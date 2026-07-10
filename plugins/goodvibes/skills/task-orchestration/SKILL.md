---
name: task-orchestration
description: "Decompose complex repository work into bounded Codex subagent tasks, coordinate dependencies, and apply the Write-Review-Fix-Confirm pattern. Use when independent investigation, implementation, testing, or refutation work can run in parallel or needs explicit handoffs."
---

# Task Orchestration

Use Codex's available subagent tooling as an in-band workflow. Do not create a background coordinator or shared mutable task queue.

## Define the work graph

For every delegated task, specify:

- one concrete objective and done condition;
- the role contract to follow;
- inherited workspace, permission, and mutation boundaries;
- required inputs and relevant paths;
- dependencies on other tasks;
- the exact output needed for the next handoff.

Run independent tasks in parallel. Run dependent work sequentially and pass the prior result directly. Avoid assigning two writers to overlapping files.

## Select a role

Read and include the relevant role reference in the delegated prompt:

- [architect](references/roles/architect.md) for read-only mapping and design;
- [engineer](references/roles/engineer.md) for authorized implementation;
- [tester](references/roles/tester.md) for risk-based tests and execution;
- [refutation reviewer](references/roles/refutation-reviewer.md) for read-only falsification.

The role is prompt context, not a custom model profile. Select a read-only/explorer subagent for architect and reviewer work, and a worker subagent for authorized engineer or tester writes.

## Apply WRFC when risk warrants it

1. **Write:** delegate a bounded implementation.
2. **Review:** inspect the actual current diff and grounded checks with the refutation-reviewer role.
3. **Fix:** address only confirmed critical or high defects when the user has authorized changes.
4. **Confirm:** rerun checks and review the new diff, not the pre-fix version.

Cap fix cycles at two unless the user asks otherwise. Escalate unresolved defects rather than looping indefinitely. Skip a dedicated loop for trivial, low-risk changes with no meaningful failure surface.
