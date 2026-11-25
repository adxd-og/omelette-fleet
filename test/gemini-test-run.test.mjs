// 1.13.0 T5 (plan docs/superpowers/plans/2026-11-24-1.13.0-neon-tester.md, T5; spec
// docs/superpowers/specs/2026-11-23-neon-tester-design.md, «The tool» and «The boundary»):
// gemini_test's run directory — a HEAD clone of the work tree's top with the session's patch
// applied and committed under an isolated git, and a scratch home that links the Keychains only.
// Git only, every platform. HOME, XDG_CONFIG_HOME and TMPDIR point into one temp base for the
// whole file: no row reads the real home, and testRunsRoot() is this file's own.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cloneDiff, removeRun } from '../core/clone.mjs';
import { checkDeps, copyDeps, discardRun, prepareTestRun, relocateVenv, testDiff, testRunsRoot } from '../units/gemini/test-run.mjs';

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

// 1.13.0 T6: `deps` — checked before any run dir exists, copied by `cp -c` into the clone, left out of the diff, a
// venv's console scripts relocated. The refusals run everywhere; the copy rows need macOS's `cp -c`.
const DARWIN = process.platform === 'darwin';
// Budgets as above: checkDeps alone runs git a few times (≤ 270 ms under a full `npm test`), a copy row makes a run (≤ 500 ms).
const CHECKED = { timeout: 2_000 };
const COPIED = { ...MADE, skip: !DARWIN };

/** `tree` written under `dir` after its commit: path → content, or `{ link }` for a symlink. */
function writeTree(dir, tree) {
  for (const [p, c] of Object.entries(tree)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    if (typeof c === 'object') symlinkSync(c.link, join(dir, p)); else writeFileSync(join(dir, p), c);
  }
  return dir;
}
const check = (top, deps, devOf) => checkDeps({ top, deps, root: testRunsRoot(), ...(devOf ? { devOf } : {}) });
const refusal = (entry, tail) => (e) => e.message === `gemini: deps entry ${JSON.stringify(entry)} ${tail}`;
/** A run of `work` with a one-line patch, its deps checked and copied. */
function runWithDeps(work, deps) {
  writeFileSync(join(work, 'README.md'), 'two\n');
  const run = open(work, patchOf(work));
  copyDeps(run, check(work, deps));
  return run;
}

test('checkDeps refuses an entry that is no relative path inside the work tree', CHECKED, () => {
  const work = workTree();
  for (const entry of ['.', './', '../x', 'a/../b', '/abs', '', 'a\nb', 5]) {
    assert.throws(() => check(work, [entry]), refusal(entry, 'must be a relative path inside the work tree'));
  }
});

test('checkDeps refuses an entry that is or holds .git or .omelette', CHECKED, () => {
  const work = writeTree(workTree({ '.gitignore': 'vendored/\nstate/\n' }), { 'vendored/.git/HEAD': 'ref\n', 'state/.omelette/x': 'x\n' });
  for (const entry of ['.git', 'a/.git/x', '.omelette', 'vendored', 'state']) {
    assert.throws(() => check(work, [entry]), refusal(entry, 'is or holds .git or .omelette'));
  }
});

test('checkDeps refuses a symlink or a file: not a directory, a link not followed', CHECKED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\nlnk\nnotes.txt\n' }), { 'node_modules/m/i.js': '1\n', lnk: { link: 'node_modules' }, 'notes.txt': 'n\n' });
  for (const entry of ['lnk', 'notes.txt', 'missing']) {
    assert.throws(() => check(work, [entry]), refusal(entry, 'is not a directory (a symlink is not followed)'));
  }
});

test('checkDeps refuses an entry under a symlinked parent: it resolves outside the work tree', CHECKED, () => {
  const outside = join(BASE, `outside${++n}`);
  mkdirSync(join(outside, 'deps'), { recursive: true });
  const work = writeTree(workTree({ '.gitignore': 'ext/\n' }), { ext: { link: outside } });
  assert.throws(() => check(work, ['ext/deps']), refusal('ext/deps', 'resolves outside the work tree'));
});

test('checkDeps refuses an ignored dir that holds tracked files', CHECKED, () => {
  const work = writeTree(workTree({ '.gitignore': 'vendor/\n' }), { 'vendor/keep.js': 'k\n' });
  gitIn(work, 'add', '-f', 'vendor/keep.js');
  gitIn(work, 'commit', '-qm', 'vendor');
  assert.throws(() => check(work, ['vendor']), refusal('vendor', 'holds tracked files — only a directory git ignores whole is copied'));
});

