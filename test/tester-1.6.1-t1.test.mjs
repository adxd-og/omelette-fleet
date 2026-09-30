/**
 * omelette-fleet :: test/tester-1.6.1-t1.test.mjs
 * The tester's tests for 1.6.1 Task 1 (the Codex GPT-6 catalog, the effort
 * policy of the unit, doctor's codex `models` line), written from the spec and
 * the plan, not from the implementation: they cover what
 * test/codex-catalog-1.6.1.test.mjs does not — the argv a CALL actually sends
 * the CLI, the refusals before any spawn, doctor's line against what the
 * runtime really pins, the probe's failure modes, `--probe-models` order,
 * `codex_models` output, and the docs / catalog sweeps.
 *
 * Every codex here is a fake under a temp dir (CODEX_BIN), OMELETTE_HOME is a
 * temp dir, and nothing spawns the real CLI or reads the real ~/.omelette.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import unit from '../units/codex/adapter.mjs';
import { CODEX_MODELS, ALLOWLIST, EFFORTS, GUIDE, isAllowedModel } from '../units/codex/models.js';
import { createUnitRuntime } from '../core/unit.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'codex-debug-models.json');
const HEAD = 'gpt-6.1-sol';
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const find = (id) => CODEX_MODELS.find((m) => m.id === id);

// --- the fake codex ----------------------------------------------------------
//
// One script, driven by spec.json next to it, logging every invocation (argv
// and the four env names that must never reach it) to calls.log:
//   --version                 -> codex-cli 0.159.2
//   login status              -> stderr text + exit code, or a sleep past doctor's 20 s
//   debug models --bundled    -> drains stdin to EOF (an open stdin would hang into the
//                                20 s kill), then prints debug-out.txt; optional sleep
//   exec ...                  -> JSONL answer, or a turn.failed for spec.rejectModels
const FAKE = [
  `#!${process.execPath}`,
  "const fs = require('fs');",
  "const path = require('path');",
  "const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'spec.json'), 'utf8'));",
  'const a = process.argv.slice(2);',
  "const cmd = a[0] === 'exec' ? 'exec' : a.join(' ');",
  'const seen = {};',
  "for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_EXEC_SERVER_URL', 'GH_TOKEN']) seen[k] = process.env[k] === undefined ? null : process.env[k];",
  "fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify({ cmd, argv: a, env: seen }) + '\\n');",
  'function main() {',
  "  if (a[0] === '--version') { console.log('codex-cli 0.159.2'); process.exit(0); }",
  "  if (a[0] === 'login' && a[1] === 'status') {",
  '    if (spec.loginSleepMs) { setTimeout(() => process.exit(0), spec.loginSleepMs); return; }',
  "    process.stderr.write(spec.loginOut === undefined ? 'Logged in using ChatGPT\\n' : spec.loginOut);",
  '    process.exit(spec.loginExit || 0);',
  '  }',
  "  if (cmd === 'debug models --bundled') {",
  "    process.stdin.on('data', () => {}).on('end', () => {",
  '      if (spec.debugSleepMs) { setTimeout(() => process.exit(0), spec.debugSleepMs); return; }',
  '      if (spec.debugErr) process.stderr.write(spec.debugErr);',
  "      process.stdout.write(fs.readFileSync(path.join(__dirname, 'debug-out.txt'), 'utf8'));",
  '      process.exitCode = spec.debugExit || 0;',
  '    });',
  '    process.stdin.resume();',
  '    return;',
  '  }',
  "  if (a[0] === 'exec') {",
  "    process.stdin.on('data', () => {}).on('end', () => {",
  "      const m = a[a.indexOf('-m') + 1];",
  "      const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
  "      line({ type: 'thread.started', thread_id: 't' }); line({ type: 'turn.started' });",
  '      if ((spec.rejectModels || []).includes(m)) {',
  "        const msg = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: \"The '\" + m + \"' model is not supported when using Codex with a ChatGPT account.\" } });",
  "        line({ type: 'turn.failed', error: { message: msg } });",
  '        process.exitCode = 1;',
  '        return;',
  '      }',
  "      line({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'OK' } });",
  "      line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });",
  '    });',
  '    process.stdin.resume();',
  '    return;',
  '  }',
  "  console.error('unexpected argv: ' + a.join(' '));",
  '  process.exit(1);',
  '}',
  'main();',
].join('\n');

/** A fresh fake-codex station: its own dir doubles as OMELETTE_HOME and HOME. */
function station(spec = {}, debugOut = '') {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t161-'));
  const bin = join(dir, 'fake-codex');
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
  writeFileSync(join(dir, 'debug-out.txt'), debugOut);
  const calls = () => (existsSync(join(dir, 'calls.log'))
    ? readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  return { dir, bin, calls, execs: () => calls().filter((c) => c.cmd === 'exec') };
}

const argAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];
const effortArg = (argv) => (argv.find((x) => typeof x === 'string' && x.startsWith('model_reasoning_effort=')) || null);

/** A unit runtime over the station, with a clean env (nothing of the operator's leaks into the config). */
function runtimeOn(st, { config, env = {} } = {}) {
  if (config) writeFileSync(join(st.dir, 'fleet.config.json'), JSON.stringify(config));
  return createUnitRuntime(unit, {
    env: { PATH: process.env.PATH, HOME: st.dir, OMELETTE_HOME: st.dir, OMELETTE_UPDATE_CHECK: '0', CODEX_BIN: st.bin, ...env },
  });
}

// --- doctor harness ----------------------------------------------------------

function doctorEnv(st, env = {}) {
  const gone = join(st.dir, 'no-such');
  return {
    PATH: process.env.PATH, HOME: st.dir, OMELETTE_HOME: st.dir, OMELETTE_UPDATE_CHECK: '0',
    AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: st.bin,
    // The keys that must never reach a probe: billing keys, the exec-server URL, an unrelated secret.
    OPENAI_API_KEY: 'sk-must-not-reach', CODEX_API_KEY: 'ck-must-not-reach',
    CODEX_EXEC_SERVER_URL: 'http://leak.invalid', GH_TOKEN: 'ghp-must-not-reach',
    ...env,
  };
}

