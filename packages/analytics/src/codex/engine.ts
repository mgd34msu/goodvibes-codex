import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveAnalyticsPaths, type AnalyticsPathOptions } from './paths.js';
import { scanSessions } from './rollout.js';
import {
  atomicWriteJson,
  atomicWriteText,
  configRange,
  readState,
  updateState,
  validateConfigKey,
  validateConfigValue,
} from './state.js';
import type {
  AnalyticsPaths,
  AnalyticsState,
  RolloutSession,
  SessionScan,
  SessionView,
  TokenUsage,
} from './types.js';
import { ZERO_USAGE } from './types.js';

const MAX_INLINE_SESSIONS = 100;
const DEFAULT_WARNING_THRESHOLDS = [0.5, 0.8, 1];

type ToolArguments = Record<string, unknown>;

export interface CodexAnalyticsEngineOptions extends AnalyticsPathOptions {
  now?: () => Date;
  /** Explicit active thread for hosts/tests that can provide it. */
  sessionId?: string;
}

function object(value: unknown): ToolArguments {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ToolArguments)
    : {};
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sessionIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const id = value.trim();
  return id.length > 0 && id.length <= 200 && !/[\r\n\0]/.test(id) ? id : null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
    : [];
}

function result(data: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

function error(message: string, details?: Record<string, unknown>): CallToolResult {
  return result({ success: false, error: message, ...details }, true);
}

function sumUsage(sessions: RolloutSession[]): TokenUsage {
  const total: TokenUsage = { ...ZERO_USAGE };
  for (const session of sessions) {
    total.input_tokens += session.attributed_usage.input_tokens;
    total.cached_input_tokens += session.attributed_usage.cached_input_tokens;
    total.output_tokens += session.attributed_usage.output_tokens;
    total.reasoning_output_tokens += session.attributed_usage.reasoning_output_tokens;
    total.total_tokens += session.attributed_usage.total_tokens;
  }
  return total;
}

function aggregateTools(sessions: RolloutSession[]): Record<string, number> {
  const tools: Record<string, number> = {};
  for (const session of sessions) {
    for (const [name, calls] of Object.entries(session.attributed_tool_calls)) {
      tools[name] = (tools[name] ?? 0) + calls;
    }
  }
  return Object.fromEntries(
    Object.entries(tools).sort(
      ([nameA, callsA], [nameB, callsB]) => callsB - callsA || nameA.localeCompare(nameB)
    )
  );
}

function sessionView(session: RolloutSession, state: AnalyticsState): SessionView {
  return {
    id: session.id,
    root_session_id: session.root_session_id,
    started_at: session.started_at,
    updated_at: session.updated_at,
    cwd: session.cwd,
    project: session.project,
    cli_version: session.cli_version,
    source: session.source,
    parent_thread_id: session.parent_thread_id,
    agent_nickname: session.agent_nickname,
    models: session.models,
    turns: session.attributed_turns,
    tool_calls: session.attributed_tool_calls,
    usage: session.attributed_usage,
    usage_attribution: session.attribution,
    tags: state.tags[session.id] ?? [],
    parser: {
      format: session.format,
      malformed_lines: session.malformed_lines,
      unknown_records: session.unknown_records,
    },
  };
}

function projectSummaries(sessions: RolloutSession[]): Array<Record<string, unknown>> {
  const projects = new Map<string, RolloutSession[]>();
  for (const session of sessions) {
    const key = session.cwd ?? '(unknown project)';
    const existing = projects.get(key) ?? [];
    existing.push(session);
    projects.set(key, existing);
  }
  return [...projects.entries()]
    .map(([cwd, projectSessions]) => ({
      cwd: cwd === '(unknown project)' ? null : cwd,
      project: projectSessions[0]?.project ?? '(unknown project)',
      sessions: projectSessions.length,
      latest_at:
        projectSessions
          .map(session => session.updated_at)
          .sort()
          .at(-1) ?? null,
      usage: sumUsage(projectSessions),
    }))
    .sort((a, b) => String(b.latest_at).localeCompare(String(a.latest_at)));
}

function agentSummary(sessions: RolloutSession[]): Record<string, unknown> {
  const children = sessions.filter(
    session => session.parent_thread_id !== null || session.source?.startsWith('subagent:') === true
  );
  return {
    sessions: children.length,
    usage: sumUsage(children),
    agents: children.slice(0, MAX_INLINE_SESSIONS).map(session => ({
      session_id: session.id,
      parent_thread_id: session.parent_thread_id,
      nickname: session.agent_nickname,
      agent_path: session.agent_path,
      source: session.source,
      updated_at: session.updated_at,
      usage: session.attributed_usage,
      usage_attribution: session.attribution,
      tool_calls: session.attributed_tool_calls,
    })),
    truncated: children.length > MAX_INLINE_SESSIONS,
  };
}

function csv(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  return `"${raw.replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
}

function html(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function safeExportPath(root: string, requested: string): Promise<string | null> {
  if (isAbsolute(requested)) {
    return null;
  }
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, requested);
  const prefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;
  if (!target.startsWith(prefix)) {
    return null;
  }

  try {
    await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(absoluteRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return null;
    }
    const canonicalRoot = await realpath(absoluteRoot);
    const parent = dirname(target);
    const relativeParent = relative(absoluteRoot, parent);
    if (
      relativeParent === '..' ||
      relativeParent.startsWith(`..${sep}`) ||
      isAbsolute(relativeParent)
    ) {
      return null;
    }

    let current = absoluteRoot;
    for (const component of relativeParent.split(sep).filter(Boolean)) {
      current = join(current, component);
      try {
        const currentStat = await lstat(current);
        if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
          return null;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return null;
        }
        await mkdir(current, { mode: 0o700 });
        const createdStat = await lstat(current);
        if (!createdStat.isDirectory() || createdStat.isSymbolicLink()) {
          return null;
        }
      }
    }

    const canonicalParent = await realpath(parent);
    const canonicalPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
    if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(canonicalPrefix)) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

function normalizeTag(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const tag = value.trim();
  if (tag.length === 0 || tag.length > 100 || /[\r\n\0]/.test(tag)) {
    return null;
  }
  return tag;
}

function warningThresholds(value: unknown): number[] | null {
  if (value === undefined) {
    return [...DEFAULT_WARNING_THRESHOLDS];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const thresholds = value.filter(
    (item): item is number =>
      typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1
  );
  if (thresholds.length !== value.length || thresholds.length > 10) {
    return null;
  }
  return [...new Set(thresholds)].sort((a, b) => a - b);
}

function renderExport(
  format: 'json' | 'csv' | 'markdown',
  sessions: SessionView[],
  generatedAt: string,
  truncated: boolean
): string {
  if (format === 'json') {
    return `${JSON.stringify(
      {
        schema_version: 1,
        source: 'codex-rollout-metadata',
        generated_at: generatedAt,
        monetary_costs_included: false,
        truncated,
        sessions,
      },
      null,
      2
    )}\n`;
  }

  if (format === 'csv') {
    const header = [
      'session_id',
      'project',
      'cwd',
      'started_at',
      'updated_at',
      'input_tokens',
      'cached_input_tokens',
      'output_tokens',
      'reasoning_output_tokens',
      'total_tokens',
      'turns',
      'tags',
    ];
    const rows = sessions.map(session =>
      [
        session.id,
        session.project,
        session.cwd,
        session.started_at,
        session.updated_at,
        session.usage.input_tokens,
        session.usage.cached_input_tokens,
        session.usage.output_tokens,
        session.usage.reasoning_output_tokens,
        session.usage.total_tokens,
        session.turns,
        session.tags.join(';'),
      ]
        .map(csv)
        .join(',')
    );
    return `${header.map(csv).join(',')}\n${rows.join('\n')}\n`;
  }

  const rows = sessions.map(
    session =>
      `| ${session.id.replace(/\|/g, '\\|')} | ${session.project.replace(/\|/g, '\\|')} | ` +
      `${session.usage.total_tokens} | ${session.turns} | ${session.tags.join(', ').replace(/\|/g, '\\|')} |`
  );
  return [
    '# GoodVibes Codex analytics export',
    '',
    `Generated: ${generatedAt}`,
    '',
    'Monetary costs are not included. Token counters come from local Codex rollout metadata.',
    '',
    '| Session | Project | Total tokens | Turns | Tags |',
    '|---|---|---:|---:|---|',
    ...rows,
    truncated ? '' : undefined,
    truncated ? '_Export truncated to the configured byte limit._' : undefined,
    '',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function renderReport(sessions: SessionView[], generatedAt: string, truncated: boolean): string {
  const usage = sessions.reduce<TokenUsage>(
    (total, session) => ({
      input_tokens: total.input_tokens + session.usage.input_tokens,
      cached_input_tokens: total.cached_input_tokens + session.usage.cached_input_tokens,
      output_tokens: total.output_tokens + session.usage.output_tokens,
      reasoning_output_tokens:
        total.reasoning_output_tokens + session.usage.reasoning_output_tokens,
      total_tokens: total.total_tokens + session.usage.total_tokens,
    }),
    { ...ZERO_USAGE }
  );
  const rows = sessions
    .map(
      session =>
        `<tr><td>${html(session.id)}</td><td>${html(session.project)}</td>` +
        `<td>${session.usage.total_tokens.toLocaleString('en-US')}</td><td>${session.turns}</td>` +
        `<td>${html(session.updated_at)}</td><td>${html(session.tags.join(', '))}</td></tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GoodVibes Codex analytics</title>
<style>body{font:15px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#202124}h1{margin-bottom:.2rem}.muted{color:#666}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1rem;margin:1.5rem 0}.card{border:1px solid #ddd;border-radius:10px;padding:1rem}.value{font-size:1.5rem;font-weight:700}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border-bottom:1px solid #ddd;padding:.55rem;text-align:left}th{position:sticky;top:0;background:#fff}</style>
</head><body><h1>GoodVibes Codex analytics</h1><p class="muted">Generated ${html(generatedAt)} from local Codex rollout metadata. Message and tool payloads are excluded. Monetary costs are not calculated.</p>
<div class="cards"><div class="card"><div class="muted">Sessions</div><div class="value">${sessions.length}</div></div><div class="card"><div class="muted">Total tokens</div><div class="value">${usage.total_tokens.toLocaleString('en-US')}</div></div><div class="card"><div class="muted">Cached input</div><div class="value">${usage.cached_input_tokens.toLocaleString('en-US')}</div></div><div class="card"><div class="muted">Output tokens</div><div class="value">${usage.output_tokens.toLocaleString('en-US')}</div></div></div>
${truncated ? '<p><strong>Report truncated to configured limits.</strong></p>' : ''}
<table><thead><tr><th>Session</th><th>Project</th><th>Total tokens</th><th>Turns</th><th>Updated</th><th>Tags</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
}

function scanDiagnostics(scan: SessionScan): {
  degraded: boolean;
  reasons: string[];
  malformedLines: number;
  unknownRecords: number;
  parsedRecords: number;
  unknownFormatSessions: number;
} {
  const malformedLines = scan.sessions.reduce((sum, session) => sum + session.malformed_lines, 0);
  const unknownRecords = scan.sessions.reduce((sum, session) => sum + session.unknown_records, 0);
  const parsedRecords = scan.sessions.reduce((sum, session) => sum + session.records, 0);
  const unknownFormatSessions = scan.sessions.filter(
    session => session.format === 'codex-rollout-unknown'
  ).length;
  const reasons = [
    ...new Set(scan.issues.map(issue => `scan:${issue.code}`)),
    ...(malformedLines > 0 ? ['parser:malformed_lines'] : []),
    ...(unknownRecords > 0 ? ['parser:unknown_records'] : []),
    ...(unknownFormatSessions > 0 ? ['parser:unknown_rollout_format'] : []),
  ];
  return {
    degraded: reasons.length > 0,
    reasons,
    malformedLines,
    unknownRecords,
    parsedRecords,
    unknownFormatSessions,
  };
}

export class CodexAnalyticsEngine {
  readonly paths: AnalyticsPaths;
  private readonly now: () => Date;
  private readonly requestedSessionId: string | null;

  constructor(options: CodexAnalyticsEngineOptions = {}) {
    this.paths = resolveAnalyticsPaths(options);
    this.now = options.now ?? (() => new Date());
    this.requestedSessionId = sessionIdentifier(
      options.sessionId ??
        process.env.GOODVIBES_SESSION_ID ??
        process.env.CODEX_THREAD_ID ??
        process.env.CODEX_SESSION_ID
    );
  }

  async initialize(): Promise<void> {
    // Deliberately lazy and read-only: initialize/list-tools never creates state.
  }

  async shutdown(): Promise<void> {
    // No watchers, timers, or database handles in the Codex adapter.
  }

  private async snapshot(): Promise<{ state: AnalyticsState; scan: SessionScan }> {
    const state = await readState(this.paths.state_file, this.now);
    const scan = await scanSessions(this.paths.sessions_dir, {
      maxSessions: state.config.max_sessions,
      maxFileBytes: state.config.max_file_bytes,
      now: this.now,
    });
    return { state, scan };
  }

  private currentSession(sessions: RolloutSession[]): RolloutSession | null {
    if (this.requestedSessionId) {
      return sessions.find(session => session.id === this.requestedSessionId) ?? null;
    }
    return sessions.find(session => session.parent_thread_id === null) ?? sessions[0] ?? null;
  }

  private sessionForAction(
    sessions: RolloutSession[],
    args: ToolArguments,
    requireBoundSession: boolean
  ): { session: RolloutSession | null; failure: CallToolResult | null } {
    const explicitId = sessionIdentifier(args.session_id);
    if (hasOwn(args, 'session_id') && !explicitId) {
      return {
        session: null,
        failure: error(
          'session_id must be a non-empty rollout session identifier of at most 200 characters.'
        ),
      };
    }

    const targetId = explicitId ?? this.requestedSessionId;
    if (requireBoundSession && !targetId) {
      return {
        session: null,
        failure: error(
          'This mutation requires an explicit session_id because the host did not provide an active Codex session identifier.'
        ),
      };
    }
    if (targetId) {
      const selected = sessions.find(session => session.id === targetId) ?? null;
      return {
        session: selected,
        failure: selected
          ? null
          : error(`No scanned Codex rollout session matches session_id ${targetId}.`),
      };
    }
    return { session: this.currentSession(sessions), failure: null };
  }

  private filterQuerySessions(
    sessions: RolloutSession[],
    state: AnalyticsState,
    args: ToolArguments
  ): RolloutSession[] {
    const current = this.currentSession(sessions);
    const dataScope = string(args.data_scope) ?? 'current_session';
    let selected: RolloutSession[];
    if (dataScope === 'all_projects') {
      selected = [...sessions];
    } else if (dataScope === 'current_project') {
      selected = current ? sessions.filter(session => session.cwd === current.cwd) : [];
    } else if (dataScope === 'tagged') {
      selected = sessions.filter(session => (state.tags[session.id] ?? []).length > 0);
    } else {
      selected = current ? [current] : [];
    }

    const filters = object(args.filters);
    const requiredTags = stringArray(filters.tags);
    if (requiredTags.length > 0) {
      selected = selected.filter(session => {
        const tags = state.tags[session.id] ?? [];
        return requiredTags.every(tag => tags.includes(tag));
      });
    }
    const toolFilter = string(filters.tool);
    if (toolFilter) {
      selected = selected.filter(session => (session.attributed_tool_calls[toolFilter] ?? 0) > 0);
    }

    const timeRange = string(args.time_range) ?? 'session';
    const windowMs =
      timeRange === 'last_5m'
        ? 5 * 60_000
        : timeRange === 'last_30m'
          ? 30 * 60_000
          : timeRange === 'last_1h'
            ? 60 * 60_000
            : null;
    if (windowMs !== null) {
      const threshold = this.now().getTime() - windowMs;
      selected = selected.filter(session => new Date(session.updated_at).getTime() >= threshold);
    }
    return selected;
  }

  async handleToolCall(name: string, rawArgs: unknown): Promise<CallToolResult> {
    const args = object(rawArgs);
    switch (name) {
      case 'analytics_query':
        return this.query(args);
      case 'analytics_dashboard':
        return this.dashboard(args);
      case 'analytics_budget':
        return this.budget(args);
      case 'analytics_export':
        return this.exportData(args);
      case 'analytics_tag':
        return this.tag(args);
      case 'analytics_sync':
        return this.sync(args);
      case 'analytics_config':
        return this.config(args);
      default:
        return error(`Unknown analytics tool: ${name}`);
    }
  }

  private async query(args: ToolArguments): Promise<CallToolResult> {
    const unsupportedArguments: string[] = [];
    if (hasOwn(args, 'group_by')) {
      unsupportedArguments.push('group_by');
    }
    if (hasOwn(args, 'format')) {
      unsupportedArguments.push('format');
    }
    const filters = object(args.filters);
    if (hasOwn(filters, 'status')) {
      unsupportedArguments.push('filters.status');
    }
    if (hasOwn(filters, 'agent')) {
      unsupportedArguments.push('filters.agent');
    }
    if (unsupportedArguments.length > 0) {
      return error(
        'Unsupported query arguments were supplied; this adapter cannot derive those fields from sanitized Codex rollout metadata.',
        { unsupported_arguments: unsupportedArguments }
      );
    }

    const { state, scan } = await this.snapshot();
    const mode = string(args.mode);
    if (mode === 'doctor') {
      return this.doctor(state, scan);
    }

    const selected = this.filterQuerySessions(scan.sessions, state, args);
    if (mode === 'agents') {
      return result({
        success: true,
        mode: 'agents',
        ...agentSummary(selected),
        scan: this.scanMeta(scan),
      });
    }
    if (mode === 'live_cost') {
      return result({
        success: true,
        mode: 'live_tokens',
        compatibility_alias: 'live_cost',
        usage: sumUsage(selected),
        sessions: selected.length,
        monetary_costs_available: false,
        note: 'GoodVibes does not infer API or subscription billing from local Codex rollouts.',
        scan: this.scanMeta(scan),
      });
    }

    const scope = string(args.scope) ?? 'all';
    if (scope === 'health') {
      return this.doctor(state, scan);
    }
    if (scope === 'agents') {
      return result({ success: true, scope, ...agentSummary(selected), scan: this.scanMeta(scan) });
    }
    if (scope === 'commands') {
      return result({
        success: true,
        scope,
        tool_calls: aggregateTools(selected),
        scan: this.scanMeta(scan),
      });
    }
    if (scope === 'project') {
      return result({
        success: true,
        scope,
        projects: projectSummaries(selected),
        scan: this.scanMeta(scan),
      });
    }
    if (scope === 'cache') {
      const tokenUsage = sumUsage(selected);
      return result({
        success: true,
        scope,
        cached_input_tokens: tokenUsage.cached_input_tokens,
        input_tokens: tokenUsage.input_tokens,
        scan: this.scanMeta(scan),
      });
    }
    if (scope === 'files') {
      return result({
        success: true,
        scope,
        available: false,
        reason:
          'File analytics are intentionally unavailable because the Codex adapter does not inspect tool arguments.',
        scan: this.scanMeta(scan),
      });
    }
    if (scope === 'cost') {
      return result({
        success: true,
        scope,
        available: false,
        usage: sumUsage(selected),
        reason:
          'Monetary costs are omitted; local rollout tokens are not authoritative billing data.',
        scan: this.scanMeta(scan),
      });
    }
    if (scope === 'tokens') {
      return result({ success: true, scope, usage: sumUsage(selected), scan: this.scanMeta(scan) });
    }

    return result({
      success: true,
      scope: 'all',
      usage: sumUsage(selected),
      sessions: selected.slice(0, MAX_INLINE_SESSIONS).map(session => sessionView(session, state)),
      sessions_truncated: selected.length > MAX_INLINE_SESSIONS,
      projects: projectSummaries(selected),
      tool_calls: aggregateTools(selected),
      agents: agentSummary(selected),
      monetary_costs_included: false,
      scan: this.scanMeta(scan),
    });
  }

  private scanMeta(scan: SessionScan): Record<string, unknown> {
    return {
      sessions_dir: scan.sessions_dir,
      scanned_at: scan.scanned_at,
      discovered_files: scan.discovered_files,
      scanned_files: scan.scanned_files,
      truncated: scan.truncated,
      issues: scan.issues,
    };
  }

  private doctor(state: AnalyticsState, scan: SessionScan): CallToolResult {
    const diagnostics = scanDiagnostics(scan);
    const cliVersions = [
      ...new Set(scan.sessions.map(session => session.cli_version).filter(Boolean)),
    ].sort();
    return result({
      success: true,
      status: diagnostics.degraded ? 'degraded' : 'ok',
      degradation_reasons: diagnostics.reasons,
      adapter: 'codex-rollout-v1',
      codex_home: this.paths.codex_home,
      sessions_dir: this.paths.sessions_dir,
      analytics_home: this.paths.analytics_home,
      sessions: scan.sessions.length,
      malformed_lines: diagnostics.malformedLines,
      unknown_records: diagnostics.unknownRecords,
      rollout_compatibility: {
        parsed_records: diagnostics.parsedRecords,
        unknown_records: diagnostics.unknownRecords,
        unknown_record_ratio:
          diagnostics.parsedRecords > 0
            ? diagnostics.unknownRecords / diagnostics.parsedRecords
            : 0,
        unknown_format_sessions: diagnostics.unknownFormatSessions,
      },
      cli_versions: cliVersions,
      scan: this.scanMeta(scan),
      local_config: state.config,
      local_config_authoritative_for_codex: false,
      privacy:
        'Only rollout metadata and token counters are retained; message text, reasoning, tool arguments, and outputs are ignored.',
    });
  }

  private async dashboard(args: ToolArguments): Promise<CallToolResult> {
    const action = string(args.action);
    if (!action || !['report', 'doctor', 'status'].includes(action)) {
      return error('dashboard.action must be report, doctor, or status.');
    }
    const { state, scan } = await this.snapshot();
    if (action === 'doctor') {
      return this.doctor(state, scan);
    }
    if (action === 'status') {
      const current = this.currentSession(scan.sessions);
      const diagnostics = scanDiagnostics(scan);
      return result({
        success: true,
        status: diagnostics.degraded ? 'degraded' : 'ready',
        degradation_reasons: diagnostics.reasons,
        source: 'CODEX_HOME/sessions',
        current_session: current ? sessionView(current, state) : null,
        sessions: scan.sessions.length,
        usage: sumUsage(scan.sessions),
        monetary_costs_included: false,
        scan: this.scanMeta(scan),
      });
    }

    const scope = string(args.scope) ?? 'all_projects';
    const current = this.currentSession(scan.sessions);
    let selected = scan.sessions;
    if (scope === 'session') {
      selected = current ? [current] : [];
    }
    if (scope === 'project') {
      selected = current ? scan.sessions.filter(session => session.cwd === current.cwd) : [];
    }
    selected = selected.slice(0, state.config.max_report_sessions);
    const generatedAt = this.now().toISOString();
    let views = selected.map(session => sessionView(session, state));
    let report = renderReport(views, generatedAt, selected.length < scan.sessions.length);
    let truncated = selected.length < scan.sessions.length;
    while (Buffer.byteLength(report, 'utf8') > state.config.max_export_bytes && views.length > 1) {
      views = views.slice(0, Math.max(1, Math.floor(views.length / 2)));
      truncated = true;
      report = renderReport(views, generatedAt, truncated);
    }
    if (Buffer.byteLength(report, 'utf8') > state.config.max_export_bytes) {
      return error(
        'The report header exceeds max_export_bytes; increase the local analytics limit.'
      );
    }

    await mkdir(this.paths.reports_dir, { recursive: true, mode: 0o700 });
    const reportPath = join(this.paths.reports_dir, 'analytics-report.html');
    await atomicWriteText(reportPath, report);
    return result({
      success: true,
      action: 'report',
      scope,
      path: reportPath,
      bytes: Buffer.byteLength(report, 'utf8'),
      sessions: views.length,
      truncated,
      monetary_costs_included: false,
    });
  }

  private async budget(args: ToolArguments): Promise<CallToolResult> {
    const action = string(args.action);
    if (!action || !['set', 'check', 'clear'].includes(action)) {
      return error('budget.action must be set, check, or clear.');
    }
    if (args.unit !== undefined && args.unit !== 'tokens') {
      return error(
        'Only token budgets are supported. GoodVibes does not treat local rollout data as authoritative monetary billing.'
      );
    }
    const { state, scan } = await this.snapshot();
    const selection = this.sessionForAction(
      scan.sessions,
      args,
      action === 'set' || action === 'clear'
    );
    if (selection.failure) {
      return selection.failure;
    }
    const current = selection.session;
    if (!current) {
      return error('No Codex rollout session is available for a budget.');
    }

    if (action === 'set') {
      const amount = args.amount;
      const thresholds = warningThresholds(args.warn_at);
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        return error('budget.amount must be a positive token count when action is set.');
      }
      if (!thresholds) {
        return error('budget.warn_at must contain at most ten fractions from 0 through 1.');
      }
      const next = await updateState(
        this.paths.state_file,
        draft => {
          draft.budgets[current.id] = {
            amount: Math.floor(amount),
            warn_at: thresholds,
            updated_at: this.now().toISOString(),
          };
        },
        this.now
      );
      return result({
        success: true,
        action,
        session_id: current.id,
        unit: 'tokens',
        budget: next.budgets[current.id],
      });
    }

    if (action === 'clear') {
      const existed = state.budgets[current.id] !== undefined;
      await updateState(this.paths.state_file, draft => delete draft.budgets[current.id], this.now);
      return result({ success: true, action, session_id: current.id, cleared: existed });
    }

    const configured = state.budgets[current.id];
    if (!configured) {
      return result({
        success: true,
        action,
        session_id: current.id,
        configured: false,
        unit: 'tokens',
      });
    }
    const used = current.attributed_usage.total_tokens;
    const percentage = configured.amount > 0 ? used / configured.amount : 0;
    const reached = configured.warn_at.filter(threshold => percentage >= threshold);
    return result({
      success: true,
      action,
      session_id: current.id,
      configured: true,
      unit: 'tokens',
      amount: configured.amount,
      used,
      remaining: Math.max(0, configured.amount - used),
      percentage,
      reached_thresholds: reached,
    });
  }

  private async tag(args: ToolArguments): Promise<CallToolResult> {
    const action = string(args.action);
    if (!action || !['add', 'remove', 'list', 'auto'].includes(action)) {
      return error('tag.action must be add, remove, list, or auto.');
    }
    const { state, scan } = await this.snapshot();
    if (action === 'list' && args.scope === 'all') {
      return result({ success: true, action, scope: 'all', tags: state.tags });
    }
    const selection = this.sessionForAction(
      scan.sessions,
      args,
      action === 'add' || action === 'remove'
    );
    if (selection.failure) {
      return selection.failure;
    }
    const current = selection.session;
    if (!current) {
      return error('No Codex rollout session is available to tag.');
    }

    if (action === 'auto') {
      const suggestions = [
        current.project !== '(unknown project)' ? `project:${current.project}` : null,
        ...current.models.slice(0, 3).map(model => `model:${model}`),
        current.parent_thread_id ? 'subagent' : 'main-thread',
      ].filter((item): item is string => item !== null);
      return result({
        success: true,
        action,
        session_id: current.id,
        suggestions: [...new Set(suggestions)],
      });
    }
    if (action === 'list') {
      return result({
        success: true,
        action,
        session_id: current.id,
        tags: state.tags[current.id] ?? [],
      });
    }

    const value = normalizeTag(args.value);
    if (!value) {
      return error('tag.value must be 1-100 characters without line breaks.');
    }
    const next = await updateState(
      this.paths.state_file,
      draft => {
        const tags = new Set(draft.tags[current.id] ?? []);
        if (action === 'add') {
          tags.add(value);
        } else {
          tags.delete(value);
        }
        if (tags.size > 0) {
          draft.tags[current.id] = [...tags].slice(0, 50);
        } else {
          delete draft.tags[current.id];
        }
      },
      this.now
    );
    return result({
      success: true,
      action,
      session_id: current.id,
      value,
      tags: next.tags[current.id] ?? [],
    });
  }

  private async sync(args: ToolArguments): Promise<CallToolResult> {
    const scope = string(args.scope) ?? 'current';
    if (!['current', 'all'].includes(scope)) {
      return error('sync.scope must be current or all.');
    }
    const { state, scan } = await this.snapshot();
    const current = this.currentSession(scan.sessions);
    const selected =
      scope === 'all'
        ? scan.sessions
        : current
          ? scan.sessions.filter(session => session.cwd === current.cwd)
          : [];
    const index = {
      schema_version: 1,
      source: 'codex-rollout-metadata',
      synced_at: this.now().toISOString(),
      scope,
      monetary_costs_included: false,
      sessions: selected.map(session => sessionView(session, state)),
      scan: this.scanMeta(scan),
    };
    if (Buffer.byteLength(JSON.stringify(index), 'utf8') > state.config.max_export_bytes) {
      return error(
        'The sanitized session index exceeds max_export_bytes; lower max_sessions or increase the local limit.'
      );
    }
    await atomicWriteJson(this.paths.index_file, index);
    return result({
      success: true,
      scope,
      indexed_sessions: selected.length,
      index_path: this.paths.index_file,
      scan: this.scanMeta(scan),
    });
  }

  private async config(args: ToolArguments): Promise<CallToolResult> {
    const action = string(args.action);
    if (!action || !['get', 'set', 'reload'].includes(action)) {
      return error('config.action must be get, set, or reload.');
    }
    if (action === 'get' || action === 'reload') {
      const state = await readState(this.paths.state_file, this.now);
      const key = string(args.key);
      let value: unknown = state.config;
      if (key) {
        if (!validateConfigKey(key)) {
          return error(`Unknown local config key: ${key}`, {
            supported_keys: Object.keys(state.config),
          });
        }
        value = state.config[key];
      }
      return result({
        success: true,
        action,
        key,
        value,
        source: this.paths.state_file,
        authoritative_for_codex: false,
        note: 'These settings only bound GoodVibes scanning and output; they do not configure Codex.',
      });
    }

    const key = string(args.key);
    if (!key || !validateConfigKey(key)) {
      return error('config.set requires a supported local key.', {
        supported_keys: [
          'max_sessions',
          'max_file_bytes',
          'max_export_bytes',
          'max_report_sessions',
        ],
      });
    }
    const value = validateConfigValue(key, args.value);
    if (value === null) {
      const [minimum, maximum] = configRange(key);
      return error(`${key} must be an integer from ${minimum} through ${maximum}.`);
    }
    const next = await updateState(
      this.paths.state_file,
      draft => {
        draft.config[key] = value;
      },
      this.now
    );
    return result({
      success: true,
      action,
      key,
      value: next.config[key],
      source: this.paths.state_file,
      authoritative_for_codex: false,
    });
  }

  private async exportData(args: ToolArguments): Promise<CallToolResult> {
    if (hasOwn(args, 'sections')) {
      return error(
        'export.sections is not supported. Exports use one fixed sanitized session schema; choose format, scope, tags, and output_path only.',
        { unsupported_arguments: ['sections'] }
      );
    }
    const format = string(args.format);
    if (format !== 'json' && format !== 'csv' && format !== 'markdown') {
      return error('export.format must be json, csv, or markdown.');
    }
    const { state, scan } = await this.snapshot();
    const scope = string(args.scope) ?? 'current';
    const current = this.currentSession(scan.sessions);
    let selected: RolloutSession[];
    if (scope === 'current') {
      selected = current ? [current] : [];
    } else if (scope === 'historical' || scope === 'all_projects') {
      selected = [...scan.sessions];
    } else if (scope.startsWith('session:')) {
      const sessionId = scope.slice('session:'.length);
      selected = scan.sessions.filter(session => session.id === sessionId);
      if (selected.length === 0) {
        return error(`No scanned session matches ${sessionId}.`);
      }
    } else {
      return error('export.scope must be current, historical, all_projects, or session:<id>.');
    }

    const requiredTags = stringArray(args.tags);
    if (requiredTags.length > 0) {
      selected = selected.filter(session => {
        const tags = state.tags[session.id] ?? [];
        return requiredTags.every(tag => tags.includes(tag));
      });
    }
    const generatedAt = this.now().toISOString();
    let views = selected.map(session => sessionView(session, state));
    let truncated = false;
    let content = renderExport(format, views, generatedAt, truncated);
    while (Buffer.byteLength(content, 'utf8') > state.config.max_export_bytes && views.length > 1) {
      views = views.slice(0, Math.max(1, Math.floor(views.length / 2)));
      truncated = true;
      content = renderExport(format, views, generatedAt, truncated);
    }
    if (Buffer.byteLength(content, 'utf8') > state.config.max_export_bytes) {
      return error(
        'A single sanitized session exceeds max_export_bytes; increase the local analytics limit.'
      );
    }

    const extension = format === 'markdown' ? 'md' : format;
    const requested =
      string(args.output_path) ?? `analytics-export-${safeTimestamp(this.now())}.${extension}`;
    const exportPath = await safeExportPath(this.paths.exports_dir, requested);
    if (!exportPath) {
      return error(
        'export.output_path must be a relative path beneath the GoodVibes analytics exports directory.'
      );
    }
    await atomicWriteText(exportPath, content);
    return result({
      success: true,
      format,
      scope,
      path: exportPath,
      bytes: Buffer.byteLength(content, 'utf8'),
      sessions: views.length,
      truncated,
      monetary_costs_included: false,
    });
  }
}
