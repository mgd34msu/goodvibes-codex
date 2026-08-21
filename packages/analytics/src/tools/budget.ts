/** `budget`, set/check/clear an exactly selected session token budget. */
import type { ToolModule } from './types.js';

export const budgetTool: ToolModule = {
  name: 'budget',
  engineTool: 'analytics_budget',
  description:
    'Set, check, or clear a token budget for the selected Codex session. Monetary budgets are rejected ' +
    'because local rollout counters are not authoritative billing data. Mutations require an exact session ' +
    'unless the host supplies active session context.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'check', 'clear'] },
      session_id: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'Exact scanned Codex rollout session. Required for set/clear unless the host supplied an active session identifier.',
      },
      amount: { type: 'number', description: 'Budget limit; required when action is "set".' },
      unit: { type: 'string', enum: ['tokens'], description: 'Only token budgets are supported.' },
      warn_at: {
        type: 'array',
        items: { type: 'number', minimum: 0, maximum: 1 },
        description: 'Warning threshold fractions, e.g. [0.5, 0.8, 1.0].',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};
