# GoodVibes for Codex: architecture and implementation plan

**Status:** implemented as `0.1.0`; retained as the audited design and decision record

**Prepared:** 2026-07-09

**Audited upstream:** `../goodvibes-plugin` at tag `v2.3.3`, commit `e49770e5f37ec9a02f5dc35ed03c2b35bf48929f`

**Proposed first Codex release:** `0.1.0`

## 1. Executive recommendation

Build GoodVibes as **one Codex plugin containing three independent stdio MCP servers**:

- `goodvibes_intel`: structure-aware repository inspection and editing;
- `goodvibes_analytics`: Codex-native token, session, health, and report analytics;
- `goodvibes_connect`: explicitly authorized HTTP and database access.

Keep the existing TypeScript workspace and most of the server-independent domain code, but introduce a host boundary so Claude-specific behavior is not scattered through the port. The intended package split is `core`, `host-codex`, `intel`, `analytics`, and `connect`.

The port should preserve the existing 25 domain capabilities, six knowledge skills, command workflows, useful hooks, templates, and four orchestration roles. It should **not** attempt a byte-for-byte transplant. In particular:

1. The Intel algorithms and most schemas are reusable.
2. Analytics needs a Codex-native ingestion layer and revised product claims.
3. Connect needs a stricter authority boundary before release.
4. Claude commands become Codex skills.
5. Claude agents become role references used by an orchestration skill; plugin-bundled custom-agent TOML is not currently a first-class plugin component.
6. Hooks must be mapped to the Codex hook event and output contracts.
7. Dependency installation, state paths, and workspace-root handling need to be redesigned rather than copied.

The most important release gate is **trusted workspace-root propagation**. The current source audit indicates that the practical bundled-server launch shape uses the installed plugin as `cwd`, but this must be confirmed against the supported Codex build with an installed-plugin probe. In every launch shape, an arbitrary model-provided `base_path` is not proof of an approved workspace. No filesystem, edit, export, local-driver, or project-config capability should be considered production-ready until that boundary is solved and tested.

## 2. Source audit baseline

The Claude source is a substantial, working product rather than a thin prompt bundle:

| Surface                | Audited result                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository             | 473 tracked files; approximately 48 MiB checkout                                                                                              |
| Implementation         | npm workspaces, TypeScript, esbuild, CommonJS server bundles                                                                                  |
| Packages               | `core`, `intel`, `analytics`, `connect`                                                                                                       |
| TypeScript size        | approximately 46.6k lines across the four packages                                                                                            |
| Plugin                 | `plugins/goodvibes`, manifest version `2.3.3`                                                                                                 |
| MCP topology           | three independent stdio servers launched with ambient `node`; bundles and CI target Node 20, while the root package currently claims Node 18+ |
| MCP capability         | tools only; no resources, prompts, completions, or HTTP transport                                                                             |
| Tool surface           | 25 tools: Intel 15, Analytics 7, Connect 3                                                                                                    |
| Prompt content         | 5 commands, 6 skills, 4 agent role definitions                                                                                                |
| Hooks                  | 10 event scripts plus shared libraries and dependency helpers                                                                                 |
| Templates              | three scaffold template families                                                                                                              |
| Shipped server payload | approximately 41 MiB, much of it source maps and embedded sources                                                                             |

Current quality baseline, verified before planning the port:

- all four TypeScript packages typecheck;
- 58 test files pass, with 690 tests passing and 1 skipped;
- ESLint reports 0 errors and 32 warnings;
- the Claude manifest lockstep check passes at `2.3.3`.

These tests are valuable regression coverage, but they do not prove that the current path, concurrency, credential, timeout, or transcript assumptions are safe in Codex.

### 2.1 Existing MCP topology

The source manifest points to `plugins/goodvibes/.mcp.json`. Each server uses `@modelcontextprotocol/sdk`, `StdioServerTransport`, a static `ListTools` handler, and a `CallTool` handler. All initialize with `{ tools: {} }`; no MCP resources or prompts need to be recreated for parity.

The server inventory is:

| Server        | Existing tools                                                                                                                                                                                                                               | Port disposition                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intel (15)    | `code_read`, `code_grep`, `code_glob`, `code_surface`, `code_safe_delete`, `api_routes`, `api_spec`, `api_validate`, `db_schema`, `component_tree`, `hook_dependencies`, `client_boundary`, `layout_analysis`, `scaffold`, `structural_edit` | Port all, preserving names where possible; add workspace enforcement, annotations, cancellation, and edit hardening                                      |
| Analytics (7) | `query`, `dashboard`, `budget`, `export`, `tag`, `sync`, `config`                                                                                                                                                                            | Preserve the workflow-facing names, replace the Claude transcript/cost implementation with a Codex adapter                                               |
| Connect (3)   | `api_request`, `service`, `db_query`                                                                                                                                                                                                         | Preserve the data-plane names; remove model-mutable authority changes from `service` and move registration/auth/write grants to an approved control path |

### 2.2 Prompt and automation inventory

The current plugin also ships:

- commands: `/analytics`, `/codebase-review`, `/plugin`, `/services`, `/setup`;
- skills: `intel-mastery`, `project-onboarding`, `goodvibes-memory`, `task-orchestration`, `review-scoring`, `service-integration`;
- agent roles: `architect`, `engineer`, `tester`, `refutation-reviewer`;
- hooks for session start/end, setup, commit guarding, compaction, tool failure, subagent lifecycle, and turn stop;
- scaffold assets and runtime WASM/binary dependencies.

This content should be treated as product behavior that needs a migration decision, not as files to copy indiscriminately.

## 3. Codex compatibility decisions

