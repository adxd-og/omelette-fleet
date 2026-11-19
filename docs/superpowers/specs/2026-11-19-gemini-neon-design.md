# 1.12.0 — the Gemini catalog after agy 1.5.12: Gemini 4 Neon in, Argon and Hydrogen (XHigh) out

Status: approved by the operator, 2026-11-19 («Да»). Their rulings the same day: Argon leaves, Hydrogen (XHigh) leaves, Neon's quota is the shared Gemini pool, and the release is the catalog alone («Го» on the split) — the default is settled later by an eval with a spec of its own (`2026-11-19-evals-neon-design.md`, to land on its branch). Builds on 1.11.0 (`2026-11-13-gemini-hydrogen-design.md`). Ledger: `.omelette/ledger-neon.md`, branch `feat/gemini-neon`.

| Section | Answers |
|---|---|
| [Why](#why) | What shipped, what was run, what each source says |
| [Not confirmed](#not-confirmed) | What no source states, and so what the catalog will not say |
| [Decisions](#decisions) | What the operator ruled, and the one proposal that follows from it |
| [Catalog](#catalog-unitsgeminimodelsjs) | The entries, the header and the guide |
| [Routing and wording](#routing-and-wording) | The tie-breaker row, ORCHESTRATION, the adapter's strings |
| [Tests](#tests) | What gets pinned and what is re-anchored |
| [Release](#release) | Reviews and the live gate |
| [Not in 1.12.0](#not-in-1120) | What stays out |

## Why

Google released Gemini 4 Neon on 2026-11-18. Everything below was read or run on 2026-11-19.

**agy 1.5.12** (auto-updated from 1.5.8; `agy models`): `Gemini 4 Neon (Low|Medium|High|XHigh)`, slugs `gemini-4-neon-low|-medium|-high|-xhigh`, and `Orchestrator (Neon)`. `(High)` answered headless on the operator's Google AI Pro sign-in with no API key, 5.7 s — the changelog's «when you connect with a `GEMINI_API_KEY`» is not the only way in. Still listed: Hydrogen ×4, Argon ×3, 3.8 Flash ×3, GPT-OSS 120B (announced removal 2026-11-18), the Claude tiers.

**DeepMind model card**, published 2026-11-18 ([card](https://deepmind.google/models/model-cards/gemini-4-neon/); read twice, independently):
- adapted from Gemini 4 Carbon (as Hydrogen is); 1M tokens for input and output together, 64K synchronous output; knowledge cutoff March 2026; text, image, audio and video in;
- the table, against Claude Opus 5.5 and GPT-6.2 Sol, **no thinking level stated for any column**: AA Index v5.0.1 61 / 59 / 57; Terminal-bench 4.1 (cheating-adjusted) 65.2 / 65.8 / 61.5; FrontierCode 2.0 46.2 / 47.3 / 43.8; Agents' Last Exam v1.1 75.8 / 71.6 / 73.0; Terminal-Bench-Science 0.1 70.5 / 63.3 / 68.0; HLE-Diamond 71.3 / 67.9 / 64.0; GraphWalks 256k–1M 95.2 / 66.8 / 80.1; Chartography 73.5 / 66.3 / 75.1; LVBench 89.0 / 83.7 / 87.6;
- against Hydrogen, safety section: unjustified refusals **−3.00 pp** (lower is better), image-to-text safety +1.90 pp, multilingual −0.40 pp; the full safety report is "available in the coming days".

**Launch post** ([blog.google](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-neon/)): four levels, default high; "a 32% lower cost per task than Carbon" at high; "46.2% (at its default high setting) on FrontierCode 2.0"; Index 61 "at its xhigh thinking level"; Gray Swan IPI "0.0% attack success rate" at "its highest thinking level"; "for paid Google AI Pro and Ultra subscribers in Google Antigravity". No number against Argon or Hydrogen, nothing on Argon's future.

**Artificial Analysis**, Index v5.0.1 (third party; [Neon](https://artificialanalysis.ai/models/gemini-4-neon), [Neon vs Argon](https://artificialanalysis.ai/models/comparisons/gemini-4-neon-vs-gemini-4-argon), [Neon vs Hydrogen](https://artificialanalysis.ai/models/comparisons/gemini-4-neon-vs-gemini-4-hydrogen)):

| | Index | $ per task | Minutes per task | Output tokens over the Index |
|---|---:|---:|---:|---:|
| Neon (xhigh) | 61 | 6.44 | 21.5 | 283M |
| Neon (high) | 60 | 3.74 | 14.8 | 123M |
| Neon (medium) | 55 | 1.90 | 8.3 | 62.9M |
| Neon (low) | 44 | 0.75 | 3.7 | 28.3M |
| Hydrogen (xhigh) | 54 | 3.16 | 15.2 | 304M |
| Hydrogen (high) | 51 | 1.87 | 8.6 | 110M |
| Hydrogen (medium) | 41 | 0.80 | 4.2 | 54.4M |
| Hydrogen (low) | 27 | 0.29 | 1.5 | 20.3M |
| Argon (high) | 50 | 4.97 | 29.5 | 113M |

Neon's rows by level (xhigh / high / medium / low): Terminal-Bench 4.0 63.6 / 61.6 / 54.5 / 32.8; Terminal-Bench-Science 0.1 70.0 / 65.7 / 54.8 / 27.1; AutomationBench-AA 79.3 / 79.2 / 77.8 / 76.0; FrontierCode-AA 2.0 44.4 / 43.3 / 36.9 / 26.9; GDP.pdf 28.0 / 33.4 / 32.8 / 31.4; HLE-Diamond 71.3 / 68.4 / 63.6 / 54.2; CritPt v2 (Hard Subset) 60.5 / 59.0 / 61.5 / 62.0; AA-Omniscience v1.1 55 / 54 / 51 / 49.

- Read once, not twice: Neon's cost per task at high, medium and low, and every per-benchmark row (the comparison pages). The coder's brief has the session re-open them.
- AA re-measured since 2026-11-13: Hydrogen's minutes were 7.9 and 13.7, Argon's 30.0. Hydrogen (Low) and (Medium), "unmeasured" in the catalog, now have figures.
- Neon (high) against Argon (high), same pages: ahead on the Index, Terminal-Bench 4.0 (61.6 vs 57.1), Terminal-Bench-Science (65.7 vs 52.9) and AutomationBench-AA (79.2 vs 77.5), for less and in half the time.
- Neon (medium) against Hydrogen (xhigh): Index 55 vs 54 at $1.90 vs $3.16 and 8.3 vs 15.2 minutes.

**Antigravity** ([models](https://antigravity.google/docs/models)): Neon on Pro, Ultra and Enterprise, "default for new conversations", context "Up to 512K tokens"; Argon listed with no removal note; Carbon on Ultra and Enterprise only; `Orchestrator (Neon)` plans on Neon and implements on Hydrogen with no level to choose.

**Quota** (the operator, 2026-11-19): Neon draws on the shared Gemini pool; it has no window of its own, unlike Argon.

**Exact-page prompts on agy 1.5.12** (two direct runs with the unit's flags, one prompt): Neon (High) and Hydrogen (High) each reached for `run_command` with `curl`; agy auto-denied it (`permission_mode: request-review` — the 1.10.2 pin holds) and the run ended with an empty response, which the unit turns into `agy produced no output` (`units/gemini/adapter.mjs:321`). On 1.5.8 the same kind of prompt came back as a search answer.

## Not confirmed

Nothing below is written into the catalog as a fact.

- **What a Neon call costs the Gemini pool against a Hydrogen call.** The eval reads it.
- The thinking level behind the card's table. Its Index 61 and HLE-Diamond 71.3 equal AA's xhigh rows, while the post gives FrontierCode 46.2 as high: the column probably mixes levels (the session's inference).
- Neon's context window inside Antigravity: the models page says 512K, the card 1M.
- How often an exact-page prompt ends empty: one prompt, one run per model.
- Whether `Orchestrator (Neon)` is on Enterprise: two reads disagree.

## Decisions

Operator, 2026-11-19:

1. **Argon leaves the catalog**, all three entries. Neon (high) leads it on every AA row read, for less.
2. **Hydrogen (XHigh) leaves.** Neon (medium) does more for less; the step up from Hydrogen is now Neon.
3. **Neon enters at four levels**, on the shared pool: not a one-call route by quota, so no `ARGON_QUOTA`-style rule.
4. **The default does not change in this release.** Hydrogen (High) stays until the eval's result; nothing in the operator's config changes.

Follows from 1, the session's proposal:

5. **The tie-breaker becomes `Gemini 4 Neon (High)`**, Codex `gpt-6.1-sol` behind it. If the eval later makes Neon the default, the row goes to Codex alone — a tie between Grok and Neon wants a model that is neither, and Hydrogen is the same lineage and weaker.

## Catalog (`units/gemini/models.js`)

**Entries.** Hydrogen ×3, then Neon ×4, then Claude ×4 and GPT-OSS.

| id | effort | tier |
|---|---|---|
| `Gemini 4 Hydrogen (Low)` | Low | fast |
| `Gemini 4 Hydrogen (Medium)` | Medium | balanced |
| `Gemini 4 Hydrogen (High)` | High | balanced |
| `Gemini 4 Neon (Low)` | Low | heavy |
| `Gemini 4 Neon (Medium)` | Medium | heavy |
| `Gemini 4 Neon (High)` | High | heavy |
| `Gemini 4 Neon (XHigh)` | XHigh | heavy |

`stageModels` takes the first `gemini` + `balanced` entry at Medium and at High (`units/gemini/adapter.mjs:388`): with Neon filed `heavy`, deep research stays on Hydrogen Medium, Medium, High with no code change. Whether a stage should move to Neon is not this release's question.

What the entries say:
- **Neon (High)** — the step up from Hydrogen and the tie-breaker (ruling 5): AA at high against Hydrogen at high (60 vs 51, $3.74 vs $1.87, 14.8 vs 8.6 minutes) and its own rows at high; the card's shape; the refusal delta against Hydrogen. `avoid`: sweeps and quick lookups (Hydrogen); the exact-URL caveat; the card's rows it trails on (Terminal-bench 4.1 and FrontierCode 2.0 against Opus 5.5, Chartography against GPT-6.2 Sol — no level stated).
- **Neon (XHigh)** — one call when depth pays: one Index point over High for 1.7 times the cost and 2.3 times the output tokens; GDP.pdf falls at xhigh (28.0 vs 33.4).
- **Neon (Medium)**, **(Low)** — their own AA rows; Medium is Hydrogen (High)'s cost and time with four Index points more.
- **Hydrogen (High)** — still the default; today's AA figures; its XHigh pointers go, the step up is Neon. **(Medium)**, **(Low)** lose "unmeasured" and gain their four AA figures.
- Every comparison stays inside one source; every figure carries its level; a card row with no level is filed under no level (binding, 2026-11-13).

**Out:** the three Argon entries, `ARGON_QUOTA`, the ARGON header paragraph, Hydrogen (XHigh). The typedef keeps `'XHigh'` (Neon).

**Header.** "SYNCED TO agy" on 1.5.12, 2026-11-19; a NEON paragraph with the sources above; the sweep note (what left and why, how to restore); SCOPE: Neon on the shared pool (operator); WEB ACCESS: the 1.5.12 exact-page runs.

**`GUIDE`.** Hydrogen's three clauses, Neon's four, no Argon clause; the limit of 1963 characters stands.

## Routing and wording

- `rules/omelette-fleet.md:83` and `docs/ORCHESTRATION.md:410`: the tie-breaker row per ruling 5; `docs/ORCHESTRATION.md:426`: "up to Argon for terminal agents" becomes Neon (High). Then re-render this checkout's managed files.
- `units/gemini/adapter.mjs`: every string that names Argon or Hydrogen (XHigh) to a caller.
- The operator's `settings.json` for agy names `Gemini 4 Argon (High)` as its own default: it keeps working while agy lists Argon, and it is theirs to change.

## Tests

- **New pins:** the four Neon ids with efforts and tiers; no id containing `Argon` or `Hydrogen (XHigh)` in `ALLOWLIST` or `modelEnum()`; `stageModels` with no model still returns Hydrogen Medium, Medium, High.
- **Re-anchored or dropped, each reported:** whatever names an Argon id or Hydrogen (XHigh) in `test/`.
- No pins on catalog prose.

## Release

- Version 1.12.0; CHANGELOG dated: the catalog, the routing.
- Coder: `omelette-coder` for the catalog text (judgement on what each source supports). Tester with the second pass. Docs to a cheaper model.
- Reviews: Grok, an Opus whole-branch review, and Codex if the plan allows by then.
- **Live gate, through the unit:** `gemini_research` on `Gemini 4 Neon (High)` and on the default; one `gemini_deep_research` with no model, filed under Hydrogen Medium and High; a refused `Gemini 4 Argon (High)`; the vendor row and the units line in MEASUREMENTS.

## Not in 1.12.0

- **The default, a review tool, a sandbox for Gemini** — each waits for the eval (`2026-11-19-evals-neon-design.md`).
- The exact-page behaviour: the preamble that still names `read_url` and the rules row "Grounded web research → Gemini" (backlog «Из 1.11.0», the operator's decision).
- `Orchestrator (Neon)`; Gemini 4 Carbon (not on Pro); the Claude Low tiers.
- A deep-research stage on Neon.
