// scripts/mutants.mjs — what test/mutants.test.mjs leaves open: the report's
// unique-catch rule with two catchers, the timeout path and its stragglers,
// restoration between mutants, the dry-run refusals, the scratch rules, literal
// replacement. Every fixture repository is built under a fresh tmp directory;
// neither this checkout nor the real catalogue is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMutant, main, prepareScratch, runSuite } from '../scripts/mutants.mjs';

const ENTRIES = ['lib', 'test'];
const LIB = [
  "import { spawn } from 'node:child_process';",
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
  "import { fileURLToPath } from 'node:url';",
  "import { add, onlyA, onlyB, hang, later, TAG } from '../lib/core.mjs';",
  // leaves a pid trail and a straggler child in the process group (its command line holds MUT_MARK), when asked to
  'if (process.env.MUT_PIDFILE) {',
  '  appendFileSync(process.env.MUT_PIDFILE, `${process.pid}\\n`);',
  "  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.env.MUT_MARK || ''], { stdio: 'ignore' });",
  '  c.unref();',
  '  appendFileSync(process.env.MUT_PIDFILE, `${c.pid}\\n`);',
  '}',
  // leaves a process outside the group that outlives the suite, recording its pid: 'env' — a neutral command line,
  // known only by the scratch variable it inherits; 'path' — no environment, its command line holding this file's (real) path
  'if (process.env.MUT_STRAY) {',
  "  const s = process.env.MUT_STRAY === 'env'",
  "    ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
  "    : spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', fileURLToPath(import.meta.url)], { detached: true, stdio: 'ignore', env: {} });",
  '  s.unref();',
  '  appendFileSync(process.env.MUT_STRAY_PIDS, `${s.pid}\\n`);',
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
// A grandchild in a process group of its own, its command line holding MUT_MARK and no scratch
// path: only a walk of the process tree reaches it. Once running it adds `<pid> detached` to MUT_PIDFILE.
const DETACHED = "spawn(process.execPath, ['-e', \"require('node:fs').appendFileSync(process.env.MUT_PIDFILE, process.pid + ' detached' + require('node:os').EOL); setInterval(() => {}, 1000);\", process.env.MUT_MARK], { detached: true, stdio: 'ignore' }).unref();";

const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) };
};

const sandbox = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-mutants-runner-test-'));
  const cleanups = [];
  t.after(() => {
    for (const fn of cleanups.reverse()) { try { fn(); } catch { /* the next one still runs */ } }
    rmSync(dir, { recursive: true, force: true });
  });
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'lib', 'core.mjs'), LIB);
  writeFileSync(join(root, 'test', 'a.test.mjs'), A_TEST);
  writeFileSync(join(root, 'test', 'b.test.mjs'), B_TEST);
  return { dir, root, real: realpathSync(dir), onCleanup: (fn) => cleanups.push(fn) };
};
// Every live process whose command line holds the sandbox (as named or as its real path), where
// these tests put every scratch. A `ps` read of the test's own, not the runner's.
const survivors = (sb) => execFileSync('ps', ['-A', '-ww', '-o', 'pid=,stat=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').map((l) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean)
  .filter(([, pid, stat, command]) => Number(pid) !== process.pid && !stat.startsWith('Z') && (command.includes(sb.dir) || command.includes(sb.real)))
  .map(([, pid, , command]) => `${pid} ${command}`);
// The scan once nothing is left, or the last one after 5 s: a bound for a failed test, never a wait a pass needs.
const settle = async (sb) => {
  for (const deadline = Date.now() + 5000; ;) {
    const left = survivors(sb);
    if (!left.length || Date.now() >= deadline) return left;
    await new Promise((r) => setTimeout(r, 50));
  }
};
const killSurvivors = (sb) => { for (const line of survivors(sb)) { try { process.kill(Number(line.split(' ')[0]), 'SIGKILL'); } catch { /* gone */ } } };

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

test('a mutant that hangs a test is killed at --timeout with every descendant (one outside the process group too), counted under caughtByTimeout, and the next mutant runs clean', async (t) => {
  const sb = sandbox(t);
  const pidfile = join(sb.dir, 'pids.txt');
  process.env.MUT_PIDFILE = pidfile;
  process.env.MUT_MARK = join(sb.dir, 'mark');
  sb.onCleanup(() => {
    delete process.env.MUT_PIDFILE;
    delete process.env.MUT_MARK;
    killSurvivors(sb);
    if (existsSync(pidfile)) for (const l of readFileSync(pidfile, 'utf8').split('\n').filter(Boolean)) { try { process.kill(Number(l.split(' ')[0]), 'SIGKILL'); } catch { /* gone */ } }
  });
  // The hung file ignores SIGTERM, so node's own --test-timeout cannot end it: only the runner's kill at the cap can.
  const hang = M('m-hang', 'return 1;', `process.on('SIGTERM', () => {}); ${DETACHED} for (;;);`);
  // --timeout caps the fixture's own baseline run too, so it must stay far above that run's time under load.
  const { code, io, report } = await run(sb, [hang, ONLY_B], ['--timeout', '15', '--scratch', join(sb.dir, 'scratch')]);
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
  const trail = readFileSync(pidfile, 'utf8').split('\n').filter(Boolean);
  assert.ok(trail.length >= 6, `each run left a test process and a straggler, saw ${trail.length}`);
  assert.ok(trail.some((l) => l.endsWith(' detached')), 'the hung file started its grandchild outside the group');
  assert.deepEqual(await settle(sb), [], 'no process whose command line holds the sandbox survives');
  assert.equal(readFileSync(join(sb.root, 'lib', 'core.mjs'), 'utf8'), LIB);
});

test("a file node's own --test-timeout cancelled counts as one still running at the cap: timedOut, under stillRunning", async (t) => {
  const sb = sandbox(t);
  // node's cancel, staged (equal to the cap, it cannot be made to come first): the real reporter is
  // handed b's file-level complete as node 20 and 22 send it for a cancelled file.
  const staged = join(sb.dir, 'staged-reporter.mjs');
  writeFileSync(staged, [
    "import { resolve } from 'node:path';",
    `import reporter from ${JSON.stringify(new URL('../scripts/mutants.mjs', import.meta.url).href)};`,
    'export default async function* (source) {',
    '  yield* reporter((async function* () {',
    '    for await (const ev of source) {',
    '      const d = ev.data || {};',
    "      const top = ev.type === 'test:complete' && d.nesting === 0 && !!d.file && resolve(d.name || '') === d.file;",
    "      const error = Object.assign(new Error('test timed out after 60000ms'), { failureType: 'testTimeoutFailure' });",
    '      yield top ? { ...ev, data: { ...d, details: { ...d.details, passed: false, error } } } : ev;',
    '    }',
    '  })());',
    '}',
    '',
  ].join('\n'));
  const r = await runSuite({ cwd: sb.root, files: ['test/b.test.mjs'], timeoutMs: 60_000, home: join(sb.dir, 'home'), reporter: staged });
  assert.deepEqual({ timedOut: r.timedOut, stillRunning: r.stillRunning, failed: r.failed }, { timedOut: true, stillRunning: ['test/b.test.mjs'], failed: ['test/b.test.mjs'] }, r.stderr);
  assert.ok(r.wallMs < 60_000, 'the runner\'s own cap never fired');
});

// The strays a run's files recorded, set up for one test and killed after it whatever happens.
const strays = (sb, kind) => {
  const file = join(sb.dir, 'strays.txt');
  Object.assign(process.env, { MUT_STRAY: kind, MUT_STRAY_PIDS: file });
  const pids = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : []);
  sb.onCleanup(() => {
    delete process.env.MUT_STRAY;
    delete process.env.MUT_STRAY_PIDS;
    for (const p of pids()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    killSurvivors(sb);
  });
  return pids;
};
// Alive by `kill -0`, a zombie counting as gone.
const isAlive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z'); } catch { return false; }
};
// The recorded pids still alive after up to 5 s: a bound for a failed test, never a wait a pass needs.
const strayAlive = async (pids) => {
  for (const deadline = Date.now() + 5000; pids.some(isAlive) && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 50));
  return pids.filter(isAlive);
};

