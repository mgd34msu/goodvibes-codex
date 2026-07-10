/** Codex-native GoodVibes Analytics MCP server. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { errorEnvelope, toCallToolResult } from '@goodvibes/core/envelope';
import { installProcessHygiene, withBudget } from '@goodvibes/core/proc';
import { CodexAnalyticsEngine, type CodexAnalyticsEngineOptions } from './codex/engine.js';
import type { ToolModule } from './tools/types.js';
import { queryTool } from './tools/query.js';
import { dashboardTool } from './tools/dashboard.js';
import { budgetTool } from './tools/budget.js';
import { exportTool } from './tools/export.js';
import { tagTool } from './tools/tag.js';
import { syncTool } from './tools/sync.js';
import { configTool } from './tools/config.js';

export const SERVER_NAME = 'goodvibes-analytics';
declare const __GV_VERSION__: string | undefined;
export const SERVER_VERSION = typeof __GV_VERSION__ !== 'undefined' ? __GV_VERSION__ : '0.0.0-dev';

const CALL_BUDGET_MS = 20_000;

/** The stable seven-tool public surface. */
export const TOOL_MODULES: ToolModule[] = [
  queryTool,
  dashboardTool,
  budgetTool,
  exportTool,
  tagTool,
  syncTool,
  configTool,
];

export interface CreateServerOptions extends CodexAnalyticsEngineOptions {
  onActivity?: () => void;
  onEngine?: (engine: CodexAnalyticsEngine) => void;
}

function annotations(tool: ToolModule): Record<string, boolean> {
  const readOnly = tool.name === 'query';
  return {
    readOnlyHint: readOnly,
    destructiveHint: false,
    idempotentHint: readOnly || tool.name === 'dashboard' || tool.name === 'sync',
    openWorldHint: false,
  };
}

/** Build a lazily initialized MCP server backed only by local Codex rollout metadata. */
export function createServer(options: CreateServerOptions = {}): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Analyze local Codex rollout metadata under CODEX_HOME/sessions. Token counts are local usage counters, not billing. ' +
        'The server never reads message text, reasoning, tool arguments, or tool outputs, and it does not calculate monetary cost.',
    }
  );

  const byName = new Map(TOOL_MODULES.map(tool => [tool.name, tool]));
  let engine: CodexAnalyticsEngine | null = null;

  function getEngine(): CodexAnalyticsEngine {
    if (!engine) {
      engine = new CodexAnalyticsEngine(options);
      options.onEngine?.(engine);
    }
    return engine;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    options.onActivity?.();
    return {
      tools: TOOL_MODULES.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: annotations(tool),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    options.onActivity?.();
    const tool = byName.get(request.params.name);
    if (!tool) {
      return toCallToolResult(errorEnvelope(`Unknown tool: ${request.params.name}`));
    }

    try {
      const activeEngine = getEngine();
      await activeEngine.initialize();
      const outcome = await withBudget(CALL_BUDGET_MS, async () =>
        activeEngine.handleToolCall(tool.engineTool, request.params.arguments ?? {})
      );
      if (!outcome.budget_exceeded) {
        return outcome.value;
      }
      return {
        ...outcome.value,
        content: [
          ...outcome.value.content,
          {
            type: 'text',
            text: `Analytics exceeded its ${CALL_BUDGET_MS}ms cooperative time budget after ${outcome.elapsed_ms}ms.`,
          },
        ],
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return toCallToolResult(errorEnvelope(`Tool ${tool.name} failed: ${message}`));
    }
  });

  return server;
}

export async function main(): Promise<void> {
  let engine: CodexAnalyticsEngine | null = null;
  const hygiene = installProcessHygiene({
    onShutdown: async () => engine?.shutdown(),
  });
  const server = createServer({
    onActivity: () => hygiene.noteActivity(),
    onEngine: created => {
      engine = created;
    },
  });
  await server.connect(new StdioServerTransport());
}

if (!process.env.VITEST) {
  void main().catch(cause => {
    console.error(`[${SERVER_NAME}] fatal:`, cause);
    process.exit(1);
  });
}
