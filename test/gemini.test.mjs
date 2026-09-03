import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit, { interpretAgy, parseSubquestions, stageModels, catalog } from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const ok = (over = {}) => ({ stdout: '', stderr: '', code: 0, killed: false, ...over });
const envelope = (o) => JSON.stringify({ status: 'SUCCESS', response: 'answer', usage: { input_tokens: 10, output_tokens: 3 }, ...o });

test('interpretAgy: clean JSON turn → text + usage; envelope status drives the outcome', () => {
  const r = interpretAgy(ok({ stdout: envelope({}) }), { timeoutS: 300 });
  assert.equal(r.text, 'answer');
  assert.deepEqual(r.usage, { input: 10, output: 3 });
  const early = interpretAgy(ok({ stdout: envelope({ status: 'TIMEOUT' }) }), { timeoutS: 300 });
  assert.match(early.text, /run ended early — status=TIMEOUT/);
  assert.throws(() => interpretAgy(ok({ stdout: envelope({ status: 'TIMEOUT', response: '' }) }), { timeoutS: 300 }), /no answer \(status=TIMEOUT\)/);
});

test('interpretAgy: a successful answer ABOUT quotas is never misread as exhaustion', () => {
  const r = interpretAgy(ok({ stdout: envelope({ response: 'RESOURCE_EXHAUSTED means the quota was exceeded' }) }), { timeoutS: 300 });
  assert.match(r.text, /RESOURCE_EXHAUSTED/);
});

test('interpretAgy: failed turns — quota, hard-kill, silent stderr-only, non-zero exit', () => {
  assert.throws(() => interpretAgy(ok({ stdout: '', stderr: 'RESOURCE_EXHAUSTED', code: 1 }), { timeoutS: 300 }), /quota exhausted/);
  assert.throws(() => interpretAgy(ok({ stdout: envelope({}), killed: true }), { timeoutS: 300 }), /hard-killed after 360s/);
  assert.throws(() => interpretAgy(ok({ stdout: '', stderr: 'a tool required the "read_url" permission' }), { timeoutS: 300 }), /produced no output: a tool required/);
  assert.throws(() => interpretAgy(ok({ stdout: '', stderr: 'boom', code: 2 }), { timeoutS: 300 }), /agy exited 2: boom/);
});

test('interpretAgy: non-JSON stdout fails OPEN to the raw text', () => {
  const r = interpretAgy(ok({ stdout: 'plain old answer' }), { timeoutS: 300 });
  assert.equal(r.text, 'plain old answer');
  assert.equal(r.usage, null);
});

test('parseSubquestions extracts and caps the first string array', () => {
  assert.deepEqual(parseSubquestions('here: ["a", "b", "c"] done', 2), ['a', 'b']);
  assert.deepEqual(parseSubquestions('{"subquestions":["x"]}', 3), ['x']);
  assert.equal(parseSubquestions('nothing', 3), null);
});

test('stageModels picks by catalog shape so a generation sweep never strands an id', () => {
  const s = stageModels(catalog);
  assert.ok(catalog.isAllowedModel(s.decompose));
  assert.ok(catalog.isAllowedModel(s.synth));
  assert.match(s.decompose, /Flash \(Medium\)$/);
  assert.match(s.synth, /Flash \(High\)$/);
  assert.deepEqual(stageModels(catalog, 'X'), { decompose: 'X', gather: 'X', synth: 'X' });
});

test('unit contract: four tools, billing scrub list, both modes declared', () => {
  assert.deepEqual(unit.tools.map((t) => t.name), ['gemini_research', 'gemini_image', 'gemini_models', 'gemini_deep_research']);
  assert.ok(unit.billingRiskEnv.includes('GEMINI_API_KEY') && unit.billingRiskEnv.includes('ANTHROPIC_API_KEY'));
  assert.deepEqual(unit.supportedModes, { 'read-only': true, 'workspace-write': true });
  assert.equal(catalog.efforts.length, 0);
});

test('runtime with a fake agy: argv per mode — research standard, workspace-write accept-edits, image always accept-edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-'));
  const fake = join(dir, 'fake-agy.mjs');
  writeFileSync(fake, 'process.stdout.write(JSON.stringify({status:"SUCCESS",response:"ARGS "+process.argv.slice(2).join(" ")}))');
  const wrap = (env) => createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { model: catalog.ids[2], timeoutS: 120 } } }));
  const base = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };

  const ro = await wrap(base).callTool('gemini_research', { prompt: 'q' });
  assert.match(ro.text, /--output-format json/);
  assert.match(ro.text, /--print-timeout 120s/);
  assert.match(ro.text, new RegExp(`--model ${catalog.ids[2].replace(/[()]/g, '\\$&')}`));
  assert.doesNotMatch(ro.text, /--mode /);

  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { mode: 'workspace-write' } } }));
  const { utimesSync } = await import('node:fs');
  utimesSync(join(dir, 'fleet.config.json'), new Date(), new Date(Date.now() + 5000));
  const closed = await wrap(base).callTool('gemini_research', { prompt: 'q' });
  assert.doesNotMatch(closed.text, /--mode accept-edits/);
  const open = await wrap({ ...base, OMELETTE_ALLOW_WRITE: 'gemini' }).callTool('gemini_research', { prompt: 'q' });
  assert.match(open.text, /--mode accept-edits/);

  const img = await wrap(base).callTool('gemini_image', { prompt: 'a cat' });
  assert.match(img.text, /--mode accept-edits/);
});
