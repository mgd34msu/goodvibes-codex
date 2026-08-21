/**
 * connect service-registry persistence.
 *
 * Service and connection policy lives in the shared GoodVibes data root, apart
 * from credentials. The MCP service tool reads this state but cannot mutate it;
 * only the interactive control utility performs authority changes. Credentials
 * live in their own owner-only file, and version 0.1.x has no cookie store.
 *
 * The file is read fresh on every access (small, infrequent) so a write by one
 * call is visible to the next without cache-invalidation bugs, the same
 * property required for prompt revocation.
 */

import * as crypto from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { statePath } from '@goodvibes/core/config';
import { acquireLockFile } from '@goodvibes/core/lockfile';

/** HTTP methods considered non-mutating (always allowed under read-only default). */
export const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;

/** Configuration for a single registered API service. */
export interface ServiceConfig {
  /** Base URL (e.g. "https://api.github.com"). Credentials pin to this origin. */
  base_url: string;
  /** Default headers applied to every request to this service. */
  default_headers?: Record<string, string>;
  /** Auth type configured for this service (references the secrets store). */
  auth_type?: 'bearer' | 'basic' | 'api-key' | 'none';
  /** Requests-per-second hint. */
  rate_limit_rps?: number;
  /** Request timeout in ms. */
  timeout_ms?: number;
  /** Display description. */
  description?: string;
  /**
   * Trust boundary: write methods this service is allowed to use.
   * Absent/empty means read-only, only SAFE_METHODS are permitted. Opting into
   * writes is explicit and per-service.
   */
  write_methods?: string[];
  /** Explicit control-plane grant for private/link-local destinations. */
  allow_private_network?: boolean;
}

/** URL pattern mapping a hostname to a service name (exact match, no wildcards). */
export interface UrlPattern {
  hostname: string;
  service: string;
}

/**
 * A registered database connection (db_query trust model). Credentials are kept
 * out of this non-0600 file by preferring `url_env` (the name of an environment
 * variable holding the full connection URL); an inline `url` is meant for
 * secret-free targets like a local SQLite file path. Writes are read-only by
 * default and require an explicit per-connection `allow_writes` opt-in.
 */
export interface DbConnection {
  /** Opaque key in the owner-only secrets file. Never an env-var name or URL. */
  secret_ref: string;
  /** Opt-in to write queries on this connection (default read-only). */
  allow_writes?: boolean;
  /** Display description. */
  description?: string;
}

/** The persisted connect registry. */
export interface FetchConfig {
  /** Named service configurations. */
  services?: Record<string, ServiceConfig>;
  /** Hostname → service resolution patterns. */
  url_patterns?: UrlPattern[];
  /**
   * Trust boundary: destination allowlist of extra hostnames
   * reachable with a bare `url` (no service) while in restricted mode.
   * Registered service origins are always reachable and need no entry here.
   */
  allowlist?: string[];
  /** Global defaults merged under service and request headers. */
  global_defaults?: {
    headers?: Record<string, string>;
    timeout_ms?: number;
    user_agent?: string;
  };
  /** Named database connections for `db_query` (registered-connection-only trust). */
  connections?: Record<string, DbConnection>;
}

/** The registry file path, `services.json` under the durable GoodVibes data root. */
export function registryPath(): string {
  return statePath('services.json');
}

/** Read the registry synchronously; returns `{}` when the file is absent/invalid. */
export function getRegistry(): FetchConfig {
  try {
    const file = registryPath();
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {};
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      return {};
    }
    const content = fs.readFileSync(file, 'utf-8');
    return JSON.parse(content) as FetchConfig;
  } catch {
    return {};
  }
}

/** Write the registry to disk (creates the state dir as needed). */
export async function saveRegistry(config: FetchConfig): Promise<void> {
  const file = registryPath();
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });

  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing unsafe registry path: ${file}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
    await fs.promises.rename(temporary, file);
    if (process.platform !== 'win32') {
      await fs.promises.chmod(file, 0o600);
    }
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

/** How long a registry mutation waits for another mutation to finish. */
const REGISTRY_LOCK_WAIT_MS = 5_000;

/**
 * Apply a change to the registry as one serialized read-modify-write.
 *
 * Every mutation reads the whole file, edits it in memory, and writes the whole
 * file back. Two of those interleaving would make the second write erase the
 * first caller's service, connection, or allowlist entry with no error to
 * either side, so the registry has one shared write path guarded by a lock file
 * and `mutate` always sees state read fresh inside that lock.
 *
 * @param mutate - receives the current registry and returns the result to pass
 *   back to the caller; the (possibly mutated) config is saved afterwards
 */
export async function updateRegistry<T>(
  mutate: (config: FetchConfig) => T | Promise<T>
): Promise<T> {
  const release = await acquireLockFile(`${registryPath()}.lock`, {
    waitMs: REGISTRY_LOCK_WAIT_MS,
    busyMessage: (lockFile, waitMs) =>
      `Timed out after ${waitMs}ms waiting for the connect registry lock '${lockFile}'.`,
  });
  try {
    const config = getRegistry();
    const result = await mutate(config);
    await saveRegistry(config);
    return result;
  } finally {
    await release();
  }
}
