/**
 * SQLite connection pool for connect `db_query`.
 *
 * Ported from v1 project-engine `core/database/sqlite-pool.ts`. v2 changes: the
 * WASM is located the same way `core/telemetry` does it (candidates beside the
 * bundle, falling back to sql.js's node_modules default in tests), and the v1
 * `logWarn` shared logger is replaced by a local `console.warn`.
 *
 * Ownership model. sql.js has no file locking and no shared state between
 * instances: `new SQL.Database(buffer)` is a private in-memory *copy* of the
 * file, and writing it back replaces the whole file. Handing that copy to more
 * than one writer at a time means the last writer's copy silently erases every
 * other writer's committed rows, so this pool gives one database file exactly
 * one writer path:
 *
 *   - one pooled connection per file, held exclusively for the duration of a
 *     call (the waiter queue serializes everyone else in this process);
 *   - a lock file beside the database serializes writers in *other* processes,
 *     taken before the snapshot is loaded so nobody can commit underneath it;
 *   - the file is replaced through a same-directory temporary and a rename, so
 *     a crash mid-write cannot truncate it and readers never see a partial file;
 *   - a cached snapshot is dropped when the file's identity on disk no longer
 *     matches what it was loaded from, so a read after any write is never stale;
 *   - read-only handles run with `PRAGMA query_only = ON`, so a write issued on
 *     one fails instead of mutating a snapshot that is then thrown away.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as nodePath from 'node:path';

import { acquireLockFile, type LockRelease } from '@goodvibes/core/lockfile';

import type { SqliteDatabase, SqliteConnectionOptions } from './types.js';

function logWarn(message: string, err?: unknown): void {
  console.warn(`[connect:db] ${message}${err ? `: ${String(err)}` : ''}`);
}

/** @internal sql.js module interface (kept local, no @types/sql.js needed). */
interface SqlJsStatic {
  Database: new (data?: ArrayLike<number> | Buffer | null) => SqliteDatabase;
}

let sqlJsInstance: SqlJsStatic | null = null;

/**
 * Resolve the sql.js `locateFile` config. When the WASM sits beside the bundle
 * (`server/` or `server/wasm/`) point sql.js there; otherwise let sql.js find it
 * in node_modules (the Vitest / source path).
 */
function sqlConfig(): { locateFile?: (file: string) => string } {
  // `__dirname` is defined in the CJS bundle and under Vitest; guard anyway so a
  // stray ESM context falls back to sql.js's node_modules default instead of throwing.
  const dir = typeof __dirname === 'string' ? __dirname : '';
  if (!dir) {
    return {};
  }
  const candidates = [
    nodePath.join(dir, 'sql-wasm.wasm'),
    nodePath.join(dir, 'wasm', 'sql-wasm.wasm'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      const dir = nodePath.dirname(c);
      return { locateFile: (file: string) => nodePath.join(dir, file) };
    }
  }
  return {};
}

