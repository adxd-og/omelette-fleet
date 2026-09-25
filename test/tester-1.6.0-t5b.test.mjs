/**
 * omelette-fleet :: test/tester-1.6.0-t5b.test.mjs
 * Clean-context tester for 1.6.0 Task 5b ("Grok 4.7 in the catalog, and
 * `doctor` compares the CLI's default with the catalog"). Written against
 * the plan section (docs/superpowers/plans/2026-09-25-1.6.0-result-truth.md,
 * "Task 5b", Steps 2-4), NOT against the coder's own test
 * (test/tester-1.6.0-r5b.test.mjs) — this file covers what that one does
 * not: the live runtime path (tools/list enum, a rejected model, buildArgs),
 * exact-string comparison against the plan's printed text, doctor's
 * escaping and the two negative cases (a non-'in' probe, and the units that
 * never report a default), and the docs grep the plan's Step 4 promises.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import unit, { buildArgs, catalog } from '../units/grok/adapter.mjs';
import { GROK_MODELS, ALLOWLIST } from '../units/grok/models.js';
import { createUnitRuntime } from '../core/unit.mjs';
import { visible } from '../core/log.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const PLAN = join(ROOT, 'docs/superpowers/plans/2026-09-25-1.6.0-result-truth.md');

/** A fresh OMELETTE_HOME dir + env for createUnitRuntime. */
function rtEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t5b-unit-'));
  return { dir, env: { ...process.env, OMELETTE_HOME: dir, ...extra } };
}

// --- 1. grok_models through the runtime -----------------------------------

