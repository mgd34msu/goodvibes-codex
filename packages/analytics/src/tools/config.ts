/** `config` — view/update/reload local GoodVibes output bounds. */
import type { ToolModule } from './types.js';

export const configTool: ToolModule = {
  name: 'config',
  engineTool: 'analytics_config',
  description:
    'View or update bounded GoodVibes scan/report settings stored under CODEX_HOME. These settings are ' +
    'non-authoritative and never configure Codex itself.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set', 'reload'] },
      key: { type: 'string' },
      value: {},
    },
    required: ['action'],
  },
};
