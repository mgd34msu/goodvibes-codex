/**
 * Resolve an externalized Intel runtime package from the installed plugin or
 * the launcher's durable dependency roots.
 *
 * Node's ESM resolver ignores NODE_PATH. The launcher intentionally exposes
 * durable packages through NODE_PATH, so resolve with a CommonJS require that
 * is anchored in the Intel server and then import the resolved file URL.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

declare const __filename: string;

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function packageSegments(moduleName: string): string[] | null {
  const segments = moduleName.split('/');
  const valid = (value: string): boolean => /^[A-Za-z0-9._-]+$/.test(value);
  if (segments.length === 1 && valid(segments[0])) {
    return segments;
  }
  if (
    segments.length === 2 &&
    segments[0].startsWith('@') &&
    valid(segments[0].slice(1)) &&
    valid(segments[1])
  ) {
    return segments;
  }
  return null;
}

function conditionalExport(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const selected = conditionalExport(candidate);
      if (selected) {
        return selected;
      }
    }
    return null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const conditions = value as Record<string, unknown>;
  for (const condition of ['require', 'node', 'default', 'import']) {
    const selected = conditionalExport(conditions[condition]);
    if (selected) {
      return selected;
    }
  }
  return null;
}

function explicitRuntimeEntry(nodeModules: string, moduleName: string): string | null {
  const segments = packageSegments(moduleName);
  if (!segments) {
    return null;
  }
  const root = path.resolve(nodeModules);
  const packageRoot = path.join(root, ...segments);
  const packageFile = path.join(packageRoot, 'package.json');
  if (!existsSync(packageFile)) {
    return null;
  }

  try {
    const manifest = JSON.parse(readFileSync(packageFile, 'utf8')) as {
      main?: unknown;
      exports?: unknown;
    };
    const exportedRoot =
      manifest.exports &&
      typeof manifest.exports === 'object' &&
      !Array.isArray(manifest.exports) &&
      '.' in manifest.exports
        ? (manifest.exports as Record<string, unknown>)['.']
        : manifest.exports;
    const selected =
      conditionalExport(exportedRoot) ||
      (typeof manifest.main === 'string' ? manifest.main : 'index.js');
    const entry = path.resolve(packageRoot, selected);
    if (!isWithin(packageRoot, entry) || !existsSync(entry)) {
      return null;
    }

    const [realNodeModules, realPackageRoot, realEntry] = [root, packageRoot, entry].map(candidate =>
      realpathSync(candidate)
    );
    if (!isWithin(realNodeModules, realPackageRoot) || !isWithin(realPackageRoot, realEntry)) {
      return null;
    }
    return realEntry;
  } catch {
    return null;
  }
}

/** Import a package from launcher-controlled runtime roots, or return null. */
export async function importRuntimeModule<T>(moduleName: string): Promise<T | null> {
  try {
    const anchor = process.env.GOODVIBES_PLUGIN_ROOT
      ? path.join(process.env.GOODVIBES_PLUGIN_ROOT, 'server', 'intel', 'launcher.cjs')
      : typeof __filename === 'string'
        ? __filename
        : path.resolve(process.cwd(), 'package.json');
    for (const nodeModules of (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) {
      const entry = explicitRuntimeEntry(nodeModules, moduleName);
      if (entry) {
        return (await import(pathToFileURL(entry).href)) as T;
      }
    }
    const resolved = createRequire(anchor).resolve(moduleName);
    return (await import(pathToFileURL(resolved).href)) as T;
  } catch {
    return null;
  }
}
