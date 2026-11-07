# Orchestration

How to run a session with a fleet: who decides, who proposes, and which unit gets which task.

| Question | Where |
|---|---|
| Who's in charge, and what do the units actually do? | [The operating model](#the-operating-model) |
| How does the operating model actually reach a running session? | [How the rules reach a session](#how-the-rules-reach-a-session) |
| What does the contract every unit sends say, and when does it change? | [Layer 1: the contract](#layer-1-the-contract) |
| When does a server send the one-line contract instead of the full one? | [Layer 1: the contract](#layer-1-the-contract) |
| Which files does `rules` write, what will it refuse to overwrite or remove, and when does my session see each one? | [Layer 2: the rules file and its marker](#layer-2-the-rules-file-and-its-marker) |
| How do I print the commands that install the fleet pane mod? | [Layer 2: the rules file and its marker](#layer-2-the-rules-file-and-its-marker) |
| What does the guard hook do, and how do I wire it? | [Layer 3: the guard](#layer-3-the-guard) |
| What does guard v2 refuse, rule by rule? | [Guard v2: the rules](#guard-v2-the-rules) |
| Who answers when the settings hook and the mod are both wired? | [The two deliveries](#the-two-deliveries) |
| Why does `doctor` say the guard is NOT wired? | [What doctor says about the wiring](#what-doctor-says-about-the-wiring) |
| Where do the rules go in a monorepo, and what about an existing AGENTS.md? | [Monorepos and AGENTS.md](#monorepos-and-agentsmd) |
| How should work be delegated once I'm inside a session? | [Inside Claude Code](#inside-claude-code) |
| May the session skip the flow for a one-line fix? | [When the session does the work itself](#when-the-session-does-the-work-itself) |
| How does a finished branch reach main? | [How a branch reaches main](#how-a-branch-reaches-main) |
| How do I keep a plan from getting lost across a compaction? | [Ledger and handoff](#ledger-and-handoff) |
| What are a handoff block's six fields, and what is the compaction skip? | [Ledger and handoff](#ledger-and-handoff) |
| Who tests the coder's work, and who decides test vs. code? | [Tester sub-agent and arbitration](#tester-sub-agent-and-arbitration) |
| What is the tester's second pass, and when do I send it? | [Tester sub-agent and arbitration](#tester-sub-agent-and-arbitration) |
| `/omelette-test` is refused under auto mode. What now? | [Under auto mode: the manual dispatch](#under-auto-mode-the-manual-dispatch) |
| What does a review finding have to look like? | [Reviews](#reviews) |
| What does the reviewer's brief ask for, and what does the session do with the labels? | [Reviews](#reviews) |
| Which sub-agent runs a review, and what keeps it read-only? | [Reviews](#reviews) |
| How do I trust a report or a code map without re-reading the code? | [Evidence with pointers](#evidence-with-pointers) |
| What does a planner, a coder or a plan reviewer get handed? | [What each agent is handed](#what-each-agent-is-handed) |
| When is a scout map worth taking? | [The scout map, when a fresh planner needs one](#the-scout-map-when-a-fresh-planner-needs-one) |
| How do I control a sub-agent's model and effort? | [Spawning sub-agents: model and effort](#spawning-sub-agents-model-and-effort) |
| Should a role's model be the exact id or the alias, and what did the alias resolve to? | [Spawning sub-agents: model and effort](#spawning-sub-agents-model-and-effort) |
| What does the mod pin, flag and say about a spawn's model and effort? | [Spawning sub-agents: model and effort](#spawning-sub-agents-model-and-effort) |
| Which model and effort does each shipped role run on, and why? | [Effort by role and model](#effort-by-role-and-model) |
| Is Claude Code's advisor worth attaching to a role? | [Effort by role and model](#effort-by-role-and-model) |
| Which model and effort did a sub-agent actually run, and how do I probe it? | [Effort by role and model](#effort-by-role-and-model) |
| The tester stopped at its turn limit. What now? | [When the tester runs out of turns](#when-the-tester-runs-out-of-turns) |
| Which unit should a given task be routed to, and when does a security review go to Mistral? | [Routing by task](#routing-by-task) |
| When should I escalate to a stronger model or higher effort, and which Mistral alias is the default? | [Model and effort escalation](#model-and-effort-escalation) |
| How much should I trust a unit's claims on their own (Grok's one in three, Mistral's three of nine)? | [Never a sole source](#never-a-sole-source) |
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

**Layer 1 — the contract, automatic.** Every unit server returns a short contract from the MCP `initialize` handshake (`InitializeResult.instructions`), and Claude Code puts it in the session's context as "MCP Server Instructions". Install a unit and it is there, with no user action: the units propose and the session applies, absolute paths and one job per call, no unit is a source of record and Grok least of all, plus one line saying what that particular unit is for. It is under ten lines on purpose. With `contract=auto` (the default) a server sends only a one-line short contract, plus the unit's own line, once a rendered rules file is found, in the project or globally; without one it sends the full text. `contract=short` and `contract=full` decide it outright: [CONFIG, "The contract, and why auto is the default"](CONFIG.md#the-contract-and-why-auto-is-the-default). Like every other server change, it takes effect on the next Claude Code restart.

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
| `--mods` | Nothing: it prints the commands that install, update and remove the fleet pane mod ([MODS](MODS.md#install-update-and-removal)) and returns before any file is rendered or read; with `--remove` it is a usage error | — | — | — |
| `--dry-run` | Nothing: it prints every path and action, and for `--hooks` announces the settings snippet instead of printing it — a snippet naming a script that was never written is a snippet somebody pastes | — | — | — |

The file's first line is a version marker, and that marker is the only proof of ownership: a file is marked when that line matches, whole, the marker's text with any semver in the version slot — a file left by an older release is ours, and `doctor` reports the version it found; a line that merely opens like the marker is somebody else's file. All four managed kinds — the rules file, the agent definitions, the skill, the hook script — work exactly this way; only the comment syntax of the marker differs. What no flag can do — be triggered by a unit, write through a link, follow a planted temporary file: [SECURITY, "What this package never does"](SECURITY.md#what-this-package-never-does).

`doctor` reports each kind on one informational line, both scopes, and never counts a missing file as a fault; while something is missing from the project it adds ONE `next` line above the units, and nothing once all is done. Each line, and the `next` ladder in order: [INSTALL, "What doctor tells you"](INSTALL.md#what-doctor-tells-you).

`update` prints the exact refresh command when a marked file is behind the installed package, and also when a scope holds only some of a kind's files, whatever their version, on every path (`--check` included) (`… refresh: omelette-fleet rules --agents (2 of 4 missing)`) — it never rewrites the file for you.

### Layer 3: the guard

**Layer 3 — the guard, one script the operator wires up.** `omelette-fleet rules --hooks` writes `.claude/hooks/omelette-guard.mjs` and serves four events from it: on `PreToolUse` it exits 2 when the caller is one of the four roles this package ships — `omelette-coder`, `omelette-coder-medium`, `omelette-tester` or `omelette-reviewer` — and the command is a `git` write, and, since 1.8.0, on a write to a curated ledger file by any caller and on a write outside its report by the reviewer; on `PreCompact` it sweeps closed ledgers into the archive and stamps the ones left open; on `SessionStart` it sweeps again and, after a compaction or a `/clear`, prints the open ledger's handoff, the decisions register and the backlog's first table; on `SubagentStop` it records the files a guarded role wrote. The guard is containment for the sub-agent roles, not a security boundary. What it does on each event, its bounds and why: [SECURITY, "The guard hook"](SECURITY.md#the-guard-hook); the exact grammar of a `git` write: [SECURITY, "What the guard reads as a write"](SECURITY.md#what-the-guard-reads-as-a-write); the rules one by one: [Guard v2: the rules](#guard-v2-the-rules).

Since 1.5.0 there is no nudge, no held `Stop` and no summary written by the hook: the handoff block is the session's to write, and the guard sweeps, stamps and prints around it (the retired events: [SECURITY, "The guard hook"](SECURITY.md#the-guard-hook)).

A hook script is not a hook until something calls it, and **the caller lives in your settings, which this package reads and never writes**. So `rules --hooks` prints the snippet on every run and you merge it in yourself — into `.claude/settings.json` or `.claude/settings.local.json`, whichever you keep this kind of setting in. The CLI says as much above it: *"Merge this into your settings file (it is a whole hooks object — add the events it lists to an existing `hooks` block rather than replacing the file)"*. If you already keep hooks in that file, add these four events to the `hooks` block you have; pasting the snippet over the file would take the rest with it:

```json
{ "hooks": {
  "PreToolUse": [ { "matcher": "Bash|Write|Edit|NotebookEdit", "hooks": [ { "type": "command", "command": "node '/abs/path/.claude/hooks/omelette-guard.mjs'" } ] } ],
  "PreCompact": [ { "hooks": [ { "type": "command", "command": "node '/abs/path/.claude/hooks/omelette-guard.mjs'" } ] } ],
  "SessionStart": [ { "hooks": [ { "type": "command", "command": "node '/abs/path/.claude/hooks/omelette-guard.mjs'" } ] } ],
  "SubagentStop": [ { "hooks": [ { "type": "command", "command": "node '/abs/path/.claude/hooks/omelette-guard.mjs'" } ] } ] } }
```

The printed path is absolute and shell-quoted: a hook `command` is a command line rather than an argv, so a checkout under `~/My Projects` would otherwise paste a hook that runs `node /Users/you/My` and fails on every tool call. The quoting follows the platform the CLI runs on: POSIX single quotes on macOS and Linux, double quotes on Windows, where `cmd.exe` would read single ones as part of the path — and the JSON layer then doubles that path's backslashes, `"node \"C:\\Users\\me\\.claude\\hooks\\omelette-guard.mjs\""`. Double quotes are a shell quoting, not an argv: under PowerShell or Git Bash a `$` in that path would expand, so a path holding one wants editing by hand — one more reason native Windows is not supported yet.

The guard is a *settings-level* hook on purpose: a `hooks:` block in an agent definition's own frontmatter did **not** fire on Claude Code 2.1.261 — no log line, `git commit` went straight through — while the same hook in the project's settings did fire for the same sub-agent, blocked it with exit 2, and its stdin JSON carried `agent_type: <the sub-agent>` (and no `agent_type` at all for the main thread). Measured 2026-09-06; that measurement is why the guard is keyed on `agent_type` rather than declared in the definition.

### Guard v2: the rules

Guard v2 (1.8.0) is the same script with more rules; each is one row group in `test/hooks.test.mjs`, and that table is the contract for both deliveries. The mechanics, bounds and residuals are SECURITY's ([The guard hook](SECURITY.md#the-guard-hook)); here is what each rule says.

- **A heredoc body is text.** `<<WORD`, `<<-WORD` (tabs allowed before the terminator), `<<'WORD'` and `<<"WORD"`: the lines up to the terminator carry no git word. A quoted body is text wholly; an unquoted body's `$(…)` and backquotes are still read as commands. The operator line's continuation (a backslash-newline), a `#` as the delimiter, the `$'EOF'` form and a CRLF terminator are read as the shell reads them. `EOF text` or `  EOF` is not a terminator, and a heredoc with none runs to the command's end.
- **Quotes hide no git word, subcommand or global option.** `"git" commit`, `git "commit"` and `git "-C" /x commit` are `git commit`.
- **The curated files are appended to, never rewritten, for every role and the main thread.** Those are `.omelette/ledger-*.md`, `.omelette/backlog.md`, `.omelette/decisions.md` and the file the register's `register:` line names. A Bash command that truncates one is refused — a redirection `>`, `>|`, `<>` or `&>`, `tee` without `-a`, `sed -i`, `perl -i`, `sort -o`, `mv` or `cp` onto one, `truncate`, `rm` — also behind the wrappers `env`, `nice`, `sudo` and a few more; appends (`>>`, `tee -a`), reads and `git mv` pass. So is a `Write` that is not an append (nothing there yet, or content starting with the file's current bytes). `Edit` is the harness's own business: it refuses a file that moved since your read. To replace one on purpose, move it first.
- **The reviewer writes one file.** On `Write`, `Edit` and `NotebookEdit`, `omelette-reviewer` is refused anything but `<name>-review.md` directly in `<cwd>/.omelette/reports/`, compared through the project's real path (a symlinked `.omelette` or `reports` is refused). The fence is the definition's own sentence made mechanical; the session's `git status --porcelain` check after the review stays.
- **The touched record.** When a guarded role stops (`SubagentStop`), the guard reads its transcript and writes `.omelette/reports/touched-<role>-<first 8 of the agent id>.md`: every path it wrote through `Write`, `Edit`, `NotebookEdit` or a Bash command the guard reads as a write, and a tally of its tool calls. Nothing is refused and nothing is printed; the session opens it beside the report's `## DIFF`.
- **The stamp carries facts.** `PreCompact` appends `## Compaction <ISO> (trigger: <manual|auto|unknown>) — branch <b> · HEAD <h> · <n> dirty files — re-read this ledger before continuing`. Each fact comes from one git call (2 s, absolute PATH entries only) and is `unknown` when the call fails or the value is not a plain name; `<n>` counts every line of `git status --porcelain`, so an `.omelette/` that is not in `.gitignore` is counted among the dirty files.
- **A command too deep to read is refused whole.** One whose brackets spend 1 MiB of scanning gets `TOO_DEEP` (`command too deep to read (over 1 MiB of bracket scanning) — split it, or write the file with Write`), for every caller; split it or use `Write`.

### The two deliveries

One script, two ways its answer reaches the engine. The **settings hook** is the script on `PreToolUse` (`Bash|Write|Edit|NotebookEdit`), `PreCompact`, `SessionStart` and `SubagentStop`: exit 2 and a line on stderr refuse a call. The **mod** ([MODS](MODS.md)) hooks `tool.call` for the same four tools and runs the same rendered script (`.claude/hooks/omelette-guard.mjs`, the project's first, then the user's `$HOME`) with `node` from the absolute entries of `PATH`, under 2 seconds: exit 2 becomes the call's refusal with the script's line as its text, and anything else — another exit, a timeout, no script, no `node` — lets the call go on. The mod hands the script `agent_type` when its pane knows the loop's role and nothing on the main thread, so the script's own role gate decides.

**The mod answers first**: a denial never reaches the settings hook, so a call both would refuse is refused once, with the same text. A session without the mod, or one run headless, gets the settings hook alone, which is why both exist. `doctor`'s `guard` line says which is wired, and says a stale installed mod carries no guard ([What doctor says about the wiring](#what-doctor-says-about-the-wiring)).

### What doctor says about the wiring

`doctor` reads **both** files of a scope — `settings.json` and `settings.local.json`, and the global pair under `$CLAUDE_CONFIG_DIR` or `~/.claude` — and reports the **union**: a guard wired half in `settings.json` and half in `settings.local.json` reads as wired, which is what it is; reading only the first would report a guard wired in the file a project usually gitignores as inert. It matches on the script's *name* inside the command string rather than on an exact path, so quoting it (the printed snippet does), wrapping it or keeping it elsewhere still reads as wired. The line is `wired: PreToolUse, PreCompact, SessionStart, SubagentStop`, or `NOT wired` with the most specific reason it found — an unreadable settings file or a matcher aimed elsewhere wins over the plain list of missing events:

| `doctor` prints | When |
|---|---|
| `NOT wired — paste the snippet from rules --hooks` | no event calls the script |
| `NOT wired (missing SessionStart) — …` | a guard wired the 0.3.2 way: the events nobody calls are named, since that is what has to be pasted. A snippet merged before 1.8.0 reads `NOT wired (missing SubagentStop) — …`: add that group |
| `wired: PreToolUse (Bash only — re-merge the PreToolUse group for Write/Edit), …` | a `PreToolUse` entry that sees `Bash` and not `Write` (the pre-1.8.0 matcher): the git rule and the Bash half of the curated rule run, the `Write` half and the reviewer's fence do not; re-merge the group with the matcher `Bash|Write|Edit|NotebookEdit` |
| `guard         settings hook wired (PreToolUse Bash\|Write\|Edit\|NotebookEdit, SubagentStop) · mod omelette-fleet enabled, installed 1.8.0 — the mod answers first` (a line of its own) | the two deliveries, each half as it stands. The settings half reads `not wired (…, re-merge the PreToolUse group)` when no entry sees `Bash`. The mod half reads `installed X, not enabled`, `enabled, not installed`, or `enabled, installed X (package Y): stale — reinstall, or the second delivery is absent`: the terminal reads the mod's folder in place, the desktop app a copy cached by version, and a stale cache carries no guard. `doctor` reads the settings files and the plugin index and never says "loaded": the CLI cannot see what a session loaded. No line when neither half exists |
| `NOT wired (settings.local.json unreadable) — …` | a settings file exists but cannot be parsed — named rather than counted, because sending an operator to re-paste something already there is the wrong advice |
| `NOT wired (PreToolUse matcher is not Bash) — …` | the entry's matcher cannot see a `Bash` call, so it guards nothing and yet looks installed from every other angle; a finding only while an event is still missing — once the scope's two files together wire every event, some other entry already sees the call |
| `NOT wired (PreToolUse matcher "(" is not a valid regex) — …` | the pattern does not compile: a typo in the settings file and a guard aimed at another tool are fixed differently |
| `NOT wired (PreToolUse matcher is not a string)` | the matcher is not a string at all |
| `NOT wired (SessionStart matcher is not compact)` | the matcher is `startup` alone; `compact` and `startup|compact` are wired, and an absent matcher — what the snippet prints since 1.7.3 — is wired |
| `project SessionStart misses startup, resume, clear — replace the SessionStart group with the snippet from omelette-fleet rules --hooks` (a line of its own) | a snippet merged before 1.7.3 (replace its `compact` group rather than adding beside it: both in one file run the guard twice after a compaction, since identical handlers are deduplicated across settings files only): `compact` alone still prints after a compaction, but the sweep waits for one and nothing is printed after a `/clear`. It names the scope (`project` or `global`) and lists the missing sources among `startup`, `resume`, `clear`, `compact` |
| `v<version> (…) [run: omelette-fleet rules --hooks]` | the rendered script is behind the package: a script rendered before 1.8.0 prints its `SessionStart` text as plain stdout, which the mod cannot see, so with the mod live it adds its own entry beside it and the session reads two copies until the script is re-rendered |
| `hook imports <path>/core/ledger.mjs — not found: run omelette-fleet rules --hooks` (a line of its own) | the package that rendered the guard moved or was removed: the sweep is skipped, the stamp and the print go on, until the guard is rendered again |
| `wired: PreToolUse, PreCompact, SessionStart, SubagentStop · PostToolUse, Stop, PostCompact wired but no longer used — remove them from your settings files` | all four live events are wired and an entry still calls the guard on a retired event; never a reason the guard reads as unwired. With a live event missing the same leftover rides on the `NOT wired (…)` line instead |

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

- One line per event, appended as it happens — not reconstructed afterwards from memory that has already been compacted. Open it with `omelette-fleet ledger open <plan>`, which writes `branch: <the current branch>` on its second line: the ledger belongs to that branch — open while it exists, closed once it is deleted, and never closed when headed `branch: main`, `master` or `trunk` ([CONFIG](CONFIG.md#ledgers-and-the-decisions-register)).
- **Every decision as `Ruling: <what> — <why> — <cost if wrong>`.** The third field is the one that pays for itself: it is what tells a later reader whether to revisit the call or leave it alone.
- **A decision that outlives its plan is marked when it is written: `Ruling(binding): …`.** Three criteria, all three: it outlives the plan, it constrains future work, and the cost of being wrong is named. One line of about 200 characters, with a pointer (`path:line` · `` `fragment` ``, before the marker or at the end of the line) where there is one. Nobody triages later — the sweep copies the marked lines into the decisions register when the branch is gone and judges nothing; a plain `Ruling:` stays in its ledger, which is the right place for most of them.
- Tasks marked complete **with their commits**, so the ledger and the branch name the same checkpoints.
- **Close a plan with its review yield.** One line, `review yield: <findings> found / <accepted> accepted / <rejected> rejected (wrong <n> / intentional <n> / didn't matter <n>) — <the two or three that mattered>`. The split says why a finding was refused: the reviewer was wrong, the code does it on purpose, or it was true and changed nothing. It is the cheap measure of what the reviews were worth; keep it honest.
- Before a compaction — announced or merely suspected — and at every natural pause, append a **handoff block**, `## Handoff (<date> — <title>)`, with six fields in this order, each a line that opens with its bold label: **State** (branch, HEAD, tree, what is done), **Open findings** (unruled, by pointer), **Agents in flight** (their ids and what each holds), **Gotchas** (what will bite the next reader, three lines at most), **Tried** (the `tried:` lines still worth knowing) and **Next action** (one sentence, then the step after it). Write it as if the reader has none of your context, because they do not. The print shows the block as written and never checks its fields: a block with fewer still prints.
- **Write a dead end as a `tried:` line** when an approach is abandoned or confirmed: `- <date> tried: <approach> — failed | succeeded — <why, one clause>`. A session after a compaction does not walk the same path; the handoff's **Tried** field repeats the ones still open. The sweep ignores `tried:` lines: they stay in their ledger.
- After a compaction or a `/clear`, **read three things, in order, before doing anything else**: the open ledger's last handoff (where did we stop), the decisions register (what is decided and still binds), the backlog's first table (what is next). The guard prints all three, so the read is a paste rather than a search. Acting first and reading second is how a plan silently forks.
- **Compact within a goal, `/clear` at its boundary.** When a release is out or a new plan is next, the orchestrator writes the handoff, saves what the operator said in chat and the ledger does not hold, and suggests `/clear`. Every request of a long session carries its whole context, an automatic compaction summarises on its own terms, and a fresh session that reads the ledger carries exactly what was written — and shows at once what was not. At the boundary the merged branch is deleted, and the next session start sweeps its ledger into the archive.
- **Provenance apart from trust, and demote-not-delete.** Every line carries what it is — a unit's claim, a coder's report, a tester's run, the orchestrator's own check — and a claim is `candidate` until the orchestrator verified it, then `verified` or `rejected`. Two independent seats reporting the same thing is still two candidates. A ruling that turned out wrong is not edited: it stays, and a `Superseded by: <new ruling>` line follows it, so the next reader sees the decision, the reversal and its cost instead of a clean page that hides a lesson. (The vocabulary is borrowed from NexusMem's provenance/trust-state split and its hash-only tombstones — https://github.com/yaminbkk/NexusMem — which is the one idea from that project this model adopts.)

Location: `<project>/.omelette/ledger-<plan>.md`, with `.omelette/` in `.gitignore`; closed ledgers live in `.omelette/archive/`, and the register in `.omelette/decisions.md` or the file its first line names.

`omelette-fleet rules --hooks` mechanises the fragile step, and it is a backstop, not the discipline: it sweeps closed ledgers on every session start, stamps a re-read line into the open ones when a compaction happens, and prints the open ledger's handoff, the register and the backlog's first table into the session that opens after a compaction or a `/clear`, but it cannot write the handoff block you did not write. **Both halves read `<session cwd>/.omelette/ledger-*.md`** — the directory the session is running in, not the repository the plan is about. A ledger kept in another checkout gets neither the stamp nor the print, and an orchestrator working across repositories keeps the ledger where the session is. What each event does, its bounds and what 1.5.0 removed: [SECURITY, "The guard hook"](SECURITY.md#the-guard-hook); the two-row version the rules file points at: [CONFIG, "The handoff hooks"](CONFIG.md#the-handoff-hooks).

**The stamp, the print and its two deliveries (1.8.0).** `PreCompact` appends `## Compaction <ISO> (trigger: <t>) — branch <b> · HEAD <h> · <n> dirty files — re-read this ledger before continuing` to each ledger left open: facts a reader can check against the repository, never a summary ([Guard v2: the rules](#guard-v2-the-rules) has how each is read). The print after a compaction or a `/clear` reaches the session by one of two paths. The settings hook's `SessionStart` answers as one JSON document, `hookSpecificOutput.additionalContext`, led by the line `--- omelette-fleet · read before continuing ---`, on `compact` and `clear` only. The mod adds the print as a `SessionStart` context entry when the settings hook did not (startup, resume, or no hook wired): on every source it runs the same script as a `clear` start (the guard's 12 KB cap applies) unless an entry the marker leads is already there, so the session reads one copy by construction, and nothing reaches a sub-agent. A script rendered before 1.8.0 prints plain text with no marker, which the mod appends as it is: re-render with `rules --hooks`, and read `doctor` for a script behind the package.

**The compaction skip, off by default.** The mod's option `handoffGate` ([CONFIG, "Handoff settings"](CONFIG.md#handoff-settings)) skips a manual or automatic compaction of the main conversation once, with `no handoff in the last 30 minutes: write one, then compact again`, when the newest open ledger has no fresh handoff; the next attempt within 10 minutes goes through. A heading is **fresh** when its date is today's and, if it carries a time (`## Handoff (2026-11-03 14:05 — title)`), that time is within 30 minutes; a date-only heading counts for its whole day, which is why a block written under the gate carries the time. The gate reads the **last** `## Handoff (` heading anywhere in the ledger, a fenced code block included, while the guard's print skips a fenced heading: a handoff heading written inside a fence makes the two disagree about which block is last.

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

**Under Claude Code's auto permission mode the skill does not run.** The harness refuses the injection before the fork — `` Shell command permission check failed for pattern "!`git -C "$1" diff HEAD`" `` (2026-09-17, reported to Anthropic) — so in that mode the mechanism is the manual dispatch, and it is the documented first path there: the orchestrator spawns `subagent_type: omelette-tester` with the spec's path and a diff it took itself — `git add -N` for the new files so they appear, then `git diff HEAD` saved to a file the brief points at — and never a summary, which is the one rule the skill exists to enforce. Every 1.6.0 tester was dispatched this way. As of 1.8.0 (2026-11-04) the skill still injects with `!`, so auto mode still refuses it. The program plan dropped the W0 spike and moved the mechanised form, G2, to 1.11.0 as a mod command that takes the diff itself; until it ships the manual dispatch is the path ([plan](superpowers/plans/2026-10-04-deterministic-layer-program.md), "Backlog items absorbed").

## Reviews

**A finding has four parts, or it is a question.** Every review brief asks for, and every finding is recorded as, `location · scenario · consequence · how to confirm`. The orchestrator rules on each: `verified`, `rejected (reason)` or `needs-check (what)`, in the ledger.

**First review clean, re-review continued.** The first review of a change runs with a clean context — no coder summary, no earlier findings. A re-review after a fix round is briefed with the previous findings and the rulings on them, so it verifies the fixes instead of rediscovering the file.

**The review brief, in full (1.8.0).** The reviewer's stance is to read to break confidence in the change, not to confirm it. It lists the **attack surface** first — the inputs, the states, the callers, the files beside the ones changed — and a finding earns its place when it answers four questions: what input or state, what happens, who is hurt, how to confirm. One strong finding beats three weak ones, and an inference is marked as one. After its four parts each finding carries `confidence: 0–1`, `important | nit`, `introduced | pre-existing`, and `seen: <n>` when the same class of defect recurs on the branch: the pointer is the example, the count says whether it is a pattern, and the class is named so the fix covers every instance. A section `## DECLINED TO JUDGE`, before the verdict, lists what the reviewer saw and chose not to rule on, one line each, `none` when none; the session rules on each line. **The spec's silence is not permission**: a finding is judged by its effect on the operator, not by whether the spec names the trigger.

**What the session does with a review.** The dispatch's **BASE** — the commit the coder builds on — is written in the ledger line before the coder starts, and a re-review gets the diff `base..HEAD`, never `HEAD~1`: a fix round can span several commits. **A brief never pre-judges**: no "do not flag X", no "nothing above minor" — the reviewer finds, the session rules. **A coder fixes `important` + `introduced` findings only**; a `nit` or a `pre-existing` one goes to the ledger as one line and to the release's whole-branch review, and the final review of a release gets **one fix dispatch** for all its findings, not one per finding. The plan's `review yield:` line splits what was rejected into `wrong`, `intentional` and `didn't matter` ([Ledger and handoff](#ledger-and-handoff)). A coder's report lists every red test it saw in the full run, its own or not, as a pointer line, and its `## FINDINGS` stops at about ten lines with the details in the report file.

**Since 1.8.0 the reviewer's one file is enforced, not only stated.** Where the guard is wired, `Write`, `Edit` and `NotebookEdit` by `omelette-reviewer` are refused for anything but `.omelette/reports/<name>-review.md` ([Guard v2: the rules](#guard-v2-the-rules)). The session's `git status --porcelain` check after every review stays: a Bash write by the reviewer is read by the curated and git rules only.

**The shipped reviewer.** `omelette-fleet rules --agents` writes `omelette-reviewer` — the clean-context second reader on our own model, the Opus review 1.2.0 briefed by hand, now a definition (`model: claude-opus-5-5` and `effort: xhigh` by default, tools `Read, Grep, Glob, Bash, Write`, `disallowedTools: Agent, Edit, NotebookEdit`). One spawn is one review of one thing: a plan, a task's diff or a branch. Its brief carries the base and head (or the file) and the spec's path, and, for a re-review only, the earlier findings and the rulings on them. It reads what it reviews, runs the suite when the brief says so, and reports findings only, ranked, each `location · scenario · consequence · how to confirm` with the location as a pointer line `omelette-fleet check` can verify, then one verdict line: `ship`, `do not ship` or `needs-check`. The report goes to `.omelette/reports/<name>-review.md`; the reply is the verdict line and the count. The Routing table's code-review row stays Codex: this adds a reader, it replaces none.

**Read-only by definition and by check, not by enforcement.** Claude Code's tool filtering cannot scope `Write` to one path or make `Bash` read-only, and the guard refuses the git commands it names and, since 1.8.0, the reviewer's `Write`, `Edit` and `NotebookEdit` outside its report. So the definition says the only file the reviewer writes is its report; the guard refuses its `git commit`, `stash`, branch creation and `worktree` by name, as it does the coder's, and its `reset --hard`/`--merge`/`--keep`, `update-ref` and writing `symbolic-ref`, which move HEAD or a ref and leave the tree clean; and the session runs `git status --porcelain` after every review and rejects the review outright if anything but that report changed, and compares `git rev-parse HEAD` and `git symbolic-ref -q HEAD` from before the review with their values after it (two branches at one commit would otherwise hide a switch). The check sees what git sees: `git status --porcelain` lists tracked and untracked paths — not ignored ones, and not a moved HEAD, which is what the `rev-parse` comparison is for. The report itself lives in the ignored `.omelette/`, and a write elsewhere under an ignored path is not caught (containment, not enforcement).

## Evidence with pointers

Delegation multiplies reading: four planners re-read the same modules, and a report in free prose has to be taken on faith or re-derived. The answer is a funnel — explore once, pass compact evidence up — with one guard against the funnel's own failure: a digest that cannot be checked turns one agent's mistake into everyone's premise. So evidence is written as **pointer lines**, and a command verifies them.

```
- `core/unit.mjs:540` · `const finish = (text, isError` · finish() closes the status entry and spools the record
```

`path:line` — relative to the project root, never absolute, one line and not a range · a **verbatim fragment** of that line in backticks — at least 8 characters and a run of three letters or digits, no backtick inside it · the claim, which is not optional. Quote, never paraphrase: paraphrase is where mistakes enter. A line that opens like a pointer and does not parse is `malformed`, and a fragment too short or without a run of three alphanumerics proves nothing and is `weak` — both fail, because evidence that silently stops counting is the failure this shape exists to prevent. Everything else is prose and is ignored.

| Piece | What it is |
|---|---|
| **Report shape** | `omelette-coder` and `omelette-tester` write their full report as `## TASK`, `## FINDINGS` (pointer lines), `## DIFF`, `## TEST RESULTS`, `## OPEN QUESTIONS`; the short reply is unchanged. |
| **`omelette-fleet check <file.md>`** | Verifies every pointer: `ok`, `moved` (the fragment is on another line — the nearest is named, ties to the smaller line number), `mismatch`, `missing`, `outside` (absolute, leaves the project root, a symlink, not a regular file), `too-large`, `weak`, `malformed`, and `stale` when the file changed since the map's `commit:` — committed or not. Exit `0` when every pointer is `ok` — `stale` too, unless `--strict` — and there is at least one distinct pointer (`--require <n>` moves the floor; `--require 0` is for a report whose findings say `none`); `1` otherwise; `2` for a usage error. `--strict` also fails on a staleness that could not be checked, including a `commit:` value that is not a plain hash. Limits: a checked file of 1 MiB and 2000 pointer lines, targets of 2 MiB (`too-large`); a checked file over either of its two limits exits 2 as a usage error, and nothing is reported. The file you check may live anywhere (a report in a scratchpad); the paths it names are opened only when they resolve inside the root. git runs only when there is a `commit:` line — `git diff --name-only --relative <hash>`, against the working tree, in a built environment with lazy fetch, tracing, external diff and hooks shut off — and `check` writes nothing. |

How to use `check`: run it on a report before handing it on; re-take a `stale` or `moved` line rather than trusting it (a file whose timestamps moved while its content did not can read `stale` too — re-taking a line is a read, whereas refreshing git's index for you would be a write, and `check` writes nothing). A right pointer can still carry a wrong conclusion, which is why the claim is a third part and not a paraphrase.

### What each agent is handed

Reading is two thirds of what a sub-agent takes in, and the repetition is across agents, not within one ([MEASUREMENTS](MEASUREMENTS.md#where-a-sub-agents-context-goes)). So each agent is handed what its job needs, pointed at, and nothing it has to rediscover. The rules file says each of these in one line; this is the full text.

- **A planner gets its section.** Its brief carries the package's section of the spec and the pointers the session hands it; the plan's header lists what it read. When several packages are planned by fresh delegates, a scout map is the way to hand them the same reading once — see [The scout map, when a fresh planner needs one](#the-scout-map-when-a-fresh-planner-needs-one).
- **A coder gets its task, not the release.** Its brief carries the task's section of the plan and the pointers it needs, not the whole spec; the spec's path is there for the cases the plan did not settle. The brief also names which coder, by how much the section leaves to decide. **`omelette-coder-medium`** (`effort: medium`) when the section prints the exact text, the diff, the tests and the numbers they must print: the coder executes it, and on one plan-driven trial medium built the same behaviour as xhigh, which took 2.5× the cache reads and 3.6× the wall clock ([MEASUREMENTS](MEASUREMENTS.md#coder-effort-medium-high-xhigh-on-one-task), N = 1). **`omelette-coder`** (`effort: xhigh`) otherwise: a new thing with no written shape, debugging with no known cause, or a decision the brief *explicitly delegates* (decide X between A and B, report the trade-off) — effort buys depth on the decisions the brief hands over, not permission to guess. A brief that leaves a required decision open gets `NEEDS_CONTEXT` back at any effort: the coder template says so, and neither bucket changes it. The bucket and the reason for it go into the brief and into the task's ledger line.
- **The session reviews a plan by its header, task list and Self-Review.** The full plan file goes to a unit — `codex_code_review` or `grok_code_review`, with the spec's path and the plan's path, asking for four-part findings — and the session opens the pointers of the findings, not the file. The ledger records the findings and the rulings as for any review.
- **Pay for judgement, not for repetition.** Reviews, clean-context testers and arbitration are what the tokens are for; re-reading, re-running and re-deriving are where they are lost. A planner does not dry-run its plan: the review reads it, and the coder and the tester run it for real.

**Four more hand-offs, in full (1.8.0).**

**A plan's header and tasks name what they hold.** The header carries `Global constraints` (the spec's values, verbatim) and `Review focus` (the input classes no task's tests cover, each pointing at the task that should); each task lists `Consumes` (the names it reads) and `Produces` (the names it defines), so a reviewer can see what a task depends on without reading the others.

**A tester gets the spec and the diff from git, never a summary.** `/omelette-test` injects the working tree's diff at invocation; by hand it is the approved spec plus `git diff HEAD`, with new files added by `git add -N`. A summary tells the tester what the coder believed.

**A reviewer gets the spec and the diff, never the coder's report.** The brief carries the base and head (or the file), the spec's path and, for a re-review only, the earlier findings and the rulings on them. A first review runs clean.

**The touched record is read beside the report.** When a coder or tester reports, the session opens `.omelette/reports/touched-<role>-<id>.md` — the files its loop wrote, recorded by the guard from its transcript when it stopped — and compares it with the report's `## DIFF` by eye. A path in one and not the other is a question for the agent. A mechanical comparison is a later release's.

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

**What the mod adds when it is installed (1.8.0).** The `Agent` call's `model` is the one lever the definition does not control, and the mod closes it for the four roles. At `agent.spawn` it reads the role's definition (`.claude/agents/<role>.md` in the project, else the user's `$HOME`) and, when the call names a model that is not the definition's, rewrites it to the definition's id, with a toast `pinned <role> to <id>`. An alias of the same family is the definition's model, not an override: the mod's map is `opus` → `claude-opus-5-5`, `sonnet` → `claude-sonnet-5-5`, `haiku` → `claude-haiku-5-5`, `fable` → `claude-fable-5-1`, kept by hand beside the catalogs. A pin counts only when the engine's answer names the model: a session that forces one sub-agent model outranks the hook, and gets one toast saying so. A fork and a resume are not pinned. The operator changes a role's model with `set … && rules --agents`, as before. Effort is not in the spawn call, so the mod only **flags** it: the first step of a guarded role that reports an effort other than its definition's gets one toast, `effort <x> on <role> (definition says <y>)`, and a note in the pane; nothing is changed, because the definition's `effort:` is honoured by the engine and `CLAUDE_CODE_EFFORT_LEVEL` beats it. At session start, with that variable set, the mod says so in one notice: `CLAUDE_CODE_EFFORT_LEVEL=<v> is set: it overrides every agent definition's effort`. What the pane draws: [MODS](MODS.md#pins-effort-flags-and-refusals).

`omelette-fleet rules --agents` writes four of these next to the rules file:

- **`omelette-coder`** — `model: claude-opus-5-5`, `effort: xhigh`, `disallowedTools: Agent`, otherwise the default tools. Implements one task from the brief the orchestrator gives it (a file path or the text itself), follows the brief's test cycle, never commits (where the guard is wired it cannot, even when a brief asks), and cannot spawn anything.
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
| `omelette-tester` | `claude-sonnet-5-5` | `high`, plus the second pass | 1.6.1's measurement: one pass at `high` found 4 of 17 findings, the same agent continued with the second pass 13, one `xhigh` pass 10 at about twice the cost ([MEASUREMENTS](MEASUREMENTS.md#the-testers-effort-a-second-pass-and-an-advisor)). Anthropic's guidance for Sonnet 5.5 runs routine work at `high` or below and keeps `xhigh` for a measured gain |
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
| Math / STEM cross-check | **Grok** → `grok_research` or **Gemini** → `GPT-OSS 120B (Medium)` (Antigravity announced its removal for 2026-11-02; `agy models` still listed it on 2026-11-04) | Two independent non-Google/non-OpenAI voices for the same check; each model's figures are in its catalog (`grok_models`, `gemini_models`), dated there |
| Strongest code review, agentic terminal analysis | **Codex** → `codex_code_review` with an absolute `cwd` | The fleet's strongest reviewer, on `gpt-6.1-sol` at `xhigh` by default — AA Intelligence Index 52 against astra's 53 at max effort, at $0.72 per Index task against astra's $3.26 (AA, read 2026-09-30); reads, greps and runs read-only shell commands inside an OS sandbox |
| Research where the answer depends on running things | **Codex** → `codex_research` | The same default (`gpt-6.1-sol` at `xhigh`) and the same sandbox, plus web search, and it reports real token usage per call |
| Final pre-release security audit | **Codex** on `gpt-6-astra` (heavy reviews only) — pass `model: "gpt-6-astra"` | Leads gpt-5.6-sol on the vendor's own cyber evals (ExploitBench 100.0 vs 78.5, ExploitGym 42.4 vs 30.3). Five times 6.1-sol's input and output price and slower (51 tok/s against 68) — two or three runs per release, not one per PR |
| Security review by a model that reproduces | **Mistral** → `mistral_security_review`, then `mistral_security_repro` under `OMELETTE_ALLOW_REPRO=1` | Large 4 at thinking high found half the 2026-10-20 audit's key with no wrong claim, and with a sandboxed shell it ran the finding no read-only arm found. Repro works in a disposable clone under a kernel sandbox and returns a diff the session applies, or does not. macOS only |
| Tie-breaker when Grok and Gemini Flash disagree | **Gemini** → `Gemini 4 Argon (High)`; if agy refuses it, **Codex** → `codex_research` on `gpt-6.1-sol` | A third voice inside the fleet: a frontier Gemini of another generation than Flash's |
| Image generation | **Gemini** → `gemini_image`, **Grok** → `grok_image`, or **Codex** → `codex_image` (gpt-image-2) | All three save outside your project — a temp directory, or Grok's session directory — and return an absolute path you import by hand |
| Image-to-image editing | **Grok** → `grok_image_edit` | The only unit in the fleet that edits images |
| Architecture, planning, UI/front-end taste, long-horizon engineering | **Claude** (your session, or its sub-agents) | Grok is explicitly contraindicated for architecture and UI; Codex is a strong reviewer but not a source of record |
| Any file edit, git operation, deploy or publish | **Claude**, under your approval | The only mutating path. Units reject git/deploy intent before spawn and mostly cannot act on it anyway |
| A client timeout, a cancellation or a restart dropped an answer | **The same unit** → `<unit>_result` (no id = the newest, plus the last ten) | The answer was spooled before the response was sent, so it is on disk. Fetching it starts no run and costs nothing; re-asking the question pays for it twice |

Ask a unit's `<unit>_models` tool when you are unsure whether a task belongs on it at all — the catalogs carry "route to / route away" advice, not just ids.

## Model and effort escalation

The rules below come from the catalogs' own `GUIDE` strings. Omit `model` to keep the default (the fleet config's `model` for the unit if set; for Gemini, otherwise agy's own default); escalate deliberately, because on a subscription quota the cost is real.

**Gemini** — the example config pins `Gemini 3.8 Flash (High)` for delegated research and agentic work; the code sets no default (`DEFAULT_MODEL` is empty), so the operator's `gemini.model` or agy's own setting decides.
- Down to `(Low)` for quick facts, lookups and short summaries; `(Medium)` when High's latency or token overhead is unwanted. 3.8 deliberately spends more thinking tokens than the previous generation at the same price per token, so **dropping the effort level is the way to buy that back** — not paying High for routine work.
- Up to `Gemini 4 Argon (High)` where Flash falls short: multi-step automation and agent workflows (AutomationBench-AA 78 against Flash High's 60), terminal agents (Terminal-Bench 4.0 57 vs 20), hard knowledge and science research (HLE 57 vs 48, SciCode 62 vs 57, AA-Omniscience 42 vs 30 — fewer confident errors), and repository-level code (DeepSWE v1.1 77.9 on DeepMind's card, against GPT-6 Astra's 74.1). It is also the fleet's tie-breaker when Grok and Flash disagree. Argon is a code and agentic model, not a long-context one: its 1M window is shared by input and output, and nothing in the catalog now takes inputs past 1M tokens. PDF-heavy work (GDP.pdf 22 against GPT-6.1 Sol's 31) and the hardest software engineering (FrontierSWE v2 55.0 against Astra's 65.5) go to Codex. The AA figures are Argon at High, read 2026-10-14; `(Medium)` and `(Low)` are unmeasured and inherit High's profile. On a Google AI Pro subscription Argon's quota is small (operator, 2026-10-16): there it is a named one-call route like Claude via agy — never a sweep, a deep-research stage, `gemini.model` or the default. No tool refuses it; the rule is the caller's to keep.
- Long-context retrieval is **not** a reason to go up to Argon — AA-LCR 80 for Argon (High), level with Flash High's 81 (AA, read 2026-10-14).
- `Claude Opus 5.5 (High|Medium)` and `Claude Sonnet 5.5 (High|Medium)` run on Antigravity's separate Claude quota — the same generation as the fleet's own coder and reviewer, so they buy an independent read, not a stronger one. That quota is small (operator, 2026-10-03) where the Gemini pool is effectively unlimited: one named call per question, never a sweep, and `gemini_deep_research` refuses them (about five runs per call); `gemini_research` and `gemini_image` refuse a Claude id that is only the configured `gemini.model`. The refusals see only ids the fleet names: keep agy's own default model on `Gemini 3.8 Flash` — not Argon, whose quota on a Pro subscription is small too. Prefer Gemini for citation-heavy research (web grounding via agy is unverified for the Claude family). Sonnet's 2026-08-02 exclusion is lifted; neither is a fleet role.
- `GPT-OSS 120B (Medium)` is a corroborating voice for maths and vendor de-biasing, never the lead researcher. Antigravity announced its removal for 2026-11-02; on 2026-11-04 `agy models` still lists it and the catalog keeps the entry. It leaves the catalog when agy stops listing it.
- The `effort` config key and argument are **inert** for this unit: effort is baked into the model id.

**Grok** — default `grok-4.7` (the CLI's own default since 2026-09-21); `grok-4.7-build-fast` is the same model at twice the output speed and twice the price; `grok-4.6` exists only as a regression fallback. `doctor` prints the grok CLI's reported default beside the catalog and says when the catalog does not carry it.
- `effort: low` for fast cheap sweeps, `medium` for ordinary work, `high` for harder analysis, `xhigh` for the hardest maths and proofs only — it is the slowest setting. Omitted, the CLI's own default applies (xAI documents `high` for 4.7 on the API; the CLI's default effort is not probed here).

**Codex** — default `gpt-6.1-sol` at `effort: xhigh` (operator decision 2026-09-30). `doctor` prints the codex CLI's bundled default beside the model the fleet pins.
- 6.1-sol (released 2026-09-29) scores 52 on the AA Intelligence Index against astra's 53 at max effort, at $0.72 per Index task against $3.26 (AA, read 2026-09-30). The vendor's claims for it are relative only — DeepSWE v1.1 "matches GPT-6 Astra at roughly one-fifth of the cost" — and the catalog quotes them as claims. codex-cli 0.159.2 accepts it on a ChatGPT plan (probed 2026-09-30 at `low` and `ultra`). Since 0.159.1 it is also the CLI's own bundled default; the fleet pins it explicitly either way, because the unit runs with `--ignore-user-config` ([CONFIG, "Which unit actually uses which key"](CONFIG.md#which-unit-actually-uses-which-key)). An older CLI that lacks the model's metadata refuses it: the "When a ChatGPT plan refuses an id" bullet below.
- Up to `gpt-6-astra` (xhigh) for **heavy reviews only**: the pre-release security audit, root-cause hunts, the reviews the session names. It tops the GPT-6 line on the AA Index at max effort (53) and leads gpt-5.6-sol on the vendor's cyber evals, at five times 6.1-sol's input and output price and 51 tok/s against 68. `gpt-6-astra-pro`, `gpt-6-pro` and `gpt-6` are rejected on a ChatGPT plan (last probed 2026-09-05, codex-cli 0.153.4).
- Back to `gpt-6-sol` (high) when 6.1-sol regresses on a task: the previous Sol, the same $2/$10 price, AA Index 48 at max effort.
- Down to `gpt-6-luna` (medium) for single-file questions, lookups, routing and short summaries ($0.10/$0.50 per 1M tokens, 142 tok/s). **Not** for anything spanning modules or files, not for long inputs, and not for prohibition-heavy briefs — those limits were measured on gpt-5.6-luna and are inherited until GPT-6 Luna is measured.
- `effort`: `low` or `medium` for sweeps, `xhigh` (the fleet default) for review and research; a named model brings its own pairing unless an effort is configured — a call naming `gpt-6-luna` and no effort runs at `medium`, `gpt-6-sol` at `high` — while an effort in the fleet config or `CODEX_EFFORT` wins over every pairing and a call's own `effort` over both. `max` and `ultra` are manual escalation **only**, for architecture, proofs, or root-cause hunts in obfuscated code — the luna tiers stop at `max`. Adaptive reasoning treats effort as a ceiling. (`none` left the list on 2026-09-30: no model in the catalog offers it. `minimal` was never accepted by the 5.6 line.)
- `gpt-5.6-terra`, `gpt-5.6-luna` and `gpt-5.6-sol` are superseded by the GPT-6 tiers — Codex's own catalog shows migration prompts to `gpt-6-sol` / `gpt-6-luna` — but not deprecated on OpenAI's schedule as of 2026-09-30, and all three are accepted on a ChatGPT plan. The catalog keeps them for regression comparison. `omelette-fleet doctor --probe-models` tells you which ids your account accepts.
- **When a ChatGPT plan refuses an id.** The catalog lists what exists in the current generation, not what one account accepts. A refused id fails fast, before any work, with `The '<id>' model is not supported when using Codex with a ChatGPT account`. An older codex-cli refuses `gpt-6.1-sol` with that same message because it lacks the model's metadata, not because of the plan: update Codex. On 2026-09-30, on codex-cli 0.159.2, `doctor --probe-models` on the ChatGPT plan these probes run on accepted every id in the catalog (`gpt-6.1-sol` also at `ultra`); the same day, 0.157.1 had refused `gpt-6.1-sol` for lack of its metadata while accepting the other six. `gpt-5.6-sol` had been refused on 2026-09-03 (codex-cli 0.146.0).
- Inside Codex every model's window is 272000 tokens (`codex debug models`, 0.159.2), whatever the API offers: the long-context figures in the catalog are API figures.

**Mistral** — default `mistral-large-4-0-3` at thinking high, the unit default for `mistral_security_review` and `mistral_security_repro`. 11 aliases; effort is baked into the alias, and `effort` (`low`, `medium`, `high`, `max`) moves a call within the model's family (Large 4 offers low, medium, high; the GLMs low, high, max); a level the family lacks keeps the alias. Measured on the 2026-10-20 audit replayed on the 1.7.1 snapshot (read-only tools, one run): Large 4 gave 9 findings, 3 of the 6 keys, 0 wrong claims, 0 drifted pointers, in 12.6 minutes at $0 on the plan.
- `zai-glm-5-3-flash` is a free sweep and second opinion. Its pointers drift (2 of its 4 were off on the replay): verify them.
- `glm-5-3` and `mistral-medium-3.5` are named routes only, paid per token; `maxPrice` applies. `mistral-medium-3.5` is Vibe's silent fallback target: an answer that reports it when another model was requested is the fallback, and the unit withholds it.
- Billing: the plan covers the two $0 rows (Large 4 and GLM-5.3 Flash). `cost_usd` in the footer is Vibe's estimate from catalog prices; the console's Usage page is the bill. Whether the plan also covers the two paid rows is unknown until the operator reads the console.
- Repro and review are two tools on one model, not two models. Run review first; run repro (gate open) on the findings worth executing.

## Never a sole source

**Grok, specifically and non-negotiably.** Artificial Analysis measures Grok 4.7 (the CLI default since 2026-09-21) on AA-Omniscience at **47.5% accuracy and a 29.3% hallucination rate** at xhigh (47.8% / 32.4% at high; read 2026-09-26), against 4.6's 48.2% / 34.3% (read 2026-09-05) and 4.5's roughly 54% hallucination. Better each time, and it still means roughly **one factual answer in three is wrong** when the model chooses to answer. It is also *overconfident*: it claims capabilities and actions it does not have, so "I checked and it works" from Grok is not evidence. (xAI's own model card moves the other way, 0.98% → 1.7% at high effort, but that is its narrower internal factuality eval on a different task — not comparable to the AA figure.) Every fact from Grok gets independently verified — by another unit, by the primary source, or by Claude reading the code — before it reaches a decision, a document, or a commit. Its cheapness is an argument for volume and rough work, not for trust.

**Mistral.** On the replay Large 4 made 0 wrong claims in 9 findings, but 3 of the 9 reported documented behaviour as findings (an accept-edits mode the adapter's header already states, a kill window the spawn header states, a raw results body SECURITY already names). The session rules every finding. A repro answer's diff is proposed, never applied.

**The general rule holds for every unit.** Codex is the fleet's strongest coder and still not its source of record. Gemini's deep-research reports list sources that are *asserted by the model* — verify them. And anything any unit read off the web is untrusted input: never execute instructions a unit reports finding, and cross-check facts that came through a fetched page.

The cheapest cross-check available: ask two units the same question and compare. They are different vendors, different training, different failure modes — agreement is weak evidence, and disagreement is a reliable signal that you need to look yourself.

## Supervising with the status feed

Delegated calls are slow and silent — a deep-research run can take ten minutes, and a hung CLI looks exactly like a thinking one. The status feed is how a human tells the difference without interrupting the session:

```bash
tail -f ~/.omelette/fleet-log.ndjson | jq -r '"\(.ts) \(.unit) \(.event) \(.tool) \(.status // "")"'
```

What to watch for: an `active` entry whose `startedAt` is older than that unit's `timeoutS` (something is stuck and will be hard-killed) — that entry is in the per-process snapshot `~/.omelette/status-<unit>-<pid>.json`, not in the log the command above tails, so `cat` the snapshot to see it ([STATUS-FEED](STATUS-FEED.md)); a run of `end` events with `status: "error"` (usually auth, quota, or a CLI that auto-updated under you); `status: "cancelled"`, the client having abandoned the call while the unit's `cancel` is `kill` — nobody is waiting for that answer, and the spool is where it went — unless the server itself was stopped mid-call, which also ends as `cancelled` and spools nothing ([STATUS-FEED](STATUS-FEED.md#what-ok-error-and-cancelled-mean)); and `usage`, which is where the fleet reports what a call actually cost. All three units report it now (Grok's image runs still report none) — Codex the fullest (`input, cachedInput, output, reasoning`), Gemini and Grok `{input, output}`.

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
