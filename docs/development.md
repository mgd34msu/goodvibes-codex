# Development

## Repository responsibilities

| Path                               | Responsibility                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/core`                    | Shared envelopes, config/state paths, process hygiene, and workspace enforcement            |
| `packages/intel`                   | Fifteen structure-aware code tools and templates integration                                |
| `packages/analytics`               | Seven Codex rollout-metadata tools                                                          |
| `packages/connect`                 | Three policy-bound HTTP/database tools and control-plane support                            |
| `plugins/goodvibes`                | Runnable marketplace plugin tree                                                            |
| `scripts`                          | Version, manifest, build-cachebuster, and MCP smoke checks                                  |
| `.agents/plugins/marketplace.json` | Repository marketplace definition                                                           |

`UPSTREAM.md` records the Claude-plugin source point. Codex-specific security and state changes should not be overwritten during an upstream comparison.

## Environment

Use Node 20.19 or Node 22. CI runs the full quality suite on both lines on Ubuntu and repeats build/manifest/MCP smoke checks on Ubuntu, macOS, and Windows with Node 22.

```bash
npm ci
```

The root lockfile is authoritative for development. Each plugin server also has a committed runtime `package.json` and `package-lock.json` used by automatic launcher and maintenance repair.

## Checks

The complete local sequence is:

```bash
npm run check:versions
npm run typecheck
npm test
npm run lint
npm run build
npm run validate:plugin
npm run smoke:mcp
```

`npm run verify` runs the full sequence above and also verifies the generated artifact-hash manifest. The individual commands remain useful while iterating on one layer.

What each release-facing check proves:

- `check:versions`: workspace and plugin versions have not drifted.
- `typecheck`: TypeScript contracts compile in every workspace.
- `test`: package and security regressions pass under Vitest.
- `lint`: source and scripts meet repository static rules.
- `build`: all three bundles and required copied assets are regenerated.
- `validate:plugin`: manifest, marketplace, three MCP declarations/launchers, and default hook discovery meet this repository's portable contract.
- `smoke:mcp`: every launcher initializes over stdio and lists exactly 15, 7, and 3 tools.

These checks do not replace an installed-plugin/new-thread test, hook trust review, or live service/database test.

## Authored/generated boundary

Edit TypeScript under `packages`, launchers and runtime manifests under `plugins/goodvibes/server`, and the authored skills/hooks/templates/control files. Do not hand-edit:

```text
plugins/goodvibes/server/intel/index.cjs
plugins/goodvibes/server/analytics/index.cjs
plugins/goodvibes/server/connect/index.cjs
```

Builds omit source maps by default. Set `GOODVIBES_SOURCEMAP=1` only for a local debugging artifact; do not commit maps into the marketplace tree.

After a build, review `git diff -- plugins/goodvibes/server plugins/goodvibes/ARTIFACTS.json` and confirm only expected generated changes/assets occurred. CI rebuilds and checks that both the committed output and its artifact manifest are current.

## Local marketplace loop

```bash
npm run build
npm run validate:plugin
npm run smoke:mcp
codex plugin marketplace add "$(pwd)" --json
codex plugin add goodvibes@goodvibes --json
```

When the marketplace is already registered, reinstall with the final command. Start a new Codex thread so the cached plugin and MCP processes are refreshed.

Before testing an interactive capability:

```bash
node plugins/goodvibes/scripts/goodvibes-control.mjs roots add "$(pwd)"
node plugins/goodvibes/scripts/goodvibes-control.mjs deps status
```

Authority-changing control commands deliberately require a TTY and must not be automated in ordinary tests. Tests should set isolated temporary homes/state overrides and never mutate the developer's real `${CODEX_HOME}`.

## Version and cachebuster

`.codex-plugin/plugin.json` is the plugin version source. A release version must also match the root, workspace, and per-server package manifests checked by `npm run check:versions`.

For a release candidate:

1. choose the release version and update every versioned manifest together;
2. run `npm run check:versions`;
3. build once from clean dependencies;
4. validate and smoke the resulting plugin tree;
5. reinstall that exact tree and test a new Codex thread.

`node scripts/update-plugin-cachebuster.mjs` is a development-only convenience. It replaces only the plugin manifest version with a timestamped `+codex.local-...` version so Codex selects a changed local copy. Run it before the matching local build/reinstall, expect `check:versions` to report the intentional mismatch, and restore the real aligned version before committing or creating a release candidate. The script has no read-only/help mode.

Do not publish two materially different plugin trees with one version or publish a local cachebuster version.

## Adding or changing a tool

Keep one canonical tool schema and handler boundary. Update:

- its package tests and adversarial fixtures;
- MCP annotations;
- `scripts/smoke-mcp.mjs` expected inventory when the public surface changes;
- skill references that call it;
- the capability matrix and README counts;
- the release notes for any compatibility/security change.

Never add an MCP action that can grant itself a root, destination, credential, connection, wider mode, or write permission. Authority belongs in the interactive control entrypoint.

## Adding or changing a skill

Every skill needs a complete `SKILL.md` frontmatter/body and `agents/openai.yaml`. Declare only real MCP dependencies and keep examples aligned with the current server key/tool names. Validate relative reference links and avoid active Claude-only instructions outside the migration document.

## Adding or changing a hook

Use only Codex-supported hook events and exact output shapes. Hook scripts must:

- read one JSON object from stdin;
- reserve stdout for the hook response;
- send diagnostics to stderr;
- bound copied fields;
- avoid raw transcript parsing;
- write only to `PLUGIN_DATA` or the documented fallback;
- fail open unless the exact supported permission-deny response is intended.

Changing hook definitions can trigger user re-review, so call it out in release notes.

## Security tests

Changes to path, Connect, structural-edit, scaffold, secrets, or analytics parsing need adversarial coverage proportionate to the risk. Important cases include traversal and symlink escapes, sibling-prefix paths, preview replay/races, SSRF/private IPs and redirect pivots, cross-origin credential forwarding, stacked/ambiguous SQL, write grants, corrupt/oversized rollouts, concurrency, and secret redaction.

Do not use production credentials or real private rollout files in tests.

## Documentation discipline

The tool, skill, and hook counts stated in the documentation are enforced, not descriptive. `scripts/smoke-mcp.mjs` fails the build when a server advertises a tool set other than the exact 15, 7, and 3 names it pins. If a surface changes, update that inventory and the [capability matrix](capability-matrix.md) in the same change, so a count can never drift from the shipped servers without a failing gate.

Record deferred behavior explicitly rather than implying Claude parity the Codex host cannot safely provide.
