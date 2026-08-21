/**
 * tsconfig discovery + parsing, and TypeScript lib-directory resolution.
 *
 * Ported from project-engine `core/code-intel/tsconfig.ts` and the
 * `findTypescriptLibDir` helper from `core/code-intel/virtual-fs.ts`.
 *
 * Lib-dir resolution matters in v2 because `typescript` is BUNDLED into the
 * server (§5.1): at runtime `ts.getDefaultLibFilePath()` resolves next to the
 * esbuild bundle, where the `lib.*.d.ts` files do NOT live. So the host prefers
 * the TARGET project's `node_modules/typescript/lib` (found by walking up),
 * falling back to the bundled default only when the project has no TypeScript.
 */

import * as fs from 'node:fs';
import * as node_fs from 'node:fs/promises';
import * as path from 'node:path';
import ts from 'typescript';

import { logger } from '@goodvibes/core/logging';
import {
  assertExistingPathWithinSelectedRoot,
  assertPathWithinSelectedRoot,
} from '@goodvibes/core/fsx';
import { toTsPath } from './paths.js';
import { TS_ANALYSIS_OPTIONS } from './constants.js';

/**
 * Walk up from `startPath` to find the nearest `tsconfig.json` (synchronous,
 * used inside the synchronous language-service host callbacks).
 * @param startPath - file or directory to start from
 * @returns TS-normalized absolute path to the tsconfig, or null
 */
export function findTsConfigSync(startPath: string, analysisRoot: string): string | null {
  const root = assertExistingPathWithinSelectedRoot(analysisRoot, analysisRoot);
  const safeStart = assertPathWithinSelectedRoot(startPath, root);
  let dir = path.extname(safeStart) ? path.dirname(safeStart) : safeStart;

  for (;;) {
    const tsconfigPath = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      return toTsPath(assertExistingPathWithinSelectedRoot(tsconfigPath, root));
    }
    if (dir === root) {
      break;
    }
    const parentDir = path.dirname(dir);
    if (parentDir === dir) {
      break;
    }
    dir = parentDir;
  }
  return null;
}

/**
 * Async variant of {@link findTsConfigSync}.
 * @param startPath - file or directory to start from
 */
export async function findTsConfig(
  startPath: string,
  analysisRoot: string
): Promise<string | null> {
  const root = assertExistingPathWithinSelectedRoot(analysisRoot, analysisRoot);
  const safeStart = assertPathWithinSelectedRoot(startPath, root);
  let dir = path.extname(safeStart) ? path.dirname(safeStart) : safeStart;

  for (;;) {
    const tsconfigPath = path.join(dir, 'tsconfig.json');
    try {
      await node_fs.access(tsconfigPath);
      return toTsPath(assertExistingPathWithinSelectedRoot(tsconfigPath, root));
    } catch (error) {
      if (error instanceof Error && error.message.includes('escapes the selected workspace root')) {
        throw error;
      }
      // not here; keep walking
    }
    if (dir === root) {
      break;
    }
    const parentDir = path.dirname(dir);
    if (parentDir === dir) {
      break;
    }
    dir = parentDir;
  }
  return null;
}

/**
 * Read and parse a tsconfig synchronously, merged over the analysis defaults.
 * @param configPath - absolute path to tsconfig.json
 */
export function readTsConfigSync(configPath: string, analysisRoot: string): ts.CompilerOptions {
  return parseTsConfigSync(configPath, analysisRoot).options;
}

/**
 * Parse a tsconfig synchronously, returning BOTH the merged compiler options and
 * the resolved project file list. The file list seeds the program's root set so
 * project-wide reference searches (code_safe_delete) see sibling files that do
 * not import the target, TypeScript's reference engine only searches files that
 * are part of the program.
 * @param configPath - absolute path to tsconfig.json
 */
export function parseTsConfigSync(
  configPath: string,
  analysisRoot: string
): {
  options: ts.CompilerOptions;
  fileNames: string[];
} {
  const root = assertExistingPathWithinSelectedRoot(analysisRoot, analysisRoot);
  const safeConfigPath = assertExistingPathWithinSelectedRoot(configPath, root);
  const configDir = toTsPath(path.dirname(safeConfigPath));

  const safeCandidate = (candidate: string): string =>
    assertPathWithinSelectedRoot(
      path.isAbsolute(candidate) ? candidate : path.resolve(configDir, candidate),
      root
    );
  const parseHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: fileName => ts.sys.fileExists(safeCandidate(fileName)),
    readFile: fileName => ts.sys.readFile(safeCandidate(fileName)),
    readDirectory: (rootDir, extensions, excludes, includes, depth) => {
      const safeDir = safeCandidate(rootDir);
      return ts.sys
        .readDirectory(safeDir, extensions, excludes, includes, depth)
        .map(fileName => assertExistingPathWithinSelectedRoot(fileName, root));
    },
    directoryExists: dirName => ts.sys.directoryExists(safeCandidate(dirName)),
  };
  const result = ts.readConfigFile(safeConfigPath, parseHost.readFile);

  if (result.error) {
    logger.warn(`Error reading tsconfig at ${configPath}`, result.error.messageText);
    return { options: { ...TS_ANALYSIS_OPTIONS }, fileNames: [] };
  }

  const parsed = ts.parseJsonConfigFileContent(
    result.config,
    parseHost,
    configDir,
    undefined,
    safeConfigPath
  );
  if (parsed.errors.length > 0) {
    logger.warn(`Errors parsing tsconfig at ${configPath}`, parsed.errors.length);
  }

  const validateOptionPath = (candidate: string): void => {
    assertPathWithinSelectedRoot(candidate, root);
  };
  for (const optionPath of [
    parsed.options.baseUrl,
    parsed.options.rootDir,
    ...(parsed.options.rootDirs ?? []),
    ...(parsed.options.typeRoots ?? []),
  ]) {
    if (optionPath) {
      validateOptionPath(optionPath);
    }
  }
  const pathBase = parsed.options.baseUrl ?? configDir;
  for (const targets of Object.values(parsed.options.paths ?? {})) {
    for (const target of targets) {
      validateOptionPath(path.resolve(pathBase, target));
    }
  }
  for (const reference of parsed.projectReferences ?? []) {
    validateOptionPath(reference.path);
  }

  return {
    options: { ...TS_ANALYSIS_OPTIONS, ...parsed.options },
    fileNames: parsed.fileNames.map(fileName => assertPathWithinSelectedRoot(fileName, root)),
  };
}

/**
 * Async variant of {@link readTsConfigSync}.
 * @param configPath - absolute path to tsconfig.json
 */
export async function readTsConfig(
  configPath: string,
  analysisRoot: string
): Promise<ts.CompilerOptions> {
  return readTsConfigSync(configPath, analysisRoot);
}

/**
 * Find a TypeScript `lib` directory by walking up from a start directory.
 * Prefers the target project's own TypeScript so the bundled compiler can load
 * `lib.*.d.ts` at runtime (see module header).
 * @param startDir - directory to start walking from
 * @returns absolute path to a `.../typescript/lib` directory, or null
 */
export function findTypescriptLibDir(startDir: string, analysisRoot: string): string | null {
  const root = assertExistingPathWithinSelectedRoot(analysisRoot, analysisRoot);
  let dir = assertPathWithinSelectedRoot(startDir, root);
  for (;;) {
    const tsLibDir = path.join(dir, 'node_modules', 'typescript', 'lib');
    if (fs.existsSync(tsLibDir)) {
      return assertExistingPathWithinSelectedRoot(tsLibDir, root);
    }
    if (dir === root) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}
