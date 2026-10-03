# Orchestration

How to run a session with a fleet: who decides, who proposes, and which unit gets which task.

| Question | Where |
|---|---|
| Who's in charge, and what do the units actually do? | [The operating model](#the-operating-model) |
| How does the operating model actually reach a running session? | [How the rules reach a session](#how-the-rules-reach-a-session) |
| What does the contract every unit sends say, and when does it change? | [Layer 1: the contract](#layer-1-the-contract) |
| Which files does `rules` write, what will it refuse to overwrite or remove, and when does my session see each one? | [Layer 2: the rules file and its marker](#layer-2-the-rules-file-and-its-marker) |
| What does the guard hook do, and how do I wire it? | [Layer 3: the guard](#layer-3-the-guard) |
| Why does `doctor` say the guard is NOT wired? | [What doctor says about the wiring](#what-doctor-says-about-the-wiring) |
| Where do the rules go in a monorepo, and what about an existing AGENTS.md? | [Monorepos and AGENTS.md](#monorepos-and-agentsmd) |
| How should work be delegated once I'm inside a session? | [Inside Claude Code](#inside-claude-code) |
| May the session skip the flow for a one-line fix? | [When the session does the work itself](#when-the-session-does-the-work-itself) |
| How does a finished branch reach main? | [How a branch reaches main](#how-a-branch-reaches-main) |
| How do I keep a plan from getting lost across a compaction? | [Ledger and handoff](#ledger-and-handoff) |
| Who tests the coder's work, and who decides test vs. code? | [Tester sub-agent and arbitration](#tester-sub-agent-and-arbitration) |
| What is the tester's second pass, and when do I send it? | [Tester sub-agent and arbitration](#tester-sub-agent-and-arbitration) |
| `/omelette-test` is refused under auto mode. What now? | [Under auto mode: the manual dispatch](#under-auto-mode-the-manual-dispatch) |
| What does a review finding have to look like? | [Reviews](#reviews) |
| Which sub-agent runs a review, and what keeps it read-only? | [Reviews](#reviews) |
| How do I trust a report or a code map without re-reading the code? | [Evidence with pointers](#evidence-with-pointers) |
| What does a planner, a coder or a plan reviewer get handed? | [What each agent is handed](#what-each-agent-is-handed) |
| When is a scout map worth taking? | [The scout map, when a fresh planner needs one](#the-scout-map-when-a-fresh-planner-needs-one) |
| How do I control a sub-agent's model and effort? | [Spawning sub-agents: model and effort](#spawning-sub-agents-model-and-effort) |
| Which model and effort does each shipped role run on, and why? | [Effort by role and model](#effort-by-role-and-model) |
| The tester stopped at its turn limit. What now? | [When the tester runs out of turns](#when-the-tester-runs-out-of-turns) |
| Which unit should a given task be routed to? | [Routing by task](#routing-by-task) |
| When should I escalate to a stronger model or higher effort? | [Model and effort escalation](#model-and-effort-escalation) |
| How much should I trust a unit's claims on their own? | [Never a sole source](#never-a-sole-source) |
| How do I tell a slow run from a stuck one? | [Supervising with the status feed](#supervising-with-the-status-feed) |
| A unit broke overnight. What do I check first? | [When a unit breaks overnight](#when-a-unit-breaks-overnight) |
| What makes a good brief to a unit? | [Briefing a unit well](#briefing-a-unit-well) |

## The operating model

Your Claude Code session is the **orchestrator and the reviewer**. It plans, decomposes, routes, and it is the only thing that changes code — directly or through its own sub-agents, under whatever approval flow you already have. The units are **read-only proposers**: they research, analyse, review and give second opinions, and they hand back text. Nothing a unit says reaches your repository except by passing through you.

<img src="assets/diagrams/change-path.svg" alt="Which path a change takes: at most 20 lines with its test and outside the six excluded areas takes the small-change lane; everything else goes spec, plan, then the session itself when the four delegate conditions do not all hold, or omelette-coder-medium or omelette-coder by what the section prints, and on to tester, review and commit." width="720">

<img src="assets/diagrams/operating-model.svg" alt="Six lanes — operator, session, omelette-coder, omelette-tester, omelette-reviewer, fleet units — with the commit and merge step sitting only in the session lane." width="880">

That split is what makes the fleet cheap to supervise. A unit's worst case is a wrong answer, not a wrong commit — so you review claims, not diffs. And because every unit reads untrusted material by design (web pages, repositories), keeping the mutating surface in one place is also the injection containment.

Use whatever subset you have installed. The routing below degrades gracefully: with only Codex you lose grounded multi-source research; with only Gemini you lose the strongest code review; the model still works.

## How the rules reach a session

None of the above helps if the session never reads it. Three layers deliver it, and they are independent.

The overlap is deliberate: layer 1 is the part you cannot afford to have missing, layer 2 is the part worth a command, layer 3 is the part worth enforcing rather than asking for.

### Layer 1: the contract

**Layer 1 — the contract, automatic.** Every unit server returns a short contract from the MCP `initialize` handshake (`InitializeResult.instructions`), and Claude Code puts it in the session's context as "MCP Server Instructions". Install a unit and it is there, with no user action: the units propose and the session applies, absolute paths and one job per call, no unit is a source of record and Grok least of all, plus one line saying what that particular unit is for. It is under ten lines on purpose. Like every other server change, it takes effect on the next Claude Code restart.

### Layer 2: the rules file and its marker

**Layer 2 — the operating model, one command.**

```bash
omelette-fleet rules            # <project>/.claude/rules/omelette-fleet.md
omelette-fleet rules --global   # $CLAUDE_CONFIG_DIR or ~/.claude instead
omelette-fleet rules --agents   # also the sub-agent definitions and the /omelette-test skill
omelette-fleet rules --hooks    # the guard script, plus the settings snippet to paste
omelette-fleet install --rules  # the registrations AND `rules --agents --hooks` here, in one run
```

Each kind of managed file reaches a running session on its own schedule:

| Managed file | Lands in a session | Restart needed when | What the CLI says |
|---|---|---|---|
| The rules file, `.claude/rules/omelette-fleet.md` (or `~/.claude/rules/`) | At session start, loaded the way CLAUDE.md is (verified on Claude Code 2.1.261). A `paths:` frontmatter key would scope a rules file to matching files (code.claude.com/docs/en/claude-directory); the shipped file declares none, so it is always on | Always | The sentence below |
| The agent definitions, `.claude/agents/` and `~/.claude/agents/` | Claude Code's watcher picks a new or edited one up on its own — usually within seconds, but a new global definition took about ten minutes once (2026-09-06): "seconds" is the common case, not a guarantee | The directory did not exist when the session started | The sentence below |
| The skill, `.claude/skills/omelette-test/` | The same watcher: `.claude/skills/` is watched too | `.claude/skills` did not exist when the session started | The sentence below |
| The guard script, `.claude/hooks/omelette-guard.mjs` | The moment it is on disk, once your settings call it ([Layer 3](#layer-3-the-guard)) | Never | Nothing: a run that wrote only the guard says nothing about session starts |

The sentence the CLI prints after a write, and only after one of the first three kinds was written: **rules load on the next session start; agent definitions and skills are picked up by Claude Code's watcher — usually within seconds, sometimes minutes (restart if `.claude/agents` or `.claude/skills` did not exist before)** — the directory has to have existed when the session started for the watch to be on it.

What each flag writes, and what it does with a file already at that path:

| Flag | Files written | Marked file | Unmarked file | Symlink or non-regular |
|---|---|---|---|---|
| `rules` | `<cwd>/.claude/rules/omelette-fleet.md` | Refreshed; the run prints which version it moved from | Left alone — refused until `--force` | Refused: a directory, a device or a FIFO before it is even read; a link at `.claude`, at any of the four directories under it, or at the target itself |
| `--agents` | Also `.claude/agents/omelette-coder.md`, `omelette-coder-medium.md`, `omelette-tester.md`, `omelette-reviewer.md` and `.claude/skills/omelette-test/SKILL.md` | Refreshed | Left alone | Refused |
| `--hooks` | Also `.claude/hooks/omelette-guard.mjs`; prints the settings snippet that calls it ([Layer 3](#layer-3-the-guard)) | Refreshed | Left alone | Refused |
| `--global` | The same files under `$CLAUDE_CONFIG_DIR` or `~/.claude` instead of the project | Refreshed | Left alone | Refused |
| `--force` | — | Refreshed | Replaced | Still refused: `--force` never writes through a link |
| `--remove` | Nothing: it deletes, and removes exactly one directory — the skill's own `.claude/skills/omelette-test/`, once its `SKILL.md` is gone, because a skill IS a directory and the empty one left behind still reads as an installed skill | Deleted | Left where it is, with a line telling you to delete it by hand if you meant it | The skill directory goes only while it is empty and not a symlink: anything else in it makes it yours, and one that cannot be removed is left alone in silence, not turned into a refusal |
| `--print` | Nothing at all: the text goes to stdout | — | — | — |
| `--dry-run` | Nothing: it prints every path and action, and for `--hooks` announces the settings snippet instead of printing it — a snippet naming a script that was never written is a snippet somebody pastes | — | — | — |

The file's first line is a version marker, and that marker is the only proof of ownership: a file is marked when that line matches, whole, the one this version renders — a line that merely opens like it is somebody else's file. All four managed kinds — the rules file, the agent definitions, the skill, the hook script — work exactly this way; only the comment syntax of the marker differs. What no flag can do — be triggered by a unit, write through a link, follow a planted temporary file: [SECURITY, "What this package never does"](SECURITY.md#what-this-package-never-does).

`doctor` reports each kind on one informational line, both scopes, and never counts a missing file as a fault; while something is missing from the project it adds ONE `next` line above the units, and nothing once all is done. Each line, and the `next` ladder in order: [README, "What doctor tells you"](../README.md#what-doctor-tells-you).

`update` prints the exact refresh command when a marked file is behind the installed package, and `update --check` also when a scope holds only some of a kind's files, whatever their version (`… refresh: omelette-fleet rules --agents (2 of 4 missing)`) — it never rewrites the file for you.

### Layer 3: the guard

**Layer 3 — the guard, one script the operator wires up.** `omelette-fleet rules --hooks` writes `.claude/hooks/omelette-guard.mjs` and serves three events from it: on `PreToolUse` it exits 2 when the caller is one of the four roles this package ships — `omelette-coder`, `omelette-coder-medium`, `omelette-tester` or `omelette-reviewer` — and the command is a `git` write, and on `PreCompact` and `SessionStart` it stamps every plan ledger and prints the last handoff block back into the session after a compaction. What it does on each event, its bounds and why it is containment rather than a boundary: [SECURITY, "The guard hook"](SECURITY.md#the-guard-hook); the exact grammar of a `git` write: [SECURITY, "What the guard reads as a write"](SECURITY.md#what-the-guard-reads-as-a-write).

A hook script is not a hook until something calls it, and **the caller lives in your settings, which this package reads and never writes**. So `rules --hooks` prints the snippet on every run and you merge it in yourself — into `.claude/settings.json` or `.claude/settings.local.json`, whichever you keep this kind of setting in. The CLI says as much above it: *"Merge this into your settings file (it is a whole `hooks` object — add the events it lists to an existing `hooks` block rather than replacing the file)"*. If you already keep hooks in that file, add these three events to the `hooks` block you have; pasting the snippet over the file would take the rest with it:

```json
{ "hooks": {
  "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node '/abs/path/.claude/hooks/omelette-guard.mjs'" } ] } ],
  "PreCompact": [ { "hooks": [ { "type": "command", "command": "node '/abs/path/.claude/hooks/omelette-guard.mjs'" } ] } ],
  "SessionStart": [ { "matcher": "compact", "hooks": [ { "type": "command", "command": "node '/abs/path/.claude/hooks/omelette-guard.mjs'" } ] } ] } }
```

The printed path is absolute and shell-quoted: a hook `command` is a command line rather than an argv, so a checkout under `~/My Projects` would otherwise paste a hook that runs `node /Users/you/My` and fails on every tool call. The quoting follows the platform the CLI runs on: POSIX single quotes on macOS and Linux, double quotes on Windows, where `cmd.exe` would read single ones as part of the path — and the JSON layer then doubles that path's backslashes, `"node \"C:\\Users\\me\\.claude\\hooks\\omelette-guard.mjs\""`. Double quotes are a shell quoting, not an argv: under PowerShell or Git Bash a `$` in that path would expand, so a path holding one wants editing by hand — one more reason native Windows is not supported yet.

The guard is a *settings-level* hook on purpose: a `hooks:` block in an agent definition's own frontmatter did **not** fire on Claude Code 2.1.261 — no log line, `git commit` went straight through — while the same hook in the project's settings did fire for the same sub-agent, blocked it with exit 2, and its stdin JSON carried `agent_type: <the sub-agent>` (and no `agent_type` at all for the main thread). Measured 2026-09-06; that measurement is why the guard is keyed on `agent_type` rather than declared in the definition.

### What doctor says about the wiring

`doctor` reads **both** files of a scope — `settings.json` and `settings.local.json`, and the global pair under `$CLAUDE_CONFIG_DIR` or `~/.claude` — and reports the **union**: a guard wired half in `settings.json` and half in `settings.local.json` reads as wired, which is what it is; reading only the first would report a guard wired in the file a project usually gitignores as inert. It matches on the script's *name* inside the command string rather than on an exact path, so quoting it (the printed snippet does), wrapping it or keeping it elsewhere still reads as wired. The line is `wired: PreToolUse, PreCompact, SessionStart`, or `NOT wired` with the most specific reason it found — an unreadable settings file or a matcher aimed elsewhere wins over the plain list of missing events:

| `doctor` prints | When |
|---|---|
| `NOT wired — paste the snippet from rules --hooks` | no event calls the script |
| `NOT wired (missing SessionStart) — …` | a guard wired the 0.3.2 way: the events nobody calls are named, since that is what has to be pasted |
| `NOT wired (settings.local.json unreadable) — …` | a settings file exists but cannot be parsed — named rather than counted, because sending an operator to re-paste something already there is the wrong advice |
| `NOT wired (PreToolUse matcher is not Bash) — …` | the entry's matcher cannot see a `Bash` call, so it guards nothing and yet looks installed from every other angle; a finding only while an event is still missing — once the scope's two files together wire every event, some other entry already sees the call |
| `NOT wired (PreToolUse matcher "(" is not a valid regex) — …` | the pattern does not compile: a typo in the settings file and a guard aimed at another tool are fixed differently |
| `NOT wired (PreToolUse matcher is not a string)` | the matcher is not a string at all |
| `NOT wired (SessionStart matcher is not compact)` | the matcher is `startup` alone; `compact` and `startup|compact` are wired, and an absent matcher counts as wired because the guard's own `source` check is what keeps a startup silent |
| `wired: PreToolUse, PreCompact, SessionStart · PostToolUse, Stop, PostCompact wired but no longer used — remove them from your settings files` | an entry still calls the guard on a retired event; never a reason the guard reads as unwired |

A matcher is read exactly as Claude Code reads one (its docs spell `"Edit|Write"` and `"mcp__.*"`): a string of nothing but tool names, `|`, `,` and spaces is an **exact list** compared whole — `Bash|Edit` and `Bash, Write` are wired, `Edit`, `Bashful` and `ash` are not — and anything else is a **regex tested against `Bash` unanchored**, so `.*`, `Ba.` and `ash$` are wired; an absent matcher, `""` and `"*"` mean every tool. `SessionStart` is matched the same way, against the session's SOURCE rather than a tool name. The line exists at all because a script nobody calls is the failure mode where everything looks installed.

### Monorepos and AGENTS.md

If the project already keeps an `AGENTS.md` for other agents, Claude Code does not read it on its own; a one-line `@AGENTS.md` import in `CLAUDE.md` makes both read the same text (code.claude.com/docs/en/memory, "AGENTS.md"), and `.claude/rules/omelette-fleet.md` loads independently of either.

**In a monorepo, placement decides reach.** `omelette-fleet rules` writes into the `.claude` of the directory you run it in, and a session picks up the rules of the tree it starts in. Put the file at the level whose sessions should see it: the repository root when the whole monorepo works this way, a package directory when only that package does. Descendant directories are loaded lazily rather than all at once, so a root-level file is the one reliably in context for every session — and `--global` puts it in front of every project on the machine, which is the right call for a personal setup and the wrong one for a shared checkout.

## Inside Claude Code

The same split applies one level down, and it is the operating model this package was built under. Your top-level session is the expensive, careful one: keep it for planning, routing and review, and delegate the work.

- **Code changes go to a strong coding sub-agent**, briefed with the plan and the constraints, never to a unit. The session reviews the result before it lands.
- **Documentation, changelogs and boilerplate go to a cheaper model.** They are long, mechanical, and easy to check against the code.
- **Research goes either to a fleet unit or to a sub-agent**, whichever has the better tool for the question — a unit when you want a different vendor's judgement or grounded web search, a sub-agent when the answer is in your own repository.
- **Nothing lands unreviewed.** Every delegated result — sub-agent or unit — comes back to the session, which checks it against the code and the plan before accepting it. Delegation buys throughput, not trust.
- **Branch per feature; main is gated.** Work on a `feat/<name>` branch from main. The session commits each task on that branch once its review passes — git-native checkpoints that a review package, a ledger or a revert can name — while coder sub-agents never commit. How that branch reaches main is configuration: [How a branch reaches main](#how-a-branch-reaches-main).

Two practical rules that follow: give each delegate one job and the context to do it (they start fresh and see none of your session), and do not delegate the decision about whether the work is correct — that is the part you kept the expensive session for.

### When the session does the work itself

**When a delegate is justified — all four, or the session does it itself.** The subtask is independent (its own files or its own question); it resolves a **named uncertainty** ("does the migration run on 0.3.2 data?", not "look at the architecture"); a wrong answer would cost something material; the expected output fits one sentence. Short of all four, the session does the work itself rather than paying a delegate's overhead for a routine call it could make in a handful of tool calls.

**The small-change exception.** The session edits directly when the change is at most **20 lines**, changes no behaviour beyond the fix, carries its test in the same commit (or touches only docs and comments), and gets a ledger line. The tester still runs on every coder result; a docs-only edit needs none.

**The small-change lane.** A change that qualifies for the small-change exception goes to main on its own short branch (`fix/<name>`): the session writes it with its test, runs the suite (and, per the Linux rule, sees it green on Linux — Docker or the pushed branch's CI), fast-forwards main, and writes one ledger line. No spec, no plan, no reviews, no tag. The next release's whole-branch review covers it (the reviewers are told which commits arrived through the lane), and its CHANGELOG line rides that release.

**What stays out of the lane.** Anything that changes behaviour beyond the fix, touches the guard's refusal logic, the env allowlist, the billing scrub, the write gates or a tool's schema, or needs a doc section rewritten: those go through the flow whatever their size. The lane exists so a one-line fix costs a one-line process, not so the flow becomes optional.

### How a branch reaches main

**How that branch reaches main is configuration**, one key: `workflow.merge` in the fleet config, and the rules file carries the sentence it renders. Switch it with `omelette-fleet set workflow.merge=pr && omelette-fleet rules`: like every other rendered value, the config alone changes nothing until the file is written again.

| `workflow.merge` | Rendered sentence | Who merges | Who pushes and tags |
|---|---|---|---|
| `session` (the default) | *"The session merges the branch into main itself once every review is clean and it is confident the work is ready; pushing and tagging wait for the operator's explicit approval"* | The session — the gate is its own verified judgement rather than a per-commit approval | The session, after the operator's explicit approval |
| `pr` | *"The session opens a pull request from the feature branch and never merges into main itself; merging is the operator's or the repository's gate"* — the shape a team whose main is protected already works in | The operator, or the repository's gate | Not set by this sentence |

What `doctor` and `install --rules` print about the policy, whether the rendered file carries it yet, and when that line adds a hint that the repository looks PR-gated — a hint and never a fault: [CONFIG, "Workflow settings"](CONFIG.md#workflow-settings).

## Ledger and handoff

A long plan outlives the context it was made in. Compaction is the obvious way that happens, but it is not the only one: an interrupted evening, a session that had to be restarted, a hand-off to a colleague. Everything the orchestrator knows and never wrote down is lost at that moment — and what is lost first is exactly what is most expensive to recover, the *reasons*. The code is still in git. Why option B was rejected is not.

So: **keep a ledger file for every plan, from the first step.**

- One line per event, appended as it happens — not reconstructed afterwards from memory that has already been compacted.
- **Every decision as `Ruling: <what> — <why> — <cost if wrong>`.** The third field is the one that pays for itself: it is what tells a later reader whether to revisit the call or leave it alone.
- Tasks marked complete **with their commits**, so the ledger and the branch name the same checkpoints.
- **Close a plan with its review yield.** One line, `review yield: <findings> found / <accepted> accepted / <rejected> rejected — <the two or three that mattered>`. It is the cheap measure of what the reviews were worth; keep it honest.
- Before a compaction — announced or merely suspected — and at every natural pause, append a **handoff block**: where the work stands, open findings, agents in flight, next action. Write it as if the reader has none of your context, because they do not.
- After a compaction, **re-read the ledger before doing anything else.** Acting first and reading second is how a plan silently forks.
- **Provenance apart from trust, and demote-not-delete.** Every line carries what it is — a unit's claim, a coder's report, a tester's run, the orchestrator's own check — and a claim is `candidate` until the orchestrator verified it, then `verified` or `rejected`. Two independent seats reporting the same thing is still two candidates. A ruling that turned out wrong is not edited: it stays, and a `Superseded by: <new ruling>` line follows it, so the next reader sees the decision, the reversal and its cost instead of a clean page that hides a lesson. (The vocabulary is borrowed from NexusMem's provenance/trust-state split and its hash-only tombstones — https://github.com/yaminbkk/NexusMem — which is the one idea from that project this model adopts.)

Location: `<project>/.omelette/ledger-<plan>.md`, with `.omelette/` in `.gitignore` — or wherever the project's own convention puts it. The rule is the file, not the path.

`omelette-fleet rules --hooks` mechanises the fragile step, and it is a backstop, not the discipline: it stamps a re-read line into every ledger when a compaction happens and prints the last handoff block back into the session that opens after one, but it cannot write the handoff block you did not write. **Both halves read `<session cwd>/.omelette/ledger-*.md`** — the directory the session is running in, not the repository the plan is about. A ledger kept in another checkout gets neither the stamp nor the print, and an orchestrator working across repositories keeps the ledger where the session is. What each event does, its bounds and what 1.5.0 removed: [SECURITY, "The guard hook"](SECURITY.md#the-guard-hook); the two-row version the rules file points at: [CONFIG, "The handoff hooks"](CONFIG.md#the-handoff-hooks).

## Tester sub-agent and arbitration

A coder sub-agent reporting "done" is a claim, not evidence. What turns it into evidence is a second sub-agent that did not write the code.

**The clean context is the whole mechanism, and it is cheaper than it looks.** The second agent is not smarter than the first; it is *uncorrelated with it*. An implementer's context contains every assumption that produced the bug, so the blind spot travels with it — re-reading your own diff harder buys very little, while a fresh reader with the same spec and none of the history catches a different class of mistake. That is the reasoning behind Boris Cherny's advice to spend test-time compute on a second, clean-context pass rather than on one longer one ([claude-code-best-practice, tips/claude-boris-2-tips-10-mar-26.md](https://github.com/shanraisshan/claude-code-best-practice/blob/main/tips/claude-boris-2-tips-10-mar-26.md)). The corollary is the rule below: anything that carries the coder's framing into the tester's context — a summary, a "here's what I changed", a list of what to look at — spends the second pass re-running the first one.

**The orchestrator spawns the tester, never the coder.** A coder that picks its own tester grades its own homework: it chooses what gets checked, and it briefs the tester out of the same understanding that produced the bug. A sub-agent on Claude Code *can* spawn a sub-agent, so this is a rule of the operating model rather than a limit of the tool.

**The tester's input is the approved spec plus the diff, taken from git** — never the coder's summary. A summary says what the implementer believed they built; the diff says what they actually did, and the spec says what was asked. Anything that reaches the tester only through a summary is untested by construction.

`omelette-fleet rules --agents` ships that handoff as a mechanism rather than a habit:

```
/omelette-test docs/specs/my-feature.md              # the diff of THIS repository
/omelette-test docs/specs/my-feature.md ../other-repo # …or of one you name
```

The skill (`.claude/skills/omelette-test/SKILL.md`) declares `context: fork` and `agent: omelette-tester` — and deliberately not `disable-model-invocation`, because the orchestrating session is the one that invokes it (through the Skill tool; a human can also type `/omelette-test`) — and its body carries `` !`git -C "$1" diff HEAD` `` and `` !`git -C "$1" ls-files --others --exclude-standard` ``. Those commands run **at invocation, before the fork**, so the forked tester opens with the working tree's real diff and the list of untracked files already in front of it — there is no step at which a summary could be substituted. `$0` is the spec path and `$1` the optional repository path, for an orchestrator whose session sits in another repository: when it is not given the shell expands it to an empty string and `git -C ""` is a no-op, so the diff is the current directory's. That path is substituted into a shell command before it runs, so pass a plain absolute path and nothing the shell would interpret — a `$`, a quote or a `$(` in it is expanded, not escaped. Where skills are unavailable, dispatch `subagent_type: omelette-tester` by hand with the spec and the diff; the rule is the same, only the plumbing is manual.

**The tests run through the real runner.** The tester writes its tests in a new file, never editing the implementation, and runs them with `npm test`, `pytest` or whatever the project actually uses. The raw runner output is the evidence, quoted. "I verified it" from a model is not a test result, and neither is a test that was written and reasoned about but never executed.

**Narrow the run when the full suite is Docker-bound or minutes long** — the affected suite, the changed package, the one target that exercises the diff. The orchestrator decides the scope, and the report says which scope ran; an unqualified "tests pass" over a subset is the kind of evidence that is worse than none.

**Then a second pass, in the same tester, before arbitration.** When the first report is in, the orchestrator continues the SAME tester with the words "Second pass" (in Claude Code, `SendMessage` to its agent id); the template carries the rest. First a mutation check: about a dozen small breaking changes to the code the diff touches, one at a time, in a plain copy outside the tree, each run against both test files, with a test added for every miss the spec requires. Then a reviewer's read of what the diff *writes* — strings, docs, changelog, examples, config — for claims that are inconsistent, stale, undated, inferred rather than checked, or silent about what an upgrading operator meets, each finding in four parts. It reports only what is new. Every measured second pass continued a tester dispatched by hand through the Agent tool — whether one forked by the `/omelette-test` skill can be continued was not tried; where the first tester cannot be continued, dispatch a fresh `omelette-tester` with the words "Second pass", the spec, the diff and the first tester's test file, which costs a first read again. Skip it, with a ledger line, for a docs-only diff or one the small-change exception covers. Why it exists: on one task two passes at `high` found 13 of 17 findings where one `xhigh` pass found 10, at about half the cost, and on the next diff the second pass found six prose findings the first had not ([MEASUREMENTS](MEASUREMENTS.md#the-testers-effort-a-second-pass-and-an-advisor)).

**Send it at once.** The one measured long pause, 31.5 minutes idle before the medium arm's second pass, made that pass's first request write 76 439 cache tokens and read none, while the high arm's second pass, sent within ten seconds of its report, wrote 58 878 in all. A tool call that runs past about five minutes cools the cache the same way, so the template runs a long mutation sweep as several shorter commands ([MEASUREMENTS](MEASUREMENTS.md#the-testers-effort-a-second-pass-and-an-advisor)).

**Arbitration belongs to the orchestrator, and it happens before anyone edits.** A failing test is not automatically a bug in the code; it is just as often a bug in the test. The rule: the test encodes an assumption the spec never made → fix the test; the spec is explicit and the code disagrees with it → fix the code. That ruling binds the coder: what must never happen is a coder changing code until a test goes green without the call being made — that is how a spec quietly becomes whatever the tester happened to assume.

The one exception, and it runs the other way: **the tester may fix or drop its OWN tests** when the spec never made the assumption they encode — it wrote them, they are not evidence about the code, and leaving them failing would bury the real findings. Every such change is reported, so the orchestrator sees what was withdrawn and why. Nothing the tester does reaches the implementation.

**Two or three rounds, then a human.** The ruling and the findings go back to the coder — continue the same sub-agent where the harness supports resuming one, so its context survives — and if the same defect is still there after the third round the problem is no longer a coding problem. Escalate it.

### Under auto mode: the manual dispatch

**Under Claude Code's auto permission mode the skill does not run.** The harness refuses the injection before the fork — `` Shell command permission check failed for pattern "!`git -C "$1" diff HEAD`" `` (2026-09-17, reported to Anthropic) — so in that mode the mechanism is the manual dispatch, and it is the documented first path there: the orchestrator spawns `subagent_type: omelette-tester` with the spec's path and a diff it took itself — `git add -N` for the new files so they appear, then `git diff HEAD` saved to a file the brief points at — and never a summary, which is the one rule the skill exists to enforce. Every 1.6.0 tester was dispatched this way. The mechanised form returns as G2 in 1.7.0 — a Workflow script that takes the diff itself, or the skill without the positional `$1` — after the W0 spike decides which.

## Reviews

**A finding has four parts, or it is a question.** Every review brief asks for, and every finding is recorded as, `location · scenario · consequence · how to confirm`. The orchestrator rules on each: `verified`, `rejected (reason)` or `needs-check (what)`, in the ledger.

**First review clean, re-review continued.** The first review of a change runs with a clean context — no coder summary, no earlier findings. A re-review after a fix round is briefed with the previous findings and the rulings on them, so it verifies the fixes instead of rediscovering the file.

**The shipped reviewer.** `omelette-fleet rules --agents` writes `omelette-reviewer` — the clean-context second reader on our own model, the Opus review 1.2.0 briefed by hand, now a definition (`model: claude-opus-5-5` and `effort: xhigh` by default, tools `Read, Grep, Glob, Bash, Write`, `disallowedTools: Agent, Edit, NotebookEdit`). One spawn is one review of one thing: a plan, a task's diff or a branch. Its brief carries the base and head (or the file) and the spec's path, and, for a re-review only, the earlier findings and the rulings on them. It reads what it reviews, runs the suite when the brief says so, and reports findings only, ranked, each `location · scenario · consequence · how to confirm` with the location as a pointer line `omelette-fleet check` can verify, then one verdict line: `ship`, `do not ship` or `needs-check`. The report goes to `.omelette/reports/<name>-review.md`; the reply is the verdict line and the count. The Routing table's code-review row stays Codex: this adds a reader, it replaces none.

**Read-only by definition and by check, not by enforcement.** Claude Code's tool filtering cannot scope `Write` to one path or make `Bash` read-only, and the guard refuses only the git commands it names. So the definition says the only file the reviewer writes is its report; the guard refuses its `git commit`, `stash`, branch creation and `worktree` by name, as it does the coder's, and its `reset --hard`/`--merge`/`--keep`, `update-ref` and writing `symbolic-ref`, which move HEAD or a ref and leave the tree clean; and the session runs `git status --porcelain` after every review and rejects the review outright if anything but that report changed, and compares `git rev-parse HEAD` and `git symbolic-ref -q HEAD` from before the review with their values after it (two branches at one commit would otherwise hide a switch). The check sees what git sees: `git status --porcelain` lists tracked and untracked paths — not ignored ones, and not a moved HEAD, which is what the `rev-parse` comparison is for. The report itself lives in the ignored `.omelette/`, and a write elsewhere under an ignored path is not caught (containment, not enforcement).

## Evidence with pointers

Delegation multiplies reading: four planners re-read the same modules, and a report in free prose has to be taken on faith or re-derived. The answer is a funnel — explore once, pass compact evidence up — with one guard against the funnel's own failure: a digest that cannot be checked turns one agent's mistake into everyone's premise. So evidence is written as **pointer lines**, and a command verifies them.

```
- `core/unit.mjs:540` · `const finish = (text, isError` · finish() closes the status entry and spools the record
```

`path:line` — relative to the project root, never absolute, one line and not a range · a **verbatim fragment** of that line in backticks — at least 8 characters, no backtick inside it · the claim, which is not optional. Quote, never paraphrase: paraphrase is where mistakes enter. A line that opens like a pointer and does not parse is `malformed`, and a fragment too short to prove anything is `weak` — both fail, because evidence that silently stops counting is the failure this shape exists to prevent. Everything else is prose and is ignored.

| Piece | What it is |
|---|---|
| **Report shape** | `omelette-coder` and `omelette-tester` write their full report as `## TASK`, `## FINDINGS` (pointer lines), `## DIFF`, `## TEST RESULTS`, `## OPEN QUESTIONS`; the short reply is unchanged. |
| **`omelette-fleet check <file.md>`** | Verifies every pointer: `ok`, `moved` (the fragment is on another line — the nearest is named, ties to the smaller line number), `mismatch`, `missing`, `outside` (absolute, leaves the project root, a symlink, not a regular file), `too-large`, `weak`, `malformed`, and `stale` when the file changed since the map's `commit:` — committed or not. Exit `0` when every pointer is `ok` — `stale` too, unless `--strict` — and there is at least one distinct pointer (`--require <n>` moves the floor; `--require 0` is for a report whose findings say `none`); `1` otherwise; `2` for a usage error. `--strict` also fails on a staleness that could not be checked, including a `commit:` value that is not a plain hash. Limits: a checked file of 1 MiB and 2000 pointer lines, targets of 2 MiB. The file you check may live anywhere (a report in a scratchpad); the paths it names are opened only when they resolve inside the root. git runs only when there is a `commit:` line — `git diff --name-only --relative <hash>`, against the working tree, in a built environment with lazy fetch, tracing, external diff and hooks shut off — and `check` writes nothing. |

How to use `check`: run it on a report before handing it on; re-take a `stale` or `moved` line rather than trusting it (a file whose timestamps moved while its content did not can read `stale` too — re-taking a line is a read, whereas refreshing git's index for you would be a write, and `check` writes nothing). A right pointer can still carry a wrong conclusion, which is why the claim is a third part and not a paraphrase.

### What each agent is handed

Reading is two thirds of what a sub-agent takes in, and the repetition is across agents, not within one ([MEASUREMENTS](MEASUREMENTS.md#where-a-sub-agents-context-goes)). So each agent is handed what its job needs, pointed at, and nothing it has to rediscover. The rules file says each of these in one line; this is the full text.

- **A planner gets its section.** Its brief carries the package's section of the spec and the pointers the session hands it; the plan's header lists what it read. When several packages are planned by fresh delegates, a scout map is the way to hand them the same reading once — see [The scout map, when a fresh planner needs one](#the-scout-map-when-a-fresh-planner-needs-one).
- **A coder gets its task, not the release.** Its brief carries the task's section of the plan and the pointers it needs, not the whole spec; the spec's path is there for the cases the plan did not settle. The brief also names which coder, by how much the section leaves to decide. **`omelette-coder-medium`** (`effort: medium`) when the section prints the exact text, the diff, the tests and the numbers they must print: the coder executes it, and on one plan-driven trial medium built the same behaviour as xhigh, which took 2.5× the cache reads and 3.6× the wall clock ([MEASUREMENTS](MEASUREMENTS.md#coder-effort-medium-high-xhigh-on-one-task), N = 1). **`omelette-coder`** (`effort: xhigh`) otherwise: a new thing with no written shape, debugging with no known cause, or a decision the brief *explicitly delegates* (decide X between A and B, report the trade-off) — effort buys depth on the decisions the brief hands over, not permission to guess. A brief that leaves a required decision open gets `NEEDS_CONTEXT` back at any effort: the coder template says so, and neither bucket changes it. The bucket and the reason for it go into the brief and into the task's ledger line.
- **The session reviews a plan by its header, task list and Self-Review.** The full plan file goes to a unit — `codex_code_review` or `grok_code_review`, with the spec's path and the plan's path, asking for four-part findings — and the session opens the pointers of the findings, not the file. The ledger records the findings and the rulings as for any review.
- **Pay for judgement, not for repetition.** Reviews, clean-context testers and arbitration are what the tokens are for; re-reading, re-running and re-deriving are where they are lost. A planner does not dry-run its plan: the review reads it, and the coder and the tester run it for real.

### The scout map, when a fresh planner needs one

A technique, not a rule. Before a release of several packages is planned by fresh delegates, **one** read-only scout writes `.omelette/map-<plan>.md`, once: `# Map — <plan>`, `commit: <hash>`, pointer lines grouped by module and factual only (*owns / exports / calls / reads / writes*), and a closing `## Not read`, so silence is not read as absence. Run `omelette-fleet check` on it before handing it on and again when the branch has moved; a consumer opens **three pointers of its own choosing** before relying on it, and one false line rejects the map whole; a planner's header lists the map lines it relied on and re-took. It earns its place when the planners are fresh delegates and would otherwise each re-read the tree; when the session plans, it does not — the session already holds the reading. A map never goes to a first review, which runs clean-context precisely so it does not inherit the scout's blind spots. The one measurement ([MEASUREMENTS](MEASUREMENTS.md#planning-cost-with-the-scout-map)) showed the map halving a fresh planner's reading and no total saving, because that planner dry-ran the plan; the mandate left the rules in 1.5.0 and the technique stayed here.

## Spawning sub-agents: model and effort

Two things decide how hard a sub-agent thinks, and they are set in different places.

**The model** is set on the `Agent` call. **Effort is not**: it comes from an *agent definition* — a markdown file with YAML frontmatter, in `.claude/agents/<name>.md` for the project or `~/.claude/agents/<name>.md` for the user, the project's copy winning a name clash. Accepted values: `low`, `medium`, `high`, `xhigh`, `max`.

Effort resolves in this order (code.claude.com/docs/en/model-config, sub-agents): the **`CLAUDE_CODE_EFFORT_LEVEL` environment variable** beats every agent definition; otherwise the **`effort:` key** of the definition; otherwise the sub-agent **inherits the session level**. Never export that variable in a fleet session — it would silently flatten every definition you ship — and set `effort:` explicitly when it matters. (A previous session in this project concluded that a sub-agent's effort could not be set at all and routed work around it. That was wrong — the key exists.)

The frontmatter keys that matter:

| Key | What it does |
|---|---|
| `name` | The value you pass as `subagent_type` |
| `description` | What the orchestrator reads when deciding whether to reach for this agent |
| `model` | The model the sub-agent runs on (the shipped definitions pin exact ids, `claude-opus-5-5` and `claude-sonnet-5-5`) |
| `effort` | `low` / `medium` / `high` / `xhigh` / `max` — where a sub-agent's effort is set, short of the environment variable above |
| `tools` | Comma-separated allowlist; omit it to give the agent the default tool set |
| `disallowedTools` | Comma-separated denylist, applied **before** `tools` resolves — the harness enforces it, so it is the only way to make "does not spawn sub-agents" true rather than requested |
| `maxTurns` | How many turns the sub-agent may take before the harness stops it |

The shipped definitions pin exact model ids — `claude-opus-5-5` for the two coders and the reviewer, `claude-sonnet-5-5` for the tester — the way the fleet pins its units' models: a new generation reaches them in a release of this package, never silently. What was measured: on 2026-09-30, on Claude Code 2.1.284, two days after Sonnet 5.5 shipped, a sub-agent spawned with the `sonnet` alias ran on Sonnet 5 (the `model` field of its transcript) while Claude Code's own alias table already said 5.5, and one spawned with `opus` resolved to Opus 5.5. An alias is still a value you may set — `omelette-fleet set agents.tester.model=sonnet && omelette-fleet rules --agents` renders `model: sonnet` — for an install that would rather follow Claude Code's resolution than a pin. These are first-party ids: on a provider that names models differently (Bedrock, Vertex, Foundry), set `agents.<role>.model` to that provider's id or back to the alias — not tested here. What actually ran is in the transcript, not in the definition: [Effort by role and model](#effort-by-role-and-model).

`omelette-fleet rules --agents` writes four of these next to the rules file:

- **`omelette-coder`** — `model: claude-opus-5-5`, `effort: xhigh`, `disallowedTools: Agent`, otherwise the default tools. Implements one task from the brief the orchestrator gives it (a file path or the text itself), follows the brief's test cycle, does not commit unless told to, and cannot spawn anything.
- **`omelette-coder-medium`** — `model: claude-opus-5-5`, `effort: medium`, `disallowedTools: Agent`, otherwise the default tools: the coder's own template rendered under a second name, from its own `agents.coderMedium` block, so its instructions are the coder's word for word and the two cannot drift apart. Which one a brief goes to is the rule under [What each agent is handed](#what-each-agent-is-handed).
- **`omelette-tester`** — `model: claude-sonnet-5-5`, `effort: high`, `maxTurns: 80` by default (config), `disallowedTools: Agent`, tools `Read, Glob, Grep, Bash, Write, Edit`. The flow above: spec plus diff in, new test file, real runner, a test-vs-spec ruling on every failure; continued with "Second pass", a mutation check and a reviewer's read of what the diff writes.
- **`omelette-reviewer`** — `model: claude-opus-5-5`, `effort: xhigh`, `disallowedTools: Agent, Edit, NotebookEdit`, tools `Read, Grep, Glob, Bash, Write`. One review of one thing with a clean context: findings only, ranked, in four parts, then `ship`, `do not ship` or `needs-check`; the one file it writes is its report ([Reviews](#reviews)).

Select them with `subagent_type: omelette-coder` / `omelette-coder-medium` / `omelette-tester` / `omelette-reviewer`. All four are refreshed by re-running the command and are yours to replace — drop the marker comment and the fleet stops touching the file.

**Those values are configuration, not code.** They live in the fleet config's `agents` block and the templates carry `{{model}}`, `{{effort}}` and `{{maxTurns}}` where they go, so a role is retuned with `set` and a re-render:

```bash
omelette-fleet show agents                                          # what the definitions will say
omelette-fleet set agents.tester.maxTurns=120                       # change it
omelette-fleet rules --agents                                       # re-render the definitions
```

Nesting is allowed three levels deep by default (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), which is exactly why the tester rule has to be enforced rather than stated: the coder *could* spawn its own reviewer. `disallowedTools: Agent` in every shipped definition takes the possibility away. Verified on Claude Code 2.1.261, 2026-09-05. "Never commits" is enforced one layer out for EVERY shipped role, by the `PreToolUse` guard of `rules --hooks` — a denylist can remove the `Agent` tool, but `git commit` is just a `Bash` call, and only a hook can tell it apart from the `git diff` each role legitimately runs. The refusal names the role it caught (`omelette-coder never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`, and the same line under the tester's and the reviewer's own names), so none is ever handed another's rule.

### Effort by role and model

What `rules --agents` renders for each shipped role with nothing configured; every value is config ([CONFIG, Agent settings](CONFIG.md#agent-settings)).

| Role | Model id | Effort | Why |
|---|---|---|---|
| `omelette-coder` | `claude-opus-5-5` | `xhigh` | Judgement: a new thing with no written shape, debugging with no known cause, a decision the brief delegates. On the judgement-heavy repeat, medium left a fail-open class in place; xhigh's misses were two narrow writes, fixed in one round ([MEASUREMENTS](MEASUREMENTS.md#the-matched-repeat-medium-and-xhigh-on-a-judgement-heavy-task)) |
| `omelette-coder-medium` | `claude-opus-5-5` | `medium` | The measured plan-driven equivalence: medium built the same behaviour as xhigh, which took 2.5× the cache reads and 3.6× the wall clock ([MEASUREMENTS](MEASUREMENTS.md#coder-effort-medium-high-xhigh-on-one-task), N = 1) |
| `omelette-tester` | `claude-sonnet-5-5` | `high`, plus the second pass | This release's measurement: one pass at `high` found 4 of 17 findings, the same agent continued with the second pass 13, one `xhigh` pass 10 at about twice the cost ([MEASUREMENTS](MEASUREMENTS.md#the-testers-effort-a-second-pass-and-an-advisor)). Anthropic's guidance for Sonnet 5.5 runs routine work at `high` or below and keeps `xhigh` for a measured gain |
| `omelette-reviewer` | `claude-opus-5-5` | `xhigh` | Judgement is what a review pays for |

**What the measurement showed.** On one task's diff, depth came from a directed second pass, not from effort and not from an advisor: Sonnet 5.5 at `high` in two passes found 13 of 17 findings for at least $1.46, one `xhigh` pass 10 for at least $2.90 ([MEASUREMENTS](MEASUREMENTS.md#the-testers-effort-a-second-pass-and-an-advisor)). The coder and tester templates also carry Anthropic's stop-and-report guidance for Sonnet 5.5, adapted: when the work asked for is done and its checks pass, stop and report, and name what else is worth doing instead of doing it — at `xhigh` and `max` a model can start its own rounds of review and make fixes it noticed along the way, which a tester must not.

**The advisor, measured and not adopted.** Measured on Claude Code 2.1.285, 2026-09-30: Claude Code's advisor tool (experimental, Anthropic API only; `/advisor <model>`, `advisorModel` in settings or `--advisor`) lets the running model consult a stronger one, which reads the caller's whole conversation uncached at its own rates. On the tester's task, Sonnet 5.5 at `high` with an Opus 5.5 advisor attached never called it in 20 turns; asked in the brief to consult it twice, it did, and the two consultations cost $1.10 of a $2.06 run that found what an unadvised `high` run finds. The advice comes back encrypted in the transcript (`advisor_redacted_result`), so nobody can read afterwards what it said. Sub-agents inherit a configured advisor, so an `advisorModel` in your settings reaches every shipped role; `/advisor off` or `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` turns it off.

**What actually ran is in the transcript.** A sub-agent's transcript (`~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`) records `model` and `effort` on every turn; the definition and the `Agent` call only say what was asked for. After `rules --agents` the next spawn may still run the old definition for minutes: on 2026-09-30 a probe spawned right after a re-render to `high` ran at `xhigh`, and one about five minutes later at `high`. Before a run whose model or effort matters, spawn a one-line probe and read its transcript; after the run, read its own.

### When the tester runs out of turns

The most common case is the tester running out of turns on a big diff. `maxTurns` in a definition **is** honoured — measured 2026-09-06: an agent given `maxTurns: 3` and six tool calls to make stopped after three, and the harness told the orchestrator it had stopped at its turn limit and could be continued. **A turn-limit truncation is not a failing suite** — the shipped tester is told to say what it had left to do — and the fix is the two commands above, then **continuing the same tester** rather than dispatching a new one, so its context is kept; the new definition is picked up by Claude Code's watcher, usually within seconds, sometimes minutes. The orchestrator may do this on its own mid-plan: it is a config change, not a code change. Details of the block, its defaults and the dotted `set` form: [CONFIG.md](CONFIG.md#agent-settings).

## Routing by task

| Task | Route to | Why |
|---|---|---|
| Grounded web research, fact synthesis, reading and summarising | **Gemini** → `gemini_research` | Web-grounded, and the fleet's citation-oriented researcher |
| Multi-source deep research | **Gemini** → `gemini_deep_research` | Decompose → parallel gather → synthesise, returning Summary / Findings / Sources / Gaps & Confidence. **Costs ~5 CLI runs per call** and commonly takes 3–10 minutes — deliberate use, not the default research mode |
| An independent Claude read on Antigravity's quota | Gemini `gemini_research` with `Claude Opus 5.5 (High)` or `Claude Sonnet 5.5 (High)` named in the call | One named call per question; never deep research, never the configured default — the Claude bucket is small |
| Reading local images, PDFs, screenshots, diagrams | **Gemini** → `gemini_research`, needs the opt-in agy rule set (SECURITY, Recommended agy allow-rules) | Multimodal. Give an **absolute path** and say "view the file directly, no terminal commands" — shell tools are auto-denied headless |
| Cheap fast second opinion, mechanical review, high-volume sweeps | **Grok** → `grok_research` / `grok_code_review` | Inexpensive per token and fine for volume — with the caveat below. Two profiles: `grok_research` is web-only and reads no local files; `grok_code_review` reads the tree and has no web |
| Math / STEM cross-check | **Grok** → `grok_research` or **Gemini** → `GPT-OSS 120B (Medium)` | Two independent non-Google/non-OpenAI voices for the same check; each model's figures are in its catalog (`grok_models`, `gemini_models`), dated there |
| Strongest code review, agentic terminal analysis | **Codex** → `codex_code_review` with an absolute `cwd` | The fleet's strongest reviewer, on `gpt-6.1-sol` at `xhigh` by default — AA Intelligence Index 52 against astra's 53 at max effort, at $0.72 per Index task against astra's $3.26 (AA, read 2026-09-30); reads, greps and runs read-only shell commands inside an OS sandbox |
| Research where the answer depends on running things | **Codex** → `codex_research` | The same default (`gpt-6.1-sol` at `xhigh`) and the same sandbox, plus web search, and it reports real token usage per call |
| Final pre-release security audit | **Codex** on `gpt-6-astra` (heavy reviews only) — pass `model: "gpt-6-astra"` | Leads gpt-5.6-sol on the vendor's own cyber evals (ExploitBench 100.0 vs 78.5, ExploitGym 42.4 vs 30.3). Five times 6.1-sol's input and output price and slower (51 tok/s against 68) — two or three runs per release, not one per PR |
| Tie-breaker when Grok and Gemini Flash disagree | **Gemini** → `Gemini 3.1 Pro (High)` | A third voice inside the fleet, on the model whose training and generation differ from Flash's |
| Image generation | **Gemini** → `gemini_image`, **Grok** → `grok_image`, or **Codex** → `codex_image` (gpt-image-2) | All three save outside your project — a temp directory, or Grok's session directory — and return an absolute path you import by hand |
| Image-to-image editing | **Grok** → `grok_image_edit` | The only unit in the fleet that edits images |
| Architecture, planning, UI/front-end taste, long-horizon engineering | **Claude** (your session, or its sub-agents) | Grok is explicitly contraindicated for architecture and UI; Codex is a strong reviewer but not a source of record |
| Any file edit, git operation, deploy or publish | **Claude**, under your approval | The only mutating path. Units reject git/deploy intent before spawn and mostly cannot act on it anyway |
| A client timeout, a cancellation or a restart dropped an answer | **The same unit** → `<unit>_result` (no id = the newest, plus the last ten) | The answer was spooled before the response was sent, so it is on disk. Fetching it starts no run and costs nothing; re-asking the question pays for it twice |

Ask a unit's `<unit>_models` tool when you are unsure whether a task belongs on it at all — the catalogs carry "route to / route away" advice, not just ids.

## Model and effort escalation

The rules below come from the catalogs' own `GUIDE` strings. Omit `model` to keep the fleet default; escalate deliberately, because on a subscription quota the cost is real.

**Gemini** — default `Gemini 3.8 Flash (High)` for delegated research and agentic work.
- Down to `(Low)` for quick facts, lookups and short summaries; `(Medium)` when High's latency or token overhead is unwanted. 3.8 deliberately spends more thinking tokens than the previous generation at the same price per token, so **dropping the effort level is the way to buy that back** — not paying High for routine work.
- Up to `Gemini 3.1 Pro (High)` for two things only: inputs past 1M tokens (the 2M context window), and formal or scientific reasoning where 3.8 Flash has no published numbers (GPQA Diamond 94.3, ARC-AGI-2 77.1). It is also the fleet's tie-breaker when Grok and Flash disagree. It is **not** a code or agentic model any more — 3.8 Flash leads it 68.1 vs 46.2 on public coding and 67.6 vs 40.1 on agentic lanes, at roughly a third of the price. `Pro (Low)` is the same two niches at balanced cost.
- Plain 128K retrieval is **not** a reason to reach for Pro — the last measured Flash generation led MRCR v2 128K 97.0 vs 84.9.
- `Claude Opus 5.5 (High|Medium)` and `Claude Sonnet 5.5 (High|Medium)` run on Antigravity's separate Claude quota — the same generation as the fleet's own coder and reviewer, so they buy an independent read, not a stronger one. That quota is small (operator, 2026-10-03) where the Gemini pool is effectively unlimited: one named call per question, never a sweep, and `gemini_deep_research` refuses them (about five runs per call); `gemini_research` and `gemini_image` refuse a Claude id that is only the configured `gemini.model`. The refusals see only ids the fleet names: keep agy's own default model a Gemini one. Prefer Gemini for citation-heavy research (web grounding via agy is unverified for the Claude family). Sonnet's 2026-08-02 exclusion is lifted; neither is a fleet role.
- `GPT-OSS 120B (Medium)` is a corroborating voice for maths and vendor de-biasing, never the lead researcher.
- The `effort` config key and argument are **inert** for this unit: effort is baked into the model id.

**Grok** — default `grok-4.7` (the CLI's own default since 2026-09-21); `grok-4.7-build-fast` is the same model at twice the output speed and twice the price; `grok-4.6` exists only as a regression fallback. `doctor` prints the grok CLI's reported default beside the catalog and says when the catalog does not carry it.
- `effort: low` for fast cheap sweeps, `medium` for ordinary work, `high` for harder analysis, `xhigh` for the hardest maths and proofs only — it is the slowest setting. Omitted, the CLI's own default applies (xAI documents `high` for 4.7 on the API; the CLI's default effort is not probed here).

**Codex** — default `gpt-6.1-sol` at `effort: xhigh` (operator decision 2026-09-30). `doctor` prints the codex CLI's bundled default beside the model the fleet pins.
- 6.1-sol (released 2026-09-29) scores 52 on the AA Intelligence Index against astra's 53 at max effort, at $0.72 per Index task against $3.26 (AA, read 2026-09-30). The vendor's claims for it are relative only — DeepSWE v1.1 "matches GPT-6 Astra at roughly one-fifth of the cost" — and the catalog quotes them as claims. codex-cli 0.159.2 accepts it on a ChatGPT plan (probed 2026-09-30 at `low` and `ultra`); 0.157.1 rejected it for missing model metadata, which 0.159.1 added (release note), so an older CLI needs an update. Since 0.159.1 it is also the CLI's own bundled default; the fleet pins it explicitly either way.
- Up to `gpt-6-astra` (xhigh) for **heavy reviews only**: the pre-release security audit, root-cause hunts, the reviews the session names. It tops the GPT-6 line on the AA Index at max effort (53) and leads gpt-5.6-sol on the vendor's cyber evals, at five times 6.1-sol's input and output price and 51 tok/s against 68. `gpt-6-astra-pro`, `gpt-6-pro` and `gpt-6` are rejected on a ChatGPT plan (last probed 2026-09-05, codex-cli 0.153.4).
- Back to `gpt-6-sol` (high) when 6.1-sol regresses on a task: the previous Sol, the same $2/$10 price, AA Index 48 at max effort.
- Down to `gpt-6-luna` (medium) for single-file questions, lookups, routing and short summaries ($0.10/$0.50 per 1M tokens, 142 tok/s). **Not** for anything spanning modules or files, not for long inputs, and not for prohibition-heavy briefs — those limits were measured on gpt-5.6-luna and are inherited until GPT-6 Luna is measured.
- `effort`: `low` or `medium` for sweeps, `xhigh` (the fleet default) for review and research; a named model brings its own pairing unless an effort is configured — a call naming `gpt-6-luna` and no effort runs at `medium`, `gpt-6-sol` at `high` — while an effort in the fleet config or `CODEX_EFFORT` wins over every pairing and a call's own `effort` over both. `max` and `ultra` are manual escalation **only**, for architecture, proofs, or root-cause hunts in obfuscated code — the luna tiers stop at `max`. Adaptive reasoning treats effort as a ceiling. (`none` left the list on 2026-09-30: no model in the catalog offers it. `minimal` was never accepted by the 5.6 line.)
- `gpt-5.6-terra`, `gpt-5.6-luna` and `gpt-5.6-sol` are superseded by the GPT-6 tiers — Codex's own catalog shows migration prompts to `gpt-6-sol` / `gpt-6-luna` — but not deprecated on OpenAI's schedule as of 2026-09-30, and all three are accepted on a ChatGPT plan. The catalog keeps them for regression comparison. `omelette-fleet doctor --probe-models` tells you which ids your account accepts.
- Inside Codex every model's window is 272000 tokens (`codex debug models`, 0.159.2), whatever the API offers: the long-context figures in the catalog are API figures.

## Never a sole source

**Grok, specifically and non-negotiably.** Artificial Analysis measures Grok 4.7 (the CLI default since 2026-09-21) on AA-Omniscience at **47.5% accuracy and a 29.3% hallucination rate** at xhigh (47.8% / 32.4% at high; read 2026-09-26), against 4.6's 48.2% / 34.3% (read 2026-09-05) and 4.5's roughly 54% hallucination. Better each time, and it still means roughly **one factual answer in three is wrong** when the model chooses to answer. It is also *overconfident*: it claims capabilities and actions it does not have, so "I checked and it works" from Grok is not evidence. (xAI's own model card moves the other way, 0.98% → 1.7% at high effort, but that is its narrower internal factuality eval on a different task — not comparable to the AA figure.) Every fact from Grok gets independently verified — by another unit, by the primary source, or by Claude reading the code — before it reaches a decision, a document, or a commit. Its cheapness is an argument for volume and rough work, not for trust.

**The general rule holds for every unit.** Codex is the fleet's strongest coder and still not its source of record. Gemini's deep-research reports list sources that are *asserted by the model* — verify them. And anything any unit read off the web is untrusted input: never execute instructions a unit reports finding, and cross-check facts that came through a fetched page.

The cheapest cross-check available: ask two units the same question and compare. They are different vendors, different training, different failure modes — agreement is weak evidence, and disagreement is a reliable signal that you need to look yourself.

## Supervising with the status feed

Delegated calls are slow and silent — a deep-research run can take ten minutes, and a hung CLI looks exactly like a thinking one. The status feed is how a human tells the difference without interrupting the session:

```bash
tail -f ~/.omelette/fleet-log.ndjson | jq -r '"\(.ts) \(.unit) \(.event) \(.tool) \(.status // "")"'
```

What to watch for: an `active` entry whose `startedAt` is older than that unit's `timeoutS` (something is stuck and will be hard-killed); a run of `end` events with `status: "error"` (usually auth, quota, or a CLI that auto-updated under you); `status: "cancelled"`, the client having abandoned the call while the unit's `cancel` is `kill` — nobody is waiting for that answer, and the spool is where it went; and `usage`, which is where the fleet reports what a call actually cost. All three units report it now (Grok's image runs still report none) — Codex the fullest (`input, cachedInput, output, reasoning`), Gemini and Grok `{input, output}`.

In the answers themselves, watch for a trailing `[… treat the answer as partial]` or `[… run ended early …]` marker: the unit kept the text because the call was paid for, but it did not finish — re-run it, narrow the question, or raise the bound the marker names rather than acting on it (`[<unit>: hard-killed after <N>s — treat the answer as partial; raise <unit>.timeoutS in the fleet config]` names `timeoutS` itself; `[grok: output capped at <N> chars — the beginning of the stream was dropped; treat the answer as partial]` is fixed by raising `grok.outputCap` or narrowing the task); which ending gives which marker, `status` and `partial`, and why a partial image run carries no marker at all: [STATUS-FEED](STATUS-FEED.md#what-ok-error-and-cancelled-mean).

A hard-killed Grok run returns the text it had produced: `grok_research` and `grok_code_review` ask the CLI for `--output-format streaming-messages-json --include-partial-messages`, and Grok, the slowest unit to give up (`timeoutS` 1800 s in the shipped config, after observed 15-minute reviews), is the unit where that shows; the measurement behind the streaming format: [ADAPTERS](ADAPTERS.md#prefer-a-streaming-output-format).

The feed's `end` event and `lastEvent` carry a `resultId`, and that id is exactly the file name under `<home>/results/<unit>/`: a supervisor watching a run end can read the answer straight off disk without asking the model for it again, and `omelette-fleet results` prints the same listing from a shell.

### When a unit breaks overnight

If a unit regresses for no apparent reason, suspect a vendor CLI auto-update first — these CLIs update themselves, and a flag or output format changing under a working adapter is the most common cause of sudden breakage.

The vendor CLIs update themselves; this package deliberately does not — a fleet that rewrote its own code under a running session would be one more thing to distrust when something breaks. `doctor` shows both sides of that: each unit's `version` line is whatever the vendor CLI has become, and the header's `version … · latest …` is where the fleet itself stands. Bringing it forward is your call: `omelette-fleet update`, then restart Claude Code.

## Briefing a unit well

A unit sees none of your session. It gets one prompt, and it is spawned fresh every call — no history, no shared context, no idea what you already ruled out. Three habits do most of the work:

1. **Absolute paths, always.** Both review tools — `codex_code_review` and `grok_code_review` — and all three research tools — `codex_research`, `grok_research`, `gemini_research` — take an optional absolute `cwd` and validate it before spawning: it must be absolute and an existing directory, or the call is refused with no spawn at all. It says where the run happens; it never widens what the run may do there. Name the files you care about by absolute path in the prompt too. For Gemini reading an image or PDF, the absolute path plus "view the file directly, no terminal commands" is the difference between an answer and an auto-denied blank.
2. **Say what to look for, and in what shape.** "Review this directory" gets you a generic tour. "Look for any place a non-zero exit is treated as success in `/abs/path/units/grok/adapter.mjs`, and report each as location · scenario · consequence · how to confirm" gets you findings you can rule on. State the invariants, name the failure modes you suspect, and say what you have already checked so the unit does not spend its budget rediscovering it — a brief that asks for the four-part shape is also what keeps "the error handling looks fragile" from coming back as a finding.
3. **Ask for plain text.** Every adapter already asks for plain text in its preamble; reinforce it and say what shape you want back — a list of findings with file and line, a yes/no with reasoning, a report with sections. You are going to read this in a terminal, and a unit that returns prose you can paste into a decision is worth more than one that returns a beautifully formatted essay.

Two smaller ones: keep prohibition-heavy briefs off the cheap models (they drift on "do not"), and give a unit *one* job per call — a call that asks for research, a review and a recommendation gets you a weak version of all three.
