// 1.13.0 T5 (plan docs/superpowers/plans/2026-11-24-1.13.0-neon-tester.md, T5; spec
// docs/superpowers/specs/2026-11-23-neon-tester-design.md, «The tool» and «The boundary»):
// gemini_test's run directory — a HEAD clone of the work tree's top with the session's patch
// applied and committed under an isolated git, and a scratch home that links the Keychains only.
// Git only, every platform. HOME, XDG_CONFIG_HOME and TMPDIR point into one temp base for the
// whole file: no row reads the real home, and testRunsRoot() is this file's own.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cloneDiff, removeRun } from '../core/clone.mjs';
import { prepareTestRun, testRunsRoot } from '../units/gemini/test-run.mjs';

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'neon-test-')));
const HOME = join(BASE, 'home');
const OPERATOR = join(BASE, 'operator');
mkdirSync(HOME);
mkdirSync(join(OPERATOR, 'Library', 'Keychains'), { recursive: true });
const SAVED = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'GIT_CONFIG_GLOBAL'].map((k) => [k, process.env[k]]));
process.env.HOME = HOME;
process.env.XDG_CONFIG_HOME = join(HOME, '.config');
process.env.TMPDIR = BASE;
delete process.env.GIT_CONFIG_GLOBAL;
after(() => {
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(BASE, { recursive: true, force: true });
});

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
/** git as the test runs it: no system config; the global one is <HOME>/.gitconfig, absent unless a row writes it. */
const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...ID }, timeout: 5_000 }).toString();

// Each row's budget, ten times its time under a full `npm test` (2026-11-25): a run made (≤ 400 ms), a run made then
// refused (≤ 210 ms), a refusal before any run dir (≤ 100 ms).
const MADE = { timeout: 4_000 };
const UNDONE = { timeout: 2_000 };
const REFUSED = { timeout: 1_000 };

let n = 0;
/** A work tree with one commit of `files` (path → content; a `{ link }` value is a symlink). */
function workTree(files = {}) {
  const dir = join(BASE, `w${++n}`);
  mkdirSync(dir);
  gitIn(dir, 'init', '-q');
  for (const [p, c] of Object.entries({ 'README.md': 'one\n', ...files })) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    if (typeof c === 'object') symlinkSync(c.link, join(dir, p)); else writeFileSync(join(dir, p), c);
  }
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'one');
  return dir;
}
/** The work tree's change as the session writes it: `git add -N` of new files, `git diff HEAD`, to a file outside the tree. */
function patchOf(dir, newFiles = []) {
  if (newFiles.length) gitIn(dir, 'add', '-N', '--', ...newFiles);
  const p = join(BASE, `p${++n}.patch`);
  writeFileSync(p, gitIn(dir, 'diff', 'HEAD'));
  return p;
}
const shortHead = (dir) => gitIn(dir, 'rev-parse', '--short', 'HEAD').trim();
const runs = () => (existsSync(testRunsRoot()) ? readdirSync(testRunsRoot()).filter((e) => e.startsWith('run-')).sort() : []);
const open = (cwd, patch) => prepareTestRun({ cwd, patch, home: OPERATOR });

test('the patch is applied and committed: the clone holds the patched file, HEAD\'s author is omelette-fleet, and cloneDiff of the untouched clone is empty', MADE, () => {
  const work = workTree();
  const at = shortHead(work);
  writeFileSync(join(work, 'README.md'), 'two\n');
  const run = open(work, patchOf(work));
  try {
    assert.equal(readFileSync(join(run.clone, 'README.md'), 'utf8'), 'two\n');
    assert.equal(gitIn(run.clone, 'log', '-1', '--format=%an <%ae>|%s').trim(), 'omelette-fleet <gemini-test@omelette.invalid>|gemini_test: the patch under test');
    assert.equal(gitIn(run.clone, 'rev-parse', '--short', 'HEAD~1').trim(), at, 'the patch commit sits on the work tree\'s HEAD');
    assert.equal(run.head, at, 'the run names the work tree\'s commit, not the patch commit');
    assert.equal(run.top, realpathSync(work));
    assert.deepEqual(Object.keys(run.ids).sort(), ['clone', 'home', 'tmp']);
    assert.equal(cloneDiff(run.clone, join(run.out, 'git')), '');
  } finally { removeRun(run.runDir); }
});

test('a patch with a new file (git add -N, git diff HEAD) applies', MADE, () => {
  const work = workTree();
  mkdirSync(join(work, 'src'));
  writeFileSync(join(work, 'src', 'new.mjs'), 'export const x = 1;\n');
  const run = open(work, patchOf(work, ['src/new.mjs']));
  try {
    assert.equal(readFileSync(join(run.clone, 'src', 'new.mjs'), 'utf8'), 'export const x = 1;\n');
    assert.match(gitIn(run.clone, 'ls-tree', '-r', '--name-only', 'HEAD'), /^src\/new\.mjs$/m, 'the new file is in the patch commit');
    assert.equal(cloneDiff(run.clone, join(run.out, 'git')), '');
  } finally { removeRun(run.runDir); }
});

