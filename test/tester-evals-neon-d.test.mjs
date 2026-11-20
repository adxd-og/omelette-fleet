// Tester's tests for scripts/eval-patch.mjs (T15, plan docs/superpowers/plans/2026-11-19-evals-neon.md).
// Every call that could reach a container goes to test/fixtures/fake-docker.mjs: a tripwire named plain `docker`
// stands first on every PATH handed out here, `OMELETTE_EVALS_DOCKER` (or the `docker` argument) names the fake,
// and the last test reads the tripwire. Every tree, diff, task line and word below is invented.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  linesChanged, main, makeStage, prepareImage, proofInputs, proofStatus, prove, pTaskProblems, readPTasks, runStep, testFiles,
} from '../scripts/eval-patch.mjs';
import { fakeDocker } from './fixtures/fake-docker.mjs';

const made = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const quiet = () => {};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const TRIPWIRE = tmp('omelette-evals-dtrip-');
writeFileSync(join(TRIPWIRE, 'docker'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(join(TRIPWIRE, 'reached'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(99);\n`);
chmodSync(join(TRIPWIRE, 'docker'), 0o755);

const IMAGE = `golang@sha256:${'0'.repeat(64)}`;
const OTHER_IMAGE = `golang@sha256:${'1'.repeat(64)}`;
const idOf = (ref) => `sha256:${sha256(ref)}`;

// timeoutS 5: no child of a test outlives that.
const P01 = {
  id: 'P01', prompt: 'Invented bug report: the widget drops its last item.', tree: 'third-party/p01/before-fix', image: IMAGE, build: null,
  gold: 'suites/P/P01/gold.diff', tests: 'suites/P/P01/tests.diff',
  failToPass: "go test ./widget -run '^TestInventedLastItem$'", passToPass: 'go test ./widget', timeoutS: 5,
};
const WIDGET = 'package widget\n\nfunc Last(items []string) string { return "" }\n';
const WIDGET_TEST = 'package widget\n\nimport "testing"\n';
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
  const dir = tmp('omelette-evals-dpdir-');
  const line = { ...P01, ...task };
  put(dir, `${P01.tree}/widget/widget.go`, WIDGET);
  put(dir, `${P01.tree}/widget/widget_test.go`, WIDGET_TEST);
  put(dir, P01.gold, gold);
  put(dir, P01.tests, TESTS);
  put(dir, 'suites/P/tasks.jsonl', `${JSON.stringify(line)}\n`);
  return { dir, task: line };
}

function setup(opts) {
  const { dir, task } = pDir(opts);
  const home = tmp('omelette-evals-dhome-');
  const fake = fakeDocker(home);
  return { dir, task, fake, home, env: { PATH: `${TRIPWIRE}:${process.env.PATH}`, HOME: home, OMELETTE_EVALS_DOCKER: fake.bin } };
}

const proofAt = (dir, id = 'P01') => JSON.parse(readFileSync(join(dir, 'checks', 'proofs', `${id}.json`), 'utf8'));
const stepsOf = (fake) => fake.runs().map((a) => a[a.length - 1]);

/** A private OS temp dir for the duration of `fn`: the stages a call leaves behind are what is in it afterwards. */
async function withTmpdir(fn) {
  const mine = tmp('omelette-evals-dtmp-');
  const was = process.env.TMPDIR;
  process.env.TMPDIR = mine;
  const stages = () => readdirSync(mine).filter((n) => n.startsWith('omelette-evals-p-'));
  try {
    return await fn({ mine, stages });
  } finally {
    if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
    const open = (d) => {
      chmodSync(d, 0o700);
      for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) open(join(d, e.name));
    };
    try { open(mine); } catch { /* the walk is best effort */ }
    rmSync(mine, { recursive: true, force: true });
  }
}

// Plan, `proofInputs`: the task line's fields, the gold text, the tests text and every file of the build dir.
test('proofInputs: every input the plan lists changes the digest', () => {
  const { dir, task } = pDir({ task: { build: 'suites/P/P01/build' } });
  const dockerfile = `FROM ${IMAGE}\nRUN true\n`;
  put(dir, 'suites/P/P01/build/Dockerfile', dockerfile);
  put(dir, 'suites/P/P01/build2/Dockerfile', dockerfile);
  put(dir, 'third-party/p01/other/widget/widget.go', WIDGET);
  put(dir, 'suites/P/P01/gold2.diff', GOLD);
  put(dir, 'suites/P/P01/tests2.diff', TESTS);
  const base = proofInputs({ dir, task });
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(proofInputs({ dir, task: { ...task } }), base, 'the same inputs, the same digest');

  const { timeoutS, ...noTimeout } = task;
  const fields = {
    image: { ...task, image: OTHER_IMAGE },
    build: { ...task, build: 'suites/P/P01/build2' },
    'build (none)': { ...task, build: null },
    tree: { ...task, tree: 'third-party/p01/other' },
    'gold path': { ...task, gold: 'suites/P/P01/gold2.diff' },
    'tests path': { ...task, tests: 'suites/P/P01/tests2.diff' },
    failToPass: { ...task, failToPass: 'go test ./widget -run X' },
    passToPass: { ...task, passToPass: 'go test ./...' },
    timeoutS: { ...task, timeoutS: timeoutS + 1 },
    'timeoutS (absent)': noTimeout,
  };
  for (const [name, changed] of Object.entries(fields)) assert.notEqual(proofInputs({ dir, task: changed }), base, `the task line's ${name}`);

  const edits = {
    'gold text': [P01.gold, GOLD.replace('FAKE: fixes', 'FAKE: fixes!')],
    'tests text': [P01.tests, `${TESTS}+// more\n`],
    'Dockerfile text': ['suites/P/P01/build/Dockerfile', `${dockerfile}RUN true\n`],
    'a file added to the build dir': ['suites/P/P01/build/.dockerignore', '*.log\n'],
    'a nested file added to the build dir': ['suites/P/P01/build/deps/lock.txt', 'invented 1.0\n'],
  };
  for (const [name, [rel, text]] of Object.entries(edits)) {
    const was = existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), 'utf8') : null;
    put(dir, rel, text);
    assert.notEqual(proofInputs({ dir, task }), base, name);
    if (was === null) rmSync(join(dir, rel)); else put(dir, rel, was);
  }
  rmSync(join(dir, 'suites/P/P01/build/deps'), { recursive: true });
  assert.equal(proofInputs({ dir, task }), base, 'undone, the digest is the first one again');
  // A file's name, not only its bytes.
  put(dir, 'suites/P/P01/build/a.lock', 'invented 1.0\n');
  const named = proofInputs({ dir, task });
  rmSync(join(dir, 'suites/P/P01/build/a.lock'));
  put(dir, 'suites/P/P01/build/b.lock', 'invented 1.0\n');
  assert.notEqual(proofInputs({ dir, task }), named, 'a renamed file in the build dir');
});

