/**
 * omelette-fleet :: test/check.test.mjs
 * `omelette-fleet check` and core/check.mjs, against
 * docs/superpowers/specs/2026-09-17-1.1.0-design.md — §1 (the pointer-line
 * grammar, with `malformed` and the fragment floor), §4 (statuses, staleness
 * and the boxed git child, exit codes, output, bounds) and the list §6 keeps
 * for this file, review round included.
 *
 * Everything runs on temp directories under os.tmpdir(), removed in after().
 * Nothing spawns a vendor binary; the CLI runs with its own throwaway
 * OMELETTE_HOME so no test can touch the real fleet home. The staleness tests
 * build their own git repository and skip, loudly, where git is not on PATH.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CACHE_BYTES, MAX_POINTERS, MAX_TARGET_BYTES, TARGET_OPEN_FLAGS,
  changedSince, checkPointers, gitChildEnv, parseCommit, parsePointers, readBoundedFile,
} from '../core/check.mjs';

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

const summary = (n, { ok = 0, moved = 0, mismatch = 0, missing = 0, outside = 0, stale = 0, tooLarge = 0, weak = 0, malformed = 0 } = {}) =>
  `check: ${n} pointers · ${ok} ok · ${moved} moved · ${mismatch} mismatch · ${missing} missing · ${outside} outside · ${stale} stale`
  + (tooLarge ? ` · ${tooLarge} too-large` : '')
  + (weak ? ` · ${weak} weak` : '')
  + (malformed ? ` · ${malformed} malformed` : '');

const statuses = (o) => checkPointers({ changed: null, ...o }).pointers.map((p) => p.status);

/** Exactly `bytes` bytes, padding first and `line` as the second line of the file. */
function padded(bytes, line) {
  const pad = bytes - Buffer.byteLength(line);
  assert.ok(pad > 1, 'fixture sanity: room to pad');
  return Buffer.concat([Buffer.alloc(pad - 1, 0x61), Buffer.from('\n'), Buffer.from(line)]);
}

// ─── §1 the grammar ─────────────────────────────────────────────────────────

test('parsePointers: every bullet, backticks optional, leading zeros, the claim required', () => {
  const text = [
    '# Map — demo',                                                            // 1
    '',                                                                        // 2
    '- `core/unit.mjs:435` · `const finish = (text, isError` · it spools',      // 3
    '* core/unit.mjs:12 · `export function createUnitRuntime` · claim',         // 4
    '+ core/unit.mjs:13 · `export function resolveBin` · claim',                // 5
    '1. core/unit.mjs:14 · `the ordered bullet` · claim',                       // 6
    '2) core/unit.mjs:15 · `the other ordered bullet` · claim',                 // 7
    '  bin/omelette-fleet.mjs:7 · `NEVER SHELLS OUT` · the header says so',     // 8
    'core/unit.mjs:0042 · `leading zeros are tolerated` · claim',               // 9
    'Prose about core/unit.mjs:435 and what it does.',                          // 10
    'A line with a · middle dot and no pointer at all.',                        // 11
  ].join('\n');
  assert.deepEqual(parsePointers(text), [
    { line: 3, path: 'core/unit.mjs', lineNo: 435, fragment: 'const finish = (text, isError' },
    { line: 4, path: 'core/unit.mjs', lineNo: 12, fragment: 'export function createUnitRuntime' },
    { line: 5, path: 'core/unit.mjs', lineNo: 13, fragment: 'export function resolveBin' },
    { line: 6, path: 'core/unit.mjs', lineNo: 14, fragment: 'the ordered bullet' },
    { line: 7, path: 'core/unit.mjs', lineNo: 15, fragment: 'the other ordered bullet' },
    { line: 8, path: 'bin/omelette-fleet.mjs', lineNo: 7, fragment: 'NEVER SHELLS OUT' },
    { line: 9, path: 'core/unit.mjs', lineNo: 42, fragment: 'leading zeros are tolerated' },
  ]);
});

