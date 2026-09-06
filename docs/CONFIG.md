# Configuration

One file, read fresh on every call, and it can only ever *narrow* what a unit may do.

## Location

```
$OMELETTE_HOME/fleet.config.json      # OMELETTE_HOME set
~/.omelette/fleet.config.json         # default
```

`OMELETTE_HOME` also holds the status feed (`status-<unit>.json`, `fleet-log.ndjson`) and the update-check cache (`update-check.json`). The file is optional: with no file at all, every unit runs on built-in defaults, read-only, with no warnings. `omelette-fleet set` writes it atomically (temp file + rename) with mode `0600` and `"version": 1`.

## Shape

```json
{
  "version": 1,
  "updateCheck": true,
  "defaults": { "status": true },
  "agents": {
    "coder":  { "model": "opus", "effort": "xhigh" },
    "tester": { "model": "sonnet", "effort": "xhigh", "maxTurns": 80 }
  },
  "units": {
    "gemini": { "enabled": true, "mode": "read-only", "model": "Gemini 3.8 Flash (High)", "timeoutS": 300 },
    "grok":   { "enabled": true, "mode": "read-only", "timeoutS": 1800, "maxTurns": 30 },
    "codex":  { "enabled": true, "mode": "read-only", "model": "gpt-6-astra", "effort": "high", "webSearch": true, "timeoutS": 600 }
  }
}
```

