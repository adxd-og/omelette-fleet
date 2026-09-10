# Adding a unit

A unit is one vendor CLI exposed as one MCP server. Adding one is three files and a test. The runtime already owns everything that is not vendor-specific, so an adapter that reaches for `process.stdout`, `readFileSync` on the config, or `child_process` directly is doing the runtime's job.

## What the runtime does for you vs what the adapter owns

| The runtime (`core/`) | The adapter (`units/<unit>/`) |
|---|---|
| Config resolution and the write ceiling | Which config keys mean anything for this CLI (`builtin`, `extraSchema`, `envMap`) |
| Model / effort validation against the catalog | The catalog itself, and the routing advice in it |
| The git/deploy intent gate (per tool, via `mutateGate`) | Which tools deserve that gate |
| Status feed start/end, including `usage` you return | Returning `usage` when the CLI reports it |
| Bounded spawn: process group, hard kill, output caps, the env allowlist + billing scrub, ENOENT help | The argv, the sandbox/permission flags, the prompt wrapping, and which env names the CLI needs (`envPassthrough`, `billingRiskEnv`) |
| The auth check on empty-stdout runs | The `auth.detect` regex and the `help` text |
| JSON-RPC, `tools/list`, stderr logging | Nothing — never touch stdin/stdout |
| One bounded retry, when the adapter asks for it | Deciding whether re-issuing this call is safe |
| Progress notifications while a run is in flight, and the request's cancellation policy | Checking `ctx.signal` between stages of a pipeline |
| Answering `local` tools in-process, without a spawn or a feed entry | Declaring a tool `local` when it reads something the runtime already has |

## 1. `units/<unit>/models.js`

Plain ESM, zero deps. It owns the ids that may ever reach a spawn.

```js
export const ACME_MODELS = [
  {
    id: 'acme-2-fast',          // the EXACT string the CLI accepts
    label: 'Acme 2 Fast',
    family: 'acme',
    effort: 'medium',
    tier: 'fast',
    useFor: 'Lookups, short summaries, single-file questions.',
    avoid: 'Multi-file work, long inputs, fact-critical claims.',
  },
];

export const EFFORTS = ['low', 'medium', 'high'];   // omit if effort is baked into the id
export const ALLOWLIST = ACME_MODELS.map((m) => m.id);
export const GUIDE =
  'Pick by task, not by name. acme-2-fast = cheap sweeps … ' +
  'Omit `model` to keep the fleet default.';
```

