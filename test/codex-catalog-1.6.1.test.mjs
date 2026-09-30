/**
 * omelette-fleet :: test/codex-catalog-1.6.1.test.mjs
 * 1.6.1 Task 1: the Codex catalog knows the GPT-6 generation — gpt-6.1-sol
 * the fleet default at xhigh, gpt-6-astra for heavy reviews only, gpt-6-sol
 * the regression fallback, gpt-6-luna the cheap tier, the 5.6 tiers
 * superseded — `ultra` joins the effort list and `none` leaves it, and
 * `doctor` prints the codex CLI's bundled default (`codex debug models
 * --bundled`) beside the model the fleet pins.
 *
 * The fixture test/fixtures/codex-debug-models.json is the real codex-cli
 * 0.159.2 `debug models --bundled` output (2026-09-30), cut to the fields the
 * probe reads and kept in the CLI's own order — which is NOT priority order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import unit from '../units/codex/adapter.mjs';
import {
  CODEX_MODELS, ALLOWLIST, EFFORTS, DEFAULT_MODEL, GUIDE, isAllowedModel, isAllowedEffort,
} from '../units/codex/models.js';
import { createUnitRuntime, defineUnit } from '../core/unit.mjs';
import { makeCatalog } from '../core/catalog.mjs';
import grokUnit from '../units/grok/adapter.mjs';
import geminiUnit from '../units/gemini/adapter.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'codex-debug-models.json');
const HEAD = 'gpt-6.1-sol';
const KNOWN = 'gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-terra, gpt-5.6-luna, gpt-5.6-sol';

const find = (id) => CODEX_MODELS.find((m) => m.id === id);
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// --- the catalog -----------------------------------------------------------

test('the catalog is the GPT-6 line in the guide\'s order, the 5.6 tiers after it; the head is gpt-6.1-sol at xhigh', () => {
  assert.deepEqual(ALLOWLIST, KNOWN.split(', '));
  assert.equal(DEFAULT_MODEL, '', 'the catalog head is the default');
  const head = CODEX_MODELS[0];
  assert.equal(head.id, HEAD);
  assert.equal(head.effort, 'xhigh');
  assert.equal(head.tier, 'balanced');
  assert.match(head.useFor, /^THE FLEET DEFAULT \(operator decision 2026-09-30\)/);
  for (const id of ALLOWLIST) assert.equal(isAllowedModel(id), true, id);
  assert.equal(isAllowedModel('gpt-6'), false);
});

test('per-model effort pairing and tiers: 6.1-sol and astra xhigh, 6-sol high, 6-luna medium; astra is heavy and for heavy reviews only', () => {
  assert.deepEqual(
    ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'].map((id) => [id, find(id).effort, find(id).tier]),
    [['gpt-6.1-sol', 'xhigh', 'balanced'], ['gpt-6-astra', 'xhigh', 'heavy'], ['gpt-6-sol', 'high', 'balanced'], ['gpt-6-luna', 'medium', 'fast']],
  );
  const astra = find('gpt-6-astra');
  assert.match(astra.useFor, /^HEAVY REVIEWS ONLY/);
  assert.match(astra.useFor, /pre-release security audit/);
  assert.doesNotMatch(astra.useFor, /THE FLEET DEFAULT/);
  // Its old index figures were on another AA index version: said, not silently swapped.
  assert.match(astra.useFor, /AA Intelligence Index 53 at max/);
  assert.match(astra.useFor, /older index version/);
  assert.match(find('gpt-6-sol').useFor, /REGRESSION FALLBACK for gpt-6\.1-sol/);
  assert.match(find('gpt-6-luna').avoid, /INHERITED from gpt-5\.6-luna/);
});

test('the 5.6 tiers are superseded, not deprecated, and no longer plan-gated', () => {
  for (const [id, successor] of [['gpt-5.6-terra', 'gpt-6-sol'], ['gpt-5.6-luna', 'gpt-6-luna'], ['gpt-5.6-sol', 'gpt-6-sol']]) {
    const m = find(id);
    assert.match(m.useFor, new RegExp(`SUPERSEDED by ${successor.replace(/\./g, '\\.')}`), id);
    assert.match(m.useFor, /NOT deprecated on OpenAI's schedule as of 2026-09-30/, id);
    assert.doesNotMatch(`${m.useFor} ${m.avoid}`, /PLAN-GATED|plan-gated|Pro\/Enterprise|Pro-only/, id);
  }
  assert.match(find('gpt-5.6-sol').useFor, /ACCEPTED on the ChatGPT plan since at least 2026-09-30/);
});

test('efforts: ultra in, none out; the tool schemas\' effort enum is EFFORTS', () => {
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(isAllowedEffort('ultra'), true);
  assert.equal(isAllowedEffort('none'), false);
  const rt = createUnitRuntime(unit, { env: { ...process.env, OMELETTE_HOME: mkdtempSync(join(tmpdir(), 'omelette-161-enum-')), CODEX_BIN: process.execPath } });
  for (const name of ['codex_research', 'codex_code_review']) {
    const tool = rt.tools.find((t) => t.name === name);
    assert.deepEqual(tool.inputSchema.properties.effort.enum, EFFORTS, name);
    assert.deepEqual(tool.inputSchema.properties.model.enum, ALLOWLIST, name);
  }
});

// Re-pinned in 1b round 3: an omitted effort takes the named model's pairing,
// so the description no longer calls xhigh "the fleet default" outright, and the
// shipped example drops codex.effort (a configured effort would beat every pairing).
test('the built-in effort is xhigh; the tool description says an omitted effort takes the model\'s pairing; the shipped example sets no codex effort', () => {
  assert.equal(unit.builtin.effort, 'xhigh');
  const desc = unit.tools.find((t) => t.name === 'codex_research').inputSchema.properties.effort.description;
  assert.doesNotMatch(desc, /\bnone\b/);
  assert.match(desc, /max\/ultra = manual escalation/);
  assert.match(desc, /OMIT for the fleet default: the named model's pairing — gpt-6\.1-sol and gpt-6-astra xhigh, gpt-6-sol high, the lunas medium — unless the operator configured an effort\./);
  const example = JSON.parse(read('examples/fleet.config.json'));
  // Re-pinned in 1.6.1 Task 2 (ruling B): the example sets no codex model either — the catalog head follows the package.
  assert.ok(!('model' in example.units.codex), JSON.stringify(example.units.codex));
  assert.ok(!('effort' in example.units.codex), JSON.stringify(example.units.codex));
});

test('GUIDE: 6.1-sol is the default at xhigh, astra heavy reviews only, max and ultra manual escalation', () => {
  assert.match(GUIDE, /gpt-6\.1-sol \(xhigh\)=THE FLEET DEFAULT/);
  assert.match(GUIDE, /gpt-6-astra \(xhigh\)=heavy reviews only/);
  assert.match(GUIDE, /gpt-6-sol \(high\)=the regression fallback/);
  assert.match(GUIDE, /do not raise above xhigh by default: ultra and max are manual escalation/);
  assert.doesNotMatch(GUIDE, /PLAN-GATED|plan-gated|\bnone\b/);
});

// --- doctor: the codex `models` line --------------------------------------

/**
 * A fake codex: `--version`, `login status` (stderr, like the real one) and
 * `debug models --bundled`, which reads stdin to EOF first (the probe must
 * close it, or this hangs into the 20 s kill) and refuses to answer when a
 * billing key reached it (the probe must run in the scrubbed probe env).
 */
