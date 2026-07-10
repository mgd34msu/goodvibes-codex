/**
 * Database driver loading for connect `db_query`.
 *
 * Drivers resolve only from the plugin runtime or its durable dependency
 * directory. Project cwd is intentionally never searched: an untrusted
 * workspace must not be able to replace a database driver with arbitrary code.
 */

import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import * as path from 'node:path';

export type AnyModule = Record<string, unknown>;

const mockDrivers: Record<string, AnyModule | null> = {};

/** Set a mock driver for testing. @internal */
export function setMockDriver(moduleName: string, driver: AnyModule | null): void {
  mockDrivers[moduleName] = driver;
}

/** Clear all mock drivers. @internal */
export function clearMockDrivers(): void {
  for (const key of Object.keys(mockDrivers)) {
    delete mockDrivers[key];
  }
}

/** Resolve a module name from the plugin or prepared runtime dependencies. @internal */
function resolveFromRuntime(moduleName: string): string | null {
  try {
    const anchor = process.env.GOODVIBES_PLUGIN_ROOT
      ? path.join(process.env.GOODVIBES_PLUGIN_ROOT, 'server', 'connect', 'launcher.cjs')
      : import.meta.url;
    const req = createRequire(anchor);
    return req.resolve(moduleName);
  } catch {
    return null;
  }
}

/**
 * Dynamically import a database driver from the controlled runtime roots.
 * @param moduleName - the npm package name (e.g. "pg")
 * @returns the module, or null when it has not been prepared for the plugin
 */
export async function dynamicImport(moduleName: string): Promise<AnyModule | null> {
  if (moduleName in mockDrivers) {
    return mockDrivers[moduleName];
  }

  const resolved = resolveFromRuntime(moduleName);
  if (!resolved) {
    return null;
  }

  try {
    return (await import(pathToFileURL(resolved).href)) as AnyModule;
  } catch {
    return null;
  }
}

/** Load the PostgreSQL driver from controlled runtime dependencies. */
export async function loadPostgresDriver(): Promise<AnyModule | null> {
  return dynamicImport('pg');
}

/** Load the MySQL driver from controlled runtime dependencies. */
export async function loadMysqlDriver(): Promise<AnyModule | null> {
  return dynamicImport('mysql2/promise');
}

/** Detect the driver type from a connection URL. */
export function detectDriver(url: string): 'postgresql' | 'mysql' | 'sqlite' | 'unknown' {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return 'postgresql';
  }
  if (url.startsWith('mysql://')) {
    return 'mysql';
  }
  if (
    url.startsWith('sqlite:') ||
    url.startsWith('file:') ||
    url.match(/\.(db|sqlite|sqlite3)$/i)
  ) {
    return 'sqlite';
  }
  if (url === ':memory:') {
    return 'sqlite';
  }
  return 'unknown';
}
