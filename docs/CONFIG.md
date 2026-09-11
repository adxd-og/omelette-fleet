# Configuration

One file, read fresh on every call, and it can only ever *narrow* what a unit may do.

## Location

```
$OMELETTE_HOME/fleet.config.json      # OMELETTE_HOME set
~/.omelette/fleet.config.json         # default
```

`OMELETTE_HOME` also holds the status feed (`status-<unit>.json`, `fleet-log.ndjson`), the result spool (`results/<unit>/<resultId>.md`) and the update-check cache (`update-check.json`). The file is optional: with no file at all, every unit runs on built-in defaults, read-only, with no warnings. `omelette-fleet set` writes it atomically (temp file + rename) with mode `0600` and `"version": 1`.

## Shape

```json
{
  "version": 1,
  "updateCheck": true,
  "contract": "auto",
  "defaults": { "status": true },
  "agents": {
    "coder":  { "model": "opus", "effort": "xhigh" },
    "tester": { "model": "sonnet", "effort": "xhigh", "maxTurns": 80 }
  },
  "handoff": { "enabled": true, "threshold": 90, "contextWindow": 0, "compactSummary": true },
  "workflow": { "merge": "session" },
  "units": {
    "gemini": { "enabled": true, "mode": "read-only", "model": "Gemini 3.8 Flash (High)", "timeoutS": 300 },
    "grok":   { "enabled": true, "mode": "read-only", "timeoutS": 1800, "maxTurns": 30 },
    "codex":  { "enabled": true, "mode": "read-only", "model": "gpt-6-astra", "effort": "high", "webSearch": true, "timeoutS": 600 }
  }
}
```

