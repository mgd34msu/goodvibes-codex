---
name: project-onboarding
description: "Map an unfamiliar repository's stack, entry points, APIs, data model, UI composition, and public modules before planning changes. Use when beginning non-trivial work in a codebase whose architecture has not yet been verified."
---

# Project Onboarding

Build a structural map before proposing changes. Use a trusted absolute `base_path` for every GoodVibes filesystem call and fall back to native workspace tools if that boundary is unavailable.

## Map the repository

1. **Orient.** Use `code_glob` with a tight cap to identify the directory shape. Read package, workspace, build, and framework configuration plus likely entry points.
2. **Map the backend.** If present, run `api_routes`, then `api_spec`. Use `db_schema`; enable usage analysis only when call sites matter. Compare against an existing specification with `api_validate` when relevant.
3. **Map the frontend.** Run a bare `component_tree` first. Add only necessary state, boundary, event, or attribute annotations. Use `layout_analysis`, `hook_dependencies`, and `client_boundary` for focused risks.
4. **Map public contracts.** Use `code_surface` on modules the task will consume or change. Use `code_safe_delete` before proposing a removal or rename.
5. **Verify intent.** Read the implementation paths that matter. Static structure does not establish business intent, runtime behavior, or production configuration.

## Deliver the map

Report:

- verified stack and entry points;
- backend, data, frontend, and exported surfaces relevant to the task;
- important dependencies between them;
- facts versus inferences;
- unknowns that require runtime checks or user input;
- the smallest safe change boundary.

Record durable findings with `$goodvibes-memory` only when the active task authorizes workspace changes and the information would otherwise need to be rediscovered.
