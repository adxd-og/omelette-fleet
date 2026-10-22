/**
 * omelette-fleet :: test/tester-1.6.2-t1.test.mjs
 * Independent tests for 1.6.2 T1 (the Gemini catalog's Claude 5.5 entries and
 * gemini_deep_research's refusal of a Claude id). Written from the task's plan
 * section, not from the implementer's tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEMINI_MODELS, ALLOWLIST } from '../units/gemini/models.js';
import unit, { catalog } from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const CLAUDE_IDS = [
  'Claude Opus 5.5 (High)',
  'Claude Opus 5.5 (Medium)',
  'Claude Sonnet 5.5 (High)',
  'Claude Sonnet 5.5 (Medium)',
];

const REFUSAL = (id) => 'Error: gemini_deep_research does not run on a Claude model ("' + id + '"): a deep-research call is about five agy runs, and Antigravity\'s Claude quota is small and separate. Ask gemini_research with that model for one question, or name a Flash id — a configured Claude `gemini.model` applies whenever `model` is omitted.';

const res = (over) => Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, killed: false, capped: false, ...over });

/** A runtime with an in-process spawn stub; records every spawn's argv and every usedModel call. */
function rig(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t162-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30, ...config } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const calls = { spawn: [], usedModel: [] };
  const stub = (o) => {
    calls.spawn.push(o.args);
    const prompt = o.args[o.args.indexOf('-p') + 1] || '';
    if (/Decompose the following research question/.test(prompt)) {
      return res({ stdout: JSON.stringify({ status: 'SUCCESS', response: '{"subquestions":["alpha"]}', structured_output: { subquestions: ['alpha'] } }) });
    }
    return res({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nthe answer' }) });
  };
  const rt = createUnitRuntime(
    {
      ...unit,
      tools: unit.tools.map((t) => (t.run
        ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub, usedModel: (id) => { calls.usedModel.push(id); return ctx.usedModel(id); } }) }
        : t)),
    },
    { env },
  );
  return { rt, calls, dir };
}

const modelArg = (argv) => argv[argv.indexOf('--model') + 1];

// --- the catalog as the tools serve it -----------------------------------------

test('exactly four Claude entries exist, all heavy, none balanced, each with non-empty useFor/avoid/label', () => {
  const claude = GEMINI_MODELS.filter((m) => m.family === 'claude');
  assert.deepEqual(claude.map((m) => m.id), CLAUDE_IDS);
  for (const m of claude) {
    assert.equal(m.tier, 'heavy', m.id);
    assert.ok(m.label && m.label.includes('5.5'), m.id);
    assert.ok(typeof m.useFor === 'string' && m.useFor.length > 40, m.id);
    assert.ok(typeof m.avoid === 'string' && m.avoid.length > 20, m.id);
  }
  // labels use the middle dot form of the plan
  assert.deepEqual(claude.map((m) => m.label), [
    'Claude Opus 5.5 · High', 'Claude Opus 5.5 · Medium', 'Claude Sonnet 5.5 · High', 'Claude Sonnet 5.5 · Medium',
  ]);
});

test('ids are unique across the catalog and the ALLOWLIST is exactly the catalog ids', () => {
  const ids = GEMINI_MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ALLOWLIST].sort(), [...ids].sort());
  assert.deepEqual(catalog.modelEnum().sort(), [...ids].sort());
  for (const id of ids) assert.ok(!/Claude.*\(Low\)/.test(id), id);
});

test('the Claude entries sit between Gemini 4 Argon (High) and GPT-OSS 120B (Medium)', () => {
  const ids = GEMINI_MODELS.map((m) => m.id);
  const argon = ids.indexOf('Gemini 4 Argon (High)');
  const oss = ids.indexOf('GPT-OSS 120B (Medium)');
  assert.ok(argon >= 0 && oss >= 0);
  assert.equal(oss, argon + 5);
});