const blocks = (out) => {
  const at = out.indexOf('── codex (');
  const probeAt = out.indexOf('── codex model probe');
  return {
    codex: at < 0 ? '' : out.slice(at, probeAt > at ? probeAt : undefined),
    probe: probeAt < 0 ? '' : out.slice(probeAt),
  };
};

function doctor(st, { args = [], env = {}, config } = {}) {
  if (config) writeFileSync(join(st.dir, 'fleet.config.json'), JSON.stringify(config));
  const r = spawnSync(process.execPath, [BIN, 'doctor', ...args], { cwd: st.dir, encoding: 'utf8', env: doctorEnv(st, env), timeout: 120000 });
  const out = r.stdout || '';
  return { status: r.status, out, err: r.stderr || '', ...blocks(out) };
}

function doctorAsync(st, { args = [], env = {} } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [BIN, 'doctor', ...args], { cwd: st.dir, env: doctorEnv(st, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (status) => resolve({ status, out, err, ms: Date.now() - t0, ...blocks(out) }));
  });
}

const fixtureModels = () => JSON.parse(readFileSync(FIXTURE, 'utf8')).models;
const entry = (slug, priority, visibility = 'list') => ({ slug, visibility, priority, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }] });
const MODELS_LINE = /^ {2}models {6}.*$/gm;

// =============================================================================
// 1. A call through the unit: what reaches the CLI
// =============================================================================

test('a call that names no model and no effort reaches the CLI with -m gpt-6.1-sol and model_reasoning_effort="xhigh" — research and review alike', async () => {
  const st = station();
  const rt = runtimeOn(st);
  const r1 = await rt.callTool('codex_research', { prompt: 'hello' });
  assert.ok(!r1.isError, r1.text);
  const r2 = await rt.callTool('codex_code_review', { prompt: 'look', cwd: st.dir });
  assert.ok(!r2.isError, r2.text);
  const execs = st.execs();
  assert.equal(execs.length, 2);
  for (const c of execs) {
    assert.equal(argAfter(c.argv, '-m'), HEAD, c.argv.join(' '));
    assert.equal(effortArg(c.argv), 'model_reasoning_effort="xhigh"', c.argv.join(' '));
    assert.ok(c.argv.includes('--ignore-user-config') && c.argv.includes('--ignore-rules'));
    assert.ok(!c.argv.some((x) => /dangerously/.test(x)));
  }
});

test('the spooled result of a default call is filed under gpt-6.1-sol at xhigh (the record carries its own model and effort lines)', async () => {
  const st = station();
  const rt = runtimeOn(st);
  const r = await rt.callTool('codex_research', { prompt: 'file me' });
  assert.ok(!r.isError, r.text);
  const env = { PATH: process.env.PATH, HOME: st.dir, OMELETTE_HOME: st.dir, OMELETTE_UPDATE_CHECK: '0' };
  const list = spawnSync(process.execPath, [BIN, 'results', 'codex'], { encoding: 'utf8', env });
  assert.equal(list.status, 0, list.stdout + list.stderr);
  const id = (list.stdout.match(/^(\d{8}T\d{6}Z-\d+-\d+)\s/m) || [])[1];
  assert.ok(id, list.stdout);
  const shown = spawnSync(process.execPath, [BIN, 'results', 'codex', id], { encoding: 'utf8', env });
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.match(shown.stdout, /^model: gpt-6\.1-sol$/m, shown.stdout);
  assert.match(shown.stdout, /^effort: xhigh$/m, shown.stdout);
});

test('an explicit effort:"ultra" is accepted and sent verbatim; upper case is normalised', async () => {
  const st = station();
  const rt = runtimeOn(st);
  for (const e of ['ultra', 'ULTRA', ' Ultra ']) {
    const r = await rt.callTool('codex_research', { prompt: 'deep', effort: e });
    assert.ok(!r.isError, `${e}: ${r.text}`);
  }
  const execs = st.execs();
  assert.equal(execs.length, 3);
  for (const c of execs) assert.equal(effortArg(c.argv), 'model_reasoning_effort="ultra"');
});

test('an explicit effort:"none" is refused with the allowed list BEFORE any spawn; so is "minimal"', async () => {
  const st = station();
  const rt = runtimeOn(st);
  for (const e of ['none', 'NONE', 'minimal']) {
    for (const tool of ['codex_research', 'codex_code_review']) {
      const r = await rt.callTool(tool, { prompt: 'x', effort: e, cwd: st.dir });
      assert.equal(r.isError, true, `${tool} ${e}: ${r.text}`);
      assert.match(r.text, new RegExp(`unknown effort "${e.toLowerCase()}"`), r.text);
      assert.match(r.text, /Allowed: low, medium, high, xhigh, max, ultra\./, r.text);
    }
  }
  assert.deepEqual(st.calls(), [], 'the CLI was never started');
});

test('a model outside the catalog is refused before any spawn — gpt-6, gpt-6-pro, gpt-6-astra-pro, gpt-5.5', async () => {
  const st = station();
  const rt = runtimeOn(st);
  for (const id of ['gpt-6', 'gpt-6-pro', 'gpt-6-astra-pro', 'gpt-5.5']) {
    const r = await rt.callTool('codex_research', { prompt: 'x', model: id });
    assert.equal(r.isError, true, id);
    assert.match(r.text, new RegExp(`unknown model "${id}"`), r.text);
    assert.match(r.text, /Allowed: gpt-6\.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5\.6-terra, gpt-5\.6-luna, gpt-5\.6-sol\./, r.text);
  }
  assert.deepEqual(st.calls(), []);
});

test('an old 1.6.0 config (gpt-6-astra / high) keeps what it set: -m gpt-6-astra, effort "high"', async () => {
  const st = station();
  const rt = runtimeOn(st, { config: { version: 1, units: { codex: { model: 'gpt-6-astra', effort: 'high' } } } });
  const r = await rt.callTool('codex_research', { prompt: 'x' });
  assert.ok(!r.isError, r.text);
  const [c] = st.execs();
  assert.equal(argAfter(c.argv, '-m'), 'gpt-6-astra');
  assert.equal(effortArg(c.argv), 'model_reasoning_effort="high"');
});

