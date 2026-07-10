# Intel tool catalog

Codex exposes these through the `goodvibes_intel` MCP server, normally as `mcp__goodvibes_intel__<tool>`.

| Tool | Use |
|---|---|
| `code_read` | Read outlines or exact line ranges, including batched files. |
| `code_grep` | Search patterns with count, file-only, or bounded match output. |
| `code_glob` | Discover files with ignore rules and optional metadata. |
| `code_surface` | Inspect exported symbols and module entry points. |
| `code_safe_delete` | Find references that make deleting a symbol unsafe. |
| `api_routes` | Inventory detected HTTP routes. |
| `api_spec` | Derive an OpenAPI-shaped view from detected routes. |
| `api_validate` | Compare a static API specification with detected routes. |
| `db_schema` | Extract Prisma, Drizzle, or SQL schema structure and optional usage. |
| `component_tree` | Map React composition with optional annotations. |
| `hook_dependencies` | Check React hook dependency arrays. |
| `client_boundary` | Find server/client boundary violations. |
| `layout_analysis` | Analyze layout hierarchy, sizing, overflow, and stacking. |
| `scaffold` | Preview or create a project from a bundled template. |
| `structural_edit` | Preview and apply exact or syntax-aware multi-site edits. |

## Selection rules

- Use `code_surface` before changing a public module contract.
- Use `code_safe_delete` before deleting or renaming an exported symbol.
- Use `api_routes`, then `api_spec`; add `api_validate` only when a written specification exists.
- Use bare `component_tree` first, then request only the annotations relevant to the task.
- Treat `api_validate` and every other analyzer as static analysis. Use Connect or an explicitly authorized runtime check for live behavior.
- Use native patch and shell tools for ordinary edits and execution. Reserve `structural_edit` for repeated or syntax-anchored changes that benefit from a checked preview.