test('grok_models (the runtime catalog tool): 4.7 first, then build-fast, then 4.6, never 4.5; GUIDE starts right', async () => {
  const { env } = rtEnv({ GROK_BIN: process.execPath }); // never spawned: catalog is a local read
  const rt = createUnitRuntime(unit, { env });
  const r = await rt.callTool('grok_models', {});
  assert.equal(r.isError, undefined, r.text);
  const text = r.text;
  const i47 = text.search(/^• grok-4\.7 {2}\[/m);
  const iFast = text.search(/^• grok-4\.7-build-fast {2}\[/m);
  const i46 = text.search(/^• grok-4\.6 {2}\[/m);
  assert.ok(i47 >= 0 && iFast >= 0 && i46 >= 0, text);
  assert.ok(i47 < iFast && iFast < i46, `expected 4.7 < build-fast < 4.6, got ${i47}, ${iFast}, ${i46}`);
  assert.doesNotMatch(text, /grok-4\.5/);
  assert.match(text, /GUIDE: grok-4\.7 \(released 2026-09-21, the CLI default/);
});

// --- 2. tools/list model enum + a rejected model never spawns -------------

test('tools/list: grok_research/grok_code_review model enum is exactly the three ids', () => {
  const { env } = rtEnv({ GROK_BIN: process.execPath });
  const rt = createUnitRuntime(unit, { env });
  for (const name of ['grok_research', 'grok_code_review']) {
    const tool = rt.tools.find((t) => t.name === name);
    assert.ok(tool, `${name} missing from tools/list`);
    assert.deepEqual(tool.inputSchema.properties.model.enum, ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6']);
  }
});

test('a call with model: "grok-4.5" is refused before any spawn, naming the allowed ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t5b-reject-'));
  const sentinel = join(dir, 'spawned');
  const fake = join(dir, 'fake-grok');
  // Loud on purpose: if the model gate ever let this through, the test fails
  // on the sentinel file, not just on the tool text.
  writeFileSync(fake, [
    `#!${process.execPath}`,
    `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'spawned');`,
    "console.error('FAKE GROK SPAWNED — the model gate did not hold');",
    'process.exit(1);',
  ].join('\n'));
  chmodSync(fake, 0o755);
  const rt = createUnitRuntime(unit, { env: { ...process.env, OMELETTE_HOME: dir, GROK_BIN: fake } });
  const r = await rt.callTool('grok_research', { prompt: 'q', model: 'grok-4.5' });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'Error: unknown model "grok-4.5". Allowed: grok-4.7, grok-4.7-build-fast, grok-4.6. Call grok_models for guidance.');
  assert.equal(existsSync(sentinel), false, 'the fake grok must never have been spawned');
});

// --- 3. buildArgs threads an explicit build-fast id through ----------------

test('buildArgs: an explicit grok-4.7-build-fast model lands verbatim after --model', () => {
  const a = buildArgs({ prompt: 'p', model: 'grok-4.7-build-fast', tools: 'web_search,web_fetch', maxTurns: 30 });
  assert.equal(a[a.indexOf('--model') + 1], 'grok-4.7-build-fast');
});

// --- 4. every number in the 4.7 / build-fast entries is what the plan printed

/** The two full JS object literals the plan's Step 2 fence gives for 4.7 and
 * 4.7-build-fast (the 4.6 object there carries a non-JS placeholder for
 * `avoid` and is checked separately, against git history). Evaluating the
 * plan's own source — rather than retyping it — rules out a transcription
 * mistake in this test standing in for one in the catalog. */
function planGrokModels() {
  const planSrc = readFileSync(PLAN, 'utf8');
  const fence = planSrc.match(/`GROK_MODELS` becomes, in this order:\n\n```js\n([\s\S]*?)\n```/);
  assert.ok(fence, 'Task 5b Step 2 GROK_MODELS code fence not found in the plan — has the plan moved?');
  const body = fence[1];
  const cut = body.indexOf("  {\n    id: 'grok-4.6'");
  assert.ok(cut > 0, 'could not isolate the grok-4.6 placeholder object in the plan fence');
  // eslint-disable-next-line no-new-func
  return new Function(`return [${body.slice(0, cut)}]`)();
}

/** Fix round B (2026-09-26) superseded four of the plan's strings on review
 * findings: the effort default (B9), build-fast's price (B8), the 4.7 effort
 * labels (B21) and the 4.7 AA-Omniscience figures (B22). Applied to the plan's
 * text here, so every other byte is still compared against what it printed. */
const FIX_ROUND_B = [
  ["effort: 'Medium',", "effort: 'High',"],
  ["Grok Build only: not on the public API and not on docs.x.ai's price list, so no per-token price is published. ",
    'Cursor and Grok Build only (not on the public xAI API); priced at $4 in / $1 cached / $12 out per Mtok under 200K prompt tokens, $6 / $1.50 / $18 above (docs.x.ai/developers/pricing, "Grok 4.7 Fast pricing", read 2026-09-26). '],
  ["xAI's own table against 4.6 (high effort):",
    "xAI's own table against 4.6 (Grok 4.7 at xhigh against Grok 4.6 at high; DeepSWE's 71.0% is the one high-effort figure):"],
  ['AA Intelligence Index 46 on v4.3.2 (read', 'AA Intelligence Index 46 (xhigh) on v4.3.2 (read'],
  ['no AA-Omniscience figure for 4.7 was verified when this entry was written (2026-09-25); until one is, the 4.6 measurement stands (roughly one wrong factual answer in three) and the "never a sole source" rule with it. ',
    'AA-Omniscience lists 4.7 at 47.5% accuracy / 29.3% hallucination at xhigh (47.8% / 32.4% at high; index 32.0 / 30.9; artificialanalysis.ai/models/grok-4-7, read 2026-09-26), better than 4.6\'s 34.3% and still roughly one wrong factual answer in three: the "never a sole source" rule stands. '],
];
const afterFixRoundB = (m) => {
  const out = { ...m };
  for (const k of ['effort', 'useFor', 'avoid']) {
    for (const [from, to] of FIX_ROUND_B) {
      const probe = k === 'effort' ? `effort: '${out[k]}',` : out[k];
      const next = probe.split(from).join(to);
      out[k] = k === 'effort' ? /effort: '(.*)',/.exec(next)[1] : next;
    }
  }
  return out;
};

test('the plan Step 2 text: grok-4.7 and grok-4.7-build-fast useFor/avoid equal the catalog exactly (after fix round B)', () => {
  const planned = planGrokModels().map(afterFixRoundB);
  assert.deepEqual(planned.map((m) => m.id), ['grok-4.7', 'grok-4.7-build-fast']);
  for (const p of planned) {
    const actual = GROK_MODELS.find((m) => m.id === p.id);
    assert.ok(actual, `${p.id} missing from units/grok/models.js`);
    assert.equal(actual.label, p.label, `${p.id} label`);
    assert.equal(actual.family, p.family, `${p.id} family`);
    assert.equal(actual.effort, p.effort, `${p.id} effort`);
    assert.equal(actual.tier, p.tier, `${p.id} tier`);
    assert.equal(actual.useFor, p.useFor, `${p.id} useFor`);
    assert.equal(actual.avoid, p.avoid, `${p.id} avoid`);
  }
});

test('grok-4.6 avoid is byte-identical to what it was at 0e1e5f7 (untouched, per Step 2)', () => {
  const oldSrc = execFileSync('git', ['show', '0e1e5f7:units/grok/models.js'], { cwd: ROOT, encoding: 'utf8' });
  const m = oldSrc.match(/id: 'grok-4\.6',[\s\S]*?avoid:\n([\s\S]*?)\n  \},/);
  assert.ok(m, "could not find grok-4.6's avoid block at 0e1e5f7");
  // eslint-disable-next-line no-new-func
  const oldAvoid = new Function(`return [${m[1]}][0]`)();
  const cur = GROK_MODELS.find((mo) => mo.id === 'grok-4.6').avoid;
  assert.equal(cur, oldAvoid);
});

