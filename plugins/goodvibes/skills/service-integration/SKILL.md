---
name: service-integration
description: "Use the GoodVibes Connect MCP server for authenticated HTTP requests and live PostgreSQL, MySQL, or SQLite queries. Use when a task needs a service or database that the user has already approved through the separate interactive control plane."
---

# Service Integration

Use Connect for registered, authenticated targets. Use normal web access for a public page or an unauthenticated one-off URL.

## Preserve the trust boundary

1. Inspect trust mode and registered targets with `mcp__goodvibes_connect__service` before making a request.
2. The MCP `service` tool is read-only: its only actions are `list`, `get`, and `status`. Never claim that it can register, remove, authenticate, allow, or grant writes.
3. Service registration, credentials, allowlists, connection definitions, and write grants belong to `goodvibes-control.mjs`, which a human must operate directly in an interactive terminal. Never invoke, script, or feed input to those authority-changing commands on the user's behalf. Locked runtime dependency repair is the narrow exception: MCP launchers and `$goodvibes-maintenance` may invoke `deps install` unattended.
4. Never echo, log, commit, or place a secret in project memory. Report credential presence as status only.
5. Keep HTTP and SQL access read-only unless the user requests a write and the target has a matching write grant.
6. Stored HTTP credentials require HTTPS. Remote PostgreSQL/MySQL connections require the verified-TLS URL forms documented in the operations reference.

## Call an approved target

- Use `mcp__goodvibes_connect__api_request` for registered HTTP services or explicitly allowlisted destinations.
- Use `mcp__goodvibes_connect__db_query` for a registered database connection.
- Batch independent reads when useful, but keep each entry independently identifiable.
- Cap response bytes and rows. Request only fields needed for the task.
- Verify the final destination after redirects and never forward registered credentials to a different origin.
- For a mutation, show the method or statement, target, and expected effect before proceeding when that effect is not already explicit in the user request.

Read [references/operations.md](references/operations.md) for the read-only status surface, request shapes, and database safeguards.

## Report safely

Return the target name, operation, trust mode, and sanitized result. Redact authorization headers, cookies, connection URLs, tokens, passwords, and sensitive response fields. Distinguish server-enforced policy from assumptions made in the prompt.