test('parsePointers: a line that opens like a pointer and does not parse is malformed, not prose', () => {
  const near = [
    'file.js:10-20 · `a range is not one line` · claim',
    'C:/x.js:3 · `a colon in the path` · claim',
    'a.txt:0 · `zero is not a line number` · claim',
    'a.txt:1 · `no claim after the fragment`',
    'a.txt:1 · `   ` · a fragment of whitespace',
    'a.txt:1 · no backticks round the fragment · claim',
    'a.txt:1 · `a fragment with a ` backtick inside` · claim',
    '`a.txt:1 · `half a backtick pair` · claim',
    'a.txt:1 - `the wrong separator` · claim',
  ];
  const got = parsePointers(near.join('\n'));
  assert.equal(got.length, near.length, `every near-miss is kept: ${JSON.stringify(got)}`);
  for (const [i, p] of got.entries()) {
    assert.equal(p.malformed, true, near[i]);
    assert.equal(p.line, i + 1);
    assert.equal(p.raw, near[i]);
    assert.equal(p.path, undefined, 'a malformed line has no path to look up');
  }
});

test('parsePointers: an absolute path parses — it is outside, not malformed', () => {
  assert.deepEqual(parsePointers('/abs/path.js:3 · `an absolute path parses` · claim'), [
    { line: 1, path: '/abs/path.js', lineNo: 3, fragment: 'an absolute path parses' },
  ]);
});

test('parsePointers: at most 2000 lines, malformed ones counted in', () => {
  const good = 'a.txt:1 · `a fragment long enough` · claim';
  const bad = 'a.txt:1 · no backticks · claim';
  assert.equal(MAX_POINTERS, 2000);
  assert.equal(parsePointers(Array(MAX_POINTERS).fill(good).join('\n')).length, MAX_POINTERS);
  const mixed = Array(MAX_POINTERS / 2).fill(`${good}\n${bad}`).join('\n');
  assert.equal(parsePointers(mixed).length, MAX_POINTERS);
  assert.throws(() => parsePointers(`${mixed}\n${bad}`), /2000/);
  assert.throws(() => parsePointers(Array(MAX_POINTERS + 1).fill(good).join('\n')), /2000/);
});

test('parseCommit: no line is undefined, an unusable value is null, a hash is the hash', () => {
  assert.equal(parseCommit('# Map — demo\ncommit: 3dd368d\n'), '3dd368d');
  assert.equal(parseCommit('commit: `3dd368dabc1234567890abcdef1234567890abcd`\n'), '3dd368dabc1234567890abcdef1234567890abcd');
  assert.equal(parseCommit('nothing about a commit here\n'), undefined, 'no commit: line at all');
  assert.equal(parseCommit(`${'filler\n'.repeat(20)}commit: 3dd368d\n`), undefined, 'line 21 is too late');
  assert.equal(parseCommit('commit: --output=x\n'), null, 'a flag is unusable, never an argument');
  assert.equal(parseCommit('commit: HEAD~1\n'), null);
  assert.equal(parseCommit('commit: 3dd368d (the release base)\n'), null, 'a hash with a trailing note is unusable');
  assert.equal(parseCommit('commit: 3dd368\n'), null, 'six hex is shorter than the grammar');
  assert.equal(parseCommit(`commit: ${'a'.repeat(41)}\n`), null, 'forty-one hex is longer');
  assert.equal(parseCommit('commit:\n'), null, 'a commit: line with nothing on it is unusable');
});

// ─── §4 statuses ────────────────────────────────────────────────────────────

test('ok: the fragment is on that line', () => {
  const root = project({ 'a.txt': 'first line here\nthe second line\nthird line here\n' });
  const { pointers, counts } = checkPointers({ text: 'a.txt:2 · `the second line` · c', root, changed: null });
  assert.equal(pointers[0].status, 'ok');
  assert.equal(pointers[0].foundAt, undefined);
  assert.deepEqual([counts.total, counts.ok, counts.distinct], [1, 1, 1]);
});

test('ok: both sides whitespace-normalised, and the line need only contain the fragment', () => {
  const root = project({ 'a.txt': 'x\n   const   finish\t= (text,  isError) => {\n' });
  assert.deepEqual(statuses({ text: 'a.txt:2 · `const finish = (text, isError` · c', root }), ['ok']);
});

test('moved: the nearest line carrying the fragment, ties to the smaller line number', () => {
  const root = project({ 'a.txt': 'the hidden line\nxx\nxx\nxx\nthe hidden line\n' });
  const tie = checkPointers({ text: 'a.txt:3 · `the hidden line` · c', root, changed: null }).pointers[0];
  assert.deepEqual([tie.status, tie.foundAt], ['moved', 1], 'equally far from 1 and 5 → the smaller');
  const near = checkPointers({ text: 'a.txt:4 · `the hidden line` · c', root, changed: null }).pointers[0];
  assert.deepEqual([near.status, near.foundAt], ['moved', 5]);
});

