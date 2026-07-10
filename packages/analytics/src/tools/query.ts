/** `query` — ad-hoc queries against local Codex rollout metadata. */
import type { ToolModule } from './types.js';

export const queryTool: ToolModule = {
  name: 'query',
  engineTool: 'analytics_query',
  description:
    'Query sanitized Codex session metadata: cumulative token counters, cached input, tool-call counts, ' +
    'subagent sessions, projects, and parser health. Supports bounded time/project scopes and tool/tag filters. ' +
    'The live_cost compatibility mode reports live token counters only; no monetary cost is inferred.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: [
          'tokens',
          'cache',
          'commands',
          'agents',
          'files',
          'cost',
          'health',
          'project',
          'all',
        ],
        description:
          'The data domain to query within the current session (default: all). Ignored when mode is set.',
      },
      mode: {
        type: 'string',
        enum: ['live_cost', 'doctor', 'agents'],
        description:
          'Overrides scope. live_cost is a compatibility alias for live token totals; doctor reports parser/storage ' +
          'health; agents summarizes parent/subagent rollout relationships.',
      },
      time_range: {
        type: 'string',
        enum: ['session', 'last_5m', 'last_30m', 'last_1h'],
        description: 'Time window to aggregate over (default: session).',
      },
      filters: {
        type: 'object',
        properties: {
          tool: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      data_scope: {
        type: 'string',
        enum: ['current_session', 'current_project', 'all_projects', 'tagged'],
        description: 'Which set of sessions to include (default: current_session).',
      },
    },
    required: [],
    additionalProperties: false,
  },
};
