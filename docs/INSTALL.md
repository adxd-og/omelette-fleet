# Install, wire, check, update

Everything after README's five commands: what each step writes, how `doctor` reports it, and how to keep the install current.

| Question | Where |
|---|---|
| What do I need before I start, and does it run on Windows? | [Requirements](#requirements) |
| How do I sign in to each vendor CLI? | [Log in to the vendor CLIs](#log-in-to-the-vendor-clis) |
| What does `install` register and create? | [Install the units](#install-the-units) |
| Which files does a project get, and when does a session see them? | [Give a project the rules](#give-a-project-the-rules) |
| How do I wire the guard hook, and how do I check it? | [Wire the guard](#wire-the-guard) |
| How do I see the fleet at work in a pane? | [The fleet pane](#the-fleet-pane) |
| What does `doctor` check, and what does its output look like? | [What doctor tells you](#what-doctor-tells-you) |
| Which registrations does `doctor` count as ours? | [Which registrations are ours](#which-registrations-are-ours) |
| What does each `doctor` line mean, and which ones are faults? | [Each line](#each-line) |
| What does the `next` line want me to do? | [The next ladder](#the-next-ladder) |
| When does `doctor` exit 1? | [When doctor exits 1](#when-doctor-exits-1) |
| Which `doctor` flags spend vendor calls? | [The sandbox probe](#the-sandbox-probe) |
| How do I stop approving every unit call by hand? | [Fewer permission prompts](#fewer-permission-prompts) |
| What CLI subcommands are there, and how do I test a unit without Claude Code? | [CLI](#cli) |
| How do I update, and what updates itself? | [Keeping it up to date](#keeping-it-up-to-date) |

## Requirements

- **Node 20 or newer.** There are no dependencies to install and no build step.
- **Claude Code**, with `claude` on your `PATH`. `install` registers the units through `claude mcp add`.
- **At least one vendor CLI**, installed and logged in: `agy` (Antigravity, for Gemini), `grok` (Grok Build), `codex` (Codex CLI) or `vibe` (Mistral Vibe; `uv tool install mistral-vibe`, 3.1.0 was the version the 1.9.0 gate ran on). A partial fleet is normal. `install` skips a unit whose CLI is not on `PATH`, and the units you have work the same.
- **macOS or Linux.** `mistral_security_repro` is macOS only: its sandbox is `sandbox-exec`, and where that is missing the tool refuses and `doctor` says `macOS only (1.9.0)`. Native Windows is not supported. The package runs on Windows through WSL. A native harness would need `.cmd` shims for the vendor CLIs and handling for path and file-mode differences; it is not built and has no date. CI runs on Ubuntu and macOS only.

omelette-fleet is not published on npm. You run it from a git clone, so `npx omelette-fleet` does not work.

## Log in to the vendor CLIs

| Unit | CLI | Log in with |
|---|---|---|
| **gemini** | `agy` (Antigravity) | agy has no `login` subcommand. Run `agy` once and sign in through its OAuth flow; the credentials land under `~/.gemini/`. To let it read local images and PDFs, it needs `read_file(*)` in the agy allow-rules, the opt-in set in SECURITY, [Recommended agy allow-rules](SECURITY.md#recommended-agy-allow-rules). Antigravity's terms are a grey zone for this unit on consumer plans: [SECURITY](SECURITY.md#antigravitys-terms-a-grey-zone) |
| **grok** | `grok` (Grok Build) | `grok login`, or `grok login --device-code` |
| **codex** | `codex` (Codex CLI) | `codex login`, with your ChatGPT account |
| **mistral** | `vibe` (Mistral Vibe) | Run `vibe` once in a terminal and sign in through the browser. The login lives in the Keychain, and the unit runs on it only: `MISTRAL_API_KEY` is scrubbed. `doctor` cannot read the Keychain, so its `login` line checks that `~/.vibe/config.toml` or `~/.vibe/.env` exists and reads neither |

`doctor` shows each CLI's login state on its `login` line ([Each line](#each-line)).

## Install the units

```bash
git clone https://github.com/adxd-og/omelette-fleet.git
omelette-fleet/bin/omelette-fleet.mjs install
```

The CLI is the file `bin/omelette-fleet.mjs` in the clone. It is executable, so it needs no `node` in front. The rest of the docs call it `omelette-fleet`; an alias makes that name work in your shell:

```bash
alias omelette-fleet=/path/to/omelette-fleet/bin/omelette-fleet.mjs
```

What `install` does:

- It registers one MCP server per unit with `claude mcp add -s user`. The name is `<prefix>-<unit>`, and the default prefix is `omelette`: `omelette-gemini`, `omelette-grok`, `omelette-codex`, `omelette-mistral`. `--prefix <name>` picks another; `--units <a,b,c>` picks a subset.
- It skips a unit whose vendor CLI is not on `PATH`, unless you pass `--force`.
- It creates `~/.omelette/fleet.config.json` from `examples/fleet.config.json` if you have none. An existing file is never overwritten. What the example holds: [CONFIG, "Shape"](CONFIG.md#shape).
- Without `claude` on `PATH`, it registers nothing. It still writes the fleet config and prints the exact `claude mcp add` commands to run later.
- `--dry-run` prints every command and every write, and runs nothing.

Restart Claude Code afterwards. The tools then appear as `mcp__<prefix>-<unit>__<tool>`, for example `mcp__omelette-codex__codex_code_review`.

## Give a project the rules

Run this **from inside the project**. Every file it writes lands under the current directory's `.claude/`:

```bash
cd /path/to/your/project
omelette-fleet rules --agents --hooks
```

You get the operating rules, the four sub-agent definitions, the `/omelette-test` skill, the guard script and the settings snippet to paste. `install --rules` does both halves in one run: it registers the servers, then runs exactly `rules --agents --hooks` in the current directory. Run that from the project, not from the clone. `install --rules --dry-run` prints both halves and changes nothing.

The same files, one kind at a time:

```bash
omelette-fleet rules            # <project>/.claude/rules/omelette-fleet.md
omelette-fleet rules --global   # under $CLAUDE_CONFIG_DIR or ~/.claude instead
omelette-fleet rules --agents   # + the four sub-agent definitions and the /omelette-test skill
omelette-fleet rules --hooks    # + the guard script, and the settings snippet that calls it
```

Rules load on the next session start. Agent definitions and skills are picked up by Claude Code's watcher, usually within seconds, sometimes minutes. Restart if `.claude/agents` or `.claude/skills` did not exist before. Every flag, and what `rules` refuses to overwrite: [ORCHESTRATION, "Layer 2"](ORCHESTRATION.md#layer-2-the-rules-file-and-its-marker).

The rules also make the units cheaper to have around. With the rules file installed, each unit sends one line at `initialize` instead of the ~300-token fleet contract. What that line says and how to force the full one: [CONFIG, "The contract, and why auto is the default"](CONFIG.md#the-contract-and-why-auto-is-the-default).

## Wire the guard

The guard is optional. It is one script, `.claude/hooks/omelette-guard.mjs`, written by `rules --hooks`. It refuses a git write by one of the four guarded roles (`omelette-coder`, `omelette-coder-medium`, `omelette-tester`, `omelette-reviewer`), a rewrite of a curated file (a plan ledger, the backlog, the decisions register) by any caller, and a reviewer's write outside its report. It stamps every open plan ledger at a compaction, prints the last handoff block into the session that follows a compaction or a `/clear`, and records the files a guarded role wrote when it stops ([SECURITY, "The guard hook"](SECURITY.md#the-guard-hook)). The guard is containment for the sub-agent roles, not a security boundary.

**Merge the snippet.** `rules --hooks` prints a settings snippet that wires four events: `PreToolUse`, `PreCompact`, `SessionStart` and `SubagentStop`. You merge it yourself, into `.claude/settings.json` or `.claude/settings.local.json`. A hook script does nothing until your settings call it, and omelette-fleet reads those files but never writes them. The snippet is a whole `hooks` object, so, as the printed line says: *"Merge this into your settings file (it is a whole hooks object — add the events it lists to an existing `hooks` block rather than replacing the file)"*. How the script path in it is quoted per platform: [ORCHESTRATION, "Layer 3: the guard"](ORCHESTRATION.md#layer-3-the-guard).

**Check it.** `doctor` reads both settings files and reports `hooks         project: v1.8.0 (wired: PreToolUse, PreCompact, SessionStart, SubagentStop)`, or `NOT wired` with the reason. A `guard` line says which of the two deliveries is wired: this settings hook, the fleet pane mod, or both. Every line it can print there: [ORCHESTRATION, "What doctor says about the wiring"](ORCHESTRATION.md#what-doctor-says-about-the-wiring).

## The fleet pane

`omelette-fleet rules --mods` prints how to install the fleet pane, and writes nothing. The pane is a Claude Code mod. It draws the orchestrator, its sub-agents and the four units, and who is calling whom. It also runs the guard, pins a guarded role's model to its definition and hands back the handoff block. Install, update and removal: [MODS](MODS.md#install-update-and-removal).

## What doctor tells you

`doctor` reports, per unit, the vendor binary and its version, the login state, the resolved config with sources, the effective mode and write ceiling, the MCP registration, and whether the status-feed directory is writable. Above the units it reports the managed files and the client's timeout walls. It reads Claude Code's `.claude.json` from `$CLAUDE_CONFIG_DIR` first and `~/` second, and prints which file it used: "not registered" against the wrong file would be a lie. It reads the project's `.mcp.json` too, and names it when it is there.

Run it in the project. Here is what `doctor` prints at 1.8.0 for a default install: the shipped example config, the default prefix `omelette`, the clone at `~/omelette-fleet`, and `MCP_TOOL_TIMEOUT` unset. It was taken on 2026-11-04 in this repository, so the project lines (`ledgers`, `decisions`, `merge policy`) are this repository's. The home directory is written `~`, the config tables are cut to four rows, and the `decisions` warning line is left out (the table below says when it appears):

```console
$ omelette-fleet doctor
FLEET DOCTOR · omelette-fleet 1.8.0 · node v20.19.5 · darwin
version       1.8.0 · latest 1.8.0
fleet home    ~/.omelette
fleet config  ~/.omelette/fleet.config.json
claude CLI    ~/.local/bin/claude
claude config ~/.claude.json
rules         project: v1.8.0 · global: absent
agents        project: v1.8.0 (4) · global: absent
skills        project: v1.8.0 (1) · global: absent
hooks         project: v1.8.0 (wired: PreToolUse, PreCompact, SessionStart, SubagentStop) · global: absent
guard         settings hook wired (PreToolUse Bash|Write|Edit|NotebookEdit, SubagentStop)
handoff       stamp and print on · ledgers: 1
ledgers       1 open (ledger-docs-pass.md → feat/docs-pass), 0 untracked, 26 archived
decisions     docs/DECISIONS.md (via .omelette/decisions.md) — 34 lines, 1 struck, 0 stale pointers
contract      short (rules installed here)
merge policy  session (rules rendered) — this repository looks PR-gated: consider set workflow.merge=pr
mcp timeout   wall-clock: MCP_TOOL_TIMEOUT unset (default ~28 h) ≥ 1800000 needed · ok
              deep research: gemini_deep_research worst case: 3 stages × 2 attempts × (300 + 60 s) = 2160 s · within the wall-clock limit
              idle: CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT unset → 30 min default; grok.timeoutS=1800 s reaches it — units send progress every 30 s when the client passes a progress token; otherwise set CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0 or a per-server "timeout"

── gemini (Gemini) ────────────────────────────────────────────
  bin         agy → ~/.local/bin/agy   [AGY_BIN=(unset)]
  version     1.5.0
  login       OK — agy models listed 13 line(s)
  config      closed — OMELETTE_ALLOW_WRITE does not list "gemini" · effective mode: read-only
              KEY              VALUE                    SOURCE
              enabled          true                     file
              mode             read-only                file
              model            Gemini 3.8 Flash (High)  file
              timeoutS         300                      file
  notice      Antigravity's FAQ calls wrapping agy inside another coding agent "not supported under consumer plans" (read 2026-10-21): a grey zone, and your account's risk — docs/SECURITY.md, "Antigravity's terms: a grey zone"
  mcp         omelette-gemini registered (user) → node ~/omelette-fleet/servers/gemini.mjs [file exists]
  status feed ~/.omelette is writable
  results     ~/.omelette/results/gemini · keep 50 · max 50 MB

── grok (Grok) ────────────────────────────────────────────────
  bin         grok → ~/.grok/bin/grok   [GROK_BIN=(unset)]
  version     grok 1.0.62 (1474f9cbdd91) [stable]
  login       OK — grok models listed 7 line(s)
  models      CLI default grok-4.7 — in the catalog
  config      closed — OMELETTE_ALLOW_WRITE does not list "grok" · and this unit refuses workspace-write anyway · effective mode: read-only
              KEY              VALUE      SOURCE
              enabled          true       file
              mode             read-only  file
              model            (unset)    default
              timeoutS         1800       file
  mcp         omelette-grok registered (user) → node ~/omelette-fleet/servers/grok.mjs [file exists]
  status feed ~/.omelette is writable
  results     ~/.omelette/results/grok · keep 50 · max 50 MB

── codex (Codex) ──────────────────────────────────────────────
  bin         codex → ~/.local/bin/codex   [CODEX_BIN=(unset)]
  version     codex-cli 0.166.0
  login       OK — Logged in using ChatGPT
  models      CLI default gpt-6.1-sol — in the catalog; the fleet pins gpt-6.1-sol (catalog head)
  config      closed — OMELETTE_ALLOW_WRITE does not list "codex" · effective mode: read-only
              KEY              VALUE      SOURCE
              enabled          true       file
              mode             read-only  file
              model            (unset)    default
              timeoutS         600        file
  mcp         omelette-codex registered (user) → node ~/omelette-fleet/servers/codex.mjs [file exists]
  status feed ~/.omelette is writable
  results     ~/.omelette/results/codex · keep 50 · max 50 MB

No faults in units that are both enabled and registered.
```

### Which registrations are ours

A registration counts as ours by **where it points**, not by what it is called: the command is `node`, and its argument is exactly this clone's `servers/<unit>.mjs`.

- If you registered the units under your own prefix, `doctor` finds them anyway. It prints `prefix        orion (found on the registrations)` and reports under that name. A default install prints no `prefix` line, as in the sample above.
- Two different prefixes are ambiguous. `doctor` names both, keeps `omelette`, and leaves the choice to `--prefix`.
- A server of ours by name that points at another clone is "registered elsewhere".
- A project-scope entry counts only for the project you are standing in.

### Each line

| `doctor` line | What it reports | Fault? |
|---|---|---|
| `version` | The fleet's own version and the latest release (`version … · latest …`), with `[run: omelette-fleet update]` when you are behind, or `latest check disabled` | No: an unreachable GitHub is never a finding |
| `fleet home`, `fleet config` | Where the fleet keeps its files, and the config file it read; `(absent — built-in defaults in force)` when there is none | No |
| `claude CLI`, `claude config` | The `claude` binary it found, or `not found in PATH`; the `.claude.json` it read, with `[via CLAUDE_CONFIG_DIR]` when that variable sent it there | No |
| `mcp.json` | The project's `.mcp.json`, when there is one | No |
| `prefix` | The prefix it found on the registrations, when it is not `omelette` ([Which registrations are ours](#which-registrations-are-ours)) | No |
| `rules`, `agents`, `skills`, `hooks` | Each managed kind at both scopes, with its marker version; `hooks` also says whether the guard is wired ([every NOT-wired reason](ORCHESTRATION.md#what-doctor-says-about-the-wiring)) | No: a missing file is never counted |
| `guard` | The two deliveries of the guard: the settings hook and the fleet pane mod, each as it stands ([The two deliveries](ORCHESTRATION.md#the-two-deliveries)) | No |
| `handoff` | What the installed guard will do, read back out of the script itself: `stamp and print on · ledgers: 1`; `off (handoff.enabled=false)` when the switch is off; `ledgers: none (nothing to stamp — omelette-fleet ledger open <plan> starts one)` when the project keeps no ledger. Then the print after a `/clear` or a compaction carries the register and the backlog alone | No |
| `ledgers`, `decisions` | `ledgers` and `decisions` are printed when the project has an `.omelette/`; without a register the `decisions` row reads `.omelette/decisions.md — none yet`. `doctor` runs the ledger sweep first and prints its lines. `ledgers` counts the open, untracked and archived ledgers; `decisions` counts the register's lines, the struck ones and the pointers `check` does not find ok. A `warning` line follows past 30 unstruck lines, or with more than one open ledger. Every form: [CONFIG, "Ledgers and the decisions register"](CONFIG.md#ledgers-and-the-decisions-register) | No |
| `contract` | Which contract the unit servers send this project: `short (rules installed here)`, or the full one ([CONFIG](CONFIG.md#the-contract-and-why-auto-is-the-default)) | No |
| `merge policy` | The configured policy, and whether the rendered rules file carries its sentence yet ([CONFIG](CONFIG.md#workflow-settings)) | No: its PR-gated hint is a hint |
| `mcp timeout` | The client's own two timeout walls: the wall-clock `MCP_TOOL_TIMEOUT` against the longest call the enabled units can make, and the 30-minute stdio idle abort. It prints the snippet to merge when the first one is short ([CONFIG](CONFIG.md#client-timeouts)) | No: informational |
| `next` | The one thing still missing ([The next ladder](#the-next-ladder)) | No |
| `bin`, `version` (per unit) | The vendor binary it found, and its `--version`. A non-zero `--version` is `unknown (exit N)` with the tail of its output, never a version | Yes, when the binary is missing |
| `login` | The CLI's login state (Mistral: the `~/.vibe` file check, `absent` when neither file is there, which is not a fault). A `login status` with no explicit signal is `unknown (exit N)` with the tail of its output, never "signed out" | Yes, when the CLI says it is signed out; `unknown` is not |
| `homes`, `repro`, `billing` (mistral) | The two Vibe homes with the version and time of the last render (`not rendered yet` until the first call), the repro gate as doctor's own shell sees it (`open in this shell` or `closed in this shell`; the registration's env decides what the unit does) with whether `sandbox-exec` was found, and the billing scrub (`MISTRAL_API_KEY` scrubbed; the Keychain login is the only route) | No |
| `models` (grok, codex, mistral) | The CLI's own default model beside the catalog (Mistral prints the catalog head and the alias count, because Vibe reports no default); for Codex, also the model the fleet pins ([CONFIG](CONFIG.md#which-unit-actually-uses-which-key)) | No |
| `config` | The resolved config with sources, the effective mode and the write ceiling | No |
| `notice` (gemini) | Antigravity's terms are a grey zone for this unit on consumer plans. Printed when agy is found or the unit is registered ([SECURITY](SECURITY.md#antigravitys-terms-a-grey-zone)) | No |
| `mcp` | The registration, and whether its server file exists | Yes, when the registration points at a server file that no longer exists |
| `status feed`, `results` | Whether the status-feed directory is writable; the result spool's directory and bounds | No |
| `sandbox` (`--probe-sandbox` only) | The probe's verdict: `held`, `BREACHED` or `skipped` with its reason ([The sandbox probe](#the-sandbox-probe)) | Yes, for `BREACHED` |

### The next ladder

While something is missing, `doctor` prints ONE `next` line: the first of these that applies, in this order.

```
next          omelette-fleet install
next          <path> is a symlink — omelette-fleet refuses to manage it; remove the link, then rules --agents --hooks
next          a managed file has no omelette-fleet marker (see the rules/agents/skills/hooks lines) — inspect it, then `omelette-fleet rules --agents --hooks --force` replaces it
next          omelette-fleet rules --agents --hooks
next          merge the hooks snippet into .claude/settings.json (rules --hooks prints it)
next          raise MCP_TOOL_TIMEOUT to 1800000 ms — merge {"env":{"MCP_TOOL_TIMEOUT":"1800000"}} into your settings file (omelette-fleet never writes it)
next          the omelette-grok registration caps its own calls at 900000 ms — raise its "timeout" to 1800000 ms or drop the field (omelette-fleet never writes .claude.json or .mcp.json)
```

Once every step is done it prints nothing.

- The `install` line adds `--prefix <p>` when `doctor` reports on another prefix.
- The path line and the marker line are the two that are not a command. `rules` never writes through a link, not even with `--force`. A file at a managed path without the marker is somebody else's, and the plain command would refuse it. So `doctor` names the situation instead of sending you into a refusal. When the path is not a link but something else `rules` cannot write (`is not a directory`, `is not a regular file`), the line says `remove it` instead of `remove the link`.
- The ladder looks at the **project** scope only, the scope its commands write. A guard installed and wired globally still gets the merge line here.
- The two timeout lines come last on purpose (since 0.3.3). They are tuning for a machine that already works. The first names the shared `MCP_TOOL_TIMEOUT`; the second, one registration's own `"timeout"` field. The numbers come from your config.
- A `next` line is a hint, never a fault. It does not change the exit code.

### When doctor exits 1

`doctor` exits 1 only for a unit that is **enabled and registered** and broken: the vendor binary is missing, the CLI says it is signed out, or the registration points at a server file that no longer exists. Under `--probe-sandbox`, a `BREACHED` verdict exits 1 too. A unit you never wired up is not a fault, and neither is a login state of `unknown`.

### The sandbox probe

Two flags spend real vendor calls. Without them, `doctor` runs no model.

- `--probe-sandbox` spends one real call per unit that is enabled, registered as ours and has a binary. It is how you find out whether "read-only" is true on your machine rather than on paper. Its line looks like this:

  ```
    sandbox     held (12 s, replied "refused")
  ```

- `--probe-models` spends one real Codex call per catalog id, to test which ids your account accepts.

What the sandbox probe does step by step, every verdict it can print, and what it does and does not prove: [SECURITY, "The sandbox probe"](SECURITY.md#the-sandbox-probe).

## Fewer permission prompts

No unit tool can write to your project: each vendor CLI runs under that vendor's own read-only enforcement (a kernel sandbox for Codex, a permission policy for Gemini; [SECURITY](SECURITY.md#threat-model) says which is which) under the default read-only mode (`OMELETTE_ALLOW_WRITE` closed; [SECURITY, "The ceiling"](SECURITY.md#the-ceiling)) — so approving each call one at a time buys you nothing. Allowlist them once in `.claude/settings.json` (project) or `~/.claude/settings.json` (global):

```json
{
  "permissions": {
    "allow": [
      "mcp__omelette-gemini__*",
      "mcp__omelette-grok__*",
      "mcp__omelette-codex__*"
    ]
  }
}
```

- Use your own `--prefix` if you installed with one.
- If you register the servers per project through a checked-in `.mcp.json` instead of `claude mcp add -s user`, `"enableAllProjectMcpServers": true` in `.claude/settings.json` approves the servers themselves. The `permissions.allow` entries above still decide the per-tool prompting.
- This is a file you edit. omelette-fleet never writes `settings.json` or `settings.local.json`.

## CLI

| Command | What it does | Details |
|---|---|---|
| `install [--prefix <name>] [--units <a,b,c>] [--rules] [--dry-run] [--force]` | Registers one MCP server per unit as `<prefix>-<unit>` with `claude mcp add -s user`, and creates `<home>/fleet.config.json` from the shipped example if it does not exist yet (an existing file is never overwritten). A unit whose vendor CLI is not in `PATH` is skipped unless `--force`. `--rules` then runs `rules --agents --hooks` in the current directory and prints the settings snippet, so the whole first run is one command; it happens even when `claude` is missing, since the project files do not depend on it. `--dry-run` prints every command and every write — both halves — and runs nothing. Exits 1 if a `claude mcp add` fails, or if a managed file is refused | [Install the units](#install-the-units) |
| `uninstall [--prefix <name>] [--units <a,b,c>] [--dry-run]` | `claude mcp remove -s user` for those servers. Removing one that was never registered is a no-op; a removal that **fails for one that is registered** prints "Still registered" and exits 1. The fleet config and the status files are never touched | — |
| `update [--check]` | Reports the latest released version, then brings **this** install up to date. A git checkout is fast-forwarded (`git pull --ff-only`); a dirty tree or a diverged branch is refused, never overwritten. An install that is not a git checkout is left alone and the exact `npm i -g` line is printed. MCP registrations are never rewritten — they hold absolute paths a pull does not move. `--check` fetches but pulls nothing and exits 3 when an update is available, 0 when there is none | [Keeping it up to date](#keeping-it-up-to-date) |
| `rules [--global] [--agents] [--hooks] [--mods] [--print] [--remove] [--force] [--dry-run]` | Writes the fleet's operating rules — units propose and this session applies, the ledger and handoff rule, the tester flow, the routing table — to `<cwd>/.claude/rules/omelette-fleet.md`, which Claude Code loads like CLAUDE.md. `--global` writes it under `$CLAUDE_CONFIG_DIR` or `~/.claude` instead. `--agents` also writes four sub-agent definitions (`omelette-coder`: Opus 5.5 xhigh; `omelette-coder-medium`: Opus 5.5 medium; `omelette-tester`: Sonnet 5.5 high; `omelette-reviewer`: Opus 5.5 xhigh; each model pinned by exact id; all four `disallowedTools: Agent`, the reviewer also `Edit, NotebookEdit`) into `.claude/agents` — a definition is where a sub-agent's effort is set — and the `/omelette-test` skill into `.claude/skills`. `--hooks` writes the guard script into `.claude/hooks` and prints the settings snippet that calls it. `--mods` prints how to install the fleet pane mod and writes nothing. `--force` replaces a file that lacks the version marker; `--remove` deletes only files that carry it; `--print` sends the text to stdout; `--dry-run` prints every path and action and writes nothing | [ORCHESTRATION, Layer 2](ORCHESTRATION.md#layer-2-the-rules-file-and-its-marker) |
| `doctor [--prefix <name>] [--probe-models] [--probe-sandbox]` | Checks the install: per unit the binary, `--version`, login state, resolved config with sources, ceiling, MCP registration and status-feed writability; above them the managed files at both scopes, the client's two timeout walls and — while anything is missing — one `next` line, which is a hint and never a fault. `--probe-models` spends real Codex calls to test every catalog id; `--probe-sandbox` spends one real call per unit to test its read-only sandbox. Exits 1 only for a unit that is enabled, registered and broken, or one the sandbox probe caught writing | [What doctor tells you](#what-doctor-tells-you) |
| `show [<unit> \| fleet \| agents \| handoff \| workflow]` | Every config key for one unit or all of them: value, where it came from, and the ceiling. `show fleet` prints the top-level keys (`contract`, `updateCheck`); `show agents` prints the `agents` block that `rules --agents` renders the sub-agent definitions from; `show handoff` prints the auto-handoff block that `rules --hooks` renders into the guard; `show workflow` prints the merge policy that `rules` renders into the rules file | [CONFIG](CONFIG.md) |
| `set <key>=<value> \| <unit>.<key>=<value> \| agents.<agent>.<key>=<value> \| handoff.<key>=<value> \| workflow.<key>=<value> [...]` | Changes keys in the config file: a bare `<key>=<value>` is a top-level fleet key (`contract`, `updateCheck`), and the dotted forms edit a unit, an agent, the handoff block or the workflow block. Unknown units, unknown agents, unknown keys and invalid values are refused; the rest of the file is kept | [CONFIG, Editing with set](CONFIG.md#editing-with-set) |
| `call <unit> <tool> [json-args] [--timeout <seconds>]` | Drives a unit's server over real stdio (initialize → tools/list → tools/call). `json-args` must be a JSON **object**. Exit 0 = ok, 2 = the tool answered with an error, 1 = usage error or the call never completed. Default timeout 900 s, clamped to 1–86400 | Below the table |
| `results [<unit>] [<id>] [--path] [--stats [--since <when>]]` | Prints what the units spooled — every tool call's answer, written to `<home>/results/<unit>/<id>.md` before the response is sent: no arguments, the last 10 across the fleet, newest first; a unit, its last 10; a unit and an id, that result, header and text; `--path` prints the path instead, and `--stats` what the spool cost, narrowed by `--since`. Reads files only — no server, no vendor CLI, nothing spent. Exit 1 for an unknown unit, an id that is not in the spool, a `--since` that is neither a window nor a date, `--since` without `--stats`, `--stats` with an id, or `--stats --path` | [CONFIG, What the result spool keeps](CONFIG.md#what-the-result-spool-keeps) |
| `check <file.md> [--strict] [--require <n>] [--root <dir>]` | Verifies the pointer lines of a sub-agent report or a scout map — `path:line` (relative to the root) · a verbatim fragment in backticks · the claim. Read-only. Exit `0` when every pointer is `ok` — `stale` too, unless `--strict` — and there is at least one distinct pointer (`--require 0` for a report whose findings say `none`); `1` otherwise; `2` for a usage error | [ORCHESTRATION, Evidence with pointers](ORCHESTRATION.md#evidence-with-pointers) |
| `ledger open <plan>` \| `ledger sweep [--dry-run]` | `open` writes `.omelette/ledger-<plan>.md` headed `branch: <the current branch>`; `sweep` copies each closed ledger's `Ruling(binding):` lines into the decisions register, appends a `closed` line and moves the ledger to `.omelette/archive/` — the guard and `doctor` run the same sweep, so nobody has to call it | `open`: exit 2 for a usage error (no plan name, an invalid one, an extra argument), exit 1 on a refusal (a detached HEAD, an existing file, a plan name already in `.omelette/archive/`, a HEAD outside `refs/heads/`). `sweep`: one line per action and exit 0, even for a refusal; exit 2 for an unknown flag or argument. Every case: [CONFIG, Ledgers and the decisions register](CONFIG.md#ledgers-and-the-decisions-register) |
| `--help`, `--version` | Every subcommand answers `--help` / `-h` too, and so does `help <command>` | — |

`call` is the way to test a unit without a client: `omelette-fleet call codex codex_models '{}'`. It tells apart the two failures that matter. A tool that answered with an error exits 2: the unit is talking. A server that errored at the protocol level or died mid-call exits 1: the pipe broke. Neither is reported as an empty success.

Without `claude` in `PATH`, `uninstall` prints its commands and changes nothing; `install` prints its own and still writes the fleet config ([Install the units](#install-the-units)). Every file the CLI and the servers write: [SECURITY, "What the fleet writes down locally"](SECURITY.md#what-the-fleet-writes-down-locally). What they never do, shelling out included: [SECURITY, "What this package never does"](SECURITY.md#what-this-package-never-does).

## Keeping it up to date

```bash
omelette-fleet update          # fast-forward this checkout
omelette-fleet update --check  # report only; exit 3 = an update is available
```

- **Restart Claude Code afterwards.** The unit servers are spawned per session and there is no daemon. A running session keeps the code it started with until you restart it.
- **Refresh each project's managed files.** `update` never rewrites them. It prints the refresh command, such as `omelette-fleet rules --agents`, when a project's files are behind.
- **You do not have to remember to check.** Each unit server makes one unauthenticated request to the GitHub releases API at startup. When there is something newer, it prints one stderr line: `update: omelette-fleet X.Y.Z is available (you run …)`. The check runs at most **once every 24 hours** (the answer is cached in `<home>/update-check.json`), is capped at **2.5 s**, and is fire-and-forget, so it never delays a tool call. It stays quiet when you are current. Switch it off with `OMELETTE_UPDATE_CHECK=0` in the server's env block, or `"updateCheck": false` in the fleet config ([CONFIG, "Update check"](CONFIG.md#update-check)).
- **The vendor CLIs update themselves; this package deliberately does not.** `doctor` shows both: each unit's `version` line, and the fleet's own `version … · latest …` line. When a unit breaks overnight, suspect a vendor update first ([ORCHESTRATION](ORCHESTRATION.md#when-a-unit-breaks-overnight)).