test('mismatch: the fragment is nowhere in the file', () => {
  const root = project({ 'a.txt': 'first line here\nthe second line\n' });
  assert.deepEqual(statuses({ text: 'a.txt:1 · `nowhere in this file` · c', root }), ['mismatch']);
});

test('a line number past the end: moved when the fragment is elsewhere, mismatch when nowhere', () => {
  const root = project({ 'a.txt': 'first line here\nthe second line\n' });
  const moved = checkPointers({ text: 'a.txt:99 · `the second line` · c', root, changed: null }).pointers[0];
  assert.deepEqual([moved.status, moved.foundAt], ['moved', 2]);
  assert.deepEqual(statuses({ text: 'a.txt:99 · `nowhere in this file` · c', root }), ['mismatch']);
});

test('missing: no such file, and no such directory either', () => {
  const root = project({ 'a.txt': 'first line here\n' });
  assert.deepEqual(
    statuses({ text: 'gone.txt:1 · `first line here` · c\nno/such/dir/b.txt:1 · `first line here` · c', root }),
    ['missing', 'missing'],
  );
});

test('outside: a ../ escape, an absolute path, a symlink, a directory', () => {
  const base = tmp();
  const root = join(base, 'proj');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(base, 'outside.txt'), 'the secret line\n');
  writeFileSync(join(root, 'a.txt'), 'first line here\n');
  symlinkSync(join(root, 'a.txt'), join(root, 'link.txt'));
  const text = [
    '../outside.txt:1 · `the secret line` · c',
    '/etc/hosts:1 · `the localhost line` · c',
    'link.txt:1 · `first line here` · c',
    'sub:1 · `first line here` · c',
  ].join('\n');
  const { pointers, counts } = checkPointers({ text, root, changed: null });
  assert.deepEqual(pointers.map((p) => p.status), ['outside', 'outside', 'outside', 'outside']);
  assert.equal(counts.outside, 4);
});

test('outside: a parent component that is a symlink leading out of root — one inside it is fine', () => {
  const elsewhere = tmp('omelette-check-elsewhere-');
  writeFileSync(join(elsewhere, 'secret.txt'), 'the stolen line\n');
  const root = project({ 'real/c.txt': 'the kept line here\n' });
  symlinkSync(elsewhere, join(root, 'out'));
  symlinkSync(join(root, 'real'), join(root, 'alias'));
  assert.deepEqual(
    statuses({ text: 'out/secret.txt:1 · `the stolen line` · c\nalias/c.txt:1 · `the kept line here` · c', root }),
    ['outside', 'ok'],
  );
});

test('containment is by path.relative, so a root of / resolves its own children', () => {
  const root = project({ 'a.txt': 'the only line here\n' });
  const fromSlash = relative(sep, realpathSync(join(root, 'a.txt')));
  if (/[\s:`]/.test(fromSlash)) return; // a temp path the pointer grammar cannot spell
  assert.deepEqual(statuses({ text: `${fromSlash}:1 · \`the only line here\` · c`, root: sep }), ['ok']);
});

test('too-large: over 2 MiB is refused unread, exactly 2 MiB is read', () => {
  assert.equal(MAX_TARGET_BYTES, 2 * 1024 * 1024);
  const root = project({});
  const line = `${'the long line here '.repeat(4)}\n`;
  writeFileSync(join(root, 'over.txt'), padded(MAX_TARGET_BYTES + 1, line));
  writeFileSync(join(root, 'exact.txt'), padded(MAX_TARGET_BYTES, line));
  assert.deepEqual(
    statuses({ text: 'over.txt:2 · `the long line here` · c\nexact.txt:2 · `the long line here` · c', root }),
    ['too-large', 'ok'],
  );
});