/** Load or return the cached sql.js module. @internal */
async function getSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsInstance) {
    return sqlJsInstance;
  }

  try {
    const anchor = process.env.GOODVIBES_PLUGIN_ROOT
      ? nodePath.join(process.env.GOODVIBES_PLUGIN_ROOT, 'server', 'connect', 'launcher.cjs')
      : import.meta.url;
    const loaded = createRequire(anchor)('sql.js') as {
      default?: (opts: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;
    } & ((opts: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>);
    const initSqlJs = loaded.default ?? loaded;

    sqlJsInstance = await initSqlJs(sqlConfig());
    return sqlJsInstance;
  } catch (error) {
    throw new Error(
      `SQLite driver (sql.js) failed to initialize: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ── on-disk identity ─────────────────────────────────────────────────────────

/**
 * Canonical path for a database file, so aliases of one file (a symlink, a
 * relative path, a `..` segment) share one connection and one write lock
 * instead of each getting an independent copy of the same bytes.
 */
async function canonicalPath(filepath: string): Promise<string> {
  if (filepath === ':memory:') {
    return filepath;
  }
  try {
    return await realpath(filepath);
  } catch {
    // Not created yet: canonicalize the directory so the file still keys the same.
    try {
      return nodePath.join(await realpath(nodePath.dirname(filepath)), nodePath.basename(filepath));
    } catch {
      return nodePath.resolve(filepath);
    }
  }
}

/** What a cached snapshot was loaded from, so a replaced file can be detected. */
interface FileIdentity {
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  mode: number;
}

/** Stat the database file, or null when it does not exist yet. */
async function readFileIdentity(filepath: string): Promise<FileIdentity | null> {
  try {
    const info = await stat(filepath, { bigint: true });
    return {
      ino: info.ino,
      size: info.size,
      mtimeNs: info.mtimeNs,
      mode: Number(info.mode) & 0o777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function sameFile(a: FileIdentity | null, b: FileIdentity | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/** Replace the database file through a same-directory temporary and a rename. */
async function writeDatabaseFile(
  filepath: string,
  data: Uint8Array,
  mode: number | null
): Promise<void> {
  const temporary = nodePath.join(
    nodePath.dirname(filepath),
    `.${nodePath.basename(filepath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  );
  try {
    await writeFile(temporary, Buffer.from(data), { flag: 'wx' });
    if (mode !== null) {
      await chmod(temporary, mode);
    }
    await rename(temporary, filepath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

// ── cross-process write lock ─────────────────────────────────────────────────

/** A write lock whose holder cannot be checked is reclaimed after this long. */
const WRITE_LOCK_ABANDONED_MS = 60_000;

/** The lock file a writer holds while it owns `filepath`. */
export function sqliteWriteLockPath(filepath: string): string {
  return `${filepath}.goodvibes-write.lock`;
}

/** Take the cross-process write lock for a database file. */
function acquireWriteLock(filepath: string, timeoutMs: number): Promise<LockRelease> {
  return acquireLockFile(sqliteWriteLockPath(filepath), {
    waitMs: timeoutMs,
    abandonedAfterMs: WRITE_LOCK_ABANDONED_MS,
    busyMessage: (lockFile, waitMs) =>
      `Timed out after ${waitMs}ms waiting for the SQLite write lock '${lockFile}'. ` +
      'Another writer holds it; locks left by processes that no longer exist are reclaimed automatically.',
  });
}

// ── the pool ─────────────────────────────────────────────────────────────────

interface PooledConnection {
  database: SqliteDatabase | null;
  filepath: string;
  readonly: boolean;
  /** The on-disk state `database` was loaded from (null for `:memory:`). */
  identity: FileIdentity | null;
  lastUsed: number;
  inUse: boolean;
  isOpen: boolean;
  releaseWriteLock: LockRelease | null;
}

/** One exclusive SQLite connection per database file. */
class SqliteConnectionPool {
  private connections: Map<string, PooledConnection> = new Map();
  private waiters: Map<string, Array<(conn: PooledConnection) => void>> = new Map();
  private readonly idleTimeoutMs = 60_000;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanupIdleConnections(), 30_000);
    this.cleanupInterval.unref?.();
  }

  /**
   * Take exclusive ownership of a file's connection slot. The map is mutated
   * before any await, so two callers in the same tick cannot both decide the
   * slot is free.
   */
  private claim(filepath: string, timeoutMs: number): Promise<PooledConnection> {
    const existing = this.connections.get(filepath);
    if (!existing) {
      const created: PooledConnection = {
        database: null,
        filepath,
        readonly: true,
        identity: null,
        lastUsed: Date.now(),
        inUse: true,
        isOpen: false,
        releaseWriteLock: null,
      };
      this.connections.set(filepath, created);
      return Promise.resolve(created);
    }
    if (!existing.inUse) {
      existing.inUse = true;
      existing.lastUsed = Date.now();
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = this.waiters.get(filepath);
        const index = queue ? queue.indexOf(waiter) : -1;
        if (queue && index !== -1) {
          queue.splice(index, 1);
        }
        reject(new Error(`SQLite connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      const waiter = (conn: PooledConnection): void => {
        clearTimeout(timer);
        resolve(conn);
      };

      const queue = this.waiters.get(filepath) ?? [];
      queue.push(waiter);
      this.waiters.set(filepath, queue);
    });
  }

  async acquire(options: SqliteConnectionOptions): Promise<PooledConnection> {
    const readonly = options.readonly ?? true;
    const timeout = options.timeout ?? 5000;
    const filepath = await canonicalPath(options.filepath);
    const resolved: SqliteConnectionOptions = { ...options, filepath };
    const connection = await this.claim(filepath, timeout);

    try {
      if (!readonly && filepath !== ':memory:') {
        // Before the snapshot is loaded, so no other process can commit between
        // the load and the write-back.
        connection.releaseWriteLock = await acquireWriteLock(filepath, timeout);
      }
      await this.refresh(connection, resolved, readonly);
      return connection;
    } catch (error) {
      await this.release(connection);
      throw error;
    }
  }

  /** Load or revalidate the snapshot, then set the handle's access mode. */
  private async refresh(
    connection: PooledConnection,
    options: SqliteConnectionOptions,
    readonly: boolean
  ): Promise<void> {
    if (options.filepath !== ':memory:') {
      const identity = await readFileIdentity(options.filepath);
      if (connection.database && !sameFile(connection.identity, identity)) {
        this.closeConnection(connection);
      }
    }

    if (!connection.database) {
      const opened = await this.createConnection(options);
      connection.database = opened.database;
      connection.identity = opened.identity;
      connection.isOpen = true;
    }

    connection.readonly = readonly;
    try {
      connection.database.run(`PRAGMA query_only = ${readonly ? 'ON' : 'OFF'}`);
    } catch (error) {
      throw new Error(
        `SQLite could not enter ${readonly ? 'read-only' : 'read-write'} mode: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  release(connection: PooledConnection): Promise<void> {
    const releaseLock = connection.releaseWriteLock;
    connection.releaseWriteLock = null;
    const done = releaseLock
      ? releaseLock().catch(error => logWarn('Failed to release the SQLite write lock', error))
      : Promise.resolve();

    // The lock file is not reentrant, so it is given up before the in-process
    // handoff; otherwise the next waiter would block on this process's own lock.
    return done.then(() => {
      connection.lastUsed = Date.now();
      const queue = this.waiters.get(connection.filepath);
      if (queue && queue.length > 0) {
        const waiter = queue.shift()!;
        waiter(connection);
        return;
      }
      connection.inUse = false;
    });
  }

  async saveToFile(connection: PooledConnection): Promise<void> {
    if (connection.filepath === ':memory:' || connection.readonly || !connection.database) {
      return;
    }
    await writeDatabaseFile(
      connection.filepath,
      connection.database.export(),
      connection.identity?.mode ?? null
    );
    connection.identity = await readFileIdentity(connection.filepath);
  }

  private async createConnection(
    options: SqliteConnectionOptions
  ): Promise<{ database: SqliteDatabase; identity: FileIdentity | null }> {
    const SQL = await getSqlJs();
    let db: SqliteDatabase;
    let identity: FileIdentity | null = null;

    if (options.filepath === ':memory:') {
      db = new SQL.Database();
    } else {
      // Stat before reading: an identity captured after the read could match a
      // file this snapshot does not actually contain.
      identity = await readFileIdentity(options.filepath);
      if (identity !== null) {
        db = new SQL.Database(await readFile(options.filepath));
      } else {
        db = new SQL.Database();
        if (!(options.readonly ?? true)) {
          await writeDatabaseFile(options.filepath, db.export(), null);
          identity = await readFileIdentity(options.filepath);
        }
      }
    }

    try {
      if (options.foreignKeys !== false) {
        db.run('PRAGMA foreign_keys = ON');
      }
      db.run('PRAGMA busy_timeout = 5000');
    } catch (err) {
      logWarn('SQLite PRAGMA setup failed', err);
    }

    return { database: db, identity };
  }

  private closeConnection(connection: PooledConnection): void {
    if (connection.database && connection.isOpen) {
      try {
        connection.database.close();
      } catch (err) {
        logWarn('Failed to close SQLite connection', err);
      }
    }
    connection.database = null;
    connection.identity = null;
    connection.isOpen = false;
  }

  private cleanupIdleConnections(): void {
    const now = Date.now();
    for (const [key, connection] of this.connections.entries()) {
      if (connection.inUse || now - connection.lastUsed <= this.idleTimeoutMs) {
        continue;
      }
      this.closeConnection(connection);
      this.connections.delete(key);
    }
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    for (const connection of this.connections.values()) {
      this.closeConnection(connection);
    }
    this.connections.clear();
    this.waiters.clear();
  }
}

let poolInstance: SqliteConnectionPool | null = null;

/** Get the global SQLite connection pool (created on first use). */
export function getConnectionPool(): SqliteConnectionPool {
  if (!poolInstance) {
    poolInstance = new SqliteConnectionPool();
  }
  return poolInstance;
}

/** Shut down the global pool (test teardown / graceful shutdown). */
export function shutdownConnectionPool(): void {
  if (poolInstance) {
    poolInstance.shutdown();
    poolInstance = null;
  }
}

/**
 * Run a callback with the pooled SQLite connection for a file, held exclusively
 * for the duration of the call and written back afterwards for read-write use.
 * @param options - SQLite connection options
 * @param callback - receives the database instance
 */
export async function withConnection<T>(
  options: SqliteConnectionOptions,
  callback: (db: SqliteDatabase) => T | Promise<T>
): Promise<T> {
  const pool = getConnectionPool();
  const connection = await pool.acquire(options);

  try {
    const result = await callback(connection.database as SqliteDatabase);
    if (!(options.readonly ?? true)) {
      await pool.saveToFile(connection);
    }
    return result;
  } finally {
    await pool.release(connection);
  }
}
