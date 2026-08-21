# State and privacy

## Storage roots

GoodVibes separates immutable plugin files, shared user data, hook-private data, project-local state, and Codex-owned source data.

| Class                 | Installed-plugin default       | Examples                                            |
| --------------------- | ------------------------------ | --------------------------------------------------- |
| Installed plugin      | Codex plugin cache             | bundles, skills, hooks, launchers, templates        |
| Shared GoodVibes data | `~/.codex/goodvibes`           | authority/config, dependencies, analytics, logs     |
| Hook-private data     | Codex-supplied `PLUGIN_DATA`   | hook events, checkpoints, agent tracking            |
| Hook fallback         | `~/.codex/goodvibes/hooks`     | same hook files when `PLUGIN_DATA` is absent        |
| Project-local state   | `<workspace>/.goodvibes/codex` | project config, curated memory, health/report state |
| Codex-owned input     | `~/.codex/sessions`            | rollout JSONL read by Analytics                     |

MCP server processes do not assume they receive hook-only `PLUGIN_DATA`. Their launchers resolve the shared data root independently.

### Environment-override limitation

The launchers and libraries understand `CODEX_HOME`, `GOODVIBES_DATA_ROOT`, and `GOODVIBES_ANALYTICS_HOME` when those variables are actually present. The installed-plugin probe on Codex CLI 0.144.1 found that bundled MCP children receive a minimal environment and do not inherit those parent variables. Only static values declared in `.mcp.json` are passed.

To keep installed copies coherent, each launcher infers `CODEX_HOME` from the standard `<codex-home>/plugins/cache/...` installed path, and the control utility performs the same inference when invoked from its saved `installedPath`. This supports a custom Codex home even though the variable is absent.

A checkout path cannot be inferred; direct development launches with a custom home must pass `CODEX_HOME` explicitly. Arbitrary GoodVibes-only path overrides are direct-launch/test features in `0.1.x` and are not automatically propagated by the host.

Re-test this contract when upgrading Codex.

## Shared GoodVibes data

The exact set grows as features are used. Important paths include:

```text
<data-root>/
  config.json                    trust mode and local bounds
  trusted-roots.json             registered workspace roots
  services.json                  service, connection, and allowlist policy
  goodvibes.secrets.json         stored credentials
  .control.lock                  serializes control-utility writes
  analytics/
    state.json
    session-index.json
    reports/
    exports/
  deps/
    intel/node_modules/
    analytics/node_modules/
    connect/node_modules/
  edit-tokens/                   structural_edit previews, expire after 10 minutes
  locks/
    structural-edit.lock         serializes applies across Codex threads
  hooks/                         fallback only
  logs/                          size-rotated activity and debug logs
```

`trusted-roots.json`, service/connection policy, and credential files are control state. They must not be copied into a workspace or edited by an MCP tool. On POSIX systems, private directories/files are created as `0700`/`0600` where supported. Important writes use same-directory temporary files and atomic rename.

The data directory is intentionally preserved across plugin reinstall and uninstall. A user must explicitly revoke authority or delete retained data.

## Analytics source and retained fields

Analytics scans a bounded set of rollout JSONL files under `~/.codex/sessions` in the supported installed-plugin layout. It extracts only what its summaries need:

| Extracted                       | Why it is kept                                                    |
| ------------------------------- | ------------------------------------------------------------------ |
| Session identity and timestamps | Identify and order sessions, and scope a query to a time range    |
| Project and cwd                 | Group sessions by repository                                      |
| Codex CLI and model identifiers | Attribute usage to a client and model version                     |
| Token counters                  | Report input, cached-input, output, reasoning, and totals present |
| Tool names and counts           | Report which tools ran and how often, never their arguments       |
| Parent and subagent links       | Reconstruct which session spawned which                           |
| Malformed record diagnostics    | Report unparsed input rather than counting it as zero             |

It ignores message text, reasoning content, tool arguments, and tool outputs. It does not rewrite or tag the rollout files. Tags, budgets, parser limits, and the sanitized index are written to `analytics/state.json` and `analytics/session-index.json`.

Reports and exports are confined beneath `analytics/reports` and `analytics/exports`. Export paths are relative, and existing parent components are rejected when they are symlinks or leave the canonical export root. Exports use one fixed sanitized session schema rather than silently ignoring requested sections. The metadata can still identify repositories and work patterns, so treat those files as private.