function fakeCodex(dir, { debugOut = '', debugCode = 0, loginOut = 'Logged in using ChatGPT\n', loginCode = 0 } = {}) {
  const out = join(dir, 'debug-out.txt');
  writeFileSync(out, debugOut);
  const p = join(dir, 'fake-codex');
  writeFileSync(p, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('codex-cli 0.159.2'); process.exit(0); }",
    `if (a[0] === 'login' && a[1] === 'status') { process.stderr.write(${JSON.stringify(loginOut)}); process.exit(${loginCode}); }`,
    "if (a.join(' ') === 'debug models --bundled') {",
    "  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) { console.error('billing key leaked'); process.exit(3); }",
    // exitCode, not exit(): on macOS a pipe write is asynchronous, and exit()
    // right after a 450 KB write lets only the first 64 KiB through.
    `  let s = ''; process.stdin.on('data', (c) => { s += c; }).on('end', () => { process.stdout.write(fs.readFileSync(${JSON.stringify(out)}, 'utf8')); process.exitCode = ${debugCode}; });`,
    '} else {',
    "  console.error('unexpected argv: ' + a.join(' '));",
    '  process.exit(1);',
    '}',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** doctor with a fresh fleet home (optionally a fleet config); only codex has a binary. */
function doctorWith(fakeOpts, { config, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-161-doctor-'));
  const fake = fakeCodex(dir, fakeOpts);
  if (config) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(config));
  const gone = join(dir, 'no-such');
  const r = spawnSync(process.execPath, [BIN, 'doctor'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0',
      AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: fake, OPENAI_API_KEY: 'sk-must-not-reach', ...env,
    },
  });
  const out = r.stdout || '';
  const at = out.indexOf('── codex');
  return { out, err: r.stderr || '', codex: at >= 0 ? out.slice(at) : '' };
}

const fixture = () => readFileSync(FIXTURE, 'utf8');

test('the fixture is the CLI\'s order, not priority order: astra comes first, 6.1-sol holds priority 1', () => {
  const { models } = JSON.parse(fixture());
  assert.equal(models[0].slug, 'gpt-6-astra');
  assert.equal(models.find((m) => m.priority === 1).slug, HEAD);
  assert.ok(!('base_instructions' in models[0]), 'the fixture holds only the fields the probe reads');
});

test('doctor: the bundled default in the catalog reads "in the catalog; the fleet pins <head> (catalog head)", beside an intact login line', () => {
  const r = doctorWith({ debugOut: fixture() });
  assert.match(r.codex, /^  login       OK — Logged in using ChatGPT$/m, r.out + r.err);
  assert.match(r.codex, /^  models      CLI default gpt-6\.1-sol — in the catalog; the fleet pins gpt-6\.1-sol \(catalog head\)$/m, r.out + r.err);
});

test('doctor: a bundled default the catalog does not carry is named, with what the catalog knows and the pinned model', () => {
  const { models } = JSON.parse(fixture());
  const nova = { models: [...models, { slug: 'gpt-7-nova', display_name: 'GPT-7-Nova', visibility: 'list', priority: 0, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }] }] };
  const r = doctorWith({ debugOut: JSON.stringify(nova) });
  assert.ok(
    r.codex.includes(`  models      CLI default gpt-7-nova — NOT in the catalog (units/codex/models.js knows ${KNOWN}); the fleet pins gpt-6.1-sol (catalog head), so calls are unaffected — update the catalog\n`),
    r.out + r.err,
  );
  // grok's wording is grok's alone: codex always passes -m.
  assert.doesNotMatch(r.codex, /every call that omits `model` runs on it/);
});

test('doctor: a codex model set in the fleet config is the one named as pinned', () => {
  const r = doctorWith({ debugOut: fixture() }, { config: { version: 1, units: { codex: { model: 'gpt-6-astra' } } } });
  assert.match(r.codex, /^  models      CLI default gpt-6\.1-sol — in the catalog; the fleet pins gpt-6-astra \(fleet config\)$/m, r.out + r.err);
});

