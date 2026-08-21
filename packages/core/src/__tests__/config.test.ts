/** Config loader + Codex-namespaced state-directory resolution. */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  loadConfig,
  resetConfigCache,
  getStatePath,
  projectConfigPath,
  configForEnvelope,
  describeConfigKeys,
  DEFAULT_CONFIG,
  CONFIG_KEYS,
} from '../config/index.js';

describe('config defaults', () => {
  beforeEach(() => resetConfigCache());

  it('defaults to restricted mode and read_only true', () => {
    const cfg = loadConfig('/nonexistent/project');
    expect(cfg.mode).toBe('restricted');
    expect(configForEnvelope(cfg)).toEqual({ mode: 'restricted', read_only: true });
  });

  it('carries the mandated budget defaults', () => {
    const cfg = loadConfig('/nonexistent/project');
    expect(cfg.budgets.analyzer_ms).toBe(20000);
    expect(cfg.budgets.search_ms).toBe(15000);
    expect(cfg.budgets.http_default_ms).toBe(30000);
    expect(cfg.budgets.http_max_ms).toBe(120000);
    expect(cfg.ppid_poll_ms).toBe(5000);
  });

  it('DEFAULT_CONFIG and CONFIG_KEYS agree on documented defaults', () => {
    expect(DEFAULT_CONFIG.mode).toBe(CONFIG_KEYS.mode.default);
    expect(DEFAULT_CONFIG.budgets.analyzer_ms).toBe(CONFIG_KEYS['budgets.analyzer_ms'].default);
  });

  it('documents every key from one source of truth', () => {
    const doc = describeConfigKeys();
    for (const key of Object.keys(CONFIG_KEYS)) {
      expect(doc).toContain(key);
    }
  });

  it('observes an open-to-restricted revocation without restarting the process', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-config-revocation-'));
    const previous = process.env.GOODVIBES_DATA_ROOT;
    process.env.GOODVIBES_DATA_ROOT = tmp;
    try {
      const config = path.join(tmp, 'config.json');
      fs.writeFileSync(config, JSON.stringify({ mode: 'open' }));
      expect(loadConfig().mode).toBe('open');
      fs.writeFileSync(config, JSON.stringify({ mode: 'restricted' }));
      expect(loadConfig().mode).toBe('restricted');
    } finally {
      if (previous === undefined) {
        delete process.env.GOODVIBES_DATA_ROOT;
      } else {
        process.env.GOODVIBES_DATA_ROOT = previous;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('state directory', () => {
  it('resolves all project state under .goodvibes/codex/', () => {
    expect(getStatePath('/proj', 'cache', 'cache.db')).toBe(
      path.join('/proj', '.goodvibes', 'codex', 'cache', 'cache.db')
    );
    expect(projectConfigPath('/proj')).toBe(
      path.join('/proj', '.goodvibes', 'codex', 'config.json')
    );
  });

  it('does not mutate legacy Claude state while resolving a Codex path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-state-migration-'));
    try {
      const legacyCache = path.join(tmp, '.goodvibes', 'v2', 'cache');
      fs.mkdirSync(legacyCache, { recursive: true });
      fs.writeFileSync(path.join(legacyCache, 'last-session-summary.json'), '{"cost_usd":1.5}');

      const resolved = getStatePath(tmp, 'cache', 'last-session-summary.json');
      expect(resolved).toBe(
        path.join(tmp, '.goodvibes', 'codex', 'cache', 'last-session-summary.json')
      );
      expect(fs.existsSync(resolved)).toBe(false);
      expect(
        fs.readFileSync(path.join(legacyCache, 'last-session-summary.json'), 'utf-8')
      ).toContain('1.5');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
