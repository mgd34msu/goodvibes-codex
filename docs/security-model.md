# Security model

## Scope and assumptions

GoodVibes handles three sensitive classes of capability: reading/writing local workspaces, sending authenticated network requests, and querying databases. It uses server-side path and target policy in addition to Codex approvals and MCP tool annotations.

The most important limitation is explicit: the current authority control plane is a same-user CLI plus owner-private files. It is not cryptographically or OS-principal separated from Codex. The design assumes Codex sandboxing and approval policy prevent an agent from writing GoodVibes authority files directly or completing an interactive authority-changing prompt. Automatic dependency repair uses the same executable but cannot grant roots, destinations, credentials, connections, writes, or wider trust mode.

If Codex is allowed unrestricted writes to `${CODEX_HOME}` or `${GOODVIBES_DATA_ROOT}`, or unrestricted interactive shell execution, an agent may be able to alter the same files the control utility protects. In that environment, do not treat GoodVibes root, service, connection, or write-grant registration as a strong security boundary. Use a restricted sandbox, require approval for shell/network/write operations, and do not register secrets whose compromise would be unacceptable.

The model does not claim protection against a compromised user account, malicious same-user process, hostile Node runtime, or a user who approves a misleading authority change.

## Trust boundaries

| Boundary              | Enforced behavior                                                                                 | Residual risk                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Codex to MCP          | Strict schemas, output caps, path/target checks, read/write policy                                | Tool annotations and prompts do not themselves authorize anything                                   |
| MCP to workspace      | Canonical registered roots, sibling/traversal rejection, symlink checks                           | Same-user authority file can be modified if host sandbox permits it                                 |
| MCP to HTTP           | Registered/allowed destinations, redirect revalidation, origin-bound credentials, response limits | Approved services can return hostile content; DNS/network infrastructure remains external           |
| MCP to database       | Registered connection handles, statement classification, limits, explicit write grant             | SQL classification is defense in depth; database roles should enforce least privilege               |
| Hook process          | User-reviewed definitions, bounded inputs, fail-open output                                       | Hooks are not a shell sandbox and do not intercept every command path                               |
| Analytics to rollouts | Read-only bounded scan, metadata extraction only                                                  | Codex rollout metadata can still reveal project names, timestamps, model use, and activity patterns |

## Automatic runtime dependency repair

Every MCP launcher and the maintenance skill may run locked dependency repair without an interactive prompt. This is intentionally not an authority grant: the repair path accepts only the known server names, reads committed runtime manifests and lockfiles, and writes only to `<GoodVibes data root>/deps`. It never changes the installed plugin cache, a project checkout, trusted roots, Connect policy, or credentials.

Repair may contact the configured npm registry and execute lifecycle behavior required by the exact locked packages, including native-platform package selection. npm cache and log paths are overridden into the durable dependency root. Per-server interprocess locks prevent concurrent promotion races.

New content is installed in a private staging directory:

- its declared versions and loadability are verified;
- required executables are probed;
- the prior healthy target is retained until atomic promotion succeeds.

Launcher and maintenance attempts have bounded deadlines and terminate spawned npm work on timeout. Treat the npm registry, lockfile contents, Node/npm executable, and same-user durable data root as part of this supply-chain boundary.

Offline or incompatible first start cannot guarantee successful repair. The launcher reports the failure on stderr, preserves dependency-free MCP capabilities, and retries on later starts; it never weakens workspace or Connect policy to compensate.

## Workspace registration

`goodvibes-control.mjs roots add` resolves and displays the canonical directory, requires an interactive terminal, and requires the user to type `yes`. The registry is stored outside the workspace with owner-only permissions where POSIX modes are available.

Intel tools:

- reject paths outside all registered roots;
- distinguish `/repo` from a sibling such as `/repo-secrets`;
- canonicalize existing paths and the nearest existing ancestor for new paths;
- reject symlink escapes;
- do not use the MCP launch directory as authority;
- require mutation paths to remain in the selected root at execution time.

Register the narrowest practical root. Do not register a home directory merely to avoid adding individual repositories. Revoke a root as soon as it is no longer needed.

## Filesystem mutations

`scaffold` defaults to a dry run. File creation, package installation, and Git initialization are separate explicit choices. Review the planned destinations and commands before execution.

`structural_edit` requires preview before apply. Preview records use random single-use identifiers and bind the edit set to original file hashes.

Apply:

- claims the preview atomically;
- serializes applies that share a GoodVibes data root;
- checks each hash at preflight and again immediately before replacement;
- uses synced same-directory temporary writes.