test('doctor: a codex model set through CODEX_DEFAULT_MODEL is named with that variable', () => {
  const r = doctorWith({ debugOut: fixture() }, { env: { CODEX_DEFAULT_MODEL: 'gpt-6-sol' } });
  assert.match(r.codex, /^  models      CLI default gpt-6\.1-sol — in the catalog; the fleet pins gpt-6-sol \(env CODEX_DEFAULT_MODEL\)$/m, r.out + r.err);
});

test('doctor: a configured codex model the catalog does not carry is ignored at run time, so the head is what is pinned', () => {
  const r = doctorWith({ debugOut: fixture() }, { config: { version: 1, units: { codex: { model: 'gpt-4o' } } } });
  assert.match(r.codex, /^  models      CLI default gpt-6\.1-sol — in the catalog; the fleet pins gpt-6\.1-sol \(catalog head\)$/m, r.out + r.err);
});

test('doctor: the smallest priority among "list" entries wins — a hidden entry ranked above it does not', () => {
  const { models } = JSON.parse(fixture());
  const hidden = { models: [{ slug: 'codex-internal', visibility: 'hide', priority: 0 }, ...models] };
  const r = doctorWith({ debugOut: JSON.stringify(hidden) });
  assert.match(r.codex, /^  models      CLI default gpt-6\.1-sol — /m, r.out + r.err);
});

test('doctor: an answer past the 400 000-char default output cap still parses (the real one is ~650 KB)', () => {
  const { models } = JSON.parse(fixture());
  // The padding comes FIRST: a probe that kept only the default tail would lose the JSON's head.
  const padded = JSON.stringify({ padding: 'x'.repeat(450000), models });
  assert.ok(padded.length > 400000);
  const r = doctorWith({ debugOut: padded });
  assert.match(r.codex, /^  models      CLI default gpt-6\.1-sol — in the catalog; /m, r.out + r.err);
});

test('doctor: `debug models` failing, printing garbage or listing nothing leaves the login line intact and prints no models line', () => {
  const cases = [
    ['exit 1', { debugOut: fixture(), debugCode: 1 }],
    ['garbage', { debugOut: 'error: unrecognized subcommand \'debug\'\n' }],
    ['no list entries', { debugOut: JSON.stringify({ models: [{ slug: 'x', visibility: 'hide', priority: 1 }] }) }],
    ['no models key', { debugOut: '{}' }],
  ];
  for (const [label, opts] of cases) {
    const r = doctorWith(opts);
    assert.match(r.codex, /^  login       OK — Logged in using ChatGPT$/m, `${label}: ${r.out}${r.err}`);
    assert.doesNotMatch(r.codex, /^  models /m, `${label}: ${r.codex}`);
  }
});

test('doctor: the bundled default is a fact about the binary — a signed-out login still gets the models line and keeps its verdict', () => {
  const r = doctorWith({ debugOut: fixture(), loginOut: 'Not logged in\n', loginCode: 1 });
  assert.match(r.codex, /^  login       SIGNED OUT — signed out — run `codex login`$/m, r.out + r.err);
  assert.match(r.codex, /^  models      CLI default gpt-6\.1-sol — in the catalog; /m, r.out + r.err);
});

// --- docs --------------------------------------------------------------------

test('docs: no Codex step-down to gpt-5.6-terra, no "plan-gated" sol; the default reads gpt-6.1-sol at xhigh', () => {
  for (const rel of ['docs/ORCHESTRATION.md', 'README.md', 'docs/CONFIG.md']) {
    const text = read(rel);
    assert.doesNotMatch(text, /plan-gated/i, rel);
    assert.doesNotMatch(text, /Down to `gpt-5\.6-terra`|step-down|`gpt-5\.6-terra` is the cheaper/i, rel);
    assert.doesNotMatch(text, /"model": "gpt-6-astra", "effort": "high"/, rel);
    assert.doesNotMatch(text, /`none`\/`low`/, rel);
  }
  const orch = read('docs/ORCHESTRATION.md');
  assert.match(orch, /^\*\*Codex\*\* — default `gpt-6\.1-sol` at `effort: xhigh`/m);
  assert.match(orch, /^\| Final pre-release security audit \| \*\*Codex\*\* on `gpt-6-astra` \(heavy reviews only\)/m);
  assert.match(read('docs/CONFIG.md'), /^\| codex \| — \| `timeoutS: 600`, `effort: "xhigh"`, /m);
  assert.match(read('docs/CONFIG.md'), /installed binary's catalog, not the server's/);
  assert.match(read('README.md'), /on `gpt-6\.1-sol` \(xhigh\) by default/);
  assert.match(read('CHANGELOG.md'), /^## 1\.6\.1 — (unreleased|\d{4}-\d\d-\d\d)$/m);
});

// =============================================================================
// Task 1b (the fix round after the two-pass tester, rulings of 2026-09-30)
// =============================================================================

/**
 * A fake codex that answers `exec` like the real one and appends every argv it
 * was started with to argv.log — what reached the CLI is the thing pinned.
 */
function execStation() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-161b-'));
  const bin = join(dir, 'fake-codex');
  const logPath = join(dir, 'argv.log');
  writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    'const a = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(a) + '\\n');`,
    "process.stdin.on('data', () => {}).on('end', () => {",
    "  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "  line({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } });",
    "  line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });",
    '});',
    'process.stdin.resume();',
  ].join('\n'));
  chmodSync(bin, 0o755);
  const argvs = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, bin, argvs };
}

/** A runtime over the station; `config` is written to its OMELETTE_HOME, `env` is all the env it gets beyond the basics. */
function execRuntime(st, { config, env = {} } = {}) {
  if (config) writeFileSync(join(st.dir, 'fleet.config.json'), JSON.stringify(config));
  return createUnitRuntime(unit, { env: { PATH: process.env.PATH, HOME: st.dir, OMELETTE_HOME: st.dir, CODEX_BIN: st.bin, ...env } });
}

