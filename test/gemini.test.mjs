import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
  assert.throws(() => interpretAgy(ok({ stdout: '', killed: true }), { timeoutS: 300 }), /hard-killed after 360s/);
  assert.throws(() => interpretAgy(ok({ stdout: '', stderr: 'a tool required the "read_url" permission' }), { timeoutS: 300 }), /produced no output: a tool required/);
  assert.throws(() => interpretAgy(ok({ stdout: '', stderr: 'boom', code: 2 }), { timeoutS: 300 }), /agy exited 2: boom/);
});

test('interpretAgy: a hard kill with a captured answer returns it under a partial marker', () => {
  const r = interpretAgy(ok({ stdout: envelope({}), code: null, killed: true }), { timeoutS: 300 });
  assert.equal(r.partial, true);
  assert.match(r.text, /^answer/);
  assert.match(r.text, /\[gemini: hard-killed after 360s — treat the answer as partial; raise gemini\.timeoutS in the fleet config\]/);
  assert.deepEqual(r.usage, { input: 10, output: 3 });
  // Non-JSON stdout is salvaged the same way the clean path reads it.
  assert.match(interpretAgy(ok({ stdout: 'plain half answer', code: null, killed: true }), { timeoutS: 300 }).text, /^plain half answer/);
  // Nothing captured: still an error, and quota exhaustion still wins over it.
  assert.throws(() => interpretAgy(ok({ stdout: '   ', code: null, killed: true }), { timeoutS: 300 }), /hard-killed after 360s/);
  assert.throws(() => interpretAgy(ok({ stdout: envelope({}), stderr: 'RESOURCE_EXHAUSTED', code: null, killed: true }), { timeoutS: 300 }), /quota exhausted/);
});

test('interpretAgy: a non-zero exit WITH text keeps the text under a partial marker', () => {
  const r = interpretAgy(ok({ stdout: envelope({}), code: 1, stderr: 'wobble' }), { timeoutS: 300 });
  assert.match(r.text, /^answer/);
  assert.match(r.text, /\[gemini: CLI exited 1 — treat the answer as partial\]/);
  // Both annotations land when the turn also reported a non-SUCCESS status.
  const both = interpretAgy(ok({ stdout: envelope({ status: 'TIMEOUT' }), code: 1 }), { timeoutS: 300 });
  assert.match(both.text, /run ended early — status=TIMEOUT/);
  assert.match(both.text, /CLI exited 1/);
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
  writeFileSync(fake, 'process.stdout.write(JSON.stringify({status:"SUCCESS",response:"ARGS "+process.argv.slice(2).join(" ")+" CWD "+process.cwd()}))');
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

  // Every spawn disables slash-command / skill expansion of the prompt text.
  assert.match(ro.text, /--disable-slash-commands/);

  const img = await wrap(base).callTool('gemini_image', { prompt: 'a cat' });
  assert.match(img.text, /--mode accept-edits/);
  assert.match(img.text, /--disable-slash-commands/);
  // The prompt that actually reaches agy carries the "no shell" hardening: the
  // first live image call was lost to the model reaching for the `command`
  // tool, which headless agy auto-denies (2026-09-03).
  assert.match(img.text, /Use ONLY your built-in image generation tool and save the image directly with it\./);
  assert.match(img.text, /Do NOT run terminal commands — they are unavailable\./);
  // F8: the image run gets its OWN temp cwd, so even a cwd-relative save by agy
  // lands outside every project — never in whatever repo the server was started in.
  const imgCwd = /CWD (.+)$/.exec(img.text)[1];
  assert.ok(imgCwd.startsWith(realpathSync(tmpdir())), `${imgCwd} is not under ${realpathSync(tmpdir())}`);
  assert.match(imgCwd, /omelette-gemini-image-/);
  assert.notEqual(imgCwd, process.cwd());
  // Research keeps the process cwd — only image runs are relocated.
  assert.match(ro.text, new RegExp(`CWD ${realpathSync(process.cwd())}$`));

  const noPrompt = await wrap(base).callTool('gemini_research', { prompt: '  ' });
  assert.equal(noPrompt.isError, true);
});