`defaults` applies to every unit; `units.<unit>` overrides it for one unit. Both accept the same keys. `agents` is a separate top-level block that has nothing to do with the units — it configures the Claude Code sub-agent definitions this package ships, and is described [below](#agent-settings). A `version` higher than 1 is accepted with a warning — known keys still apply, unknown ones are ignored.

### Top-level settings

Some keys describe the fleet rather than any one unit, so they sit at the top level next to `defaults` and `units` and are resolved on their own:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `updateCheck` | boolean | `true` | Whether a unit server may check for a newer release at startup, and whether `doctor` / `update` report the latest version. See [Update check](#update-check) |

An invalid value is a warning and the built-in default stays in force, exactly as for a unit's keys.

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

## Keys

Every unit understands these. Adapters may add their own (below).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` makes every spawning tool of that unit return an error; catalog tools still answer |
| `mode` | `"read-only"` \| `"workspace-write"` | `"read-only"` | Requested capability level. Subject to the ceiling — see below |
| `model` | string | `""` (vendor default) | Default model id for this unit. Must be in the unit's catalog, or it is ignored with a warning |
| `effort` | string | `""` (vendor default) | Default reasoning effort. Only meaningful for units whose catalog declares effort levels |
| `timeoutS` | positive int | `300` | Wall-clock bound for one vendor run. See the per-unit note below |
| `maxTurns` | positive int | `30` | Tool-loop cap. Consumed by Grok only |
| `outputCap` | positive int | `400000` | Characters of a run's stdout kept. The **last** ones — see the note below |
| `webSearch` | boolean | `true` | Whether the unit's web tools are available |
| `status` | boolean | `true` | Write the status feed for this unit |

Booleans accept JSON booleans and the strings `1/true/on/yes` and `0/false/off/no`, so the same values work from a file or an environment variable. Every **positive int** key — `timeoutS`, `maxTurns`, `outputCap`, `imageMaxTurns`, `agents.tester.maxTurns` — is a WHOLE number above zero, given as a number or a numeric string. A fraction is refused rather than rounded (`0.5` used to floor to the very `0` these keys forbid, and `1.9` to a `1` nobody wrote), and so are zero, negatives and anything that is not a number.

### Unit-specific extras and built-in overrides

| Unit | Extra key | Built-in defaults |
|---|---|---|
| gemini | — | `timeoutS: 300` |
| grok | `imageMaxTurns` (positive int, default `8`) — turn cap for image runs only | `timeoutS: 300`, `maxTurns: 30`, `outputCap: 2000000` |
| codex | — | `timeoutS: 600`, `effort: "high"`, `webSearch: true` |

### Which unit actually uses which key

| Key | gemini | grok | codex |
|---|---|---|---|
| `enabled`, `status`, `model` | yes | yes | yes |
| `mode` | `workspace-write` → `--mode accept-edits` | declared unsupported; always read-only | `workspace-write` → OS sandbox, review-with-`cwd` only |
| `effort` | **ignored** — the catalog bakes effort into the model id and declares no effort levels | `--reasoning-effort` (`low`/`medium`/`high`/`xhigh`) | `model_reasoning_effort` (`none`/`low`/`medium`/`high`/`xhigh`/`max`) |
| `timeoutS` | yes (see below) | yes | yes |
| `maxTurns` | — | `--max-turns` | — |
| `outputCap` | bounds stdout | bounds stdout (built-in `2000000`), and a capped run is marked partial or refused — see below | bounds stdout |
| `webSearch` | — | drops `web_search`/`web_fetch` from the toolset | `-c tools.web_search=<bool>` |
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
  KEY        VALUE          SOURCE
  enabled    true           default
  mode       read-only      default
  model      gpt-5.6-terra  file
  effort     high           default
  timeoutS   333            env:CODEX_TIMEOUT_S
  maxTurns   30             default
  webSearch  false          file:defaults
  status     true           default
  ceiling  closed — OMELETTE_ALLOW_WRITE does not list "codex" · effective mode: read-only
```

`timeoutS` shows `333` because the environment wins: the file said 222, `defaults` said 111, the built-in is 600. The four source labels are `default`, `file:defaults`, `file`, and `env:<NAME>`.

The `mode` row shows what the config *asked for*. When the ceiling clamps it, the clamp is spelled out inline — `workspace-write (clamped to read-only)` — so nobody reads the requested value off the table and believes it. `doctor` prints the same block per unit.

An invalid value does not poison the key — it warns and falls through to the next-lower layer. `"timeoutS": "soon"` in the file leaves `timeoutS` at the built-in default and logs `grok.timeoutS = "soon" is invalid — ignored`.

### Editing with `set`

`omelette-fleet set codex.timeoutS=900 gemini.model="Gemini 3.8 Flash (High)"` takes any number of assignments, validates each against the same schema (unknown unit, unknown key or an invalid value is refused and **nothing** is written), and merges them into `units.<unit>`, keeping the rest of the file. A three-part path with `agents` in front — `omelette-fleet set agents.tester.maxTurns=120` — edits the [agent block](#agent-settings) instead; the two forms mix freely in one command, and `agents` is the only word accepted in the first position that is not a unit name. It refuses to touch a file it cannot merge into — one that is not valid JSON, or whose `units` / `agents` (or the `units.<unit>` / `agents.<agent>` it would edit) is something other than an object — because writing there would delete what is present rather than edit it. Fix those by hand. On success it prints the before/after with sources:

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

## Live reload

The file is `stat`ed on **every** resolution and re-parsed only when its mtime changes. A toggle therefore takes effect on the next tool call — no server restart, no session restart.

A malformed file is a **warning, never an exception**: the last good parse of that same file stays in force, and if there never was one, the built-in defaults do. The config layer cannot throw into a tool call. Warnings are logged once per process (stderr, prefixed with the unit name) rather than repeated on every call.

The `agents` block is the exception, and for a plain reason: nothing reads it at call time. It is rendered into files on disk by `rules --agents`, and until you run that, the config and the definitions a session is reading disagree.

## `enabled: false`

Disabling a unit is a runtime decision, not a registration one:

- Every spawning tool returns an error result naming the config path: `Error: unit "grok" is disabled in the fleet config (/…/fleet.config.json).`
- The unit's `<unit>_models` tool still answers — it is a local catalog read.
- **The tool list does not change for the running session.** `tools/list` is built when the server starts, so the client still shows the tools; they just refuse. Re-enable and the next call works, again with no restart.

To remove the tools from the client entirely, use `omelette-fleet uninstall` (or `claude mcp remove`) and restart Claude Code.

## How `timeoutS` differs per unit

| Unit | Behaviour |
|---|---|
| **gemini** | The value is handed to the CLI as `--print-timeout <timeoutS>s`, and the process-group SIGKILL sits **60 s above it** — so agy gets to report its own timeout first, and a hard kill means agy itself hung. The hard-kill error therefore names `timeoutS + 60`. Default 300 s |
| **grok** | No CLI-side timeout flag exists, so the process-group SIGKILL at `timeoutS` is the only wall-clock bound. Default 300 s; the example config raises it to 1800 s — a thorough `grok_code_review` has been observed running 15 minutes, and a kill now returns the partial answer rather than nothing |
| **codex** | Same — hard kill only, at `timeoutS`. Default 600 s, because `codex_code_review` over a directory is a long call |

A hard kill is always reported as an error naming the unit and the limit, e.g. `codex hard-killed after 600s (raise codex.timeoutS in the fleet config)`. `gemini_deep_research` runs several stages (decompose, parallel gathers, synthesis) and each stage is bounded by `timeoutS` separately — the whole pipeline commonly takes 3–10 minutes.

## What `outputCap` does

Each run's stdout is held in memory, so it is bounded: the fleet keeps the **last** `outputCap` characters and drops what came before, which is what stops a runaway model from exhausting the server. The default of 400 000 characters is far above any answer a unit gives; the cap exists for the pathological run.

Keeping the *tail* is the right half for every unit here: a finished run's answer is the last thing it prints (Grok's `result` line, agy's envelope, Codex's final item), so a cap that bites takes the narration ahead of the answer rather than the answer. What it does mean is that a capped run's output starts mid-stream — and if the answer alone is bigger than the cap, it is cut open too. Grok says which of the two happened rather than passing either off as a whole answer:

- **grok** raises the built-in to **2 000 000** characters, because its streaming NDJSON carries thinking deltas, tool calls and one JSON envelope per text delta alongside the answer — the stream is many times the size of what you read. A capped run whose remaining lines still parse comes back with `[grok: output capped at <N> chars — the beginning of the stream was dropped; treat the answer as partial]` appended and `partial: true` in the status feed. If the answer itself was longer than the cap, not one line of the stream parses, and the call fails loudly with `grok output exceeded the <N> char cap and the final result line was lost — raise grok.outputCap or narrow the task` instead of handing back the JSON fragment that survived. That last case is for the streaming research and review runs only: an image run's plain stdout has no lines to parse, so a capped one comes back marked like any other capped answer. A run that was hard-killed as well is answered as a hard kill first — the salvaged text, both markers — and only a killed run with nothing captured surfaces the cap in its error.
- **gemini** and **codex** keep the 400 000 default.

Raise it per unit (`omelette-fleet set grok.outputCap=4000000`) when a legitimately huge review is being truncated; narrowing the task is usually the better answer.
