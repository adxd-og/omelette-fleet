// scripts/mutants.mjs — what test/mutants.test.mjs leaves open: the report's
// unique-catch rule with two catchers, the timeout path and its stragglers,
// restoration between mutants, the dry-run refusals, the scratch rules, literal
// replacement. Every fixture repository is built under a fresh tmp directory;
// neither this checkout nor the real catalogue is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMutant, main, prepareScratch } from '../scripts/mutants.mjs';

const ENTRIES = ['lib', 'test'];
const LIB = [
  "export const TAG = '$1-$&';",
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  'export function onlyA() {',
  "  return 'A';",
  '}',
  'export function onlyB() {',
  "  return 'B';",
  '}',
  'export function dead() {',
  "  return 'dead';",
  '}',
  'export function hang() {',
  '  return 1;',
  '}',
  'export function later() {',
  "  return 'later';",
  '}',
  '',
].join('\n');
const HEADER = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { spawn } from 'node:child_process';",
  "import { appendFileSync } from 'node:fs';",
  "import { add, onlyA, onlyB, hang, later, TAG } from '../lib/core.mjs';",
  // leaves a pid trail and a straggler child in the process group, when asked to
  'if (process.env.MUT_PIDFILE) {',
  '  appendFileSync(process.env.MUT_PIDFILE, `${process.pid}\\n`);',
  "  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  '  c.unref();',
  '  appendFileSync(process.env.MUT_PIDFILE, `${c.pid}\\n`);',
  '}',
].join('\n');
const A_TEST = `${HEADER}
test('a', () => { assert.equal(add(1, 2), 3); assert.equal(onlyA(), 'A'); assert.equal(hang(), 1); assert.equal(TAG, '$1-$&'); });
test('a, not yet', { todo: true }, () => { assert.equal(later(), 'later'); });
`;
const B_TEST = `${HEADER}
test('b', () => { assert.equal(add(1, 2), 3); assert.equal(onlyB(), 'B'); });
`;

const M = (id, find, replace) => ({ id, file: 'lib/core.mjs', find, replace, breaks: id });
const CAUGHT_BY_BOTH = M('m-both', 'return a + b;', 'return a - b;');
const ONLY_A = M('m-only-a', "return 'A';", "return 'a';");
const ONLY_B = M('m-only-b', "return 'B';", "return 'b';");
const ONLY_A_TOO = M('m-only-a-too', 'return 1;', 'return 2;');
const TODO_ONLY = M('m-todo-only', "return 'later';", "return 'LATER';");
const NONE = M('m-none', "return 'dead';", "return 'DEAD';");
const SYNTAX = M('m-syntax', 'export function dead() {', 'export function dead( {');

const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) };
};

const sandbox = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-mutants-runner-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'lib', 'core.mjs'), LIB);
  writeFileSync(join(root, 'test', 'a.test.mjs'), A_TEST);
  writeFileSync(join(root, 'test', 'b.test.mjs'), B_TEST);
  return { dir, root };
};

const run = async ({ dir, root }, catalogue, args = []) => {
  const cataloguePath = join(dir, 'catalogue.json');
  writeFileSync(cataloguePath, JSON.stringify(catalogue));
  const io = capture();
  const outFile = join(dir, 'report.json');
  const code = await main(['--out', outFile, ...args], { root, cataloguePath, entries: ENTRIES, out: io.out, err: io.err });
  return { code, io, report: existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : null };
};

test('caughtBy lists test files, uniqueCatches leaves out a mutant two files catch, a syntax error is caught by every importer, a failing todo test catches nothing, a mutant never leaks into the next', async (t) => {
  const sb = sandbox(t);
  const { code, io, report } = await run(sb, [ONLY_A, ONLY_A_TOO, CAUGHT_BY_BOTH, SYNTAX, TODO_ONLY, NONE, ONLY_B], ['--files', 'b.test.mjs,a.*.mjs', '--scratch', join(sb.dir, 'scratch')]);
  assert.equal(code, 0, io.lines.err.join('\n'));
  const by = Object.fromEntries(report.mutants.map((m) => [m.id, m.caughtBy]));
  assert.deepEqual(by, {
    'm-only-a': ['test/a.test.mjs'],
    'm-only-a-too': ['test/a.test.mjs'],
    'm-both': ['test/a.test.mjs', 'test/b.test.mjs'],
    'm-syntax': ['test/a.test.mjs', 'test/b.test.mjs'],
    'm-todo-only': [], // node itself does not fail a run for a todo test
    'm-none': [], // would be caught by a file if the earlier mutants had stayed applied in the scratch copy
    'm-only-b': ['test/b.test.mjs'],
  });
  assert.deepEqual(report.uniqueCatches, { 'test/a.test.mjs': ['m-only-a', 'm-only-a-too'], 'test/b.test.mjs': ['m-only-b'] });
  assert.deepEqual(report.uncaught, ['m-todo-only', 'm-none']);
  assert.equal(readFileSync(join(sb.root, 'lib', 'core.mjs'), 'utf8'), LIB, 'the tree under test is untouched');
  assert.equal(readFileSync(join(sb.dir, 'scratch', 'work', 'lib', 'core.mjs'), 'utf8'), LIB, 'the scratch copy is restored');
});

