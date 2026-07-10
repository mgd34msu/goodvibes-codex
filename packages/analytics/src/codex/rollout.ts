import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import type {
  RolloutSession,
  ScanIssue,
  SessionScan,
  TokenSnapshot,
  TokenUsage,
  ToolCallSnapshot,
} from './types.js';
import { ZERO_USAGE } from './types.js';

const KNOWN_TOP_LEVEL_RECORDS = new Set([
  'session_meta',
  'turn_context',
  'event_msg',
  'response_item',
  'compacted',
  'world_state',
  'inter_agent_communication_metadata',
]);

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DIRECTORY_VISITS = 10_000;

interface RolloutEnvelope {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

export interface ParseRolloutOptions {
  maxFileBytes?: number;
  fallbackStartedAt?: Date;
  fallbackUpdatedAt?: Date;
}

export class RolloutFileTooLargeError extends Error {
  constructor(
    readonly filePath: string,
    readonly size: number,
    readonly limit: number
  ) {
    super(`Rollout file is ${size} bytes; configured limit is ${limit} bytes.`);
    this.name = 'RolloutFileTooLargeError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max = 4096): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function usage(value: unknown): TokenUsage | null {
  const raw = record(value);
  if (!raw) {
    return null;
  }
  const normalized: TokenUsage = {
    input_tokens: count(raw.input_tokens),
    cached_input_tokens: count(raw.cached_input_tokens),
    output_tokens: count(raw.output_tokens),
    reasoning_output_tokens: count(raw.reasoning_output_tokens),
    total_tokens: count(raw.total_tokens),
  };
  if (normalized.total_tokens === 0) {
    // Codex includes cached input within input_tokens and reasoning output
    // within output_tokens. Do not add either subset twice.
    normalized.total_tokens = normalized.input_tokens + normalized.output_tokens;
  }
  return normalized;
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sourceName(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.slice(0, 200);
  }
  const source = record(value);
  const subagent = source?.subagent;
  if (typeof subagent === 'string') {
    return `subagent:${subagent.slice(0, 100)}`;
  }
  const subagentRecord = record(subagent);
  const kind = subagentRecord ? Object.keys(subagentRecord).sort()[0] : null;
  return kind ? `subagent:${kind.slice(0, 100)}` : null;
}

function sourceParentThreadId(value: unknown): string | null {
  const source = record(value);
  const subagent = record(source?.subagent);
  if (!subagent) {
    return null;
  }
  for (const candidate of Object.values(subagent)) {
    const details = record(candidate);
    const parent = text(details?.parent_thread_id, 200);
    if (parent) {
      return parent;
    }
  }
  return null;
}

function fallbackId(filePath: string): string {
  const match = basename(filePath).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
  return match?.[0] ?? basename(filePath, '.jsonl');
}

function projectName(cwd: string | null): string {
  if (!cwd) {
    return '(unknown project)';
  }
  return basename(cwd) || cwd;
}

/**
 * Parse a Codex rollout as a metadata stream. Message text, reasoning, tool
 * arguments, and tool outputs are deliberately ignored and never retained.
 *
 * `event_msg.token_count.info.total_token_usage` is cumulative. The parser
 * keeps the greatest cumulative observation rather than summing events, which
 * would double-count repeated snapshots.
 */
export async function parseRolloutFile(
  filePath: string,
  options: ParseRolloutOptions = {}
): Promise<RolloutSession> {
  const fileStat = await stat(filePath);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (fileStat.size > maxFileBytes) {
    throw new RolloutFileTooLargeError(filePath, fileStat.size, maxFileBytes);
  }

  const fallbackStarted = (options.fallbackStartedAt ?? fileStat.birthtime).toISOString();
  const fallbackUpdated = (options.fallbackUpdatedAt ?? fileStat.mtime).toISOString();
  let id = fallbackId(filePath);
  let rootSessionId = id;
  let observedStartedAt: string | null = null;
  let observedUpdatedAt: string | null = null;
  let cwd: string | null = null;
  let cliVersion: string | null = null;
  let originator: string | null = null;
  let source: string | null = null;
  let parentThreadId: string | null = null;
  let agentNickname: string | null = null;
  let agentPath: string | null = null;
  let currentUsage: TokenUsage = { ...ZERO_USAGE };
  let format: RolloutSession['format'] = 'codex-rollout-unknown';
  let records = 0;
  let malformedLines = 0;
  let unknownRecords = 0;
  let turnContextCount = 0;
  let hasSessionIdentity = false;
  let identityTimestamp: string | null = null;

  const models = new Set<string>();
  const turnIds = new Set<string>();
  const toolCalls: Record<string, number> = {};
  const tokenSnapshots: TokenSnapshot[] = [];
  const toolCallSnapshots: ToolCallSnapshot[] = [];

  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    let decoded: RolloutEnvelope;
    try {
      decoded = JSON.parse(line) as RolloutEnvelope;
    } catch {
      malformedLines++;
      continue;
    }

    records++;
    const topType = text(decoded.type, 100);
    const payload = record(decoded.payload);
    if (!topType || !payload) {
      unknownRecords++;
      continue;
    }
    if (KNOWN_TOP_LEVEL_RECORDS.has(topType)) {
      format = 'codex-rollout-v1';
    } else {
      unknownRecords++;
    }

    const timestamp = iso(decoded.timestamp) ?? iso(payload.timestamp);
    if (timestamp) {
      if (observedStartedAt === null || timestamp < observedStartedAt) {
        observedStartedAt = timestamp;
      }
      if (observedUpdatedAt === null || timestamp > observedUpdatedAt) {
        observedUpdatedAt = timestamp;
      }
    }

    if (topType === 'session_meta' && !hasSessionIdentity) {
      hasSessionIdentity = true;
      id = text(payload.id, 200) ?? text(payload.session_id, 200) ?? id;
      rootSessionId = text(payload.session_id, 200) ?? id;
      identityTimestamp = iso(payload.timestamp) ?? timestamp;
      cwd = text(payload.cwd) ?? cwd;
      cliVersion = text(payload.cli_version, 100) ?? cliVersion;
      originator = text(payload.originator, 200) ?? originator;
      source = sourceName(payload.source) ?? text(payload.thread_source, 200) ?? source;
      parentThreadId =
        text(payload.parent_thread_id, 200) ??
        text(payload.forked_from_id, 200) ??
        sourceParentThreadId(payload.source) ??
        parentThreadId;
      agentNickname = text(payload.agent_nickname, 200) ?? agentNickname;
      agentPath = text(payload.agent_path, 500) ?? agentPath;
      continue;
    }

    if (topType === 'turn_context') {
      turnContextCount++;
      cwd = text(payload.cwd) ?? cwd;
      const model = text(payload.model, 200);
      if (model) {
        models.add(model);
      }
      const turnId = text(payload.turn_id, 200);
      if (turnId) {
        turnIds.add(turnId);
      }
      continue;
    }

    if (topType === 'event_msg') {
      const eventType = text(payload.type, 100);
      const eventTurnId = text(payload.turn_id, 200);
      if (eventTurnId) {
        turnIds.add(eventTurnId);
      }
      if (eventType === 'token_count') {
        const info = record(payload.info);
        const total = usage(info?.total_token_usage);
        const last = usage(info?.last_token_usage);
        if (total) {
          tokenSnapshots.push({ timestamp, total, last });
          if (total.total_tokens >= currentUsage.total_tokens) {
            currentUsage = total;
          }
        }
      }
      continue;
    }

    if (topType === 'response_item') {
      const itemType = text(payload.type, 100);
      if (itemType === 'function_call' || itemType === 'custom_tool_call') {
        const name = text(payload.name, 200);
        if (name) {
          toolCalls[name] = (toolCalls[name] ?? 0) + 1;
          toolCallSnapshots.push({ id: text(payload.call_id, 300) ?? text(payload.id, 300), name });
        }
      }
    }
  }

