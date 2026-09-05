# Rules delivery: how the orchestration rules reach a session

**Status:** approved in chat 2026-09-05, awaiting spec review · **Target:** omelette-fleet 0.3.0

## Problem

`omelette-fleet install` registers three MCP servers and nothing else. `docs/ORCHESTRATION.md` ships in the package but no Claude Code session ever reads it: a session sees CLAUDE.md files, the tools' descriptions, and the `instructions` string an MCP server may return from `initialize`. Our servers return none. On a fresh machine the fleet works, but the operating model (units propose, Claude applies; nothing lands unreviewed; Grok is never a sole source) exists only for people who read the README.

## Goals

1. The core contract is in every session's context with **zero user action** after `install`.
2. The fuller operating model (session-side orchestration, tester flow, arbitration rule, routing table) is one command away, as a file Claude Code loads on its own, per project or globally.
3. The delivered text is versioned and refreshable; the fleet never edits a file it did not create.
4. Catalog and docs catch up with the 2026-09-05 model landscape where it changes routing.

## Non-goals

- No change to the write ceiling, env allowlist or billing scrub.
- No `<unit>_propose_tests` tools and no applier pattern (that is the next spec).
- No edits to the user's `CLAUDE.md` / `AGENTS.md`, ever.
- No new runtime dependencies.

## Verified facts this design rests on (2026-09-05)

