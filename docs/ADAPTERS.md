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

`ctx` gives you `{ cfg, mode, model, effort, spawn, retry, log, catalog, home }`. `spawn(o)` accepts `{ args, cwd, stdinText, extraEnv, hardKillMs, outputCap }` and resolves `{ stdout, stderr, code, signal, killed }` — it does **not** reject on a non-zero exit, because only you know what an exit code means for this CLI. A refusal you make yourself returns `{ text, isError: true }`; returning an `Error: …` string without the flag reports a failure to MCP as a success. `{ text, partial: true }` is the third shape: an answer the run did not finish (today, a hard kill whose captured text was kept) — a success, with the flag carried into the status feed.

Export `buildArgs` and the result interpreter. Everything worth testing about an adapter lives in those two pure functions.

## 3. `servers/<unit>.mjs`

```js
#!/usr/bin/env node
import { startUnit } from '../core/unit.mjs';
import unit from '../units/acme/adapter.mjs';

startUnit(unit);
```

Register it with `claude mcp add -s user <prefix>-acme -- node /abs/path/servers/acme.mjs`, or add the unit to the CLI's install list. Drive it by hand with `node scripts/mcp-call.mjs servers/acme.mjs acme_models '{}'` — the low-level entry point, which takes a server path rather than a unit name and therefore works before the unit is wired into the CLI. Once it is, `omelette-fleet call acme acme_models '{}'` does the same through `core/client.mjs`. Both keep stdin open until the call answers, which a naive `printf | node server` does not (a server exits on stdin EOF by design).

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
- [ ] **stdout is JSON-RPC only.** Log through `ctx.log`.
- [ ] **`mutateGate`** on prompt-driven research tools; leave it off where git-reading is a legitimate ask, and off for image prompts.
- [ ] **Add the unit to the CLI's install list** and to `doctor`, so a missing CLI is skipped rather than registered broken.