test('--only and --files narrow the run: a mutant two files catch is unique once the other file is not run', async (t) => {
  const sb = sandbox(t);
  const { code, io, report } = await run(sb, [ONLY_A, CAUGHT_BY_BOTH, ONLY_B], ['--only', 'm-both,m-only-b', '--files', 'a.test.mjs']);
  assert.equal(code, 0, io.lines.err.join('\n'));
  assert.equal(report.baseline.files, 1);
  assert.deepEqual(report.mutants.map((m) => [m.id, m.caughtBy]), [['m-both', ['test/a.test.mjs']], ['m-only-b', []]]);
  assert.deepEqual(report.uniqueCatches, { 'test/a.test.mjs': ['m-both'] });
  assert.deepEqual(report.uncaught, ['m-only-b']);
});

test('a mutant that hangs a test is killed at --timeout, counted under caughtByTimeout, leaves no process behind, and the next mutant runs clean', async (t) => {
  const sb = sandbox(t);
  const pidfile = join(sb.dir, 'pids.txt');
  process.env.MUT_PIDFILE = pidfile;
  t.after(() => {
    delete process.env.MUT_PIDFILE;
    if (existsSync(pidfile)) for (const p of readFileSync(pidfile, 'utf8').split('\n').filter(Boolean)) { try { process.kill(Number(p), 'SIGKILL'); } catch { /* gone */ } }
  });
  const hang = M('m-hang', 'return 1;', 'for (;;);');
  // --timeout caps the fixture's own baseline run too, so it must stay far above that run's time under load.
  const { code, io, report } = await run(sb, [hang, ONLY_B], ['--timeout', '15']);
  assert.equal(code, 0, io.lines.err.join('\n'));
  assert.equal(report.timeoutMs, 15000);
  const [h, b] = report.mutants;
  assert.equal(h.id, 'm-hang');
  assert.equal(h.timedOut, true);
  assert.deepEqual(h.caughtByTimeout, ['test/a.test.mjs']);
  assert.deepEqual(h.caughtBy, ['test/a.test.mjs'], 'the passing file is not caught by the timeout');
  assert.ok(h.wallMs >= 5500 && h.wallMs < 20000, `killed at the cap, wallMs ${h.wallMs}`);
  assert.deepEqual([b.id, b.timedOut, b.caughtBy, b.caughtByTimeout], ['m-only-b', false, ['test/b.test.mjs'], []]);
  assert.match(io.lines.out.join('\n'), /1 timed out/);
  const pids = readFileSync(pidfile, 'utf8').split('\n').filter(Boolean).map(Number);
  assert.ok(pids.length >= 6, `each run left a test process and a straggler, saw ${pids.length}`);
  await new Promise((r) => setTimeout(r, 300));
  for (const p of pids) {
    assert.throws(() => process.kill(p, 0), { code: 'ESRCH' }, `pid ${p} is still alive`);
  }
  assert.equal(readFileSync(join(sb.root, 'lib', 'core.mjs'), 'utf8'), LIB);
});

test('a red baseline stops the run before any mutant: exit 1, the failing file named, no mutant in the report', async (t) => {
  const sb = sandbox(t);
  writeFileSync(join(sb.root, 'test', 'b.test.mjs'), `${B_TEST}test('red', () => assert.equal(1, 2));\n`);
  const { code, io, report } = await run(sb, [ONLY_A]);
  assert.equal(code, 1);
  assert.match(io.lines.err.join('\n'), /baseline is not green[\s\S]*test\/b\.test\.mjs/);
  assert.equal(report, null, 'no report is written for a run that never started');
  assert.ok(!io.lines.err.some((l) => /m-only-a/.test(l)), 'no mutant was run');
});

