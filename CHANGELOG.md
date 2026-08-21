# Changelog

## 0.1.1 - 2026-07-10

- Automatically install and self-heal exact Intel and Connect runtime dependencies from committed lockfiles at MCP startup and maintenance invocation, without a TTY or confirmation.
- Keep dependency repair beneath the durable GoodVibes data root with per-server locking, verified staging, atomic promotion, and degraded offline fallback; never mutate the installed plugin cache.
- Resolve Intel's ESM-only `web-tree-sitter` and `@ast-grep/napi` imports through the launcher's controlled durable dependency path.
- Make `goodvibes-maintenance` an implicit-capable repair workflow while preserving interactive authorization for roots, services, credentials, connections, write grants, hooks, and trust mode.
- Fail closed in the Connect query gate: SQL the tokenizer does not recognize is refused instead of allowed past a read-only connection, closing the writable common-table-expression bypass.
- Serialize SQLite access across concurrent Connect writers with a cross-process lock module, eliminating last-writer-wins data loss on shared database files.
- Remove the unwired telemetry subsystem (647 lines nothing on a live path imported) and its config plumbing; an existing config file carrying the old key still loads cleanly.
- Make the release hazard scan actually run on hosted CI (it invoked a tool absent from the runner image and the failure read as a pass) and widen it to the whole shipped tree; SHA-pin workflow actions; assert allowScripts pins against the lockfile.

## 0.1.0 - 2026-07-10

- Port GoodVibes to one Codex plugin with three stdio MCP servers and 25 domain tools.
- Add nine Codex skill packages and six supported lifecycle hooks.
- Add canonical trusted-workspace registration and an interactive control plane for roots, Connect authority, configuration, and runtime dependencies.
- Rebuild Analytics around bounded metadata-only Codex rollout parsing.
- Require exact Analytics session targets for budget/tag mutations, expose parser degradation, remove unsupported query/export arguments, and reject symlink-parent export escapes.
- Narrow Connect MCP administration to read-only inspection and harden HTTP/database operations around registered policy.
- Make scaffolding plan-only by default and bind structural-edit apply to single-use previews.
- Add repository marketplace packaging, validation, MCP smoke tests, CI/platform coverage, and Codex migration/security/privacy documentation.
