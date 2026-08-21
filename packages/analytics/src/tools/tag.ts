/** `tag`, add/remove/list/auto-suggest local session tags. */
import type { ToolModule } from './types.js';

export const tagTool: ToolModule = {
  name: 'tag',
  engineTool: 'analytics_tag',
  description:
    'Add, remove, or list local tags on the selected Codex session. Tags are stored privately under ' +
    'CODEX_HOME and never modify Codex rollouts. Add/remove require an exact session unless the host supplies ' +
    'active session context; auto suggestions use metadata only.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'remove', 'list', 'auto'] },
      session_id: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'Exact scanned Codex rollout session. Required for add/remove unless the host supplied an active session identifier.',
      },
      value: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
        description: 'Required for add/remove.',
      },
      scope: {
        type: 'string',
        enum: ['session', 'all'],
        description: 'For the list action (default: session).',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};
