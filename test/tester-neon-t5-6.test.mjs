// 1.13.0 T5/T6 tester rows (plan docs/superpowers/plans/2026-11-24-1.13.0-neon-tester.md, T5 and T6 Produces):
// what test/gemini-test-run.test.mjs leaves unpinned in prepareTestRun, checkDeps, copyDeps and relocateVenv.
// HOME, XDG_CONFIG_HOME and TMPDIR point into one temp base for the whole file (no row reads the real home);
// every directory a row makes is under that base, removed in `after`.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { cloneDiff, removeRun } from '../core/clone.mjs';
import { TEST_RUNS, checkDeps, copyDeps, discardRun, prepareTestRun, relocateVenv, testDiff, testRunsRoot } from '../units/gemini/test-run.mjs';

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
const gitBuf = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...ID }, timeout: 5_000 });
const gitIn = (dir, ...a) => gitBuf(dir, ...a).toString();

const MADE = { timeout: 4_000 };
const UNDONE = { timeout: 2_000 };
const CHECKED = { timeout: 2_000 };
const DARWIN = process.platform === 'darwin';
const COPIED = { ...MADE, skip: !DARWIN };

let n = 0;
/** A work tree with one commit of `files` (path → content; `{ link }` a symlink). */
function workTree(files = {}) {
  const dir = join(BASE, `w${++n}`);
  mkdirSync(dir);
  gitIn(dir, 'init', '-q');
  writeTree(dir, { 'README.md': 'one\n', ...files });
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'one');
  return dir;
}
/** `tree` written under `dir`: path → content (string or Buffer), or `{ link }` for a symlink. */
function writeTree(dir, tree) {
  for (const [p, c] of Object.entries(tree)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    if (c && typeof c.link === 'string') symlinkSync(c.link, join(dir, p)); else writeFileSync(join(dir, p), c);
  }
  return dir;
}
const patchText = (text) => { const p = join(BASE, `p${++n}.patch`); writeFileSync(p, text); return p; };
/** The session's patch: `git add -N` of the new files, `git diff HEAD` (with the extra args), to a file outside the tree. */
function patchOf(dir, newFiles = [], ...diffArgs) {
  if (newFiles.length) gitIn(dir, 'add', '-N', '--', ...newFiles);
  return patchText(gitBuf(dir, 'diff', ...diffArgs, 'HEAD'));
}
const runs = () => (existsSync(testRunsRoot()) ? readdirSync(testRunsRoot()).filter((e) => e.startsWith('run-')).sort() : []);
const open = (cwd, patch) => prepareTestRun({ cwd, patch, home: OPERATOR });
const check = (top, deps, devOf) => checkDeps({ top, deps, root: testRunsRoot(), ...(devOf ? { devOf } : {}) });
const refusal = (entry, tail) => (e) => e.message === `gemini: deps entry ${JSON.stringify(entry)} ${tail}`;
const NOT_IGNORED = 'is not ignored by git — only a directory git ignores whole is copied';
const NOT_RELATIVE = 'must be a relative path inside the work tree';
/** A run of `work` with its one-line README patch and `deps` checked and copied. */
function runWithDeps(work, deps) {
  writeFileSync(join(work, 'README.md'), 'two\n');
  const run = open(work, patchOf(work));
  copyDeps(run, check(work, deps));
  return run;
}

// ---- prepareTestRun -------------------------------------------------------------------------------------------

