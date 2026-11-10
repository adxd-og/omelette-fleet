# The hard coders — two Fable 5.2 coders for the tasks the Opus coder loses rounds on, and Fable 5.1 retired

**Status:** approved by the operator 2026-11-10 in chat («давай хай, а мб и сейчас ххай добавить, но как extra-hard coder») — `high` as the hard coder, `xhigh` beside it as the extra-hard one; `xhard` follows a failed `hard` round automatically («можно авто ххард да, если хард не смог»); the short name `xhard` is the session's, [flagged below](#decisions) · **Base:** main `ee5c4d0` · **Version:** 1.10.0 (two more shipped roles are a minor; the gates program shifts one more minor)

| Question | Where |
|---|---|
| Why a third coder, and why not as the default? | [Why](#why) |
| Which numbers the effort choice rests on | [What is measured](#what-is-measured) |
| What the roles are: names, model, efforts, template | [1. The roles](#1-the-roles) |
| When the session routes to it — the rules text | [2. Routing](#2-routing) |
| Where Fable 5.1 is replaced and where it stays | [3. Fable 5.1 → 5.2](#3-fable-51--52) |
| Which files change | [4. Delivery](#4-delivery) |
| Tests | [5. Tests](#5-tests) |
| Who does what, in which order | [6. Who does what](#6-who-does-what) |
| What is deliberately not in it | [Non-goals](#non-goals) |
| What was decided, and by whom | [Decisions](#decisions) |
| When it is done | [Done-when](#done-when) |

## Why

- **The coders stop at Opus 5.5 xhigh.** A task that survives two fix rounds goes to the operator; there is no stronger coder to try first. 1.9.0's heredoc rule took a whole-branch fix round and a post-merge round on `omelette-coder`.
- **Fable 5.2 at `high` is a measured step above Opus 5.5 at `xhigh`**, not a restatement of it (table below).
- **Fable draws on its own quota, and the session lives in it.** On the operator's subscription Fable has a separate weekly limit, half of the general one (operator, 2026-11-10). Every Fable coder token is taken from the orchestrator. So the role is a named route with a reason, never the default and never a sweep.

## What is measured

Artificial Analysis Intelligence Index, per effort level, read from the model pages 2026-11-10 (general index, not a coding one; API list prices; one vendor's harness).

| Variant | Index | $ per task | Minutes per task |
|---|---|---|---|
| Opus 5.5 `high` | 52 | 3.46 | 9.5 |
| Opus 5.5 `xhigh` — today's `omelette-coder` | 57 | 6.05 | 16.2 |
| Fable 5.2 `low` | 54 | 3.10 | 6.5 |
| Fable 5.2 `medium` | 56 | 3.80 | 8.3 |
| **Fable 5.2 `high`** | **62** | 9.08 | 17.4 |
| Fable 5.2 `xhigh` | 62 | 14.83 | 26.3 |
| Fable 5.2 `max` | 65 | 26.54 | 44.6 |

- `high` → `xhigh` buys nothing on this index and costs 63% more and 9 more minutes. Anthropic's own guidance for 5.2: most of the gain arrives by `high`; `xhigh` "raised scores slightly on coding evaluations and used many more tokens" — use it where a gain is measured.
- `medium` equals `omelette-coder` (56 vs 57) at about 60% of the price and half the time. It is a faster same-grade coder, not a harder one — and it would move routine work from the Opus pool into the smaller Fable one.
- One independent single-task test: all four of Opus medium/high and Fable medium/high passed 59/59; Fable `high` cost 4.5× Opus `high`. On a task the Opus coder already solves, Fable buys nothing.
- Anthropic, "Which Claude model should you build with" (2026-11-09, read through a sub-agent): on FrontierCode 2.0 Fable 5.2 at `high` is level with Opus 5.5 at `max` (45.3% vs 45.5%) for about half the cost per task; on SWE-bench Pro Opus 5.5 at `xhigh` adds about 1.4 points over `high` at 2.5× the cost. Its ladder when a model falls short — let it verify with a test, raise effort one level, then the next model up at a lower effort — is the shape of [Routing](#2-routing): past Opus `xhigh` the next step is Fable below `xhigh`, not Opus `max`.
- Not measured by us. The first real dispatch is the measurement ([Done-when](#done-when)).

## 1. The roles

| | `omelette-coder-hard` | `omelette-coder-xhard` |
|---|---|---|
| Config block | `agents.coderHard` | `agents.coderXhard` |
| Model (default) | `claude-fable-5-2` | `claude-fable-5-2` |
| Effort (default) | `high` | `xhigh` |
| Index / $ / minutes per task | 62 / 9.08 / 17.4 | 62 / 14.83 / 26.3 |
| Pane label | `coder-hard` | `coder-xhard` |

Both are the coder's own template under another name, as `omelette-coder-medium` is (`AGENT_TEMPLATES`): the coder's tools (`disallowedTools: Agent`), one more whole name each in the guard's `GUARDED_AGENTS` (a refusal names the one it caught) and in the mod's `ROLES` (pinned at `agent.spawn`).

- **Why both now.** `high` is where the index gain arrives. `xhigh` shows none on the general index, but Anthropic reports a slight gain on coding evaluations and the one coding benchmark with per-effort figures puts Fable's lead over Opus above `high`. Shipping the second name costs one line per map and lets one task be run at either level without re-rendering a definition mid-plan.
- **`xhard`, not `extra-hard`:** the pane's boxes are cut to the width `coder-medium` fills; `coder-extra-hard` would show as an ellipsis. `hard` / `xhard` mirror `high` / `xhigh`.
- **One template, no Fable fork.** Anthropic's 5.2 notes that matter to a coder — stops early (mostly at `low`/`medium`), adds to the existing structure rather than restructuring — either do not apply at `high` or are what a briefed coder should do. A fork waits for a measured defect.
- **Not everyone has Fable.** The definition is written like the others; an install without Fable access never routes to it, or points `agents.coderHard.model` elsewhere. `doctor` does not probe model access today and does not start to.

## 2. Routing

Three sentences change in `rules/omelette-fleet.md`; the wording is the plan's to fit into the size cap.

| Where | Today | Becomes |
|---|---|---|
| Operating model, "A coder gets…" | `omelette-coder-medium` when the plan prints the exact text, `omelette-coder` otherwise | adds: `omelette-coder-hard` (Fable-class, the session's own quota) only by name, with its reason in the ledger line — a task the plan buckets `hard` (refusal or parser logic, a sandbox profile, concurrency, a cause two attempts did not find), or the fresh coder after a second fix round failed on the same finding — one at a time, never a sweep |
| same sentence | — | adds: `omelette-coder-xhard` only after `omelette-coder-hard` failed a round on the same finding, or on the operator's word — never a first dispatch of the session's own |
| Tester flow, step 6 | at most 2–3 rounds, then the operator | the last round before the operator may go to a fresh `omelette-coder-hard` (task, diff, findings); if that round fails on the same finding, one more to a fresh `omelette-coder-xhard`; then the operator |
| Spawning sub-agents | "installs four definitions…" | six, with `omelette-coder-hard` (Fable 5.2, `effort: high`), `omelette-coder-xhard` (Fable 5.2, `effort: xhigh`) and `claude-fable-5-2` among the pinned ids |

- **Why the escalation step costs nothing extra:** after a review past five minutes the coder's cache is gone and the rules already brief a fresh coder — the model changes on a dispatch that was cold anyway.
- **`hard` is a third bucket**, beside the two the rules already name; the planner assigns it with a reason, the session may overrule it, both go in the ledger line as today. There is no `xhard` bucket: a plan never routes there.
- **The ladder is `omelette-coder` → `hard` → `xhard` → the operator**, one round on each Fable step. A task bucketed `hard` from the start goes to `xhard` when its fix round fails on the same finding. "Failed" is the tester's or the reviewer's finding still standing after the round, ruled by the session — not the coder's own report.
- **Why `xhard` is never a first dispatch:** a run is about 26 minutes and two thirds dearer than `hard` for a gain nobody has measured on this code, out of the quota the session itself runs on. It is spent only where `hard` has already lost.
- **When the Fable window is short**, the session says so and the operator picks: wait, or `omelette-coder`. The package reads no quota.
- The planner, the tester and the reviewer keep their models.

## 3. Fable 5.1 → 5.2

| Place | Action |
|---|---|
| `mods/omelette-fleet/hooks/roles.mjs` — `ALIASES.fable` | `claude-fable-5-1` → `claude-fable-5-2` (the one behaviour: which id the `fable` alias stands for when the mod compares a call with a definition), and its test row |
| `docs/ORCHESTRATION.md` — the mod's alias map | same id |
| `docs/MODS.md` pane picture and the pane fixtures (`test/mod-layout`, `mod-model`, `mod-svg`, `mod-text`, `mods/.../register.test.ts`) | `fable-5-1` → `fable-5-2`: the examples show the current generation |
| `docs/MEASUREMENTS.md`, `CHANGELOG.md`, earlier specs and plans | **stay** — records of runs made on 5.1 and of prices of their date |
| `units/grok/models.js` guide line and its test | **stay** — xAI's table compares against Fable 5.1 Max; it is a fact about 5.1 |
| Outside the repo (the session, at approval): the gitignored `CLAUDE.md`, the operator's `fable-xhigh` definition's description | 5.2 |

## 4. Delivery

| Area | Files |
|---|---|
| Roles | `core/rules.mjs` (`AGENT_ROLES`, `AGENT_TEMPLATES`), `core/config.mjs` (`AGENT_SETTINGS_SCHEMA.coderHard`, `.coderXhard`), `bin/omelette-fleet.mjs` (help text, the `set` key spelling) |
| Guard | `hooks/omelette-guard.mjs` — `GUARDED_AGENTS` and the header comment; no refusal logic changes |
| Mod | `mods/omelette-fleet/hooks/roles.mjs` — `ROLES`, `ALIASES` |
| Rules | `rules/omelette-fleet.md` — the three sentences and the guard's list of names; `test/rules-size.test.mjs` cap raised with its dated comment |
| Docs | `ORCHESTRATION` (definitions list, defaults table, the mod paragraph), `CONFIG` (the four keys), `INSTALL` and `SECURITY` ("four roles" → six), `MODS`, the two diagrams that list role names (`guard-verdict`, `security-layers`: svg + html), `CHANGELOG`, `MEASUREMENTS` (the index table above, as the reason for `high`) |

## 5. Tests

Each pins a line of this spec; none reads source text.

- `rules --agents` writes `omelette-coder-hard.md` and `omelette-coder-xhard.md`, each the coder's body word for word with its own `name:`, `model: claude-fable-5-2` and `effort: high` / `xhigh`; `set agents.coderHard.effort=…` re-renders its file and leaves the other alone; an invalid level is refused.
- The guard refuses a `git commit` from each of the two and names the one it caught; `omelette-coder-hard-2` is not guarded (a whole name, not a prefix).
- The mod pins a call that names another model for either role; `fable` is the definition's model, not an override; the pane labels them `coder-hard` and `coder-xhard`.
- The rendered rules file fits the new cap.

## 6. Who does what

| Task | Who |
|---|---|
| T1 role, config, guard name, mod — exact diffs in the plan | `omelette-coder-medium`, then `omelette-tester` with the second pass |
| T2 Fable 5.1 → 5.2 (mod alias, fixtures) | `omelette-coder-medium`, tester |
| T3 rules template and the cap | the session (three sentences), tester's suite run |
| T4 docs, diagrams, CHANGELOG | a cheaper model, session review |
| Reviews before merge | Opus whole-branch, Grok, Codex (what the free tier allows — say so); the branch is pushed to CI before the merge (1.9.0's lesson) |

## Non-goals

- No Fable `medium` variant (it equals `omelette-coder` and would move routine work into the Fable pool), no change to `omelette-coder`'s or the reviewer's model.
- No automatic model bump — pins still move in a release (backlog, after the guard debt).
- No quota reading, no Fable access probe in `doctor`.
- No coder template fork for Fable.

## Decisions

| What | Who, when |
|---|---|
| A hard coder on Fable 5.2 at `high`; an extra-hard one at `xhigh` beside it | operator, 2026-11-10 |
| Fable 5.1 replaced by 5.2; automatic model bumps later, after the guard debt | operator, 2026-11-10 |
| The names `omelette-coder-hard` / `omelette-coder-xhard` (the operator said "hard coder" and "extra-hard coder"; `xhard` is the pane-width spelling) | session — operator may rename before T1 lands |
| `xhard` runs automatically when `hard` failed a round on the same finding, otherwise only on the operator's word | operator, 2026-11-10 («можно авто ххард да, если хард не смог») |
| 1.10.0 | session, by the minor-per-role rule |

## Done-when

- `npm test` pristine, CI green on the pushed branch, three reviews ruled, merged, tagged `v1.10.0`, released, managed files re-rendered here.
- Live gate: a probe sub-agent of each role — its transcript names `claude-fable-5-2`, the guard refuses its `git commit`; the vendor matrix row and the units-per-release line are in MEASUREMENTS.
- **The measurement rides the next release:** the guard-debt patch's refusal-logic task goes to `omelette-coder-hard`, and MEASUREMENTS gets its row — tokens, wall clock, fix rounds, review findings — beside 1.9.0's heredoc task on `omelette-coder` (unmatched, N = 1, said so). An `xhard` row is added the first time one runs.