test('gemini_models renders all four Claude ids with their tags, the GUIDE, and no 4.6', async () => {
  const { rt } = rig();
  const r = await rt.callTool('gemini_models', {});
  assert.ok(!r.isError);
  for (const id of CLAUDE_IDS) assert.ok(r.text.includes('• ' + id + '  [claude · '), id);
  assert.ok(r.text.includes('Claude Opus 5.5 (High)  [claude · High effort · heavy]'));
  assert.ok(r.text.includes('Claude Sonnet 5.5 (Medium)  [claude · Medium effort · heavy]'));
  assert.ok(!r.text.includes('4.6'));
  assert.ok(r.text.includes('GUIDE: '));
});

test('every tool that takes `model` offers the four Claude ids in its enum', () => {
  for (const name of ['gemini_research', 'gemini_image', 'gemini_deep_research']) {
    const t = unit.tools.find((x) => x.name === name);
    for (const id of CLAUDE_IDS) assert.ok(t.inputSchema.properties.model.enum.includes(id), name + ' / ' + id);
    assert.ok(!t.inputSchema.properties.model.enum.some((i) => i.includes('4.6')), name);
  }
});

// --- the deep-research refusal ------------------------------------------------

test('an explicit Flash id overrides a configured Claude id: the call runs', async () => {
  const { rt, calls } = rig({ model: 'Claude Opus 5.5 (High)' });
  const r = await rt.callTool('gemini_deep_research', { question: 'why', model: 'Gemini 3.8 Flash (Medium)' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /## Summary/);
  assert.ok(calls.spawn.length >= 2);
  for (const argv of calls.spawn) assert.equal(modelArg(argv), 'Gemini 3.8 Flash (Medium)');
});

test('a surrounding-whitespace Claude id is still refused, named without the whitespace', async () => {
  const { rt, calls } = rig();
  const r = await rt.callTool('gemini_deep_research', { question: 'why', model: '  Claude Opus 5.5 (Medium)  ' });
  assert.equal(r.isError, true);
  assert.equal(r.text, REFUSAL('Claude Opus 5.5 (Medium)'));
  assert.equal(calls.spawn.length, 0);
});

test('a Claude Low id (agy lists it, the catalog does not) is the runtime\'s "unknown model" error, not the refusal, and spawns nothing', async () => {
  const { rt, calls } = rig();
  const r = await rt.callTool('gemini_deep_research', { question: 'why', model: 'Claude Opus 5.5 (Low)' });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Error: unknown model "Claude Opus 5\.5 \(Low\)"\. Allowed: /);
  assert.ok(r.text.includes('Claude Sonnet 5.5 (Medium)'));
  assert.ok(!r.text.includes('Opus 4.6'));
  assert.equal(calls.spawn.length, 0);
  // and the removed 4.6 id is refused the same way
  const old = await rt.callTool('gemini_research', { prompt: 'hi', model: 'Claude Opus 4.6 (Thinking)' });
  assert.match(old.text, /^Error: unknown model "Claude Opus 4\.6 \(Thinking\)"/);
  assert.equal(calls.spawn.length, 0);
});

test('a configured Claude id the catalog does not admit is ignored (vendor default) and deep research proceeds on the Flash stages', async () => {
  const { rt, calls } = rig({ model: 'Claude Opus 5.5 (Low)' });
  const r = await rt.callTool('gemini_deep_research', { question: 'why' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /## Summary/);
  for (const argv of calls.spawn) assert.match(modelArg(argv), /^Gemini 3\.8 Flash \(/);
});

test('deep research with no model uses Flash for every spawn (no Claude id leaks into the stages)', async () => {
  const { rt, calls } = rig();
  const r = await rt.callTool('gemini_deep_research', { question: 'why' });
  assert.ok(!r.isError, r.text);
  assert.ok(calls.spawn.length >= 2);
  for (const argv of calls.spawn) assert.match(modelArg(argv), /^Gemini 3\.8 Flash \(/);
  assert.equal(calls.usedModel.length, 1);
});

test('an empty question is still the "question is required" error, not the refusal, even with a Claude id', async () => {
  const { rt, calls } = rig();
  const r = await rt.callTool('gemini_deep_research', { question: '   ', model: 'Claude Opus 5.5 (High)' });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'Error: "question" is required.');
  assert.equal(calls.spawn.length, 0);
});

test('the refusal is a finished call, not a hang: the status feed and the spool record it as an error and no stage ran', async () => {
  const { rt, dir, calls } = rig();
  await rt.callTool('gemini_deep_research', { question: 'why', model: 'Claude Opus 5.5 (High)' });
  const snap = JSON.parse(readFileSync(join(dir, `status-gemini-${process.pid}.json`), 'utf8'));
  assert.equal(snap.lastEvent.status, 'error');
  assert.equal(calls.spawn.length, 0);
});

// --- third pass: R5 (gemini_research refuses a configured Claude default) and R7 (the Claude exhaustion message) ---

const CFG_REFUSAL_HEAD = 'Error: a Claude id is named per call, not configured as `gemini.model` ("';
const GEMINI_EXHAUSTED_MSG = 'Gemini quota exhausted — the Antigravity bucket is empty; try after the window resets.';

/** A rig whose every spawn fails as an exhausted bucket; counts spawns. */
function exhaustedRig(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t162-r7-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30, ...config } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const calls = { spawn: [] };
  const stub = (o) => { calls.spawn.push(o.args); return res({ stdout: '', stderr: 'error: Individual quota reached. AGY_ERROR RESOURCE_EXHAUSTED', code: 1 }); };
  const rt = createUnitRuntime({ ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub }) } : t)) }, { env });
  return { rt, calls };
}