// Plan, `prove`: "A repetition is ok when: snapshot apply.exit === 0; snapshot failToPass neither timed out nor exit 0 nor in
// HARNESS_EXITS; snapshot passToPass.exit === 0; gold apply, failToPass and passToPass exit 0." Each half, one at a time.
test('a repetition is ok only when every half of it holds: each miss fails the proof, and the test failing is not the harness failing', async () => {
  const run = async ({ setupOpts, knob }) => {
    const ctx = setup(setupOpts);
    ctx.fake.addImage(IMAGE);
    knob?.(ctx.fake);
    const printed = [];
    const proof = await prove({ dir: ctx.dir, task: ctx.task, docker: ctx.fake.bin, env: ctx.env, reps: 1, out: (l) => printed.push(l) });
    return { proof, rep: proof.reps[0], printed, fake: ctx.fake };
  };

  for (const code of [120, 121, 122, 123, 125]) {
    const { proof, rep } = await run({ knob: (f) => f.snapshotExit('f2p', code) });
    assert.deepEqual([proof.ok, rep.ok, rep.snapshot.failToPass.exit], [false, false, code], `snapshot F2P exits ${code}: the harness, not the test`);
  }
  // Any other non-zero exit is the test failing, whatever the number.
  for (const code of [2, 124, 126, 127, 137]) {
    const { rep } = await run({ knob: (f) => f.snapshotExit('f2p', code) });
    assert.deepEqual([rep.ok, rep.snapshot.failToPass.exit], [true, code], `snapshot F2P exits ${code}`);
  }
  const snapshotHangs = await run({ setupOpts: { task: { timeoutS: 1 } }, knob: (f) => f.snapshotExit('f2p', 'hang') });
  assert.deepEqual([snapshotHangs.rep.ok, snapshotHangs.rep.snapshot.failToPass.timedOut, snapshotHangs.rep.snapshot.failToPass.exit], [false, true, null]);
  assert.ok(snapshotHangs.rep.snapshot.failToPass.ms >= 900 && snapshotHangs.rep.snapshot.failToPass.ms < 3500, `a step bounded at 1 s ends near it: ${snapshotHangs.rep.snapshot.failToPass.ms} ms`);
  assert.ok(snapshotHangs.printed.some((l) => /snapshot F2P exit timeout, P2P exit 0 · .* — FAILED$/.test(l)), snapshotHangs.printed.join('\n'));
  assert.ok(snapshotHangs.fake.log().some((a) => a[0] === 'rm'), 'the container of a step past its bound is removed');

  const snapshotSignal = await run({ knob: (f) => f.snapshotExit('f2p', 'kill') });
  assert.deepEqual([snapshotSignal.rep.ok, snapshotSignal.rep.snapshot.failToPass.exit, snapshotSignal.rep.snapshot.failToPass.timedOut], [false, null, false], 'a step that died of a signal never exited: the test did not fail');

  const snapshotP2p = await run({ knob: (f) => f.snapshotExit('p2p', 1) });
  assert.deepEqual([snapshotP2p.rep.ok, snapshotP2p.rep.snapshot.passToPass.exit], [false, 1], 'the neighbouring tests fail on the snapshot');
  const snapshotApply = await run({ knob: (f) => f.snapshotExit('apply', 120) });
  assert.deepEqual([snapshotApply.rep.ok, snapshotApply.rep.snapshot.failToPass, snapshotApply.rep.snapshot.passToPass], [false, null, null]);
  assert.deepEqual(stepsOf(snapshotApply.fake), ['apply', 'apply', 'f2p', 'p2p'], 'a state whose apply failed runs no test');

  const goldF2p = await run({ setupOpts: { gold: goldWith('invented: no fix') } });
  assert.deepEqual([goldF2p.rep.ok, goldF2p.rep.gold.failToPass.exit, goldF2p.rep.gold.passToPass.exit], [false, 1, 0], 'the gold does not make the test pass');
  const goldP2p = await run({ setupOpts: { gold: goldWith('FAKE: fixes FAKE: breaks-neighbours') } });
  assert.deepEqual([goldP2p.rep.ok, goldP2p.rep.gold.failToPass.exit, goldP2p.rep.gold.passToPass.exit], [false, 0, 1], 'the gold breaks the neighbours');
  const goldHangs = await run({ setupOpts: { task: { timeoutS: 1 }, gold: goldWith('FAKE: fixes FAKE: hangs') } });
  assert.deepEqual([goldHangs.rep.ok, goldHangs.rep.gold.failToPass.timedOut, goldHangs.rep.gold.failToPass.exit], [false, true, null]);
});