`GUIDE` rides in **every** `tools/list` payload — keep it to a paragraph. Record in the file header which CLI version you verified the ids against, on what date, and how. See [ARCHITECTURE.md](ARCHITECTURE.md#how-catalogs-are-curated) for the curation rules.

## 2. `units/<unit>/adapter.mjs`

The whole minimal unit:

```js
import { defineUnit } from '../../core/unit.mjs';
import { makeCatalog } from '../../core/catalog.mjs';
import { ACME_MODELS, EFFORTS, GUIDE } from './models.js';

export const catalog = makeCatalog({ models: ACME_MODELS, efforts: EFFORTS, guide: GUIDE, title: 'ACME MODEL CATALOG' });

const READONLY_PREFIX =
  'You are a read-only research assistant. Do NOT modify files, run git, ' +
  'deploy, or publish. Answer in plain text.\n\n';

/** Build the argv for one run. Exported so a test can assert the flags. */
export function buildArgs({ model, effort }) {
  const args = ['--headless', '--read-only', '--output-format', 'json'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

/** Turn a finished run into text, or throw a clear error. Exported for tests. */
export function interpretAcme(res, { timeoutS }) {
  // One parser for both paths: what a finished run returns is also what a
  // killed run salvages — a second parser for the failure path is how they drift.
  const answer = (() => { try { return (JSON.parse(res.stdout || '{}').text || '').trim(); } catch { return ''; } })();
  if (res.killed) {
    if (answer) return { text: `${answer}\n\n[acme: hard-killed after ${timeoutS}s — treat the answer as partial; raise acme.timeoutS in the fleet config]`, partial: true };
    throw new Error(`acme hard-killed after ${timeoutS}s with no output (raise acme.timeoutS in the fleet config)`);
  }
  if (!answer) throw new Error(`acme exited ${res.code}: ${res.stderr.trim().slice(-500) || '(no stderr)'}`);
  return answer;
}

const isDeterministic = (e) => /not authenticated|hard-killed|not found in PATH/i.test((e && e.message) || '');

export default defineUnit({
  name: 'acme',
  label: 'Acme',
  bin: { env: 'ACME_BIN', default: 'acme' },
  billingRiskEnv: ['ACME_API_KEY'],
  envPassthrough: ['ACME_*'],   // the vendor's own knobs; the scrub above runs after this
  envMap: { model: 'ACME_DEFAULT_MODEL', timeoutS: 'ACME_TIMEOUT_S' },
  builtin: { timeoutS: 300 },
  supportedModes: { 'read-only': true, 'workspace-write': null },
  auth: { detect: (stderr) => /not signed in/i.test(stderr), help: 'Acme CLI is not authenticated — run `acme login`, then retry.' },
  catalog,
  tools: [
    {
      name: 'acme_research',
      kind: 'research',
      mutateGate: true,
      description: 'Delegate research to Acme. READ-ONLY. ' + GUIDE,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The research question.' },
          model: { type: 'string', enum: catalog.modelEnum(), description: 'Optional. OMIT for the fleet default. ' + GUIDE },
          effort: { type: 'string', enum: catalog.effortEnum(), description: 'Optional reasoning effort.' },
        },
        required: ['prompt'],
      },
      async run(args, ctx) {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return { text: 'Error: "prompt" is required.', isError: true };
        return ctx.retry(async () => {
          const res = await ctx.spawn({ args: [...buildArgs({ model: ctx.model, effort: ctx.effort }), '-p', READONLY_PREFIX + prompt] });
          return interpretAcme(res, { timeoutS: ctx.cfg.timeoutS });
        }, { skipIf: isDeterministic });
      },
    },
    {
      name: 'acme_models',
      kind: 'catalog',
      description: 'List the Acme models and a route-to / route-away cheat-sheet. No arguments, no spawn.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
});
```

`ctx` gives you `{ cfg, mode, model, effort, spawn, retry, log, catalog, home, signal }`. `spawn(o)` accepts `{ args, cwd, stdinText, extraEnv, hardKillMs, outputCap }` and resolves `{ stdout, stderr, code, signal, killed, capped }` — it does **not** reject on a non-zero exit, because only you know what an exit code means for this CLI. Both bounds default to the unit's config (`timeoutS`, `outputCap`) and a call may override either. A refusal you make yourself returns `{ text, isError: true }`; returning an `Error: …` string without the flag reports a failure to MCP as a success. `{ text, partial: true }` is the third shape: an answer the run did not finish — a success, with the flag carried into the status feed. There are three reasons to set it: a hard kill whose captured text you kept, output that hit `outputCap`, and — for a pipeline tool — a stage whose own answer came back partial (`gemini_deep_research` states the count in the report and passes the flag out).

**Where the run happens.** `spawn`'s `cwd` is the directory the vendor process runs in, and the three research tools take an optional one from the caller: an ABSOLUTE path that must exist and be a directory, validated before any spawn with the wording the review tools use — `Error: "cwd" must be an absolute path (got …)` and `Error: "cwd" is not an existing directory: …`. Pass it to the CLI as well where the CLI has a flag for it (grok `--cwd`, codex `-C`; agy has none and takes the spawn cwd alone), and leave the sandbox alone: `codex_research` is `-s read-only` with a `cwd` exactly as it is without one. Omitted, the run happens in the server's own process cwd, which is what it always did. The runtime writes the value onto the spooled record's `cwd:` header, so an answer can be read back knowing where it was produced — which is how `doctor --probe-sandbox` gets a unit to run in a throwaway directory without the CLI process ever changing its own.

### Handle `capped`

`capped: true` means the tail cap dropped characters, and what it drops is the **beginning** of stdout: your parser is reading a fragment. Say so rather than returning it as a whole answer — append a marker to the text and return `partial: true`. Then decide what the truncation cost you. If your CLI's answer arrives as one final object and the cap cut into that object, there is no answer left to hand back — throw an error naming the config key instead of failing open with a fragment (the Grok unit's `[grok: output capped at <N> chars …]` marker and its `raise grok.outputCap or narrow the task` error are the worked example, in `units/grok/adapter.mjs`). If your run was hard-killed as well, answer the kill first: salvaged text is still an answer, and the cap note rides along with it.

