/**
 * omelette-fleet :: test/path-entries-1.7.2.test.mjs
 * 1.7.2 T1: a relative PATH entry is never searched — not by the units (they
 * already drop it), not by `doctor`/`install` resolving a binary (`whichBin`),
 * not by the `git` that `check` runs inside the checked repository.
 * `whichBin` is driven through `doctor` as a child process: the bin file runs
 * `main` on import, so it cannot be imported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absolutePathEntries, runProcess } from '../core/spawn.mjs';
import { changedSince } from '../core/check.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const WIN = process.platform === 'win32';
const tmp = () => mkdtempSync(join(tmpdir(), 'omelette-path-'));

test('absolutePathEntries keeps the absolute, non-empty entries, in order', () => {
  const a = resolve('/usr/bin');
  const b = resolve('/opt');
  assert.deepEqual(absolutePathEntries(['bin', a, '', join('rel', 'x'), b].join(delimiter)), [a, b]);
  assert.deepEqual(absolutePathEntries(''), []);
  assert.deepEqual(absolutePathEntries(undefined), []);
});

function fakeCodex(dir) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'codex');
  writeFileSync(p, [
    `#!${process.execPath}`,
    "if (process.argv[2] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    'process.exit(1);',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

function doctorCodexLine(dir, PATH) {
  const gone = join(dir, 'no-such');
  const r = spawnSync(process.execPath, [BIN, 'doctor'], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: gone },
  });
  return ((r.stdout || '').match(/── codex[\s\S]*?bin\s+(.*)/) || [])[1] || `no codex bin line: ${r.stdout}${r.stderr}`;
}

test('whichBin (via doctor): a relative PATH entry is never searched; an absolute one is', { skip: WIN && 'POSIX executables' }, () => {
  const dir = tmp();
  fakeCodex(join(dir, 'rel')); // rel/codex, relative to doctor's cwd
  const abs = join(dir, 'abs');
  mkdirSync(abs);
  const PATH = ['rel', abs].join(delimiter);
  assert.match(doctorCodexLine(dir, PATH), /^codex → not found in PATH/);
  const planted = fakeCodex(abs);
  assert.match(doctorCodexLine(dir, PATH), new RegExp(`^codex → ${planted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`));
});

test('changedSince: the git child gets no relative PATH entry', { skip: WIN && 'POSIX shell stub' }, () => {
  const dir = tmp();
  const stubDir = join(dir, 'stub');
  mkdirSync(stubDir);
  const seen = join(dir, 'seen-path');
  // A stand-in git: records the PATH it was given and reports no change.
  writeFileSync(join(stubDir, 'git'), `#!/bin/sh\nprintf '%s' "$PATH" > '${seen}'\nexit 0\n`);
  chmodSync(join(stubDir, 'git'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = ['rel', '', stubDir].join(delimiter);
  try {
    changedSince({ hash: 'abcdef1', root: dir });
  } finally {
    process.env.PATH = saved;
  }
  const entries = readFileSync(seen, 'utf8').split(delimiter);
  assert.deepEqual(entries, [stubDir]);
  assert.ok(entries.every((e) => e && isAbsolute(e)));
});

test('runProcess inheritEnv: the parent env passes whole, except PATH\'s relative entries', async () => {
  const usrBin = resolve('/usr/bin');
  const r = await runProcess({
    bin: process.execPath,
    args: ['-e', 'console.log(JSON.stringify({ PATH: process.env.PATH, FOO: process.env.FOO }))'],
    env: { PATH: ['rel', '', usrBin].join(delimiter), FOO: 'bar' },
    inheritEnv: true,
    hardKillMs: 10000,
  });
  const seen = JSON.parse(r.stdout);
  assert.deepEqual(seen.PATH.split(delimiter), [usrBin]);
  assert.equal(seen.FOO, 'bar', 'every other variable still passes');
});
