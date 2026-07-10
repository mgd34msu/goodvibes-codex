# Troubleshooting

Start with read-only status:

```bash
codex plugin list --json --available
node "<plugin-root>/scripts/goodvibes-control.mjs" status
node "<plugin-root>/scripts/goodvibes-control.mjs" deps status
```

For an installed marketplace copy, use the `installedPath` returned by `codex plugin add --json`; `codex plugin list --json` may report source metadata without the cache path. In a source checkout, `<plugin-root>` is `plugins/goodvibes`.

## All three MCP servers are missing

Likely causes are an unavailable Node executable, plugin installation failure, or a stale Codex thread.

1. Run `node --version` in the environment that launches Codex; it must be 20.19 or newer.
2. Confirm `codex plugin list --json` reports `goodvibes@goodvibes` as installed/enabled.
3. Check that `.mcp.json` and all three `server/<name>/launcher.cjs` files exist under the reported plugin root.
4. Reinstall with `codex plugin add goodvibes@goodvibes --json`.
5. Start a new Codex thread.

From a checkout, `npm run smoke:mcp` tests initialize and tool listing without involving the Codex UI.

## One server fails or a tool reports a missing module

The server bundles load some runtime packages lazily. Inspect and prepare the exact pinned dependencies:

```bash
node "<plugin-root>/scripts/goodvibes-control.mjs" deps status
node "<plugin-root>/scripts/goodvibes-control.mjs" deps install
```

Do not run an unlocked `npm install` in the plugin cache. The supported installer uses the committed per-server lockfiles and a writable durable dependency directory.

If preparation succeeds but the server still fails, confirm the current OS, architecture, Node version, and dependency path shown by `status`; reinstalling a cache copy does not remove durable dependencies.

## Intel says a path is outside every trusted workspace

List the registered canonical paths:

```bash
node "<plugin-root>/scripts/goodvibes-control.mjs" roots list
```

Register the actual repository root from an interactive terminal. Do not solve the error by registering your entire home directory. If the displayed path differs because of a symlink, pass the canonical registered path as `base_path`. An unregistered sibling is expected to fail.

If a previously working path was moved or replaced, remove the old registration and add the new canonical path. Restart long-lived Codex sessions after changing authority state.

## A structural edit says another apply owns the lock

Applies are serialized through `<GoodVibes data root>/locks/structural-edit.lock`. Wait for the other apply to finish and retry the same unconsumed preview token. If a process crashed, first verify that no GoodVibes apply is running, use the control utility's read-only `status` output to confirm the exact data root, and then remove only that stale lock file. GoodVibes deliberately does not auto-delete an ambiguous lock because doing so could allow two writers.

## The control utility refuses to change state

Authority changes require both stdin and stdout to be attached to an interactive terminal and require an exact `yes` confirmation. They intentionally fail in a pipe, background process, hook, CI job, or ordinary MCP tool call.

Run the command yourself in a terminal. Use top-level `--help` to confirm the installed command summary; group-level `--help` is not supported. A read-only `list`, `show`, `status`, or top-level `--help` operation should not require confirmation.

## Hooks do not run

GoodVibes tools and skills can work while hooks remain disabled. Run `/hooks` in Codex, inspect the installed `hooks/hooks.json` and scripts, then trust that version if appropriate. A plugin update that changes hook definitions may require re-review.

Check that the hook command receives `PLUGIN_ROOT` and, for durable hook data, `PLUGIN_DATA`. Hooks use the shared GoodVibes hook directory only as a fallback. Start a new thread after trust changes.

Safe/fail-open hook paths may intentionally emit no user-visible output. Inspect hook event state only when diagnostics are needed; absence of an event is not proof the associated Codex action did not occur.

## A Git command was denied

The advisory `PreToolUse` hook detects commands that would include known GoodVibes credential filenames and the legacy cookie-store filename. Remove the secret file from the Git operation and repository, then rotate any exposed credential. Do not bypass the hook merely because the file is ignored; ignored files can still be explicitly added.

