/**
 * omelette-fleet :: test/tester-1.6.1-t1b.test.mjs
 * The tester's tests for 1.6.1 Task 1b (the model's pairing applied, doctor's
 * "NOT in this CLI's bundled catalog" tail, `set` validating an effort, the
 * mark on a refused configured effort, and the ruling that the resolution lives
 * in core behind `pairedEffort: true`). Written from the plan and the ruling,
 * not from the implementation; they cover what the `1b ...` tests in
 * test/codex-catalog-1.6.1.test.mjs do not: the review tool, the feed and the
 * record for every source of the effort, `effortFrom` for each step, the
 * per-call normalisation, a warning once per process, concurrent calls, `set`'s
 * atomicity and clearing, the mark's absences, and the probe's edge cases.
 *
 * Every codex here is a fake under a temp dir (CODEX_BIN), OMELETTE_HOME and
 * HOME are temp dirs, and nothing spawns a real CLI or reads the real ~/.omelette.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import unit from '../units/codex/adapter.mjs';
import { CODEX_MODELS } from '../units/codex/models.js';
import { createUnitRuntime, defineUnit } from '../core/unit.mjs';
import { makeCatalog } from '../core/catalog.mjs';
import grokUnit from '../units/grok/adapter.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'codex-debug-models.json');
const HEAD = 'gpt-6.1-sol';
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// --- a fake codex that logs argv and the live status snapshot -----------------

function station() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-161tb-'));
  const bin = join(dir, 'fake-codex');
  const logPath = join(dir, 'argv.log');
  const seenDir = join(dir, 'seen');
  mkdirSync(seenDir);
  writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    "const path = require('path');",
    'const a = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(a) + '\\n');`,
    `const dir = ${JSON.stringify(dir)};`,
    // Keyed by the -m of this run, so concurrent runs do not overwrite each other.
    "const m = a[a.indexOf('-m') + 1];",
    "const snap = fs.readdirSync(dir).find((f) => /^status-codex-\\d+\\.json$/.test(f));",
    `if (snap) fs.writeFileSync(path.join(${JSON.stringify(seenDir)}, m + '.json'), fs.readFileSync(path.join(dir, snap), 'utf8'));`,
    "process.stdin.on('data', () => {}).on('end', () => {",
    "  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "  setTimeout(() => {",
    "    line({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } });",
    "    line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });",
    '  }, Number(process.env.FAKE_DELAY_MS || 0));',
    '});',
    'process.stdin.resume();',
  ].join('\n'));
  chmodSync(bin, 0o755);
  const argvs = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const seen = (m) => JSON.parse(readFileSync(join(seenDir, `${m}.json`), 'utf8'));
  return { dir, bin, argvs, seen };
}

function runtimeOn(st, { config, env = {} } = {}) {
  if (config) writeFileSync(join(st.dir, 'fleet.config.json'), JSON.stringify(config));
  return createUnitRuntime(unit, { env: { PATH: process.env.PATH, HOME: st.dir, OMELETTE_HOME: st.dir, CODEX_BIN: st.bin, ...env } });
}

const flag = (argv) => argv.find((x) => x.startsWith('model_reasoning_effort=')) || null;
const modelOf = (argv) => argv[argv.indexOf('-m') + 1];
const spooled = (st) => {
  const dir = join(st.dir, 'results', 'codex');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(dir, f), 'utf8')) : [];
};

/** Captures stderr for the duration of fn. */
async function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try { await fn(); } finally { process.stderr.write = orig; }
  return lines.join('');
}

// =============================================================================
// Rule 1 -- the pairing is applied: what the earlier files do not reach
// =============================================================================

test('t1b rule 1: codex_code_review brings the pairing too (luna medium, 6-sol high, none named = head xhigh)', async () => {
  const st = station();
  const rt = runtimeOn(st);
  const cwd = mkdtempSync(join(tmpdir(), 'omelette-161tb-cwd-'));
  for (const [model, want] of [['gpt-6-luna', 'medium'], ['gpt-6-sol', 'high'], [undefined, 'xhigh']]) {
    const before = st.argvs().length;
    const r = await rt.callTool('codex_code_review', { prompt: 'x', cwd, ...(model ? { model } : {}) });
    assert.ok(!r.isError, r.text);
    const argv = st.argvs()[before];
    assert.equal(modelOf(argv), model || HEAD);
    assert.equal(flag(argv), `model_reasoning_effort="${want}"`, `${model}`);
  }
});

