import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

/** A runtime whose every spawn argv is recorded; each spawn answers a canned stage. */
function recordingRuntime() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-mode-pin-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const spawns = [];
  const stub = (o) => {
    spawns.push(o.args);
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) {
      return Promise.resolve({ stdout: JSON.stringify({ status: 'SUCCESS', response: '{"subquestions":["alpha"]}', structured_output: { subquestions: ['alpha'] } }), stderr: '', code: 0, signal: null, killed: false, capped: false });
    }
    return Promise.resolve({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nthe report' }), stderr: '', code: 0, signal: null, killed: false, capped: false });
  };
  const rt = createUnitRuntime(
    {
      ...unit,
      tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub }) } : t)),
    },
    { env },
  );
  return { rt, spawns };
}

/** Assert the argv pins agy's Default mode: `--settings` followed by JSON whose agentMode is '', and no `--mode`. */
function assertDefaultModePinned(argv) {
  const at = argv.indexOf('--settings');
  assert.ok(at >= 0, `no --settings in ${JSON.stringify(argv)}`);
  const settings = JSON.parse(argv[at + 1]);
  assert.equal(typeof settings, 'object');
  assert.equal(settings.agentMode, '');
  assert.ok(!argv.includes('--mode'), `--mode in ${JSON.stringify(argv)}`);
}

test('a gemini_research spawn pins the Default agent mode through --settings and passes no --mode', async () => {
  const { rt, spawns } = recordingRuntime();
  const r = await rt.callTool('gemini_research', { prompt: 'a question' });
  assert.ok(!r.isError, r.text);
  assert.equal(spawns.length, 1);
  assertDefaultModePinned(spawns[0]);
});

test('every gemini_deep_research stage spawn pins the Default agent mode and passes no --mode', async () => {
  const { rt, spawns } = recordingRuntime();
  const r = await rt.callTool('gemini_deep_research', { question: 'why' });
  assert.ok(!r.isError, r.text);
  assert.ok(spawns.length >= 2, `spawned ${spawns.length}`);
  for (const argv of spawns) assertDefaultModePinned(argv);
});

test('a gemini_image spawn passes --mode accept-edits and no --settings', async () => {
  const { rt, spawns } = recordingRuntime();
  await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.ok(spawns.length >= 1, `spawned ${spawns.length}`);
  for (const argv of spawns) {
    const at = argv.indexOf('--mode');
    assert.ok(at >= 0, `no --mode in ${JSON.stringify(argv)}`);
    assert.equal(argv[at + 1], 'accept-edits');
    assert.ok(!argv.includes('--settings'), `--settings in ${JSON.stringify(argv)}`);
  }
});
