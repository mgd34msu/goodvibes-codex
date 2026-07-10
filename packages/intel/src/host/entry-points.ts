/**
 * Entry-point detection for a package/directory.
 *
 * Ported verbatim from project-engine `core/code-intel/entry-points.ts`.
 * Reads package.json main/module/exports, then falls back to conventional
 * entry-point file names, then a `src/` subdirectory.
 */

import * as node_fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  assertExistingPathWithinSelectedRoot,
  assertPathWithinSelectedRoot,
} from '@goodvibes/core/fsx';

import { ENTRY_POINT_NAMES } from './constants.js';

/**
 * Auto-detect entry points for a directory.
 * @param dirPath - absolute directory to inspect
 * @returns absolute entry-point file paths that exist on disk
 */
export async function detectEntryPoints(
  dirPath: string,
  analysisRoot: string = dirPath
): Promise<string[]> {
  const root = assertExistingPathWithinSelectedRoot(analysisRoot, analysisRoot);
  const safeDir = assertExistingPathWithinSelectedRoot(dirPath, root);
  const entryPoints: string[] = [];

  let packageJson: Record<string, unknown> | null = null;
  try {
    const packageJsonPath = assertExistingPathWithinSelectedRoot(
      path.join(safeDir, 'package.json'),
      root
    );
    const content = await node_fs.readFile(packageJsonPath, 'utf-8');
    packageJson = JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.includes('escapes the selected workspace root')) {
      throw error;
    }
    // no/invalid package.json — fall through to conventions
  }

  const addIfExists = async (p: string): Promise<void> => {
    const candidate = assertPathWithinSelectedRoot(p, root);
    try {
      await node_fs.access(candidate);
      const safePath = assertExistingPathWithinSelectedRoot(candidate, root);
      if (!entryPoints.includes(safePath)) {
        entryPoints.push(safePath);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('escapes the selected workspace root')) {
        throw error;
      }
      // does not exist — skip
    }
  };

  if (packageJson) {
    const addExportPath = async (
      exportPath: string | { default?: string; import?: string; require?: string }
    ): Promise<void> => {
      if (typeof exportPath === 'string') {
        await addIfExists(path.resolve(safeDir, exportPath));
      } else if (typeof exportPath === 'object') {
        for (const key of ['default', 'import', 'require'] as const) {
          const val = exportPath[key];
          if (typeof val === 'string') {
            await addIfExists(path.resolve(safeDir, val));
          }
        }
      }
    };

    if (typeof packageJson.main === 'string') {
      const mainPath = path.resolve(safeDir, packageJson.main);
      await addIfExists(mainPath);
      const tsVersion = mainPath.replace(/\.js$/, '.ts');
      if (mainPath !== tsVersion) {
        await addIfExists(tsVersion);
      }
    }

    if (typeof packageJson.module === 'string') {
      await addIfExists(path.resolve(safeDir, packageJson.module));
    }

    if (packageJson.exports) {
      if (typeof packageJson.exports === 'string') {
        await addExportPath(packageJson.exports);
      } else if (typeof packageJson.exports === 'object' && packageJson.exports !== null) {
        const exportsObj = packageJson.exports as Record<string, unknown>;
        for (const key of Object.keys(exportsObj)) {
          const value = exportsObj[key];
          if (typeof value === 'string') {
            await addIfExists(path.resolve(safeDir, value));
          } else if (typeof value === 'object' && value !== null) {
            await addExportPath(value as { default?: string; import?: string; require?: string });
          }
        }
      }
    }
  }

  for (const name of ENTRY_POINT_NAMES) {
    await addIfExists(path.join(safeDir, name));
  }

  const srcDir = path.join(safeDir, 'src');
  try {
    const safeSrcDir = assertExistingPathWithinSelectedRoot(srcDir, root);
    if ((await node_fs.stat(safeSrcDir)).isDirectory()) {
      for (const name of ENTRY_POINT_NAMES) {
        await addIfExists(path.join(safeSrcDir, name));
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('escapes the selected workspace root')) {
      throw error;
    }
    // no src directory
  }

  return entryPoints;
}
