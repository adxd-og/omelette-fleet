<p align="center">
  <img src="docs/assets/logo.png" width="160" alt="Omelette Fleet">
</p>

<h1 align="center">Omelette Fleet</h1>

<p align="center">Gemini, Grok and Codex as read-only units in Claude Code</p>

<p align="center">
  <a href="https://github.com/adxd-og/omelette-fleet/actions/workflows/test.yml"><img src="https://github.com/adxd-og/omelette-fleet/actions/workflows/test.yml/badge.svg" alt="test workflow status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-blue" alt="Node 20 or newer">
  <img src="https://img.shields.io/badge/dependencies-zero-blue" alt="Zero runtime dependencies">
</p>

## What you get

Three peers inside Claude Code, each on a subscription you already pay for, none of them able to write. `doctor` is where you find out whether that is actually true on your machine:

```console
$ omelette-fleet doctor      # example output — all three units; config tables trimmed
FLEET DOCTOR · omelette-fleet 0.3.0 · node v20.19.5 · darwin
version       0.3.0 · latest 0.3.0
fleet home    ~/.omelette
fleet config  ~/.omelette/fleet.config.json
claude CLI    ~/.local/bin/claude
claude config ~/.claude.json
rules         project: v0.3.0 · global: absent
agents        project: v0.3.0 (2) · global: absent

── gemini (Gemini) ────────────────────────────────────────────
  bin         agy → ~/.local/bin/agy   [AGY_BIN=(unset)]
  version     1.1.25
  login       OK — agy models listed 14 line(s)
  config      closed — OMELETTE_ALLOW_WRITE does not list "gemini" · effective mode: read-only
              KEY        VALUE                    SOURCE
              enabled    true                     file
              mode       read-only                file
              model      Gemini 3.8 Flash (High)  file
              timeoutS   300                      file
  mcp         omelette-gemini registered (user) → node ~/omelette-fleet/servers/gemini.mjs [file exists]
  status feed ~/.omelette is writable

── grok (Grok) ────────────────────────────────────────────────
  bin         grok → ~/.grok/bin/grok   [GROK_BIN=(unset)]
  version     grok 1.0.13 (5e9a58528b76) [stable]
  login       OK — grok models listed 5 line(s)
  config      closed — OMELETTE_ALLOW_WRITE does not list "grok" · and this unit refuses workspace-write anyway · effective mode: read-only
  mcp         omelette-grok registered (user) → node ~/omelette-fleet/servers/grok.mjs [file exists]

── codex (Codex) ──────────────────────────────────────────────
  bin         codex → ~/.local/bin/codex   [CODEX_BIN=(unset)]
  version     codex-cli 0.153.0
  login       OK — Logged in using ChatGPT
  config      closed — OMELETTE_ALLOW_WRITE does not list "codex" · effective mode: read-only
  mcp         omelette-codex registered (user) → node ~/omelette-fleet/servers/codex.mjs [file exists]

No faults in units that are both enabled and registered.
```

## How it fits together

```mermaid
graph LR
  CC["Claude Code (MCP client)"]

  subgraph FLEET["one stdio MCP server per unit"]
    SG["omelette-gemini"]
    SK["omelette-grok"]
    SX["omelette-codex"]
  end

  AGY["agy CLI"]
  GRK["grok CLI"]
  CDX["codex CLI"]
  SUB["your Gemini / xAI / ChatGPT subscriptions"]

  CFG["fleet.config.json + OMELETTE_ALLOW_WRITE ceiling"]
  FEED["status-*.json + fleet-log.ndjson"]
  READER["menu-bar app / tail -f"]

  CC -->|stdio| FLEET
  SG -->|spawn| AGY --> SUB
  SK -->|spawn| GRK --> SUB
  SX -->|spawn| CDX --> SUB
  CFG -. "re-read per call" .-> FLEET
  FLEET -. "writes" .-> FEED
  FEED --> READER
```

Plug Google Gemini, xAI Grok and OpenAI Codex into Claude Code as MCP **units** — read-only research and code-review peers. Each unit is its own stdio MCP server that spawns the vendor's own CLI headless (`agy`, `grok`, `codex`), so every call rides the subscription you already pay for. The child environment is built from a small allowlist rather than inherited, and API keys that would silently switch a CLI to metered billing are scrubbed on top of it. Claude Code stays the manager: **units propose, the manager applies.** A single config file with a two-key write ceiling keeps a unit from becoming a foot-gun, and a status feed reports what each unit is doing right now.

Zero runtime dependencies. Node core only, no build step.

## Requirements