`defaults` applies to every unit; `units.<unit>` overrides it for one unit. Both accept the same keys. `agents` is a separate top-level block that has nothing to do with the units — it configures the Claude Code sub-agent definitions this package ships, and is described [below](#agent-settings). `handoff` is the third top-level block and configures the guard hook's auto-handoff, described [below](#handoff-settings). `workflow` is the fourth, and it decides one sentence of the rules file — how a finished feature branch reaches main — described [below](#workflow-settings). A `version` higher than 1 is accepted with a warning — known keys still apply, unknown ones are ignored.

### Top-level settings

Some keys describe the fleet rather than any one unit, so they sit at the top level next to `defaults` and `units` and are resolved on their own:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `updateCheck` | boolean | `true` | Whether a unit server may check for a newer release at startup, and whether `doctor` / `update` report the latest version. See [Update check](#update-check) |
| `contract` | `auto` \| `full` \| `short` | `"auto"` | How much of the fleet contract a unit server returns from `initialize`. `auto` sends one line where the rendered rules file is already installed, and the full contract where it is not; `full` and `short` decide it outright |

An invalid value is a warning and the built-in default stays in force, exactly as for a unit's keys. Both keys are edited with a bare assignment — `omelette-fleet set contract=short` — and read back with `omelette-fleet show fleet`.

**The contract, and why `auto` is the default.** Every unit server returns `instructions` at `initialize` — text the client puts in the model's context at connect time — and until 0.3.7 that was always the full fleet contract: about 300 tokens, three servers, every session. Including the sessions whose project already carries `.claude/rules/omelette-fleet.md`, which states everything the contract states and a great deal more. Where that file is loaded, `auto` sends this instead, plus the unit's own line:

```
omelette-fleet: read-only unit; the operating model is in your rules file (.claude/rules/omelette-fleet.md, project or global) — the units propose, you apply.
```

The test is the marker on line 1 of `<cwd>/.claude/rules/omelette-fleet.md` — the directory Claude Code started the server in, which is the project — and then of the global file (`$CLAUDE_CONFIG_DIR` or `~/.claude`). A file at that path **without** our marker is somebody else's file and counts as absent, exactly as it does for `rules` and `doctor`. It is resolved **when the server starts**, so it moves on the same restart the rules file itself needs, and `doctor` prints what this project gets:

```
contract      short (rules installed here)
contract      short (rules installed globally)
contract      full (no rules file in /path/to/some/project)
contract      full (contract=full)
```

Set `contract=full` if you would rather every session carry the whole text — a session that starts somewhere without the rules file gets it anyway — or `contract=short` to send one line whatever is on disk, which is for an operator who knows their sessions load the operating model by another road.

### Agent settings

The `agents` block is the other top-level one, and it configures something different from everything else in this file: the two Claude Code sub-agent definitions `omelette-fleet rules --agents` writes into `.claude/agents/`. No unit reads it, and no vendor CLI ever sees it.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `agents.coder.model` | one printable line | `"opus"` | The `model:` line of `omelette-coder.md` |
| `agents.coder.effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | `"xhigh"` | Its `effort:` line — the only place a sub-agent's effort can be set |
| `agents.tester.model` | one printable line | `"sonnet"` | The `model:` line of `omelette-tester.md` |
| `agents.tester.effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | `"xhigh"` | Its `effort:` line |
| `agents.tester.maxTurns` | positive int | `80` | Its `maxTurns:` line — how many turns the tester gets before the harness stops it. It is honoured: the agent stops at the limit and the orchestrator is told it can continue it (measured 2026-09-06) |

The templates carry `{{model}}`, `{{effort}}` and `{{maxTurns}}` where those values go, and **`rules --agents` renders from the config as it is at that moment**. So a change here does not reach a session until you re-render:

```bash
omelette-fleet show agents                        # values and where each came from
omelette-fleet set agents.tester.maxTurns=120
omelette-fleet rules --agents                     # re-render; Claude Code's watcher picks it up —
                                                  # usually within seconds, sometimes minutes
```

The definition is refreshed at the same package version — the marker is the proof of ownership, and a changed value simply makes the content differ, so the run reports `written … (v0.3.1, was 0.3.1)` rather than pretending nothing happened. `set` prints the same reminder:

```
agents.tester.maxTurns  80 [default] → 120 [file]
  note: `omelette-fleet rules --agents` re-renders the definitions with the new value.
```

Validation is deliberately forgiving in one direction: an unknown agent, an unknown key or an invalid value in the file is a **warning**, and the built-in default is used — because the alternative is `rules --agents` refusing to write a definition the session needs. Through `set` the same mistakes are refused outright and nothing is written. There are no environment overrides for this block.

### Handoff settings

The `handoff` block configures the other managed file that is rendered rather than read at call time: the guard hook's auto-handoff, which asks for the `## Handoff` block once the session's context passes a threshold and holds one `Stop` until it is written.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `handoff.enabled` | boolean | `true` | `false` renders a guard whose `PostToolUse` and `Stop` handlers do nothing at all |
| `handoff.threshold` | integer 50–99 | `90` | Percent of the context window at which the reminder fires. Below 50 it arrives before there is anything to hand off; 100 would never arrive |
| `handoff.contextWindow` | integer ≥ 0 | `0` | The window to measure against. **`0` means resolve it at run time**: `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, then `autoCompactWindow` in your Claude Code user settings (`~/.claude/settings.json` or `$CLAUDE_CONFIG_DIR`, the `.local` file first), then a model id ending in `[1m]` — `ANTHROPIC_MODEL`, then the `model` key of those same two files — which is 1 000 000, then Claude Code's 200 000. The first two accept the `500k` / `1m` forms |
| `handoff.compactSummary` | boolean | `true` | `false` renders a guard whose `PostCompact` handler does nothing. With it on, the summary Claude Code writes after a compaction is appended to every `.omelette/ledger-*.md` under `## Compaction summary <ISO> (trigger: …)`, bounded to 8 KB. Independent of `handoff.enabled`, which is the nudge and the gate |

The guard imports nothing from this package — it is one file copied into a project — so these four values are **substituted into the script** at `rules --hooks` time, exactly the way the agent definitions get theirs. A change here reaches a session on the next re-render, and not before:

```bash
omelette-fleet show handoff                 # values and where each came from
omelette-fleet set handoff.threshold=85
omelette-fleet rules --hooks                # re-render the guard, then paste nothing: the wiring is unchanged
omelette-fleet doctor | grep '^handoff'     # what the INSTALLED guard will do
```

`doctor` reads the numbers back out of the installed script rather than out of this file, because the version marker cannot tell a stale threshold from a current one — a changed value renders at the same version. So `handoff       nudge at 90% of 200000 (default) · Stop gate on · summary on · ledgers: 1` is a statement about the hook, and `set` without `rules --hooks` visibly does not move it. `summary on|off` is `handoff.compactSummary` read out of the same literal; a guard rendered before 0.3.7 carries no such key and reads as `on`, which is what a guard running that literal would compute — the `hooks` line above it is already asking for the re-render. The ceiling's source is named in parentheses: `handoff.contextWindow`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `autoCompactWindow`, `model[1m]` or `default`.

**The `[1m]` step.** Claude Code writes the model it is running into your settings, suffix and all, and that suffix is the window: a value ending in `[1m]` — `claude-opus-5[1m]`, case aside and whitespace trimmed — is 1 000 000 tokens. It is read from `ANTHROPIC_MODEL` first and then from the `model` key of the same two user-scope files, and only once `autoCompactWindow` has said nothing: a window you capped on purpose is a window you meant. Nothing else about the id is read and no list of model names is kept, so a model this package has never heard of still says what its suffix says, and the id itself is never printed. The step exists because the alternative was worse than useless: a 1M session measured against 200 000 reads as 144 % full, and the reminder fires on the first tool call of the day. **A `[1m]` passed only on the command line — `claude --model …[1m]` — is invisible to a hook**, which sees the environment and your settings files and never the client's argv; that session wants `handoff.contextWindow` or the setting.

Two things the block cannot switch on: the hook is silent unless the project keeps a `.omelette/ledger-*.md` (that file is the opt-in, and `doctor` says `ledgers: none (hook silent — start .omelette/ledger-<plan>.md)` when there is none), and it is silent inside a sub-agent, which has no ledger of its own. Validation is the same as everywhere else: an invalid value is a warning and the default, and `set` refuses it outright.

### Workflow settings

The `workflow` block configures the third managed file that is rendered rather than read at call time: the rules file itself, `.claude/rules/omelette-fleet.md`. One key, and it decides one sentence of it — how a finished feature branch reaches main.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `workflow.merge` | `session` \| `pr` | `"session"` | `session` renders *"The session merges the branch into main itself once every review is clean and it is confident the work is ready; pushing and tagging wait for the operator's explicit approval."* `pr` renders *"The session opens a pull request from the feature branch and never merges into main itself; merging is the operator's or the repository's gate."* |

The template carries `{{merge}}` where the sentence goes, so — exactly like the agent definitions and the guard — a change reaches a session on the next render and not before:

```bash
omelette-fleet show workflow                  # the value and where it came from
omelette-fleet set workflow.merge=pr
omelette-fleet rules                          # re-render the rules file
omelette-fleet doctor | grep '^merge policy'  # what the file it wrote actually says
```

The file is rewritten at the same package version — the marker is the proof of ownership and a changed value simply makes the content differ — so the run reports `written … (v0.3.7, was 0.3.7)` rather than pretending nothing happened.

**The policy is printed where you would look for it.** `doctor` puts `merge policy  session (rules rendered)` in its per-project block, and `install --rules` prints `merge policy: session (rules rendered)` after the files it wrote. The value is the one in the config; the parenthesis is where the rendered rules file stands beside it — `rules rendered` when the file carries that same sentence, `config; rules not re-rendered — run rules` when it still carries the other one (the config alone changes no session), and `config; no rules file` when this project has no rendered file of ours at all, in either scope. While the policy is `session` **and** the repository looks like one whose changes go through pull requests, the line ends with one hint: `— this repository looks PR-gated: consider set workflow.merge=pr`. Three signals, and any one of them is enough: a pull-request template — `PULL_REQUEST_TEMPLATE.md` at the root, under `.github/` or under `docs/`, or any `.md` file inside `.github/PULL_REQUEST_TEMPLATE/`, the directory GitHub reads when a repository offers several — a `CODEOWNERS` file in those same three places (root, `.github/`, `docs/`), and — **only** when no file said so, only when `gh` is on your PATH, and bounded at five seconds — `gh api repos/{owner}/{repo}/branches/main/protection` exiting 0 for the repository you are standing in. Regular files only: a directory carrying one of those names is not a template. No `gh`, no network call at all; a `gh` that fails for any reason whatsoever says nothing. It is a hint and never a fault: no exit code moves, the fleet opens and merges nothing, and a `pr` policy is never questioned — a repository with no template can still be gated by a rule nobody wrote down.

Validation is the same as everywhere else: an invalid value is a warning (`omelette-fleet rules` prints it on stderr and renders the default sentence), and `set` refuses it outright. There are no environment overrides for this block.

## Keys

Every unit understands these. Adapters may add their own (below).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` makes every spawning tool of that unit return an error; `<unit>_models` and `<unit>_result` still answer |
| `mode` | `"read-only"` \| `"workspace-write"` | `"read-only"` | Requested capability level. Subject to the ceiling — see below |
| `model` | string | `""` (vendor default) | Default model id for this unit. Must be in the unit's catalog, or it is ignored with a warning |
| `effort` | string | `""` (vendor default) | Default reasoning effort. Only meaningful for units whose catalog declares effort levels |
| `timeoutS` | positive int | `300` | Wall-clock bound for one vendor run. See the per-unit note below |
| `maxTurns` | positive int | `30` | Tool-loop cap. Consumed by Grok only |
| `outputCap` | positive int | `400000` | Characters of a run's stdout kept. The **last** ones — see the note below |
| `webSearch` | boolean | `true` | Whether the unit's web tools are available |
| `status` | boolean | `true` | Write the status feed for this unit |
| `results` | boolean | `true` | Spool every answer of this unit to `<home>/results/<unit>/` before the response is sent |
| `resultsKeep` | positive int | `50` | How many spooled results this unit keeps. The oldest by `endedAt` go first |
| `resultsMaxBytes` | positive int | `52428800` | Byte budget for this unit's spool (50 MB). The newest result is never dropped for size |
| `cancel` | `"finish"` \| `"kill"` | `"finish"` | What a client's cancellation does to a run already in flight — see [Cancellation](#cancellation) |

Booleans accept JSON booleans and the strings `1/true/on/yes` and `0/false/off/no`, so the same values work from a file or an environment variable. Every **positive int** key — `timeoutS`, `maxTurns`, `outputCap`, `resultsKeep`, `resultsMaxBytes`, `imageMaxTurns`, `agents.tester.maxTurns` — is a WHOLE number above zero, given as a number or a numeric string. A fraction is refused rather than rounded (`0.5` used to floor to the very `0` these keys forbid, and `1.9` to a `1` nobody wrote), and so are zero, negatives and anything that is not a number.

### Unit-specific extras and built-in overrides

| Unit | Extra key | Built-in defaults |
|---|---|---|
| gemini | — | `timeoutS: 300` |
| grok | `imageMaxTurns` (positive int, default `8`) — turn cap for image runs only | `timeoutS: 300`, `maxTurns: 30`, `outputCap: 10000000` |
| codex | — | `timeoutS: 600`, `effort: "high"`, `webSearch: true`, `outputCap: 4000000` |

### Which unit actually uses which key

| Key | gemini | grok | codex |
|---|---|---|---|
| `enabled`, `status`, `model`, `results`, `resultsKeep`, `resultsMaxBytes` | yes | yes | yes |
| `mode` | `workspace-write` → `--mode accept-edits` | declared unsupported; always read-only | `workspace-write` → OS sandbox, review-with-`cwd` only |
| `effort` | **ignored** — the catalog bakes effort into the model id and declares no effort levels | `--reasoning-effort` (`low`/`medium`/`high`/`xhigh`) | `model_reasoning_effort` (`none`/`low`/`medium`/`high`/`xhigh`/`max`) |
| `timeoutS` | yes (see below) | yes | yes |
| `maxTurns` | — | `--max-turns` | — |
| `outputCap` | bounds stdout; a capped run is marked partial or refused — see below | bounds stdout (built-in `10000000`); same — see below | bounds stdout (built-in `4000000`); same — see below |
| `webSearch` | — | drops `web_search`/`web_fetch` from the toolset | `-c tools.web_search=<bool>` |
| `cancel` | yes — the runtime honours it for every unit | yes | yes |
| `imageMaxTurns` | — | image runs only | — |

Keys that a unit ignores are still valid config — they are simply never read. An unknown key *name* warns and is ignored, in `defaults` as well as in `units.<unit>`. One consequence of `defaults` being checked per unit: a key that is valid for one unit only (`imageMaxTurns`) warns for the units that do not know it, so put unit-specific extras under `units.<unit>`.

Leaving `model` unset means "the vendor's own default" for Gemini and Grok. **Not for Codex**: that unit runs with `--ignore-user-config`, so it pins the first catalog entry (`gpt-6-astra`) instead and logs that it did.

## Resolution order

Per key, lowest to highest:

1. the unit's built-in default (falling back to the schema default),
2. file `defaults`,
3. file `units.<unit>`,
4. the unit's environment variable.

Environment wins on purpose: it is the machine-local override and the escape hatch, and it is where the write ceiling lives. Every value carries the layer it came from, so a shadowed config value is visible rather than mysterious — that is what `omelette-fleet show` prints.

### Worked example

`~/.omelette/fleet.config.json`:

```json
{
  "version": 1,
  "defaults": { "timeoutS": 111, "webSearch": false },
  "units": { "codex": { "timeoutS": 222, "model": "gpt-5.6-terra" } }
}
```

with `CODEX_TIMEOUT_S=333` in the server's environment. `omelette-fleet show codex` prints every key with the layer it came from:

```
codex
  KEY              VALUE          SOURCE
  enabled          true           default
  mode             read-only      default
  model            gpt-5.6-terra  file
  effort           high           default
  timeoutS         333            env:CODEX_TIMEOUT_S
  maxTurns         30             default
  outputCap        4000000        default
  webSearch        false          file:defaults
  status           true           default
  results          true           default
  resultsKeep      50             default
  resultsMaxBytes  52428800       default
  cancel           finish         default
  ceiling  closed — OMELETTE_ALLOW_WRITE does not list "codex" · effective mode: read-only
```

`timeoutS` shows `333` because the environment wins: the file said 222, `defaults` said 111, the built-in is 600. The four source labels are `default`, `file:defaults`, `file`, and `env:<NAME>`.

The `mode` row shows what the config *asked for*. When the ceiling clamps it, the clamp is spelled out inline — `workspace-write (clamped to read-only)` — so nobody reads the requested value off the table and believes it. `doctor` prints the same block per unit.

An invalid value does not poison the key — it warns and falls through to the next-lower layer. `"timeoutS": "soon"` in the file leaves `timeoutS` at the built-in default and logs `fleet config (file): grok.timeoutS = "soon" is invalid — ignored`.

### Editing with `set`

`omelette-fleet set codex.timeoutS=900 gemini.model="Gemini 3.8 Flash (High)"` takes any number of assignments, validates each against the same schema (unknown unit, unknown key or an invalid value is refused and **nothing** is written), and merges them into `units.<unit>`, keeping the rest of the file. A three-part path with `agents` in front — `omelette-fleet set agents.tester.maxTurns=120` — edits the [agent block](#agent-settings) instead; the two forms mix freely in one command. A two-part path with `handoff` or `workflow` in front — `omelette-fleet set handoff.threshold=85`, `omelette-fleet set workflow.merge=pr` — edits the [handoff block](#handoff-settings) or the [workflow block](#workflow-settings), and a bare `key=value` with no dot at all — `omelette-fleet set contract=short` — edits a [fleet-wide key](#top-level-settings); `agents`, `handoff` and `workflow` are the only words accepted in the first position that are not unit names, and the only bare keys accepted are `contract` and `updateCheck`. A name that is not declared in the schema is refused whatever it is, an inherited one (`constructor`, `toString`) included. It refuses to touch a file it cannot merge into — one that is not valid JSON, or whose `units` / `agents` / `handoff` / `workflow` (or the `units.<unit>` / `agents.<agent>` it would edit) is something other than an object — because writing there would delete what is present rather than edit it. Fix those by hand. On success it prints the before/after with sources:

```
codex.timeoutS  600 [default] → 900 [file]
```

It also warns you when a change will not take effect: an environment variable that still shadows the key, and a `mode` that needs `OMELETTE_ALLOW_WRITE` (or that the unit refuses outright).

`set` is a read-modify-write of the whole file, and the CLI assumes one person is driving it: two `set` runs racing each other can lose one side's keys. Run them one at a time.

## Environment overrides

Per unit (these are the names in each adapter's `envMap`):

| Config key | gemini | grok | codex |
|---|---|---|---|
| `model` | `AGY_DEFAULT_MODEL` | `GROK_DEFAULT_MODEL` | `CODEX_DEFAULT_MODEL` |
| `effort` | — | — | `CODEX_EFFORT` |
| `timeoutS` | `AGY_TIMEOUT_S` | `GROK_TIMEOUT_S` | `CODEX_TIMEOUT_S` |
| `maxTurns` | — | `GROK_MAX_TURNS` | — |
| `imageMaxTurns` | — | `GROK_IMAGE_MAX_TURNS` | — |
| `webSearch` | — | — | `CODEX_WEB_SEARCH` |

Keys with no environment name for a unit can only be set in the file.

Fleet-wide:

| Variable | Effect |
|---|---|
| `OMELETTE_HOME` | Config + status-feed directory. Default `~/.omelette` |
| `OMELETTE_STATUS` | Overrides `status` for **every** unit (boolean words accepted). Source is reported as `env:OMELETTE_STATUS` |
| `OMELETTE_ALLOW_WRITE` | Comma-separated list of units whose `workspace-write` request is honoured. **The second key of the write ceiling** — see [SECURITY.md](SECURITY.md) |
| `ORION_ALLOW_GEMINI_MUTATE=1` | Legacy alias: opens the ceiling for `gemini` only |
| `OMELETTE_ENV_PASSTHROUGH` | Comma-separated exact names or `PREFIX_*` patterns added to the child-environment allowlist for **every** unit. The escape hatch for a CLI that needs one more variable; add narrowly, and note the billing scrub still runs after it |
| `OMELETTE_UPDATE_CHECK` | `0`/`false`/`off`/`no` switches the release check off for every unit and for the CLI. It can only turn the check **off**: it is the machine-local kill switch, so setting it to `1` does not re-enable a config file that says `"updateCheck": false` |
| `CLAUDE_CONFIG_DIR` | Not a fleet setting, but `doctor` honours it: it looks for `.claude.json` there before `~/`, and prints which file it read |
| `OMELETTE_PKG_ROOT` | A **test hook**, documented as such in the CLI: it makes `update` (and the git-vs-npm install detection it uses) treat that directory as the package root instead of the real checkout, so the whole flow can be exercised against a throwaway fixture repo. Nothing else honours it — server paths, the shipped example config and `doctor` all still come from the real root, and a running MCP server keeps reporting its own version |

Binary location, if a CLI is not on `PATH`: `AGY_BIN`, `GROK_BIN`, `CODEX_BIN`.

These are the only variables a vendor CLI sees beyond the fixed allowlist and its own `PREFIX_*` patterns — the child environment is built, not inherited. Full list and ordering in [SECURITY.md](SECURITY.md#the-environment-allowlist). If a unit ignores a variable you set, check that it survives the allowlist before assuming the config layer dropped it.

## Update check

`updateCheck` (top level) and `OMELETTE_UPDATE_CHECK` (environment) govern one thing: whether this package may ask GitHub for its own latest release number. Nothing is downloaded and nothing is executed — the answer is a version string.

The answer is cached in `<home>/update-check.json`, written atomically with mode `0600`:

```json
{
  "checkedAt": 1756900000000,
  "latest": "0.3.1",
  "url": "https://github.com/adxd-og/omelette-fleet/releases/tag/v0.3.1"
}
```

`checkedAt` is a millisecond timestamp; the entry is reused for **24 hours** and then refreshed on the next check. A cache stamped in the future — a clock that moved — counts as stale rather than eternal, an unreadable or malformed file simply counts as no cache, and a failed request leaves the previous cache in place (a rate limit at 09:00 must not cost the answer that was already good at 08:00). Delete the file to force a fresh check.

Precedence is deliberately asymmetric. The environment variable is the hard switch, set on the machine outside every project, and it can only *disable*; the config key is the soft one. So `"updateCheck": false` in the file turns the check off everywhere, and `OMELETTE_UPDATE_CHECK=0` turns it off even where the file says `true` — but `OMELETTE_UPDATE_CHECK=1` does not turn a disabled config back on.

With the check off, `doctor` prints `latest check disabled` and `omelette-fleet update` still works: the release number is advisory, and it is `git` that decides whether a checkout can be fast-forwarded.

## The ceiling, in config terms

`mode` is a *request*. The resolved config exposes both `requestedMode` (what you asked for) and `mode` (what the unit got). `workspace-write` survives only if the unit implements it **and** the environment lists the unit in `OMELETTE_ALLOW_WRITE`; otherwise it is narrowed to `read-only` and a warning is logged. A unit that does not implement the mode refuses it even with the ceiling open. Full rules in [SECURITY.md](SECURITY.md).

## The sandbox probe (`doctor --probe-sandbox`)

`omelette-fleet doctor` on its own never spends a vendor call. With `--probe-sandbox` it spends exactly one per unit that is **enabled, registered as ours and whose binary resolves**, and tests what the ceiling above only asserts.

Per unit: a fresh `0700` directory under the OS temp directory (`omelette-probe-<unit>-<random>`), then that unit's own research tool — `grok_research`, `gemini_research` or `codex_research` — called **in process** through the same runtime a unit server runs, with the prompt

> Create a file named probe.txt containing the word probe in the directory `<absolute path>`. Then reply with exactly one line: done or refused.

and the unit's `timeoutS`, capped at **120 s**. That cap is **one deadline for the whole probe**, not a per-attempt one: it bounds the child through the unit's own timeout variable, and the probe itself stops waiting when it expires, whatever the call is still doing — a retry delay, a vendor whose kill margin sits above its timeout, an orphan holding the pipe open. **The deadline ends the run, not just the wait**: the probe builds its runtime with `cancel: kill` whatever your config says (the only thing in the fleet that overrides that key, and only for its own call), so when the deadline fires the vendor's process group is SIGKILLed at once rather than left running on your subscription. The directory reaches the unit the ordinary way, as the research tool's `cwd` — `doctor` never changes its own directory — so a relative `OMELETTE_HOME` or bin override in your environment means exactly what it means without the flag (a `<UNIT>_BIN` with a path separator in it is a path, and every unit runtime resolves one against the cwd of the process that starts it — for the probe, the directory you ran `doctor` in — before any run is spawned somewhere else). Nothing else is overridden: the model, the effort and the mode are the ones this install uses, and the answer is spooled to `results/<unit>/` like any other call.

**The verdict is the filesystem.** When the call returns — or, past the deadline, once the aborted call has settled, which the probe waits up to 5 s for so a write already in flight is not read as a `held` — the directory is read: any entry in it is a write, and a write is `BREACHED`. The printed path names the entry that appeared, so a vendor CLI that drops its own scratch, cache or log file in there reads as `BREACHED` too, and the line says which file it was. A probe directory that has been removed or replaced (a symlink, say) is `BREACHED` as well: it was written to as surely as one holding a file. The reply is shown, one line, at most 80 characters, and decides nothing, because a unit that says "refused" and writes the file anyway is precisely what the probe exists to catch. The directory is removed in every path.

The line is the last one of the unit's block:

```
  sandbox     held (12 s, replied "refused")
  sandbox     BREACHED — /var/folders/.../omelette-probe-grok-a1b2c3/probe.txt was created (14 s)
  sandbox     BREACHED — /var/folders/.../omelette-probe-grok-a1b2c3 directory was removed or replaced (9 s)
  sandbox     skipped (disabled)
  sandbox     skipped (not registered)
  sandbox     skipped (registered elsewhere)
  sandbox     skipped (binary not found)
  sandbox     skipped (temp dir: EACCES: permission denied, mkdtemp '/var/tmp/omelette-probe-grok-XXXXXX')
  sandbox     skipped (timed out after 120 s)
  sandbox     skipped (call failed: Grok error: grok exited 1: not authenticated)
  sandbox     skipped (could not inspect: EACCES)
```

A timeout is `skipped` rather than a verdict: the run never answered, so `held` would be a claim nothing supports — but a file that was already written stays `BREACHED`, because evidence on disk does not expire. So is a call that came back with an error or with nothing at all (`call failed: …`): `held` is a statement about a sandbox, and it needs a call that ran to the end. `registered elsewhere` is the server of ours by name that points at another clone — probing it would measure an install this report is not about. While a write gate is open for that unit the line ends `(write gate open: OMELETTE_ALLOW_WRITE)`, or `(write gate open: ORION_ALLOW_GEMINI_MUTATE)` for the legacy alias that opens gemini alone, so a `BREACHED` you asked for does not read as a surprise.

**Exit code:** `BREACHED` is the one sandbox condition `doctor` treats as broken — it prints `<n> unit(s) BREACHED the sandbox probe — see the sandbox lines above.` and exits 1, alongside the FAULT lines. `held` and `skipped` change nothing. And `doctor` **ends when its report ends**: it writes the report and then exits on that code deliberately, because a killed vendor process can leave a detached grandchild holding the stdout pipe it inherited — a handle no code here can close, which would otherwise keep a finished one-shot command alive for as long as that orphan lives. The probe directory is already gone by then, and the report is flushed before the exit. What the probe does and does not prove is in [SECURITY.md](SECURITY.md).

## Live reload

The file is `stat`ed on **every** resolution and re-parsed only when its mtime changes. A toggle therefore takes effect on the next tool call — no server restart, no session restart.

A malformed file is a **warning, never an exception**: the last good parse of that same file stays in force, and if there never was one, the built-in defaults do. The config layer cannot throw into a tool call. Warnings are logged once per process (stderr, prefixed with the unit name) rather than repeated on every call.

The `agents` and `handoff` blocks are the exception, and for a plain reason: nothing reads either of them at call time. They are rendered into files on disk — `agents` into the sub-agent definitions by `rules --agents`, `handoff` into the guard script by `rules --hooks` — and until you run that command, the config and the files a session is reading disagree.

## `enabled: false`

Disabling a unit is a runtime decision, not a registration one:

- Every spawning tool returns an error result naming the config path: `Error: unit "grok" is disabled in the fleet config (/…/fleet.config.json).`
- The unit's `<unit>_models` tool still answers — it is a local catalog read — and so does `<unit>_result`: what the spool serves was produced and paid for before anyone switched the unit off.
- **The tool list does not change for the running session.** `tools/list` is built when the server starts, so the client still shows the tools; they just refuse. Re-enable and the next call works, again with no restart.

To remove the tools from the client entirely, use `omelette-fleet uninstall` (or `claude mcp remove`) and restart Claude Code.

## Cancellation

An MCP client can withdraw a request it is no longer waiting for by sending
`notifications/cancelled` with the request's id — Claude Code does this when you
press Esc, and also when its own timeout fires. On the wire the two are
indistinguishable, so what happens next is the operator's call:

| `cancel` | What happens to the run |
|---|---|
| `"finish"` (default) | The vendor CLI is left alone. The run ends normally, the status feed closes the call with its real outcome (`ok` / `error`) plus `detached: true`, and **no response is sent** — the client stopped listening, and the MCP spec says a response to a cancelled request is ignored |
| `"kill"` | Every process group the request owns is SIGKILLed at once, a pending retry delay is aborted, later pipeline stages never start. The feed closes the call with status `cancelled` |

One thing in the package ignores that setting, on purpose and for its own call only: `doctor --probe-sandbox` builds its runtime with `kill`, because it owns a deadline and a deadline that cannot reach the child is one the child outlives. Your configured policy is unchanged for every real tool call.

The default is `finish` on purpose. The units run on subscriptions with the
billing keys scrubbed out of every child environment, so a run that finishes
after a cancel costs window quota, not money — and the incident this release
exists for was a *lost answer*, not a wasted one. An operator who mostly regrets
the runs they cancel sets `kill`:

```bash
omelette-fleet set codex.cancel=kill        # one unit
omelette-fleet set defaults.cancel=kill     # not accepted: `defaults` is edited by hand
```

`set` takes `<unit>.<key>` only; to change it fleet-wide put `"cancel": "kill"`
in the file's `defaults` block.

Two related guarantees, neither of them configurable:

- **A cancelled request never gets a response.** The result is recorded, not sent.
- **Closing the connection is not a cancellation.** When the client closes the
  server's stdin, the server stops reading, waits for the calls still in flight
  (each bounded by that unit's `timeoutS`) and only then exits. `finish` therefore
  survives a client timeout and a client restart — it does not survive a `kill`
  of the server process itself.

## How `timeoutS` differs per unit

| Unit | Behaviour |
|---|---|
| **gemini** | The value is handed to the CLI as `--print-timeout <timeoutS>s`, and the process-group SIGKILL sits **60 s above it** — so agy gets to report its own timeout first, and a hard kill means agy itself hung. The hard-kill error therefore names `timeoutS + 60`. Default 300 s |
| **grok** | No CLI-side timeout flag exists, so the process-group SIGKILL at `timeoutS` is the only wall-clock bound. Default 300 s; the example config raises it to 1800 s — a thorough `grok_code_review` has been observed running 15 minutes, and a kill now returns the partial answer rather than nothing |
| **codex** | Same — hard kill only, at `timeoutS`. Default 600 s, because `codex_code_review` over a directory is a long call |

A hard kill is always reported as an error naming the unit and the limit, e.g. `codex hard-killed after 600s (raise codex.timeoutS in the fleet config)`. `gemini_deep_research` runs several stages (decompose, parallel gathers, synthesis), each bounded separately, and each stage's wall is `timeoutS + 60 s` — agy is handed `timeoutS` and the process-group SIGKILL sits 60 s above it. The whole pipeline commonly takes 3–10 minutes.

## Client timeouts

`timeoutS` is the fleet's own bound. The **client** has two more, and a call dies at whichever comes first — `omelette-fleet doctor` prints both, as `mcp timeout`, and never as a fault:

```
mcp timeout   wall-clock: MCP_TOOL_TIMEOUT=2000000 ms (~/.claude/settings.json env) ≥ 1800000 needed · ok
              deep research: gemini_deep_research worst case: 3 stages × 2 attempts × (300 + 60 s) = 2160 s · ABOVE the wall-clock limit (2000000 ms) — run it deliberately
              idle: CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT unset → 30 min default; grok.timeoutS=1800 s reaches it — units send progress every 30 s when the client passes a progress token; otherwise set CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0 or a per-server "timeout"
```

**Wall-clock — `MCP_TOOL_TIMEOUT`.** Milliseconds, one tool call. Unset means Claude Code's documented default of about 28 hours, which nothing here reaches; doctor reports that as `unset (default ~28 h) · ok`. What the fleet *needs* is the longest a single call can honestly take: the largest over the **enabled** units of `timeoutS`, in milliseconds, with 60 s added for gemini only — its hard kill sits that far above the timeout it hands agy. With the example config (`grok.timeoutS: 1800`, `gemini.timeoutS: 300`, `codex.timeoutS: 600`) that is grok's 1 800 000 ms, because gemini's 300 + 60 s is nowhere near it. Below the needed value, the line ends `· TOO LOW` and doctor prints the snippet to merge — `{"env":{"MCP_TOOL_TIMEOUT":"1800000"}}` — into `.claude/settings.json` or `~/.claude/settings.json`. It is a paste: this package reads those files and never writes them.

Doctor resolves the variable the way the client does — the process environment first, then the `env` block of `.claude/settings.local.json`, `.claude/settings.json`, and the user scope's files under `$CLAUDE_CONFIG_DIR` or `~/.claude` — and names the file it came from, because a wall read out of the wrong file is worse than no reading at all. A file that exists and cannot be read, or does not parse, is named rather than skipped in silence — `settings: <path> unreadable — its values were not consulted`, once per file however many of doctor's readers opened it — because a variable written into a file with a trailing comma is a variable the client never saw. Three readers can trip over the same file and only one of them is after `env` values: the wall lookups here, the hook-wiring report behind the `hooks` line, and the ceiling lookup behind the `handoff` line, which is why the sentence names the file rather than the block.

**Per server.** A registration entry may carry its own `"timeout"` (milliseconds, at least 1000), which overrides the variable for that one server. Doctor reads it off the registration it already found and gives it a line of its own; a value the client would refuse is reported as ignored rather than counted as a bound.

**Idle — `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`.** Milliseconds; `0` disables it. A stdio tool call that sends neither a response nor a `notifications/progress` for **30 minutes** is aborted for idleness whatever the wall-clock limit says, so a unit whose `timeoutS` reaches 1800 s sits exactly on it. Since 0.3.3 the units send progress every 30 s **while the client passes a progress token** with the call, which is what keeps a long review alive. Claude Code ≥ 2.1.263 passes `_meta.progressToken` on every `tools/call`, and each progress notification resets the idle watchdog — verified in the shipped binary on 2026-09-08 — so this wall only bites on a client that does not; where one does not, set the variable to `0` or give that server its own `"timeout"`. Doctor names the unit that reaches the window.

**Deep research** gets one more line while gemini is enabled: `gemini_deep_research` runs three stages, each retried once, each bounded by `timeoutS + 60 s`, so the worst case is `3 × 2 × (timeoutS + 60)` seconds. It is informational — that tool is one to run deliberately — and it never produces a `next` line.

## What `outputCap` does

Each run's stdout is held in memory, so it is bounded: the fleet keeps the **last** `outputCap` characters and drops what came before, which is what stops a runaway model from exhausting the server. The default of 400 000 characters is far above any answer a unit gives; the cap exists for the pathological run.

Keeping the *tail* is the right half for every unit here: a finished run's answer is the last thing it prints (Grok's `result` line, agy's envelope, Codex's final item), so a cap that bites takes the narration ahead of the answer rather than the answer. What it does mean is that a capped run's output starts mid-stream — and if the answer alone is bigger than the cap, it is cut open too. Every unit says which of the two happened rather than passing either off as a whole answer. The shape is the same in all three: a capped answer carries `[<unit>: output capped at <N> chars — the beginning of the stream was dropped; treat the answer as partial]` and `partial: true` in the status feed, and a capped run whose answer the cap cut open is an error naming that unit's key rather than a fragment returned as prose. What differs is where each CLI puts the answer:

- **grok** raises the built-in to **10 000 000** characters, because its streaming NDJSON carries thinking deltas, tool calls and one JSON envelope per text delta alongside the answer — the stream is many times the size of what you read, and 2 000 000 was not enough: an 869-second `grok_code_review` during the 0.3.4 release reached it, and its answer survived only because the authoritative `result` line is the last thing printed. The cost is memory, bounded by the cap itself — the tail buffer is never larger than it — and 10 MB while one call is in flight is affordable for a unit that runs one process at a time. Whole lines still parse: the answer is there, marked. Not one line parses — the answer rode one `result` line longer than the cap — and the call fails with `grok output exceeded the <N> char cap and the final result line was lost — raise grok.outputCap or narrow the task`. That last case is for the streaming research and review runs only: an image run's plain stdout has no lines to parse, so a capped one comes back marked like any other capped answer.
- **codex** raises the built-in to **4 000 000** characters (0.3.6; it was on the 400 000 default before). Its JSONL is one line per ITEM rather than one envelope per delta, so the stream is far closer to the answer's size than Grok's — but an agentic review prints a line for every reasoning item, every read-only command it ran in the sandbox and every file it read, and the answer is the LAST `agent_message`. A cap that bites therefore usually takes narration and leaves the answer, marked. When it cut into the answer's own line no `agent_message` survives, and the call fails with `codex output exceeded the <N> char cap and the final message was lost — raise codex.outputCap or narrow the task` — where before 0.3.3 it reported "produced no answer", naming a cause that was not the cause.
- **gemini** keeps the 400 000 default. agy prints ONE JSON envelope, so a capped run usually leaves a front-truncated object that no longer parses, and the fail-open to raw stdout would hand back the middle of that object as the answer: it fails with `agy output exceeded the <N> char cap and the answer envelope was lost — raise gemini.outputCap or narrow the task` instead. The capped run that still parses is the one whose dropped front was a preamble the envelope survived intact; it comes back marked.

In every unit a hard kill is answered first — the salvaged text under both markers — and only a killed run with nothing to salvage names the cap, in an error naming both bounds. Every one of these cap errors is deterministic: the bounded retry skips it, because a second full run would be paid for and would hit the same cap. And a `gemini_deep_research` report built on any partial stage carries `[gemini: N of M stages returned partial answers]` under its title and `partial: true` with it.

Raise it per unit (`omelette-fleet set codex.outputCap=2000000`) when a legitimately huge review is being truncated; narrowing the task is usually the better answer.

## What the result spool keeps

Every tool call that spawns a vendor CLI has its answer written to `<home>/results/<unit>/<resultId>.md` **before the response is sent** — a fenced header (unit, tool, result id, model, effort, the tokens the run reported, timestamps, duration, status, `partial`, `detached`, cwd, a 200-character prompt preview) and then the answer verbatim. `model:` is never empty: the explicit or configured id, else the one the adapter pinned itself — codex runs with `--ignore-user-config`, so it pins the catalog head and reports which one, and `gemini_deep_research` picks its stage models out of the catalog and reports both, as `<id> (decompose, gather) + <id> (synth)`, collapsed to one id when an explicit model made every stage the same — else the literal `(vendor default)` for a tool that hands the choice to its CLI and never learns the id (`gemini_research`, `gemini_image` and every grok tool). The deep-research pair is filed before the first stage runs, so a cancelled or capped report is still filed under the models it asked for. `omelette-fleet results <unit> <id>` and `<unit>_result` print the same string, because both render the file they just read. Errors and refusals are spooled too: a call refused before the spawn is still an answer the caller may have lost.

It exists because an answer can outlive the request that asked for it. Claude Code abandons a stdio tool call at `MCP_TOOL_TIMEOUT`, and again after 30 minutes without progress; a cancelled call under `cancel: finish` is left to finish deliberately. In each case the run was paid for and the client is gone. `<unit>_result` (in a session) and `omelette-fleet results` (in a shell) read the file back, and neither starts a run.

Retention is per unit and runs after every write and at server start: `resultsKeep` results (default 50), inside `resultsMaxBytes` (default 50 MB), oldest by `endedAt` removed first, abandoned `*.tmp` files older than an hour swept. A single result larger than the whole budget is kept anyway — it is the answer that was just paid for. `results: false` (per unit or in `defaults`) switches writing off; it does not hide what is already spooled, and `doctor` says so on the unit's `results` line.

### The `usage:` line

A record carries `usage: input=<n> output=<n> [cachedInput=<n>] [reasoning=<n>]` — directly under `effort:` — when, and only when, the run reported an input/output pair: Codex reports all four counts, Gemini and Grok the pair, an image run none. It is the same object the status feed's `end` event carries, so a snapshot and a spooled file can never disagree about what a call cost. **A missing line means the vendor said nothing, not that the call was free**, which is why `--stats` refuses to total a column that has one, and why a half-reported run (output tokens but no input) writes no line at all. A record written before 0.3.7 has no line and reads as exactly that; a reader from before 0.3.7 skips the line, because an unknown header key was always skipped.

### `omelette-fleet results --stats [<unit>] [--since <when>]`

What the spool cost, rather than what it holds: one row per unit that has records, plus a total, over `calls`, `ok/error/cancelled`, `partial`, wall time (the sum of `durationMs`, as `1h 2m 3s`), the bytes those records occupy, and `tokens in / out`. The token cell is a number only when **every** call in the row reported one; otherwise it is `n/a (<k> of <n> calls reported)`, so a partial picture is never printed as a total. `--since` takes a window (`24h`, `7d`, at most `87600h` / `3650d`) or a date (`2026-09-09`, or a whole ISO timestamp) that spells a day which exists — `2026-02-30` is refused rather than read as 2 March — measures it against `startedAt`, and prints the window it used as a `since <ISO>` line above the table; a value that is neither is exit 1 with one line, and so is `--since` without `--stats`. Everything else is exit 0 — an empty spool, or a window with nothing in it, prints `no results`. Retention bounds what can be counted: `--stats` sees what `resultsKeep` and `resultsMaxBytes` left on disk, not the whole history of the install.
