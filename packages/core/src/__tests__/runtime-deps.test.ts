import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface RunOptions {
  cwd?: string;
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
}

type RunCommand = (command: string, args: string[], options?: RunOptions) => Promise<void>;

interface RuntimeDeps {
  ensureRuntimeDependencies(options: {
    pluginRoot: string;
    dataRoot: string;
    server: 'intel' | 'analytics' | 'connect';
    runCommand?: RunCommand;
    lockWaitMs?: number;
    staleLockMs?: number;
    env?: NodeJS.ProcessEnv;
    repairTimeoutMs?: number;
    processTimeoutMs?: number;
    killGraceMs?: number;
  }): Promise<{ prepared: boolean; repaired: boolean }>;
  inspectRuntimeDependencies(options: {
    pluginRoot: string;
    dataRoot: string;
    server: 'intel' | 'analytics' | 'connect';
    runCommand?: RunCommand;
  }): Promise<{ prepared: boolean; issues: string[] }>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.resolve(here, '../../../../plugins/goodvibes/scripts/lib/runtime-deps.cjs');
const runtimeDeps = createRequire(import.meta.url)(helperPath) as RuntimeDeps;
const temporary: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goodvibes-runtime-deps-'));
  temporary.push(directory);
  return directory;
}

function writeRuntime(
  pluginRoot: string,
  server: 'intel' | 'analytics' | 'connect',
  dependencies: Record<string, string>,
  lockedDependencies: Record<string, string> = dependencies
): void {
  const root = path.join(pluginRoot, 'server', server);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: `fixture-${server}`, version: '0.1.0', private: true, dependencies }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: `fixture-${server}`,
        version: '0.1.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: `fixture-${server}`, version: '0.1.0', dependencies: lockedDependencies },
        },
      },
      null,
      2
    )}\n`
  );
}

function materializePackages(prefix: string): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(prefix, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const packageRoot = path.join(prefix, 'node_modules', ...name.split('/'));
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify({ name, version, main: 'index.js' })}\n`
    );
    fs.writeFileSync(path.join(packageRoot, 'index.js'), 'module.exports = {};\n');
    if (name === '@vscode/ripgrep') {
      const binary = path.join(packageRoot, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, 'fixture-ripgrep\n');
    }
  }
}