  return {
    id,
    root_session_id: rootSessionId,
    file_path: filePath,
    format,
    started_at: identityTimestamp ?? observedStartedAt ?? fallbackStarted,
    updated_at: observedUpdatedAt ?? fallbackUpdated,
    cwd,
    project: projectName(cwd),
    cli_version: cliVersion,
    originator,
    source,
    parent_thread_id: parentThreadId,
    agent_nickname: agentNickname,
    agent_path: agentPath,
    models: [...models].sort(),
    turns: turnIds.size || turnContextCount,
    tool_calls: Object.fromEntries(
      Object.entries(toolCalls).sort(([a], [b]) => a.localeCompare(b))
    ),
    attributed_tool_calls: Object.fromEntries(
      Object.entries(toolCalls).sort(([a], [b]) => a.localeCompare(b))
    ),
    usage: currentUsage,
    attributed_usage: { ...currentUsage },
    attribution: 'full',
    attributed_turns: turnIds.size || turnContextCount,
    records,
    malformed_lines: malformedLines,
    unknown_records: unknownRecords,
    token_snapshots: tokenSnapshots,
    tool_call_snapshots: toolCallSnapshots,
    turn_ids: [...turnIds],
    identity_timestamp: identityTimestamp,
  };
}

function sameUsage(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.input_tokens === b.input_tokens &&
    a.cached_input_tokens === b.cached_input_tokens &&
    a.output_tokens === b.output_tokens &&
    a.reasoning_output_tokens === b.reasoning_output_tokens &&
    a.total_tokens === b.total_tokens
  );
}

