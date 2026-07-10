import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AnalyticsPaths } from './types.js';

export interface AnalyticsPathOptions {
  codexHome?: string;
  sessionsDir?: string;
  analyticsHome?: string;
}

function absolute(input: string): string {
  return isAbsolute(input) ? resolve(input) : resolve(input);
}

/**
 * Resolve every active analytics path from CODEX_HOME. Nothing in this adapter
 * probes or falls back to another assistant's state directory.
 */
export function resolveAnalyticsPaths(options: AnalyticsPathOptions = {}): AnalyticsPaths {
  const codexHome = absolute(
    options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  );
  const sessionsDir = absolute(options.sessionsDir ?? join(codexHome, 'sessions'));
  const sharedDataRoot = process.env.GOODVIBES_DATA_ROOT;
  const analyticsHome = absolute(
    options.analyticsHome ??
      process.env.GOODVIBES_ANALYTICS_HOME ??
      (sharedDataRoot
        ? join(sharedDataRoot, 'analytics')
        : join(codexHome, 'goodvibes', 'analytics'))
  );

  return {
    codex_home: codexHome,
    sessions_dir: sessionsDir,
    analytics_home: analyticsHome,
    state_file: join(analyticsHome, 'state.json'),
    index_file: join(analyticsHome, 'session-index.json'),
    reports_dir: join(analyticsHome, 'reports'),
    exports_dir: join(analyticsHome, 'exports'),
  };
}
