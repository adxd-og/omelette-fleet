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

// 1.13.0 T8: the test program — a name on gemini.testPrograms or a path under a deps entry — and the toolchain the
// kernel re-allows under the home for it. Pure, every platform: fixtures are directories under this file's BASE.
import { renameSync as renameT8 } from 'node:fs';
import { nodeEnv as nodeEnvT8 } from '../core/seatbelt.mjs';
import { assertDeps, checkTestCommand, parsePrograms, resolveProgram, shebangOf, toolchainReach } from '../units/gemini/test-run.mjs';

const PURE = { timeout: 1_000 };
/** A fixture tree under a fresh dir of BASE: path → content (an executable file), or `{ link }` for a symlink. */
function fixture(tree) {
  const dir = join(BASE, `f${++n}`);
  mkdirSync(dir);
  for (const [p, c] of Object.entries(tree)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    if (typeof c === 'object') symlinkSync(c.link, join(dir, p));
    else { writeFileSync(join(dir, p), c); chmodSync(join(dir, p), 0o755); }
  }
  return dir;
}
/** A run as resolveProgram reads it: its dir, its clone and the clone's tree, and a work tree top of its own (`top`, a tree or empty). */
function fakeRun(tree = {}, top = {}) {
  const runDir = fixture(Object.fromEntries(Object.entries(tree).map(([p, c]) => [`clone/${p}`, c])));
  mkdirSync(join(runDir, 'clone'), { recursive: true });
  return { runDir, clone: join(runDir, 'clone'), top: fixture(top) };
}
const NOT_UNDER = (w) => (e) => e.message === `gemini: ${JSON.stringify(w)} is not under a deps entry — a program in the copy outside the dependencies is a file the model can write`;

test('a bare name not on testPrograms is refused naming the list and the set command', PURE, () => {
  assert.throws(() => resolveProgram({ word: 'bash', programs: ['node', 'npm'], deps: [], run: fakeRun() }),
    (e) => e.message === 'gemini: "bash" is not on gemini.testPrograms (node, npm) — name a program on it, add one with omelette-fleet set gemini.testPrograms=…, or name a path under a deps entry');
});

test('a bare name resolves through the absolute PATH entries only', PURE, () => {
  const dir = fixture({ 'rel/node': '#!/bin/sh\n', 'abs/node': '#!/bin/sh\n' });
  const saved = process.cwd();
  process.chdir(dir);
  try {
    const run = fakeRun();
    assert.equal(resolveProgram({ word: 'node', programs: ['node'], deps: [], run, env: { PATH: `rel:${join(dir, 'abs')}` } }), join(dir, 'abs', 'node'));
    assert.throws(() => resolveProgram({ word: 'node', programs: ['node'], deps: [], run, env: { PATH: 'rel' } }), (e) => e.message === 'gemini: "node" is not found in PATH');
  } finally { process.chdir(saved); }
});

test('paths not under a deps entry are refused', PURE, () => {
  const run = fakeRun({ 'run.sh': '#!/bin/sh\n', 'scripts/x': '#!/bin/sh\n', 'x': '#!/bin/sh\n', 'node_modules/.bin/y': '#!/bin/sh\n' });
  const resolve = (word) => resolveProgram({ word, programs: ['node'], deps: ['node_modules'], run });
  assert.throws(() => resolve('run.sh'), /^Error: gemini: "run\.sh" is not on gemini\.testPrograms \(node\)/, 'a name with no slash is a program name');
  for (const w of ['scripts/x', 'node_modules/../x', '/usr/bin/env', 'node_modules/', 'node_modules//']) assert.throws(() => resolve(w), NOT_UNDER(w), w);
  assert.equal(resolve('./node_modules/.bin/y'), join(run.clone, 'node_modules', '.bin', 'y'));
});

