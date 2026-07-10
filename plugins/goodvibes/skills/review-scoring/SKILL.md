---
name: review-scoring
description: "Review a code change by trying to falsify its correctness claims and reporting concrete, severity-ranked defects. Use for pull requests, diffs, implementation reviews, merge-readiness checks, or re-review after a fix."
---

# Review Scoring

Produce a defect list, not a scalar score. Remain read-only unless the user separately asks for fixes.

## Review method

1. Read the actual current diff and affected code paths.
2. Run grounded checks available in the repository before relying on opinion.
3. List the behavioral, security, compatibility, or test claims the change makes.
4. Try to falsify each claim with a concrete input, state, race, permission boundary, or integration path.
5. Report only actionable defects with a failure scenario.

For each finding include:

- exact file and line;
- claim being tested;
- concrete failure scenario;
- severity: `critical`, `high`, `medium`, or `low`;
- verdict: `CONFIRMED` when reproduced or definitively traced, otherwise `PLAUSIBLE`.

Rank findings by severity. A test or typecheck failure is grounded evidence, not an opinion to rephrase. Do not inflate style preferences into correctness defects.

## Gate and re-review

Treat unaddressed `CONFIRMED` critical or high defects as blocking. Surface lower-severity and plausible findings for judgment rather than hiding them. After a fix, review the new diff and rerun relevant checks; never approve the older version by accident.

If no defects survive an honest attempt, say `No defects found` and list what was tested or traced.
