# GoodVibes Codex hooks

Codex discovers this directory through the plugin-default `hooks/hooks.json` path. Users must review and trust non-managed hooks before they run.

| Script               | Event                   | Behavior                                                                                                                                                     |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session-start.mjs`  | `SessionStart`          | Records bounded lifecycle metadata, reports missing runtime dependencies, and announces or reverts an ephemeral open trust mode. It never installs packages. |
| `commit-guard.mjs`   | `PreToolUse` for `Bash` | Warns once, then denies a Git command that would include a known GoodVibes credential file. Safe calls emit no stdout.                                       |
| `pre-compact.mjs`    | `PreCompact`            | Records the `manual` or `auto` trigger and writes a metadata-only checkpoint. It does not parse transcripts.                                                 |
| `subagent-start.mjs` | `SubagentStart`         | Records stable agent metadata and injects one short authority-boundary reminder.                                                                             |
| `subagent-stop.mjs`  | `SubagentStop`          | Records stable completion metadata and a digest/length of the last message. It always returns valid JSON.                                                    |
| `stop.mjs`           | `Stop`                  | Records one bounded turn-stop event. It is not a session-end signal and always returns valid JSON.                                                           |

Hook-private files live under `PLUGIN_DATA` when Codex supplies it, otherwise under the configured GoodVibes data root. No hook writes into the installed plugin cache. Hooks store stable event fields only; transcript formats are deliberately not an interface.

All scripts fail open. The commit hook is a guardrail rather than a complete shell security boundary because Codex does not intercept every possible command path.