Budget and tag mutations use a host-provided active session identifier when one
is available. Without that context, callers must provide an exact scanned
`session_id`; recency and project heuristics are never used for those mutations.

GoodVibes does not infer actual subscription charges or API invoices from rollout counters. The first Codex release omits monetary cost calculations.

## Hook data

The hooks write one JSON object per line under `events/YYYY-MM.jsonl`, one file per calendar month in UTC. Three sibling directories hold short-lived records:

| Directory       | Contents                                                                    |
| --------------- | ---------------------------------------------------------------------------- |
| `events/`       | The append-only monthly event log                                           |
| `checkpoints/`  | One metadata-only compaction checkpoint per workspace                       |
| `agents/`       | One tracking record per running subagent, deleted when that subagent stops  |
| `commit-guard/` | Per-workspace state for the advisory Git credential guard                   |

Every event carries the common fields. The rest appear only on the events that produce them:

| Field                                       | Written by       | What it holds                                                    |
| ------------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| `schema_version`, `event`, `at`             | every event      | Record format number, lifecycle event name, and UTC timestamp    |
| `workspace_key`                             | every event      | Truncated SHA-256 of the canonical working directory, not a path |
| `session_id`, `turn_id`, `agent_id`         | every event      | Host-supplied identifiers, truncated to 256 characters           |
| `source`, `trigger`, `permission_mode`      | every event      | Short host-supplied labels, truncated to 32 characters           |
| `agent_type`                                | every event      | Subagent role name, truncated to 64 characters                   |
| `stop_hook_active`                          | every event      | Whether a stop hook was already running                          |
| `trust_mode`, `missing_dependency_servers`  | `session_start`  | Effective mode and the names of servers needing dependency repair |
| `decision`, `protected_files`               | `commit_guard`   | Allow or deny, and which known credential filenames matched      |
| `started_at`, `duration_ms`                 | `subagent_stop`  | Subagent lifetime, computed when its tracking record is consumed |
| `last_message_chars`, `last_message_sha256` | `stop`, `subagent_stop` | Length and digest of the last assistant message           |

Fields whose value is absent are dropped rather than written as null.

The last message itself is never written. Its digest is still a stable fingerprint of the exact text, so treat it as metadata rather than as an anonymized value. Agent tracking files are removed on the corresponding stop event when possible.

Hooks fail open, so records may be incomplete. They are local diagnostics, not an audit log.

## Project state

Codex-specific project files live under `.goodvibes/codex` to avoid silently interpreting state from another host. The directory should be ignored by version control unless a team has deliberately chosen to review and share a non-secret artifact such as curated memory.

Project state is non-authoritative. A project file cannot register its own workspace root, service destination, credential, connection, or write grant.

## Secrets

Connect credentials live in the shared data root, never in the repository. Secret files are checked for unsafe symlinks and overly broad POSIX permissions. Errors and registry summaries must not echo secret values or database URLs. Version `0.1.x` has no persistent cookie store or browser/session-auth path.

The control utility accepts/stores credentials for the selected registration. MCP processes deliberately do not inherit an arbitrary secret namespace and do not resolve legacy environment references. Re-enter a legacy secret through the interactive control plane instead of copying its file.

## Network behavior

Intel is local. Analytics is local and reads only Codex-owned files. Connect performs target network operations only when its MCP data tools are called. MCP startup and maintenance may contact the configured npm registry to automatically repair exact packages from committed lockfiles. Downloads, staging files, locks, and installed packages stay beneath the durable GoodVibes data root and are never copied or linked into the plugin cache.

The plugin does not send GoodVibes analytics to an external GoodVibes service.

## Retention and deletion

GoodVibes does not currently apply an automatic retention policy to durable analytics, reports, exports, or hook events. Review and remove them according to your own policy.

For a full cleanup:

1. Revoke roots, services, connections, credentials, and wider trust mode through the control utility.
2. Remove the plugin and marketplace.
3. Back up any wanted analytics or curated project memory.
4. Delete the GoodVibes data root.
5. Delete `.goodvibes/codex` in each workspace if no longer wanted.

Do not delete `~/.codex/sessions` as part of a GoodVibes cleanup unless you separately intend to remove Codex's own session history.
