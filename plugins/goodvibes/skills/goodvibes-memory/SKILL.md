---
name: goodvibes-memory
description: "Read or record durable repository decisions, patterns, failures, and preferences under .goodvibes/codex/memory. Use when prior project context may affect a task or when a completed change produced knowledge worth preserving across sessions."
---

# GoodVibes memory

Treat `.goodvibes/codex/memory/` as curated project knowledge, not a transcript, task queue, or same-session message bus.

## Read before acting

1. Check only the memory categories relevant to the task.
2. Verify entries against current code when they may have drifted.
3. Treat explicit user instructions and current repository evidence as higher authority than memory.
4. Explain when a decision is based on a potentially stale entry.

## Record selectively

Write an entry only when the task authorizes project changes and the fact is likely to prevent future rediscovery. Good candidates are an architectural choice with alternatives, a reusable repository pattern, a failed approach with a durable cause, or a project-specific preference.

Before updating a file, parse its existing JSON array, preserve unknown fields, append one valid entry, and write atomically. Do not overwrite malformed data; report it for repair. Avoid duplicate entries and prune or supersede stale records deliberately rather than silently rewriting history.

Read [references/schemas.md](references/schemas.md) for file names, required fields, and examples.
