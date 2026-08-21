/**
 * structural_edit, intel tool 15, the ONE write surface on an otherwise
 * read-only server (plan §14.B; carve-out §8 addendum lane 10).
 *
 * Two-step, preview-gated contract:
 *   action "preview", run the match engine across the batch, return a per-entry
 *     unified diff, a single-use `preview_token`, and each file's content hash.
 *     Writes NOTHING.
 *   action "apply"  , take the token, re-hash every file, and write. Any file
 *     changed since preview is refused per-entry (`refused_stale`), never
 *     silently re-matched. Hashes are checked at preflight and immediately
 *     before replacement. Atomic mode (default) serializes applies, rejects the
 *     batch before writing when preflight fails, and restores completed writes
 *     after an ordinary mid-batch error. It reports any restoration failure.
 *
 * Only the three permitted modes ship: `exact`, `ast` (TypeScript-compiler node
 * matching), `ast_pattern` (ast-grep, degrades to an honest "unavailable"
 * error in this build; see engine). No fuzzy, no regex.
 *
 * Every filesystem interaction goes through `base_path` and echoes each entry's
 * absolute `resolved_path` (field issue 1); the handler runs under `withBudget`
 * (field issue 9); bytes outside an edit span are preserved exactly, including
 * CRLF (the v1 silent-conversion lesson).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { createTwoFilesPatch } from 'diff';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition } from './types.js';
import {
  successEnvelope,
  errorEnvelope,
  toCallToolResult,
  type Envelope,
} from '@goodvibes/core/envelope';
import { withBudget } from '@goodvibes/core/proc';
import { acquireLockFile, type LockRelease } from '@goodvibes/core/lockfile';
import { loadConfig } from '@goodvibes/core/config';
import { resolveInputPath } from '@goodvibes/core/fsx';
import { assertPathTrusted, goodvibesDataRoot } from '@goodvibes/core/workspace';
import { ensureArray, resolveStringOrBase64 } from '../lib/args.js';
import { resolveWorkDir } from '../lib/workdir.js';
import { computeEdit, type EditMatchMode, type Occurrence } from '../edit/engine.js';
import {
  saveToken,
  loadAndConsumeToken,
  sweepExpiredTokens,
  newTokenId,
  sha256,
  type PreviewToken,
  type PreviewEntryRecord,
  type PreviewFileRecord,
} from '../edit/tokens.js';

type Transaction = 'atomic' | 'partial';

const APPLY_LOCK_WAIT_MS = 10_000;

function editStateRoot(): string {
  return process.env.GOODVIBES_STATE_ROOT
    ? path.join(process.env.GOODVIBES_STATE_ROOT, '.goodvibes', 'codex')
    : goodvibesDataRoot();
}

/**
 * Serialize applies across Codex threads that share the same GoodVibes data
 * root. A lock left behind by a crashed apply is reclaimed automatically once
 * its recorded process is found to be gone.
 */
function acquireApplyLock(): Promise<LockRelease> {
  return acquireLockFile(path.join(editStateRoot(), 'locks', 'structural-edit.lock'), {
    waitMs: APPLY_LOCK_WAIT_MS,
    busyMessage: lockFile =>
      `Another structural_edit apply still owns '${lockFile}' and its process is still running. ` +
      'Locks left behind by processes that no longer exist are reclaimed automatically.',
  });
}

interface EditSpec {
  id?: string;
  path?: string;
  find?: string;
  find_base64?: string;
  replace?: string;
  replace_base64?: string;
  occurrence?: Occurrence;
  language?: string;
}

interface StructuralEditInput {
  action?: 'preview' | 'apply';
  edits?: EditSpec[];
  base_path?: string;
  transaction?: Transaction;
  match?: { mode?: EditMatchMode; case_sensitive?: boolean };
  output?: { context?: number; max_tokens?: number };
  preview_token?: string;
}

const VALID_MODES: EditMatchMode[] = ['exact', 'ast', 'ast_pattern'];

/** A per-diff character cap so a huge node replacement cannot blow the response
 *  budget. Derived from `output.max_tokens` (≈3.5 chars/token) split across the
 *  batch, floored so a diff is always at least glanceable. */
function diffCharCap(maxTokens: number, entryCount: number): number {
  return Math.max(1200, Math.floor((maxTokens * 3.5) / Math.max(1, entryCount)));
}