test('a 1.6.0 config with effort:"none" (valid then, out now) never sends "none" to the CLI and does not fail the call', async () => {
  const st = station();
  const rt = runtimeOn(st, { config: { version: 1, units: { codex: { effort: 'none' } } } });
  const r = await rt.callTool('codex_research', { prompt: 'x' });
  assert.ok(!r.isError, r.text);
  const [c] = st.execs();
  assert.equal(argAfter(c.argv, '-m'), HEAD);
  assert.ok(!c.argv.some((x) => /"none"/.test(String(x))), c.argv.join(' '));
  // 1b rule 1: a refused configured value falls through to the resolved model's pairing, not to no flag.
  assert.equal(effortArg(c.argv), 'model_reasoning_effort="xhigh"');
});

test('CODEX_EFFORT=ultra sets the effort; CODEX_EFFORT=none is ignored, never forwarded', async () => {
  const a = station();
  assert.ok(!(await runtimeOn(a, { env: { CODEX_EFFORT: 'ultra' } }).callTool('codex_research', { prompt: 'x' })).isError);
  assert.equal(effortArg(a.execs()[0].argv), 'model_reasoning_effort="ultra"');
  const b = station();
  assert.ok(!(await runtimeOn(b, { env: { CODEX_EFFORT: 'none' } }).callTool('codex_research', { prompt: 'x' })).isError);
  assert.equal(effortArg(b.execs()[0].argv), 'model_reasoning_effort="xhigh"', 'a refused CODEX_EFFORT falls through to the head\'s pairing');
});

// Re-pinned by the session in 1.6.1 Task 1b (rule 1): the pairing is APPLIED since the two-pass
// tester found the "cheap tier" running at the unit's xhigh — this test used to pin the opposite.
test('a per-call model with no effort brings its catalog pairing: gpt-6-sol runs at high, not the unit built-in xhigh', async () => {
  const st = station();
  const rt = runtimeOn(st);
  const r = await rt.callTool('codex_research', { prompt: 'x', model: 'gpt-6-sol' });
  assert.ok(!r.isError, r.text);
  const [c] = st.execs();
  assert.equal(argAfter(c.argv, '-m'), 'gpt-6-sol');
  // core resolves it before the feed's start (pairedEffort: true on the codex unit).
  assert.equal(effortArg(c.argv), 'model_reasoning_effort="high"');
});

test('gpt-6-luna with effort ultra (the catalog says luna has no ultra): refused before the spawn, or sent verbatim — never silently swapped for another effort', async (t) => {
  const outcomes = [];
  for (const how of ['arg', 'config']) {
    const st = station();
    const rt = how === 'arg'
      ? runtimeOn(st)
      : runtimeOn(st, { config: { version: 1, units: { codex: { model: 'gpt-6-luna', effort: 'ultra' } } } });
    const r = how === 'arg'
      ? await rt.callTool('codex_research', { prompt: 'x', model: 'gpt-6-luna', effort: 'ultra' })
      : await rt.callTool('codex_research', { prompt: 'x' });
    const execs = st.execs();
    if (r.isError) {
      assert.equal(execs.length, 0, `${how}: an error must come before the spawn — ${r.text}`);
      outcomes.push(`${how}: refused (${r.text})`);
    } else {
      assert.equal(execs.length, 1, how);
      assert.equal(argAfter(execs[0].argv, '-m'), 'gpt-6-luna', how);
      assert.equal(effortArg(execs[0].argv), 'model_reasoning_effort="ultra"', `${how}: the effort was changed on the way`);
      outcomes.push(`${how}: passed through verbatim`);
    }
  }
  t.diagnostic(`luna + ultra -> ${outcomes.join('; ')}`);
});

test('the luna entries tell the reader ultra is not theirs: the catalog text and the tool description both say the ceiling is max', () => {
  assert.match(find('gpt-6-luna').avoid, /No `ultra` effort/);
  assert.match(find('gpt-6-luna').avoid, /ceiling is max/);
  for (const name of ['codex_research', 'codex_code_review']) {
    const desc = unit.tools.find((t) => t.name === name).inputSchema.properties.effort.description;
    assert.match(desc, /the luna tiers stop at max/, name);
    assert.match(desc, /OMIT for the fleet default/, name);
    assert.doesNotMatch(desc, /\bnone\b/, name);
  }
});

test('codex_image: no effort flag at all (built-in xhigh must not ride along), and the model is the catalog head', async () => {
  const st = station();
  const rt = runtimeOn(st);
  // The fake answers "OK" and writes no image: the call errors, but the argv is what matters here.
  await rt.callTool('codex_image', { prompt: 'a red circle' });
  const [c] = st.execs();
  assert.ok(c, 'codex_image spawned the CLI');
  assert.equal(effortArg(c.argv), null, c.argv.join(' '));
  assert.equal(argAfter(c.argv, '-m'), HEAD);
});

test('the tool schemas: effort on research and review is EFFORTS, the image tool has none, and every model enum is the seven-id allowlist in order', () => {
  const rt = createUnitRuntime(unit, { env: { PATH: process.env.PATH, OMELETTE_HOME: mkdtempSync(join(tmpdir(), 'omelette-t161-schema-')), CODEX_BIN: process.execPath } });
  for (const name of ['codex_research', 'codex_code_review']) {
    const p = rt.tools.find((x) => x.name === name).inputSchema.properties;
    assert.deepEqual(p.effort.enum, EFFORTS, name);
    assert.deepEqual(p.model.enum, ALLOWLIST, name);
    assert.match(p.model.description, /gpt-6\.1-sol \(xhigh\)=THE FLEET DEFAULT/, name);
  }
  const image = rt.tools.find((x) => x.name === 'codex_image').inputSchema.properties;
  assert.equal(image.effort, undefined);
  assert.deepEqual(image.model.enum, ALLOWLIST);
  assert.match(unit.instructions, /Default gpt-6\.1-sol at xhigh/);
  assert.match(unit.instructions, /pre-release security audit and the heaviest reviews here on gpt-6-astra/);
});

// =============================================================================
// 2. codex_models: the cheat-sheet the session reads
// =============================================================================

