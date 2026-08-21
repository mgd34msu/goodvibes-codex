# Release verification

## Release artifact

The installable unit is the repository marketplace plus the runnable `plugins/goodvibes` tree. Installation does not run a build, so release commits must contain current generated server bundles and all referenced assets.

The staged `goodvibes-codex-<version>.tar.gz` contains:

```text
.agents/plugins/marketplace.json
plugins/goodvibes/
FILELIST
SHA256SUMS
```

The uploaded GitHub Actions artifact contains that tarball, its `*.tar.gz.sha256`, and separate copies of `FILELIST` and `SHA256SUMS` for inspection without extraction. The archive is a transport artifact for review/testing. Its SHA-256 manifests detect accidental changes; they are not a signature, SBOM, or independent attestation.

## Automated gates

`.github/workflows/ci.yml` runs:

- full version/type/test/lint/build/plugin-validation/MCP-smoke checks on Ubuntu with Node 20.19 and Node 22;
- build/plugin-validation/MCP-smoke checks on Ubuntu, macOS, and Windows with Node 22;
- a clean generated-bundle and artifact-manifest diff check;
- a staged plugin archive and per-file SHA-256 manifest after all jobs pass.

`.github/workflows/release-check.yml` repeats the full Node 22 suite on a version tag or manual dispatch, verifies a tag matches the plugin manifest, stages only the marketplace/plugin artifact, emits hashes and an inventory, and uploads the candidate for inspection. It does not publish a GitHub release or modify a marketplace automatically.

## Candidate checklist

1. Confirm `UPSTREAM.md` identifies the source baseline and carried Codex-specific patches.

2. Confirm the plugin/workspace/runtime versions and lockfiles are intentional.

3. Run `npm ci` from a clean checkout.

4. Run every local check in [development.md](development.md).

5. Rebuild and require clean generated-bundle and `ARTIFACTS.json` diffs.

6. Confirm `.mcp.json` declares only `goodvibes_intel`, `goodvibes_analytics`, and `goodvibes_connect`.

7. Confirm MCP tool inventories are exactly 15, 7, and 3.

8. Confirm nine skills, six supported hooks, templates, launchers, runtime locks, and required WASM files are present.

9. Scan generated bundles/artifacts for absolute developer paths, credentials, unresolved internal workspace imports, Claude-only runtime variables, and source maps.

10. Inspect the CI archive and verify `SHA256SUMS` before testing it.

11. Install the staged marketplace under an isolated custom `CODEX_HOME` and verify every launcher plus the control utility infer that home from the cached `installedPath` without inherited path variables.

12. Run an installed-plugin/new-thread handshake and a representative dependency-backed Intel, Analytics, and Connect call.

13. Test no-hook-trust and trusted-hook states; confirm tools remain understandable without hooks.

14. Register/revoke a temporary workspace and service; confirm revocation takes effect after process refresh.

15. Record any intentional deferral in [capability-matrix.md](capability-matrix.md) and the release notes.

## Manual installed-artifact test

Use an isolated temporary home and a copy of the exact staged artifact. Add the artifact root as a marketplace, install `goodvibes@goodvibes`, and start a new Codex thread. Do not test a source checkout after claiming the archive was tested.

At minimum verify:

- all three launchers automatically prepare exact locked runtime dependencies in an isolated durable data root;

- a failed offline first-start repair preserves MCP initialization, clean JSON-RPC stdout, and precise automatic-retry diagnostics;

- automatically prepared dependencies survive and pass representative dependency-backed calls on an offline restart;

- a path with spaces works;

- an unregistered sibling and symlink escape are denied;

- scaffold remains dry-run by default;

- a structural-edit token cannot be reused;

- Connect MCP cannot mutate authority;

- a redirect cannot forward credentials across origins;

- a registered read-only database rejects writes;

- Analytics ignores message/tool payload text and confines exports;

- hook trust is explicit and changed hook definitions request re-review;

- reinstall selects the new version/cachebuster.

## Platform interpretation

The cross-platform CI job proves repository installation, bundle generation, portable manifest validation, and MCP initialize/tool listing on the three hosted operating systems. It does not prove every optional native package, filesystem ACL, DNS behavior, shell hook, database driver, or real Codex app integration on every platform.

Before claiming a platform fully supported, perform the installed-artifact cases relevant to that platform, including owner-only secret storage (or documented Windows ACL), executable discovery, path separators/spaces/Unicode, automatic runtime dependency repair, and read-only installed plugin files.

## Reproducibility and provenance

Release review should compare two clean builds when toolchain or bundle changes could introduce nondeterminism. A clean Git diff after a second build is the minimum repository check. Preserve:

- Git commit and tag;
- Node/npm versions;
- root and runtime lockfile hashes;
- plugin artifact SHA-256 manifest;
- CI run URL and platform results;
- source baseline from `UPSTREAM.md`;
- known deferrals and security assumptions.

Do not describe the checksum archive as supply-chain attestation. Signing, formal SBOM generation, binary provenance attestations, and automated GitHub release publication remain separate release-engineering work unless explicitly added and verified.

## Version tags

Release tags use `v<manifest-version>`, for example `v0.1.1` for the current manifest. The release-check workflow rejects a tag whose suffix differs from `.codex-plugin/plugin.json`.

No workflow changes root, plugin, or runtime versions automatically. Version mutation remains an intentional reviewed source change.