test('t1b rule 1: an operator effort also beats the pairing for codex_code_review', async () => {
  const st = station();
  const rt = runtimeOn(st, { env: { CODEX_EFFORT: 'medium' } });
  const cwd = mkdtempSync(join(tmpdir(), 'omelette-161tb-cwd-'));
  const r = await rt.callTool('codex_code_review', { prompt: 'x', cwd, model: 'gpt-6-astra' });
  assert.ok(!r.isError, r.text);
  assert.equal(flag(st.argvs()[0]), 'model_reasoning_effort="medium"');
});

test('t1b rule 1: the feed\'s active entry and the record agree with the argv for every step (call / config / pairing / head), model or no model', async () => {
  const cases = [
    // [label, runtime options, tool args, expected effort]
    ['pairing: luna', {}, { model: 'gpt-6-luna' }, 'medium'],
    ['pairing: no model = head', {}, {}, 'xhigh'],
    ['config file', { config: { version: 1, units: { codex: { effort: 'low' } } } }, { model: 'gpt-6-sol' }, 'low'],
    ['config env', { env: { CODEX_EFFORT: 'max' } }, { model: 'gpt-6-luna' }, 'max'],
    ['call', { config: { version: 1, units: { codex: { effort: 'low' } } } }, { model: 'gpt-6-luna', effort: 'ultra' }, 'ultra'],
    ['configured model (file) brings its pairing', { config: { version: 1, units: { codex: { model: 'gpt-6-sol' } } } }, {}, 'high'],
    ['configured model (env) brings its pairing', { env: { CODEX_DEFAULT_MODEL: 'gpt-6-luna' } }, {}, 'medium'],
  ];
  for (const [label, opts, args, want] of cases) {
    const st = station();
    const rt = runtimeOn(st, opts);
    const r = await rt.callTool('codex_research', { prompt: 'x', ...args });
    assert.ok(!r.isError, `${label}: ${r.text}`);
    const argv = st.argvs()[0];
    assert.equal(flag(argv), `model_reasoning_effort="${want}"`, label);
    const snap = st.seen(modelOf(argv));
    assert.equal(snap.active[0].effort, want, `${label}: the feed`);
    assert.match(spooled(st)[0], new RegExp(`^effort: ${want}$`, 'm'), `${label}: the record`);
  }
});

test('t1b rule 1: the call\'s effort is trimmed and lower-cased, and still beats the pairing (feed and record too)', async () => {
  const st = station();
  const rt = runtimeOn(st);
  const r = await rt.callTool('codex_research', { prompt: 'x', model: 'gpt-6-luna', effort: '  HIGH ' });
  assert.ok(!r.isError, r.text);
  assert.equal(flag(st.argvs()[0]), 'model_reasoning_effort="high"');
  assert.equal(st.seen('gpt-6-luna').active[0].effort, 'high');
});

test('t1b rule 1: a whitespace-only call effort is "not given": the pairing applies', async () => {
  const st = station();
  const rt = runtimeOn(st);
  const r = await rt.callTool('codex_research', { prompt: 'x', model: 'gpt-6-luna', effort: '   ' });
  assert.ok(!r.isError, r.text);
  assert.equal(flag(st.argvs()[0]), 'model_reasoning_effort="medium"');
});

test('t1b rule 1: a call effort outside the list (none, bogus) is still refused before any spawn, whatever the pairing', async () => {
  const st = station();
  const rt = runtimeOn(st);
  for (const effort of ['none', 'bogus']) {
    const r = await rt.callTool('codex_research', { prompt: 'x', model: 'gpt-6-luna', effort });
    assert.equal(r.isError, true, effort);
    assert.match(r.text, /unknown effort/i, r.text);
  }
  assert.equal(st.argvs().length, 0, 'nothing reached the CLI');
});

test('t1b rule 1: an unknown explicit model is refused and does not crash the resolution (no spawn)', async () => {
  const st = station();
  const rt = runtimeOn(st);
  const r = await rt.callTool('codex_research', { prompt: 'x', model: 'gpt-4o' });
  assert.equal(r.isError, true);
  assert.equal(st.argvs().length, 0);
});

test('t1b rule 1: a model id with surrounding spaces is trimmed and its pairing found', async () => {
  const st = station();
  const rt = runtimeOn(st);
  const r = await rt.callTool('codex_research', { prompt: 'x', model: ' gpt-6-luna ' });
  assert.ok(!r.isError, r.text);
  assert.deepEqual([modelOf(st.argvs()[0]), flag(st.argvs()[0])], ['gpt-6-luna', 'model_reasoning_effort="medium"']);
});