const sentEffort = (argv) => (argv.find((x) => x.startsWith('model_reasoning_effort=')) || null);
const sentModel = (argv) => argv[argv.indexOf('-m') + 1];

/** One research call; returns [the -m, the effort flag] that reached the CLI. */
async function oneCall(st, rt, args) {
  const before = st.argvs().length;
  const r = await rt.callTool('codex_research', { prompt: 'x', ...args });
  assert.ok(!r.isError, r.text);
  const argv = st.argvs()[before];
  return [sentModel(argv), sentEffort(argv)];
}

test('1b rule 1: a named model with nothing configured brings its catalog pairing — luna medium, 6-sol high, astra xhigh, the 5.6 tiers theirs', async () => {
  const st = execStation();
  const rt = execRuntime(st);
  for (const m of CODEX_MODELS) {
    assert.deepEqual(await oneCall(st, rt, { model: m.id }), [m.id, `model_reasoning_effort="${m.effort}"`], m.id);
  }
  // The pairings the ruling names, spelled out so a catalog edit cannot move them silently.
  assert.deepEqual(
    Object.fromEntries(CODEX_MODELS.map((m) => [m.id, m.effort])),
    { 'gpt-6.1-sol': 'xhigh', 'gpt-6-astra': 'xhigh', 'gpt-6-sol': 'high', 'gpt-6-luna': 'medium', 'gpt-5.6-terra': 'high', 'gpt-5.6-luna': 'medium', 'gpt-5.6-sol': 'high' },
  );
});

test('1b rule 1: nothing configured and no model named is unchanged — gpt-6.1-sol at xhigh', async () => {
  const st = execStation();
  assert.deepEqual(await oneCall(st, execRuntime(st), {}), [HEAD, 'model_reasoning_effort="xhigh"']);
});

test('1b rule 1: a model named in the fleet config brings its pairing too (it is the model the run resolved to)', async () => {
  const st = execStation();
  const rt = execRuntime(st, { config: { version: 1, units: { codex: { model: 'gpt-6-luna' } } } });
  assert.deepEqual(await oneCall(st, rt, {}), ['gpt-6-luna', 'model_reasoning_effort="medium"']);
});

test('1b rule 1: an effort the operator configured beats every pairing — in the file (unit or defaults block) or in CODEX_EFFORT', async () => {
  const setups = [
    ['units.codex.effort', { config: { version: 1, units: { codex: { effort: 'low' } } } }],
    ['defaults.effort', { config: { version: 1, defaults: { effort: 'low' } } }],
    ['CODEX_EFFORT', { env: { CODEX_EFFORT: 'low' } }],
  ];
  for (const [label, how] of setups) {
    const st = execStation();
    const rt = execRuntime(st, how);
    for (const m of CODEX_MODELS) {
      assert.deepEqual(await oneCall(st, rt, { model: m.id }), [m.id, 'model_reasoning_effort="low"'], `${label}: ${m.id}`);
    }
    assert.deepEqual(await oneCall(st, rt, {}), [HEAD, 'model_reasoning_effort="low"'], `${label}: no model`);
  }
});

test('1b rule 1: an operator who configured xhigh explicitly keeps xhigh on luna (configured, not the built-in)', async () => {
  const st = execStation();
  const rt = execRuntime(st, { config: { version: 1, units: { codex: { effort: 'xhigh' } } } });
  assert.deepEqual(await oneCall(st, rt, { model: 'gpt-6-luna' }), ['gpt-6-luna', 'model_reasoning_effort="xhigh"']);
});

test('1b rule 1: the call\'s effort beats the config and the pairing', async () => {
  const st = execStation();
  const rt = execRuntime(st, { config: { version: 1, units: { codex: { effort: 'low' } } } });
  assert.deepEqual(await oneCall(st, rt, { model: 'gpt-6-luna', effort: 'max' }), ['gpt-6-luna', 'model_reasoning_effort="max"']);
  const bare = execStation();
  assert.deepEqual(await oneCall(bare, execRuntime(bare), { model: 'gpt-6-luna', effort: 'high' }), ['gpt-6-luna', 'model_reasoning_effort="high"']);
});

