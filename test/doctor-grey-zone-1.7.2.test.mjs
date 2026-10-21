/**
 * omelette-fleet :: test/doctor-grey-zone-1.7.2.test.mjs
 * 1.7.2 T6: `doctor` prints the Antigravity grey-zone notice in the gemini
 * block only, and the notice is never a problem — it does not make a healthy,
 * registered gemini a FAULT and does not change the exit code.
 *
 * doctor has no per-unit filter (it always reports gemini, grok and codex), so
 * "gemini absent" is checked as: the notice is in no other unit's block.
 * Same harness as test/cli.test.mjs: the CLI runs as a child process under a
 * temp HOME / OMELETTE_HOME with a fake vendor binary; nothing real is touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const NOTICE = `  notice      Antigravity's FAQ calls wrapping agy inside another coding agent "not supported under consumer plans" (read 2026-10-21): a grey zone, and your account's risk — docs/SECURITY.md, "Antigravity's terms: a grey zone"`;

function cli(args, dir, env) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function fakeBin(dir) {
  const p = join(dir, 'fake-cli');
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    "if (a[0] === 'models') { console.log('model-a'); console.log('model-b'); process.exit(0); }",
    "if (a[0] === 'login' && a[1] === 'status') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }",
    'process.exit(1);',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** The text of one unit's block: from its header to the next header (or the end). */
function block(out, name) {
  const m = out.match(new RegExp(`── ${name} \\([\\s\\S]*?(?=\\n── |$)`));
  assert.ok(m, `no ${name} block in:\n${out}`);
  return m[0];
}

test('doctor: the grey-zone notice is printed once, in the gemini block, after the warnings and before mcp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grey-'));
  const fake = fakeBin(dir);
  const r = cli(['doctor'], dir, { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: fake });
  assert.equal(r.code, 0, r.out + r.err);
  const lines = r.out.split('\n');
  assert.equal(lines.filter((l) => l === NOTICE).length, 1, r.out);
  const gemini = block(r.out, 'gemini').split('\n');
  const at = gemini.indexOf(NOTICE);
  assert.ok(at > 0, 'notice not in the gemini block');
  assert.match(gemini[at + 1], /^ {2}mcp {9}/); // right after the warnings loop, right before mcp
  assert.match(gemini[at - 1], /^ {2}(config|warning) |^ {14}/);
});

test('doctor: grok and codex blocks carry no grey-zone notice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grey-'));
  const fake = fakeBin(dir);
  const r = cli(['doctor'], dir, { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: fake });
  for (const name of ['grok', 'codex']) assert.doesNotMatch(block(r.out, name), /notice|grey zone/);
});

test('doctor: the notice is not a problem — a registered, healthy gemini is no FAULT and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grey-'));
  const fake = fakeBin(dir);
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-gemini': { command: 'node', args: [join(ROOT, 'servers', 'gemini.mjs')] } },
  }));
  const r = cli(['doctor'], dir, { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: fake });
  assert.match(r.out, /omelette-gemini registered \(user\) → node .*servers.*gemini\.mjs \[file exists\]/);
  assert.ok(r.out.includes(NOTICE), r.out);
  assert.equal(r.code, 0, r.out + r.err);
  assert.doesNotMatch(r.out, /FAULT/);
  assert.match(r.out, /No faults in units that are both enabled and registered\./);
});