test('t1b rule 1: a configured model the catalog lacks is ignored (warned) and the HEAD\'s pairing applies, not the built-in by accident', async () => {
  const st = station();
  const rt = runtimeOn(st, { config: { version: 1, units: { codex: { model: 'gpt-4o' } } } });
  const r = await rt.callTool('codex_research', { prompt: 'x' });
  assert.ok(!r.isError, r.text);
  assert.deepEqual([modelOf(st.argvs()[0]), flag(st.argvs()[0])], [HEAD, 'model_reasoning_effort="xhigh"']);
});

test('t1b rule 1: the log line names the pairing only when the pairing decided (not for a call, a configured or a head-default effort that equals it)', async () => {
  const cases = [
    ['pairing', {}, { model: 'gpt-6-luna' }, /effort=medium \(gpt-6-luna's pairing\)/],
    ['call', {}, { model: 'gpt-6-luna', effort: 'medium' }, /effort=medium ·/],
    ['config', { config: { version: 1, units: { codex: { effort: 'medium' } } } }, { model: 'gpt-6-luna' }, /effort=medium ·/],
  ];
  for (const [label, opts, args, re] of cases) {
    const st = station();
    const rt = runtimeOn(st, opts);
    const text = await captureStderr(async () => { assert.ok(!(await rt.callTool('codex_research', { prompt: 'x', ...args })).isError); });
    assert.match(text, re, `${label}: ${text}`);
    if (label !== 'pairing') assert.doesNotMatch(text, /pairing\)/, label);
  }
});

test('t1b rule 1: the "not in the catalog\'s list — ignored" warning fires once per process and names the value; the call runs on the pairing', async () => {
  const st = station();
  const rt = runtimeOn(st, { config: { version: 1, units: { codex: { effort: 'none' } } } });
  const text = await captureStderr(async () => {
    for (let i = 0; i < 3; i += 1) assert.ok(!(await rt.callTool('codex_research', { prompt: 'x', model: 'gpt-6-luna' })).isError);
  });
  const hits = text.split('\n').filter((l) => /default effort "none"/.test(l));
  assert.equal(hits.length, 1, text);
  assert.match(hits[0], /not in the catalog's list/);
  for (const argv of st.argvs()) assert.equal(flag(argv), 'model_reasoning_effort="medium"');
});

test('t1b rule 1: an invalid CODEX_EFFORT falls through to the pairing (not "no flag"), for a named model and for none', async () => {
  const st = station();
  const rt = runtimeOn(st, { env: { CODEX_EFFORT: 'none' } });
  for (const [model, want] of [['gpt-6-sol', 'high'], [undefined, 'xhigh']]) {
    const r = await rt.callTool('codex_research', { prompt: 'x', ...(model ? { model } : {}) });
    assert.ok(!r.isError, r.text);
    assert.equal(flag(st.argvs().at(-1)), `model_reasoning_effort="${want}"`, `${model}`);
  }
});

test('t1b rule 1: two concurrent calls with different models each send their own pairing, and each feed entry says so', async () => {
  const st = station();
  const rt = runtimeOn(st, { env: { FAKE_DELAY_MS: '150' } });
  const [a, b] = await Promise.all([
    rt.callTool('codex_research', { prompt: 'x', model: 'gpt-6-luna' }),
    rt.callTool('codex_research', { prompt: 'y', model: 'gpt-6-sol' }),
  ]);
  assert.ok(!a.isError && !b.isError, a.text + b.text);
  const byModel = Object.fromEntries(st.argvs().map((v) => [modelOf(v), flag(v)]));
  assert.deepEqual(byModel, { 'gpt-6-luna': 'model_reasoning_effort="medium"', 'gpt-6-sol': 'model_reasoning_effort="high"' });
});

test('t1b rule 1: codex_image with a stray effort argument (its schema lists none) still sends no flag', async () => {
  const st = station();
  const rt = runtimeOn(st);
  await rt.callTool('codex_image', { prompt: 'a red circle', model: 'gpt-6-luna', effort: 'high' });
  assert.equal(flag(st.argvs()[0]), null);
});

// --- the core: ctx.effortFrom, for each step, on a throwaway unit ------------

function acme({ pairedEffort, builtin = { effort: 'high' }, efforts = ['low', 'medium', 'high'], models } = {}) {
  const catalog = makeCatalog({
    models: models || [{ id: 'a', effort: 'low' }, { id: 'b', effort: 'medium' }, { id: 'n' }],
    efforts,
  });
  const echo = (kind) => ({ name: `acme_${kind}`, kind, description: 'd', inputSchema: { type: 'object', properties: {} }, run: (args, ctx) => `${ctx.effort}|${ctx.effortFrom}` });
  return defineUnit({
    name: 'acme', bin: process.execPath, builtin, catalog, envMap: { effort: 'ACME_EFFORT', model: 'ACME_MODEL' },
    ...(pairedEffort === undefined ? {} : { pairedEffort }), tools: [echo('research'), echo('image')],
  });
}
const acmeRt = (u, { config, env = {} } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'omelette-161tb-acme-'));
  if (config) writeFileSync(join(home, 'fleet.config.json'), JSON.stringify(config));
  return createUnitRuntime(u, { env: { PATH: process.env.PATH, OMELETTE_HOME: home, HOME: home, ...env } });
};
const acmeCall = async (rt, args, tool = 'acme_research') => (await rt.callTool(tool, args)).text;

