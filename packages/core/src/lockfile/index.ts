/**
 * Exclusive lock files with abandoned-holder recovery.
 *
 * Several GoodVibes subsystems own one shared write target that genuinely
 * cannot be split per actor: the structural_edit apply path, a SQLite database
 * file the connect pool rewrites whole, and the connect service registry. Each
 * needs the same primitive, so it lives here once.
 *
 * A lock is a file created with `wx`, so exactly one caller can hold it. The
 * holder records its pid and hostname, which is what makes the lock recoverable:
 * a crash (SIGKILL, OOM, host restart) leaves the file behind with no in-process
 * `finally` to clean it up, and the next caller reclaims it after finding that
 * the recorded process is gone. A holder that is still running is never evicted,
 * whatever the lock's age. When the record cannot be checked against a live pid
 * (written on another host, or unparsable), age is the only signal left and the
 * lock is reclaimed once it exceeds `abandonedAfterMs`.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

/** Released by the holder; a no-op once the lock has been reclaimed by someone else. */
export type LockRelease = () => Promise<void>;

export interface LockFileOptions {
  /** How long to wait for a busy lock before throwing (ms, default 10s). */
  waitMs?: number;
  /** Reclaim a lock with no checkable pid once it is this old (ms, default 2min). */
  abandonedAfterMs?: number;
  /** Build the error thrown when the wait expires. */
  busyMessage?: (lockFile: string, waitMs: number) => string;
}

interface LockRecord {
  owner_id?: string;
  pid?: number;
  hostname?: string;
  created_at?: number;
}

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_ABANDONED_AFTER_MS = 120_000;
const POLL_MS = 25;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid is taken by a process this user cannot signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isAbandoned(record: LockRecord, abandonedAfterMs: number): boolean {
  if (record.hostname === hostname() && typeof record.pid === 'number' && record.pid > 0) {
    return !processExists(record.pid);
  }
  const age =
    typeof record.created_at === 'number'
      ? Date.now() - record.created_at
      : Number.POSITIVE_INFINITY;
  return age >= abandonedAfterMs;
}

/** Clear a lock whose holder is gone. Returns true when the lock is now free. */
async function clearAbandoned(lockFile: string, abandonedAfterMs: number): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockFile, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }

  let record: LockRecord = {};
  try {
    record = JSON.parse(raw) as LockRecord;
  } catch {
    record = {};
  }
  if (!isAbandoned(record, abandonedAfterMs)) {
    return false;
  }

  try {
    // Re-read first: a lock re-taken since the decision belongs to someone else.
    if ((await readFile(lockFile, 'utf8')) !== raw) {
      return false;
    }
    await unlink(lockFile);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function defaultBusyMessage(lockFile: string, waitMs: number): string {
  return (
    `Timed out after ${waitMs}ms waiting for the lock '${lockFile}'. Another holder is still ` +
    'running; locks left behind by processes that no longer exist are reclaimed automatically.'
  );
}

/**
 * Take an exclusive lock file, waiting for a live holder and reclaiming an
 * abandoned one.
 * @param lockFile - absolute path of the lock file (its directory is created)
 * @param options - wait/abandonment thresholds and the busy error message
 */
export async function acquireLockFile(
  lockFile: string,
  options: LockFileOptions = {}
): Promise<LockRelease> {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const abandonedAfterMs = options.abandonedAfterMs ?? DEFAULT_ABANDONED_AFTER_MS;
  const busyMessage = options.busyMessage ?? defaultBusyMessage;
  const ownerId = randomBytes(16).toString('hex');
  const deadline = Date.now() + Math.max(waitMs, 1);

  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });

  for (;;) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockFile, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (await clearAbandoned(lockFile, abandonedAfterMs)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(busyMessage(lockFile, waitMs));
      }
      await pause(POLL_MS);
      continue;
    }

    try {
      await handle.writeFile(
        JSON.stringify({
          owner_id: ownerId,
          pid: process.pid,
          hostname: hostname(),
          created_at: Date.now(),
        })
      );
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(lockFile).catch(() => {});
      throw error;
    }
    await handle.close().catch(() => {});

    return async () => {
      try {
        const current = JSON.parse(await readFile(lockFile, 'utf8')) as LockRecord;
        if (current.owner_id !== ownerId) {
          return;
        }
      } catch {
        // Missing or unreadable locks are not ours to remove.
        return;
      }
      await unlink(lockFile).catch(() => {});
    };
  }
}
