# Orchestration

How to run a session with a fleet: who decides, who proposes, and which unit gets which task.

## The operating model

Your Claude Code session is the **orchestrator and the reviewer**. It plans, decomposes, routes, and it is the only thing that changes code — directly or through its own sub-agents, under whatever approval flow you already have. The units are **read-only proposers**: they research, analyse, review and give second opinions, and they hand back text. Nothing a unit says reaches your repository except by passing through you.

That split is what makes the fleet cheap to supervise. A unit's worst case is a wrong answer, not a wrong commit — so you review claims, not diffs. And because every unit reads untrusted material by design (web pages, repositories), keeping the mutating surface in one place is also the injection containment.

Use whatever subset you have installed. The routing below degrades gracefully: with only Codex you lose grounded multi-source research; with only Gemini you lose the strongest code review; the model still works.

## How the rules reach a session

None of the above helps if the session never reads it. Three layers deliver it, and they are independent.

**Layer 1 — the contract, automatic.** Every unit server returns a short contract from the MCP `initialize` handshake (`InitializeResult.instructions`), and Claude Code puts it in the session's context as "MCP Server Instructions". Install a unit and it is there, with no user action: the units propose and the session applies, absolute paths and one job per call, no unit is a source of record and Grok least of all, plus one line saying what that particular unit is for. It is under ten lines on purpose. Like every other server change, it takes effect on the next Claude Code restart.

**Layer 2 — the operating model, one command.**

```bash
omelette-fleet rules            # <project>/.claude/rules/omelette-fleet.md
omelette-fleet rules --global   # $CLAUDE_CONFIG_DIR or ~/.claude instead
omelette-fleet rules --agents   # also the sub-agent definitions and the /omelette-test skill
omelette-fleet rules --hooks    # the guard script, plus the settings snippet to paste
omelette-fleet install --rules  # the registrations AND `rules --agents --hooks` here, in one run
```

Claude Code loads `.claude/rules/*.md` and `~/.claude/rules/*.md` the way it loads CLAUDE.md, at session start (verified on Claude Code 2.1.261). Agent definitions are different: Claude Code watches `.claude/agents/` and `~/.claude/agents/` and picks a new or edited definition up on its own — usually within seconds, but a new global definition took about ten minutes to appear once (2026-09-06), so treat "seconds" as the common case and not a guarantee. Skills behave like agent definitions: `.claude/skills/` is watched too, and the same "it has to have existed at session start" caveat applies to a skills directory created afterwards. So: **rules load on the next session start; agent definitions and skills are picked up by Claude Code's watcher — usually within seconds, sometimes minutes (restart if `.claude/agents` or `.claude/skills` did not exist before)** — the directory has to have existed when the session started for the watch to be on it. That is the sentence the CLI prints after a write, and only after one of those three kinds was written: a hook script is called by your settings the moment it is on disk, so a run that wrote nothing but the guard says nothing about session starts. Claude Code's own documentation (code.claude.com/docs/en/claude-directory) describes a `paths:` frontmatter key that scopes a rules file to matching files; a rules file without it loads at session start. The shipped file declares no `paths:`, so it is always on.

The file's first line is a version marker, and that marker is the only proof of ownership. Re-running refreshes a marked file and prints which version it moved from; a file sitting at that path *without* the marker is left alone unless you pass `--force`. `--remove` deletes only a marked file, `--print` writes nothing at all, `--dry-run` prints every path and action (and, for `--hooks`, announces the settings snippet instead of printing it — a snippet naming a script that was never written is a snippet somebody pastes). All four managed kinds — the rules file, the agent definitions, the skill, the hook script — work exactly this way; only the comment syntax of the marker differs. `--remove` removes files and exactly one directory — the skill's own `.claude/skills/omelette-test/`, once its `SKILL.md` is gone, because a skill IS a directory and the empty one left behind still reads as an installed skill. It goes only while it is empty and is not a symlink: anything else in there makes the directory yours rather than ours, and a directory that cannot be removed is left alone in silence rather than turned into a refusal. `doctor` reports each kind on one informational line, both scopes, and never counts a missing file as a fault:

```
rules         project: v0.3.1 · global: absent
agents        project: v0.3.1 (2) · global: absent
skills        project: v0.3.1 (1) · global: absent
hooks         project: v0.3.1 (wired: PreToolUse, PreCompact) · global: absent
```