- **Node ≥ 20**
- **Claude Code** (the MCP client that will host the units)
- **Any subset** of the vendor CLIs, installed and logged in: `agy` (Antigravity, for Gemini), `grok` (Grok Build), `codex` (Codex CLI).

A partial fleet is normal and expected. `install` skips units whose CLI is not on `PATH`; the units you do have work exactly the same.

## Quickstart

```bash
git clone https://github.com/adxd-og/omelette-fleet.git
cd omelette-fleet
./bin/omelette-fleet.mjs install
```

`install` registers one MCP server per available unit with `claude mcp add -s user`, named `<prefix>-<unit>` (default prefix `omelette`, so `omelette-gemini`, `omelette-grok`, `omelette-codex`), and creates `~/.omelette/fleet.config.json` from `examples/fleet.config.json` if you don't have one.

Restart Claude Code. The tools appear as `mcp__<prefix>-<unit>__<tool>` — for example `mcp__omelette-codex__codex_code_review`.

Then put the operating rules into your project (optional, recommended):

```bash
./bin/omelette-fleet.mjs rules          # <project>/.claude/rules/omelette-fleet.md
./bin/omelette-fleet.mjs rules --global # ~/.claude/rules instead
./bin/omelette-fleet.mjs rules --agents # + the coder / tester sub-agent definitions
```

Rules load on the next session start; agent definitions are picked up within seconds (restart if `.claude/agents` did not exist before).

Then check the install:

```bash
./bin/omelette-fleet.mjs doctor
```

`doctor` reports the binaries and versions it found, login state, the resolved config with sources, the effective mode and write ceiling per unit, MCP registration, and whether the status-feed directory is writable. It reads Claude Code's `.claude.json` from `$CLAUDE_CONFIG_DIR` first and `~/` second, and prints which file it used — "not registered" against the wrong file would be a lie.

It exits 1 only for a unit that is **enabled and registered** *and* broken: the vendor binary is missing, the CLI says it is signed out, or the registration points at a server file that no longer exists. A unit you deliberately never wired up is not a fault — and neither is a login state of `unknown`. A probe `doctor` cannot interpret (a non-zero `--version`, a `login status` with no explicit signal) is reported as `unknown (exit N)` with the tail of its output, never as a version and never as "signed out".

Once published, the same commands work as `npx omelette-fleet …`.

### CLI

| Command | What it does |
|---|---|
| `install [--prefix <name>] [--units <a,b,c>] [--dry-run] [--force]` | Registers one MCP server per unit as `<prefix>-<unit>` with `claude mcp add -s user`, and creates `<home>/fleet.config.json` from the shipped example if it does not exist yet (an existing file is never overwritten). A unit whose vendor CLI is not in `PATH` is skipped unless `--force`. `--dry-run` prints every command and every write and runs nothing. Exits 1 if a `claude mcp add` fails |
| `uninstall [--prefix <name>] [--units <a,b,c>] [--dry-run]` | `claude mcp remove -s user` for those servers. Removing one that was never registered is a no-op; a removal that **fails for one that is registered** prints "Still registered" and exits 1. The fleet config and the status files are never touched |
| `update [--check]` | Reports the latest released version, then brings **this** install up to date. A git checkout is fast-forwarded (`git pull --ff-only`); a dirty tree or a diverged branch is refused, never overwritten. An npm install is left alone and the exact `npm i -g` line is printed. MCP registrations are never rewritten — they hold absolute paths a pull does not move. `--check` fetches but pulls nothing and exits 3 when an update is available, 0 when there is none |
| `rules [--global] [--agents] [--print] [--remove] [--force] [--dry-run]` | Writes the fleet's operating rules — units propose and this session applies, the tester flow, the routing table — to `<cwd>/.claude/rules/omelette-fleet.md`, which Claude Code loads like CLAUDE.md. `--global` writes it under `$CLAUDE_CONFIG_DIR` or `~/.claude` instead. The file carries a version marker on line 1: re-running refreshes a file with the marker, and a file **without** it is never touched (`--force` replaces it). `--print` sends the text to stdout; `--remove` deletes only a file with the marker; `--dry-run` prints every path and action and writes nothing. `--agents` also writes two sub-agent definitions (`omelette-coder`: Opus xhigh; `omelette-tester`: Sonnet xhigh, both `disallowedTools: Agent`) into `.claude/agents` — a definition is where a sub-agent's effort is set |
| `doctor [--prefix <name>] [--probe-models]` | Per unit: binary, `--version`, login state, resolved config with sources, ceiling, MCP registration, status-feed writability. A registration counts as yours only if its command is node and its path is *this* clone's `servers/<unit>.mjs` — otherwise it is reported as "registered elsewhere". `--probe-models` spends real Codex calls to test every catalog id |
| `show [<unit>]` | Every config key for one unit or all of them: value, where it came from, and the ceiling |
| `set <unit>.<key>=<value> [...]` | Changes keys in the config file. Unknown units, unknown keys and invalid values are refused; the rest of the file is kept |
| `call <unit> <tool> [json-args] [--timeout <seconds>]` | Drives a unit's server over real stdio (initialize → tools/list → tools/call). `json-args` must be a JSON **object**. Exit 0 = ok, 2 = the tool answered with an error, 1 = usage error or the call never completed. Default timeout 900 s, clamped to 1–86400 |
| `--help`, `--version` | Every subcommand answers `--help` / `-h` too, and so does `help <command>` |

