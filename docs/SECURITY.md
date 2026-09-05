# Security

The short version: units read, the manager writes. Everything below explains what enforces that, how strong each mechanism actually is, and where the guarantees stop.

## Threat model

**Prompt injection through content a unit ingests.** Every unit is pointed at untrusted material by design — fetched web pages during research, and repository contents during review. A page or a file can contain instructions aimed at the model. The mitigation is not detection; it is that a unit has nothing to act with. A compromised unit can return misleading *text*, and that text is what you have to distrust — never execute instructions a unit reports finding, and verify facts it brings back from the web.

**Secrets reachable by a model that can run shell commands.** A vendor CLI is not a library call: it runs a model that reads files and executes read-only commands. Anything in that process's environment is therefore readable by the model and can end up in an answer, in a log, or in a web request. Inheriting the MCP server's environment would hand a review run your `GH_TOKEN`, your cloud credentials and everything else exported in your shell. Hence the env allowlist below.

**Billing-key leakage into metered spend.** These CLIs authenticate against a subscription, but several of them prefer an API key when one is visible in the environment — silently, with no visible change except the bill. `OPENAI_API_KEY`, `CODEX_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are deleted from the child environment by the unit that could be flipped by them — and the scrub runs *after* the allowlist and the passthrough patterns, so a pattern like `CODEX_*` cannot re-admit the key it deletes.

**Configuration the fleet did not choose.** A vendor CLI reads its own config file, and that file can carry more than model defaults: MCP servers, plugins, hooks, notification commands. A filesystem sandbox does not bound a *configured MCP tool* — a server that mutates an external system (a tracker, a deploy endpoint) would be reachable from a call the fleet believes is read-only. Codex is therefore run with its user config ignored entirely.

**Runaway processes.** A model in a tool loop can burn wall-clock time and memory. Every spawn runs in its own process group so a wall-clock timeout SIGKILLs the whole tree rather than the top process; stdout is capped at a 400 KB tail and stderr at 8 KB, so a runaway generator cannot exhaust memory; Grok additionally caps turns (`maxTurns`, default 30; `imageMaxTurns`, default 8). The stdin transport caps one un-terminated JSON-RPC frame at 16 MiB and drops it rather than letting the buffer grow until the process dies.

**A config file becoming a foot-gun.** A JSON file is easy to edit, easy to copy between machines, and — critically — writable by anything that can write files. If widening a unit's powers were a one-line config edit, the config file would itself be the attack surface. Hence the ceiling below: the config can only ever narrow.

## The ceiling

Opening write mode for a unit takes **two independent keys**:

1. `"mode": "workspace-write"` for that unit in `fleet.config.json`, and
2. the unit named in **`OMELETTE_ALLOW_WRITE`** (comma-separated, case-insensitive) in the MCP server's environment block.

`OMELETTE_ALLOW_WRITE` lives in the MCP server registration — outside every project, and not writable by a read-only unit. **`ORION_ALLOW_GEMINI_MUTATE=1`** is honoured as a legacy alias that opens the ceiling for `gemini` only.

"The config can only narrow" means exactly this: a config file that asks for more than the environment allows does not get it. The requested mode is recorded (`requestedMode`) and the effective mode falls back to `read-only` with a warning on stderr — the call still runs, just without the extra power. `omelette-fleet show` prints that state as `workspace-write (clamped to read-only)`, so nobody reads the requested value off the table and believes it. There is no config key, and no tool argument, that can widen a unit past what the machine environment permits.

A third gate sits below both: a unit that does not implement a mode (`supportedModes[mode]` falsy) refuses it explicitly, **even with the ceiling open**.

```
requested mode ──▶ does the unit implement it? ──no──▶ read-only (warning)
                            │yes
                            ▼
              is the unit in OMELETTE_ALLOW_WRITE? ──no──▶ read-only (warning)
                            │yes
                            ▼
                      effective mode
