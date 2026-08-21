/**
 * SQLite pool ownership rules for connect `db_query`.
 *
 * sql.js keeps the whole database in memory, so a pooled connection is a *copy*
 * of the file, not a handle onto it. These tests pin the ownership model that
 * makes that safe: one exclusive connection per file, writers serialized across
 * processes through a lock file, the file replaced atomically, cached snapshots
 * refreshed when the file underneath them changes, and read-only handles that
 * genuinely refuse to write.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { shutdownConnectionPool, sqliteWriteLockPath, withConnection } from '../db/sqlite-pool.js';

let tmpDir: string | undefined;

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function makeDir(): Promise<string> {
  // realpath so the test's own paths match the canonical ones the pool keys on.
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-pool-test-')));
  return tmpDir;
}

/** Seed a database file with a `notes(body TEXT)` table. */
async function seed(filepath: string): Promise<void> {
  await withConnection({ filepath, readonly: false }, db => {
    db.run('CREATE TABLE notes (body TEXT)');
  });
}

async function insert(filepath: string, body: string): Promise<void> {
  await withConnection({ filepath, readonly: false }, async db => {
    // Yield inside the callback so two overlapping writers genuinely interleave.
    await Promise.resolve();
    db.run('INSERT INTO notes (body) VALUES (?)', [body]);
  });
}

/** Read the bodies straight off disk, bypassing every cached snapshot. */
async function bodiesOnDisk(filepath: string): Promise<string[]> {
  shutdownConnectionPool();
  return withConnection({ filepath, readonly: true }, db => {
    const result = db.exec('SELECT body FROM notes ORDER BY body');
    return result.length > 0 ? result[0].values.map(row => String(row[0])) : [];
  });
}

afterEach(async () => {
  shutdownConnectionPool();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('sqlite pool ownership', () => {
  it('keeps both rows when a second writer starts inside a slow write', async () => {
    const dir = await makeDir();
    const filepath = path.join(dir, 'concurrent.db');
    await seed(filepath);

    // The slow writer is still holding the database when the quick one arrives,
    // which is the window that used to hand out a second independent copy.
    const slow = withConnection({ filepath, readonly: false }, async db => {
      await delay(120);
      db.run("INSERT INTO notes (body) VALUES ('first')");
    });
    await delay(30);
    const quick = withConnection({ filepath, readonly: false }, db => {
      db.run("INSERT INTO notes (body) VALUES ('second')");
    });
    await Promise.all([slow, quick]);

    expect(await bodiesOnDisk(filepath)).toEqual(['first', 'second']);
  });

  it('keeps every row when many writers overlap on one file', async () => {
    const dir = await makeDir();
    const filepath = path.join(dir, 'many.db');
    await seed(filepath);

    const bodies = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    await Promise.all(bodies.map(body => insert(filepath, body)));

    expect(await bodiesOnDisk(filepath)).toEqual(bodies);
  });

  it('refuses a write issued on a read-only handle', async () => {
    const dir = await makeDir();
    const filepath = path.join(dir, 'readonly.db');
    await seed(filepath);

    await expect(
      withConnection({ filepath, readonly: true }, db => {
        db.run("INSERT INTO notes (body) VALUES ('sneaky')");
      })
    ).rejects.toThrow(/readonly|read.only/i);

    expect(await bodiesOnDisk(filepath)).toEqual([]);
  });

  it('sees a write from the same pool on the next read', async () => {
    const dir = await makeDir();
    const filepath = path.join(dir, 'freshness.db');
    await seed(filepath);

    const before = await withConnection({ filepath, readonly: true }, db =>
      db.exec('SELECT COUNT(*) FROM notes')
    );
    expect(Number(before[0].values[0][0])).toBe(0);

    await insert(filepath, 'added');

    const after = await withConnection({ filepath, readonly: true }, db =>
      db.exec('SELECT COUNT(*) FROM notes')
    );
    expect(Number(after[0].values[0][0])).toBe(1);
  });

  it('reloads after another process replaces the file', async () => {
    const dir = await makeDir();
    const filepath = path.join(dir, 'foreign.db');
    const donor = path.join(dir, 'donor.db');
    await seed(filepath);
    await seed(donor);
    await insert(donor, 'from-elsewhere');

    // Warm a cached snapshot of the original file.
    await withConnection({ filepath, readonly: true }, db => db.exec('SELECT COUNT(*) FROM notes'));

    // Another process replaces the file the same way this pool does.
    await fs.copyFile(donor, `${filepath}.foreign`);
    await fs.rename(`${filepath}.foreign`, filepath);

    const rows = await withConnection({ filepath, readonly: true }, db =>
      db.exec('SELECT body FROM notes')
    );
    expect(rows[0].values.map(row => String(row[0]))).toEqual(['from-elsewhere']);
  });

  it('leaves no temporary or lock files behind after a write', async () => {
    const dir = await makeDir();
    const filepath = path.join(dir, 'tidy.db');
    await seed(filepath);
    await insert(filepath, 'row');

    expect(await fs.readdir(dir)).toEqual(['tidy.db']);
  });

  it('writes through a symlinked database instead of replacing the link', async () => {
    const dir = await makeDir();
    const real = path.join(dir, 'real.db');
    const link = path.join(dir, 'link.db');
    await seed(real);
    await fs.symlink(real, link);

    await insert(link, 'through-the-link');

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await bodiesOnDisk(real)).toEqual(['through-the-link']);
  });

  it('treats two aliases of one file as one writer', async () => {
    const dir = await makeDir();
    const real = path.join(dir, 'aliased.db');
    const alias = path.join(dir, 'sub', '..', 'aliased.db');
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
    await seed(real);

    const slow = withConnection({ filepath: real, readonly: false }, async db => {
      await delay(120);
      db.run("INSERT INTO notes (body) VALUES ('direct')");
    });
    await delay(30);
    const quick = withConnection({ filepath: alias, readonly: false }, db => {
      db.run("INSERT INTO notes (body) VALUES ('aliased')");
    });
    await Promise.all([slow, quick]);

    expect(await bodiesOnDisk(real)).toEqual(['aliased', 'direct']);
  });

  it('reclaims a write lock left by a process that no longer exists', async () => {
    const dir = await makeDir();
    const filepath = path.join(dir, 'stale.db');
    await seed(filepath);

    const lockFile = sqliteWriteLockPath(filepath);
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        owner_id: randomBytes(8).toString('hex'),
        pid: 0x7fffffff,
        hostname: os.hostname(),
        created_at: Date.now(),
      }),
      'utf8'
    );

    await insert(filepath, 'after-takeover');

    expect(await bodiesOnDisk(filepath)).toEqual(['after-takeover']);
    await expect(fs.stat(lockFile)).rejects.toThrow();
  });

  it('waits for a live lock holder instead of stealing the lock', async () => {
    const dir = await makeDir();
    const filepath = path.join(dir, 'live.db');
    await seed(filepath);

    const lockFile = sqliteWriteLockPath(filepath);
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        owner_id: randomBytes(8).toString('hex'),
        pid: process.pid,
        hostname: os.hostname(),
        created_at: Date.now(),
      }),
      'utf8'
    );

    await expect(
      withConnection({ filepath, readonly: false, timeout: 250 }, db => {
        db.run("INSERT INTO notes (body) VALUES ('blocked')");
      })
    ).rejects.toThrow(/lock/i);

    await fs.rm(lockFile, { force: true });
    expect(await bodiesOnDisk(filepath)).toEqual([]);
  });
});
