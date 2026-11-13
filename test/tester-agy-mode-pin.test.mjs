import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const ok = (response) => ({ stdout: JSON.stringify({ status: 'SUCCESS', response }), stderr: '', code: 0, signal: null, killed: false, capped: false });

/** Runtime with a recording spawn; `answer(n, argv)` is the reply to the n-th spawn. */
function rt({ config = {}, env = {}, answer } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-tester-mode-pin-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30, ...config } } }));
  const spawns = [];
  const stub = (o) => {
    spawns.push(o.args);
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (answer) return Promise.resolve(answer(spawns.length, o.args));
    if (/Decompose the following research question/.test(prompt)) {
      return Promise.resolve({ ...ok('{"subquestions":["a","b"]}'), stdout: JSON.stringify({ status: 'SUCCESS', response: '{}', structured_output: { subquestions: ['a', 'b'] } }) });
    }
    return Promise.resolve(ok('answer'));
  };
  const runtime = createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub }) } : t)) },
    { env: { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath, OMELETTE_ALLOW_WRITE: '', ORION_ALLOW_GEMINI_MUTATE: '', ...env } },
  );
  return { runtime, spawns, dir };
}

function assertPinned(argv) {
  const at = argv.indexOf('--settings');
  assert.ok(at >= 0, `no --settings in ${JSON.stringify(argv)}`);
  assert.deepEqual(JSON.parse(argv[at + 1]), { agentMode: '' });
  assert.ok(!argv.includes('--mode'), `--mode in ${JSON.stringify(argv)}`);
}

function assertAcceptEdits(argv) {
  const at = argv.indexOf('--mode');
  assert.ok(at >= 0, `no --mode in ${JSON.stringify(argv)}`);
  assert.equal(argv[at + 1], 'accept-edits');
  assert.ok(!argv.includes('--settings'), `--settings in ${JSON.stringify(argv)}`);
}

test('research under an open ceiling with a cwd: accept-edits and no --settings', async () => {
  const { runtime, spawns, dir } = rt({ config: { mode: 'workspace-write' }, env: { OMELETTE_ALLOW_WRITE: 'gemini' } });
  await runtime.callTool('gemini_research', { prompt: 'q', cwd: dir });
  assert.equal(spawns.length, 1);
  assertAcceptEdits(spawns[0]);
});

test('research under an open ceiling WITHOUT a cwd stays read-only: pinned', async () => {
  const { runtime, spawns } = rt({ config: { mode: 'workspace-write' }, env: { OMELETTE_ALLOW_WRITE: 'gemini' } });
  await runtime.callTool('gemini_research', { prompt: 'q' });
  assert.equal(spawns.length, 1);
  assertPinned(spawns[0]);
});

test('read-only research with a cwd — the run that sits in a project — is pinned and never accept-edits', async () => {
  const { runtime, spawns, dir } = rt();
  await runtime.callTool('gemini_research', { prompt: 'q', cwd: dir });
  assert.equal(spawns.length, 1);
  assertPinned(spawns[0]);
});

test('deep research with an explicit model: decompose (schema), every gather and the synthesis are pinned', async () => {
  const { runtime, spawns } = rt();
  const model = unit.catalog.ids[1];
  const r = await runtime.callTool('gemini_deep_research', { question: 'why', model });
  assert.ok(!r.isError, r.text);
  // decompose + two gathers + synthesis
  assert.equal(spawns.length, 4, `spawned ${spawns.length}`);
  assert.ok(spawns[0].includes('--json-schema'), 'the first stage is the schema stage');
  for (const argv of spawns) {
    assertPinned(argv);
    assert.equal(argv[argv.indexOf('--model') + 1], model);
  }
});

test('the pin never displaces the prompt: -p is followed by the prompt itself on every research spawn', async () => {
  const { runtime, spawns } = rt();
  await runtime.callTool('gemini_research', { prompt: 'where does the prompt sit' });
  assert.equal(spawns.length, 1);
  const argv = spawns[0];
  assert.match(argv[argv.indexOf('-p') + 1], /where does the prompt sit/);
  assertPinned(argv);
});
