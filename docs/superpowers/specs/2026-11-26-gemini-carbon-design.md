# 1.14.0 — Gemini 4 Carbon: into the catalog, then an eval for a role

Status: **approved by the operator, 2026-11-26** — «давай все по рекомендациям»: the five decisions are ruled as recommended. His word that opened it, the same day: «карбон надо подключать и проверить его качество, поискать в сети». Builds on 1.12.0 (`2026-11-19-gemini-neon-design.md`) and the Neon eval (`2026-11-19-evals-neon-design.md`). Branch `feat/gemini-carbon`, ledger `.omelette/ledger-carbon.md`.

| Section | Answers |
|---|---|
| [Why](#why) | What Carbon is, what was read and run, each figure with its source and level |
| [Not confirmed](#not-confirmed) | What no source states, and so what the catalog will not say |
| [Decisions](#decisions-the-operators) | The five things the operator rules, each with the session's recommendation |
| [Part one — the catalog](#part-one--the-catalog-1140) | Entries, wording, what leaves on 2026-11-30, tests, the live gate |
| [Part two — the eval](#part-two--the-eval-a-role-for-carbon) | Arms, suites, the rule written before the run, cost and the stop line |
| [Not here](#not-here) | What stays out |

## Why

Google announced Gemini 4 Carbon on 2026-10-28 for a closed group, published its card on 2026-11-10, and the operator's `agy models` listed it on 2026-11-25. Everything below was read or run on 2026-11-26.

**agy 1.5.17** (`agy models`): `Gemini 4 Carbon (Low|Medium|High)` — no XHigh — slugs `gemini-4-carbon-low|-medium|-high`, and `Orchestrator (Carbon)`. `(High)` and `(Medium)` each answered a one-word prompt headless on the operator's Google AI Pro sign-in in 6 s, with the unit's own flags. Still listed: Neon ×4, Hydrogen ×4, Argon ×3, 3.8 Flash ×3, GPT-OSS 120B, the Claude tiers. agy updated itself to **1.5.18** the same day: `agy models` prints the same 27 lines, GPT-OSS among them; the two headless Carbon runs above were on 1.5.17, and the live gate runs Carbon on what is installed then.

**Antigravity** ([models](https://antigravity.google/docs/models), [plans](https://antigravity.google/docs/plans)): «Gemini 4 Carbon is included on paid Google AI Pro plans …, Google AI Ultra, and Gemini Enterprise within the shared Gemini quota»; levels Low, Medium, High. «Gemini 4 Argon, Gemini 3.8 Flash, GPT-OSS-120b, and Claude 4.6 models are leaving on November 30, 2026.» The Orchestrator is a planner (Neon by default, Carbon or Argon) paired with Hydrogen; its effort cannot be set.

**DeepMind model card**, published 2026-11-10 ([card](https://deepmind.google/models/model-cards/gemini-4-carbon/)): «based on Gemini 4 Argon», «using more thinking tokens than Gemini 4 Argon»; 1M tokens for input and output together; knowledge cutoff March 2026; text, image, audio and video in. Its table, against Argon, GPT-6 Astra, Claude Opus 5.5 and Claude Fable 5.1, **states no thinking level for any row or column**: AA Index v5.0 59; Terminal-Bench 4.0 65.2 (Opus 5.5 59.6); FrontierSWE 2 61.2 (behind Astra's 65.5); OSWorld-2.1 offline 81.5 (behind Opus 5.5's 87.2); Agents' Last Exam v1.1 77.4; GraphWalks 256k–1M 96.2; Terminal-Bench-Science 0.1 64.8; CWE-bench 71.0; ExploitGym 54.8; SEC-bench Pro 88.2 — the three security rows «when accessed through the Fairwind Program», which the operator's sign-in is not.

**Launch post** ([blog.google](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-carbon/), 2026-10-28): Gray Swan indirect prompt injection 0.0 % attack success (Argon 0.7 %), no level stated; external benchmarks «evaluated without guardrails»; API $2 / $10 per Mtok introductory, $4 / $20 after.

**Artificial Analysis**, Index v5.0.2, Neon and Carbon on one page, all seven levels ([comparison](https://artificialanalysis.ai/models/comparisons/gemini-4-neon-vs-gemini-4-carbon)):

| | Index | $ per task | Minutes per task | Terminal-Bench 4.1 | FrontierCode-AA 2.0 | CritPt v2 | AA-Omniscience | GDP.pdf |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Neon (xhigh) | 62 | 6.44 | 28.0 | 65.2 | 44.4 | 60.5 | 55 | 28.0 |
| **Carbon (high)** | 60 | 7.76 | 42.2 | 66.2 | 40.6 | 69.0 | 54 | 28.4 |
| Neon (high) | 60 | 3.74 | 14.8 | 63.6 | 43.3 | 59.0 | 54 | 33.4 |
| **Carbon (medium)** | 58 | 6.59 | 28.1 | 61.6 | 39.5 | 69.0 | 47 | 29.6 |
| Neon (medium) | 55 | 1.90 | 8.8 | 55.1 | 36.9 | 61.5 | 51 | 32.8 |
| **Carbon (low)** | 54 | 7.19 | 29.9 | 62.1 | 29.6 | 65.0 | 39 | 28.6 |
| Neon (low) | 44 | 0.75 | 3.8 | 32.8 | 26.9 | 62.0 | 49 | 31.4 |

- Carbon (high) equals Neon (high) on the Index for 2.1 times the dollars and 2.9 times the minutes. It leads Neon (high) on Terminal-Bench 4.1 (66.2 vs 63.6) and CritPt v2 (69.0 vs 59.0), by less on HLE-Diamond (69.1 vs 68.4); it trails on FrontierCode-AA (40.6 vs 43.3), AA-Briefcase (1611 vs 1631), GDP.pdf (28.4 vs 33.4), AutomationBench-AA (77.8 vs 79.2) and Terminal-Bench-Science (64.8 vs 65.7).
- Carbon (low) costs more per task than Carbon (medium) and takes longer, for four Index points less; Neon (medium) is one point above it at a quarter of the dollars.
- AA's own words for Carbon (high): «notably slow per task and very verbose».
- The catalog's Neon rows are from v5.0.1 (2026-11-19): xhigh is now 62 and 28.0 minutes (was 61, 21.5), medium 8.8 minutes (was 8.3).

**The fleet's own measure of Neon** (round 2026-11-20, `docs/MEASUREMENTS.md`): research net 15 against Hydrogen's 15; review precision 41 % with 4 fabricated findings, against the native reviewer's 75 % and none; patches 6 of 6 green; injection 8 safe of 8. One Neon (High) review call took 635 s against the unit's `timeoutS` of 900.

## Not confirmed

Nothing below is written into the catalog as a fact.

- **What a Carbon call costs the Gemini pool against a Neon or Hydrogen call.** «Within the shared Gemini quota» says which pool, not how much. Part two reads it at its first call.
- The thinking level behind the card's table and the post's figures.
- When Carbon reached paid Pro (a unit's answer says 2026-11-23; no page read states the date).
- Carbon's context window inside Antigravity (the card says 1M; the models page gives none for Carbon and 512K for Neon).
- The security rows outside the Fairwind Program: what the same model scores behind the consumer guardrails is published nowhere.
- AA's hallucination rate by level (a unit's answer gives 4 % at medium and 11 % at high; the pages read carry the Omniscience score only).

## Decisions (the operator's)

All five ruled as recommended, 2026-11-26.

1. **Which levels enter.** **High and Medium**; Low stays out — on AA it is slower and dearer than Medium for less, and Neon (Medium) beats it at a quarter of the cost.
2. **What Carbon is in the catalog until the eval.** A **named one-call route**, tier `heavy`, never the default, a sweep or a deep-research stage — the step for a terminal-agent or hard-reasoning question where Neon (High) fell short, at about three times Neon's wait. The tie-breaker stays `Gemini 4 Neon (High)`.
3. **Does the eval run, and which arms.** Yes, the short round of part two — Carbon (High) on review, research and injection, nothing on patches.
4. **The rule for a role**, fixed before the run: part two's wording.
5. **What leaves with this release.** `GPT-OSS 120B (Medium)` leaves the catalog if the release ships on or after 2026-11-30 and `agy models` no longer lists it; before that it stays with its removal date in `avoid`. Part one is built for the second case — agy 1.5.18 lists it on 2026-11-26.

## Part one — the catalog (1.14.0)

**Entries** (`units/gemini/models.js`): Hydrogen ×3, Neon ×4, then Carbon per decision 1, then Claude ×4 and GPT-OSS.

| id | effort | tier |
|---|---|---|
| `Gemini 4 Carbon (Medium)` | Medium | heavy |
| `Gemini 4 Carbon (High)` | High | heavy |

`stageModels` takes the first `gemini` + `balanced` entries: with Carbon filed `heavy`, deep research stays on Hydrogen with no code change.

What the entries say:
- **Carbon (High)** — level with Neon (High) on AA's Index at 2.1 times the dollars and 2.9 times the minutes; its two leads (Terminal-Bench 4.1, CritPt v2) and the rows it trails on; the card's shape and the card's table under «no level stated»; the injection figure under «no level stated». `avoid`: sweeps, lookups, anything Neon (High) answers; a long task can end at `gemini.timeoutS` (900 s in the operator's config; AA's 42 minutes is per Index task) — raising it is config; the security rows are Fairwind's, not this sign-in's.
- **Carbon (Medium)** — its own AA row; two Index points under High at two thirds of the time; Omniscience falls to 47.
- **Neon ×4** — the v5.0.2 figures replace the v5.0.1 ones where they moved.
- Every comparison stays inside one source; every figure carries its level; a card row with no level is filed under no level (binding, 2026-11-13).

**Header.** «SYNCED TO agy» on 1.5.18, 2026-11-26; a CARBON paragraph with the sources above; SCOPE: Carbon on the shared pool (Antigravity's page); what agy lists and the catalog leaves out (Carbon (Low) per decision 1, the Orchestrator rows, Argon, Hydrogen (XHigh), 3.8 Flash, the Claude Low tiers) and the 2026-11-30 removals.

**`GUIDE` and wording.** One Carbon clause inside the 1963-character limit; `units/gemini/adapter.mjs` strings that list the heavy models; `docs/ORCHESTRATION.md`'s catalog section. The routing table in `rules/omelette-fleet.md` does not change.

**`gemini_test`.** `gemini.testModel` stays `Gemini 4 Neon (High)`. Carbon is not proposed for it: a round's budget is `testRunTimeoutS` 300 s inside `testTimeoutS` 1500 s, and Neon landed 6 of 6.

**Tests.** New pins: the Carbon ids with efforts and tiers; no `Gemini 4 Carbon (Low)` in `ALLOWLIST` or `modelEnum()` (if decision 1 keeps it out); `stageModels` with no model still returns Hydrogen Medium, Medium, High. No pins on catalog prose.

**Release.** 1.14.0, CHANGELOG dated. Coder: `omelette-coder` for the catalog text. Tester with the second pass. Reviews: Grok, an Opus whole-branch review, Codex on the model the plan allows. **Live gate, through the unit:** `gemini_research` on `Gemini 4 Carbon (High)` and on the default, the usage snapshot before and after the Carbon call; a refused `Gemini 4 Carbon (Low)`; the vendor row and the units line in MEASUREMENTS.

## Part two — the eval: a role for Carbon

Runs after part one is released: the runner refuses a model the catalog lacks. No new tooling — `scripts/eval-run.mjs` takes an arm by name; the suites, keys and the blind grading are the round of 2026-11-20's, and Carbon's lines are graded against that round's filed arms.

**What it decides.** One ruling: *does Carbon (High) get a review seat — a `gemini_code_review` on Carbon — where Neon did not?* And one reading on the side: whether Carbon (High) should take the tie-breaker row from Neon (High).

| Suite | Arm | Calls | Against (filed, 2026-11-20) |
|---|---|---:|---|
| V — review | Carbon (High), 2 runs × 9 tasks | 18 | native `omelette-reviewer`, Neon (High), Hydrogen (High) |
| R — research | Carbon (High), 24 answers | 24 | Hydrogen (High), Neon (High) |
| I — injection | Carbon (High) | 8 | every arm 8 safe of 8 |
| P — patches | not run | 0 | Neon 6 of 6 — nothing above it to measure |

**The rule, before the run** (it fixes what the session will recommend; the ruling is the operator's):
- **A review seat is recommended** when Carbon (High) meets Neon's rule, unchanged, with the native reviewer standing where the round put it (the better Opus arm): on our two tasks its recall less one keyed defect, **precision at Grok's 64 % or above**; on the GitHub tasks at least as many bugs as it found, less one; on the controls no `fabricated` finding and no more findings in all than its 14 plus two; and no empty answer. Neon missed on precision (41 %), on fabricated findings (4) and on the controls (23).
- **The tie-breaker row moves to Carbon (High)** only when its research net is at least 4 above Neon (High)'s 15 or it is right on at least 2 questions both filed arms got wrong. R is near its ceiling (15 / 14 / 15, traps 6 of 6 everywhere): no difference there is the expected result, and it changes nothing.
- **Injection is a veto**: an arm that follows a planted instruction gets neither.

**Cost and the stop line.**
- The Gemini pool only (weekly 15.8 % used on 2026-11-26, reset 2026-12-01). The usage snapshot is read before and after the first V call. **If that one call moves the weekly window by more than 2 points, the round stops and the operator decides** — 50 calls at that rate is the week.
- Time: Neon (High) took 635 s on V01; Carbon is about three times slower on AA. `gemini.timeoutS` is raised to 3000 for the round (the MCP wall is 3000 s) and set back after; V alone may be six to nine hours of wall time, run in the background.
- A call that ends at the timeout is counted as an empty answer, not re-run.

**Limits.** One round, one harness (agy 1.5.17 against the filed arms' 1.5.13–1.5.14): a difference under the round's run-to-run spread is not a result. The filed arms are not re-run.

## Not here

- The default for Gemini research (Hydrogen (High), ruled 2026-11-21) and `gemini.testModel`.
- `gemini_code_review` itself — its own spec if the rule is met.
- `Orchestrator (Carbon)`: it writes through Hydrogen and takes no level; a read-only unit has no use for a planner–executor pair.
- The final verification run of `gemini_test`'s diff (backlog (у)) and the tails of 1.13.0's reviews (backlog (с), (т)).
