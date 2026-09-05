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
  "units": {
    "gemini": { "enabled": true, "mode": "read-only", "model": "Gemini 3.8 Flash (High)", "timeoutS": 300 },
    "grok":   { "enabled": true, "mode": "read-only", "timeoutS": 1800, "maxTurns": 30 },
    "codex":  { "enabled": true, "mode": "read-only", "model": "gpt-6-astra", "effort": "high", "webSearch": true, "timeoutS": 600 }
  }
}
```

`defaults` applies to every unit; `units.<unit>` overrides it for one unit. Both accept the same keys. A `version` higher than 1 is accepted with a warning — known keys still apply, unknown ones are ignored.

### Top-level settings

Some keys describe the fleet rather than any one unit, so they sit at the top level next to `defaults` and `units` and are resolved on their own:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `updateCheck` | boolean | `true` | Whether a unit server may check for a newer release at startup, and whether `doctor` / `update` report the latest version. See [Update check](#update-check) |

An invalid value is a warning and the built-in default stays in force, exactly as for a unit's keys.

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
| `webSearch` | boolean | `true` | Whether the unit's web tools are available |
| `status` | boolean | `true` | Write the status feed for this unit |

Booleans accept JSON booleans and the strings `1/true/on/yes` and `0/false/off/no`, so the same values work from a file or an environment variable. `timeoutS`/`maxTurns` accept numeric strings and are floored; zero and negatives are rejected.

### Unit-specific extras and built-in overrides

| Unit | Extra key | Built-in defaults |
|---|---|---|
| gemini | — | `timeoutS: 300` |
| grok | `imageMaxTurns` (positive int, default `8`) — turn cap for image runs only | `timeoutS: 300`, `maxTurns: 30` |
| codex | — | `timeoutS: 600`, `effort: "high"`, `webSearch: true` |

### Which unit actually uses which key

| Key | gemini | grok | codex |
|---|---|---|---|
| `enabled`, `status`, `model` | yes | yes | yes |
| `mode` | `workspace-write` → `--mode accept-edits` | declared unsupported; always read-only | `workspace-write` → OS sandbox, review-with-`cwd` only |
| `effort` | **ignored** — the catalog bakes effort into the model id and declares no effort levels | `--reasoning-effort` (`low`/`medium`/`high`/`xhigh`) | `model_reasoning_effort` (`none`/`low`/`medium`/`high`/`xhigh`/`max`) |
| `timeoutS` | yes (see below) | yes | yes |
| `maxTurns` | — | `--max-turns` | — |
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

`omelette-fleet set codex.timeoutS=900 gemini.model="Gemini 3.8 Flash (High)"` takes any number of assignments, validates each against the same schema (unknown unit, unknown key or an invalid value is refused and **nothing** is written), and merges them into `units.<unit>`, keeping the rest of the file. It refuses to touch a file it cannot merge into — one that is not valid JSON, or whose `units` (or the `units.<unit>` it would edit) is something other than an object — because writing there would delete what is present rather than edit it. Fix those by hand. On success it prints the before/after with sources:

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
  "latest": "0.3.0",
  "url": "https://github.com/adxd-og/omelette-fleet/releases/tag/v0.3.0"
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