test('a patch that does not apply is refused naming HEAD, and no run-* is left under testRunsRoot()', UNDONE, () => {
  const work = workTree();
  const p = join(BASE, `p${++n}.patch`);
  writeFileSync(p, 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-not what HEAD holds\n+two\n');
  const before = runs();
  assert.throws(() => open(work, p), (e) => e.message === `gemini: the patch does not apply to HEAD ${shortHead(work)}: error: README.md: patch does not apply`);
  assert.deepEqual(runs(), before);
});

test('a patch that applies and changes nothing is refused naming HEAD, and no run-* is left', UNDONE, () => {
  const work = workTree();
  const p = join(BASE, `p${++n}.patch`);
  const hunk = (from, to) => `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
  writeFileSync(p, hunk('one', 'two') + hunk('two', 'one'));
  const before = runs();
  assert.throws(() => open(work, p), (e) => e.message === `gemini: the patch changes nothing at HEAD ${shortHead(work)}`);
  assert.deepEqual(runs(), before);
});

test('an empty patch, a relative path and a missing file are refused before any run dir exists', REFUSED, () => {
  const work = workTree();
  const empty = join(BASE, `p${++n}.patch`);
  writeFileSync(empty, '');
  const big = join(BASE, `p${++n}.patch`);
  writeFileSync(big, '');
  truncateSync(big, 16 * 1024 * 1024 + 1);
  const real = join(BASE, `p${++n}.patch`);
  writeFileSync(real, 'diff --git a/x b/x\n');
  const linked = join(BASE, `p${++n}.patch`);
  symlinkSync(real, linked);
  const before = runs();
  const notFile = (got) => (e) => e.message === `gemini: "patch" must be an absolute path to a regular file (got ${JSON.stringify(got)})`;
  assert.throws(() => open(work, empty), (e) => e.message === `gemini: the patch ${empty} is empty`);
  assert.throws(() => open(work, 'rel.patch'), notFile('rel.patch'));
  const missing = join(BASE, 'missing.patch');
  assert.throws(() => open(work, missing), notFile(missing));
  assert.throws(() => open(work, linked), notFile(linked), 'a symlink is not followed');
  assert.throws(() => open(work, BASE), notFile(BASE), 'a directory');
  assert.throws(() => open(work, big), (e) => e.message === `gemini: the patch ${big} is larger than 16 MB`);
  assert.deepEqual(runs(), before);
});

test('a patch that writes through a committed symlink is refused', UNDONE, () => {
  const work = workTree({ 'sub/a.txt': 'a\n', link: { link: 'sub' } });
  const p = join(BASE, `p${++n}.patch`);
  writeFileSync(p, 'diff --git a/link/new.txt b/link/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/link/new.txt\n@@ -0,0 +1 @@\n+new\n');
  const before = runs();
  assert.throws(() => open(work, p), (e) => e.message === `gemini: the patch does not apply to HEAD ${shortHead(work)}: error: affected file 'link/new.txt' is beyond a symbolic link`);
  assert.deepEqual(runs(), before);
});

test('a mode-only patch commits', MADE, () => {
  const work = workTree({ 'run.sh': '#!/bin/sh\n' });
  chmodSync(join(work, 'run.sh'), 0o755);
  const run = open(work, patchOf(work));
  try {
    assert.match(gitIn(run.clone, 'ls-tree', 'HEAD', 'run.sh'), /^100755 blob /);
    assert.equal(statSync(join(run.clone, 'run.sh')).mode & 0o111, 0o111);
  } finally { removeRun(run.runDir); }
});

test('cwd below the top is refused, naming the top', REFUSED, () => {
  const work = workTree({ 'sub/a.txt': 'a\n' });
  writeFileSync(join(work, 'README.md'), 'two\n');
  const p = patchOf(work);
  const before = runs();
  const below = join(work, 'sub');
  assert.throws(() => open(below, p), (e) => e.message === `gemini: ${below} is not the top of its git work tree (${realpathSync(work)}) — gemini_test clones the top; pass it as cwd`);
  // No work tree at all: the same refusal, git's own words in place of the top, before core's repro wording.
  const plain = join(BASE, `plain${++n}`);
  mkdirSync(plain);
  assert.throws(() => open(plain, p), (e) => e.message.startsWith(`gemini: ${plain} is not the top of its git work tree (`) && e.message.endsWith(') — gemini_test clones the top; pass it as cwd'));
  assert.deepEqual(runs(), before);
});

test('the scratch home holds Library/Keychains linked to <home>/Library/Keychains and nothing else', MADE, () => {
  const work = workTree();
  writeFileSync(join(work, 'README.md'), 'two\n');
  const run = open(work, patchOf(work));
  try {
    assert.equal(run.home, join(run.runDir, 'home'));
    assert.deepEqual(readdirSync(run.home), ['Library']);
    assert.equal(lstatSync(join(run.home, 'Library')).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(join(run.home, 'Library')), ['Keychains']);
    const link = join(run.home, 'Library', 'Keychains');
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), join(OPERATOR, 'Library', 'Keychains'));
  } finally { removeRun(run.runDir); }
});

test('a work tree hook does not run', MADE, () => {
  const work = workTree();
  const marker = join(BASE, `hook-ran-${++n}`);
  writeFileSync(join(work, '.git', 'hooks', 'post-commit'), `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 });
  // The operator's global config points every repository's hooks at the work tree's: git would run them in the clone.
  writeFileSync(join(HOME, '.gitconfig'), `[core]\n\thooksPath = ${join(work, '.git', 'hooks')}\n`);
  try {
    const control = workTree();
    gitIn(control, 'commit', '-q', '--allow-empty', '-m', 'control');
    assert.ok(existsSync(marker), 'the control commit ran the hook: the global hooksPath is live');
    rmSync(marker);
    writeFileSync(join(work, 'README.md'), 'two\n');
    const run = open(work, patchOf(work));
    try {
      assert.equal(gitIn(run.clone, 'log', '-1', '--format=%s').trim(), 'gemini_test: the patch under test');
      assert.equal(existsSync(marker), false);
    } finally { removeRun(run.runDir); }
  } finally { rmSync(join(HOME, '.gitconfig'), { force: true }); }
});
