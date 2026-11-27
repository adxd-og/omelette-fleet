// The tester's rows for the temp-directory clean-up (spec 2026-11-27-test-tmpdir-design.md) that the
// implementer's rows leave unpinned: the preload's other mkdtemp spellings and its "this process only,
// directly under the temp directory" rule; the sweep's name table, its mtime (not atime), its day and
// its budget at the default. Every row works under a base of its own (not `omelette-*`) and a TMPDIR of
// its own; the real temp directory is never read or swept.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUDGET_MS, MAX_AGE_MS, sweep } from '../scripts/tmp-sweep.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRELOAD = pathToFileURL(join(HERE, 'tmp-preload.mjs')).href;
const B = mkdtempSync(join(tmpdir(), 'tmp-tester-'));
after(() => rmSync(B, { recursive: true, force: true }));

// ---- the preload ---------------------------------------------------------------------------------

const FORMS = `
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { promises } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('forms', async () => {
  const made = {};
  const p = (k) => join(tmpdir(), k + '-');
  made.cb2 = await new Promise((res, rej) => fs.mkdtemp(p('cb2'), (e, d) => (e ? rej(e) : res(d))));
  made.promisified = await promisify(fs.mkdtemp)(p('prom'));
  const buf = fs.mkdtempSync(p('buf'), { encoding: 'buffer' });
  assert.ok(Buffer.isBuffer(buf), 'the buffer encoding still returns a Buffer');
  made.buf = buf.toString();
  made.req = createRequire(import.meta.url)('node:fs').mkdtempSync(p('req'));
  made.ns = await fsp.mkdtemp(p('ns'), { encoding: 'utf8' });
  made.promises = await promises.mkdtemp(p('pro'));
  const fixed = join(tmpdir(), 'fixed-parent');
  fs.mkdirSync(fixed);
  made.fixed = fixed;
  made.deep = fs.mkdtempSync(join(fixed, 'run-'));
  for (const v of Object.values(made)) assert.ok(fs.existsSync(v), v);
  fs.writeFileSync(process.env.FIXTURE_OUT, JSON.stringify(made));
});
`;

const OTHERS = `
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('others', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const code = "process.stdout.write(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'child-')))";
  const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0, r.stderr);
  const mine = mkdtempSync(join(tmpdir(), 'mine-'));
  writeFileSync(process.env.FIXTURE_OUT, JSON.stringify({ child: r.stdout, mine }));
});
`;

