---
name: codebase-review
description: "Review an uncommitted diff or a diff against a base ref using repository checks and refutation-based findings. Use for code review, pull-request review, regression hunting, or an explicitly requested Write-Review-Fix-Confirm cycle."
---

# Codebase review

Default to a read-only review. Do not fix findings merely because this skill was invoked; apply changes only when the user explicitly requests a fix or full WRFC cycle.

## Run the review

1. Determine the target diff from the user's base ref or the uncommitted working tree.
2. Stop plainly if the diff is empty.
3. Discover the repository's configured checks instead of assuming command names. Run relevant type, lint, and test checks that fit the requested scope.
4. Review the actual diff and affected code paths using `$review-scoring`.
5. Use the refutation-reviewer role from `$task-orchestration` when an independent pass improves confidence.
6. Rank findings by severity with file, line, failure scenario, and verdict.

Read [references/workflow.md](references/workflow.md) for diff selection, grounded-check handling, authorized fix loops, and the report shape.

## Preserve review integrity

- Do not review a summary in place of the actual change.
- Do not silently truncate a large diff; state what was inspected and how omitted portions were covered.
- Do not turn a failed check into a subjective finding.
- After an authorized fix, rerun checks and review the current diff.
- Cap the fix-confirm loop at two iterations unless the user requests otherwise.