If `claude` is not in `PATH`, `install` still writes the fleet config and prints the exact `claude mcp add` commands to run later; `uninstall` prints its commands and changes nothing. Neither the CLI nor the servers ever shell out — every child is `spawn(bin, [args])`, so a path or a value containing a space is data, not shell syntax. The only files the CLI writes are `<home>/fleet.config.json`, `<home>/update-check.json` and — only when you run `rules` — the marked files it manages under `.claude/rules/` and `.claude/agents/`, never one that lacks its marker unless you pass `--force`. Claude Code's own config is parsed, never written.

`call` is the way to test a unit without a client: `./bin/omelette-fleet.mjs call codex codex_models '{}'`. It distinguishes the two failures that matter — a tool that answered with an error (exit 2, the unit talking) from a server that errored at the protocol level or died mid-call (exit 1, the pipe breaking), rather than reporting either as an empty success.

### Keeping it up to date

```bash
./bin/omelette-fleet.mjs update          # fast-forward this checkout
./bin/omelette-fleet.mjs update --check  # report only; exit 3 = an update is available
```

Restart Claude Code afterwards. The unit servers are spawned per session and there is no daemon, so a running session keeps the code it started with until you restart it.

You do not have to remember to check: each unit server makes one unauthenticated request to the GitHub releases API at startup and prints a single stderr line — `update: omelette-fleet X.Y.Z is available (you run …)` — when there is something newer. The check runs at most **once every 24 hours** (the answer is cached in `<home>/update-check.json`), is capped at **2.5 s**, is fire-and-forget so it can never delay a tool call, and stays quiet when you are current. Switch it off with `OMELETTE_UPDATE_CHECK=0` in the server's env block, or `"updateCheck": false` in the fleet config.

The vendor CLIs update *themselves*; this package deliberately does not. `doctor` shows both — each unit's `version` line, and the fleet's own `version … · latest …` header.

## Units

| Unit | CLI | Log in with | Tools | Good for | Do not trust it with |
|---|---|---|---|---|---|
| **gemini** | `agy` (Antigravity) | agy has no `login` subcommand — sign in through the OAuth flow on your first interactive `agy` run; credentials land under `~/.gemini/` | `gemini_research`, `gemini_deep_research`, `gemini_image`, `gemini_models` | Grounded web research and fact synthesis; multi-source deep research; reading local files **including images and PDFs** (give an absolute path); inputs past 1M tokens and formal/scientific reasoning via `Gemini 3.1 Pro (High)`; a non-Google second opinion via `GPT-OSS 120B (Medium)`; image generation | Writing anything. agy has no kernel sandbox — read-only here rests on your own agy `settings.json` permission policy plus a prompt preamble, the weakest posture in the fleet. Deep-research sources are **asserted by the model**; verify them. Anything it read off the web is untrusted input |
| **grok** | `grok` (Grok Build) | `grok login`, or `grok login --device-code` | `grok_research`, `grok_code_review`, `grok_image`, `grok_image_edit`, `grok_models` | A cheap, fast second opinion; mechanical code analysis; math/STEM checks (AIME 93–100%, GPQA Diamond 84.6–88%); high-volume research sweeps; image generation **and image-to-image editing** — the only unit in the fleet that edits images | Fact-critical claims. AA-Omniscience measures Grok 4.6 at **48.2% accuracy / 34.3% hallucination** (read 2026-09-05; 4.5 was ~54% hallucination) — better, and still roughly one factual answer in three wrong — and it is overconfident. Never the sole source of a fact. Also: architecture calls, long-horizon engineering (DeepSWE 1.1 65.9), UI/front-end taste. Prompt-injection susceptible; `workspace-write` is **declared unsupported** and refused even with the ceiling open |
| **codex** | `codex` (Codex CLI) | `codex login` (ChatGPT account) | `codex_research`, `codex_code_review`, `codex_image`, `codex_models` | The strongest code review in the fleet and agentic terminal analysis, on `gpt-6-astra` (high) by default — AA Intelligence Index 55 against sol's 51 and terra's 47, and accepted on a ChatGPT Plus plan; directory-scoped review with an explicit `cwd`; grounded research with web search; image generation via the CLI's built-in **gpt-image-2** tool, saved to a temp directory outside every project; reports the fullest token usage in the fleet (input, cached, output, reasoning) | Being a source of record — verify factual claims. `gpt-5.6-luna` on anything multi-file or past ~200K tokens. `gpt-5.6-sol` unless your plan is ChatGPT Pro/Enterprise (Plus/Team gets an explicit rejection). `effort: xhigh` or `max` on routine work |

