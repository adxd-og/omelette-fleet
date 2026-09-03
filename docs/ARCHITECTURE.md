# Architecture

Three layers, one direction of dependency: `servers/` → `units/` → `core/`.

```
servers/<unit>.mjs     entrypoint: import the adapter, startUnit(unit)
units/<unit>/          adapter.mjs (vendor knowledge) + models.js (catalog)
core/                  everything that is not vendor-specific
```

## core/

| Module | Owns |
|---|---|
| `unit.mjs` | The `defineUnit` contract, validation, and the generic tool runtime (`createUnitRuntime`, `startUnit`). Also `MUTATE_RE`, the git/deploy intent pattern, and `boundedRetry`. |
| `config.mjs` | `fleet.config.json` resolution, the key schema, and the write-mode **ceiling**. |
| `catalog.mjs` | `makeCatalog()` — the model/effort allowlist and the rendered cheat-sheet behind every `<unit>_models` tool. |
| `spawn.mjs` | One bounded child process: own process group, wall-clock SIGKILL, output caps, the **child-environment allowlist** and billing scrub, actionable ENOENT. |
| `status.mjs` | The schema-1 status feed (per-unit snapshot + shared NDJSON log), fail-soft. |
| `jsonrpc.mjs` | Newline-delimited JSON-RPC 2.0 over stdin/stdout — the MCP stdio transport. `createHandler` is pure and testable; `serve` wires it to the process. |
| `client.mjs` | The other side of the same transport: drive one unit server the way a real client does. Behind `omelette-fleet call`, `scripts/mcp-call.mjs` and the end-to-end tests. Every way a call can die is a rejection that does not wait out the timeout — a JSON-RPC `error` reply to any of the three requests, a child that exits, a stdin that closes under an unanswered request — and the timeout itself is clamped to 1–86400 s, because Node's int32 timers turn a larger value into an instant false "no answer". |
| `log.mjs` | stderr-only logging. stdout belongs to JSON-RPC; one stray byte there and the client shows the server as offline. |

A unit adapter never touches stdin/stdout, never reads the config file, never spawns directly, and never writes the status feed. It declares what is vendor-specific and receives everything else through `ctx`.

## The adapter contract

`defineUnit(spec)` validates the spec loudly at import time — a bad tool kind, a duplicate tool name, a missing `run()`, a name that is not `[a-z][a-z0-9-]*`, or a catalog that did not come from `makeCatalog()` all throw before the server starts.

```js
defineUnit({
  name: 'codex',                       // [a-z][a-z0-9-]*; also the config key and status unit
  label: 'Codex',                      // human name in error messages
  bin: { env: 'CODEX_BIN', default: 'codex' },
  billingRiskEnv: ['OPENAI_API_KEY'],  // deleted from every child env
  envPassthrough: ['CODEX_*'],         // added to core/spawn.mjs's ALLOWED_ENV for this unit's
                                       // children only (exact names or PREFIX_* patterns); the
                                       // billing scrub runs AFTER it, so a pattern cannot
                                       // re-admit an API key. Everything else is NOT inherited.
  envMap: { model: 'CODEX_DEFAULT_MODEL', timeoutS: 'CODEX_TIMEOUT_S' },   // env overrides
  builtin: { timeoutS: 600 },          // unit defaults for config keys
  extraSchema: { imageMaxTurns: { type: 'posint', default: 8 } },          // unit-only config keys
  supportedModes: { 'read-only': true, 'workspace-write': true|null },     // null = refuse that level
  auth: { detect: (stderr) => bool, help: 'run `codex login`' },           // checked on empty-stdout runs only
  catalog: makeCatalog({ models, efforts, guide, title }),
  tools: [{ name, description, inputSchema, kind, mutateGate?, run(args, ctx) }],
})
```

Defaults filled in by `defineUnit`: `version: '0.1.0'`, `serverName: 'omelette-<name>'`, `label: <name>`, empty `billingRiskEnv` / `envPassthrough` / `envMap` / `builtin` / `extraSchema`, `supportedModes: { 'read-only': true, 'workspace-write': null }`, `auth: null`. A string `bin` is normalised to `{ env: null, default: bin }`.

