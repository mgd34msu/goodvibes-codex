---
name: intel-mastery
description: "Choose and use the GoodVibes intel MCP tools for repository-scale reading, search, static analysis, scaffolding, and structural edits. Use when code structure matters more than a simple native file read or text search."
---

# Intel Mastery

Use Intel selectively. Prefer a native file or shell operation for a small, direct task; use Intel when batching, compiler-aware analysis, or a structured result reduces ambiguity.

## Establish the boundary

1. Identify a host-authorized workspace root before calling a filesystem tool.
2. Pass its canonical absolute path as `base_path` on every request.
3. Refuse to guess from the MCP server's working directory. If no trusted root is available, use native workspace tools instead.
4. Treat every returned `resolved_path` as evidence to verify before a mutation.

## Gather efficiently

- Start unfamiliar files with `code_read` in `outline` mode, then request only the needed ranges.
- Use `code_grep` with `count_only` or `files_only` before retrieving a broad match set.
- Use `code_glob` for repository shape and metadata-aware discovery.
- Batch independent files or patterns in one call. Do not turn a known batch into a serial loop.
- Inspect `success`, `error`, `warning`, `meta.truncated`, and `meta.effective_caps`; never treat capped output as complete.

## Apply structure-aware tools

Use the narrowest analyzer that answers the question. Read [references/tools.md](references/tools.md) for the complete catalog and selection guide.

For `structural_edit`, always preview first, verify paths and the proposed diff, then apply with the returned preview token only when the task authorizes edits. For `scaffold`, start with `dry_run: true`, review every destination and follow-up command, and never overwrite an existing project implicitly.

## Report honestly

Distinguish compiler-backed findings from heuristics and unsupported frameworks. If a result is incomplete, capped, or dependent on unavailable native modules, say so and fall back to direct inspection rather than inventing certainty.