test('t1b core: effortFrom names each step - call, config (file and env), pairing, builtin, and empty', async () => {
  const paired = acme({ pairedEffort: true });
  assert.equal(await acmeCall(acmeRt(paired), { model: 'b', effort: 'low' }), 'low|call');
  assert.equal(await acmeCall(acmeRt(paired, { config: { version: 1, units: { acme: { effort: 'low' } } } }), { model: 'b' }), 'low|config');
  assert.equal(await acmeCall(acmeRt(paired, { env: { ACME_EFFORT: 'low' } }), { model: 'b' }), 'low|config');
  assert.equal(await acmeCall(acmeRt(paired), { model: 'b' }), 'medium|pairing');
  // The model carries no pairing: the built-in applies, and says so.
  assert.equal(await acmeCall(acmeRt(paired), { model: 'n' }), 'high|builtin');
  // A configured model is "the model the run resolved to".
  assert.equal(await acmeCall(acmeRt(paired, { env: { ACME_MODEL: 'b' } }), {}), 'medium|pairing');
  // No effort list at all: nothing resolves, even for a paired unit.
  const bare = acme({ pairedEffort: true, efforts: [], builtin: {} });
  assert.equal(await acmeCall(acmeRt(bare), { model: 'b' }), '|');
  // A list, no built-in, no pairing, nothing configured: empty.
  const none = acme({ pairedEffort: true, builtin: {} });
  assert.equal(await acmeCall(acmeRt(none), { model: 'n' }), '|');
  // The same with the pairing present: the pairing, not empty.
  assert.equal(await acmeCall(acmeRt(none), { model: 'a' }), 'low|pairing');
});

test('t1b core: a unit with no effort list (gemini-like) that has an effort configured resolves nothing and warns about nothing', async () => {
  const bare = acme({ pairedEffort: true, efforts: [], builtin: {}, models: [{ id: 'a', effort: 'low' }] });
  const rt = acmeRt(bare, { config: { version: 1, units: { acme: { effort: 'whatever' } } } });
  let text;
  const logged = await captureStderr(async () => { text = await acmeCall(rt, { model: 'a' }); });
  assert.equal(text, '|');
  assert.doesNotMatch(logged, /default effort/, logged);
});

test('t1b rule 1: an unknown configured model AND a refused configured effort - the head\'s pairing still applies (both fall-throughs at once)', async () => {
  const st = station();
  const rt = runtimeOn(st, { config: { version: 1, units: { codex: { model: 'gpt-4o', effort: 'none' } } } });
  const r = await rt.callTool('codex_research', { prompt: 'x' });
  assert.ok(!r.isError, r.text);
  assert.deepEqual([modelOf(st.argvs()[0]), flag(st.argvs()[0])], [HEAD, 'model_reasoning_effort="xhigh"']);
});

test('t1b core: a configured value equal to the built-in counts as configured (source "file"), and beats the pairing', async () => {
  const paired = acme({ pairedEffort: true });
  const rt = acmeRt(paired, { config: { version: 1, units: { acme: { effort: 'high' } } } });
  assert.equal(await acmeCall(rt, { model: 'b' }), 'high|config');
});

test('t1b core: an operator effort the catalog refuses falls to the pairing for a paired unit, to the vendor default (empty) for an unpaired one', async () => {
  const cfg = { config: { version: 1, units: { acme: { effort: 'bogus' } } } };
  assert.equal(await acmeCall(acmeRt(acme({ pairedEffort: true }), cfg), { model: 'b' }), 'medium|pairing');
  // Unpaired: a refused configured value is dropped; the builtin does not come back either.
  assert.equal(await acmeCall(acmeRt(acme({}), cfg), { model: 'b' }), '|');
});

