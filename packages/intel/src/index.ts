/**
 * goodvibes-intel MCP server, the structure-aware code-intelligence server of
 * the single `goodvibes` plugin (three servers: intel, analytics, connect).
 *
 * Wires `core/proc` (process hygiene) and `core/envelope` (response shape) and
 * serves the 15 intel tools over stdio. Native/WASM-backed capabilities load
 * their deps lazily and degrade to an honest maintenance-pointer envelope when
 * the user has not explicitly prepared them yet.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { installProcessHygiene } from '@goodvibes/core/proc';
import { errorEnvelope, toCallToolResult } from '@goodvibes/core/envelope';
import { loadConfig } from '@goodvibes/core/config';
import type { ToolDefinition } from './tools/types.js';
// Scaffolding.
import { scaffoldTool } from './tools/scaffold.js';
// Compiler-host code intelligence.
import { codeSurfaceTool } from './tools/code_surface.js';
import { codeSafeDeleteTool } from './tools/code_safe_delete.js';
// Batched search and reads.
import { codeReadTool } from './tools/code_read.js';
import { codeGrepTool } from './tools/code_grep.js';
import { codeGlobTool } from './tools/code_glob.js';
// API and database-schema analysis.
import { apiRoutesTool } from './tools/api_routes.js';
import { apiSpecTool } from './tools/api_spec.js';
import { apiValidateTool } from './tools/api_validate.js';
import { dbSchemaTool } from './tools/db_schema.js';
// Frontend analysis.
import { componentTreeTool } from './tools/component_tree.js';
import { hookDependenciesTool } from './tools/hook_dependencies.js';
import { clientBoundaryTool } from './tools/client_boundary.js';
import { layoutAnalysisTool } from './tools/layout_analysis.js';
// Preview-gated structural editing.
import { structuralEditTool } from './tools/structural_edit.js';

export const SERVER_NAME = 'goodvibes-intel';
// Injected by build.mjs from plugin.json (the single version source);
// falls back in unbundled dev/test runs where no injection happens.
declare const __GV_VERSION__: string | undefined;
export const SERVER_VERSION = typeof __GV_VERSION__ !== 'undefined' ? __GV_VERSION__ : '0.0.0-dev';

/**
 * Every tool this server serves. One module per tool under `src/tools/` keeps
 * schemas and handlers independently testable.
 */
const TOOLS: ToolDefinition[] = [
  scaffoldTool,
  codeSurfaceTool,
  codeSafeDeleteTool,
  codeReadTool,
  codeGrepTool,
  codeGlobTool,
  apiRoutesTool,
  apiSpecTool,
  apiValidateTool,
  dbSchemaTool,
  componentTreeTool,
  hookDependenciesTool,
  clientBoundaryTool,
  layoutAnalysisTool,
  structuralEditTool,
];

/**
 * Build the configured MCP server. `onActivity` is invoked on every request so
 * the process-hygiene idle timer can be reset.
 */
export function createServer(onActivity?: () => void): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'GoodVibes Intel analyzes only user-registered workspace roots. Pass base_path when more than one root is registered. Read tools are advisory; scaffold and structural_edit can mutate files.',
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    onActivity?.();
    return {
      tools: TOOLS.map(tool => {
        const mutating =
          tool.definition.name === 'scaffold' || tool.definition.name === 'structural_edit';
        return {
          ...tool.definition,
          annotations: {
            readOnlyHint: !mutating,
            destructiveHint: mutating,
            idempotentHint: !mutating,
            openWorldHint: tool.definition.name === 'scaffold',
          },
        };
      }),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async request => {
    onActivity?.();
    const tool = TOOLS.find(t => t.definition.name === request.params.name);
    if (!tool) {
      return toCallToolResult(
        errorEnvelope(
          `Unknown tool: ${request.params.name}. Known tools: ${TOOLS.map(t => t.definition.name).join(', ') || '(none registered yet)'}.`
        )
      );
    }
    return tool.handler(request.params.arguments ?? {});
  });

  return server;
}

/** Boot the server over stdio with the process-hygiene watchdogs installed. */
export async function main(): Promise<void> {
  const cfg = loadConfig();
  const hygiene = installProcessHygiene({
    ppidPollMs: cfg.ppid_poll_ms,
  });
  const server = createServer(() => hygiene.noteActivity());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Bootstrap only when run as the process entry; never when imported by tests.
if (!process.env.VITEST) {
  void main().catch(err => {
    console.error(`[${SERVER_NAME}] fatal:`, err);
    process.exit(1);
  });
}