function subtractUsage(total: TokenUsage, baseline: TokenUsage): TokenUsage {
  return {
    input_tokens: Math.max(0, total.input_tokens - baseline.input_tokens),
    cached_input_tokens: Math.max(0, total.cached_input_tokens - baseline.cached_input_tokens),
    output_tokens: Math.max(0, total.output_tokens - baseline.output_tokens),
    reasoning_output_tokens: Math.max(
      0,
      total.reasoning_output_tokens - baseline.reasoning_output_tokens
    ),
    total_tokens: Math.max(0, total.total_tokens - baseline.total_tokens),
  };
}

function inferredBaseline(snapshot: TokenSnapshot | undefined): TokenUsage | null {
  if (!snapshot) {
    return { ...ZERO_USAGE };
  }
  if (!snapshot.last) {
    return null;
  }
  const keys: Array<keyof TokenUsage> = [
    'input_tokens',
    'cached_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
    'total_tokens',
  ];
  if (keys.some(key => snapshot.total[key] < snapshot.last![key])) {
    return null;
  }
  return subtractUsage(snapshot.total, snapshot.last);
}

function zeroUsage(value: TokenUsage): boolean {
  return value.total_tokens === 0;
}

function ancestorSnapshots(
  session: RolloutSession,
  byId: Map<string, RolloutSession>
): TokenUsage[] {
  const snapshots: TokenUsage[] = [];
  const visited = new Set<string>();
  let parentId = session.parent_thread_id;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) {
      break;
    }
    snapshots.push(...parent.token_snapshots.map(snapshot => snapshot.total));
    parentId = parent.parent_thread_id;
  }
  return snapshots;
}

function longestParentPrefixBaseline(
  child: TokenSnapshot[],
  parent: TokenSnapshot[]
): TokenUsage | null {
  if (child.length === 0 || parent.length === 0) {
    return null;
  }
  let bestLength = 0;
  let bestBaseline: TokenUsage | null = null;
  for (let parentStart = 0; parentStart < parent.length; parentStart++) {
    let length = 0;
    while (
      length < child.length &&
      parentStart + length < parent.length &&
      sameUsage(child[length].total, parent[parentStart + length].total)
    ) {
      length++;
    }
    if (length > bestLength) {
      bestLength = length;
      bestBaseline = child[length - 1]?.total ?? null;
    }
  }
  return bestBaseline;
}