All three shipped units read `capped` since 0.3.3, and the three shapes cover most CLIs you will meet: Grok's line-per-event NDJSON (whole lines survive, or the final `result` line is cut open), Codex's line-per-item JSONL (the answer is the last `agent_message`, present or gone), and agy's single JSON envelope (it parses, or it does not — and a capped envelope that no longer parses is the case where failing open would return the middle of an object as prose). Copy whichever matches your CLI.

One exception worth stating, because it looks like a missing marker: **an image tool answers with a bare path by contract.** All four — `gemini_image`, `grok_image`, `grok_image_edit`, `codex_image` — return the file they verified on disk and nothing else. When the run was capped, hard-killed or cancelled and the artifact is there anyway, the path still comes back bare: `partial: true` carries the incompleteness to the status feed and the spooled record, and no marker is stapled to a string the caller is expected to `stat`. When there is no artifact the tool fails — with the interpreter's own error where the run produced nothing to read at all, and otherwise with a message naming the bound that explains it (`core/artifact.mjs`'s `artifactMiss`: `raise <unit>.outputCap`, `raise <unit>.timeoutS`, or the client's own cancellation). `codex_image` goes one step further, because it has a file to look at: an `image.png` already saved outranks even an interpreter that refused the run. Anything a caller is expected to `stat` must stay a path.

Export `buildArgs` and the result interpreter. Everything worth testing about an adapter lives in those two pure functions.

### The `local` kind

A tool whose answer needs no vendor CLI is `kind: 'local'`. It still gets
`run(args, ctx)`, but with a reduced context — `{ cfg, mode, log, catalog, home }`,
no `spawn`, no `retry` — because a local tool that spawns is not local. The
runtime answers it directly: it is never tracked by the status feed, never
spooled, and (like a `catalog` read) it still answers while the unit is
`enabled: false`, since what it serves was produced before someone switched the
unit off. Use it for reading back something the fleet already has; use a normal
kind for anything that talks to the vendor.

### Progress and cancellation

Both are the runtime's job, and an adapter only has to stay out of the way.

**Progress.** While a call runs, the runtime sends
`notifications/progress` every 30 seconds to a client that supplied a
`progressToken`, carrying elapsed seconds and one short line. Nothing is sent
without a token and nothing after the response. This is not decoration: a stdio
tool call that sends neither a response nor a progress notification for 30
minutes is aborted for idleness by the client, whatever its wall-clock timeout
says.