test('1b rule 1: the log line and the spooled record show the effort actually sent', async () => {
  const st = execStation();
  const rt = execRuntime(st);
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return true; };
  let r;
  try { r = await rt.callTool('codex_research', { prompt: 'x', model: 'gpt-6-luna' }); } finally { process.stderr.write = write; }
  assert.ok(!r.isError, r.text);
  assert.ok(lines.some((l) => /codex exec · .*model=gpt-6-luna · effort=medium \(gpt-6-luna's pairing\)/.test(l)), lines.join(''));
  const dir = join(st.dir, 'results', 'codex');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 1);
  const record = readFileSync(join(dir, files[0]), 'utf8');
  assert.match(record, /^model: gpt-6-luna$/m, record);
  assert.match(record, /^effort: medium$/m, record);
});

test('1b rule 1: codex_image is unchanged — no effort flag, whatever model or config', async () => {
  const st = execStation();
  const rt = execRuntime(st, { config: { version: 1, units: { codex: { effort: 'low' } } } });
  await rt.callTool('codex_image', { prompt: 'a red circle', model: 'gpt-6-luna' });
  const bare = execStation();
  await execRuntime(bare).callTool('codex_image', { prompt: 'a red circle' });
  for (const argv of [...st.argvs(), ...bare.argvs()]) assert.equal(sentEffort(argv), null, argv.join(' '));
});

// --- rule 2: doctor says when the installed CLI lacks the pinned model ---------

// Re-pinned in 1b round 3 (ruling C): the bundle is the binary's, so the tail no longer says the CLI would refuse.
const WARN = " — NOT in this CLI's bundled catalog: update codex (codex-cli 0.157.1 refused a model its bundle lacked)";
const shortFixture = () => JSON.stringify({ models: JSON.parse(fixture()).models.filter((m) => ['gpt-6-astra', 'gpt-6-sol'].includes(m.slug)) });

test('1b rule 2: a bundled catalog without the pinned head ends the models line with the warning, naming the pinned model', () => {
  const r = doctorWith({ debugOut: shortFixture() });
  assert.ok(r.codex.includes(`  models      CLI default gpt-6-astra — in the catalog; the fleet pins gpt-6.1-sol (catalog head)${WARN}\n`), r.out + r.err);
});

test('1b rule 2: the full bundled catalog, or a configured model the CLI carries, prints no warning', () => {
  const full = doctorWith({ debugOut: fixture() });
  assert.match(full.codex, /^  models      CLI default gpt-6\.1-sol — in the catalog; the fleet pins gpt-6\.1-sol \(catalog head\)$/m, full.out + full.err);
  const astra = doctorWith({ debugOut: shortFixture() }, { config: { version: 1, units: { codex: { model: 'gpt-6-astra' } } } });
  assert.match(astra.codex, /^  models      CLI default gpt-6-astra — in the catalog; the fleet pins gpt-6-astra \(fleet config\)$/m, astra.out + astra.err);
  for (const r of [full, astra]) assert.ok(!r.out.includes("NOT in this CLI's bundled catalog"), r.codex);
});

test('1b rule 2: a CLI default the catalog lacks AND a pinned model the CLI lacks — the line does not claim calls are unaffected', () => {
  const nova = { slug: 'gpt-7-nova', visibility: 'list', priority: 0 };
  const r = doctorWith({ debugOut: JSON.stringify({ models: [nova, ...JSON.parse(shortFixture()).models] }) });
  assert.ok(
    r.codex.includes(`  models      CLI default gpt-7-nova — NOT in the catalog (units/codex/models.js knows ${KNOWN}); the fleet pins gpt-6.1-sol (catalog head) — update the catalog${WARN}\n`),
    r.out + r.err,
  );
  assert.doesNotMatch(r.codex, /calls are unaffected/);
});

test('1b rule 2: a failed probe still prints nothing', () => {
  const r = doctorWith({ debugOut: shortFixture(), debugCode: 1 });
  assert.doesNotMatch(r.codex, /^  models /m, r.codex);
  assert.ok(!r.out.includes("NOT in this CLI's bundled catalog"));
});

// --- rule 3: `set` validates effort; `show` and `doctor` mark a refused one -----

/** The CLI with a throwaway fleet home: never the operator's. */
function cliIn(dir, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const home = () => mkdtempSync(join(tmpdir(), 'omelette-161b-set-'));
const configIn = (dir) => (existsSync(join(dir, 'fleet.config.json')) ? JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8')) : null);
const MARK = "not in the catalog's list: ignored at call time, the model's pairing applies";

test('1b rule 3: `set codex.effort=none` and `=bogus` exit non-zero, naming the catalog\'s list, and write nothing', () => {
  for (const v of ['none', 'bogus', 'ULTRA']) {
    const dir = home();
    const r = cliIn(dir, ['set', `codex.effort=${v}`]);
    assert.notEqual(r.code, 0, `${v}: ${r.out}${r.err}`);
    assert.match(r.err, new RegExp(`invalid value for codex\\.effort: "${v}" — expected one of the catalog's effort levels: low \\| medium \\| high \\| xhigh \\| max \\| ultra`), r.err);
    assert.equal(configIn(dir), null, `${v}: nothing written`);
  }
});

test('1b rule 3: `set codex.effort=ultra` is written; grok validates against its own list; gemini (no list) is unchanged', () => {
  const dir = home();
  const ok = cliIn(dir, ['set', 'codex.effort=ultra']);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.equal(configIn(dir).units.codex.effort, 'ultra');
  const grok = cliIn(home(), ['set', 'grok.effort=ultra']);
  assert.notEqual(grok.code, 0, grok.out + grok.err);
  assert.match(grok.err, /expected one of the catalog's effort levels: low \| medium \| high \| xhigh/);
  const gdir = home();
  const gemini = cliIn(gdir, ['set', 'gemini.effort=anything']);
  assert.equal(gemini.code, 0, gemini.out + gemini.err);
  assert.equal(configIn(gdir).units.gemini.effort, 'anything');
});

test('1b rule 3: a hand-written config holding `none` is marked in `show codex` and in `doctor`', () => {
  const dir = home();
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, units: { codex: { effort: 'none' } } }));
  const shown = cliIn(dir, ['show', 'codex']);
  assert.equal(shown.code, 0, shown.out + shown.err);
  assert.match(shown.out, new RegExp(`^  effort +none +file — ${MARK}$`, 'm'), shown.out);
  const d = doctorWith({ debugOut: fixture() }, { config: { version: 1, units: { codex: { effort: 'none' } } } });
  assert.match(d.codex, new RegExp(`^ +effort +none +file — ${MARK}$`, 'm'), d.codex);
  // A valid configured effort carries no mark.
  const fine = home();
  writeFileSync(join(fine, 'fleet.config.json'), JSON.stringify({ version: 1, units: { codex: { effort: 'high' } } }));
  assert.match(cliIn(fine, ['show', 'codex']).out, /^  effort +high +file$/m);
});

test('1b rule 3: CODEX_EFFORT=none is marked with its source; grok\'s refused value names what grok falls back to', () => {
  const dir = home();
  const shown = cliIn(dir, ['show', 'codex'], { CODEX_EFFORT: 'none' });
  assert.match(shown.out, new RegExp(`^  effort +none +env:CODEX_EFFORT — ${MARK}$`, 'm'), shown.out);
  const g = home();
  writeFileSync(join(g, 'fleet.config.json'), JSON.stringify({ version: 1, units: { grok: { effort: 'max' } } }));
  assert.match(cliIn(g, ['show', 'grok']).out, /^  effort +max +file — not in the catalog's list: ignored at call time, the vendor default applies$/m);
});

test('1b rule 3: a call under a config holding `none` sends the resolved model\'s pairing, not an empty flag', async () => {
  const st = execStation();
  const rt = execRuntime(st, { config: { version: 1, units: { codex: { effort: 'none' } } } });
  assert.deepEqual(await oneCall(st, rt, {}), [HEAD, 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(await oneCall(st, rt, { model: 'gpt-6-luna' }), ['gpt-6-luna', 'model_reasoning_effort="medium"']);
});

// --- rule 4: text ------------------------------------------------------------

test('1b rule 4: the text items — README\'s probe claim is versioned, 5.6-luna steps up to gpt-6-sol, CHANGELOG gives the upgrade path, AA figures say at max and when', () => {
  const readme = read('README.md');
  assert.match(readme, /on codex-cli 0\.159\.2/);
  assert.doesNotMatch(readme, /accepted every id in the catalog, including/);
  assert.match(find('gpt-5.6-luna').avoid, /Step up to gpt-6-sol/);
  assert.doesNotMatch(find('gpt-5.6-luna').avoid, /Step up to terra/);
  const entry = read('CHANGELOG.md').split(/^## /m).find((s) => s.startsWith('1.6.1'));
  // Re-pinned in 1b round 3 (ruling 4): the upgrade clears codex.effort so the pairings apply.
  // Re-pinned in 1.6.1 Task 2 (ruling B): it clears codex.model too, so the catalog head follows the package.
  assert.ok(entry.includes('omelette-fleet set codex.model= codex.effort='), entry);
  assert.ok(!entry.includes('codex.effort=xhigh'), entry);
  assert.ok(entry.includes('omelette-fleet rules --agents --hooks'), entry);
  assert.match(entry, /catalog pairing/);
  assert.match(entry, /`set` refuses/);
  // Every AA figure the two files quote says at max effort and when it was read.
  for (const [name, text] of [['README.md', readme], ['CHANGELOG 1.6.1', entry]]) {
    for (const sentence of text.split(/(?<=[.;])\s+|\n/).filter((s) => /AA Intelligence Index|per Index task/.test(s))) {
      assert.match(sentence, /at max effort/, `${name}: ${sentence}`);
      assert.match(sentence, /AA, read 2026-09-30/, `${name}: ${sentence}`);
    }
  }
  // README's doctor sample carries a codex that knows 6.1-sol, and its models line
  // (re-taken at the 1.6.1 live gate on an install that pins no codex model: the catalog head).
  const sample = readme.slice(readme.indexOf('── codex'), readme.indexOf('── codex') + 800);
  assert.match(sample, /^  version     codex-cli 0\.159\.2$/m, sample);
  assert.match(sample, /^  models      CLI default gpt-6\.1-sol — in the catalog; the fleet pins gpt-6\.1-sol \(catalog head\)$/m, sample); // live gate 1.6.1: the sample install pins no codex model
  assert.match(readme, /on codex-cli 0\.159\.2, `doctor --probe-models`[^\n]*accepted every id in the catalog[^\n]*0\.157\.1 had refused `gpt-6\.1-sol`/); // live gate 1.6.1: every id re-probed on 0.159.2
});

test('1b: CONFIG and ORCHESTRATION say a named model brings its own pairing unless an effort is configured', () => {
  for (const rel of ['docs/CONFIG.md', 'docs/ORCHESTRATION.md']) {
    assert.match(read(rel), /a named model brings its own pairing unless an effort is configured/i, rel);
  }
});

// --- 1b round 2: the resolution lives in core, behind `pairedEffort` ---------

/**
 * A fake codex that, while its run is live, copies the unit's status snapshot
 * (status-codex-<pid>.json in the fleet home) next to its argv — so a test can
 * read what the feed's `active` entry said about the run that was in flight.
 */
function feedStation() {
  const st = execStation();
  const seen = join(st.dir, 'snapshot-seen.json');
  writeFileSync(st.bin, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    "const path = require('path');",
    'const a = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(join(st.dir, 'argv.log'))}, JSON.stringify(a) + '\\n');`,
    `const dir = ${JSON.stringify(st.dir)};`,
    "const snap = fs.readdirSync(dir).find((f) => /^status-codex-\\d+\\.json$/.test(f));",
    `if (snap) fs.writeFileSync(${JSON.stringify(seen)}, fs.readFileSync(path.join(dir, snap), 'utf8'));`,
    "process.stdin.on('data', () => {}).on('end', () => {",
    "  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "  line({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } });",
    "  line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });",
    '});',
    'process.stdin.resume();',
  ].join('\n'));
  return { ...st, seen: () => JSON.parse(readFileSync(seen, 'utf8')) };
}

const spooled = (st) => {
  const dir = join(st.dir, 'results', 'codex');
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(dir, f), 'utf8'));
};

test('1b core: a luna call sends `medium`, and the status feed\'s active entry said `medium` while it ran', async () => {
  const st = feedStation();
  const rt = execRuntime(st);
  assert.deepEqual(await oneCall(st, rt, { model: 'gpt-6-luna' }), ['gpt-6-luna', 'model_reasoning_effort="medium"']);
  const snap = st.seen();
  assert.equal(snap.active.length, 1, JSON.stringify(snap));
  assert.equal(snap.active[0].model, 'gpt-6-luna');
  assert.equal(snap.active[0].effort, 'medium');
  const [record] = spooled(st);
  assert.match(record, /^effort: medium$/m, record);
});

test('1b core: codex_image claims no effort — not in the argv, the feed\'s active entry, or the record', async () => {
  const st = feedStation();
  const rt = execRuntime(st);
  await rt.callTool('codex_image', { prompt: 'a red circle', model: 'gpt-6-luna' });
  assert.equal(sentEffort(st.argvs()[0]), null);
  assert.equal(st.seen().active[0].effort, null, JSON.stringify(st.seen()));
  const [record] = spooled(st);
  assert.match(record, /^effort:$/m, record);
});

test('1b core: `pairedEffort` is an opt-in — without it the built-in beats a pairing, with it the pairing wins, an image tool gets none, and it must be a boolean', async () => {
  const catalog = makeCatalog({ models: [{ id: 'a', effort: 'low' }, { id: 'b', effort: 'medium' }, { id: 'c', effort: 'High' }], efforts: ['low', 'medium', 'high'] });
  assert.equal(catalog.pairedEffort('b'), 'medium');
  assert.equal(catalog.pairedEffort('c'), '', 'a tag the effort list does not hold is no pairing');
  assert.equal(catalog.pairedEffort('nope'), '');
  const echo = (kind) => ({ name: `acme_${kind}`, kind, description: 'd', inputSchema: { type: 'object', properties: {} }, run: (args, ctx) => `${ctx.effort}|${ctx.effortFrom}` });
  const make = (pairedEffort) => defineUnit({
    name: 'acme', bin: process.execPath, builtin: { effort: 'high' }, catalog,
    ...(pairedEffort === undefined ? {} : { pairedEffort }), tools: [echo('research'), echo('image')],
  });
  const env = { PATH: process.env.PATH, OMELETTE_HOME: mkdtempSync(join(tmpdir(), 'omelette-161b-acme-')) };
  const plain = createUnitRuntime(make(undefined), { env });
  const paired = createUnitRuntime(make(true), { env });
  assert.equal(make(undefined).pairedEffort, false);
  assert.equal((await plain.callTool('acme_research', { model: 'b' })).text, 'high|builtin');
  assert.equal((await paired.callTool('acme_research', { model: 'b' })).text, 'medium|pairing');
  assert.equal((await paired.callTool('acme_research', {})).text, 'low|pairing', 'no model named: the catalog head\'s pairing');
  assert.equal((await paired.callTool('acme_research', { model: 'c' })).text, 'high|builtin', 'no usable pairing: the built-in');
  assert.equal((await paired.callTool('acme_research', { model: 'b', effort: 'low' })).text, 'low|call');
  assert.equal((await paired.callTool('acme_image', { model: 'b' })).text, '|');
  assert.equal((await plain.callTool('acme_image', { model: 'b' })).text, 'high|builtin', 'without the opt-in an image tool is as it was');
  assert.throws(() => make('yes'), /pairedEffort must be a boolean/);
});

test('1b core: only codex opts in; grok, which does not, is unchanged for a named model', async () => {
  assert.equal(unit.pairedEffort, true);
  assert.equal(grokUnit.pairedEffort, false);
  assert.equal(geminiUnit.pairedEffort, false);
  const dir = mkdtempSync(join(tmpdir(), 'omelette-161b-grok-'));
  const fake = join(dir, 'fake-grok');
  const log = join(dir, 'argv.log');
  writeFileSync(fake, [`#!${process.execPath}`, `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`, 'process.exit(1);'].join('\n'));
  chmodSync(fake, 0o755);
  const rt = createUnitRuntime(grokUnit, { env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, GROK_BIN: fake } });
  await rt.callTool('grok_research', { prompt: 'x', model: 'grok-4.6' });
  const argv = JSON.parse(readFileSync(log, 'utf8').split('\n')[0]);
  assert.equal(argv[argv.indexOf('--model') + 1], 'grok-4.6');
  assert.ok(!argv.includes('--reasoning-effort'), argv.join(' '));
});