The plan follows the current [Codex plugin model](https://developers.openai.com/codex/plugins/build), [MCP configuration](https://developers.openai.com/codex/mcp), [skill format](https://learn.chatgpt.com/codex/build-skills), [hook contract](https://learn.chatgpt.com/codex/hooks), and [custom-agent configuration](https://learn.chatgpt.com/codex/agent-configuration/subagents).

| Claude plugin feature               | Codex target                          | Decision                                                                                                               |
| ----------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `.claude-plugin/plugin.json`        | `.codex-plugin/plugin.json`           | Replace; use strict semver and required `interface` metadata                                                           |
| `mcpServers: ./.mcp.json`           | same plugin component                 | Keep one companion file with all three servers                                                                         |
| `${CLAUDE_PLUGIN_ROOT}` in MCP args | launcher path and tested plugin `cwd` | Replace; probe the installed runtime's argv/cwd/env/relative-path behavior instead of inferring hook-variable behavior |
| `alwaysLoad` on Analytics           | no equivalent needed                  | Remove; server availability is controlled by plugin installation/configuration                                         |
| Claude commands                     | skills                                | Convert command workflows to explicit/implicit Codex skills                                                            |
| Claude skills                       | Codex skills                          | Port and update tool names, host concepts, examples, and metadata                                                      |
| Claude agents directory             | orchestration role references         | Do not claim direct plugin-agent parity; optionally offer an explicit installer for project `.codex/agents` later      |
| `Setup` hook                        | no Codex event                        | Retire; provide maintenance skill and first trusted `SessionStart` behavior                                            |
| `PostToolUseFailure`                | `PostToolUse`                         | Defer until real Codex Bash response fixtures support reliable failure classification                                  |
| `SessionEnd`                        | no equivalent                         | Retire; `Stop` is per turn and must not be treated as session end                                                      |
| common lifecycle events             | Codex hooks                           | Adapt schemas and response shapes, and rely on default `hooks/hooks.json` discovery                                    |
| `~/.claude/...`                     | Codex/plugin-scoped storage           | Namespace state; only support explicit import from Claude state                                                        |
| Claude JSONL sessions               | Codex rollout JSONL                   | Rebuild behind a versioned, tolerant host adapter                                                                      |
| Anthropic model prices              | Codex token/rate data                 | Do not port; any future dollar value must be labeled an API-equivalent estimate                                        |

### 3.1 Candidate Codex manifest

The first implementation should create `plugins/goodvibes/.codex-plugin/plugin.json` along these lines:

```json
{
  "name": "goodvibes",
  "version": "0.1.0",
  "description": "Structure-aware code intelligence, Codex analytics, and controlled service access through three MCP servers.",
  "author": {
    "name": "Mike Davis",
    "email": "mgd34msu@gmail.com"
  },
  "homepage": "https://goodvibes.sh",
  "repository": "https://github.com/mgd34msu/goodvibes-codex",
  "license": "MIT",
  "keywords": ["codex", "mcp", "code-intelligence", "analytics", "database"],
  "mcpServers": "./.mcp.json",
  "skills": "./skills/",
  "interface": {
    "displayName": "GoodVibes",
    "shortDescription": "Code intelligence, analytics, and safe service access",
    "longDescription": "Inspect and edit code structurally, analyze Codex usage, and access registered HTTP and database services through explicit trust boundaries.",
    "developerName": "Mike Davis",
    "category": "Developer Tools",
    "capabilities": ["Interactive", "Read", "Write"],
    "websiteURL": "https://goodvibes.sh",
    "defaultPrompt": [
      "Map this codebase with GoodVibes and identify its main architectural boundaries.",
      "Review this change with GoodVibes and rank the findings by severity.",
      "Show GoodVibes token and session health for this project."
    ]
  }
}
```

Implementation notes:

- omit a top-level `hooks` field and use default `hooks/hooks.json` discovery. This agrees with the runtime and avoids a current local validator mismatch;
- make an installed-plugin hook-fire test authoritative because current local scaffolding/validation examples are inconsistent with the official default-discovery contract;
- omit `apps` unless an `.app.json` integration is actually built;
- add icon/logo fields only after real assets exist;
- keep the Codex product version independent from the upstream Claude version;
- record the upstream source tag and commit in `UPSTREAM.md` or `upstream.json`.

### 3.2 Candidate MCP declaration

Use globally distinctive server keys because plugin MCP names share a namespace and a user-defined server may shadow a plugin server:

```json
{
  "goodvibes_intel": {
    "command": "node",
    "args": ["server/intel/launcher.cjs"],
    "cwd": ".",
    "env": { "NODE_ENV": "production" }
  },
  "goodvibes_analytics": {
    "command": "node",
    "args": ["server/analytics/launcher.cjs"],
    "cwd": ".",
    "env": { "NODE_ENV": "production" }
  },
  "goodvibes_connect": {
    "command": "node",
    "args": ["server/connect/launcher.cjs"],
    "cwd": ".",
    "env": { "NODE_ENV": "production" }
  }
}
```

The direct server map is the current official format; the documented alternative wrapper is snake-case `mcp_servers`, not the Claude/local-validator camel-case wrapper. Check in a portable validator that follows the current runtime contract and test actual installation rather than shaping the artifact around a stale local validator.

The `cwd`, relative launcher arguments, inherited environment, writable-data discovery, and MCP-roots behavior above are **provisional premises**. Phase 0 must install a probe plugin that records argv/cwd/non-secret environment metadata, resolves the launcher, and calls `roots/list`. Only then should the production launch and workspace design be frozen.

### 3.3 User-controlled MCP policy

Codex users can tune bundled-server policy in their own `~/.codex/config.toml`, for example:

```toml
[plugins."goodvibes".mcp_servers.goodvibes_intel]
enabled = true
default_tools_approval_mode = "prompt"

[plugins."goodvibes".mcp_servers.goodvibes_intel.tools.code_read]
approval_mode = "approve"
```

The plugin should provide a reviewed sample and maintenance diagnostics, but it cannot assume or silently install this user policy. Tool annotations and user approvals are defense in depth. Canonical path enforcement, immutable authority state, credential controls, and write safety remain server-side requirements.

## 4. Target architecture

### 4.1 Repository layout

```text
goodvibes-codex/
├── .agents/plugins/marketplace.json
├── .github/workflows/
├── package.json
├── package-lock.json
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
├── UPSTREAM.md
├── docs/
│   ├── architecture.md
│   ├── security-model.md
│   ├── state-and-privacy.md
│   ├── development.md
│   └── migration-from-claude.md
├── packages/
│   ├── core/
│   ├── host-codex/
│   ├── intel/
│   ├── analytics/
│   └── connect/
├── plugins/goodvibes/
│   ├── .codex-plugin/plugin.json
│   ├── .mcp.json
│   ├── assets/
│   ├── control/                 # only if Phase 0 proves a host/user-presence control channel
│   │   └── goodvibesctl.cjs
│   ├── hooks/
│   │   ├── hooks.json
│   │   ├── *.mjs
│   │   └── lib/
│   ├── skills/
│   │   └── <skill>/
│   │       ├── SKILL.md
│   │       ├── agents/openai.yaml
│   │       ├── references/
│   │       └── scripts/
│   ├── server/
│   │   ├── intel/
│   │   ├── analytics/
│   │   └── connect/
│   └── templates/
└── scripts/
    ├── update-plugin-cachebuster.mjs
    ├── build-plugin.mjs
    ├── validate-artifact.mjs
    ├── smoke-mcp.mjs
    └── release.mjs
```

Within the plugin tree, manifests, skills, hooks, control code, templates, and each `launcher.cjs` are authored inputs. Bundled `index.cjs`, native/WASM payload metadata, and artifact manifests are generated outputs. The build must encode and enforce that boundary.

Add `.goodvibes/` to `.gitignore` at project creation time so runtime health/state files are never confused with source files.

### 4.2 Package responsibilities

`packages/core`

- shared MCP success/error envelopes;
- schema and output-budget helpers;
- cancellation/deadline primitives;
- safe path resolution and canonicalization;
- structured diagnostics and redaction;
- version metadata shared by all bundles.

`packages/host-codex`

- Codex workspace/context resolution;
- Codex/plugin state directories;
- hook wire schemas;
- rollout/session reader interfaces;
- token usage normalization;
- one normalized telemetry/event sink consumed by analytics and lifecycle reporting;
- optional OpenAI API-equivalent pricing provider;
- Codex CLI/version feature detection;
- host-specific fixtures and compatibility tests.

`packages/intel`

- the current analyzers, parsers, template support, and edit engine;
- no direct dependence on Claude or Codex paths;
- receives a verified `WorkspaceContext` from `host-codex`.

`packages/analytics`

- host-neutral aggregation, budgets, reports, exports, and tags;
- a `SessionSource` interface implemented by `host-codex`;
- no direct reading of `~/.claude` or hard-coded model IDs.

`packages/connect`

- request/database execution and output controls;
- immutable-at-call-time authority snapshots supplied by an approved config store;
- redirect, DNS, credential, and write-policy enforcement.

### 4.3 Common server contract

All three servers should share these conventions:

- Node 20 or newer is the documented and tested runtime;
- stdio is reserved exclusively for MCP JSON-RPC; diagnostics go to stderr;
- initialize instructions are concise and make the server's safe-use contract clear;
- tool schemas have one canonical source and are contract-snapshotted;
- handlers validate arguments against that canonical schema rather than relying on low-level MCP dispatch to do it;
- every response uses one consistent structured envelope and correct `isError` behavior;
- application validation errors and transport errors are distinguishable;
- every potentially long operation accepts an `AbortSignal` and deadline;
- process shutdown has its own deadline and cannot wait forever on a cleanup callback;
- output size, token estimate, and truncation metadata use the shared core;
- tool annotations declare `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` accurately;
- annotations are treated as advisory metadata, never as an authorization or approval mechanism;
- no process uses its current working directory as an implicit project boundary;
- no server writes into the installed plugin cache.

### 4.4 Trusted workspace context: release-blocking design

The audited Codex source suggests that a relative plugin MCP `cwd` resolves inside the installed plugin and that the client version inspected does not advertise MCP roots. These are versioned implementation observations, not a permanent public contract. Phase 0 must prove them with an installed-plugin probe. Until roots or another host-authenticated context is actually received, an unverified `base_path` can escape the user's workspace, and the external MCP process must not be assumed to inherit the Codex file sandbox.

Implement a `WorkspaceContextProvider` before porting domain tools. Its contract should be:

```ts
interface WorkspaceContext {
  id: string;
  canonicalRoot: string;
  visibleRoots: string[];
  source: 'mcp-roots' | 'user-control';
}

interface WorkspaceContextProvider {
  resolve(workspaceId: string): Promise<WorkspaceContext>;
  resolvePath(ctx: WorkspaceContext, relativePath: string): Promise<string>;
}
```

Resolution rules:

1. Run an installed-plugin host probe for cwd, argv, environment, and `roots/list` on every supported Codex release line.
2. Prefer standard MCP roots when the probed runtime exposes them.
3. Until then, require a **host-mediated user-presence boundary**, such as a plugin settings UI or protected broker that Codex tools cannot invoke or forge. A same-user `goodvibesctl` command or writable file is not sufficient merely because it is outside MCP: Codex may invoke local CLIs or write same-user state.
4. If the only available fallback is a CLI/config file protected by Codex sandbox and approval, state that weaker threat-model assumption explicitly and test it. The CLI must require a verified interactive/user-presence channel, and authority records must have integrity protection that a model-controlled shell cannot reproduce.
5. Store canonical registered roots in protected Codex-specific control state, with user-visible list/revoke behavior.
6. Normal tools take a `workspace_id` and workspace-relative paths. Do not accept arbitrary absolute roots as authority.
7. Resolve symlinks and junctions, compare canonical paths, and recheck the final path before each read/write.
8. Support multiple workspace roots rather than assuming a single Git repository.
9. Treat registration as control-plane state. Domain tools cannot add, widen, or silently repair it.
10. Show the canonical path during the user-presence flow and document immediate revocation.
11. Offer plugin-scoped Codex approval-mode configuration as defense in depth, but do not make server security depend on users having configured it.

If neither MCP roots nor a proven user-presence control flow is available, defer filesystem tools until the host contract improves. Shipping a convenient but model-defined root—or treating a model-invokable CLI as a different principal—would invalidate the stated trust boundary.

#### Tool-schema consequences

Treat this as a versioned schema migration, not a hidden adapter:

- replace every Intel `base_path` authority field with `workspace_id`; all file/path/glob/spec/template inputs are workspace-relative and reject absolute or parent traversal;
- make `scaffold` output workspace-relative, or require a separately registered external destination ID;
- bind structural-edit preview tokens to the workspace ID and relative file set;
- bind Analytics report/export destinations to a workspace or separately approved destination ID;
- remove project-cwd driver discovery from Connect and reference only approved connection handles;
- update every skill example, golden schema, and compatibility document; do not retain an escape hatch that accepts legacy absolute paths.

### 4.5 State, privacy, and coexistence

Use three storage classes:

| Class                      | Proposed location                                                                            | Contents                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Hook-private durable state | documented `PLUGIN_DATA`                                                                     | hook trust/version markers, hook-only logs and scratch state                                                                           |
| Protected authority state  | host settings or a user-presence broker selected in Phase 0                                  | trusted roots, Connect origins/auth/write grants, secret handles, external export grants, analytics ingestion/privacy/retention policy |
| Shared durable data        | `${GOODVIBES_DATA_ROOT}` when explicitly set, otherwise `${CODEX_HOME:-~/.codex}/goodvibes/` | dependencies, install results/logs, non-secret analytics events/index                                                                  |
| Project state              | `<workspace>/.goodvibes/codex/`                                                              | non-authoritative preferences, health, reports, local tags, non-secret caches                                                          |
| Ephemeral state            | OS temp directory or process memory                                                          | previews, request scratch data, parser caches                                                                                          |

Requirements:

- never silently reuse `.goodvibes` files whose schema was written by the Claude plugin;
- prove how hooks and MCP launchers resolve shared state; `PLUGIN_DATA` is documented for hook processes, not bundled MCP processes;
- keep all grants and privacy authority outside workspace-writable and model-writable state: roots, origins, auth, write grants, external exports, dependency consent, transcript ingestion, retention, and global analytics policy;
- offer an explicit, one-way migration/import command if shared history is useful;
- secrets live outside the repository with mode `0600` on POSIX and a documented restrictive Windows ACL; reject/repair lax pre-existing files and defend against symlink replacement;
- launch MCP servers with a minimal environment allowlist;
- logs redact headers, credentials, database URLs, query parameters selected as secrets, and environment values;
- analytics is local and opt-in where transcript/session reading is involved;
- state schemas include `schema_version`, `host`, and migration tests;
- all shared authority/config/secret writes are atomic, locked, versioned, and durable before success is reported;
- all database/index writes are safe across multiple concurrent Codex sessions.

### 4.6 Runtime dependency strategy

The current plugin installs packages into a global Claude directory and links them back into the plugin cache. That is non-reproducible, assumes the cache is writable, can leave stale dependencies, and only probes a representative package.

For Codex:

1. Pin runtime packages exactly and commit a per-server runtime `package-lock.json`, or one dedicated runtime-dependencies workspace lock; use `npm ci`, never an unlocked `npm install`.
2. Key installations by lock digest, server, OS, architecture, libc where relevant, and Node ABI/version.
3. Resolve the writable data root in the launcher using the tested `GOODVIBES_DATA_ROOT`/`CODEX_HOME`/home fallback contract; do not assume MCP receives hook-only `PLUGIN_DATA`.
4. Install through a staging directory, fully probe every external module and matching WASM asset, then promote it under a versioned/digest path with an atomic pointer where the platform supports it.
5. Never symlink or copy `node_modules` into the installed plugin directory.
6. Have `server/<name>/launcher.cjs` initialize module resolution from the resolved dependency directory before loading `index.cjs`.
7. Preserve the useful current behavior in which every server can initialize and list tools before optional native/WASM dependencies are installed.
8. A dependency-backed tool should return a precise maintenance action, not crash the server.
9. Make downloads an explicit action through the selected user-presence/consent channel. Cold/offline operation must degrade clearly; after dependencies are prepared, warm/offline operation must work. Marketplace `ON_INSTALL` authentication is not a dependency-install hook.
10. Add garbage collection for old digests with conservative retention and no deletion of an in-use digest.

## 5. MCP server migration plan

### 5.1 Intel server

Intel is the highest-reuse package. Port its schemas, TypeScript compiler analysis, ripgrep/fast-glob logic, tree-sitter support, OpenAPI analysis, schema parsers, and output budgeting. Make workspace safety and write semantics first-class.

| Tool                | Behavior to preserve                           | Codex work required                                                          | MCP annotations                                                                               |
| ------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `code_read`         | line/outline reads, paging, budgets            | verified workspace paths; dependency-free line mode; abortable parser load   | read-only, idempotent, closed-world                                                           |
| `code_grep`         | batched ranked search and replacement previews | root-bound ripgrep invocation; kill process on abort; binary/output controls | read-only, idempotent, closed-world                                                           |
| `code_glob`         | presets, filters, previews                     | root-bound traversal; symlink/junction tests                                 | read-only, idempotent, closed-world                                                           |
| `code_surface`      | public/internal TS API map                     | remove cwd assumptions; abortable TypeScript program build                   | read-only, idempotent                                                                         |
| `code_safe_delete`  | semantic reference check                       | keep advisory name/behavior; root enforcement                                | read-only, idempotent                                                                         |
| `api_routes`        | framework route discovery                      | root enforcement and fixture parity                                          | read-only, idempotent                                                                         |
| `api_spec`          | generated OpenAPI response                     | keep response-only default; explicit path needed for any write               | read-only, idempotent                                                                         |
| `api_validate`      | spec-versus-code validation                    | root-bound spec resolution                                                   | read-only, idempotent                                                                         |
| `db_schema`         | Prisma/Drizzle/SQL discovery                   | root enforcement; bounded SQL parsing                                        | read-only, idempotent                                                                         |
| `component_tree`    | component hierarchy/annotations                | root enforcement; parser dependency diagnostics                              | read-only, idempotent                                                                         |
| `hook_dependencies` | React hook dependency analysis                 | root enforcement and current framework fixtures                              | read-only, idempotent                                                                         |
| `client_boundary`   | server/client boundary analysis                | root enforcement                                                             | read-only, idempotent                                                                         |
| `layout_analysis`   | CSS/layout diagnostics                         | root enforcement and bounded parsing                                         | read-only, idempotent                                                                         |
| `scaffold`          | templated project generation                   | default to plan-only; separate file creation from package install/git init   | destructive and open-world on execution                                                       |
| `structural_edit`   | preview/apply workflow                         | rebuild transaction and preview-token security                               | combined compatibility tool is destructive; split preview/apply tools can annotate accurately |

MCP annotations only describe behavior; they cannot enforce approval. Codex lets users configure plugin-scoped default/per-tool approval modes in their own config, but a plugin cannot assume that configuration exists and tool-level policy may not distinguish action arguments. Phase 0 must test that policy for defense-in-depth UX. If policy is tool-level only, split `scaffold_plan` from `scaffold_apply` and `structural_edit_preview` from `structural_edit_apply` so users can configure meaningful prompts; otherwise keep execution in a directly invoked external control path. In all cases, server-side checks remain mandatory. Capability parity matters more than preserving an unsafe 25-tool count.

`scaffold` should change its unsafe defaults. It currently writes/overwrites and defaults to running package installation plus `git init` unless `dry_run` is set. In Codex, plan-only behavior should be the normal path. File creation, package installation, and Git initialization must be separate explicit operations, cancellable, reflected in the result, and protected server-side even when no host approval policy is configured.

`structural_edit` hardening requirements:

- preview records bind workspace ID, canonical paths, original hashes, requested edits, tool/schema version, and expiry;
- tokens are cryptographically random or HMAC-signed and consumed atomically;
- the apply path uses create-exclusive/rename semantics so two callers cannot consume one token;
- revalidate every source hash and workspace boundary at apply time;
- stage file contents, fsync where meaningful, and atomically rename on the same filesystem;
- keep a transaction journal sufficient for deterministic rollback;
- serialize overlapping writes within a workspace;
- test race, expiration, symlink swap, partial failure, and rollback paths;
- do not describe best-effort multi-file writes as atomic until those tests pass.

### 5.2 Analytics server

Analytics is the largest host-specific rewrite. The current implementation assumes Claude project JSONL layout, Claude task/subagent records, Anthropic model IDs and prices, `~/.claude/projects`, and `~/.claude/.goodvibes`. Those assumptions must remain in an optional Claude import adapter, not in the Codex engine.

Implement these interfaces:

```ts
interface SessionSource {
  discover(scope: AnalyticsScope): AsyncIterable<SessionDescriptor>;
  records(session: SessionDescriptor, cursor?: Cursor): AsyncIterable<NormalizedRecord>;
}

interface UsageSource {
  current(): Promise<NormalizedTokenUsage | null>;
  limits(): Promise<NormalizedRateLimitState | null>;
}
```

A local inspection of current Codex rollout files shows usable `session_meta`, `turn_context`, response/tool records, and `event_msg` token-count records. That makes a Codex adapter feasible, but the rollout format is not a stable public contract. The adapter must:

- detect and record `cli_version` and a parser schema version;
- ignore unknown records and fields;
- parse sanitized golden fixtures from each supported Codex version;
- isolate transcript reading behind `host-codex`;
- fail with a compatibility diagnostic rather than silently producing zeros;
- prefer stable hook inputs such as `last_assistant_message` over parsing transcript internals;
- never ingest secrets or full prompt/tool payloads when counters and metadata suffice.

Define one versioned `GoodVibesEvent` schema and a concurrency-safe `TelemetrySink/EventStore`. Every MCP invocation records bounded timing/result metadata through that sink; retained hooks may add only stable lifecycle metadata; rollout ingestion supplies Codex token/tool/agent records. The analytics layer must label each metric's provenance and reconcile duplicate observations. Cache, timing, anomaly, and tool-health queries remain deferred until this producer/consumer path is implemented—do not copy the source's disconnected telemetry DB and hook JSONL streams.

Tool plan:

| Tool        | First Codex release                                                                     | Later parity                                                                                  |
| ----------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `query`     | current session/project tokens, cache, commands/tools, agents, health                   | historical and cross-project grouping after durable indexing is safe                          |
| `dashboard` | status/doctor and a local token/session HTML report                                     | richer historical comparisons                                                                 |
| `budget`    | token budgets and warnings                                                              | optional API-equivalent dollar estimates                                                      |
| `export`    | bounded JSON/CSV/Markdown under the registered workspace or an approved export location | historical/all-project export                                                                 |
| `tag`       | project/session tags in Codex namespace                                                 | cross-project tag queries                                                                     |
| `sync`      | incremental Codex rollout import with version diagnostics                               | optional explicit Claude-history import                                                       |
| `config`    | schema-validated, non-authoritative display/query preferences                           | privacy, ingestion, retention, and external-export authority remain out-of-band host controls |

Do not call an estimated dollar value “Codex cost” or “actual spend.” ChatGPT/Codex subscription billing is not derivable from local token records. If an OpenAI API price table is later added, label results `api_equivalent_estimate`, timestamp the pricing data, map model aliases explicitly, and show unpriced usage separately.

The current sql.js global database is loaded and exported as a whole file without cross-process locking, so concurrent sessions can lose updates. Choose one of these before historical analytics ships:

- a real SQLite implementation with WAL and migrations, accepting its native packaging burden; or
- append-only per-process events plus a single-writer compactor with atomic snapshots and locking.

Do not retain whole-file last-writer-wins persistence.

### 5.3 Connect server

The useful Connect data plane is reusable, but its current control plane is too permissive. Today the model-facing `service` tool can register services, change allowlists, set authentication, register database connections, and enable writes. It can also refer to arbitrary inherited environment variables. That means the same principal requesting access can grant itself access.

Target trust model:

1. Keep `api_request`, `service`, and `db_query` as the three domain tools.
2. Make `service` read-only for `list`, `get`, and `status` in ordinary MCP use.
3. Remove register/remove/auth/allowlist/connection/write-grant actions from the model-facing `service` schema. Move them to the Phase-0-proven host/user-presence control channel. A bare same-user CLI/file is not a separate authority. This is an intentional schema incompatibility with the Claude tool and must be documented.
4. Snapshot policy at request start; normal requests cannot modify it.
5. Make writes deny-by-default per service/connection and visibly distinguish them in tool arguments and results.
6. Remove literal per-request auth overrides, `{$env}`, and `url_env` from data-plane schemas. Requests may reference only opaque secret handles created out of band.
7. Redact secrets from all responses, errors, logs, health records, and previews.
8. Invalidate policy snapshots by version/mtime so revoking a root, origin, secret, connection, or write grant takes effect in a running server.

HTTP hardening:

- validate scheme, hostname, port, resolved IPs, and path against the registered policy;
- reject loopback, link-local, private, metadata, Unix socket, and unexpected schemes unless specifically authorized;
- pin the validated resolved address through connection establishment with a custom dispatcher/equivalent while preserving hostname and TLS SNI verification; a separate preflight lookup followed by ordinary `fetch` is insufficient;
- disable automatic redirects or revalidate every redirect hop under the same policy;
- attach registered credentials/cookies only after each hop passes origin policy, and strip them on unapproved/cross-origin redirects;
- bound response bytes while streaming rather than after buffering;
- apply cancellation and a real wall-clock deadline;
- enforce configured rate limits and make queued requests/retries abortable;
- log only redacted origin/method/status/timing metadata.

Database hardening:

- resolve connection definitions only from approved control state;
- do not load arbitrary project-local drivers based on an untrusted cwd;
- make read-only the default at the server and connection level, independent of advisory tool metadata or user approval settings;
- use a dialect-aware single-statement allowlist plus PostgreSQL/MySQL server-side read-only roles/transactions and SQLite query-only mode; reject unknown statement classes rather than relying on keyword prefixes;
- use statement/transaction timeouts and cancellation where the driver supports them;
- disallow stacked or multiple statements unless explicitly required and approved;
- cap rows, bytes, and execution time independently;
- make `explain` safe for the selected engine;
- test PostgreSQL, MySQL, and SQLite behavior independently.

The adversarial DB corpus must explicitly cover comments/CTEs, negative or oversized limits, `CALL`, `DO`, `COPY`, `EXEC`, `SET`, `ANALYZE`, `ATTACH`, writable PRAGMAs, and multi-statement variants.

## 6. Skills, commands, and agents

### 6.1 Skill set

Port the six existing skills and convert the useful command workflows into skills. A compact target set is:

| Codex skill             | Origin                          | Invocation                                                                                                   |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `intel-mastery`         | existing skill                  | implicit allowed; teaches tool selection and output controls                                                 |
| `project-onboarding`    | existing skill                  | implicit allowed for unfamiliar repositories                                                                 |
| `goodvibes-memory`      | existing skill                  | explicit by default; uses Codex-scoped project state                                                         |
| `task-orchestration`    | existing skill plus agent roles | implicit for complex implementation/review work                                                              |
| `review-scoring`        | existing skill                  | implicit for reviews                                                                                         |
| `service-integration`   | existing skill plus `/services` | explicit/implicit with Connect dependency                                                                    |
| `goodvibes-analytics`   | `/analytics`                    | explicit by default                                                                                          |
| `codebase-review`       | `/codebase-review`              | explicit and implicit when clearly requested                                                                 |
| `goodvibes-maintenance` | `/plugin` and `/setup`          | explicit only; diagnostics/status and directions to the host user-presence flow; it does not grant authority |

Each skill needs:

- a complete `SKILL.md` with no Claude-only commands or tool names;
- progressive-disclosure references for long examples and policies;
- `agents/openai.yaml` with display metadata, intentional `allow_implicit_invocation`, and `dependencies.tools[]` entries using the current `type: "mcp"`/server `value` schema; validate the exact local-stdio fields and discovery against the installed plugin;
- scripts only where deterministic automation is better than prompt instructions;
- tests/lint that reject `Claude`, `CLAUDE_PLUGIN_ROOT`, obsolete hook events, and stale tool counts unless found in migration documentation.

### 6.2 Orchestration roles

Move the four role prompts to:

```text
skills/task-orchestration/references/roles/
├── architect.md
├── engineer.md
├── tester.md
└── refutation-reviewer.md
```

The orchestration skill should select Codex's available explorer/worker behavior and inject the relevant role contract into the delegated task. Remove Claude model pins and assumptions about Claude-specific subagent tool permissions.

An optional later feature may install checked-in TOML templates into a project's `.codex/agents/`, but only through an explicit maintenance action. The plugin must not silently write global or project agent configuration during installation.

## 7. Hook migration

Use `plugins/goodvibes/hooks/hooks.json` through default discovery. Plugin hooks receive `PLUGIN_ROOT` and writable `PLUGIN_DATA`, but users must inspect/trust hooks and must re-trust changed hook definitions. Multiple handlers for one event can run concurrently, so merge stateful `SessionStart` behavior into one script.

| Existing hook                          | Codex plan                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `session-start.mjs`                    | Keep and merge with open-mode behavior; load project context and report dependency state; remove Claude cost recap    |
| `session-start-open-mode.mjs`          | Merge; move user-global config to Codex/plugin data and project state to `.goodvibes/codex`                           |
| `setup.mjs` (`Setup`)                  | Retire as a hook; replace with maintenance diagnostics and the proven host/user-presence setup channel                |
| `commit-guard.mjs` (`PreToolUse:Bash`) | Keep as an advisory guard; safe path emits empty stdout/`{}`, deny uses Codex `permissionDecision: deny`              |
| `post-tool-use-failure.mjs`            | Defer; rebuild on `PostToolUse:Bash` only after golden response fixtures identify failures reliably                   |
| `pre-compact.mjs`                      | Keep marker/backup behavior; remove transcript-tail parsing and use `manual                                           | auto` trigger |
| `subagent-start.mjs`                   | Keep; use Codex `turn_id`, `agent_id`, `agent_type`, and `permission_mode`                                            |
| `subagent-stop.mjs`                    | Rebuild; use stable last-message/status fields; do not infer changed files or run typecheck from transcript internals |
| `stop.mjs`                             | Keep as lightweight per-turn telemetry; never call it session end                                                     |
| `session-end.mjs`                      | Retire; Codex has no equivalent and mapping it to `Stop` would double count                                           |

Minimal first-release events:

- `SessionStart`;
- `PreToolUse` for the Bash credential/commit advisory;
- `PreCompact`;
- `SubagentStart`;
- `SubagentStop`;
- `Stop`.

Important contract tests:

- `PreToolUse` allow/fail-open returns no unsupported `continue` field;
- denial uses the exact `hookSpecificOutput` event and permission fields;
- `SubagentStop` and `Stop` always emit valid JSON on successful exit;
- no retained hook parses unstable transcript contents;
- unsupported keys `Setup`, `PostToolUseFailure`, and `SessionEnd` do not appear in `hooks.json`;
- an installed-plugin smoke test proves default discovery from `hooks/hooks.json`; only fall back to another path if the supported Codex runtime demonstrably requires it;
- one fixture per event validates POSIX and Windows commands (`commandWindows` where needed);
- the commit hook is documented as a guardrail, not a complete shell-enforcement boundary.

Dependency installation cannot be assumed to happen at `SessionStart` before hook trust. The plugin should still install, initialize, and explain its maintenance state without trusted hooks.

## 8. Build, packaging, and release design

### 8.1 Clean build

The current build does not clean output and copies some assets best-effort, which can leave stale or incomplete artifacts. Codex installation also does not run this repository's build. Treat `plugins/goodvibes` as the real runnable marketplace root: manifest, skills, hooks, launchers, templates, and runtime manifests are authored there; generated bundles/assets live only under declared generated server subtrees. Commit a runnable plugin tree for a source marketplace, or publish the same tree from a dedicated distribution repository.

Replace the build with one root pipeline:

1. validate the source manifest and upstream metadata;
2. typecheck all workspaces;
3. copy the authored plugin content into a fresh temporary marketplace/artifact root;
4. build every generated server subtree into that root and assert every required WASM/template/runtime manifest;
5. assert bundles contain no unresolved `@goodvibes/*`, source `.ts`, repository `node_modules`, or undeclared external imports;
6. run artifact-only dependency scans, MCP smoke tests, and portable checked-in schema validation;
7. generate file hashes, sizes, third-party notices, licenses, and an artifact manifest;
8. build twice from clean inputs and compare manifests/hashes for reproducibility;
9. for a source-marketplace release, perform a validated clean replacement of only generated server subtrees while no process consumes them; do not claim cross-platform atomic replacement of a non-empty plugin directory;
10. fail if generated output differs unexpectedly or stale output remains.

Use Node 20 as the minimum because the current bundles and test toolchain already require it. Test Node 20 and 22.

Because `.mcp.json` launches ambient `node`, document and test a Node 20+ prerequisite before installation. Provide a README/installer diagnostic that still works when Node is missing; an MCP maintenance tool cannot explain a failure when no MCP process can start.

### 8.2 Artifact size and source maps

Committed server artifacts are roughly 41 MiB; source maps account for a large fraction and embed source content. Decide explicitly whether release archives need maps. The default recommendation is:

- omit full source maps from marketplace artifacts;
- remove any resulting `sourceMappingURL` reference from release bundles;
- publish source and build provenance in the repository;
- publish source maps only as a separate debug artifact when needed;
- set a CI size budget per server and for the full plugin.

### 8.3 Lockfiles and versions

Do not copy the current root lockfile blindly; it contains stale workspace/extraneous state. Regenerate it in this repository and require:

- `npm ci` succeeds in a clean checkout;
- `npm ls` has no unexpected extraneous/missing entries;
- runtime dependency manifests are exact and have committed `npm ci`-compatible lockfiles;
- server and plugin versions come from one Codex manifest source;
- docs/tool counts are generated or contract-tested to prevent drift;
- Codex version `0.1.0` is independent of upstream `2.3.3`;
- `UPSTREAM.md` records the source tag, commit, port date, carried patches, and later merge decisions.

### 8.4 Marketplace and install flow

Add this repo-local `.agents/plugins/marketplace.json` for development/distribution (the final catalog name may change before publication):

```json
{
  "name": "goodvibes-local",
  "interface": {
    "displayName": "GoodVibes Development"
  },
  "plugins": [
    {
      "name": "goodvibes",
      "source": {
        "source": "local",
        "path": "./plugins/goodvibes"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
```

Marketplace `source` is resolved relative to the marketplace root, and Codex installs a cached copy. Use one of two exact flows:

- repository flow: promote the validated generated subtrees into the committed `plugins/goodvibes` tree, then validate/install the repo marketplace whose source is exactly `./plugins/goodvibes`;
- release/CI flow: create a temporary marketplace root containing `.agents/plugins/marketplace.json` and the exact staged `plugins/goodvibes` artifact, then install from that root.

Run the cachebuster **before** building so injected versions agree, then validate, reinstall, and test in a new thread. Build one canonical artifact, upload it, and have Linux/macOS/Windows jobs test that same artifact while acquiring their own platform-specific optional dependencies. Automated CLI ingestion/handshake belongs in CI; a fresh Codex app thread is a separately recorded manual release gate.

The non-default repo or temporary-marketplace install sequence is:

```bash
node scripts/update-plugin-cachebuster.mjs plugins/goodvibes
npm run build:plugin
npm run validate:plugin
codex plugin marketplace add <absolute-marketplace-root>
codex plugin add goodvibes@goodvibes-local
```

`update-plugin-cachebuster.mjs` is a checked-in portable equivalent of the local plugin-creator helper. Rebuild the temporary marketplace with the same `name` if that flow is used, reinstall after every changed artifact, and start a fresh thread after reinstall. Stable releases omit cachebuster metadata and use the transactional release flow below.

### 8.5 Transactional release workflow

`scripts/release.mjs` should require a clean main branch, changelog entry, stable semver without a local cachebuster, and an upstream provenance update. It should perform the version bump and mandatory build in a temporary worktree/staging root, run every gate against the exact artifact, verify the expected source/generated diff, attach checksums/SBOM/debug maps as applicable, and only then create the tag and publish. A failure must leave the main checkout unbumped and unpublished; there is no `--skip-build` release path.

## 9. Phased implementation roadmap

Each phase ends in a demonstrable gate. Do not advance merely because files have been copied.

### Phase 0 — contracts, threat model, and host spike

Deliverables:

- record upstream tag/commit and generate the full capability inventory;
- decide state coexistence/import behavior;
- write `security-model.md` with workspace, filesystem, network, credential, database, transcript, and dependency trust boundaries;
- implement a minimal `host-codex` package;
- install a probe plugin that tests direct-map `.mcp.json`, launcher resolution, cwd/argv/env, writable-data discovery, `roots/list`, default hook discovery, and user-configured approval behavior on the supported Codex version;
- spike MCP roots support and candidate host/user-presence registration flows;
- prove that the selected control channel cannot be invoked/forged through model-controlled MCP or shell, or explicitly document/test reliance on Codex sandbox approvals as a weaker threat model;
- freeze the control-plane interface, protected-state integrity model, and immediate revocation contract;
- define canonical response envelopes, errors, annotations, cancellation, and version contracts;
- define analytics v1 as token/session health rather than actual billing.

Exit gate:

- a minimal server can initialize/list/call from an installed plugin;
- hook and MCP components resolve their intended private/shared data roots without assuming MCP receives `PLUGIN_DATA`;
- a test proves an unregistered absolute path, `..`, symlink escape, and alternate root are denied;
- a user can list and revoke approved roots;
- security review signs off on the boundary.

### Phase 1 — repository scaffold and reproducible core

Deliverables:

- create the Codex manifest, direct-map three-server `.mcp.json`, marketplace entry, workspace config, and CI skeleton;
- port `core` and introduce `host-codex`;
- define the versioned `GoodVibesEvent`, `TelemetrySink`, and concurrency-safe event-store contract;
- regenerate lockfiles under Node 20;
- implement clean staging builds and plugin validation;
- build dependency health/launcher behavior without writing the plugin cache;
- add common MCP contract tests.

Exit gate:

- clean checkout can `npm ci`, typecheck, test, build, validate, and produce a deterministic artifact;
- each of the three placeholder servers independently initializes and lists its intended tool contracts;
- missing optional runtime dependencies produce actionable errors without breaking handshake.

### Phase 2 — Intel parity and write hardening

Deliverables:

- port all 13 read/advisory Intel tools first;
- package/test ripgrep, tree-sitter, required grammar WASM, and templates; do not carry the stale Intel sql.js dependency unless a reachable feature is specified;
- port `scaffold` with preview-first semantics;
- rebuild `structural_edit` preview/apply transactions;
- add accurate MCP annotations, document user-config approval settings, and split mixed preview/apply tools if the host cannot enforce the required boundary;
- port Intel fixtures and add Codex workspace-boundary tests.

Exit gate:

- all 15 audited Intel capabilities, plus any security-motivated split execution tools, pass schema snapshots and representative calls in an installed plugin;
- no path escape or symlink race test succeeds;
- edit concurrency/rollback tests pass;
- destructive execution remains server-safe with no host approval configured and is separated enough for users to configure an always-prompt tool policy.

### Phase 3 — Connect data plane and control plane

Deliverables:

- port read-only service registry/status behavior;
- implement administration through the Phase-0-proven host/user-presence channel for service/connection/auth/write policy;
- port HTTP requests with redirect, SSRF, DNS, body-size, timeout, cancellation, and redaction controls;
- port database queries with read-only default and driver-specific policy;
- add secret storage and migration behavior;
- annotate all open-world/destructive operations and document optional user-owned plugin MCP policy.

Exit gate:

- a normal model tool call cannot grant itself a host, secret, connection, or write permission;
- redirect, DNS rebinding, metadata endpoint, arbitrary environment variable, and credential-log tests pass;
- test services and databases work only after explicit registration;
- revoked permissions take effect without reinstalling the plugin.

### Phase 4 — Codex skills, orchestration roles, and hooks

Deliverables:

- port the six skills and three command-derived skills;
- create `agents/openai.yaml` metadata and validated `dependencies.tools[]` MCP entries;
- migrate four role prompts into the orchestration references;
- implement the six-event minimal hook set;
- implement and test hook-private versus shared GoodVibes data resolution;
- write setup, trust, privacy, and migration docs.

Exit gate:

- explicit and intended implicit skill invocation works from a fresh thread;
- role-based subagent workflows run without Claude model/tool assumptions;
- every hook fixture passes and unsupported events are absent;
- plugin operation remains understandable before hooks are trusted.

### Phase 5 — Analytics v1: trustworthy Codex telemetry

Deliverables:

- implement versioned Codex rollout/session and current-usage adapters;
- instrument all three MCP dispatch paths through the shared event sink and reconcile server events with rollout-derived observations;
- normalize token/cache/reasoning counters without retaining prompt bodies;
- ship `query`, `dashboard status/doctor`, token `budget`, bounded `export`, project/session `tag`, incremental `sync`, and `config`;
- build a local self-contained HTML report labeled with data provenance;
- implement concurrency-safe persistence;
- add corrupt/truncated/unknown-version fixture behavior.

Exit gate:

- reports reconcile with known synthetic fixtures;
- unsupported Codex versions fail visibly and safely;
- concurrent sessions do not lose indexed data;
- no UI, output, or documentation describes token-derived estimates as actual spend.

### Phase 6 — historical analytics and optional estimates

Deliverables:

- cross-session/project queries and tags;
- retention, compaction, rebuild, and database migrations;
- explicit one-way Claude history import, if desired;
- optional timestamped OpenAI API-equivalent pricing provider;
- analytics performance/size benchmarks.

Exit gate:

- incremental sync is idempotent and crash-safe;
- rebuild from source data produces the same aggregates;
- priced and unpriced usage are separated and labeled;
- privacy/retention controls are user-visible.

### Phase 7 — cross-platform hardening and `0.1.0`

Deliverables:

- Ubuntu, macOS, and Windows build/install/runtime coverage;
- Node 20/22 quality matrix;
- path-with-spaces, clean HOME, missing-Node, read-only plugin tree, cold-offline graceful-degradation, warm-offline, and fresh-install tests;
- artifact size/license/SBOM/checksum generation;
- marketplace install/reinstall/uninstall smoke tests;
- user docs, upgrade notes, and known limitations;
- dogfood sessions on small, medium, monorepo, non-Git, and multi-root workspaces.

Exit gate:

- all release gates below pass from a clean release staging directory;
- the installed artifact, not the source checkout, is what was tested;
- release notes enumerate any intentionally deferred Claude capability.

## 10. Test and CI strategy

### 10.1 Required CI jobs

`quality` on Node 20 and 22:

- install from lockfile;
- typecheck all packages;
- lint with no errors and a tracked warning budget;
- run unit/integration tests;
- verify generated tool/docs/version registries are fresh;
- run `npm ls` and lockfile consistency checks.

`artifact`:

- build from a clean staging directory;
- validate `.codex-plugin/plugin.json` and direct-map `.mcp.json` with a checked-in portable validator plus actual Codex ingestion;
- assert required WASM/templates/hook/skill assets;
- scan bundles for absolute developer paths, secrets, Claude-only variables, and missing licenses;
- reject unresolved workspace packages, source TypeScript imports, repository `node_modules`, and undeclared runtime externals;
- repeat a clean build and compare artifact manifests/hashes;
- enforce artifact size budgets and produce checksums/SBOM.

`mcp-contract`:

- initialize, list tools, and call at least one dependency-free tool on all three servers;
- snapshot all tool names, schemas, annotations, instructions, error envelopes, and `isError` flags;
- start/stop each server repeatedly and verify stdout contains JSON-RPC only;
- test cancellation, deadlines, malformed input, unknown tools, oversized output, and missing dependencies;
- test stdin close, parent-process loss, SIGTERM/SIGINT, bounded shutdown, and a deliberately hung operation that is cancelled or killed within budget;
- reject duplicate batch IDs instead of silently overwriting an earlier result.
- contract-test binary/base64 request bodies so `body_base64` never silently becomes lossy UTF-8 text.

`platform` on Ubuntu, macOS, and Windows:

- test path with spaces and Unicode;
- test clean HOME/CODEX_HOME;
- test read-only installed plugin directory;
- test cold/offline startup and actionable degradation, then warm/offline full operation after explicit dependency preparation;
- test optional dependency install/repair and executable permissions;
- run representative Intel ripgrep/tree-sitter and Analytics/Connect sql.js or replacement-store calls.

`plugin-smoke`:

- validate and install the repo marketplace artifact;
- run an automated Codex CLI ingestion/handshake test;
- confirm three namespaced servers and expected skills are discovered;
- exercise hook trust/no-trust states;
- disable each server independently and verify graceful degradation;
- reinstall a changed build and verify the cachebuster selected it.

Separately record a manual new-thread Codex app check before release; it should not be modeled as a deterministic GitHub CI step.

### 10.2 Security suites

Filesystem:

- relative traversal, absolute path, sibling repository, symlink/junction swap, case-folding, Unicode normalization, hard link, deleted/recreated root, multi-root confusion;
- preview/apply races, double token consume, stale hash, partial rename, rollback, concurrent overlapping edits;
- export and report paths receive the same enforcement as code tools.
- host-owned authority files reject symlink replacement, repair/refuse lax POSIX modes, and apply the documented Windows ACL fallback; revocation is observed by already-running servers.

Network:

- IPv4/IPv6 private, loopback, link-local, metadata endpoints, encoded hostnames, user-info URLs, alternate ports, redirects, DNS rebinding, cross-origin credential stripping;
- request/response streaming limits and timeout cancellation;
- secret redaction in every error and diagnostic path.

Database:

- write detection and explicit grants, multi-statements, transaction timeout, large/cyclic values, row/byte caps, cancellation, connection errors, driver loading boundaries.

Analytics:

- truncated/corrupt/mixed-version rollout files, duplicate records, clock skew, unknown models, missing token fields, parent/subagent relationships, repeated sync, concurrent writers, migrations, report escaping;
- known token fixtures reconcile exactly;
- dollar labels and pricing timestamps are contract-tested.

Hooks:

- one golden stdin/stdout fixture per event;
- invalid input fails open or closed according to documented risk;
- response shapes never mix Claude and Codex fields;
- scripts remain silent on safe paths and send logs to stderr;
- no transcript-internal parsing remains in lifecycle hooks.

## 11. Release gates and definition of done

The `0.1.0` release is ready only when all of the following are true:

- a repo marketplace installs one GoodVibes plugin containing three independently operable MCP servers;
- all 25 audited domain capabilities are either working or named in an explicit, user-visible deferral matrix; security-motivated tool splits/schema changes are counted separately and documented;
- every filesystem/export/report operation is bound to an approved canonical workspace or approved external destination;
- normal Connect calls cannot mutate their own trust policy;
- credentials and environment secrets cannot appear in tool output, logs, analytics, or reports;
- Intel edit/apply and scaffold execution have race-safe semantics and a server-side authority boundary even when the user has not configured prompt approvals;
- Analytics reads Codex data through a versioned adapter and makes no actual-billing claim;
- concurrent sessions cannot corrupt or silently overwrite shared state;
- the plugin never depends on a writable installation/cache directory;
- all three MCP handshakes work on a fresh install before optional dependency repair;
- skills, hooks, templates, and role workflows are verified from the installed artifact;
- the same canonical artifact passes Linux, macOS, Windows, Node 20, and Node 22 gates, with platform-specific runtime dependencies prepared separately;
- source, built artifact, checksums, dependency licenses, and upstream provenance are available;
- documentation contains setup, trust, privacy, state, troubleshooting, migration, and uninstall/revoke instructions;
- no active product text refers to Claude paths, Anthropic pricing, Claude-only events, or the stale 14-tool Intel count.

## 12. Recommended pull-request sequence

Keep changes reviewable and preserve the upstream baseline:

1. **Bootstrap/provenance:** workspace config, `UPSTREAM.md`, Codex manifest skeleton, marketplace skeleton, CI, generated capability inventory.
2. **Host contract:** `core` port, `host-codex`, response/cancellation/path contracts, minimal MCP server.
3. **Workspace authority:** roots probe, host/user-presence registration and revocation, path/control-state security suite.
4. **Build/runtime dependencies:** clean staging, exact dependency digests, launcher, artifact validation.
5. **Intel read surface:** 13 read/advisory tools and external runtime assets.
6. **Intel writes:** scaffold preview and hardened structural edit transactions.
7. **Connect control plane:** host/user-presence registry, secrets, allowlists, write grants.
8. **Connect data plane:** HTTP and database execution plus security suites.
9. **Skills/roles:** nine Codex skills and four orchestration role references.
10. **Hooks:** minimal six-event set and trust/fixture tests.
11. **Analytics adapter:** current usage/session source and compatibility fixtures.
12. **Analytics product:** seven tools, report, persistence, concurrency, privacy.
13. **Packaging/platform:** marketplace smoke, OS matrix, artifact/SBOM/size gates.
14. **Release:** installed-artifact dogfood, documentation, deferral matrix, `0.1.0`.

Each PR should update the capability matrix and include an installed-artifact test where its behavior is user-visible.

## 13. Decisions to make before implementation expands

These are genuine product/security choices, not naming details:

1. **Workspace authority:** wait for MCP roots or prove a host-mediated user-presence registration step. Recommendation: support roots when available and use a settings UI/protected broker fallback; a bare `goodvibesctl` or same-user file is insufficient unless the threat model explicitly relies on tested Codex sandbox approvals.
2. **Analytics persistence:** native SQLite/WAL versus append-only events plus a single writer. Recommendation: choose from packaging prototypes, with correctness under concurrency as the deciding gate.
3. **Analytics scope:** whether Claude history import belongs in `0.1.x`. Recommendation: defer it until Codex-native analytics is stable.
4. **Cost display:** whether to show API-equivalent estimates at all. Recommendation: token-only v1; estimates later and unmistakably labeled.
5. **Connect administration:** host settings/protected broker versus a sandbox-approval-dependent interactive CLI. Recommendation: require real user presence, keep it outside model-facing MCP, and never hide it in `service`.
6. **Dependency acquisition:** vendor all platform payloads versus explicit maintenance download. Recommendation: use reproducible explicit download keyed by platform/ABI unless vendoring remains practical; cold offline must degrade cleanly and warm offline must work fully.
7. **Source maps:** include, omit, or publish separately. Recommendation: omit from marketplace artifacts and keep debug artifacts in CI/releases.
8. **Custom agents:** whether to offer an opt-in `.codex/agents` installer later. Recommendation: ship role references first and evaluate only after real orchestration dogfood.

## 14. Known source issues that should not be copied

- Analytics is coupled to Claude transcript layouts, model names, pricing, process detection, and state directories.
- Analytics success/error responses are inconsistent with Intel/Connect and often fail to set `isError` for application failures.
- Cooperative budget wrappers do not preempt non-cooperative hangs.
- Shared config is cached per cwd, so hook/config changes can fail to affect a running server.
- Filesystem tools assume process `cwd` is the project and accept absolute or parent paths.
- Connect lets model-facing actions mutate registry, auth, allowlists, connections, and write grants.
- Connect permits arbitrary environment references and does not revalidate every redirect hop.
- Structural-edit preview tokens and consumption are raceable, writes are not fully atomic, and rollback is best-effort.
- The global sql.js analytics database has no safe cross-process writer coordination.
- The source telemetry producers and analytics consumers are disconnected, leaving several timing/cache/health claims without a reliable event source.
- Runtime dependency installation mutates/cache-links installed plugin content and is not lockfile-reproducible.
- Build copy steps can leave stale output and do not require every asset.
- The root Node requirement says 18 while builds/tests target Node 20.
- Large committed maps embed source content and inflate the artifact.
- Version/tool-count/docs claims have drifted in several files.
- Hook documentation and events mix obsolete Claude behavior; commit guarding is advisory, not a complete security boundary.

These are migration inputs and regression tests. They are not criticisms that block reuse of the well-tested analyzers, schemas, templates, reporting ideas, and workflow content.

## 15. Immediate next action

Begin only **Phase 0**: commit the provenance/capability inventory, write the threat model, scaffold the smallest valid plugin, and prove the trusted workspace-context design with one read-only MCP tool. That spike decides whether the rest of the Intel, Analytics, and Connect port can share a safe host foundation. It should happen before bulk-copying packages or generated bundles.