test('a process that outlives its suite, known only by the scratch variable it inherited, is killed after the run that left it, and the progress line says so; a run that throws is swept in its finally', async (t) => {
  const sb = sandbox(t);
  const pids = strays(sb, 'env');
  const scratch = join(sb.dir, 'scratch');
  const green = await run(sb, [ONLY_B], ['--files', 'a.test.mjs', '--scratch', scratch]);
  assert.equal(green.code, 0, green.io.lines.err.join('\n'));
  const lineOf = (re) => green.io.lines.err.find((l) => re.test(l)) || '';
  assert.match(lineOf(/^baseline:/), /  stragglers: 1 killed$/);
  assert.match(lineOf(/m-only-b/), /UNCAUGHT .* stragglers: 1 killed$/);
  assert.equal(pids().length, 2, 'the baseline and the mutant each left one');
  assert.deepEqual(await strayAlive(pids()), []);
  assert.equal(existsSync(join(scratch, 'owner.pid')), false, 'a finished run releases the scratch it named');

  writeFileSync(join(sb.root, 'test', 'b.test.mjs'), `${B_TEST}test('red', () => assert.equal(1, 2));\n`);
  const red = await run(sb, [ONLY_B], ['--scratch', scratch]);
  assert.equal(red.code, 1);
  assert.match(red.io.lines.err.join('\n'), /baseline is not green/);
  assert.ok(red.io.lines.err.includes('stragglers: 2 killed'), red.io.lines.err.join('\n'));
  assert.deepEqual(await strayAlive(pids()), []);
  assert.deepEqual(await settle(sb), []);
});

test('a --scratch reached through a symlink: a stray with no environment whose command line names the scratch by its real path is swept too', async (t) => {
  const sb = sandbox(t);
  const pids = strays(sb, 'path');
  const target = join(sb.dir, 'elsewhere', 'scratch');
  mkdirSync(target, { recursive: true });
  symlinkSync(target, join(sb.dir, 'link'));
  const { code, io } = await run(sb, [ONLY_B], ['--files', 'a.test.mjs', '--scratch', join(sb.dir, 'link')]);
  assert.equal(code, 0, io.lines.err.join('\n'));
  assert.match(io.lines.err.find((l) => l.startsWith('baseline:')) || '', /  stragglers: 1 killed$/);
  assert.equal(pids().length, 2);
  assert.deepEqual(await strayAlive(pids()), []);
  assert.deepEqual(await settle(sb), []);
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