test('the run is <OS temp>/omelette-gemini-test/run-*, every directory of it 0700', MADE, () => {
  const work = workTree();
  writeFileSync(join(work, 'README.md'), 'two\n');
  const run = open(work, patchOf(work));
  try {
    assert.equal(TEST_RUNS, 'omelette-gemini-test');
    assert.equal(testRunsRoot(), join(tmpdir(), 'omelette-gemini-test'));
    assert.equal(dirname(run.runDir), realpathSync(testRunsRoot()));
    assert.match(basename(run.runDir), /^run-/);
    assert.equal(statSync(testRunsRoot()).mode & 0o777, 0o700);
    for (const d of [run.runDir, run.tmp, run.home, run.out]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
    assert.deepEqual([run.clone, run.tmp, run.home, run.out].map((p) => dirname(p)), [run.runDir, run.runDir, run.runDir, run.runDir]);
  } finally { removeRun(run.runDir); }
});

test('cwd through a symlink or with a trailing slash is the top: accepted, the run names the real top; a link to a sub-directory is refused naming it', MADE, () => {
  const work = workTree({ 'sub/a.txt': 'a\n' });
  writeFileSync(join(work, 'README.md'), 'two\n');
  const p = patchOf(work);
  const viaLink = join(BASE, `ln${++n}`);
  symlinkSync(work, viaLink);
  for (const cwd of [viaLink, `${work}/`]) {
    const run = open(cwd, p);
    try {
      assert.equal(run.top, realpathSync(work), cwd);
      assert.equal(readFileSync(join(run.clone, 'README.md'), 'utf8'), 'two\n');
    } finally { removeRun(run.runDir); }
  }
  const viaSub = join(BASE, `ln${++n}`);
  symlinkSync(join(work, 'sub'), viaSub);
  const before = runs();
  assert.throws(() => open(viaSub, p), (e) => e.message === `gemini: ${viaSub} is not the top of its git work tree (${realpathSync(work)}) — gemini_test clones the top; pass it as cwd`);
  assert.deepEqual(runs(), before);
});

test('the refusals come in the contract\'s order: a cwd that is not the top before a bad patch', UNDONE, () => {
  const work = workTree({ 'sub/a.txt': 'a\n' });
  const below = join(work, 'sub');
  const missing = join(BASE, 'missing.patch');
  const empty = patchText('');
  for (const bad of [missing, 'rel.patch', empty]) {
    assert.throws(() => open(below, bad), (e) => e.message.startsWith(`gemini: ${below} is not the top of its git work tree (`), String(bad));
  }
});

test('a patch of exactly 16 MB, or of one byte, is not refused for its size', UNDONE, () => {
  const work = workTree();
  const big = patchText('');
  truncateSync(big, 16 * 1024 * 1024);
  const one = patchText('x');
  for (const p of [big, one]) {
    assert.throws(() => open(work, p), (e) => e.message.startsWith(`gemini: the patch does not apply to HEAD ${gitIn(work, 'rev-parse', '--short', 'HEAD').trim()}: `), p);
  }
  assert.deepEqual(runs(), []);
});

test('a deletion, a rename, a binary change (--binary) and a new executable land byte for byte, committed', MADE, () => {
  const bytes = (...b) => Buffer.from(b);
  const work = workTree({ 'gone.txt': 'gone\n', 'old-name.txt': 'a line\nanother line\nand a third\n', 'b.bin': bytes(0, 1, 2, 3, 255) });
  gitIn(work, 'mv', 'old-name.txt', 'new-name.txt');
  rmSync(join(work, 'gone.txt'));
  writeFileSync(join(work, 'b.bin'), bytes(255, 254, 0, 0, 7, 10, 13));
  writeFileSync(join(work, 'tool.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const run = open(work, patchOf(work, ['tool.sh'], '--binary'));
  try {
    assert.equal(existsSync(join(run.clone, 'gone.txt')), false);
    assert.equal(existsSync(join(run.clone, 'old-name.txt')), false);
    assert.equal(readFileSync(join(run.clone, 'new-name.txt'), 'utf8'), 'a line\nanother line\nand a third\n');
    assert.deepEqual(readFileSync(join(run.clone, 'b.bin')), bytes(255, 254, 0, 0, 7, 10, 13));
    assert.match(gitIn(run.clone, 'ls-tree', 'HEAD', 'tool.sh'), /^100755 blob /);
    assert.equal(gitIn(run.clone, 'status', '--porcelain'), '', 'everything is in the patch commit');
    assert.equal(cloneDiff(run.clone, join(run.out, 'git')), '');
  } finally { removeRun(run.runDir); }
});

test('a binary change without --binary is refused naming HEAD, and no run-* is left', UNDONE, () => {
  const work = workTree({ 'b.bin': Buffer.from([0, 1, 2, 3]) });
  writeFileSync(join(work, 'b.bin'), Buffer.from([0, 9, 9, 9]));
  const before = runs();
  assert.throws(() => open(work, patchOf(work)), (e) => e.message === `gemini: the patch does not apply to HEAD ${gitIn(work, 'rev-parse', '--short', 'HEAD').trim()}: error: b.bin: patch does not apply`);
  assert.deepEqual(runs(), before);
});

test('CR line ends and trailing blanks in the patch land as written: the whitespace is neither fixed nor refused', MADE, () => {
  const work = workTree({ 'crlf.txt': 'x\r\ny\r\n' });
  const wanted = 'x\r\ny\r\nz  \r\n\t\n';
  writeFileSync(join(work, 'crlf.txt'), wanted);
  const run = open(work, patchOf(work));
  try {
    assert.equal(gitBuf(run.clone, 'show', 'HEAD:crlf.txt').toString('latin1'), wanted, 'the committed blob');
    assert.equal(readFileSync(join(run.clone, 'crlf.txt'), 'latin1'), wanted, 'the file in the clone');
  } finally { removeRun(run.runDir); }
});

test('a patch naming a path inside .git or above the clone is refused, nothing left', UNDONE, () => {
  const work = workTree();
  const add = (path) => `diff --git a/${path} b/${path}\nnew file mode 100755\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;
  const before = runs();
  for (const path of ['.git/hooks/post-commit', 'sub/.git/config', '../escape.txt']) {
    assert.throws(() => open(work, patchText(add(path))), (e) => e.message.startsWith(`gemini: the patch does not apply to HEAD ${gitIn(work, 'rev-parse', '--short', 'HEAD').trim()}: error: invalid path`), path);
  }
  assert.deepEqual(runs(), before);
});

test('a patch that is no string, or a relative path to a file that exists from here, is refused as no absolute path', UNDONE, () => {
  const work = workTree();
  const real = patchText('diff --git a/x b/x\n');
  const rel = relative(process.cwd(), real);
  const before = runs();
  for (const bad of [undefined, null, 5, rel]) {
    assert.throws(() => open(work, bad), (e) => e.message === `gemini: "patch" must be an absolute path to a regular file (got ${JSON.stringify(bad)})`, String(bad));
  }
  assert.deepEqual(runs(), before);
});

test('a failure after the run dir exists (an operator home that is no path) removes the run dir and throws', UNDONE, () => {
  const work = workTree();
  writeFileSync(join(work, 'README.md'), 'two\n');
  const p = patchOf(work);
  const before = runs();
  assert.throws(() => prepareTestRun({ cwd: work, patch: p, home: undefined }));
  assert.deepEqual(runs(), before);
});

test('a patch that only adds a gitlink commits, whatever the operator\'s global diff.ignoreSubmodules says', MADE, () => {
  const work = workTree();
  const p = patchText('diff --git a/sm b/sm\nnew file mode 160000\nindex 0000000..1234567\n--- /dev/null\n+++ b/sm\n@@ -0,0 +1 @@\n+Subproject commit 1234567890123456789012345678901234567890\n');
  writeFileSync(join(HOME, '.gitconfig'), '[diff]\n\tignoreSubmodules = all\n');
  try {
    const run = open(work, p);
    try {
      assert.match(gitIn(run.clone, 'ls-tree', 'HEAD', 'sm'), /^160000 commit 1234567890123456789012345678901234567890\tsm$/m);
    } finally { removeRun(run.runDir); }
  } finally { rmSync(join(HOME, '.gitconfig'), { force: true }); }
});

test('a program the work tree\'s own git config names runs for none of the unit\'s git calls', MADE, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'node_modules/m/i.js': '1\n' });
  const marker = join(BASE, `fsmonitor-ran-${++n}`);
  const hook = join(BASE, `fsmonitor-${n}.sh`);
  writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`, { mode: 0o755 });
  const own = join(work, '.git', 'config');
  writeFileSync(own, `${readFileSync(own, 'utf8')}[core]\n\tfsmonitor = ${hook}\n\thooksPath = ${join(work, '.git', 'hooks')}\n`);
  writeFileSync(join(work, '.git', 'hooks', 'post-commit'), `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
  writeFileSync(join(work, 'README.md'), 'two\n');
  const p = patchOf(work);
  rmSync(marker, { force: true });
  const run = open(work, p);
  try {
    check(work, ['node_modules']);
    assert.equal(existsSync(marker), false);
  } finally { removeRun(run.runDir); }
});

// ---- checkDeps ------------------------------------------------------------------------------------------------

test('checkDeps refuses a case variant of .git or .omelette as one of them', CHECKED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'node_modules/m/i.js': '1\n' });
  for (const entry of ['.GIT', '.Git', 'a/.Git/x', '.OMELETTE', 'node_modules/.Omelette']) {
    assert.throws(() => check(work, [entry]), refusal(entry, 'is or holds .git or .omelette'));
  }
});

test('checkDeps returns "./x", "a//b" and "a/./b" normalised', CHECKED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\na/b/\n' }), { 'node_modules/m/i.js': '1\n', 'a/b/x.js': 'x\n' });
  assert.deepEqual(check(work, ['./node_modules', 'a//b']), ['node_modules', 'a/b']);
  assert.deepEqual(check(work, ['a/./b/']), ['a/b']);
});

test('checkDeps takes a name with a leading dash, a space or non-ASCII letters', CHECKED, () => {
  const names = ['-deps', 'my deps', 'dépôt'];
  const work = writeTree(workTree({ '.gitignore': '/-deps/\n/my deps/\n/dépôt/\n' }), Object.fromEntries(names.map((d) => [`${d}/x.js`, 'x\n'])));
  assert.deepEqual(check(work, names), names);
});

test('checkDeps: a directory kept ignored only by a nested .gitignore is accepted; one a negated rule re-includes is refused', CHECKED, () => {
  const work = writeTree(workTree({ '.gitignore': 'build/*\n!build/keep/\n', 'pkg/.gitignore': 'node_modules/\n' }), {
    'pkg/node_modules/m/i.js': '1\n', 'build/out/o.js': 'o\n', 'build/keep/k.js': 'k\n',
  });
  assert.deepEqual(check(work, ['pkg/node_modules', 'build/out']), ['pkg/node_modules', 'build/out']);
  assert.throws(() => check(work, ['build/keep']), refusal('build/keep', NOT_IGNORED));
});

test('checkDeps: a venv ignored by the .gitignore inside it (uv, python -m venv) is a directory git ignores', CHECKED, () => {
  const work = writeTree(workTree(), { '.venv/.gitignore': '*\n', '.venv/pyvenv.cfg': 'home = /usr/bin\n' });
  assert.deepEqual(check(work, ['.venv']), ['.venv']);
});

test('checkDeps checks each rule in the contract\'s order when an entry breaks two', CHECKED, () => {
  const work = writeTree(workTree({ 'src/a.js': 'a\n', '.gitignore': 'node_modules/\n' }), { 'node_modules/m/i.js': '1\n' });
  // relative before reserved
  for (const entry of ['../.git', '/x/.git', '.git/..', '']) assert.throws(() => check(work, [entry]), refusal(entry, NOT_RELATIVE));
  // reserved before not-a-directory
  assert.throws(() => check(work, ['missing/.git']), refusal('missing/.git', 'is or holds .git or .omelette'));
  // tracked before not-ignored
  assert.throws(() => check(work, ['src']), refusal('src', 'holds tracked files — only a directory git ignores whole is copied'));
  // overlap before the volume: the second entry would also be on another volume
  const devOf = (p) => (p.endsWith('/b') ? 2 : 1);
  const w2 = writeTree(workTree({ '.gitignore': 'a/\n' }), { 'a/b/x.js': 'x\n' });
  assert.throws(() => check(w2, ['a', 'a/b'], devOf), (e) => e.message === 'gemini: deps entries "a" and "a/b" overlap');
});

test('checkDeps refuses a directory on another real volume than the runs root (the default devOf)', CHECKED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'node_modules/m/i.js': '1\n' });
  assert.deepEqual(check(work, ['node_modules']), ['node_modules'], 'the same volume: accepted');
  // /dev is a file system of its own on macOS and on Linux: a root there is another volume than the work tree's.
  assert.throws(() => checkDeps({ top: work, deps: ['node_modules'], root: '/dev' }), refusal('node_modules', 'is on another volume than /dev — a copy-on-write clone (cp -c) is not possible; gemini_test copies dependencies within one volume only'));
});

test('checkDeps refuses overlapping entries given the inner one first', CHECKED, () => {
  const work = writeTree(workTree({ '.gitignore': 'a/\n' }), { 'a/b/x.js': 'x\n' });
  assert.throws(() => check(work, ['a/b', 'a']), (e) => e.message === 'gemini: deps entries "a/b" and "a" overlap');
});

// ---- copyDeps -------------------------------------------------------------------------------------------------

test('copyDeps: the exclude lines are anchored to the copies: two deps both left out of the diff, a node_modules of the model\'s own below the top is not', COPIED, () => {
  const work = writeTree(workTree({ '.gitignore': '/node_modules/\n/.venv/\n' }), {
    'node_modules/pkg/index.js': 'module.exports = 1;\n', '.venv/pyvenv.cfg': 'home = /usr/bin\n', '.venv/lib/x.py': 'x\n',
  });
  const run = runWithDeps(work, ['node_modules', '.venv']);
  try {
    assert.deepEqual(run.deps.map((d) => d.rel), ['node_modules', '.venv']);
    writeFileSync(join(run.clone, 'node_modules', 'pkg', 'new.js'), 'n\n');
    writeFileSync(join(run.clone, '.venv', 'lib', 'new.py'), 'n\n');
    // The clone's own .gitignore (anchored to the top) says nothing of this one: the exclude line must not be wider than the copy.
    mkdirSync(join(run.clone, 'tests', 'node_modules'), { recursive: true });
    writeFileSync(join(run.clone, 'tests', 'node_modules', 'fixture.js'), 'f\n');
    writeFileSync(join(run.clone, 'tests', 'a.test.mjs'), 't\n');
    const diff = cloneDiff(run.clone, join(run.out, 'git'));
    assert.match(diff, /^\+\+\+ b\/tests\/a\.test\.mjs$/m);
    assert.match(diff, /^\+\+\+ b\/tests\/node_modules\/fixture\.js$/m, 'a directory of the same name elsewhere is the model\'s');
    assert.doesNotMatch(diff, /^\+\+\+ b\/(node_modules|\.venv)\//m);
  } finally { removeRun(run.runDir); }
});

test('copyDeps: the copies stay out of the diff whatever the clone\'s .gitignore says (a negated rule the model wrote)', COPIED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'node_modules/pkg/index.js': 'i\n' });
  const run = runWithDeps(work, ['node_modules']);
  try {
    writeFileSync(join(run.clone, '.gitignore'), 'node_modules/\n!/node_modules/\n');
    writeFileSync(join(run.clone, 'x.test.mjs'), 't\n');
    const diff = testDiff(run);
    assert.match(diff, /^\+\+\+ b\/x\.test\.mjs$/m);
    assert.doesNotMatch(diff, /^diff --git a\/node_modules\//m);
    assert.doesNotMatch(diff, /^\+\+\+ b\/node_modules\//m);
  } finally { removeRun(run.runDir); }
});

// The next rows ask: what stands at the target in the clone before the copy. The clone is HEAD plus the patch, so a
// patch can put a link or a directory where the work tree has an ignored directory. A row passes when copyDeps
// refuses, or when the copy lands at <clone>/<entry> and nothing is written outside the run.
test('copyDeps: a link the patch put at the target is not written through', COPIED, () => {
  const outside = join(BASE, `outside${++n}`);
  mkdirSync(outside);
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'node_modules/m/i.js': '1\n' });
  const run = open(work, patchText(`diff --git a/node_modules b/node_modules\nnew file mode 120000\n--- /dev/null\n+++ b/node_modules\n@@ -0,0 +1 @@\n+${outside}\n\\ No newline at end of file\n`));
  try {
    assert.ok(lstatSync(join(run.clone, 'node_modules')).isSymbolicLink(), 'the patch put a link there');
    try { copyDeps(run, check(work, ['node_modules'])); } catch { /* a refusal is a way to keep the copy inside the run */ }
    assert.deepEqual(readdirSync(outside), [], 'nothing of the copy landed where the link points');
  } finally { removeRun(run.runDir); }
});

test('copyDeps: a link the patch put at the parent of the target is not written through', COPIED, () => {
  const outside = join(BASE, `outside${++n}`);
  mkdirSync(outside);
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'pkg/node_modules/m/i.js': '1\n' });
  const run = open(work, patchText(`diff --git a/pkg b/pkg\nnew file mode 120000\n--- /dev/null\n+++ b/pkg\n@@ -0,0 +1 @@\n+${outside}\n\\ No newline at end of file\n`));
  try {
    try { copyDeps(run, check(work, ['pkg/node_modules'])); } catch { /* as above */ }
    assert.deepEqual(readdirSync(outside), [], 'nothing of the copy landed where the link points');
  } finally { removeRun(run.runDir); }
});

test('copyDeps: a directory the patch put at the target does not make the copy land one level down', COPIED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'node_modules/m/i.js': '1\n' });
  const run = open(work, patchText('diff --git a/node_modules/x.js b/node_modules/x.js\nnew file mode 100644\n--- /dev/null\n+++ b/node_modules/x.js\n@@ -0,0 +1 @@\n+x\n'));
  try {
    let refused = false;
    try { copyDeps(run, check(work, ['node_modules'])); } catch { refused = true; }
    if (!refused) {
      assert.equal(run.deps[0].copy, join(run.clone, 'node_modules'));
      assert.ok(existsSync(join(run.clone, 'node_modules', 'm', 'i.js')), 'the copy\'s content is at the entry');
      assert.equal(existsSync(join(run.clone, 'node_modules', 'node_modules')), false, 'not nested under itself');
    }
  } finally { removeRun(run.runDir); }
});

test('copyDeps: an entry with glob characters either is refused or leaves out of the diff only its own copy', COPIED, () => {
  // A directory literally named `te*`, ignored by the work tree; Neon then writes a new `test/` of its own.
  const work = writeTree(workTree({ '.gitignore': 'te\\*/\n' }), { 'te*/m/i.js': '1\n' });
  writeFileSync(join(work, 'README.md'), 'two\n');
  const run = open(work, patchOf(work));
  try {
    let deps = null;
    try { deps = check(work, ['te*']); } catch (e) { assert.match(e.message, /^gemini: deps entry "te\*" /); }
    if (deps) {
      copyDeps(run, deps);
      assert.ok(existsSync(join(run.clone, 'te*', 'm', 'i.js')));
      mkdirSync(join(run.clone, 'test'));
      writeFileSync(join(run.clone, 'test', 'new.test.mjs'), 't\n');
      assert.match(cloneDiff(run.clone, join(run.out, 'git')), /^\+\+\+ b\/test\/new\.test\.mjs$/m, 'the exclude line `/te*/` also hides test/');
    }
  } finally { removeRun(run.runDir); }
});

test('copyDeps: a file keeps its modification time (a clone, not a rewrite), and the work tree\'s is unchanged', COPIED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'node_modules/pkg/index.js': 'i\n' });
  const f = join(work, 'node_modules', 'pkg', 'index.js');
  utimesSync(f, 1_000_000_000, 1_000_000_000);
  const run = runWithDeps(work, ['node_modules']);
  try {
    assert.equal(statSync(join(run.clone, 'node_modules', 'pkg', 'index.js')).mtimeMs, 1_000_000_000_000);
    assert.equal(statSync(f).mtimeMs, 1_000_000_000_000);
  } finally { removeRun(run.runDir); }
});

test('copyDeps: a dependency directory without pyvenv.cfg keeps its bin scripts as they are', COPIED, () => {
  const work = workTree({ '.gitignore': 'node_modules/\n' });
  const shebang = `#!${join(work, 'node_modules')}/bin/node\n`;
  writeTree(work, { 'node_modules/bin/tool': `${shebang}x\n` });
  const run = runWithDeps(work, ['node_modules']);
  try {
    assert.equal(readFileSync(join(run.clone, 'node_modules', 'bin', 'tool'), 'utf8'), `${shebang}x\n`);
  } finally { removeRun(run.runDir); }
});

test('copyDeps: a copy cp cannot finish is refused with cp\'s last line', { ...COPIED, skip: !DARWIN || (process.getuid && process.getuid() === 0) }, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'node_modules/pkg/index.js': 'i\n', 'node_modules/priv/x': 'x\n' });
  writeFileSync(join(work, 'README.md'), 'two\n');
  const run = open(work, patchOf(work));
  const priv = join(work, 'node_modules', 'priv');
  chmodSync(priv, 0);
  try {
    assert.throws(() => copyDeps(run, check(work, ['node_modules'])), (e) => e.message.startsWith('gemini: copying deps entry "node_modules" failed: cp: ') && /Permission denied$/.test(e.message));
  } finally { chmodSync(priv, 0o755); removeRun(run.runDir); }
});

