import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineUnit, createUnitRuntime, boundedRetry, MUTATE_RE } from '../core/unit.mjs';
import { makeCatalog } from '../core/catalog.mjs';

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
    envMap: { timeoutS: 'FAKE_TIMEOUT_S', model: 'FAKE_DEFAULT_MODEL' },
    supportedModes: { 'read-only': true, 'workspace-write': true },
    auth: { detect: (stderr) => /not signed in/i.test(stderr), help: 'run `fake login`' },
    catalog,
    tools: [
      {
        name: 'fake_research', kind: 'research', mutateGate: true,
        description: 'd', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
        async run(args, ctx) {
          const r = await ctx.spawn({ args: ['-e', `process.stdout.write(${JSON.stringify(`mode=${ctx.mode};model=${ctx.model};effort=${ctx.effort};key=` )} + String(process.env.FAKE_API_KEY))`] });
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

test('defineUnit validates the contract loudly', () => {
  assert.throws(() => defineUnit({ name: 'Bad Name', bin: 'x', tools: [], catalog }), /name must match/);
  assert.throws(() => defineUnit({ name: 'x', bin: 'x', tools: [{ name: 't', description: 'd', inputSchema: {}, kind: 'nope' }], catalog }), /unknown kind/);
  assert.throws(() => defineUnit({ name: 'x', bin: 'x', tools: [{ name: 't', description: 'd', inputSchema: {}, kind: 'research' }], catalog }), /needs run/);
  const u = defineUnit({ name: 'x', bin: 'xbin', tools: [{ name: 't', description: 'd', inputSchema: {}, kind: 'catalog' }], catalog });
  assert.deepEqual(u.bin, { env: null, default: 'xbin' });
  assert.equal(u.serverName, 'omelette-x');
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

test('a full research call: config model + effort reach ctx, billing env is scrubbed, usage lands in status', async () => {
  const { dir, env: e } = env({ units: { fake: { model: 'm-fast', effort: 'high' } } }, { FAKE_API_KEY: 'leak' });
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const r = await rt.callTool('fake_research', { prompt: 'what is up' });
  assert.equal(r.isError, undefined);
  assert.equal(r.text, 'mode=read-only;model=m-fast;effort=high;key=undefined');
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
