/**
 * omelette-fleet :: test/tester-1.7.2-t1t4.test.mjs
 * Tester additions for 1.7.2 T1 (relative PATH entries) and T4 (fleet-wide
 * billing scrub). Each test kills a mutant the implementer's two files let live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChildEnv, runProcess } from '../core/spawn.mjs';
import { gitChildEnv } from '../core/check.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const WIN = process.platform === 'win32';
const POSIX = { skip: WIN && 'POSIX executables and PATH' };
const tmp = () => mkdtempSync(join(tmpdir(), 'omelette-t1t4-'));
const usrBin = resolve('/usr/bin');

// ── T4 ──────────────────────────────────────────────────────────────────────

test('buildChildEnv: the caller\'s own scrub names still go, on top of BILLING_ENV', () => {
  const out = buildChildEnv({
    env: { PATH: usrBin, MYUNIT_SECRET: 's', MYUNIT_OK: 'k', OMELETTE_ENV_PASSTHROUGH: 'MYUNIT_*' },
    scrub: ['MYUNIT_SECRET'],
  });
  assert.equal(out.MYUNIT_SECRET, undefined);
  assert.equal(out.MYUNIT_OK, 'k');
});

test('buildChildEnv: `extra` is applied after the scrub, even for a BILLING_ENV name', () => {
  const out = buildChildEnv({ env: { PATH: usrBin, CODEX_API_KEY: 'parent' }, extra: { CODEX_API_KEY: 'adapter' } });
  assert.equal(out.CODEX_API_KEY, 'adapter');
});

test('buildChildEnv: an EXACT name in OMELETTE_ENV_PASSTHROUGH or in the adapter\'s own passthrough cannot re-admit another vendor\'s key', () => {
  const keys = ['CODEX_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GROK_TRACE_UPLOAD_URL', 'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES', 'CODEX_EXEC_SERVER_URL'];
  // CODEX_TIMEOUT_S is the positive control: a harmless name each path admits, so an absent key is the scrub's doing.
  const parent = { PATH: usrBin, CODEX_TIMEOUT_S: '30' };
  for (const k of keys) parent[k] = 'v';
  const viaEnv = buildChildEnv({ env: { ...parent, OMELETTE_ENV_PASSTHROUGH: [...keys, 'CODEX_TIMEOUT_S'].join(', ') }, scrub: [] });
  // No OMELETTE_ENV_PASSTHROUGH here: the adapter's own list is the only way in.
  const viaAdapter = buildChildEnv({ env: parent, passthrough: [...keys, 'CODEX_TIMEOUT_S'], scrub: [] });
  for (const k of keys) {
    assert.equal(viaEnv[k], undefined, `${k} via OMELETTE_ENV_PASSTHROUGH`);
    assert.equal(viaAdapter[k], undefined, `${k} via the adapter passthrough`);
  }
  assert.equal(viaEnv.CODEX_TIMEOUT_S, '30', 'OMELETTE_ENV_PASSTHROUGH admits a harmless name');
  assert.equal(viaAdapter.CODEX_TIMEOUT_S, '30', 'the adapter passthrough alone admits a harmless name');
});

test('runProcess: no scrubEnv at all, the fleet-wide scrub still holds the other vendors\' keys back', async () => {
  const r = await runProcess({
    bin: process.execPath,
    args: ['-e', 'console.log(JSON.stringify([process.env.GOOGLE_API_KEY, process.env.XAI_API_KEY, process.env.GROK_THEME]))'],
    env: { PATH: process.env.PATH, GOOGLE_API_KEY: 'g', XAI_API_KEY: 'x', GROK_THEME: 'dark', OMELETTE_ENV_PASSTHROUGH: 'GOOGLE_*,XAI_*,GROK_*' },
    hardKillMs: 10000,
  });
  assert.deepEqual(JSON.parse(r.stdout), [null, null, 'dark']);
});

// ── T1 ──────────────────────────────────────────────────────────────────────

test('runProcess inheritEnv: billing keys and every other variable pass whole; the parent object is not mutated', async () => {
  const parent = { PATH: ['rel', usrBin].join(delimiter), CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'a', CODEX_API_KEY: 'c' };
  const r = await runProcess({
    bin: process.execPath,
    args: ['-e', 'const e = process.env; console.log(JSON.stringify([e.CLAUDE_CONFIG_DIR, e.ANTHROPIC_API_KEY, e.CODEX_API_KEY]))'],
    env: parent, inheritEnv: true, hardKillMs: 10000,
  });
  assert.deepEqual(JSON.parse(r.stdout), ['/c', 'a', 'c']);
  assert.equal(parent.PATH, ['rel', usrBin].join(delimiter));
});

test('runProcess inheritEnv: a PATH of only relative entries leaves the child NO PATH (absent, not empty); extraEnv still wins', async () => {
  const probe = 'console.log(JSON.stringify({ has: "PATH" in process.env, path: process.env.PATH }))';
  const bare = await runProcess({
    bin: process.execPath, args: ['-e', probe],
    env: { PATH: ['rel', '', '.'].join(delimiter), HOME: '/h' }, inheritEnv: true, hardKillMs: 10000,
  });
  assert.equal(JSON.parse(bare.stdout).has, false);
  const forced = await runProcess({
    bin: process.execPath, args: ['-e', probe],
    env: { PATH: 'rel' }, extraEnv: { PATH: usrBin }, inheritEnv: true, hardKillMs: 10000,
  });
  assert.equal(JSON.parse(forced.stdout).path, usrBin);
});

test('runProcess inheritEnv: a bare command is never found through a relative PATH entry of the run\'s cwd', POSIX, async () => {
  const dir = tmp();
  mkdirSync(join(dir, 'rel'));
  const planted = join(dir, 'rel', 'planted-tool');
  writeFileSync(planted, `#!/bin/sh\necho RAN > '${join(dir, 'ran')}'\n`);
  chmodSync(planted, 0o755);
  await assert.rejects(runProcess({
    bin: 'planted-tool', args: [], cwd: dir,
    env: { PATH: ['rel', '', usrBin].join(delimiter) }, inheritEnv: true, hardKillMs: 10000,
  }), /not found|ENOENT/i);
  assert.equal(spawnSync('test', ['-e', join(dir, 'ran')]).status, 1, 'the planted tool never ran');
});

test('gitChildEnv: empty and relative entries dropped in place; only-relative leaves PATH absent; HOME still copied; parent untouched', () => {
  const parent = { PATH: ['bin', '', usrBin, '.', resolve('/opt')].join(delimiter), HOME: '/h' };
  const env = gitChildEnv(parent);
  assert.equal(env.PATH, [usrBin, resolve('/opt')].join(delimiter));
  assert.equal(env.HOME, '/h');
  assert.equal(parent.PATH, ['bin', '', usrBin, '.', resolve('/opt')].join(delimiter));
  const none = gitChildEnv({ PATH: ['bin', ''].join(delimiter), HOME: '/h' });
  assert.equal('PATH' in none, false);
  assert.equal(none.HOME, '/h');
  assert.equal('PATH' in gitChildEnv({}), false);
});

// whichBin through doctor (the bin file runs main on import).
function fakeCodex(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    `#!${process.execPath}`,
    "if (process.argv[2] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    'process.exit(1);',
  ].join('\n'));
  chmodSync(path, 0o755);
  return path;
}
function doctorCodexLine(dir, PATH, extra = {}) {
  const gone = join(dir, 'no-such');
  const r = spawnSync(process.execPath, [BIN, 'doctor'], {
    cwd: dir, encoding: 'utf8',
    env: { PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: gone, ...extra },
  });
  return ((r.stdout || '').match(/── codex[\s\S]*?bin\s+(.*)/) || [])[1] || `no codex bin line: ${r.stdout}${r.stderr}`;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('whichBin (via doctor): an empty entry (`::`) and `.` are skipped; the absolute entry after them is used', POSIX, () => {
  const dir = tmp();
  fakeCodex(join(dir, 'codex')); // in doctor's cwd: what `.` or an empty entry would find
  const abs = join(dir, 'abs');
  assert.match(doctorCodexLine(dir, ['', '.', abs].join(delimiter)), /^codex → not found in PATH/);
  const planted = fakeCodex(join(abs, 'codex'));
  assert.match(doctorCodexLine(dir, ['', '.', abs].join(delimiter)), new RegExp(`^codex → ${esc(planted)}\\s`));
});

test('whichBin (via doctor): an explicit CODEX_BIN path is checked as-is, whatever PATH holds', POSIX, () => {
  const dir = tmp();
  const explicit = fakeCodex(join(dir, 'elsewhere', 'my-codex'));
  assert.match(doctorCodexLine(dir, 'rel', { CODEX_BIN: explicit }), new RegExp(`^${esc(explicit)} → ${esc(explicit)}\\s`));
});