// ---- the fix round: what copyDeps refuses, testDiff, discardRun -------------------------------------------------

test('copyDeps refuses a dangling link at the target (lstat, not stat), and leaves no run', COPIED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'node_modules/m/i.js': '1\n' });
  const before = runs();
  const dangling = join(BASE, `nowhere${++n}`);
  const run = open(work, patchText(`diff --git a/node_modules b/node_modules\nnew file mode 120000\n--- /dev/null\n+++ b/node_modules\n@@ -0,0 +1 @@\n+${dangling}\n\\ No newline at end of file\n`));
  try {
    assert.throws(() => copyDeps(run, check(work, ['node_modules'])), refusal('node_modules', 'cannot be copied: it already exists in the patched tree (HEAD plus the patch) — a dependency directory is one git ignores whole'));
    assert.equal(existsSync(dangling), false, 'nothing was made where the link points');
    assert.deepEqual(runs(), before);
  } finally { removeRun(run.runDir); }
});

test('checkDeps refuses "[" and "]" each on its own as a glob character', CHECKED, () => {
  const work = workTree();
  for (const entry of ['a[b', 'a]b']) {
    assert.throws(() => check(work, [entry]), refusal(entry, 'holds a glob character (* ? [ ] \\) — name the directory literally'));
  }
});

