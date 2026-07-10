/**
 * Regression coverage for installed SQLite driver resolution.
 *
 * Codex launchers add the durable dependency directory to NODE_PATH before
 * loading the bundled server. Node's ESM resolver ignores NODE_PATH, so the
 * pool must resolve sql.js through a CommonJS require anchored in the
 * installed plugin tree.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const nodeModule = createRequire(import.meta.url)('node:module') as {
  _initPaths(): void;
};

describe('installed SQLite dependency resolution', () => {
  let temporaryRoot: string | undefined;
  let previousNodePath: string | undefined;
  let previousPluginRoot: string | undefined;
  let sqlitePool: typeof import('../db/sqlite-pool.js') | undefined;

  afterEach(async () => {
    sqlitePool?.shutdownConnectionPool();
    sqlitePool = undefined;

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

    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = undefined;
    }
  });

  it('loads sql.js from the prepared durable NODE_PATH beside an installed plugin', async () => {
    previousNodePath = process.env.NODE_PATH;
    previousPluginRoot = process.env.GOODVIBES_PLUGIN_ROOT;
    temporaryRoot = await mkdtemp(path.join(tmpdir(), 'goodvibes-sqlite-resolution-'));

    const pluginRoot = path.join(
      temporaryRoot,
      'codex-home',
      'plugins',
      'cache',
      'goodvibes',
      'goodvibes',
      '0.1.0'
    );
    const connectServer = path.join(pluginRoot, 'server', 'connect');
    const durableNodeModules = path.join(
      temporaryRoot,
      'codex-home',
      'goodvibes',
      'deps',
      'connect',
      'node_modules'
    );
    const durableSqlJs = path.join(durableNodeModules, 'sql.js');

    await mkdir(connectServer, { recursive: true });
    await mkdir(durableSqlJs, { recursive: true });
    await writeFile(path.join(connectServer, 'launcher.cjs'), '', 'utf8');
    await writeFile(
      path.join(durableSqlJs, 'package.json'),
      `${JSON.stringify({ name: 'sql.js', version: '0.0.0-test', main: 'index.cjs' })}\n`,
      'utf8'
    );
    await writeFile(
      path.join(durableSqlJs, 'index.cjs'),
      `'use strict';
class DurableDatabase {
  run() {}
  exec() { return [{ columns: ['source'], values: [['durable-node-path']] }]; }
  prepare() { throw new Error('prepare was not expected'); }
  close() {}
  export() { return new Uint8Array(); }
  getRowsModified() { return 0; }
}
module.exports = async function initSqlJs() { return { Database: DurableDatabase }; };
`,
      'utf8'
    );

    process.env.GOODVIBES_PLUGIN_ROOT = pluginRoot;
    process.env.NODE_PATH = durableNodeModules;
    nodeModule._initPaths();
    vi.resetModules();

    sqlitePool = await import('../db/sqlite-pool.js');
    const result = await sqlitePool.withConnection(
      { filepath: ':memory:', readonly: true },
      database => database.exec('DURABLE RESOLUTION PROBE')
    );

    expect(result).toEqual([{ columns: ['source'], values: [['durable-node-path']] }]);
  });
});
