import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('child_process', () => ({ spawn: spawnMock }));

const nodeModule = createRequire(import.meta.url)('node:module') as {
  _initPaths(): void;
};

interface FakeProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function fakeProcess(): FakeProcess {
  const child = new EventEmitter() as FakeProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('ripgrep runtime repair', () => {
  const temporary: string[] = [];
  const previousNodePath = process.env.NODE_PATH;
  const previousPluginRoot = process.env.GOODVIBES_PLUGIN_ROOT;

  afterEach(() => {
    spawnMock.mockReset();
    if (previousNodePath === undefined) {
      delete process.env.NODE_PATH;
    } else {
      process.env.NODE_PATH = previousNodePath;
    }
    if (previousPluginRoot === undefined) {
      delete process.env.GOODVIBES_PLUGIN_ROOT;
    } else {
      process.env.GOODVIBES_PLUGIN_ROOT = previousPluginRoot;
    }
    nodeModule._initPaths();
    vi.resetModules();
    for (const directory of temporary.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('re-resolves the packaged binary after an unavailable fallback without restarting', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goodvibes-ripgrep-heal-'));
    temporary.push(root);
    const pluginRoot = path.join(root, 'plugin');
    const serverRoot = path.join(pluginRoot, 'server', 'intel');
    const nodeModules = path.join(root, 'data', 'deps', 'intel', 'node_modules');
    fs.mkdirSync(serverRoot, { recursive: true });
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.writeFileSync(path.join(serverRoot, 'launcher.cjs'), '');

    process.env.GOODVIBES_PLUGIN_ROOT = pluginRoot;
    process.env.NODE_PATH = nodeModules;
    nodeModule._initPaths();
    vi.resetModules();

    const commands: string[] = [];
    spawnMock.mockImplementation((command: string) => {
      commands.push(command);
      const child = fakeProcess();
      queueMicrotask(() => {
        if (command === 'rg') {
          child.emit('error', new Error('ENOENT'));
        } else {
          child.emit('close', 1);
        }
      });
      return child;
    });

    const { RipgrepCore } = await import('../lib/ripgrep.js');
    const ripgrep = new RipgrepCore();
    await expect(ripgrep.listFiles({ path: root })).rejects.toThrow("Failed to spawn ripgrep ('rg')");

    const packageRoot = path.join(nodeModules, '@vscode', 'ripgrep');
    const packagedBinary = path.join(packageRoot, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
    fs.mkdirSync(path.dirname(packagedBinary), { recursive: true });
    fs.writeFileSync(packagedBinary, 'fixture');
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify({ name: '@vscode/ripgrep', version: '1.15.14', main: 'index.cjs' })}\n`
    );
    fs.writeFileSync(
      path.join(packageRoot, 'index.cjs'),
      `module.exports = { rgPath: ${JSON.stringify(packagedBinary)} };\n`
    );

    await expect(ripgrep.listFiles({ path: root })).resolves.toEqual([]);
    expect(commands).toEqual(['rg', packagedBinary]);
  });
});
