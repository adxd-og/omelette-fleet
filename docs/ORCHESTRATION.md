# Orchestration

How to run a session with a fleet: who decides, who proposes, and which unit gets which task.

## The operating model

Your Claude Code session is the **orchestrator and the reviewer**. It plans, decomposes, routes, and it is the only thing that changes code — directly or through its own sub-agents, under whatever approval flow you already have. The units are **read-only proposers**: they research, analyse, review and give second opinions, and they hand back text. Nothing a unit says reaches your repository except by passing through you.

That split is what makes the fleet cheap to supervise. A unit's worst case is a wrong answer, not a wrong commit — so you review claims, not diffs. And because every unit reads untrusted material by design (web pages, repositories), keeping the mutating surface in one place is also the injection containment.

Use whatever subset you have installed. The routing below degrades gracefully: with only Codex you lose grounded multi-source research; with only Gemini you lose the strongest code review; the model still works.

## Inside Claude Code

The same split applies one level down, and it is the operating model this package was built under. Your top-level session is the expensive, careful one: keep it for planning, routing and review, and delegate the work.

- **Code changes go to a strong coding sub-agent**, briefed with the plan and the constraints, never to a unit. The session reviews the result before it lands.
- **Documentation, changelogs and boilerplate go to a cheaper model.** They are long, mechanical, and easy to check against the code.
- **Research goes either to a fleet unit or to a sub-agent**, whichever has the better tool for the question — a unit when you want a different vendor's judgement or grounded web search, a sub-agent when the answer is in your own repository.
- **Nothing lands unreviewed.** Every delegated result — sub-agent or unit — comes back to the session, which checks it against the code and the plan before accepting it. Delegation buys throughput, not trust.

Two practical rules that follow: give each delegate one job and the context to do it (they start fresh and see none of your session), and do not delegate the decision about whether the work is correct — that is the part you kept the expensive session for.

## Routing by task

| Task | Route to | Why |
|---|---|---|
| Grounded web research, fact synthesis, reading and summarising | **Gemini** → `gemini_research` | Web-grounded, and the fleet's citation-oriented researcher |
| Multi-source deep research | **Gemini** → `gemini_deep_research` | Decompose → parallel gather → synthesise, returning Summary / Findings / Sources / Gaps & Confidence. **Costs ~5 CLI runs per call** and commonly takes 3–10 minutes — deliberate use, not the default research mode |
| Reading local images, PDFs, screenshots, diagrams | **Gemini** → `gemini_research` | Multimodal. Give an **absolute path** and say "view the file directly, no terminal commands" — shell tools are auto-denied headless |
| Cheap fast second opinion, mechanical review, high-volume sweeps | **Grok** → `grok_research` / `grok_code_review` | Cheapest per token in the fleet and fine for volume — with the caveat below |
| Math / STEM cross-check | **Grok** (AIME 93–100%, GPQA Diamond 84.6–88%) or **Gemini** → `GPT-OSS 120B (Medium)` | Two independent non-Google/non-OpenAI voices for the same check |
| Strongest code review, agentic terminal analysis | **Codex** → `codex_code_review` with an absolute `cwd` | Terminal-Bench 2.1 87.4 on `gpt-5.6-terra`; reads, greps and runs read-only shell commands inside an OS sandbox |
| Research where the answer depends on running things | **Codex** → `codex_research` | Same sandbox, plus web search, and it reports real token usage per call |
| Image generation | **Gemini** → `gemini_image` or **Grok** → `grok_image` | Both save outside your project and return an absolute path you import by hand |
| Image-to-image editing | **Grok** → `grok_image_edit` | The only unit in the fleet that edits images |
| Architecture, planning, UI/front-end taste, long-horizon engineering | **Claude** (your session, or its sub-agents) | Grok is explicitly contraindicated for architecture and UI; Codex is a strong reviewer but not a source of record |
| Any file edit, git operation, deploy or publish | **Claude**, under your approval | The only mutating path. Units reject git/deploy intent before spawn and mostly cannot act on it anyway |

Ask a unit's `<unit>_models` tool when you are unsure whether a task belongs on it at all — the catalogs carry "route to / route away" advice, not just ids.

## Model and effort escalation

The rules below come from the catalogs' own `GUIDE` strings. Omit `model` to keep the fleet default; escalate deliberately, because on a subscription quota the cost is real.

**Gemini** — default `Gemini 3.8 Flash (High)` for delegated research and agentic work.
- Down to `(Low)` for quick facts, lookups and short summaries; `(Medium)` when High's latency or token overhead is unwanted. 3.8 deliberately spends more thinking tokens than the previous generation at the same price per token, so **dropping the effort level is the way to buy that back** — not paying High for routine work.
- Up to `Gemini 3.1 Pro (High)` for frontier scientific and formal reasoning (GPQA Diamond 94.3, ARC-AGI-2 77.1 — both unpublished for 3.8 Flash) and anything needing the 2M context window. `Pro (Low)` is the middle ground: Pro-grade reasoning and the 2M window at balanced cost.
- Plain 128K retrieval is **not** a reason to reach for Pro — the last measured Flash generation led MRCR v2 128K 97.0 vs 84.9.
- `Claude Opus 4.6 (Thinking)` runs on a separate quota bucket, so it is otherwise-idle capacity for hard verification passes and Opus-grade second opinions. That bucket is the more restrictive one; spend it on hard problems, and prefer Gemini for citation-heavy research (its web grounding via this CLI is unverified for the Claude family).
- `GPT-OSS 120B (Medium)` is a corroborating voice for maths and vendor de-biasing, never the lead researcher.
- The `effort` config key and argument are **inert** for this unit: effort is baked into the model id.