// --- 5. doctor: escaping, a probe that never reaches 'in', and the units --
// --    that never report a default -----------------------------------------

/** A fake vendor CLI: `models` and `login status` each answer with the given
 * text/exit code; everything else errors loudly. Mirrors the fixture style
 * of test/cli.test.mjs and the coder's test/tester-1.6.0-r5b.test.mjs. */
function fakeBin(dir, name, { modelsOut = 'model-a\nmodel-b\n', modelsCode = 0, loginOut = 'Logged in using ChatGPT\n', loginStream = 'stderr', loginCode = 0 } = {}) {
  const p = join(dir, name);
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    `if (a[0] === 'models') { process.stdout.write(${JSON.stringify(modelsOut)}); process.exit(${modelsCode}); }`,
    `if (a[0] === 'login' && a[1] === 'status') { process.${loginStream}.write(${JSON.stringify(loginOut)}); process.exit(${loginCode}); }`,
    "console.error('unexpected argv: ' + a.join(' '));",
    'process.exit(1);',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** doctor with a fresh fleet home; slices the per-unit blocks out of stdout
 * the same way as the plan's own fixture (gemini, then grok, then codex). */
function runDoctor(env) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t5b-doctor-'));
  const r = spawnSync(process.execPath, [BIN, 'doctor'], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  const out = r.stdout || '';
  const iG = out.indexOf('── gemini');
  const iK = out.indexOf('── grok');
  const iC = out.indexOf('── codex');
  return {
    out, err: r.stderr || '',
    gemini: iG >= 0 ? out.slice(iG, iK >= 0 ? iK : undefined) : '',
    grok: iK >= 0 ? out.slice(iK, iC >= 0 ? iC : undefined) : '',
    codex: iC >= 0 ? out.slice(iC) : '',
  };
}

test('doctor: a CLI default holding control characters is printed through visible(), never raw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t5b-esc-'));
  const value = 'grok-4.7\u001b[31m';
  const grok = fakeBin(dir, 'fake-grok', { modelsOut: `Default model: ${value}\n\nAvailable models:\n  * ${value} (default)\n` });
  const gone = join(dir, 'no-such');
  const r = runDoctor({ AGY_BIN: gone, GROK_BIN: grok, CODEX_BIN: gone });
  assert.ok(r.grok.includes(`CLI default ${visible(value)} — NOT in the catalog`), r.grok);
  assert.ok(!r.out.includes('\u001b['), 'doctor must never print a raw ANSI escape to the terminal');
});

test('doctor: a grok "models" call that exits non-zero (even with a Default model line) prints no models line — the probe is not "in"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t5b-nonzero-'));
  const grok = fakeBin(dir, 'fake-grok', {
    modelsOut: 'Default model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n',
    modelsCode: 1,
  });
  const gone = join(dir, 'no-such');
  const r = runDoctor({ AGY_BIN: gone, GROK_BIN: grok, CODEX_BIN: gone });
  assert.doesNotMatch(r.grok, /^  models /m, r.grok);
});

test('doctor: codex and gemini never print a models line, even when their probe output contains the words "Default model:"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t5b-others-'));
  const sneaky = 'Default model: sneaky\n';
  const agy = fakeBin(dir, 'fake-agy', { modelsOut: `model-a\n${sneaky}` });
  const codex = fakeBin(dir, 'fake-codex', { loginOut: `Logged in using ChatGPT\n${sneaky}`, loginStream: 'stderr' });
  const grokGone = join(dir, 'no-such-grok');
  const r = runDoctor({ AGY_BIN: agy, GROK_BIN: grokGone, CODEX_BIN: codex });
  assert.doesNotMatch(r.gemini, /^  models /m, r.gemini);
  assert.doesNotMatch(r.codex, /^  models /m, r.codex);
});

// --- 6. docs: the Step 4 grep --------------------------------------------

test('docs: no live mention of grok-4.5 outside CHANGELOG/superpowers; ORCHESTRATION names build-fast and the 4.6 fallback', () => {
  const r = spawnSync('grep', ['-rn', 'grok-4\\.5', 'docs', 'README.md'], { cwd: ROOT, encoding: 'utf8' });
  // grep exit 1 = no matches, which is an acceptable outcome too.
  const lines = (r.stdout || '').split('\n').filter(Boolean);
  const live = lines.filter((l) => !l.startsWith('docs/superpowers/') && !/CHANGELOG\.md:/.test(l));
  assert.deepEqual(live, [], `unexpected live grok-4.5 mention(s):\n${live.join('\n')}`);

  const orch = readFileSync(join(ROOT, 'docs/ORCHESTRATION.md'), 'utf8');
  assert.match(orch, /grok-4\.7-build-fast/);
  assert.match(orch, /grok-4\.6.*fallback/);
});
