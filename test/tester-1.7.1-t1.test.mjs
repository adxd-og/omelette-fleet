/**
 * omelette-fleet :: test/tester-1.7.1-t1.test.mjs
 * Independent behaviour tests for 1.7.1 T1-T2 (Gemini 4 Argon in, 3.1 Pro out).
 * Written from the spec, not from the implementer's tests. Runtime behaviour only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const ARGON = ['Gemini 4 Argon (Low)', 'Gemini 4 Argon (Medium)', 'Gemini 4 Argon (High)'];
const PRO = ['Gemini 3.1 Pro (Low)', 'Gemini 3.1 Pro (High)'];

const res = (over) => Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, killed: false, capped: false, ...over });

function rig(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t171-'));
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
const modelArg = (argv) => argv[argv.indexOf('--model') + 1];

for (const id of ARGON) {
  test(`an explicit ${id} reaches agy as the exact --model on gemini_research, gemini_image and every deep-research stage`, async () => {
    const { rt, calls } = rig();
    const r = await rt.callTool('gemini_research', { prompt: 'hi', model: id });
    assert.ok(!r.isError, r.text);
    assert.equal(modelArg(calls.spawn[0]), id);
    await rt.callTool('gemini_image', { prompt: 'a cat', model: id }); // fails (no file) but must have spawned on the id
    assert.equal(modelArg(calls.spawn[1]), id);
    const n = calls.spawn.length;
    const d = await rt.callTool('gemini_deep_research', { question: 'why', model: id });
    assert.ok(!d.isError, d.text);
    assert.ok(calls.spawn.length - n >= 2);
    for (const argv of calls.spawn.slice(n)) assert.equal(modelArg(argv), id);
  });
}

for (const id of PRO) {
  test(`${id} is refused by all three tools as an unknown model, with no spawn, and the error offers Argon`, async () => {
    const { rt, calls } = rig();
    for (const [tool, args] of [['gemini_research', { prompt: 'hi' }], ['gemini_image', { prompt: 'a cat' }], ['gemini_deep_research', { question: 'why' }]]) {
      const r = await rt.callTool(tool, { ...args, model: id });
      assert.equal(r.isError, true, tool);
      assert.ok(r.text.startsWith(`Error: unknown model "${id}". Allowed: `), r.text);
      assert.ok(r.text.includes('Gemini 4 Argon (High)'), tool);
      assert.ok(!r.text.slice(r.text.indexOf('Allowed:')).includes('3.1 Pro'), tool);
    }
    assert.equal(calls.spawn.length, 0);
  });
}

test('a configured Argon gemini.model is not refused: research, image and deep research all run on it when no model is named', async () => {
  const id = 'Gemini 4 Argon (Medium)';
  const { rt, calls } = rig({ model: id });
  const r = await rt.callTool('gemini_research', { prompt: 'hi' });
  assert.ok(!r.isError, r.text);
  assert.equal(modelArg(calls.spawn[0]), id);
  await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(modelArg(calls.spawn[1]), id);
  const n = calls.spawn.length;
  const d = await rt.callTool('gemini_deep_research', { question: 'why' });
  assert.ok(!d.isError, d.text);
  assert.match(d.text, /## Summary/);
  for (const argv of calls.spawn.slice(n)) assert.equal(modelArg(argv), id);
});

test('a stale configured 3.1 Pro gemini.model is ignored (vendor default), and deep research falls back to the Flash stages', async () => {
  const { rt, calls } = rig({ model: 'Gemini 3.1 Pro (High)' });
  const r = await rt.callTool('gemini_research', { prompt: 'hi' });
  assert.ok(!r.isError, r.text);
  assert.ok(!calls.spawn[0].includes('--model'));
  const n = calls.spawn.length;
  const d = await rt.callTool('gemini_deep_research', { question: 'why' });
  assert.ok(!d.isError, d.text);
  for (const argv of calls.spawn.slice(n)) assert.match(modelArg(argv), /^Gemini 3\.8 Flash \(/);
});

test('Claude guards are unchanged next to Argon: an explicit Argon id overrides a configured Claude id on research, and deep research still refuses the configured Claude when none is named', async () => {
  const { rt, calls } = rig({ model: 'Claude Opus 5.5 (High)' });
  const ok = await rt.callTool('gemini_research', { prompt: 'hi', model: 'Gemini 4 Argon (High)' });
  assert.ok(!ok.isError, ok.text);
  assert.equal(modelArg(calls.spawn[0]), 'Gemini 4 Argon (High)');
  const refusedResearch = await rt.callTool('gemini_research', { prompt: 'hi' });
  assert.equal(refusedResearch.isError, true);
  assert.match(refusedResearch.text, /a Claude id is named per call/);
  const refusedDeep = await rt.callTool('gemini_deep_research', { question: 'why' });
  assert.equal(refusedDeep.isError, true);
  assert.match(refusedDeep.text, /does not run on a Claude model/);
  const n = calls.spawn.length;
  const deepArgon = await rt.callTool('gemini_deep_research', { question: 'why', model: 'Gemini 4 Argon (Low)' });
  assert.ok(!deepArgon.isError, deepArgon.text);
  for (const argv of calls.spawn.slice(n)) assert.equal(modelArg(argv), 'Gemini 4 Argon (Low)');
});
