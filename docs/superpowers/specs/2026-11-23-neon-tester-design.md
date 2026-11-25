# A second tester on Gemini — `gemini_test`: tests written in a disposable copy, run by the unit under our kernel profile

Status: approved by the operator, 2026-11-24. Brainstormed with the operator on 2026-11-23; the spike behind it ran the same day (the lane ledger, 2026-11-23, «Spike» lines).

| Section | Answers |
|---|---|
| [Why](#why) | What the operator asked for, and what it is for |
| [Goals, non-goals, anti-goals](#goals-non-goals-anti-goals) | What ships, what does not, what would make it a failure even if it ran |
| [What the spike measured](#what-the-spike-measured) | The facts the design rests on, each from the disk or agy's own record |
| [Approaches](#approaches) | The four considered, which was picked and why |
| [The tool](#the-tool) | `gemini_test`: its arguments, its run, its answer |
| [The boundary](#the-boundary) | The two kernel profiles, the scratch home, agy's flags, the gate |
| [The test loop](#the-test-loop) | Rounds: Neon writes, the unit runs, Neon reads the output |
| [How the session uses it](#how-the-session-uses-it) | Beside the Sonnet tester, the session's rerun, arbitration |
| [The trial and its rule](#the-trial-and-its-rule) | Written before the run: what is counted, what earns the seat |
| [What it leaves open](#what-it-leaves-open) | The residuals, stated |
| [Release](#release) | Docs, tests, reviews, the live gate |
| [Left to the builder](#left-to-the-builder) | What a builder settles by measuring |
| [Not here](#not-here) | What stays out |

## Why

The operator, 2026-11-23: «А что если сделать второго тестера на неоне? И они могли бы с Sonnet параллельно делать тесты. Дать неону свою песочницу. И пусть он тестит.» A Gemini 4 Neon tester beside the Sonnet tester (`omelette-tester`), on the same coder task, at the same time; Neon in a sandbox of its own, where it writes tests and sees them run. Sonnet stays.

What it is for, agreed the same day: **to catch what the Sonnet tester misses.** One model's tests are blind in the same places run after run; another vendor's are blind elsewhere. The evidence for Neon is the round of 2026-11-20 (docs/MEASUREMENTS.md, «Round two»): it found all 8 public bugs in the review suite where the native Opus reviewer found 6, and it added tests of its own, unasked, in all six of its counted patch answers. Its weakness there — 41 % precision, 4 fabricated findings — is what a tester's flow absorbs: a test that does not fail on a real defect proves nothing and is dropped, and the evidence stays the runner's output, never the model's word.

Success, agreed: its tests sometimes fail on a real defect the Sonnet tester's did not catch; its false failures are few; it runs in parallel, so a task waits for the slower of the two and no longer; it does not spend the Gemini pool that research needs (Argon's quota is now part of that one pool — the operator, 2026-11-23).

## Goals, non-goals, anti-goals

**Goals.**
- A Gemini unit tool, `gemini_test`, that gives the model a disposable copy of the project with the coder's patch applied, lets it write files in that copy only, runs one fixed test command for it after each round under a profile with no network, and returns the model's last word, the test command's exit code per round, and a diff of the tests it wrote — the diff taken by the unit.
- A tester flow in which the session calls `gemini_test` at the moment it dispatches the Sonnet tester, reads the unit's run of Neon's tests, and rules on both reports.
- **Use in any project the operator works in** (his word, 2026-11-24: «Буду везде юзать»), not only this one: a project with installed dependencies is tested with them — the dependency directories the call names are copied into the disposable copy (see [`deps`](#the-tool)). Proven at the release's live gate on two stacks, Node with `node_modules` and Python with a venv; on his machine those are 13 of the 22 project manifests found (2026-11-24).
- A trial on the next plan's coder tasks, with its rule written here, before the run.

**Non-goals.** Replacing the Sonnet tester. Tests that need a simulator or a system service — an Xcode project's `xcodebuild test` hands the work to CoreSimulator and launchd, outside any profile of ours, so the boundary would not hold (7 such projects on the operator's machine; a Swift package's `swift test` is not promised either, unmeasured). Dependencies kept in the home rather than the project (Go's module cache, Cargo's registry): profile B reads no home. A test command that needs the network. Neon running any command of its own choosing. agy's own terminal sandbox (`--sandbox`). Linux (the tool refuses where `sandbox-exec` is missing, as `mistral_security_repro` does). Applying Neon's diff to the work tree. A second pass (mutation check) for Neon. The rules file's tester flow changed before the trial says so.

**Anti-goals** — a failure even if it runs:
- A model-chosen read or write that reaches the operator's home, the work tree, the fleet home or another run.
- Any change to the operator's own agy state or settings (`~/.gemini/antigravity-cli`, `~/.gemini/config`).
- Neon's report taken as evidence: a test of Neon's counts only when the session's own run of it fails or passes.
- The tester flow made slower by waiting on Neon in series.

## What the spike measured

agy 1.5.14, Gemini 4 Hydrogen (High), 2026-11-23; every outcome read from the disk afterwards or from agy's conversation record (each command's `BypassSandbox` and «Ran in the sandbox»), never from the answer. Scripts in the session's scratchpad (`spike/agy-sandbox-probe*.sh`, `spike/outer3.sb`); the lines in the lane ledger.

1. **agy's own sandbox is not tight in any combination measured.** The unit's mode pin plus `--sandbox` runs no command: headless denies the `command` permission first. `--sandbox` with a session rule `command(*)`: the network and reads of the home are denied, but when asked to retry the model set `BypassSandbox: true` itself and agy ran that `curl` outside the sandbox, headless, unprompted. `toolPermission: proceed-in-sandbox`: no bypass taken, but inside the sandbox the network is open and a file in the home is readable. Every combination let a command write anywhere under the OS temp root and none let a shell write land in the copy itself.
2. **A sandbox cannot be applied inside a sandbox on macOS.** `sandbox-exec` under `sandbox-exec` fails: `sandbox_apply: Operation not permitted`. agy applies its own in-process (the model's command is agy's direct child). So agy's sandbox cannot sit inside ours.
3. **agy runs whole under our kernel profile.** Writes allowed only in the copy, the run's tmp and agy's state and config directories; reads of the home denied but agy's directories, its binary and `~/Library/Keychains` + `~/Library/Preferences`; network open. Under `--mode accept-edits --settings {"allowNonWorkspaceAccess":false}`, with no command permission: agy signs in, writes a file in the copy with its file tool, and its `read_file` of a planted file in the home fails `operation not permitted` — the kernel, past the operator's `read_file(*)` allow rule.
4. **agy's file tool keeps to the workspace by its own policy too.** Under the same flags a write outside the copy or into the home asks for `write_file` permission, headless denies it, and the run ends with no output. Under the mode pin alone not even the copy is written.
5. **agy signs in with a scratch HOME** holding nothing but a link to the real `~/Library/Keychains`: the login token is in the Keychain, found through HOME. Its state directory is then fresh, under the run, and none of the operator's agy settings apply — no `read_file(*)`, no command rules, no trusted workspaces.
6. Earlier and still true (SECURITY, «Gemini»): a session `--settings` object replaces only the keys it names, and a session `permissions.allow` of `[]` denied a read the operator's file allowed; an unknown setting is an error before any turn (`sandboxAllowNetwork`, `internetAccess`, `nonWorkspaceFileAccess` are unknown on 1.5.14; `allowNonWorkspaceAccess`, `toolPermission`, `enableTerminalSandbox` are known).

## Approaches

| # | Approach | Verdict |
|---|---|---|
| 1 | agy's own sandbox, `--sandbox`, its permission settings measured by our probes | The operator's first pick. **Measured not to hold** (fact 1): one setting lets the model leave the sandbox at will, the other leaves the network and the home open. |
| 2 | Our profile around agy with agy's sandbox inside it, as a second layer | **Cannot exist** (fact 2). |
| 3 | No sandbox: Neon writes tests blind as one diff from the spec and the patch shown as text; the session applies and runs them | Works today, and the eval shows it writes runnable tests blind. But Neon never sees a failure and cannot fix a test, and it is not what was asked. |
| 4 | **agy whole under our kernel profile with a scratch home; Neon runs no command; the unit runs the one test command the call names, under a second, no-network profile, and hands the output back for a bounded number of rounds** | **Picked** — the operator, 2026-11-23 («Давай»), after the spike. Neon still writes, sees failures and fixes; the commands that run are one known command, under a profile that is ours, and nothing depends on how Google's sandbox behaves. |

## The tool

`gemini_test`, on the Gemini unit, beside `gemini_research`. Closed by default (see [the gate](#the-boundary)).

| Argument | What it is |
|---|---|
| `cwd` | Absolute path of the work tree. The copy is a HEAD-only clone of it (as `mistral_security_repro` takes one); uncommitted and ignored files are not in it. |
| `patch` | Absolute path of a patch file the session wrote: the coder's change as `git diff HEAD` after `git add -N` of new files — the same diff the tester flow already hands the Sonnet tester. The unit applies it in the clone (with the clone's git config isolated, as Mistral's `CLONE_CONFIG`) and commits it there, so Neon's diff is taken against the patched tree. A patch that does not apply is an error before any spawn. |
| `prompt` | The brief: the task, the spec path (as a path in the copy — a spec is committed before its build), what to test. The unit adds its own preamble: write tests with your file tools only, run no command, the unit runs the test command after you finish and gives you its output. |
| `testCommand` | The one command the unit runs, as an argv array (no shell string, no shell): `["node", "--test", "test/foo.test.mjs"]`, `[".venv/bin/pytest", "tests/test_foo.py"]`. Its first word is either a name on the config list `gemini.testPrograms` (default `node`, `npm`, `npx`, `pnpm`, `yarn`, `python3` — the builder fixes the default; the operator adds with `set`), resolved to an absolute path outside the copy, or a relative path that lies under one of the call's `deps` entries (`node_modules/.bin/vitest`, `.venv/bin/pytest`). Either way it is a file Neon cannot write, so nothing Neon writes can stand in for the program. |
| `deps` | Optional: the project's installed-dependency directories, as paths relative to `cwd` (`["node_modules"]`, `[".venv"]`). Each must be a directory inside the work tree that git ignores whole, and none may be or contain `.git` or `.omelette` — a slip like `"."` is an error before any spawn. The unit copies each into the copy at the same place (on APFS a copy-on-write clone, `cp -c`: no data is duplicated), before round 1. Nothing else of the work tree enters the copy: no `.env`, no other ignored file. |
| `rounds` | How many write-then-run rounds at most. Default 3, at most 5. |
| `model` | Optional; default the config key `gemini.testModel`, default `Gemini 4 Neon (High)` — separate from `gemini.model`, which stays Hydrogen (High) for research (the operator's ruling of 2026-11-21). |

**The answer**, in this order: one line per round with the test command's exit code and wall time, measured by the unit; Neon's last message; under the unit's own heading `## proposed tests (not applied)`, the diff of everything Neon changed in the copy, taken by the unit outside both profiles against a fresh copy of the clone's `.git` kept in the run's out dir (Mistral's `cloneDiff`, with its protections: nothing the model planted in the clone's `.git` runs, a nested repository is named and not entered, 1 MB cap, a model-written heading of that name is marked). A file Neon changed outside the test directories is listed by name above the diff — the tester writes tests; a change to the code under test is reported, never hidden.

A call is never retried: a second run would execute the model's tests again. The result is spooled like every unit call (`gemini_result`).

## The boundary

**The run.** Under `<OS temp>/omelette-gemini-test/run-*`, 0700, the operator's: `clone/` (the copy), `tmp/`, `home/` (agy's scratch HOME: an empty directory with `Library/Keychains` linked to the real one), `out/` (the fresh `.git` copy, agy's JSON output, the runner's logs). Removed after the call, unless `gemini.testKeep` (default `false`).

**Profile A — agy.** `sandbox-exec` with a rendered profile in the Mistral style, its skeleton fact 3:
- writes only the run's `clone/`, `tmp/` and `home/`, `/dev/null`, the command's own `/dev/tty` and the fd devices — and **not the copied `deps` directories inside `clone/`** (denied by path, as `repro.sb` denies the clone's `.vibe`): git ignores them, so a change there would not show in the diff, and the program the unit runs may live there. Neon reads them (a library's types and API help it write a test);
- reads of the operator's home denied whole, re-allowed: `~/Library/Keychains` (read only) and whatever agy's sign-in needs beside it (fact 3 needed `Preferences` too; the builder narrows it), agy's binary and the directories its real path lies in;
- the work tree (`SRC`), the fleet home, other runs and the fleet's other `omelette-*` temp dirs denied, the run's own dirs re-allowed last;
- no hand-off to a process outside the profile (Apple events, `open`, `osascript`, `launchctl`, `automator`, `pbpaste`, `pbcopy`, launchd jobs, preference writes), signals and process info only within the sandbox — as `repro.sb`; `/usr/bin/security` too, unless sign-in needs it (the builder measures);
- **the network open**: agy reaches Google. This is the one thing profile A cannot close (see [What it leaves open](#what-it-leaves-open)).

**agy's flags**, every round: `-p`, `--output-format json`, `--print-timeout`, `--model`, `--disable-slash-commands`, `--mode accept-edits`, `--settings` with `allowNonWorkspaceAccess: false` and a `permissions` object the unit pins — no `command` rule at all, the `read_url` and web tools denied if agy lets a session deny them (the builder measures; the preamble asks for no web either way). With the scratch home there is no operator `settings.json` to merge; the session object is all the policy agy has. Never `--sandbox`, `--dangerously-skip-permissions`, `--mode auto`, `--continue` (it would pick the operator's latest conversation if HOME were wrong).

**Profile B — the test command.** The test command runs through a wrapper under `repro.sb` itself, or a profile derived from it with the same rules (the builder decides which by what `node --test` and `npm test` need): no network, writes only `clone/` and `tmp/`, no read of the home but the adapter's node (`NODE`, `NODEUP`), `HOME` set to `tmp/`, the process group killed at the end (`killGroupOnExit`), a time limit per run (`gemini.testRunTimeoutS`, default 300). The dependencies are the copies inside `clone/`, so the profile gains no read of the work tree: `SRC` stays denied whole, and a runner that writes a cache into its dependency directory (`node_modules/.cache`, `.vite`) writes into the disposable copy. Its stdout and stderr go to `out/`, are cut to their last 16 KB for the model, and are made safe to show (control characters stripped by the unit itself: a unit's answer is not stripped today, only its status preview and its spool header are).

**The gate.** `OMELETTE_ALLOW_REPRO` — the variable that already opens `mistral_security_repro` — opens `gemini_test` too: the class is the same, the model's code executing in a disposable clone, and a registration's env is per server, so opening it on the gemini unit's registration opens nothing on mistral's. `OMELETTE_ALLOW_WRITE` opens nothing here, and the gate opens no write to the work tree. Closed, the tool answers with an error naming the variable. macOS only.

**Who opens it.** The operator, once, on the gemini server's registration (user scope, so it holds in every project) — the same step that opened Mistral's repro. No session sets the variable for a command of its own: a gate a session can open for itself gates nothing, and the write gates are the operator's (CLAUDE.md, «Two write gates»). With it set, a session that follows the flow calls the tool with no further step of his (the operator, 2026-11-24: «Обычно агент сам по флоу оркестрации идет»); `doctor` prints the gate's state on the gemini unit as it does on mistral's.

**What stays as it is.** The env allowlist and the billing-key scrub apply to both spawns. `gemini_research`, `gemini_deep_research` and `gemini_image` do not change. The unit's intent gate (`mutateGate`) is not put on `gemini_test`: a tester's brief and patch hold git words legitimately (the eval's V02 was refused for that), and Neon runs no command, so it can run no git.

## The test loop

Round 1: the unit spawns agy in the copy with the preamble and the brief; Neon reads the copy and writes tests. When agy exits, the unit runs `testCommand` under profile B and records the exit code. Round k > 1: the unit resumes the same conversation (`--conversation <id>`, the id from round 1's JSON; the conversation lives in the run's scratch home) with the test command's output. The loop ends when Neon answers `DONE`, when `rounds` is reached, or when a round ends with no output (a denied permission ends agy's run — fact 4 — and that round's diff still counts). The unit then takes the diff.

**The rounds are for tests that run, not for green.** The tester flow's rule holds for Neon (rules file, «Tester flow», step 5): a tester changes its own test only where the spec never made the assumption the test encodes. The preamble of every round says so: fix what keeps a test from running as intended (a syntax error, an import, a fixture, a wrong helper); a test that fails because the code does what the spec says it must not stays as it is and is named in the last message as a candidate defect, with the spec line it rests on; an assertion is never weakened to match the code. `DONE` means «the tests run and test what the brief asks», whatever their result. So that a failure seen in an early round cannot be edited away unseen, the answer carries each round's result as the unit measured it: the exit code, the wall time and the last 40 lines of the test command's output, and the run's `out/` keeps each round's diff when `testKeep` is on.

**One budget for the whole call.** `gemini.testTimeoutS`, default 1500 s: the unit starts no round once it is spent, ends a round that outlives it, and takes the diff of what is there. Without it three rounds at their worst (900 s of agy plus 300 s of tests each) outlast the client's wall-clock limit of 50 minutes, and the answer would be lost to a timeout with the run still going. `doctor` prints the worst case against that limit, as it does for deep research.

What a round costs is not known: each is one agy call on the Gemini pool. The defaults (3 rounds, 300 s per test run, the unit's `timeoutS` per agy call, 1500 s in all) are the builder's starting points; the trial reports the real ones.

## How the session uses it

On a coder task, while the trial runs (and after it only if the trial earns the seat):
1. The session writes the patch file (`git add -N`, `git diff HEAD`), spawns the Sonnet tester as today, and in the same message hands the `gemini_test` call — the same spec, the patch, the task's test command, its `deps` and the brief — to a **relay**: a background sub-agent on a cheap model (`general-purpose`, Haiku-class) whose whole job is that one MCP call. An MCP call made by the session itself would hold its turn for the whole loop, up to 25 minutes; the relay holds its own. Measured 2026-11-24: a Haiku sub-agent reaches the gemini unit's tools (it loaded and called `gemini_models`). The relay reports that the call ended and nothing else; **the session reads the answer itself with `gemini_result`** (every unit call is spooled), so no model stands between the unit's evidence and the session. Neither tester waits for the other.
2. **The evidence is the unit's run, not Neon's word.** The per-round lines (exit code, wall time, the output's tail) are written by the unit from the test command it ran under profile B, outside the model's reach, as `mistral_security_repro`'s exit codes are; Neon's own message is a claim. The session does not run Neon's code outside a profile before it has read it: it reads Neon's whole diff first, then rules on each failing test against the spec.
3. Arbitration as today, with both reports: a failing test of Neon's is a candidate defect until the session rules test against spec. A test the session keeps is read whole and enters the work tree through the session — into the coder's fix round or the task's commit — like any tester's test, and from then on runs in the suite as every test does; never applied from the unit's answer unread.
4. A ledger line per task: Neon's measures (below), the Sonnet tester's for the same task.

`gemini_test` runs once per task, on the coder's first patch; a fix round's patch is tested by the Sonnet tester as today, not by Neon again.

## The trial and its rule

Written before the run (the operator's standing rule: a role changes on a measurement against a rule fixed first). On the next plan's coder tasks — 3 to 5 of them — `gemini_test` runs beside the Sonnet tester on every one.

Counted per task: whether Neon's diff applied and its tests ran in the session's own run; how many of its tests failed on a defect the session ruled real; how many of those the Sonnet tester's tests did not catch (**new defects**); how many failed with no real defect (**false failures**); rounds used; Neon's wall time against the Sonnet tester's first report; the Gemini pool reading before and after where the usage snapshot refreshed.

**Rule.** Neon keeps a seat in the tester flow — and the rules file's tester flow gets it — when, over the trial: at least one new defect; at most one false failure per task on average; no task waited on Neon more than 10 minutes past the Sonnet tester's first report; and no run in which the boundary failed (a write or a read the profiles should have refused, found on the disk or in agy's record). Short of it, the tool stays, gated, and the role does not change; the result goes to MEASUREMENTS either way.

How the rule is read:
- **A new defect** is one the session ruled real that neither of the Sonnet tester's passes (the first report and the second pass) caught on that task.
- **A trial with no real defect at all** — found by neither tester on any task — says nothing about Neon: it is inconclusive, not failed, and runs on for up to five more coder tasks of the plans that follow.
- **The Gemini pool** has no threshold in the rule: the usage snapshot is not reliably readable (it did not refresh for a day in the eval round). The trial reports what it read; a call answered «exhausted» stops its loop, is not retried, and is reported.

## What it leaves open

- **agy's own process has the network**, and Neon's `read_file` reads whatever profile A leaves readable: the copy, the scratch home, the Keychain files (encrypted blobs), and files outside the home that the operator's user can read (system files, other volumes — the profile denies by list, as Mistral's does). What Neon reads can leave in the request; this is the limit every unit has.
- **The runner executes code Neon wrote**, under profile B: the class `mistral_security_repro` already accepts, with the same profile.
- **Neon reads the copied dependencies**, and what it reads can leave in the request: a private package in `node_modules` is as exposed as the project's own source, which the unit already sends.
- **A stack is covered only as far as it was measured**: Node and Python with project-local dependencies at the gate. A toolchain kept under the home (nvm, pyenv) runs only if its install root can be re-allowed read-only the way `repro.sb` re-allows the adapter's node; one that cannot fails closed, with the kernel's error in the round's output.
- Names under the home leak through `stat` where the profile allows metadata, as with Mistral.
- A model-written `.gitignore` can hide a new file from the diff (as Mistral's).
- **Antigravity's terms** (SECURITY, «a grey zone»): a loop of headless calls is still the official `agy` under the operator's own login; it is more calls of the same kind the unit already makes.

## Release

A minor release, 1.13.0, through the whole flow: it adds a tool, a gate's second use and two profiles.
- Code: the tool in `units/gemini/`; the clone, diff, cleanup and wrapper pieces of `units/mistral/repro.mjs` lifted where both units can use them, Mistral's tests passing unchanged; profile A rendered per run.
- Tests: kernel tests on macOS in the shape of `test/mistral-repro.test.mjs` (Neon cannot read the home or another run, cannot write outside the copy, the test command has no network, nothing planted in the clone's `.git` runs at diff time, a non-applying patch is refused, the gate's closed answer; a `deps` entry that is tracked, outside the tree or `.git` is refused, Neon cannot write a copied dependency, the work tree's own dependency directory is unchanged after a run), with a fake `agy` in `test/` for the loop; live runs at the gate: this repository, one Node project with `node_modules` and one Python project with a venv (throwaway fixtures made for the gate, never one of the operator's projects by name).
- Docs: SECURITY (a «Gemini — `gemini_test`» subsection beside Mistral's, the spike's facts), ADAPTERS (the checklist line for a unit that executes code now has two examples), CONFIG (`testModel`, `testKeep`, `testRunTimeoutS`, `testTimeoutS`, `testPrograms`, the gate and who opens it), ORCHESTRATION (the routing row, «not yet in the tester flow» until the trial), MEASUREMENTS (the spike), CHANGELOG.
- Three reviews before the merge (Codex where the plan allows — `gpt-6-luna` on the operator's plan — Grok, an Opus whole-branch review), Mistral's security review generously (the operator, 2026-11-19), the live gate on the day's agy, and `doctor` listing the tool and its gate.

## Left to the builder

Settled by measuring, each recorded with its evidence: the smallest read set agy needs to sign in under profile A (`Keychains` alone or `Preferences` too; `/usr/bin/security` or not); whether a session `permissions` deny of `read_url` and the web tools is accepted; whether `--conversation` resumes in the scratch home under profile A, else a fresh call per round with the previous round's output in the prompt; whether `repro.sb` itself runs `node --test` and `npm test` in the copy or a derived profile is needed; agy's updater under profile A (it must neither fail the call nor write outside the run); the default of `gemini.testPrograms`; how long the copy of a large `node_modules` takes with `cp -c` and what the unit does off APFS (a plain copy under a size cap, or an error naming it); how a toolchain under the home (nvm's node, pyenv's python, a venv's base interpreter) is re-allowed read-only in profile B; how the patch is applied (`git apply --index`, then a commit with a fixed identity, under the isolated git config).

## Not here

The mod's unit settings in the fleet pane (backlog «Из эвала Neon», (к): next, its own spec). A second pass for Neon. Linux. agy's `--sandbox` as a layer. Neon as a reviewer (on trial by name only — the operator's ruling of 2026-11-21). Changing the Sonnet tester.