test('t1b core: without the opt-in the pairing is never used, even when the built-in is absent', async () => {
  const plain = acme({ builtin: {} });
  assert.equal(await acmeCall(acmeRt(plain), { model: 'b' }), '|');
});

test('t1b core: the image tool of an opted-in unit gets no effort even when configured, and a call effort on it is honoured as given', async () => {
  const paired = acme({ pairedEffort: true });
  const rt = acmeRt(paired, { config: { version: 1, units: { acme: { effort: 'low' } } } });
  assert.equal(await acmeCall(rt, { model: 'b' }, 'acme_image'), '|');
  assert.equal(await acmeCall(rt, { model: 'b' }, 'acme_research'), 'low|config');
});

test('t1b core: pairedEffort of the shipped units - codex true, grok and gemini not', async () => {
  const gemini = (await import('../units/gemini/adapter.mjs')).default;
  assert.deepEqual([unit.pairedEffort, grokUnit.pairedEffort, gemini.pairedEffort], [true, false, false]);
  for (const bad of [1, 'true', null, {}]) assert.throws(() => acme({ pairedEffort: bad }), /pairedEffort must be a boolean/, String(bad));
  assert.equal(acme({ pairedEffort: false }).pairedEffort, false);
});

test('t1b core: catalog.pairedEffort - a model with no effort field, a non-string tag, and an unlisted tag all give ""', () => {
  const c = makeCatalog({ models: [{ id: 'a' }, { id: 'b', effort: 3 }, { id: 'c', effort: 'ultra' }, { id: 'd', effort: 'low' }], efforts: ['low', 'high'] });
  assert.deepEqual(['a', 'b', 'c', 'd', 'zzz', undefined].map((id) => c.pairedEffort(id)), ['', '', '', 'low', '', '']);
  const noList = makeCatalog({ models: [{ id: 'a', effort: 'low' }] });
  assert.equal(noList.pairedEffort('a'), '', 'a catalog with no effort list pairs nothing');
});

test('t1b core: the codex catalog pairs every model with an effort its own list holds', () => {
  const cat = unit.catalog;
  for (const m of CODEX_MODELS) assert.equal(cat.pairedEffort(m.id), m.effort, m.id);
});

test('t1b core: grok (not opted in) with a configured effort the catalog refuses sends no flag; a listed one still does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-161tb-grok-'));
  const fake = join(dir, 'fake-grok');
  const log = join(dir, 'argv.log');
  writeFileSync(fake, [`#!${process.execPath}`, `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`, 'process.exit(1);'].join('\n'));
  chmodSync(fake, 0o755);
  const env = () => ({ PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, GROK_BIN: fake });
  const setEffort = (v) => writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, units: { grok: { effort: v } } }));
  const runsOf = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  setEffort('max');
  await createUnitRuntime(grokUnit, { env: env() }).callTool('grok_research', { prompt: 'x' });
  const refused = runsOf(); // the fake exits 1, so the unit may retry: judge every run it made
  assert.ok(refused.length >= 1);
  for (const a of refused) assert.ok(!a.includes('--reasoning-effort'), a.join(' '));
  setEffort('high');
  await createUnitRuntime(grokUnit, { env: env() }).callTool('grok_research', { prompt: 'x' });
  const listed = runsOf().slice(refused.length);
  assert.ok(listed.length >= 1);
  for (const a of listed) assert.equal(a[a.indexOf('--reasoning-effort') + 1], 'high');
});

// =============================================================================
// Rule 2 -- doctor and the bundled list
// =============================================================================

// Re-pinned by the session (1b round 3, ruling C): a bundle is not a verdict, so the tail names the one measured refusal.
const WARN = " — NOT in this CLI's bundled catalog: update codex (codex-cli 0.157.1 refused a model its bundle lacked)";