test('weak: a fragment under eight normalised characters, or without three alphanumerics, is never looked up', () => {
  const root = project({ 'a.txt': 'x = 1;\nthe second line\n' });
  const text = [
    'a.txt:1 · `x = 1;` · six characters is too few',
    'a.txt:2 · `-- === -- ==` · long enough, but no alphanumeric run of three',
    'gone.txt:1 · `x = 1;` · weak is decided before the file is opened',
    'a.txt:2 · `the second line` · this one is real evidence',
  ].join('\n');
  const { pointers, counts } = checkPointers({ text, root, changed: null });
  assert.deepEqual(pointers.map((p) => p.status), ['weak', 'weak', 'weak', 'ok']);
  assert.equal(counts.weak, 3);
});

test('stale: an ok pointer whose file changed — by resolved location, not by spelling', () => {
  const root = project({ 'a.txt': 'first line here\nthe second line\n', 'b.txt': 'alpha beta gamma\n', 'sub/keep.txt': 'x\n' });
  const text = [
    'a.txt:1 · `first line here` · c',
    './a.txt:2 · `the second line` · c',
    'sub/../a.txt:1 · `first line here` · c',
    'b.txt:1 · `alpha beta gamma` · c',
    'a.txt:1 · `the second line` · c',
  ].join('\n');
  const { pointers, counts } = checkPointers({ text, root, changed: new Set(['a.txt']) });
  assert.deepEqual(pointers.map((p) => p.status), ['stale', 'stale', 'stale', 'ok', 'moved']);
  assert.deepEqual([counts.stale, counts.ok, counts.moved], [3, 1, 1]);
});

test('the pointer objects keep their documented shape', () => {
  const root = project({ 'a.txt': 'first line here\nthe second line\n' });
  const { pointers } = checkPointers({ text: 'a.txt:1 · `the second line` · c\nb.txt:1 · no backticks · c', root, changed: null });
  assert.deepEqual(Object.keys(pointers[0]).sort(), ['foundAt', 'fragment', 'line', 'lineNo', 'path', 'status']);
  assert.deepEqual(Object.keys(pointers[1]).sort(), ['line', 'malformed', 'raw', 'status']);
});

// ─── §4 the cache, the open flags, the worst case ───────────────────────────