**Grok** — default `grok-4.6`; `grok-4.5` exists only as a regression fallback.
- `effort: low` for fast cheap sweeps, `medium` (the default) for ordinary work, `high` for harder analysis, `xhigh` for the hardest maths and proofs only — it is the slowest setting.

**Codex** — default `gpt-5.6-terra` at `effort: high`.
- Down to `gpt-5.6-luna` (medium) for single-file questions, lookups, routing and short summaries. **Not** for anything spanning modules or files, not for long inputs (retrieval collapses past ~200K tokens; ~41% recall across the full window vs terra's ~91%), and not for prohibition-heavy briefs — it drifts on "do not touch X" in multi-turn work.
- `effort` on terra: `none`/`low` for sweeps, `high` (the default) for review, `xhigh`/`max` **only** for architecture, proofs, or root-cause hunts in obfuscated code. Adaptive reasoning treats effort as a ceiling, and xhigh on routine work buys latency, not quality. (`minimal` is not an accepted value — the whole 5.6 line rejects it.)
- `gpt-5.6-sol` is plan-gated to ChatGPT Pro/Enterprise and earns its extra compute only on genuinely hard architecture, proof or root-cause work (Terminal-Bench 2.1 88.8 vs terra's 87.4). On Plus/Team it fails fast with an explicit "not supported" error. `omelette-fleet doctor --probe-models` tells you which ids your account accepts.

## Never a sole source

**Grok, specifically and non-negotiably.** Grok 4.5 measured **~54% hallucination** on AA-Omniscience in Artificial Analysis testing — more than double the preceding generation — and it is *overconfident*: it claims capabilities and actions it does not have. "I checked and it works" from Grok is not evidence. 4.6 ships RL loops meant to restore abstention, but as of 2026-08-13 **no post-fix measurement exists**, so treat the problem as unfixed. Every fact from Grok gets independently verified — by another unit, by the primary source, or by Claude reading the code — before it reaches a decision, a document, or a commit. Its cheapness is an argument for volume and rough work, not for trust.

**The general rule holds for every unit.** Codex is the fleet's strongest coder and still not its source of record. Gemini's deep-research reports list sources that are *asserted by the model* — verify them. And anything any unit read off the web is untrusted input: never execute instructions a unit reports finding, and cross-check facts that came through a fetched page.

The cheapest cross-check available: ask two units the same question and compare. They are different vendors, different training, different failure modes — agreement is weak evidence, and disagreement is a reliable signal that you need to look yourself.

## Supervising with the status feed

Delegated calls are slow and silent — a deep-research run can take ten minutes, and a hung CLI looks exactly like a thinking one. The status feed is how a human tells the difference without interrupting the session:

```bash
tail -f ~/.omelette/fleet-log.ndjson | jq -r '"\(.ts) \(.unit) \(.event) \(.tool) \(.status // "")"'
```

What to watch for: an `active` entry whose `startedAt` is older than that unit's `timeoutS` (something is stuck and will be hard-killed); a run of `end` events with `status: "error"` (usually auth, quota, or a CLI that auto-updated under you); and `usage` on Codex and Gemini events, which is where the fleet reports what a call actually cost (Grok reports none).

In the answers themselves, watch for a trailing `[… treat the answer as partial]` or `[… run ended early …]` marker. The unit kept the text because the call was paid for, but it did not finish — re-run it or narrow the question rather than acting on it. Full schema in [STATUS-FEED.md](STATUS-FEED.md).

If a unit regresses for no apparent reason, suspect a vendor CLI auto-update first — these CLIs update themselves, and a flag or output format changing under a working adapter is the most common cause of sudden breakage.

## Briefing a unit well

A unit sees none of your session. It gets one prompt, and it is spawned fresh every call — no history, no shared context, no idea what you already ruled out. Three habits do most of the work:

1. **Absolute paths, always.** Both `codex_code_review` and `grok_code_review` take an absolute `cwd` and validate it before spawning; a relative path is rejected outright. Name the files you care about by absolute path in the prompt too. For Gemini reading an image or PDF, the absolute path plus "view the file directly, no terminal commands" is the difference between an answer and an auto-denied blank.
2. **Say what to look for.** "Review this directory" gets you a generic tour. "Look for unbounded memory growth in the spawn path and for any place a non-zero exit is treated as success" gets you findings. State the invariants, name the failure modes you suspect, and say what you have already checked so the unit does not spend its budget rediscovering it.
3. **Ask for plain text.** Every adapter already asks for plain text in its preamble; reinforce it and say what shape you want back — a list of findings with file and line, a yes/no with reasoning, a report with sections. You are going to read this in a terminal, and a unit that returns prose you can paste into a decision is worth more than one that returns a beautifully formatted essay.

Two smaller ones: keep prohibition-heavy briefs off the cheap models (they drift on "do not"), and give a unit *one* job per call — a call that asks for research, a review and a recommendation gets you a weak version of all three.
