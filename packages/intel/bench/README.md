# intel measurement harness (EXP suite)

Ported from `docs/deep-review-2026-07-01.md` Appendix A (token-cost measurements
that grounded the "keep code_read outline / code_grep" call in
`docs/goodvibes-plan.md`), scoped to the operations v2 actually kept:
`code_read`'s `outline` extract (EXP3) and `code_grep` search (EXP4). The
retired `content`/`symbols`/`ast` extract modes (EXP1, EXP2, EXP5–7) do not
port — there is nothing left in v2 to measure them against.

Gate 5 (plan §5.3, §6 lane 8): intel must beat native on these kept
operations at defaults, or the README's token-savings claim comes off. This
harness is **runnable, not CI-wired**. Re-run it when search, outline, grammar,
or response-envelope behavior changes. The release inventory contains all 15
Intel tools and the required tree-sitter grammars.

## Prerequisites

```sh
node packages/intel/build.mjs   # produces plugins/goodvibes/server/intel/index.cjs
```

`measure-grep.mjs` also needs `git` on PATH (used as the native baseline —
`git grep -n`). Both scripts need the ripgrep binary the server resolves
(`@vscode/ripgrep` once installed, or a system `rg` on PATH meanwhile — see
`src/lib/ripgrep.ts`).

## Run

```sh
node packages/intel/bench/run-all.mjs

# or individually, with custom targets:
node packages/intel/bench/measure-outline.mjs packages/intel/src/tools/code_grep.ts
node packages/intel/bench/measure-grep.mjs 'export function' packages/intel/src
```

Each script exits `0` on PASS, `1` on FAIL, and `measure-outline.mjs` exits
`2` when outline extraction itself errors, which indicates an environment or
asset failure rather than a measurement result.

## Method

Token counts use the same `bytes / 3.5` estimate as
`@goodvibes/core/envelope`, applied uniformly to both the native baseline and
the intel tool's response so the comparison is apples-to-apples (this is also
exactly what `docs/deep-review-2026-07-01.md` Appendix A did).
