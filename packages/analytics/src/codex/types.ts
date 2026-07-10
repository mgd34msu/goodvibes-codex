/** Sanitized token counters exposed by Codex rollout `token_count` events. */
export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

export interface TokenSnapshot {
  timestamp: string | null;
  total: TokenUsage;
  last: TokenUsage | null;
}

export interface ToolCallSnapshot {
  id: string | null;
  name: string;
}

/** Metadata-only summary of one Codex rollout file. Prompt and tool payloads are never retained. */
export interface RolloutSession {
  id: string;
  root_session_id: string;
  file_path: string;
  format: 'codex-rollout-v1' | 'codex-rollout-unknown';
  started_at: string;
  updated_at: string;
  cwd: string | null;
  project: string;
  cli_version: string | null;
  originator: string | null;
  source: string | null;
  parent_thread_id: string | null;
  agent_nickname: string | null;
  agent_path: string | null;
  models: string[];
  turns: number;
  tool_calls: Record<string, number>;
  attributed_tool_calls: Record<string, number>;
  usage: TokenUsage;
  attributed_usage: TokenUsage;
  attribution: 'full' | 'parent-prefix-subtracted' | 'inferred-baseline' | 'unattributed';
  attributed_turns: number;
  records: number;
  malformed_lines: number;
  unknown_records: number;
  /** Internal metadata-only samples used to de-duplicate forked rollout prefixes. */
  token_snapshots: TokenSnapshot[];
  /** Internal call identities used to de-duplicate forked rollout prefixes. */
  tool_call_snapshots: ToolCallSnapshot[];
  /** Internal turn identities used to de-duplicate forked rollout prefixes. */
  turn_ids: string[];
  /** Timestamp from the authoritative first session_meta record. */
  identity_timestamp: string | null;
}

export interface ScanIssue {
  file?: string;
  code: 'sessions_missing' | 'read_failed' | 'file_too_large' | 'scan_limit';
  message: string;
}

export interface SessionScan {
  sessions_dir: string;
  scanned_at: string;
  discovered_files: number;
  scanned_files: number;
  truncated: boolean;
  sessions: RolloutSession[];
  issues: ScanIssue[];
}

export interface TokenBudget {
  amount: number;
  warn_at: number[];
  updated_at: string;
}

/** Local plugin settings only. These never configure or override Codex itself. */
export interface AnalyticsLocalConfig {
  max_sessions: number;
  max_file_bytes: number;
  max_export_bytes: number;
  max_report_sessions: number;
}

export interface AnalyticsState {
  version: 1;
  config: AnalyticsLocalConfig;
  budgets: Record<string, TokenBudget>;
  tags: Record<string, string[]>;
  updated_at: string;
}

export interface SessionView {
  id: string;
  root_session_id: string;
  started_at: string;
  updated_at: string;
  cwd: string | null;
  project: string;
  cli_version: string | null;
  source: string | null;
  parent_thread_id: string | null;
  agent_nickname: string | null;
  models: string[];
  turns: number;
  tool_calls: Record<string, number>;
  usage: TokenUsage;
  usage_attribution: RolloutSession['attribution'];
  tags: string[];
  parser: {
    format: RolloutSession['format'];
    malformed_lines: number;
    unknown_records: number;
  };
}

export interface AnalyticsPaths {
  codex_home: string;
  sessions_dir: string;
  analytics_home: string;
  state_file: string;
  index_file: string;
  reports_dir: string;
  exports_dir: string;
}

export const ZERO_USAGE: Readonly<TokenUsage> = Object.freeze({
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
});
