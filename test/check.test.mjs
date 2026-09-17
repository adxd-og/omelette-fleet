/**
 * omelette-fleet :: test/check.test.mjs
 * `omelette-fleet check` and core/check.mjs, against
 * docs/superpowers/specs/2026-09-17-1.1.0-design.md — §1 (the pointer-line
 * grammar), §4 (statuses, staleness, exit codes, output, bounds) and the list
 * §6 keeps for this file.
 *
 * Everything runs on temp directories under os.tmpdir(), removed in after().
 * Nothing spawns a vendor binary; the CLI runs with its own throwaway
 * OMELETTE_HOME so no test can touch the real fleet home. The staleness tests
 * build their own git repository and skip, loudly, where git is not on PATH.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CACHE_BYTES, MAX_POINTERS, MAX_TARGET_BYTES, TARGET_OPEN_FLAGS, changedSince, checkPointers, parseCommit, parsePointers } from '../core/check.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

const dirs = [];
function tmp(prefix = 'omelette-check-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A project fixture: { 'rel/path': contents } under a fresh temp root. */
function project(files) {
  const root = tmp();
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

/** The CLI, with a throwaway home so nothing reaches the operator's fleet. */
function cli(args, { cwd, env = {} } = {}) {
  const home = tmp('omelette-check-home-');
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: home, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const summary = (n, { ok = 0, moved = 0, mismatch = 0, missing = 0, outside = 0, stale = 0, tooLarge = 0 } = {}) =>
  `check: ${n} pointers · ${ok} ok · ${moved} moved · ${mismatch} mismatch · ${missing} missing · ${outside} outside · ${stale} stale`
  + (tooLarge ? ` · ${tooLarge} too-large` : '');

// ─── §1 the grammar ─────────────────────────────────────────────────────────

test('parsePointers: bullet and backticks optional, the claim ignored, everything else prose', () => {
  const text = [
    '# Map — demo',                                                       // 1
    '',                                                                   // 2
    '- `core/unit.mjs:436` · `const finish = (text, isError` · it spools', // 3
    '* core/unit.mjs:12 · `export function createUnitRuntime` · claim',    // 4
    '  bin/omelette-fleet.mjs:7 · `NEVER SHELLS OUT` · the header says so',// 5
    'core/unit.mjs:9 · `no claim at all`',                                 // 6
    'Prose about core/unit.mjs:436 and what it does.',                     // 7
    'core/unit.mjs:0 · `zero is not a line` · never a pointer',            // 8
    'core/unit.mjs:abc · `not a number` · never a pointer',                // 9
    'core/unit.mjs:5 - `wrong separator` · never a pointer',               // 10
    'core/unit.mjs:5 · no backticks round the fragment · never a pointer',  // 11
    '`core/unit.mjs:5 · `half a backtick pair` · never a pointer',         // 12
    'core/unit.mjs:5 · `` · an empty fragment is no fragment',             // 13
  ].join('\n');
  assert.deepEqual(parsePointers(text), [
    { line: 3, path: 'core/unit.mjs', lineNo: 436, fragment: 'const finish = (text, isError' },
    { line: 4, path: 'core/unit.mjs', lineNo: 12, fragment: 'export function createUnitRuntime' },
    { line: 5, path: 'bin/omelette-fleet.mjs', lineNo: 7, fragment: 'NEVER SHELLS OUT' },
    { line: 6, path: 'core/unit.mjs', lineNo: 9, fragment: 'no claim at all' },
  ]);
});

test('parsePointers: at most 2000 pointer lines per checked file', () => {
  const line = 'a.txt:1 · `x` · c';
  assert.equal(MAX_POINTERS, 2000);
  assert.equal(parsePointers(Array(MAX_POINTERS).fill(line).join('\n')).length, MAX_POINTERS);
  assert.throws(() => parsePointers(Array(MAX_POINTERS + 1).fill(line).join('\n')), /2000/);
});

test('parseCommit: a hex hash in the first 20 lines, and nothing else', () => {
  assert.equal(parseCommit('# Map — demo\ncommit: 3dd368d\n'), '3dd368d');
  assert.equal(parseCommit('commit: `3dd368dabc1234567890abcdef1234567890abcd`\n'), '3dd368dabc1234567890abcdef1234567890abcd');
  assert.equal(parseCommit('commit: --output=x\n'), null, 'a flag never reaches git');
  assert.equal(parseCommit('commit: $(id)\n'), null);
  assert.equal(parseCommit('commit: HEAD~1\n'), null);
  assert.equal(parseCommit('commit: 3dd368\n'), null, 'six hex is shorter than the grammar');
  assert.equal(parseCommit(`commit: ${'a'.repeat(41)}\n`), null, 'forty-one hex is longer');
  assert.equal(parseCommit(`${'filler\n'.repeat(20)}commit: 3dd368d\n`), null, 'line 21 is too late');
  assert.equal(parseCommit('nothing about a commit here\n'), null);
});

// ─── §4 statuses ────────────────────────────────────────────────────────────

test('ok: the fragment is on that line', () => {
  const root = project({ 'a.txt': 'one\ntwo\nthree\n' });
  const { pointers, counts } = checkPointers({ text: 'a.txt:2 · `two` · the second line', root, changed: null });
  assert.equal(pointers[0].status, 'ok');
  assert.equal(pointers[0].foundAt, undefined);
  assert.deepEqual([counts.total, counts.ok], [1, 1]);
});

test('ok: both sides whitespace-normalised, and the line need only contain the fragment', () => {
  const root = project({ 'a.txt': 'x\n   const   finish\t= (text,  isError) => {\n' });
  const p = checkPointers({ text: 'a.txt:2 · `const finish = (text, isError` · c', root, changed: null }).pointers[0];
  assert.equal(p.status, 'ok');
});

test('moved: the nearest other line carrying the fragment, ties to the lower line', () => {
  const root = project({ 'a.txt': 'hit\nx\nx\nx\nhit\n' });
  const tie = checkPointers({ text: 'a.txt:3 · `hit` · c', root, changed: null }).pointers[0];
  assert.equal(tie.status, 'moved');
  assert.equal(tie.foundAt, 1, 'equally far from 1 and 5 → the lower line');
  const near = checkPointers({ text: 'a.txt:4 · `hit` · c', root, changed: null }).pointers[0];
  assert.deepEqual([near.status, near.foundAt], ['moved', 5]);
});

test('mismatch: the fragment is nowhere in the file', () => {
  const root = project({ 'a.txt': 'one\ntwo\n' });
  const p = checkPointers({ text: 'a.txt:1 · `nowhere at all` · c', root, changed: null }).pointers[0];
  assert.equal(p.status, 'mismatch');
});

test('a line number past the end of the file: moved when the fragment is elsewhere, mismatch when nowhere', () => {
  const root = project({ 'a.txt': 'one\ntwo\n' });
  const moved = checkPointers({ text: 'a.txt:99 · `two` · c', root, changed: null }).pointers[0];
  assert.deepEqual([moved.status, moved.foundAt], ['moved', 2]);
  const gone = checkPointers({ text: 'a.txt:99 · `nowhere` · c', root, changed: null }).pointers[0];
  assert.equal(gone.status, 'mismatch');
});

test('missing: no such file, and no such directory either', () => {
  const root = project({ 'a.txt': 'one\n' });
  const { pointers } = checkPointers({ text: 'gone.txt:1 · `one` · c\nno/such/dir/b.txt:1 · `one` · c', root, changed: null });
  assert.deepEqual(pointers.map((p) => p.status), ['missing', 'missing']);
});

test('outside: a ../ escape, an absolute path, a symlink, a directory', () => {
  const base = tmp();
  const root = join(base, 'proj');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(base, 'outside.txt'), 'secret\n');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  symlinkSync(join(root, 'a.txt'), join(root, 'link.txt'));
  const text = [
    '../outside.txt:1 · `secret` · c',
    '/etc/hosts:1 · `localhost` · c',
    'link.txt:1 · `one` · c',
    'sub:1 · `one` · c',
  ].join('\n');
  const { pointers, counts } = checkPointers({ text, root, changed: null });
  assert.deepEqual(pointers.map((p) => p.status), ['outside', 'outside', 'outside', 'outside']);
  assert.equal(counts.outside, 4);
});

test('outside: a parent component that is a symlink leading out of root — one inside it is fine', () => {
  const elsewhere = tmp('omelette-check-elsewhere-');
  writeFileSync(join(elsewhere, 'secret.txt'), 'stolen\n');
  const root = project({ 'real/c.txt': 'kept\n' });
  symlinkSync(elsewhere, join(root, 'out'));
  symlinkSync(join(root, 'real'), join(root, 'alias'));
  const { pointers } = checkPointers({
    text: 'out/secret.txt:1 · `stolen` · c\nalias/c.txt:1 · `kept` · c',
    root,
    changed: null,
  });
  assert.deepEqual(pointers.map((p) => p.status), ['outside', 'ok']);
});

test('too-large: over 2 MiB is refused unread, exactly 2 MiB is read', () => {
  assert.equal(MAX_TARGET_BYTES, 2 * 1024 * 1024);
  const root = project({});
  writeFileSync(join(root, 'over.txt'), Buffer.alloc(MAX_TARGET_BYTES + 1, 0x61));
  writeFileSync(join(root, 'exact.txt'), Buffer.alloc(MAX_TARGET_BYTES, 0x61));
  const { pointers } = checkPointers({ text: 'over.txt:1 · `aaa` · c\nexact.txt:1 · `aaa` · c', root, changed: null });
  assert.deepEqual(pointers.map((p) => p.status), ['too-large', 'ok']);
});

test('stale: an ok pointer whose file changed since the commit — and only an ok one', () => {
  const root = project({ 'a.txt': 'one\ntwo\n', 'b.txt': 'alpha\n' });
  const text = [
    'a.txt:1 · `one` · c',
    './a.txt:2 · `two` · c',
    'b.txt:1 · `alpha` · c',
    'a.txt:1 · `two` · c',
  ].join('\n');
  const { pointers, counts } = checkPointers({ text, root, changed: new Set(['a.txt']) });
  assert.deepEqual(pointers.map((p) => p.status), ['stale', 'stale', 'ok', 'moved'], './a.txt is the same path to git');
  assert.deepEqual([counts.stale, counts.ok, counts.moved], [2, 1, 1]);
});

// ─── §4 staleness: changedSince ─────────────────────────────────────────────

const GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const GIT_SKIP = GIT ? false : 'git is not on PATH — the staleness tests need a real repository';
const GIT_ID = ['-c', 'user.name=omelette test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];

/** A repository with two commits: `first` is the hash, a.txt changed after it. */
function gitRepo() {
  const root = tmp('omelette-check-git-');
  const run = (args) => {
    const r = spawnSync('git', [...GIT_ID, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return (r.stdout || '').trim();
  };
  run(['init', '-q']);
  writeFileSync(join(root, 'a.txt'), 'hello world\n');
  writeFileSync(join(root, 'b.txt'), 'alpha\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'first']);
  const first = run(['rev-parse', 'HEAD']);
  writeFileSync(join(root, 'a.txt'), 'hello world\nand a second line\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'second']);
  return { root, first };
}

test('changedSince: the files a commit range touched', { skip: GIT_SKIP }, () => {
  const { root, first } = gitRepo();
  const r = changedSince({ hash: first, root });
  assert.ok(r.changed instanceof Set, r.reason);
  assert.deepEqual([...r.changed].sort(), ['a.txt']);
});

test('changedSince: an unknown commit, a directory that is no repository, a hash that is not one', { skip: GIT_SKIP }, () => {
  const { root } = gitRepo();
  assert.deepEqual(changedSince({ hash: 'deadbee', root }), { reason: 'unknown commit deadbee' });
  assert.deepEqual(changedSince({ hash: 'deadbee', root: tmp() }), { reason: 'not a git repository' });
  assert.deepEqual(changedSince({ hash: '--output=x', root }), { reason: 'invalid commit' });
  assert.deepEqual(changedSince({ hash: 'HEAD', root }), { reason: 'invalid commit' });
  assert.equal(existsSync(join(root, 'x')), false, 'nothing that is not a hash ever reached git');
});

test('changedSince: git missing from PATH is a reason, not a crash', () => {
  const saved = process.env.PATH;
  process.env.PATH = join(tmp(), 'no-binaries-here');
  try {
    assert.deepEqual(changedSince({ hash: 'abcdef1', root: ROOT }), { reason: 'git not found' });
  } finally {
    process.env.PATH = saved;
  }
});

// ─── §4 the command ─────────────────────────────────────────────────────────

test('check: every pointer ok → exit 0 and nothing on stdout but the summary', () => {
  const root = project({
    'a.txt': 'one\ntwo\nthree\n',
    'sub/b.txt': 'alpha\nbeta\n',
    'report.md': [
      '## FINDINGS',
      '',
      'Prose about a.txt:1 that is not a pointer line.',
      '- `a.txt:2` · `two` · the second line',
      'sub/b.txt:1 · `alpha` · the first line',
      '',
    ].join('\n'),
  });
  const r = cli(['check', 'report.md'], { cwd: root });
  assert.equal(r.err, '');
  assert.equal(r.code, 0);
  assert.equal(r.out, `${summary(2, { ok: 2 })}\n`);
});

test('check: one line per pointer that is not ok, then the summary, exit 1', () => {
  const root = project({
    'a.txt': 'one\ntwo\n',
    'report.md': [
      'a.txt:1 · `one` · ok',
      'a.txt:1 · `two` · moved',
      'a.txt:1 · `neither` · mismatch',
      'gone.txt:3 · `nope` · missing',
      '../escape.txt:1 · `nope` · outside',
      '',
    ].join('\n'),
  });
  const r = cli(['check', 'report.md'], { cwd: root });
  assert.equal(r.code, 1);
  assert.equal(r.out, [
    'moved  a.txt:1  two  → found at 2',
    'mismatch  a.txt:1  neither',
    'missing  gone.txt:3  nope',
    'outside  ../escape.txt:1  nope',
    summary(5, { ok: 1, moved: 1, mismatch: 1, missing: 1, outside: 1 }),
    '',
  ].join('\n'));
  assert.equal(r.err, '');
});

test('check: too-large joins the summary only when there is one', () => {
  const root = project({ 'report.md': 'big.txt:1 · `aaa` · c\n' });
  writeFileSync(join(root, 'big.txt'), Buffer.alloc(MAX_TARGET_BYTES + 1, 0x61));
  const r = cli(['check', 'report.md'], { cwd: root });
  assert.equal(r.code, 1);
  assert.equal(r.out, `too-large  big.txt:1  aaa\n${summary(1, { tooLarge: 1 })}\n`);
  assert.ok(!summary(1, { ok: 1 }).includes('too-large'));
});

test('check: --require — zero pointers fails by default, passes at --require 0', () => {
  const root = project({ 'report.md': '# A report with no findings\n\nnone\n' });
  const bare = cli(['check', 'report.md'], { cwd: root });
  assert.equal(bare.code, 1);
  assert.equal(bare.out, `${summary(0)}\ncheck: 0 pointers, at least 1 required\n`);
  const allowed = cli(['check', 'report.md', '--require', '0'], { cwd: root });
  assert.equal(allowed.code, 0);
  assert.equal(allowed.out, `${summary(0)}\n`);
});

test('check: --require counts pointers, not their status', () => {
  const root = project({ 'a.txt': 'one\n', 'report.md': 'a.txt:1 · `one` · c\n' });
  assert.equal(cli(['check', 'report.md', '--require', '1'], { cwd: root }).code, 0);
  const short = cli(['check', 'report.md', '--require', '3'], { cwd: root });
  assert.equal(short.code, 1);
  assert.equal(short.out, `${summary(1, { ok: 1 })}\ncheck: 1 pointers, at least 3 required\n`);
});

test('check: --root moves the project, the checked file stays where it was named', () => {
  const root = project({ 'a.txt': 'one\n' });
  const elsewhere = project({ 'report.md': 'a.txt:1 · `one` · c\n' });
  const r = cli(['check', join(elsewhere, 'report.md'), '--root', root], { cwd: elsewhere });
  assert.equal(r.code, 0);
  assert.equal(r.out, `${summary(1, { ok: 1 })}\n`);
  const wrong = cli(['check', join(elsewhere, 'report.md')], { cwd: elsewhere });
  assert.equal(wrong.code, 1, 'without --root the pointer resolves against cwd and is missing');
  assert.match(wrong.out, /^missing {2}a\.txt:1 {2}one$/m);
});

test('check: usage errors exit 2 with one line on stderr and nothing on stdout', () => {
  const root = project({ 'a.txt': 'one\n', 'report.md': 'a.txt:1 · `one` · c\n', 'sub/x.txt': 'x\n' });
  const cases = [
    [[], /usage: omelette-fleet check/],
    [['--require', '2'], /usage: omelette-fleet check/],
    [['gone.md'], /gone\.md/],
    [['sub'], /sub/],
    [['report.md', '--nope'], /unknown flag: --nope/],
    [['report.md', '--require', 'two'], /--require/],
    [['report.md', '--require', '-1'], /--require/],
    [['report.md', '--root', join(root, 'nowhere')], /--root/],
    [['report.md', '--root', join(root, 'a.txt')], /--root/],
    [['report.md', 'extra.md'], /unexpected argument: extra\.md/],
  ];
  for (const [args, message] of cases) {
    const r = cli(['check', ...args], { cwd: root });
    assert.equal(r.code, 2, `${args.join(' ')} → exit 2, got ${r.code}: ${r.out}${r.err}`);
    assert.equal(r.out, '', `${args.join(' ')} prints nothing on stdout`);
    assert.match(r.err, message);
    assert.equal(r.err.trim().split('\n').length, 1, `${args.join(' ')} says it in one line`);
  }
});

test('check: a checked file over 1 MiB, and more than 2000 pointer lines, are usage errors', () => {
  const root = project({ 'a.txt': 'one\n' });
  writeFileSync(join(root, 'huge.md'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  const huge = cli(['check', 'huge.md'], { cwd: root });
  assert.equal(huge.code, 2);
  assert.match(huge.err, /1 MiB/);
  writeFileSync(join(root, 'many.md'), `${Array(MAX_POINTERS + 1).fill('a.txt:1 · `one` · c').join('\n')}\n`);
  const many = cli(['check', 'many.md'], { cwd: root });
  assert.equal(many.code, 2);
  assert.match(many.err, /2000/);
  assert.equal(many.out, '');
  writeFileSync(join(root, 'plenty.md'), `${Array(MAX_POINTERS).fill('a.txt:1 · `one` · c').join('\n')}\n`);
  const plenty = cli(['check', 'plenty.md'], { cwd: root });
  assert.equal(plenty.code, 0);
  assert.equal(plenty.out, `${summary(MAX_POINTERS, { ok: MAX_POINTERS })}\n`);
});

test('check: --strict turns a stale pointer into a failure', { skip: GIT_SKIP }, () => {
  const { root, first } = gitRepo();
  writeFileSync(join(root, 'map.md'), [
    '# Map — demo',
    `commit: ${first}`,
    '',
    '- `a.txt:1` · `hello world` · unchanged line of a changed file',
    '- `b.txt:1` · `alpha` · untouched since the commit',
    '',
  ].join('\n'));
  const lax = cli(['check', 'map.md'], { cwd: root });
  assert.equal(lax.code, 0);
  assert.equal(lax.out, [
    'stale  a.txt:1  hello world',
    summary(2, { ok: 1, stale: 1 }),
    '',
  ].join('\n'));
  const strict = cli(['check', 'map.md', '--strict'], { cwd: root });
  assert.equal(strict.code, 1);
  assert.equal(strict.out, lax.out, '--strict changes the exit code, not the report');
});

test('check: staleness that git could not answer says so, and only --strict fails on it', { skip: GIT_SKIP }, () => {
  const { root } = gitRepo();
  writeFileSync(join(root, 'map.md'), `commit: deadbee\n\na.txt:1 · \`hello world\` · c\n`);
  const lax = cli(['check', 'map.md'], { cwd: root });
  assert.equal(lax.code, 0);
  assert.equal(lax.out, `staleness: not checked (unknown commit deadbee)\n${summary(1, { ok: 1 })}\n`);
  assert.equal(cli(['check', 'map.md', '--strict'], { cwd: root }).code, 1);

  const plain = project({ 'a.txt': 'hello world\n' });
  writeFileSync(join(plain, 'map.md'), `commit: deadbee\n\na.txt:1 · \`hello world\` · c\n`);
  const noRepo = cli(['check', 'map.md'], { cwd: plain });
  assert.equal(noRepo.code, 0);
  assert.equal(noRepo.out, `staleness: not checked (not a git repository)\n${summary(1, { ok: 1 })}\n`);
  assert.equal(cli(['check', 'map.md', '--strict'], { cwd: plain }).code, 1);
});

test('check: no commit line is not "unchecked" — staleness is simply off, --strict and all', () => {
  const root = project({ 'a.txt': 'one\n', 'map.md': '# Map — no commit line\n\na.txt:1 · `one` · c\n' });
  const r = cli(['check', 'map.md', '--strict'], { cwd: root });
  assert.equal(r.code, 0);
  assert.equal(r.out, `${summary(1, { ok: 1 })}\n`);
});

test('check: a hostile commit: value is never handed to git', () => {
  const root = project({ 'a.txt': 'one\n', 'map.md': 'commit: --output=x\n\na.txt:1 · `one` · c\n' });
  const r = cli(['check', 'map.md', '--strict'], { cwd: root });
  assert.equal(r.code, 0);
  assert.equal(r.out, `${summary(1, { ok: 1 })}\n`, 'no staleness line at all: there is no hash');
  assert.equal(existsSync(join(root, 'x')), false);
});

test('check: the command writes nothing — the project is byte-for-byte what it was', () => {
  const root = project({ 'a.txt': 'one\n', 'report.md': 'a.txt:1 · `one` · c\nb.txt:1 · `x` · c\n' });
  const snapshot = () => readdirSync(root).sort().map((n) => `${n} ${readFileSync(join(root, n), 'utf8')}`);
  const before = snapshot();
  cli(['check', 'report.md'], { cwd: root });
  cli(['check', 'report.md', '--strict', '--require', '0'], { cwd: root });
  assert.deepEqual(snapshot(), before);
});

// ─── the review round: the open flags, the cache budget, the stale lookup ───

test('the target open carries O_NOFOLLOW where the platform defines it — lstat alone leaves a race', () => {
  if (constants.O_NONBLOCK) assert.equal(TARGET_OPEN_FLAGS & constants.O_NONBLOCK, constants.O_NONBLOCK);
  if (!constants.O_NOFOLLOW) return; // where the platform has no such flag it folds to 0, by design
  assert.equal(TARGET_OPEN_FLAGS & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
  const root = project({ 'a.txt': 'one\n' });
  symlinkSync(join(root, 'a.txt'), join(root, 'link.txt'));
  let code = null;
  try { closeSync(openSync(join(root, 'link.txt'), TARGET_OPEN_FLAGS)); } catch (e) { code = e.code; }
  assert.match(String(code), /^(ELOOP|EMLINK)$/, 'a symlink swapped in is refused at the open itself');
  const p = checkPointers({ text: 'link.txt:1 · `one` · c', root, changed: null }).pointers[0];
  assert.equal(p.status, 'outside', 'and the caller sees a status, never the ELOOP');
});

test('the read cache has a byte budget: past it a target is read and judged but not kept', () => {
  assert.equal(MAX_CACHE_BYTES, 32 * 1024 * 1024);
  const root = project({ 'one.txt': 'alpha\nbeta\n', 'two.txt': 'gamma\ndelta\n', 'three.txt': 'epsilon\n' });
  const text = [
    'one.txt:1 · `alpha` · ok',
    'two.txt:2 · `delta` · ok',
    'three.txt:1 · `epsilon` · ok',
    'one.txt:2 · `alpha` · moved back to 1',
    'two.txt:1 · `nowhere` · mismatch',
    'three.txt:9 · `epsilon` · past the end, moved',
  ].join('\n');
  const shape = (o) => checkPointers({ text, root, changed: null, ...o }).pointers.map((p) => `${p.status}${p.foundAt ? `@${p.foundAt}` : ''}`);
  const cached = shape({});
  assert.deepEqual(cached, ['ok', 'ok', 'ok', 'moved@1', 'mismatch', 'moved@1']);
  assert.deepEqual(shape({ cacheBytes: 1 }), cached, 'a budget of one byte caches nothing and changes nothing');
  assert.deepEqual(shape({ cacheBytes: 0 }), cached, 'and neither does a budget of none');
});

test('stale is looked up by the resolved location, so sub/../a.txt is git\'s a.txt', () => {
  const root = project({ 'a.txt': 'hello world\n', 'sub/keep.txt': 'x\n' });
  const text = [
    'sub/../a.txt:1 · `hello world` · c',
    './a.txt:1 · `hello world` · c',
    'a.txt:1 · `hello world` · c',
  ].join('\n');
  const { pointers } = checkPointers({ text, root, changed: new Set(['a.txt']) });
  assert.deepEqual(pointers.map((p) => p.status), ['stale', 'stale', 'stale']);
});

test('check: a pointer written sub/../a.txt is stale against the real commit range', { skip: GIT_SKIP }, () => {
  const { root, first } = gitRepo();
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'map.md'), `commit: ${first}\n\n- \`sub/../a.txt:1\` · \`hello world\` · c\n`);
  const r = cli(['check', 'map.md'], { cwd: root });
  assert.equal(r.code, 0);
  assert.equal(r.out, `stale  sub/../a.txt:1  hello world\n${summary(1, { stale: 1 })}\n`);
  assert.equal(cli(['check', 'map.md', '--strict'], { cwd: root }).code, 1);
});

test('the example pointer in docs/ORCHESTRATION.md still points at a real line', () => {
  const md = readFileSync(join(ROOT, 'docs', 'ORCHESTRATION.md'), 'utf8');
  const { pointers, counts } = checkPointers({ text: md, root: ROOT, changed: null });
  assert.ok(counts.total >= 1, 'the section shows at least one pointer line');
  assert.deepEqual(pointers.filter((p) => p.status !== 'ok').map((p) => `${p.path}:${p.lineNo} ${p.status}`), []);
});

test('check: the help lists it next to the other subcommands', () => {
  const dir = tmp();
  const r = cli(['--help'], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.out, /omelette-fleet check\s+<file\.md> \[--strict\] \[--require <n>\] \[--root <dir>\]/);
  const page = cli(['check', '--help'], { cwd: dir });
  assert.equal(page.code, 0);
  assert.match(page.out, /check/);
});