// Spec: "removed after the run"; plan: a stage "removed after its steps", and the stage can hold the gold.
test('no stage is left in the OS temp dir: not by a failed proof, not when docker vanishes half-way through one', async () => {
  await withTmpdir(async ({ stages }) => {
    const failing = setup({ gold: goldWith('invented: no fix') });
    failing.fake.addImage(IMAGE);
    const proof = await prove({ dir: failing.dir, task: failing.task, docker: failing.fake.bin, env: failing.env, reps: 2, out: quiet });
    assert.equal(proof.ok, false);
    assert.equal(failing.fake.runs().length, 12);
    assert.deepEqual(stages(), [], 'a failed proof leaves no stage');

    // The fourth `run` is the gold state's apply; then the binary removes itself, and the gold state's F2P cannot start.
    const vanishing = setup();
    vanishing.fake.addImage(IMAGE);
    const counter = join(vanishing.home, 'runs-seen');
    const wrapper = join(vanishing.home, 'docker-that-vanishes');
    writeFileSync(wrapper, `#!${process.execPath}
const fs = require('fs');
const r = require('child_process').spawnSync(${JSON.stringify(vanishing.fake.bin)}, process.argv.slice(2), { stdio: 'inherit', timeout: 4000 });
if (process.argv[2] === 'run') {
  const n = (fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0) + 1;
  fs.writeFileSync(${JSON.stringify(counter)}, String(n));
  if (n === 4) fs.unlinkSync(__filename);
}
process.exit(r.status);
`);
    chmodSync(wrapper, 0o755);
    const printed = [];
    const code = await main(['prove', '--task', 'P01', '--dir', vanishing.dir], { out: quiet, err: (l) => printed.push(l), env: { ...vanishing.env, OMELETTE_EVALS_DOCKER: wrapper } });
    assert.equal(code, 1, printed.join('\n'));
    assert.equal(vanishing.fake.runs().length, 4, 'the proof stopped where docker went');
    assert.equal(existsSync(join(vanishing.dir, 'checks', 'proofs', 'P01.json')), false, 'a proof that did not finish is not written');
    assert.deepEqual(stages(), [], 'the stage of the step that could not start is removed too: it holds the gold');
  });
});