test('a deps link that lands in the copy outside its dep is refused', PURE, () => {
  const run = fakeRun({ 'evil.sh': '#!/bin/sh\n', 'node_modules/.bin/x': { link: '../../evil.sh' } });
  assert.throws(() => resolveProgram({ word: 'node_modules/.bin/x', programs: [], deps: ['node_modules'], run }),
    (e) => e.message === 'gemini: "node_modules/.bin/x" resolves into the copy outside its dependency directory');
  assert.throws(() => resolveProgram({ word: 'node_modules/.bin/none', programs: [], deps: ['node_modules'], run }),
    (e) => e.message === 'gemini: "node_modules/.bin/none" is not a file in the copy');
});

test('a deps link to a program outside the run is accepted', PURE, () => {
  const run = fakeRun({ '.venv/bin/python': { link: '/usr/bin/true' }, 'node_modules/.bin/v': { link: '../v/cli.js' }, 'node_modules/v/cli.js': '#!/bin/sh\n' });
  assert.equal(resolveProgram({ word: '.venv/bin/python', programs: [], deps: ['.venv', 'node_modules'], run }), join(run.clone, '.venv', 'bin', 'python'));
  assert.equal(resolveProgram({ word: 'node_modules/.bin/v', programs: [], deps: ['.venv', 'node_modules'], run }), join(run.clone, 'node_modules', '.bin', 'v'));
});

/** Every path in `hits` matches `re`, every path in `misses` does not. */
function covers(re, hits, misses) {
  const r = new RegExp(re);
  for (const p of hits) assert.ok(r.test(p), `${re} should match ${p}`);
  for (const p of misses) assert.ok(!r.test(p), `${re} should miss ${p}`);
}

test('reach: a system program adds nothing; an nvm-shaped prefix under the home adds bin, npm and corepack only; a uv-shaped prefix is re-allowed whole; a binary in ~/bin adds itself alone; the up chain covers each', PURE, () => {
  const home = fixture({
    '.nvm/versions/node/v20/bin/node': 'n', '.nvm/versions/node/v20/lib/node_modules/npm/bin/npm-cli.js': 'n',
    '.nvm/versions/node/v20/lib/node_modules/corepack/x.js': 'c', '.nvm/versions/node/v20/lib/node_modules/other/y.js': 'o',
    '.local/share/uv/python/cpython-3.12/bin/python3.12': 'p', '.local/share/uv/python/cpython-3.12/lib/python3.12/os.py': 'o',
    '.local/share/uv/other/z': 'z', 'bin/tool': 't', 'bin/other': 'o', '.ssh/id': 's',
  });
  const base = nodeEnvT8({ home, prefix: '/opt/fleet-node', binary: '/opt/fleet-node/bin/node' });
  const system = toolchainReach({ home, binaries: ['/bin/echo'], base });
  assert.deepEqual(system, { node: base.OMELETTE_REPRO_NODE, up: base.OMELETTE_REPRO_NODEUP });
  const nvm = join(home, '.nvm/versions/node/v20');
  const uv = join(home, '.local/share/uv/python/cpython-3.12');
  const reach = toolchainReach({ home, binaries: ['/bin/echo', join(nvm, 'bin/node'), join(uv, 'bin/python3.12'), join(home, 'bin/tool')], base });
  covers(reach.node,
    ['/opt/fleet-node/bin/node', join(nvm, 'bin/node'), join(nvm, 'lib/node_modules/npm/bin/npm-cli.js'), join(nvm, 'lib/node_modules/corepack/x.js'),
      uv, join(uv, 'lib/python3.12/os.py'), join(home, 'bin/tool')],
    [home, join(nvm, 'lib/node_modules/other/y.js'), join(nvm, 'lib'), join(home, '.local/share/uv/other/z'), join(home, 'bin/other'), join(home, 'bin'), join(home, '.ssh/id'), `${join(home, 'bin/tool')}x`]);
  covers(reach.up,
    [home, join(home, '.nvm'), join(nvm, 'lib'), join(nvm, 'lib/node_modules'), join(home, '.local'), join(home, '.local/share/uv/python'), join(home, 'bin')],
    [join(home, '.ssh'), join(home, '.local/share/uv/other'), join(home, '.local/share/uv/python/cpython-3.12/lib'), `${home}/`, '/opt']);
});

