/**
 * omelette-fleet :: test/outputcap-tester.test.mjs
 * Tester coverage for spec 2026-09-06-0.3.2, section 3 ("Grok: front-truncated
 * streams" / `outputCap`), written against the diff in
 * .omelette/reports/review-B.diff. Does not edit the implementation or the
 * implementer's own tests (test/config.test.mjs, test/grok.test.mjs,
 * test/spawn.test.mjs, test/unit.test.mjs already cover a good deal of this;
 * this file targets what those left uncovered:
 *   - the CLI surface (`show`/`set`) for the new `outputCap` key,
 *   - interpretGrok's DEFAULT outputCap parameter (GROK_OUTPUT_CAP) when a
 *     caller omits it entirely, rather than always passing one explicitly,
 *   - the exact TAIL kept by runProcess's cap (not just length + a shared
 *     suffix literal),
 *   - the real codex/gemini unit objects resolving to the fleet default
 *     (400 000) through their OWN builtin/envMap/extraSchema, not a synthetic
 *     stand-in — the concrete case the spec's "an unrelated unit" line names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../core/spawn.mjs';
import { unitConfig } from '../core/config.mjs';
import grokUnit, { interpretGrok, GROK_OUTPUT_CAP } from '../units/grok/adapter.mjs';
import codexUnit from '../units/codex/adapter.mjs';
import geminiUnit from '../units/gemini/adapter.mjs';

const node = process.execPath;
const ok = (over = {}) => ({ stdout: '', stderr: '', code: 0, killed: false, capped: false, ...over });

// ─── runProcess: the exact TAIL, not just a length + a shared-literal suffix ──

test('runProcess: a tiny outputCap keeps the exact trailing characters, nothing from the front', async () => {
  const r = await runProcess({
    bin: node,
    args: ['-e', 'process.stdout.write("0123456789ABCDEFGHIJ")'], // 20 chars, alphabet-distinct so "tail" is unambiguous
    outputCap: 10,
  });
  assert.equal(r.stdout, 'ABCDEFGHIJ'); // exactly the LAST 10 chars — not "ends with", not "same length"
  assert.equal(r.capped, true);
});

test('runProcess: `capped` stays false right up to the boundary — one char over flips it', async () => {
  const atCap = await runProcess({ bin: node, args: ['-e', 'process.stdout.write("a".repeat(50))'], outputCap: 50 });
  assert.equal(atCap.stdout.length, 50);
  assert.equal(atCap.capped, false);
  const overByOne = await runProcess({ bin: node, args: ['-e', 'process.stdout.write("a".repeat(51))'], outputCap: 50 });
  assert.equal(overByOne.stdout.length, 50);
  assert.equal(overByOne.capped, true);
});

// ─── interpretGrok: the DEFAULT outputCap (GROK_OUTPUT_CAP) when omitted ──────

test('interpretGrok: `outputCap` defaults to GROK_OUTPUT_CAP when the caller omits it', () => {
  // The VALUE of the constant is pinned once, in test/grok.test.mjs's unit
  // contract. Everything here derives from it, so raising the built-in is a
  // one-line change and not a hunt through the suite.
  // capped && !parsed, no outputCap in opts at all — the thrown message must
  // still name a real number, not "undefined", and it must be the built-in.
  assert.throws(
    () => interpretGrok(ok({ stdout: '_reason":"end_turn","usage":{"input_tokens":10}}\n', capped: true }), { jsonMode: true, timeoutS: 300 }),
    new RegExp(`^Error: grok output exceeded the ${GROK_OUTPUT_CAP} char cap and the final result line was lost — raise grok\\.outputCap or narrow the task$`),
  );
  // capped && parsed, no outputCap in opts: the partial marker names the same number.
  const marked = interpretGrok(ok({
    stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'tail of the answer', stop_reason: 'end_turn' }) + '\n',
    capped: true,
  }), { jsonMode: true, timeoutS: 300 });
  assert.match(marked.text, /^tail of the answer/);
  assert.match(marked.text, new RegExp(`\\[grok: output capped at ${GROK_OUTPUT_CAP} chars — the beginning of the stream was dropped; treat the answer as partial\\]`));
  assert.equal(marked.partial, true);
});

// ─── real unit objects: grok raises the built-in, codex/gemini stay at the fleet default ──

const MODES = { 'read-only': true, 'workspace-write': true };

function tmpHome(config) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-oc-cfg-'));
  if (config !== undefined) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(config));
  return dir;
}

test('unitConfig resolves outputCap through the REAL adapter objects: grok raised, codex/gemini at the fleet default', () => {
  const env = { OMELETTE_HOME: tmpHome() };
  const grokCfg = unitConfig({
    unit: grokUnit.name, envMap: grokUnit.envMap, builtin: grokUnit.builtin, extraSchema: grokUnit.extraSchema,
    supportedModes: grokUnit.supportedModes, env,
  });
  assert.equal(grokCfg.values.outputCap, GROK_OUTPUT_CAP);
  assert.equal(grokCfg.sources.outputCap, 'default');

  const codexCfg = unitConfig({
    unit: codexUnit.name, envMap: codexUnit.envMap, builtin: codexUnit.builtin, extraSchema: codexUnit.extraSchema,
    supportedModes: codexUnit.supportedModes, env,
  });
  assert.equal(codexCfg.values.outputCap, 400000, 'codex declares no outputCap builtin — the unrelated unit stays at the fleet default');
  assert.equal(codexCfg.sources.outputCap, 'default');
  assert.equal('outputCap' in codexUnit.builtin, false, 'codex adapter never opts into the raised cap');

  const geminiCfg = unitConfig({
    unit: geminiUnit.name, envMap: geminiUnit.envMap, builtin: geminiUnit.builtin, extraSchema: geminiUnit.extraSchema,
    supportedModes: geminiUnit.supportedModes, env,
  });
  assert.equal(geminiCfg.values.outputCap, 400000);
  assert.equal('outputCap' in geminiUnit.builtin, false);
});

test('unitConfig: a fleet-wide `defaults.outputCap` still narrows codex even though grok raised its own builtin', () => {
  // defaults applies to every unit BEFORE the per-unit file layer; grok's file
  // layer says nothing here, so grok's builtin (GROK_OUTPUT_CAP) still wins —
  // this is the same precedence config.test.mjs exercises, checked here against
  // the real adapter objects instead of a hand-built `builtin` stand-in.
  const env = { OMELETTE_HOME: tmpHome({ defaults: { outputCap: 90000 } }) };
  const codexCfg = unitConfig({
    unit: codexUnit.name, envMap: codexUnit.envMap, builtin: codexUnit.builtin, extraSchema: codexUnit.extraSchema,
    supportedModes: codexUnit.supportedModes, env,
  });
  assert.equal(codexCfg.values.outputCap, 90000);
  assert.equal(codexCfg.sources.outputCap, 'file:defaults');
  const grokCfg = unitConfig({
    unit: grokUnit.name, envMap: grokUnit.envMap, builtin: grokUnit.builtin, extraSchema: grokUnit.extraSchema,
    supportedModes: grokUnit.supportedModes, env,
  });
  assert.equal(grokCfg.values.outputCap, 90000, '`defaults` still overrides a unit builtin — it sits above it in resolution order');
  assert.equal(grokCfg.sources.outputCap, 'file:defaults');
});

// ─── CLI: `show grok` and `set <unit>.outputCap=...` ──────────────────────────

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-oc-cli-'));
}

function cli(args, { dir, env = {} } = {}) {
  const r = spawnSync(node, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('CLI show: grok reports its raised built-in; gemini/codex report the fleet default (400 000)', () => {
  const dir = home();
  const grok = cli(['show', 'grok'], { dir });
  assert.equal(grok.code, 0);
  assert.match(grok.out, new RegExp(`^\\s+outputCap\\s+${GROK_OUTPUT_CAP}\\s+default$`, 'm'));
  const codex = cli(['show', 'codex'], { dir });
  assert.match(codex.out, /^\s+outputCap\s+400000\s+default$/m);
  const gemini = cli(['show', 'gemini'], { dir });
  assert.match(gemini.out, /^\s+outputCap\s+400000\s+default$/m);
});

test('CLI set: grok.outputCap=1000 is accepted, persisted, and read back by show', () => {
  const dir = home();
  const s = cli(['set', 'grok.outputCap=1000'], { dir });
  assert.equal(s.code, 0);
  assert.match(s.out, new RegExp(`grok\\.outputCap\\s+${GROK_OUTPUT_CAP} \\[default\\] → 1000 \\[file\\]`));
  const shown = cli(['show', 'grok'], { dir });
  assert.match(shown.out, /^\s+outputCap\s+1000\s+file$/m);
});

test('CLI set: grok.outputCap=0 and grok.outputCap=abc are both refused — exit 1, nothing written', () => {
  const dir = home();
  const zero = cli(['set', 'grok.outputCap=0'], { dir });
  assert.equal(zero.code, 1);
  assert.match(zero.err, /invalid value for grok\.outputCap: "0" — expected a positive integer/);
  const word = cli(['set', 'grok.outputCap=abc'], { dir });
  assert.equal(word.code, 1);
  assert.match(word.err, /invalid value for grok\.outputCap: "abc" — expected a positive integer/);
  // Neither refusal wrote the config file at all.
  const shown = cli(['show', 'grok'], { dir });
  assert.match(shown.out, new RegExp(`^\\s+outputCap\\s+${GROK_OUTPUT_CAP}\\s+default$`, 'm'));
});