test('checkDeps refuses an untracked dir git does not ignore', CHECKED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'scratch/a.js': 'a\n' });
  assert.throws(() => check(work, ['scratch']), refusal('scratch', 'is not ignored by git — only a directory git ignores whole is copied'));
});

test('checkDeps refuses overlapping entries', CHECKED, () => {
  const work = writeTree(workTree({ '.gitignore': 'a/\nnode_modules/\n' }), { 'a/b/x.js': 'x\n', 'node_modules/m/i.js': '1\n' });
  assert.throws(() => check(work, ['a', 'a/b']), (e) => e.message === 'gemini: deps entries "a" and "a/b" overlap');
  assert.throws(() => check(work, ['node_modules', 'node_modules/']), (e) => e.message === 'gemini: deps entries "node_modules" and "node_modules" overlap');
});

test('checkDeps refuses an entry on another volume than the runs root', CHECKED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'node_modules/m/i.js': '1\n' });
  const devOf = (p) => (p === join(work, 'node_modules') ? 2 : 1);
  assert.throws(() => check(work, ['node_modules'], devOf), refusal('node_modules', `is on another volume than ${testRunsRoot()} — a copy-on-write clone (cp -c) is not possible; gemini_test copies dependencies within one volume only`));
});

test('checkDeps accepts "node_modules/" as node_modules, in the order given', CHECKED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n.venv/\n' }), { 'node_modules/m/i.js': '1\n', '.venv/pyvenv.cfg': 'home = /usr/bin\n' });
  assert.deepEqual(check(work, ['node_modules/', '.venv']), ['node_modules', '.venv']);
});

test('a dep ignored only by the global excludes file is accepted', CHECKED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'globaldeps/x.js': 'x\n' });
  assert.throws(() => check(work, ['globaldeps']), refusal('globaldeps', 'is not ignored by git — only a directory git ignores whole is copied'));
  const excludes = join(BASE, `global-ignore-${++n}`);
  writeFileSync(excludes, 'globaldeps/\n');
  writeFileSync(join(HOME, '.gitconfig'), `[core]\n\texcludesFile = ${excludes}\n`);
  try {
    assert.deepEqual(check(work, ['globaldeps']), ['globaldeps']);
  } finally { rmSync(join(HOME, '.gitconfig'), { force: true }); }
});

test('the copy is in the clone, the work tree\'s own copy unchanged after a write into the clone\'s, and cloneDiff names nothing under it', COPIED, () => {
  // Ignored by the work tree's own info/exclude, which the clone does not have: only the run's exclude keeps it out of the diff.
  const work = writeTree(workTree(), { 'node_modules/pkg/index.js': 'module.exports = 1;\n' });
  writeFileSync(join(work, '.git', 'info', 'exclude'), 'node_modules/\n');
  const run = runWithDeps(work, ['node_modules']);
  try {
    const copied = join(run.clone, 'node_modules', 'pkg', 'index.js');
    assert.equal(readFileSync(copied, 'utf8'), 'module.exports = 1;\n');
    writeFileSync(copied, 'module.exports = 2;\n');
    writeFileSync(join(run.clone, 'node_modules', 'pkg', 'new.js'), 'new\n');
    assert.equal(readFileSync(join(work, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;\n');
    writeFileSync(join(run.clone, 'x.test.mjs'), 'test\n');
    const diff = cloneDiff(run.clone, join(run.out, 'git'));
    assert.match(diff, /^\+\+\+ b\/x\.test\.mjs$/m);
    assert.doesNotMatch(diff, /node_modules/);
  } finally { removeRun(run.runDir); }
});

test('a symlink inside the dep is copied as a link', COPIED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'node_modules/pkg/cli.js': 'cli\n', 'node_modules/.bin/tool': { link: '../pkg/cli.js' } });
  const run = runWithDeps(work, ['node_modules']);
  try {
    const link = join(run.clone, 'node_modules', '.bin', 'tool');
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), '../pkg/cli.js');
  } finally { removeRun(run.runDir); }
});

