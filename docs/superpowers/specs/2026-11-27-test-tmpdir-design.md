# The test suite stops leaving directories in the OS temp directory

Status: **approved by the operator, 2026-11-27** — «Супер. Делаем». His word that opened it, the same day: «Надо подумать, как авточистку старья делать», then «А что ты думаешь, как лучше поступить нам будет с файлами?». Dev tooling only: nothing a user installs changes, no version bump, no tag.

| Section | Answers |
|---|---|
| [Why](#why) | What was measured in the temp directory, and what was not confirmed |
| [Goals](#goals-and-what-stays-out) | What the change must do, what it leaves alone, what would make it a failure |
| [Approaches](#approaches) | The four ways considered, the two spiked, the one taken |
| [Design](#design) | The preload, the sweep, the mutation script, the rule for a single file |
| [Tests and acceptance](#tests-and-acceptance) | What is pinned, and how we know it worked |
| [Left to the builder](#left-to-the-builder) | What the plan decides, and one open question |

## Why

Measured by the session on the operator's machine, 2026-11-27 14:40 local:

- The OS temp directory held **660 476 entries**, nearly all `omelette-*`. First by count: `omelette-evals-tf` 62 791, `omelette-evals-home` 54 773, `omelette-evals-pdir` 51 912. None older than 30 days; 402 of 1692 sampled were empty.
- **The source is the test suite.** 178 test files call `mkdtempSync`; 121 of them never call `rmSync`. One `npm test` leaves about 2500 entries (2488 counted today); a night of mutation runs left about 290 000 (backlog, 2026-11-20). The adapters remove their own scratch in `finally`.
- **macOS does not clear it.** Its temp cleaning removes files and leaves the directories (backlog (ц)(1)).

Not confirmed: that the leftovers make a run take 7–13 minutes (another session's agent, relayed by the operator). After that agent cleared the directory the full suite took 134 s, three times; `test/cli.test.mjs` alone took 135 s while the directory was being cleared and 131 s after. No timing of the full suite on the crowded directory exists. The change is worth making on the count alone.

## Goals and what stays out

- **Goal.** A full `npm test` leaves the OS temp directory with no test scratch it did not have before the run.
- **Goal.** A mutation run (`scripts/mutants.mjs`) leaves none either.
- **Goal.** What a bare `node --test test/x.test.mjs` or a killed process leaves under an `omelette-*` name is gone within a day, without anyone asking. Scratch under another prefix (`spawn-outfd-`, `unit-outfd-`, `neon-test-` and the like — 28 literal prefixes in 18 test files) is removed by the preload under `npm test` and `npm run test:file`, and stays after a bare run: the sweep takes no name another program could share. (Narrowed on 2026-11-27 after the review — the design below already said this; the goal had promised more.)
- **Stays out.** The 178 test files: not edited. `TMPDIR`: not changed. Making the suite faster. The shipped package: no command, no hook, nothing under `bin`, `core`, `units`, `hooks`.
- **A failure even if it works.** A test that passed before and now runs a different branch, or is skipped. A sweep that removes a directory something still uses — a unit's call in flight, an eval round's snapshot, another session's test run. A sweep that follows a link out of the temp directory.

## Approaches

1. **One directory per run (`TMPDIR` pointed at it) — spiked, rejected.** The full suite passes, 0 failed, and all 2488 leftovers land in the run's directory. But the kernel tests read the temp root's shape: `test/mistral-repro.test.mjs:1088` (the PROBE) turned from run to skipped, and `test/tester-neon-t9-10.test.mjs:477` takes its other branch when the root is not `/private/var/folders/x/y/T`. The suite would stay green while no longer exercising the profile a macOS user gets.
2. **A preload that removes what each test process created — spiked, taken.** `node --import` loads a small module into every test process; it records the directories that process makes with `mkdtemp` directly under the OS temp directory and removes them when the process exits. `TMPDIR` and the tests are untouched. On the real temp directory: 2946 tests, 2945 pass, the one expected skip, 134 s, and 7 new entries instead of 2488 — five `omelette-gemini-research-*` and the units' two fixed parents (`omelette-gemini-test`, `omelette-mistral-repro`), which are meant to stay.
3. **A sweep by age only.** Catches every way of running, but the leftovers pile up between sweeps (a night gave 290 000), and removal by name in a shared directory would be the whole design rather than the net.
4. **A shared helper with removal in `after`, in every test file.** A mechanical diff over 178 files, and the next test a tester writes forgets the helper; the operator's rule against tests over source text rules out pinning it.

## Design

**The preload — one module under `test/`, loaded by the `test` script.** `"test": "node --import ./test/<preload> --test test/*.test.mjs"`.

- Wraps `fs.mkdtempSync`, `fs.mkdtemp` and `fs.promises.mkdtemp`, then `syncBuiltinESMExports()`, so `import { mkdtempSync } from 'node:fs'` in a test gets the wrapped one.
- Records a created directory only when its parent is the OS temp directory (both resolved). A `mkdtemp` inside a directory already recorded goes with its parent.
- On the process's `exit`, removes each recorded directory, recursively; a failure to remove one is ignored.
- It removes only what this very process created — no name pattern, no age, nothing of another process.
- The spike that produced the numbers above is 30 lines, kept in `.omelette/spike/tmp-clean.mjs`; that directory is private, so the plan prints them.

**The sweep — `scripts/tmp-sweep.mjs`, run by `"pretest"`.** The net for a bare `node --test`, a killed process and a child's leftovers. It removes an entry of the OS temp directory only when all of these hold:

- its name is `omelette-`, anything, a dash, and six characters of `mkdtemp`'s alphabet (`omelette-cli-Ab3xYz`);
- `lstat` says a directory — a link is never followed and never removed;
- it belongs to this user;
- its modification time is more than 24 hours old.

So the units' fixed parents stay whatever their age — `omelette-evals` (an eval round's snapshots), `omelette-mistral-repro`, `omelette-gemini-test` — as does everything not ours. The sweep stops after 5 seconds of wall clock and leaves the rest to the next run; it never fails `npm test`: an error is one line on stderr and exit 0.

**The mutation script.** `scripts/mutants.mjs` starts its `node --test` with the same `--import`, from the copy it runs in.

**The rule for a single file.** `"test:file": "node --import ./test/<preload> --test"`, so one file is `npm run test:file -- test/x.test.mjs`. `CONTRIBUTING.md` and this checkout's `CLAUDE.md` say so, and a coder's and a tester's brief in this repository says the same.

**Cost if the 24 hours are wrong:** a mutation scratch or a unit call older than a day loses its directory under it. Neither exists today: the longest call is `timeoutS` (3000 s at most so far), the longest mutation night was 7 hours.

## Tests and acceptance

Pinned by tests (the sweep takes the temp root as a parameter, so no test touches the real one):

- a `node --import <preload> --test` over a fixture file that makes a directory with each of the three `mkdtemp` forms: the three directories exist while the file runs and are gone after it — this is what proves `--import` reaches a test's process on Node 20 and on Node 22;
- the same fixture, failing: its directories are gone as well;
- a directory the fixture makes inside its own recorded directory, and one it makes outside the OS temp directory: the first goes with its parent, the second stays;
- the sweep's table, ages set with `utimes`: an old `omelette-x-Ab3xYz` goes; a young one stays; old `omelette-evals`, `omelette-mistral-repro`, `omelette-gemini-test` stay; an old file with a matching name stays; an old link with a matching name stays and its target is untouched; an old `other-Ab3xYz` stays;
- the sweep on a temp root it cannot read exits 0.

Acceptance, by the session at the end:

- `npm test` green on macOS with **one** skip, the expected one, and on Linux in the pushed branch's CI before the merge;
- the `omelette-*` entries new after a full `npm test` are the units' fixed parents and nothing a test process made;
- the suite's wall clock is not worse than 134 s by more than noise.

Reviews: the tester with its second pass, one clean `omelette-reviewer` over the branch, and `mistral_security_review` of the sweep — it removes by name in a directory other programs share.

## Left to the builder

- The preload's file name under `test/` (not `*.test.mjs`, so the glob does not run it).
- The nested case: the preload's own test starts `node --test` from inside a test process, so `NODE_TEST_CONTEXT` has to be dropped from the child's environment (`scripts/mutants.mjs` already does this in `DROPPED_ENV`).
- **Open question, not this change:** who leaves five `omelette-gemini-research-*` per run. Either a test kills a child before its `finally`, or the adapter has a path that skips the removal — the second would be a leak in the shipped unit. The plan's first task finds out and reports; a fix in `units/` goes through its own flow.
