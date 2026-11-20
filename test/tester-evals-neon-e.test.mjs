// Tester's tests for the fix round of scripts/eval-patch.mjs (T15, rulings FP1-FP4): the neighbours of what the
// implementer's tests pin — signals at the edges, the stage removal's reach, the hunk reader's counts, each header
// form against each unsafe path, the Dockerfile's stage rules, the proof's verdict. Every call that could reach a
// container goes to test/fixtures/fake-docker.mjs: a tripwire named plain `docker` stands first on every PATH handed
// out here, `OMELETTE_EVALS_DOCKER` (or the `docker` argument) names the fake, and the last test reads the tripwire.
// Every tree, diff, task line and word below is invented. No child of a test lives past 5 s.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  linesChanged, makeStage, prepareImage, proofInputs, proofStatus, prove, removeStage, testFiles,
} from '../scripts/eval-patch.mjs';
import { fakeDocker } from './fixtures/fake-docker.mjs';

const SCRIPT_URL = pathToFileURL(join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'eval-patch.mjs')).href;

const made = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
/** Every directory under `root` (a link is not followed) made the owner's, so that a test can remove what it made. */
const open = (root) => {
  try {
    if (!lstatSync(root).isDirectory()) return;
    chmodSync(root, 0o700);
    for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) open(join(root, e.name));
  } catch { /* best effort */ }
};
after(() => { for (const d of made) { open(d); rmSync(d, { recursive: true, force: true }); } });
const quiet = () => {};

