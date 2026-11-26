/**
 * omelette-fleet :: test/tester-carbon.test.mjs
 * Clean-context tester file for 1.14.0 part one (Gemini 4 Carbon in the catalog),
 * spec docs/superpowers/specs/2026-11-26-gemini-carbon-design.md. Pins what
 * test/gemini-catalog.test.mjs does not: what the tools DO with the two Carbon ids
 * (a one-call route is passed to agy as named; deep research on a named Carbon id runs
 * every stage on it, unrefused) and what the
 * gemini_models listing offers.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const spawnRes = (over) => Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, killed: false, capped: false, ...over });
const ok = (response) => JSON.stringify({ status: 'SUCCESS', response });

const world = (units, stub) => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-tester-carbon-'));
  made.push(dir);
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30, ...units } } }));
  const rt = createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub }) } : t)) },
    { env: { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath } },
  );
  return rt;
};

const modelOf = (o) => { const i = o.args.indexOf('--model'); return i < 0 ? null : o.args[i + 1]; };

const deepStub = (seen) => (o) => {
  const prompt = o.args[o.args.indexOf('-p') + 1];
  const stage = /Decompose the following research question/.test(prompt) ? 'decompose'
    : /Question: /.test(prompt) ? 'gather' : 'synth';
  seen.push([stage, modelOf(o)]);
  if (stage === 'decompose') {
    return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify({ subquestions: ['alpha'] }), structured_output: { subquestions: ['alpha'] } }) });
  }
  return spawnRes({ stdout: ok(stage === 'gather' ? 'finding' : '## Summary\nreport') });
};

for (const id of ['Gemini 4 Carbon (High)', 'Gemini 4 Carbon (Medium)']) {
  test(`gemini_research on "${id}" is accepted and hands agy exactly that --model`, async () => {
    const seen = [];
    const rt = world({}, (o) => { seen.push(modelOf(o)); return spawnRes({ stdout: ok('answer') }); });
    const r = await rt.callTool('gemini_research', { prompt: 'hi', model: id });
    assert.ok(!r.isError, r.text);
    assert.deepEqual(seen, [id]);
  });
}

test('gemini.model set to a Carbon id is not refused as a configured default (only Claude ids are)', async () => {
  const seen = [];
  const rt = world({ model: 'Gemini 4 Carbon (High)' }, (o) => { seen.push(modelOf(o)); return spawnRes({ stdout: ok('answer') }); });
  const r = await rt.callTool('gemini_research', { prompt: 'hi' });
  assert.ok(!r.isError, r.text);
  assert.deepEqual(seen, ['Gemini 4 Carbon (High)']);
});

test('gemini_deep_research naming Carbon (High) is not refused and runs every stage on it', async () => {
  const seen = [];
  const rt = world({}, deepStub(seen));
  const r = await rt.callTool('gemini_deep_research', { question: 'why', model: 'Gemini 4 Carbon (High)' });
  assert.ok(!r.isError, r.text);
  assert.equal(seen.length, 3);
  for (const [stage, model] of seen) assert.equal(model, 'Gemini 4 Carbon (High)', stage);
});

test('gemini_models lists both Carbon ids and no Carbon (Low)', async () => {
  const rt = world({}, () => { throw new Error('no spawn'); });
  const r = await rt.callTool('gemini_models', {});
  assert.ok(!r.isError, r.text);
  assert.ok(r.text.includes('Gemini 4 Carbon (High)'));
  assert.ok(r.text.includes('Gemini 4 Carbon (Medium)'));
  assert.ok(!r.text.includes('Carbon (Low)'));
});
