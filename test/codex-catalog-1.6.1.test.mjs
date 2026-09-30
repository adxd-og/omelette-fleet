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
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import unit from '../units/codex/adapter.mjs';
import {
  CODEX_MODELS, ALLOWLIST, EFFORTS, DEFAULT_MODEL, GUIDE, isAllowedModel, isAllowedEffort,
} from '../units/codex/models.js';
import { createUnitRuntime } from '../core/unit.mjs';

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

test('the fleet default effort is xhigh: the unit built-in, the tool description and the shipped example agree', () => {
  assert.equal(unit.builtin.effort, 'xhigh');
  const desc = unit.tools.find((t) => t.name === 'codex_research').inputSchema.properties.effort.description;
  assert.doesNotMatch(desc, /\bnone\b/);
  assert.match(desc, /xhigh = the fleet default/);
  assert.match(desc, /max\/ultra = manual escalation/);
  const example = JSON.parse(read('examples/fleet.config.json'));
  assert.equal(example.units.codex.model, HEAD);
  assert.equal(example.units.codex.effort, 'xhigh');
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
  assert.match(read('CHANGELOG.md'), /^## 1\.6\.1 — unreleased$/m);
});
