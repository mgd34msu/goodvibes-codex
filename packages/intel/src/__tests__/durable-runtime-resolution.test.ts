/** Regression coverage for Intel packages installed only in the durable root. */

import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nodeModule = createRequire(import.meta.url)('node:module') as {
  _initPaths(): void;
};

describe('installed Intel dependency resolution', () => {
  let temporaryRoot: string;
  let durableNodeModules: string;
  let previousNodePath: string | undefined;
  let previousPluginRoot: string | undefined;

  beforeEach(async () => {
    previousNodePath = process.env.NODE_PATH;
    previousPluginRoot = process.env.GOODVIBES_PLUGIN_ROOT;
    temporaryRoot = await mkdtemp(path.join(tmpdir(), 'goodvibes-intel-runtime-'));

    const pluginRoot = path.join(
      temporaryRoot,
      'codex-home',
      'plugins',
      'cache',
      'goodvibes',
      'goodvibes',
      '0.1.0'
    );
    durableNodeModules = path.join(
      temporaryRoot,
      'codex-home',
      'goodvibes',
      'deps',
      'intel',
      'node_modules'
    );
    await mkdir(path.join(pluginRoot, 'server', 'intel'), { recursive: true });
    await writeFile(path.join(pluginRoot, 'server', 'intel', 'launcher.cjs'), '', 'utf8');
    await mkdir(durableNodeModules, { recursive: true });

    process.env.GOODVIBES_PLUGIN_ROOT = pluginRoot;
    process.env.NODE_PATH = durableNodeModules;
    nodeModule._initPaths();
    vi.resetModules();
  });

  afterEach(async () => {
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
    delete (globalThis as Record<string, unknown>).__goodvibesDurableTreeSitter;
    delete (globalThis as Record<string, unknown>).__goodvibesDurableAstGrep;
    nodeModule._initPaths();
    vi.resetModules();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('loads web-tree-sitter through durable NODE_PATH', async () => {
    const packageRoot = path.join(durableNodeModules, 'web-tree-sitter');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify({
        name: 'web-tree-sitter',
        version: '0.0.0-test',
        type: 'module',
        exports: './index.js',
      })}\n`,
      'utf8'
    );
    await writeFile(
      path.join(packageRoot, 'index.js'),
      `globalThis.__goodvibesDurableTreeSitter = true;
export class Parser {
  static async init() {}
  setLanguage() {}
  parse() { return null; }
}
export class Language { static async load() { return {}; } }
`,
      'utf8'
    );

    const { TreeSitterCore } = await import('../lib/tree-sitter.js');
    await expect(new TreeSitterCore().init()).resolves.toBeUndefined();
    expect((globalThis as Record<string, unknown>).__goodvibesDurableTreeSitter).toBe(true);
  });

  it('retries web-tree-sitter resolution after an in-session repair', async () => {
    const { TreeSitterCore, TreeSitterUnavailableError } = await import('../lib/tree-sitter.js');
    await expect(new TreeSitterCore().init()).rejects.toBeInstanceOf(TreeSitterUnavailableError);

    const packageRoot = path.join(durableNodeModules, 'web-tree-sitter');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify({
        name: 'web-tree-sitter',
        version: '0.0.0-test',
        type: 'module',
        exports: './index.js',
      })}\n`,
      'utf8'
    );
    await writeFile(
      path.join(packageRoot, 'index.js'),
      `export class Parser {
  static async init() {}
  setLanguage() {}
  parse() { return null; }
}
export class Language { static async load() { return {}; } }
`,
      'utf8'
    );

    await expect(new TreeSitterCore().init()).resolves.toBeUndefined();
  });

  it('loads @ast-grep/napi through durable NODE_PATH', async () => {
    const { computeEdit } = await import('../edit/engine.js');
    const request = {
      filePath: 'example.ts',
      find: 'console.log($A)',
      replace: 'logger.info(1)',
      mode: 'ast_pattern' as const,
      occurrence: 'all' as const,
      caseSensitive: true,
    };
    await expect(computeEdit('console.log(1)', request)).resolves.toMatchObject({
      status: 'error',
      matchCount: 0,
    });

    const packageRoot = path.join(durableNodeModules, '@ast-grep', 'napi');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify({
        name: '@ast-grep/napi',
        version: '0.0.0-test',
        main: 'index.cjs',
      })}\n`,
      'utf8'
    );
    await writeFile(
      path.join(packageRoot, 'index.cjs'),
      `'use strict';
exports.Lang = { TypeScript: 'durable-typescript' };
exports.parse = function parse(language, source) {
  globalThis.__goodvibesDurableAstGrep = language;
  const text = source;
  const match = {
    range() { return { start: { line: 0, column: 0 }, end: { line: 0, column: text.length } }; },
    text() { return text; },
    getMatch() { return null; },
    getMultipleMatches() { return []; },
  };
  return { root() { return { findAll() { return [match]; } }; } };
};
`,
      'utf8'
    );

    const result = await computeEdit('console.log(1)', request);

    expect(result).toMatchObject({
      status: 'ready',
      matchCount: 1,
      newContent: 'logger.info(1)',
    });
    expect((globalThis as Record<string, unknown>).__goodvibesDurableAstGrep).toBe(
      'durable-typescript'
    );
  });
});