test('a venv\'s console script is relocated and its interpreter link kept', COPIED, () => {
  const work = workTree({ '.gitignore': '.venv/\n' });
  const src = join(work, '.venv');
  const shebang = `#!${src}/bin/python\n`;
  writeTree(work, {
    '.venv/pyvenv.cfg': 'home = /usr/bin\n',
    '.venv/bin/python': { link: '/usr/bin/true' },
    '.venv/bin/tool': `${shebang}print(1)\n`,
    // A link to a script carrying the shebang, out of the copy: rewritten through, it would change the work tree's.
    '.venv/bin/tool-link': { link: join(src, 'bin', 'tool') },
    '.venv/bin/big': `${shebang}${'#'.repeat(64 * 1024)}\n`,
  });
  chmodSync(join(src, 'bin', 'tool'), 0o755);
  const run = runWithDeps(work, ['.venv']);
  try {
    const copy = join(run.clone, '.venv');
    assert.equal(readFileSync(join(copy, 'bin', 'tool'), 'utf8'), `#!${copy}/bin/python\nprint(1)\n`);
    assert.equal(statSync(join(copy, 'bin', 'tool')).mode & 0o777, 0o755);
    assert.equal(readFileSync(join(src, 'bin', 'tool'), 'utf8'), `${shebang}print(1)\n`, 'the work tree\'s script is unchanged');
    assert.ok(lstatSync(join(copy, 'bin', 'python')).isSymbolicLink());
    assert.equal(readlinkSync(join(copy, 'bin', 'python')), '/usr/bin/true');
    assert.equal(readlinkSync(join(copy, 'bin', 'tool-link')), join(src, 'bin', 'tool'));
    assert.ok(readFileSync(join(copy, 'bin', 'big'), 'utf8').startsWith(shebang), 'a file over 64 KB is left as it is');
    // The count: one script of the four entries under bin.
    const again = join(BASE, `venv-copy-${++n}`);
    cpSync(src, again, { recursive: true });
    assert.equal(relocateVenv(again, src), 1);
  } finally { removeRun(run.runDir); }
});

test('run.deps[0].chain names the copy\'s dev and ino, and each directory between the clone and it', COPIED, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n', 'pkg/index.js': 'i\n' }), { 'pkg/lib/node_modules/m/i.js': '1\n' });
  const run = runWithDeps(work, ['pkg/lib/node_modules']);
  try {
    const copy = join(run.clone, 'pkg', 'lib', 'node_modules');
    assert.equal(run.deps.length, 1);
    assert.equal(run.deps[0].rel, 'pkg/lib/node_modules');
    assert.equal(run.deps[0].copy, copy);
    const paths = [join(run.clone, 'pkg'), join(run.clone, 'pkg', 'lib'), copy];
    assert.deepEqual(run.deps[0].chain, paths.map((p) => { const st = lstatSync(p); return { path: p, dev: st.dev, ino: st.ino }; }));
    assert.equal(lstatSync(join(run.clone, 'pkg', 'lib')).mode & 0o777, 0o755, 'the parent the clone lacked is made 0755');
  } finally { removeRun(run.runDir); }
});

// The fix round of T6: what the patch put at a copy's target or above it, a glob in an entry, the copies left out of
// the diff by the unit itself, a failed copy leaving no run, the venv log line.
/** A patch file adding `path` as a symlink to `target`, or (no target) as a one-line file. */
function addPatch(path, target) {
  const body = target === undefined
    ? `new file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`
    : `new file mode 120000\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`;
  const p = join(BASE, `p${++n}.patch`);
  writeFileSync(p, `diff --git a/${path} b/${path}\n${body}`);
  return p;
}
const EXISTS = 'cannot be copied: it already exists in the patched tree (HEAD plus the patch) — a dependency directory is one git ignores whole';
const notDir = (at) => `cannot be copied: ${JSON.stringify(at)} is not a directory in the patched tree (HEAD plus the patch)`;
/** A run dir gone whatever modes it holds: the rows' own cleanup, not the unit's. */
function scrub(dir) {
  if (!existsSync(dir)) return;
  execFileSync('/bin/chmod', ['-R', 'u+rwX', dir], { stdio: 'ignore', timeout: 5_000 });
  rmSync(dir, { recursive: true, force: true });
}

test('copyDeps refuses a link, a file and a directory the patch put at the target, and a link at its parent — and leaves no run', { ...COPIED, timeout: 8_000 }, () => {
  const cases = [
    { entry: 'node_modules', patch: (outside) => addPatch('node_modules', outside), tail: EXISTS },
    { entry: 'node_modules', patch: () => addPatch('node_modules'), tail: EXISTS },
    { entry: 'node_modules', patch: () => addPatch('node_modules/x.js'), tail: EXISTS },
    { entry: 'pkg/node_modules', patch: (outside) => addPatch('pkg', outside), tail: notDir('pkg') },
  ];
  for (const { entry, patch, tail } of cases) {
    const outside = join(BASE, `outside${++n}`);
    mkdirSync(outside);
    const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { [`${entry}/m/i.js`]: '1\n' });
    const before = runs();
    const run = open(work, patch(outside));
    try {
      assert.throws(() => copyDeps(run, check(work, [entry])), refusal(entry, tail), tail);
      assert.deepEqual(readdirSync(outside), [], 'nothing landed where the link points');
      assert.deepEqual(runs(), before, 'the run is removed');
    } finally { scrub(run.runDir); }
  }
});

