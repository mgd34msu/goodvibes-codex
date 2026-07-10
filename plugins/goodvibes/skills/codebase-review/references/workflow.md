# Codebase-review workflow

## Select the diff

For uncommitted work, inspect both staged and unstaged changes plus untracked files relevant to the task. For a base ref, verify that the ref resolves before comparing the merge-base range. Capture the diff stat and the complete patch or inspect every file in bounded chunks.

If no changes exist, report the target and stop without spawning reviewers.

## Run grounded checks

Read the repository's package scripts, task files, CI configuration, or language tooling. Run only checks that exist and are relevant. Record the exact command, exit status, and concise output. Do not install dependencies or rewrite configuration merely to make a check available during a review.

## Refute the change

Test each claimed behavior against concrete inputs and affected call paths. Include security, permissions, error handling, concurrency, compatibility, data integrity, and missing-test risks where relevant. Use `CONFIRMED` only for reproduced or definitive traces.

## Fix only with authority

If the user requested fixes, hand confirmed critical or high findings to an engineer role with the smallest necessary scope. Preserve unrelated changes. Repeat grounded checks and refutation against the new diff. Stop and escalate after two unsuccessful cycles.

## Report

```text
Review target
Grounded checks and exact results
Findings, most severe first
Authorized fixes and re-review results
Outstanding risks and inspection limits
```