// Plan: a stage is "removed after its steps" (it holds a copy of the tree, and in a gold state the gold). A tree with a directory
// its owner cannot write in (a vendored module cache) copies fine, and then the stage cannot be removed.
test('a tree holding a read-only directory leaves no stage behind', async () => {
  await withTmpdir(async ({ stages }) => {
    const { dir, task, fake, env } = setup();
    fake.addImage(IMAGE);
    put(dir, `${P01.tree}/vendor/mod/file.go`, WIDGET);
    chmodSync(join(dir, P01.tree, 'vendor', 'mod'), 0o555);
    try {
      await prove({ dir, task, docker: fake.bin, env, reps: 1, out: quiet });
    } catch { /* thrown or not, what matters is what is left */ } finally {
      chmodSync(join(dir, P01.tree, 'vendor', 'mod'), 0o755);
    }
    const left = stages().map((n) => [n, readdirSync(join(process.env.TMPDIR, n))]);
    for (const name of stages()) {
      const open = (d) => { chmodSync(d, 0o700); for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) open(join(d, e.name)); };
      open(join(process.env.TMPDIR, name));
    }
    assert.deepEqual(left, [], 'a stage outlives its steps');
  });
});

// Plan, CLI: "exit 0 when every proof is ok, 1 when one is not or one refused, 2 on a usage error"; dirs 0700, file 0600.
test('prove with several tasks: a miss or a refusal does not stop the next, the exit is 1, a repeated id runs once', async () => {
  const { dir, fake, env } = setup();
  fake.addImage(IMAGE);
  put(dir, 'suites/P/P02/gold.diff', goldWith('invented: no fix'));
  put(dir, 'suites/P/P02/tests.diff', TESTS);
  const lines = [P01, { ...P01, id: 'P02', gold: 'suites/P/P02/gold.diff', tests: 'suites/P/P02/tests.diff' }, { ...P01, id: 'P03' }];
  put(dir, 'suites/P/tasks.jsonl', lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  put(dir, 'runs/2026-11-20/P-x.jsonl', `${JSON.stringify({ suite: 'P', taskIds: ['P03'], arm: 'native:invented', run: 1, ok: true, answer: 'An invented answer.' })}\n`);
  const printed = [];
  const code = await main(['prove', '--task', 'P09', '--task', 'P02', '--task', 'P03', '--task', 'P01', '--task', 'P01', '--dir', dir], { out: (l) => printed.push(l), err: (l) => printed.push(l), env });
  assert.equal(code, 1, printed.join('\n'));
  assert.match(printed.join('\n'), /P09: suite P has no such task/);
  assert.match(printed.join('\n'), /P03: a model's diff already exists/);
  assert.match(printed.join('\n'), /P02: NOT proven/);
  assert.equal(proofAt(dir, 'P02').ok, false);
  assert.equal(proofAt(dir, 'P01').ok, true, 'a task after a failure is still proven');
  assert.equal(existsSync(join(dir, 'checks', 'proofs', 'P03.json')), false);
  assert.equal(fake.runs().length, 36, 'P02 and P01, three repetitions of six steps each; P01 named twice, proven once');
  assert.equal(statSync(join(dir, 'checks')).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'checks', 'proofs')).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'checks', 'proofs', 'P01.json')).mode & 0o777, 0o600);
});