test('R5: the refusal comes before the cwd check (a relative cwd does not mask it) and before any spawn', async () => {
  const { rt, calls } = rig({ model: 'Claude Opus 5.5 (High)' });
  const r = await rt.callTool('gemini_research', { prompt: 'a question', cwd: 'relative/dir' });
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith(CFG_REFUSAL_HEAD), r.text);
  assert.equal(calls.spawn.length, 0);
});

test('R5: a Claude id named in the call runs when it differs from the configured one, and with a Flash default', async () => {
  for (const config of [{ model: 'Claude Opus 5.5 (Medium)' }, { model: 'Gemini 3.8 Flash (High)' }, {}]) {
    const { rt, calls } = rig(config);
    const r = await rt.callTool('gemini_research', { prompt: 'a question', model: 'Claude Sonnet 5.5 (High)' });
    assert.ok(!r.isError, r.text);
    assert.equal(calls.spawn.length, 1);
    assert.equal(modelArg(calls.spawn[0]), 'Claude Sonnet 5.5 (High)');
  }
});

test('R5: a configured Claude default with a Flash id named in the call runs on the Flash id', async () => {
  const { rt, calls } = rig({ model: 'Claude Opus 5.5 (High)' });
  const r = await rt.callTool('gemini_research', { prompt: 'a question', model: 'Gemini 3.8 Flash (Medium)' });
  assert.ok(!r.isError, r.text);
  assert.equal(calls.spawn.length, 1);
  assert.equal(modelArg(calls.spawn[0]), 'Gemini 3.8 Flash (Medium)');
});

test('R5: a configured Flash default, no model in the call, runs on it; no config at all runs on agy\'s default (no --model)', async () => {
  const a = rig({ model: 'Gemini 3.8 Flash (High)' });
  const ra = await a.rt.callTool('gemini_research', { prompt: 'q' });
  assert.ok(!ra.isError, ra.text);
  assert.equal(modelArg(a.calls.spawn[0]), 'Gemini 3.8 Flash (High)');
  const b = rig({});
  const rb = await b.rt.callTool('gemini_research', { prompt: 'q' });
  assert.ok(!rb.isError, rb.text);
  assert.ok(!b.calls.spawn[0].includes('--model'));
});

test('R5: a whitespace-only model argument is "no model named": the configured Claude default is refused', async () => {
  const { rt, calls } = rig({ model: 'Claude Opus 5.5 (High)' });
  const r = await rt.callTool('gemini_research', { prompt: 'q', model: '   ' });
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith(CFG_REFUSAL_HEAD), r.text);
  assert.equal(calls.spawn.length, 0);
});