function truncateDiff(diff: string, cap: number): { diff: string; truncated: boolean } {
  if (diff.length <= cap) {
    return { diff, truncated: false };
  }
  const head = Math.floor(cap * 0.6);
  const tail = Math.floor(cap * 0.25);
  return {
    diff: `${diff.slice(0, head)}\n... [diff truncated: full content via code_read] ...\n${diff.slice(-tail)}`,
    truncated: true,
  };
}

// ── preview ────────────────────────────────────────────────────────────────

interface PreviewEntryOut {
  id?: string;
  status: 'ready' | 'no_match' | 'error';
  resolved_path: string;
  match_count: number;
  diff?: string;
  diff_truncated?: boolean;
  error: string | null;
}

async function runPreview(input: StructuralEditInput, startedAt: number): Promise<CallToolResult> {
  const { workDir, warning: baseWarning } = await resolveWorkDir(input.base_path);

  const edits = ensureArray<EditSpec>(input.edits) ?? [];
  if (edits.length === 0) {
    return toCallToolResult(
      errorEnvelope(
        "Missing required parameter 'edits'. Expected: array of { path, find, replace }.",
        {
          execution_ms: Math.round(performance.now() - startedAt),
        }
      )
    );
  }

  const mode = (input.match?.mode ?? 'exact') as EditMatchMode;
  if (!VALID_MODES.includes(mode)) {
    return toCallToolResult(
      errorEnvelope(
        `Invalid match.mode '${mode}'. structural_edit supports only: ${VALID_MODES.join(', ')} (no fuzzy, no regex).`,
        { execution_ms: Math.round(performance.now() - startedAt) }
      )
    );
  }
  const caseSensitive = input.match?.case_sensitive ?? true;
  const transaction: Transaction = input.transaction === 'partial' ? 'partial' : 'atomic';
  const cfg = loadConfig();
  const maxTokens = input.output?.max_tokens ?? cfg.max_tokens_default;
  const context = input.output?.context ?? 3;
  const cap = diffCharCap(maxTokens, edits.length);

  // Read each unique file once; keep a working content map so multiple entries
  // on the same file are computed sequentially (entry N sees entry N-1's edit).
  const originalContent = new Map<string, string | null>();
  const workingContent = new Map<string, string>();

  const entriesOut: Record<string, PreviewEntryOut> = {};
  const entryRecords: PreviewEntryRecord[] = [];
  const touchedFiles = new Map<string, PreviewFileRecord>();
  const seenKeys = new Set<string>();

  let readyCount = 0;
  let noMatchCount = 0;
  let errorCount = 0;
  let anyTruncated = false;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const key = edit.id != null && edit.id !== '' ? String(edit.id) : String(i);

    if (seenKeys.has(key)) {
      return toCallToolResult(
        errorEnvelope(`Duplicate structural_edit entry id '${key}'. Entry ids must be unique.`, {
          execution_ms: Math.round(performance.now() - startedAt),
        })
      );
    }
    seenKeys.add(key);

    let entryOut: PreviewEntryOut;
    let record: PreviewEntryRecord;

    try {
      if (!edit.path || typeof edit.path !== 'string') {
        throw new Error(`edits[${i}].path is required and must be a string.`);
      }
      const find = resolveStringOrBase64(edit as unknown as Record<string, unknown>, 'find');
      const replace = resolveStringOrBase64(edit as unknown as Record<string, unknown>, 'replace');
      if (find == null) {
        throw new Error(`edits[${i}].find is required (provide find or find_base64).`);
      }
      if (replace == null) {
        throw new Error(`edits[${i}].replace is required (provide replace or replace_base64).`);
      }

      const resolved = resolveInputPath(edit.path, workDir).resolved_path;

      // Read + hash the file the first time we touch it.
      if (!originalContent.has(resolved)) {
        let content: string | null;
        try {
          content = await fs.readFile(resolved, 'utf-8');
        } catch {
          content = null;
        }
        originalContent.set(resolved, content);
        if (content !== null) {
          workingContent.set(resolved, content);
        }
        touchedFiles.set(resolved, {
          resolved_path: resolved,
          hash: content !== null ? sha256(content) : '',
          existed: content !== null,
        });
      }

      if (originalContent.get(resolved) === null) {
        throw new Error(`file not found or unreadable: '${resolved}'.`);
      }

      const before = workingContent.get(resolved)!;
      const computed = await computeEdit(before, {
        filePath: resolved,
        find,
        replace,
        mode,
        occurrence: edit.occurrence ?? 'first',
        caseSensitive,
        language: edit.language,
      });

      if (computed.status === 'error') {
        entryOut = {
          id: edit.id,
          status: 'error',
          resolved_path: resolved,
          match_count: 0,
          error: computed.error ?? 'edit failed',
        };
        record = {
          key,
          id: edit.id,
          path: edit.path,
          resolved_path: resolved,
          status: 'error',
          match_count: 0,
          error: computed.error,
        };
        errorCount++;
      } else if (computed.status === 'no_match') {
        entryOut = {
          id: edit.id,
          status: 'no_match',
          resolved_path: resolved,
          match_count: 0,
          error: null,
        };
        record = {
          key,
          id: edit.id,
          path: edit.path,
          resolved_path: resolved,
          status: 'no_match',
          match_count: 0,
        };
        noMatchCount++;
      } else {
        const after = computed.newContent!;
        workingContent.set(resolved, after); // sequential edits on the same file
        const relName = path.relative(workDir, resolved) || path.basename(resolved);
        const rawDiff = createTwoFilesPatch(relName, relName, before, after, '', '', { context });
        const { diff, truncated } = truncateDiff(rawDiff, cap);
        if (truncated) {
          anyTruncated = true;
        }
        entryOut = {
          id: edit.id,
          status: 'ready',
          resolved_path: resolved,
          match_count: computed.matchCount,
          diff,
          ...(truncated ? { diff_truncated: true } : {}),
          error: null,
        };
        record = {
          key,
          id: edit.id,
          path: edit.path,
          resolved_path: resolved,
          status: 'ready',
          match_count: computed.matchCount,
        };
        readyCount++;
      }
    } catch (err) {
      const resolvedGuess = edit.path ? resolveInputPath(edit.path, workDir).resolved_path : '';
      entryOut = {
        id: edit.id,
        status: 'error',
        resolved_path: resolvedGuess,
        match_count: 0,
        error: (err as Error).message,
      };
      record = {
        key,
        id: edit.id,
        path: edit.path ?? '',
        resolved_path: resolvedGuess,
        status: 'error',
        match_count: 0,
        error: (err as Error).message,
      };
      errorCount++;
    }

    entriesOut[key] = entryOut;
    entryRecords.push(record);
  }

  // Final post-edit content per file with at least one ready edit. Preserve
  // unchanged/cancelled results too; apply must never treat a missing value as
  // an empty file.
  const computedContent: Record<string, string> = {};
  const readyPaths = new Set(
    entryRecords.filter(entry => entry.status === 'ready').map(entry => entry.resolved_path)
  );
  for (const resolved of readyPaths) {
    const content = workingContent.get(resolved);
    if (content === undefined) {
      throw new Error(`Preview did not retain computed content for '${resolved}'.`);
    }
    computedContent[resolved] = content;
  }

  const now = Date.now();
  const token: PreviewToken = {
    token: newTokenId(),
    created_at: now,
    expires_at: now + 10 * 60 * 1000,
    transaction,
    mode,
    base_path: input.base_path,
    files: Array.from(touchedFiles.values()),
    entries: entryRecords,
    computed: computedContent,
  };
  await saveToken(token);
  void sweepExpiredTokens(now); // opportunistic cleanup, never blocks

  const data = {
    action: 'preview' as const,
    preview_token: token.token,
    expires_at: token.expires_at,
    expires_in_seconds: Math.round((token.expires_at - now) / 1000),
    transaction,
    mode,
    entries: entriesOut,
    files: token.files.map(f => ({
      resolved_path: f.resolved_path,
      hash: f.hash,
      existed: f.existed,
    })),
    summary: {
      entries: edits.length,
      ready: readyCount,
      no_match: noMatchCount,
      error: errorCount,
      files: token.files.length,
    },
    next:
      readyCount > 0
        ? `Call structural_edit action:"apply" with preview_token:"${token.token}" within 10 minutes to write ${readyCount} ready edit(s).`
        : 'No ready edits: nothing to apply.',
  };

  const env: Envelope<typeof data> = successEnvelope(data, {
    execution_ms: Math.round(performance.now() - startedAt),
    ...(anyTruncated ? { truncated: true, effective_caps: { max_tokens: maxTokens } } : {}),
  });
  if (baseWarning) {
    env.warning = baseWarning;
  }
  return toCallToolResult(env);
}

