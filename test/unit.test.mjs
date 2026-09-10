import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineUnit, createUnitRuntime, boundedRetry, makeResultId, MUTATE_RE, PROGRESS_EVERY_MS, TOOL_KINDS } from '../core/unit.mjs';
import { makeCatalog } from '../core/catalog.mjs';
import { createHandler } from '../core/jsonrpc.mjs';
import { createResultStore, parseResult } from '../core/results.mjs';

const node = process.execPath;
const catalog = makeCatalog({
  models: [{ id: 'm-fast', useFor: 'speed', avoid: 'depth' }, { id: 'm-deep' }],
  efforts: ['low', 'high'],
  guide: 'pick by task',
  title: 'TEST CATALOG',
});

/** A unit whose "CLI" is node -e, so the whole runtime runs without any vendor tool. */
function fakeUnit(overrides = {}) {
  return defineUnit({
    name: 'fake',
    label: 'Fake',
    bin: { env: 'FAKE_BIN', default: node },
    billingRiskEnv: ['FAKE_API_KEY'],
    // The child env is an ALLOWLIST (core/spawn.mjs), so a unit that wants to see
    // its own vars must declare them — and the billing scrub still runs after.
    envPassthrough: ['FAKE_*'],
    envMap: { timeoutS: 'FAKE_TIMEOUT_S', model: 'FAKE_DEFAULT_MODEL' },
    supportedModes: { 'read-only': true, 'workspace-write': true },
    auth: { detect: (stderr) => /not signed in/i.test(stderr), help: 'run `fake login`' },
    catalog,
    tools: [
      {
        name: 'fake_research', kind: 'research', mutateGate: true,
        description: 'd', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
        async run(args, ctx) {
          const r = await ctx.spawn({ args: ['-e', `process.stdout.write(${JSON.stringify(`mode=${ctx.mode};model=${ctx.model};effort=${ctx.effort};key=` )} + String(process.env.FAKE_API_KEY) + ';secret=' + String(process.env.GH_TOKEN))`] });
          return { text: r.stdout, usage: { out: 1 } };
        },
      },
      {
        name: 'fake_auth', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run(_a, ctx) { const r = await ctx.spawn({ args: ['-e', 'process.stderr.write("Not signed in"); process.exit(1)'] }); return r.stdout; },
      },
      {
        name: 'fake_slow', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run(_a, ctx) { const r = await ctx.spawn({ args: ['-e', 'setTimeout(()=>{}, 20000)'] }); return r.killed ? 'killed' : 'finished'; },
      },
      {
        // A CLI that prints more than the cap allows: what the runtime hands
        // back is the TAIL, flagged, so the adapter can say the beginning is gone.
        name: 'fake_flood', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run(args, ctx) {
          const r = await ctx.spawn({
            args: ['-e', 'process.stdout.write("x".repeat(5000) + "END")'],
            ...(args.outputCap !== undefined ? { outputCap: args.outputCap } : {}),
          });
          return `len=${r.stdout.length};capped=${r.capped}`;
        },
      },
      {
        // An adapter that refuses the call itself (bad args), the way the real ones do.
        name: 'fake_refuse', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run() { return { text: 'Error: "prompt" is required.', isError: true }; },
      },
      {
        // A run that was hard-killed but had already produced text: an answer,
        // flagged, the way all three real adapters report a salvaged kill.
        name: 'fake_partial', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run() { return { text: 'half an answer\n\n[fake: hard-killed]', usage: { out: 2 }, partial: true }; },
      },
      {
        // A `local` tool: answered in-process, never spawned, never tracked.
        // NOT called `fake_result`: that name belongs to the tool the runtime
        // appends to every unit, and an adapter declaring it keeps its own.
        name: 'fake_local', kind: 'local', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run(_a, ctx) { return `local:${ctx.cfg.timeoutS}:${ctx.spawn === undefined ? 'no-spawn' : 'HAS-SPAWN'}`; },
      },
      {
        // An in-process wait: a call long enough to tick, with no child noise.
        name: 'fake_wait', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run(args) { await new Promise((r) => setTimeout(r, Number(args.ms) || 50)); return 'waited'; },
      },
      {
        // A real child that outlives a cancel unless the signal reaches it.
        name: 'fake_cancel', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run(_a, ctx) {
          const r = await ctx.spawn({ args: ['-e', 'setTimeout(() => process.stdout.write("done"), 800)'] });
          return `killed=${r.killed};cancelled=${r.cancelled}`;
        },
      },
      {
        name: 'fake_signal', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run(_a, ctx) { return `signal=${ctx.signal ? 'yes' : 'no'}`; },
      },
      { name: 'fake_models', kind: 'catalog', description: 'd', inputSchema: { type: 'object', properties: {} } },
    ],
    ...overrides,
  });
}

function env(config, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-unit-'));
  if (config) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(config));
  return { dir, env: { ...process.env, OMELETTE_HOME: dir, ...extra } };
}

const spoolDir = (dir) => join(dir, 'results', 'fake');
const spooled = (dir) => { try { return readdirSync(spoolDir(dir)).filter((n) => n.endsWith('.md')).sort(); } catch { return []; } };
const readSpooled = (dir, name) => parseResult(readFileSync(join(spoolDir(dir), name), 'utf8'));

