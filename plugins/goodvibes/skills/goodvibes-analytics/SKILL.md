---
name: goodvibes-analytics
description: 'Query and present GoodVibes analytics for Codex sessions, including tokens, cache use, agent activity, reports, budgets, exports, tags, synchronization, and diagnostics. Use only when the user asks to inspect or manage usage data.'
---

# GoodVibes analytics

Use the `goodvibes_analytics` MCP server and label every metric by its source. This version reports local token/session metadata only and does not calculate money, pricing, subscription charges, or API-equivalent cost.

## Choose an operation

- Use `query` for current-session, project, or historical summaries.
- Use `dashboard` for an HTML report or host-health diagnostics.
- Use `budget` to inspect, set, or clear a supported threshold.
- Use `export` for JSON, CSV, or Markdown output.
- Use `tag` to classify sessions.
- Use `sync` to ingest available Codex session records.
- Use `config` to inspect or explicitly change analytics settings.

Budget `set`/`clear` and tag `add`/`remove` must target an exact scanned
`session_id` unless the host supplied an active Codex session identifier. Never
choose a mutation target from recency or project similarity. Exports use one
fixed sanitized session schema; select only their format, scope, tag filter, and
relative output path.

Read [references/operations.md](references/operations.md) for the corresponding MCP names and operation shapes.

## Present results

1. State the requested scope and the records actually available.
2. Separate token counts, cache counts, tool or agent activity, and health observations.
3. Label missing, partial, stale, or parser-unsupported data instead of treating it as zero.
   Treat a degraded doctor result as incomplete compatibility, especially when
   unknown or future rollout records are reported.
4. Do not infer or add monetary values. If asked for cost, explain that this version has no pricing provider and return token counts only when useful.
5. For a generated report or export, return its absolute path as a clickable file link when the host supports one.
6. For diagnostics, show cleanup commands but do not run them unless the user asks.