function successfulRunner(observed: {
  installs: number;
  loads: string[];
  binaries: number;
}): RunCommand {
  return async (command, args): Promise<void> => {
    const prefixIndex = args.indexOf('--prefix');
    if (args.includes('ci') && prefixIndex >= 0) {
      observed.installs += 1;
      materializePackages(args[prefixIndex + 1]);
      return;
    }
    if (command === process.execPath && args[0] === '-e') {
      observed.loads.push(args[1]);
      return;
    }
    if (path.basename(command).toLowerCase().startsWith('rg')) {
      observed.binaries += 1;
    }
  };
}

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('automatic runtime dependency repair', () => {
  it('installs from the committed lock, verifies every dependency, and repairs version drift', async () => {
    const root = tempDir();
    const pluginRoot = path.join(root, 'plugin');
    const dataRoot = path.join(root, 'data');
    writeRuntime(pluginRoot, 'intel', {
      '@ast-grep/napi': '0.40.5',
      '@vscode/ripgrep': '1.15.14',
      'web-tree-sitter': '0.26.10',
    });
    const observed = { installs: 0, loads: [] as string[], binaries: 0 };
    const runCommand = successfulRunner(observed);

    const first = await runtimeDeps.ensureRuntimeDependencies({
      pluginRoot,
      dataRoot,
      server: 'intel',
      runCommand,
    });
    expect(first).toMatchObject({ prepared: true, repaired: true });
    expect(observed.installs).toBe(1);
    expect(observed.loads.join('\n')).toContain('web-tree-sitter');
    expect(observed.loads.join('\n')).toContain('@ast-grep/napi');
    expect(observed.binaries).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(pluginRoot, 'server', 'intel', 'node_modules'))).toBe(false);

    const second = await runtimeDeps.ensureRuntimeDependencies({
      pluginRoot,
      dataRoot,
      server: 'intel',
      runCommand,
    });
    expect(second).toMatchObject({ prepared: true, repaired: false });
    expect(observed.installs).toBe(1);

    const installedManifest = path.join(
      dataRoot,
      'deps',
      'intel',
      'node_modules',
      'web-tree-sitter',
      'package.json'
    );
    fs.writeFileSync(
      installedManifest,
      `${JSON.stringify({ name: 'web-tree-sitter', version: '0.0.0', main: 'index.js' })}\n`
    );
    const repaired = await runtimeDeps.ensureRuntimeDependencies({
      pluginRoot,
      dataRoot,
      server: 'intel',
      runCommand,
    });
    expect(repaired).toMatchObject({ prepared: true, repaired: true });
    expect(observed.installs).toBe(2);
  });

  it('preserves caller environment while confining npm cache and logs to the durable root', async () => {
    const root = tempDir();
    const pluginRoot = path.join(root, 'plugin');
    const dataRoot = path.join(root, 'data');
    writeRuntime(pluginRoot, 'connect', { pg: '8.16.3' });
    let npmEnv: NodeJS.ProcessEnv | undefined;
    const runCommand: RunCommand = async (_command, args, options): Promise<void> => {
      const prefixIndex = args.indexOf('--prefix');
      if (args.includes('ci') && prefixIndex >= 0) {
        npmEnv = options?.env;
        materializePackages(args[prefixIndex + 1]);
        fs.writeFileSync(path.join(npmEnv?.npm_config_cache || '', 'cache-write'), 'cache');
        fs.writeFileSync(path.join(npmEnv?.npm_config_logs_dir || '', 'install.log'), 'log');
      }
    };

    await runtimeDeps.ensureRuntimeDependencies({
      pluginRoot,
      dataRoot,
      server: 'connect',
      runCommand,
      env: {
        GOODVIBES_CALLER_ENV: 'preserved',
        NPM_CONFIG_CACHE: path.join(root, 'escaped-uppercase-cache'),
        NPM_CONFIG_LOGS_DIR: path.join(root, 'escaped-uppercase-logs'),
        npm_config_cache: path.join(root, 'escaped-cache'),
        npm_config_logs_dir: path.join(root, 'escaped-logs'),
      },
    });

    const expectedCache = path.join(dataRoot, 'deps', '.npm-cache');
    const expectedLogs = path.join(dataRoot, 'deps', '.npm-logs');
    expect(npmEnv?.GOODVIBES_CALLER_ENV).toBe('preserved');
    expect(npmEnv?.npm_config_cache).toBe(expectedCache);
    expect(npmEnv?.npm_config_logs_dir).toBe(expectedLogs);
    expect(npmEnv?.NPM_CONFIG_CACHE).toBeUndefined();
    expect(npmEnv?.NPM_CONFIG_LOGS_DIR).toBeUndefined();
    expect(fs.readFileSync(path.join(expectedCache, 'cache-write'), 'utf8')).toBe('cache');
    expect(fs.readFileSync(path.join(expectedLogs, 'install.log'), 'utf8')).toBe('log');
    expect(fs.existsSync(path.join(root, 'escaped-cache'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'escaped-logs'))).toBe(false);
  });

  it('terminates a hung package manager within the repair budget and cleans staging and locks', async () => {
    const root = tempDir();
    const pluginRoot = path.join(root, 'plugin');
    const dataRoot = path.join(root, 'data');
    writeRuntime(pluginRoot, 'connect', { pg: '8.16.3' });
    const npmCli = path.join(root, 'hung-npm.cjs');
    const pidFile = path.join(root, 'hung-npm.pid');
    fs.writeFileSync(
      npmCli,
      `'use strict';
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`
    );
    const previousCli = process.env.GOODVIBES_TEST_NPM_CLI;
    process.env.GOODVIBES_TEST_NPM_CLI = npmCli;
    const started = Date.now();
    try {
      await expect(
        runtimeDeps.ensureRuntimeDependencies({
          pluginRoot,
          dataRoot,
          server: 'connect',
          processTimeoutMs: 100,
          repairTimeoutMs: 1_000,
          killGraceMs: 50,
          lockWaitMs: 500,
        })
      ).rejects.toThrow('timed out after 100ms');
    } finally {
      if (previousCli === undefined) {
        delete process.env.GOODVIBES_TEST_NPM_CLI;
      } else {
        process.env.GOODVIBES_TEST_NPM_CLI = previousCli;
      }
    }
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fs.existsSync(path.join(dataRoot, 'deps', '.locks', 'connect.lock'))).toBe(false);
    const entries = fs.readdirSync(path.join(dataRoot, 'deps'));
    expect(entries.some(entry => entry.endsWith('.tmp') || entry.endsWith('.old'))).toBe(false);
    const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('serializes concurrent repairs per server', async () => {
    const root = tempDir();
    const pluginRoot = path.join(root, 'plugin');
    const dataRoot = path.join(root, 'data');
    writeRuntime(pluginRoot, 'connect', { mysql2: '3.15.3' });
    let installs = 0;
    const runCommand: RunCommand = async (_command, args): Promise<void> => {
      const prefixIndex = args.indexOf('--prefix');
      if (args.includes('ci') && prefixIndex >= 0) {
        installs += 1;
        await new Promise(resolve => setTimeout(resolve, 150));
        materializePackages(args[prefixIndex + 1]);
      }
    };

    const results = await Promise.all([
      runtimeDeps.ensureRuntimeDependencies({
        pluginRoot,
        dataRoot,
        server: 'connect',
        runCommand,
      }),
      runtimeDeps.ensureRuntimeDependencies({
        pluginRoot,
        dataRoot,
        server: 'connect',
        runCommand,
      }),
    ]);
    expect(installs).toBe(1);
    expect(results.every(result => result.prepared)).toBe(true);
    expect(results.filter(result => result.repaired)).toHaveLength(1);
  });

  it('does not let concurrent dead-lock reapers steal the replacement lock', async () => {
    const root = tempDir();
    const pluginRoot = path.join(root, 'plugin');
    const dataRoot = path.join(root, 'data');
    writeRuntime(pluginRoot, 'connect', { mysql2: '3.15.3' });
    const lock = path.join(dataRoot, 'deps', '.locks', 'connect.lock');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(
      path.join(lock, 'owner.json'),
      `${JSON.stringify({ pid: 2_147_483_647, token: 'shared-dead-generation-token' })}\n`
    );

    let installs = 0;
    const runCommand: RunCommand = async (_command, args): Promise<void> => {
      const prefixIndex = args.indexOf('--prefix');
      if (args.includes('ci') && prefixIndex >= 0) {
        installs += 1;
        await new Promise(resolve => setTimeout(resolve, 100));
        materializePackages(args[prefixIndex + 1]);
      }
    };

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        runtimeDeps.ensureRuntimeDependencies({
          pluginRoot,
          dataRoot,
          server: 'connect',
          runCommand,
          lockWaitMs: 5_000,
        })
      )
    );

    expect(installs).toBe(1);
    expect(results.every(result => result.prepared)).toBe(true);
    expect(results.filter(result => result.repaired)).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(false);
    const tombstones = fs
      .readdirSync(path.dirname(lock))
      .filter(name => name.startsWith('connect.lock.stale.'));
    expect(tombstones).toHaveLength(1);
  });

  it('reaps a dead owner promptly but never steals an old lock from a live owner', async () => {
    const root = tempDir();
    const pluginRoot = path.join(root, 'plugin');
    const dataRoot = path.join(root, 'data');
    writeRuntime(pluginRoot, 'connect', { mysql2: '3.15.3' });
    const lock = path.join(dataRoot, 'deps', '.locks', 'connect.lock');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(
      path.join(lock, 'owner.json'),
      `${JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner-token-00000000' })}\n`
    );
    const observed = { installs: 0, loads: [] as string[], binaries: 0 };
    const repaired = await runtimeDeps.ensureRuntimeDependencies({
      pluginRoot,
      dataRoot,
      server: 'connect',
      runCommand: successfulRunner(observed),
      lockWaitMs: 1_000,
    });
    expect(repaired).toMatchObject({ prepared: true, repaired: true });
    expect(observed.installs).toBe(1);
    expect(fs.existsSync(lock)).toBe(false);

    fs.rmSync(path.join(dataRoot, 'deps', 'connect'), { recursive: true, force: true });
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(
      path.join(lock, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'live-owner-token-00000000' })}\n`
    );
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    await expect(
      runtimeDeps.ensureRuntimeDependencies({
        pluginRoot,
        dataRoot,
        server: 'connect',
        runCommand: successfulRunner(observed),
        lockWaitMs: 25,
        staleLockMs: 0,
      })
    ).rejects.toThrow('Timed out waiting for runtime dependency lock');
    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).token).toBe(
      'live-owner-token-00000000'
    );
  });

  it('keeps the prior target and releases its lock after a failed repair so the next call retries', async () => {
    const root = tempDir();
    const pluginRoot = path.join(root, 'plugin');
    const dataRoot = path.join(root, 'data');
    writeRuntime(pluginRoot, 'connect', { pg: '8.16.3' });
    const target = path.join(dataRoot, 'deps', 'connect');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'sentinel'), 'keep');

    await expect(
      runtimeDeps.ensureRuntimeDependencies({
        pluginRoot,
        dataRoot,
        server: 'connect',
        runCommand: async (_command, args): Promise<void> => {
          if (args.includes('ci')) {
            throw new Error('registry unavailable');
          }
        },
      })
    ).rejects.toThrow('registry unavailable');
    expect(fs.readFileSync(path.join(target, 'sentinel'), 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(dataRoot, 'deps', '.locks', 'connect.lock'))).toBe(false);

    const observed = { installs: 0, loads: [] as string[], binaries: 0 };
    const retried = await runtimeDeps.ensureRuntimeDependencies({
      pluginRoot,
      dataRoot,
      server: 'connect',
      runCommand: successfulRunner(observed),
    });
    expect(retried).toMatchObject({ prepared: true, repaired: true });
    expect(observed.installs).toBe(1);
    expect(fs.existsSync(path.join(target, 'sentinel'))).toBe(false);
  });

  it('rejects floating versions and manifest-lock drift before invoking a package manager', async () => {
    const root = tempDir();
    const pluginRoot = path.join(root, 'plugin');
    const dataRoot = path.join(root, 'data');
    let invoked = false;
    const runCommand: RunCommand = async (): Promise<void> => {
      invoked = true;
    };

    writeRuntime(pluginRoot, 'connect', { pg: '^8.16.3' });
    await expect(
      runtimeDeps.ensureRuntimeDependencies({ pluginRoot, dataRoot, server: 'connect', runCommand })
    ).rejects.toThrow('must use an exact version');

    writeRuntime(pluginRoot, 'connect', { pg: '8.16.3' }, { pg: '8.16.2' });
    await expect(
      runtimeDeps.inspectRuntimeDependencies({
        pluginRoot,
        dataRoot,
        server: 'connect',
        runCommand,
      })
    ).rejects.toThrow('manifest and committed lockfile dependencies do not match');
    expect(invoked).toBe(false);
  });

  it('contains a Windows process-tree fallback for timed-out npm commands', () => {
    const source = fs.readFileSync(helperPath, 'utf8');
    expect(source).toContain("'taskkill.exe'");
    expect(source).toContain("['/PID', String(child.pid), '/T', '/F']");
  });

  it('refuses a durable dependency root nested lexically or through a symlink inside the plugin', async () => {
    const root = tempDir();
    const pluginRoot = path.join(root, 'plugin');
    writeRuntime(pluginRoot, 'connect', { pg: '8.16.3' });
    await expect(
      runtimeDeps.ensureRuntimeDependencies({
        pluginRoot,
        dataRoot: path.join(pluginRoot, 'state'),
        server: 'connect',
      })
    ).rejects.toThrow('outside the plugin tree');

    const symlinkedData = path.join(root, 'symlinked-data');
    fs.mkdirSync(path.join(pluginRoot, 'state'), { recursive: true });
    fs.symlinkSync(path.join(pluginRoot, 'state'), symlinkedData, 'dir');
    await expect(
      runtimeDeps.ensureRuntimeDependencies({
        pluginRoot,
        dataRoot: symlinkedData,
        server: 'connect',
      })
    ).rejects.toThrow('resolve inside the immutable plugin tree');
  });
});
