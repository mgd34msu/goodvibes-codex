# Capability and deferral matrix

This file is the user-visible `0.1.x` parity record. "Available" means the capability is present in the Codex plugin surface; it does not mean every analyzer supports every framework or that an external registry or platform failure cannot temporarily degrade an individual call.

## MCP servers and tools

### Intel: 15 tools

| Tool                | Status              | Codex behavior                                                                         |
| ------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `code_read`         | Available           | Batched outline/range reads with output caps and registered-root enforcement           |
| `code_grep`         | Available           | Bounded regex/text search with count/file-only modes                                   |
| `code_glob`         | Available           | Ignore-aware discovery with optional file metadata                                     |
| `code_surface`      | Available           | Static exported-symbol and entry-point inspection                                      |
| `code_safe_delete`  | Available           | Static reference evidence before symbol removal                                        |
| `api_routes`        | Available           | Static route inventory for supported server frameworks                                 |
| `api_spec`          | Available           | OpenAPI-shaped response derived from detected routes                                   |
| `api_validate`      | Available           | Static comparison of detected routes and a supplied API spec                           |
| `db_schema`         | Available           | Prisma, Drizzle, and SQL schema extraction with optional usage analysis                |
| `component_tree`    | Available           | React composition map with bounded optional annotations                                |
| `hook_dependencies` | Available           | Static React hook dependency analysis                                                  |
| `client_boundary`   | Available           | Static server/client boundary analysis                                                 |
| `layout_analysis`   | Available           | Static hierarchy, sizing, overflow, and stacking analysis                              |
| `scaffold`          | Available, hardened | Plan-only by default; writing, dependency install, and Git initialization are explicit |
| `structural_edit`   | Available, hardened | Preview plus random single-use apply token, hash checks, and atomic file replacement   |

Every filesystem operation requires a path within a registered workspace. Static analysis findings remain heuristics unless a tool explicitly reports compiler-backed evidence.

### Analytics: 7 tools

| Tool        | Status              | Codex behavior                                                                                                                      |
| ----------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `query`     | Available, narrowed | Bounded token/cache/tool/agent/project/parser-health summaries; unsupported grouping/format/status/agent filters are not advertised |
| `dashboard` | Available, hardened | Metadata-only HTML report; doctor degrades on scan, malformed, unknown, or future-format evidence                                   |
| `budget`    | Available, hardened | Token budgets only; mutations require an exact session unless the host supplies one                                                 |
| `export`    | Available, hardened | Fixed-schema JSON/CSV/Markdown metadata beneath a symlink-checked analytics export root                                             |
| `tag`       | Available, hardened | Local tags; mutations require an exact session and Codex rollouts are not modified                                                  |
| `sync`      | Available, changed  | Builds a sanitized Codex rollout index rather than importing Claude transcripts                                                     |
| `config`    | Available, narrowed | Local scan/report bounds only; no Codex or authority configuration                                                                  |

Monetary cost, subscription billing, prompt text, reasoning, tool arguments, and tool output analytics are intentionally absent.
Export section selection and query grouping/presentation/status/agent filters are also absent rather than silently ignored.

### Connect: 3 tools

| Tool          | Status              | Codex behavior                                                                                                               |
| ------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `service`     | Available, narrowed | Credential-free `list`, `get`, and `status` only                                                                             |
| `api_request` | Available, hardened | Bounded policy-checked calls; credentials require HTTPS and remain origin/type-bound; metadata/link-local targets are denied |
| `db_query`    | Available, hardened | Registered connections, verified TLS for remote engines, bounded results/time, statement checks, and explicit write grant    |

All service/credential/destination/connection/write-grant mutations moved to the interactive control utility. This is an intentional compatibility break.

## Skills

| Skill                   | Status    | Replaces or adds                                             |
| ----------------------- | --------- | ------------------------------------------------------------ |
| `intel-mastery`         | Available | Intel tool selection and safe structured-edit workflow       |
| `project-onboarding`    | Available | Repository architecture mapping workflow                     |
| `goodvibes-memory`      | Available | Codex-namespaced curated project memory                      |
| `task-orchestration`    | Available | In-band subagent decomposition and four role references      |
| `review-scoring`        | Available | Refutation-based, severity-ranked review                     |
| `service-integration`   | Available | Connect data-plane workflow with control-plane boundary      |
| `goodvibes-analytics`   | Available | Codex metadata analytics workflow                            |
| `codebase-review`       | Available | Diff/check-driven review and optional WRFC cycle             |
| `goodvibes-maintenance` | Available | Plugin health, hook trust, automatic locked dependency repair, and verification |

Claude slash-command files are not installed. Codex invokes these skills from matching requests or explicit `$skill-name` references.

## Hooks

| Event                 | Status                | Behavior                                                                     |
| --------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `SessionStart`        | Available after trust | Dependency/trust-mode notice plus bounded lifecycle metadata                 |
| `PreToolUse` for Bash | Available after trust | Advisory deny for Git commands that include known GoodVibes credential files |
| `PreCompact`          | Available after trust | Metadata-only checkpoint; no transcript-tail parsing                         |
| `SubagentStart`       | Available after trust | Bounded metadata plus inherited-authority reminder                           |
| `SubagentStop`        | Available after trust | Duration and last-message length/hash metadata                               |
| `Stop`                | Available after trust | Bounded per-turn metadata; not a session-end signal                          |

`Setup`, `PostToolUseFailure`, and `SessionEnd` are not declared. Codex users must review/trust hooks separately from plugin installation.

## Templates and roles

The minimal Next.js, minimal Vite React, and full Next.js SaaS template trees are included for `scaffold`. Four orchestration role references, architect, engineer, tester, and refutation reviewer, are included inside `task-orchestration`.

The plugin does not install custom-agent TOML into `~/.codex` or `.codex/agents`. That remains an opt-in future possibility, not first-release behavior.

## Intentional deferrals

| Claude-era capability                   | `0.1.x` decision      | Rationale                                                                                                     |
| --------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------- |
| Claude transcript/history import        | Deferred              | Codex analytics needs a stable native baseline before one-way historical import                               |
| Anthropic model pricing and cost recap  | Retired for v1        | Local rollout token counters are not authoritative billing data                                               |
| Prompt/reasoning/tool-payload analytics | Not collected         | Privacy boundary and unstable transcript internals                                                            |
| Automatic dependency install/self-heal  | Available             | Every launcher and maintenance invocation verifies and repairs locked packages in the durable data root       |
| Claude command installer                | Retired               | Codex skills are the workflow surface                                                                         |
| Silent custom-agent install             | Deferred              | Role references work without mutating user/project configuration                                              |
| Post-tool failure automation            | Deferred              | Requires a stable Codex event/output contract and golden fixtures                                             |
| Session-end analytics                   | Retired               | Codex `Stop` is per turn, not session end                                                                     |
| MCP resources/prompts/completions       | Not applicable        | The source plugin exposes tools only                                                                          |
| Strong host-separated authority broker  | Deferred/host-limited | Current fallback is an interactive same-user CLI dependent on Codex sandbox and approvals                     |
| OAuth2/browser/session auth             | Deferred              | `0.1.x` supports stored bearer, Basic, and API-key auth only; hidden refresh/login network paths were removed |

Security-motivated narrowing is considered parity: preserving an unsafe model-facing authority mutation would be a regression, not a required feature.