test('1b round 2: every AA Index figure in ORCHESTRATION\'s Codex routing rows and escalation block says at max effort', () => {
  const orch = read('docs/ORCHESTRATION.md');
  const block = orch.slice(orch.indexOf('**Codex** — default'), orch.indexOf('\n\n', orch.indexOf('**Codex** — default')));
  const rows = orch.split('\n').filter((l) => /^\| (Strongest code review|Final pre-release security audit)/.test(l));
  const sentences = [block, ...rows].join('\n').split(/(?<=[.;])\s+|\n/).filter((s) => /AA (Intelligence )?Index/.test(s));
  assert.ok(sentences.length >= 3, sentences.join('\n'));
  for (const s of sentences) assert.match(s, /at max effort/, s);
});

// --- 1b round 3 ---------------------------------------------------------------

/** A throwaway unit whose tools echo `effort|effortFrom`; model `c` has no usable pairing. */
function acmeRuntime({ pairedEffort = true, config } = {}) {
  const catalog = makeCatalog({ models: [{ id: 'a', effort: 'low' }, { id: 'b', effort: 'medium' }, { id: 'c', effort: 'High' }], efforts: ['low', 'medium', 'high'] });
  const echo = (kind) => ({ name: `acme_${kind}`, kind, description: 'd', inputSchema: { type: 'object', properties: {} }, run: (args, ctx) => `${ctx.effort}|${ctx.effortFrom}` });
  const home = mkdtempSync(join(tmpdir(), 'omelette-161b-acme3-'));
  if (config) writeFileSync(join(home, 'fleet.config.json'), JSON.stringify(config));
  const u = defineUnit({ name: 'acme', bin: process.execPath, builtin: { effort: 'high' }, catalog, pairedEffort, tools: [echo('research'), echo('image')] });
  return createUnitRuntime(u, { env: { PATH: process.env.PATH, OMELETTE_HOME: home } });
}
const say = async (rt, tool, args) => (await rt.callTool(tool, args)).text;

