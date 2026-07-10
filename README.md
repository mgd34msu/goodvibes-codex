# GoodVibes for Codex

GoodVibes is a Codex plugin for structure-aware code intelligence, local Codex usage analytics, and controlled access to registered HTTP services and databases. One plugin installs three independent stdio MCP servers, 25 tools, nine skills, six lifecycle hooks, and the project scaffolding templates carried forward from the Claude plugin.

This repository is the Codex-native port. It does not read Claude state, install Claude commands, or depend on Claude-specific hook and transcript formats.

## What is included

| Server                | Tools | Purpose                                                                                                                           |
| --------------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------- |
| `goodvibes_intel`     |    15 | Batched reads/search, API and database-schema analysis, React structure analysis, scaffolding, and preview-bound structural edits |
| `goodvibes_analytics` |     7 | Metadata-only Codex session summaries, reports, token budgets, exports, tags, sync, and local bounds                              |
| `goodvibes_connect`   |     3 | Read-only registry inspection plus policy-bound HTTP and database operations                                                      |

The nine skills are `intel-mastery`, `project-onboarding`, `goodvibes-memory`, `task-orchestration`, `review-scoring`, `service-integration`, `goodvibes-analytics`, `codebase-review`, and `goodvibes-maintenance`.

The complete tool and migration status is in the [capability matrix](docs/capability-matrix.md).

## Install

Prerequisites:

- Codex CLI with plugin support;
- Node.js 20.19.x or 22.12 and newer (Node 20.19 and Node 22 are the CI targets);
- Git, when installing the marketplace from GitHub.

After a release commit has been published to the remote `main` branch, install its repository marketplace:

```bash
codex plugin marketplace add mgd34msu/goodvibes-codex --ref main --json
codex plugin add goodvibes@goodvibes --json
```

For the current checkout, or any unpublished development tree:

```bash
cd /absolute/path/to/goodvibes-codex
npm ci
npm run build
npm run validate:plugin
npm run smoke:mcp
codex plugin marketplace add "$(pwd)" --json
codex plugin add goodvibes@goodvibes --json
```

The remote repository is not installable until it has at least one published ref. On PowerShell, pass the absolute checkout path instead of `$(pwd)`.

## Complete setup deliberately

GoodVibes does not infer workspace authority from the MCP process working directory. Register each workspace from a real interactive terminal, using the control utility in the plugin tree:

```bash
node <plugin-root>/scripts/goodvibes-control.mjs roots add /absolute/path/to/workspace
node <plugin-root>/scripts/goodvibes-control.mjs roots list
```

The utility displays the canonical path and requires `yes` on a TTY. `<plugin-root>` is `plugins/goodvibes` in a checkout. For a marketplace copy, save the `installedPath` printed by `codex plugin add --json`; `codex plugin list --json` reports source metadata and may not expose the cache path.

Every MCP launcher checks its pinned runtime dependencies and automatically repairs missing, stale, or corrupt packages before loading the server. Repair uses the committed per-server lockfiles and writes only beneath the durable GoodVibes data root. The same idempotent path is available for status or an immediate retry:

```bash
node <plugin-root>/scripts/goodvibes-control.mjs deps status
node <plugin-root>/scripts/goodvibes-control.mjs deps install
```

Dependency repair is unattended and does not require a TTY or confirmation. Run the utility with top-level `--help` before changing service, connection, or trust-mode state; those authority-changing operations remain interactive and unavailable through MCP.

Codex discovers the six hooks from `hooks/hooks.json`, but non-managed hooks require user review and trust. Review them with `/hooks`; GoodVibes remains usable without them. Start a new Codex thread after installation or a plugin update so server and hook discovery begins from a clean session.

See [installation and operations](docs/installation.md) for registration, updates, hook review, and uninstall/revocation.

## Security boundary

GoodVibes separates the model-facing data plane from an authority control plane:

- Intel filesystem operations require a path inside a canonical registered workspace.
- Connect's `service` MCP tool only supports `list`, `get`, and `status`. Service registration, credentials, destinations, connections, write grants, and trust mode are control-utility operations.
- Analytics reads bounded metadata and token counters from Codex rollout files. It ignores message text, reasoning content, tool arguments, and tool outputs.
- Hooks are fail-open lifecycle helpers and an advisory credential-commit guard, not a shell sandbox.
- Runtime dependency repair is automatic, lockfile-driven, and confined to the durable GoodVibes data root; it never grants access to a workspace or remote target.

The current control plane is a same-user interactive CLI and private files, not a cryptographically separate authority service. Its safety therefore depends on Codex sandboxing and approval policy preventing an agent from modifying GoodVibes control state or completing an interactive authority prompt. Read the [security model](docs/security-model.md) before registering sensitive services or databases.

## Documentation

- [Installation and operations](docs/installation.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [State and privacy](docs/state-and-privacy.md)
- [Capability and deferral matrix](docs/capability-matrix.md)
- [Migration from the Claude plugin](docs/migration-from-claude.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)
- [Release verification](docs/release.md)

## Develop

```bash
npm ci
npm run check:versions
npm run typecheck
npm test
npm run lint
npm run build
npm run validate:plugin
npm run smoke:mcp
```

`npm run build` regenerates the committed `plugins/goodvibes/server/*/index.cjs` files. Do not hand-edit generated bundles. See [development](docs/development.md) for the authored/generated boundary and marketplace reinstall flow.

## License and provenance

GoodVibes is MIT licensed. [UPSTREAM.md](UPSTREAM.md) records the Claude-plugin source baseline and the Codex-port divergence.
