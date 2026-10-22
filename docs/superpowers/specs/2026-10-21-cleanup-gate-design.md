# The clean-up gate: a test suite only for a reason, a repository without tails

Status: approved by the operator, 2026-10-22. Ledger: `.omelette/ledger-cleanup.md`. Operator's ruling (2026-10-21): this gate comes before 1.8.0 and before any new feature.

| Section | Answers |
|---|---|
| [Why](#why) | What the suite and the repository hold today |
| [The rule for a test](#the-rule-for-a-test) | What stays, what goes, who decides |
| [T0 — the mutant catalogue](#t0--the-mutant-catalogue) | The objective judge, a dev-only script |
| [T1 — the tester's files](#t1--the-testers-files) | 62 files, 587 tests, in packages |
| [T2 — the timing tests](#t2--the-timing-tests) | The five that fail under load |
| [T3 — the repository](#t3--the-repository) | Branches, worktrees, reports, drafts, the old backlog |
| [What does not change](#what-does-not-change) | No behaviour, no fix on the way |
| [Done when](#done-when) | The numbers that close the gate |

## Why

Read 2026-10-21: 136 test files, 1853 tests; 62 files are the tester's (`test/tester-*.test.mjs`), 587 tests, most written before the "only for a reason" rule of 1.7.1. 14 of them read README, docs or CHANGELOG and assert on prose; one asserts on source text; five fail under the parallel suite from timing alone (backlog item 2); an unknown number repeat a check another file already makes. The repository carries 17 merged branches, a prunable worktree, 81 files in `.omelette/reports`, and `backlog-1.0.md` beside the single backlog. A suite nobody trusts and a CI that needs reruns cheapen every review. The 1.7.2 release showed what the suite is for: the testers' tests killed mutants the coders' tests missed, and one test (a FIFO boot) caught a regression a fix round introduced — those earn their place; a test pinning a sentence of MEASUREMENTS does not.

## The rule for a test

A test stays when at least one holds:
1. it pins a behaviour the spec of its release promised and no other test pins (a line of the spec, not of the source);
2. it kills a mutant of the catalogue (T0) that no other test kills;
3. it pins a defect that was found and fixed (the regression guard).

A test goes when any holds, and none of the above:
- it asserts on the text of a doc, the changelog, a comment or a source file (`readFileSync` of a `.md` or `.mjs` followed by a string assertion);
- it repeats a check another test makes through the same entry point;
- its outcome depends on wall-clock timing under load (T2 decides whether to rewrite or drop);
- its assertion cannot fail (a mutant of the code it names passes it).

Who decides: a coder sorts each file, test by test, into `keep (reason 1/2/3, with the pointer)` or `drop (reason)`; the session rules on every drop whose reason is not mechanical (a doc assertion is mechanical; "repeats" needs the pointer to the twin). The test being the tester's is no protection, and no reason to drop either.

## T0 — the mutant catalogue

- `scripts/mutants.mjs` (dev-only, not in the npm package, like the eval scripts) and `scripts/mutants.json`: a hand-written catalogue of about 60 one-line mutants across `core/*.mjs`, `units/*/adapter.mjs`, `bin/omelette-fleet.mjs` and `hooks/omelette-guard.mjs` — each an `id`, a `file`, a `find` fragment that occurs once, a `replace`, and the behaviour it breaks in one line. Seeded from what the 1.7.2 testers and reviewers ran by hand (the 12 status/update mutants, the 4 env mutants, the 2 grok ones, the ones the reviews named) and extended by the coder to cover every module with at least three: a guard dropped, a comparison flipped, a constant changed, an early return removed, a scrub list emptied.
- The runner copies the repository to a scratch directory (never a worktree, never the tree under test), applies one mutant, runs `node --test test/*.test.mjs` with a time cap, records which test FILES failed, restores, next. Output: `.omelette/mutants/<date>.json` (gitignored): per mutant, the files that caught it; per test file, the mutants only it catches. Runtime budget: the suite takes about three minutes; 60 mutants is three hours — acceptable once per gate, and the runner takes `--only <ids>` and `--files <glob>` for the per-package loop.
- A mutant no file catches is a finding for the backlog (a hole in the suite), not something this gate fixes.
- Test: the runner on a two-mutant fixture catalogue against a tiny fixture suite (one caught, one not), and the report's shape.

## T1 — the tester's files

- Packages of 10–12 files, in release order (0.3.x first). One `omelette-coder-medium` per package, briefed with: the rule, the mutant report for the package's area (T0 `--files`), the file list, and the report shape `file · test title · keep/drop · reason · pointer`. The coder edits only `test/`; a kept test may be moved into a sibling file when two files cover one module, named for the module, with the release tag kept in a header comment.
- After each package: `npm test` green; the mutant runner on the package's area shows no mutant that was caught before and is not now (the catch set may not shrink); one commit per package, `test: clean-up package N — kept X, dropped Y (…)`.
- A tester-style review on one package in three (clean context): does every drop match the rule; does every keep's reason hold.
- The 14 doc-reading files and the one source-text file are the first package: mechanical, and the visible proof of the rule.

## T2 — the timing tests

The five from backlog item 2: three from 1.7.1 (`check` "worst case bounded", fake-grok cancel, mod-text-clean) and two older (`test/cli.test.mjs:619` the probe-sandbox timeout, `test/tester-0.3.5-p2-review.test.mjs:94` the deep-research cancel). Each is rewritten to a deterministic shape where the behaviour matters (a fake binary that blocks on a FIFO, a clock injected, a cancel signalled by the test rather than by elapsed time) or dropped where the behaviour is already pinned deterministically elsewhere. Their own package, after T1's first.

## T3 — the repository

- Branches: every `feat/*` and `fix/*` merged into main is deleted locally and on origin (`git branch --merged main`; 17 today). `feat/1.7.2-security` included.
- Worktrees: `git worktree prune` (the evals worktree's scratchpad is gone).
- `.omelette/reports` (81 files): kept as the archive they are — reports are evidence — but moved under `.omelette/reports/<release>/` by their name prefix; `.omelette/drafts` (empty) removed; `backlog-1.0.md` gets a one-line header "archive of decisions; the queue is backlog.md"; `map-1.2.0.md`, `map-1.3.0.md`, `spike`, `briefs`, `archive` listed with a one-line verdict each (archive or delete) for the operator before anything is deleted.
- `docs/superpowers/plans` and `specs`: every plan and spec of a shipped release stays (history); a draft spec without a decision, if any, is listed for the operator.
- `.gitignore` gains `.omelette/mutants/`.

## What does not change

No line outside `test/`, `scripts/mutants.*`, `.gitignore` and the `.omelette/` housekeeping changes. A defect in code found on the way is a line in `backlog.md`, not a fix in this branch. The guard, the allowlist, the scrub, the gates and every tool schema are untouched. Dropping a test never loosens a check: the catch set of the mutant catalogue may not shrink.

## Done when

- The numbers before and after, in the ledger and in a MEASUREMENTS line: test files, tests, mutants caught of the catalogue, the suite's wall time.
- CI green on the branch three runs in a row with no rerun (the timing tests gone or deterministic).
- The branch merged; the next release's reviews cover it like any other branch (its commits are test files, a dev script and housekeeping).
