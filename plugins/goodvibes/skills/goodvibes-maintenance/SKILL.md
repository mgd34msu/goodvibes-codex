---
name: goodvibes-maintenance
description: "Inspect and automatically repair GoodVibes Codex plugin health, runtime dependencies, MCP servers, and assets. Use for setup, status, installation repair, hook trust, or plugin troubleshooting requests."
---

# GoodVibes Maintenance

Invocation of this skill, whether explicit or implicit, authorizes unattended repair of GoodVibes-owned runtime dependencies beneath the durable GoodVibes data root. Do not ask for confirmation and do not stop after diagnosing a repairable dependency problem. This authorization is narrow: it does not grant or broaden workspace roots, services, credentials, network destinations, database connections, write grants, hook trust, or open mode.

Never patch an installed plugin cache or a project checkout during runtime repair. The dependency manager uses the installed plugin's committed manifests and lockfiles, stages downloads beneath the durable data root, and atomically replaces only `deps/<server>` state.

## Resolve the installation

The skill resides at `<plugin-root>/skills/goodvibes-maintenance/SKILL.md`; resolve the plugin root from that file location rather than from the current project directory.

## Repair and inspect

Resolve `<plugin-root>`, then immediately run the idempotent repair command without a TTY or confirmation:

```bash
node "<plugin-root>/scripts/goodvibes-control.mjs" deps install
```

The command verifies exact direct-dependency versions, module loadability, the packaged ripgrep binary, and the committed lockfile fingerprint. It serializes concurrent repairs per server and skips already-healthy dependency roots. If a transient repair attempt fails, capture its diagnostics, continue the structural checks below, and retry once before reporting the remaining external blocker. MCP launchers also run the same repair automatically at startup and retry on later starts.

Check independently:

1. `.codex-plugin/plugin.json` exists and has a valid version.
2. `.mcp.json` declares `goodvibes_intel`, `goodvibes_analytics`, and `goodvibes_connect`.
3. Each server has `launcher.cjs`, `index.cjs`, `package.json`, and required WASM assets.
4. All nine skill directories contain `SKILL.md` and `agents/openai.yaml`.
5. `hooks/hooks.json` exists; report whether the host still requires hook review through `/hooks`.
6. `deps status` reports every declared runtime dependency ready at its exact pinned version.

Read [references/diagnostics.md](references/diagnostics.md) for data-root resolution, expected components, and repair boundaries.

After repair, initialize and list tools for all three MCP servers. Exercise one dependency-backed Intel operation and the available Connect database-driver probes, not only dependency-free tool listing. Report partial failures per server rather than declaring the entire plugin healthy from one representative probe.

An unavailable package registry, incompatible native binary, missing `npm`, or unwritable durable data root can prevent an attempt from completing. Report that concrete external blocker and the automatic retry behavior; never replace it with instructions for the user to perform the same install manually.