// Plan, `prove`: "refuses (throws, no docker call) when any <D>/runs/*/P-*.jsonl holds a line for the task".
test('a model\'s diff filed under any date, alone or in a batch, stops the proof of that task and of no other', async () => {
  const line = (taskIds) => `${JSON.stringify({ suite: 'P', taskIds, arm: 'gemini:Invented Model (High)', run: 1, ok: true, answer: 'An invented answer.' })}\n`;
  const refused = [
    ['an older day, a newer day holding another task', { 'runs/2026-11-18/P-a.jsonl': line(['P01']), 'runs/2026-11-20/P-b.jsonl': line(['P02']) }],
    ['a batch', { 'runs/2026-11-20/P-a.jsonl': line(['P02', 'P01']) }],
    ['a second file of a day', { 'runs/2026-11-20/P-a.jsonl': line(['P02']), 'runs/2026-11-20/P-b.jsonl': `\n${line(['P01'])}` }],
  ];
  for (const [name, files] of refused) {
    const { dir, task, fake, env } = setup();
    for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
    await assert.rejects(prove({ dir, task, docker: fake.bin, env, reps: 1, out: quiet }), /P01: a model's diff already exists/, name);
    assert.deepEqual(fake.log(), [], name);
    assert.equal(existsSync(join(dir, 'checks')), false, name);
  }
  const free = setup();
  free.fake.addImage(IMAGE);
  put(free.dir, 'runs/2026-11-18/P-a.jsonl', line(['P02']));
  put(free.dir, 'runs/2026-11-20/P-b.jsonl', line(['P02', 'P03']));
  assert.equal((await prove({ dir: free.dir, task: free.task, docker: free.fake.bin, env: free.env, reps: 1, out: quiet })).ok, true);
});

// Ruling 1, 2: the gate is in `prove`, `prepareImage` and `makeStage` themselves, whatever the caller checked.
test('prove and prepareImage refuse a task line that is not sound before any docker call', async () => {
  const unsound = [
    { tree: '.' }, { tree: 'third-party' }, { tree: 'suites/P/P01' }, { gold: 'suites/R/key.diff' }, { tests: 'third-party/p01/before-fix/x.diff' },
    { image: 'python:3.13' }, { image: `someone/tool@sha256:${'0'.repeat(64)}` }, { build: 'suites/P' }, { timeoutS: 0 }, { timeoutS: 3601 },
  ];
  for (const bad of unsound) {
    const { dir, fake, env } = setup();
    const task = { ...P01, ...bad };
    await assert.rejects(prove({ dir, task, docker: fake.bin, env, reps: 1, out: quiet }), /^Error: P01: /, JSON.stringify(bad));
    await assert.rejects(prepareImage({ dir, task, docker: fake.bin, env, out: quiet }), /^Error: P01: /, JSON.stringify(bad));
    assert.deepEqual(fake.log(), [], JSON.stringify(bad));
    assert.equal(existsSync(join(dir, 'checks')), false, JSON.stringify(bad));
  }
});

// Ruling 1: "strictly under third-party/ ... as the kernel resolves it"; a link that stays inside is not a refusal.
test('a link that stays inside third-party/ is a tree, one that leads out is not, a link as the tree is not, and a private dir reached through a link works', async () => {
  const { dir } = pDir();
  symlinkSync('p01', join(dir, 'third-party', 'alias'));
  const viaAlias = { ...P01, tree: 'third-party/alias/before-fix' };
  assert.deepEqual(pTaskProblems(viaAlias, { dir }), []);
  const stage = makeStage({ dir, task: viaAlias, change: null });
  try {
    assert.equal(readFileSync(join(stage, 'tree', 'widget', 'widget.go'), 'utf8'), WIDGET);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  // A link back to third-party/ itself stays inside (the tree under it is where it says); one to the private dir leads out; a link as the tree is refused.
  symlinkSync('.', join(dir, 'third-party', 'self'));
  symlinkSync('..', join(dir, 'third-party', 'up'));
  assert.deepEqual(pTaskProblems({ ...P01, tree: 'third-party/self/p01/before-fix' }, { dir }), []);
  assert.match(pTaskProblems({ ...P01, tree: 'third-party/up/suites/P/P01' }, { dir }).join('; '), /leads out of third-party\/ through a link/);
  assert.throws(() => makeStage({ dir, task: { ...P01, tree: 'third-party/up/suites/P/P01' }, change: null }), /leads out of third-party\/ through a link/);
  for (const tree of ['third-party/self', 'third-party/self/', 'third-party/up', 'third-party/up/']) {
    assert.notDeepEqual(pTaskProblems({ ...P01, tree }, { dir }), [], tree);
    assert.throws(() => makeStage({ dir, task: { ...P01, tree }, change: null }), /P01: tree /, tree);
  }

  // The directory handed in is itself reached through a link (a /tmp that is a link, a `--dir` that is one).
  const front = join(tmp('omelette-evals-dlink-'), 'front');
  symlinkSync(dir, front);
  assert.deepEqual(pTaskProblems(P01, { dir: front }), []);
  const stageViaFront = makeStage({ dir: front, task: P01, change: null });
  rmSync(stageViaFront, { recursive: true, force: true });
});

// Plan, `OFFICIAL_IMAGE`: an official Docker Hub image, no path, pinned by a 64-hex digest.
test('an image must be an official one, pinned by a lowercase 64-hex digest', () => {
  const zeros = '0'.repeat(64);
  const refused = [
    'python:3.13', 'golang', '', 5, null, `Golang@sha256:${zeros}`, `ghcr.io/owner/tool@sha256:${zeros}`, `library/golang@sha256:${zeros}`,
    `docker.io/golang@sha256:${zeros}`, `docker.io/library/foo/bar@sha256:${zeros}`, `localhost:5000/golang@sha256:${zeros}`,
    `golang@sha256:${'0'.repeat(63)}`, `golang@sha256:${'0'.repeat(65)}`, `golang@sha256:${'A'.repeat(64)}`, `golang@sha512:${zeros}`,
    `golang@sha256:${zeros}\n`, ` golang@sha256:${zeros}`, `-golang@sha256:${zeros}`, `golang:@sha256:${zeros}`, `golang:1.25 @sha256:${zeros}`,
    `golang:${'a'.repeat(129)}@sha256:${zeros}`, `golang@sha256:${zeros}@sha256:${zeros}`,
  ];
  for (const image of refused) {
    assert.match(pTaskProblems({ ...P01, image }).join('; '), /^image .* is not an official image pinned by digest$/, JSON.stringify(image));
  }
  for (const image of [`golang@sha256:${zeros}`, `docker.io/library/golang@sha256:${zeros}`, `golang:1.25@sha256:${zeros}`,
    `python:3.13-slim@sha256:${'ab'.repeat(32)}`, `golang:${'a'.repeat(128)}@sha256:${zeros}`]) {
    assert.deepEqual(pTaskProblems({ ...P01, image }), [], image);
  }
});

// Ruling 2: gold and tests are plain files (by lstat); a directory named like one is not.
test('a gold or tests path naming a directory is not a plain file', () => {
  for (const field of ['gold', 'tests']) {
    const { dir, task } = pDir();
    rmSync(join(dir, task[field]));
    mkdirSync(join(dir, task[field]));
    assert.match(pTaskProblems(task, { dir }).join('; '), new RegExp(`^${field} .* is not a plain file`), field);
    assert.throws(() => makeStage({ dir, task, change: null }), new RegExp(`P01: ${field} .* is not a plain file`), field);
    assert.throws(() => proofInputs({ dir, task }), new RegExp(`P01: ${field} .* is not a plain file`), field);
  }
});

// Plan, `prepareImage`: "every FROM line of <D>/<build>/Dockerfile (…) must equal image, else throw".
test('every FROM of the build Dockerfile names the task\'s image, whatever its flags, case or stage name', async () => {
  const accepted = [
    `from ${IMAGE}\nRUN true\n`,
    `FROM --platform=linux/amd64 ${IMAGE} AS build\nRUN true\nFROM ${IMAGE} AS final\n`,
    `  FROM\t${IMAGE}\r\nRUN true\r\n`,
  ];
  for (const text of accepted) {
    const { dir, task, fake, env } = setup({ task: { build: 'suites/P/P01/build' } });
    put(dir, 'suites/P/P01/build/Dockerfile', text);
    const got = await prepareImage({ dir, task, docker: fake.bin, env, out: quiet });
    assert.equal(got.built, true, JSON.stringify(text));
    assert.ok(fake.log().some((a) => a[0] === 'build'), JSON.stringify(text));
  }
  const refused = [
    ['scratch', 'FROM scratch\n'], ['a lowercase other image', 'from other:1\n'], ['a tag without the digest', 'FROM golang:1.25\n'],
    ['another digest', `FROM ${OTHER_IMAGE}\n`], ['a flagged other image with a stage name', `FROM --platform=linux/amd64 other@sha256:${'0'.repeat(64)} AS x\n`],
    ['an argument', 'ARG BASE\nFROM $BASE\n'], ['the second of three', `FROM ${IMAGE}\nFROM ${IMAGE}\nFROM ${OTHER_IMAGE}\n`],
  ];
  for (const [name, text] of refused) {
    const { dir, task, fake, env } = setup({ task: { build: 'suites/P/P01/build' } });
    put(dir, 'suites/P/P01/build/Dockerfile', text);
    await assert.rejects(prepareImage({ dir, task, docker: fake.bin, env, out: quiet }), /^Error: P01: the Dockerfile builds FROM .*, not the task's image$/, name);
    assert.deepEqual(fake.log(), [], `${name}: refused before docker is called`);
  }
});

// Plan, `testFiles` and `linesChanged`.
test('testFiles and linesChanged on a rename, a path with a space, a binary patch, a missing trailing newline and a note about one', () => {
  const diff = [
    'diff --git a/old name.txt b/new name.txt',
    'similarity index 80%',
    'rename from old name.txt',
    'rename to new name.txt',
    '--- a/old name.txt',
    '+++ b/new name.txt',
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-before',
    '+after',
    '\\ No newline at end of file',
    'diff --git a/img.png b/img.png',
    'index 1111111..2222222 100644',
    'GIT binary patch',
    'literal 3',
    'KcmZQz00031',
    '',
    'literal 0',
    'HcmV?d00000',
    '',
    'diff --git a/pic.gif b/pic.gif',
    'Binary files a/pic.gif and b/pic.gif differ',
    'diff --git a/last.txt b/last.txt',
    '--- a/last.txt',
    '+++ b/last.txt',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ].join('\n');
  assert.deepEqual(testFiles(diff), ['last.txt', 'new name.txt', 'old name.txt']);
  assert.equal(linesChanged(diff), 4, 'two lines of the rename, none of the binary patches, two of the last file');
  assert.equal(linesChanged(''), 0);
  assert.deepEqual(testFiles(''), []);
});

// Plan, `proofStatus`: `stale` — an unreadable proof is a proof of nothing.
test('a proof file that is truncated or not an object is stale, not ok', async () => {
  const { dir, task, fake, env } = setup();
  fake.addImage(IMAGE);
  await prove({ dir, task, docker: fake.bin, env, reps: 1, out: quiet });
  const file = join(dir, 'checks', 'proofs', 'P01.json');
  const whole = readFileSync(file, 'utf8');
  assert.equal(proofStatus({ dir, task }), 'ok');
  for (const text of [whole.slice(0, whole.length >> 1), 'null', '[]', '', '{"ok":true}']) {
    writeFileSync(file, text);
    assert.equal(proofStatus({ dir, task }), 'stale', JSON.stringify(text.slice(0, 20)));
  }
  assert.equal(lstatSync(file).isFile(), true);
});

// A docker of its own that delegates to the fake: it can delay the first `run` and records the DOCKER_HOST it was started with.
function wrapperDocker({ home, fake, delayFirstRunMs = 0 }) {
  const bin = join(home, 'docker-wrapper');
  const counter = join(home, 'wrapper-runs');
  const seenHost = join(home, 'wrapper-host');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(seenHost)}, String(process.env.DOCKER_HOST) + '\\n');
if (process.argv[2] === 'run') {
  const n = (fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0) + 1;
  fs.writeFileSync(${JSON.stringify(counter)}, String(n));
  if (n === 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayFirstRunMs});
}
const r = require('child_process').spawnSync(${JSON.stringify(fake.bin)}, process.argv.slice(2), { stdio: 'inherit', timeout: 4000 });
process.exit(r.status);
`);
  chmodSync(bin, 0o755);
  return { bin, hosts: () => readFileSync(seenHost, 'utf8').split('\n').filter(Boolean) };
}

// Plan, `prove`: "`timeoutS` (optional, 1–3600, default 600) bounds each container step"; `docker` is the operator's own tool, run in the operator's environment.
test('a task with no timeoutS has the long default bound, and docker is started in the operator\'s environment', async () => {
  const { timeoutS, ...unbounded } = P01;
  const { dir, task, fake, home, env } = setup({ task: { ...unbounded, timeoutS: undefined } });
  fake.addImage(IMAGE);
  const wrapper = wrapperDocker({ home, fake, delayFirstRunMs: 1500 });
  const proof = await prove({ dir, task, docker: wrapper.bin, env: { ...env, DOCKER_HOST: 'tcp://invented.invalid:1' }, reps: 1, out: quiet });
  assert.equal(proof.ok, true, 'a step of 1.5 s is far inside the default bound');
  assert.ok(wrapper.hosts().length >= 7 && wrapper.hosts().every((h) => h === 'tcp://invented.invalid:1'), wrapper.hosts().join(' '));
});

// Plan, `runStep`: no bound, no container.
test('runStep refuses a bound that is no bound', async () => {
  const { dir, task, fake, env } = setup();
  const stage = makeStage({ dir, task, change: null });
  try {
    for (const timeoutS of [0, -1, 1.5, NaN, '5', null, undefined]) {
      await assert.rejects(runStep({ docker: fake.bin, imageId: idOf(IMAGE), stage, step: 'apply', timeoutS, env }), /runStep needs timeoutS/, String(timeoutS));
    }
    assert.deepEqual(fake.log(), []);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

// Plan: the image id is what `docker image inspect` prints, and the only thing a step is started with (argv, after `--entrypoint /bin/sh`).
test('an image id that is not `sha256:` and 64 hex is refused, whatever else docker prints', async () => {
  for (const printed of ['--privileged', 'sha256:abc', `sha256:${'0'.repeat(63)}`, `sha256:${'0'.repeat(64)}\n--privileged`, `sha256:${'g'.repeat(64)}`,
    `--network host sha256:${'0'.repeat(64)}`, `${'x'.repeat(2000)}`]) {
    const { dir, task, home } = setup();
    const bin = join(home, 'docker-hostile');
    const log = join(home, 'hostile-log');
    writeFileSync(bin, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.argv[2] === 'image') process.stdout.write(${JSON.stringify(printed)});\nprocess.exit(0);\n`);
    chmodSync(bin, 0o755);
    await assert.rejects(prove({ dir, task, docker: bin, env: { PATH: process.env.PATH, HOME: home }, reps: 1, out: quiet }), /docker image inspect printed no image id/, JSON.stringify(printed.slice(0, 30)));
    assert.deepEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)[0]), ['image'], 'nothing is run');
  }
});

