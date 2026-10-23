/**
 * omelette-fleet :: test/tester-1.6.1-t1.test.mjs
 * The tester's tests for 1.6.1 Task 1 (the Codex GPT-6 catalog, the effort
 * policy of the unit, doctor's codex `models` line), written from the spec and
 * the plan, not from the implementation: they cover what
 * test/codex-catalog-1.6.1.test.mjs does not — the spooled record of a default
 * call, the refusals before any spawn, doctor's line against what the runtime
 * really pins, the probe's failure modes, `--probe-models` order and the
 * `codex_models` output.
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
import { ALLOWLIST, GUIDE } from '../units/codex/models.js';
import { createUnitRuntime } from '../core/unit.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'codex-debug-models.json');
const HEAD = 'gpt-6.1-sol';

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

test('the codex_image schema: no effort property, and its model enum is the seven-id allowlist in order', () => {
  const rt = createUnitRuntime(unit, { env: { PATH: process.env.PATH, OMELETTE_HOME: mkdtempSync(join(tmpdir(), 'omelette-t161-schema-')), CODEX_BIN: process.execPath } });
  const image = rt.tools.find((x) => x.name === 'codex_image').inputSchema.properties;
  assert.equal(image.effort, undefined);
  assert.deepEqual(image.model.enum, ALLOWLIST);
});

// =============================================================================
// 2. codex_models: the cheat-sheet the session reads
// =============================================================================

test('codex_models: the seven ids in the guide\'s order, each with its effort pairing and tier; the effort line is the six levels; no "none"', async () => {
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
  assert.match(t, /^EFFORT LEVELS \(the `effort` arg\): low \| medium \| high \| xhigh \| max \| ultra$/m);
  assert.doesNotMatch(t, /\bnone\b/);
  assert.ok(t.includes(GUIDE));
  assert.deepEqual(st.calls(), [], 'a catalog read spawns nothing');
});

// =============================================================================
// 3. doctor: the models line against what the runtime really pins
// =============================================================================

test('doctor names the model the runtime really pins: the line and the -m of a real call agree in every configuration', async () => {
  const scenarios = [
    { name: 'nothing set', config: null, env: {}, pinned: HEAD, label: 'catalog head' },
    { name: 'fleet config: astra', config: { version: 1, units: { codex: { model: 'gpt-6-astra' } } }, env: {}, pinned: 'gpt-6-astra', label: 'fleet config' },
    { name: 'defaults.model luna', config: { version: 1, defaults: { model: 'gpt-6-luna' } }, env: {}, pinned: 'gpt-6-luna', label: 'fleet config' },
    { name: 'env beats file', config: { version: 1, units: { codex: { model: 'gpt-6-astra' } } }, env: { CODEX_DEFAULT_MODEL: 'gpt-6-sol' }, pinned: 'gpt-6-sol', label: 'env CODEX_DEFAULT_MODEL' },
    { name: 'config model not in the catalog', config: { version: 1, units: { codex: { model: 'gpt-4o' } } }, env: {}, pinned: HEAD, label: 'catalog head' },
    { name: 'env model not in the catalog beats a good file value', config: { version: 1, units: { codex: { model: 'gpt-6-astra' } } }, env: { CODEX_DEFAULT_MODEL: 'gpt-9-nova' }, pinned: HEAD, label: 'catalog head' },
  ];
  for (const s of scenarios) {
    const st = station({}, JSON.stringify({ models: fixtureModels() }));
    const d = doctor(st, { config: s.config || undefined, env: s.env });
    const m = d.codex.match(/^ {2}models {6}CLI default (\S+) — in the catalog; the fleet pins (\S+) \(([^)]+)\)$/m);
    assert.ok(m, `${s.name}: no models line\n${d.out}${d.err}`);
    assert.deepEqual([m[2], m[3]], [s.pinned, s.label], s.name);
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
  // The floor pins that the probe was not killed early: the kill is due at
  // 20 s and a timer cannot fire early. The ceiling is a hang detector over the
  // run's variable part only: 20 s is what this test demands, the rest measured
  // at most 0.3 s, so 60 s leaves over 100x that. Neither tells the kill from
  // the fake's own silent exit at 30 s: that the kill fires is
  // tester-t2c-doctor-kill.test.mjs's. "Once, not twice" is the call count above.
  assert.ok(b.ms >= 19000 && b.ms < 60000, `not killed before its 20 s, and doctor then ended: ${b.ms} ms`);
});

// =============================================================================
// 4. doctor --probe-models: the catalog's ids, in the catalog's order
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
