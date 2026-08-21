/**
 * `service`, credential-free registry and trust-status inspection.
 *
 * Its public actions are exactly list, get, and status. Responses never contain
 * credentials, and no action can register a destination, change a grant, store
 * a secret, or flip trust mode. Those mutations belong to the interactive
 * control utility.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  successEnvelope,
  errorEnvelope,
  toCallToolResult,
  startTimer,
  type Envelope,
} from '@goodvibes/core/envelope';
import { loadConfig, configForEnvelope } from '@goodvibes/core/config';
import {
  getAllServiceSummaries,
  getServiceSummary,
  getAllowlist,
  listServiceNames,
  listConnectionNames,
} from '../fetch/service-registry.js';
import { getAuthStatus } from '../fetch/auth/auth-orchestrator.js';

/** Actions the `service` tool accepts. */
export type ServiceAction = 'list' | 'get' | 'status';

/** Input to the `service` tool. */
export interface ServiceInput {
  action: ServiceAction;
  name?: string;
}

/** The tool descriptor (schema deferred by the client). */
export const serviceTool = {
  name: 'service',
  description:
    'Inspect services and database connections that a user registered through the GoodVibes control utility. ' +
    'This MCP tool is read-only: list/get/status never add destinations, credentials, connections, or write grants.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'status'],
      },
      name: { type: 'string', description: 'Registered service name for action=get.' },
    },
    required: ['action'],
  },
} as const;

/** Execute the `service` tool and return an MCP result. */
export async function handleService(args: unknown): Promise<CallToolResult> {
  const elapsed = startTimer();
  const cfg = loadConfig();
  const { mode } = configForEnvelope(cfg);
  const input = (args ?? {}) as Partial<ServiceInput>;

  const fail = (msg: string): CallToolResult =>
    toCallToolResult(errorEnvelope(msg, { mode, execution_ms: elapsed() }));

  const ok = (data: unknown): CallToolResult =>
    toCallToolResult(successEnvelope(data, { mode, execution_ms: elapsed() }) as Envelope);

  try {
    switch (input.action) {
      case 'list':
        return ok({
          services: getAllServiceSummaries(),
          connections: listConnectionNames(),
          allowlist: getAllowlist(),
          mode,
        });

      case 'get': {
        if (!input.name) {
          return fail('`get` requires a service `name`.');
        }
        const summary = getServiceSummary(input.name);
        if (!summary) {
          return fail(`Service "${input.name}" is not registered.`);
        }
        const auth_status = await getAuthStatus(
          input.name,
          summary.base_url,
          summary.auth_type as 'bearer' | 'basic' | 'api-key' | 'none' | undefined
        );
        return ok({ ...summary, auth_status });
      }

      case 'status':
        return ok({
          mode,
          read_only: mode === 'restricted',
          dangerously_persist_across_sessions: cfg.dangerously_persist_across_sessions,
          services: listServiceNames(),
          connections: listConnectionNames(),
          allowlist: getAllowlist(),
          note: 'Authority changes are unavailable through MCP. Use the interactive GoodVibes control utility.',
        });

      default:
        return fail(
          `Unknown or non-MCP service action "${String(input.action)}". Valid MCP actions: list, get, status.`
        );
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
