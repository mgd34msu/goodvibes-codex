/** `dashboard`, bounded Codex metadata report, doctor, or status. */
import type { ToolModule } from './types.js';

export const dashboardTool: ToolModule = {
  name: 'dashboard',
  engineTool: 'analytics_dashboard',
  description:
    'Generate a bounded, self-contained HTML report under CODEX_HOME/goodvibes/analytics, or inspect ' +
    'the Codex rollout parser and local state. Reports contain token/session metadata only and never ' +
    'include prompt text, tool payloads, or monetary cost calculations.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['report', 'doctor', 'status'] },
      scope: {
        type: 'string',
        enum: ['session', 'project', 'all_projects'],
        description:
          'Report scope: session-only, this project with history, or all projects (default).',
      },
    },
    required: ['action'],
  },
};
