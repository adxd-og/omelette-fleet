# Mistral unit — Large 4 as the fleet's security reviewer, and a repro profile under Seatbelt

**Status:** approved by the operator 2026-11-06 in chat («Да, звучит хорошо»), including 1.9.0 for the unit and the gates program shifting one minor · **Base:** main `af5c6ef` · **Version:** 1.9.0 (a fourth unit is a minor; the program's "1.9.0 — the gates" and its successors shift one minor, operator to confirm)

| Question | Where |
|---|---|
| Why a fourth unit, and why this model? | [Why](#why) |
| What the probes established, verbatim | [What is measured](#what-is-measured) |
| What the unit is: tools, spawn, env, outputs | [1. The unit](#1-the-unit) |
| Which models, at which effort, at what price | [2. The catalog](#2-the-catalog) |
| How the repro profile executes code without reaching the operator | [3. The repro profile](#3-the-repro-profile) |
| What the posture is and what it misses | [4. Security](#4-security) |
| Install, doctor, rules, pane, docs | [5. Delivery](#5-delivery) |
| Tests | [6. Tests](#6-tests) |
| Who does what, in which order | [7. Who does what](#7-who-does-what) |
| What is deliberately not in it | [Non-goals](#non-goals) |
| When it is done | [Done-when](#done-when) |

## Why

- **The fleet has no reviewer that will reproduce.** The 2026-10-20 audit's two findings that needed a live run (#5 parent-directory race, #6 guard quotes) were found by nobody in the 2026-11-06 replay (four read-only arms); Codex found them in October by running things, and Codex on the operator's free tier now refuses the models that did it. Closed frontier models score near zero on reproduce-and-patch because they refuse the work (Hugging Face, Mistral Large 4 card); Large 4 reports 82% there.
- **Large 4 measured well on our own task.** Replay of the audit on the 1.7.1 snapshot, read-only tools, one run: 9 findings, 3 of the 6 keys, 2 new low findings, 3 rejected as documented behaviour, **0 wrong claims, 0 drifted pointers**, 12.6 min, 4.65 M tokens at $0 on the plan (`.omelette/evals/runs/2026-11-06-security-replay/summary.md`). Grok 4.7 on the same brief: 12 findings, 3 keys, 1 wrong. GLM-5.3 Flash (free on the plan): 4 findings, 2 keys, 2 of 4 pointers drifted.
- **It is cheap and already paid for.** Large 4 and GLM-5.3 Flash cost $0 on the operator's plan; the two paid catalog models carry list prices Vibe enforces with `--max-price`.
- **The vendor CLI gives the adapter what the others lack.** Headless mode with a time limit that exits 3 and still writes `export.json` (usage, cost, outcome, stop reason), a tool allow-list, a per-tool shell override that lets a kernel sandbox sit under every command the model runs.

## What is measured

Probes run 2026-11-06 on Vibe 3.1.0 (`uv tool install mistral-vibe`), macOS, operator signed in through the browser flow (Keychain). Ledger: `.omelette/ledger-lane.md` 2026-11-06.

| # | Probe | Result |
|---|---|---|
| 1 | `vibe -p … --output text --output-dir D` | `D/export.json` holds `outcome`, `stop_reason`, `error`, `usage{input,output,cached_input,total}`, `cost_usd`, `steps`, `limits`, `exit_code`, `config` (the effective config, catalog included) |
| 2 | project `.vibe/config.toml` with `[tools.bash] shell = <wrapper>` | every model command reaches the wrapper as `-c <cmd>`; Vibe's own startup login-env probe reaches it too, as `-lc printf '%s' mistralai-vibe-login-env-<id>; …; exec env -0` |
| 3 | `--time-limit 20` against `sleep 90` | `Stopped: deadline`, exit 3, `outcome: deadline`, `stop_reason: interrupted`, usage filled |
| 4 | clone + wrapper `sandbox-exec -f repro.sb` under every command | `node --test` passes inside the clone; write to `/tmp` → `Operation not permitted`; `curl` → no resolve; `ls ~/.ssh` → denied; write inside the clone ok; 6 steps, 66 k tokens |
| 5 | `VIBE_HOME=<dir>` with the unit's own `config.toml` | policy applies (telemetry, update checks, auto-update, subagents, MCP, connectors off; `outside_workdir = deny`); Keychain login still works; `~/.vibe` untouched. **The plan's catalog is absent in a fresh home: Vibe printed "Model 'mistral-large-4-0-3' is not available — running 'Mistral Medium 3.5'" and ran the paid model** |
| 6 | `models = [{ name, provider = "mistral", alias, thinking }]` in that `config.toml` | the named models are available under their aliases, Large 4 runs, no fallback notice; the plan's catalog lives in a server-pushed feature-flag cache (`experiment_eval_cache.json`), not in a documented file |

Replay numbers: §Why, and the run folder.

## 1. The unit

`units/mistral/adapter.mjs` + `units/mistral/models.js` + `servers/mistral.mjs`, through `defineUnit` like the three others. `name: 'mistral'`, `bin: 'vibe'`, server name `<prefix>-mistral` (the operator's `orion-mistral`).

### Tools

| Tool | Kind | What it does |
|---|---|---|
| `mistral_security_review` | run | Read-only review of `cwd` (absolute, must exist) with the unit's security prefix — what an attacker gains, four-part findings, `total:` line — plus the caller's prompt. Tools handed to Vibe: `read_file`, `grep`. Default model Large 4 at high. |
| `mistral_security_repro` | run | The same brief, executed: a disposable clone of `cwd`'s HEAD under the Seatbelt wrapper (§3). Gated by `OMELETTE_ALLOW_REPRO=1`, refused otherwise with the gate named. Returns the report and, when the clone's tree changed, `git diff` of the clone appended by the **adapter** under a `proposed patch (not applied)` heading. |
| `mistral_models` | catalog | The catalog with prices, effort levels, the plan note, and the two routes (review / repro). |
| `mistral_result` | result | The spool, as every unit has it. |

No research, no image, no general code review tool: Vibe has web tools and image models, and they are not what the unit is for (Non-goals).

### Spawn

Argv, one array, no shell:

```
vibe --workdir <cwd|clone> --trust --agent auto-approve
     --enabled-tools read_file --enabled-tools grep [--enabled-tools bash]   # repro adds bash
     --model <alias from models.js>
     --max-turns <cfg.maxTurns> --max-price <cfg.maxPrice> --time-limit <cfg.timeoutS − 15>
     --output text --output-dir <spool tmp> --prompt-file <spool tmp>/prompt.md
```

- `--prompt-file`, never `-p`: the brief holds the caller's text and goes through a file the unit owns (0600, `wx`), so no argv length limit and nothing of it in `ps`.
- `--time-limit` sits 15 s inside the unit's `timeoutS` so Vibe stops itself and writes `export.json` before the fleet's own kill; exit 3 with `outcome: deadline` is returned as a partial answer marked `deadline`, as `core/partial.mjs` does for the others — never re-run.
- `--trust` is required for a headless run in an untrusted folder; it trusts the run's workdir for that invocation only (probe 2, 4).
- The model's fallback is refused: after the run the adapter reads `export.json` `config.active_model` and the first assistant entry's `model` in the session journal; if either is not the requested catalog entry the answer is returned as an error naming both (probe 5: Vibe substitutes a paid model silently).

### Environment

- The fleet allowlist (`core/spawn.mjs`) plus `HOME` (Keychain lookup; today's allowlist already carries it for the others) and `VIBE_HOME=<fleet home>/vibe/<profile>/`.
- `riskEnv: ['MISTRAL_API_KEY']` — scrubbed like `OPENAI_API_KEY` is for Codex: the unit runs on the operator's plan through the Keychain login, never on a per-token key. The operator who wants key billing sets it through `OMELETTE_ENV_PASSTHROUGH` on purpose, and `doctor` says which one is in force.
- `envPassthrough: []`.
- Two Vibe homes, rendered by the unit at start (`wx`, re-rendered when `models.js` or the config changed, the same `syncManagedFile` discipline as the rules files): `<home>/vibe/review/config.toml` and `<home>/vibe/repro/config.toml`. Each carries: the policy block of probe 5 (`enable_telemetry = false`, `enable_update_checks = false`, `enable_auto_update = false`, `enable_subagents = false`, `enable_mcp = false`, `enable_connectors = false`, `outside_workdir = "deny"`, `show_greeting = false`), the `models` list from `models.js` (probe 6), and for repro `[tools.bash] shell = <home>/vibe/repro/shell.sh`. The operator's `~/.vibe` is never read or written by the unit.
- **The login-env probe is intercepted.** Vibe's startup runs `<shell> -lc …mistralai-vibe-login-env…; exec env -0` and takes that output as the environment for every later tool command — a login shell sources the operator's `.zprofile`/`.zshrc`, which re-admits every exported key the fleet's allowlist and scrub just removed. Both profiles' wrappers answer that probe with the wrapper's own (allowlisted) environment through `env -0` and never start a login shell. The review profile therefore also carries a `shell.sh`, with no sandbox, only this interception. A plan task probes that the model's `bash` then sees the allowlisted env and nothing from `.zshrc`.

### Outputs

Answer = Vibe's stdout (`--output text`, the final assistant message). `export.json` → `usage` (the fleet's real-token accounting line, as Codex reports it), `cost_usd` (Vibe's estimate from catalog prices; printed as `est.`, never as a bill), `outcome`, `exit_code`, `steps`. The spool entry keeps `export.json` next to the answer; the session journal is not kept (size).

### Config keys (`fleet.config.json`, `mistral.*`)

`model` (alias, default `mistral-large-4-0-3`), `effort` (`low|medium|high`, default `high`), `timeoutS` (review 1500, repro 2400), `maxTurns` (150), `maxPrice` (review 1, repro 3 — dollars, Vibe-enforced), `repro.keep` (`false`; `true` keeps the clone for the session to inspect, path in the answer), `repro.tools` (`bash,read_file,grep`, §3). `omelette-fleet set mistral.model=…` works as for the others.

## 2. The catalog

`units/mistral/models.js`, the single source, rendered into both Vibe homes. Ids are Vibe aliases (ours) over vendor model names (theirs); effort is Vibe's `thinking` per model entry, so one catalog entry per (model, effort) alias — `mistral-large-4-0-3` is the high entry, `…-medium` and `…-low` the others, as agy bakes effort into the id.

| Alias (ours) | Vendor name | Thinking | Price in/out $/M (Vibe catalog, read 2026-11-06) | Role |
|---|---|---|---|---|
| `mistral-large-4-0-3` (+`-medium`, `-low`) | `mistral-large-4-0` | high / medium / low | 0 / 0 on the plan (list 0.70 / 2.10) | **default**: security review and repro |
| `zai-glm-5-3-flash` (+`-low`, `-max`) | `zai-glm-5-3-flash` | high / low / max | 0 / 0 on the plan | cheap sweep, second opinion; pointers drift, verify |
| `glm-5-3` | `zai-glm-5-3` | high / low / max | 1.4 / 4.4 | named route only, `maxPrice` applies |
| `mistral-medium-3.5` | `mistral-vibe-cli-latest` | high / off | 1.5 / 7.5 | named route only; **Vibe's silent fallback target** |

The `mistral_models` output carries the replay numbers as the "measured on our task" line, the way the Grok catalog carries AA numbers, and says that a plan covers the two $0 rows and that the console's Usage page, not `cost_usd`, is the bill. Whether the plan also covers the two paid rows is unknown (probe: `cost_usd` > 0 for both; the console was not read) — the catalog says so until the operator reads the console.

## 3. The repro profile

The first unit that executes code. Three layers, in order of trust:

1. **A disposable clone, never the working tree.** `git clone --no-hardlinks --depth 1 file://<cwd> <home>/repro/<id>/` — HEAD only: uncommitted work, `.env`, ignored files are not in it (the answer says so; the session commits first when the change under test matters). The clone is deleted after the answer unless `repro.keep`. `<cwd>` must be a git work tree; otherwise refused.
2. **The kernel under every command.** `[tools.bash] shell = <home>/vibe/repro/shell.sh`; the wrapper execs `sandbox-exec -D CLONE=… -D TMP=… -D HOME=… -f <home>/vibe/repro/repro.sb /bin/bash "$@"`. The profile (probe 4, verbatim in `units/mistral/repro.sb`): `(allow default)`, `(deny network*)`, `(deny file-write*)` then allow under the clone, the run's TMP, `/private/var/folders`, `/dev/null`, ttys; `(deny file-read*)` on `~/.ssh`, `~/.aws`, `~/.omelette`, `~/.vibe`, `~/.config`. Child processes inherit it. Not on Linux: `sandbox-exec` absent → `mistral_security_repro` refuses with the reason and `doctor` says `repro: macOS only (1.9.0)`.
3. **Vibe's policy as the second belt.** `--enabled-tools bash read_file grep` and nothing else, `outside_workdir = deny`, `enable_subagents = false`, `--max-turns`, `--max-price`, `--time-limit`.

**Why `edit` and `write_file` are off** (Ruling, in the plan's ledger): they are Vibe-native, in-process tools — the Seatbelt under `bash` does not see them, only `outside_workdir` policy does. With them off every write the model makes goes through the sandboxed shell. Cost: the model patches through `cat > file <<EOF` and `sed`, clumsier; `repro.tools` lets the operator turn them on knowingly.

**What the unit returns.** The model's report; then, if `git -C <clone> status --porcelain` is non-empty, `git -C <clone> diff` (and `diff --no-index` for new files) under `## proposed patch (not applied)`, appended by the adapter, never by the model, so the heading is trustworthy. Nothing is applied: the session reads the diff, and the change, if any, goes through the coder. `OMELETTE_ALLOW_WRITE` stays what it is; `OMELETTE_ALLOW_REPRO` is its own gate because executing code in a clone is a different thing from writing the tree, and the two are opened separately.

## 4. Security

For `docs/SECURITY.md`, in its shape (posture, what it misses, how to confirm):

- **Review profile:** policy only — Vibe's allow-list (`read_file`, `grep`) and `outside_workdir = deny`; the model reads what the operator can read under `cwd`; the answer is the only exit (no web tools, no bash). Same class as Gemini's posture, said so.
- **Repro profile:** kernel for every shell command (Seatbelt), policy for the in-process reads. What it misses: `read_file`/`grep` are in-process and bounded by `outside_workdir` only (a Vibe bug there reads outside the clone — the Seatbelt read-denies do not apply to Vibe's own process); the Vibe process itself has the network (it must, for the API), so whatever the model reads with `read_file` can leave in the answer or in the request — the same limit every unit has, written down; `/private/var/folders` is writable (npm/node caches); a model command can fill the disk under the clone (`--time-limit` bounds the run, not the bytes).
- **Both:** the login-env interception (§1) is what keeps the operator's `.zshrc` exports out of the model's shell; the Keychain token is Vibe's, read in-process, never in the child env; telemetry and auto-update are off by config — Vibe's `enable_auto_update` would otherwise replace the binary mid-release (the fleet's CLI auto-update policy is "let the vendor update"; here the update would run inside a unit's spawn, so it is off and `doctor` reports the version the way it does for the others).
- **The model is not a source of record** — ORCHESTRATION's "Never a sole source" gets its row: on the replay, 0 of 9 claims wrong, but 3 of 9 reported documented behaviour as findings; the session rules every finding.
- `doctor` prints: `vibe` version and path, the two homes rendered and at which catalog version, the login present (`~/.vibe/config.toml` or `.env` exists — not read), `sandbox-exec` present, `OMELETTE_ALLOW_REPRO` state, `MISTRAL_API_KEY` scrubbed or passed through.

## 5. Delivery

- `bin/omelette-fleet.mjs`: `install` / `uninstall` / `doctor` / `call` / `results` / `set` know the fourth unit (the unit list is data; the plan names the lines).
- Rules template (`rules/omelette-fleet.md`): routing rows `Security review with a model that reproduces | Mistral mistral_security_review, then mistral_security_repro under OMELETTE_ALLOW_REPRO=1` and the "Never a sole source" line; the rendered file is at its size cap (18 843 / 18 850) — the cap moves in this release, and the test with it.
- Mod pane: a fourth unit row, same snapshot schema (`core/status.mjs`), nothing new.
- Docs: ADAPTERS (the unit's section in the shape of the others), SECURITY (§4), ORCHESTRATION (routing + catalog), CONFIG (`mistral.*` keys, the two homes), INSTALL (`uv tool install mistral-vibe`, the browser login, the plan), README unit list, CHANGELOG 1.9.0, MEASUREMENTS (the replay table as this release's measurement row; the live gate adds `vibe --version` to the vendor matrix).
- Evals: `scripts/eval-run.mjs` gains the `mistral:<alias>` arm so round two can run V on it through the unit — a dev-only script change, in this release because the replay is the baseline it compares against.

## 6. Tests

Fake `vibe` in `test/` like the three fakes: it writes `export.json` from a scripted outcome and prints a scripted answer. Tests earn their place by the operator's rule (pin a spec line, kill a mutant, pin a defect):

- argv shape per profile (no `edit`/`write_file` in repro by default; `--time-limit` = `timeoutS − 15`; `--prompt-file` used, never `-p`);
- the fallback refusal (export `active_model` ≠ requested → error naming both);
- deadline → partial answer marked `deadline`, exit 3 not treated as failure;
- the gate (`OMELETTE_ALLOW_REPRO` unset → refused before any spawn; `OMELETTE_ALLOW_WRITE` alone does not open it);
- the homes: rendered `wx`, policy block present, `models` from `models.js`, `~/.vibe` never touched (HOME pointed at a temp dir in the test);
- the login-env interception: the wrapper answers the probe line with `env -0` of its own env and does not exec a login shell (shell script tested by running it);
- the Seatbelt profile file renders with the clone and TMP params and parses (`sandbox-exec -n` is not a thing; the test runs `sandbox-exec -f … /usr/bin/true` on macOS and skips elsewhere);
- the clone is HEAD-only and deleted after; `repro.keep` keeps it and the answer names the path;
- the appended diff heading comes from the adapter (a scripted model answer containing the heading is prefixed, not trusted);
- Linux: repro refuses with the reason; review runs;
- `riskEnv` scrub and `doctor` lines; the rules size cap; `eval-run` arm parsing.

## 7. Who does what

1. **Plan** (`docs/superpowers/plans/2026-11-06-1.9.0-mistral-unit.md`), from this spec, by the session: tasks T1 catalog + homes + wrapper (login-env interception, probed), T2 adapter review profile + spool + fallback refusal + deadline, T3 repro profile (clone, Seatbelt, diff, gate, Linux refusal), T4 CLI/doctor/install/rules/pane, T5 docs + CHANGELOG + MEASUREMENTS + eval-run arm. Each task: coder (`omelette-coder`, xhigh for T2/T3; `omelette-coder-medium` for T1/T4/T5 where the plan prints the text) → tester, clean context, two passes → arbitration → commit on `feat/mistral-unit`.
2. **Reviews before merge:** Grok whole-branch; Mistral's own `mistral_security_review` on the branch (the unit reviewing its own adapter, as Codex did for its); an Opus `omelette-reviewer` whole-branch read; Codex when the operator's tier allows a sol/astra model, otherwise recorded as skipped. Fix round ≤ 2–3, then the operator.
3. **Live gate:** `doctor` with the real `vibe`; one `mistral_security_review` on this repo; one `mistral_security_repro` on this repo with `OMELETTE_ALLOW_REPRO=1` asking for key #6 (guard quotes) to be reproduced — the probe the whole unit exists for; `results --stats` row; vendor matrix row.
4. Release by the flow in CLAUDE.md; push, tag, GitHub release on the operator's word.

## Non-goals

- Linux/Docker repro, a Colab "remote repro" profile, the Colab ≥27B local arm — backlog (evals #4, the Mistral line).
- Research / web tools, image generation, a general-purpose `mistral_code_review`: Vibe can, the unit does not; a second spec if measured useful.
- Routing the paid rows (`glm-5-3`, `mistral-medium-3.5`) anywhere by default; they are catalog entries with a price.
- Reading the operator's `~/.vibe` for anything, including its catalog.
- Replacing Codex as the final pre-release auditor: Large 4 is a second auditor that reproduces; the routing table keeps astra where it is for when the tier allows it.

## Done-when

- `npm test` pristine on macOS and Linux (repro tests skip on Linux by design, review tests run).
- `omelette-fleet doctor` shows the fourth unit green with the operator's prefix; `call mistral mistral_security_review` and `… mistral_security_repro` (gate open) answer on this repo; the repro answer carries a real `proposed patch (not applied)` or says the tree was unchanged.
- The replay's numbers and the live gate's run are in MEASUREMENTS; `.omelette/ledger-mistral-unit.md` closes with its review yield; CHANGELOG 1.9.0 dated; managed files re-rendered here.