test('cloneDiff\'s exclude drops an untracked path that is the named one itself', MADE, () => {
  const work = workTree();
  writeFileSync(join(work, 'README.md'), 'two\n');
  const run = open(work, patchOf(work));
  try {
    writeFileSync(join(run.clone, 'solo'), 's\n');
    writeFileSync(join(run.clone, 'other'), 'o\n');
    const diff = cloneDiff(run.clone, join(run.out, 'git'), { exclude: ['solo'] });
    assert.match(diff, /^\+\+\+ b\/other$/m);
    assert.doesNotMatch(diff, /^\+\+\+ b\/solo$/m);
  } finally { removeRun(run.runDir); }
});

test('testDiff uses its scratch index: the out dir\'s own index stays as the patch commit left it, and a file the model removed again leaves no trace', MADE, () => {
  const work = workTree();
  writeFileSync(join(work, 'README.md'), 'two\n');
  const run = open(work, patchOf(work));
  try {
    const own = () => execFileSync('git', ['--git-dir', join(run.out, 'git'), 'ls-files'], { timeout: 5_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).toString();
    const before = own();
    writeFileSync(join(run.clone, 'a.test.mjs'), 't\n');
    assert.match(testDiff(run), /^\+\+\+ b\/a\.test\.mjs$/m);
    assert.equal(own(), before, 'no intent-to-add entry in the git dir\'s own index');
    rmSync(join(run.clone, 'a.test.mjs'));
    assert.equal(testDiff(run), '', 'the removed file is gone from the next diff');
  } finally { removeRun(run.runDir); }
});

test('testDiff past 1 MB cuts the diff and names gemini.testKeep', MADE, () => {
  const work = workTree();
  writeFileSync(join(work, 'README.md'), 'two\n');
  const run = open(work, patchOf(work));
  try {
    writeFileSync(join(run.clone, 'big.txt'), 'x'.repeat(79).concat('\n').repeat(16 * 1024));
    const diff = testDiff(run);
    assert.ok(diff.endsWith('… diff truncated at 1 MB — set gemini.testKeep=true to inspect the clone\n'), diff.slice(-120));
  } finally { removeRun(run.runDir); }
});

test('discardRun removes a run whose directories are read-only and never follows the scratch home\'s Keychains link', COPIED, () => {
  const operator = join(BASE, `op${++n}`);
  const keychains = join(operator, 'Library', 'Keychains');
  mkdirSync(keychains, { recursive: true });
  writeFileSync(join(keychains, 'login.keychain-db'), 'k\n');
  const work = workTree();
  writeFileSync(join(work, 'README.md'), 'two\n');
  const run = prepareTestRun({ cwd: work, patch: patchOf(work), home: operator });
  try {
    mkdirSync(join(run.clone, 'ro'));
    writeFileSync(join(run.clone, 'ro', 'f'), 'f\n');
    chmodSync(join(run.clone, 'ro'), 0o555);
    chmodSync(join(keychains, 'login.keychain-db'), 0o400);
    chmodSync(keychains, 0o500);
    assert.equal(discardRun(run), true);
    assert.equal(existsSync(run.runDir), false);
    assert.equal(statSync(keychains).mode & 0o777, 0o500, 'the operator\'s Keychains directory keeps its mode');
    assert.equal(statSync(join(keychains, 'login.keychain-db')).mode & 0o777, 0o400);
    assert.equal(readFileSync(join(keychains, 'login.keychain-db'), 'utf8'), 'k\n', 'and its contents');
  } finally { chmodSync(keychains, 0o755); removeRun(run.runDir); }
});

// ---- relocateVenv ---------------------------------------------------------------------------------------------

/** A venv at `<BASE>/vN/.venv` standing for the copy, and the path of the work tree's it was copied from. */
function venv(files) {
  const dir = join(BASE, `v${++n}`);
  const copy = join(dir, 'copy');
  const src = join(dir, 'src');
  writeTree(copy, files({ copy, src }));
  return { copy, src, dir };
}

test('relocateVenv rewrites a shebang of the work tree\'s bin and nothing else: arguments and the rest of the bytes kept, other interpreters, nested files and links left', () => {
  const { copy, src } = venv(({ src }) => ({
    'pyvenv.cfg': 'home = /usr/bin\n',
    'bin/args': `#!${src}/bin/python -u\nprint('${src}/bin/python')\n`,
    'bin/binary': Buffer.concat([Buffer.from(`#!${src}/bin/python\n`), Buffer.from([0, 255, 254, 13, 10, 128])]),
    'bin/env': '#!/usr/bin/env python\n',
    'bin/other': `#!${src}-2/bin/python\n`,
    'bin/later': `# x\n#!${src}/bin/python\n`,
    'bin/sub/nested': `#!${src}/bin/python\n`,
  }));
  assert.equal(relocateVenv(copy, src), 2);
  assert.equal(readFileSync(join(copy, 'bin', 'args'), 'utf8'), `#!${copy}/bin/python -u\nprint('${src}/bin/python')\n`);
  assert.deepEqual(readFileSync(join(copy, 'bin', 'binary')), Buffer.concat([Buffer.from(`#!${copy}/bin/python\n`), Buffer.from([0, 255, 254, 13, 10, 128])]));
  assert.equal(readFileSync(join(copy, 'bin', 'env'), 'utf8'), '#!/usr/bin/env python\n');
  assert.equal(readFileSync(join(copy, 'bin', 'other'), 'utf8'), `#!${src}-2/bin/python\n`);
  assert.equal(readFileSync(join(copy, 'bin', 'later'), 'utf8'), `# x\n#!${src}/bin/python\n`);
  assert.equal(readFileSync(join(copy, 'bin', 'sub', 'nested'), 'utf8'), `#!${src}/bin/python\n`, 'only the files directly under bin');
});

test('relocateVenv: a script of exactly 64 KB is rewritten, one byte more is not', () => {
  const { copy, src } = venv(({ src }) => {
    const head = `#!${src}/bin/python\n`;
    return { 'bin/exact': head + '#'.repeat(64 * 1024 - head.length), 'bin/over': head + '#'.repeat(64 * 1024 - head.length + 1) };
  });
  assert.equal(relocateVenv(copy, src), 1);
  assert.ok(readFileSync(join(copy, 'bin', 'exact'), 'utf8').startsWith(`#!${copy}/bin/python\n`));
  assert.ok(readFileSync(join(copy, 'bin', 'over'), 'utf8').startsWith(`#!${src}/bin/python\n`));
});

test('relocateVenv rewrites a read-only script and keeps its mode', () => {
  const { copy, src } = venv(({ src }) => ({ 'bin/ro': `#!${src}/bin/python\nprint(1)\n` }));
  chmodSync(join(copy, 'bin', 'ro'), 0o555);
  assert.equal(relocateVenv(copy, src), 1);
  assert.equal(readFileSync(join(copy, 'bin', 'ro'), 'utf8'), `#!${copy}/bin/python\nprint(1)\n`);
  assert.equal(statSync(join(copy, 'bin', 'ro')).mode & 0o7777, 0o555);
});

test('relocateVenv leaves alone a bin that is itself a link: the work tree\'s scripts behind it are not written', () => {
  const { copy, src, dir } = venv(({ src }) => ({ 'pyvenv.cfg': 'home = /usr/bin\n' }));
  const real = join(dir, 'real-bin');
  writeTree(dir, { 'real-bin/tool': `#!${src}/bin/python\nprint(1)\n` });
  symlinkSync(real, join(copy, 'bin'));
  assert.equal(relocateVenv(copy, src), 0);
  assert.equal(readFileSync(join(real, 'tool'), 'utf8'), `#!${src}/bin/python\nprint(1)\n`);
  // And no bin at all.
  const bare = venv(() => ({ 'pyvenv.cfg': 'x\n' }));
  assert.equal(relocateVenv(bare.copy, bare.src), 0);
});