test('codex_models: 6.1-sol first and the only THE FLEET DEFAULT; astra is heavy and HEAVY REVIEWS ONLY; the effort line is the six levels; no "none"', async () => {
  const st = station();
  const r = await runtimeOn(st).callTool('codex_models', {});
  assert.ok(!r.isError, r.text);
  const t = r.text;
  const order = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol'].map((id) => t.indexOf(`• ${id}  [`));
  assert.ok(order.every((i) => i >= 0), `every id listed: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'listed in the guide\'s order');
  assert.match(t, /^• gpt-6\.1-sol {2}\[gpt · xhigh effort · balanced\]$/m);
  assert.match(t, /^• gpt-6-astra {2}\[gpt · xhigh effort · heavy\]$/m);
  assert.match(t, /^• gpt-6-luna {2}\[gpt · medium effort · fast\]$/m);
  assert.equal((t.match(/THE FLEET DEFAULT \(operator decision/g) || []).length, 1, 'exactly one entry claims the default');
  const astraBlock = t.slice(t.indexOf('• gpt-6-astra'), t.indexOf('• gpt-6-sol'));
  assert.match(astraBlock, /USE FOR: HEAVY REVIEWS ONLY/);
  assert.doesNotMatch(astraBlock, /THE FLEET DEFAULT/);
  assert.match(t, /^EFFORT LEVELS \(the `effort` arg\): low \| medium \| high \| xhigh \| max \| ultra$/m);
  assert.doesNotMatch(t, /\bnone\b/);
  assert.match(t, /^GUIDE: Pick by task, not by name\. gpt-6\.1-sol \(xhigh\)=THE FLEET DEFAULT/m);
  assert.match(t, /gpt-6-astra \(xhigh\)=heavy reviews only/);
  assert.ok(t.includes(GUIDE));
  assert.deepEqual(st.calls(), [], 'a catalog read spawns nothing');
});

// =============================================================================
// 3. The catalog against the CLI's own catalog (the fixture is the real 0.159.2 --bundled)
// =============================================================================

test('EFFORTS is exactly the union of the levels codex debug models lists for the catalog\'s ids; `none` is nobody\'s', () => {
  const byId = new Map(fixtureModels().map((m) => [m.slug, m]));
  const union = new Set();
  for (const id of ALLOWLIST) {
    const m = byId.get(id);
    assert.ok(m, `${id} is in the CLI's catalog`);
    for (const l of m.supported_reasoning_levels) union.add(l.effort);
  }
  assert.deepEqual([...union].sort(), [...EFFORTS].sort());
  assert.ok(!union.has('none'));
});

test('every catalog model\'s recommended effort is one its CLI entry supports; only the two lunas lack ultra, and the GPT-6 luna says so', () => {
  const byId = new Map(fixtureModels().map((m) => [m.slug, m]));
  for (const m of CODEX_MODELS) {
    const levels = byId.get(m.id).supported_reasoning_levels.map((l) => l.effort);
    assert.ok(levels.includes(m.effort), `${m.id}: ${m.effort} in ${levels}`);
  }
  const lacking = CODEX_MODELS.filter((m) => !byId.get(m.id).supported_reasoning_levels.some((l) => l.effort === 'ultra')).map((m) => m.id);
  assert.deepEqual(lacking.sort(), ['gpt-5.6-luna', 'gpt-6-luna']);
});

test('the catalog covers every model the CLI lists except gpt-5.5, which the header leaves out on purpose', () => {
  const listed = fixtureModels().filter((m) => m.visibility === 'list').map((m) => m.slug);
  const missing = listed.filter((s) => !isAllowedModel(s));
  assert.deepEqual(missing, ['gpt-5.5']);
  assert.match(read('units/codex/models.js'), /gpt-5\.5[^\n]*retiring\s*\n?[^\n]*2026-10-14/);
});

// =============================================================================
// 4. Source classes and dates on the new figures (a regex over the catalog)
// =============================================================================