test('reach: a prefix that is a direct child of the home is re-allowed through its bin and lib only, and a binary outside a bin directory there alone', PURE, () => {
  const home = fixture({ '.cargo/bin/rg': 'r', '.cargo/lib/x': 'l', '.cargo/credentials.toml': 's', '.cargo/registry/y': 'y', '.ssh/tool': 't', '.ssh/id': 's' });
  const base = nodeEnvT8({ home, prefix: '/opt/fleet-node', binary: '/opt/fleet-node/bin/node' });
  const reach = toolchainReach({ home, binaries: [join(home, '.cargo/bin/rg'), join(home, '.ssh/tool')], base });
  covers(reach.node, [join(home, '.cargo/bin'), join(home, '.cargo/bin/rg'), join(home, '.cargo/lib'), join(home, '.cargo/lib/x'), join(home, '.ssh/tool')],
    [join(home, '.cargo'), join(home, '.cargo/credentials.toml'), join(home, '.cargo/registry'), join(home, '.cargo/registry/y'), join(home, '.ssh/id'), join(home, '.ssh')]);
  covers(reach.up, [home, join(home, '.cargo'), join(home, '.ssh')], [join(home, '.cargo/bin'), join(home, '.ssh/id')]);
});

test('shebangOf follows /usr/bin/env one level', PURE, () => {
  const dir = fixture({
    'bin/node': '#!/usr/bin/env other\n', 'env.js': '#!/usr/bin/env node\n', 'envs.js': '#!/usr/bin/env -S node --flag\n',
    'sh.sh': '#!/bin/sh -e\n', 'none.txt': 'no shebang\n', 'lost.js': '#!/usr/bin/env missing\n',
  });
  const env = { PATH: join(dir, 'bin') };
  assert.equal(shebangOf(join(dir, 'env.js'), { env }), join(dir, 'bin', 'node'), 'the interpreter is located, its own shebang not followed');
  assert.equal(shebangOf(join(dir, 'envs.js'), { env }), join(dir, 'bin', 'node'));
  assert.equal(shebangOf(join(dir, 'sh.sh'), { env }), '/bin/sh');
  assert.equal(shebangOf(join(dir, 'none.txt'), { env }), null);
  assert.equal(shebangOf(join(dir, 'lost.js'), { env }), null);
});

test('parsePrograms refuses a path and a space', PURE, () => {
  assert.deepEqual(parsePrograms(' node , npm,,python3 '), ['node', 'npm', 'python3']);
  assert.throws(() => parsePrograms('node,/usr/bin/x'), (e) => e.message === 'gemini: gemini.testPrograms holds "/usr/bin/x", not a program name');
  assert.throws(() => parsePrograms('node,my prog'), (e) => e.message === 'gemini: gemini.testPrograms holds "my prog", not a program name');
});

test('checkTestCommand refuses [], a string, 65 words and a newline', PURE, () => {
  const refused = (e) => e.message === 'gemini: "testCommand" must be an argv array of 1 to 64 strings with no control characters';
  for (const bad of [[], 'node --test', Array(65).fill('x'), ['node', 'a\nb'], ['node', ''], ['node', 7], ['x'.repeat(4097)]]) assert.throws(() => checkTestCommand(bad), refused, JSON.stringify(bad).slice(0, 40));
  assert.deepEqual(checkTestCommand(['node', '--test', 'x'.repeat(4096)]), ['node', '--test', 'x'.repeat(4096)]);
  assert.equal(checkTestCommand(Array(64).fill('x')).length, 64);
});