**Tool kinds** — `research | review | image | pipeline | catalog`. A `catalog` tool never spawns: the runtime answers it locally with `catalog.render()`. Every other kind must supply `run(args, ctx)` returning a string or `{ text, usage?, isError? }`. `isError: true` is how an adapter reports a refusal it handled itself — a missing prompt, a bad `cwd` — so that MCP is told it is an error and the status feed records one, instead of an `Error: …` string being reported as a successful answer.

**`ctx`** — `{ cfg, mode, model, effort, spawn, retry, log, catalog, home }`. `cfg` is the resolved value bag, `mode` is the *effective* mode after the ceiling, `spawn(o)` is the bounded child-process call, `retry(fn, {skipIf})` is the one-shot retry.

**`mutateGate: true`** puts the tool's `prompt` through `MUTATE_RE` (`git push|commit|merge|rebase|reset|tag`, `npm publish`, `deploy`) and rejects the call before any spawn. It is applied per tool, not globally, because "review the last git commit" is a legitimate read-only ask for a review tool.

`tools/list` is derived from the same array with `run`, `kind` and `mutateGate` stripped, so the MCP shape and the implementation can never drift.

## The path of one call

1. **Client → transport.** Claude Code writes a newline-delimited JSON-RPC frame to the server's stdin. `createLineSplitter` reassembles frames across arbitrary chunk boundaries; a frame that is not JSON is dropped without killing the loop, and so is any single frame that passes 16 MiB without a newline — it is dropped with one stderr line rather than growing the buffer until the process dies.
2. **`tools/call` → runtime.** `createHandler` routes to `callTool(name, args)`. An unknown tool name returns a clean error result.
3. **Catalog short-circuit.** If the tool's kind is `catalog`, the rendered catalog is returned. No config, no spawn, no status entry.
4. **Config.** `unitConfig()` resolves every key: built-in default → file `defaults` → file `units.<unit>` → environment. Warnings are logged once per process, never repeated per call.
5. **Ceiling.** `effectiveMode()` has already run inside the config resolution: a requested `workspace-write` survives only if the unit implements it *and* the machine env lists the unit in `OMELETTE_ALLOW_WRITE`. Otherwise it is narrowed to `read-only` with a warning. `enabled: false` fails the call here.
6. **Model / effort selection.** An explicit `model` argument wins; otherwise the configured default is used *if* it is in the catalog (an unknown configured default is ignored with a warning and the vendor default applies). A unit that ignores its vendor's config file — Codex — pins the catalog head here instead of leaving the model unset.
7. **Status start.** `status.start()` opens an `active` entry and appends a `start` line to the log. It runs before validation on purpose, so a rejected call still produces a matching `end` event.
8. **Catalog validation.** An explicit model or effort that is not in the allowlist is a hard error with the allowed ids listed — no process is spawned to be told the same thing.
9. **Mutate gate.** For tools declaring `mutateGate`, git/deploy/publish intent in the prompt is rejected here.
10. **Adapter `run(args, ctx)`.** The vendor-specific part: build argv, choose a sandbox/toolset, wrap the prompt.
11. **Spawn.** `runProcess` starts the CLI in its **own process group** (so a timeout can SIGKILL the whole tree), keeps only the tail of stdout (400 KB) and stderr (8 KB), feeds the prompt on stdin when the adapter asks, and **builds the child environment from an allowlist** — `ALLOWED_ENV`, plus the unit's `envPassthrough` patterns, plus `OMELETTE_ENV_PASSTHROUGH`, then the billing scrub, then the adapter's own additions. Nothing else is inherited. It never rejects on a non-zero exit — the adapter decides what an exit code means for that CLI. A missing binary rejects with an actionable "install X" message.
12. **Auth check.** Only on a run with empty stdout: if `auth.detect(stderr)` matches, the adapter's `auth.help` becomes the error. A real answer that merely mentions signing in can never false-positive.
13. **Vendor parse.** The adapter turns the raw run into text — Codex reads the last `agent_message` from its event stream and the usage from `turn.completed`; Gemini reads `status`/`response` from agy's JSON envelope; Grok reads `text`/`stopReason` from the one-shot result object. A run that finished badly but produced text keeps the text under a visible partial marker; only a text-less failure throws.
14. **Status end.** `status.end()` closes the entry with `ok`/`error`, duration, truncated error text, and any `usage` the adapter returned; the result goes back over stdout as MCP `content`, carrying `isError` when the adapter or the runtime said so.

