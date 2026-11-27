// scripts/tmp-sweep.mjs — the net `pretest` casts before the suite: an entry of a temp directory goes
// only when its name is omelette-<anything>-<six mkdtemp characters>, lstat says a directory, it is
// this user's and it is more than a day old; a link is never followed. Every row builds its own root
// under this file's base and passes `now`; the script rows give the child a TMPDIR of their own, so
// the real temp directory is never swept.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_AGE_MS, sweep } from '../scripts/tmp-sweep.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'tmp-sweep.mjs');
const B = mkdtempSync(join(tmpdir(), 'tmp-sweep-test-'));
after(() => rmSync(B, { recursive: true, force: true }));

const HOUR = 60 * 60 * 1000;
const OLD = 25 * HOUR;
// A whole second, so an age set through utimes reads back exactly.
const NOW = Math.floor(Date.now() / 1000) * 1000;
const rootOf = () => mkdtempSync(join(B, 'root-'));
/** Set `p`'s times to `ms` before NOW (`link`: the link's own, not its target's). */
const age = (p, ms, { link = false } = {}) => { const t = new Date(NOW - ms); (link ? lutimesSync : utimesSync)(p, t, t); };
/** A directory `name` in `root`, `ms` old. */
const dir = (root, name, ms) => { const p = join(root, name); mkdirSync(p); age(p, ms); return p; };
const nothing = { removed: [], failed: [], stopped: false };

test('the table', () => {
  const root = rootOf();
  const x = join(root, 'omelette-x-Ab3xYz');
  mkdirSync(x);
  writeFileSync(join(x, 'f'), 'x');
  age(x, OLD);
  dir(root, 'omelette-y-Ab3xYz', HOUR);
  const evals = join(root, 'omelette-evals');
  mkdirSync(join(evals, 'snapshots', 'abc'), { recursive: true });
  writeFileSync(join(evals, 'snapshots', 'abc', 'f'), 'x');
  age(evals, OLD);
  dir(root, 'omelette-mistral-repro', OLD);
  dir(root, 'omelette-gemini-test', OLD);
  writeFileSync(join(root, 'omelette-f-Ab3xYz'), 'x');
  age(join(root, 'omelette-f-Ab3xYz'), OLD);
  const target = mkdtempSync(join(B, 'target-'));
  writeFileSync(join(target, 'f'), 'x');
  age(target, OLD);
  symlinkSync(target, join(root, 'omelette-l-Ab3xYz'));
  age(join(root, 'omelette-l-Ab3xYz'), OLD, { link: true });
  dir(root, 'other-Ab3xYz', OLD);

  assert.deepEqual(sweep({ root, now: NOW }), { removed: ['omelette-x-Ab3xYz'], failed: [], stopped: false });
  assert.deepEqual(readdirSync(root).sort(), [
    'omelette-evals', 'omelette-f-Ab3xYz', 'omelette-gemini-test', 'omelette-l-Ab3xYz', 'omelette-mistral-repro', 'omelette-y-Ab3xYz', 'other-Ab3xYz',
  ]);
  assert.ok(existsSync(join(evals, 'snapshots', 'abc', 'f')), "an eval round's snapshot stays");
  assert.ok(lstatSync(join(root, 'omelette-l-Ab3xYz')).isSymbolicLink(), 'the link stays');
  assert.ok(existsSync(join(target, 'f')), 'and its target is untouched');
});

test('the boundary', () => {
  const root = rootOf();
  dir(root, 'omelette-day-Ab3xYz', MAX_AGE_MS);
  dir(root, 'omelette-more-Ab3xYz', MAX_AGE_MS + 1000);
  assert.deepEqual(sweep({ root, now: NOW }), { removed: ['omelette-more-Ab3xYz'], failed: [], stopped: false });
  assert.ok(existsSync(join(root, 'omelette-day-Ab3xYz')), 'exactly a day old stays');
});

test("another user's", () => {
  const root = rootOf();
  const p = dir(root, 'omelette-u-Ab3xYz', OLD);
  if (typeof process.getuid === 'function') assert.deepEqual(sweep({ root, now: NOW, uid: process.getuid() + 1 }), nothing);
  assert.deepEqual(sweep({ root, now: NOW, uid: null }), nothing);
  assert.ok(existsSync(p));
  assert.deepEqual(sweep({ root, now: NOW }).removed, ['omelette-u-Ab3xYz'], "this user's own goes");
});

test('the budget', () => {
  const root = rootOf();
  const p = dir(root, 'omelette-b-Ab3xYz', OLD);
  assert.deepEqual(sweep({ root, now: NOW, budgetMs: 0 }), { removed: [], failed: [], stopped: true });
  assert.ok(existsSync(p), 'left for the next run');
  // The budget covers the looking as well as the removing: a directory of young ones stops too.
  const young = rootOf();
  dir(young, 'omelette-y-Ab3xYz', HOUR);
  assert.deepEqual(sweep({ root: young, now: NOW, budgetMs: 0 }), { removed: [], failed: [], stopped: true });
  assert.deepEqual(sweep({ root: rootOf(), now: NOW, budgetMs: 0 }), nothing, 'nothing of ours to look at: not stopped');
});

test('one that cannot be removed does not stop the rest', { skip: process.getuid?.() === 0 && 'root removes a directory under a 0500 one' }, () => {
  const root = rootOf();
  // Named to sort first: on a file system that lists names in order, it is met before the other.
  const stuck = join(root, 'omelette-a-Ab3xYz');
  mkdirSync(join(stuck, 'sub'), { recursive: true });
  writeFileSync(join(stuck, 'sub', 'f'), 'x');
  chmodSync(join(stuck, 'sub'), 0o500);
  try {
    age(stuck, OLD);
    dir(root, 'omelette-b-Ab3xYz', OLD);
    assert.deepEqual(sweep({ root, now: NOW }), { removed: ['omelette-b-Ab3xYz'], failed: ['omelette-a-Ab3xYz'], stopped: false });
  } finally {
    chmodSync(join(stuck, 'sub'), 0o700);
  }
});

test('as a script: a temp directory that does not exist', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, TMPDIR: join(B, 'absent') }, timeout: 10_000, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.startsWith('tmp-sweep: '), r.stderr);
  assert.equal(r.stdout, '');
});

test('as a script: it sweeps the temp directory it is given', () => {
  const root = rootOf();
  const p = dir(root, 'omelette-s-Ab3xYz', OLD);
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, TMPDIR: root }, timeout: 10_000, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(p), false);
  assert.equal(r.stdout, 'tmp-sweep: removed 1 stale omelette-* directories\n');
});