// ── apply ──────────────────────────────────────────────────────────────────

type ApplyStatus = 'applied' | 'refused_stale' | 'rolled_back' | 'failed';

class StaleDuringApplyError extends Error {
  constructor(readonly resolvedPath: string) {
    super(`File '${resolvedPath}' changed during apply; refused before replacement.`);
    this.name = 'StaleDuringApplyError';
  }
}

let beforeReplaceHookForTests: ((resolvedPath: string) => void | Promise<void>) | undefined;

/** Inject a final-check race in tests; unavailable in production processes. */
export function setBeforeReplaceHookForTests(
  hook?: (resolvedPath: string) => void | Promise<void>
): void {
  if (!process.env.VITEST) {
    throw new Error('structural_edit test hooks are unavailable outside Vitest.');
  }
  beforeReplaceHookForTests = hook;
}

interface ApplyEntryOut {
  id?: string;
  status: ApplyStatus;
  resolved_path: string;
  bytes_written?: number;
  error: string | null;
}

async function runApplyUnlocked(
  input: StructuralEditInput,
  startedAt: number
): Promise<CallToolResult> {
  const token = input.preview_token;
  if (!token || typeof token !== 'string') {
    return toCallToolResult(
      errorEnvelope(
        'Missing required parameter \'preview_token\'. Run action:"preview" first to obtain one.',
        {
          execution_ms: Math.round(performance.now() - startedAt),
        }
      )
    );
  }

  // Single-use: this both reads and deletes the token.
  const record = await loadAndConsumeToken(token);
  if (!record) {
    return toCallToolResult(
      errorEnvelope(
        'Invalid or already-used preview token. Preview tokens are single-use; run action:"preview" again for a fresh one.',
        { execution_ms: Math.round(performance.now() - startedAt) }
      )
    );
  }

  const now = Date.now();
  if (now > record.expires_at) {
    return toCallToolResult(
      errorEnvelope(
        'Preview token expired (tokens are valid for 10 minutes). Run action:"preview" again.',
        {
          execution_ms: Math.round(performance.now() - startedAt),
        }
      )
    );
  }

  // Re-read + re-hash every touched file; a changed hash means the file moved
  // under us since preview → its entries are refused, never re-matched.
  const currentSnapshot = new Map<string, string | null>();
  const expectedHashes = new Map(record.files.map(file => [file.resolved_path, file.hash]));
  const staleFiles = new Set<string>();
  for (const f of record.files) {
    let current: string | null;
    try {
      assertPathTrusted(f.resolved_path);
      current = await fs.readFile(f.resolved_path, 'utf-8');
    } catch {
      current = null;
    }
    currentSnapshot.set(f.resolved_path, current);
    const currentHash = current !== null ? sha256(current) : '';
    if (currentHash !== f.hash) {
      staleFiles.add(f.resolved_path);
    }
  }

  const transaction = record.transaction;

  // Classify each entry. `pending` entries (ready + fresh file) are the ones we
  // would write; anything else is decided up front.
  interface Classified {
    key: string;
    id?: string;
    resolved_path: string;
    outcome: 'pending' | 'refused_stale' | 'failed';
    error?: string;
  }
  const classified: Classified[] = record.entries.map(e => {
    if (e.status !== 'ready') {
      return {
        key: e.key,
        id: e.id,
        resolved_path: e.resolved_path,
        outcome: 'failed',
        error: e.error ?? `entry was '${e.status}' at preview and cannot be applied`,
      };
    }
    if (staleFiles.has(e.resolved_path)) {
      return {
        key: e.key,
        id: e.id,
        resolved_path: e.resolved_path,
        outcome: 'refused_stale',
        error: 'file changed since preview; refused (never silently re-matched)',
      };
    }
    return { key: e.key, id: e.id, resolved_path: e.resolved_path, outcome: 'pending' };
  });

  const anyBlocked = classified.some(c => c.outcome !== 'pending');
  const computedFor = (resolved: string): string => {
    if (!Object.prototype.hasOwnProperty.call(record.computed, resolved)) {
      throw new Error(`Preview token is missing computed content for '${resolved}'.`);
    }
    return record.computed[resolved];
  };
  const freshFilesToWrite = new Set<string>();
  for (const c of classified) {
    if (
      c.outcome === 'pending' &&
      computedFor(c.resolved_path) !== currentSnapshot.get(c.resolved_path)
    ) {
      freshFilesToWrite.add(c.resolved_path);
    }
  }

  const entriesOut: Record<string, ApplyEntryOut> = {};
  const filesWritten: string[] = [];

  const finalize = (success: boolean, errorMsg?: string): CallToolResult => {
    const summary = { applied: 0, refused_stale: 0, rolled_back: 0, failed: 0 };
    for (const out of Object.values(entriesOut)) {
      summary[out.status]++;
    }
    const data = {
      action: 'apply' as const,
      transaction,
      entries: entriesOut,
      files_written: filesWritten,
      summary,
    };
    const env: Envelope<typeof data> = {
      success,
      data,
      ...(errorMsg ? { error: errorMsg } : {}),
      meta: { token_estimate: 0, execution_ms: Math.round(performance.now() - startedAt) },
    };
    return toCallToolResult(env);
  };

  const bytesOf = (resolved: string): number => Buffer.byteLength(computedFor(resolved), 'utf-8');

  // ── ATOMIC ──────────────────────────────────────────────────────────────
  if (transaction === 'atomic') {
    if (anyBlocked) {
      const staleCount = classified.filter(c => c.outcome === 'refused_stale').length;
      for (const c of classified) {
        if (c.outcome === 'refused_stale') {
          entriesOut[c.key] = {
            id: c.id,
            status: 'refused_stale',
            resolved_path: c.resolved_path,
            error: c.error ?? null,
          };
        } else {
          entriesOut[c.key] = {
            id: c.id,
            status: 'failed',
            resolved_path: c.resolved_path,
            error:
              c.outcome === 'failed'
                ? (c.error ?? 'entry failed')
                : 'atomic batch was rejected during preflight; no file was written',
          };
        }
      }
      const reason =
        staleCount > 0
          ? `Atomic batch rejected before writing: ${staleCount} file(s) changed since preview.`
          : 'Atomic batch rejected before writing because one or more entries could not apply.';
      return finalize(false, reason);
    }

    let failedPath: string | undefined;
    try {
      for (const resolved of freshFilesToWrite) {
        failedPath = resolved;
        await atomicWriteFile(resolved, computedFor(resolved), expectedHashes.get(resolved));
        filesWritten.push(resolved);
      }
    } catch (error) {
      const rollback = await restoreSnapshots(filesWritten, currentSnapshot);
      const writtenBeforeFailure = new Set(filesWritten);
      const lateStale = error instanceof StaleDuringApplyError;
      filesWritten.splice(0, filesWritten.length, ...rollback.failed);
      for (const c of classified) {
        const wasWritten = writtenBeforeFailure.has(c.resolved_path);
        const restoreFailed = rollback.failed.includes(c.resolved_path);
        const isLateStale = lateStale && c.resolved_path === failedPath;
        entriesOut[c.key] = {
          id: c.id,
          status: isLateStale
            ? 'refused_stale'
            : wasWritten && !restoreFailed
              ? 'rolled_back'
              : 'failed',
          resolved_path: c.resolved_path,
          error: restoreFailed
            ? 'write failed and the pre-apply snapshot could not be restored'
            : wasWritten
              ? 'write failed later in the batch; this file was restored'
              : isLateStale
                ? (error as Error).message
                : c.resolved_path === failedPath
                  ? `write failed: ${(error as Error).message}`
                  : 'atomic batch stopped before this file was written',
        };
      }
      const rollbackNote = rollback.failed.length
        ? ` Rollback also failed for ${rollback.failed.length} path(s); inspect files_written immediately.`
        : '';
      return finalize(
        false,
        `Atomic batch failed during a write and rolled back completed writes.${rollbackNote}`
      );
    }

    for (const c of classified) {
      entriesOut[c.key] = {
        id: c.id,
        status: 'applied',
        resolved_path: c.resolved_path,
        bytes_written: bytesOf(c.resolved_path),
        error: null,
      };
    }
    return finalize(true);
  }

  // ── PARTIAL ──────────────────────────────────────────────────────────────
  // Independent entries: apply what we can, report the rest per-entry, no rollback.
  for (const resolved of freshFilesToWrite) {
    let ok = true;
    let writeError = '';
    let writeWasStale = false;
    try {
      await atomicWriteFile(resolved, computedFor(resolved), expectedHashes.get(resolved));
      filesWritten.push(resolved);
    } catch (err) {
      ok = false;
      writeError = (err as Error).message;
      writeWasStale = err instanceof StaleDuringApplyError;
    }
    for (const c of classified) {
      if (c.outcome === 'pending' && c.resolved_path === resolved) {
        entriesOut[c.key] = ok
          ? {
              id: c.id,
              status: 'applied',
              resolved_path: resolved,
              bytes_written: bytesOf(resolved),
              error: null,
            }
          : {
              id: c.id,
              status: writeWasStale ? 'refused_stale' : 'failed',
              resolved_path: resolved,
              error: writeWasStale ? writeError : `write failed: ${writeError}`,
            };
      }
    }
  }
  for (const c of classified) {
    if (c.outcome === 'refused_stale') {
      entriesOut[c.key] = {
        id: c.id,
        status: 'refused_stale',
        resolved_path: c.resolved_path,
        error: c.error ?? null,
      };
    } else if (c.outcome === 'failed') {
      entriesOut[c.key] = {
        id: c.id,
        status: 'failed',
        resolved_path: c.resolved_path,
        error: c.error ?? 'entry failed',
      };
    } else if (!entriesOut[c.key]) {
      entriesOut[c.key] = {
        id: c.id,
        status: 'applied',
        resolved_path: c.resolved_path,
        bytes_written: bytesOf(c.resolved_path),
        error: null,
      };
    }
  }
  const applied = Object.values(entriesOut).some(e => e.status === 'applied');
  const anyFailed = Object.values(entriesOut).some(e => e.status === 'failed');
  const success = applied && !anyFailed;
  const errMsg = success
    ? undefined
    : anyFailed
      ? 'One or more entries failed in partial mode.'
      : 'No entries applied (all refused_stale or failed).';
  return finalize(success, errMsg);
}