The hook is not comprehensive DLP. A command that passed the hook is not proof that a commit contains no secrets.

## Connect denies a URL or redirect

Use MCP `service` with `action: status` to inspect credential-free registration names and policy. Then use the interactive control utility to correct an intended registration.

Check:

- scheme, hostname, and port match the registered service;
- the path and method are permitted;
- each redirect destination remains permitted;
- a credential is configured for that exact service;
- restricted mode is active unless wider behavior was deliberately selected.

Do not add a broad destination solely to bypass an SSRF/private-address rejection. Registered credentials are intentionally not forwarded to a different origin.

## Connect denies a database query

Confirm the connection is registered and use its name, not a bare database URL. Read queries can still be rejected when the statement classifier sees multiple statements, an unknown command, writable pragma, procedure call, or another potentially mutating form.

For a legitimate write, both the user request and the connection's explicit write grant must allow it. Prefer a database-side least-privilege account; the plugin will not convert an administrator connection into a strong read-only principal.

## Analytics is empty or partial

In the supported installed-plugin layout, Analytics reads `~/.codex/sessions`. Check that it contains rollout JSONL files. `dashboard` with `action: doctor` reports parser/storage diagnostics.

The current Codex host does not forward a parent `CODEX_HOME` override into bundled MCP children. GoodVibes launchers compensate by inferring it from an installed cache path. If Analytics scans the wrong tree, confirm that the server is running from `<codex-home>/plugins/cache/...` and that the control utility was invoked from the `installedPath` printed during installation. Checkout launches with a custom home must pass `CODEX_HOME` explicitly.

Large files and large session sets are bounded. `query`/`doctor` reports scan limits, malformed lines, unknown records, unknown-format sessions, and an unknown-record ratio rather than silently treating missing data as zero. Doctor reports `degraded` whenever that evidence means the adapter did not fully understand the scanned input. Adjust only the supported local bounds with Analytics `config` after reviewing the privacy/size effect.

If a budget or tag mutation requests `session_id`, use an ID returned by a
read-only Analytics query. The server refuses to guess a mutation target when
the host did not provide an active session ID. Query grouping/format and
status/agent filters, plus export section selection, are intentionally not part
of the `0.1.0` schema.

Analytics intentionally shows no monetary total and no prompt or tool-payload history.

## Open mode did not reset

Without `--persist`, the reviewed/trusted `SessionStart` hook attempts to reset the global control setting to restricted at the next session. If hooks are untrusted, disabled, or fail open, the setting can remain open. Never depend on a hook as the security boundary.

Return to restricted mode from an interactive terminal and verify with `config show`:

```bash
node "<plugin-root>/scripts/goodvibes-control.mjs" config set-mode restricted
```

Use open for the shortest practical period. Do not add `--persist` merely to silence a notice; it explicitly keeps the wider mode across sessions.

## Local validation fails

Run the checks independently so the first failing layer is clear:

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

`validate:plugin` checks the portable repository contract; `smoke:mcp` speaks MCP JSON-RPC to each launcher and asserts the exact 15/7/3 tool surface. Neither proves installed-plugin hook trust or a real external service/database connection.

## Updating did not change behavior

Codex uses a cached plugin copy and running MCP processes retain the old bundle. For a Git marketplace:

```bash
codex plugin marketplace upgrade goodvibes --json
codex plugin add goodvibes@goodvibes --json
```

For a checkout, rebuild and validate before reinstalling. Then start a new Codex thread. Preserve the output of `codex plugin list --json` when reporting a bug so the installed version and source path are unambiguous.

## Reporting a problem

Include:

- operating system and architecture;
- `node --version` and Codex CLI version;
- GoodVibes manifest version and marketplace source;
- affected server/tool or hook event;
- sanitized stderr/error envelope;
- whether the workspace/target was registered and the active mode;
- the smallest reproduction that contains no credential, database URL, prompt content, or private rollout data.

See [SECURITY.md](../SECURITY.md) for confidential vulnerability reports.