test('1b round 3 (A): an image tool of a paired unit ignores a stray call `effort` too — effort and effortFrom empty', async () => {
  const rt = acmeRuntime();
  assert.equal(await say(rt, 'acme_image', { model: 'b', effort: 'low' }), '|');
  assert.equal(await say(rt, 'acme_image', { effort: 'bogus' }), '|', 'not even refused: it is not an effort this tool sends');
  // Without the opt-in an image tool is as it always was: the call's effort counts.
  assert.equal(await say(acmeRuntime({ pairedEffort: false }), 'acme_image', { effort: 'low' }), 'low|call');
});

test('1b round 3 (A): a stray `effort: "max"` on the real codex_image reaches neither the argv, the feed\'s active entry nor the record', async () => {
  const st = feedStation();
  const rt = execRuntime(st);
  await rt.callTool('codex_image', { prompt: 'a red circle', effort: 'max' });
  assert.equal(sentEffort(st.argvs()[0]), null);
  assert.equal(st.seen().active[0].effort, null, JSON.stringify(st.seen()));
  const [record] = spooled(st);
  assert.match(record, /^effort:$/m, record);
});

test('1b round 3 (B): a paired unit falls back to its built-in when the configured effort is refused (or cleared) and the model has no pairing', async () => {
  const refused = acmeRuntime({ config: { version: 1, units: { acme: { effort: 'none' } } } });
  assert.equal(await say(refused, 'acme_research', { model: 'c' }), 'high|builtin');
  assert.equal(await say(refused, 'acme_research', { model: 'b' }), 'medium|pairing');
  const cleared = acmeRuntime({ config: { version: 1, units: { acme: { effort: '' } } } });
  assert.equal(await say(cleared, 'acme_research', { model: 'c' }), 'high|builtin');
  assert.equal(await say(acmeRuntime(), 'acme_research', { model: 'c' }), 'high|builtin');
  // An operator's allowed effort still beats all of it.
  assert.equal(await say(acmeRuntime({ config: { version: 1, units: { acme: { effort: 'low' } } } }), 'acme_research', { model: 'c' }), 'low|config');
});

