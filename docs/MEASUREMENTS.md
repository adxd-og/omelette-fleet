# Measurements

What has actually been measured on this project, how each number was taken, and what has not been measured yet. Nothing here is an estimate unless it says so.

| Question | Where |
|---|---|
| What does planning cost today — the number the scout map is aimed at? | [Planning cost before the scout map](#planning-cost-before-the-scout-map) |
| What did the 1.1.0 review rounds change that a clock can see? | [`check` before and after its reviews](#check-before-and-after-its-reviews) |
| What are three release reviews worth? | [Review yield per release](#review-yield-per-release) |
| What does the short fleet contract save in every session? | [The fleet contract, full and short](#the-fleet-contract-full-and-short) |
| Where do sub-agent tokens go, by role? | [Sub-agents by role](#sub-agents-by-role) |
| How do I repeat these on my own sessions? | [How the numbers are taken](#how-the-numbers-are-taken) |
| Which claims has nobody measured? | [Not measured yet](#not-measured-yet) |

## Planning cost before the scout map

Until 1.1.0 every package of a release got its own planner, and every planner read the modules it needed from scratch. These are the planners of five releases, as reported by the harness when each finished (what the number means: [below](#how-the-numbers-are-taken)).

| Release | Planners | Tokens, each | Tokens, total |
|---|---:|---|---:|
| 0.3.3 | 5 | 284 997 · 260 588 · 264 294 · 224 462 · 221 964 | 1 256 305 |
| 0.3.4 | 3 | 376 924 · 236 573 · 256 314 | 869 811 |
| 0.3.5 | 3 | 243 803 · 233 836 · 280 078 | 757 717 |
| 0.3.6 | 1 | 439 485 | 439 485 |
| 0.3.7 | 4 | 343 286 · 221 426 · 310 616 · 365 127 | 1 240 455 |
| **All** | **16** | mean 285 236 | **4 563 773** |

Planning is the second largest sub-agent cost of the project ([by role](#sub-agents-by-role)), and in 0.3.3 and 0.3.7 four or five planners each loaded much of the same `core/`. That repetition is what [one scout map per release](ORCHESTRATION.md#evidence-with-pointers) is aimed at.

**After: not measured.** No release has been planned from a scout map yet. The first one that is gets a row here, taken the same way, and the comparison will be whatever it turns out to be.

## `check` before and after its reviews

`omelette-fleet check` went through three release reviews and three fix rounds inside 1.1.0. Two of the findings can be put on a clock; both rows below were taken on one machine (Apple M1 Pro, Node 20.19.5), with the module as it stood before the fixes (commit `b76e8af`) and as released (`v1.1.0`), on identical fixtures.

| What | Before | After | Note |
|---|---:|---:|---|
| Worst case a reviewer built: 2000 pointers whose fragment is nowhere, into one 2 MiB source-like file | 27 597 ms | 169 ms | The first version normalised every line of the target once per pointer; the released one holds one normalised representation per target and searches it with `indexOf`. |
| Peak resident memory, 16 newline-heavy 2 MiB targets | 221 MiB | 213 MiB | **Not improved.** The peak is the transient split of one target into a million lines, not the cache. What changed is that the cache budget now charges what it really keeps. A lower peak would need the representation built without the split; nobody has done that. |
| `.git/index` rewritten by a run on a stamped map with a stat-dirty file | yes | no | A read-only command was writing. Found by a reviewer from git's source, reproduced by hashing the index before and after, closed by `-c diff.autoRefreshIndex=false`. The price: a touched-but-unchanged file reads `stale`. |
| A pointer whose fragment is one character | `ok` | `weak` (fails) | Evidence that proves nothing no longer passes; neither does one true pointer repeated to reach `--require`. |

## Review yield per release

Every release closes its ledger with one line: findings found, accepted, rejected. It is the cheap measure of what the reviews were worth, kept since 0.3.6 and reconstructed for the two releases before it.

| Release | Found | Accepted | Rejected / partial | What mattered |
|---|---:|---:|---:|---|
| 0.3.4 | 33 | 32 | 1 | A FIFO hanging every tool call; the Stop gate imprisoning a session with a read-only `.omelette`; a quoted `--exec` passing the rebase classifier |
| 0.3.5 | 25 | 23 | 2 | (counts from the backlog note; that release's ledger predates the yield line) |
| 0.3.6 | 27 | 25 | 2 | A bin override resolved inside the caller's `cwd`; an image tool losing a saved file |
| 0.3.7 | 31 | 28 | 3 | A FIFO at the rules path hanging every server start; a compaction summary able to forge a handoff heading |
| 1.0.0 | 10 | 8 | 1 / 1 | Three diagram labels that contradicted the code; three blind spots in the docs test itself |
| 1.1.0 | 37 | 29 | 6 / 2 | `check` writing git's index; a one-character fragment passing; staleness blind to the working tree; an unusable `commit:` value switching staleness off in silence |

Across six releases, 163 findings and 145 accepted: the reviewers are rarely wrong, and the rejected ones are mostly stricter readings of a brief than of the spec. A docs-only release (1.0.0) still produced eight real defects.

## The fleet contract, full and short

Since 0.3.7 a unit server that starts in a project carrying the rendered rules file returns a short contract instead of the full one, because the rules already say everything the contract says.

| | Characters per server | Three servers |
|---|---:|---:|
| Full contract | 1 206 | 3 618 |
| Short contract | 158 | 474 |
| **Saved, resident in every session** | 1 048 | **3 144** |

In tokens that is roughly 900 down to 120 at four characters per token — the ratio is exact, the token figures are an estimate.

## Sub-agents by role

Every sub-agent the orchestrating session of releases 0.3.3 → 1.1.0 saw finish: 76 agents.

| Role | Agents | Tokens | Tool uses | Minutes |
|---|---:|---:|---:|---:|
| coder | 27 | 5 714 634 | 3 095 | 989 |
| planner | 16 | 4 563 773 | 880 | 360 |
| tester | 19 | 2 410 517 | 1 008 | 466 |
| reviewer | 6 | 1 202 849 | 342 | 504 |
| docs | 3 | 721 125 | 128 | 75 |
| other | 5 | 537 105 | 157 | 60 |
| **All** | **76** | **15 150 003** | 5 610 | 2 454 |

Minutes are wall clock and include time an agent spent waiting on a permission prompt — one reviewer sat on prompts for seven hours — so they say more about the harness than about the work. The fleet's own units (Gemini, Grok, Codex) are not in this table: they run on their vendors' subscriptions and are counted by `omelette-fleet results --stats`.

## How the numbers are taken

- **Sub-agent tokens.** `node scripts/agent-usage.mjs <transcript.jsonl>` (in the repository; not part of the installed package) reads a Claude Code session transcript (`~/.claude/projects/<project>/<session>.jsonl`) and collects the task notifications the harness writes when a background sub-agent finishes — `subagent_tokens`, `tool_uses`, `duration_ms` — one row per agent. It reads nothing else, and a description that carries an absolute path is cut to its last segment. The transcript itself is private and is not in this repository; only the aggregates above are.
- **What `subagent_tokens` means.** It is the harness's count for the agent at the moment it stopped. A resumed agent reports again with a larger number (the 1.1.0 coder reported 139 834, 184 245, 286 692 and 320 000 across four rounds), so the script keeps the largest. Read it as the size of the context the agent ended with — a floor on what it had to read — not as a bill: the billed total, with cache reads on every turn, is larger and is not in the transcript in this form.
- **`check` timings.** A throwaway harness imports `core/check.mjs` from each commit, builds the fixture in a temp directory, and times `checkPointers` with `process.hrtime`; memory is `process.resourceUsage().maxRSS` from a fresh process per run (an idle Node process on that machine: 33 MiB). The fixtures are the ones described in the table; the timing one is also a test (`test/check.test.mjs`, "the worst case is bounded").
- **Review yield.** The `review yield:` line of each release's ledger (`.omelette/ledger-<release>.md`, kept by the orchestrator, not in the repository).
- **Contract sizes.** `FLEET_CONTRACT.length` and `SHORT_CONTRACT.length` from `core/rules.mjs`.

## Not measured yet

- **What the scout map saves.** The baseline is above; the after is not. Until a release is planned from a map, "saves tokens" is a design intent, not a result.
- **Whether the five-section report shortens the orchestrator's reading.** The orchestrator's own tokens per release have not been separated out of its single long session.
- **What the units cost per release.** `results --stats --since` has the data; it has not been cut by release.
- **Whether `check` catches wrong evidence in practice.** In 1.1.0 it caught one off-by-one pointer in the orchestrator's own documentation and one weak fragment in the coder's own report. Two is an anecdote.
