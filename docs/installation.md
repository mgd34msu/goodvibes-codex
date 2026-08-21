# Installation and operations

## Prerequisites

GoodVibes launches its MCP servers with the ambient `node` executable. Install a Node.js version satisfying `^20.19.0 || >=22.12.0` before installing the plugin. Node 21 does not qualify. CI exercises Node 20.19 and Node 22; Node 22 is the preferred development line.

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

## Automatic runtime dependencies

The plugin bundles its server code and WASM assets, but some capabilities use pinned runtime packages. Each MCP launcher verifies and automatically repairs its own dependencies before loading the server bundle. Repair uses the committed lockfile, serializes concurrent starts, stages and verifies the result, and atomically promotes it beneath the GoodVibes data root. It never writes `node_modules` into the installed plugin cache.

The maintenance skill runs the same idempotent repair without asking for another confirmation. You can also inspect or invoke that path directly for diagnostics:

```bash
node "<plugin-root>/scripts/goodvibes-control.mjs" deps status
node "<plugin-root>/scripts/goodvibes-control.mjs" deps install
```

No TTY or confirmation is required for dependency repair. Launcher repair has a bounded startup budget; the direct maintenance path has a longer but still bounded budget. On an unavailable or stalled registry, incompatible binary, missing `npm`, or unwritable data root, the launcher terminates the attempt, reports the failure on stderr, and still loads the server in degraded mode so dependency-free tools remain available. Later server starts and maintenance invocations retry automatically.

## Configure Connect

Connect is split into two planes:

- MCP is the data plane: `service` can inspect registrations, while `api_request` and `db_query` operate within existing policy.
- `goodvibes-control.mjs` is the control plane: it registers/removes services and connections, stores/clears credentials, changes mode, and prepares dependencies.

Start from the top-level help rather than guessing credential flags:

```bash
node "<plugin-root>/scripts/goodvibes-control.mjs" --help
```

The installed `--help` output is authoritative. The command groups it covers are:

| Command                                              | What it does                                                       | Needs a TTY |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ----------- |
| `status`                                             | Print data root, plugin root, roots, registrations, and mode       | No          |
| `roots list\|add\|remove`                            | Register or revoke a canonical workspace                           | Add/remove  |
| `services list\|add\|remove`                         | Register or revoke an HTTP service                                 | Add/remove  |
| `services auth\|clear-auth`                          | Store or clear bearer, Basic, or API-key credentials               | Yes         |
| `services allow list\|add\|remove`                   | Manage the destination allowlist                                   | Add/remove  |
| `connections list\|add\|remove`                      | Register or revoke a database connection and its write grant       | Add/remove  |
| `config show`                                        | Print the effective configuration and data root                    | No          |
| `config set-mode restricted\|open [--persist]`       | Change trust mode                                                  | Yes         |
| `deps status\|install [intel\|analytics\|connect\|all]` | Inspect or repair pinned runtime dependencies                   | No          |

Authority changes require an interactive terminal and an explicit confirmation phrase. Setting `open` mode requires typing `open network access` rather than `yes`. The MCP `service` tool cannot perform any of these operations.

Static bearer, Basic, and API-key credentials can be configured only for an `https://` service. Unauthenticated HTTP services may still be registered when policy permits, but GoodVibes will not attach a stored credential to plaintext transport.

Remote database registration has a deliberately narrow transport contract:

- PostgreSQL: include exactly `?sslmode=verify-full`.
- MySQL: include exactly `?ssl-mode=VERIFY_IDENTITY`.
- SQLite: use a local SQLite/file path or `:memory:`.

Other remote URL options are rejected rather than silently ignored. PostgreSQL and MySQL use the system trust store and require certificate/hostname verification.

Remain in `restricted` mode unless you have reviewed the wider destination behavior and the [security model](security-model.md). Prefer registered services and connections even when a wider mode is available.

## Review hooks

The plugin supplies six hooks. Review what each one does before trusting it:

| Hook                  | What it does when trusted                                                          |
| --------------------- | ------------------------------------------------------------------------------------ |
| `SessionStart`        | Reports dependency and trust-mode state, and resets a non-persistent `open` mode   |
| `PreToolUse` for Bash | Warns or advises denial when a Git command names a known GoodVibes credential file |
| `PreCompact`          | Writes a metadata-only checkpoint before compaction, with no transcript parsing    |
| `SubagentStart`       | Records bounded metadata and returns an inherited-authority reminder               |
| `SubagentStop`        | Records subagent duration and the last message's length and digest                 |
| `Stop`                | Records bounded per-turn metadata; it is not a session-end signal                  |

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