const GPT6 = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];
const DATE = /\b2026-\d\d-\d\d\b/;
const METRIC = /Intelligence Index \d|tok\/s|per Index task|\$\d|\d+(?:\.\d+)? pp\b|\d+(?:\.\d+)? ?%|DeepSWE|OSWorld|AutomationBench|Terminal-Bench|ExploitBench|ExploitGym|MRCR/;
const CLASS = /\b(?:vendor|AA|probed)\b/i;
const NEGATIVE = /\bNo\b[^.]*\b(?:figure|absolute)\b|do not invent|announced, not probed/;
const sentences = (text) => String(text || '').split(/\.\s+(?=[A-Z`"])/);

test('catalog: every figure in the four GPT-6 entries names its source class — vendor, AA or probed', () => {
  const bare = [];
  for (const id of GPT6) {
    const m = find(id);
    for (const s of [...sentences(m.useFor), ...sentences(m.avoid)]) {
      if (METRIC.test(s) && !NEGATIVE.test(s) && !CLASS.test(s)) bare.push(`${id}: ${s.slice(0, 120)}`);
    }
  }
  assert.deepEqual(bare, []);
});

test('catalog: a figure that names a date in the GPT-6 entries also names a source class', () => {
  const bare = [];
  for (const id of GPT6) {
    const m = find(id);
    for (const s of [...sentences(m.useFor), ...sentences(m.avoid)]) {
      if (DATE.test(s) && METRIC.test(s) && !CLASS.test(s)) bare.push(`${id}: ${s.slice(0, 120)}`);
    }
  }
  assert.deepEqual(bare, []);
});

test('catalog: each source class an entry uses is dated in that entry — vendor by a release date, AA by "read 2026-09-30", probed by a date', () => {
  for (const id of GPT6) {
    const text = `${find(id).useFor} ${find(id).avoid}`;
    if (/\(vendor|\bvendor\b/i.test(text)) assert.match(text, /[Rr]eleased 2026-09-\d\d \(vendor\)/, `${id}: vendor figures without a dated announcement`);
    if (/\bAA\b/.test(text)) assert.match(text, /AA, read 2026-09-30/, `${id}: AA figures without their read date`);
    if (/\bprobed\b/i.test(text)) assert.match(text, /[Pp]robed[^.]*2026-09-\d\d|2026-09-\d\d[^.]*probed/i, `${id}: probed without a date`);
  }
});

test('catalog: the rollout note on 6.1-sol carries the version, the date and the plan — rejected on 0.157.1, accepted on 0.159.2, both 2026-09-30', () => {
  const m = find(HEAD);
  const text = `${m.useFor} ${m.avoid}`;
  assert.match(text, /PROBED 2026-09-30 on codex-cli 0\.159\.2, ChatGPT plan: ACCEPTED at effort low and at ultra/);
  assert.match(text, /codex-cli 0\.157\.1 REJECTED it/);
  assert.match(text, /lacked the model's metadata, not because of the plan/);
});

test('catalog: the header keeps the 2026-09-03 history of `none` and says it was superseded, instead of deleting it', () => {
  const src = read('units/codex/models.js');
  assert.match(src, /SUPERSEDED 2026-09-30 \(codex-cli 0\.159\.2\): the list is now `low`, `medium`,\s*\n \*\s+`high`, `xhigh`, `max`, `ultra`/);
  assert.match(src, /VERIFIED LIVE 2026-09-30 \(codex-cli 0\.157\.1, then 0\.159\.2/);
  assert.match(src, /THE LESSON: codex-cli 0\.159\.1 made gpt-6\.1-sol its bundled default/);
  assert.match(src, /LESSON FOR THE NEXT SWEEP: what the binary embeds is not what the API/);
});

test('catalog: the 5.6 entries lost the plan-gating and the Pro/Enterprise claim but kept their own figures', () => {
  for (const id of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol']) {
    const m = find(id);
    assert.doesNotMatch(`${m.useFor} ${m.avoid}`, /plan-gated|PLAN-GATED|Pro \/ Enterprise|Pro\/Enterprise|Pro-only|upgrade the plan/i, id);
  }
  assert.match(find('gpt-5.6-terra').useFor, /Terminal-Bench 2\.1 87\.4/);
  assert.match(find('gpt-5.6-luna').useFor, /Terminal-Bench 2\.1 84\.7/);
  assert.match(find('gpt-5.6-sol').useFor, /SWE-bench Pro 64\.6/);
});

// =============================================================================
// 5. doctor: the models line against what the runtime really pins
// =============================================================================

test('doctor names the model the runtime really pins: the line and the -m of a real call agree in every configuration, and CONFIG.md documents each label', async () => {
  const scenarios = [
    { name: 'nothing set', config: null, env: {}, pinned: HEAD, label: 'catalog head' },
    { name: 'fleet config: astra', config: { version: 1, units: { codex: { model: 'gpt-6-astra' } } }, env: {}, pinned: 'gpt-6-astra', label: 'fleet config' },
    { name: 'defaults.model luna', config: { version: 1, defaults: { model: 'gpt-6-luna' } }, env: {}, pinned: 'gpt-6-luna', label: 'fleet config' },
    { name: 'env beats file', config: { version: 1, units: { codex: { model: 'gpt-6-astra' } } }, env: { CODEX_DEFAULT_MODEL: 'gpt-6-sol' }, pinned: 'gpt-6-sol', label: 'env CODEX_DEFAULT_MODEL' },
    { name: 'config model not in the catalog', config: { version: 1, units: { codex: { model: 'gpt-4o' } } }, env: {}, pinned: HEAD, label: 'catalog head' },
    { name: 'env model not in the catalog beats a good file value', config: { version: 1, units: { codex: { model: 'gpt-6-astra' } } }, env: { CODEX_DEFAULT_MODEL: 'gpt-9-nova' }, pinned: HEAD, label: 'catalog head' },
  ];
  const config = read('docs/CONFIG.md');
  for (const s of scenarios) {
    const st = station({}, JSON.stringify({ models: fixtureModels() }));
    const d = doctor(st, { config: s.config || undefined, env: s.env });
    const m = d.codex.match(/^ {2}models {6}CLI default (\S+) — in the catalog; the fleet pins (\S+) \(([^)]+)\)$/m);
    assert.ok(m, `${s.name}: no models line\n${d.out}${d.err}`);
    assert.deepEqual([m[2], m[3]], [s.pinned, s.label], s.name);
    assert.ok(config.includes(`(${m[3]})`) || config.includes(`\`(${m[3]})\``) || config.includes(m[3]), `${s.name}: CONFIG.md does not name "${m[3]}"`);
    // The same environment, a real call: the argv is the truth doctor must match.
    const rt = runtimeOn(st, { env: s.env });
    const r = await rt.callTool('codex_research', { prompt: 'x' });
    assert.ok(!r.isError, `${s.name}: ${r.text}`);
    assert.equal(argAfter(st.execs()[0].argv, '-m'), m[2], `${s.name}: doctor says the fleet pins ${m[2]}`);
  }
});

test('doctor: the bundled probe runs `debug models --bundled` once, with stdin closed and none of the billing keys, the exec-server URL or a stray secret in its env', () => {
  const st = station({}, JSON.stringify({ models: fixtureModels() }));
  const d = doctor(st);
  assert.match(d.codex, /^ {2}models {6}CLI default gpt-6\.1-sol — /m, d.out + d.err);
  const dbg = st.calls().filter((c) => c.cmd.startsWith('debug'));
  assert.equal(dbg.length, 1);
  assert.deepEqual(dbg[0].argv, ['debug', 'models', '--bundled']);
  assert.deepEqual(dbg[0].env, { OPENAI_API_KEY: null, CODEX_API_KEY: null, CODEX_EXEC_SERVER_URL: null, GH_TOKEN: null });
  // Login and version probes are scrubbed the same way (nothing new leaks through the second process).
  for (const c of st.calls()) assert.deepEqual(c.env, { OPENAI_API_KEY: null, CODEX_API_KEY: null, CODEX_EXEC_SERVER_URL: null, GH_TOKEN: null }, c.cmd);
  assert.equal(st.execs().length, 0, 'plain doctor spawns no model run');
  assert.equal(d.status, 0);
});

test('doctor: warnings on the probe\'s stderr do not spoil a good answer on stdout', () => {
  const st = station({ debugErr: 'WARNING: proceeding, even though we could not update PATH\n' }, JSON.stringify({ models: fixtureModels() }));
  const d = doctor(st);
  assert.match(d.codex, /^ {2}models {6}CLI default gpt-6\.1-sol — in the catalog; the fleet pins gpt-6\.1-sol \(catalog head\)$/m, d.out + d.err);
});