test('the target open carries O_NOFOLLOW where the platform defines it — lstat alone leaves a race', () => {
  if (constants.O_NONBLOCK) assert.equal(TARGET_OPEN_FLAGS & constants.O_NONBLOCK, constants.O_NONBLOCK);
  if (!constants.O_NOFOLLOW) return; // where the platform has no such flag it folds to 0, by design
  assert.equal(TARGET_OPEN_FLAGS & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
  const root = project({ 'a.txt': 'first line here\n' });
  symlinkSync(join(root, 'a.txt'), join(root, 'link.txt'));
  let code = null;
  try { closeSync(openSync(join(root, 'link.txt'), TARGET_OPEN_FLAGS)); } catch (e) { code = e.code; }
  assert.match(String(code), /^(ELOOP|EMLINK)$/, 'a symlink swapped in is refused at the open itself');
  assert.equal(readBoundedFile(join(root, 'link.txt'), 1024), null, 'and the bounded reader says no, it does not throw');
  assert.deepEqual(statuses({ text: 'link.txt:1 · `first line here` · c', root }), ['outside']);
});

test('the read cache has a byte budget: past it a target is read and judged but not kept', () => {
  assert.equal(MAX_CACHE_BYTES, 32 * 1024 * 1024);
  const root = project({
    'one.txt': 'alpha beta gamma\nbeta gamma delta\n',
    'two.txt': 'gamma delta epsilon\ndelta epsilon zeta\n',
    'three.txt': 'epsilon zeta eta\n',
  });
  const text = [
    'one.txt:1 · `alpha beta gamma` · ok',
    'two.txt:2 · `delta epsilon zeta` · ok',
    'three.txt:1 · `epsilon zeta eta` · ok',
    'one.txt:2 · `alpha beta gamma` · moved back to 1',
    'two.txt:1 · `nowhere in this file` · mismatch',
    'three.txt:9 · `epsilon zeta eta` · past the end, moved',
  ].join('\n');
  const shape = (o) => checkPointers({ text, root, changed: null, ...o }).pointers.map((p) => `${p.status}${p.foundAt ? `@${p.foundAt}` : ''}`);
  const cached = shape({});
  assert.deepEqual(cached, ['ok', 'ok', 'ok', 'moved@1', 'mismatch', 'moved@1']);
  assert.deepEqual(shape({ cacheBytes: 1 }), cached, 'a budget of one byte caches nothing and changes nothing');
  assert.deepEqual(shape({ cacheBytes: 0 }), cached, 'and neither does a budget of none');
});

test('the worst case is bounded: 2000 mismatching pointers into a 2 MiB target', () => {
  const root = project({});
  const line = 'the quick brown fox jumps over the lazy dog and keeps on running\n';
  writeFileSync(join(root, 'big.txt'), line.repeat(Math.floor((2 * 1024 * 1024) / line.length)));
  const text = Array.from({ length: MAX_POINTERS }, (_, i) => `big.txt:${i + 1} · \`quartz vex ${String(i).padStart(5, '0')}\` · claim`).join('\n');
  const started = Date.now();
  const { counts } = checkPointers({ text, root, changed: null });
  const spent = Date.now() - started;
  assert.equal(counts.mismatch, MAX_POINTERS);
  // The scan-per-pointer version took 28 s on a laptop; this one takes under two.
  // The bound sits between them with room for a CI runner several times slower:
  // it is there to catch the quadratic shape coming back, not to race the clock.
  assert.ok(spent < 15000, `2000 pointers into 2 MiB took ${spent} ms`);
});

// ─── §4 staleness: the git child ────────────────────────────────────────────

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
  writeFileSync(join(root, 'a.txt'), 'hello world line\n');
  writeFileSync(join(root, 'b.txt'), 'alpha beta gamma\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'first']);
  const first = run(['rev-parse', 'HEAD']);
  writeFileSync(join(root, 'a.txt'), 'hello world line\nand a second line\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'second']);
  return { root, first, run };
}

test('gitChildEnv: built, not inherited — nothing of the parent\'s git state survives', () => {
  const env = gitChildEnv({
    PATH: '/usr/bin', HOME: '/home/someone', LANG: 'en_GB.UTF-8', LC_ALL: 'C',
    GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', GIT_TRACE: '1',
    GIT_TRACE2_EVENT: '/tmp/trace.json', GIT_EXTERNAL_DIFF: '/tmp/evil.sh', GIT_CONFIG_GLOBAL: '/tmp/theirs',
    NODE_OPTIONS: '--require /tmp/evil.js',
  });
  for (const gone of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_TRACE', 'GIT_TRACE2_EVENT', 'GIT_EXTERNAL_DIFF', 'NODE_OPTIONS']) {
    assert.equal(env[gone], undefined, `${gone} never reaches the child`);
  }
  assert.deepEqual(
    { PATH: env.PATH, HOME: env.HOME, LANG: env.LANG, LC_ALL: env.LC_ALL },
    { PATH: '/usr/bin', HOME: '/home/someone', LANG: 'en_GB.UTF-8', LC_ALL: 'C' },
  );
  assert.deepEqual(
    { ...env, PATH: undefined, HOME: undefined, LANG: undefined, LC_ALL: undefined },
    {
      PATH: undefined, HOME: undefined, LANG: undefined, LC_ALL: undefined,
      GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
    },
  );
  assert.equal(gitChildEnv({}).LANG, undefined, 'a variable the parent does not set is not invented');
});

test('changedSince: the commit against the WORKING TREE, so an uncommitted edit counts', { skip: GIT_SKIP }, () => {
  const { root, first } = gitRepo();
  assert.deepEqual([...changedSince({ hash: first, root }).changed].sort(), ['a.txt']);
  writeFileSync(join(root, 'b.txt'), 'alpha beta gamma\nedited, never committed\n');
  assert.deepEqual([...changedSince({ hash: first, root }).changed].sort(), ['a.txt', 'b.txt']);
});

test('changedSince: an unknown commit, a directory that is no repository, a value that is no hash', { skip: GIT_SKIP }, () => {
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
    'a.txt': 'first line here\nthe second line\nthird line here\n',
    'sub/b.txt': 'alpha beta gamma\nbeta gamma delta\n',
    'report.md': [
      '## FINDINGS',
      '',
      'Prose about a.txt:1 that is not a pointer line.',
      '- `a.txt:2` · `the second line` · the second line',
      'sub/b.txt:1 · `alpha beta gamma` · the first line',
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
    'a.txt': 'first line here\nthe second line\n',
    'report.md': [
      'a.txt:1 · `first line here` · ok',
      'a.txt:1 · `the second line` · moved',
      'a.txt:1 · `nowhere in this file` · mismatch',
      'gone.txt:3 · `first line here` · missing',
      '../escape.txt:1 · `first line here` · outside',
      'a.txt:1 · `short` · weak',
      'a.txt:1 · no backticks here · malformed',
      '',
    ].join('\n'),
  });
  const r = cli(['check', 'report.md'], { cwd: root });
  assert.equal(r.code, 1);
  assert.equal(r.out, [
    'moved  a.txt:1  the second line  → found at 2',
    'mismatch  a.txt:1  nowhere in this file',
    'missing  gone.txt:3  first line here',
    'outside  ../escape.txt:1  first line here',
    'weak  a.txt:1  short',
    'malformed  line 7  a.txt:1 · no backticks here · malformed',
    summary(7, { ok: 1, moved: 1, mismatch: 1, missing: 1, outside: 1, weak: 1, malformed: 1 }),
    '',
  ].join('\n'));
  assert.equal(r.err, '');
});

test('check: a malformed line is printed trimmed and cut at 120 characters', () => {
  const long = `a.txt:1 · no backticks and then ${'x'.repeat(200)}`;
  const root = project({ 'a.txt': 'first line here\n', 'report.md': `    ${long}\n` });
  const r = cli(['check', 'report.md'], { cwd: root });
  assert.equal(r.code, 1);
  assert.equal(r.out.split('\n')[0], `malformed  line 1  ${long.slice(0, 120)}`);
});

test('check: too-large, weak and malformed join the summary only when there is one', () => {
  const root = project({ 'report.md': 'big.txt:1 · `the long line here` · c\n' });
  writeFileSync(join(root, 'big.txt'), padded(MAX_TARGET_BYTES + 1, `${'the long line here '.repeat(4)}\n`));
  const r = cli(['check', 'report.md'], { cwd: root });
  assert.equal(r.code, 1);
  assert.equal(r.out, `too-large  big.txt:1  the long line here\n${summary(1, { tooLarge: 1 })}\n`);
  assert.ok(!summary(1, { ok: 1 }).includes('too-large'));
  assert.ok(!summary(1, { ok: 1 }).includes('weak'));
  assert.ok(!summary(1, { ok: 1 }).includes('malformed'));
});

test('check: --require counts DISTINCT path:line pairs', () => {
  const root = project({
    'a.txt': 'first line here\nthe second line\n',
    'report.md': [
      'a.txt:1 · `first line here` · one pair',
      './a.txt:1 · `first line here` · the same pair, spelled otherwise',
      'a.txt:2 · `the second line` · a second pair',
      'a.txt:1 · no backticks · malformed lines count toward none of it',
      '',
    ].join('\n'),
  });
  assert.equal(cli(['check', 'report.md', '--require', '2'], { cwd: root }).code, 1, 'malformed keeps it failing');
  const short = cli(['check', 'report.md', '--require', '4'], { cwd: root });
  assert.equal(short.code, 1);
  assert.equal(short.out.split('\n').at(-2), 'check: 2 distinct pointers, at least 4 required');
});

test('check: --require — zero pointers fails by default, passes at --require 0', () => {
  const root = project({ 'report.md': '# A report with no findings\n\nnone\n' });
  const bare = cli(['check', 'report.md'], { cwd: root });
  assert.equal(bare.code, 1);
  assert.equal(bare.out, `${summary(0)}\ncheck: 0 distinct pointers, at least 1 required\n`);
  const allowed = cli(['check', 'report.md', '--require', '0'], { cwd: root });
  assert.equal(allowed.code, 0);
  assert.equal(allowed.out, `${summary(0)}\n`);
});

test('check: --root moves the project, the checked file stays where it was named', () => {
  const root = project({ 'a.txt': 'first line here\n' });
  const elsewhere = project({ 'report.md': 'a.txt:1 · `first line here` · c\n' });
  const r = cli(['check', join(elsewhere, 'report.md'), '--root', root], { cwd: elsewhere });
  assert.equal(r.code, 0);
  assert.equal(r.out, `${summary(1, { ok: 1 })}\n`);
  const wrong = cli(['check', join(elsewhere, 'report.md')], { cwd: elsewhere });
  assert.equal(wrong.code, 1, 'without --root the pointer resolves against cwd and is missing');
  assert.match(wrong.out, /^missing {2}a\.txt:1 {2}first line here$/m);
});

test('check: usage errors exit 2 with one line on stderr and nothing on stdout', () => {
  const root = project({ 'a.txt': 'first line here\n', 'report.md': 'a.txt:1 · `first line here` · c\n', 'sub/x.txt': 'x\n' });
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

test('check: a usage error wins over pointer failures — no report at all', () => {
  const root = project({
    'a.txt': 'first line here\n',
    'report.md': 'gone.txt:1 · `first line here` · a failing pointer\n',
  });
  const r = cli(['check', 'report.md', '--require', 'many'], { cwd: root });
  assert.equal(r.code, 2);
  assert.equal(r.out, '', 'the failing pointer is never reported');
  assert.match(r.err, /--require/);
});

test('check: a checked file over 1 MiB, and more than 2000 pointer lines, are usage errors', () => {
  const root = project({ 'a.txt': 'first line here\n' });
  const pointer = 'a.txt:1 · `first line here` · c';
  writeFileSync(join(root, 'huge.md'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  const huge = cli(['check', 'huge.md'], { cwd: root });
  assert.equal(huge.code, 2);
  assert.match(huge.err, /1 MiB/);
  writeFileSync(join(root, 'many.md'), `${Array(MAX_POINTERS + 1).fill(pointer).join('\n')}\n`);
  const many = cli(['check', 'many.md'], { cwd: root });
  assert.equal(many.code, 2);
  assert.match(many.err, /2000/);
  assert.equal(many.out, '');
  writeFileSync(join(root, 'plenty.md'), `${Array(MAX_POINTERS).fill(pointer).join('\n')}\n`);
  const plenty = cli(['check', 'plenty.md'], { cwd: root });
  assert.equal(plenty.code, 0);
  assert.equal(plenty.out, `${summary(MAX_POINTERS, { ok: MAX_POINTERS })}\n`);
});

test('check: the checked file is read with the bounded reader — a symlinked report is refused', () => {
  const root = project({ 'a.txt': 'first line here\n', 'real.md': 'a.txt:1 · `first line here` · c\n' });
  symlinkSync(join(root, 'real.md'), join(root, 'link.md'));
  const r = cli(['check', 'link.md'], { cwd: root });
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /link\.md/);
});

test('check: --strict turns a stale pointer into a failure', { skip: GIT_SKIP }, () => {
  const { root, first } = gitRepo();
  writeFileSync(join(root, 'map.md'), [
    '# Map — demo',
    `commit: ${first}`,
    '',
    '- `a.txt:1` · `hello world line` · unchanged line of a changed file',
    '- `b.txt:1` · `alpha beta gamma` · untouched since the commit',
    '',
  ].join('\n'));
  const lax = cli(['check', 'map.md'], { cwd: root });
  assert.equal(lax.code, 0);
  assert.equal(lax.out, ['stale  a.txt:1  hello world line', summary(2, { ok: 1, stale: 1 }), ''].join('\n'));
  const strict = cli(['check', 'map.md', '--strict'], { cwd: root });
  assert.equal(strict.code, 1);
  assert.equal(strict.out, lax.out, '--strict changes the exit code, not the report');
});

test('check: an uncommitted edit makes its pointer stale', { skip: GIT_SKIP }, () => {
  const { root, first } = gitRepo();
  writeFileSync(join(root, 'map.md'), `commit: ${first}\n\n- \`b.txt:1\` · \`alpha beta gamma\` · committed and untouched\n`);
  assert.equal(cli(['check', 'map.md'], { cwd: root }).out, `${summary(1, { ok: 1 })}\n`);
  writeFileSync(join(root, 'b.txt'), 'alpha beta gamma\nedited, never committed\n');
  const r = cli(['check', 'map.md'], { cwd: root });
  assert.equal(r.code, 0);
  assert.equal(r.out, `stale  b.txt:1  alpha beta gamma\n${summary(1, { stale: 1 })}\n`);
  assert.equal(cli(['check', 'map.md', '--strict'], { cwd: root }).code, 1);
});

test('check: a pointer written sub/../a.txt is stale against the real commit range', { skip: GIT_SKIP }, () => {
  const { root, first } = gitRepo();
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'map.md'), `commit: ${first}\n\n- \`sub/../a.txt:1\` · \`hello world line\` · c\n`);
  const r = cli(['check', 'map.md'], { cwd: root });
  assert.equal(r.code, 0);
  assert.equal(r.out, `stale  sub/../a.txt:1  hello world line\n${summary(1, { stale: 1 })}\n`);
  assert.equal(cli(['check', 'map.md', '--strict'], { cwd: root }).code, 1);
});

test('check: staleness that git could not answer says so, and only --strict fails on it', { skip: GIT_SKIP }, () => {
  const { root } = gitRepo();
  writeFileSync(join(root, 'map.md'), 'commit: deadbee\n\na.txt:1 · `hello world line` · c\n');
  const lax = cli(['check', 'map.md'], { cwd: root });
  assert.equal(lax.code, 0);
  assert.equal(lax.out, `staleness: not checked (unknown commit deadbee)\n${summary(1, { ok: 1 })}\n`);
  assert.equal(cli(['check', 'map.md', '--strict'], { cwd: root }).code, 1);

  const plain = project({ 'a.txt': 'hello world line\n' });
  writeFileSync(join(plain, 'map.md'), 'commit: deadbee\n\na.txt:1 · `hello world line` · c\n');
  const noRepo = cli(['check', 'map.md'], { cwd: plain });
  assert.equal(noRepo.code, 0);
  assert.equal(noRepo.out, `staleness: not checked (not a git repository)\n${summary(1, { ok: 1 })}\n`);
  assert.equal(cli(['check', 'map.md', '--strict'], { cwd: plain }).code, 1);
});

test('check: an unusable commit value is announced, fails --strict, and never reaches git', () => {
  const root = project({ 'a.txt': 'first line here\n', 'map.md': 'commit: --output=x\n\na.txt:1 · `first line here` · c\n' });
  const lax = cli(['check', 'map.md'], { cwd: root });
  assert.equal(lax.code, 0);
  assert.equal(lax.out, `staleness: not checked (unusable commit value)\n${summary(1, { ok: 1 })}\n`);
  assert.equal(cli(['check', 'map.md', '--strict'], { cwd: root }).code, 1);
  assert.equal(existsSync(join(root, 'x')), false, 'no flag of ours became an argument of git\'s');
});

test('check: no commit line is not "unchecked" — staleness is simply off, --strict and all', () => {
  const root = project({ 'a.txt': 'first line here\n', 'map.md': '# Map — no commit line\n\na.txt:1 · `first line here` · c\n' });
  const r = cli(['check', 'map.md', '--strict'], { cwd: root });
  assert.equal(r.code, 0);
  assert.equal(r.out, `${summary(1, { ok: 1 })}\n`);
});

test('check: the command writes nothing — the project is byte-for-byte what it was', () => {
  const root = project({ 'a.txt': 'first line here\n', 'report.md': 'a.txt:1 · `first line here` · c\nb.txt:1 · `alpha beta gamma` · c\n' });
  const snapshot = () => readdirSync(root).sort().map((n) => `${n} ${readFileSync(join(root, n), 'utf8')}`);
  const before = snapshot();
  cli(['check', 'report.md'], { cwd: root });
  cli(['check', 'report.md', '--strict', '--require', '0'], { cwd: root });
  assert.deepEqual(snapshot(), before);
});

test('the example pointer in docs/ORCHESTRATION.md still points at a real line', () => {
  const md = readFileSync(join(ROOT, 'docs', 'ORCHESTRATION.md'), 'utf8');
  const { pointers, counts } = checkPointers({ text: md, root: ROOT, changed: null });
  assert.ok(counts.total >= 1, 'the section shows at least one pointer line');
  assert.deepEqual(pointers.filter((p) => p.status !== 'ok').map((p) => `line ${p.line}: ${p.status}`), []);
});

test('check: the help lists it next to the other subcommands, and says what the statuses cost', () => {
  const dir = tmp();
  const r = cli(['--help'], { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(r.out, /omelette-fleet check\s+<file\.md> \[--strict\] \[--require <n>\] \[--root <dir>\]/);
  const page = cli(['check', '--help'], { cwd: dir });
  assert.equal(page.code, 0);
  for (const needle of [/weak/, /malformed/, /--strict/, /exit 2/i, /1 MiB/, /2000/, /2 MiB/, /distinct/i, /stale/]) {
    assert.match(page.out, needle, `the help body names ${needle}`);
  }
  assert.ok(!page.out.includes('Exit 1 on anything but ok'), 'the old, wrong sentence is gone');
});