While one of those four is missing from the project — or nothing is registered against this clone, or the guard is on disk and nothing calls it — `doctor` adds ONE `next` line above the units (`omelette-fleet install` → `omelette-fleet rules --agents --hooks` → `merge the hooks snippet into .claude/settings.json (rules --hooks prints it)`), and nothing once all three are done. It reads the project scope only, and it never changes the exit code.

`update` prints the exact refresh command when a marked file is behind the installed package — it never rewrites the file for you.

**Layer 3 — the guard, one script the operator wires up.** `omelette-fleet rules --hooks` writes `.claude/hooks/omelette-guard.mjs` and serves two events from it. On `PreToolUse` (matcher `Bash`) it reads the event's `agent_type`: when the caller is `omelette-coder` and the command is a `git` invocation that creates commits, moves branches or touches stashes, worktrees or tags — `commit`, `merge`, `cherry-pick`, `revert`, `am`, `pull`, `push`, `stash`, `worktree`, `rebase` in every form but `--abort`, `branch <name>` or a `branch` flag that moves a ref (`-m`/`-M`, `-c`/`-C`, `-f`/`--force`, `-u`/`--set-upstream-to`), a tag NAME or a `tag` flag that writes one (`-a`/`--annotate`, `-m`/`--message`, `-F`/`--file`, `--cleanup`, `-s`/`-u`/`--sign`, `-f`/`--force`, `-d`/`--delete`), or a `checkout`/`switch` that creates a branch (`-b`/`-B`, `-c`/`-C`, `--create`, `--force-create`, `--orphan`, `--track`, wherever the flag sits and whether or not the name is attached to it) — it exits 2 and the call never runs. Options ahead of the subcommand are stepped over with their values, quoted ones included (`-C "/My Dir"`, `-c user.name="A B"`, `--work-tree /tmp/x`, a value-less `-p`, a bare `--`), so prefixing them hides nothing. "Coder sub-agents never commit" stops being a request. What it deliberately lets through is everything the coder legitimately needs: `git log`, `git diff`, `git status`, `git branch` as a listing (`-l`, `--list`, `-a`, `-r`, `-v`, `-d`/`-D`), the same for tags (bare, `-l`, `--list`, `-n`, `--contains`, `--sort` — finding the last release is a read), `git rebase --abort`, which undoes rather than writes and is the recovery an agent stuck mid-rebase needs (`--continue` and `--skip` each create a commit, and a bare `git rebase` starts one), `git checkout <ref>` and `git commit-tree`, which writes an object and commits nothing. It is containment for a delegated agent rather than a boundary: it reads one command string, so an argv-array spawn, a backslash-escaped `g\it` or `$(which git)` is out of scope by design. On `PreCompact` it appends a re-read line to every `.omelette/ledger-*.md` in the project, skipping any that is not a regular file — a planted symlink is not followed, a FIFO does not hold the append open. It never throws: malformed input, an unknown event, a ledger it may not write, stdin past 1 MiB and stdin that never closes (given up on after 5 s) all exit 0, because a hook that crashes is a session that stops working.

A hook script is not a hook until something calls it, and **the caller lives in your settings, which this package reads and never writes**. So `rules --hooks` prints the snippet on every run and you merge it in yourself — into `.claude/settings.json` or `.claude/settings.local.json`, whichever you keep this kind of setting in. The CLI says as much above it: *"Merge this into your settings file (it is a whole `hooks` object — add the two events to an existing `hooks` block rather than replacing the file)"*. If you already keep hooks in that file, add these two events to the `hooks` block you have; pasting the snippet over the file would take the rest with it:

```json
{ "hooks": {
  "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node '/abs/path/.claude/hooks/omelette-guard.mjs'" } ] } ],
  "PreCompact": [ { "hooks": [ { "type": "command", "command": "node '/abs/path/.claude/hooks/omelette-guard.mjs'" } ] } ] } }
```

The printed path is absolute and shell-quoted: a hook `command` is a command line rather than an argv, so a checkout under `~/My Projects` would otherwise paste a hook that runs `node /Users/you/My` and fails on every tool call. The quoting follows the platform the CLI runs on: POSIX single quotes on macOS and Linux, double quotes on Windows, where `cmd.exe` would read single ones as part of the path — and the JSON layer then doubles that path's backslashes, `"node \"C:\\Users\\me\\.claude\\hooks\\omelette-guard.mjs\""`.

