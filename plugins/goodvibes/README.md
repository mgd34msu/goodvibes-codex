# GoodVibes for Codex

This installed plugin contains three MCP servers (Intel, Analytics, Connect),
25 tools, nine skills, six optional hooks, and scaffolding templates.

Before using filesystem tools, register the workspace directly in a terminal:

```bash
node "<plugin-root>/scripts/goodvibes-control.mjs" roots add /absolute/workspace
```

MCP launchers automatically prepare and repair their exact locked runtime
dependencies beneath the durable GoodVibes data root. Run the same script with
`--help` for dependency status and Connect service/connection administration.
Dependency repair is unattended; workspace and Connect authority changes remain
interactive and cannot be performed by MCP tools.

Review `hooks/hooks.json` through `/hooks` before trusting hooks. The plugin is
usable without them.

Full installation, security, privacy, migration, and troubleshooting guides are
maintained at <https://github.com/mgd34msu/goodvibes-codex/tree/main/docs>.

See `LICENSE`, `UPSTREAM.md`, and `THIRD_PARTY_NOTICES.md` in this directory.
