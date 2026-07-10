# GoodVibes diagnostics

## Expected plugin components

```text
.codex-plugin/plugin.json
.mcp.json
skills/<nine skill names>/SKILL.md
hooks/hooks.json
server/{intel,analytics,connect}/{launcher.cjs,index.cjs,package.json,package-lock.json}
```

Intel additionally ships parser and grammar WASM files. Analytics is fully bundled and dependency-free. Connect ships the SQL.js WASM asset; its locked runtime dependencies add SQL.js plus optional PostgreSQL and MySQL drivers.

## Writable data root

Resolve durable data in this order:

1. `GOODVIBES_DATA_ROOT` when explicitly configured;
2. `$CODEX_HOME/goodvibes` when `CODEX_HOME` is set;
3. the platform-equivalent of `~/.codex/goodvibes`.

Runtime dependencies live under `deps/<server>/node_modules` in that root. Hook-only `PLUGIN_DATA` is not proof that MCP server processes use the same directory.

## Health states

- **Ready:** bundle and required assets exist, all declared runtime dependencies resolve, and MCP initialize plus tool listing succeeds.
- **Degraded:** the server initializes but a declared native capability is unavailable.
- **Broken:** launcher or bundle is missing, initialize fails, or the tool registry cannot be listed.
- **Hooks pending review:** plugin tools may work, but non-managed hooks remain disabled until the user reviews them with `/hooks`.

## Repair boundaries

- Require Node.js 20.19.x or Node 22.12 and newer.
- Use committed runtime manifests and lockfiles; do not install floating dependency ranges.
- Keep installation logs and result metadata in the writable data root.
- Do not mutate the plugin cache or project source during dependency repair.
- Codex must not invoke the interactive control utility or bypass it with a direct package-manager command; the user performs repair from a terminal.
- Do not run cleanup or process-kill commands as part of a status request.
- Reinstall or update the plugin through the configured marketplace rather than a plugin-owned updater.