## Why three servers, not one

- **Failure isolation.** A vendor CLI that hangs, a missing binary, or a bug in one adapter takes down one server. The other units keep answering; the client shows exactly which one is offline.
- **Stable tool names.** Each server owns a fixed tool list under a fixed server name, so `mcp__<prefix>-<unit>__<tool>` never changes because a different unit was installed, removed, or disabled. A single multiplexed server would have to renumber or namespace its tool list dynamically, and a partial fleet is the normal case here.
- **Independent posture.** Each unit gets its own config block, its own timeout, its own ceiling decision and its own billing-scrub list, enforced in its own process.

The cost is one idle Node process per unit, which does nothing until a call arrives.

## Why spawn CLIs, not call APIs

- **Subscriptions.** The vendor CLIs authenticate against the plan you already pay for. Calling the raw API instead would mean a metered bill and a second set of credentials to manage. The same reason drives the scrub list: with an API key visible in the environment, some of these CLIs silently prefer it over the browser/OAuth credentials, which turns every fleet call into real metered spend.
- **The CLI's own machinery is part of the posture.** Codex ships an OS-level sandbox (Seatbelt on macOS, Landlock/seccomp on Linux); Grok ships a toolset allowlist plus a deny/ask/allow permission engine; agy ships a permission policy with headless auto-deny. Driving those flags is enforcement that a raw API client would have to invent — and would get wrong. See [SECURITY.md](SECURITY.md) for what each layer actually guarantees.
- **The CLIs already do the agentic work.** File reading, grep, web search and tool loops exist in the CLI. The adapters constrain them; they do not reimplement them.

The flip side is that a CLI is a program with an environment and a config file of its own, and both are inputs the fleet has to decide about rather than inherit. The child environment is built from an allowlist, and a vendor config file that can carry executable behaviour — MCP servers, hooks, plugins — is ignored where the CLI lets us ignore it (Codex's `--ignore-user-config --ignore-rules`). What that costs, and what it means for "the vendor default", is in [SECURITY.md](SECURITY.md).

## How catalogs are curated

Each unit ships a `models.js` holding the model list, the `model` allowlist, the optional `effort` allowlist, and a compact `GUIDE` string that rides in every `tools/list` payload. Rules:

- **Ids are exact.** They are the literal strings the CLI accepts (`grok --model "<id>"`, `codex exec -m <id>`, `agy --model "<id>"`). Spawn uses an argv array, never a shell, so spaces and parentheses in an id are one safe element.
- **The allowlist is a correctness gate, not a convenience.** A typo is rejected locally with the valid ids, without paying for a process spawn to be told the same thing — and if a CLI generation ever goes back to silently falling back to its default on an unknown `--model`, this gate is what stops a typo from quietly running on the wrong model. It also carries policy: a model the CLI would happily run can be kept out of the fleet path deliberately.
- **Current generation only.** When a vendor ships a new generation, the previous one leaves the catalog rather than accumulating. Restoring a retired generation means re-adding its entry by hand.
- **Ids are verified live, and the date is recorded.** Each `models.js` header states which CLI version was checked, on what date, and how (one trivial call per id, success = a completed turn). What the binary embeds is not the same as what an account accepts — the Codex header records exactly which ids a ChatGPT-plan account accepted and which were rejected. **Effort values get the same treatment**, and for the same reason: a sweep that read the effort names out of the binary's strings shipped a `minimal` that every model in the catalog rejects with an HTTP 400, so they are now probed with a real one-shot too.
- **Numbers are sourced or absent.** `useFor` / `avoid` carry benchmark figures with their harness and provenance, and explicitly name the axes that are *not published* for a model so the next sweep does not silently upgrade an inherited claim.
- **A catalog copied from an upstream source of truth stays byte-identical to its origin.** `makeCatalog()` takes the models array as data precisely so a synced file needs no edits to be usable here.

Consequence for the docs: any model id or benchmark number in this repository's documentation comes from `units/<unit>/models.js` and nowhere else.