test('doctor: JSON that parses but is not the expected shape prints no models line and changes nothing else', () => {
  const shapes = {
    'a bare array': JSON.stringify(fixtureModels()),
    'null': 'null',
    'models is an object': JSON.stringify({ models: { slug: 'gpt-6.1-sol', visibility: 'list', priority: 1 } }),
    'entries without a slug': JSON.stringify({ models: [{ visibility: 'list', priority: 1 }, { slug: '', visibility: 'list', priority: 0 }, { slug: 7, visibility: 'list', priority: 0 }] }),
    'every entry hidden': JSON.stringify({ models: fixtureModels().map((m) => ({ ...m, visibility: 'hide' })) }),
    'empty output': '',
    'BOM-prefixed JSON': `﻿${JSON.stringify({ models: fixtureModels() })}`,
  };
  for (const [label, body] of Object.entries(shapes)) {
    const st = station({}, body);
    const d = doctor(st);
    assert.equal(d.status, 0, `${label}\n${d.out}${d.err}`);
    assert.match(d.codex, /^ {2}login {7}OK — Logged in using ChatGPT$/m, label);
    assert.deepEqual(d.codex.match(MODELS_LINE) || [], [], `${label}: ${d.codex}`);
    assert.doesNotMatch(d.out, /FAULT/, label);
  }
});

