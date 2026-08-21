/** `sync`, build a sanitized index from Codex rollout JSONL files. */
import type { ToolModule } from './types.js';

export const syncTool: ToolModule = {
  name: 'sync',
  engineTool: 'analytics_sync',
  description:
    'Scan rollout JSONL beneath CODEX_HOME/sessions and write a bounded metadata-only index. Use ' +
    'scope="current" for the selected project or scope="all" for every scanned project.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['current', 'all'],
        description: 'Sync scope (default: current).',
      },
    },
  },
};
