import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePlugin = path.resolve(here, '../../../../plugins/goodvibes');
const temporary: string[] = [];

function fixture(): {
  root: string;
  pluginRoot: string;
  dataRoot: string;
  launcher: string;
  marker: string;
  npmCli: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goodvibes-launcher-repair-'));
  temporary.push(root);
  const pluginRoot = path.join(root, 'plugin');
  const dataRoot = path.join(root, 'data');
  const serverRoot = path.join(pluginRoot, 'server', 'connect');
  const helperRoot = path.join(pluginRoot, 'scripts', 'lib');
  fs.mkdirSync(serverRoot, { recursive: true });
  fs.mkdirSync(helperRoot, { recursive: true });
  fs.copyFileSync(
    path.join(sourcePlugin, 'server', 'connect', 'launcher.cjs'),
    path.join(serverRoot, 'launcher.cjs')
  );
  fs.copyFileSync(
    path.join(sourcePlugin, 'scripts', 'lib', 'runtime-deps.cjs'),
    path.join(helperRoot, 'runtime-deps.cjs')
  );
  const dependencies = { 'goodvibes-fixture-runtime': '1.2.3' };
  fs.writeFileSync(
    path.join(serverRoot, 'package.json'),
    `${JSON.stringify({ name: 'fixture-connect', version: '0.1.1', private: true, dependencies })}\n`
  );
  fs.writeFileSync(
    path.join(serverRoot, 'package-lock.json'),
    `${JSON.stringify({
      name: 'fixture-connect',
      version: '0.1.1',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'fixture-connect', version: '0.1.1', dependencies } },
    })}\n`
  );
  const marker = path.join(root, 'bundle-loaded');
  const npmCli = path.join(root, 'fake-npm.cjs');
  fs.writeFileSync(
    npmCli,
    `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const index = process.argv.indexOf('--prefix');
const prefix = process.argv[index + 1];
const manifest = JSON.parse(fs.readFileSync(path.join(prefix, 'package.json'), 'utf8'));
for (const [name, version] of Object.entries(manifest.dependencies || {})) {
  const root = path.join(prefix, 'node_modules', ...name.split('/'));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
  fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = { ready: true };\\n');
}
`
  );
  return {
    root,
    pluginRoot,
    dataRoot,
    launcher: path.join(serverRoot, 'launcher.cjs'),
    marker,
    npmCli,
  };
}

function writeBundle(pluginRoot: string, marker: string, requireDependency: boolean): void {
  const dependencyCheck = requireDependency
    ? `if (require('goodvibes-fixture-runtime').ready !== true) throw new Error('dependency unavailable');\n`
    : '';
  fs.writeFileSync(
    path.join(pluginRoot, 'server', 'connect', 'index.cjs'),
    `'use strict';\n${dependencyCheck}require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');\n`
  );
}

function launch(value: ReturnType<typeof fixture>, npmCli: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [value.launcher], {
    cwd: value.pluginRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: path.join(value.root, 'codex'),
      GOODVIBES_DATA_ROOT: value.dataRoot,
      GOODVIBES_TEST_NPM_CLI: npmCli,
      NODE_ENV: 'test',
    },
  });
}

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('MCP launcher automatic dependency repair', () => {
  it('continues degraded after failure and repairs before loading the bundle on the next startup', () => {
    const value = fixture();
    const failingNpm = path.join(value.root, 'failing-npm.cjs');
    fs.writeFileSync(failingNpm, 'process.exitCode = 7;\n');
    writeBundle(value.pluginRoot, value.marker, false);

    const degraded = launch(value, failingNpm);
    expect(degraded.status).toBe(0);
    expect(degraded.stderr).toContain('continuing in degraded mode');
    expect(fs.readFileSync(value.marker, 'utf8')).toBe('loaded');

    fs.rmSync(value.marker);
    writeBundle(value.pluginRoot, value.marker, true);
    const repaired = launch(value, value.npmCli);
    expect(repaired.status).toBe(0);
    expect(repaired.stderr).toContain('Repaired runtime dependencies');
    expect(fs.readFileSync(value.marker, 'utf8')).toBe('loaded');
    expect(
      fs.existsSync(
        path.join(value.dataRoot, 'deps', 'connect', 'node_modules', 'goodvibes-fixture-runtime')
      )
    ).toBe(true);
    expect(fs.existsSync(path.join(value.pluginRoot, 'server', 'connect', 'node_modules'))).toBe(
      false
    );
  });

  it('wires the shared repair helper into every launcher', () => {
    for (const server of ['intel', 'analytics', 'connect']) {
      const launcher = fs.readFileSync(
        path.join(sourcePlugin, 'server', server, 'launcher.cjs'),
        'utf8'
      );
      expect(launcher).toContain("require('../../scripts/lib/runtime-deps.cjs')");
      expect(launcher).toContain('await ensureRuntimeDependencies');
      expect(launcher).toContain('continuing in degraded mode');
      expect(launcher).toContain('repairTimeoutMs: 7_000');
      expect(launcher).toContain('processTimeoutMs: 5_500');
      expect(launcher.indexOf('await ensureRuntimeDependencies')).toBeLessThan(
        launcher.indexOf("require('./index.cjs')")
      );
    }
  });
});
