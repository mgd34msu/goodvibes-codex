# Contributing

GoodVibes is a security-sensitive Codex plugin. Keep changes bounded, preserve the control/data-plane split, and update tests and capability documentation with public-surface changes.

## Before submitting a change

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

Review generated bundle changes and do not commit source maps or local `.goodvibes` state. See [development](docs/development.md) for the repository boundary, marketplace loop, and security test expectations.

## Pull requests

Explain the user-visible behavior, risk boundary, tests run, and any intentional deferral. For tool/skill/hook changes, update the corresponding inventory and [capability matrix](docs/capability-matrix.md). Avoid drive-by formatting or unrelated generated output.

Do not include credentials, real rollout data, private database URLs, or proprietary test fixtures. Report security problems through [SECURITY.md](SECURITY.md), not a public pull request.
