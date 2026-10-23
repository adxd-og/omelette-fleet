/**
 * omelette-fleet :: test/tester-t2c-doctor-kill.test.mjs
 * T2c tester: doctor's `codex debug models --bundled` probe is hard-killed, not
 * waited out. test/tester-1.6.1-t1.test.mjs pins "not killed EARLY" (a floor of
 * 19 s) but its fake exits silently on its own at 30 s, and a probe that ends
 * silently reads the same as a killed one — so a doctor whose kill never fires
 * (hardKillMs raised past the fake's own exit) passed that test. Here the fake
 * leaves a mark only if it lives to its own exit: after doctor returns the mark
 * must be absent, whatever the clock said.
 *
 * No wall-clock bound: the kill is due 20 s after the spawn and the fake's own
 * exit 30 s after its start, so the order of the two does not depend on load
 * short of a 10 s stall of doctor's event loop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

test('doctor: a `debug models` probe that outlives its 20 s is killed — it never reaches its own exit', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t2c-dk-'));
  const started = join(dir, 'probe-started');
  const naturalExit = join(dir, 'probe-reached-its-own-exit');
  const fake = join(dir, 'fake-codex');
  writeFileSync(fake, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('codex-cli 0.159.2'); process.exit(0); }",
    "if (a[0] === 'login' && a[1] === 'status') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }",
    "if (a.join(' ') === 'debug models --bundled') {",
    "  process.stdin.on('data', () => {}).on('end', () => {",
    `    fs.writeFileSync(${JSON.stringify(started)}, '');`,
    `    setTimeout(() => { fs.writeFileSync(${JSON.stringify(naturalExit)}, ''); process.exit(0); }, 30000);`,
    '  });',
    '  process.stdin.resume();',
    "} else { process.exit(1); }",
  ].join('\n'));
  chmodSync(fake, 0o755);
  const gone = join(dir, 'no-such');
  const env = {
    PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0',
    AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: fake,
  };
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'doctor'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (status) => resolve({ status, out }));
  });
  assert.equal(r.status, 0, r.out);
  assert.equal(existsSync(started), true, 'the probe ran (the test would pass vacuously otherwise)');
  assert.equal(existsSync(naturalExit), false, 'the probe was killed before its own exit: doctor does not wait a hung probe out');
});