function countToolSnapshots(snapshots: ToolCallSnapshot[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const snapshot of snapshots) {
    counts[snapshot.name] = (counts[snapshot.name] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** Remove copied parent prefixes/baselines from child rollout metadata. */
function attributeForkedSessions(sessions: RolloutSession[]): void {
  const byId = new Map(sessions.map(session => [session.id, session]));
  for (const session of sessions) {
    if (!session.parent_thread_id) {
      continue;
    }
    const parent = byId.get(session.parent_thread_id);
    const matchedBaseline = parent
      ? longestParentPrefixBaseline(session.token_snapshots, parent.token_snapshots)
      : null;
    const candidate = inferredBaseline(session.token_snapshots[0]);
    const candidateTrusted =
      parent !== undefined &&
      candidate !== null &&
      (zeroUsage(candidate) ||
        ancestorSnapshots(session, byId).some(snapshot => sameUsage(snapshot, candidate)));
    const baseline = matchedBaseline ?? (candidateTrusted ? candidate : null);
    if (baseline) {
      session.attributed_usage = subtractUsage(session.usage, baseline);
      session.attribution = matchedBaseline ? 'parent-prefix-subtracted' : 'inferred-baseline';
    } else {
      // A nonzero inherited baseline with no scanned ancestor cannot be safely
      // separated from this branch. Exclude it from aggregate totals rather
      // than presenting a knowingly inflated number.
      session.attributed_usage = { ...ZERO_USAGE };
      session.attribution = 'unattributed';
    }

    if (parent) {
      const parentCallIds = new Set(
        parent.tool_call_snapshots.map(call => call.id).filter((id): id is string => id !== null)
      );
      session.attributed_tool_calls = countToolSnapshots(
        session.tool_call_snapshots.filter(call => call.id === null || !parentCallIds.has(call.id))
      );
      // A child performs its own work under the spawning parent turn id. Turn
      // identity is therefore `(thread_id, turn_id)`, and must not be globally
      // de-duplicated against the parent thread.
      session.attributed_turns = session.turns;
    } else if (session.attribution === 'unattributed') {
      session.attributed_tool_calls = {};
    }
  }
}

interface DiscoveredFile {
  path: string;
  size: number;
  mtime: Date;
  birthtime: Date;
}

async function discoverJsonlFiles(root: string): Promise<DiscoveredFile[]> {
  const files: DiscoveredFile[] = [];
  const pending = [root];
  let visits = 0;

  while (pending.length > 0 && visits < MAX_DIRECTORY_VISITS) {
    const dir = pending.pop()!;
    visits++;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const fileStat = await stat(child);
        files.push({
          path: child,
          size: fileStat.size,
          mtime: fileStat.mtime,
          birthtime: fileStat.birthtime,
        });
      }
    }
  }

  return files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export interface ScanSessionsOptions {
  maxSessions: number;
  maxFileBytes: number;
  now?: () => Date;
}

/** Discover and parse the newest bounded set of rollouts beneath CODEX_HOME/sessions. */
export async function scanSessions(
  sessionsDir: string,
  options: ScanSessionsOptions
): Promise<SessionScan> {
  const issues: ScanIssue[] = [];
  let discovered: DiscoveredFile[];
  try {
    discovered = await discoverJsonlFiles(sessionsDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      sessions_dir: sessionsDir,
      scanned_at: (options.now?.() ?? new Date()).toISOString(),
      discovered_files: 0,
      scanned_files: 0,
      truncated: false,
      sessions: [],
      issues: [
        {
          code: code === 'ENOENT' ? 'sessions_missing' : 'read_failed',
          message:
            code === 'ENOENT'
              ? `Codex sessions directory does not exist: ${sessionsDir}`
              : `Could not scan Codex sessions directory: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  const selected = discovered.slice(0, options.maxSessions);
  const truncated = selected.length < discovered.length;
  if (truncated) {
    issues.push({
      code: 'scan_limit',
      message: `Scanned the newest ${selected.length} of ${discovered.length} rollout files.`,
    });
  }

  const sessions: RolloutSession[] = [];
  for (const file of selected) {
    if (file.size > options.maxFileBytes) {
      issues.push({
        file: file.path,
        code: 'file_too_large',
        message: `Skipped ${file.size}-byte rollout; limit is ${options.maxFileBytes} bytes.`,
      });
      continue;
    }
    try {
      sessions.push(
        await parseRolloutFile(file.path, {
          maxFileBytes: options.maxFileBytes,
          fallbackStartedAt: file.birthtime,
          fallbackUpdatedAt: file.mtime,
        })
      );
    } catch (error) {
      issues.push({
        file: file.path,
        code: error instanceof RolloutFileTooLargeError ? 'file_too_large' : 'read_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  attributeForkedSessions(sessions);
  return {
    sessions_dir: sessionsDir,
    scanned_at: (options.now?.() ?? new Date()).toISOString(),
    discovered_files: discovered.length,
    scanned_files: selected.length,
    truncated,
    sessions,
    issues,
  };
}
