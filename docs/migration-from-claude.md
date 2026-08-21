# Migration from the Claude plugin

The Codex plugin is a behavioral port, not an in-place upgrade. Install it alongside the Claude plugin, verify the Codex behavior, and retire the old installation separately.

## What changes

| Claude plugin concept               | Codex port                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| One plugin with three MCP servers   | Preserved as `goodvibes_intel`, `goodvibes_analytics`, and `goodvibes_connect`                                  |
| 25 domain tools                     | Preserved by domain, with Connect authority mutation removed from MCP and Analytics semantics rebuilt for Codex |
| Claude commands                     | Re-expressed as Codex skills and natural-language workflows; no command installer                               |
| Six knowledge skills                | Expanded to nine Codex skill packages                                                                           |
| Claude agents                       | Four role references consumed by `task-orchestration`; no silent `.codex/agents` installation                   |
| Claude setup hook                   | Replaced by automatic MCP-launcher repair plus `goodvibes-maintenance` verification                             |
| Claude lifecycle hooks              | Six Codex-supported events; unsupported setup/failure/session-end mappings retired or deferred                  |
| Claude transcript analytics         | Replaced by metadata-only Codex rollout parsing                                                                 |
| Claude global/project paths         | Replaced by `~/.codex/goodvibes` and `.goodvibes/codex` namespaces                                              |
| Model-facing service administration | Replaced by interactive `goodvibes-control.mjs` control plane                                                   |

## Do not copy state wholesale

GoodVibes deliberately performs no automatic Claude-state discovery or migration, and copying the old state by hand does not substitute for it. Each of these carries an assumption the Codex port does not share:

| Do not copy                                     | Why it does not transfer                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `~/.claude` and Claude plugin cache files       | Host layout and plugin identity differ                                      |
| Old runtime `node_modules`                      | Launchers install exact locked versions into the durable data root themselves |
| `.goodvibes/v2` project state                   | Codex state is namespaced under `.goodvibes/codex` with a different schema  |
| Service registries and cookie jars              | Authority boundaries changed; `0.1.x` has no cookie or session-auth path    |
| Secret files                                    | Credentials are re-entered through the interactive control plane            |
| Analytics databases and transcript-derived reports | Model identifiers and pricing semantics differ, so totals are not comparable |

## Recommended migration

1. Install GoodVibes for Codex; its MCP launchers automatically prepare pinned runtime dependencies.
2. Register each intended Codex workspace with `roots add`; do not register a parent directory merely to reproduce broad old access.
3. Recreate each service and database connection through the Codex control utility after reviewing its current destination and write policy.
4. Re-enter credentials. Rotate them first when the old store or repository history may have exposed them.
5. Keep Connect in restricted mode and grant write methods/connections only when required.
6. Review/trust the six Codex hooks independently; old hook trust does not transfer.
7. Run read-only Intel, Analytics status, and Connect status checks in a new Codex thread.
8. Remove the Claude plugin only after the Codex workflows you need have been verified.

Use `<plugin-root>/scripts/goodvibes-control.mjs --help` for the exact installed command summary. Group-level `--help` is not supported.

## Curated project memory

If the Claude project contains genuinely durable architectural decisions, migrate them manually rather than copying its memory directory:

1. Read and validate each candidate against the current repository.
2. Remove transcript fragments, secrets, stale tasks, and host-specific paths.
3. Rewrite the surviving fact into the Codex `.goodvibes/codex/memory` schema documented by the `goodvibes-memory` skill.
4. Let the skill perform an authorized atomic update.

This is editorial migration, not database import.

## Analytics history

The first Codex release does not import Claude transcripts, prices, token ledgers, SQLite databases, tags, or budgets. Analytics begins from Codex rollout metadata under `~/.codex/sessions` in the supported default layout and reports token counters rather than money.

Keep old reports as static records if needed. Do not combine their totals with Codex totals unless you separately define and disclose the different sources.

## Service and database policy

The Claude plugin allowed the model-facing `service` tool to mutate registrations, auth, allowlists, connection definitions, and write grants. That behavior is intentionally incompatible.

In Codex:

- MCP `service` only accepts `list`, `get`, and `status`;
- service and connection changes require the interactive control utility;
- credentials are not resolved from arbitrary inherited environment variables;
- unregistered workspace roots and registered-only targets are enforced server-side;
- open mode is an explicit control-plane setting, not an MCP action.

Update automation and skill examples that still call old `service` administration actions; they should instruct the user to perform the corresponding control operation.

## Hook mapping

| Claude behavior                  | Codex status                                        |
| -------------------------------- | --------------------------------------------------- |
| Session setup/install            | Replaced by automatic locked launcher repair        |
| Session start/open-mode notice   | Adapted to `SessionStart`                           |
| Bash credential commit guard     | Adapted to `PreToolUse` for Bash; advisory only     |
| Pre-compaction transcript backup | Metadata-only checkpoint at `PreCompact`            |
| Subagent start/stop              | Adapted to stable Codex fields                      |
| Turn stop                        | Lightweight `Stop` metadata only                    |
| Session end                      | Retired; `Stop` is not treated as session end       |
| Post-tool failure automation     | Deferred until a stable Codex contract justifies it |

## Coexistence and rollback

The two plugins can coexist because their plugin caches and active Codex state are separate. Avoid pointing both at one shared `GOODVIBES_DATA_ROOT`.

To roll back the Codex port, revoke its authority, remove `goodvibes@goodvibes`, and optionally delete the Codex GoodVibes data root. This does not reinstall, modify, or clean the Claude plugin.
