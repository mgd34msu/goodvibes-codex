# Installation and operations

## Prerequisites

GoodVibes launches its MCP servers with the ambient `node` executable. Install Node.js 20.19.x or Node 22.12 and newer before installing the plugin. CI exercises Node 20.19 and Node 22; Node 22 is the preferred development line.

You also need a Codex CLI version that supports `codex plugin`, and Git for a remote marketplace install.

Confirm the prerequisites:

```bash
node --version
codex plugin --help
git --version
```

If `node` is not visible to the process that starts Codex, the MCP launchers cannot start even when an interactive shell can find it.

## Install the Git marketplace after publication

This flow becomes available after the repository has a release commit on `main`. An empty remote with no refs cannot be cloned or registered as a Git marketplace.

```bash
codex plugin marketplace add mgd34msu/goodvibes-codex --ref main --json
codex plugin add goodvibes@goodvibes --json
codex plugin list --marketplace goodvibes --json
```

The marketplace and plugin happen to share the name `goodvibes`; the selector is therefore `goodvibes@goodvibes`.

## Install a checkout

Use this flow when developing the port or testing an unpublished commit. Start from an existing checkout; clone from GitHub only after the remote has a published ref.

```bash
cd /absolute/path/to/goodvibes-codex
npm ci
npm run build
npm run validate:plugin
npm run smoke:mcp
codex plugin marketplace add "$(pwd)" --json
codex plugin add goodvibes@goodvibes --json
```

Codex installs a cached copy. Editing the checkout does not update an already running MCP process. Rebuild, reinstall, and start a new thread after a change.

## Find the plugin root

The control utility is always addressed from the plugin root:

```text
<plugin-root>/scripts/goodvibes-control.mjs
```

For a checkout, `<plugin-root>` is `<checkout>/plugins/goodvibes`. For an installed marketplace copy, save the `installedPath` printed by `codex plugin add goodvibes@goodvibes --json`. `codex plugin list --json` reports source metadata and may not expose the cache path. Quote the path on every platform because it may contain spaces.

```bash
node "<plugin-root>/scripts/goodvibes-control.mjs" --help
```

The utility is the only supported user-facing control entrypoint. It owns the `roots`, `services`, `connections`, `config`, and `deps` groups. Its top-level `--help` output is the exact command summary for the installed version; group-level `--help` is not a supported interface.