/** `source` as a fixture file under its own row, run by `node --import <preload> --test` on a TMPDIR of the row's own. */
const runFixture = (source, { before = () => {} } = {}) => {
  const row = mkdtempSync(join(B, 'row-'));
  const tmp = join(row, 'tmp');
  const out = join(row, 'out.json');
  const file = join(row, 'fixture.mjs');
  mkdirSync(tmp);
  writeFileSync(file, source);
  before(tmp);
  const env = { ...process.env, TMPDIR: tmp, FIXTURE_OUT: out };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--import', PRELOAD, '--test', file], { env, timeout: 30_000, encoding: 'utf8' });
  const output = `status ${r.status} signal ${r.signal}\n${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, output);
  assert.ok(existsSync(out), `the fixture never wrote its paths:\n${output}`);
  return { tmp, made: JSON.parse(readFileSync(out, 'utf8')), output };
};
const present = (made) => Object.fromEntries(Object.entries(made).map(([k, v]) => [k, existsSync(v)]));

test('preload: the two-argument callback, promisify, the buffer encoding, require, the namespace and fs.promises spellings are all removed', () => {
  const r = runFixture(FORMS);
  assert.deepEqual(present(r.made), {
    cb2: false, promisified: false, buf: false, req: false, ns: false, promises: false, fixed: true, deep: true,
  });
});

test('preload: a mkdtemp one level below the temp directory (inside a directory it did not mkdtemp) is not its own to remove', () => {
  const r = runFixture(FORMS);
  assert.deepEqual(readdirSync(r.tmp), ['fixed-parent']);
  assert.equal(readdirSync(r.made.fixed).length, 1);
});

test("preload: a directory already there and one another process made stay; the process's own goes", () => {
  const r = runFixture(OTHERS, {
    before: (tmp) => {
      mkdirSync(join(tmp, 'omelette-pre-Ab3xYz'));
      writeFileSync(join(tmp, 'omelette-pre-Ab3xYz', 'f'), 'x');
      mkdirSync(join(tmp, 'plain'));
      writeFileSync(join(tmp, 'a-file'), 'x');
    },
  });
  assert.deepEqual(present(r.made), { child: true, mine: false });
  assert.deepEqual(readdirSync(r.tmp).filter((n) => !n.startsWith('child-')).sort(), ['a-file', 'omelette-pre-Ab3xYz', 'plain']);
  assert.ok(existsSync(join(r.tmp, 'omelette-pre-Ab3xYz', 'f')));
});

// ---- the sweep -----------------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const NOW = Math.floor(Date.now() / 1000) * 1000;
const rootOf = () => mkdtempSync(join(B, 'root-'));
const dir = (root, name, ms) => { const p = join(root, name); mkdirSync(p, { recursive: true }); const t = new Date(NOW - ms); utimesSync(p, t, t); return p; };

test('sweep: near-misses of the name stay, however old (anchored both ends, exactly six characters of the alphabet, a dash before them)', () => {
  const root = rootOf();
  const stay = [
    'xomelette-x-Ab3xYz', 'not-omelette-x-Ab3xYz', 'omelette-x-Ab3xY', 'omelette-x-Ab3xYz1',
    'omelette-x-Ab3xYz-', 'omelette-x-Ab3x_z', 'omelette-x-Ab3x.z', 'omelette-x-Ab3 xz', 'omelette-xAb3xYz', 'omelette-evals-snapshots',
  ];
  for (const n of stay) dir(root, n, 48 * HOUR);
  dir(root, 'omelette-x-Ab3xYz', 48 * HOUR);
  assert.deepEqual(sweep({ root, now: NOW }).removed, ['omelette-x-Ab3xYz']);
  assert.deepEqual(readdirSync(root).sort(), [...stay].sort());
});

test('sweep: it does not descend: an old matching name inside a kept directory stays', () => {
  const root = rootOf();
  dir(root, 'omelette-evals', 48 * HOUR);
  const inner = dir(join(root, 'omelette-evals'), 'omelette-x-Ab3xYz', 48 * HOUR);
  dir(root, 'other', 48 * HOUR);
  dir(join(root, 'other'), 'omelette-x-Ab3xYz', 48 * HOUR);
  assert.deepEqual(sweep({ root, now: NOW }), { removed: [], failed: [], stopped: false });
  assert.ok(existsSync(inner));
  assert.ok(existsSync(join(root, 'other', 'omelette-x-Ab3xYz')));
});

test('sweep: the day is 24 hours at the default: 23 h stays, 25 h goes; the age is the modification time, not the access time', () => {
  const root = rootOf();
  dir(root, 'omelette-a-Ab3xYz', 23 * HOUR);
  dir(root, 'omelette-b-Ab3xYz', 25 * HOUR);
  // modified long ago, read just now: stale. Modified just now, read long ago: fresh.
  const mOld = dir(root, 'omelette-c-Ab3xYz', 0);
  utimesSync(mOld, new Date(NOW), new Date(NOW - 48 * HOUR));
  const mNew = dir(root, 'omelette-d-Ab3xYz', 0);
  utimesSync(mNew, new Date(NOW - 48 * HOUR), new Date(NOW));
  assert.equal(MAX_AGE_MS, 24 * HOUR);
  assert.deepEqual(sweep({ root, now: NOW }).removed.sort(), ['omelette-b-Ab3xYz', 'omelette-c-Ab3xYz']);
  assert.deepEqual(readdirSync(root).sort(), ['omelette-a-Ab3xYz', 'omelette-d-Ab3xYz']);
});

test('sweep: the budget at the default is five seconds of wall clock: stopped at 5000 ms since the call began, not before', () => {
  const root = rootOf();
  for (const n of ['omelette-a-Ab3xYz', 'omelette-b-Ab3xYz', 'omelette-c-Ab3xYz']) dir(root, n, 48 * HOUR);
  assert.equal(BUDGET_MS, 5000);
  const real = Date.now;
  let calls = 0;
  // began = T; the first matching name is looked at 4999 ms in; the second at 5000.
  Date.now = () => { calls += 1; return NOW + (calls === 1 ? 0 : calls === 2 ? 4999 : 5000); };
  let r;
  try { r = sweep({ root, now: NOW }); } finally { Date.now = real; }
  assert.equal(r.stopped, true);
  assert.equal(r.removed.length, 1, 'one went before the budget ran out');
  assert.equal(readdirSync(root).length, 2, 'the rest is left for the next run');
});

// A directory it cannot remove is ignored: the next one still goes, and the process's own exit status is untouched.
const STUCK = `
import test from 'node:test';
import { mkdirSync, mkdtempSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('stuck', () => {
  const a = mkdtempSync(join(tmpdir(), 'a-'));
  mkdirSync(join(a, 'sub'));
  writeFileSync(join(a, 'sub', 'f'), 'x');
  chmodSync(join(a, 'sub'), 0o500);
  const b = mkdtempSync(join(tmpdir(), 'b-'));
  writeFileSync(process.env.FIXTURE_OUT, JSON.stringify({ a, b }));
});
`;
test('preload: one directory that cannot be removed does not stop the next, and the exit status stays 0', { skip: process.getuid?.() === 0 && 'root removes a directory under a 0500 one' }, () => {
  let r;
  try {
    r = runFixture(STUCK);
  } finally {
    // runFixture asserts status 0 itself; put the mode back so the base can be removed whatever happened.
    for (const row of readdirSync(B)) {
      const sub = join(B, row, 'tmp');
      if (!existsSync(sub)) continue;
      for (const d of readdirSync(sub)) { try { chmodSync(join(sub, d, 'sub'), 0o700); } catch { /* not this row's */ } }
    }
  }
  assert.deepEqual(present(r.made), { a: true, b: false });
});

// readdir order is the file system's (hash order on Linux ext4): with eight that stay stuck and eight that
// go, a sweep that stops at its first failure leaves some of the eight whatever the order.
test('sweep: failures do not stop the rest, whatever order the names are listed in', { skip: process.getuid?.() === 0 && 'root removes a directory under a 0500 one' }, () => {
  const root = rootOf();
  const stuck = [];
  const go = [];
  for (let i = 0; i < 8; i += 1) {
    const s = join(root, `omelette-s${i}-Ab3xYz`);
    mkdirSync(join(s, 'sub'), { recursive: true });
    writeFileSync(join(s, 'sub', 'f'), 'x');
    chmodSync(join(s, 'sub'), 0o500);
    const t = new Date(NOW - 48 * HOUR);
    utimesSync(s, t, t);
    stuck.push(s);
    go.push(`omelette-g${i}-Ab3xYz`);
    dir(root, go[i], 48 * HOUR);
  }
  try {
    const r = sweep({ root, now: NOW });
    assert.deepEqual(r.removed.sort(), go);
    assert.equal(r.failed.length, 8);
    assert.equal(r.stopped, false);
  } finally {
    for (const s of stuck) chmodSync(join(s, 'sub'), 0o700);
  }
});
