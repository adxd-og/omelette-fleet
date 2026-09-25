/**
 * omelette-fleet :: test/tester-1.6.0-r5b.test.mjs
 * 1.6.0 Task 5b: Grok 4.7 in the catalog (4.7, 4.7-build-fast, 4.6 as the
 * fallback; 4.5 out), and `doctor` prints the grok CLI's reported default
 * beside the catalog, saying when the two disagree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROK_MODELS, ALLOWLIST, isAllowedModel, GUIDE, DEFAULT_MODEL } from '../units/grok/models.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

test('the grok catalog is 4.7, 4.7-build-fast and 4.6 — 4.5 is two generations back', () => {
  assert.deepEqual(ALLOWLIST, ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6']);
  assert.equal(isAllowedModel('grok-4.7'), true);
  assert.equal(isAllowedModel('grok-4.5'), false);
  assert.equal(DEFAULT_MODEL, '', 'omit --model: the CLI default is the fleet default');
  const m47 = GROK_MODELS.find((m) => m.id === 'grok-4.7');
  assert.match(m47.useFor, /CLI DEFAULT since 2026-09-21/);
  assert.match(m47.avoid, /no AA-Omniscience figure for 4\.7 was verified/);
  const fast = GROK_MODELS.find((m) => m.id === 'grok-4.7-build-fast');
  assert.match(fast.useFor, /twice the output speed at twice the price/);
  assert.equal(fast.tier, 'fast');
  assert.match(GROK_MODELS.find((m) => m.id === 'grok-4.6').useFor, /^SUPERSEDED by grok-4\.7/);
  assert.match(GUIDE, /^grok-4\.7 \(released 2026-09-21, the CLI default/);
  assert.match(GUIDE, /Omit the model param to keep grok's default \(grok-4\.7\); grok-4\.6 remains only as a regression fallback/);
  assert.doesNotMatch(GUIDE, /grok-4\.5/);
});

/** A fake vendor CLI whose `models` prints `modelsOut` verbatim (the doctor fixture of cli.test.mjs). */
function fakeBin(dir, modelsOut) {
  const p = join(dir, 'fake-cli');
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    `if (a[0] === 'models') { process.stdout.write(${JSON.stringify(modelsOut)}); process.exit(0); }`,
    "if (a[0] === 'login' && a[1] === 'status') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }",
    "console.error('unexpected argv: ' + a.join(' '));",
    'process.exit(1);',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** doctor with a fresh fleet home; only grok has a binary, so only its block probes `models`. */
function doctorWith(modelsOut) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-r5b-'));
  const fake = fakeBin(dir, modelsOut);
  const gone = join(dir, 'no-such');
  const r = spawnSync(process.execPath, [BIN, 'doctor'], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone },
  });
  const out = r.stdout || '';
  const grok = out.slice(out.indexOf('── grok'), out.indexOf('── codex'));
  return { out, err: r.stderr || '', grok };
}

test('doctor: a grok CLI default that is not in the catalog is named, with what the catalog knows', () => {
  const r = doctorWith('Default model: grok-9\n\nAvailable models:\n  * grok-9 (default)\n  - grok-4.7\n');
  assert.match(r.grok, /^  models {6}CLI default grok-9 — NOT in the catalog \(units\/grok\/models\.js knows grok-4\.7, grok-4\.7-build-fast, grok-4\.6\) — every call that omits `model` runs on it; update the catalog$/m, r.out + r.err);
});

test('doctor: a grok CLI default that the catalog carries reads "in the catalog"', () => {
  const r = doctorWith('Default model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n');
  assert.match(r.grok, /^  models      CLI default grok-4\.7 — in the catalog$/m, r.out + r.err);
});

test('doctor: no "Default model:" line from grok, no models line', () => {
  const r = doctorWith('model-a\nmodel-b\n');
  assert.match(r.grok, /^  login       OK/m, r.out + r.err);
  assert.doesNotMatch(r.out, /^  models /m);
});
