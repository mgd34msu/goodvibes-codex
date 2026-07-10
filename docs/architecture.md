# Architecture

## Product shape

GoodVibes is one Codex plugin with three independent stdio MCP servers:

```text
Codex
  |-- skills (nine workflow packages)
  |-- hooks (six optional lifecycle events)
  |-- goodvibes_intel ----- 15 tools ---- trusted workspace files
  |-- goodvibes_analytics -- 7 tools ----- Codex rollout metadata + local state
  `-- goodvibes_connect ---- 3 tools ----- registered HTTP and DB targets
                    |
                    `-- read-only authority snapshot

interactive terminal
  `-- scripts/goodvibes-control.mjs
        |-- roots
        |-- services and credentials
        |-- connections and write grants
        |-- trust mode
        `-- pinned runtime dependencies
```

Each server can initialize, list tools, and fail independently. Intel failure does not prevent Analytics or Connect from starting.

## Plugin layout

```text
plugins/goodvibes/
  .codex-plugin/plugin.json       plugin metadata
  .mcp.json                       three stdio server declarations
  hooks/                          authored Codex hook definitions/scripts
  scripts/goodvibes-control.mjs   interactive control-plane entrypoint
  skills/                         nine skill packages and references
  templates/                      scaffold templates
  server/
    intel/
    analytics/
    connect/
```

The manifest points Codex to `.mcp.json` and the skills directory. Codex discovers `hooks/hooks.json` by the plugin-default path.

Each MCP declaration starts `node server/<name>/launcher.cjs` with the installed plugin root as its working directory. A launcher resolves:

1. the immutable installed plugin root;
2. the writable GoodVibes data root;
3. server-local dependencies for a development tree;
4. durable dependencies under `<data-root>/deps/<server>/node_modules`;
5. the generated `index.cjs` bundle.

MCP stdout is reserved for JSON-RPC. Diagnostics belong on stderr.

## Authored and generated files

Authored plugin inputs include the manifest, MCP declaration, launchers, runtime package manifests/lockfiles, skills, hooks, control utility, and templates. The TypeScript workspaces under `packages/` are the implementation source.

Generated release inputs are the `plugins/goodvibes/server/*/index.cjs` bundles and copied runtime assets such as WASM grammars. They are committed because installing a repository marketplace does not run this repository's build.

The release check rebuilds those outputs and fails when they differ from the committed plugin tree. Source maps are disabled unless `GOODVIBES_SOURCEMAP=1` is set deliberately.

## Workspace authority

The MCP runtime currently launches bundled servers in the installed plugin tree and does not provide useful MCP roots. The server working directory is therefore not a project boundary.

The control utility canonicalizes an explicitly registered root and stores it outside the project. Intel resolves each supplied path against the registered set, rejects unregistered roots and siblings, resolves symlinks, and rechecks mutation destinations. Relative paths are interpreted only after a trusted root is selected.

This registry is a fallback authority mechanism, not an identity service. Its threat-model limitation is described in [security-model.md](security-model.md).

## Intel

Intel carries the existing structure-aware readers and analyzers behind a Codex-specific workspace boundary. Read/search operations share output caps and response envelopes. Write-like operations have additional rules:

- `scaffold` is plan-only by default; package installation and `git init` require explicit execution flags.
- `structural_edit` previews before apply, binds a random single-use token to the proposed edits, checks original hashes, serializes applies through shared state, consumes the token atomically, and writes through synced same-directory temporary files. Multi-file rollback handles ordinary write failures but is explicitly not an OS-crash transaction.

Tool annotations describe read-only, destructive, idempotent, and open-world behavior to Codex. They are UX metadata, not authorization.

## Analytics

Analytics is a Codex-native adapter rather than a Claude transcript compatibility layer. In the supported installed layout, it scans bounded JSONL rollouts beneath `~/.codex/sessions`, retaining only session identifiers, timestamps, canonical project metadata, model/CLI identifiers, token counters, tool names/counts, and parent/subagent relationships needed by its summaries.

Message text, reasoning, tool arguments, and tool outputs are ignored. Local budgets, tags, limits, sanitized indexes, reports, and exports live beneath the Codex home’s `goodvibes/analytics` directory. State updates are lock-protected and use same-directory atomic replacement. Budget/tag mutations require an exact session ID unless the host supplies one, and export parents are checked against symlink escape before writing. Installed launchers infer the Codex home from their cache path because the host does not propagate path overrides; see [state and privacy](state-and-privacy.md#environment-override-limitation).

## Connect

Connect keeps authority decisions out of model-facing MCP calls:

| Plane         | Entry point                                   | Responsibility                                                                                          |
| ------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Control       | `goodvibes-control.mjs` in an interactive TTY | Register/revoke roots, services, credentials, connections, destinations, modes, and dependency installs |
| Inspection    | MCP `service`                                 | `list`, `get`, and `status` only; credential-free summaries                                             |
| HTTP data     | MCP `api_request`                             | Bounded calls within the current service/destination policy                                             |
| Database data | MCP `db_query`                                | Bounded statements against registered connections and write grants                                      |

The data plane reads an authority snapshot from private GoodVibes state. It cannot add, broaden, or repair its own authority. Registered credentials are attached only to the matching service origin; redirect destinations are revalidated and credentials are not forwarded across origins.

## Skills and role references

The nine skills translate Claude commands and workflows into Codex skill packages. Their `agents/openai.yaml` files declare display metadata and MCP dependencies. Four orchestration roles are references used by `task-orchestration`; the plugin does not silently install global or project custom-agent TOML.

## Hooks

The six hook scripts record bounded lifecycle metadata or provide small context/guardrail responses. Hook state prefers `PLUGIN_DATA` because it is hook-private. When unavailable it falls back to `<GoodVibes data root>/hooks`.

Hooks do not install dependencies, mutate the plugin cache, parse raw transcript formats, or treat `Stop` as a session-end event. All hooks fail open; see [state-and-privacy.md](state-and-privacy.md) for the exact metadata retained.