The current Codex runtime does not propagate parent path variables into bundled MCP children. Installed launchers recover `CODEX_HOME` from their cache path, and the control utility does the same when run from the saved `installedPath`. Arbitrary `GOODVIBES_DATA_ROOT` and `GOODVIBES_ANALYTICS_HOME` overrides still require a direct launch. See [state and privacy](state-and-privacy.md#environment-override-limitation).

## Register workspace roots

Intel tools do not trust an arbitrary `base_path`. Register the canonical workspace from an interactive terminal:

```bash
node "<plugin-root>/scripts/goodvibes-control.mjs" roots add /absolute/path/to/workspace
node "<plugin-root>/scripts/goodvibes-control.mjs" roots list
```

Adding or removing a root requires a TTY and an exact `yes` confirmation. Registration covers the canonical directory and paths beneath it; it does not authorize sibling repositories. Symlinks are resolved before the boundary is checked.

When a workspace no longer needs access, revoke it promptly:

```bash
node "<plugin-root>/scripts/goodvibes-control.mjs" roots remove /absolute/path/to/workspace
```

## Prepare runtime dependencies

The plugin bundles its server code and WASM assets, but some capabilities use pinned runtime packages. Dependency preparation is explicit and writes only beneath the GoodVibes data root:

```bash
node "<plugin-root>/scripts/goodvibes-control.mjs" deps status
node "<plugin-root>/scripts/goodvibes-control.mjs" deps install
```

Review the displayed destination and network operation before confirming. The installer uses the committed server lockfiles and does not write `node_modules` into the installed plugin cache. A server should still initialize and list tools when an optional dependency is absent; the affected call reports the missing dependency and maintenance action.

## Configure Connect

Connect is split into two planes:

- MCP is the data plane: `service` can inspect registrations, while `api_request` and `db_query` operate within existing policy.
- `goodvibes-control.mjs` is the control plane: it registers/removes services and connections, stores/clears credentials, changes mode, and prepares dependencies.

Start from the top-level help rather than guessing credential flags:

```bash
node "<plugin-root>/scripts/goodvibes-control.mjs" --help
```

Representative operations are `services list/add/remove/auth/clear-auth`, `connections list/add/remove`, and `config show/set-mode`. Authority changes require an interactive terminal. The MCP `service` tool cannot perform any of them.

Static bearer, Basic, and API-key credentials can be configured only for an `https://` service. Unauthenticated HTTP services may still be registered when policy permits, but GoodVibes will not attach a stored credential to plaintext transport.

Remote database registration has a deliberately narrow transport contract:

- PostgreSQL: include exactly `?sslmode=verify-full`.
- MySQL: include exactly `?ssl-mode=VERIFY_IDENTITY`.
- SQLite: use a local SQLite/file path or `:memory:`.

Other remote URL options are rejected rather than silently ignored. PostgreSQL and MySQL use the system trust store and require certificate/hostname verification.

Remain in `restricted` mode unless you have reviewed the wider destination behavior and the [security model](security-model.md). Prefer registered services and connections even when a wider mode is available.

## Review hooks

The plugin supplies six hooks: `SessionStart`, `PreToolUse` for Bash, `PreCompact`, `SubagentStart`, `SubagentStop`, and `Stop`.

Codex requires review/trust for non-managed hooks. In a Codex thread, run `/hooks`, inspect `hooks/hooks.json` and the referenced scripts, and trust them only if they match the installed version you intended. A hook change may require re-review.

Hooks are optional. Without trust, the MCP servers and skills remain discoverable; lifecycle metadata, dependency notices, subagent reminders, compaction checkpoints, and the advisory commit guard do not run.

## Verify the installation

Start a new Codex thread, then check:

1. The GoodVibes skills appear in the available skill list.
2. `goodvibes_intel`, `goodvibes_analytics`, and `goodvibes_connect` initialize.
3. Their tool counts are 15, 7, and 3.
4. `service` with `action: status` reports registrations without exposing credentials.
5. A read-only Intel request succeeds inside a registered workspace and fails for an unregistered sibling.

The source checkout also provides a protocol-level smoke test:

```bash
npm run validate:plugin
npm run smoke:mcp
```

## Update or reinstall

For a Git marketplace:

```bash
codex plugin marketplace upgrade goodvibes --json
codex plugin add goodvibes@goodvibes --json
```

For a checkout, rebuild first and run `codex plugin add goodvibes@goodvibes --json` again. Start a new Codex thread after either flow. Plugin state lives outside the cache and is not removed by a normal reinstall.

## Uninstall and revoke

Revoke authority before removing the plugin:

```bash
node "<plugin-root>/scripts/goodvibes-control.mjs" roots list
node "<plugin-root>/scripts/goodvibes-control.mjs" roots remove /absolute/path/to/workspace
node "<plugin-root>/scripts/goodvibes-control.mjs" services list
node "<plugin-root>/scripts/goodvibes-control.mjs" connections list
```

Remove sensitive service/connection registrations and credentials with the applicable control commands, then uninstall:

```bash
codex plugin remove goodvibes@goodvibes --json
codex plugin marketplace remove goodvibes --json
```

Uninstall does not delete `~/.codex/goodvibes` (or another data root reported by a directly launched control utility). This prevents accidental loss of analytics and control state. After reviewing and backing up anything you need, delete the actual reported directory yourself if you want a complete GoodVibes data purge. Codex-owned rollout files under `~/.codex/sessions` are never removed by GoodVibes.