test('1b round 3 (1, 6): the effort description, GUIDE and codex_models\' title line say an omitted effort takes the model\'s pairing; GUIDE\'s AA figure says at max and when', async () => {
  const rt = createUnitRuntime(unit, { env: { ...process.env, OMELETTE_HOME: mkdtempSync(join(tmpdir(), 'omelette-161b-models-')), CODEX_BIN: process.execPath } });
  const text = (await rt.callTool('codex_models', {})).text;
  const title = text.split('\n')[0];
  assert.match(title, /^CODEX MODEL CATALOG \(.*; omit `effort` for the named model's pairing, the `<level> effort` tag on its entry, unless the operator configured one\):$/, title);
  assert.match(GUIDE, /omit it and the named model's pairing applies \(gpt-6\.1-sol and gpt-6-astra xhigh, gpt-6-sol high, the lunas medium\) unless the operator configured an effort/);
  assert.doesNotMatch(GUIDE, /xhigh \(the fleet default\)/);
  assert.match(GUIDE, /AA Intelligence Index 52 against astra's 53 at max effort, at \$0\.72 per Index task against astra's \$3\.26 \(AA, read 2026-09-30\)/);
});

test('1b round 3 (4): the shipped example, used as a fleet config, runs 6.1-sol at xhigh and luna at medium — its pairings, not a configured effort', async () => {
  const st = execStation();
  const rt = execRuntime(st, { config: JSON.parse(read('examples/fleet.config.json')) });
  assert.deepEqual(await oneCall(st, rt, {}), [HEAD, 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(await oneCall(st, rt, { model: 'gpt-6-luna' }), ['gpt-6-luna', 'model_reasoning_effort="medium"']);
  for (const rel of ['README.md', 'docs/CONFIG.md']) assert.doesNotMatch(read(rel), /"model": "gpt-6\.1-sol",?\s*"effort"/, rel);
});

test('1b round 3 (5): ARCHITECTURE, CONFIG and ADAPTERS document pairedEffort and the bundled-catalog tail', () => {
  const arch = read('docs/ARCHITECTURE.md');
  assert.match(arch, /^ {2}pairedEffort: true, +\/\/ codex only/m);
  assert.match(arch, /`auth: null`, `pairedEffort: false`\./);
  assert.ok(read('docs/CONFIG.md').includes("ends `— NOT in this CLI's bundled catalog: update codex (codex-cli 0.157.1 refused a model its bundle lacked)`"));
  assert.match(read('docs/ADAPTERS.md'), /A model entry's `effort` is applied only when the unit opts in with `pairedEffort: true` in its definition/);
});

test('1b round 3 (2, 3, C): CHANGELOG measures the pairing change against 1.6.0, names the changed 5.6 sentences, and carries the new doctor tail', () => {
  const entry = read('CHANGELOG.md').split(/^## /m).find((x) => x.startsWith('1.6.1'));
  assert.match(entry, /a call naming no model moves from `gpt-6-astra` at `high` to `gpt-6\.1-sol` at `xhigh`; a call naming `gpt-6-astra` moves from `high` to `xhigh`; `gpt-5\.6-terra` and `gpt-5\.6-sol` stay at `high`; `gpt-5\.6-luna` moves from `high` to `medium`/);
  assert.match(entry, /`results --stats` totals per unit, not per model or effort/);
  assert.doesNotMatch(entry, /keep their 2026-09-03 text/);
  assert.match(entry, /`gpt-5\.6-luna`'s "Step up to terra" becomes "Step up to gpt-6-sol, which supersedes terra"/);
  assert.match(entry, /`gpt-5\.6-sol` loses its PLAN-GATED sentences/);
  assert.ok(entry.includes("update codex (codex-cli 0.157.1 refused a model its bundle lacked)"), entry);
  assert.ok(!entry.includes('this CLI would refuse it'), entry);
  assert.match(entry, /Keeping an explicit `codex\.effort` is the way to force one effort for every model/);
});
