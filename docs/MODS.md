# Mods

The fleet pane: an optional Claude Code mod, shipped in this package, that draws the orchestrator, its sub-agents and the four units, and who is calling whom. Since 1.8.0 it also delivers the guard's answer (the same rendered script the settings hook runs), pins a guarded role's model to its definition, hands the handoff back as a `SessionStart` context entry when the settings hook did not and, if you switch it on, skips a compaction that has no fresh handoff. The pane itself still only reads.

| Question | Where |
|---|---|
| What does the pane show? | [What the pane shows](#what-the-pane-shows) |
| What do the pane's notes say about a pin, an effort flag, a refusal or a touched record? | [Pins, effort flags and refusals](#pins-effort-flags-and-refusals) |
| How does the mod refuse a call, and which script does it run? | [The guard delivery](#the-guard-delivery) |
| How does the handoff reach the session, and what does the compaction skip do? | [The handoff entry and the compaction skip](#the-handoff-entry-and-the-compaction-skip) |
| How do I install it, update it, remove it? | [Install, update and removal](#install-update-and-removal) |
| How do I open and close it, and what can I switch off? | [Commands and options](#commands-and-options) |
| What does it look like on a narrow terminal, with `NO_COLOR`, and what moves? | [Terminals](#terminals) |
| What does it look like in the desktop app, VS Code and on mobile? | [Desktop, VS Code and mobile](#desktop-vs-code-and-mobile) |
| What does it read, and what does it write? | [What it reads and writes](#what-it-reads-and-writes) |
| Can it block, rewrite or leak anything? | [What it never does](#what-it-never-does) |
| Which Claude Code build was it tested on, and what if mine differs? | [The tested build, and other builds](#the-tested-build-and-other-builds) |
| What comes after the pane? | [The road after](#the-road-after) |

## What the pane shows

One pane, three zones: a header line, the graph, the history. This is the graph at 53 columns, the narrowest width that draws it:

```
ctx 31% · 5h 11% · 7d 71%

┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ ⠋ coder-medium│ │ · tester      │ │ ⠋ reviewer    │
│ opus · medium │ │ sonnet · high │ │ opus · xhigh  │
│ Bash: npm test│ │ reported 3:10 │ │ Read models.js│
└───────┬───────┘ └───────┬───────┘ └───────┬───────┘
        └─────────────────┼─────────────────┘
             ┌────────────┴────────────┐
             │ ● orchestrator          │
             │ fable-5-2 · high · 31%  │
             └────────────┬────────────┘
        ┌─────────────────┼─────────────────┐
┌───────┴───────┐ ┌───────┴───────┐ ┌───────┴───────┐
│ · gemini      │ │ ⠋ grok        │ │ · codex       │
│ idle 12m      │ │ code_review   │ │ idle          │
│               │ │ grok-4.7 2:17 │ │               │
└───────────────┘ └───────────────┘ └───────────────┘

12:05:40 orchestrator → grok · code_review
12:04:52 coder-medium → orchestrator · report
12:04:10 orchestrator → coder-medium · Agent
```

| Part | What it says |
|---|---|
| Header | Context fill and the five-hour and seven-day windows. A figure the engine does not have is left out. The header has no cost: on a subscription it is the API price of the tokens, not a bill. |
| Box, line 1 | A state glyph and the role (the `omelette-` prefix dropped). |
| Box, line 2 | Model and effort (`claude-opus-5-5` reads `opus`). A unit shows its tool here. |
| Box, line 3 | What it is doing now (`Bash: npm test`, `Edit adapter.mjs`), or its state with a time (`reported 3:10`, `idle 12m`). A unit shows its model and the elapsed time. |
| Lines between boxes | Who called whom. Sub-agents above, the orchestrator in the middle, the units below. A line is bold and in the accent colour while the call is live; every other line is dim. |
| Sub-agent row | One row, as many boxes as the width holds (three at 53 columns, up to six). Running and waiting ones come first; the rest fold into a last box, `+N more`. A sub-agent leaves the pane 10 minutes after it reported; the history keeps its role. Forgetting runs while the pane ticks, so a pane opened again drops at once whatever reported more than 10 minutes before. |
| History | The newest links first, as many as the pane's height leaves under the graph (on a short terminal pane that can be one; the desktop shows at least three): time, caller, callee, tool. Kept for the session, the last 200. A unit called from a sub-agent is marked `← coder-medium`. |

State glyphs:

| Glyph | State |
|---|---|
| spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`; ASCII `\|/-\`) | Running: a call or a model step is in flight. The frame is bold and in the accent colour. |
| `·` | Idle: a unit with no call, or a sub-agent that stopped and reported. |
| `◌` | Waiting: an agent the engine holds (on its own background work, a plan's approval) or lists as idle without a stop, for example a teammate waiting for a message. |
| `●` | The orchestrator. |

With `animate` off the running glyph is a still `▶` and the frame keeps its accent colour. With the pane closed, one status-line entry says the same in short while anything runs (`fleet: coder-medium, grok 2:17`) and nothing when all is idle.

### Pins, effort flags and refusals

Four things the mod does draw as one dim line each under the graph (the newest six, with a `+K more notes` line above them), or under the agent's name in the narrow tree:

| Note | What it says |
|---|---|
| `coder: pinned opus → claude-opus-5-5` | The spawn asked for a model the role's definition does not name, and the mod set the definition's. A toast `pinned <role> to <id>` came with it. |
| `coder: effort max (definition says xhigh)` | A guarded role's step reported an effort other than its definition's, once per agent. Nothing was changed; a toast `effort <x> on <role> (definition says <y>)` came with it. |
| `touched: <file> — <n> files` | The touched record the guard wrote when the agent stopped ([CONFIG](CONFIG.md#the-touched-reports)); shown on a reported agent, and cut to its file name and count when the line is too long. |
| `refused` | Not a note: the activity of a loop whose call the guard refused, for one tick. |

The pane keeps two counts per day in its own state, for the measurement and not drawn: refusals by delivery (the mod's), and pins. A spawn the engine answered with another model (a session that forces one sub-agent model outranks the hook) is not counted as a pin; it gets one toast saying so.

## The guard delivery

The mod hooks `tool.call` for `Bash`, `Write`, `Edit` and `NotebookEdit` and asks the rendered guard script about the call, before the engine runs it. It finds the script at `.claude/hooks/omelette-guard.mjs` in the session's directory, else in the user's `$HOME`, runs it with `node` (looked up in the absolute entries of `PATH` only) with the call as a `PreToolUse` event on stdin, and waits at most 2 s. Exit 2 refuses the call, the script's stderr — stripped of ANSI escapes and control characters, 2 KB at most — being the reason the model reads. **Any other outcome lets the call go on**: another exit code, a timeout, no rendered script (said once, `guard v2: no rendered script — omelette-fleet rules --hooks`), no `node` (said once). The mod has no rule of its own and refuses nothing the script does not.

The call goes to the script for the main thread too, with `agent_type` only when the pane knows the loop's role (the script's curated-file rules apply to every caller, its git and fence rules to the six roles). When the settings hook is wired as well, the mod answers first and a refusal reaches the hook never, so a call both would refuse is refused once, with the same text. What the script refuses: [ORCHESTRATION, "Guard v2: the rules"](ORCHESTRATION.md#guard-v2-the-rules); why running a project's script is the designed answer: [SECURITY, "Wiring, and what the guard is not"](SECURITY.md#wiring-and-what-the-guard-is-not). The guard is containment for the sub-agent roles, not a security boundary. `doctor`'s `guard` line names which of the two deliveries is wired: [ORCHESTRATION, "The two deliveries"](ORCHESTRATION.md#the-two-deliveries).

## The handoff entry and the compaction skip

- **The entry.** The mod adds the print as a `SessionStart` context entry when the settings hook did not (the hook prints on `compact` and `clear`; the mod covers startup, resume, or no hook wired): on every source it reads the context the hooks beneath it returned, adds nothing when an entry there starts with the print's marker line, `--- omelette-fleet · read before continuing ---`, and otherwise runs the same script as a `SessionStart` on `clear` (5 s) and appends its text — the open ledgers' last handoffs, the decisions register's tail and the backlog's first table, under the guard's 12 KB. One copy by construction; empty output, a failed run or no rendered script adds nothing, and nothing reaches a sub-agent.
- **The skip, off by default.** With the `handoffGate` option on, a manual or automatic compaction of the main conversation is skipped once (the plugin config menu calls the option "Refuse a compaction"; the mechanism is the engine's `{ skip }`), with the notice `no handoff in the last 30 minutes: write one, then compact again`, when the newest open ledger has no fresh handoff; the next attempt within 10 minutes goes through. What fresh means and the fenced-heading caveat: [CONFIG, "Handoff settings"](CONFIG.md#handoff-settings). A sub-agent's own compaction, a plugin's and a precompute pass are never skipped.

## Install, update and removal

The package root (the folder with `package.json`) is a folder marketplace. The terminal reads the mod from it in place; the desktop app runs its own Claude Code and loads the copy cached at install. `omelette-fleet rules --mods` prints these commands and writes nothing. The CLI never writes Claude Code's settings.

```bash
claude plugin marketplace add <package root>
claude plugin install omelette-fleet@omelette-fleet
```

| Task | How |
|---|---|
| Try it for one session, nothing installed | `claude --plugin-dir <package root>/mods/omelette-fleet` |
| Update | Update the package (`git pull` in a checkout, or `omelette-fleet update`). In the terminal, run `/reload-plugins`: the folder is read in place, so the reload loads the new mod. The desktop app keeps its cached copy until the version changes: run `claude plugin marketplace update omelette-fleet` and `claude plugin update omelette-fleet@omelette-fleet`, then restart the app. |
| Remove | `claude plugin uninstall omelette-fleet@omelette-fleet` |
| The package root moved | A folder marketplace points at a path. An npx cache or a version-manager prefix changes that path on an update, which breaks the marketplace: run `claude plugin marketplace add <new package root>` again. |

The mod is optional. The units, the CLI, the rules file and the guard hook work the same with or without it.

## Commands and options

| Command | What it does |
|---|---|
| `/omelette-fleet` | Opens the pane at any width. |
| `/omelette-fleet close` | Closes it. |

At session start the mod asks for the pane unasked. Claude Code seats it on its own only on a wide terminal (144 columns, or 110 once you have opened it yourself).

| Option | Default | Effect |
|---|---|---|
| `autoOpen` | `true` | `false` stops the pane opening at session start. The command and the status-line entry stay. |
| `animate` | `true` | `false` turns all motion off: no spinner, no fast tick, no moving lines on the desktop. The accent frames stay. |
| `handoffGate` | `false` | `true` skips a manual or automatic compaction once while the newest open ledger has no handoff block of the last 30 minutes (a date-only heading counts for its whole day); the next attempt within 10 minutes passes. |

All three are rows in Claude Code's plugin config menu. Defaults are also listed in [CONFIG](CONFIG.md#the-fleet-pane-mod).

## Terminals

| Case | What you get |
|---|---|
| 53 columns or more, and tall enough | The graph above. |
| Fewer than 53 columns, or too short for the graph | The same actors as an indented tree, two lines each. The orchestrator first, then the sub-agents, then the units. |
| `NO_COLOR` set, or `TERM=dumb` | ASCII frames and glyphs (`+ - \|`, the `\|/-\` spinner — or `>` with `animate` off — for running, `*` for the orchestrator). A running box is marked by its glyph alone, since there is no colour. |
| Motion | The spinner turns at a 250 ms tick, only while something runs and only on a pane the terminal draws. With nothing running the tick is one second, so an idle session pays nothing extra. |

The layout is computed from the pane's own width, never the terminal's, and re-runs when it changes. Every string is cut by cells with an ellipsis.

## Desktop, VS Code and mobile

The same model is drawn as one SVG: boxes, real lines (a sub-agent's call to a unit is routed around the orchestrator), the live ones in the accent colour. The SVG's alt text is the terminal graph, and the history follows as text lines.

Live lines run as a dashed stroke from caller to callee, and a running box's frame pulses. Both are CSS animations inside the SVG. They are off under `prefers-reduced-motion` and when `animate` is `false`.

## What it reads and writes

| Reads | From |
|---|---|
| Agents, their models and efforts, tool calls, hand-backs | The engine's own events (`agent.spawn`, `turn.step`, `tool.call`, the sub-agent stop) |
| Agents it never saw spawn (after a reload or a resume), and each agent's status (a held agent or an idle teammate reads as waiting) | `$.agent.list()`, at each `session.start`, at open and with the status feed, at most every 2 s, and, while the pane is closed and an agent runs, from the orchestrator's own model requests, at most every 5 s |
| Context fill and the rate-limit windows | `$.session.usage()` and the engine's measure event |
| A unit's model, start time, and calls made by other sessions (shown as `← other`) | The units' status snapshots, `status-<unit>-<pid>.json` under `$OMELETTE_HOME` (default `~/.omelette`), schema 2. See [STATUS-FEED](STATUS-FEED.md). |
| The rendered guard script, to run it | `.claude/hooks/omelette-guard.mjs` in the session's directory, else the user's `$HOME` copy |
| Each guarded role's `model:` and `effort:` | `.claude/agents/<role>.md` in the project, else the user's `$HOME`, read once per session, for the pin and the effort flag |
| The open ledgers, for the gate | `.omelette/ledger-*.md`: the `branch:` header and the last `## Handoff` heading; one `git show-ref` per ledger that names a branch (2 s) |
| A stopped agent's touched record | `.omelette/reports/touched-<role>-<id8>.md`, read for the pane's note, never written by the mod |
| `CLAUDE_CODE_EFFORT_LEVEL` | The environment, at session start, for one notice when it is set |

Snapshots that cannot be read are handled quietly. No fleet home, a malformed file or a schema other than 2 makes the unit's box say `no feed`; this session's own calls still show. A snapshot with a call in `active[]` and an `updatedAt` older than 2 hours reads as idle: the mod spawns nothing, so it cannot ask whether the process is alive.

It writes only its own pane state (`$.state`, so a reload redraws from it, and the time of the gate's last skip). It writes no file and sends nothing over the network. It spawns two kinds of process and no others: `node` on the rendered guard and for the print, with an environment of the absolute `PATH` entries only, and `git show-ref` for the gate, with the engine's default environment; each runs under a clock.

## What it never does

- **It refuses no tool call of its own.** The only refusal it answers is the guard script's exit 2 ([The guard delivery](#the-guard-delivery)); every failure of its own, and every other outcome of the script, lets the call go on. A hook that fails is skipped by the engine and the session goes on.
- **The one thing of its own it holds back is a compaction.** With `handoffGate` on, `session.compact` returns `{ skip }` once for a manual or automatic compaction of the main conversation ([The handoff entry and the compaction skip](#the-handoff-entry-and-the-compaction-skip)); no tool call and nothing else is held back.
- **It rewrites two things and no more.** A guarded role's `model` at spawn, to its definition's, and the `SessionStart` context, where it adds the handoff's entry when the settings hook's is not there. The rest of an event goes on unchanged.
- **It draws no raw text.** Every state string is cleaned of terminal control characters (C0 and C1 controls, DEL, bidi controls) before it is drawn, and XML-escaped in the SVG.
- **A command line stays off the pane.** A Bash command shows its program, and for a short list of programs (`git`, `npm`, `node`, `docker` and a few more) one plain next word — the subcommand or the script's name. Flags, paths, environment assignments and everything after those one or two words are never shown. Whatever stands in those one or two places does show, quotes removed: a secret typed as the program's name or as that next word (`python3 'hunter2'`) would reach the pane; nothing else in a command line does.
- **It touches no setting.** It does not edit `settings.json`, the rules file or the guard. It runs the guard and never writes it.

The history records call attempts. A call that another hook refuses further down the chain still appears, because the pane sees the attempt, not the result; a call the mod's own guard refused shows `refused` for one tick.

## The tested build, and other builds

Tested on Claude Code **2.1.317**. The plugin API is early access: its declaration file grew from 13 186 to 20 422 lines between 2.1.277 and 2.1.289.

On another build the event shapes may differ. The hooks then fail and the engine skips them: the pane may be empty or not open, and nothing else changes. If the pane misbehaves after a Claude Code update, update the package and `/reload-plugins`. The release gate re-tests on the build of the day.

## The road after

1.7.0 refused, rewrote and blocked nothing; 1.8.0 added the guard delivery, the pins and the handoff block. The slices that follow, each with its own spec:

| Slice | What |
|---|---|
| The gates | Tester after coder, the release commit's checks, reports checked as they are written. |
| Rules by event | Judgement rules handed to the model when they apply, and a smaller rules file. |
| Cost per task and role | Ledger lines from the session's measure. |

The full list is in the spec, [Out of scope and the road after](superpowers/specs/2026-10-04-1.7.0-fleet-pane-design.md#out-of-scope-and-the-road-after). The direction beyond 1.7.0, the fleet as one plugin, is in [the deterministic layer program](superpowers/plans/2026-10-04-deterministic-layer-program.md).