Atomic mode rejects a failed preflight before writing and attempts to restore completed writes after an ordinary mid-batch error, reporting any failed restoration.

No portable filesystem primitive makes a multi-file batch crash-atomic or provides a cross-process compare-and-swap against an unrelated editor in the final check/rename interval, so these controls do not replace source control. Commit or otherwise back up important work before a broad edit.

## Connect control and data planes

The MCP `service` tool is read-only. It can list registrations, return a credential-free service summary, and report status. It cannot add/remove a target, store/clear auth, change URL patterns or allowlists, register a connection, grant writes, or change trust mode.

Those changes go through the single interactive control utility. Run its top-level `--help` for the installed command summary, then verify the exact target, origin, credential type, and write grant before confirming.

### HTTP

Prefer a registered service name plus relative path.

Credentials are loaded from private state and never returned by `service`. A credential is bound to the service's exact origin and declared auth type, and static credentials are never attached over plaintext HTTP.

Connect validates the URL policy before a call and after each redirect; a registered credential must not cross to a different origin. Requests and responses are bounded, and errors are redacted.

Cloud metadata and link-local destinations remain forbidden even when a service has a private-network grant.

Treat non-`GET`/`HEAD`/`OPTIONS` methods as mutations. A write request needs both an explicit task and the registered policy that permits that method. External responses are untrusted data even when the service itself is trusted.

### Databases

Use named registered connections only.

PostgreSQL URLs must use the sole query parameter `sslmode=verify-full`; MySQL URLs must use the sole query parameter `ssl-mode=VERIFY_IDENTITY`. Both drivers enforce certificate and hostname verification, while SQLite remains local.

Keep `allow_writes` false and use a database account with server-side read-only rights for inspection. Query parsing rejects unknown or dangerous statement classes, stacked statements, writable pragmas, and writes without a grant.

Row, byte, statement, and time limits remain necessary even for read-only queries.

Server-side database roles and transactions are the final authority. Do not give a read workflow an administrator connection merely because the MCP layer also checks SQL.

### Secrets

Secrets live outside repositories in `goodvibes.secrets.json`, with owner-only POSIX permissions and symlink checks. Atomic replacement avoids partially written files. The MCP server does not resolve arbitrary inherited environment-variable references; enter credentials through the control utility. Version `0.1.x` supports bearer, Basic, and API-key credentials only. It has no automatic OAuth refresh, browser login, session login, per-request credential, or persistent cookie network path.

Never commit the GoodVibes data root, print a credential in a prompt, or copy secret files into project memory. The Bash pre-tool hook recognizes current GoodVibes secret filenames and the legacy cookie-store filename, but it is only an advisory Git guard and is not comprehensive data-loss prevention.

## Restricted and open modes

`restricted` is the default and recommended mode. An `open` mode widens destination behavior and should be treated as temporary. Only the interactive control plane may set the effective global mode.

Without `--persist`, a reviewed/trusted `SessionStart` hook attempts to atomically reset the same global control file that Connect reads, before the new session uses tools. A persistent open mode is re-announced instead. Hooks are optional and fail open, so this is cleanup rather than an authorization boundary: always run `config set-mode restricted` yourself when the wider operation is complete and verify with `config show`.

## Analytics privacy

Analytics reads local Codex rollouts but extracts metadata only. It does not retain prompt/response text, reasoning, tool arguments, tool outputs, or calculate subscription/API charges. Exports and reports are confined to the analytics data directory.

Metadata is still sensitive. It can expose repository paths, session timing, model/CLI versions, token totals, tool counts, and agent relationships. Keep the GoodVibes data root private and delete reports/exports when they are no longer needed.

## Hooks

Review hook source before trusting it and re-review after a definition change. All six hooks are designed to fail open so an instrumentation problem does not block Codex. Consequently:

- the commit guard is advisory;
- dependency repair notices are informational; launchers own the actual repair path;
- lifecycle events may be missing;
- subagent reminders do not grant authority;
- no hook should be treated as an enforcement boundary.

## Incident response and revocation

If authority or credentials may be compromised:

1. Revoke the affected remote token or database credential at its source.
2. Use the control utility to clear the stored auth and remove the service/connection.
3. Remove unneeded trusted roots.
4. Set mode to restricted and inspect `${GOODVIBES_DATA_ROOT}` or `${CODEX_HOME}/goodvibes`.
5. Remove generated exports/reports containing sensitive metadata.
6. Restart Codex so long-lived MCP processes release old in-memory state.

Removing the plugin alone does not revoke remote credentials and intentionally does not delete durable state.
