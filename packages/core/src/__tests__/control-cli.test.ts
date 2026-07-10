import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePluginRoot = path.resolve(here, '../../../../plugins/goodvibes');
const source = path.join(sourcePluginRoot, 'scripts', 'goodvibes-control.mjs');
const temporary: string[] = [];

function installedFixture(): { root: string; script: string; workspace: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goodvibes-control-test-'));
  temporary.push(root);
  const pluginRoot = path.join(
    root,
    'codex',
    'plugins',
    'cache',
    'goodvibes',
    'goodvibes',
    '0.1.0'
  );
  const script = path.join(pluginRoot, 'scripts', 'goodvibes-control.mjs');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(source, script);
  const helper = path.join('scripts', 'lib', 'runtime-deps.cjs');
  fs.mkdirSync(path.join(pluginRoot, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(sourcePluginRoot, helper), path.join(pluginRoot, helper));
  for (const server of ['intel', 'analytics', 'connect']) {
    const target = path.join(pluginRoot, 'server', server);
    fs.mkdirSync(target, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(sourcePluginRoot, 'server', server, file), path.join(target, file));
    }
  }
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  return { root, script, workspace };
}

function minimalEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.CODEX_HOME;
  delete env.GOODVIBES_DATA_ROOT;
  delete env.GOODVIBES_ANALYTICS_HOME;
  delete env.GOODVIBES_TRUSTED_ROOTS_FILE;
  return env;
}

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('GoodVibes control CLI', () => {
  it('infers a custom Codex home from an installed cache path', () => {
    const fixture = installedFixture();
    const unrelatedHome = path.join(fixture.root, 'unrelated-home');
    fs.mkdirSync(unrelatedHome);
    const result = spawnSync(process.execPath, [fixture.script, 'status'], {
      encoding: 'utf8',
      env: minimalEnv(unrelatedHome),
    });
    expect(result.status).toBe(0);
    const status = JSON.parse(result.stdout) as { data_root: string; trusted_roots: string[] };
    expect(status.data_root).toBe(path.join(fixture.root, 'codex', 'goodvibes'));
    expect(status.trusted_roots).toEqual([]);
  });

  it('refuses authority mutation when stdin is not an interactive terminal', () => {
    const fixture = installedFixture();
    const result = spawnSync(
      process.execPath,
      [fixture.script, 'roots', 'add', fixture.workspace],
      { input: 'yes\n', encoding: 'utf8', env: minimalEnv(path.join(fixture.root, 'home')) }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires an interactive terminal');
    expect(fs.existsSync(path.join(fixture.root, 'codex', 'goodvibes', 'trusted-roots.json'))).toBe(
      false
    );
  });

  it('allows dependency repair without an interactive terminal', () => {
    const fixture = installedFixture();
    const result = spawnSync(process.execPath, [fixture.script, 'deps', 'install', 'analytics'], {
      encoding: 'utf8',
      env: minimalEnv(path.join(fixture.root, 'home')),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Verified analytics dependencies');
    expect(result.stderr).not.toContain('requires an interactive terminal');
  });
});