// Plan, `pTaskProblems`: relative paths under third-party/ and suites/P/ — a sibling directory whose name starts the same is not under.
test('pTaskProblems reads a path lexically: a sibling that starts like third-party/ or suites/P/ is not under it, and a field of the wrong type is a message', () => {
  for (const tree of ['third-party2/p01', 'third-party-x/p01']) assert.match(pTaskProblems({ ...P01, tree }).join('; '), /^tree .* strictly under/, tree);
  for (const field of ['gold', 'tests']) assert.match(pTaskProblems({ ...P01, [field]: 'suites/P2/x.diff' }).join('; '), new RegExp(`^${field} .* strictly under`), field);
  assert.match(pTaskProblems({ ...P01, build: 'suites/P2/build' }).join('; '), /^build .* strictly under/);
  for (const field of ['prompt', 'failToPass', 'passToPass']) {
    for (const value of [undefined, 5, null, ['x'], {}]) assert.deepEqual(pTaskProblems({ ...P01, [field]: value }), [`needs a non-empty ${field}`], `${field} ${JSON.stringify(value)}`);
  }
  for (const line of [null, undefined, [], 'P01', 5]) assert.deepEqual(pTaskProblems(line), ['not a JSON object'], JSON.stringify(line));
});

// Plan, `readPTasks`: "validated lines".
test('readPTasks checks each line against the private dir, not only as written', () => {
  const { dir, task } = pDir();
  rmSync(join(dir, P01.gold));
  put(dir, 'suites/P/P01/real.diff', GOLD);
  symlinkSync('real.diff', join(dir, P01.gold));
  assert.throws(() => readPTasks(dir), /task P01: gold .* is not a plain file/);
  rmSync(join(dir, P01.gold));
  assert.throws(() => readPTasks(dir), /task P01: gold .* is not a plain file/);
  put(dir, P01.gold, GOLD);
  assert.deepEqual(readPTasks(dir), [task]);
});