async function runApply(input: StructuralEditInput, startedAt: number): Promise<CallToolResult> {
  const release = await acquireApplyLock();
  try {
    return await runApplyUnlocked(input, startedAt);
  } finally {
    await release();
  }
}

/** Restore written paths in reverse order and report any path that could not be restored. */
async function restoreSnapshots(
  written: string[],
  snapshots: Map<string, string | null>
): Promise<{ restored: string[]; failed: string[] }> {
  const restored: string[] = [];
  const failed: string[] = [];
  for (const resolved of [...written].reverse()) {
    const snap = snapshots.get(resolved);
    try {
      if (snap === null || snap === undefined) {
        await fs.unlink(resolved);
      } else {
        await atomicWriteFile(resolved, snap);
      }
      restored.push(resolved);
    } catch (error) {
      if (snap === null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        restored.push(resolved);
      } else {
        failed.push(resolved);
      }
    }
  }
  return { restored, failed };
}

/** Write a file through a same-directory temporary and atomic rename. */
async function atomicWriteFile(
  resolved: string,
  content: string,
  expectedHash?: string
): Promise<void> {
  assertPathTrusted(resolved);
  const dir = path.dirname(resolved);
  const temporary = path.join(
    dir,
    `.${path.basename(resolved)}.goodvibes-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let mode = 0o600;
  try {
    mode = (await fs.stat(resolved)).mode;
  } catch {
    // New files use a restrictive default.
  }
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    try {
      await handle.writeFile(content, { encoding: 'utf-8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (expectedHash !== undefined) {
      await beforeReplaceHookForTests?.(resolved);
      let current: string | null = null;
      try {
        current = await fs.readFile(resolved, 'utf8');
      } catch {
        // A removed or inaccessible target is stale too.
      }
      if (current === null || sha256(current) !== expectedHash) {
        throw new StaleDuringApplyError(resolved);
      }
    }
    await fs.rename(temporary, resolved);
    try {
      const directory = await fs.open(dir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Some platforms do not support opening or syncing directories.
    }
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

// ── dispatch ────────────────────────────────────────────────────────────────

async function run(args: unknown): Promise<CallToolResult> {
  const start = performance.now();
  const input = (args ?? {}) as StructuralEditInput;
  const action = input.action;
  try {
    if (action === 'preview') {
      return await runPreview(input, start);
    }
    if (action === 'apply') {
      return await runApply(input, start);
    }
    return toCallToolResult(
      errorEnvelope(
        `Missing or invalid 'action'. Expected "preview" or "apply" (got ${JSON.stringify(action)}). ` +
          'structural_edit is preview-gated: preview first, then apply the returned token.',
        { execution_ms: Math.round(performance.now() - start) }
      )
    );
  } catch (err) {
    return toCallToolResult(
      errorEnvelope((err as Error).message, { execution_ms: Math.round(performance.now() - start) })
    );
  }
}

const definition: Tool = {
  name: 'structural_edit',
  description:
    'Use for multi-site or AST-anchored edits where a plain string replace is risky (rename all call sites, change every matching pattern). The ONE write tool on this read-only server: a preview-gated, AST-aware editor. Two steps: action:"preview" ' +
    "returns a per-entry unified diff, a single-use preview_token, and each file's content hash WITHOUT writing; " +
    'action:"apply" takes that token, checks every hash at preflight and immediately before replacement, and writes. A file changed since preview is refused ' +
    '(refused_stale), never silently re-matched. Atomic mode (default) serializes applies across processes, rejects ' +
    'a failed preflight before writing, and rolls completed writes back after an ordinary write error. It is not a ' +
    'filesystem-wide crash transaction or a CAS against unrelated writers, and reports any failed restoration. Modes: exact (byte-exact string), ast ' +
    '(TypeScript-compiler node matching), ast_pattern (ast-grep: unavailable unless @ast-grep/napi is installed). ' +
    'No fuzzy, no regex. Newlines/CRLF outside edit spans are preserved byte-for-byte.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['preview', 'apply'],
        description:
          'preview (compute diffs + token, no write) or apply (write using a preview_token).',
      },
      edits: {
        type: 'array',
        description:
          'preview only: the batch of edits. Results are keyed by id (or array index), never collapsed.',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Optional stable key for this entry (defaults to its array index).',
            },
            path: { type: 'string', description: 'File to edit, relative to base_path.' },
            find: {
              type: 'string',
              description: 'Pattern to match (exact string, or an ast/ast_pattern selector).',
            },
            find_base64: {
              type: 'string',
              description: 'Base64 alternate to find (mutually exclusive).',
            },
            replace: { type: 'string', description: 'Replacement text.' },
            replace_base64: {
              type: 'string',
              description: 'Base64 alternate to replace (mutually exclusive).',
            },
            occurrence: {
              description:
                'Which matches to replace: "first" (default), "last", "all", or a 1-based number.',
            },
            language: {
              type: 'string',
              description: 'ast_pattern only: override the language auto-detection.',
            },
          },
          required: ['path'],
        },
      },
      base_path: {
        type: 'string',
        description:
          'A user-registered GoodVibes workspace root. Required when more than one trusted root exists.',
      },
      transaction: {
        type: 'string',
        enum: ['atomic', 'partial'],
        default: 'atomic',
        description:
          'atomic: serialized preflight plus rollback on ordinary write failure (default; not crash-atomic). partial: apply what can apply and report the rest.',
      },
      match: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['exact', 'ast', 'ast_pattern'], default: 'exact' },
          case_sensitive: { type: 'boolean', default: true, description: 'exact mode only.' },
        },
      },
      output: {
        type: 'object',
        properties: {
          context: {
            type: 'number',
            default: 3,
            description: 'Unified-diff context lines (preview).',
          },
          max_tokens: {
            type: 'number',
            description: 'Caps preview diff size; large diffs truncate with a note.',
          },
        },
      },
      preview_token: {
        type: 'string',
        description: 'apply only: the single-use token returned by a prior preview call.',
      },
    },
    required: ['action'],
  },
};

/** Preview parsing is budgeted. Apply returns its mutation result directly so
 *  a completed write can never be hidden behind a later budget error. */
export async function handler(args: unknown): Promise<CallToolResult> {
  const start = performance.now();
  if ((args as StructuralEditInput | null)?.action === 'apply') {
    return run(args);
  }
  const cfg = loadConfig();
  const outcome = await withBudget(cfg.budgets.analyzer_ms, async () => run(args));
  if (outcome.budget_exceeded) {
    return toCallToolResult(
      errorEnvelope('structural_edit exceeded its time budget before completing.', {
        execution_ms: Math.round(performance.now() - start),
        budget_exceeded: true,
      })
    );
  }
  return outcome.value;
}

/** Registration entry consumed by `src/index.ts`. */
export const structuralEditTool: ToolDefinition = { definition, handler };
