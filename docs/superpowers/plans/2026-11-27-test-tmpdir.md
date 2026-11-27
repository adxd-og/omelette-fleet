# The test suite stops leaving directories in the OS temp directory: Implementation Plan

> **For agentic workers:** steps use `- [ ]`. **The coder and the tester never commit**: each task's last step names the commit subject, and the session commits after the tester and the review. Tasks run in the order below. A task's `bucket` names the coder: `medium` → `omelette-coder-medium`, `default` → `omelette-coder`; `session` is the orchestrating session's own. T1–T3 go to one `omelette-coder` in one run (three small tasks, T3 reads T1's file name).

| Question | Where |
|---|---|
| What is built, in one paragraph | [Goal](#goal) |
| How the pieces fit | [Architecture](#architecture) |
| The spec's values no task may move | [Global constraints](#global-constraints) |
| What the session measured, and with what | [Measured](#measured) |
| What no task's tests would cover unasked, and which task owns the test | [Review focus](#review-focus) |
| The tasks | [T1](#t1--the-preload) · [T2](#t2--the-sweep) · [T3](#t3--the-mutation-script) · [T4](#t4--docs-the-session) |
| Tester, reviews, acceptance, merge | [Gate (the session)](#gate-the-session) |
| Coverage and what is left open | [Self-Review](#self-review) |

## Goal

After a full `npm test` the OS temp directory holds no test scratch it did not hold before. A module loaded into every test process removes what that process created with `mkdtemp`; a sweep by age, run before the suite, takes what a bare `node --test` or a killed process left; the mutation script loads the same module.

## Architecture

`test/tmp-preload.mjs` is loaded by `node --import` (the `test` and `test:file` scripts, and `scripts/mutants.mjs`): it wraps the three `mkdtemp` forms of `node:fs`, records each directory created directly under the OS temp directory, and removes the recorded ones on `exit`. `scripts/tmp-sweep.mjs` exports `sweep()` and, run as a script by `pretest`, applies it to the OS temp directory. Neither is shipped: `test/` and `scripts/` are outside `package.json`'s `files`.

**Tech stack:** Node ≥ 20, zero dependencies, ESM `.mjs`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-27-test-tmpdir-design.md` at `32d24ac` (approved 2026-11-27). Branch `feat/test-tmpdir`, ledger `.omelette/ledger-test-tmpdir.md`, BASE `32d24ac`.

**Read to write this:** the spec; `package.json`; `scripts/mutants.mjs:570-600` and `:676-722`; `test/mutants-isolation.test.mjs:128-140`; `CONTRIBUTING.md`; the spike `.omelette/spike/tmp-clean.mjs`.

## Global constraints

From the spec, verbatim where it fixes a value:

- The 178 test files: not edited. `TMPDIR`: not changed. Nothing under `bin`, `core`, `units`, `hooks`.
- The preload records a created directory only when its parent is the OS temp directory (both resolved), and removes only what this very process created — no name pattern, no age.
- The sweep removes an entry only when all four hold: its name is `omelette-`, anything, a dash, and six characters of `mkdtemp`'s alphabet; `lstat` says a directory; it belongs to this user; its modification time is more than 24 hours old. A link is never followed and never removed.
- The sweep stops after 5 seconds of wall clock, and never fails `npm test`: an error is one line on stderr and exit 0.
- Scripts, exactly: `"pretest": "node scripts/tmp-sweep.mjs"`, `"test": "node --import ./test/tmp-preload.mjs --test test/*.test.mjs"`, `"test:file": "node --import ./test/tmp-preload.mjs --test"`.
- The repository's rules: no test over source text or over `package.json`'s text; a test's child gets a timeout; no real-shell loop in a probe; a test's own scratch sits under a base that is not named `omelette-*`.

## Measured

By the session, 2026-11-27, Node v20.19.5, macOS:

- With the spike as `--import` on the real temp directory: 2946 tests, 2945 pass, 1 skip (`off macOS the tool refuses…`, expected), 134 s; 7 new `omelette-*` instead of 2488. So `--import` reaches each test file's process on Node 20, and `syncBuiltinESMExports()` reaches `import { mkdtempSync } from 'node:fs'`.
- `rmSync(dir, { recursive: true, force: true })` over a directory holding a `0500` subdirectory with a file throws `EACCES`.
- `lstatSync(link).isDirectory()` is `false` for a link to a directory; `utimesSync(link, …)` changes the target's time.
- `scripts/mutants.mjs` runs the suite in a copy (`paths.work`) that holds `test/` (`COPY_ENTRIES`), and its tests build copies that hold no `test/tmp-preload.mjs`.

## Review focus

Input classes the spec implies and a task's tests would not reach unasked; each is a row of the task named.

1. A test process that ends by `process.exit()` or by a failing test still removes its directories (T1, modes `exit` and `fail`).
2. A directory the test removed itself before the exit, and a recorded directory whose removal fails: no error, the exit code is unchanged (T1, `removed` in the fixture).
3. `TMPDIR` given through a link (macOS: `/var` → `/private/var`): the parent is compared resolved (T1, the link row).
4. One entry that cannot be removed does not stop the sweep (T2, the `0500` row).
5. The age boundary: exactly 24 hours stays, one second more goes (T2, `now` passed in).

---

### T1 — the preload

**Files:** create `test/tmp-preload.mjs`, `test/fixtures/tmp-preload/forms.fixture.mjs`, `test/tmp-preload.test.mjs`; modify `package.json` (`scripts.test`, `scripts["test:file"]`).
**Bucket:** `medium` — the module is printed.
**Consumes:** nothing. **Produces:** `test/tmp-preload.mjs` (a side-effect module, no exports), loaded as `--import ./test/tmp-preload.mjs`; T3 uses this path.

- [ ] **The fixture**, run only as a child (`.fixture.mjs`, so no glob picks it up). One `node:test` test that, with `import { mkdtempSync, mkdtemp, rmSync, existsSync, writeFileSync } from 'node:fs'` and `import { mkdtemp as mkdtempP } from 'node:fs/promises'`, makes under `tmpdir()`: `a` (sync), `b` (callback form, with an options argument `{ encoding: 'utf8' }`), `c` (promise form), `removed` (sync, then `rmSync` at once); `nested` = `mkdtempSync(join(a, 'in-'))`; `outside` = `mkdtempSync(join(process.env.FIXTURE_OUTSIDE, 'out-'))`. It asserts `a`, `b`, `c`, `nested`, `outside` exist, writes `{ a, b, c, nested, outside, removed }` as JSON to `process.env.FIXTURE_OUT`, then by `process.env.FIXTURE_MODE`: `pass` → returns; `fail` → `assert.fail('asked to fail')`; `exit` → `process.exit(3)`.
- [ ] **Tests first**, `test/tmp-preload.test.mjs`. Base `B = mkdtempSync(join(tmpdir(), 'tmp-preload-test-'))`, removed in `after`; per row a fresh `t` (the child's `TMPDIR`), `o` (`FIXTURE_OUTSIDE`) and out file under `B`. The child: `spawnSync(process.execPath, [...(preload ? ['--import', PRELOAD] : []), '--test', FIXTURE], { env, timeout: 30_000 })`, `env` = `process.env` without `NODE_TEST_CONTEXT`, plus `TMPDIR`, `FIXTURE_OUT`, `FIXTURE_OUTSIDE`, `FIXTURE_MODE`. Rows:
  - `pass: the three mkdtemp forms are gone after the process, the nested one with its parent, the one outside the temp directory stays` — status 0; `a`, `b`, `c`, `nested` do not exist; `outside` exists; `readdirSync(t)` is `[]`.
  - `fail: a failing test file still removes its directories` — status not 0; `a`, `b`, `c` gone.
  - `exit: process.exit in a test still removes them` — status not 0; `a`, `b`, `c` gone.
  - `TMPDIR through a link: the parent is compared resolved` — `TMPDIR` is a symlink to `t`; status 0; `a`, `b`, `c` gone.
  - `without the preload the same fixture leaves a, b and c` — status 0; all three exist (the control: the rows above measure the preload).
- [ ] Run `node --test test/tmp-preload.test.mjs` — the control passes, the other four fail (`Cannot find module` for the preload).
- [ ] **Implement** `test/tmp-preload.mjs`, the spike with a header comment saying what it is for and that it is dev-only:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const made = new Set();
const root = () => { try { return fs.realpathSync(os.tmpdir()); } catch { return os.tmpdir(); } };
const note = (p) => {
  try { const r = fs.realpathSync(p); if (path.dirname(r) === root()) made.add(r); } catch { /* gone already */ }
  return p;
};

const sync = fs.mkdtempSync;
fs.mkdtempSync = function (...a) { return note(sync.apply(this, a)); };
const cb = fs.mkdtemp;
fs.mkdtemp = function (prefix, opts, done) {
  if (typeof opts === 'function') { done = opts; opts = undefined; }
  return cb.call(this, prefix, opts, (e, p) => { if (!e) note(p); done(e, p); });
};
const pm = fs.promises.mkdtemp;
fs.promises.mkdtemp = async function (...a) { return note(await pm.apply(this, a)); };
syncBuiltinESMExports();

process.on('exit', () => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});
```

- [ ] `package.json`: `"test": "node --import ./test/tmp-preload.mjs --test test/*.test.mjs"` and `"test:file": "node --import ./test/tmp-preload.mjs --test"`.
- [ ] Run `npm run test:file -- test/tmp-preload.test.mjs` — 5 pass; `npm test` — 0 failed, 1 skipped.
- [ ] The session commits: `test: a preload removes the directories each test process made in the OS temp directory`

### T2 — the sweep

**Files:** create `scripts/tmp-sweep.mjs`, `test/tmp-sweep.test.mjs`; modify `package.json` (`scripts.pretest`).
**Bucket:** `default` — it removes by name in a directory other programs share.
**Consumes:** nothing. **Produces:**

- `export const SWEEP_NAME = /^omelette-.*-[A-Za-z0-9]{6}$/`, `MAX_AGE_MS = 24 * 60 * 60 * 1000`, `BUDGET_MS = 5000`;
- `export function sweep({ root, now = Date.now(), maxAgeMs = MAX_AGE_MS, budgetMs = BUDGET_MS, uid = <process.getuid() where it exists, else null> }) → { removed: string[], failed: string[], stopped: boolean }` — names, not paths. `uid: null` removes nothing. An entry is taken when `SWEEP_NAME` matches, `lstatSync` says a directory, `st.uid === uid` and `now - st.mtimeMs > maxAgeMs`; an `lstat` that throws skips the entry; a removal that throws puts the name in `failed`. The clock is read before each removal: at `budgetMs` or more since the call began, `stopped` is `true` and the rest is left;
- run as a script (`node scripts/tmp-sweep.mjs`): `sweep({ root: realpathSync(tmpdir()) })`; prints `tmp-sweep: removed <n> stale omelette-* directories` to stdout when `n > 0`, with ` (stopped at the 5 s budget, the rest next run)` appended when `stopped`; anything thrown becomes `tmp-sweep: <message>` on stderr; the exit code is always 0. Importing the module runs nothing.

- [ ] **Tests first**, `test/tmp-sweep.test.mjs`. Base `B = mkdtempSync(join(tmpdir(), 'tmp-sweep-test-'))`, removed in `after`; each row builds its own root under `B`; ages are set with `utimesSync` and `now` is passed in. Rows:
  - `the table` — in one root, with `now` fixed and `old` = `now` − 25 h: an old `omelette-x-Ab3xYz` holding a file → gone; `omelette-y-Ab3xYz` aged 1 h → stays; old `omelette-evals` (holding `snapshots/abc/f`), old `omelette-mistral-repro`, old `omelette-gemini-test` → stay; an old **file** `omelette-f-Ab3xYz` → stays; an old **link** `omelette-l-Ab3xYz` to a directory outside the root → the link stays and the file in its target stays; an old `other-Ab3xYz` → stays. `removed` is `['omelette-x-Ab3xYz']`, `failed` is `[]`, `stopped` is `false`.
  - `the boundary` — a directory aged exactly `MAX_AGE_MS` stays; one aged `MAX_AGE_MS + 1000` goes.
  - `another user's` — `uid: process.getuid() + 1` removes nothing; `uid: null` removes nothing (skip the first where `process.getuid` is absent).
  - `the budget` — `budgetMs: 0`: `removed` is `[]`, `stopped` is `true`, the old directory is still there.
  - `one that cannot be removed does not stop the rest` — two old matching directories, one holding `sub/f` with `sub` at `0500` (put back to `0700` in `finally`): its name is in `failed`, the other is in `removed` (skip when `process.getuid() === 0`).
  - `as a script: a temp directory that does not exist` — `spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, TMPDIR: join(B, 'absent') }, timeout: 10_000 })`: status 0, stderr starts with `tmp-sweep: `, stdout empty.
  - `as a script: it sweeps the temp directory it is given` — `TMPDIR` a root holding one old matching directory: status 0, the directory is gone, stdout is `tmp-sweep: removed 1 stale omelette-* directories\n`.
- [ ] Run `node --test test/tmp-sweep.test.mjs` — every row fails (no module).
- [ ] **Implement** `scripts/tmp-sweep.mjs` to the interface above. The script entry is guarded the way `scripts/mutants.mjs` guards its own.
- [ ] `package.json`: `"pretest": "node scripts/tmp-sweep.mjs"`, before `test`.
- [ ] Run `npm run test:file -- test/tmp-sweep.test.mjs` — 7 pass; `npm test` — 0 failed, 1 skipped.
- [ ] The session commits: `test: a sweep before the suite removes omelette-* scratch older than a day`

### T3 — the mutation script

**Files:** modify `scripts/mutants.mjs` (`runSuite`, its JSDoc, the `suite` object at `:705`); test: append to `test/mutants-runner.test.mjs` (it already calls `runSuite` at `:209`).
**Bucket:** `default`.
**Consumes:** T1's `test/tmp-preload.mjs`. **Produces:** `runSuite({ cwd, files, timeoutMs, home, reporter, env, preload })` — `preload`, when a string, puts `--import=<its file URL>` before `--test`; absent, the arguments are as today. The mutation run passes `preload: join(paths.work, 'test', 'tmp-preload.mjs')` when that file exists in the copy, and nothing when it does not.

- [ ] **Tests first**, beside the row at `test/mutants-runner.test.mjs:209`, reusing its sandbox helper: the sandbox's test file makes `mkdtempSync(join(tmpdir(), 'mut-preload-'))` and writes the path to a file the row reads; `env` carries a `TMPDIR` under the row's own base. `runSuite with preload: the suite's directory is gone after the run` (`preload: <the repository's test/tmp-preload.mjs>`); `runSuite without preload: it stays`.
- [ ] One row through the whole run, in `test/mutants-isolation.test.mjs`'s harness (it records each suite's parent command line as `r.parent`, `:137`): with `test/tmp-preload.mjs` in the fixture root, every record's `r.parent` includes `--import=`; the existing rows, whose root has none, keep passing unchanged.
- [ ] Run the two files — the new rows fail.
- [ ] **Implement.**
- [ ] Run the two files — pass; `npm test` — 0 failed, 1 skipped.
- [ ] The session commits: `mutants: the suite runs with the temp-directory preload`

### T4 — docs (the session)

**Files:** `CONTRIBUTING.md`, this checkout's `CLAUDE.md` (gitignored), `.omelette/backlog.md`.
**Bucket:** `session` — under 20 lines, docs only.

- [ ] `CONTRIBUTING.md:13`: `npm test` is `node --test` over `test/*.test.mjs` with a preload that removes each test process's temp directories; one file is `npm run test:file -- test/x.test.mjs`; a bare `node --test` leaves its scratch in the OS temp directory until the next `npm test` sweeps what is older than a day.
- [ ] `CLAUDE.md`, «Run & test»: the same rule in one line, for coder and tester briefs.
- [ ] `.omelette/backlog.md`: the 2026-11-20 line and (н) get «сделано» with the commit.
- [ ] The session commits: `docs: CONTRIBUTING — one test file goes through npm run test:file`

## Gate (the session)

- [ ] After the coder: `omelette-tester` by hand with the spec and `git diff 32d24ac` (new files `git add -N`), then its second pass at once.
- [ ] One clean `omelette-reviewer` over `32d24ac..HEAD`; `mistral_security_review` of `scripts/tmp-sweep.mjs` on a clean copy.
- [ ] Acceptance: `npm test` — 0 failed, **1** skipped; the `omelette-*` names new in the OS temp directory after it are the units' fixed parents and `omelette-gemini-research-*` only (see Self-Review); wall clock within noise of 134 s.
- [ ] Push the branch, CI green on Ubuntu and macOS, Node 20 and 22; fast-forward main; delete the branch; `ledger sweep`.

## Self-Review

- **Coverage.** Preload → T1. Sweep and `pretest` → T2. Mutation script → T3. The single-file rule → T1 (`test:file`) and T4 (the words). The spec's test list: the three forms, the failing fixture, nested and outside → T1; the sweep's table, the unreadable root → T2. Acceptance → the gate.
- **Not pinned by a test, on purpose:** the three `scripts` strings (a test over `package.json`'s text); T1's and T2's script rows and the gate's count stand in.
- **The spec's open question** — who leaves five `omelette-gemini-research-*` a run — is answered, by the session's run of each of the 207 test files alone: `test/tester-1.6.0-t7.test.mjs` (3), `test/tester-1.6.0-u1.test.mjs` (1), `test/fix-round-a-1.6.0.test.mjs` (1). Each kills the Gemini server during a call (`SIGTERM`, then `SIGKILL`), and a server that shuts down on a signal never reaches the call's `finally` (`units/gemini/adapter.mjs:825`). The same happens to a user whose client kills the server during a call: one empty directory. Not a task here — a backlog line; these five a run are the sweep's.
- **Names.** `test/tmp-preload.mjs` in T1, T3, T4 and the scripts; `sweep`, `SWEEP_NAME`, `MAX_AGE_MS`, `BUDGET_MS` in T2 only.