`doctor` reads **both** files of a scope — `settings.json` and `settings.local.json`, and the global pair under `$CLAUDE_CONFIG_DIR` or `~/.claude` — and says which events actually call the script: `wired: PreToolUse, PreCompact` when one of them wires both, or `NOT wired — paste the snippet from rules --hooks`. Reading only the first would report a guard wired in `settings.local.json`, the file a project usually gitignores, as inert. A settings file that exists but cannot be parsed is named rather than counted (`NOT wired (settings.local.json unreadable) — …`), because sending an operator to re-paste something that is already there is the wrong advice. A `PreToolUse` entry that calls the guard under a matcher which cannot see a `Bash` call is named the same way — `NOT wired (PreToolUse matcher is not Bash) — …` — because it guards nothing and yet looks installed from every other angle. A matcher is a **regex** (Claude Code's own docs spell `"Edit|Write"` and `"mcp__.*"`), so it is anchored and tested against `Bash`: `Bash|Edit`, `.*`, `""` and an absent matcher are all wired, and `Edit` is not. A pattern that does not compile covers nothing rather than being guessed at, and says so in its own words — `NOT wired (PreToolUse matcher "(" is not a valid regex) — …` — because a typo in the settings file and a guard aimed at another tool are fixed differently. That line exists at all because a script nobody calls is the failure mode where everything looks installed.

The guard is a *settings-level* hook on purpose: a `hooks:` block in an agent definition's own frontmatter did **not** fire on Claude Code 2.1.261 — no log line, `git commit` went straight through — while the same hook in the project's settings did fire for the same sub-agent, blocked it with exit 2, and its stdin JSON carried `agent_type: <the sub-agent>` (and no `agent_type` at all for the main thread). Measured 2026-09-06; that measurement is why the guard is keyed on `agent_type` rather than declared in the definition.

The overlap is deliberate: layer 1 is the part you cannot afford to have missing, layer 2 is the part worth a command, layer 3 is the part worth enforcing rather than asking for.

If the project already keeps an `AGENTS.md` for other agents, Claude Code does not read it on its own; a one-line `@AGENTS.md` import in `CLAUDE.md` makes both read the same text (code.claude.com/docs/en/memory, "AGENTS.md"), and `.claude/rules/omelette-fleet.md` loads independently of either.

**In a monorepo, placement decides reach.** `omelette-fleet rules` writes into the `.claude` of the directory you run it in, and a session picks up the rules of the tree it starts in. Put the file at the level whose sessions should see it: the repository root when the whole monorepo works this way, a package directory when only that package does. Descendant directories are loaded lazily rather than all at once, so a root-level file is the one reliably in context for every session — and `--global` puts it in front of every project on the machine, which is the right call for a personal setup and the wrong one for a shared checkout.

## Inside Claude Code

The same split applies one level down, and it is the operating model this package was built under. Your top-level session is the expensive, careful one: keep it for planning, routing and review, and delegate the work.

- **Code changes go to a strong coding sub-agent**, briefed with the plan and the constraints, never to a unit. The session reviews the result before it lands.
- **Documentation, changelogs and boilerplate go to a cheaper model.** They are long, mechanical, and easy to check against the code.
- **Research goes either to a fleet unit or to a sub-agent**, whichever has the better tool for the question — a unit when you want a different vendor's judgement or grounded web search, a sub-agent when the answer is in your own repository.
- **Nothing lands unreviewed.** Every delegated result — sub-agent or unit — comes back to the session, which checks it against the code and the plan before accepting it. Delegation buys throughput, not trust.
- **Branch per feature; main is gated.** Work on a `feat/<name>` branch from main. The session commits each task on that branch once its review passes — git-native checkpoints that a review package, a ledger or a revert can name — while coder sub-agents never commit. The session merges the branch into main itself once every review is clean and it is confident the work is ready — the gate is its own verified judgement, not a per-commit approval; pushing and tagging, the outward-facing steps, wait for the operator's explicit approval.

Two practical rules that follow: give each delegate one job and the context to do it (they start fresh and see none of your session), and do not delegate the decision about whether the work is correct — that is the part you kept the expensive session for.

## Ledger and handoff

A long plan outlives the context it was made in. Compaction is the obvious way that happens, but it is not the only one: an interrupted evening, a session that had to be restarted, a hand-off to a colleague. Everything the orchestrator knows and never wrote down is lost at that moment — and what is lost first is exactly what is most expensive to recover, the *reasons*. The code is still in git. Why option B was rejected is not.

So: **keep a ledger file for every plan, from the first step.**

- One line per event, appended as it happens — not reconstructed afterwards from memory that has already been compacted.
- **Every decision as `Ruling: <what> — <why> — <cost if wrong>`.** The third field is the one that pays for itself: it is what tells a later reader whether to revisit the call or leave it alone.
- Tasks marked complete **with their commits**, so the ledger and the branch name the same checkpoints.
- Before a compaction — announced or merely suspected — and at every natural pause, append a **handoff block**: where the work stands, open findings, agents in flight, next action. Write it as if the reader has none of your context, because they do not.
- After a compaction, **re-read the ledger before doing anything else.** Acting first and reading second is how a plan silently forks.

Location: `<project>/.omelette/ledger-<plan>.md`, with `.omelette/` in `.gitignore` — or wherever the project's own convention puts it. The rule is the file, not the path.

`omelette-fleet rules --hooks` mechanises the fragile step. Its `PreCompact` handler appends `## Compaction <ISO timestamp> (trigger: …) — re-read this ledger before continuing` to every `.omelette/ledger-*.md` in the project, so the marker lands even when the compaction was not announced. It fires on a manual `/compact` as well, including one that reports "not enough messages to compact" (verified on Claude Code 2.1.261, 2026-09-06). The hook is a backstop, not the discipline: it stamps a reminder, it cannot write the handoff block you did not write.

## Tester sub-agent and arbitration

A coder sub-agent reporting "done" is a claim, not evidence. What turns it into evidence is a second sub-agent that did not write the code.

**The clean context is the whole mechanism, and it is cheaper than it looks.** The second agent is not smarter than the first; it is *uncorrelated with it*. An implementer's context contains every assumption that produced the bug, so the blind spot travels with it — re-reading your own diff harder buys very little, while a fresh reader with the same spec and none of the history catches a different class of mistake. That is the reasoning behind Boris Cherny's advice to spend test-time compute on a second, clean-context pass rather than on one longer one ([claude-code-best-practice, tips/claude-boris-2-tips-10-mar-26.md](https://github.com/shanraisshan/claude-code-best-practice/blob/main/tips/claude-boris-2-tips-10-mar-26.md)). The corollary is the rule below: anything that carries the coder's framing into the tester's context — a summary, a "here's what I changed", a list of what to look at — spends the second pass re-running the first one.

**The orchestrator spawns the tester, never the coder.** A coder that picks its own tester grades its own homework: it chooses what gets checked, and it briefs the tester out of the same understanding that produced the bug. A sub-agent on Claude Code *can* spawn a sub-agent, so this is a rule of the operating model rather than a limit of the tool.

**The tester's input is the approved spec plus the diff, taken from git** — never the coder's summary. A summary says what the implementer believed they built; the diff says what they actually did, and the spec says what was asked. Anything that reaches the tester only through a summary is untested by construction.

`omelette-fleet rules --agents` ships that handoff as a mechanism rather than a habit:

```
/omelette-test docs/specs/my-feature.md              # the diff of THIS repository
/omelette-test docs/specs/my-feature.md ../other-repo # …or of one you name
```

The skill (`.claude/skills/omelette-test/SKILL.md`) declares `context: fork` and `agent: omelette-tester` — and deliberately not `disable-model-invocation`, because the orchestrating session is the one that invokes it (through the Skill tool; a human can also type `/omelette-test`) — and its body carries `` !`git -C "$1" diff HEAD` `` and `` !`git -C "$1" ls-files --others --exclude-standard` ``. Those commands run **at invocation, before the fork**, so the forked tester opens with the working tree's real diff and the list of untracked files already in front of it — there is no step at which a summary could be substituted. `$0` is the spec path and `$1` the optional repository path, for an orchestrator whose session sits in another repository: when it is not given the shell expands it to an empty string and `git -C ""` is a no-op, so the diff is the current directory's. Where skills are unavailable, dispatch `subagent_type: omelette-tester` by hand with the spec and the diff; the rule is the same, only the plumbing is manual.

**The tests run through the real runner.** The tester writes its tests in a new file, never editing the implementation, and runs them with `npm test`, `pytest` or whatever the project actually uses. The raw runner output is the evidence, quoted. "I verified it" from a model is not a test result, and neither is a test that was written and reasoned about but never executed.

**Narrow the run when the full suite is Docker-bound or minutes long** — the affected suite, the changed package, the one target that exercises the diff. The orchestrator decides the scope, and the report says which scope ran; an unqualified "tests pass" over a subset is the kind of evidence that is worse than none.

**Arbitration belongs to the orchestrator, and it happens before anyone edits.** A failing test is not automatically a bug in the code; it is just as often a bug in the test. The rule: the test encodes an assumption the spec never made → fix the test; the spec is explicit and the code disagrees with it → fix the code. That ruling binds the coder: what must never happen is a coder changing code until a test goes green without the call being made — that is how a spec quietly becomes whatever the tester happened to assume.

The one exception, and it runs the other way: **the tester may fix or drop its OWN tests** when the spec never made the assumption they encode — it wrote them, they are not evidence about the code, and leaving them failing would bury the real findings. Every such change is reported, so the orchestrator sees what was withdrawn and why. Nothing the tester does reaches the implementation.

**Two or three rounds, then a human.** The ruling and the findings go back to the coder — continue the same sub-agent where the harness supports resuming one, so its context survives — and if the same defect is still there after the third round the problem is no longer a coding problem. Escalate it.

## Spawning sub-agents: model and effort

Two things decide how hard a sub-agent thinks, and they are set in different places.

**The model** is set on the `Agent` call. **Effort is not**: it comes from an *agent definition* — a markdown file with YAML frontmatter, in `.claude/agents/<name>.md` for the project or `~/.claude/agents/<name>.md` for the user, the project's copy winning a name clash. Accepted values: `low`, `medium`, `high`, `xhigh`, `max`.

Effort resolves in this order (code.claude.com/docs/en/model-config, sub-agents): the **`CLAUDE_CODE_EFFORT_LEVEL` environment variable** beats every agent definition; otherwise the **`effort:` key** of the definition; otherwise the sub-agent **inherits the session level**. Never export that variable in a fleet session — it would silently flatten every definition you ship — and set `effort:` explicitly when it matters. (A previous session in this project concluded that a sub-agent's effort could not be set at all and routed work around it. That was wrong — the key exists.)

The frontmatter keys that matter:

| Key | What it does |
|---|---|
| `name` | The value you pass as `subagent_type` |
| `description` | What the orchestrator reads when deciding whether to reach for this agent |
| `model` | The model the sub-agent runs on (the shipped definitions use `opus` and `sonnet`) |
| `effort` | `low` / `medium` / `high` / `xhigh` / `max` — where a sub-agent's effort is set, short of the environment variable above |
| `tools` | Comma-separated allowlist; omit it to give the agent the default tool set |
| `disallowedTools` | Comma-separated denylist, applied **before** `tools` resolves — the harness enforces it, so it is the only way to make "does not spawn sub-agents" true rather than requested |
| `maxTurns` | How many turns the sub-agent may take before the harness stops it |

`omelette-fleet rules --agents` writes two of these next to the rules file:

- **`omelette-coder`** — `model: opus`, `effort: xhigh`, `disallowedTools: Agent`, otherwise the default tools. Implements one task from the brief the orchestrator gives it (a file path or the text itself), follows the brief's test cycle, does not commit unless told to, and cannot spawn anything.
- **`omelette-tester`** — `model: sonnet`, `effort: xhigh`, `maxTurns: 80` by default (config), `disallowedTools: Agent`, tools `Read, Glob, Grep, Bash, Write, Edit`. The flow above: spec plus diff in, new test file, real runner, a test-vs-spec ruling on every failure.

Select them with `subagent_type: omelette-coder` / `omelette-tester`. Both are refreshed by re-running the command and are yours to replace — drop the marker comment and the fleet stops touching the file.

**Those values are configuration, not code.** They live in the fleet config's `agents` block and the templates carry `{{model}}`, `{{effort}}` and `{{maxTurns}}` where they go, so a role is retuned with `set` and a re-render:

```bash
omelette-fleet show agents                                          # what the definitions will say
omelette-fleet set agents.tester.maxTurns=120                       # change it
omelette-fleet rules --agents                                       # re-render the definitions
```

The most common case is the tester running out of turns on a big diff. `maxTurns` in a definition **is** honoured — measured 2026-09-06: an agent given `maxTurns: 3` and six tool calls to make stopped after three, and the harness told the orchestrator it had stopped at its turn limit and could be continued. **A turn-limit truncation is not a failing suite** — the shipped tester is told to say what it had left to do — and the fix is the two commands above, then **continuing the same tester** rather than dispatching a new one, so its context is kept; the new definition is picked up by Claude Code's watcher, usually within seconds, sometimes minutes. The orchestrator may do this on its own mid-plan: it is a config change, not a code change. Details of the block, its defaults and the dotted `set` form: [CONFIG.md](CONFIG.md#agent-settings).

Nesting is allowed three levels deep by default (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), which is exactly why the tester rule has to be enforced rather than stated: the coder *could* spawn its own reviewer. `disallowedTools: Agent` in both shipped definitions takes the possibility away. Verified on Claude Code 2.1.261, 2026-09-05. The coder's "never commits" is enforced one layer out, by the `PreToolUse` guard of `rules --hooks` — a denylist can remove the `Agent` tool, but `git commit` is just a `Bash` call, and only a hook can tell it apart from the `git diff` the coder legitimately runs.

## Routing by task

| Task | Route to | Why |
|---|---|---|
| Grounded web research, fact synthesis, reading and summarising | **Gemini** → `gemini_research` | Web-grounded, and the fleet's citation-oriented researcher |
| Multi-source deep research | **Gemini** → `gemini_deep_research` | Decompose → parallel gather → synthesise, returning Summary / Findings / Sources / Gaps & Confidence. **Costs ~5 CLI runs per call** and commonly takes 3–10 minutes — deliberate use, not the default research mode |
| Reading local images, PDFs, screenshots, diagrams | **Gemini** → `gemini_research` | Multimodal. Give an **absolute path** and say "view the file directly, no terminal commands" — shell tools are auto-denied headless |
| Cheap fast second opinion, mechanical review, high-volume sweeps | **Grok** → `grok_research` / `grok_code_review` | Inexpensive per token and fine for volume — with the caveat below |
| Math / STEM cross-check | **Grok** (AIME 93–100%, GPQA Diamond 84.6–88%) or **Gemini** → `GPT-OSS 120B (Medium)` | Two independent non-Google/non-OpenAI voices for the same check |
| Strongest code review, agentic terminal analysis | **Codex** → `codex_code_review` with an absolute `cwd` | The fleet's strongest reviewer, on `gpt-6-astra` by default (AA Intelligence Index 55 vs sol 51, terra 47); reads, greps and runs read-only shell commands inside an OS sandbox |
| Research where the answer depends on running things | **Codex** → `codex_research` | Same sandbox, plus web search, and it reports real token usage per call |
| Final pre-release security audit | **Codex** on its default `gpt-6-astra` | Leads sol on the vendor's own cyber evals (ExploitBench 100.0 vs 78.5, ExploitGym 42.4 vs 30.3) and on 512K–1M recall (MRCR v2 8-needle 96.3 vs 73.8). Slow and ~5x terra's price — two or three runs per release, not one per PR |
| Tie-breaker when Grok and Gemini Flash disagree | **Gemini** → `Gemini 3.1 Pro (High)` | A third voice inside the fleet, on the model whose training and generation differ from Flash's |
| Image generation | **Gemini** → `gemini_image`, **Grok** → `grok_image`, or **Codex** → `codex_image` (gpt-image-2) | All three save outside your project — a temp directory, or Grok's session directory — and return an absolute path you import by hand |
| Image-to-image editing | **Grok** → `grok_image_edit` | The only unit in the fleet that edits images |
| Architecture, planning, UI/front-end taste, long-horizon engineering | **Claude** (your session, or its sub-agents) | Grok is explicitly contraindicated for architecture and UI; Codex is a strong reviewer but not a source of record |
| Any file edit, git operation, deploy or publish | **Claude**, under your approval | The only mutating path. Units reject git/deploy intent before spawn and mostly cannot act on it anyway |

Ask a unit's `<unit>_models` tool when you are unsure whether a task belongs on it at all — the catalogs carry "route to / route away" advice, not just ids.

## Model and effort escalation

The rules below come from the catalogs' own `GUIDE` strings. Omit `model` to keep the fleet default; escalate deliberately, because on a subscription quota the cost is real.

**Gemini** — default `Gemini 3.8 Flash (High)` for delegated research and agentic work.
- Down to `(Low)` for quick facts, lookups and short summaries; `(Medium)` when High's latency or token overhead is unwanted. 3.8 deliberately spends more thinking tokens than the previous generation at the same price per token, so **dropping the effort level is the way to buy that back** — not paying High for routine work.
- Up to `Gemini 3.1 Pro (High)` for two things only: inputs past 1M tokens (the 2M context window), and formal or scientific reasoning where 3.8 Flash has no published numbers (GPQA Diamond 94.3, ARC-AGI-2 77.1). It is also the fleet's tie-breaker when Grok and Flash disagree. It is **not** a code or agentic model any more — 3.8 Flash leads it 68.1 vs 46.2 on public coding and 67.6 vs 40.1 on agentic lanes, at roughly a third of the price. `Pro (Low)` is the same two niches at balanced cost.
- Plain 128K retrieval is **not** a reason to reach for Pro — the last measured Flash generation led MRCR v2 128K 97.0 vs 84.9.
- `Claude Opus 4.6 (Thinking)` runs on a separate quota bucket, so it is otherwise-idle capacity for hard verification passes and Opus-grade second opinions. That bucket is the more restrictive one; spend it on hard problems, and prefer Gemini for citation-heavy research (its web grounding via this CLI is unverified for the Claude family).
- `GPT-OSS 120B (Medium)` is a corroborating voice for maths and vendor de-biasing, never the lead researcher.
- The `effort` config key and argument are **inert** for this unit: effort is baked into the model id.

**Grok** — default `grok-4.6`; `grok-4.5` exists only as a regression fallback.
- `effort: low` for fast cheap sweeps, `medium` (the default) for ordinary work, `high` for harder analysis, `xhigh` for the hardest maths and proofs only — it is the slowest setting.

**Codex** — default `gpt-6-astra` at `effort: high`.
- Astra is **accepted on a ChatGPT Plus plan** — probed live 2026-09-05 on codex-cli 0.153.4 at effort low, high, xhigh and max — while `gpt-6-astra-pro`, `gpt-6-pro` and `gpt-6` are rejected on a ChatGPT plan with the same "not supported" message as sol. It leads the fleet on AA Intelligence Index (55 vs sol 51, terra 47) and on the two axes this fleet actually uses Codex for: security and exploit work, and recall past 500K tokens. codex-cli 0.153.4 also made it the CLI's own bundled default; the fleet pins it explicitly either way. No Terminal-Bench figure comparable to the 2.1 numbers below is published for it — do not compare it to them.
- Down to `gpt-5.6-terra` (high) for sweeps and routine review. Astra costs ~5x terra per token and is slow: 64 tok/s against sol's 83, and time-to-first-token 384 s against sol's 140 s at max effort (Artificial Analysis, independent — the comparison there is astra-vs-sol; no astra-vs-terra speed figure is published). Terra is a strong balanced tier in its own right: Terminal-Bench 2.1 87.4, ~91% recall across the 1M window.
- Down to `gpt-5.6-luna` (medium) for single-file questions, lookups, routing and short summaries. **Not** for anything spanning modules or files, not for long inputs (retrieval collapses past ~200K tokens; ~41% recall across the full window vs terra's ~91%), and not for prohibition-heavy briefs — it drifts on "do not touch X" in multi-turn work.
- `effort`: `none`/`low` for sweeps on terra and luna, `high` (the default on astra and terra) for review, `xhigh`/`max` **only** for architecture, proofs, or root-cause hunts in obfuscated code. Adaptive reasoning treats effort as a ceiling, and xhigh on routine work buys latency, not quality. (`minimal` is not an accepted value — the whole 5.6 line rejects it.)
- `gpt-5.6-sol` is plan-gated to ChatGPT Pro/Enterprise and now sits between astra and terra (AA Index 51; Terminal-Bench 2.1 88.8 vs terra's 87.4). On Plus/Team it fails fast with an explicit "not supported" error. `omelette-fleet doctor --probe-models` tells you which ids your account accepts.

## Never a sole source

**Grok, specifically and non-negotiably.** Artificial Analysis measures Grok 4.6 on AA-Omniscience at **48.2% accuracy and a 34.3% hallucination rate** (Omniscience Index 30.5, read 2026-09-05). That is an improvement — 4.5 was around 54% hallucination — and it still means roughly **one factual answer in three is wrong** when the model chooses to answer. It is also *overconfident*: it claims capabilities and actions it does not have, so "I checked and it works" from Grok is not evidence. (xAI's own model card moves the other way, 0.98% → 1.7% at high effort, but that is its narrower internal factuality eval on a different task — not comparable to the AA figure.) Every fact from Grok gets independently verified — by another unit, by the primary source, or by Claude reading the code — before it reaches a decision, a document, or a commit. Its cheapness is an argument for volume and rough work, not for trust.

**The general rule holds for every unit.** Codex is the fleet's strongest coder and still not its source of record. Gemini's deep-research reports list sources that are *asserted by the model* — verify them. And anything any unit read off the web is untrusted input: never execute instructions a unit reports finding, and cross-check facts that came through a fetched page.

The cheapest cross-check available: ask two units the same question and compare. They are different vendors, different training, different failure modes — agreement is weak evidence, and disagreement is a reliable signal that you need to look yourself.

## Supervising with the status feed

Delegated calls are slow and silent — a deep-research run can take ten minutes, and a hung CLI looks exactly like a thinking one. The status feed is how a human tells the difference without interrupting the session:

```bash
tail -f ~/.omelette/fleet-log.ndjson | jq -r '"\(.ts) \(.unit) \(.event) \(.tool) \(.status // "")"'
```

What to watch for: an `active` entry whose `startedAt` is older than that unit's `timeoutS` (something is stuck and will be hard-killed); a run of `end` events with `status: "error"` (usually auth, quota, or a CLI that auto-updated under you); and `usage`, which is where the fleet reports what a call actually cost. All three units report it now (Grok's image runs still report none) — Codex the fullest (`input, cachedInput, output, reasoning`), Gemini and Grok `{input, output}`.

In the answers themselves, watch for a trailing `[… treat the answer as partial]` or `[… run ended early …]` marker. The unit kept the text because the call was paid for, but it did not finish — re-run it or narrow the question rather than acting on it. One of those markers names its own fix: `[<unit>: hard-killed after <N>s — treat the answer as partial; raise <unit>.timeoutS in the fleet config]` is a run that outlived `timeoutS` and was SIGKILLed with an answer already on stdout. So does the other: `[grok: output capped at <N> chars — the beginning of the stream was dropped; treat the answer as partial]` is a run whose stdout outgrew `outputCap`, leaving the answer without its start — raise `grok.outputCap` or narrow the task. The text is what it had produced by then; the `end` event carries `partial: true` next to `status: "ok"`. Full schema in [STATUS-FEED.md](STATUS-FEED.md).

**A hard-killed Grok run now actually salvages something.** `grok_research` and `grok_code_review` ask the CLI for `--output-format streaming-messages-json --include-partial-messages` rather than `json`, because the `json` format writes *nothing* to stdout until the run ends: on a 2026-09-06 probe it had produced 0 bytes at 20 s while the same question in plain mode had text by 16 s. A salvage path reading that stream had nothing to salvage on exactly the runs it exists for. The streaming format emits one JSON object per line as the answer is produced — 441 text deltas, 1513 characters, still there when a 30 s kill landed. Grok is also the slowest unit to give up (`timeoutS` 1800 s in the shipped config, after observed 15-minute reviews), so this is the unit where the difference shows.

The vendor CLIs update themselves; this package deliberately does not — a fleet that rewrote its own code under a running session would be one more thing to distrust when something breaks. `doctor` shows both sides of that: each unit's `version` line is whatever the vendor CLI has become, and the header's `version … · latest …` is where the fleet itself stands. Bringing it forward is your call: `omelette-fleet update`, then restart Claude Code.

If a unit regresses for no apparent reason, suspect a vendor CLI auto-update first — these CLIs update themselves, and a flag or output format changing under a working adapter is the most common cause of sudden breakage.

## Briefing a unit well

A unit sees none of your session. It gets one prompt, and it is spawned fresh every call — no history, no shared context, no idea what you already ruled out. Three habits do most of the work:

1. **Absolute paths, always.** Both `codex_code_review` and `grok_code_review` take an absolute `cwd` and validate it before spawning; a relative path is rejected outright. Name the files you care about by absolute path in the prompt too. For Gemini reading an image or PDF, the absolute path plus "view the file directly, no terminal commands" is the difference between an answer and an auto-denied blank.
2. **Say what to look for.** "Review this directory" gets you a generic tour. "Look for unbounded memory growth in the spawn path and for any place a non-zero exit is treated as success" gets you findings. State the invariants, name the failure modes you suspect, and say what you have already checked so the unit does not spend its budget rediscovering it.
3. **Ask for plain text.** Every adapter already asks for plain text in its preamble; reinforce it and say what shape you want back — a list of findings with file and line, a yes/no with reasoning, a report with sections. You are going to read this in a terminal, and a unit that returns prose you can paste into a decision is worth more than one that returns a beautifully formatted essay.

Two smaller ones: keep prohibition-heavy briefs off the cheap models (they drift on "do not"), and give a unit *one* job per call — a call that asks for research, a review and a recommendation gets you a weak version of all three.
