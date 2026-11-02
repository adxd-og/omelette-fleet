/**
 * omelette-fleet :: test/tester-1.7.3-ledger.test.mjs
 * Tester probes for 1.7.3 Tasks 1-3 (core/ledger.mjs): what the coder's two
 * files leave unpinned. Every test runs in a throwaway project from the Task 1
 * fixture; the fake git is a node script in a temp directory, killed by the
 * timeout it is tested with.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePointers } from '../core/check.mjs';
import { branchExists, classifyLedger, harvestBindings, listLedgers, openLedger, readRegisterPath, registerLine } from '../core/ledger.mjs';
import { GIT_SKIP, ledger, project } from './fixtures/ledger-1.7.3.mjs';

const POSIX = process.platform === 'win32' && 'POSIX paths, symlinks and a fake git';
const FENCE = '`'.repeat(3);

/** A fake `git` first on an absolute PATH: logs every argv, behaves as `mode` says. */
function fakeGit(mode) {
  const bin = mkdtempSync(join(tmpdir(), 'omelette-fakegit-'));
  writeFileSync(join(bin, 'mode'), mode);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const dir = path.dirname(process.argv[1]);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim();
if (mode === 'notrepo') { process.stderr.write('fatal: not a git repository (or any of the parent directories): .git\\n'); process.exit(128); }
if (mode === 'fail') { process.stderr.write('fatal: something else\\n'); process.exit(2); }
if (mode === 'hang') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); process.exit(0); }
if (mode === 'branch-unicode') { process.stdout.write('feat/\\u00fc\\n'); process.exit(0); }
process.exit(1);
`);
  chmodSync(join(bin, 'git'), 0o755);
  return {
    env: { PATH: bin },
    mode: (m) => writeFileSync(join(bin, 'mode'), m),
    calls: () => (existsSync(join(bin, 'calls.log')) ? readFileSync(join(bin, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
  };
}

const NO_GIT = { PATH: '/nonexistent-omelette-bin' };

test('header: CRLF `branch: main` is standing without asking git; a 100 KB ledger is classified from its first bytes; `main` past line 20 is untracked', () => {
  const p = project({ git: false });
  p.write('.omelette/ledger-lane.md', '# lane\r\nbranch: main\r\n\r\nnote\r\n');
  p.write('.omelette/ledger-big.md', `# big\nbranch: main\n${'x'.repeat(100_000)}\n`);
  p.write('.omelette/ledger-late.md', `${'line\n'.repeat(20)}branch: main\n`);
  assert.deepEqual(classifyLedger(p.dir, 'ledger-lane.md', { env: NO_GIT }), { name: 'ledger-lane.md', plan: 'lane', state: 'standing', branch: 'main' });
  assert.equal(classifyLedger(p.dir, 'ledger-big.md', { env: NO_GIT }).state, 'standing');
  assert.equal(classifyLedger(p.dir, 'ledger-late.md', { env: NO_GIT }).state, 'untracked');
  const l = listLedgers(p.dir, { env: NO_GIT });
  assert.equal(l.error, null, 'no named branch, so git was never asked');
  assert.deepEqual(l.ledgers.map((x) => `${x.name}:${x.state}`), ['ledger-big.md:standing', 'ledger-lane.md:standing', 'ledger-late.md:untracked']);
});

test('only a real file inside a real .omelette is a ledger: a symlink, a FIFO and a directory are skipped, never followed or opened', { skip: POSIX, timeout: 15000 }, () => {
  const p = project({ git: false });
  p.write('.omelette/ledger-real.md', ledger('main'));
  p.write('elsewhere/ledger-target.md', ledger('main'));
  symlinkSync(join(p.dir, 'elsewhere', 'ledger-target.md'), join(p.dir, '.omelette', 'ledger-link.md'));
  mkdirSync(join(p.dir, '.omelette', 'ledger-dir.md'));
  const fifo = spawnSync('mkfifo', [join(p.dir, '.omelette', 'ledger-fifo.md')]);
  for (const name of ['ledger-link.md', 'ledger-dir.md', ...(fifo.status === 0 ? ['ledger-fifo.md'] : [])]) {
    assert.equal(classifyLedger(p.dir, name, { env: NO_GIT }), null, name);
  }
  assert.deepEqual(listLedgers(p.dir, { env: NO_GIT }).ledgers.map((x) => x.name), ['ledger-real.md']);
  // an archive that is a symlink is not counted; a .omelette that is a symlink is refused whole
  p.write('elsewhere/archive-src/ledger-0.1.md', 'x');
  symlinkSync(join(p.dir, 'elsewhere', 'archive-src'), join(p.dir, '.omelette', 'archive'));
  assert.equal(listLedgers(p.dir, { env: NO_GIT }).archived, 0);
  const q = project({ git: false });
  rmDir(q, '.omelette');
  q.write('real-omelette/ledger-x.md', ledger('main'));
  symlinkSync(join(q.dir, 'real-omelette'), join(q.dir, '.omelette'));
  assert.deepEqual(listLedgers(q.dir, { env: NO_GIT }), { ledgers: [], archived: 0, error: 'not-a-directory' });
});

