# 1.11.0 — the Gemini catalog after agy 1.5.8: Gemini 4 Hydrogen in, Gemini 3.8 Flash out

Status: approved by the operator, 2026-11-13 («На все да … 3.8 убираем и делаем хайдроген»). Builds on 1.10.2 (`2026-11-13-agy-default-mode-pin-design.md`), released the same day. Ledger: `.omelette/ledger-hydrogen.md`, branch `feat/gemini-hydrogen`.

| Section | Answers |
|---|---|
| [Why](#why) | What shipped, what was run, what each source says |
| [Not confirmed](#not-confirmed) | What no source states, and so what the catalog will not say |
| [Decisions](#decisions) | The five rulings the operator owes, each with a recommendation |
| [Catalog](#catalog-unitsgeminimodelsjs) | The entries, the header and the guide |
| [Routing and wording](#routing-and-wording) | ORCHESTRATION, the rules table, the adapter's strings |
| [Tests](#tests) | What gets pinned and what is re-anchored |
| [Release](#release) | Reviews and the live gate |
| [Not in 1.11.0](#not-in-1110) | What stays out |

## Why

Google released Gemini 4 Hydrogen on 2026-11-12. Everything below was read or run on 2026-11-13.

**agy 1.5.8** (`agy models`): `Gemini 4 Hydrogen (Low|Medium|High|XHigh)`, slugs `gemini-4-hydrogen-low|-medium|-high|-xhigh`. `(Low)` and `(XHigh)` answered headless on the operator's plan, 2.2 s and 2.3 s. Still listed: the three 3.8 Flash ids, the three Argon ids, GPT-OSS 120B. Listed and not in the catalog: `Orchestrator (Argon)`, the Claude Low tiers.

**DeepMind model card**, published 2026-11-12 ([card](https://deepmind.google/models/model-cards/gemini-4-hydrogen/)):
- adapted from Gemini 4 Carbon; 1M tokens for input and output together, 64K synchronous output; knowledge cutoff March 2026; text, image, audio and video in;
- the table, against Claude Sonnet 5.5 and GPT-6.1 Terra, **no thinking level stated for any column**:

  | Benchmark | Hydrogen | Sonnet 5.5 | GPT-6.1 Terra |
  |---|---:|---:|---:|
  | SWE-sweep | 13.5 | 3.1 | 5.8 |
  | Terminal-Bench 4.1 (cheating-adjusted) | 57.0 | 63.9 | — |
  | Agents' Last Exam v1.1 | 71.6 | 60.4 | 69.8 |
  | AutomationBench-AA | 76.1 | 71.8 | 60.2 |
  | Vending-Bench 2 ($) | 14 549 | 11 165 | 9 107 |
  | OSWorld-2.1 (offline subset) | 77.6 | 83.9 | 74.2 |
  | MKA | 53.4 | 52.0 | 43.8 |
  | Chartography | 66.6 | 61.6 | 63.2 |
  | Terminal-Bench-Science 0.1 | 51.4 | 59.9 | 58.3 |
  | HLE-Diamond | 58.8 | 53.3 | 47.3 |

- against 3.8 Flash, safety section: unjustified refusals **+5.57 pp** (lower is better), "particularly for multimodal prompts"; the full safety report is "available in the coming days";
- not on the card: DeepSWE v1.1, FrontierSWE v2, HLE-Verified, LAB-Bench2, CharXiv, LVBench, MRCR, OSWorld 2.0, Terminal-Bench 2.1 — none of the rows the Flash entries hold.

**Launch post** ([blog.google](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/)): levels "low, medium, high (default), and a new xhigh tier"; "a major standalone upgrade for teams migrating from Gemini 3.8 Flash"; against 3.8 Flash — "finishing tasks 2.5 times faster at its high default setting", Terminal-Bench 4.1 57 vs 18.2, "more than 2.3x more resilient on the Gray Swan IPI benchmark"; "cutting fabricated claims by more than 5x" with no baseline in the sentence.

**Price** ([pricing](https://aistudio.google.com/docs/pricing)): Hydrogen $1.50 / $7.50 per Mtok, flat, no step. 3.8 Flash $0.75 / $3.75 through 2026-12-31, then $1.50 / $7.50. Argon $2 / $10 through 2026-11-30, then $4 / $20. The unit bills the subscription, so these are context, not cost.

**Artificial Analysis**, Index v5.0.1 (third party; the two comparison pages, [Hydrogen vs Argon](https://artificialanalysis.ai/models/comparisons/gemini-4-hydrogen-vs-gemini-4-argon) and [Hydrogen vs 3.8 Flash](https://artificialanalysis.ai/models/comparisons/gemini-4-hydrogen-vs-gemini-3-8-flash), and Hydrogen (high)'s [own page](https://artificialanalysis.ai/models/gemini-4-hydrogen-high)):

| Row | Hydrogen (xhigh) | Argon (high) | 3.8 Flash (high) |
|---|---:|---:|---:|
| Intelligence Index | 54 | 50 | 31 |
| AutomationBench-AA | 76.1 | 77.5 | 59.9 |
| Terminal-Bench 4.0 | 53.5 | 57.1 | 19.7 |
| Terminal-Bench-Science 0.1 | 49.5 | 52.9 | 10.0 |
| FrontierCode-AA 2.0 | 39.0 | 25.7 | 18.7 |
| GDP.pdf | 27.6 | 21.8 | 21.0 |
| HLE-Diamond | 58.8 | 56.7 | 33.1 |
| CritPt v2 (Hard Subset) | 66.0 | 52.5 | 46.5 |
| AA-Omniscience v1.1 | 46 | 46 | 23 |
| $ per Index task | 3.16 | 4.97 | 7.77 |
| Minutes per task | 13.7 | 30.0 | 14.7 |
| Output tokens per task | 154k | 116k | 98.9k |

Hydrogen (high), the fleet default's level, has four figures only: Index 51, $1.87 per task, 7.9 minutes, 110M output tokens over the Index. Its per-benchmark rows are not published as text.

- The card's AutomationBench-AA 76.1 and HLE-Diamond 58.8 equal AA's xhigh rows to the decimal: the card's Hydrogen column is probably xhigh on those rows (the session's inference). The catalog files no card row under `(High)`.
- The catalog's Argon rows of 2026-10-14 (Index 53 at $1.99, HLE 57, SciCode 62, AA-LCR 80, GDP.pdf 22, CritPt 27, AA-Omniscience 42) come from an earlier Index: v5.0 dropped HLE, SciCode and AA-LCR, v5.0.1 regraded CritPt (AA's version history). None of them compares with the table above, and all of them leave the catalog.

**Argon's card**, as it stands today (published 2026-10-13): DeepSWE v1.1 77.9 (GPT-6 Astra 74.1, Opus 5.5 74.2), FrontierSWE v2 55.0 (Astra 65.5), Terminal-bench 4.0 57.4 (Opus 5.5 66.4), GraphWalks 256k–1M 84.2 (Astra 71.8), LABBench 2 88.8, LVBench 91.7. Hydrogen's card publishes none of these rows.

**Quota** (Brioche's snapshot of the operator's Antigravity usage, 2026-11-13 13:15Z, Google AI Pro): a Gemini pool with a 5-hour and a weekly window, a separate weekly window named `Gemini 4 Argon`, and a Claude/GPT pool. There is no Hydrogen window: Hydrogen draws on the Gemini pool, as Flash did.

**Antigravity** ([models](https://antigravity.google/docs/models), [plans](https://antigravity.google/docs/plans)): Hydrogen at Low, Medium, High and Extra (`xhigh` in the CLI), default High. 3.8 Flash is listed with no removal date. GPT-OSS 120B "will be removed on November 18, 2026" (the page said November 2 a month ago).

## Not confirmed

Nothing below is written into the catalog as a fact.

- **How fast Hydrogen spends the Gemini pool on Google AI Pro.** The plans page gives no numbers; the live gate measures it (ruling 5).
- Which plans get it: the docs list every plan, the Antigravity post says "paid Google AI Pro and Ultra".
- The thinking level behind the card's table, and what "cheating-adjusted" means: the methodology PDF did not extract.
- AA at Low and Medium, and AA's per-benchmark rows at High.
- The baseline of "5x fewer fabricated claims".
- How agy's four levels map to the API's thinking levels.

## Decisions

Operator, 2026-11-13 — yes to all five, and «3.8 убираем и делаем хайдроген»:

1. **Hydrogen replaces 3.8 Flash**: the standing sweep policy (2026-08-13, applied 2026-09-03 and 2026-10-16), and Google names it the migration target. 3.8 Flash leaves the catalog in this release.
2. **The default stays High** — the operator's Flash policy, and Google's own default. `(XHigh)` enters as a named step up: three Index points for 1.7 times the cost and time.
3. **The tie-breaker stays `Gemini 4 Argon (High)`**, Codex `gpt-6.1-sol` behind it: a tie between Grok and Hydrogen wants a model that is neither. The row's reason changes: Argon is no longer "another generation than Flash's", it is the heavier Gemini 4.
4. **Argon's entries are rewritten** («давай пофиксим аргон»): only what a source shows today. Argon (high) leads Hydrogen (xhigh) on three AA rows — Terminal-Bench 4.0, Terminal-Bench-Science, AutomationBench-AA — and holds the card's repository and long-context rows; it trails on the Index, FrontierCode-AA, GDP.pdf, CritPt and HLE-Diamond, at 1.6 times the cost and twice the time per task. Every row read 2026-10-14 goes.
5. **The quota reading** is the live gate's, not a condition: the session reads the Gemini pool's two windows from Brioche before and after the gate's Hydrogen calls and writes the difference into SCOPE as measured. If it turns out small, that is a finding for the operator, not a rollback the session makes.

Also the operator's, outside the package: `gemini.model` in `~/.omelette/fleet.config.json` names `Gemini 3.8 Flash (High)` and stops resolving when the id leaves; agy's own `settings.json` default is `Gemini 4 Argon (High)`, against ORCHESTRATION's advice to keep it off Argon.

## Catalog (`units/gemini/models.js`)

**Entries.** Four Hydrogen entries replace the three 3.8 Flash entries at the head of the list.

| id | effort | tier |
|---|---|---|
| `Gemini 4 Hydrogen (Low)` | Low | fast |
| `Gemini 4 Hydrogen (Medium)` | Medium | balanced |
| `Gemini 4 Hydrogen (High)` | High | balanced |
| `Gemini 4 Hydrogen (XHigh)` | XHigh | heavy |

`family: 'gemini'`. The typedef's `effort` gains `'XHigh'`. `stageModels` picks by family, tier and effort (`units/gemini/adapter.mjs:367`), so deep research moves to Hydrogen Medium and High with no code change — the test below pins it.

What the entries say:
- **High** — the fleet default. `useFor`: AA Index 51 at $1.87 and 7.9 minutes per task, above Argon (high)'s 50 at $4.97 and 30 minutes; Google's two sentences against 3.8 Flash (2.5 times faster at high; Gray Swan IPI, the one that matters for a fleet that reads untrusted web pages); the model's shape from the card and AA's xhigh rows, labelled as that level's. `avoid`: the refusal rise, named for multimodal reads; computer use and terminal science where Sonnet 5.5 leads on the same card (OSWorld-2.1 83.9 vs 77.6, Terminal-Bench-Science 59.9 vs 51.4); terminal agents and multi-step automation go up to Argon (High), one named call.
- **XHigh** — the named step up, and the only level with per-benchmark rows: the table above against Argon (high) and 3.8 Flash (high). 304M output tokens over the Index against High's 110M. Not the default, not a deep-research stage, not `gemini.model`.
- **Medium**, **Low** — unmeasured; they inherit High's profile and say so. Low is the cheap lookup.
- Every comparison stays inside one source. Nothing is carried from the Flash entries: the 3.7-generation claims (UI routing, MRCR, WebDev Arena) leave with them.

**Argon.** Per ruling 4.
- **High** `useFor`: the tie-breaker; terminal agents (Terminal-Bench 4.0 57.1 against Hydrogen xhigh's 53.5), terminal science (52.9 vs 49.5) and multi-step automation (AutomationBench-AA 77.5 vs 76.1, level); repository-level code and long inputs on its card (DeepSWE v1.1 77.9 against Astra 74.1 and Opus 5.5 74.2; GraphWalks 256k–1M 84.2 against Astra 71.8) — rows Hydrogen's card does not publish, so the comparison with Hydrogen is open, and the entry says so.
- **High** `avoid`: anything Hydrogen (XHigh) does better for less — FrontierCode-AA 25.7 vs 39.0, GDP.pdf 21.8 vs 27.6, CritPt 52.5 vs 66.0, HLE-Diamond 56.7 vs 58.8, the Index 50 vs 54, at $4.97 and 30 minutes per task against $3.16 and 13.7; the hardest software engineering (FrontierSWE v2 55.0 against Astra 65.5, card — Codex).
- **Medium**, **Low**: as today, unmeasured.
- `ARGON_QUOTA` stays, and gains what Brioche shows: Argon has its own weekly window on Pro.

**GPT-OSS 120B.** Its removal date becomes 2026-11-18; it leaves when agy stops listing it, as before.

**Header.** "SYNCED TO agy" on 1.5.8, 2026-11-13. A GENERATION SWEEP 2026-11-13 paragraph: what replaced what, that the benchmark sets do not overlap (no same-harness delta beyond the two rows Google gives), and the sources. The 3.8 paragraphs (COMPARABILITY, NOT PUBLISHED, Cyber) go. SCOPE gains the quota reading from ruling 5.

**`GUIDE`.** The three Flash clauses become Hydrogen's four; the Argon clause follows ruling 4.

## Routing and wording

- `docs/ORCHESTRATION.md`: the tie-breaker row (line 410), the Gemini paragraph and its bullets (423–428), the GPT-OSS date (405, 428).
- `rules/omelette-fleet.md:83`: the tie-breaker row, then re-render this checkout's managed files.
- `docs/CONFIG.md:68`: the example config's `gemini.model`.
- `units/gemini/adapter.mjs`: the strings that say "Flash" to a caller — the `model` description (570) and the deep-research refusal (792) — and the `flash` helper's name.
- `docs/MEASUREMENTS.md` and `evals/` are records of what was measured on Flash and stay as they are.

## Tests

- **New pins:** the four Hydrogen ids with their efforts and tiers; no id containing `3.8 Flash` in `ALLOWLIST` or `modelEnum()`; `stageModels` with no model returns Hydrogen Medium, Medium, High.
- **Re-anchored or dropped, each reported:** `test/gemini-catalog.test.mjs:21` (order against `Gemini 3.8 Flash (High)`, the Flash stage ids), `test/gemini-catalog-1.6.2.test.mjs:111`, and whatever in `test/tester-1.6.2-t1.test.mjs` and `test/tester-1.7.1-t1.test.mjs` names a Flash id.
- Test discipline as on 1.7.1: no pins on catalog prose.

## Release

- Version 1.11.0; CHANGELOG dated, three entries: the catalog, the routing, the wording.
- Coder: `omelette-coder` for the catalog text (judgement on what each source supports), with this spec's tables as pointers. Tester with the second pass. Docs to a cheaper model.
- Reviews: Grok, an Opus whole-branch review, and a third by ruling at the time — Codex is on the free tier until 2026-12-03.
- **Live gate, through the unit:** `gemini_research` on `Gemini 4 Hydrogen (High)` and on `(XHigh)`; one `gemini_deep_research` with no model, filed under `Gemini 4 Hydrogen (Medium) (decompose, gather) + Gemini 4 Hydrogen (High) (synth)`; `gemini_research` on `Gemini 4 Argon (High)`; the vendor row and the units line in MEASUREMENTS.

## Not in 1.11.0

- `Orchestrator (Argon)` — a fixed configuration with no effort control, Ultra and paid Pro; its own question.
- The Claude Low tiers; agy's `--effort` flag; Gemini 4 Carbon (API key or Ultra's Orchestrator only).
- Hydrogen's arms in the evals — round two, backlog #4.