test('defineUnit validates the contract loudly', () => {
  assert.throws(() => defineUnit({ name: 'Bad Name', bin: 'x', tools: [], catalog }), /name must match/);
  assert.throws(() => defineUnit({ name: 'x', bin: 'x', tools: [{ name: 't', description: 'd', inputSchema: {}, kind: 'nope' }], catalog }), /unknown kind/);
  assert.throws(() => defineUnit({ name: 'x', bin: 'x', tools: [{ name: 't', description: 'd', inputSchema: {}, kind: 'research' }], catalog }), /needs run/);
  const u = defineUnit({ name: 'x', bin: 'xbin', tools: [{ name: 't', description: 'd', inputSchema: {}, kind: 'catalog' }], catalog });
  assert.deepEqual(u.bin, { env: null, default: 'xbin' });
  assert.equal(u.serverName, 'omelette-x');
  // serverInfo.version is the PACKAGE version — not a number frozen into core/unit.mjs.
  assert.equal(u.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});

test('tools/list shape hides run/kind/mutateGate', () => {
  const rt = createUnitRuntime(fakeUnit(), env(null));
  for (const t of rt.tools) {
    assert.equal(t.run, undefined); assert.equal(t.kind, undefined); assert.equal(t.mutateGate, undefined);
    assert.ok(t.name && t.description && t.inputSchema);
  }
});

test('catalog tool answers locally with the rendered catalog', async () => {
  const rt = createUnitRuntime(fakeUnit(), env(null));
  const r = await rt.callTool('fake_models', {});
  assert.match(r.text, /TEST CATALOG/);
  assert.match(r.text, /m-fast/);
  assert.match(r.text, /EFFORT LEVELS/);
  assert.equal(r.isError, undefined);
});

test('a full research call: config model + effort reach ctx, the child env is an allowlist, usage lands in status', async () => {
  const { dir, env: e } = env({ units: { fake: { model: 'm-fast', effort: 'high' } } }, { FAKE_API_KEY: 'leak', GH_TOKEN: 'ghp_leak' });
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const r = await rt.callTool('fake_research', { prompt: 'what is up' });
  assert.equal(r.isError, undefined);
  // key: passed the unit's envPassthrough, then deleted by the billing scrub.
  // secret: never on the allowlist at all — a read-only run cannot read GH_TOKEN.
  assert.equal(r.text, 'mode=read-only;model=m-fast;effort=high;key=undefined;secret=undefined');
  const snap = JSON.parse(readFileSync(join(dir, 'status-fake.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'ok');
  assert.deepEqual(snap.lastEvent.usage, { out: 1 });
});

test('explicit model arg is validated hard; an invalid configured default is ignored', async () => {
  const rt = createUnitRuntime(fakeUnit(), env({ units: { fake: { model: 'm-gone' } } }));
  const bad = await rt.callTool('fake_research', { prompt: 'x', model: 'm-nope' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /unknown model "m-nope"/);
  const ok = await rt.callTool('fake_research', { prompt: 'x' });
  assert.match(ok.text, /model=;/);
  const eff = await rt.callTool('fake_research', { prompt: 'x', effort: 'xhigh' });
  assert.match(eff.text, /unknown effort "xhigh"/);
});

test('mutate gate blocks git/deploy intent on gated tools only', async () => {
  const rt = createUnitRuntime(fakeUnit(), env(null));
  const r = await rt.callTool('fake_research', { prompt: 'please git push this' });
  assert.equal(r.isError, true);
  assert.match(r.text, /cannot run git/);
  assert.ok(MUTATE_RE.test('npm publish now'));
  assert.ok(!MUTATE_RE.test('read the git log'));
});

test('disabled unit refuses every spawning call but still serves its catalog', async () => {
  const rt = createUnitRuntime(fakeUnit(), env({ units: { fake: { enabled: false } } }));
  const r = await rt.callTool('fake_research', { prompt: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /disabled in the fleet config/);
  assert.equal((await rt.callTool('fake_models', {})).isError, undefined);
});

test('CEILING end-to-end: workspace-write reaches ctx only with the env key', async () => {
  const cfg = { units: { fake: { mode: 'workspace-write' } } };
  const closed = createUnitRuntime(fakeUnit(), env(cfg));
  assert.match((await closed.callTool('fake_research', { prompt: 'x' })).text, /mode=read-only/);
  const open = createUnitRuntime(fakeUnit(), env(cfg, { OMELETTE_ALLOW_WRITE: 'fake' }));
  assert.match((await open.callTool('fake_research', { prompt: 'x' })).text, /mode=workspace-write/);
});

test('auth failure on an empty run becomes the actionable help text', async () => {
  const rt = createUnitRuntime(fakeUnit(), env(null));
  const r = await rt.callTool('fake_auth', {});
  assert.equal(r.isError, true);
  assert.match(r.text, /run `fake login`/);
});

test('timeout from config hard-kills the child', async () => {
  const rt = createUnitRuntime(fakeUnit(), env({ units: { fake: { timeoutS: 1 } } }));
  const r = await rt.callTool('fake_slow', {});
  assert.equal(r.text, 'killed');
});

test('outputCap comes from the config, and a call may override it', async () => {
  const wide = createUnitRuntime(fakeUnit(), env(null));
  assert.equal((await wide.callTool('fake_flood', {})).text, 'len=5003;capped=false', 'the 400 000 default is nowhere near');
  const narrow = createUnitRuntime(fakeUnit(), env({ units: { fake: { outputCap: 100 } } }));
  assert.equal((await narrow.callTool('fake_flood', {})).text, 'len=100;capped=true');
  // A call that knows better than the config (a pipeline stage, say) wins over it.
  assert.equal((await narrow.callTool('fake_flood', { outputCap: 50 })).text, 'len=50;capped=true');
  // …but it cannot switch the cap OFF: `slice(-0)` keeps the whole string, so a
  // 0 from an adapter would silently uncap stdout. Clamped to one character.
  assert.equal((await narrow.callTool('fake_flood', { outputCap: 0 })).text, 'len=1;capped=true');
  assert.equal((await narrow.callTool('fake_flood', { outputCap: -5 })).text, 'len=1;capped=true');
  // A value that is not a number at all falls back to the unit's config.
  assert.equal((await narrow.callTool('fake_flood', { outputCap: 'lots' })).text, 'len=100;capped=true');
});

test('unknown tool and missing binary are clean errors', async () => {
  const rt = createUnitRuntime(fakeUnit(), env(null, { FAKE_BIN: 'omelette-missing-bin-xyz' }));
  assert.match((await rt.callTool('nope', {})).text, /unknown tool/);
  const r = await rt.callTool('fake_research', { prompt: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /not found in PATH — install the Fake CLI or point FAKE_BIN/);
});

test('boundedRetry retries once on empty output and skips deterministic failures', async () => {
  let n = 0;
  const r = await boundedRetry(async () => { n++; return n === 1 ? '' : 'second'; }, { delayMs: 1 });
  assert.equal(r, 'second');
  assert.equal(n, 2);
  let m = 0;
  await assert.rejects(boundedRetry(async () => { m++; throw new Error('quota exhausted'); }, { skipIf: (e) => /quota/.test(e.message), delayMs: 1 }));
  assert.equal(m, 1);
});

test('an adapter that refuses the call surfaces isError and records "error" in the status feed', async () => {
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const r = await rt.callTool('fake_refuse', {});
  assert.equal(r.isError, true);
  assert.match(r.text, /"prompt" is required/);
  const snap = JSON.parse(readFileSync(join(dir, 'status-fake.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'error');
  assert.match(snap.lastEvent.error, /"prompt" is required/);
});

test('a partial result is a successful answer that says so: status ok, isError false, partial in the feed', async () => {
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const r = await rt.callTool('fake_partial', {});
  assert.equal(r.isError, undefined, 'a hard-killed run that produced text is not an MCP error');
  assert.match(r.text, /^half an answer/);
  const snap = JSON.parse(readFileSync(join(dir, 'status-fake.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'ok');
  assert.equal(snap.lastEvent.partial, true);
  assert.deepEqual(snap.lastEvent.usage, { out: 2 }, 'usage and partial travel together');
  const line = readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).at(-1);
  assert.equal(line.event, 'end');
  assert.equal(line.partial, true);
  // …and a normal answer carries no `partial` key at all.
  const plain = createUnitRuntime(fakeUnit(), { env: e });
  await plain.callTool('fake_refuse', {});
  assert.equal('partial' in JSON.parse(readFileSync(join(dir, 'status-fake.json'), 'utf8')).lastEvent, false);
});

test('defineUnit keeps an `instructions` line and defaults it to empty', () => {
  assert.equal(fakeUnit().instructions, '');
  assert.equal(fakeUnit({ instructions: 'This unit: Fake.' }).instructions, 'This unit: Fake.');
});

// --- the `local` kind and the result id -------------------------------------

test('defineUnit knows the `local` kind and still demands a run() for it', () => {
  assert.ok(TOOL_KINDS.has('local'));
  assert.throws(
    () => defineUnit({ name: 'x', bin: 'x', catalog, tools: [{ name: 't', description: 'd', inputSchema: {}, kind: 'local' }] }),
    /needs run/,
  );
  const u = defineUnit({ name: 'x', bin: 'x', catalog, tools: [{ name: 't', description: 'd', inputSchema: {}, kind: 'local', run: () => 'x' }] });
  assert.equal(u.tools[0].kind, 'local');
});

test('a `local` tool is answered in-process: no spawn in its ctx, no feed entry, and it answers while the unit is disabled', async () => {
  const { dir, env: e } = env({ units: { fake: { enabled: false, timeoutS: 42 } } });
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const r = await rt.callTool('fake_local', {});
  assert.equal(r.isError, undefined);
  assert.equal(r.text, 'local:42:no-spawn');
  // Never tracked: the feed only ever hears from tools that spawn a CLI.
  assert.equal(existsSync(join(dir, 'fleet-log.ndjson')), false);
  const snap = JSON.parse(readFileSync(join(dir, 'status-fake.json'), 'utf8'));
  assert.deepEqual(snap.active, []);
  assert.equal(snap.lastEvent, null);
  // …while the spawning tools of the same disabled unit still refuse.
  assert.match((await rt.callTool('fake_research', { prompt: 'x' })).text, /disabled in the fleet config/);
});

test('makeResultId: a sortable <stamp>-<pid>-<seq>, and the runtime counts its own', async () => {
  assert.equal(makeResultId(1, new Date('2026-09-08T14:25:01.123Z')), `20260908T142501Z-${process.pid}-1`);
  assert.match(makeResultId(7), /^\d{8}T\d{6}Z-\d+-\d+$/); // P2's RESULT_ID_RE
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  await rt.callTool('fake_wait', { ms: 1 });
  await rt.callTool('fake_wait', { ms: 1 });
  const lines = readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ids = lines.filter((l) => l.event === 'start').map((l) => l.resultId);
  assert.equal(ids.length, 2);
  assert.match(ids[0], /-1$/);
  assert.match(ids[1], /-2$/);
  assert.notEqual(ids[0], ids[1]);
  const snap = JSON.parse(readFileSync(join(dir, 'status-fake.json'), 'utf8'));
  assert.equal(snap.lastEvent.resultId, ids[1], 'the same id closes the pair');
});

// --- progress ---------------------------------------------------------------

test('progress: only with a token, every progressEveryMs, elapsed seconds, and nothing after the response', async () => {
  const notes = [];
  const rt = createUnitRuntime(fakeUnit(), { ...env(null), progressEveryMs: 20 });
  const call = {
    id: 1, progressToken: 'tok-1', signal: new AbortController().signal,
    notify: (m, p) => notes.push([m, p]),
  };
  const r = await rt.callTool('fake_wait', { ms: 130 }, call);
  assert.equal(r.text, 'waited');
  assert.ok(notes.length >= 3, `expected several progress notifications, got ${notes.length}`);
  assert.equal(notes[0][0], 'notifications/progress');
  assert.equal(notes[0][1].progressToken, 'tok-1');
  assert.equal(typeof notes[0][1].progress, 'number');
  assert.equal('total' in notes[0][1], false, 'the end of a vendor run is unknown by construction');
  assert.match(notes[0][1].message, /^fake fake_wait running · \d+s$/);
  const seen = notes.length;
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(notes.length, seen, 'the ticker is cleared when the call finishes');
  // No token: nothing is sent at all.
  const quiet = [];
  await rt.callTool('fake_wait', { ms: 80 }, { id: 2, progressToken: null, notify: (m, p) => quiet.push([m, p]) });
  assert.equal(quiet.length, 0);
  // And a call with no context at all is still a normal call.
  assert.equal((await rt.callTool('fake_wait', { ms: 1 })).text, 'waited');
  assert.equal(PROGRESS_EVERY_MS, 30000);
});

// --- cancellation and the result record -------------------------------------

test('cancel `finish` (the default): the run is left alone, the answer stands, the feed says detached', async () => {
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const c = new AbortController();
  const abort = setTimeout(() => c.abort(), 120);
  if (abort.unref) abort.unref();
  const r = await rt.callTool('fake_cancel', {}, { id: 1, signal: c.signal });
  assert.equal(r.text, 'killed=false;cancelled=false', 'the child ran to the end');
  const snap = JSON.parse(readFileSync(join(dir, 'status-fake.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'ok', 'the outcome is what the run produced');
  assert.equal(snap.lastEvent.detached, true, '…but nobody is listening any more');
  assert.ok(snap.lastEvent.resultId);
});

test('cancel `kill`: the signal reaches the spawn, the group is reaped, the feed says cancelled', async () => {
  const { dir, env: e } = env({ units: { fake: { cancel: 'kill' } } });
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const c = new AbortController();
  const abort = setTimeout(() => c.abort(), 120);
  if (abort.unref) abort.unref();
  const t0 = Date.now();
  const r = await rt.callTool('fake_cancel', {}, { id: 1, signal: c.signal });
  assert.equal(r.text, 'killed=true;cancelled=true');
  assert.ok(Date.now() - t0 < 700, 'the child died with the cancel instead of running its course');
  const snap = JSON.parse(readFileSync(join(dir, 'status-fake.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'cancelled');
  assert.equal('detached' in snap.lastEvent, false, 'a killed run was not left to finish');
});

test('the progress ticker stops the moment the request is cancelled, even under `cancel: finish`', async () => {
  const notes = [];
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e, progressEveryMs: 20 });
  const c = new AbortController();
  const abort = setTimeout(() => c.abort(), 60);
  if (abort.unref) abort.unref();
  const p = rt.callTool('fake_wait', { ms: 400 }, {
    id: 1, progressToken: 'tok', signal: c.signal, notify: (m, params) => notes.push([m, params]),
  });
  await new Promise((res) => setTimeout(res, 140));
  const atAbort = notes.length;
  assert.ok(atAbort >= 1, 'the ticker did run before the cancel');
  // Under `finish` the run is deliberately left to end — but its client is gone,
  // so it must stop being told about it.
  assert.equal((await p).text, 'waited');
  assert.equal(notes.length, atAbort, 'no progress is sent for a request the client dropped');
  const snap = JSON.parse(readFileSync(join(dir, 'status-fake.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'ok');
  assert.equal(snap.lastEvent.detached, true);
});

test('ctx.signal reaches an adapter only under `cancel: kill`', async () => {
  const c = new AbortController();
  const finishing = createUnitRuntime(fakeUnit(), env(null));
  assert.equal((await finishing.callTool('fake_signal', {}, { signal: c.signal })).text, 'signal=no');
  const killing = createUnitRuntime(fakeUnit(), env({ units: { fake: { cancel: 'kill' } } }));
  assert.equal((await killing.callTool('fake_signal', {}, { signal: c.signal })).text, 'signal=yes');
  // …and a call with no context at all never sees one either.
  assert.equal((await killing.callTool('fake_signal', {})).text, 'signal=no');
});

test('createUnitRuntime({ cancel }) overrides the configured policy for that runtime alone', async () => {
  // doctor's probe owns a deadline of its own, and a deadline that does not
  // reach the child is one the child outlives. It builds its runtime with
  // `kill` whatever the operator configured — and changes nothing for the
  // unit servers, which pass no `cancel` at all.
  const { dir, env: e } = env({ units: { fake: { cancel: 'finish' } } });
  const killing = createUnitRuntime(fakeUnit(), { env: e, cancel: 'kill' });
  const c = new AbortController();
  const abort = setTimeout(() => c.abort(), 120);
  if (abort.unref) abort.unref();
  const t0 = Date.now();
  const r = await killing.callTool('fake_cancel', {}, { id: 1, signal: c.signal });
  assert.equal(r.text, 'killed=true;cancelled=true', 'the config said finish; this runtime kills');
  assert.ok(Date.now() - t0 < 700, 'the child died with the cancel instead of running its course');
  const snap = JSON.parse(readFileSync(join(dir, 'status-fake.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'cancelled');
  // The adapter sees the signal it only ever gets under `kill`.
  assert.equal((await killing.callTool('fake_signal', {}, { signal: new AbortController().signal })).text, 'signal=yes');

  // …and the override goes both ways: a unit configured `kill` can be built to finish.
  const { env: e2 } = env({ units: { fake: { cancel: 'kill' } } });
  const finishing = createUnitRuntime(fakeUnit(), { env: e2, cancel: 'finish' });
  const c2 = new AbortController();
  const abort2 = setTimeout(() => c2.abort(), 120);
  if (abort2.unref) abort2.unref();
  assert.equal((await finishing.callTool('fake_cancel', {}, { id: 2, signal: c2.signal })).text, 'killed=false;cancelled=false');

  // Anything that is not one of the two values is not an override at all.
  const configured = createUnitRuntime(fakeUnit(), { env: e2, cancel: 'nonsense' });
  const c3 = new AbortController();
  const abort3 = setTimeout(() => c3.abort(), 120);
  if (abort3.unref) abort3.unref();
  assert.equal((await configured.callTool('fake_cancel', {}, { id: 3, signal: c3.signal })).text, 'killed=true;cancelled=true');
});

test('boundedRetry: an abort during the delay ends it and stops the retry instead of paying for a second run', async () => {
  const c = new AbortController();
  let n = 0;
  const abort = setTimeout(() => c.abort(), 30);
  if (abort.unref) abort.unref();
  const t0 = Date.now();
  await assert.rejects(boundedRetry(async () => { n++; return ''; }, { delayMs: 5000, signal: c.signal }), /cancelled/);
  assert.equal(n, 1, 'the second attempt never ran');
  assert.ok(Date.now() - t0 < 2000, 'the delay was cut short, not waited out');
  // An untouched signal changes nothing about the existing behaviour.
  let m = 0;
  const r = await boundedRetry(async () => { m++; return m === 1 ? '' : 'second'; }, { delayMs: 1, signal: new AbortController().signal });
  assert.equal(r, 'second');
  assert.equal(m, 2);
});

test('finish hands P2 the whole result record — once per finished spawn call, feed on or off', async () => {
  const records = [];
  const { env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e, onResult: (rec) => records.push(rec) });
  await rt.callTool('fake_research', { prompt: 'what is up', cwd: '/tmp/project' });
  assert.equal(records.length, 1);
  const rec = records[0];
  assert.deepEqual(Object.keys(rec).sort(), [
    'cwd', 'detached', 'durationMs', 'effort', 'endedAt', 'model', 'partial',
    'promptPreview', 'resultId', 'startedAt', 'status', 'text', 'tool', 'usage',
  ]);
  assert.equal(rec.tool, 'fake_research');
  assert.equal(rec.status, 'ok');
  assert.equal(rec.partial, false);
  assert.equal(rec.detached, false);
  assert.equal(rec.cwd, '/tmp/project');
  assert.equal(rec.promptPreview, 'what is up');
  assert.deepEqual(rec.usage, { out: 1 }, "the adapter's object, verbatim — the header decides what is writable");
  assert.match(rec.resultId, /^\d{8}T\d{6}Z-\d+-\d+$/);
  assert.match(rec.startedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(rec.endedAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(rec.durationMs >= 0);
  assert.match(rec.text, /^mode=read-only/);
  // Local and catalog tools are never spooled.
  await rt.callTool('fake_local', {});
  await rt.callTool('fake_models', {});
  assert.equal(records.length, 1);
  // A call refused before any spawn is still an answer someone may have lost.
  await rt.callTool('fake_research', { prompt: 'x', model: 'm-nope' });
  assert.equal(records.length, 2);
  assert.equal(records[1].status, 'error');
  assert.match(records[1].text, /unknown model "m-nope"/);
  assert.equal(records[1].cwd, '');
  assert.equal(records[1].usage, null, 'a refusal reported no tokens, and null is how it says so');
  // A partial answer says so, and the feed being OFF changes nothing here.
  const off = createUnitRuntime(fakeUnit(), { env: { ...e, OMELETTE_STATUS: '0' }, onResult: (rec2) => records.push(rec2) });
  await off.callTool('fake_partial', {});
  assert.equal(records.length, 3);
  assert.equal(records[2].partial, true);
  assert.equal(records[2].status, 'ok');
});

test('the reduced ctx of a `local` tool is exactly cfg, mode, log, catalog, home, usedModel — no signal, even under `cancel: kill`', async () => {
  let keys = null;
  const rt = createUnitRuntime(
    fakeUnit({
      tools: [
        {
          name: 'fake_keys', kind: 'local', description: 'd', inputSchema: { type: 'object', properties: {} },
          run: (_a, ctx) => { keys = Object.keys(ctx).sort().join(','); return 'ok'; },
        },
        { name: 'fake_models', kind: 'catalog', description: 'd', inputSchema: { type: 'object', properties: {} } },
      ],
    }),
    env({ units: { fake: { cancel: 'kill' } } }),
  );
  const c = new AbortController();
  c.abort();
  // A tool that never spawns has nothing to cancel, in either cancel mode.
  assert.equal((await rt.callTool('fake_keys', {}, { id: 1, signal: c.signal })).text, 'ok');
  // `usedModel` is present and is a no-op: an adapter helper shared with a
  // spawn tool may call it unconditionally, and a tool that never spawns
  // produces no record for it to reach.
  assert.equal(keys, 'catalog,cfg,home,log,mode,usedModel');
});

// ─── the result spool (P2) ───────────────────────────────────────────────────

test('every spawned answer is spooled BEFORE the response is sent, under the id the feed reports', async () => {
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const handle = createHandler({ serverInfo: { name: 'omelette-fake', version: '0' }, tools: rt.tools, callTool: rt.callTool });
  // `res` is the object serve() is ABOUT to write to stdout: nothing has been
  // sent yet, and the answer is already on disk.
  const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fake_research', arguments: { prompt: 'what is up' } } });
  const names = spooled(dir);
  assert.equal(names.length, 1);
  const { header, text } = readSpooled(dir, names[0]);
  assert.equal(header.unit, 'fake');
  assert.equal(header.tool, 'fake_research');
  assert.equal(header.status, 'ok');
  assert.equal(header.partial, false);
  assert.equal(header.detached, false);
  assert.equal(header.promptPreview, 'what is up');
  assert.ok(header.durationMs >= 0);
  assert.equal(text, res.result.content[0].text, 'the spooled text is the answer the client would have got');
  assert.equal(`${header.resultId}.md`, names[0]);
  const end = readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.resultId, header.resultId, 'the feed and the spool name the same run');
});

test('a partial answer is spooled as a partial ok', async () => {
  const { dir, env: e } = env(null);
  await createUnitRuntime(fakeUnit(), { env: e }).callTool('fake_partial', {});
  const h = readSpooled(dir, spooled(dir)[0]).header;
  assert.equal(h.status, 'ok');
  assert.equal(h.partial, true);
});

test('results: false writes nothing; the feed being off does not stop the spool', async () => {
  const off = env({ units: { fake: { results: false } } });
  await createUnitRuntime(fakeUnit(), { env: off.env }).callTool('fake_research', { prompt: 'x' });
  assert.deepEqual(spooled(off.dir), []);
  assert.equal(existsSync(join(off.dir, 'results')), false, 'not even the directory');

  const feedOff = env({ units: { fake: { status: false } } });
  await createUnitRuntime(fakeUnit(), { env: feedOff.env }).callTool('fake_research', { prompt: 'x' });
  assert.equal(spooled(feedOff.dir).length, 1, 'the spool is not the status feed');
  assert.equal(existsSync(join(feedOff.dir, 'status-fake.json')), false);
});

test('a refusal before the spawn is an answer too — spooled as an error; a catalog read never is', async () => {
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  assert.equal((await rt.callTool('fake_research', { prompt: 'x', model: 'm-nope' })).isError, true);
  assert.equal((await rt.callTool('fake_research', { prompt: 'please git push this' })).isError, true);
  await rt.callTool('fake_models', {});
  const names = spooled(dir);
  assert.equal(names.length, 2, 'two refusals, and not the catalog read');
  for (const n of names) assert.equal(readSpooled(dir, n).header.status, 'error');

  const disabled = env({ units: { fake: { enabled: false } } });
  const dis = createUnitRuntime(fakeUnit(), { env: disabled.env });
  assert.equal((await dis.callTool('fake_research', { prompt: 'x' })).isError, true);
  const one = spooled(disabled.dir);
  assert.equal(one.length, 1, 'a disabled unit still owes the caller an answer');
  assert.match(readSpooled(disabled.dir, one[0]).text, /disabled in the fleet config/);
  assert.equal(readSpooled(disabled.dir, one[0]).header.status, 'error');
});

test('a server prunes its spool at boot, so a lowered resultsKeep needs no call to take effect', () => {
  const { dir, env: e } = env({ units: { fake: { resultsKeep: 1 } } });
  const s = createResultStore({ home: dir, unit: 'fake' });
  for (let i = 1; i <= 3; i++) {
    s.write({ resultId: `20260908T142501Z-1-${i}`, tool: 'fake_research', status: 'ok', partial: false, detached: false,
      startedAt: '2026-09-08T14:25:01.000Z', endedAt: `2026-09-08T14:4${i}:00.000Z`, durationMs: 1, text: 'x' });
  }
  assert.equal(spooled(dir).length, 3);
  createUnitRuntime(fakeUnit(), { env: e });
  assert.deepEqual(spooled(dir), ['20260908T142501Z-1-3.md']);
});

test('every unit gets a <unit>_result tool: local, advertised once, never spooled', async () => {
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const names = rt.tools.map((t) => t.name);
  assert.equal(names.filter((n) => n === 'fake_result').length, 1);
  const t = rt.tools.find((x) => x.name === 'fake_result');
  assert.equal(t.kind, undefined, 'tools/list shape: no kind, no run');
  assert.equal(t.run, undefined);
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['id']);
  assert.equal(t.inputSchema.required, undefined, 'id is optional');
  const empty = await rt.callTool('fake_result', {});
  assert.equal(empty.isError, true);
  assert.match(empty.text, /result spool is empty/);
  assert.deepEqual(spooled(dir), [], 'a local tool is never spooled');
});

test('<unit>_result: no id gives the newest answer plus the last ten; an id gives that one', async () => {
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  await rt.callTool('fake_research', { prompt: 'first' });
  await rt.callTool('fake_research', { prompt: 'second' });
  const names = spooled(dir);
  assert.equal(names.length, 2);
  const newest = readSpooled(dir, names.at(-1)).header;
  assert.equal(newest.promptPreview, 'second');

  const r = await rt.callTool('fake_result', {});
  assert.equal(r.isError, undefined);
  assert.match(r.text, /^---\nunit: fake\n/);
  assert.ok(r.text.includes(`resultId: ${newest.resultId}`));
  const [body, listing] = r.text.split('\n\nRecent results:\n');
  assert.ok(body.endsWith(readSpooled(dir, names.at(-1)).text), 'the whole answer, verbatim');
  const lines = listing.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp(`^${newest.resultId}  fake_research  ok  \\d+ms  20\\d\\d-`));

  const one = await rt.callTool('fake_result', { id: newest.resultId });
  assert.equal(one.isError, undefined);
  assert.ok(one.text.includes(`resultId: ${newest.resultId}`));
  assert.doesNotMatch(one.text, /Recent results:/);
  // A blank id means "the newest", not "a broken id".
  assert.equal((await rt.callTool('fake_result', { id: '   ' })).isError, undefined);
});

test('<unit>_result refuses a bad id before it builds a path, in one line', async () => {
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  await rt.callTool('fake_research', { prompt: 'x' });
  for (const id of ['../../../etc/passwd', 'nope', '20260908T142501Z-1', '20260908T142501Z-1-1/../x', 42]) {
    const r = await rt.callTool('fake_result', { id });
    assert.equal(r.isError, true, JSON.stringify(id));
    assert.equal(r.text.split('\n').length, 1, 'one line');
    assert.match(r.text, /is not a result id/);
  }
  const gone = await rt.callTool('fake_result', { id: '20260101T000000Z-1-1' });
  assert.equal(gone.isError, true);
  assert.match(gone.text, /no spooled result/);
  assert.equal(spooled(dir).length, 1, 'and none of that was spooled');
});

test('the spool is still readable with results: false — the switch stops writing, not fetching', async () => {
  const { dir, env: e } = env(null);
  await createUnitRuntime(fakeUnit(), { env: e }).callTool('fake_research', { prompt: 'x' });
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { fake: { results: false } } }));
  const r = await createUnitRuntime(fakeUnit(), { env: e }).callTool('fake_result', {});
  assert.equal(r.isError, undefined);
  assert.match(r.text, /^---\nunit: fake\n/);
});

test('an adapter that declares its own <unit>_result keeps it', () => {
  const base = fakeUnit();
  const own = fakeUnit({
    tools: [...base.tools, { name: 'fake_result', kind: 'catalog', description: 'mine', inputSchema: { type: 'object', properties: {} } }],
  });
  const rt = createUnitRuntime(own, env(null));
  const found = rt.tools.filter((x) => x.name === 'fake_result');
  assert.equal(found.length, 1);
  assert.equal(found[0].description, 'mine');
});

// ─── the model a result is filed under (P3 · spec 3a) ─────────────────────────

/** The fake unit plus one tool that reports the model it pinned itself. */
const pinningUnit = (id) => fakeUnit({
  tools: [
    ...fakeUnit().tools,
    {
      name: 'fake_pin', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
      run(_a, ctx) { ctx.usedModel(id); return `pinned=${id};ctx.model=${ctx.model}`; },
    },
  ],
});

/** The fake unit plus one tool that runs `body(ctx)` and answers 'ok'. */
const reportingUnit = (name, body) => fakeUnit({
  tools: [
    ...fakeUnit().tools,
    { name, kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} }, run(_a, ctx) { body(ctx); return 'ok'; } },
  ],
});

test('the spooled model: the explicit one, the configured one, the one the adapter pinned, else the vendor default', async () => {
  // Nothing anywhere. The header says so IN WORDS: an empty `model:` line told
  // a reader nothing, and these are exactly the runs whose model nobody could
  // name afterwards.
  const plain = env(null);
  await createUnitRuntime(fakeUnit(), { env: plain.env }).callTool('fake_research', { prompt: 'x' });
  assert.equal(readSpooled(plain.dir, spooled(plain.dir)[0]).header.model, '(vendor default)');

  // An explicit argument.
  const explicit = env(null);
  await createUnitRuntime(fakeUnit(), { env: explicit.env }).callTool('fake_research', { prompt: 'x', model: 'm-deep' });
  assert.equal(readSpooled(explicit.dir, spooled(explicit.dir)[0]).header.model, 'm-deep');

  // A configured default the catalog accepts.
  const configured = env({ units: { fake: { model: 'm-fast' } } });
  await createUnitRuntime(fakeUnit(), { env: configured.env }).callTool('fake_research', { prompt: 'x' });
  assert.equal(readSpooled(configured.dir, spooled(configured.dir)[0]).header.model, 'm-fast');

  // Nothing configured and the adapter pinned one itself — codex's case.
  const pinned = env(null);
  const r = await createUnitRuntime(pinningUnit('m-deep'), { env: pinned.env }).callTool('fake_pin', {});
  assert.equal(r.isError, undefined, r.text);
  assert.equal(r.text, 'pinned=m-deep;ctx.model=', 'a report never changes ctx.model');
  assert.equal(readSpooled(pinned.dir, spooled(pinned.dir)[0]).header.model, 'm-deep');
});

test('usedModel is a report, not an override: the caller wins, the first call wins, and junk is not a report', async () => {
  // An explicit model is what the caller asked for; an adapter cannot rename it.
  const over = env(null);
  const r = await createUnitRuntime(pinningUnit('m-deep'), { env: over.env }).callTool('fake_pin', { model: 'm-fast' });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(readSpooled(over.dir, spooled(over.dir)[0]).header.model, 'm-fast');

  // Idempotent: a retried run reports twice, and one call cannot end up with
  // two different answers about which model it used.
  const twice = env(null);
  await createUnitRuntime(reportingUnit('fake_twice', (ctx) => {
    ctx.usedModel('m-fast'); ctx.usedModel('m-deep'); ctx.usedModel('m-deep');
  }), { env: twice.env }).callTool('fake_twice', {});
  assert.equal(readSpooled(twice.dir, spooled(twice.dir)[0]).header.model, 'm-fast');

  // Anything that is not a non-empty string is not a report.
  const junk = env(null);
  await createUnitRuntime(reportingUnit('fake_junk', (ctx) => {
    for (const bad of ['', '   ', null, undefined, 42, { id: 'm-deep' }, ['m-deep'], () => 'm-deep']) ctx.usedModel(bad);
  }), { env: junk.env }).callTool('fake_junk', {});
  assert.equal(readSpooled(junk.dir, spooled(junk.dir)[0]).header.model, '(vendor default)');

  // A report is a FACT about the run, not a request: it is NOT checked against
  // the catalog. The id the CLI was actually told is the id worth filing.
  const unlisted = env(null);
  await createUnitRuntime(pinningUnit('m-unlisted-9'), { env: unlisted.env }).callTool('fake_pin', {});
  assert.equal(readSpooled(unlisted.dir, spooled(unlisted.dir)[0]).header.model, 'm-unlisted-9');
});

test('the status feed keeps its own model field, and a local tool gets a usedModel that does nothing', async () => {
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(pinningUnit('m-deep'), { env: e });
  await rt.callTool('fake_pin', {});
  // Schema 1 is unchanged: `start` still records what the RUNTIME resolved,
  // which is nothing here, and `end` never carried a model at all. The
  // adapter's report reaches the spool and stops there.
  const lines = readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(lines.find((l) => l.event === 'start').model, null);
  assert.equal(rt.status.lastEvent.model, undefined);
  assert.equal(readSpooled(dir, spooled(dir)[0]).header.model, 'm-deep');

  // A `local` tool answers from disk. Its usedModel is a no-op, and calling it
  // is not an error an adapter has to guard against.
  const local = env(null);
  const lt = createUnitRuntime(fakeUnit({
    tools: [...fakeUnit().tools, {
      name: 'fake_localpin', kind: 'local', description: 'd', inputSchema: { type: 'object', properties: {} },
      run(_a, ctx) { ctx.usedModel('m-deep'); return 'ok'; },
    }],
  }), { env: local.env });
  assert.equal((await lt.callTool('fake_localpin', {})).text, 'ok');
  assert.deepEqual(spooled(local.dir), [], 'a local tool is still never spooled');
});

test('`<unit>_result` hands back exactly the string the spool file carries', async () => {
  const { dir, env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  await rt.callTool('fake_research', { prompt: 'x' });
  const body = readFileSync(join(spoolDir(dir), spooled(dir)[0]), 'utf8');
  assert.match(body, /\nmodel: \(vendor default\)\n/);
  const back = await rt.callTool('fake_result', {});
  assert.equal(back.isError, undefined, back.text);
  // The tool re-renders the file it just read, so the two cannot drift — and
  // `omelette-fleet results <unit> <id>` renders the same expression over the
  // same file (bin/omelette-fleet.mjs, cmdResults).
  assert.ok(back.text.startsWith(body), 'the tool answers with the file, verbatim, then the listing');
  assert.match(back.text, /\nmodel: \(vendor default\)\n/);
});

/** The fake unit plus one tool that reports the usage a vendor would. */
const countingUnit = (usage) => fakeUnit({
  tools: [
    ...fakeUnit().tools,
    {
      name: 'fake_tokens', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
      run: () => ({ text: 'counted', usage }),
    },
  ],
});

test('the tokens an adapter reports reach the spooled record, the feed, and nothing else', async () => {
  // Codex's shape: all four counts.
  const codexLike = env(null);
  await createUnitRuntime(countingUnit({ input: 60835, cachedInput: 45312, output: 236, reasoning: 103 }), { env: codexLike.env })
    .callTool('fake_tokens', {});
  const one = readSpooled(codexLike.dir, spooled(codexLike.dir)[0]);
  assert.deepEqual(one.header.usage, { input: 60835, output: 236, cachedInput: 45312, reasoning: 103 });
  assert.equal(one.text, 'counted');

  // A run whose CLI reported nothing: no line, and no zero standing in for one.
  const silent = env(null);
  await createUnitRuntime(countingUnit(null), { env: silent.env }).callTool('fake_tokens', {});
  const name = spooled(silent.dir)[0];
  assert.equal(readSpooled(silent.dir, name).header.usage, undefined);
  assert.ok(!readFileSync(join(spoolDir(silent.dir), name), 'utf8').includes('usage:'));

  // And the status feed still gets the object it always got.
  const feed = env(null);
  const rt = createUnitRuntime(countingUnit({ input: 1, output: 2 }), { env: feed.env });
  await rt.callTool('fake_tokens', {});
  assert.deepEqual(rt.status.lastEvent.usage, { input: 1, output: 2 });
});
