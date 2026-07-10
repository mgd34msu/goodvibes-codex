---
name: goodvibes-maintenance
description: "Inspect GoodVibes Codex plugin health, diagnose missing MCP servers or assets, and guide explicit runtime-dependency preparation. Use for setup, status, installation repair, hook trust, or plugin troubleshooting requests."
---

# GoodVibes Maintenance

Treat status as read-only. Do not install packages, change plugin configuration, trust hooks, or write outside the workspace. Authority and dependency changes require the user to operate the interactive GoodVibes control utility directly; never invoke or automate it from Codex.

## Resolve the installation

The skill resides at `<plugin-root>/skills/goodvibes-maintenance/SKILL.md`; resolve the plugin root from that file location rather than from the current project directory.

## Inspect status

Check independently:

1. `.codex-plugin/plugin.json` exists and has a valid version.
2. `.mcp.json` declares `goodvibes_intel`, `goodvibes_analytics`, and `goodvibes_connect`.
3. Each server has `launcher.cjs`, `index.cjs`, `package.json`, and required WASM assets.
4. All nine skill directories contain `SKILL.md` and `agents/openai.yaml`.
5. `hooks/hooks.json` exists; report whether the host still requires hook review through `/hooks`.
6. Runtime dependency roots are present for each server and contain every dependency declared by that server's runtime manifest.

Read [references/diagnostics.md](references/diagnostics.md) for data-root resolution, expected components, and repair boundaries.

## Repair deliberately

For missing runtime dependencies, explain the target data directory, exact packages, network use, and files that will be written. Ask the user to run `goodvibes-control.mjs deps install` directly in an interactive terminal. The utility uses the committed lockfiles, stages into the durable data root, and never links or copies `node_modules` back into the installed plugin cache.

After a repair, initialize and list tools for all three MCP servers. Report partial failures per server rather than declaring the entire plugin healthy from one representative probe.