**Cancellation.** When the client withdraws a request, the unit's `cancel`
config decides what happens (see [CONFIG.md](CONFIG.md#cancellation)). Under
`kill` the runtime passes an `AbortSignal` down: `ctx.spawn` SIGKILLs the
process group the moment it fires, `ctx.retry` abandons a pending delay, and the
run's result carries `cancelled: true` next to `killed: true`. Under `finish`
nothing is passed down at all and the run ends normally.

What an adapter owns is the space *between* spawns. A pipeline that runs several
stages should check `ctx.signal` before starting the next one:

```js
if (ctx.signal && ctx.signal.aborted) return partialReport;   // undefined under `cancel: finish`
```

Always guard the property access: `ctx.signal` is `undefined` unless the unit is
in `kill` mode. A single-spawn tool needs no check — the spawn itself is already
bound to the signal.

### Prefer a streaming output format

The example above asks for `--output-format json` because it is the shortest thing to write. **If the CLI offers a streaming format, take it instead**, and pick it for the same reason the Grok unit did in 0.3.1.

A hard kill only salvages what the CLI has already written to stdout. A whole-document JSON format has written nothing at that point: it buffers the run and prints one object at the end. Measured on the Grok CLI, 2026-09-06 — `--output-format json` had produced **0 bytes at 20 s** on a question that had visible text in plain mode by 16 s. The salvage path was correct, tested, and had nothing to work with on precisely the runs it exists for. Switching to `--output-format streaming-messages-json --include-partial-messages` — NDJSON, one object per line, written as the answer is produced — left 441 text deltas and 1513 characters recoverable from a 30 s kill.

What that costs you is a line parser instead of one `JSON.parse`, and it comes with three rules worth stating:

- **Still one parser for both paths.** Assemble the answer from the incremental events; when the run finished and the stream carries a final whole message, that message's text wins — it is authoritative, and it is what a complete run should return. A killed run simply never reaches that line and keeps the assembled deltas. Two parsers, one for "finished" and one for "killed", is how the two answers drift apart.
- **Skip the deltas that are not the answer.** Reasoning/thinking deltas and tool-argument fragments arrive on the same stream and must never end up in the text.
- **Tolerate a truncated last line.** A SIGKILL lands mid-write, so the final line is routinely half a JSON object. Skip unparseable lines rather than failing the salvage.

Take usage counts off the stream while you are there, merging across the lines that carry them: a final event reporting only output tokens must not erase the input count an earlier one gave. That is how Grok started reporting `usage` at all.

## 3. `servers/<unit>.mjs`

```js
#!/usr/bin/env node
import { startUnit } from '../core/unit.mjs';
import unit from '../units/acme/adapter.mjs';

startUnit(unit);
```

Register it with `claude mcp add -s user <prefix>-acme -- node /abs/path/servers/acme.mjs`, or add the unit to the CLI's install list. Drive it by hand with `node scripts/mcp-call.mjs servers/acme.mjs acme_models '{}'` — the low-level entry point, which takes a server path rather than a unit name and therefore works before the unit is wired into the CLI. Once it is, `omelette-fleet call acme acme_models '{}'` does the same through `core/client.mjs`. Both keep stdin open until the call answers, and that is on the client's side of the bargain: on stdin EOF a server stops reading, lets the calls already in flight finish (each bounded by that unit's `timeoutS`), flushes stdout and exits. The answer is written, but a `printf | node server` pipeline has usually gone away by then — the response has to be read before the client closes.

## 4. `test/<unit>.test.mjs` — the fake-binary pattern

No vendor CLI is needed to test a unit end to end. Point the binary at `process.execPath` and let a throwaway script play the CLI.

Pure functions first:

```js
import unit, { buildArgs, interpretAcme, catalog } from '../units/acme/adapter.mjs';

test('argv carries the read-only flags and no dangerous ones', () => {
  const a = buildArgs({ model: 'acme-2-fast', effort: 'high' });
  assert.ok(a.includes('--read-only'));
  assert.ok(!a.some((x) => /dangerously/.test(x)));
});
```

Then the whole runtime, against a fake binary:

```js
const dir = mkdtempSync(join(tmpdir(), 'omelette-acme-'));
// A fake CLI that echoes back the argv it received.
const fake = join(dir, 'fake-acme.mjs');
writeFileSync(fake, 'process.stdout.write(JSON.stringify({text:"flags="+process.argv.slice(2).join(" ")}))');
writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { acme: { timeoutS: 30 } } }));

const env = { ...process.env, OMELETTE_HOME: dir, ACME_BIN: process.execPath };
// ACME_BIN is `node`, so prepend the fake script to every argv.
const rt = createUnitRuntime(
  { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
  { env },
);

const r = await rt.callTool('acme_research', { prompt: 'hello there' });
assert.match(r.text, /--read-only/);
```

Three things that pattern buys you: `OMELETTE_HOME` in a temp dir means the test writes its own config and reads its own status feed; `createUnitRuntime` runs the full call path (config → ceiling → validation → gate → spawn → status) without stdin/stdout; and the fake CLI can assert on the exact flags it received — which is how the read-only posture stays tested rather than asserted. Set `OMELETTE_ALLOW_WRITE` in the test env to exercise the open-ceiling path, and leave it out to prove the closed one.

Remember that the *child* env is an allowlist, not the test's env: a variable you set in `env` reaches the fake CLI only if it is in `ALLOWED_ENV` or matches the unit's `envPassthrough`. That is exactly what makes "this key never reaches the child" testable — have the fake print `process.env.ACME_API_KEY` and assert `undefined`.

Also worth a test each: an unknown model is rejected before any spawn, a disabled unit refuses spawning tools but still serves its catalog, a missing binary produces the actionable message, the auth regex fires only on an empty-stdout run, and a refusal comes back with `isError`.

## Checklist

- [ ] **`billingRiskEnv`** — list every environment variable that could switch this CLI from the subscription to metered API billing. Check the vendor's precedence rules; the failure mode is silent and costs real money.
- [ ] **`envPassthrough` as narrow as the CLI allows.** Start from nothing and add only what a real run needs; the child gets `ALLOWED_ENV` and your patterns and nothing else. A `PREFIX_*` pattern is safe against its own API key (the scrub runs after it) but not against anything else that shares the prefix.
- [ ] **Decide about the vendor's config file.** If it can carry executable behaviour — MCP servers, hooks, plugins, a notify command — a filesystem sandbox does not bound it. Ignore it if the CLI has a flag for that (Codex: `--ignore-user-config --ignore-rules`), and then pin the model explicitly, because "the vendor default" now lives in a file you are ignoring.
- [ ] **Auth detection** — a regex on stderr plus a `help` string that names the exact command to run. The runtime only checks it on runs with **empty stdout**, so a real answer that mentions signing in cannot false-positive. Make sure `isDeterministic` treats an auth failure as unretryable.
- [ ] **`supportedModes` honesty** — declare `workspace-write: null` unless the unit actually implements a mode you would defend in [SECURITY.md](SECURITY.md). A unit that declares it and then relies on a prompt to stay read-only is worse than one that refuses. If you do implement it, say precisely what scopes the write, and prefer granting it to one tool with an explicit `cwd`.
- [ ] **Retry only when re-issuing is safe.** `ctx.retry` re-runs on empty output. That is fine for a read-only one-shot; it is not fine for anything that spends metered quota per call (image generation), anything that may already have written, or a deterministic failure. Pass `skipIf` for auth, quota, hard-kill, missing-binary and CLI-error cases.
- [ ] **Fail loudly, never blankly.** An empty answer with a talkative stderr is a bug report, not a shrug — surface the stderr. A run that produced text but exited non-zero, stopped early, or was hard-killed keeps the text and appends a marker (`[<unit>: CLI exited N — treat the answer as partial]`, `[<unit>: hard-killed after <N>s — … raise <unit>.timeoutS …]`); only a text-less failure throws. A salvaged kill also returns `partial: true`, which the runtime puts in the status feed's `end` event while the status stays `"ok"`. Extract that text with the SAME parsing the success path uses — a second parser for the failure path is how the two drift. Refusals you handle yourself return `isError: true`.
- [ ] **Choose a streaming output format over a whole-document one** where the CLI has both. A format that writes nothing until the run ends leaves the hard-kill salvage above with nothing to salvage — measured, not assumed. See [Prefer a streaming output format](#prefer-a-streaming-output-format).
- [ ] **stdout is JSON-RPC only.** Log through `ctx.log`.
- [ ] **`mutateGate`** on prompt-driven research tools; leave it off where git-reading is a legitimate ask, and off for image prompts.
- [ ] **Add the unit to the CLI's install list** and to `doctor`, so a missing CLI is skipped rather than registered broken.