Model ids, benchmark numbers and routing advice live in `units/<unit>/models.js` and are served by each unit's `<unit>_models` tool — call it when you are unsure which model a task belongs on.

## Configuration

One JSON file, `~/.omelette/fleet.config.json` (or `$OMELETTE_HOME/fleet.config.json`), read fresh on every call. `examples/fleet.config.json`:

```json
{
  "version": 1,
  "defaults": {
    "status": true
  },
  "units": {
    "gemini": {
      "enabled": true,
      "mode": "read-only",
      "model": "Gemini 3.8 Flash (High)",
      "timeoutS": 300
    },
    "grok": {
      "enabled": true,
      "mode": "read-only",
      "timeoutS": 1800,
      "maxTurns": 30
    },
    "codex": {
      "enabled": true,
      "mode": "read-only",
      "model": "gpt-6-astra",
      "effort": "high",
      "webSearch": true,
      "timeoutS": 600
    }
  }
}
```

One consequence worth knowing: because the Codex unit runs with `--ignore-user-config`, leaving `codex.model` unset does **not** fall back to your `~/.codex/config.toml` default — the adapter pins the first catalog entry (`gpt-6-astra`) instead and logs that it did.

Every key, its default, the resolution order, and the per-unit environment overrides: **[docs/CONFIG.md](docs/CONFIG.md)**.

## Security

- Units are read-only by default; the mutating path stays in Claude Code, under your approval.
- Write mode needs **two keys**: `mode: "workspace-write"` in the config file *and* the unit listed in `OMELETTE_ALLOW_WRITE` in the MCP server's env block. The config can only narrow, never widen.
- Enforcement strength differs by vendor: Codex is an OS-level kernel sandbox (plus `--ignore-user-config --ignore-rules`, so your `~/.codex/config.toml` — MCP servers, plugins, hooks — never reaches a fleet run), Grok is a spawn-arg tool allowlist (and refuses write mode outright), Gemini is the CLI's own permission policy — the weakest of the three.
- The child environment is **built from an allowlist**, not inherited: a review run cannot read your `GH_TOKEN` or cloud credentials. Billing-risk API keys are scrubbed on top of that, and `--dangerously-*` / `--always-approve` flags are never passed.
- Everything a unit reads from the web or from a repository is untrusted input.

Threat model, the per-unit enforcement matrix, and what is only best-effort: **[docs/SECURITY.md](docs/SECURITY.md)**.

## Status feed