```

## The environment allowlist

A vendor CLI's environment is **built from scratch**, never inherited. In order:

1. **`ALLOWED_ENV`** — the exact names every child may see. Nothing here is a credential:

   ```
   PATH  HOME  USER  LOGNAME  SHELL  TERM
   LANG  LC_ALL  LC_CTYPE  TMPDIR  TZ
   XDG_CONFIG_HOME  XDG_DATA_HOME  XDG_CACHE_HOME
   HTTP_PROXY  HTTPS_PROXY  NO_PROXY  http_proxy  https_proxy  no_proxy
   SSL_CERT_FILE  SSL_CERT_DIR  NODE_EXTRA_CA_CERTS
   ```

   Enough to find a binary and a home directory, speak the right language, resolve a proxy and trust the right CAs.

2. **The unit's `envPassthrough`** — adapter-declared exact names or `PREFIX_*` patterns, the vendor's own knobs:

   | Unit | Patterns |
   |---|---|
   | codex | `CODEX_*` |
   | gemini | `AGY_*`, `GEMINI_*`, `GOOGLE_*` |
   | grok | `GROK_*`, `XAI_*` |

3. **`OMELETTE_ENV_PASSTHROUGH`** — your fleet-wide escape hatch: a comma-separated list of exact names or `PREFIX_*` patterns, for when a CLI needs one more variable. It applies to every unit, so add narrowly.

4. **The billing scrub** — the unit's `billingRiskEnv` names are deleted *after* steps 2 and 3, which is why `CODEX_*` can be passed through without re-admitting `CODEX_API_KEY`.

5. **The adapter's own additions**, applied last and unconditionally — for example `GROK_WEB_FETCH=1`.

A variable absent from the parent environment is absent from the child; empty strings are never synthesised, because "set but empty" means something different from "unset" to several CLIs.

`inheritEnv: true` opts out of all of it and hands over the parent environment untouched. **It is used for exactly one child in this package**: `claude mcp add` / `claude mcp remove` from the CLI, which must see `CLAUDE_CONFIG_DIR` (it decides *where* a registration lands) and your version manager's variables (they decide which `node` runs it). There is no model reading the environment in `claude mcp add`, and there always is one in `codex exec` — no vendor CLI ever gets it.

`omelette-fleet doctor` runs its version and login probes in the *same* environment a real tool call would get, allowlist and scrub included, so it cannot report a unit healthy that the server would then fail on — or quietly bill a metered key while probing.

## Network

**The only outbound request this package makes on its own is the update check.** One unauthenticated `GET` to the GitHub releases API for this repository:

```
GET https://api.github.com/repos/adxd-og/omelette-fleet/releases/latest
Accept: application/vnd.github+json
User-Agent: omelette-fleet/<version>
```

Those two headers are everything it sends. No token, no cookie, no query string, nothing about your machine, your config, your prompts or your usage — the package has no telemetry of any kind. Nothing is downloaded and nothing is executed: the response's release tag is compared against this checkout's `package.json` version, and the result is a string and a boolean.

It runs in three places:

- **A unit server's startup**, fire-and-forget — the server is already answering before the request is sent, the whole exchange is capped at 2.5 s, and every failure (no network, DNS, a rate limit, a proxy answering HTML) resolves silently. At most one line of stderr comes out of it, and only when there really is a newer release.
- **`doctor`**, for the `version … · latest …` header line. An unreachable GitHub is never one of doctor's findings.
- **`omelette-fleet update`**, which asks fresh rather than reusing the cache — it is the one moment the answer has to be current.

The first two share a 24-hour cache (`<home>/update-check.json`), so a busy day of tool calls is still at most one request. Switch it off entirely with `OMELETTE_UPDATE_CHECK=0` in the MCP server's env block, or `"updateCheck": false` in the fleet config; the env switch is the one a project cannot reach.

`omelette-fleet update` also touches the network through `git`, and only in ways that cannot cost you work: it refuses to run at all when `git status --porcelain` is non-empty (it lists the dirty paths instead), it only ever fast-forwards (`git pull --ff-only`), and a diverged branch fails with the reconciliation command rather than a merge. `--check` stops after `git fetch`, which writes refs and no working-tree file. MCP registrations are never rewritten — they hold absolute paths a pull does not move.

Everything else that reaches the network is the vendor CLI's own traffic, made with its own credentials: this package neither proxies nor inspects it.

## Per-unit enforcement matrix

These are not equivalent mechanisms. Be honest with yourself about which unit you are trusting with what.

| Unit | Read-only enforced by | Strength | `workspace-write` |
|---|---|---|---|
| **codex** | `-s read-only` — Codex's own OS-level sandbox (Seatbelt on macOS, Landlock/seccomp on Linux) — plus `--ignore-user-config --ignore-rules` | **Kernel-enforced.** The model's shell commands physically cannot write | Implemented. Kernel-scoped to the `-C <dir>` passed. Granted to `codex_code_review` with an explicit absolute `cwd` (ceiling required), and to `codex_image` in a throwaway temp dir the adapter creates (ceiling **not** consulted — see below) |
| **grok** | Six layers on the spawn argv (below) | **Toolset-level.** The write/shell tools do not exist in the process's toolset | **Declared unsupported** — refused even with the ceiling open |
| **gemini** | your agy `settings.json` permission policy (headless auto-deny) plus a prompt preamble | **Weakest.** No kernel sandbox; `--mode` is a permission policy | Maps to `--mode accept-edits`: edits auto-approved by agy's own permission layer inside the process cwd |

### Codex — one real layer, plus isolation

`codex exec -s read-only` is an operating-system sandbox, not a policy. `codex_research` is spawned read-only **regardless of the fleet config**, because a research call has no directory to scope a write to. `codex_code_review` uses `workspace-write` only when the ceiling is open, the config sets the mode, *and* the caller passed an existing absolute `cwd`; without a `cwd` it logs and runs read-only. `--dangerously-bypass-approvals-and-sandbox` and `--dangerously-bypass-hook-trust` are never passed. Verified live on codex-cli 0.146.0 (2026-09-02) and re-checked on 0.153.0 (2026-09-03): the run header prints `approval: never` / `sandbox: read-only`, and `codex exec` never prompts.

**Isolation.** Every spawn also passes `--ignore-user-config --ignore-rules`. Without them a fleet run inherits the whole of your `~/.codex/config.toml` — MCP servers, plugins, hooks, the `notify` command — and the filesystem sandbox does not bound a configured MCP tool, so a "read-only" research call could reach an MCP server that mutates an external system. `--ignore-rules` drops user and project execpolicy `.rules` files for the same reason. Auth is unaffected: it resolves through `CODEX_HOME`, verified live with ChatGPT auth on 0.153.0. `-c notify=[]` stays as a belt-and-braces silencer in case a future version reads `notify` from somewhere else.

**The consequence:** "the vendor default model" no longer means *your* configured default, because that default lives in the ignored file. When nothing is configured — no `model` argument, no `codex.model` in the fleet config — the adapter pins the first catalog entry explicitly and logs that it did, rather than running on whatever the binary hard-codes.

**Image runs are the one place this unit opens `workspace-write` without the ceiling.** `codex_image` spawns `-s workspace-write -C <a fresh directory under the OS temp dir>` whatever the config and `OMELETTE_ALLOW_WRITE` say. The kernel still scopes every write to that one directory — created empty by the adapter moments earlier, outside every project — so what is being granted is "Codex may write its own scratch directory", not "Codex may write your repository". The ceiling exists to keep a unit out of your code; it is not what makes an artifact contract possible, and an image tool that cannot leave a file behind is not a tool. The built-in gpt-image-2 tool saves under `~/.codex/generated_images/<uuid>/` and the model then copies the file into the working directory with a shell command, which is the part that needs the sandbox open (verified live, codex-cli 0.153.0, 2026-09-03). Same posture as `gemini_image`'s temp cwd: the tool returns the absolute path, you copy the file out, and temp directories may be cleaned by the OS. Image runs also drop web search and are never retried.

One smaller hardening: the prompt is fed on **stdin** (`codex exec -`), so a prompt beginning with `-` can never be read as a flag and argv stays short.

### Grok — layers L1–L6

```
L1  --tools read_file,grep,list_dir,web_search,web_fetch
    THE GUARANTEE. Headless allowlist of builtin tools. With --tools set,
    default tool injection is DISABLED — bash (run_terminal_cmd),
    search_replace (edit), todo_write, task, image/video gen, deploy_app
    etc. simply do not exist in the toolset.