const TRIPWIRE = tmp('omelette-evals-etrip-');
writeFileSync(join(TRIPWIRE, 'docker'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(join(TRIPWIRE, 'reached'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(99);\n`);
chmodSync(join(TRIPWIRE, 'docker'), 0o755);

const IMAGE = `golang@sha256:${'0'.repeat(64)}`;
const P01 = {
  id: 'P01', prompt: 'Invented bug report: the widget drops its last item.', tree: 'third-party/p01/before-fix', image: IMAGE, build: null,
  gold: 'suites/P/P01/gold.diff', tests: 'suites/P/P01/tests.diff',
  failToPass: "go test ./widget -run '^TestInventedLastItem$'", passToPass: 'go test ./widget', timeoutS: 5,
};
const WIDGET = 'package widget\n\nfunc Last(items []string) string { return "" }\n';
const goldWith = (marker) => [
  'diff --git a/widget/widget.go b/widget/widget.go', '--- a/widget/widget.go', '+++ b/widget/widget.go', '@@ -1,3 +1,4 @@',
  ' package widget', ' ', `+// ${marker}`, ' func Last(items []string) string { return "" }', '',
].join('\n');
const GOLD = goldWith('FAKE: fixes');
const TESTS = [
  'diff --git a/widget/widget_test.go b/widget/widget_test.go', '--- a/widget/widget_test.go', '+++ b/widget/widget_test.go', '@@ -1,3 +1,5 @@',
  ' package widget', ' ', ' import "testing"', '+', '+func TestInventedLastItem(t *testing.T) {}', '',
].join('\n');

function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function pDir({ task = {}, gold = GOLD } = {}) {
  const dir = tmp('omelette-evals-epdir-');
  const line = { ...P01, ...task };
  put(dir, `${P01.tree}/widget/widget.go`, WIDGET);
  put(dir, `${P01.tree}/widget/widget_test.go`, 'package widget\n\nimport "testing"\n');
  put(dir, P01.gold, gold);
  put(dir, P01.tests, TESTS);
  put(dir, 'suites/P/tasks.jsonl', `${JSON.stringify(line)}\n`);
  return { dir, task: line };
}

function setup(opts) {
  const { dir, task } = pDir(opts);
  const home = tmp('omelette-evals-ehome-');
  const fake = fakeDocker(home);
  return { dir, task, fake, home, env: { PATH: `${TRIPWIRE}:${process.env.PATH}`, HOME: home, OMELETTE_EVALS_DOCKER: fake.bin } };
}

const idOf = (ref) => `sha256:${createHash('sha256').update(ref).digest('hex')}`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** `read()` every 25 ms until `done` says so or `ms` (4 s at most) have passed: the last value read. */
async function until(read, done, ms = 4000) {
  const end = Date.now() + Math.min(ms, 4000);
  let value = read();
  while (!done(value) && Date.now() < end) {
    await new Promise((r) => { setTimeout(r, 25); });
    value = read();
  }
  return value;
}

/** A fixture TMPDIR for a call that makes stages: the stages it leaves are what is in `mine` afterwards. */
function withTmpdir(fn) {
  const mine = tmp('omelette-evals-etmp-');
  const was = process.env.TMPDIR;
  process.env.TMPDIR = mine;
  try { return fn(mine); } finally {
    if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// FP1(3): a stage is removed whatever modes its copy carries, and the walk that opens it follows no link.

test('removeStage: a read-only directory in a read-only directory, a closed directory, a link to a read-only directory outside — all gone, the outside untouched', () => {
  const stage = tmp('omelette-evals-estage-');
  const outside = tmp('omelette-evals-eout-');
  put(outside, 'kept.txt', 'An invented line.\n');
  put(outside, 'inner/kept.txt', 'Another invented line.\n');
  chmodSync(join(outside, 'inner'), 0o555);
  chmodSync(outside, 0o555);
  put(stage, 'tree/a/b/f.txt', 'x');
  put(stage, 'tree/a/closed/g.txt', 'y');
  put(stage, 'tree/a/0000file', 'z');
  chmodSync(join(stage, 'tree/a/0000file'), 0);
  symlinkSync(outside, join(stage, 'tree', 'a', 'link-out'));
  symlinkSync('b', join(stage, 'tree', 'a', 'link-in'));
  symlinkSync('..', join(stage, 'tree', 'a', 'link-up'));
  for (const d of ['tree/a/closed', 'tree/a/b', 'tree/a', 'tree']) chmodSync(join(stage, d), d.endsWith('closed') ? 0 : 0o555);
  const before = [outside, join(outside, 'inner')].map((d) => statSync(d).mode & 0o777);
  assert.deepEqual(before, [0o555, 0o555]);

  assert.equal(removeStage(stage), null);
  assert.equal(existsSync(stage), false);
  assert.deepEqual([outside, join(outside, 'inner')].map((d) => statSync(d).mode & 0o777), [0o555, 0o555], 'a link is not followed: nothing outside was made the owner\'s');
  assert.equal(readFileSync(join(outside, 'inner', 'kept.txt'), 'utf8'), 'Another invented line.\n');
  assert.equal(removeStage(stage), null, 'a stage already gone is removed');
});

test('a stage whose copy holds a nested read-only directory leaves nothing behind, and a failed copy leaves nothing either', async () => {
  const { dir, task, fake, env } = setup();
  fake.addImage(IMAGE);
  const tree = join(dir, P01.tree);
  put(tree, 'vendor/mod/deep/file.go', WIDGET);
  chmodSync(join(tree, 'vendor/mod/deep'), 0o555);
  chmodSync(join(tree, 'vendor/mod'), 0o555);
  try {
    await withTmpdir(async (mine) => {
      const proof = await prove({ dir, task, docker: fake.bin, env, reps: 1, out: quiet });
      assert.equal(proof.ok, true);
      assert.deepEqual(readdirSync(mine), []);
    });
  } finally {
    open(tree);
  }

  // A copy that fails half-way (a closed file in the tree, after a read-only directory was copied) is removed, and the error is the copy's own.
  put(tree, 'a-vendor/mod/deep/file.go', WIDGET);
  chmodSync(join(tree, 'a-vendor/mod/deep'), 0o555);
  chmodSync(join(tree, 'a-vendor/mod'), 0o555);
  chmodSync(join(tree, 'a-vendor'), 0o555);
  put(tree, 'zz/secret', 'x');
  chmodSync(join(tree, 'zz/secret'), 0);
  withTmpdir((mine) => {
    try {
      assert.throws(() => makeStage({ dir, task, change: null }), /EACCES/);
      assert.deepEqual(readdirSync(mine), []);
    } finally {
      open(mine);
      open(tree);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// FP1(2): the handlers, at their edges. A driver module stands in for the CLI: it makes a stage, starts steps through
// the fake, installs the cleanup and waits for the signal.

const DRIVER = (() => {
  const dir = tmp('omelette-evals-edriver-');
  const file = join(dir, 'driver.mjs');
  writeFileSync(file, `
import { CALL_BOUNDS_S, installCleanup, makeStage, runStep } from ${JSON.stringify(SCRIPT_URL)};
const o = JSON.parse(process.argv[2]);
installCleanup();
installCleanup();
if (o.rmBoundS) CALL_BOUNDS_S.rm = o.rmBoundS;
const stage = makeStage({ dir: o.dir, task: o.task, change: o.change });
const steps = [];
for (let i = 0; i < o.steps; i++) {
  steps.push(runStep({ docker: o.docker, imageId: o.imageId, stage, step: 'f2p', timeoutS: o.timeoutS, env: o.env }).catch((e) => ({ error: e.message })));
}
const results = await (o.waitSteps ? Promise.all(steps) : []);
console.log('READY ' + JSON.stringify({ stage, results, listeners: ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s)) }));
setInterval(() => {}, 100);
`);
  return file;
})();

/** Start the driver, wait for READY: { child, ended, ready, stderr, mine }. */
async function drive(opts, { fake, env }) {
  const mine = tmp('omelette-evals-esig-');
  const args = { steps: 0, timeoutS: 4, change: null, docker: fake.bin, imageId: idOf(IMAGE), env: { PATH: env.PATH, HOME: env.HOME }, ...opts };
  const child = spawn(process.execPath, [DRIVER, JSON.stringify(args)], { env: { ...env, TMPDIR: mine }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, killSignal: 'SIGKILL' });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const ended = new Promise((done) => { child.on('close', (code, sig) => done([code, sig])); });
  const hit = await until(() => /^READY (.*)$/m.exec(out), (m) => !!m);
  return { child, ended, mine, ready: hit ? JSON.parse(hit[1]) : null, stderr: () => err, out: () => out };
}

for (const [signal, exit] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`${signal} with a stage and no step in flight: the stage is removed, no docker is called, exit ${exit}; a second signal changes nothing; handlers are installed once`, async () => {
    const ctx = setup();
    ctx.fake.addImage(IMAGE);
    const outside = tmp('omelette-evals-eout-');
    put(outside, 'kept.txt', 'An invented line.\n');
    chmodSync(outside, 0o555);
    const tree = join(ctx.dir, P01.tree);
    put(tree, 'vendor/mod/deep/file.go', WIDGET);
    chmodSync(join(tree, 'vendor/mod/deep'), 0o555);
    chmodSync(join(tree, 'vendor/mod'), 0o555);
    symlinkSync(outside, join(tree, 'out'));
    const run = await drive({ dir: ctx.dir, task: ctx.task, change: GOLD }, ctx);
    try {
      assert.ok(run.ready, `no READY: ${run.out()} ${run.stderr()}`);
      assert.deepEqual(run.ready.listeners, [1, 1, 1], 'installCleanup is once per process');
      assert.deepEqual(readdirSync(run.mine).length, 1);
      run.child.kill(signal);
      run.child.kill(signal);
      assert.deepEqual(await run.ended, [exit, null]);
      assert.deepEqual(readdirSync(run.mine), [], 'the stage is gone');
      assert.deepEqual(ctx.fake.log(), [], 'no container, no docker call');
      assert.equal(run.stderr(), '');
      assert.equal(statSync(outside).mode & 0o777, 0o555);
    } finally {
      run.child.kill('SIGKILL');
      open(tree);
    }
  });
}

test('SIGHUP with two steps in flight: both containers are removed, the clients are gone, the stage is gone, exit 129', async () => {
  const ctx = setup();
  ctx.fake.addImage(IMAGE);
  const run = await drive({ dir: ctx.dir, task: ctx.task, change: goldWith('FAKE: fixes FAKE: hangs'), steps: 2 }, ctx);
  let hung = [];
  try {
    hung = await until(() => ctx.fake.hanging().filter((h) => h.name.startsWith('omelette-evals-')), (h) => h.length === 2);
    assert.equal(hung.length, 2);
    run.child.kill('SIGHUP');
    assert.deepEqual(await run.ended, [129, null]);
    const removed = ctx.fake.log().filter((a) => a[0] === 'rm').map((a) => a.join(' ')).sort();
    assert.deepEqual(removed, hung.map((h) => `rm -f ${h.name}`).sort());
    assert.deepEqual(readdirSync(run.mine), []);
    for (const { pid } of hung) assert.equal(await until(() => alive(pid), (is) => !is, 2000), false, 'the docker client is gone');
    assert.equal(run.stderr(), '');
  } finally {
    run.child.kill('SIGKILL');
    for (const { pid } of hung) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
});

for (const [name, setUp, driverOpts] of [
  ['the daemon refuses the removal', (fake) => fake.noRm(), {}],
  ['the removal does not end within its bound', (fake) => fake.hangOn('rm'), { rmBoundS: 0.3 }],
]) {
  test(`SIGTERM while ${name}: each container is named once with the command that removes it, and the stage is removed all the same`, async () => {
    const ctx = setup();
    ctx.fake.addImage(IMAGE);
    setUp(ctx.fake);
    const run = await drive({ dir: ctx.dir, task: ctx.task, change: goldWith('FAKE: fixes FAKE: hangs'), steps: 2, ...driverOpts }, ctx);
    let hung = [];
    try {
      hung = await until(() => ctx.fake.hanging().filter((h) => h.name.startsWith('omelette-evals-')), (h) => h.length === 2);
      assert.equal(hung.length, 2);
      const t0 = Date.now();
      run.child.kill('SIGTERM');
      assert.deepEqual(await run.ended, [143, null]);
      assert.ok(Date.now() - t0 < 4000, 'bounded');
      const lines = run.stderr().split('\n').filter(Boolean).sort();
      assert.deepEqual(lines, hung.map((h) => `eval-patch: the container ${h.name} could not be removed — remove it with: ${ctx.fake.bin} rm -f ${h.name}`).sort());
      assert.deepEqual(readdirSync(run.mine), [], 'the stage is removed though a container is not');
    } finally {
      run.child.kill('SIGKILL');
      for (const { pid } of hung) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  });
}

test('a container whose removal failed at its step\'s timeout is tried again by the signal, and named only if that fails too', async () => {
  const ctx = setup();
  ctx.fake.addImage(IMAGE);
  ctx.fake.noRm();
  const run = await drive({ dir: ctx.dir, task: ctx.task, change: goldWith('FAKE: fixes FAKE: hangs'), steps: 1, timeoutS: 1, waitSteps: true }, ctx);
  try {
    assert.ok(run.ready, `no READY: ${run.out()} ${run.stderr()}`);
    const [step] = run.ready.results;
    assert.deepEqual([step.timedOut, step.exit, typeof step.leftContainer], [true, null, 'string']);
    assert.equal(ctx.fake.log().filter((a) => a[0] === 'rm').length, 1);
    rmSync(join(ctx.fake.state, 'no-rm'));
    run.child.kill('SIGINT');
    assert.deepEqual(await run.ended, [130, null]);
    assert.deepEqual(ctx.fake.log().filter((a) => a[0] === 'rm'), [['rm', '-f', step.leftContainer], ['rm', '-f', step.leftContainer]], 'the same name, a second time');
    assert.equal(run.stderr(), '', 'it went this time: nothing to name');
    assert.deepEqual(readdirSync(run.mine), []);
  } finally {
    run.child.kill('SIGKILL');
  }
});

test('a step that ended by itself is no container to remove: a signal after it calls no docker', async () => {
  const ctx = setup();
  ctx.fake.addImage(IMAGE);
  const run = await drive({ dir: ctx.dir, task: ctx.task, change: GOLD, steps: 1, waitSteps: true }, ctx);
  try {
    assert.ok(run.ready, `no READY: ${run.out()} ${run.stderr()}`);
    assert.deepEqual([run.ready.results[0].exit, run.ready.results[0].timedOut], [0, false], 'the step ended on its own');
    const logged = ctx.fake.log().length;
    run.child.kill('SIGTERM');
    assert.deepEqual(await run.ended, [143, null]);
    assert.equal(ctx.fake.log().length, logged, 'nothing was removed: `--rm` took the container');
    assert.equal(run.stderr(), '');
  } finally {
    run.child.kill('SIGKILL');
  }
});

test('a container removed at its step\'s timeout, and a step whose docker never started, are no container for the signal to remove', async () => {
  const ctx = setup();
  ctx.fake.addImage(IMAGE);
  const timedOut = await drive({ dir: ctx.dir, task: ctx.task, change: goldWith('FAKE: fixes FAKE: hangs'), steps: 1, timeoutS: 1, waitSteps: true }, ctx);
  try {
    assert.ok(timedOut.ready, `no READY: ${timedOut.out()} ${timedOut.stderr()}`);
    assert.equal('leftContainer' in timedOut.ready.results[0], false, 'the removal went through');
    assert.equal(ctx.fake.log().filter((a) => a[0] === 'rm').length, 1);
    timedOut.child.kill('SIGTERM');
    assert.deepEqual(await timedOut.ended, [143, null]);
    assert.equal(ctx.fake.log().filter((a) => a[0] === 'rm').length, 1, 'no second removal of what is gone');
    assert.equal(timedOut.stderr(), '');
  } finally {
    timedOut.child.kill('SIGKILL');
  }

  const absent = await drive({ dir: ctx.dir, task: ctx.task, change: GOLD, steps: 1, waitSteps: true, docker: join(ctx.home, 'no-such-docker') }, ctx);
  try {
    assert.ok(absent.ready, `no READY: ${absent.out()} ${absent.stderr()}`);
    assert.match(absent.ready.results[0].error, /not found: suite P needs Docker/);
    absent.child.kill('SIGINT');
    assert.deepEqual(await absent.ended, [130, null]);
    assert.equal(absent.stderr(), '', 'no container was ever made: none is named as left');
    assert.deepEqual(readdirSync(absent.mine), []);
  } finally {
    absent.child.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// FP2(1)-(2): the hunk reader.

const J = (lines) => `${lines.join('\n')}\n`;
const crlf = (text) => text.replaceAll('\n', '\r\n');

test('a hunk is as long as its header says: counts left out, zero, with text after them, a note about a missing newline, a blank context line, two files', () => {
  const cases = [
    ['counts left out, then a pair that reads like a header', ['@@ -3 +3 @@', '--- x', '+++ y', '--- a/z', '+++ b/z', '@@ -1 +1 @@', '-q', '+r'], ['z'], 4],
    ['a zero count, then a real header', ['@@ -0,0 +1,2 @@', '+a', '+b', '--- a/y', '+++ b/y', '@@ -1 +1 @@', '-q', '+r'], ['y'], 4],
    ['text after the second @@', ['@@ -1,2 +1,2 @@ func f() {', ' a', '-b', '+c'], [], 2],
    ['a note about a missing newline is no line and no end', ['@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b', '\\ No newline at end of file', '--- a/z', '+++ b/z'], ['z'], 2],
    ['a blank context line', ['@@ -1,3 +1,3 @@', ' a', '', '-b', '+c', '--- a/z', '+++ b/z'], ['z'], 2],
    ['a body longer than its counts: what is left over is no line of it', ['@@ -1 +1 @@', '-a', '+b', '-c', '+d'], [], 2],
    ['a body shorter than its counts: the next file line ends it', ['@@ -1,5 +1,5 @@', '-a', '+b', 'diff --git a/q b/q', '--- a/q', '+++ b/q', '@@ -1 +1 @@', '-c', '+d'], ['q'], 4],
    ['a context line uses up both sides, so a plus line past the counts is out', ['@@ -1,2 +1,2 @@', ' a', '-b', '+c', '+d'], [], 2],
    ['plus lines use up the new side', ['@@ -1 +1 @@', '-a', '+b', '+c'], [], 2],
    ['a context line needs a line on both sides', ['@@ -1 +1,3 @@', ' a', ' b', '+c'], [], 0],
    ['a "--- " line with no "+++ " line after it is no header', ['--- ../x', 'not a plus line'], [], 0],
    ['two files', ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', '--- a/y', '+++ b/y', '@@ -1 +1 @@', '-a', '+b'], ['x', 'y'], 4],
    ['a pair of two names inside an open hunk is body', ['--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@', ' k', '--- a/p', '+++ b/q', ' m'], ['x'], 2],
    ['the same pair right after a closed hunk is a header, both names', ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', '--- a/p', '+++ b/q'], ['p', 'q', 'x'], 2],
  ];
  for (const [name, lines, files, changed] of cases) {
    for (const [form, text] of [['LF', J(lines)], ['CRLF', crlf(J(lines))]]) {
      assert.deepEqual(testFiles(text), files, `${name} (${form})`);
      assert.equal(linesChanged(text), changed, `${name} (${form}) — lines changed`);
    }
  }
});

test('a carriage return ends no path: a header read from a CRLF diff names the path without it, and a bare "--- " header line is not a path', () => {
  assert.deepEqual(testFiles('--- a/x.go\r\n+++ b/x.go\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n'), ['x.go']);
  assert.deepEqual(testFiles('--- a/x.go\r\n+++ /dev/null\r\n@@ -1 +0,0 @@\r\n-a\r\n'), ['x.go']);
  // `/dev/null\r` is /dev/null: it is no path to refuse.
  assert.deepEqual(testFiles('--- /dev/null\r\n+++ b/n.go\r\n@@ -0,0 +1 @@\r\n+a\r\n'), ['n.go']);
});

// ---------------------------------------------------------------------------------------------------------------------------
// FP2(3)-(4): every header form against every unsafe path, and the paths that only look unsafe.

const BODY = '@@ -1 +1 @@\n-a\n+b\n';
const FORMS = {
  'the new side of a header pair': (p) => `--- a/ok.go\n+++ ${p}\n${BODY}`,
  'the old side of a header pair': (p) => `--- ${p}\n+++ b/ok.go\n${BODY}`,
  'a diff --git line, its second name': (p) => `diff --git a/ok.go ${p}\n`,
  'a diff --git line, its first name': (p) => `diff --git ${p} b/ok.go\n`,
  'rename from': (p) => `rename from ${p}\nrename to ok.go\n`,
  'rename to': (p) => `rename from ok.go\nrename to ${p}\n`,
  'copy from': (p) => `copy from ${p}\ncopy to ok.go\n`,
  'copy to': (p) => `copy from ok.go\ncopy to ${p}\n`,
  'Index:': (p) => `Index: ${p}\n`,
  'a header after a hunk its counts ended': (p) => `--- a/ok.go\n+++ b/ok.go\n${BODY}--- ${p}\n+++ b/ok.go\n${BODY}`,
  'a diff --git line after a hunk that is shorter than its counts': (p) => `--- a/ok.go\n+++ b/ok.go\n@@ -1,5 +1,5 @@\n-a\n+b\ndiff --git a/ok.go ${p}\n`,
};
const UNSAFE = ['a/../x', 'a/b/../../../x', '/abs', 'b//abs', 'x/..', '../x', 'a/b/..', '"a/\\056\\056/x"', '"\\057abs"'];
const SAFE = ['./x', 'a..b', '...', 'a/...', 'a/..x/y..', '-x/..y', 'a/b..c/d'];

test('every header form refuses every path that is absolute or holds a ".." segment before a stage exists, and takes a path that only holds dots', () => {
  const { dir, task } = pDir();
  withTmpdir((mine) => {
    for (const [form, build] of Object.entries(FORMS)) {
      for (const path of UNSAFE) {
        assert.throws(() => makeStage({ dir, task, change: build(path) }), (e) => e.code === 'UNSAFE_PATH' && e.message.startsWith('P01: the change names a path that is absolute or holds a ".." segment: '), `${form}: ${path}`);
        assert.deepEqual(readdirSync(mine), [], `${form}: ${path}: no stage was made`);
      }
      for (const path of SAFE) {
        // a quoted or spaced name is another test's: the safe words here are bare
        const stage = makeStage({ dir, task, change: build(path) });
        assert.equal(readFileSync(join(stage, 'change.diff'), 'utf8'), build(path), `${form}: ${path}`);
        rmSync(stage, { recursive: true, force: true });
      }
    }
  });
});

test('a diff --git line whose names hold spaces: refused when a word of it climbs or is absolute, taken when none does', () => {
  const { dir, task } = pDir();
  withTmpdir((mine) => {
    for (const line of ['diff --git a/ok.go\t../x b/ok.go', 'diff --git a/ok.go\t/abs b/ok.go', 'diff --git a/dir with/../x b/dir with/../x', 'diff --git a/dir /abs/x b/dir /abs/x', 'diff --git "a/dir with/\\056\\056/x" "b/dir with/\\056\\056/x"']) {
      assert.throws(() => makeStage({ dir, task, change: `${line}\n` }), (e) => e.code === 'UNSAFE_PATH', line);
    }
    for (const line of ['diff --git a/dir with/x.go b/dir with/x.go', 'diff --git "a/na\\303\\257ve name.go" "b/na\\303\\257ve name.go"']) {
      rmSync(makeStage({ dir, task, change: `${line}\n` }), { recursive: true, force: true });
    }
    assert.deepEqual(readdirSync(mine), []);
  });
});

test('testFiles refuses what a header pair holds that leaves the tree, in the tests diff itself, under either prefix and either side', () => {
  for (const path of ['a/../x', 'a/b/../../../x', '/abs', 'b//abs', 'x/..', '../x']) {
    assert.throws(() => testFiles(`--- a/ok.go\n+++ ${path}\n${BODY}`), /absolute or holds a "\.\." segment/, path);
    assert.throws(() => testFiles(`--- ${path}\n+++ b/ok.go\n${BODY}`), /absolute or holds a "\.\." segment/, path);
  }
  for (const path of ['./x', 'a..b', '...', 'a/...']) assert.doesNotThrow(() => testFiles(`--- a/ok.go\n+++ ${path}\n${BODY}`), path);
});

// ---------------------------------------------------------------------------------------------------------------------------
// FP3: the Dockerfile check's stage rules.

test('a Dockerfile takes files only from a stage it declares or the index of one', async () => {
  const stages = `FROM ${IMAGE} AS build\nRUN true\nFROM ${IMAGE}\n`;
  const accepted = {
    'COPY --from=0 with one stage': `FROM ${IMAGE}\nCOPY --from=0 /a /b\n`,
    'a name declared later than its use': `FROM ${IMAGE}\nCOPY --from=build /a /b\nFROM ${IMAGE} AS build\n`,
    '--from=BUILD against AS build': `${stages}COPY --from=BUILD /a /b\n`,
    '--from=build against AS BUILD': `FROM ${IMAGE} AS BUILD\nCOPY --from=build /a /b\n`,
    'a cache mount, no from': `${stages}RUN --mount=type=cache,target=/x true\n`,
    'a bind mount from a stage, among other options': `${stages}RUN --mount=type=bind,source=/a,from=build,target=/x true\n`,
    'the second index of two': `${stages}COPY --from=1 /a /b\n`,
    'a continued line': `${stages}COPY \\\n  --from=build \\\n  /a /b\n`,
    'a CRLF file': `FROM ${IMAGE} AS build\r\nCOPY --from=build /a /b\r\n`,
    'a flag in a string that opens with a quote': `FROM ${IMAGE}\nRUN echo "--from=other"\n`,
    'a comment about syntax': `# the syntax of this file\nFROM ${IMAGE}\n`,
  };
  const refused = {
    'an index equal to the count of stages': [`FROM ${IMAGE}\nCOPY --from=1 /a /b\n`, /takes files from "1"/],
    'a name that is not a stage': [`${stages}COPY --from=builder /a /b\n`, /takes files from "builder"/],
    'a name that holds a stage name but is not one': [`${stages}COPY --from=build2 /a /b\n`, /takes files from "build2"/],
    'an index with a sign or a fraction': [`${stages}COPY --from=-1 /a /b\n`, /takes files from "-1"/],
    'the flag in capitals': [`${stages}COPY --FROM=other /a /b\n`, /takes files from "other"/],
    'a mount from an image, from= in the middle': [`${stages}RUN --mount=type=bind,source=/a,from=other,target=/x true\n`, /takes files from "other"/],
    'a mount from an image, only option': [`${stages}RUN --mount=from=other true\n`, /takes files from "other"/],
    'the mount flag in capitals': [`${stages}RUN --MOUNT=from=other true\n`, /takes files from "other"/],
    'from= in capitals': [`${stages}RUN --mount=type=bind,FROM=other,target=/x true\n`, /takes files from "other"/],
    'a second mount from an image': [`${stages}RUN --mount=type=cache,target=/c --mount=type=bind,from=other,target=/x true\n`, /takes files from "other"/],
    'a mount, a stage index that does not exist': [`FROM ${IMAGE}\nRUN --mount=from=1 true\n`, /takes files from "1"/],
    'a flag with a space after the equals sign': [`${stages}COPY --from= build /a /b\n`, /takes files from ""/],
    'a CRLF file, an image': [`FROM ${IMAGE}\r\nCOPY --from=other /a /b\r\n`, /takes files from "other"/],
    'a flag in a shell command': [`${stages}RUN echo --from=other\n`, /takes files from "other"/],
    'a syntax directive after the first line': [`FROM ${IMAGE}\n# syntax=someone/frontend\n`, /"# syntax=" directive/],
    'a syntax directive without a space, and spaces before its equals sign': [`#syntax =someone/frontend\nFROM ${IMAGE}\n`, /"# syntax=" directive/],
    'a syntax directive in a CRLF file': [`# syntax=someone/frontend\r\nFROM ${IMAGE}\r\n`, /"# syntax=" directive/],
  };
  for (const [name, text] of Object.entries(accepted)) {
    const { dir, task, fake, env } = setup({ task: { build: 'suites/P/P01/build' } });
    fake.addImage(IMAGE);
    put(dir, 'suites/P/P01/build/Dockerfile', text);
    assert.equal((await prepareImage({ dir, task, docker: fake.bin, env, out: quiet })).built, true, name);
  }
  for (const [name, [text, message]] of Object.entries(refused)) {
    const { dir, task, fake, env } = setup({ task: { build: 'suites/P/P01/build' } });
    fake.addImage(IMAGE);
    put(dir, 'suites/P/P01/build/Dockerfile', text);
    await assert.rejects(prepareImage({ dir, task, docker: fake.bin, env, out: quiet }), message, name);
    assert.deepEqual(fake.log(), [], `${name}: refused before docker is called`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// FP4(1)-(2): the tree's hash and the proof's verdict.

test('a proof is of the tree file by file: a path, a content, a link\'s text each count, and a link to a directory is not walked', () => {
  const { dir, task } = pDir();
  const tree = join(dir, P01.tree);
  const base = proofInputs({ dir, task });
  const outside = tmp('omelette-evals-eout-');
  put(outside, 'k.txt', 'An invented line.\n');
  // The same bytes under another path, the same paths with the bytes swapped, and a link in the place of a file with the same text.
  put(tree, 'one.txt', 'AAA');
  put(tree, 'two.txt', 'BBB');
  const ab = proofInputs({ dir, task });
  rmSync(join(tree, 'one.txt'));
  rmSync(join(tree, 'two.txt'));
  put(tree, 'one.txt', 'BBB');
  put(tree, 'two.txt', 'AAA');
  assert.notEqual(proofInputs({ dir, task }), ab, 'swapped contents under their paths');
  rmSync(join(tree, 'one.txt'));
  rmSync(join(tree, 'two.txt'));
  assert.equal(proofInputs({ dir, task }), base);
  symlinkSync(outside, join(tree, 'out'));
  const linked = proofInputs({ dir, task });
  assert.notEqual(linked, base, 'a link is an entry');
  writeFileSync(join(outside, 'k.txt'), 'Another invented line.\n');
  assert.equal(proofInputs({ dir, task }), linked, 'what it reaches is not read');
  rmSync(join(tree, 'out'));
  symlinkSync(`${outside}/`, join(tree, 'out'));
  assert.notEqual(proofInputs({ dir, task }), linked, 'a link\'s text, as written');
});

test('a file moved to another directory under the same name is another tree', () => {
  const { dir, task } = pDir();
  const tree = join(dir, P01.tree);
  put(tree, 'one/f.go', WIDGET);
  put(tree, 'two/.keep', '');
  const before = proofInputs({ dir, task });
  rmSync(join(tree, 'one', 'f.go'));
  put(tree, 'two/f.go', WIDGET);
  rmSync(join(tree, 'one'), { recursive: true });
  rmSync(join(tree, 'two', '.keep'));
  put(tree, 'one/.keep', '');
  assert.notEqual(proofInputs({ dir, task }), before);
});

test('prove reads every day under runs/, every line of every .jsonl in it, and nothing that is not a day: a null line, a file beside the days', async () => {
  const line = `${JSON.stringify({ suite: 'P', taskIds: ['P01'], arm: 'native:invented', run: 1, ok: true, answer: 'An invented answer.' })}\n`;
  const other = `${JSON.stringify({ suite: 'V', taskIds: ['V01'] })}\n`;
  for (const filed of ['2026-11-18', '2026-11-19', '2026-11-20']) {
    const { dir, task, fake, env } = setup();
    for (const day of ['2026-11-18', '2026-11-19', '2026-11-20']) put(dir, `runs/${day}/a.jsonl`, day === filed ? `null\n\n${other}${line}` : other);
    await assert.rejects(prove({ dir, task, docker: fake.bin, env, reps: 1, out: quiet }), /P01: a model's diff already exists/, filed);
    assert.deepEqual(fake.log(), [], filed);
  }
  const { dir, task, fake, env } = setup();
  fake.addImage(IMAGE);
  put(dir, 'runs/stray.jsonl', line);
  put(dir, 'runs/2026-11-20/a.jsonl', `null\n\n${other}[]\n"P01"\n`);
  assert.equal((await prove({ dir, task, docker: fake.bin, env, reps: 1, out: quiet })).ok, true);
});

test('proofStatus is ok for a proof of this task whose repetitions each held, and for nothing less', async () => {
  const { dir, task, fake, env } = setup();
  fake.addImage(IMAGE);
  const proof = await prove({ dir, task, docker: fake.bin, env, reps: 2, out: quiet });
  const file = join(dir, 'checks', 'proofs', 'P01.json');
  assert.equal(proofStatus({ dir, task }), 'ok');
  const { task: _gone, ...noTask } = proof;
  const [r1, r2] = proof.reps;
  for (const [name, edited, status] of [
    ['the task missing', noTask, 'stale'],
    ['another task id', { ...proof, task: 'P02' }, 'stale'],
    ['the id as a number', { ...proof, task: 1 }, 'stale'],
    ['other inputs', { ...proof, inputs: '0000000000000000' }, 'stale'],
    ['reps an empty object', { ...proof, reps: {} }, 'stale'],
    ['reps a string', { ...proof, reps: 'ok' }, 'stale'],
    ['reps null', { ...proof, reps: null }, 'stale'],
    ['one ok, one not', { ...proof, reps: [{ ok: true }, { ok: false }] }, 'failed'],
    ['the last not ok', { ...proof, reps: [r1, { ...r2, ok: false }] }, 'failed'],
    ['the first not ok', { ...proof, reps: [{ ...r1, ok: false }, r2] }, 'failed'],
    ['a repetition with ok as a number', { ...proof, reps: [r1, { ...r2, ok: 1 }] }, 'failed'],
    ['a repetition with no ok', { ...proof, reps: [r1, {}] }, 'failed'],
    ['a repetition that is a string', { ...proof, reps: [r1, 'ok'] }, 'failed'],
    ['ok false at the top, every repetition ok', { ...proof, ok: false }, 'failed'],
    ['ok missing at the top', (({ ok, ...rest }) => rest)(proof), 'failed'],
    ['the least that is ok: one ok repetition', { ...proof, reps: [{ ok: true }] }, 'ok'],
  ]) {
    writeFileSync(file, JSON.stringify(edited));
    assert.equal(proofStatus({ dir, task }), status, name);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------

test('no test of this file reached a binary named plain docker', () => {
  assert.equal(existsSync(join(TRIPWIRE, 'reached')), false);
});