Every unit writes what it is doing to `$OMELETTE_HOME` (default `~/.omelette`): a per-unit snapshot `status-<unit>.json` with the calls running right now and the last finished event, and a shared append-only `fleet-log.ndjson` with one compact JSON line per start and end. Writes are atomic, mode 0600, fail-soft (an fs error can never break a tool call), and the log self-trims. Any menu-bar app, HUD or `tail -f` can read it. One reader of this feed is [Omelette usage-checker](https://github.com/adxd-og/usage-checker), a macOS menu-bar app; the feed is an open contract, so nothing here depends on it. Schema and field lists: **[docs/STATUS-FEED.md](docs/STATUS-FEED.md)**.

## Orchestration

How to actually run a session with a fleet — who decides, who proposes, which unit gets which task, and when to escalate a model or effort level: **[docs/ORCHESTRATION.md](docs/ORCHESTRATION.md)**. The adapter contract and internals: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. Adding a fourth unit: **[docs/ADAPTERS.md](docs/ADAPTERS.md)**.

**Rules in your session.** Two layers put that operating model in front of Claude Code. Every unit server hands the short version — units propose, the session applies, absolute paths, verify Grok — to the client from the MCP `initialize` handshake, so it is in context as "MCP Server Instructions" after a restart, with nothing to run. The long version is one command: `omelette-fleet rules` writes `<project>/.claude/rules/omelette-fleet.md` (or `--global` for `~/.claude/rules`), which Claude Code loads like CLAUDE.md, and `--agents` adds the coder and tester sub-agent definitions — where their effort is set and where the harness is told they may not spawn sub-agents of their own. Details, including how the version marker decides which files the fleet may overwrite: **[docs/ORCHESTRATION.md](docs/ORCHESTRATION.md#how-the-rules-reach-a-session)**.

## FAQ

**Why CLIs instead of API keys?**
Two reasons. Billing: each vendor CLI authenticates against the subscription you already pay for, and an API key present in the environment would silently flip it to metered API billing — so every key that could do that is deleted from the child process env. Safety: each CLI ships its own sandbox and permission machinery (Codex's OS sandbox, Grok's `--tools` allowlist and permission rules, agy's permission policy), and this package drives those instead of reimplementing them against a raw API.

The flip side is that a CLI run is a program with an environment, so the child env is built from an allowlist rather than inherited — a unit running read-only shell commands would otherwise be able to read every secret in your shell. Details in [docs/SECURITY.md](docs/SECURITY.md).

**Why read-only?**
Because a review peer that can also write is a review peer you have to supervise twice. Units read, search, analyse and propose; Claude Code applies the change, where your normal approval flow already sits. It also contains the blast radius of prompt injection: a unit that ingests a hostile web page or repository can only report back, not act.

**Can I let a unit write?**
Only deliberately, and only where it is actually enforceable. Write mode takes two keys: `mode: "workspace-write"` for that unit in the config file, **and** the unit named in `OMELETTE_ALLOW_WRITE` in the server's env block — which lives outside every project and cannot be edited by a read-only unit. Then the unit itself has to implement the mode:

- **Codex** does. Writes are kernel-scoped to the `cwd` you pass, and the adapter grants it only to `codex_code_review` with an explicit absolute `cwd` — `codex_research` is read-only whatever the config says. (`codex_image` also runs `workspace-write`, and is the one call that does **not** consult the ceiling: the kernel scopes it to a throwaway temp directory the adapter just created, because an image tool that cannot save a file is not a tool. Details in [docs/SECURITY.md](docs/SECURITY.md).)
- **Grok** does not. `workspace-write` is declared unsupported and refused even with the ceiling open.
- **Gemini** maps it to agy's `--mode accept-edits`, which is agy's own permission layer inside the process cwd — real, but not kernel-enforced. `ORION_ALLOW_GEMINI_MUTATE=1` is honoured as a legacy alias for opening the ceiling for `gemini` only.

**What if my ChatGPT plan rejects `gpt-5.6-sol`?**
The Codex catalog lists what exists in the current generation, not what one account happens to accept. `gpt-5.6-sol` is plan-gated to ChatGPT Pro/Enterprise; on a Plus or Team plan the call fails fast, before any work, with `The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account`.

You are not missing much. The fleet default is `gpt-6-astra` at `effort: high`, which is **accepted on Plus** — probed live 2026-09-05 on codex-cli 0.153.4 at effort low, high, xhigh and max — and scores above sol on the AA Intelligence Index (55 vs 51). `gpt-5.6-terra` is the cheaper step-down for sweeps and routine review, since astra costs ~5x terra per token and is markedly slower. The heavier `gpt-6-astra-pro`, `gpt-6-pro` and `gpt-6` are rejected on a ChatGPT plan exactly like sol; only `gpt-6-astra` is embedded in the CLI binary. codex-cli 0.153.4 also made astra its own bundled default, so a fleet call and a bare `codex` run now land on the same model — the fleet pins it explicitly regardless, because it runs with `--ignore-user-config`. `omelette-fleet doctor --probe-models` tells you exactly which ids your account accepts.

**How do I add a unit?**
Three files and a test: `units/<unit>/models.js` (the model allowlist and cheat-sheet), `units/<unit>/adapter.mjs` (a `defineUnit({...})` call), `servers/<unit>.mjs` (a two-line entrypoint). The runtime gives you config, the ceiling, catalog validation, the mutate gate, the status feed, bounded spawn with the env allowlist and billing scrub, and JSON-RPC. Step by step, with a skeleton and the fake-binary test pattern: [docs/ADAPTERS.md](docs/ADAPTERS.md).

**Why three servers instead of one?**
Failure isolation and stable names. A missing CLI, a hung vendor process, or an adapter bug takes down one server, not the fleet — the other units keep answering. Each server also owns a fixed tool list, so installing or removing a unit never reshuffles the tools of the others, and you can enable, disable, time-out and configure each vendor independently. It costs one idle Node process per unit.

## License

MIT — see [LICENSE](LICENSE).
