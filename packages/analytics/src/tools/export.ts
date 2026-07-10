/** `export` — export session data as JSON/CSV/markdown. */
import type { ToolModule } from './types.js';

export const exportTool: ToolModule = {
  name: 'export',
  engineTool: 'analytics_export',
  description:
    'Export one fixed, bounded sanitized Codex session schema in JSON, CSV, or markdown. Relative output paths ' +
    'are confined beneath CODEX_HOME/goodvibes/analytics/exports with symlink-parent checks; message content, ' +
    'tool payloads, and monetary cost are excluded.',
  inputSchema: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['json', 'csv', 'markdown'] },
      scope: {
        type: 'string',
        description:
          '"current", "historical", "all_projects", or "session:<id>" (default: current).',
      },
      output_path: {
        type: 'string',
        description: 'Relative path beneath the GoodVibes analytics exports directory.',
      },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['format'],
    additionalProperties: false,
  },
};
