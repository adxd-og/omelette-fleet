// core/clone.mjs through its first caller, units/mistral/repro.mjs: what the lift into core (1.13.0)
// must keep of the order Mistral's prepareClone always had.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareClone } from '../units/mistral/repro.mjs';
import * as core from '../core/clone.mjs';

test('a cwd that is no git work tree is refused before the runs root is made, and that refusal wins over a broken runs root', () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'clone-order-')));
  const saved = process.env.TMPDIR;
  try {
    process.env.TMPDIR = real;
    const plain = join(real, 'plain');
    mkdirSync(plain);
    const refused = (e) => /^mistral: .*plain is not a git work tree/.test(e.message);
    assert.throws(() => prepareClone({ cwd: plain }), refused);
    assert.deepEqual(readdirSync(real), ['plain'], 'the refusal made nothing under the temp root');
    symlinkSync(plain, join(real, 'omelette-mistral-repro'));
    assert.throws(() => prepareClone({ cwd: plain }), refused);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    rmSync(real, { recursive: true, force: true });
  }
});

// The fix round of T4: four calls a second caller of core/clone.mjs makes naturally, each once silently wrong.
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const GENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...ID };
const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe', env: GENV, timeout: 20_000 }).toString();
const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'clone-fix-')));
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'clone-runs-')));
after(() => { rmSync(BASE, { recursive: true, force: true }); rmSync(ROOT, { recursive: true, force: true }); });
let n = 0;
/** A committed repository holding README.md and b.txt. */
function committed() {
  const dir = join(BASE, `repo-${n++}`);
  mkdirSync(dir);
  gitIn(dir, 'init', '-q');
  writeFileSync(join(dir, 'README.md'), 'one\n');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'one');
  return dir;
}
const open = (cwd, extra = {}) => core.prepareClone({ cwd, unit: 'gemini', root: ROOT, ...extra });
const runs = () => readdirSync(ROOT).filter((e) => e.startsWith('run-'));
const gitDirOf = (run) => join(run.runDir, 'out', 'git');

test('cloneDiff with indexFile: a path that does not exist yet names only what changed', () => {
  const run = open(committed());
  writeFileSync(join(run.clone, 'new.txt'), 'new\n');
  const d = core.cloneDiff(run.clone, gitDirOf(run), { indexFile: join(BASE, `index-${n++}`) });
  assert.match(d, /^\+\+\+ b\/new\.txt$/m);
  assert.doesNotMatch(d, /b\/README\.md\nnew file/);
  assert.doesNotMatch(d, /b\/b\.txt\nnew file/);
});

test('cloneDiff with indexFile: reused after an untracked file is deleted, the next diff has no phantom deletion', () => {
  const run = open(committed());
  const indexFile = join(BASE, `index-${n++}`);
  writeFileSync(join(run.clone, 'new.txt'), 'new\n');
  assert.match(core.cloneDiff(run.clone, gitDirOf(run), { indexFile }), /^\+\+\+ b\/new\.txt$/m);
  rmSync(join(run.clone, 'new.txt'));
  const again = core.cloneDiff(run.clone, gitDirOf(run), { indexFile });
  assert.doesNotMatch(again, /deleted file/);
  assert.equal(again, '');
});

test('cloneDiff refuses a relative indexFile and one inside the clone', () => {
  const run = open(committed());
  assert.throws(() => core.cloneDiff(run.clone, gitDirOf(run), { indexFile: 'idx' }), (e) => e.message === 'cloneDiff: indexFile must be an absolute path (got "idx")');
  const inside = 'cloneDiff: indexFile must lie outside the clone — the clone is the model\'s to write';
  assert.throws(() => core.cloneDiff(run.clone, gitDirOf(run), { indexFile: join(run.clone, 'idx') }), (e) => e.message === inside);
  assert.throws(() => core.cloneDiff(run.clone, gitDirOf(run), { indexFile: run.clone }), (e) => e.message === inside);
});

test('prepareClone makes out 0700 whether or not dirs names it', () => {
  const run = open(committed(), { dirs: ['tmp', 'home'] });
  for (const d of ['out', 'home']) {
    assert.equal(run[d], join(run.runDir, d));
    assert.equal(lstatSync(run[d]).mode & 0o777, 0o700, d);
  }
  assert.deepEqual(Object.keys(run.ids), ['clone', 'tmp', 'home']);
});

test('prepareClone refuses a dirs entry that is no plain name or is a key of the result', () => {
  const src = committed();
  const before = runs();
  for (const d of ['head', 'a/b', '..', 'Tmp']) {
    const message = `prepareClone: dirs entry ${JSON.stringify(d)} is not a plain directory name, or collides with a key of the result`;
    assert.throws(() => open(src, { dirs: ['tmp', d] }), (e) => e.message === message, d);
  }
  assert.deepEqual(runs(), before, 'no run is left under the root');
});

test('setup is handed the clone, the env, CLONE_CONFIG and the work tree\'s head; the result\'s head names what it committed', () => {
  const src = committed();
  const seen = {};
  const run = open(src, {
    setup: ({ clone, env, config, head }) => {
      Object.assign(seen, { config, head });
      writeFileSync(join(clone, 'setup.txt'), 'made by setup\n');
      const g = (...a) => execFileSync('git', [...config, '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', clone, ...a], { stdio: 'pipe', env, timeout: 20_000 });
      g('add', 'setup.txt');
      g('commit', '-qm', 'setup');
    },
  });
  assert.equal(seen.head, gitIn(src, 'rev-parse', '--short', 'HEAD').trim());
  assert.deepEqual(seen.config, core.CLONE_CONFIG);
  assert.notEqual(run.head, seen.head);
  assert.equal(run.head, gitIn(run.clone, 'rev-parse', '--short', 'HEAD').trim());
});

test('an async setup is refused and leaves no run', () => {
  const src = committed();
  const before = runs();
  assert.throws(() => open(src, { setup: async () => { throw new Error('late'); } }), /setup must be synchronous/);
  assert.deepEqual(runs(), before);
});
