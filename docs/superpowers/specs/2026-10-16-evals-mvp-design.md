# Evals MVP: the fleet's models on our own tasks

Status: approved by the operator, 2026-10-16. Ledger: `.omelette/ledger-evals.md`.

| Section | Answers |
|---|---|
| [Why](#why) | What the catalogs rest on today |
| [Decisions](#decisions) | The operator's rulings so far |
| [What is public, what is not](#what-is-public-what-is-not) | Where every file lives |
| [Suites](#suites) | The two task types and how each is keyed |
| [Arms](#arms) | Which model at which effort, how often |
| [Running](#running) | The runner, through the real units |
| [Grading](#grading) | Blind, by rubric, checked by the session |
| [Charts](#charts) | What gets drawn |
| [Not in the MVP](#not-in-the-mvp) | What waits |

## Why

The three unit catalogs (`units/{gemini,grok,codex}/models.js`) describe each model from vendor model cards and Artificial Analysis. Those are other people's tasks. MEASUREMENTS measures the Claude roles (coder effort, tester effort, review yield, the security audit) but no unit model. The vendor CLIs update themselves (agy went 1.2.14 → 1.4.0 in two weeks), so a unit's quality can move with no release of ours, and today nothing would show it.

## Decisions

Operator, 2026-10-16:
1. **Only charts are published.** Task sets, keys and raw answers never enter git.
2. **Scope is the fleet as it runs:**
   - Codex: `gpt-6.1-sol` and `gpt-6-astra`;
   - Gemini: `Gemini 4 Argon` and `Gemini 3.8 Flash`;
   - Grok: the CLI default (`grok-4.7`).

   The Claude roles come later.
3. **Argon first, frugally:** its quota is small on the Pro subscription (only there).
4. **Key freshness is the operator's.** When something new ships or a fact changes, the operator says so, and the suite is re-keyed and re-run.

## What is public, what is not

| Path | In git | Holds |
|---|---|---|
| `evals/README.md` | yes | A map: what is measured, the method in one screen, the charts |
| `evals/charts/*.svg` | yes | The charts, generated |
| `scripts/eval-run.mjs`, `scripts/eval-blind.mjs`, `scripts/eval-chart.mjs` | yes | Runner, blinding, chart generator. They hold no task text, no key and no answer: they read and write only the private directory |
| `.omelette/evals/suites/<suite>/tasks.jsonl` | no (`.omelette/` is ignored) | The prompts |
| `.omelette/evals/suites/<suite>/key.jsonl` | no | The answers, each with its source and the date it was checked |
| `.omelette/evals/runs/<date>/<arm>.jsonl` | no | Raw answers with model, effort, CLI version, wall time and token usage |
| `.omelette/evals/grades/<date>.jsonl` | no | The grades, keyed by blind id |
| `.omelette/evals/aggregates/<date>.json` | no | The numbers the charts are drawn from |

The charts carry the aggregates, which are numbers only. `evals/` is excluded from the npm package (`files` in `package.json`). A test pins that no file under `evals/` or `scripts/eval-*` contains a line of any `tasks.jsonl` or `key.jsonl`. That test skips when `.omelette/evals/` is absent, as it is in CI.

## Suites

**R — research with checkable facts.**
- Questions whose answers the session verified against a primary source, with the source and the date in the key.
- Mixed on purpose: some are stable facts, some are recent ones (model availability, CLI behaviour, dates) — exactly the facts the fleet is asked for.
- The operator approves the set. MVP size: 10 questions.
- **Graded per question:** correct / partly / wrong / no answer. Each cited source is graded too: real and supporting / real and not supporting / unreachable or invented.
- **Tools** (each unit's research tool, as the fleet calls it): `gemini_research`, `grok_research`, `codex_research`.

**V — review with a known-defect key.**
- One past state of a file of ours, with the defects the release reviews found in it, verified and fixed. The key lists each defect as a location and a scenario.
- MVP candidate: `mods/omelette-fleet/hooks/register.tsx` at the commit before 1.7.0's release fix round. Its key is the accepted findings on that file in `.omelette/ledger-1.7.0.md`. The operator approves the choice.
- **Graded:** recall (key defects found), precision (findings that are real, the key's or new ones the session verifies), and false findings.
- **Tools, as the fleet uses them:**
  - `codex_code_review` and `grok_code_review` with `cwd` on an exported snapshot of that commit (`git archive`, no `.git`, so the later fixes cannot be read from history);
  - Gemini has no review tool, so `gemini_research` gets the file as text in the prompt.

  The input differs by unit. That is the fleet's real shape, and the chart says so.

## Arms

| Unit | Model | Effort | R | V |
|---|---|---|---|---|
| Gemini | `Gemini 4 Argon` | Low, Medium, High | 1 call per level (all 10 questions in one prompt) | 1 call per level |
| Gemini | `Gemini 3.8 Flash` | Low, Medium, High | 2 runs per level, 1 question per call | 2 runs per level |
| Codex | `gpt-6.1-sol` | xhigh (fleet pairing) | 2 runs, 1 question per call | 2 runs |
| Codex | `gpt-6-astra` | xhigh | 2 runs | 2 runs |
| Grok | `grok-4.7` | the unit's default | 2 runs | 2 runs |

- **Argon's budget for the first round is 6 calls.** Argon gets one prompt for the whole R set, unlike everyone else, so its R score is not like-for-like. The chart marks it. A second Argon round, per question, waits for its quota to refill and for the operator's word.
- **Calls:** about 125 in all, almost all on the Gemini pool (Flash), Codex and Grok. No Claude via agy.

## Running

- **`scripts/eval-run.mjs --suite <R|V> --arm <unit:model:effort> [--runs N]`** calls the unit through the real path, the package's own adapter, as `omelette-fleet call` does. The fleet's guards, sandboxes and timeouts all apply.
- It writes one line per call: answer, model, effort, unit CLI version (`--version`), wall time, and the token usage the unit reports.
  - Gemini: agy's input, output and thinking;
  - Codex: real usage;
  - Grok: input and output.
- A failed call is recorded as failed, never retried silently.
- Arms run one at a time, Argon first.

## Grading

- **`scripts/eval-blind.mjs`** strips model names, ids and timings, shuffles, and gives each answer a blind id. The mapping stays in the private directory.
- **A clean-context `omelette-reviewer`** (Opus) grades the blinded answers against the key with the rubric above, and writes `grades/<date>.jsonl`. It is told nothing about which model wrote what.
- **The session** checks every grade the reviewer marked uncertain, every "new defect" a V answer claims, and a random 10 % of the rest, then records the agreement rate. A grade the session overturns is recorded with both values.

## Charts

`scripts/eval-chart.mjs` writes SVG with no dependencies, readable in GitHub's light and dark themes:
1. R: correct answers per arm, each run a dot and the mean a bar. Invented sources as a second series.
2. V: recall and precision per arm, each run a dot.
3. Effort: for Argon and Flash, R and V scores against Low, Medium and High.
4. Cost: score against wall time per call, one point per arm. Token use is a second panel where the unit reports it.

Each chart's caption names the date, the CLI versions and N. With N = 1 or 2 the chart shows runs, not intervals, and says so.

## Not in the MVP

- The Claude roles: coder, tester and reviewer effort are in MEASUREMENTS already.
- Rerunning on a schedule. It runs when the operator says something changed.
- More than one V file, and a larger R set. Those come after the first round shows the method works.
- A third suite, such as image reading or long-context retrieval.
