# Memory schemas

All files live under `.goodvibes/codex/memory/` and contain a JSON array. Use ISO `YYYY-MM-DD` dates.

## `decisions.json`

```json
[
  {
    "title": "Use tRPC for the API layer",
    "date": "2026-07-09",
    "rationale": "Preserve end-to-end types in the existing application",
    "alternatives": ["REST with OpenAPI", "GraphQL"]
  }
]
```

Required: `title`, `date`, `rationale`. Include `alternatives` when they were materially considered.

## `patterns.json`

```json
[
  {
    "name": "Repository data access",
    "date": "2026-07-09",
    "description": "Routes call repository modules instead of the database client directly",
    "files": ["src/repositories/user-repository.ts"]
  }
]
```

Required: `name`, `date`, `description`. Keep `files` repository-relative.

## `failures.json`

```json
[
  {
    "date": "2026-07-09",
    "approach": "Run the legacy migration before regenerating the lockfile",
    "reason": "The legacy manifest names removed workspaces",
    "suggestion": "Regenerate the lockfile from the current workspace graph"
  }
]
```

Required: `date`, `approach`, `reason`. Include a concrete `suggestion` when one is known.

## `preferences.json`

```json
[
  {
    "key": "test-framework",
    "value": "vitest",
    "date": "2026-07-09",
    "notes": "The repository already uses Vitest fixtures and helpers"
  }
]
```

Required: `key`, `value`, `date`. Store project conventions, not personal secrets or credentials.