test('--dry-run refuses every malformed entry and names each one, runs nothing and creates no scratch', async (t) => {
  const sb = sandbox(t);
  writeFileSync(join(sb.dir, 'outside.mjs'), 'export const OUT = 1;\n'); // exists, one occurrence, but outside the root
  const catalogue = [
    M('zero', 'no such fragment', 'x'),
    M('twice', 'return', 'ret'),
    { id: 'nofile', file: 'lib/missing.mjs', find: 'a', replace: 'b', breaks: 'x' },
    { id: 'dotdot', file: '../outside.mjs', find: 'OUT = 1', replace: 'OUT = 2', breaks: 'x' },
    { id: 'absolute', file: join(sb.dir, 'outside.mjs'), find: 'OUT = 1', replace: 'OUT = 2', breaks: 'x' },
    M('same', 'return a + b;', 'return a + b;'),
    M('dup', "return 'A';", "return 'a';"),
    M('dup', "return 'B';", "return 'b';"),
    M('ok', "return 'dead';", "return 'DEAD';"),
  ];
  const scratch = join(sb.dir, 'scratch');
  const { code, io } = await run(sb, catalogue, ['--dry-run', '--scratch', scratch]);
  assert.equal(code, 1);
  const err = io.lines.err.join('\n');
  assert.match(err, /zero: the fragment occurs 0 times/);
  assert.match(err, /twice: the fragment occurs \d+ times/);
  assert.match(err, /nofile: .*does not exist/);
  assert.match(err, /dotdot: /);
  assert.match(err, /absolute: /);
  assert.match(err, /same: replace equals find/);
  assert.match(err, /dup: duplicate id/);
  assert.doesNotMatch(err, /\bok:/);
  assert.equal(existsSync(scratch), false);
});

test('--only with an unknown id and --files matching nothing both fail without running anything', async (t) => {
  const sb = sandbox(t);
  const scratch = join(sb.dir, 'scratch');
  const unknown = await run(sb, [ONLY_A], ['--only', 'm-only-a,nope', '--scratch', scratch]);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.io.lines.err.join('\n'), /unknown.*nope/);
  const nofiles = await run(sb, [ONLY_A], ['--files', 'zzz.*.mjs', '--scratch', scratch]);
  assert.notEqual(nofiles.code, 0);
  assert.match(nofiles.io.lines.err.join('\n'), /matches no file/);
  assert.equal(existsSync(scratch), false);
  assert.equal(unknown.report, null);
  assert.equal(nofiles.report, null);
});

test('a --scratch inside the tree under test is refused and the tree is left as it was', async (t) => {
  const sb = sandbox(t);
  const before = readdirSync(sb.root).sort();
  const { code, io } = await run(sb, [ONLY_A], ['--scratch', join(sb.root, 'lib', 'scratch')]);
  assert.equal(code, 1);
  assert.match(io.lines.err.join('\n'), /inside the tree/);
  assert.deepEqual(readdirSync(sb.root).sort(), before);
  assert.deepEqual(readdirSync(join(sb.root, 'lib')), ['core.mjs']);
  const same = await run(sb, [ONLY_A], ['--scratch', sb.root]);
  assert.equal(same.code, 1);
  assert.deepEqual(readdirSync(sb.root).sort(), before);
});

test('a --scratch that reaches into the tree through a symlink is refused too', async (t) => {
  const sb = sandbox(t);
  mkdirSync(join(sb.root, 'inner'));
  const link = join(sb.dir, 'link');
  symlinkSync(join(sb.root, 'inner'), link);
  const { code } = await run(sb, [ONLY_A], ['--scratch', link]);
  assert.equal(code, 1);
  assert.deepEqual(readdirSync(join(sb.root, 'inner')), [], 'nothing was written into the tree');
});

test('a non-empty --scratch the runner did not make is refused and keeps its content; one it made is reused', async (t) => {
  const sb = sandbox(t);
  const foreign = join(sb.dir, 'foreign');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'precious.txt'), 'keep me');
  const { code, io } = await run(sb, [ONLY_A], ['--scratch', foreign]);
  assert.equal(code, 1);
  assert.match(io.lines.err.join('\n'), /not empty/);
  assert.deepEqual(readdirSync(foreign), ['precious.txt']);
  assert.equal(readFileSync(join(foreign, 'precious.txt'), 'utf8'), 'keep me');

  const mine = join(sb.dir, 'mine');
  const first = prepareScratch({ root: sb.root, scratch: mine, entries: ENTRIES });
  writeFileSync(join(first.work, 'lib', 'core.mjs'), 'left over by a crashed run');
  const second = prepareScratch({ root: sb.root, scratch: mine, entries: ENTRIES });
  assert.equal(readFileSync(join(second.work, 'lib', 'core.mjs'), 'utf8'), LIB, 'a reused scratch starts from the tree again');
});

test('applyMutant replaces literally ($& and $1 are text) and refuses a fragment occurring 0 or 2+ times', (t) => {
  const sb = sandbox(t);
  const lit = M('lit', "'$1-$&'", "'$&|$1|$`|$$'");
  applyMutant(sb.root, lit);
  assert.ok(readFileSync(join(sb.root, 'lib', 'core.mjs'), 'utf8').includes("export const TAG = '$&|$1|$`|$$';"));
  writeFileSync(join(sb.root, 'lib', 'core.mjs'), LIB);
  assert.throws(() => applyMutant(sb.root, M('zero', 'absent', 'x')), /occurs 0 times/);
  assert.throws(() => applyMutant(sb.root, M('twice', 'return', 'x')), /occurs \d+ times/);
  assert.equal(readFileSync(join(sb.root, 'lib', 'core.mjs'), 'utf8'), LIB, 'a refused mutant writes nothing');
});