// Plan: "every `FROM` line ... must equal image" — a FROM indented or after a tab is still a FROM.
test('an indented FROM naming another image is refused', async () => {
  for (const text of [`FROM ${IMAGE}\n   FROM other:1\n`, `FROM ${IMAGE}\n\tfrom other:1 AS x\n`, `  FROM other:1\n`]) {
    const { dir, task, fake, env } = setup({ task: { build: 'suites/P/P01/build' } });
    put(dir, 'suites/P/P01/build/Dockerfile', text);
    await assert.rejects(prepareImage({ dir, task, docker: fake.bin, env, out: quiet }), /the Dockerfile builds FROM other:1, not the task's image/, JSON.stringify(text));
    assert.deepEqual(fake.log(), []);
  }
});

// Plan, `makeStage`: `test-files` is "the paths tests.diff touches, one per line" — read by `read -r` in RUN_SH.
test('test-files holds one path per line, for any number of files', () => {
  const { dir, task } = pDir();
  const two = (path) => [`--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', '-a', '+b', ''].join('\n');
  writeFileSync(join(dir, P01.tests), `${two('widget/widget_test.go')}${two('other dir/other_test.go')}${two('z.go')}`);
  const stage = makeStage({ dir, task, change: null });
  try {
    assert.equal(readFileSync(join(stage, 'test-files'), 'utf8'), 'other dir/other_test.go\nwidget/widget_test.go\nz.go\n');
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

// The implementer's own test of this builds the second odd directory under the first one's TMPDIR, so its `=` case also holds a `,`.
test('a stage path holding only "=", or only ",", is refused', () => {
  const { dir, task } = pDir();
  const was = process.env.TMPDIR;
  const roots = ['a=b', 'a,b'].map((name) => { const odd = join(tmp('omelette-evals-dodd-'), name); mkdirSync(odd); return odd; });
  try {
    for (const odd of roots) {
      process.env.TMPDIR = odd;
      assert.throws(() => makeStage({ dir, task, change: null }), /holds "," or "="/, odd);
      assert.deepEqual(readdirSync(odd), [], 'no stage is left behind');
    }
  } finally {
    if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
  }
});

test('no test of this file reached a binary named plain docker', () => {
  assert.equal(existsSync(join(TRIPWIRE, 'reached')), false);
});
