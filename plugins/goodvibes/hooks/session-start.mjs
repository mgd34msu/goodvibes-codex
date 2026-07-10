#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { contextResponse, isDirectModule, runHook } from './lib/hook-io.mjs';
import { goodvibesDataRoot, readJson, writeJsonAtomic } from './lib/data-root.mjs';
import { recordEvent } from './lib/event-sink.mjs';

const SERVERS = ['intel', 'analytics', 'connect'];

function packageExists(nodeModules, name) {
  const packageRoot = path.join(nodeModules, ...name.split('/'));
  if (!existsSync(packageRoot)) return false;
  if (name === '@vscode/ripgrep') {
    return existsSync(
      path.join(packageRoot, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
    );
  }
  return true;
}

export function missingRuntimeDependencies(pluginRoot, dataRoot = goodvibesDataRoot()) {
  if (!pluginRoot) return [{ server: 'plugin', dependencies: ['PLUGIN_ROOT'] }];
  const missing = [];
  for (const server of SERVERS) {
    const manifestFile = path.join(pluginRoot, 'server', server, 'package.json');
    let dependencies;
    try {
      dependencies = Object.keys(JSON.parse(readFileSync(manifestFile, 'utf8')).dependencies || {});
    } catch {
      missing.push({ server, dependencies: ['runtime manifest'] });
      continue;
    }
    const local = path.join(pluginRoot, 'server', server, 'node_modules');
    const durable = path.join(dataRoot, 'deps', server, 'node_modules');
    const absent = dependencies.filter(
      name => !packageExists(local, name) && !packageExists(durable, name)
    );
    if (absent.length) missing.push({ server, dependencies: absent });
  }
  return missing;
}

export function computeOpenModeAction({ mode, persist }) {
  if (mode !== 'open') return { announce: null, revert: false, warning: false };
  if (persist) {
    return {
      announce:
        'GoodVibes OPEN trust mode is active and persisted across sessions. Destination restrictions are wider; registered credentials remain origin-bound.',
      revert: false,
      warning: true,
    };
  }
  return {
    announce:
      'GoodVibes OPEN trust mode was not persistent, so the global GoodVibes control config has been reset to restricted before this session uses tools.',
    revert: true,
    warning: true,
  };
}

export function readMergedConfig() {
  const configPath = path.join(goodvibesDataRoot(), 'config.json');
  const merged = readJson(configPath, {});
  return {
    mode: merged.mode === 'open' ? 'open' : 'restricted',
    persist: merged.dangerously_persist_across_sessions === true,
    configPath,
  };
}

export function applyOpenMode() {
  const config = readMergedConfig();
  const action = computeOpenModeAction(config);
  if (!action.revert) return { ...action, reverted: false };
  const current = readJson(config.configPath, {});
  const reverted = writeJsonAtomic(config.configPath, {
    ...current,
    mode: 'restricted',
    dangerously_persist_across_sessions: false,
  });
  if (reverted) return { ...action, reverted: true };
  return {
    announce:
      'GoodVibes OPEN trust mode is active and its global ephemeral reset failed. Set mode to restricted before using Connect.',
    revert: true,
    warning: true,
    reverted: false,
  };
}

export async function handleSessionStart(input) {
  const trust = applyOpenMode();
  const missing = missingRuntimeDependencies(process.env.PLUGIN_ROOT);

  recordEvent('session_start', input, {
    trust_mode: trust.warning && !trust.reverted ? 'open' : 'restricted',
    missing_dependency_servers: missing.map(entry => entry.server),
  });

  const lines = [];
  if (trust.announce) lines.push(trust.announce);
  if (missing.length) {
    const detail = missing
      .map(entry => `${entry.server} (${entry.dependencies.join(', ')})`)
      .join('; ');
    lines.push(
      `GoodVibes runtime dependencies are incomplete: ${detail}. GoodVibes launchers and $goodvibes-maintenance automatically retry the locked dependency repair; dependency-free surfaces remain usable if repair cannot complete.`
    );
  }
  if (!lines.length) return undefined;
  return contextResponse(
    'SessionStart',
    lines.join('\n'),
    trust.warning ? 'GoodVibes trust-mode notice' : undefined
  );
}

if (isDirectModule(import.meta.url)) {
  await runHook('SessionStart', handleSessionStart);
}