- Claude Code 2.1.261 loads `<project>/.claude/rules/*.md` and `~/.claude/rules/*.md` into context (probed with codewords; both arrived).
- Claude Code injects an MCP server's `initialize.result.instructions` into context as "MCP Server Instructions" (visible in this session for other servers).
- A Claude Code sub-agent on 2.1.261 does have the `Agent` tool and can spawn a sub-agent (probed live). The tester flow below still routes through the orchestrator by design, not by necessity.
- A Claude Code sub-agent's reasoning effort is set by the `effort:` key (`low|medium|high|xhigh|max`) in an agent definition's frontmatter (`.claude/agents/<name>.md`, project; `~/.claude/agents/`, user; project wins). The Agent tool call carries `model` but no effort. Nesting is allowed up to 3 levels (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`). Source: code.claude.com/docs/en/sub-agents (verified 2026-09-05 via the claude-code-guide agent).
- `gpt-6-astra` is accepted on a ChatGPT plan by codex-cli 0.153.4 at effort high, xhigh and max; `gpt-6-astra-pro`, `gpt-6-pro`, `gpt-6` are rejected with the plan-gating message; only `gpt-6-astra` is embedded in the binary.

## Design

### 1. One source of truth for the rules text: `core/rules.mjs`

- `FLEET_CONTRACT` — the always-on text (~12 lines, plain prose, no markdown headers): units are read-only proposers; nothing a unit returns is applied without the session reviewing it; absolute paths for `cwd` and files; Grok is never a sole source, verify every claim; one job per call, plain text back; ask `<unit>_models` when unsure where a task belongs; "run `omelette-fleet rules` for the full operating model".
- `unitInstructions(unit)` — `FLEET_CONTRACT` + one unit-specific line taken from `defineUnit({ instructions })` (e.g. Codex: "strongest code review, kernel read-only sandbox, absolute `cwd` required"; Gemini: "web-grounded research and multimodal reads, say 'no terminal commands'"; Grok: "cheap volume and second opinions, verify everything").
- `RULES_TEMPLATE_PATH` → `rules/omelette-fleet.md`, the markdown body of the rules file, with a header marker `<!-- omelette-fleet rules v{{version}} · managed by \`omelette-fleet rules\` · edits are overwritten on refresh -->`. `renderRulesFile(version)` substitutes the marker; `parseRulesMarker(text)` returns the version or `null` (file is not ours).
- `rules/` is added to `package.json` `files`; `docs/superpowers` is excluded from the published tarball (`"!docs/superpowers"`).

### 2. MCP `instructions` plumbing

- `core/jsonrpc.mjs` `createHandler({ ..., instructions })` adds `instructions` to the `initialize` result when it is a non-empty string (MCP 2024-11-05 `InitializeResult.instructions`).
- `core/unit.mjs`: `defineUnit` accepts an optional `instructions` string; `startUnit` passes `unitInstructions(unit)` to `serve`.
- Takes effect after a Claude Code restart, like every server change. `install` already says to restart.

### 3. `omelette-fleet rules [--global] [--print] [--remove] [--force] [--dry-run]`

- Default target: `<cwd>/.claude/rules/omelette-fleet.md`. `--global`: `~/.claude/rules/omelette-fleet.md` (respects `CLAUDE_CONFIG_DIR` like `doctor` does).
- `--print` writes the rendered file to stdout and touches nothing.
- Write rules: create directories as needed; if the target exists **without** our marker, refuse with exit 1 unless `--force`; if it exists with our marker and identical content, print "up to date" and do not write; otherwise write atomically (tmp + rename) and print `written <path> (v0.3.0, was v0.2.0)`.
- `--remove` deletes the file only if it carries our marker; a foreign file is left alone with exit 1.
- `--dry-run` prints every path and action, runs nothing (same convention as `install`).
- Help lives in `COMMANDS.rules` like every other command.


### 3b. Shipped agent definitions: `omelette-fleet rules --agents`

Operator request 2026-09-05: "describe how the orchestrator spawns its sub-agents and how to set their effort". Since effort can only be set in an agent definition, the package ships two and `rules --agents` installs them next to the rules file:

- `agents/omelette-coder.md` — `model: opus`, `effort: xhigh`, default tools. Body: implements ONE task from a brief file it is pointed at; TDD when the brief says so; never commits unless the brief says so; never spawns sub-agents; reports status / files / one-line test summary / concerns and writes a full report file.
- `agents/omelette-tester.md` — `model: sonnet`, `effort: xhigh`, tools `Read, Glob, Grep, Bash, Write, Edit`. Body: the tester flow — input is the spec plus the diff, never a summary; writes tests in a new test file; runs the real runner; leaves spec-encoding failures failing and rules each failure test-vs-spec; never edits the implementation.
- Ownership marker for agent files: line 1 is `---`, line 2 is a YAML comment `# omelette-fleet agent v<version> · managed by \`omelette-fleet rules --agents\` · edits are overwritten on refresh`. `parseAgentMarker(text)` mirrors `parseRulesMarker`. Same write/refresh/foreign/remove rules as the rules file; `--remove --agents` removes only marked agent files.
- Targets: `<cwd>/.claude/agents/<name>.md`, or `$CLAUDE_CONFIG_DIR|~/.claude/agents/<name>.md` with `--global`.
- `doctor` reports `agents: v0.3.0 (2)` / `absent` / `foreign` next to the rules line; `update` hints a refresh for outdated agent files too.
- The rules file and ORCHESTRATION.md gain a section **"Spawning sub-agents: model and effort"**: the Agent call sets `model`; effort comes ONLY from the definition's `effort:` key; whether a definition-less agent inherits the session's effort is disputed (operator: yes; claude-code-guide: no) and not observable, so the docs say: set it explicitly when it matters; `subagent_type: omelette-coder` / `omelette-tester` select the shipped definitions; nesting depth 3 by default; the orchestrator, not the coder, spawns the tester.

### 4. `doctor` and `update` hooks

- `doctor` gains one header line: `rules  project: v0.3.0 · global: absent` (or `foreign` when a file without our marker sits at the path). Never a fault; informational.
- `update` (after a successful pull, and under `--check`) reports any rules file whose marker version is behind the package and prints the exact `omelette-fleet rules [--global]` line to refresh it. It never rewrites the file itself.

### 5. Content of `rules/omelette-fleet.md` (one screen, ~60 lines)

1. **Operating model.** The session orchestrates, plans and reviews; it is the only thing that changes code. Code changes go to a strong coding sub-agent (Opus-class, high effort); docs and boilerplate to a cheaper model; research to a fleet unit or a sub-agent. Nothing lands unreviewed.
2. **Tester flow.** After a coder sub-agent reports, the **orchestrator** (never the coder) spawns a tester sub-agent with a clean context: input is the approved spec plus the diff taken from git, never the coder's summary. Tester model: Sonnet-class at high effort. The tester writes tests and **runs them through the real runner**; the raw runner output is the evidence, not the model's word. Findings go back to the coder (its context is kept via a follow-up message), max 2–3 rounds, then escalate to the human.
3. **Arbitration rule.** A failing test is not automatically a bug in the code. The orchestrator decides test-vs-spec before anyone edits; the coder never "fixes code to make the test pass" without that decision.
4. **Fleet routing table** — one line per task (research → Gemini; deep research → Gemini, costly; multimodal → Gemini; cheap second opinion → Grok, verify; strongest review / sandboxed analysis → Codex; final pre-release audit → Codex on `gpt-6-astra`; tie-breaker Grok vs Flash → Gemini 3.1 Pro; images → any; edits → Grok; architecture / UI taste / any mutation → Claude).
5. **Never a sole source**, three lines, Grok called out.
6. **Briefing rules**: absolute paths, say what to look for, plain text back, one job per call.
7. Pointer to `docs/ORCHESTRATION.md` in the package for the long form.

### 6. Docs and catalogs (same release)

- `docs/ORCHESTRATION.md`: new subsection "Tester sub-agent and arbitration" (content = §5.2–5.3); demote Gemini 3.1 Pro to ">1M context and formal/scientific reasoning where Flash has no published numbers; not a code or agentic model"; add the GPT-6 Astra audit row; add "How the rules reach a session" with the two layers.
- `units/codex/models.js`: add `gpt-6-astra` as the **catalog head = the fleet default** (operator decision 2026-09-05, overriding the brief's A/B rule), effort **high** by default; xhigh/max are manual escalation for the hardest architecture / proof / root-cause work; note `-pro`/`gpt-6` rejection verbatim, dated, codex-cli 0.153.4. `gpt-5.6-terra` moves to second place as the cheaper balanced tier; its entry stops claiming to be Codex's own default (codex-cli 0.153.4 made Astra the bundled default). `examples/fleet.config.json` codex model → `gpt-6-astra`; the operator's own `~/.omelette/fleet.config.json` is updated by hand with `omelette-fleet set codex.model=gpt-6-astra`. GUIDE, README, ORCHESTRATION and the rules file say "Codex default `gpt-6-astra` (high)".
- `units/gemini/models.js`: 3.1 Pro `useFor`/`avoid` and GUIDE reworded per the demotion; Flash (High) is the reasoning default too. `npm run sync:catalog` on the ORION side afterwards.
- `units/grok/models.js` + ORCHESTRATION "Never a sole source": update the "as of 2026-08-13" line with the outcome of the Sonnet research pass (measurement found → cite metric, value, source, date; not found → re-date the "unfixed" statement to 2026-09-05).
- README: Quickstart gains step "`omelette-fleet rules` (or `--global`)"; a short "Rules in your session" paragraph under Orchestration; units table row for Codex mentions Astra. CHANGELOG 0.3.0.

## Testing

- `test/jsonrpc.test.mjs`: `initialize` carries `instructions` when given, omits the key when absent.
- `test/unit.test.mjs`: `startUnit` composes `FLEET_CONTRACT` + the unit line; a unit without `instructions` still gets the contract.
- `test/rules.test.mjs` (new): render/parse marker round-trip; write → identical rewrite is a no-op; older marker → rewritten and reported; foreign file → refused without `--force`, replaced with it; `--remove` on foreign → refused; `--global` honours `CLAUDE_CONFIG_DIR`; `--print` writes nothing; `--dry-run` writes nothing.
- `test/cli.test.mjs`: `doctor` rules line for absent / ours / foreign; `update --check` prints the refresh hint when the marker is behind.
- Catalog tests: Astra in the allowlist and enum; existing effort tests unchanged.
- All tests stay fake-binary; CI matrix unchanged.

## Live verification

1. `npm test` green; `omelette-fleet doctor` clean.
2. Restart Claude Code: the three "MCP Server Instructions" blocks show the contract.
3. `omelette-fleet rules` in a scratch git repo, then `claude -p --model haiku` asked for a codeword planted in the file → the codeword comes back (same probe as 2026-09-05).
4. `omelette-fleet rules` twice → second run says "up to date".

## Open items

- Grok hallucination measurement — RESOLVED 2026-09-05 (Sonnet research pass, primary source opened): Artificial Analysis now lists Grok 4.6 on AA-Omniscience at **48.2% accuracy / 34.3% hallucination rate** (Index 30.5), vs 4.5's ~54% hallucination — https://artificialanalysis.ai/models/grok-4-6 . xAI's own model card (2026-08-12, rev. 2026-08-17) reports its narrower internal factuality eval moving the other way (0.98% → 1.7% at high effort); different task, not comparable. No Vectara HHEM / LMArena factuality entry found. Catalog + ORCHESTRATION wording: "improved, still ~1 in 3 wrong when it answers — verify every claim"; the 'no post-fix measurement' sentence is retired.
- ORION's own `CLAUDE.md` should reference `omelette-fleet rules` once the command exists (separate, tiny ORION commit).