L2  --disallowed-tools search_tool,use_tool,Agent
    The final toolset otherwise retains always-on MCP meta-tools;
    search_tool/use_tool could reach your own MCP servers (which DO
    mutate). --disallowed-tools runs AFTER --tools and wins, so this
    strips the meta-tools; `Agent` blocks ALL subagent spawning at the
    toolset level.
L3  --no-subagents — belt-and-suspenders duplicate of the Agent entry.
L4  --deny Bash --deny Edit --deny Write
    Permission-layer deny rules (deny > ask > allow, enforced in every
    mode). BEST-EFFORT redundancy: if a future CLI version ever injects a
    shell/edit tool past L1/L2, the permission engine still denies it.
L5  --max-turns <N> — runaway-loop cap (config maxTurns, default 30).
L6  Prompt level, two separate things. (a) The read-only preamble is on
    BOTH research and review prompts. (b) The fleet's MUTATE_RE intent
    gate runs on grok_research prompts only — it is deliberately skipped
    for grok_code_review, where "review the last git commit" is a
    legitimate read-only ask. Weakest layer either way; L1/L2 are what
    actually guarantee read-only, and L1-L5 hold for review exactly as
    they do for research.
```

Image runs swap L1 for an image-**only** toolset (`--tools image_gen` or `image_edit`): no read, web or shell tools at all. `--allow WebFetch --allow WebSearch` is added to research/review runs only, because a headless tool call that would prompt (web_fetch's domain approval) does not fail closed — it *cancels the entire run*, exit 0 with no answer. Those allow rules can only un-prompt the two web tools; L1 already bounds the toolset and deny still beats allow. Setting `webSearch: false` drops `web_search`/`web_fetch` from L1 and the allow rules with them.

### Gemini — the weakest posture, documented as such

agy has no kernel sandbox, and **nothing in this package can pin its permissions from the outside**: the only permission-shaped flags the CLI accepts are `--mode accept-edits|plan`, `--dangerously-skip-permissions` (never passed) and `--disable-slash-commands` (checked against agy 1.1.25's own `--help`, 2026-09-03). The read-only posture therefore rests on *your* `~/.gemini/antigravity-cli/settings.json` plus headless auto-deny. That is the documented limitation, not an oversight.

What the unit does enforce:

- **Headless auto-deny is real.** Any tool that would prompt is denied; the run then exits 0 with an empty response and the reason on stderr, which the adapter surfaces as a loud error rather than a blank answer.
- **`--disable-slash-commands` on every spawn.** Without it, prompt text containing `/something` gets slash-command and skill expansion in print mode — a prompt-injection path into agy's own command surface, for a feature no headless run needs.
- **Git/deploy intent is rejected before spawn** (`mutateGate`), and every prompt carries a read-only preamble.
- **agy's `skip` and `sandbox` modes are never used.** `--mode plan` (agy's read-only planning mode) was evaluated live on 2026-09-03 and **not** adopted: it adds nothing demonstrable over headless auto-deny — the model reached for the shell `command` tool and was denied either way. The hook where such a flag would go is marked in the adapter.

`gemini_image` always runs with `--mode accept-edits`, because the image tool has to save its artifact. It is given a **freshly created temp directory under the OS temp dir as its cwd**, so even a cwd-relative save lands outside every project. The tool returns the absolute path; you import the file by hand. Its prompt carries the same "do not run terminal commands — they are unavailable" instruction as the research preamble: the first live image call was lost to the model reaching for the shell `command` tool, which headless agy auto-denies. That instruction is in the prompt rather than something a retry gets lucky with — this run is not retried.

## Partial answers are never passed off as clean ones

A run that produced text but did not finish properly keeps its text — the call is paid for and the text is usually the useful part — under a visible marker appended to the answer:

- `[<unit>: CLI exited N — treat the answer as partial]` on a non-zero exit that still produced text (all three units).
- `[grok: run ended early — stopReason=…]` when Grok stopped for any reason other than a normal end of turn. A cancelled headless run with **no** text throws instead, naming the interactive-approval cause.
- `[gemini: run ended early — status=…]` when agy's envelope reports a non-SUCCESS status alongside text; text-less failures throw.
- `[codex: run ended before turn.completed — treat as partial]` when the Codex event stream has an answer but no completion event.
- `[<unit>: hard-killed after <N>s — treat the answer as partial; raise <unit>.timeoutS in the fleet config]` when the run outlived `timeoutS` and was SIGKILLed with text already captured (all three units). The answer is extracted with the same parsing a finished run gets — no second parser for the failure path — and the result carries `partial: true` into the status feed while the status stays `"ok"`. A kill with nothing captured throws, and a killed run is never retried.

Refusals the adapter makes itself — a missing `prompt`, a relative or non-existent `cwd`, an `imagePath` that is not a file — come back as MCP `isError` results and are recorded as `error` in the status feed. An error string returned as a successful answer is a bug, not a style choice.

## What this package never does

- **It never writes into a project on its own.** Image artifacts land in a temp directory or the vendor's own session directory and nowhere else: Grok's under `~/.grok/sessions/…`, Gemini's and Codex's in a throwaway directory under the OS temp dir. Either way the tool returns an absolute path and you copy the file where you want it.
  - The one command that writes into a project is `omelette-fleet rules`, and only when you run it: it writes `.claude/rules/omelette-fleet.md`, plus `.claude/agents/omelette-coder.md` and `.claude/agents/omelette-tester.md` with `--agents`. No unit, no tool call and no other command can trigger it. It writes into the current project, or — with `--global` — into `~/.claude` (or `CLAUDE_CONFIG_DIR`), and nowhere else. It overwrites only a file whose marker line matches the one this version renders, whole — a line that merely opens like it is somebody else's file; anything else is refused until you pass `--force`. A target that is not a regular file (a directory, a device, a FIFO) is refused before it is even read. It never follows a symlink: a link at `.claude`, at `.claude/rules`, at `.claude/agents` or at the target file itself is a refusal, `--force` included, and the temporary file is created with `O_EXCL` so a planted one fails the write rather than being followed. `--remove` deletes only files carrying the marker — a file without it is left where it is, with a line telling you to delete it by hand if you meant it.
- **It never passes `--dangerously-*` flags,** in any unit, in any mode: not `--dangerously-bypass-approvals-and-sandbox`, not `--dangerously-bypass-hook-trust`, not `--dangerously-skip-permissions`.
- **It never passes `--always-approve`.** Grok's image tools were verified to auto-approve headless without it; if a future CLI version starts prompting, the run cancels and the adapter surfaces the raw-output error rather than the flag being added silently.
- **It never uses API keys.** Subscription auth only; billing-risk keys are scrubbed from the child env.
- **It never hands a vendor CLI the parent environment.** The allowlist is the only path in.
- **It never lets Codex read your `~/.codex/config.toml`** — the pattern to follow for any future unit whose config file can carry executable behaviour.
- **It never retries an image run or a write-mode run.** The one bounded retry on empty output exists because re-issuing a read-only one-shot is safe. Re-issuing a generation bills image quota twice, and re-issuing a run that may already have written something is not idempotent — both paths skip the retry. That covers **every** image tool in the fleet: `grok_image`, `grok_image_edit`, `codex_image` and `gemini_image` each run exactly once. Deterministic failures (auth, quota, hard-kill, missing binary, CLI error) are never retried either.
- **It never writes Claude Code's config.** `~/.claude.json` is parsed for `doctor`; the only writer of that file is `claude` itself.

## What is best-effort

Call these defence in depth, not guarantees:

- **Grok L4 and L6, and every prompt preamble.** A model can ignore a preamble; a permission rule only helps if a tool got past the toolset allowlist in the first place.
- **`MUTATE_RE`.** It matches `git push|commit|merge|rebase|reset|tag`, `npm publish` and `deploy` in a prompt. It is intent routing, not security — it is trivially avoidable by rewording, and it is not applied to image prompts (where "commit" could be literal scene text) or to `grok_code_review`.
- **The Gemini unit's read-only posture as a whole**, for the reasons above.
- **Auth and quota detection.** Regex matches on stderr. Auth detection deliberately runs *only* on runs with empty stdout, and quota-exhaustion patterns are checked *only* on failed turns, so a successful answer that merely discusses signing in or quotas is never misread — but a vendor wording change can still produce a less precise error message. `doctor` reports a probe it cannot interpret as `unknown`, never as "signed out".
- **Output caps.** They keep the tail. An over-cap response is truncated from the front, which is a data-loss failure mode, not a corruption one — the adapters fall open to raw text rather than dropping a real answer.

## Units propose, the manager applies

The design principle underneath all of the above. A unit's job ends at a proposal: a review, an analysis, a report, a diff described in prose. The change itself is made by Claude Code, where your normal approval flow already sits and where one agent has the whole picture. This keeps the mutating surface in exactly one place, makes prompt injection into a unit a *reporting* problem rather than an *execution* problem, and means an untrustworthy answer costs you a re-read instead of a revert.

## Recommended agy allow-rules

agy in headless mode (`agy -p`) cannot prompt, so **any tool that would ask for permission is auto-denied** — and the run still exits 0 with `status: SUCCESS` and an empty response, with the reason on stderr. Without allow rules, web research fails with something like `a tool required the "read_url" permission that headless mode cannot prompt for`, which this unit surfaces as an error instead of a silent blank.

In `~/.gemini/antigravity-cli/settings.json`, under `permissions.allow`:

```json
{
  "permissions": {
    "allow": ["read_file(*)", "read_url(*)"]
  }
}
```

- **`read_file`** — lets Gemini read local files you name, including images and PDFs. Give an **absolute path** in the prompt and say "view the file directly, no terminal commands", because `command` is auto-denied headless.
- **`read_url`** — required for grounded web research. Without it, research prompts that fetch anything come back empty.

Do **not** reach for `--dangerously-skip-permissions` to fix a headless auto-deny: it auto-approves every tool and removes the only permission layer this unit has.

Two caveats. The only rule forms we have seen working are the `*` target (`read_file(*)`, `read_url(*)`) and deny rules naming an exact path; anything glob-shaped is **unverified** — test a rule before relying on it, and until you have, assume a deny rule covers only the exact paths you listed. And `read_file(*)` is broad by construction: it accepts that any file the CLI's user can read may end up in an answer, and therefore in local fleet logs. If that is not acceptable on your machine, list literal paths instead and expect more auto-denies.
