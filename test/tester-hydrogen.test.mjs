/**
 * omelette-fleet :: test/tester-hydrogen.test.mjs
 * Independent tests for 1.11.0 (spec docs/superpowers/specs/2026-11-13-gemini-hydrogen-design.md,
 * "Catalog", "Decisions", "Tests"): what a caller meets through the unit's tools once
 * Gemini 4 Hydrogen replaced 3.8 Flash. Behaviour only; no prose is pinned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit, { stageModels } from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const ARGS = {
  gemini_research: { prompt: 'a question' },
  gemini_image: { prompt: 'a cat' },
  gemini_deep_research: { question: 'why' },
};

const res = (over) => Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, killed: false, capped: false, ...over });

function rig(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-hydrogen-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30, ...config } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const spawns = [];
  const stub = (o) => {
    spawns.push(o.args);
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
  return { rt, spawns };
}

const modelArg = (argv) => (argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : null);

/** Run `fn` while collecting everything the process writes to stderr. */
async function withStderr(fn) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); const cb = rest.find((x) => typeof x === 'function'); if (cb) cb(); return true; };
  try { await fn(); } finally { process.stderr.write = orig; }
  return lines.join('');
}

test('an operator whose gemini.model still names 3.8 Flash: a warning once, then agy\'s default (no --model) on research and image, the Hydrogen stages on deep research', async () => {
  const { rt, spawns } = rig({ model: 'Gemini 3.8 Flash (High)' });
  let err = '';
  err += await withStderr(async () => {
    for (const tool of ['gemini_research', 'gemini_image']) {
      const r = await rt.callTool(tool, ARGS[tool]);
      assert.ok(!r.text.startsWith('Error: unknown model') && !r.text.includes('configured'), `${tool}: ${r.text}`);
    }
  });
  assert.equal(spawns.length, 2);
  for (const argv of spawns) assert.equal(modelArg(argv), null, 'no --model: the vendor default applies');
  assert.match(err, /config: default model "Gemini 3\.8 Flash \(High\)" is not in the catalog — using the vendor default/);
  assert.equal(err.split('is not in the catalog').length - 1, 1, 'warned once, not per call');

  const deep = rig({ model: 'Gemini 3.8 Flash (High)' });
  const r = await deep.rt.callTool('gemini_deep_research', ARGS.gemini_deep_research);
  assert.ok(!r.isError, r.text);
  assert.ok(deep.spawns.length >= 3);
  const used = new Set(deep.spawns.map(modelArg));
  assert.deepEqual([...used].sort(), ['Gemini 4 Hydrogen (High)', 'Gemini 4 Hydrogen (Medium)']);
  assert.equal(deep.spawns.filter((a) => modelArg(a) === 'Gemini 4 Hydrogen (High)').length, 1, 'only the synthesis runs on High');
});

test('stageModels takes the balanced Gemini entries by tier, whatever the catalog order: a heavy entry listed first, or an XHigh one, is never a stage', () => {
  const e = (id, effort, tier, family = 'gemini') => ({ id, family, effort, tier });
  const cat = { models: [
    e('heavy-medium', 'Medium', 'heavy'),
    e('heavy-high', 'High', 'heavy'),
    e('claude-high', 'High', 'balanced', 'claude'),
    e('fast-low', 'Low', 'fast'),
    e('bal-medium', 'Medium', 'balanced'),
    e('bal-high', 'High', 'balanced'),
    e('xhigh', 'XHigh', 'heavy'),
  ] };
  assert.deepEqual(stageModels(cat), { decompose: 'bal-medium', gather: 'bal-medium', synth: 'bal-high' });
});
