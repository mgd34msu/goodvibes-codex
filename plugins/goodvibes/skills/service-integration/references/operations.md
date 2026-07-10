# Connect operations

## Tools

| Tool | Purpose |
|---|---|
| `mcp__goodvibes_connect__service` | Inspect service and connection registrations; strictly read-only. |
| `mcp__goodvibes_connect__api_request` | Execute bounded HTTP calls against approved destinations. |
| `mcp__goodvibes_connect__db_query` | Execute bounded SQL against registered connections. |

## Control-plane separation

The MCP `service` actions are exactly `list`, `status`, and `get`. No MCP action may change authority.

The separate plugin script `scripts/goodvibes-control.mjs` manages trusted roots, services, credentials, allowlisted origins, database connections, write grants, mode, and prepared dependencies. It requires an interactive terminal and explicit confirmation. Codex must not execute or automate it. If setup is missing, explain the required user-operated command and stop the affected operation.

After the user says they completed a control change, call `service` with `status` and report only target names, mode, allowlist, and write-grant status. Never request or reveal credential values.

## HTTP safeguards

- Prefer a registered `service` plus relative `path` over a free-form URL.
- Require protocol, host, and port to match before attaching a registered credential.
- Revalidate every redirect hop against the destination policy.
- Per-request credentials and credential-like headers are rejected; use only a named service's stored credential.
- Stored credentials require HTTPS and remain bound to the registered service origin and auth type.
- Cloud metadata and all link-local destinations are always denied, including with a private-network grant.
- Treat methods other than `GET`, `HEAD`, and `OPTIONS` as writes.

## Database safeguards

- A registered connection name is mandatory; bare connection URLs are rejected in every mode.
- PostgreSQL connections require verified TLS with the sole URL option `sslmode=verify-full`; MySQL requires `ssl-mode=VERIFY_IDENTITY`.
- Keep `write` false for reads.
- Multiple, stacked, and unknown statement classes are rejected even when a write grant exists.
- Bound time, rows, and bytes independently.
- Do not assume a query is read-only from its first word alone; account for comments, CTEs, engine commands, and writable pragmas.
- Use server-side read-only roles or transactions where the database supports them.
