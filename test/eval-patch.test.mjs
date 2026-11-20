// scripts/eval-patch.mjs — suite P's gold proof (plan docs/superpowers/plans/2026-11-19-evals-neon.md, T15).
// Docker is a FAKE (test/fixtures/fake-docker.mjs), reached through OMELETTE_EVALS_DOCKER or handed in as
// `docker`: no test needs a daemon or the network, and every tree, diff and task line below is invented.
// A tripwire named plain `docker` stands first on every PATH handed out here; the last test reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dockerRunArgs, linesChanged, main, makeStage, prepareImage, proofInputs, proofStatus, prove, pTaskProblems, readPTasks, RUN_SH, runStep, testFiles,
} from '../scripts/eval-patch.mjs';
import { fakeDocker } from './fixtures/fake-docker.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'eval-patch.mjs');

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const quiet = () => {};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A `docker` that only records that it was reached: first on PATH, so a call to plain `docker` lands here. */
const TRIPWIRE = tmp('omelette-evals-tripwire-');
writeFileSync(join(TRIPWIRE, 'docker'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(join(TRIPWIRE, 'reached'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(99);\n`);
chmodSync(join(TRIPWIRE, 'docker'), 0o755);

const IMAGE = `golang@sha256:${'0'.repeat(64)}`;
/** The fake's id of an image it holds. */
const idOf = (ref) => `sha256:${sha256(ref)}`;

// A step is bounded at 5 s here, not the 600 of a real task line: no child of a test may outlive that.
const P01 = {
  id: 'P01', prompt: 'Invented bug report: the widget drops its last item.', tree: 'third-party/p01/before-fix', image: IMAGE, build: null,
  gold: 'suites/P/P01/gold.diff', tests: 'suites/P/P01/tests.diff',
  failToPass: "go test ./widget -run '^TestInventedLastItem$'", passToPass: 'go test ./widget', timeoutS: 5,
};
const WIDGET = 'package widget\n\nfunc Last(items []string) string { return "" }\n';
const WIDGET_TEST = 'package widget\n\nimport "testing"\n';
const goldWith = (marker) => [
  'diff --git a/widget/widget.go b/widget/widget.go',
  '--- a/widget/widget.go',
  '+++ b/widget/widget.go',
  '@@ -1,3 +1,4 @@',
  ' package widget',
  ' ',
  `+// ${marker}`,
  ' func Last(items []string) string { return "" }',
  '',
].join('\n');
const GOLD = goldWith('FAKE: fixes');
const TESTS = [
  'diff --git a/widget/widget_test.go b/widget/widget_test.go',
  '--- a/widget/widget_test.go',
  '+++ b/widget/widget_test.go',
  '@@ -1,3 +1,5 @@',
  ' package widget',
  ' ',
  ' import "testing"',
  '+',
  '+func TestInventedLastItem(t *testing.T) {}',
  '',
].join('\n');

function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** A private dir with the one P task: its tree, its gold and tests diffs, its task line. */
function pDir({ task = {}, gold = GOLD } = {}) {
  const dir = tmp('omelette-evals-pdir-');
  const line = { ...P01, ...task };
  put(dir, `${P01.tree}/widget/widget.go`, WIDGET);
  put(dir, `${P01.tree}/widget/widget_test.go`, WIDGET_TEST);
  put(dir, P01.gold, gold);
  put(dir, P01.tests, TESTS);
  put(dir, 'suites/P/tasks.jsonl', `${JSON.stringify(line)}\n`);
  return { dir, task: line };
}

/** The dir, a fake docker of its own, and the env that reaches it (and the tripwire before any other `docker`). */
function setup(opts) {
  const { dir, task } = pDir(opts);
  const home = tmp('omelette-evals-home-');
  const fake = fakeDocker(home);
  return { dir, task, fake, env: { PATH: `${TRIPWIRE}:${process.env.PATH}`, HOME: home, OMELETTE_EVALS_DOCKER: fake.bin } };
}

const cli = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
const calls = (fake) => fake.log().map((a) => (a[0] === 'image' ? `image ${a[1]}` : a[0]));
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const stageOf = (argv) => /^type=bind,source=([^,]+),/.exec(after(argv, '--mount'))[1];
const proofAt = (dir, id = 'P01') => JSON.parse(readFileSync(join(dir, 'checks', 'proofs', `${id}.json`), 'utf8'));
const runs = (n) => Array(n).fill('run');

/** Every plain file under `root`, as [relative path, text]; a link is not followed. */
function plainFiles(root) {
  const found = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else if (e.isFile()) found.push([r, readFileSync(join(d, e.name), 'utf8')]);
    }
  };
  walk(root, '');
  return found;
}

test('prove: three repetitions, F2P failing on the snapshot and passing with the gold, P2P passing both ways', async () => {
  const { dir, task, fake, env } = setup();
  const printed = [];
  const code = await main(['prove', '--task', 'P01', '--dir', dir], { out: (l) => printed.push(l), err: (l) => printed.push(l), env });
  assert.equal(code, 0, printed.join('\n'));
  const proof = proofAt(dir);
  assert.equal(proof.ok, true);
  assert.deepEqual(proof.reps.map((r) => [r.rep, r.ok]), [[1, true], [2, true], [3, true]]);
  assert.deepEqual([proof.task, proof.goldLines, proof.image, proof.imageId, proof.built], ['P01', 1, IMAGE, idOf(IMAGE), false]);
  assert.equal(proof.inputs, proofInputs({ dir, task }));
  assert.ok(!Number.isNaN(Date.parse(proof.provedAt)));
  const { snapshot, gold } = proof.reps[0];
  assert.deepEqual(snapshot.apply, { exit: 0, method: 'none' });
  assert.deepEqual(gold.apply, { exit: 0, method: 'git' });
  assert.deepEqual([snapshot.failToPass.exit, snapshot.failToPass.timedOut, snapshot.passToPass.exit, snapshot.passToPass.timedOut], [1, false, 0, false]);
  assert.deepEqual([gold.failToPass.exit, gold.passToPass.exit], [0, 0]);
  assert.equal(typeof gold.passToPass.ms, 'number');
  assert.equal(fake.runs().length, 18);
  assert.deepEqual(calls(fake), ['image inspect', 'pull', 'image inspect', ...runs(18)]);
  const state = (change) => [['apply', change], ['f2p', change], ['p2p', change]];
  assert.deepEqual(fake.stages().map((s) => [s.step, s.contents['change.diff'] ?? null]), [1, 2, 3].flatMap(() => [...state(null), ...state(GOLD)]));
  assert.ok(printed.includes('P01 rep 1: snapshot F2P exit 1, P2P exit 0 · gold applies (git), F2P exit 0, P2P exit 0 — ok'), printed.join('\n'));
  assert.equal(statSync(join(dir, 'checks', 'proofs', 'P01.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'checks', 'proofs')).mode & 0o777, 0o700);
});

test('every container step is the profile: no network, no pull, removed, one read-only mount, no capabilities', async () => {
  // The whole argv, flag by flag: the fake never enforces one, so nothing else would notice a flag gone.
  assert.deepEqual(dockerRunArgs({ imageId: 'sha256:aa', stage: '/invented/stage', name: 'omelette-evals-1-00000000', step: 'f2p', uid: 501, gid: 20 }), [
    'run', '--rm', '--pull', 'never', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '1024', '--memory', '4g', '--cpus', '2', '--user', '501:20', '--env', 'HOME=/tmp',
    '--mount', 'type=bind,source=/invented/stage,target=/task,readonly', '--name', 'omelette-evals-1-00000000', '--entrypoint', '/bin/sh',
    'sha256:aa', '/task/run.sh', 'f2p',
  ]);
  // The in-container half is never executed here either: a changed line of it is a change to the sandbox.
  assert.equal(sha256(RUN_SH), 'cd98eaa39d2f54e2a26cbf209a58e8da92cc7e54ccf19a67a796f84c3a2d1e74', 'RUN_SH is not the script the plan prints: re-read the profile before moving this digest');

  const { dir, task, fake, env } = setup();
  fake.addImage(IMAGE);
  await prove({ dir, task, docker: fake.bin, env, reps: 1, out: quiet });
  const logged = fake.runs();
  assert.equal(logged.length, 6);
  for (const argv of logged) {
    const stage = stageOf(argv);
    const name = after(argv, '--name');
    assert.deepEqual(argv, dockerRunArgs({ imageId: idOf(IMAGE), stage, name, step: argv[argv.length - 1], uid: process.getuid(), gid: process.getgid() }));
    assert.match(name, new RegExp(`^omelette-evals-${process.pid}-[0-9a-f]{8}$`));
    assert.ok(stage.startsWith(join(tmpdir(), 'omelette-evals-p-')), stage);
    assert.equal(existsSync(stage), false, 'a stage is removed after its steps');
    assert.equal(after(argv, '--network'), 'none');
    assert.equal(after(argv, '--pull'), 'never');
    assert.equal(after(argv, '--cap-drop'), 'ALL');
    assert.ok(argv.includes('--rm'));
    assert.deepEqual(argv.filter((a) => a === '--mount').length, 1);
    assert.ok(after(argv, '--mount').endsWith(',target=/task,readonly'));
    for (const flag of ['-v', '--volume', '--privileged']) assert.ok(!argv.some((a) => a === flag || a.startsWith(`${flag}=`)), flag);
  }
  assert.equal(new Set(logged.map((a) => after(a, '--name'))).size, 6);
  assert.deepEqual(logged.map((a) => a[a.length - 1]), ['apply', 'f2p', 'p2p', 'apply', 'f2p', 'p2p']);
  assert.ok(fake.stages().every((s) => s.contents['run.sh'] === RUN_SH));
});

test('the network is used only to get the image', async () => {
  const absent = setup();
  await prove({ dir: absent.dir, task: absent.task, docker: absent.fake.bin, env: absent.env, reps: 1, out: quiet });
  assert.deepEqual(calls(absent.fake), ['image inspect', 'pull', 'image inspect', ...runs(6)]);
  assert.deepEqual(absent.fake.log().slice(0, 2), [['image', 'inspect', '--format', '{{.Id}}', IMAGE], ['pull', IMAGE]]);

  const present = setup();
  present.fake.addImage(IMAGE);
  await prove({ dir: present.dir, task: present.task, docker: present.fake.bin, env: present.env, reps: 1, out: quiet });
  assert.deepEqual(calls(present.fake), ['image inspect', ...runs(6)]);

  const built = setup({ task: { build: 'suites/P/P01/build' } });
  put(built.dir, 'suites/P/P01/build/Dockerfile', `FROM ${IMAGE}\nRUN true\n`);
  const proof = await prove({ dir: built.dir, task: built.task, docker: built.fake.bin, env: built.env, reps: 1, out: quiet });
  assert.deepEqual(calls(built.fake), ['image inspect', 'pull', 'image inspect', 'build', 'image inspect', ...runs(6)]);
  const inputs = proofInputs({ dir: built.dir, task: built.task });
  assert.match(inputs, /^[0-9a-f]{16}$/);
  const tag = `omelette-evals-p01:${inputs}`;
  assert.deepEqual(built.fake.log().find((a) => a[0] === 'build'), ['build', '--pull=false', '-t', tag, join(built.dir, 'suites', 'P', 'P01', 'build')]);
  assert.deepEqual([proof.built, proof.imageId, proof.ok], [true, idOf(tag), true]);
  assert.ok(built.fake.runs().every((a) => a[a.length - 3] === idOf(tag)), 'the steps run the built image');

  const other = setup({ task: { build: 'suites/P/P01/build' } });
  put(other.dir, 'suites/P/P01/build/Dockerfile', `FROM ${IMAGE}\nFROM --platform=linux/amd64 someone/tool:1 AS second\n`);
  await assert.rejects(prove({ dir: other.dir, task: other.task, docker: other.fake.bin, env: other.env, reps: 1, out: quiet }),
    /P01: the Dockerfile builds FROM someone\/tool:1, not the task's image/);
  assert.ok(!calls(other.fake).some((c) => c === 'build' || c === 'run'));

  const offline = setup();
  offline.fake.noPull();
  await assert.rejects(prove({ dir: offline.dir, task: offline.task, docker: offline.fake.bin, env: offline.env, reps: 1, out: quiet }), /P01: docker pull/);
  assert.deepEqual(calls(offline.fake), ['image inspect', 'pull']);
  assert.equal(existsSync(join(offline.dir, 'checks')), false);
});

test('one flaky repetition fails the proof and the task is dropped', async () => {
  const { dir, fake, env } = setup();
  fake.addImage(IMAGE);
  fake.flipF2pAt(3);
  const printed = [];
  const code = await main(['prove', '--task', 'P01', '--dir', dir], { out: (l) => printed.push(l), err: (l) => printed.push(l), env });
  assert.equal(code, 1);
  const proof = proofAt(dir);
  assert.equal(proof.ok, false);
  assert.deepEqual(proof.reps.map((r) => r.ok), [true, false, true]);
  assert.equal(proof.reps[1].snapshot.failToPass.exit, 0);
  assert.equal(fake.runs().length, 18);
  assert.ok(printed.includes('P01 rep 2: snapshot F2P exit 0, P2P exit 0 · gold applies (git), F2P exit 0, P2P exit 0 — FAILED'), printed.join('\n'));
});

test('a gold patch that does not apply fails the proof', async () => {
  const { dir, task, fake, env } = setup({ gold: goldWith('FAKE: does-not-apply') });
  fake.addImage(IMAGE);
  const printed = [];
  const proof = await prove({ dir, task, docker: fake.bin, env, reps: 1, out: (l) => printed.push(l) });
  assert.deepEqual(fake.runs().map((a) => a[a.length - 1]), ['apply', 'f2p', 'p2p', 'apply']);
  assert.equal(proof.ok, false);
  assert.deepEqual(proof.reps[0].gold, { apply: { exit: 121, method: null }, failToPass: null, passToPass: null });
  assert.equal(proofAt(dir).ok, false);
  assert.ok(printed.some((l) => /^P01 rep 1: .* · gold does not apply, .* — FAILED$/.test(l)), printed.join('\n'));
});

test('an image that is not an official one pinned by digest is refused before docker is called', () => {
  for (const image of [`someone/tool@sha256:${'0'.repeat(64)}`, 'python:3.13']) {
    const { dir, fake, env } = setup({ task: { image } });
    const r = cli(['prove', '--task', 'P01', '--dir', dir], env);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /task P01: .*not an official image pinned by digest/);
    assert.deepEqual(fake.log(), []);
  }
});

test('a task with a model\'s diff already filed is not proven again', async () => {
  const runLine = (id) => `${JSON.stringify({ suite: 'P', taskIds: [id], arm: 'gemini:Invented Model (High)', run: 1, ok: true, answer: 'An invented answer.' })}\n`;
  const { dir, fake, env } = setup();
  put(dir, 'runs/2026-11-20/P-x.jsonl', runLine('P01'));
  const r = cli(['prove', '--task', 'P01', '--dir', dir], env);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /P01: a model's diff already exists/);
  assert.deepEqual(fake.log(), []);
  assert.equal(existsSync(join(dir, 'checks')), false);

  // Another task's run line is not this task's: a reserve task is proven after the first ones ran.
  const later = setup();
  later.fake.addImage(IMAGE);
  put(later.dir, 'runs/2026-11-20/P-x.jsonl', runLine('P02'));
  const proof = await prove({ dir: later.dir, task: later.task, docker: later.fake.bin, env: later.env, reps: 1, out: quiet });
  assert.equal(proof.ok, true);
});

test('a proof goes stale when its task changes', async () => {
  const { dir, task, fake, env } = setup();
  fake.addImage(IMAGE);
  await prove({ dir, task, docker: fake.bin, env, reps: 1, out: quiet });
  assert.equal(proofStatus({ dir, task }), 'ok');
  assert.equal(proofStatus({ dir, task: { ...task, id: 'P02' } }), 'missing');
  const file = join(dir, 'checks', 'proofs', 'P01.json');
  writeFileSync(file, JSON.stringify({ ...proofAt(dir), ok: false }));
  assert.equal(proofStatus({ dir, task }), 'failed');
  writeFileSync(join(dir, P01.gold), GOLD.replace('FAKE: fixes', 'FAKE: fixes, reworded'));
  assert.equal(proofStatus({ dir, task }), 'stale');
});

test('testFiles and linesChanged read headers, not removed lines that look like them', () => {
  const diff = [
    'diff --git a/notes/a.sql b/notes/a.sql',
    '--- a/notes/a.sql',
    '+++ b/notes/a.sql',
    '@@ -1,3 +1,3 @@',
    ' select 1;',
    '--- invented comment',
    '+-- another invented comment',
    ' select 2;',
    'diff --git a/notes/new.txt b/notes/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/notes/new.txt\t2026-11-20 00:00:00',
    '@@ -0,0 +1 @@',
    '+an invented line',
    'diff --git a/notes/old.txt b/notes/old.txt',
    'deleted file mode 100644',
    '--- a/notes/old.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-an invented line',
    '',
  ].join('\n');
  assert.deepEqual(testFiles(diff), ['notes/a.sql', 'notes/new.txt', 'notes/old.txt']);
  assert.equal(linesChanged(diff), 4);
  assert.throws(() => testFiles('--- "a/notes/na me.txt"\n+++ "b/notes/na me.txt"\n'), /a quoted path in the tests diff/);
});

test('a step past its timeout is killed, removed and recorded as timed out', async () => {
  const { dir, task, fake, env } = setup();
  fake.addImage(IMAGE);
  const stage = makeStage({ dir, task, change: goldWith('FAKE: hangs') });
  try {
    const step = await runStep({ docker: fake.bin, imageId: idOf(IMAGE), stage, step: 'f2p', timeoutS: 1, env });
    assert.deepEqual([step.timedOut, step.exit], [true, null]);
    assert.ok(step.ms >= 900, `the step ran to its bound, not past a kill at once: ${step.ms} ms`);
    const [run, kill] = fake.log();
    assert.ok(run.includes('--rm'));
    assert.match(after(run, '--name'), /^omelette-evals-\d+-[0-9a-f]{8}$/);
    assert.deepEqual(kill, ['kill', after(run, '--name')]);
    // A step with no bound is not started at all (`apply`: were it started, the fake would answer at once, not hang).
    await assert.rejects(runStep({ docker: fake.bin, imageId: idOf(IMAGE), stage, step: 'apply', env }), /runStep needs timeoutS/);
    assert.equal(fake.log().length, 2);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test('a task line is sound field by field: its id names a proof file and an image tag', () => {
  for (const id of ['', '../P01', 'P/01', '.P01', 'P 01', 7]) {
    assert.match(pTaskProblems({ ...P01, id }).join('; '), /^id .* is not a task id/, JSON.stringify(id));
  }
  for (const field of ['prompt', 'failToPass', 'passToPass']) {
    assert.deepEqual(pTaskProblems({ ...P01, [field]: ' ' }), [`needs a non-empty ${field}`]);
  }
  for (const timeoutS of [0, 3601, 1.5, '600', null]) {
    assert.match(pTaskProblems({ ...P01, timeoutS }).join('; '), /^timeoutS .* is not a whole number from 1 to 3600$/, JSON.stringify(timeoutS));
  }
  const { timeoutS, build, ...bare } = P01;
  assert.deepEqual(pTaskProblems(bare), [], 'timeoutS and build are optional');
  assert.deepEqual(pTaskProblems({ ...P01, timeoutS: 3600, image: `docker.io/library/golang:1.25@sha256:${'a'.repeat(64)}` }), []);

  const { dir, task } = pDir();
  assert.deepEqual(readPTasks(dir), [task]);
  put(dir, 'suites/P/tasks.jsonl', `${JSON.stringify(task)}\n${JSON.stringify(task)}\n`);
  assert.throws(() => readPTasks(dir), /task P01: a second task with this id/);
});

test('a usage error exits 2 before anything is read', async () => {
  const { dir, fake, env } = setup();
  for (const argv of [[], ['check', '--task', 'P01'], ['prove'], ['prove', '--dir', dir], ['prove', '--task', 'P01', '--reps', '1'], ['prove', 'P01']]) {
    const printed = [];
    assert.equal(await main(argv, { out: quiet, err: (l) => printed.push(l), env }), 2, argv.join(' '));
    assert.match(printed.join('\n'), /usage: node scripts\/eval-patch\.mjs prove --task ID/);
  }
  const printed = [];
  assert.equal(await main(['prove', '--task', 'P09', '--dir', dir], { out: quiet, err: (l) => printed.push(l), env }), 1);
  assert.match(printed.join('\n'), /P09: suite P has no such task/);
  assert.deepEqual(fake.log(), []);
});

test('a tree sits strictly under third-party/, as written and as the kernel resolves it', async () => {
  assert.deepEqual(pTaskProblems(P01), []);
  for (const tree of ['.', 'third-party', 'third-party/', 'third-party/..', 'third-party/../suites/P/P01', 'suites/P/P01', '../third-party/p01', '/third-party/p01', '', null]) {
    assert.match(pTaskProblems({ ...P01, tree }).join('; '), /^tree .* strictly under/, JSON.stringify(tree));
  }

  // `third-party` is a link to `suites`: the tree as written would be the gold's own directory.
  const linked = setup();
  rmSync(join(linked.dir, 'third-party'), { recursive: true });
  put(linked.dir, 'suites/P/P01/widget/widget.go', WIDGET);
  symlinkSync('suites', join(linked.dir, 'third-party'));
  const task = { ...P01, tree: 'third-party/P/P01' };
  put(linked.dir, 'suites/P/tasks.jsonl', `${JSON.stringify(task)}\n`);
  assert.throws(() => makeStage({ dir: linked.dir, task, change: null }), /P01: third-party\/ is reached through a link/);
  const printed = [];
  assert.equal(await main(['prove', '--task', 'P01', '--dir', linked.dir], { out: quiet, err: (l) => printed.push(l), env: linked.env }), 1);
  assert.match(printed.join('\n'), /reached through a link/);
  assert.deepEqual(linked.fake.log(), []);

  // A link in the path to the tree, and the tree itself a link.
  const { dir } = pDir();
  symlinkSync('../suites', join(dir, 'third-party', 'px'));
  assert.throws(() => makeStage({ dir, task: { ...P01, tree: 'third-party/px/P/P01' }, change: null }), /tree third-party\/px\/P\/P01 leads out of third-party\/ through a link/);
  symlinkSync('../../suites/P/P01', join(dir, 'third-party', 'p01', 'linked'));
  assert.throws(() => makeStage({ dir, task: { ...P01, tree: 'third-party/p01/linked' }, change: null }), /tree third-party\/p01\/linked is not a directory/);

  // A `..` behind a link: read as text, `hop/../inner` is third-party/inner; the kernel goes to hop's target first, and lands in suites/.
  put(dir, 'third-party/inner/t/decoy.go', WIDGET);
  put(dir, 'suites/inner/t/key.jsonl', '{"id":"R01","answer":"Invented key answer."}\n');
  symlinkSync('../suites/P', join(dir, 'third-party', 'hop'));
  symlinkSync('hop/../inner', join(dir, 'third-party', 'pz'));
  assert.deepEqual(readdirSync(join(dir, 'third-party', 'pz', 't')), ['key.jsonl'], 'the kernel does land outside');
  assert.throws(() => makeStage({ dir, task: { ...P01, tree: 'third-party/pz/t' }, change: null }), /tree third-party\/pz\/t leads out of third-party\/ through a link/);
});

test('gold and tests are plain .diff files under suites/P/, and a build directory there holds its own Dockerfile', async () => {
  for (const field of ['gold', 'tests']) {
    for (const path of ['suites/P/P01/gold.txt', 'suites/R/key.diff', 'suites/P', 'suites/P/../R/key.diff', 'third-party/p01/before-fix/x.diff', '/suites/P/P01/gold.diff', null]) {
      assert.match(pTaskProblems({ ...P01, [field]: path }).join('; '), new RegExp(`^${field} .* \\.diff file strictly under`), `${field} ${path}`);
    }
  }
  for (const build of ['.', 'suites/P', 'suites/P/..', 'third-party/p01', '/suites/P/P01/build']) {
    assert.match(pTaskProblems({ ...P01, build }).join('; '), /^build .* strictly under/, build);
  }

  // A link named gold.diff or tests.diff could put any file of the private dir into a proof or a stage.
  const { dir, task } = pDir();
  rmSync(join(dir, P01.gold));
  put(dir, 'suites/P/P01/real.diff', GOLD);
  symlinkSync('real.diff', join(dir, P01.gold));
  assert.match(pTaskProblems(task, { dir }).join('; '), /^gold suites\/P\/P01\/gold\.diff is not a plain file/);
  assert.throws(() => proofInputs({ dir, task }), /P01: gold .* is not a plain file/);

  const keyed = pDir();
  put(keyed.dir, 'suites/R/key.jsonl', '{"id":"R01","answer":"Invented key answer."}\n');
  rmSync(join(keyed.dir, P01.tests));
  symlinkSync('../../R/key.jsonl', join(keyed.dir, P01.tests));
  assert.throws(() => makeStage({ dir: keyed.dir, task: keyed.task, change: null }), /P01: tests .* is not a plain file/);

  // A plain file by lstat, behind a directory that is a link out of suites/P/.
  const behind = pDir();
  put(behind.dir, 'elsewhere/gold.diff', GOLD);
  put(behind.dir, 'elsewhere/build/Dockerfile', `FROM ${IMAGE}\n`);
  symlinkSync('../../elsewhere', join(behind.dir, 'suites', 'P', 'Px'));
  assert.throws(() => proofInputs({ dir: behind.dir, task: { ...P01, gold: 'suites/P/Px/gold.diff' } }), /gold suites\/P\/Px\/gold\.diff leads out of suites\/P\/ through a link/);
  assert.throws(() => proofInputs({ dir: behind.dir, task: { ...P01, build: 'suites/P/Px/build' } }), /build suites\/P\/Px\/build leads out of suites\/P\/ through a link/);

  // The Dockerfile is the build directory's own file, and the directory is not a link.
  const built = setup({ task: { build: 'suites/P/P01/build' } });
  put(built.dir, 'suites/P/P01/build/real', `FROM ${IMAGE}\n`);
  symlinkSync('real', join(built.dir, 'suites', 'P', 'P01', 'build', 'Dockerfile'));
  await assert.rejects(prepareImage({ dir: built.dir, task: built.task, docker: built.fake.bin, env: built.env, out: quiet }), /P01: build .* holds no Dockerfile that is a plain file/);
  rmSync(join(built.dir, 'suites', 'P', 'P01', 'build'), { recursive: true });
  put(built.dir, 'third-party/p01/Dockerfile', `FROM ${IMAGE}\n`);
  symlinkSync('../../../third-party/p01', join(built.dir, 'suites', 'P', 'P01', 'build'));
  await assert.rejects(prepareImage({ dir: built.dir, task: built.task, docker: built.fake.bin, env: built.env, out: quiet }), /P01: build .* is not a directory/);
  assert.deepEqual(built.fake.log(), []);
});

test('a stage holds the task\'s tree and its own files: the gold only as a gold state\'s change, a link as a link', () => {
  const { dir, task } = pDir();
  const toGold = '../../../../suites/P/P01/gold.diff';
  symlinkSync(toGold, join(dir, P01.tree, 'widget', 'peek'));
  symlinkSync(join(dir, P01.gold), join(dir, P01.tree, 'widget', 'peek-absolute'));
  assert.equal(readFileSync(join(dir, P01.tree, 'widget', 'peek'), 'utf8'), GOLD, 'in the private dir the link does reach the gold');

  const snapshot = makeStage({ dir, task, change: null });
  const hostile = 'diff --git a/x b/x\n$(touch invented-marker); `touch invented-marker`; rm -rf "$HOME"\n';
  const model = makeStage({ dir, task, change: hostile });
  try {
    assert.ok(snapshot.startsWith(join(tmpdir(), 'omelette-evals-p-')), snapshot);
    assert.deepEqual(readdirSync(snapshot).sort(), ['f2p.cmd', 'p2p.cmd', 'run.sh', 'test-files', 'tests.diff', 'tree']);
    assert.deepEqual(readdirSync(model).sort(), ['change.diff', 'f2p.cmd', 'p2p.cmd', 'run.sh', 'test-files', 'tests.diff', 'tree']);
    assert.equal(readFileSync(join(model, 'change.diff'), 'utf8'), hostile);
    for (const stage of [snapshot, model]) {
      assert.equal(readFileSync(join(stage, 'tree', 'widget', 'widget.go'), 'utf8'), WIDGET);
      assert.equal(readFileSync(join(stage, 'tests.diff'), 'utf8'), TESTS);
      assert.equal(readFileSync(join(stage, 'test-files'), 'utf8'), 'widget/widget_test.go\n');
      assert.equal(readFileSync(join(stage, 'f2p.cmd'), 'utf8'), `${P01.failToPass}\n`);
      assert.equal(readFileSync(join(stage, 'p2p.cmd'), 'utf8'), `${P01.passToPass}\n`);
      assert.equal(readFileSync(join(stage, 'run.sh'), 'utf8'), RUN_SH);
      assert.equal(statSync(join(stage, 'run.sh')).mode & 0o777, 0o755);
      // The links are the tree's own text, not what they reach here: in a container they reach nothing of this machine.
      assert.ok(lstatSync(join(stage, 'tree', 'widget', 'peek')).isSymbolicLink());
      assert.equal(readlinkSync(join(stage, 'tree', 'widget', 'peek')), toGold);
      assert.equal(readlinkSync(join(stage, 'tree', 'widget', 'peek-absolute')), join(dir, P01.gold));
      assert.deepEqual(plainFiles(stage).filter(([, text]) => text.includes('FAKE: fixes')).map(([path]) => path), []);
    }
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
    rmSync(model, { recursive: true, force: true });
  }
});

test('a stage path a --mount would misread is refused', () => {
  const { dir, task } = pDir();
  const was = process.env.TMPDIR;
  try {
    for (const name of ['a,b', 'a=b']) {
      const odd = join(tmp('omelette-evals-odd-'), name);
      mkdirSync(odd);
      process.env.TMPDIR = odd;
      assert.throws(() => makeStage({ dir, task, change: null }), /holds "," or "="/);
      assert.deepEqual(readdirSync(odd), [], 'no stage is left behind');
    }
  } finally {
    if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
  }
});

test('no test reached a binary named plain docker', () => {
  assert.equal(existsSync(join(TRIPWIRE, 'reached')), false);
});