test('R5: an empty prompt is still the "prompt is required" error even with a configured Claude default', async () => {
  const { rt } = rig({ model: 'Claude Opus 5.5 (High)' });
  const r = await rt.callTool('gemini_research', { prompt: '  ' });
  assert.equal(r.text, 'Error: "prompt" is required.');
});

test('R7: a Flash run, the default run and a deep-research Flash stage all keep the unchanged Gemini message', async () => {
  for (const [tool, args] of [
    ['gemini_research', { prompt: 'q', model: 'Gemini 3.8 Flash (High)' }],
    ['gemini_research', { prompt: 'q' }],
    ['gemini_deep_research', { question: 'q' }],
  ]) {
    const { rt, calls } = exhaustedRig();
    const r = await rt.callTool(tool, args);
    assert.equal(r.isError, true, tool);
    assert.ok(r.text.includes(GEMINI_EXHAUSTED_MSG), tool + ': ' + r.text);
    assert.ok(!/Claude/.test(r.text), tool + ': ' + r.text);
    assert.equal(calls.spawn.length, 1, tool);
  }
});

// --- fourth pass: R9 (gemini_image), R10, R11, R12 ---------------------------

/** Runs fn with TMPDIR pointed at a private empty directory; returns what fn left in it. */
async function withPrivateTmp(fn) {
  const priv = mkdtempSync(join(realpathSync(tmpdir()), 'omelette-t162-tmp-'));
  const was = process.env.TMPDIR;
  process.env.TMPDIR = priv;
  try { await fn(); } finally { if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was; }
  return readdirSync(priv);
}

test('R9: gemini_image with a configured Claude default and no model is refused: no spawn, no usedModel, no temp directory', async () => {
  for (const id of CLAUDE_IDS) {
    const { rt, calls } = rig({ model: id });
    let r;
    const left = await withPrivateTmp(async () => { r = await rt.callTool('gemini_image', { prompt: 'a cat' }); });
    assert.equal(r.isError, true);
    assert.ok(r.text.startsWith(CFG_REFUSAL_HEAD + id + '" is the configured default)'), r.text);
    assert.equal(calls.spawn.length, 0, id);
    assert.equal(calls.usedModel.length, 0, id);
    assert.deepEqual(left, [], id + ': a temp directory was made');
  }
});

test('R9: gemini_image with no config, and with a configured Flash default, still spawns (no regression)', async () => {
  const a = rig({});
  await a.rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(a.calls.spawn.length, 1);
  assert.ok(!a.calls.spawn[0].includes('--model'));
  const b = rig({ model: 'Gemini 3.8 Flash (High)' });
  await b.rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(modelArg(b.calls.spawn[0]), 'Gemini 3.8 Flash (High)');
});

test('R9: gemini_image with an empty prompt is still "prompt is required", even with a configured Claude default', async () => {
  const { rt } = rig({ model: 'Claude Opus 5.5 (High)' });
  const r = await rt.callTool('gemini_image', { prompt: ' ' });
  assert.equal(r.text, 'Error: "prompt" is required.');
});

// --- session, after the whole-branch review (finding 4): the deep-research refusal makes no temp directory ---

test('review-4: gemini_deep_research refuses a Claude id before its temp directory is made', async () => {
  for (const [config, args] of [[{}, { question: 'q', model: 'Claude Opus 5.5 (High)' }], [{ model: 'Claude Sonnet 5.5 (Medium)' }, { question: 'q' }]]) {
    const { rt, calls } = rig(config);
    let r;
    const left = await withPrivateTmp(async () => { r = await rt.callTool('gemini_deep_research', args); });
    assert.equal(r.isError, true);
    assert.ok(r.text.startsWith('Error: gemini_deep_research does not run on a Claude model ("'), r.text);
    assert.equal(calls.spawn.length, 0);
    assert.deepEqual(left, [], JSON.stringify(config) + ': a temp directory was made');
  }
});
