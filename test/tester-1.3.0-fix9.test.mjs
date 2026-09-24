/**
 * omelette-fleet :: test/tester-1.3.0-fix9.test.mjs
 * Independent coverage for plan 2026-09-24-1.3.0-P0-fixes.md, Task 9 (S16):
 * `changedSince` (core/check.mjs) must run `git diff -z` and split on NUL, so
 * a changed file whose name git would otherwise quote — non-ASCII, a space, a
 * double quote — is matched by the same spelling `checkPointers` resolves on
 * disk, and its pointer reads `stale` instead of silently `ok`.
 *
 * Written fresh against the diff, without importing anything from
 * test/check.test.mjs. Every case builds its own disposable git repository
 * under a temp dir and tears it down in after(). Nothing here compares
 * against `git show HEAD:…`; the disposable repo's own working tree is what
 * is inspected, matching the contract ("the WORKING TREE, uncommitted edits
 * included").
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { changedSince, checkPointers } from '../core/check.mjs';

const dirs = [];
function tmp(prefix = 'omelette-fix9-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const GIT_SKIP = GIT ? false : 'git is not on PATH — these tests need a real repository';
const GIT_ID = ['-c', 'user.name=omelette fix9 tester', '-c', 'user.email=fix9-tester@example.invalid', '-c', 'commit.gpgsign=false'];

/** A fresh, empty git repository, plus a `run` helper for further commands. */
function gitRepo() {
  const root = tmp('omelette-fix9-git-');
  const run = (args) => {
    const r = spawnSync('git', [...GIT_ID, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return (r.stdout || '').trim();
  };
  run(['init', '-q']);
  return { root, run };
}

/** Write `rel` (creating parent directories), commit it alone, return the commit hash. */
function commitFile(root, run, rel, body) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  run(['add', '-A']);
  run(['commit', '-q', '-m', `add ${rel}`]);
  return run(['rev-parse', 'HEAD']);
}

test('changedSince/checkPointers: a committed café.js edited after the commit is matched by its real name, and its pointer goes stale', { skip: GIT_SKIP }, () => {
  const { root, run } = gitRepo();
  const commit = commitFile(root, run, 'café.js', 'export const total = 1;\n');
  writeFileSync(join(root, 'café.js'), 'export const total = 1;\n// edited, never committed\n');

  const { changed } = changedSince({ hash: commit, root });
  assert.ok(changed.has('café.js'), `changed set did not hold café.js: ${JSON.stringify([...changed])}`);

  const { pointers } = checkPointers({
    text: 'café.js:1 · `export const total = 1;` · the total',
    root,
    changed,
  });
  assert.equal(pointers[0].status, 'stale');
});

test('changedSince: a file with a space in its name is matched as it is on disk', { skip: GIT_SKIP }, () => {
  // The pointer grammar itself excludes whitespace from a path field
  // (core/check.mjs POINTER / OPENER), so a space-named file cannot be
  // addressed by a pointer line at all — that is a grammar limit, not part of
  // this fix. What the fix owns is changedSince() reporting the name
  // correctly, checked directly here.
  const { root, run } = gitRepo();
  const commit = commitFile(root, run, 'my file.js', 'export const two = 2;\n');
  writeFileSync(join(root, 'my file.js'), 'export const two = 2;\n// edited, never committed\n');

  const { changed } = changedSince({ hash: commit, root });
  assert.ok(changed.has('my file.js'), `changed set did not hold "my file.js": ${JSON.stringify([...changed])}`);
});

test('changedSince/checkPointers: a filename holding a double quote is matched as it is on disk, or the case is skipped and says so', { skip: GIT_SKIP }, (t) => {
  const { root, run } = gitRepo();
  const rel = 'quo"te.js';
  try {
    writeFileSync(join(root, rel), 'export const three = 3;\n');
  } catch (e) {
    t.skip(`filesystem refused a double-quote filename (${rel}): ${e.message}`);
    return;
  }
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'add a quoted name']);
  const commit = run(['rev-parse', 'HEAD']);
  writeFileSync(join(root, rel), 'export const three = 3;\n// edited, never committed\n');

  const { changed } = changedSince({ hash: commit, root });
  assert.ok(changed.has(rel), `changed set did not hold ${rel}: ${JSON.stringify([...changed])}`);

  const text = `${rel}:1 · \`export const three = 3;\` · the third constant`;
  const { pointers } = checkPointers({ text, root, changed });
  assert.equal(pointers[0].status, 'stale');
});

test('changedSince/checkPointers: an unchanged ASCII file is absent from the changed set and its pointer reads ok', { skip: GIT_SKIP }, () => {
  const { root, run } = gitRepo();
  const commit = commitFile(root, run, 'plain.txt', 'hello there\n');

  const { changed } = changedSince({ hash: commit, root });
  assert.ok(!changed.has('plain.txt'), `changed set unexpectedly held plain.txt: ${JSON.stringify([...changed])}`);

  const { pointers } = checkPointers({
    text: 'plain.txt:1 · `hello there` · greeting',
    root,
    changed,
  });
  assert.equal(pointers[0].status, 'ok');
});

test('changedSince/checkPointers: a changed file under a non-ASCII directory name is matched by its relative path', { skip: GIT_SKIP }, () => {
  const { root, run } = gitRepo();
  const rel = join('café', 'résumé.js').replace(/\\/g, '/');
  const commit = commitFile(root, run, rel, 'export const four = 4;\n');
  writeFileSync(join(root, 'café', 'résumé.js'), 'export const four = 4;\n// edited, never committed\n');

  const { changed } = changedSince({ hash: commit, root });
  assert.ok(changed.has(rel), `changed set did not hold ${rel}: ${JSON.stringify([...changed])}`);

  const { pointers } = checkPointers({
    text: `${rel}:1 · \`export const four = 4;\` · the fourth constant`,
    root,
    changed,
  });
  assert.equal(pointers[0].status, 'stale');
});

test('changedSince: core.quotePath=true set explicitly still matches a non-ASCII name, because -z is unquoted regardless', { skip: GIT_SKIP }, () => {
  const { root, run } = gitRepo();
  run(['config', 'core.quotePath', 'true']);
  const commit = commitFile(root, run, 'café.js', 'export const five = 5;\n');
  writeFileSync(join(root, 'café.js'), 'export const five = 5;\n// edited, never committed\n');

  const { changed } = changedSince({ hash: commit, root });
  assert.ok(changed.has('café.js'), `changed set did not hold café.js with core.quotePath=true: ${JSON.stringify([...changed])}`);
});
