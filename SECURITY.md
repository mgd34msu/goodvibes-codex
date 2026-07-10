# Security policy

GoodVibes can access local source trees and user-registered HTTP/database targets. Read [the security model](docs/security-model.md) before enabling sensitive connections.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials, private source, rollout metadata, or an unpatched exploit. Use GitHub's private vulnerability reporting for `mgd34msu/goodvibes-codex` when available, or contact the maintainer through the address in `plugins/goodvibes/.codex-plugin/plugin.json` with a minimal, sanitized reproduction.

Include the affected GoodVibes version, Codex/Node version, operating system, boundary crossed, and whether Codex had unrestricted shell/home-directory access. Do not attach real secrets, database URLs, rollout files, or proprietary source.

## Supported versions

Until a stable release policy is published, only the newest `0.1.x` release is expected to receive security fixes. The repository default branch is development code and is not a substitute for a tagged release.

## Immediate containment

Revoke affected credentials at the remote provider first. Then clear/remove the GoodVibes service or connection, revoke unneeded roots, return to restricted mode, restart Codex, and inspect/delete sensitive GoodVibes exports or state. Uninstalling the plugin alone does not revoke credentials or erase durable data.