test('assertDeps catches an ancestor renamed and recreated', PURE, () => {
  const clone = fixture({ 'packages/a/node_modules/i.js': 'i' });
  const parts = ['packages', 'a', 'node_modules'];
  const chain = parts.map((_, i) => { const path = join(clone, ...parts.slice(0, i + 1)); const st = lstatSync(path); return { path, dev: st.dev, ino: st.ino }; });
  const run = { deps: [{ rel: 'packages/a/node_modules', copy: join(clone, 'packages/a/node_modules'), chain }] };
  assertDeps(run);
  renameT8(join(clone, 'packages'), join(clone, 'packages.old'));
  mkdirSync(join(clone, 'packages/a/node_modules'), { recursive: true });
  assert.throws(() => assertDeps(run), (e) => e.message === 'gemini: a dependency directory of the copy was replaced during the run — the test command is not run');
  rmSync(join(clone, 'packages'), { recursive: true });
  symlinkSync(join(clone, 'packages.old'), join(clone, 'packages'));
  assert.throws(() => assertDeps(run), /was replaced during the run/, 'a link to the original is not the directory');
});

// The session's ruling on T8 (2026-11-25): the test command's PATH gets the directories its program needs.
import { programDirs, programNeeds, testPath as testPathT8 } from '../units/gemini/test-run.mjs';

test('programDirs: a bare name found through a link gives the resolved directory it was found in and its interpreter\'s directory; a deps path gives only its interpreter\'s', PURE, () => {
  const dir = fixture({
    'real/v1/bin/node': '#!/bin/sh\n', 'real/v1/lib/npm/bin/npm-cli.js': '#!/usr/bin/env node\n', 'real/v1/bin/npm': { link: '../lib/npm/bin/npm-cli.js' },
    'link': { link: 'real' }, 'other/bin/tool': '#!/bin/sh\n',
  });
  const env = { PATH: join(dir, 'link', 'v1', 'bin') };
  const npm = resolveProgram({ word: 'npm', programs: ['npm'], deps: [], run: fakeRun(), env });
  assert.equal(npm, join(dir, 'real/v1/lib/npm/bin/npm-cli.js'));
  assert.deepEqual(programDirs({ word: 'npm', program: npm, env }), [join(dir, 'real/v1/bin')], 'resolved, not the link spelling');
  assert.deepEqual(programNeeds({ word: 'npm', program: npm, env }), { dirs: [join(dir, 'real/v1/bin')], interpreter: join(dir, 'real/v1/bin/node') });
  // A bare name whose script runs /bin/sh: the directory it was found in, and nothing for /bin.
  const tool = resolveProgram({ word: 'tool', programs: ['tool'], deps: [], run: fakeRun(), env: { PATH: join(dir, 'other/bin') } });
  assert.deepEqual(programDirs({ word: 'tool', program: tool, env: { PATH: join(dir, 'other/bin') } }), ['/bin']);
  const run = fakeRun({ 'node_modules/x/cli.js': '#!/usr/bin/env node\n', 'node_modules/.bin/x': { link: '../x/cli.js' }, 'node_modules/.bin/y': '#!/bin/sh\n' });
  const x = resolveProgram({ word: 'node_modules/.bin/x', programs: [], deps: ['node_modules'], run });
  assert.deepEqual(programDirs({ word: 'node_modules/.bin/x', program: x, env }), [join(dir, 'real/v1/bin')]);
  assert.deepEqual(programNeeds({ word: 'node_modules/.bin/x', program: x, env: { PATH: '/nowhere' } }), { dirs: [], interpreter: null });
});

test('testPath takes extra directories right after the program\'s, even under the home', PURE, () => {
  const root = realpathSync(mkdtempSync(join(BASE, 'path-')));
  const home = join(root, 'home');
  for (const d of ['home/.nvm/bin', 'home/x/bin', 'sys/a']) mkdirSync(join(root, d), { recursive: true });
  const program = join(home, '.nvm/lib/npm/bin/npm-cli.js');
  assert.equal(testPathT8({ program, home, extra: [join(home, '.nvm/bin'), join(root, 'sys/a')], inherited: `${join(home, 'x/bin')}:${join(root, 'sys/a')}:/bin` }),
    [join(home, '.nvm/lib/npm/bin'), join(home, '.nvm/bin'), join(root, 'sys/a'), '/bin', '/usr/bin'].join(':'));
});

