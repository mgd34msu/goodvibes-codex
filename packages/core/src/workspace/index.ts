/** Codex host workspace authority and path-boundary helpers. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TrustedRootsDocument {
  version: 1;
  roots: string[];
}

export function codexHome(): string {
  return process.env['CODEX_HOME'] || path.join(os.homedir(), '.codex');
}

export function goodvibesDataRoot(): string {
  return process.env['GOODVIBES_DATA_ROOT'] || path.join(codexHome(), 'goodvibes');
}

export function trustedRootsPath(): string {
  return (
    process.env['GOODVIBES_TRUSTED_ROOTS_FILE'] ||
    path.join(goodvibesDataRoot(), 'trusted-roots.json')
  );
}

function canonicalExisting(value: string): string {
  return fs.realpathSync.native(path.resolve(value));
}

function normalizeRoots(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const roots = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') {
      continue;
    }
    try {
      const resolved = canonicalExisting(value);
      if (fs.statSync(resolved).isDirectory()) {
        roots.add(resolved);
      }
    } catch {
      // Ignore deleted, malformed, and inaccessible registrations.
    }
  }
  return [...roots].sort();
}

export function loadTrustedRoots(): string[] {
  const testOverride = process.env['GOODVIBES_TRUSTED_ROOTS'];
  if (testOverride) {
    try {
      const parsed = JSON.parse(testOverride) as unknown;
      return normalizeRoots(parsed);
    } catch {
      return normalizeRoots(testOverride.split(path.delimiter));
    }
  }

  try {
    const file = trustedRootsPath();
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return [];
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TrustedRootsDocument>;
    if (parsed.version !== 1) {
      return [];
    }
    return normalizeRoots(parsed.roots);
  } catch {
    return [];
  }
}

export function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/**
 * Resolve a path through its nearest existing ancestor. Unlike a lexical
 * `path.resolve`, this also accounts for symlinks in every existing component
 * while still supporting destinations that have not been created yet.
 */
export function canonicalizePath(candidate: string): string {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return path.join(real, ...suffix.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`No accessible ancestor exists for '${candidate}'.`);
      }
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Constrain `candidate` to one particular selected workspace root.
 *
 * This is intentionally stricter than {@link assertPathTrusted}: being inside
 * some registered workspace is not sufficient once a request selected a
 * specific `base_path`. Both existing paths and the nearest existing ancestor
 * of future write destinations are canonicalized, so nested symlinks cannot
 * cross the selected boundary.
 */
export function assertPathWithinSelectedRoot(candidate: string, selectedRoot: string): string {
  const root = canonicalizePath(selectedRoot);
  const resolved = canonicalizePath(candidate);
  if (!isPathWithin(resolved, root)) {
    throw new Error(
      `Path '${path.resolve(candidate)}' escapes the selected workspace root '${root}'.`
    );
  }
  return resolved;
}

/** Existing-path variant of {@link assertPathWithinSelectedRoot}. */
export function assertExistingPathWithinSelectedRoot(
  candidate: string,
  selectedRoot: string
): string {
  const root = canonicalizePath(selectedRoot);
  const resolved = canonicalExisting(candidate);
  if (!isPathWithin(resolved, root)) {
    throw new Error(
      `Path '${path.resolve(candidate)}' escapes the selected workspace root '${root}'.`
    );
  }
  return resolved;
}

function trustEnforced(): boolean {
  if (process.env['GOODVIBES_ENFORCE_TRUSTED_ROOTS'] === '0') {
    return false;
  }
  if (process.env['GOODVIBES_ENFORCE_TRUSTED_ROOTS'] === '1') {
    return true;
  }
  return !process.env['VITEST'];
}

export function assertPathTrusted(candidate: string, roots: string[] = loadTrustedRoots()): string {
  const resolved = canonicalizePath(candidate);
  if (!trustEnforced()) {
    return resolved;
  }
  if (roots.some(root => isPathWithin(resolved, root))) {
    return resolved;
  }
  const registration = `node plugins/goodvibes/scripts/goodvibes-control.mjs roots add ${JSON.stringify(path.resolve(candidate))}`;
  throw new Error(
    `Path '${path.resolve(candidate)}' is outside every trusted GoodVibes workspace. ` +
      `Register the workspace directly in a terminal first: ${registration}`
  );
}

export function resolveTrustedBase(basePath?: string, fallback?: string): string {
  const roots = loadTrustedRoots();
  if (!trustEnforced()) {
    if (!basePath) {
      return path.resolve(fallback || process.cwd());
    }
    return path.isAbsolute(basePath)
      ? path.resolve(basePath)
      : path.resolve(fallback || process.cwd(), basePath);
  }

  if (!basePath) {
    if (roots.length === 1) {
      return roots[0];
    }
    if (roots.length === 0) {
      throw new Error(
        'No trusted GoodVibes workspace is registered. Run $goodvibes-maintenance for setup instructions.'
      );
    }
    throw new Error('Multiple GoodVibes workspaces are registered; pass base_path explicitly.');
  }

  const candidate = path.isAbsolute(basePath)
    ? basePath
    : path.resolve(fallback || roots[0] || process.cwd(), basePath);
  const canonical = canonicalExisting(candidate);
  if (!roots.some(root => isPathWithin(canonical, root))) {
    throw new Error(`base_path '${basePath}' is not inside a trusted GoodVibes workspace.`);
  }
  return canonical;
}
