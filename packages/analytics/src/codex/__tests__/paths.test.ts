import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAnalyticsPaths } from '../paths.js';

let priorAnalyticsHome: string | undefined;
let priorDataRoot: string | undefined;

beforeEach(() => {
  priorAnalyticsHome = process.env.GOODVIBES_ANALYTICS_HOME;
  priorDataRoot = process.env.GOODVIBES_DATA_ROOT;
  delete process.env.GOODVIBES_ANALYTICS_HOME;
  delete process.env.GOODVIBES_DATA_ROOT;
});

afterEach(() => {
  if (priorAnalyticsHome === undefined) {
    delete process.env.GOODVIBES_ANALYTICS_HOME;
  } else {
    process.env.GOODVIBES_ANALYTICS_HOME = priorAnalyticsHome;
  }
  if (priorDataRoot === undefined) {
    delete process.env.GOODVIBES_DATA_ROOT;
  } else {
    process.env.GOODVIBES_DATA_ROOT = priorDataRoot;
  }
});

describe.sequential('Codex analytics data path precedence', () => {
  it('uses an explicit engine override first', () => {
    process.env.GOODVIBES_ANALYTICS_HOME = '/env/analytics';
    process.env.GOODVIBES_DATA_ROOT = '/env/shared';
    const paths = resolveAnalyticsPaths({ codexHome: '/codex', analyticsHome: '/explicit' });
    expect(paths.analytics_home).toBe(resolve('/explicit'));
  });

  it('prefers GOODVIBES_ANALYTICS_HOME over the shared launcher root', () => {
    process.env.GOODVIBES_ANALYTICS_HOME = '/env/analytics';
    process.env.GOODVIBES_DATA_ROOT = '/env/shared';
    const paths = resolveAnalyticsPaths({ codexHome: '/codex' });
    expect(paths.analytics_home).toBe(resolve('/env/analytics'));
  });

  it('uses GOODVIBES_DATA_ROOT/analytics when supplied by the launcher', () => {
    process.env.GOODVIBES_DATA_ROOT = '/env/shared';
    const paths = resolveAnalyticsPaths({ codexHome: '/codex' });
    expect(paths.analytics_home).toBe(resolve('/env/shared/analytics'));
  });

  it('falls back beneath CODEX_HOME without probing other assistant state', () => {
    const paths = resolveAnalyticsPaths({ codexHome: '/codex' });
    expect(paths.analytics_home).toBe(resolve('/codex/goodvibes/analytics'));
    expect(paths.sessions_dir).toBe(resolve('/codex/sessions'));
  });
});