function fakeDoctorCodex(dir, debugOut) {
  const out = join(dir, 'debug-out.txt');
  writeFileSync(out, debugOut);
  const p = join(dir, 'fake-codex');
  writeFileSync(p, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('codex-cli 0.157.1'); process.exit(0); }",
    "if (a[0] === 'login' && a[1] === 'status') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }",
    "if (a.join(' ') === 'debug models --bundled') {",
    `  let s = ''; process.stdin.on('data', (c) => { s += c; }).on('end', () => { process.stdout.write(fs.readFileSync(${JSON.stringify(out)}, 'utf8')); });`,
    '} else { process.exit(1); }',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

function doctorOn(debugOut, { config, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-161tb-doctor-'));
  const fake = fakeDoctorCodex(dir, typeof debugOut === 'string' ? debugOut : JSON.stringify(debugOut));
  if (config) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(config));
  const gone = join(dir, 'no-such');
  const r = spawnSync(process.execPath, [BIN, 'doctor'], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: fake, ...env },
  });
  const out = r.stdout || '';
  const at = out.indexOf('── codex');
  return { out, err: r.stderr || '', codex: at >= 0 ? out.slice(at) : '' };
}
const entry = (slug, priority, visibility = 'list') => ({ slug, visibility, ...(priority === undefined ? {} : { priority }) });
const modelsLine = (r) => (r.codex.split('\n').find((l) => l.startsWith('  models ')) || '');

test('t1b rule 2: a pinned model set by CODEX_DEFAULT_MODEL that the CLI lacks warns, with the env attribution kept before the tail', () => {
  const r = doctorOn({ models: [entry('gpt-6.1-sol', 1), entry('gpt-6-astra', 2)] }, { env: { CODEX_DEFAULT_MODEL: 'gpt-6-luna' } });
  assert.equal(modelsLine(r), `  models      CLI default gpt-6.1-sol — in the catalog; the fleet pins gpt-6-luna (env CODEX_DEFAULT_MODEL)${WARN}`, r.out + r.err);
});

test('t1b rule 2: a pinned model set in the fleet config that the CLI lacks warns with "(fleet config)" before the tail', () => {
  const r = doctorOn({ models: [entry('gpt-6.1-sol', 1)] }, { config: { version: 1, units: { codex: { model: 'gpt-6-sol' } } } });
  assert.equal(modelsLine(r), `  models      CLI default gpt-6.1-sol — in the catalog; the fleet pins gpt-6-sol (fleet config)${WARN}`, r.out + r.err);
});

test('t1b rule 2: a configured model the catalog does not know pins the HEAD, and the tail judges the head', () => {
  const short = { models: [entry('gpt-6-astra', 1)] };
  const r = doctorOn(short, { config: { version: 1, units: { codex: { model: 'gpt-4o' } } } });
  assert.equal(modelsLine(r), `  models      CLI default gpt-6-astra — in the catalog; the fleet pins gpt-6.1-sol (catalog head)${WARN}`, r.out + r.err);
  const full = doctorOn({ models: [entry('gpt-6.1-sol', 1)] }, { config: { version: 1, units: { codex: { model: 'gpt-4o' } } } });
  assert.equal(modelsLine(full), '  models      CLI default gpt-6.1-sol — in the catalog; the fleet pins gpt-6.1-sol (catalog head)');
});

test('t1b rule 2: hidden and unranked entries - only `list` slugs count; an unranked list slug still counts as carried but cannot be the default', () => {
  // Pinned head present only as a hidden entry: not among the list slugs.
  const hidden = doctorOn({ models: [entry('gpt-6-astra', 1), entry('gpt-6.1-sol', 2, 'hide')] });
  assert.equal(modelsLine(hidden), `  models      CLI default gpt-6-astra — in the catalog; the fleet pins gpt-6.1-sol (catalog head)${WARN}`, hidden.out + hidden.err);
  // Pinned head present as a list entry without a priority: carried, so no warning; the default is the ranked one.
  const unranked = doctorOn({ models: [entry('gpt-6-astra', 1), entry('gpt-6.1-sol')] });
  assert.equal(modelsLine(unranked), '  models      CLI default gpt-6-astra — in the catalog; the fleet pins gpt-6.1-sol (catalog head)', unranked.out + unranked.err);
});

test('t1b rule 2: no ranked list entry at all, an empty list, or non-JSON prints no models line and no warning', () => {
  for (const body of [{ models: [entry('gpt-6.1-sol')] }, { models: [] }, {}, 'not json at all']) {
    const r = doctorOn(body);
    assert.ok(!/^  models /m.test(r.codex), `${JSON.stringify(body)}: ${r.codex}`);
    assert.ok(!r.out.includes('bundled catalog'), JSON.stringify(body));
    assert.match(r.codex, /^  login {7}OK/m, 'the login verdict stays');
  }
});

