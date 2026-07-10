# Analytics operations

Codex normally exposes these as `mcp__goodvibes_analytics__<tool>`.

| Request                   | Tool and operation                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| Session summary           | `query` with current-session scope                                                        |
| Full session status       | `query` with `scope: all`                                                                 |
| HTML report               | `dashboard` with `action: report` and requested scope                                     |
| Host diagnostics          | `dashboard` with `action: doctor`                                                         |
| Inspect a budget          | `budget` with `action: check` and optional exact `session_id`                             |
| Set or clear a budget     | `budget` with `action: set` or `clear` and exact `session_id` when host context is absent |
| Export records            | `export` with `format`, `scope`, optional tags, and an optional relative output path      |
| Add or remove a tag       | `tag` with exact `session_id` when host context is absent                                 |
| List or suggest tags      | `tag` with the corresponding action and optional exact `session_id`                       |
| Import available sessions | `sync` with current or all scope                                                          |
| Read or change settings   | `config` with `get`, `set`, or `reload`                                                   |

## Scope and provenance

- `current_session` uses a host-provided session ID when available. Read-only
  operations may otherwise use the newest scanned main-thread rollout; mutating
  budget/tag operations never use that heuristic.
- Project scope must be keyed by a canonical authorized workspace root.
- Historical and cross-project output must come from successfully indexed records, not a scan reported as complete when files were unreadable.
- Token records should identify whether they came from stable host events, Codex rollout ingestion, or a GoodVibes MCP event.
- No operation calculates or verifies monetary cost. Legacy cost-shaped requests return token data with an explicit unavailable marker.

## Mutation rules

Setting budgets, tags, output files, or configuration changes state. Perform those operations only when requested. Budget/tag mutations require an exact session target unless the host supplied one. A report request authorizes writing the requested report artifact, not unrelated cleanup or configuration changes.

`query` does not advertise grouping, presentation-format, status-filter, or
agent-filter arguments because sanitized rollouts cannot implement them
truthfully. `export` has a fixed sanitized schema and does not accept sections.
