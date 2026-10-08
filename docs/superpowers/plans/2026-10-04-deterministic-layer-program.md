# The fleet as one plugin — program plan (1.7.0 → 1.12.0)

Date: 2026-10-04, goal revised 2026-10-08. Starts the week of 2026-10-05. Ledger of the first release: `.omelette/ledger-1.7.0.md`. Each release gets its own spec and plan when its turn comes; this file fixes the order, the mechanisms and the decisions that are already made, and names what is still to be measured.

| Question | Where |
|---|---|
| What is the program for, and how is a release judged? | [The goal](#the-goal-one-plugin-one-install-line) |
| Which manual step goes in which release? | [What the plugin carries](#what-the-plugin-carries) |
| What is being moved off prose, and what is not? | [Every rule, classified](#every-rule-classified) |
| What is the one pattern every slice follows? | [The pattern](#the-pattern) |
| In what order, and what ships in each release? | [Releases](#releases) |
| What does each gate do, exactly? | [1.8.0](#180--guard-v2-pins-and-the-handoff-delivery), [1.9.0](#190--the-gates) |
| Which rules arrive by event, and what leaves the rules file? | [1.10.0](#1100--rules-by-event) |
| How does a project get only the parts of the model it needs? | [1.12.0](#1120--project-profiles) |
| What was already tried and retired? | [What the measurements already said](#what-the-measurements-already-said) |
| What can stop the program? | [Risks and stop conditions](#risks-and-stop-conditions) |
| What is measured, release by release? | [Measurements](#measurements) |
| What happens to the backlog's G1, G2, G3, W0 and N1? | [Backlog items absorbed](#backlog-items-absorbed) |

## The goal: one plugin, one install line

Revised 2026-10-08 (operator: the fleet should be a real tool, easy to install, configure and manage; "Будто мейк сенс" to this goal). The first draft's goal was "every rule that can be checked moves off prose"; that stays, as the means. The goal is that the whole fleet is **one Claude Code plugin** installed from this repository's marketplace:

```
/plugin install omelette-fleet --marketplace adxd-og/omelette-fleet
```

and that installing, configuring, updating and removing it are Claude Code's own actions, taken by the person, with nothing to merge by hand. At the end of the program the manual steps left are that line and each vendor CLI's own install and login (`agy`, `grok`, `codex`), which no plugin can do for them. Every release names the manual step it removes; a release that removes none says why.

The CLI stays, for three jobs: `doctor`, `call` / `results` / `check`, and the install for a person who does not take the plugin. "The CLI never writes Claude Code's settings" still holds: Claude Code installs the plugin on the person's word.

Today, from the README's quickstart, a first install is: clone; `install`; `rules --agents --hooks` from each project; merge the printed snippet into that project's `.claude/settings.json`; restart; `doctor`. A setting is `set key=value` followed by `rules --agents` again in every project; an update is `git pull`.

## What the plugin carries

| Piece | Today | In the plugin | Release | Open question |
|---|---|---|---|---|
| The pane | — | the mod | 1.7.0 | none |
| The marketplace | — | `.claude-plugin/marketplace.json` at the root | 1.7.0 (T1) | does `/plugin install … --marketplace adxd-og/omelette-fleet` work against the public repo — checked at 1.7.0's live gate |
| The three units | `install` registers `claude mcp add -s user` | the plugin's MCP servers (`${CLAUDE_PLUGIN_ROOT}/servers/<unit>.mjs`) | 1.8.0 | does a plugin's MCP server keep our env allowlist and billing scrub, and how does `doctor` tell a plugin registration from a CLI one — a spike before 1.8.0's spec |
| Guard and handoff hooks | snippet merged into settings by hand | the mod's hooks (guard v2) | 1.8.0 | which delivery answers when both are wired (already 1.8.0's) |
| Settings | `set` + `rules --agents` in every project | `userConfig` fields: rows in Claude Code's config menu; a change reloads the mod | 1.8.0 (units, handoff), 1.11.0 (roles) | which keys belong in the menu and which stay CLI-only |
| The four roles and `/omelette-test` | `rules --agents` per project | the plugin's `agents/*.md` and skill, then `agent.register` from config | 1.11.0 | a plugin agent's name is namespaced (`omelette-fleet:omelette-coder`?) — the guard and the rules name roles by bare name |
| The rules text | `rules` per project, 14 590 characters | `prompt.compose` / events from the mod; the rendered file only for CLI installs | 1.10.0 | none beyond 1.10.0's |
| Updates | `git pull` | `claude plugin update` | from 1.7.0 | the version on record vs `package.json` (T1 pins them equal) |
| Per-project choice | — | profiles | 1.12.0 | as written there |

The Usage tracker settings section (backlog, parked 2026-10-08) becomes an overview on top of this, not the place settings live.

## The pattern

1. **The mod is delivery, the package is logic.** A decision that refuses something lives in a plain Node script or a pure `.mjs` function this package tests under `npm test`; the mod calls it (`$.process.run`, 37–63 ms measured) or imports it. The guard's refusal logic stays the frozen script it is.
2. **Every gate has a classic fallback or fails open.** The API is early access. A gate the mod delivers either keeps its settings-hook delivery (the guard) or, when the mod is absent or its hook is skipped, the session falls back to the prose rule — never to a broken session.
3. **A refusal names the way out.** Every `{ deny }` and every `{ block }` says what is missing and the one action that satisfies it, and the person can always override (`/omelette-fleet allow <gate>`), because a gate that wedges the orchestrator costs more than the slip it prevents.
4. **Pure first.** State and decisions in pure `.mjs`, hooks thin, `claude plugin test` at the live gate, CI without Claude Code.
5. **A rule leaves the rules file only when its replacement has shipped and been seen to fire.**

## Every rule, classified

The rules file as rendered at 1.6.2 (14 590 characters, at its ceiling), by what a mod can do with each rule.

| Rule | Class | Where it goes |
|---|---|---|
| Sub-agents never commit, merge, stash, branch | **gate** (exists as a settings hook) | 1.8.0: the same script behind `tool.call` |
| The reviewer writes nothing but its report; check `git status` and HEAD after it | **gate** | 1.8.0: `tool.call` on its loop refuses a write elsewhere; 1.9.0: the tree is compared at its stop |
| Roles pinned by exact model id; effort from the definition | **gate + visible** | 1.8.0: `agent.spawn` pins the model; an effort that differs from the definition is flagged in the pane |
| Never export `CLAUDE_CODE_EFFORT_LEVEL` | **visible** | 1.8.0: a notice at session start when it is set |
| After a compaction, re-read the ledger | **delivered** | 1.8.0: the last handoff block as a `prompt.context` block |
| Before a compaction, write a handoff | **option, off by default** | 1.8.0: a `session.compact` skip — see the measurement below |
| The tester runs on every coder result, spawned by the orchestrator | **gate** | 1.9.0: at the commit and at the stop |
| The second pass, at once, in the same tester | **visible + by event** | 1.9.0: the pane's gates line; 1.10.0: the reminder arrives at the tester's first stop |
| Reports travel with pointers; `check` before trust | **automatic** | 1.9.0: `omelette-fleet check` runs when a report is written, its result handed to the session |
| Branch per feature; main is gated | **gate** | 1.9.0: a commit on main by the main loop is refused outside the lane |
| The small-change exception: at most 20 lines, with its test | **gate** | 1.9.0: a commit with no coder behind it and more than 20 changed code lines is refused |
| Keep a ledger from the first step of a plan | **gate** | 1.9.0: the first coder spawn on a `feat/` branch with no ledger is refused |
| Release: suite read before the commit, CHANGELOG dated, versions together, yield and live-gate lines, no home paths | **gate** | 1.9.0: `omelette-fleet gate`, called at the release commit and at the merge |
| At most 2–3 rounds, then escalate | **visible** | 1.9.0: a round counter per task in the pane |
| Arbitration first: test vs spec before any code is edited | **by event** | 1.10.0: handed to the session when a tester stops |
| A finding has four parts; first review clean, re-review continued | **by event** | 1.10.0: handed when a reviewer is spawned and when it stops |
| Grok: one answer in three is wrong — verify; units are never a sole source | **by event** | 1.10.0: handed when a unit call returns |
| Model and effort verified from the transcript | **gone** | 1.7.0: the pane shows them from the engine's events |
| `/omelette-test` takes the diff itself | **command** | 1.11.0: a mod command; the skill's shell injection goes |
| Cost per task and role | **automatic** | 1.11.0: ledger lines from `session.measure` |
| The session orchestrates and reviews; what goes to whom; when a delegate is justified; one job per delegate; pay for judgement | **prose, stays** | the rules file |
| The routing table; briefing a unit | **prose, stays** | the rules file |
| Ruling / candidate / verified / Superseded vocabulary | **prose, stays** | the rules file |
| Docs to a cheaper model; the lane's "what stays out" | **prose, stays** | the rules file |

Count: 11 rules become gates or automatic, 4 become visible, 4 arrive by event, about 10 stay prose. "All the rules on deterministic mods" is therefore not the goal; "no rule that can be checked is left to memory" is.

## What the measurements already said

- **Mechanical handoff nudges were retired in 1.5.0.** From 0.3.4 to 1.4.0 the guard measured the context, nudged, held one turn until a handoff was written and appended each compaction's summary to the ledger; over five compactions none of it rescued anything the session had not written itself (MEASUREMENTS). So the compaction skip ships **off by default**, as an option an operator can turn on, and is promoted only if a compaction without a fresh handoff is actually observed. What ships on is the delivery half that measurement kept: the handoff handed back after a compaction.
- **A task lead between the session and the coder cost 2.4–6× per task** (1.2.0 P4) and does not ship. The gates here add no agent: they are checks at events.
- **The watcher lag** of 5–10 minutes on a re-rendered agent definition (three measurements) is the reason `agent.register` is in 1.11.0.

## Releases

| Release | Week of | What ships | Refuses anything? |
|---|---|---|---|
| **1.7.0** | 2026-10-05 | the plugin folder, its delivery, the fleet model, **the pane** (graph, history, usage; terminal and desktop) | no |
| **1.8.0** | 2026-10-12 | **guard v2** (same logic, mod delivery), the reviewer's write fence, model pins at spawn, the effort flag, the handoff delivered after a compaction, the compaction skip as an option | yes — what the guard refuses today, plus a reviewer's stray write |
| **1.9.0** | 2026-10-19 | **the gates**: tester-after-coder, `omelette-fleet gate` for the release and the merge, the lane's 20 lines, main is gated, ledger-before-coder, `check` on reports, the reviewer's tree compared; the pane's gates line | yes — each with a person's override |
| **1.10.0** | 2026-10-26 | **rules by event**; the rules file loses what moved; the rent measured before and after | no |
| **1.11.0** | 2026-11-02 | `/omelette-test` as a mod command, roles registered from the mod, cost per task and role as ledger lines, the task-size label | no |
| **1.12.0** | 2026-11-09 | **project profiles**: `solo` / `standard` / `strict`, proposed by `init` from measurable signals, chosen by the operator, rendered by `rules` and subscribed by the mod | no — a lighter profile drops ceremony, never verification |

The manual step each removes: 1.7.0 none yet (it proves the marketplace install); 1.8.0 the settings snippet and `claude mcp add` (units and guard from the plugin); 1.9.0 none (it adds checks); 1.10.0 `rules` per project; 1.11.0 `rules --agents` per project and the re-render after a setting; 1.12.0 choosing what a project needs.

The weeks are an order, not a promise: each release starts when the one before it is released and has run for at least two working days on the operator's sessions.

### 1.7.0 — the pane

Spec `docs/superpowers/specs/2026-10-04-1.7.0-fleet-pane-design.md`, plan `docs/superpowers/plans/2026-10-04-1.7.0-fleet-pane.md` (five tasks). It proves the three things the rest stands on: the folder-marketplace delivery, the model fed by `agent.spawn` / `turn.step` / `tool.call` / `classic.SubagentStop`, and the CI/live test split.

### 1.8.0 — guard v2, pins and the handoff delivery

- **Guard v2.** A `tool.call` hook on `Bash` inside a loop whose agent type is one of the four roles hands the call to `hooks/omelette-guard.mjs` (stdin: the PreToolUse shape with `agent_type`) and answers `{ deny: <its stderr> }` on exit 2. The script and its test table are untouched; the settings hook stays wired and documented as the fallback, and a call both would refuse is refused once (the mod's answer comes first). Decision to take in its spec: whether the mod asks the script at all when the settings hook is present (`settings.read`), or always.
- **The reviewer's write fence.** `tool.call` on `Write` / `Edit` / `NotebookEdit` in an `omelette-reviewer` loop: refused unless the path resolves (`$.fs.stat(path, { resolve: true })`) under `.omelette/reports/` and ends in `-review.md`.
- **Model pins.** `agent.spawn` for the four roles: when the resolved model is not the definition's id, the hook returns the definition's (`{ model }`) and the pane notes it. The `agent.spawn` hook cannot set the effort (its input has none on 2.1.294), though the Agent tool now takes `effort` per call — the spec decides whether the rules ask for it; a `turn.step` whose effort differs from the definition's raises a flag in the pane and a notice, once per agent.
- **`CLAUDE_CODE_EFFORT_LEVEL`.** Read at session start; set → one notice naming the rule.
- **The handoff, delivered.** `prompt.context` gains one block with the last `## Handoff` of each ledger in the project (the bound and the reader are the guard script's own, run by `$.process.run`), after a compaction and a `/clear`; the SessionStart print stays as the fallback.
- **The compaction skip, off by default** (`userConfig.handoffGate: false`). On, a `manual` or `auto` compaction with no `## Handoff` newer than 30 minutes in the newest ledger is skipped once with the reason; the second attempt passes. Never on a `precompute`, never for a sub-agent's own compaction.
- **The units from the plugin.** The plugin's MCP servers start the three units; `install` stays for a CLI-only install, and `doctor` reports which registration is live (both wired is a warning, not two units). Starts with the spike named in What the plugin carries.
- **Settings in the config menu.** `userConfig` fields for the units' `enabled`, the handoff switch, the pane's `autoOpen`; written where Claude Code keeps plugin options, read by the mod and handed to the unit servers through their environment — the spec settles how the one config file and the menu stay one truth.
- Tests: the guard's table run through the mod's hook with the kit; the fence's path cases (a symlink out of the reports folder, `..`, a case alias); the pin on each role; the block's bound.

### 1.9.0 — the gates

Shared state, kept by the mod per session: for each coder agent, its last stop; for each tester, its stops and the messages sent to it; the files a coder's loop wrote.

| Gate | Fires on | Refuses when | Way out |
|---|---|---|---|
| **Tester owed** | the main loop's `git commit`; the turn's stop (`classic.Stop`, once per turn) | a coder role stopped and no `omelette-tester` stopped after it | dispatch the tester; or the person's `/omelette-fleet allow tester` (logged to the ledger as `tester skipped — <reason>`) |
| **Release gate** | `git commit` whose message starts `release:`; `git merge` into main; `git tag v*` | `omelette-fleet gate` exits 1: tree not clean, suite not green on this tree within the last 15 minutes (the gate runs it or reads the result the session saved), `package.json` and CHANGELOG not bumped together or undated, no `review yield:` line, no live-gate line, managed files not at the version, a home path in the diff | fix the named item; `allow release` |
| **Main is gated** | the main loop's `git commit` on the default branch | the branch is not `fix/…` merged by fast-forward — a direct commit on main | branch first; `allow main` |
| **The lane's 20 lines** | a commit on a `fix/` branch, or any commit with no coder stop since the previous commit | more than 20 changed lines outside docs and tests' fixtures (`git diff --cached --numstat`) | brief a coder; `allow lane` |
| **Ledger first** | the first spawn of a coder role on a `feat/` branch | no `.omelette/ledger-*.md` modified since the branch was created | write the ledger's first line |
| **Reports checked** | a `Write` under `.omelette/reports/` by a coder or tester loop, at its return | never refuses: runs `omelette-fleet check <file>` and hands the tally to the session at the agent's stop (`additionalContext`) | — |
| **The reviewer's tree** | an `omelette-reviewer` stop | never refuses: compares `git status --porcelain`, HEAD and the symbolic ref with those at its spawn and hands the session `review rejected: <what changed>` if anything but its report moved | — |

`omelette-fleet gate` is a CLI command of the package (the backlog's G1), usable without the mod and by CI; the mod only calls it. The pane gains one line: `gates: tester owed (coder-medium, 4m) · handoff 14m ago · round 2`.

### 1.10.0 — rules by event

Each rule below leaves the rules file and is handed to the session as `additionalContext` (or a `session.append` row) at the event where it applies, in the rule's own words:

| Event | Text handed over |
|---|---|
| a coder role stops | the tester flow's steps 1–3 (who spawns, the diff from git, the real runner) |
| an `omelette-tester` stops for the first time | "send the second pass at once, to the same tester"; then arbitration first |
| an `omelette-reviewer` is spawned / stops | the four parts of a finding; first review clean, re-review continued |
| a unit call returns (`grok_*`; any unit) | never a sole source; Grok's one-in-three; verify before it lands |
| a compaction ended | re-read the ledger (with the handoff block of 1.8.0) |

The rules file keeps the operating model, the routing table, the ledger vocabulary and a three-line pointer to what now arrives by event — and what it keeps when the mod is absent: `omelette-fleet rules` renders the full file unless the operator passes `--with-mod`, so an install without the mod loses nothing. Target: the `--with-mod` file at or under 9 500 characters; the rent per request measured before and after with the 1.2.0 tool.

### 1.11.0 — the command, the roles, the cost

- `/omelette-test <spec>` registered by the mod: it takes `git diff HEAD` itself (`$.process.run`), spawns `omelette-tester` with the spec and the diff, and sends the second pass at the first stop — the auto-mode failure of the skill's shell injection and "the second pass sent late" both go. This is the backlog's G2; the W0 Workflow spike is not run.
- `agent.register` for the four roles from the same templates the CLI renders; the rendered files stay as the fallback. The watcher lag goes.
- Cost per task and per role: at each coder / tester / reviewer stop and at each commit, one ledger line from the turn's usage and `session.measure`.
- The task-size label (`size: S|M|L` in a plan's task section, the backlog's G3) read by the command, which picks the lane, `omelette-coder-medium` or `omelette-coder`.

### 1.12.0 — project profiles

Added 2026-10-05 (operator: "пора делать какую-то автонастройку, где агент будет смотреть и принимать решение, какой паттерн юзать для проекта, и переносит только нужные части"). Today every install gets the same 14 590 characters of rules, four roles, the tester in two passes and three release reviews; an evening project pays the same rent and the same ceremony as this package. The profile is the answer, and it comes last because 1.10.0 makes it cheap: once rules arrive by event, a profile is the set of events the mod subscribes and the sections `rules` renders, not three hand-kept copies of one text.

- **Three profiles, in config** (`omelette-fleet set profile=solo|standard|strict`, default `standard` = the model as shipped today).
  - `solo`: ledger and handoff, the guard, one coder bucket; no tester sub-agent (the session runs the suite itself), no spec/plan documents, no release reviews, no tags.
  - `standard`: what 1.11.0 ships.
  - `strict`: `standard` plus `omelette-reviewer` on every task's diff, Codex `gpt-6-astra` before every release, a module-boundary section in the rules (which folders may import which), the lane closed (everything goes through the flow).
- **What no profile drops.** Nothing lands unverified (the session reads every delegated diff before it is committed); the tester, where it runs, gets the diff from git, never a summary; coder sub-agents never commit; the handoff before a compaction. A lighter profile removes ceremony, not the check — otherwise it is the self-confirming loop the program exists to avoid.
- **The decision is deterministic; the agent proposes.** `omelette-fleet init` (new; `doctor` prints the same line) computes the signals and prints the proposed profile with each signal's value: tests present and a runner in `package.json`/`pyproject`; CI config present; the package is published (`name` on a registry, a `release` workflow, tags); commit authors in the last 90 days; a deploy target (`Dockerfile`, `fly.toml`, `vercel.json`, …); files under version control. Thresholds come from real projects, not from this document: this repository, Omelette, and two small personal projects are measured first, the thresholds written into the 1.12.0 spec with those four rows. The operator confirms or overrides; the choice is written to config and the ledger line says which signals carried it.
- **Delivery.** `rules --agents --hooks` renders the profile's sections and roles; the mod reads `profile` from config at `session.start` and subscribes the profile's events (a `solo` install never sees the tester gate). An install without the mod is still complete: the rendered files carry the profile on their own.
- **Not in 1.12.0:** a model reading the code to judge its domain, automatic profile changes over time, more than three profiles. A profile that is wrong is changed by hand, in one command.

## Risks and stop conditions

- **The API moves** (13 186 → 20 422 declaration lines between two builds eight days apart). Each release re-runs the live gate on the build of the day; a release whose hooks no longer load is fixed before the next slice starts. If two consecutive builds break a shipped gate, the program pauses at the last release and the classic hooks carry the guard.
- **A gate wedges the session.** Every refusing gate has the person's `allow`, fires at most once per turn at the stop, and fails open when its check cannot run (a `$.process.run` that times out answers nothing). A gate that fires wrongly three times in a week is turned to "visible only" until its spec is revisited.
- **Latency.** A hook on every tool call of every loop: measured per release as added wall time per turn; over 150 ms per tool call on average stops the slice.
- **Two deliveries of one refusal** (the settings hook and the mod): 1.8.0's spec decides which answers, and `doctor` gains a line saying which is wired.
- **The rules file shrinks and the mod is absent**: `rules` renders the full text by default; `--with-mod` is the operator's explicit choice.

## Measurements

| Release | Measured | Row in MEASUREMENTS |
|---|---|---|
| 1.7.0 | hook time per tool call; the pane's redraw cost; whether the pane changed what the operator did (their word) | mod overhead |
| 1.8.0 | refusals by the mod vs by the settings hook over a release; pin corrections; compactions with and without a fresh handoff (the option's case) | guard v2 |
| 1.9.0 | each gate: times fired, times right, times overridden; commits that reached main without a tester before and after | gates |
| 1.10.0 | characters and tokens of rent per request, full file vs `--with-mod`; whether a rule handed by event was followed (the second pass's delay; findings in four parts) | rent, by-event |
| 1.11.0 | cost per task by role from the ledger lines; the Opus-or-Fable orchestrator question answered with them | cost |
| 1.12.0 | the four projects' signal rows and the profile each got; rent per request and ceremony steps per task by profile; profiles overridden by the operator and why | profiles |

## Backlog items absorbed

- **N1** (function hooks): this program. **N0** (the fill estimate against the engine's): done by the spike — `session.measure` gave the engine's own figures.
- **G1** `omelette-fleet gate`: 1.9.0. **G2** the task loop: 1.11.0's command. **G3** the size label: 1.11.0. **W0** the Workflow spike: dropped — the mod command answers the same question without a script.
- **The status-window idea** (July) and the backlog's "H, a status surface": 1.7.0's pane; the menu-bar app keeps reading the same feed.
- The doctor warning for a configured `gemini.model` (after 1.6.2), the two load flakes, the prompt-audit items 1, 2, 4, 5: not part of this program; they ride the lane or the release they fit.

## Working agreement for the program

Each release: spec approved by the operator (it names the manual step the release removes), plan, a coder per task, the hand-dispatched tester in two passes, three reviews, the live gate on the operator's machine, release notes that say what a session now cannot do that it could before. The orchestrator model per phase (Fable for specs and arbitration, Opus for plan-execution days) is tried on 1.7.0's execution and decided with 1.11.0's cost lines.