// The fix round after T7–T8's tester (2026-11-25): holes and C1 controls in the command, a program in the work tree.
test('checkTestCommand refuses a hole and a C1 control, and returns a copy', PURE, () => {
  const refused = (e) => e.message === 'gemini: "testCommand" must be an argv array of 1 to 64 strings with no control characters';
  for (const bad of [new Array(2), ['node', , 'x'], ['node', '\u009b31m'], ['node', '\u0085']]) assert.throws(() => checkTestCommand(bad), refused, JSON.stringify(bad));
  const argv = ['node', '--test', ' é'];
  const got = checkTestCommand(argv);
  assert.deepEqual(got, argv);
  assert.notEqual(got, argv, 'a copy, not the argument');
});

test('resolveProgram refuses a bare name that resolves into the work tree', PURE, () => {
  const run = fakeRun({}, { 'node_modules/.bin/node': '#!/bin/sh\n' });
  const real = join(run.top, 'node_modules', '.bin', 'node');
  const message = `gemini: "node" resolves into the work tree (${JSON.stringify(real)}) — the test command cannot read the work tree; name a program outside it, or a path under a deps entry`;
  const env = { PATH: `${join(run.top, 'node_modules', '.bin')}:/usr/bin:/bin` };
  assert.throws(() => resolveProgram({ word: 'node', programs: ['node'], deps: [], run, env }), (e) => e.message === message);
  // The top spelled through a link: compared resolved.
  const link = join(BASE, `top-link-${++n}`);
  symlinkSync(run.top, link);
  assert.throws(() => resolveProgram({ word: 'node', programs: ['node'], deps: [], run: { ...run, top: link }, env }), (e) => e.message === message);
});

test('resolveProgram refuses a deps path whose link resolves into the work tree', PURE, () => {
  const run = fakeRun({}, { 'tools/x.sh': '#!/bin/sh\n' });
  mkdirSync(join(run.clone, 'node_modules', '.bin'), { recursive: true });
  const real = realpathSync(join(run.top, 'tools', 'x.sh'));
  symlinkSync(real, join(run.clone, 'node_modules', '.bin', 'x'));
  const message = `gemini: "node_modules/.bin/x" resolves into the work tree (${JSON.stringify(real)}) — the test command cannot read the work tree; name a program outside it, or a path under a deps entry`;
  assert.throws(() => resolveProgram({ word: 'node_modules/.bin/x', programs: [], deps: ['node_modules'], run }), (e) => e.message === message);
});

// The second fix round after the T9/T10 tester (2026-11-25): the notice's names come from the unit's own listing, which
// honours no ignore rule (a model-written .gitignore can ignore itself) and matches the base name in lower case.
import { testGuards } from '../units/gemini/test-run.mjs';

test('testGuards names an ignore file that ignores itself, an attributes file in another letter case, a changed tracked one, and nothing under a dependency copy', { ...COPIED, timeout: 5_000 }, () => {
  const work = writeTree(workTree({ 'pkg/.gitattributes': '*.bin binary\n' }), { 'node_modules/pkg/index.js': 'i\n', 'node_modules/pkg/.gitignore': '*\n' });
  writeFileSync(join(work, '.git', 'info', 'exclude'), 'node_modules/\n');
  const run = runWithDeps(work, ['node_modules']);
  try {
    // Whether this volume reads another letter case as the same file: the attributes file's part asserts only there.
    const caseless = existsSync(join(run.clone, 'README.MD'));
    writeFileSync(join(run.clone, '.gitignore'), '*\n');
    writeFileSync(join(run.clone, 'a.test.mjs'), 'ok\n');
    writeFileSync(join(run.clone, 'pkg', '.gitattributes'), '* -diff\n');
    if (caseless) writeFileSync(join(run.clone, '.GITATTRIBUTES'), '* -diff\n');
    assert.deepEqual(testGuards(run), [...(caseless ? ['.GITATTRIBUTES'] : []), '.gitignore', 'pkg/.gitattributes']);
  } finally { discardRun(run); }
});