function rmDir(p, rel) {
  spawnSync('rm', ['-rf', join(p.dir, rel)]);
}

test('open means refs/heads/<branch> exactly: a tag of that name or a bare prefix does not count; a packed branch does', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-x.md', ledger('feat/x'));
  p.write('.omelette/ledger-f.md', ledger('feat'));
  p.git(['tag', 'feat/x']);
  assert.equal(classifyLedger(p.dir, 'ledger-x.md').state, 'closed', 'a tag is not a branch');
  p.git(['branch', 'feat-x']); // a longer name only
  assert.equal(classifyLedger(p.dir, 'ledger-f.md').state, 'closed', 'no branch is named feat');
  p.git(['branch', 'packed']);
  p.write('.omelette/ledger-packed.md', ledger('packed'));
  p.git(['pack-refs', '--all']);
  assert.equal(classifyLedger(p.dir, 'ledger-packed.md').state, 'open');
  assert.deepEqual(branchExists(p.dir, 'packed'), { exists: true });
});

test('the git child runs with absolute PATH entries only: a git planted in a relative PATH entry of the project is never run', { skip: GIT_SKIP || POSIX }, () => {
  const p = project();
  p.git(['branch', 'feat/x']);
  p.write('.omelette/ledger-x.md', ledger('feat/x'));
  p.write('bin/git', `#!/bin/sh\necho ran > "${join(p.dir, 'PLANTED')}"\nexit 0\n`);
  chmodSync(join(p.dir, 'bin', 'git'), 0o755);
  const env = { PATH: `bin${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
  assert.equal(classifyLedger(p.dir, 'ledger-x.md', { env }).state, 'open');
  assert.equal(existsSync(join(p.dir, 'PLANTED')), false);
});

test('git is asked exactly two things, read-only, and every failure maps to its code: no-git, not-a-repo, git-failed, timeout', { skip: POSIX }, () => {
  const p = project({ git: false });
  const g = fakeGit('notrepo');
  p.write('.omelette/ledger-x.md', ledger('feat/x'));
  assert.deepEqual(branchExists(p.dir, 'feat/x', { env: g.env }), { error: 'not-a-repo' });
  assert.deepEqual(openLedger(p.dir, 'x', { env: g.env }), { error: 'not inside a git repository' });
  assert.deepEqual(g.calls(), [
    ['--no-optional-locks', 'show-ref', '--verify', '--quiet', 'refs/heads/feat/x'],
    ['--no-optional-locks', 'symbolic-ref', '--quiet', 'HEAD'],
  ]);
  g.mode('fail');
  assert.deepEqual(branchExists(p.dir, 'feat/x', { env: g.env }), { error: 'git-failed' });
  assert.deepEqual(openLedger(p.dir, 'x', { env: g.env }), { error: 'git symbolic-ref failed' });
  assert.deepEqual(branchExists(p.dir, 'feat/x', { env: NO_GIT }), { error: 'no-git' });
  assert.deepEqual(openLedger(p.dir, 'x', { env: NO_GIT }), { error: 'git not found on PATH' });
  g.mode('hang');
  assert.deepEqual(branchExists(p.dir, 'feat/x', { env: g.env, timeoutMs: 300 }), { error: 'timeout' });
  assert.deepEqual(openLedger(p.dir, 'x', { env: g.env, timeoutMs: 300 }), { error: 'git symbolic-ref did not answer within 0.3 s' });
  assert.equal(existsSync(join(p.dir, '.omelette', 'ledger-x.md')), true, 'the earlier ledger is untouched');
  assert.equal(p.read('.omelette/ledger-x.md'), ledger('feat/x'));
});

test('listLedgers: after the first git error (a hang included) no later ledger asks git again; each is unknown with that error', { skip: POSIX }, () => {
  const p = project({ git: false });
  for (const n of ['a', 'b', 'c']) p.write(`.omelette/ledger-${n}.md`, ledger(`feat/${n}`));
  p.write('.omelette/ledger-m.md', ledger('main'));
  const g = fakeGit('hang');
  const l = listLedgers(p.dir, { env: g.env, timeoutMs: 300 });
  assert.equal(l.error, 'timeout');
  assert.deepEqual(l.ledgers.map((x) => `${x.name}:${x.state}:${x.error ?? ''}`), [
    'ledger-a.md:unknown:timeout', 'ledger-b.md:unknown:timeout', 'ledger-c.md:unknown:timeout', 'ledger-m.md:standing:',
  ]);
  assert.equal(g.calls().length, 1, 'one call, then none');
});

test('openLedger: the plan is checked before git is asked; a printed plan name cannot carry a control character; 64 characters are the limit', { skip: GIT_SKIP }, () => {
  const bare = project({ git: false });
  assert.match(openLedger(bare.dir, '../x', { env: NO_GIT }).error, /^plan name /, 'plan first, not "git not found"');
  const p = project();
  p.git(['checkout', '-q', '-b', 'feat/long']);
  const esc = openLedger(p.dir, 'a\u001b[31m').error;
  assert.match(esc, /^plan name /);
  assert.equal(esc.includes('\u001b'), false);
  assert.match(openLedger(p.dir, 'a'.repeat(65)).error, /^plan name /);
  assert.deepEqual(openLedger(p.dir, 'a'.repeat(64)), { rel: `.omelette/ledger-${'a'.repeat(64)}.md`, branch: 'feat/long' });
});

test('openLedger writes only a new regular file inside a real .omelette: a symlinked .omelette, a file in its place, a symlink at the ledger path and an unwritable branch name all leave everything as it was', { skip: GIT_SKIP || POSIX }, () => {
  const p = project();
  p.git(['checkout', '-q', '-b', 'feat/w']);
  // a symlink at the ledger's own path (dangling or not) is "exists", and its target is not touched
  p.write('outside/theirs.md', 'theirs\n');
  symlinkSync(join(p.dir, 'outside', 'theirs.md'), join(p.dir, '.omelette', 'ledger-s.md'));
  symlinkSync(join(p.dir, 'outside', 'not-yet.md'), join(p.dir, '.omelette', 'ledger-d.md'));
  assert.deepEqual(openLedger(p.dir, 's'), { error: '.omelette/ledger-s.md exists' });
  assert.deepEqual(openLedger(p.dir, 'd'), { error: '.omelette/ledger-d.md exists' });
  assert.equal(readFileSync(join(p.dir, 'outside', 'theirs.md'), 'utf8'), 'theirs\n');
  assert.equal(existsSync(join(p.dir, 'outside', 'not-yet.md')), false);
  // .omelette a symlink to a directory, then a plain file
  const q = project();
  q.git(['checkout', '-q', '-b', 'feat/w']);
  rmDir(q, '.omelette');
  mkdirSync(join(q.dir, 'real'));
  symlinkSync(join(q.dir, 'real'), join(q.dir, '.omelette'));
  const before = q.snapshot();
  assert.deepEqual(openLedger(q.dir, 'x'), { error: '.omelette is not a directory of this project' });
  assert.deepEqual(q.snapshot(), before);
  const r = project();
  r.git(['checkout', '-q', '-b', 'feat/w']);
  rmDir(r, '.omelette');
  r.write('.omelette', 'a file\n');
  assert.deepEqual(openLedger(r.dir, 'x'), { error: '.omelette is not a directory of this project' });
  assert.equal(r.read('.omelette'), 'a file\n');
  // a branch name the header cannot hold
  const u = project();
  u.git(['checkout', '-q', '-b', 'feat/ü']);
  const snap = u.snapshot();
  assert.match(openLedger(u.dir, 'x').error, /^branch "feat\/.*" cannot be written as a ledger header$/);
  assert.deepEqual(u.snapshot(), snap);
});

test('harvestBindings: a fence closes only on its own character and at least its own length; an unclosed fence swallows the rest; four spaces is no fence', () => {
  const R = (s) => `Ruling(binding): ${s} — why — cost`;
  const text = [
    `${FENCE}md`, '~~~', R('in backtick fence, tilde did not close it'), FENCE,
    R('1 after a backtick fence'),
    '~~~~', FENCE, R('in tilde fence, shorter backtick line did not close it'), '~~~~',
    R('2 after a tilde fence'),
    '`'.repeat(4), FENCE, R('in a four-backtick fence, a three-backtick line did not close it'), '`'.repeat(5),
    R('3 after a five-backtick closer'),
    `    ${FENCE}`, R('4 four spaces make no fence'),
    `   ${FENCE}`, R('in a fence opened with three spaces'),
  ].join('\n');
  assert.deepEqual(harvestBindings(text).map((h) => h.ruling), [R('1 after a backtick fence'), R('2 after a tilde fence'), R('3 after a five-backtick closer'), R('4 four spaces make no fence')]);
});

test('harvestBindings: the first unquoted marker wins and one line is one ruling; the date is only a leading one', () => {
  const out = harvestBindings([
    'see `Ruling(binding):` then Ruling(binding): the real one — why — cost',
    '2026-10-01 Ruling(binding): first — a — b Ruling(binding): second — c — d',
    '* 2026-10-02 Ruling(binding): star bullet — a — b',
    '+ 2026-10-03 Ruling(binding): plus bullet — a — b',
    '- note of 2026-10-04 Ruling(binding): date not leading — a — b',
    '  \t - 2026-10-05   Ruling(binding): indented — a — b   ',
  ].join('\n'));
  assert.deepEqual(out, [
    { ruling: 'Ruling(binding): the real one — why — cost', date: null },
    { ruling: 'Ruling(binding): first — a — b Ruling(binding): second — c — d', date: '2026-10-01' },
    { ruling: 'Ruling(binding): star bullet — a — b', date: '2026-10-02' },
    { ruling: 'Ruling(binding): plus bullet — a — b', date: '2026-10-03' },
    { ruling: 'Ruling(binding): date not leading — a — b', date: null },
    { ruling: 'Ruling(binding): indented — a — b', date: '2026-10-05' },
  ]);
  assert.deepEqual(harvestBindings(''), []);
  assert.deepEqual(harvestBindings(undefined), []);
});

test('registerLine: only a TRAILING pointer moves, and a half-backticked one is not a pointer', () => {
  const mid = 'Ruling(binding): see src/a.mjs:3 · `x` for the rest — why — cost';
  assert.equal(registerLine({ ruling: mid, date: '2026-11-02', plan: 'p' }), `- 2026-11-02 · p · ${mid}`, 'a mid-line pointer stays where it is');
  const half = 'Ruling(binding): x — y — z · `src/a.mjs:3 · `frag`';
  assert.equal(registerLine({ ruling: half, date: '2026-11-02', plan: 'p' }), `- 2026-11-02 · p · ${half}`);
  const two = registerLine({ ruling: 'Ruling(binding): x — y — z · src/a.mjs:1 · `one` · src/b.mjs:2 · `two`', date: '2026-11-02', plan: 'p' });
  assert.equal(two, '- src/b.mjs:2 · `two` · 2026-11-02 · p · Ruling(binding): x — y — z · src/a.mjs:1 · `one`');
  assert.equal(parsePointers(two).length >= 1, true, 'check sees the line start');
  assert.deepEqual(parsePointers(two)[0], { line: 1, path: 'src/b.mjs', lineNo: 2, fragment: 'two' });
});

test('readRegisterPath: the redirect is followed once and only from line 1; an existing target, a big register and `register:path` without a space all work', { skip: POSIX }, () => {
  const p = project({ git: false });
  p.write('docs/DECISIONS.md', 'register: docs/OTHER.md\n- 2026-11-01 · p · Ruling(binding): a — b — c\n');
  p.write('.omelette/decisions.md', `register:docs/DECISIONS.md\n${'- 2026-11-01 · p · filler\n'.repeat(400)}`);
  assert.deepEqual(readRegisterPath(p.dir), { path: join(p.dir, 'docs', 'DECISIONS.md'), rel: 'docs/DECISIONS.md', via: '.omelette/decisions.md' }, "the target's own first line is not a redirect");
  p.write('.omelette/decisions.md', '\nregister: docs/DECISIONS.md\n');
  assert.deepEqual(readRegisterPath(p.dir), { path: join(p.dir, '.omelette', 'decisions.md'), rel: '.omelette/decisions.md', via: null }, 'line 2 is not the first line');
  p.write('.omelette/decisions.md', '# the register\nregister: docs/DECISIONS.md\n');
  assert.equal(readRegisterPath(p.dir).via, null);
});

test('readRegisterPath: spellings of the register itself are refused, and the refusal prints no control character', { skip: POSIX }, () => {
  const p = project({ git: false });
  for (const v of ['./.omelette/decisions.md', '.omelette//decisions.md', '.omelette/./decisions.md']) {
    p.write('.omelette/decisions.md', `register: ${v}\n`);
    assert.match(readRegisterPath(p.dir).error, /^register: .* refused \(points at itself\)$/, v);
  }
  p.write('.omelette/decisions.md', 'register: docs/\u001b[31mx.md\n');
  const r = readRegisterPath(p.dir);
  assert.match(r.error, /^register: /);
  assert.equal(r.error.includes('\u001b'), false);
});

test('readRegisterPath: a path that reaches the register through a symlinked directory is the register itself and is refused (spec: "a redirect to .omelette/decisions.md itself")', { skip: POSIX }, () => {
  const p = project({ git: false });
  symlinkSync(join(p.dir, '.omelette'), join(p.dir, 'alias'));
  p.write('.omelette/decisions.md', 'register: alias/decisions.md\n');
  const r = readRegisterPath(p.dir);
  assert.ok(r.error, `expected a refusal, got ${JSON.stringify(r)}`);
});

test('readRegisterPath: on a case-insensitive filesystem a differently-cased spelling of the register is the register itself and is refused', { skip: POSIX }, (t) => {
  const p = project({ git: false });
  p.write('.omelette/decisions.md', 'register: .OMELETTE/decisions.md\n');
  if (!existsSync(join(p.dir, '.OMELETTE'))) return t.skip('case-sensitive filesystem');
  const r = readRegisterPath(p.dir);
  assert.ok(r.error, `expected a refusal, got ${JSON.stringify(r)}`);
});

test('readRegisterPath: a redirect into .git is refused, whether the file exists or not', { skip: POSIX }, () => {
  const p = project();
  for (const v of ['.git/config', '.git/hooks/pre-commit', '.git']) {
    p.write('.omelette/decisions.md', `register: ${v}\n`);
    assert.deepEqual(readRegisterPath(p.dir), { error: `register: ${v} refused (inside .git)` }, v);
  }
  // The same directory under another name: a symlink to .git, and a symlink to
  // a directory inside it — refused by inode, not by spelling (second pass).
  symlinkSync('.git', join(p.dir, 'gl'));
  symlinkSync(join('.git', 'hooks'), join(p.dir, 'hk'));
  for (const v of ['gl/config', 'hk/pre-commit']) {
    p.write('.omelette/decisions.md', `register: ${v}\n`);
    assert.deepEqual(readRegisterPath(p.dir), { error: `register: ${v} refused (inside .git)` }, v);
  }
});

test('a register redirect into .omelette/ is refused, a ledger or a not-yet-made archive/ alike; the default register without a redirect still reads', { skip: POSIX || GIT_SKIP }, () => {
  const p = project();
  for (const v of ['.omelette/ledger-x.md', '.omelette/archive/x.md', './.omelette/sub/y.md']) {
    p.write('.omelette/decisions.md', `register: ${v}\n`);
    assert.deepEqual(readRegisterPath(p.dir), { error: `register: ${v} refused (inside .omelette)` }, v);
  }
  mkdirSync(join(p.dir, '.omelette', 'archive'), { recursive: true });
  p.write('.omelette/decisions.md', 'register: .omelette/archive/x.md\n');
  assert.deepEqual(readRegisterPath(p.dir), { error: 'register: .omelette/archive/x.md refused (inside .omelette)' });
  // The same directory under another name — a symlink to .omelette, and one to
  // a directory inside it — is refused by inode, not by spelling.
  symlinkSync('.omelette', join(p.dir, 'om'));
  symlinkSync(join('.omelette', 'archive'), join(p.dir, 'oa'));
  for (const v of ['om/ledger-x.md', 'oa/x.md']) {
    p.write('.omelette/decisions.md', `register: ${v}\n`);
    assert.deepEqual(readRegisterPath(p.dir), { error: `register: ${v} refused (inside .omelette)` }, v);
  }
  // No redirect: the default path, with and without the file present.
  p.write('.omelette/decisions.md', '- 2026-10-02 · plan · a ruling\n');
  assert.deepEqual(readRegisterPath(p.dir), { path: join(p.dir, '.omelette', 'decisions.md'), rel: '.omelette/decisions.md', via: null });
  const q = project();
  assert.deepEqual(readRegisterPath(q.dir), { path: join(q.dir, '.omelette', 'decisions.md'), rel: '.omelette/decisions.md', via: null });
  // A redirect elsewhere in the project is still followed.
  q.write('.omelette/decisions.md', 'register: docs/DECISIONS.md\n');
  q.write('docs/DECISIONS.md', '');
  assert.equal(readRegisterPath(q.dir).rel, 'docs/DECISIONS.md');
});