// Budgets: ten times each row's time under a full `npm test` (2026-11-25) — the four refusals 1060 ms, the glob row
// 120 ms, the testDiff row 280 ms, the failed copy and discardRun 590 ms, the log row 200 ms.
test('checkDeps refuses a glob character', REFUSED, () => {
  const work = workTree();
  for (const entry of ['te*', 'a?', '[x]', 'a\\b']) {
    assert.throws(() => check(work, [entry]), refusal(entry, 'holds a glob character (* ? [ ] \\) — name the directory literally'));
  }
});

test('testDiff leaves the copies out whatever the clone\'s .gitignore says', { ...COPIED, timeout: 2_800 }, () => {
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'node_modules/pkg/index.js': 'i\n' });
  const run = runWithDeps(work, ['node_modules']);
  try {
    writeFileSync(join(run.clone, '.gitignore'), 'node_modules/\n!/node_modules/\n');
    mkdirSync(join(run.clone, 'test'));
    writeFileSync(join(run.clone, 'test', 'new.test.mjs'), 't\n');
    const diff = testDiff(run);
    assert.match(diff, /^\+\+\+ b\/test\/new\.test\.mjs$/m);
    assert.match(diff, /^\+\+\+ b\/\.gitignore$/m);
    assert.doesNotMatch(diff, /^diff --git a\/node_modules\//m);
  } finally { scrub(run.runDir); }
});

test('prepareTestRun\'s run has deps: []; a copy that fails after an earlier entry was copied leaves no run, read-only directories included', { ...COPIED, timeout: 5_500 }, () => {
  const outside = join(BASE, `outside${++n}`);
  mkdirSync(outside);
  const work = writeTree(workTree({ '.gitignore': 'node_modules/\n' }), { 'node_modules/ro/i.js': '1\n', 'pkg/node_modules/m/i.js': '1\n' });
  const ro = join(work, 'node_modules', 'ro');
  chmodSync(ro, 0o555);
  try {
    const before = runs();
    const run = open(work, addPatch('pkg', outside));
    try {
      assert.deepEqual(run.deps, []);
      assert.throws(() => copyDeps(run, check(work, ['node_modules', 'pkg/node_modules'])), refusal('pkg/node_modules', notDir('pkg')));
      assert.deepEqual(runs(), before, 'the run, the 0555 copy in it, is removed');
    } finally { scrub(run.runDir); }
    // discardRun alone: a 0555 directory holding a file under the clone, tmp and home.
    writeFileSync(join(work, 'README.md'), 'two\n');
    const held = open(work, patchOf(work));
    try {
      for (const d of [held.clone, held.tmp, held.home]) {
        mkdirSync(join(d, 'ro'));
        writeFileSync(join(d, 'ro', 'f'), 'f\n');
        chmodSync(join(d, 'ro'), 0o555);
      }
      assert.equal(discardRun(held), true);
      assert.equal(existsSync(held.runDir), false);
    } finally { scrub(held.runDir); }
  } finally { chmodSync(ro, 0o755); }
});

test('the log line says when a venv had no script relocated', { ...COPIED, timeout: 2_000 }, () => {
  const work = writeTree(workTree({ '.gitignore': '.venv/\n' }), { '.venv/pyvenv.cfg': 'home = /usr/bin\n', '.venv/bin/tool': '#!/elsewhere/.venv/bin/python\nprint(1)\n' });
  writeFileSync(join(work, 'README.md'), 'two\n');
  const run = open(work, patchOf(work));
  try {
    const lines = [];
    copyDeps(run, check(work, ['.venv']), { log: (l) => lines.push(l) });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^gemini_test: deps entry "\.venv" copied \(cp -c\) in \d+\.\d s, a venv with no script relocated — its scripts may name another spelling of its path$/);
  } finally { scrub(run.runDir); }
});

test('copyDeps runs once per run: a second call is refused, and the run and its first copy stay', COPIED, () => {
  const work = writeTree(workTree(), { 'node_modules/i.js': 'i\n', 'pkg/node_modules/j.js': 'j\n' });
  writeFileSync(join(work, '.git', 'info', 'exclude'), 'node_modules/\n');
  const run = runWithDeps(work, ['node_modules']);
  try {
    assert.throws(() => copyDeps(run, ['pkg/node_modules']), (e) => e.message === 'gemini: copyDeps already ran for this run');
    assert.deepEqual(run.deps.map((d) => d.rel), ['node_modules']);
    assert.ok(existsSync(join(run.clone, 'node_modules', 'i.js')));
  } finally { discardRun(run); }
});
