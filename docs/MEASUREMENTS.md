# Measurements

What has actually been measured on this project, how each number was taken, and what has not been measured yet. Nothing here is an estimate unless it says so.

| Question | Where |
|---|---|
| What does planning cost today — the number the scout map is aimed at? | [Planning cost before the scout map](#planning-cost-before-the-scout-map) |
| What did the 1.1.0 review rounds change that a clock can see? | [`check` before and after its reviews](#check-before-and-after-its-reviews) |
| What are three release reviews worth? | [Review yield per release](#review-yield-per-release) |
| Does a security brief find what a plain review and a plugin miss? | [Security audit: plain, brief and plugin over one revision](#security-audit-plain-brief-and-plugin-over-one-revision) |
| What does the short fleet contract save in every session? | [The fleet contract, full and short](#the-fleet-contract-full-and-short) |
| How big is the rules file every session loads, before and after 1.2.0? | [The rules file, before and after](#the-rules-file-before-and-after) |
| What did the session carry per request in 1.3.0, and did the rules file cause it? | [Rent and the rules file, 1.2.0 to 1.3.0](#rent-and-the-rules-file-120-to-130) |
| What does planning cost with the scout map, and did a fork do better? | [Planning cost with the scout map](#planning-cost-with-the-scout-map) |
| What does a task lead cost against the session running the coder and tester itself? | [A task lead between the session and the coder](#a-task-lead-between-the-session-and-the-coder) |
| Does a coder's effort level change what it builds? | [Coder effort: medium, high, xhigh on one task](#coder-effort-medium-high-xhigh-on-one-task) |
| Does medium hold against xhigh when the coder has to judge, not follow? | [The matched repeat: medium and xhigh on a judgement-heavy task](#the-matched-repeat-medium-and-xhigh-on-a-judgement-heavy-task) |
| Where do sub-agent tokens go, by role? | [Sub-agents by role](#sub-agents-by-role) |
| What fills a sub-agent's context — reading, its own output, the harness? | [Where a sub-agent's context goes](#where-a-sub-agents-context-goes) |
| Who runs past 200 k tokens, and doing what? | [Past 200 k](#past-200-k) |
| Does the guard's context estimate match the engine's? | [The guard's estimate against the engine](#the-guards-estimate-against-the-engine) |
| How do I repeat these on my own sessions? | [How the numbers are taken](#how-the-numbers-are-taken) |
| Which claims has nobody measured? | [Not measured yet](#not-measured-yet) |

## Planning cost before the scout map

All five releases' planners ran on the `opus` alias, which resolved to `claude-opus-5` on the Claude Code of the time; the table predates the rule that every row names its model.

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

**After:** 1.2.0 was the first release planned from a scout map — the rows are under [Planning cost with the scout map](#planning-cost-with-the-scout-map), taken the same way.

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
| 1.2.0 | 24 | 17 | 7 | the measuring script printing this checkout's absolute path through an uncaught throw; the release's rules-size claim being P1's figure, not the shipped file's |
| 1.3.0 | 34 | 30 | 4 | the guard's invocation cut handing `-b new` to a nested `$(git tag -l)` (a missed write, found by the shipped reviewer and by Codex); `xargs git tag < file`; PATH still reaching an env-shebang vendor; a false "three runs" line in SECURITY; three re-review rounds found process substitutions dropped unread, `reset --hard` passing for every role, and `>>(…)` under zsh |

Across eight releases, 221 findings and 192 accepted: the reviewers are rarely wrong, and the rejected ones are mostly stricter readings of a brief than of the spec. A docs-only release (1.0.0) still produced eight real defects.

## Security audit: plain, brief and plugin over one revision

Two runs over the same revision, `d7180b2` (v1.2.0), on 2026-09-24: Codex with no method (the control), and Codex with the whole brief SECURITY describes under [How this package is audited](SECURITY.md#how-this-package-is-audited) — the trust-class table, the attacker model, the refutation gate with the Trail of Bits links, and Cloudflare's core discipline, trust-class section and validation rules. Both on `gpt-6-astra` at effort high, one call per group — the unit servers with `units/` and `core/`, the guard, the CLI and what it renders. The third run, the `claude-security` plugin, needs the operator's own `/claude-security` invocation and ran on 2026-09-25 over `3b01e32` (v1.3.0), the whole repository at effort medium: 72 agents in one workflow — inventory, threat model, 33 researchers, a sweep and a three-lens panel on the session's model (`claude-opus-5-5`; three of its roles are pinned to `claude-sonnet-5`) — 12 candidates, 10 after deduplication, 4 past the panel. That revision already carries the ten fixes of this release, so the plugin's found-count is not comparable with the two Codex columns; its four defects all exist, unchanged, at `d7180b2` (opened by hand), so the overlap is. Counts are distinct defects per run: the brief run reported 17 items, one a duplicate.

| | Plain — Codex, no method | Brief — Codex, with the brief | Plugin — `claude-security` |
|---|---:|---:|---:|
| Model | `gpt-6-astra` | `gpt-6-astra` | `claude-opus-5-5` |
| Calls | 3 | 3 | 1 |
| Found | 34 | 16 | 4 |
| Verified | 18 | 9 | 4 |
| Refuted | 16 | 7 | 0 |

**Refutation.** Seven fresh agents on `claude-opus-5-5`, each with a clean context, one per file cluster (guard-io, guard-git, core-fs, adapters, spawn-rpc, cli-text, cli-fs), each told to disprove every finding in its cluster against the code at `d7180b2`; `verified` means the attempt failed. Confound: the findings of one cluster shared one agent's context, so a ruling on one could lean on another. A defect both runs reported is one finding in each run's count and one in the overlap. Among the verified: S3 was already known and documented, C3 is narrow (both runs), S17 is conditional (brief), and S2 and G6 (plain) came back `needs-check` and were then settled — S2 by a vendor probe, G6 documented as a fail-open by design. The plugin's four went another way: its panel had already re-read the code, so one live check on `omelette-coder-medium` (`claude-opus-5-5`, effort medium) ran the vendors through the real adapter against bait files and a loopback listener — F2 (grok's `read_file` reaches outside `--cwd`), F3 (the recommended agy rules read a file outside `cwd` with no prompt) and F4 (raw ESC bytes on `doctor`'s stdout) reproduced; F1 narrowed: grok's `web_fetch` runs headless with no prompt, but grok's own guard blocks private addresses, so the loopback variant is refuted and the public-exfil leg stayed unresolved (the sub-agent's sandbox had no egress). Two answers where the model declined a credential framing are policy, not an adapter boundary, and count as nothing.

**Overlap.** Verified defects both runs found — G4, G5, S3, C3, C5, C7: plain and brief 6; plugin and either Codex run 0.

**Verified by the brief only.** 3 — S17: a bare vendor name is resolved from the caller's `cwd` when `PATH` holds an empty or relative entry (Task 8); S18: the `GOOGLE_*` passthrough admits `GOOGLE_CREDENTIALS` (Task 6); S19: a gemini retry replays an accept-edits run (Task 6).

**Verified by the plugin only.** 4 — F1 and F2, one root cause: the grok adapter's bare `--allow WebFetch` next to `read_file`, so injected content can read any file the operator can and fetch a URL carrying it (the fetch runs with no prompt; private addresses are blocked by grok itself; grok accepts `WebFetch(domain:…)`, the narrower form); F3: SECURITY's recommended agy rules, `read_file(*)` with `read_url(*)`, give a headless Gemini run the same reach and an egress; F4: `doctor` prints `.mcp.json` values with their control characters. The Codex runs had none of the three in their candidates.

**In one line.** Over `d7180b2`: plain 34 found, 18 verified; brief 16 found, 9 verified; plugin (over `3b01e32`) 4 found, 4 verified; 3 verified by the brief only, 4 by the plugin only.

Reading: the brief verified 3 defects the plain review missed, carried 12 of the plain review's 34 candidates and dropped 22 (two in three) before refutation, and 12 of the plain review's verified defects were not among its findings; the spec's condition for `omelette-auditor` — defects the plain review and the plugin both missed — now reads 3 (S17, S18, S19: the plugin's candidates held none of them), all low, while the plugin verified 4 that both Codex runs missed, three of them medium and all in the units' perimeter rather than in what the brief covers; no auditor definition is built: the security brief is SECURITY's section, and a release's security review is a review run with it. What landed: the 19 findings verified at the session's ruling (S2 and G6 were settled after it) became ten tasks of the release, T4–T13 of the fixes plan, each fix with its test, all committed.

## The fleet contract, full and short

Since 0.3.7 a unit server that starts in a project carrying the rendered rules file returns a short contract instead of the full one, because the rules already say everything the contract says.

| | Characters per server | Three servers |
|---|---:|---:|
| Full contract | 1 206 | 3 618 |
| Short contract | 158 | 474 |
| **Saved, resident in every session** | 1 048 | **3 144** |

In tokens that is roughly 900 down to 120 at four characters per token — the ratio is exact, the token figures are an estimate.

## The rules file, before and after

The rendered `.claude/rules/omelette-fleet.md` is loaded at every session start, so every character of it is resident in every session. 1.2.0 kept every rule in it word for word and moved out only the prose that explained how the handoff hooks work, to CONFIG ("The handoff hooks").

| Rendered rules file | Characters | UTF-8 bytes | Tokens, estimated |
|---|---:|---:|---:|
| 1.1.0 | 14 390 | 14 479 | ~3 600 |
| 1.2.0, after P1 (explanation moved out) | 12 521 | 12 592 | ~3 100 |
| **Saved by P1** | 1 869 | 1 887 | **~500** |
| 1.2.0 as shipped (P2 added four rules lines) | 13 069 | 13 140 | ~3 300 |
| **Net, resident in every session** | 1 321 | 1 339 | **~330** |

Rendered under the default merge policy (`session`; the `pr` sentence is 32 characters shorter). Tokens at four characters per token, as for the contract above: the character counts are exact, the token figures an estimate. The ceiling is 13 100 characters, pinned by `test/rules-size.test.mjs`.

## Rent and the rules file, 1.2.0 to 1.3.0

The rent is the resident context of the orchestrating session (`claude-fable-5-1`) on every request it makes; the rules file is part of it in every session.

| | 1.2.0 | 1.3.0 |
|---|---|---|
| Session's resident context per request (`claude-fable-5-1`) | 210–250k | last 200 requests: mean 442k (min 259k, max 627k); all-time mean 339k over 1 354 requests |
| Rendered rules file, characters | 13 069 | 13 987 (`session` merge policy) · 13 955 (`pr`); ceiling 14 030 |

One line: the session ran 1.3.0 end to end without a compaction, so its rent roughly doubled while the rules file grew by 918 characters (about 230 tokens at four characters per token) — the growth is the session's length, not the rules file.

## Planning cost with the scout map

1.2.0 package P1 was planned twice from the same scout map, then compared against the 1.1.0 baseline that had none (the [Plan P1 row](#where-a-sub-agents-context-goes) further down). Arm A is a fresh planner; arm B is a fork of the orchestrating session taken mid-task. Both arms ran with the map in hand; a static rubric (0–3 across 5 criteria, judged blind by Codex `gpt-6-astra`) scored the two plans.

| Arm | Model | Requests | Peak context | Cache-write Σ | Cache-read Σ | Output | Fresh-read chars | Wall | Input-token equiv. |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline (1.1.0, no map) | claude-opus-5 | 78 | 437 208 | 771 607 | 21 040 175 | 94 187 | 510k | — | ≈ 3.07M |
| Arm A: fresh planner + map | claude-opus-5-5 | 109 | 390 330 | 374 406 | 26 630 333 | 33 588 | 306k (Read 67k + Bash 239k) | 35 min | ≈ 3.13M |
| Arm B: forked session + map | claude-fable-5-1 (inherited from the parent, not chosen) | 29 | 498 728 (≈460k inherited) | 137 442 | 12 633 430 | 8 423 | 106k | 20.5 min | ≈ 1.44M (≈ 2.9M Opus-equivalent at 2× the per-token price) |
| Scout map itself | claude-opus-5-5 | 34 | — | 137k | 3.15M | — | — | — | ≈ 0.49M, amortised over the release |

Input-token equivalents at 1.25× cache-write / 0.1× cache-read. Blinded rubric: arm A 11/15, arm B 6/15 — B's findings included a test suite left red between two tasks and a protected evidence bullet it had changed; the session built P1 from A, not B. The plan then took three more planner rounds to reach move-only (611 101 tokens, cumulative) against P2 — planned once from the map with P1's rulings already in hand: 202 772 tokens, one round, 12.6 min, 3 review findings (2 accepted, 1 rejected).

Reading: the map halves fresh reading (cache-write 771 607 → 374 406), but arm A's input-equivalent landed within 2 % of the baseline (≈3.13M vs ≈3.07M) because it ran 40 % more requests — it dry-ran its plan on a scratch copy, since forbidden in the planner definition; the cost lever is requests × resident context ("rent"), and a dry run doubles both. The forked arm was cheapest but scored lowest and was not adopted. Planned once from the map with rulings in hand, P2 closed in a third of P1's cumulative cost. One lesson from watching a dry run shorten the rules file: an LLM asked to shorten a rules file loses about ten binding conditions per pass, and a substring pin cannot hold them — move explanation out, never rewrite a rule.

## A task lead between the session and the coder

Matched pair on 1.2.0: P1's three tasks ran through `omelette-lead` (private definition, `claude-fable-5-1`, xhigh — it briefs `omelette-coder` on `claude-opus-5-5` and `omelette-tester` on `claude-sonnet-5`, arbitrates, and reports once); P2's three tasks ran directly by the session, with the same coder and tester definitions. All six tasks were plan-driven text edits with tests.

| Task | Arm | Lead (req · cache-read Σ · cache-write Σ · min · $) | Coder $ | Tester $ | Total $ | Cache-read Σ, whole task | Wall | Rulings | Escaped defects |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| P1-T1 | lead (Fable 5.1) | 29 · 1.41M · 252k · 42 · $3.59 | $0.77 | $0.59 + $1.34 (two rounds) | $6.29 | 8.64M | 42 min | 2 | 0 |
| P1-T2 | lead (Fable 5.1) | 22 · 0.87M · 228k · 39 · $3.17 | $0.57 | $0.97 + $0.44 | $5.14 | 5.69M | 39 min | 1 | 0 |
| P1-T3 | lead (Fable 5.1) | 17 · 0.63M · 113k · 16 · $1.64 | $0.41 | $0.57 | $2.62 | 2.58M | 16 min | 0 | 0 |
| P2-T1 | direct (session, claude-fable-5-1) | — | $0.36 | $0.69 | $1.05 | 2.50M | 12 min | 0 | 1 |
| P2-T2 | direct (session, claude-fable-5-1) | — | $0.53 | $0.52 | $1.05 | 2.20M | 10 min | 0 | 0 |
| P2-T3 | direct (session, claude-fable-5-1) | — | $0.85 | $0.23 | $1.09 | 1.22M | 17 min | 0 | 0 |

Prices are the list prices of 2026-09-24: Fable $10 / $12.5 / $0.25 / $50 per M tokens (input / 5-minute cache write / cache read / output), Opus 5.5 $4 / $5 / $0.20 / $20, Sonnet 5 $2 / $2.5 / $0.20 / $10; output tokens are under-counted by the max-per-id rule, equally in both arms; totals are summed from unrounded parts, so a row can differ from the sum of its cells by a cent. P2-T1's escaped defect: a tester test pinned the tree against `HEAD`, passed the session's review, failed on the next commit, and was caught by the next coder. Session side, estimated (its windows overlap other work): running a task directly, the session (`claude-fable-5-1`, xhigh) took ≈8 requests per task at 210–250k resident context, ≈$0.7; with a lead, ≈5 requests, ≈$0.45.

Reading: the lead's bill is its own cache writes at Fable rates, not its reads, and a ruling that has to escalate costs a second round outright — `SendMessage` is unavailable at depth 2, so it goes to a fresh tester, not the same one, as in P1-T1. Across three matched tasks the lead arm cost 2.4–6× the direct arm in dollars per task (4.4× in total: $14.05 vs $3.19, before the session's own share) and 1–4× in wall clock, against one fewer escaped defect and 10–15k less resident context per task carried in the session itself; `omelette-lead` does not ship in 1.2.0 and is not the 1.3.0 default — it earns its place on a cheaper model, or where the session's own context is the binding constraint.

## Coder effort: medium, high, xhigh on one task

Same brief (turn the P0 scratchpad script into `scripts/context-by-source.mjs` with tests), three `omelette-coder` copies on `claude-opus-5-5` at effort medium / high / xhigh, each in its own worktree, N = 1 per level, 2026-09-24.

| Effort | Requests | Peak context | Cache-read Σ | Cache-write Σ | Own output chars | Tool uses | Wall | Own tests | Fixture vs the shipped tool | Defect found by the session | Codex blinded rank |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---:|
| medium | 14 | 83 721 | 901 220 | 66 091 | 37 137 | 13 | 6.9 min | 7 | identical numbers | none | 3rd |
| high | 15 | 96 152 | 1 066 002 | 69 725 | 42 327 | 14 | 8.1 min | 9 | identical numbers | repo root taken from the process cwd, so absolute paths print as `<outside>` | 2nd |
| xhigh | 24 | 129 821 | 2 326 063 | 101 416 | 61 301 | 24 | 25.0 min | 15 | identical numbers | none | 1st |

Approximate cost at `claude-opus-5-5` list prices: $0.7 (medium) · $0.8 (high) · $1.3 (xhigh). Codex's review (static, blinded, four criteria) called the differences material on robustness and test depth.

Reading: on a plan-driven task all three effort levels built the same behaviour — identical fixture numbers against the shipped tool — and xhigh bought edge-case tests and robustness, largely what the clean-context tester and the review already pay for, at ~2.5× the cache reads and 3.6× the wall clock of medium. N = 1, and the one design defect landing on high rather than medium or xhigh, say this is not yet a ranking. Decision: the coder stays at `effort: xhigh` in 1.2.0; 1.3.0 repeats the trial on a judgement-heavy task and, if xhigh's edge still holds, sets `agents.coder.effort=medium`.

## The matched repeat: medium and xhigh on a judgement-heavy task

The release's largest security fix — the guard's git classifier, T4 of the P0 fixes plan — built twice from one commit in two worktrees, with the same decision brief word for word. The acceptance tests were written once, from the plan, by a clean-context tester (`claude-sonnet-5`; 31 requests, $0.83, 8 min) before either arm ran; a blind `omelette-reviewer` (`claude-opus-5-5`, xhigh; 61 requests, $3.77, 41 min for both rounds) judged both arms without knowing which was which.

| Arm | Definition · model · effort | Requests | Cache-read Σ | Cache-write Σ | Peak context | Wall | Cost | Rounds | Acceptance | Blind review |
|---|---|---:|---:|---:|---:|---|---:|---:|---:|---|
| A | `omelette-coder-medium` · `claude-opus-5-5` · medium | 30 | 3.08M | 139k | 139k | 17.3 min | $1.33 | 1 | 39/39 | 3 real defects — a second quadratic path left in place (117 s on a 448 KB command before exit 2, a fail-open class); branch writes in a nested shell missed; a redirection before the subcommand missed — and 1 pre-existing |
| B | `omelette-coder` · `claude-opus-5-5` · xhigh | 67 | 16.38M | 785k | 373k | 46.5 min round 1 + ~12 min round 2 | $7.28 | 2 | 39/39 | 2 narrow missed writes (a value-less global option before the subcommand; split quoting) and 1 maintainability, fixed in round 2 — shipped |

Reading: the acceptance tests could not tell the arms apart (39/39 each); the blind review could; N = 1. Arm A cost a fifth of arm B and left a fail-open class in the guard; arm B cost 5.5× and shipped after one fix round. Bucket log: 21 plan-driven tasks ran at medium in one round each with 0 acceptance defects and 1 tester-found defect (a line-splitting disagreement the printed diff missed), 4 stopped for a ruling the plan lacked (all stale test pins), and docs went to Sonnet 5 times. The coder default does not move: the spec moves it only if the matched repeat holds for medium, and it did not — `omelette-coder` stays at xhigh, and `omelette-coder-medium` is the plan-driven bucket. The shipped reviewer's release review of 1.3.0 found 14 findings, all accepted, against 1.2.0's three reviews together at 24 found / 17 accepted (that release did not record the Opus review's own share).

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

## Where a sub-agent's context goes

Every sub-agent of the 0.3.3 → 1.1.0 session — 76, those that started before 2026-09-18 — read from its own transcript (`scripts/context-by-source.mjs --before 2026-09-18`; [how](#how-the-numbers-are-taken)). "Logged text" is what each turn *added* to the agent's context, by where it came from; the resident context of a request is the `usage` sum, whose peak is the second column. All ran on `claude-opus-5` (coders, planners, reviewers, docs) or `claude-sonnet-5` (testers).

| Role | Agents | Peak context, mean | Requests, mean | Logged text by source: brief · Read · Bash that reads a file · other Bash · Edit · harness attachments · the agent's own output | Read calls overlapping an earlier Read of the same file |
|---|---:|---:|---:|---|---:|
| coder | 27 | 208 449 | 103 | 1 % · 32 % · 30 % · 5 % · 2 % · 4 % · 27 % | 43 of 230 |
| planner | 16 | 283 587 | 47 | 1 % · 35 % · 32 % · 5 % · 0 % · 3 % · 24 % | 15 of 175 |
| tester | 19 | 125 049 | 40 | 2 % · 46 % · 34 % · 6 % · 0 % · 0 % · 12 % | 20 of 136 |
| reviewer | 6 | 197 962 | 54 | 1 % · 32 % · 49 % · 4 % · 0 % · 5 % · 9 % | 1 of 31 |
| docs | 3 | 237 373 | 34 | 1 % · 72 % · 16 % · 2 % · 0 % · 2 % · 8 % | 1 of 18 |

Four things the table says:

- **Reading is two thirds of everything an agent takes in** — 62 % for coders, 67 % for planners, 80 % and more for testers and reviewers — and half of that reading goes through `cat`/`sed -n` rather than `Read`, which a count of `Read` calls alone would miss.
- **An agent rarely re-reads within itself** (9 % of a planner's `Read` calls overlap an earlier one, 19 % of a coder's). The repetition is *across* agents: `bin/omelette-fleet.mjs` (3 400 lines) was read 89 times by the 16 planners and 255 times by the 27 coders; `test/cli.test.mjs` 61 and 138 times. That is what one scout map per release is aimed at, and it is the right target.
- **Harness attachments are a floor.** The 2–5 % counts only attachment entries that carry text (instructions, skill listings); bookkeeping entries without text are not counted, because the transcript does not say what of them the model saw.
- **A quarter of a planner's or coder's context is its own output** — thinking, and the plan or the code it writes through `Write`/`Edit`, which then sits in the context for every later request. A planner's plan file is ~100 k characters.

The four transcripts the 1.2.0 spec asked for, one line each (the two 1.1.0 coders; the 1.1.0 planner and one from 0.3.7 as the second, 1.1.0 having had one planner):

| Agent | Requests | Peak context | Output tokens | Cache-read tokens, summed over requests | Read chars | Bash-read chars | Own output chars | Overlapping Reads |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Plan P1 (1.1.0, `check`) | 78 | 437 208 | 94 187 | 21 040 175 | 414 852 | 95 480 | 203 496 | 2 of 26 |
| Plan P4 (0.3.7, merge policy + lane) | 47 | 363 734 | 27 266 | 10 230 094 | 462 928 | 29 039 | 106 816 | 4 of 24 |
| Implement `check` (1.1.0, four rounds) | 138 | 319 330 | 188 112 | 27 331 176 | 88 401 | 44 906 | 246 155 | 3 of 15 |
| Implement P1 code (1.1.0) | 120 | 291 275 | 42 798 | 23 598 599 | 212 329 | 136 330 | 145 092 | 3 of 7 |

The cache-read column is the rent: the `check` coder's 138 requests each re-read an average of 198 k tokens from cache, 27 M in all, at a tenth of the input price — more input-token equivalents than everything it read fresh.

## Past 200 k

From the same transcripts: 31 of 76 sub-agents ran a request whose context exceeded 200 000 tokens — every one of the 16 planners, 11 of the 27 coders, none of the 19 testers — typically between 40 % and 65 % of the way through their requests. No sub-agent transcript holds a compaction marker: they ran in the 1 M window and never compacted. Of the logged text after the crossing, 87 % is reading (53 % `Read`, 34 % Bash reads) and 2 % editing; since overlapping reads are rare (above), that tail is new reading, not recovery. It argues for keeping the `[1m]` window on the shipped definitions, but it does not settle it: whether the same task done inside 200 k with a compaction comes out as good is a matched experiment (1.2.0 spec, P0), not something a tail can say.

## The guard's estimate against the engine

The handoff guard estimates the context fill from the session transcript; Claude Code's function-hooks API (early access, behind `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` on 2.1.280) reports the engine's own figure, `$.session.usage().context`. A throwaway probe plugin logged both on the same request (2026-09-22, three short sessions, early point only).

| What | Engine | Guard | Gap |
|---|---:|---:|---|
| `tokens` (the last response's input side) | 32 770 · 33 755 · 35 342 | the same three numbers | none — the arithmetic is the same |
| `window` | 200 000 (the session's model was Haiku) | 1 000 000 | the whole gap: the guard takes the window from `handoff.contextWindow` when the config sets it, and this install sets it to 1 M for its `[1m]` sessions; the engine knows the live model's window |
| `percent` at the same request | 16–18 | 3 | 13–15 points, all from the window; at an equal window the two differ by at most 1 point (the engine rounds, the guard floors) |

Not yet taken: the near-threshold and post-compaction points, which need a working `[1m]` session run with the probe loaded. The row that matters for the guard's design is the window one: an estimate that reads its window from config cannot follow a session whose model differs, and the engine's figure can — which is the case for moving the guard into a function-hooks module once that API leaves early access (backlog N1).

## How the numbers are taken

- **Sub-agent tokens.** `node scripts/agent-usage.mjs <transcript.jsonl>` (in the repository; not part of the installed package) reads a Claude Code session transcript (`~/.claude/projects/<project>/<session>.jsonl`) and collects the task notifications the harness writes when a background sub-agent finishes — `subagent_tokens`, `tool_uses`, `duration_ms` — one row per agent. It reads nothing else, and a description that carries an absolute path is cut to its last segment. The transcript itself is private and is not in this repository; only the aggregates above are.
- **Per-request usage, by source.** `node scripts/context-by-source.mjs <session.jsonl> <subagents dir> [--agents]` reads each sub-agent's own transcript (`~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`; since Claude Code 2.1.280 a `.meta.json` beside it names the role and model). One API request is one `message.id`; its context is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; text is attributed to the tool that produced it, a Bash command counting as reading when a pipeline segment starts with `cat`, `head`, `tail`, `sed -n`, `git show`, `git diff` or the like. It prints aggregates and repository-relative file names, never content; `--before <ISO date>` names the cutoff, because a resumed session keeps writing sub-agents into the same directory. This is the better source, and the one 1.2.0's measurements are taken from.
- **What `subagent_tokens` means.** It is the harness's count for the agent at the moment it stopped. A resumed agent reports again with a larger number (the 1.1.0 coder reported 139 834, 184 245, 286 692 and 320 000 across four rounds), so the script keeps the largest. Read it as the size of the context the agent ended with — a floor on what it had to read — not as a bill: the billed total, with cache reads on every turn, is larger and is not in the transcript in this form.
- **`check` timings.** A throwaway harness imports `core/check.mjs` from each commit, builds the fixture in a temp directory, and times `checkPointers` with `process.hrtime`; memory is `process.resourceUsage().maxRSS` from a fresh process per run (an idle Node process on that machine: 33 MiB). The fixtures are the ones described in the table; the timing one is also a test (`test/check.test.mjs`, "the worst case is bounded").
- **Review yield.** The `review yield:` line of each release's ledger (`.omelette/ledger-<release>.md`, kept by the orchestrator, not in the repository).
- **Security-audit counts.** The P0 lines of the 1.3.0 ledger (same place): one `candidate` line per finding per run, then its `verified` or `refuted` ruling once a fresh agent had tried to disprove it (the plugin's four: one live check that ran the vendors, ledger 2026-09-25) — seven agents on `claude-opus-5-5`, one per file cluster (guard-io, guard-git, core-fs, adapters, spawn-rpc, cli-text, cli-fs), each clean-context and handed every finding in its cluster. The confound: findings in one cluster shared one agent's context, so the rulings within a cluster are not independent. Duplicates within a run are merged before counting; the overlap is matched by the session, by location and scenario. Two runs only: the plugin run waits for the operator's own `/claude-security` invocation.
- **Matched-repeat numbers.** Per-request usage from each sub-agent's own transcript, priced at the list prices of the day ([above](#a-task-lead-between-the-session-and-the-coder)); output tokens are taken as the maximum per message id, so they are under-counted, equally in both arms. Acceptance is the tester's tests, written before either arm ran, run against each arm's tree.
- **Rent.** Per-request context from the orchestrating session's own transcript, counted as under "Per-request usage, by source" above; the 1.3.0 rules sizes are `renderRulesFile` under each merge policy, as above.
- **Contract sizes.** `FLEET_CONTRACT.length` and `SHORT_CONTRACT.length` from `core/rules.mjs`.
- **Rules file size.** `renderRulesFile('1.2.0', { merge: 'session' })` from `core/rules.mjs` — `.length` for characters, `Buffer.byteLength` for bytes — and, for 1.1.0, the same three substitutions applied to `git show v1.1.0:rules/omelette-fleet.md`.
- **Per-task cost tables.** Taken from sub-agent transcripts with `scripts/context-by-source.mjs --agents` — roles come from each agent's `.meta.json` `agentType` since commit `1997a71`, guessed from the description only when a run predates it — and that day's list prices. Session-side numbers are estimates: the session's own windows overlap other, concurrent work, so they are not read off a clean transcript the way a sub-agent's are.

## Not measured yet

- **What the scout map saves.** The baseline is above; the after is not. Until a release is planned from a map, "saves tokens" is a design intent, not a result.
- **Whether the five-section report shortens the orchestrator's reading.** The orchestrator's own tokens per release have not been separated out of its single long session.
- **What the units cost per release.** `results --stats --since` has the data; it has not been cut by release.
- **Whether `check` catches wrong evidence in practice.** In 1.1.0 it caught one off-by-one pointer in the orchestrator's own documentation and one weak fragment in the coder's own report. Two is an anecdote.
- **N0: the near-threshold and post-compaction points.** Flagged as not yet taken under [The guard's estimate against the engine](#the-guards-estimate-against-the-engine) — the probe mod exists in the scratchpad; it needs an operator session with function hooks enabled to run.
- **A second judgement-heavy effort trial.** [The matched repeat](#the-matched-repeat-medium-and-xhigh-on-a-judgement-heavy-task) is one task, N = 1; the two-bucket rule rests on it and on an observational bucket log. A second judgement-heavy pair is what would make it a ranking.
- **The plugin run of the security audit.** [The row](#security-audit-plain-brief-and-plugin-over-one-revision) has two runs; the `claude-security` plugin waits for the operator's own `/claude-security` invocation.