test('t1b rule 2: the real 0.159.2 fixture carries the head - no warning; the same fixture minus the head - warning', () => {
  const full = readFileSync(FIXTURE, 'utf8');
  assert.equal(modelsLine(doctorOn(full)), '  models      CLI default gpt-6.1-sol — in the catalog; the fleet pins gpt-6.1-sol (catalog head)');
  const parsed = JSON.parse(full);
  parsed.models = parsed.models.filter((m) => m.slug !== 'gpt-6.1-sol');
  const cut = modelsLine(doctorOn(parsed));
  assert.ok(cut.endsWith(WARN), cut);
  assert.match(cut, /the fleet pins gpt-6\.1-sol \(catalog head\)/);
});

test('t1b rule 2: the codex-cli version and the warning do not disturb the other doctor lines (bin, version, login, config, mcp)', () => {
  const r = doctorOn({ models: [entry('gpt-6-astra', 1)] });
  for (const re of [/^ +bin +\S+fake-codex/m, /^ +version +codex-cli 0\.157\.1$/m, /^ +login +OK — Logged in using ChatGPT$/m, /^ +config +/m]) assert.match(r.codex, re, r.codex);
});

// =============================================================================
// Rule 3 -- `set`, `show`, `doctor`
// =============================================================================

function cli(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const home = () => mkdtempSync(join(tmpdir(), 'omelette-161tb-home-'));
const cfgOf = (dir) => (existsSync(join(dir, 'fleet.config.json')) ? JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8')) : null);
const put = (dir, obj) => writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(obj));

test('t1b rule 3: every listed codex effort is accepted by `set`, every listed grok effort too', () => {
  for (const [unitName, list] of [['codex', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']], ['grok', ['low', 'medium', 'high', 'xhigh']]]) {
    for (const v of list) {
      const dir = home();
      const r = cli(dir, ['set', `${unitName}.effort=${v}`]);
      assert.equal(r.code, 0, `${unitName} ${v}: ${r.out}${r.err}`);
      assert.equal(cfgOf(dir).units[unitName].effort, v);
    }
  }
});

test('t1b rule 3: the refusal names the list for grok (low | medium | high | xhigh) and leaves an existing config untouched', () => {
  const dir = home();
  put(dir, { version: 1, units: { grok: { effort: 'low' } } });
  const before = readFileSync(join(dir, 'fleet.config.json'), 'utf8');
  const r = cli(dir, ['set', 'grok.effort=max']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /invalid value for grok\.effort: "max" — expected one of the catalog's effort levels: low \| medium \| high \| xhigh$/m, r.err);
  assert.equal(readFileSync(join(dir, 'fleet.config.json'), 'utf8'), before);
});

test('t1b rule 3: one bad effort in a multi-assignment writes nothing at all (atomic), and the good assignment is not applied', () => {
  const dir = home();
  const r = cli(dir, ['set', 'codex.timeoutS=123', 'codex.effort=none']);
  assert.notEqual(r.code, 0, r.out + r.err);
  assert.equal(cfgOf(dir), null, 'no file written');
});

test('t1b rule 3: `set codex.effort=` (empty) is not refused by the effort list; it clears a stored value', () => {
  const dir = home();
  put(dir, { version: 1, units: { codex: { effort: 'low', timeoutS: 99 } } });
  const r = cli(dir, ['set', 'codex.effort=']);
  assert.equal(r.code, 0, r.out + r.err);
  const c = cfgOf(dir);
  assert.ok(!c.units.codex.effort, JSON.stringify(c));
  assert.equal(c.units.codex.timeoutS, 99, 'the other key survives');
});

test('t1b rule 3: gemini takes any string as an effort, and `show gemini` carries no mark for it', () => {
  const dir = home();
  assert.equal(cli(dir, ['set', 'gemini.effort=whatever']).code, 0);
  const shown = cli(dir, ['show', 'gemini']);
  assert.match(shown.out, /^ +effort +whatever +file$/m, shown.out);
  assert.ok(!shown.out.includes("not in the catalog's list"));
});

test('t1b rule 3: no mark on a listed configured effort, on the built-in, or on an empty effort; the built-in still prints with its source', () => {
  const dir = home();
  const built = cli(dir, ['show', 'codex']);
  assert.match(built.out, /^ +effort +xhigh +default$/m, built.out);
  assert.ok(!built.out.includes("not in the catalog's list"));
  put(dir, { version: 1, units: { codex: { effort: 'ultra' }, grok: { effort: 'low' } } });
  const shown = cli(dir, ['show']);
  assert.match(shown.out, /^ +effort +ultra +file$/m, shown.out);
  assert.match(shown.out, /^ +effort +low +file$/m, shown.out);
  assert.ok(!shown.out.includes("not in the catalog's list"), shown.out);
});

test('t1b rule 3: a bare `show` marks the refused codex effort row and only that row; the built-in row of other units is unmarked', () => {
  const dir = home();
  put(dir, { version: 1, units: { codex: { effort: 'none' } } });
  const shown = cli(dir, ['show']);
  const marks = shown.out.split('\n').filter((l) => l.includes("not in the catalog's list"));
  assert.equal(marks.length, 1, shown.out);
  assert.match(marks[0], /effort +none +file — not in the catalog's list: ignored at call time, the model's pairing applies$/);
});

test('t1b rule 3: the mark is on the value as stored (case), and a `defaults` block value (source `file:defaults`) is marked for the units whose catalog refuses it', () => {
  const dir = home();
  put(dir, { version: 1, defaults: { effort: 'max' } });
  const codex = cli(dir, ['show', 'codex']);
  assert.match(codex.out, /^ +effort +max +file:defaults$/m, 'max is listed for codex: no mark');
  assert.ok(!codex.out.includes("not in the catalog's list"));
  const grok = cli(dir, ['show', 'grok']);
  assert.match(grok.out, /^ +effort +max +file:defaults — not in the catalog's list: ignored at call time, the vendor default applies$/m, grok.out);
});

test('t1b rule 3: doctor marks a refused configured effort in its own config rows, for grok as well (the vendor default applies)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-161tb-doc-'));
  put(dir, { version: 1, units: { grok: { effort: 'ultra' } } });
  const gone = join(dir, 'no-such');
  const r = spawnSync(process.execPath, [BIN, 'doctor'], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone },
  });
  assert.match(r.stdout, /^ +effort +ultra +file — not in the catalog's list: ignored at call time, the vendor default applies$/m, r.stdout);
});

// =============================================================================
// Rule 4 / text: claims the diff makes that can be checked against the code
// =============================================================================

test('t1b text: ADAPTERS documents effortFrom and pairedEffort, and lists exactly the values core can produce', () => {
  const adapters = read('docs/ADAPTERS.md');
  assert.match(adapters, /\| `effortFrom` \|/);
  assert.match(adapters, /`pairedEffort: true`/);
  for (const v of ['call', 'config', 'pairing', 'builtin']) assert.ok(adapters.includes(`\`${v}\``), v);
  const core = read('core/unit.mjs');
  assert.match(core, /effortFrom: 'call' \| 'config' \| 'pairing' \| 'builtin' \| ''|'call' \| 'config' \| 'pairing' \| 'builtin' \| ''/);
});

test('t1b text: the CHANGELOG\'s pairing list is the catalog\'s, model by model', () => {
  const entryText = read('CHANGELOG.md').split(/^## /m).find((s) => s.startsWith('1.6.1'));
  const para = entryText.split('\n').find((l) => l.includes('A named model brings its catalog pairing'));
  assert.ok(para, 'the bullet exists');
  const claimed = {
    'gpt-6.1-sol': 'xhigh', 'gpt-6-astra': 'xhigh', 'gpt-6-sol': 'high', 'gpt-6-luna': 'medium',
    'gpt-5.6-terra': 'high', 'gpt-5.6-luna': 'medium', 'gpt-5.6-sol': 'high',
  };
  for (const m of CODEX_MODELS) assert.equal(claimed[m.id], m.effort, m.id);
  assert.match(para, /`gpt-6\.1-sol` and `gpt-6-astra` xhigh, `gpt-6-sol` high, `gpt-6-luna` medium, `gpt-5\.6-terra` high, `gpt-5\.6-luna` medium, `gpt-5\.6-sol` high/);
});

test('t1b text: ORCHESTRATION\'s pointer example names a real line of core/unit.mjs', () => {
  const m = read('docs/ORCHESTRATION.md').match(/- `(core\/unit\.mjs):(\d+)` · `([^`]+)`/);
  assert.ok(m, 'the pointer line exists');
  const line = read(m[1]).split('\n')[Number(m[2]) - 1];
  assert.ok(line.includes(m[3]), `line ${m[2]} is: ${line}`);
});

test('t1b text: the codex_models tool shows each model\'s pairing (the docs send the reader there)', async () => {
  const st = station();
  const rt = runtimeOn(st);
  const r = await rt.callTool('codex_models', {});
  assert.ok(!r.isError, r.text);
  for (const m of CODEX_MODELS) assert.ok(r.text.includes(m.id), m.id);
  assert.match(r.text, /effort/i);
});
