/**
 * Lock-file recovery rules.
 *
 * The point of recording a pid is that a lock left behind by a crashed process
 * heals itself instead of blocking every later caller forever. The rule that
 * makes that safe is the other half: a holder that is still running is never
 * evicted, no matter how old its lock is.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireLockFile } from '../lockfile/index.js';

let dir: string | undefined;

async function makeLockPath(): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), 'goodvibes-lockfile-'));
  return path.join(dir, 'nested', 'thing.lock');
}

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('acquireLockFile', () => {
  it('creates the lock and removes it on release', async () => {
    const lockFile = await makeLockPath();

    const release = await acquireLockFile(lockFile);
    const record = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
    expect(record.pid).toBe(process.pid);

    await release();
    await expect(stat(lockFile)).rejects.toThrow();
  });

  it('reclaims a lock whose recorded process no longer exists', async () => {
    const lockFile = await makeLockPath();
    await acquireLockFile(lockFile);
    await writeFile(
      lockFile,
      JSON.stringify({
        owner_id: 'ghost',
        pid: 0x7fffffff,
        hostname: hostname(),
        created_at: Date.now(),
      }),
      'utf8'
    );

    const release = await acquireLockFile(lockFile, { waitMs: 200 });
    const record = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
    expect(record.pid).toBe(process.pid);
    await release();
  });

  it('reclaims an unreadable lock once it exceeds the abandonment age', async () => {
    const lockFile = await makeLockPath();
    await acquireLockFile(lockFile);
    await writeFile(lockFile, 'not json', 'utf8');

    const release = await acquireLockFile(lockFile, { waitMs: 200, abandonedAfterMs: 1 });
    await release();
    await expect(stat(lockFile)).rejects.toThrow();
  });

  it('refuses to evict a holder that is still running', async () => {
    const lockFile = await makeLockPath();
    const held = JSON.stringify({
      owner_id: 'live',
      pid: process.pid,
      hostname: hostname(),
      created_at: 0,
    });
    await acquireLockFile(lockFile);
    await writeFile(lockFile, held, 'utf8');

    await expect(acquireLockFile(lockFile, { waitMs: 100, abandonedAfterMs: 1 })).rejects.toThrow(
      /lock/i
    );
    expect(await readFile(lockFile, 'utf8')).toBe(held);
  });

  it('reports the caller-supplied busy message', async () => {
    const lockFile = await makeLockPath();
    await acquireLockFile(lockFile);

    await expect(
      acquireLockFile(lockFile, { waitMs: 50, busyMessage: () => 'registry is busy' })
    ).rejects.toThrow('registry is busy');
  });

  it('does not remove a lock that was reclaimed by someone else', async () => {
    const lockFile = await makeLockPath();
    const release = await acquireLockFile(lockFile);

    const foreign = JSON.stringify({ owner_id: 'someone-else', pid: process.pid });
    await writeFile(lockFile, foreign, 'utf8');
    await release();

    expect(await readFile(lockFile, 'utf8')).toBe(foreign);
  });

  it('hands the lock to a waiter once the holder releases', async () => {
    const lockFile = await makeLockPath();
    const first = await acquireLockFile(lockFile);

    const pending = acquireLockFile(lockFile, { waitMs: 2_000 });
    setTimeout(() => void first(), 50);

    const second = await pending;
    const record = JSON.parse(await readFile(lockFile, 'utf8')) as { owner_id: string };
    expect(record.owner_id).toBeTruthy();
    await second();
    await expect(stat(lockFile)).rejects.toThrow();
  });
});
