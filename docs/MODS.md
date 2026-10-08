# Mods

The fleet pane: an optional Claude Code mod, shipped in this package, that draws the orchestrator, its sub-agents and the three units, and who is calling whom. It only reads.

| Question | Where |
|---|---|
| What does the pane show? | [What the pane shows](#what-the-pane-shows) |
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
             │ fable-5-1 · high · 31%  │
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
| Sub-agent row | One row, as many boxes as the width holds (three at 53 columns, up to six). Running and waiting ones come first; the rest fold into a last box, `+N more`. |
| History | The newest links first, as many as the pane's height leaves under the graph (on a short terminal pane that can be one; the desktop shows at least three): time, caller, callee, tool. Kept for the session, the last 200. A unit called from a sub-agent is marked `← coder-medium`. |

State glyphs:

| Glyph | State |
|---|---|
| spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`; ASCII `\|/-\`) | Running: a call or a model step is in flight. The frame is bold and in the accent colour. |
| `·` | Idle: a unit with no call, or a sub-agent that stopped and reported. |
| `◌` | Waiting: an agent the engine holds (on its own background work, a plan's approval) or lists as idle without a stop, for example a teammate waiting for a message. |
| `●` | The orchestrator. |

With `animate` off the running glyph is a still `▶` and the frame keeps its accent colour. With the pane closed, one status-line entry says the same in short while anything runs (`fleet: coder-medium, grok 2:17`) and nothing when all is idle.

## Install, update and removal

The package root (the folder with `package.json`) is a folder marketplace, and the mod is read from it in place. `omelette-fleet rules --mods` prints these commands and writes nothing. The CLI never writes Claude Code's settings.

```bash
claude plugin marketplace add <package root>
claude plugin install omelette-fleet@omelette-fleet
```

| Task | How |
|---|---|
| Try it for one session, nothing installed | `claude --plugin-dir <package root>/mods/omelette-fleet` |
| Update | Update the package (`git pull` in a checkout, or `omelette-fleet update`), then run `/reload-plugins` in the session. The folder is read in place, so the reload loads the new mod. |
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

Both are rows in Claude Code's plugin config menu. Defaults are also listed in [CONFIG](CONFIG.md#the-fleet-pane-mod).

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
| Agents it never saw spawn (after a reload or a resume), and each agent's status (a held agent or an idle teammate reads as waiting) | `$.agent.list()`, at open and with the status feed, at most every 2 s |
| Context fill and the rate-limit windows | `$.session.usage()` and the engine's measure event |
| A unit's model, start time, and calls made by other sessions (shown as `← other`) | The units' status snapshots, `status-<unit>-<pid>.json` under `$OMELETTE_HOME` (default `~/.omelette`), schema 2. See [STATUS-FEED](STATUS-FEED.md). |

Snapshots that cannot be read are handled quietly. No fleet home, a malformed file or a schema other than 2 makes the unit's box say `no feed`; this session's own calls still show. A snapshot with a call in `active[]` and an `updatedAt` older than 2 hours reads as idle: the mod spawns nothing, so it cannot ask whether the process is alive.

It writes only its own pane state (`$.state`, so a reload redraws from it). It writes no file, spawns no process and sends nothing over the network.

## What it never does

- **It refuses, rewrites and blocks nothing.** Every hook hands the engine's event on unchanged. A hook that fails is skipped by the engine and the session goes on.
- **It draws no raw text.** Every state string is cleaned of terminal control characters (C0 and C1 controls, DEL, bidi controls) before it is drawn, and XML-escaped in the SVG.
- **A command line stays off the pane.** A Bash command shows its program, and for a short list of programs (`git`, `npm`, `node`, `docker` and a few more) one plain next word — the subcommand or the script's name. Flags, paths, environment assignments, quoted values and everything after the first word or two are never shown. A secret typed as that plain next word would show; nothing else in a command line does.
- **It touches no setting.** It does not edit `settings.json`, the rules file or the guard.

The history records call attempts. A call that a guard or another hook refuses further down the chain still appears, because the pane sees the attempt, not the result.

## The tested build, and other builds

Tested on Claude Code **2.1.294**. The plugin API is early access: its declaration file grew from 13 186 to 20 422 lines between 2.1.277 and 2.1.289.

On another build the event shapes may differ. The hooks then fail and the engine skips them: the pane may be empty or not open, and nothing else changes. If the pane misbehaves after a Claude Code update, update the package and `/reload-plugins`. The release gate re-tests on the build of the day.

## The road after

Not in 1.7.0: anything that refuses, rewrites or blocks. The slices that follow, each with its own spec:

| Slice | What |
|---|---|
| Guard v2 and the handoff delivery | The mod asks the existing guard script; after a compaction the last ledger handoff is handed back to the session. |
| The gates | Tester after coder, the release commit's checks, reports checked as they are written. |
| Rules by event | Judgement rules handed to the model when they apply, and a smaller rules file. |
| Cost per task and role | Ledger lines from the session's measure. |

The full list is in the spec, [Out of scope and the road after](superpowers/specs/2026-10-04-1.7.0-fleet-pane-design.md#out-of-scope-and-the-road-after). The direction beyond 1.7.0, the fleet as one plugin, is in [the deterministic layer program](superpowers/plans/2026-10-04-deterministic-layer-program.md).
