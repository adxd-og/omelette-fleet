/**
 * omelette-fleet :: test/tester-neon.test.mjs
 * Independent behaviour tests for 1.12.0 T1 (Gemini 4 Neon in; Argon and Hydrogen (XHigh) out).
 * Written from spec 2026-11-19-gemini-neon-design.md, not from the implementer's tests.
 * Runtime behaviour only: no assertion on catalog prose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const NEON = ['Gemini 4 Neon (Low)', 'Gemini 4 Neon (Medium)', 'Gemini 4 Neon (High)', 'Gemini 4 Neon (XHigh)'];
const RETIRED = [
  'Gemini 4 Argon (Low)', 'Gemini 4 Argon (Medium)', 'Gemini 4 Argon (High)', 'Gemini 4 Hydrogen (XHigh)',
];

const res = (over) => Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, killed: false, capped: false, ...over });

function rig(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-neon-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30, ...config } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const calls = { spawn: [] };
  const stub = (o) => {
    calls.spawn.push(o.args);
    const prompt = o.args[o.args.indexOf('-p') + 1] || '';
    if (/Decompose the following research question/.test(prompt)) {
      return res({ stdout: JSON.stringify({ status: 'SUCCESS', response: '{"subquestions":["alpha"]}', structured_output: { subquestions: ['alpha'] } }) });
    }
    return res({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nthe answer' }) });
  };
  const rt = createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub }) } : t)) },
    { env },
  );
  return { rt, calls };
}
const modelArg = (argv) => (argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : null);

test('every Neon id, including Low and XHigh, reaches agy as the exact --model on gemini_research', async () => {
  const { rt, calls } = rig();
  for (const id of NEON) {
    const r = await rt.callTool('gemini_research', { prompt: 'hi', model: id });
    assert.ok(!r.isError, id + ': ' + r.text);
  }
  assert.deepEqual(calls.spawn.map(modelArg), NEON);
});

test('every retired id is refused by all three tools before any spawn, and the error offers Neon, not the retired ids', async () => {
  const { rt, calls } = rig();
  for (const id of RETIRED) {
    for (const [tool, args] of [['gemini_research', { prompt: 'hi' }], ['gemini_image', { prompt: 'a cat' }], ['gemini_deep_research', { question: 'why' }]]) {
      const r = await rt.callTool(tool, { ...args, model: id });
      assert.equal(r.isError, true, id + ' / ' + tool);
      assert.ok(r.text.startsWith(`Error: unknown model "${id}". Allowed: `), r.text);
      const allowed = r.text.slice(r.text.indexOf('Allowed:'));
      for (const n of NEON) assert.ok(allowed.includes(n), n);
      assert.ok(!allowed.includes('Argon'), 'Argon offered');
      assert.ok(!allowed.includes('Hydrogen (XHigh)'), 'Hydrogen (XHigh) offered');
    }
  }
  assert.equal(calls.spawn.length, 0);
});

test('a configured retired gemini.model is ignored like any unknown id: the call runs with no --model, vendor default', async () => {
  for (const id of RETIRED) {
    const { rt, calls } = rig({ model: id });
    const r = await rt.callTool('gemini_research', { prompt: 'hi' });
    assert.ok(!r.isError, id + ': ' + r.text);
    assert.equal(calls.spawn.length, 1, id);
    assert.equal(calls.spawn[0].includes('--model'), false, id);
  }
});

test('deep research with no model runs its stages on Hydrogen Medium (decompose, gather) and Hydrogen High (synthesis), not Neon', async () => {
  const { rt, calls } = rig();
  const d = await rt.callTool('gemini_deep_research', { question: 'why' });
  assert.ok(!d.isError, d.text);
  const models = calls.spawn.map(modelArg);
  assert.equal(models[0], 'Gemini 4 Hydrogen (Medium)', 'decompose');
  assert.equal(models[models.length - 1], 'Gemini 4 Hydrogen (High)', 'synthesis');
  for (const m of models.slice(1, -1)) assert.equal(m, 'Gemini 4 Hydrogen (Medium)', 'gather');
  assert.ok(models.length >= 3);
});

// Spec "Catalog", GUIDE: "the limit of 1963 characters stands" (HEAD's GUIDE was 1962). A length, not a text.
test('GUIDE stays within the 1963-character limit', async () => {
  const { GUIDE } = await import('../units/gemini/models.js');
  assert.ok(GUIDE.length <= 1963, 'GUIDE is ' + GUIDE.length + ' characters');
});