test('doctor: priorities that are not numbers, and a tie — no crash, at most one line, deterministic, never NaN/undefined/null in it', (t) => {
  const named = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol'];
  const cases = {
    'all string priorities': [entry('gpt-6.1-sol', '1'), entry('gpt-6-astra', '2')],
    'null and boolean priorities': [entry('gpt-6.1-sol', null), entry('gpt-6-astra', true)],
    'a string priority next to numeric ones': [entry('gpt-6-sol', 'first'), entry('gpt-6-astra', 3), entry('gpt-6.1-sol', 2)],
    'a tie at priority 1': [entry('gpt-6-astra', 1), entry('gpt-6.1-sol', 1), entry('gpt-6-sol', 2)],
    'a tie, reversed': [entry('gpt-6.1-sol', 1), entry('gpt-6-astra', 1), entry('gpt-6-sol', 2)],
    'negative, fractional and zero priorities': [entry('gpt-6-sol', -1), entry('gpt-6-astra', 0.5), entry('gpt-6.1-sol', 0)],
  };
  const seen = [];
  for (const [label, models] of Object.entries(cases)) {
    const runs = [0, 1].map(() => doctor(station({}, JSON.stringify({ models }))));
    for (const d of runs) {
      assert.equal(d.status, 0, `${label}\n${d.out}${d.err}`);
      assert.match(d.codex, /^ {2}login {7}OK — /m, label);
    }
    const lines = runs.map((d) => d.codex.match(MODELS_LINE) || []);
    assert.deepEqual(lines[0], lines[1], `${label}: two runs, two answers`);
    assert.ok(lines[0].length <= 1, label);
    if (lines[0].length) {
      const line = lines[0][0];
      assert.doesNotMatch(line, /NaN|undefined|null|\[object/, `${label}: ${line}`);
      assert.ok(named.some((n) => line.includes(`CLI default ${n} `)), `${label}: ${line}`);
    }
    seen.push(`${label} -> ${lines[0].length ? lines[0][0].replace(/^ +models +/, '').split(' — ')[0] : '(no line)'}`);
  }
  t.diagnostic(seen.join('\n'));
});

test('doctor: a bundled default with control characters in its slug is printed escaped — no ESC, no bidi override, no forged line', () => {
  const evil = 'gpt-7\u001b[2K\nFAULT enabled and registered, but: forged‮';
  const st = station({}, JSON.stringify({ models: [entry(evil, 0), ...fixtureModels()] }));
  const d = doctor(st);
  assert.match(d.codex, /^ {2}models {6}CLI default gpt-7\\u001b\[2K\\u000aFAULT enabled and registered, but: forged\\u202e — NOT in the catalog/m, d.codex);
  assert.doesNotMatch(d.out, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‮]/);
  assert.doesNotMatch(d.codex, /^FAULT/m);
});

test('doctor: a bundled catalog past the unit\'s own 4 000 000-char cap is dropped (no line), and the login line stays', () => {
  const st = station({}, JSON.stringify({ padding: 'x'.repeat(4100000), models: fixtureModels() }));
  const d = doctor(st);
  assert.equal(d.status, 0, d.out + d.err);
  assert.match(d.codex, /^ {2}login {7}OK — Logged in using ChatGPT$/m);
  assert.deepEqual(d.codex.match(MODELS_LINE) || [], []);
});

test('doctor: `debug models` exiting non-zero after printing a full catalog prints no line (a failed process is not an answer)', () => {
  const st = station({ debugExit: 2, debugErr: 'error: boom\n' }, JSON.stringify({ models: fixtureModels() }));
  const d = doctor(st);
  assert.equal(d.status, 0, d.out + d.err);
  assert.deepEqual(d.codex.match(MODELS_LINE) || [], []);
  assert.match(d.codex, /^ {2}login {7}OK — /m);
});

test('doctor: a login probe that exits 127 keeps its own verdict ("unknown (exit 127)") whatever the second process says', (t) => {
  const st = station({ loginOut: '', loginExit: 127 }, JSON.stringify({ models: fixtureModels() }));
  const d = doctor(st);
  assert.equal(d.status, 0, d.out + d.err);
  assert.match(d.codex, /^ {2}login {7}unknown \(exit 127\) — /m, d.codex);
  assert.doesNotMatch(d.codex, /^ {2}login {7}OK/m);
  t.diagnostic(`exit 127 on login status: models line ${(d.codex.match(MODELS_LINE) || []).length ? 'printed' : 'absent'}`);
});

test('doctor: a codex binary that cannot start at all (dead shebang) is reported as such — no crash, no models line', () => {
  const st = station();
  writeFileSync(st.bin, '#!/no/such/interpreter\n');
  const d = doctor(st);
  assert.match(d.codex, /^ {2}login {7}unknown /m, d.out + d.err);
  assert.deepEqual(d.codex.match(MODELS_LINE) || [], []);
  assert.doesNotMatch(d.err, /TypeError|ReferenceError|at .*\.mjs:\d+/, d.err);
});

test('doctor: when `codex login status` hangs past 20 s the models probe never runs; when `debug models` itself hangs, the login line is intact and there is no models line', { timeout: 120000 }, async (t) => {
  const loginHang = station({ loginSleepMs: 30000 }, JSON.stringify({ models: fixtureModels() }));
  const debugHang = station({ debugSleepMs: 30000 }, JSON.stringify({ models: fixtureModels() }));
  // Both at once: each costs its 20 s kill, and they do not have to queue.
  const [a, b] = await Promise.all([doctorAsync(loginHang), doctorAsync(debugHang)]);
  t.diagnostic(`login hang: ${a.ms} ms, debug hang: ${b.ms} ms`);

  assert.equal(a.status, 0, a.out + a.err);
  assert.match(a.codex, /^ {2}login {7}unknown — codex login status: timeout \(no answer in 20s\)$/m, a.codex);
  assert.deepEqual(a.codex.match(MODELS_LINE) || [], []);
  assert.ok(!loginHang.calls().some((c) => c.cmd === 'debug models --bundled'), 'the second process was not started after a login probe that hung');

  assert.equal(b.status, 0, b.out + b.err);
  assert.match(b.codex, /^ {2}login {7}OK — Logged in using ChatGPT$/m, b.codex);
  assert.deepEqual(b.codex.match(MODELS_LINE) || [], []);
  assert.equal(debugHang.calls().filter((c) => c.cmd === 'debug models --bundled').length, 1, 'it was tried once, then killed');
  assert.ok(b.ms >= 19000 && b.ms < 60000, `one 20 s kill, not two: ${b.ms} ms`);
});

// =============================================================================
// 6. doctor --probe-models: the catalog's ids, in the catalog's order
// =============================================================================

test('doctor --probe-models probes the seven ids in the new order at effort low, goes on past a rejected head, and prints them in that order', () => {
  const st = station({ rejectModels: [HEAD] }, JSON.stringify({ models: fixtureModels() }));
  const d = doctor(st, { args: ['--probe-models'] });
  assert.equal(d.status, 0, d.out + d.err);
  const execs = st.execs();
  assert.deepEqual(execs.map((c) => argAfter(c.argv, '-m')), ALLOWLIST);
  assert.equal(ALLOWLIST[0], HEAD);
  for (const c of execs) {
    assert.equal(effortArg(c.argv), 'model_reasoning_effort="low"', c.argv.join(' '));
    assert.ok(c.argv.includes('--ignore-user-config') && c.argv.includes('--ignore-rules'));
    assert.equal(argAfter(c.argv, '-s'), 'read-only');
    assert.deepEqual(c.env, { OPENAI_API_KEY: null, CODEX_API_KEY: null, CODEX_EXEC_SERVER_URL: null, GH_TOKEN: null });
  }
  const rows = d.probe.split('\n').map((l) => l.trim()).filter((l) => /^gpt-/.test(l));
  assert.deepEqual(rows.map((l) => l.split(/\s+/)[0]), ALLOWLIST);
  assert.match(rows[0], /^gpt-6\.1-sol\s+REJECTED — .*The 'gpt-6\.1-sol' model is not supported when using Codex with a ChatGPT account/);
  for (const r of rows.slice(1)) assert.match(r, /\sACCEPTED — OK$/, r);
  // And the models line of the same run is intact beside it.
  assert.match(d.codex, /^ {2}models {6}CLI default gpt-6\.1-sol — in the catalog; /m);
});

// =============================================================================
// 7. Docs, rules, example: what the operator reads
// =============================================================================

test('the rules template: the audit row says astra for heavy reviews only and names 6.1-sol as the default; `rules --print` renders it', () => {
  const row = read('rules/omelette-fleet.md').split('\n').find((l) => l.startsWith('| Final pre-release security audit'));
  assert.ok(row, 'the audit row exists');
  assert.match(row, /Codex on `gpt-6-astra` \(heavy reviews only; the default is `gpt-6\.1-sol`\)/);
  assert.doesNotMatch(row, /its default/);
  const home = mkdtempSync(join(tmpdir(), 'omelette-t161-rules-'));
  const r = spawnSync(process.execPath, [BIN, 'rules', '--print'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: home, OMELETTE_UPDATE_CHECK: '0' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(row), 'the rendered rules carry the row verbatim');
});

test('ORCHESTRATION and the rules template agree on the audit route: both send it to astra, heavy reviews only', () => {
  const orch = read('docs/ORCHESTRATION.md').split('\n').find((l) => l.startsWith('| Final pre-release security audit'));
  assert.ok(orch);
  assert.match(orch, /`gpt-6-astra` \(heavy reviews only\)/);
  assert.match(orch, /pass `model: "gpt-6-astra"`/, 'the row says HOW to reach astra now that it is not the default');
  const codexRows = read('docs/ORCHESTRATION.md').split('\n').filter((l) => /^\| (?:Strongest code review|Research where the answer depends on running things)\b/.test(l));
  assert.equal(codexRows.length, 2);
  for (const l of codexRows) assert.match(l, /gpt-6\.1-sol/, l);
});

test('no current doc still calls astra the default, pairs it with high, or lists `none` as a codex effort', () => {
  const files = ['README.md', 'docs/ORCHESTRATION.md', 'docs/CONFIG.md', 'docs/SECURITY.md', 'docs/ADAPTERS.md', 'docs/STATUS-FEED.md', 'rules/omelette-fleet.md', 'units/codex/adapter.mjs', 'servers/codex.mjs'];
  const stale = [
    /gpt-6-astra` \(high\)/, /gpt-6-astra \(high\)/, /default `gpt-6-astra`/, /its default, `gpt-6-astra`/,
    /`gpt-6-astra`[^.\n|]{0,40}\bby default/, /default (?:model )?(?:is|becomes) `?gpt-6-astra/,
    /"model": "gpt-6-astra"/, /`none`\/`low`/, /none\/low\b/, /\(`none`\/`low`/, /Index 55\b/,
  ];
  const hits = [];
  for (const rel of files) {
    if (!existsSync(join(ROOT, rel))) continue;
    read(rel).split('\n').forEach((line, i) => { for (const re of stale) if (re.test(line)) hits.push(`${rel}:${i + 1} ${re} :: ${line.slice(0, 100)}`); });
  }
  assert.deepEqual(hits, []);
});

test('no current doc, template or unit text keeps a plan-gated sol, a Pro/Enterprise or Plus/Team gate, or the terra step-down advice', () => {
  const files = ['README.md', 'docs/ORCHESTRATION.md', 'docs/CONFIG.md', 'docs/SECURITY.md', 'docs/ADAPTERS.md', 'docs/STATUS-FEED.md', 'rules/omelette-fleet.md', 'units/codex/adapter.mjs', 'servers/codex.mjs'];
  const gone = [
    /plan-gated/i, /Pro\/Enterprise/, /Plus\/Team/, /Pro \/ Enterprise/, /Down to `gpt-5\.6-terra`/, /step-down/i,
    /`gpt-5\.6-terra` is the cheaper/, /astra costs ~?5x terra/, /unless your plan is ChatGPT Pro/,
  ];
  const hits = [];
  for (const rel of files) {
    if (!existsSync(join(ROOT, rel))) continue;
    read(rel).split('\n').forEach((line, i) => { for (const re of gone) if (re.test(line)) hits.push(`${rel}:${i + 1} ${re}`); });
  }
  // The tool descriptions and the GUIDE the session reads through the MCP surface say the same.
  for (const t of unit.tools) for (const re of gone) if (re.test(t.description || '')) hits.push(`tool ${t.name} description ${re}`);
  for (const re of gone) if (re.test(GUIDE)) hits.push(`GUIDE ${re}`);
  assert.deepEqual(hits, []);
});

test('CONFIG.md\'s effort row lists exactly EFFORTS, in the allowlist\'s order', () => {
  const row = read('docs/CONFIG.md').split('\n').find((l) => /^\| `effort` \|.*`model_reasoning_effort`/.test(l));
  assert.ok(row, 'the effort row exists');
  assert.ok(row.includes(`\`model_reasoning_effort\` (${EFFORTS.map((e) => `\`${e}\``).join('/')})`), row);
});

test('the shipped example and both docs\' config samples agree, and every value in them is one the unit accepts', () => {
  const ex = JSON.parse(read('examples/fleet.config.json')).units.codex;
  // Re-pinned by the session (1b round 3 item 4, then Task 2 round 2 ruling B): the example
  // carries only what an operator decides — no codex model, no codex effort — so an install made
  // from it follows the package's defaults, release by release.
  assert.ok(!('model' in ex));
  assert.equal(ex.effort, undefined);
  // The example is a real config: the runtime accepts it without a warning about model or effort.
  const st = station();
  const rt = runtimeOn(st, { config: { version: 1, units: { codex: ex } } });
  return rt.callTool('codex_research', { prompt: 'x' }).then((r) => {
    assert.ok(!r.isError, r.text);
    const [c] = st.execs();
    assert.deepEqual([argAfter(c.argv, '-m'), effortArg(c.argv)], [HEAD, 'model_reasoning_effort="xhigh"']);
  });
});

test('every price, speed and index figure the docs print for Codex is in the catalog (numbers copied, none invented)', () => {
  const orch = read('docs/ORCHESTRATION.md');
  const from = orch.indexOf('**Codex** — default `gpt-6.1-sol`');
  const to = orch.indexOf('## Never a sole source');
  assert.ok(from > 0 && to > from, 'the Codex block is where it was');
  const readme = read('README.md').split('\n').find((l) => l.startsWith('| **codex**'));
  const change = read('CHANGELOG.md');
  const changelog = change.slice(change.indexOf('## 1.6.1 — unreleased'), change.indexOf('\n## 1.6.0'));
  const rows = read('docs/ORCHESTRATION.md').split('\n').filter((l) => /^\| (?:Strongest code review|Research where the answer|Final pre-release security audit)\b/.test(l)).join('\n');
  const catalogText = read('units/codex/models.js');
  const figures = (text) => [
    ...(text.match(/\$\d+(?:\.\d+)?/g) || []),
    ...(text.match(/\b\d+ tok\/s/g) || []),
    ...[...text.matchAll(/(?:Intelligence Index|Index \()\s*(\d+)/g)].map((m) => `Index ${m[1]}`),
  ];
  const missing = [];
  for (const [where, text] of [['ORCHESTRATION block', orch.slice(from, to)], ['ORCHESTRATION rows', rows], ['README row', readme], ['CHANGELOG 1.6.1', changelog]]) {
    for (const f of new Set(figures(text))) {
      const needle = f.startsWith('Index ') ? new RegExp(`Intelligence Index ${f.slice(6)}\\b|Index ${f.slice(6)}\\b`) : new RegExp(f.replace(/[$.]/g, '\\$&'));
      if (!needle.test(catalogText)) missing.push(`${where}: ${f}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('CHANGELOG 1.6.1 names the behaviour change and the effort-list change where an operator upgrading will look', () => {
  const change = read('CHANGELOG.md');
  const entry = change.slice(change.indexOf('## 1.6.1 — unreleased'), change.indexOf('\n## 1.6.0'));
  assert.match(entry, /\*\*Behaviour change:\*\*|\*\*Behavior change:\*\*/);
  assert.match(entry, /now runs `gpt-6\.1-sol` instead of `gpt-6-astra`/);
  assert.match(entry, /built-in effort is `xhigh` instead of `high`/);
  assert.match(entry, /gains `ultra`[^\n]*loses `none`/);
  assert.match(entry, /codex debug models --bundled/);
});

test('CONFIG.md\'s doctor table says what the codex line compares and that it is the binary\'s catalog, not the server\'s', () => {
  const cfg = read('docs/CONFIG.md');
  assert.match(cfg, /\| codex \| the `visibility: "list"` entry with the smallest `priority` in `codex debug models --bundled` \|/);
  assert.match(cfg, /`\(fleet config\)`[^|]*`\(env CODEX_DEFAULT_MODEL\)`[^|]*`\(catalog head\)`/);
  assert.match(cfg, /a failure prints no line and never changes the login verdict/);
  // The map row for it points at a heading that exists.
  assert.match(cfg, /\| Which model does Codex pin when none is set, and what does doctor's `models` line compare\? \| \[Which unit actually uses which key\]\(#which-unit-actually-uses-which-key\) \|/);
  assert.match(cfg, /^### Which unit actually uses which key$/m);
});
