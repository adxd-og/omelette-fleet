/**
 * omelette-fleet :: test/tester-1.6.0-t5b.test.mjs
 * Clean-context tester for 1.6.0 Task 5b ("Grok 4.7 in the catalog, and
 * `doctor` compares the CLI's default with the catalog"), written against the
 * plan section (docs/superpowers/plans/2026-09-25-1.6.0-result-truth.md,
 * "Task 5b", Step 3). It covers what test/tester-1.6.0-r5b.test.mjs does not:
 * doctor's escaping of the reported default and the two negative cases (a
 * probe that is not 'in', and the units that never report a default), and
 * the model enum the grok tools actually serve in tools/list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { visible } from '../core/log.mjs';
import unit from '../units/grok/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** A fresh OMELETTE_HOME dir + env for createUnitRuntime. */
function rtEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t5b-unit-'));
  return { dir, env: { ...process.env, OMELETTE_HOME: dir, ...extra } };
}

// --- doctor: escaping, a probe that never reaches 'in', and the units --
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

// Retitled in 1.6.1: codex gained a models line of its own, read from
// `codex debug models --bundled` (test/codex-catalog-1.6.1.test.mjs); this
// fake does not answer that subcommand, so the pin below still holds for it.
test('doctor: gemini never prints a models line; codex prints one only when `debug models` answers — never from "Default model:" in its login output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t5b-others-'));
  const sneaky = 'Default model: sneaky\n';
  const agy = fakeBin(dir, 'fake-agy', { modelsOut: `model-a\n${sneaky}` });
  const codex = fakeBin(dir, 'fake-codex', { loginOut: `Logged in using ChatGPT\n${sneaky}`, loginStream: 'stderr' });
  const grokGone = join(dir, 'no-such-grok');
  const r = runDoctor({ AGY_BIN: agy, GROK_BIN: grokGone, CODEX_BIN: codex });
  assert.doesNotMatch(r.gemini, /^  models /m, r.gemini);
  assert.doesNotMatch(r.codex, /^  models /m, r.codex);
});

// --- tools/list model enum -------------

test('tools/list: grok_research/grok_code_review model enum is exactly the three ids', () => {
  const { env } = rtEnv({ GROK_BIN: process.execPath });
  const rt = createUnitRuntime(unit, { env });
  for (const name of ['grok_research', 'grok_code_review']) {
    const tool = rt.tools.find((t) => t.name === name);
    assert.ok(tool, `${name} missing from tools/list`);
    assert.deepEqual(tool.inputSchema.properties.model.enum, ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6']);
  }
});
