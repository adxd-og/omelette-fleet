// scripts/eval-patch.mjs — suite P's gold proof (plan docs/superpowers/plans/2026-11-19-evals-neon.md, T15).
// Docker is a FAKE (test/fixtures/fake-docker.mjs), reached through OMELETTE_EVALS_DOCKER or handed in as
// `docker`: no test needs a daemon or the network, and every tree, diff and task line below is invented.
// A tripwire named plain `docker` stands first on every PATH handed out here; the last test reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALL_BOUNDS_S, dockerRunArgs, linesChanged, main, makeStage, prepareImage, proofInputs, proofStatus, prove, pTaskProblems, readPTasks, RUN_SH, runStep, testFiles,
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
const stagesIn = (tmpDir) => readdirSync(tmpDir).filter((n) => n.startsWith('omelette-evals-p-'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** `read()` every 25 ms until `done` says so or `ms` have passed: the last value read. */
async function until(read, done, ms) {
  const end = Date.now() + ms;
  let value = read();
  while (!done(value) && Date.now() < end) {
    await new Promise((r) => { setTimeout(r, 25); });
    value = read();
  }
  return value;
}

/** A docker that hands every call to the fake and, after its first `run`, does `afterFirstRun` (JavaScript; `fs` is there). */
function dockerThat({ home, fake, afterFirstRun }) {
  const bin = join(home, 'docker-that');
  const seen = join(home, 'docker-that-ran');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const r = require('child_process').spawnSync(${JSON.stringify(fake.bin)}, process.argv.slice(2), { stdio: 'inherit', timeout: 4000 });
if (process.argv[2] === 'run' && !fs.existsSync(${JSON.stringify(seen)})) {
  fs.writeFileSync(${JSON.stringify(seen)}, '');
  ${afterFirstRun}
}
process.exit(r.status);
`);
  chmodSync(bin, 0o755);
  return bin;
}

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
    '--pids-limit', '1024', '--memory', '4g', '--memory-swap', '4g', '--cpus', '2', '--user', '501:20', '--env', 'HOME=/tmp',
    '--mount', 'type=bind,source=/invented/stage,target=/task,readonly', '--name', 'omelette-evals-1-00000000', '--entrypoint', '/bin/sh',
    'sha256:aa', '/task/run.sh', 'f2p',
  ]);
  // The in-container half is never executed here either: a changed line of it is a change to the sandbox.
  assert.equal(sha256(RUN_SH), '02f51da4bf9dd56d3d5ba0623369d600e10f943d47150176b5203b30be1729e4', 'RUN_SH is not the script the plan and the fix round\'s rulings print: re-read the profile before moving this digest');
  // The lines the fix round ruled, as it printed them: a fuzz of 2 and no `.orig` left in the tree the tests run in; `./` before a restored path, so one that opens with `-` is no option.
  for (const ruled of [
    '  elif command -v patch >/dev/null 2>&1 && patch --batch --forward --fuzz=2 --no-backup-if-mismatch -p1 -i /task/change.diff >>/tmp/apply.err 2>&1; then',
    '  if [ -e "/task/tree/$f" ]; then\n    mkdir -p "$(dirname "./$f")" && cp "/task/tree/$f" "./$f" || exit 122\n  else\n    rm -f "./$f" || exit 122\n  fi',
  ]) assert.ok(RUN_SH.includes(`\n${ruled}\n`), ruled);

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

test('a proof is of its tree too: a file edited, added or renamed, or a link retargeted, makes it stale — and no link is followed', async () => {
  const { dir, task, fake, env } = setup();
  fake.addImage(IMAGE);
  const tree = join(dir, P01.tree);
  symlinkSync('widget.go', join(tree, 'widget', 'alias'));
  await prove({ dir, task, docker: fake.bin, env, reps: 1, out: quiet });
  const base = proofInputs({ dir, task });
  assert.equal(proofStatus({ dir, task }), 'ok');
  const edits = {
    'a file\'s bytes': [() => writeFileSync(join(tree, 'widget', 'widget.go'), `${WIDGET}// edited\n`), () => writeFileSync(join(tree, 'widget', 'widget.go'), WIDGET)],
    'a new file': [() => put(tree, 'widget/extra.go', WIDGET), () => rmSync(join(tree, 'widget', 'extra.go'))],
    'a renamed file': [() => renameSync(join(tree, 'widget', 'widget_test.go'), join(tree, 'widget', 'moved_test.go')), () => renameSync(join(tree, 'widget', 'moved_test.go'), join(tree, 'widget', 'widget_test.go'))],
    'a link\'s text': [
      () => { rmSync(join(tree, 'widget', 'alias')); symlinkSync('widget_test.go', join(tree, 'widget', 'alias')); },
      () => { rmSync(join(tree, 'widget', 'alias')); symlinkSync('widget.go', join(tree, 'widget', 'alias')); },
    ],
  };
  for (const [name, [edit, undo]] of Object.entries(edits)) {
    edit();
    assert.notEqual(proofInputs({ dir, task }), base, name);
    assert.equal(proofStatus({ dir, task }), 'stale', name);
    undo();
    assert.equal(proofInputs({ dir, task }), base, `${name}, undone`);
  }
  assert.equal(proofStatus({ dir, task }), 'ok');
  // What a link reaches is not the tree — a container sees the link's text, never the file — and a link back into the tree is not walked.
  put(dir, 'elsewhere/kept.txt', 'An invented line.\n');
  symlinkSync(join(dir, 'elsewhere'), join(tree, 'out'));
  symlinkSync('.', join(tree, 'widget', 'round'));
  const linked = proofInputs({ dir, task });
  assert.notEqual(linked, base, 'a new link is a new entry');
  writeFileSync(join(dir, 'elsewhere', 'kept.txt'), 'Another invented line.\n');
  assert.equal(proofInputs({ dir, task }), linked);
});

test('a proof is ok only as this task\'s own, with repetitions that each held', async () => {
  const { dir, task, fake, env } = setup();
  fake.addImage(IMAGE);
  const proof = await prove({ dir, task, docker: fake.bin, env, reps: 2, out: quiet });
  const file = join(dir, 'checks', 'proofs', 'P01.json');
  assert.equal(proofStatus({ dir, task }), 'ok');
  // The same inputs under another id: P01's proof file, copied, proves nothing of P02.
  const p02 = { ...task, id: 'P02' };
  assert.equal(proofInputs({ dir, task: p02 }), proof.inputs);
  writeFileSync(join(dir, 'checks', 'proofs', 'P02.json'), JSON.stringify(proof));
  assert.equal(proofStatus({ dir, task: p02 }), 'stale');
  for (const [name, edited, status] of [
    ['no repetition', { ...proof, reps: [] }, 'stale'],
    ['repetitions that are no list', { ...proof, reps: { 0: { ok: true }, length: 1 } }, 'stale'],
    ['no repetitions at all', { ...proof, reps: undefined }, 'stale'],
    ['a repetition that did not hold under ok: true', { ...proof, reps: [proof.reps[0], { ...proof.reps[1], ok: false }] }, 'failed'],
    ['a repetition that is nothing', { ...proof, reps: [proof.reps[0], null] }, 'failed'],
    ['ok that is not true', { ...proof, ok: 'true' }, 'failed'],
  ]) {
    writeFileSync(file, JSON.stringify(edited));
    assert.equal(proofStatus({ dir, task }), status, name);
  }
});

test('prove: reps is a whole number of at least one, the proof is the operator\'s alone after every write, and the daemon is named when the environment picks it', async () => {
  for (const reps of [0, -1, 1.5, '3', null, NaN]) {
    const { dir, task, fake, env } = setup();
    await assert.rejects(prove({ dir, task, docker: fake.bin, env, reps, out: quiet }), /^TypeError: prove needs reps, a whole number of at least 1/, String(reps));
    assert.deepEqual(fake.log(), [], String(reps));
    assert.equal(existsSync(join(dir, 'checks')), false);
  }

  // A proof written over one that anyone could read, in directories anyone could list.
  const { dir, task, fake, env } = setup();
  fake.addImage(IMAGE);
  const file = join(dir, 'checks', 'proofs', 'P01.json');
  put(dir, 'checks/proofs/P01.json', '{}');
  for (const [path, mode] of [[file, 0o644], [dirname(file), 0o755], [join(dir, 'checks'), 0o755]]) chmodSync(path, mode);
  const printed = [];
  await prove({ dir, task, docker: fake.bin, env: { ...env, DOCKER_HOST: '' }, reps: 1, out: (l) => printed.push(l) });
  assert.deepEqual([file, dirname(file), join(dir, 'checks')].map((path) => statSync(path).mode & 0o777), [0o600, 0o700, 0o700]);
  assert.equal(proofAt(dir).ok, true);
  assert.deepEqual(printed.filter((l) => /DOCKER_/.test(l)), [], 'no daemon is named when the environment names none: an empty value is none');

  const elsewhere = setup();
  elsewhere.fake.addImage(IMAGE);
  const said = [];
  await prove({
    dir: elsewhere.dir, task: elsewhere.task, docker: elsewhere.fake.bin, reps: 1, out: (l) => said.push(l),
    env: { ...elsewhere.env, DOCKER_HOST: 'tcp://invented.invalid:1\u001b[2J', DOCKER_CONTEXT: 'invented\n-context' },
  });
  assert.equal(said[0], 'P01: docker is pointed at a daemon by DOCKER_HOST=tcp://invented.invalid:1[2J, DOCKER_CONTEXT=invented-context');
  assert.equal(said.filter((l) => /DOCKER_/.test(l)).length, 1);
});

test('a P run line stops the proof under any file name, and only a P line does', async () => {
  const line = (suite, taskIds) => `${JSON.stringify({ suite, taskIds, arm: 'native:invented', run: 1, ok: true, answer: 'An invented answer.' })}\n`;
  for (const name of ['hand-filed.jsonl', 'V-x.jsonl', '.jsonl']) {
    const { dir, task, fake, env } = setup();
    put(dir, `runs/2026-11-20/${name}`, `${line('V', ['V01'])}${line('P', ['P02', 'P01'])}`);
    await assert.rejects(prove({ dir, task, docker: fake.bin, env, reps: 1, out: quiet }), /P01: a model's diff already exists/, name);
    assert.deepEqual(fake.log(), [], name);
  }
  // Another suite's line that names the id, in a file named like a P one; and a file that is no .jsonl.
  const free = setup();
  free.fake.addImage(IMAGE);
  put(free.dir, 'runs/2026-11-20/P-x.jsonl', `${line('V', ['P01'])}${line(undefined, ['P01'])}${line('P', ['P02'])}`);
  put(free.dir, 'runs/2026-11-20/notes.txt', line('P', ['P01']));
  assert.equal((await prove({ dir: free.dir, task: free.task, docker: free.fake.bin, env: free.env, reps: 1, out: quiet })).ok, true);
});

test('readPTasks checks every line\'s shape and, on disk, only the tasks asked for: a reserve task not fetched yet blocks no other', async () => {
  const { dir, task, fake, env } = setup();
  fake.addImage(IMAGE);
  const reserve = { ...P01, id: 'P02', tree: 'third-party/p02/before-fix', gold: 'suites/P/P02/gold.diff', tests: 'suites/P/P02/tests.diff' };
  const write = (...lines) => put(dir, 'suites/P/tasks.jsonl', lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  write(task, reserve);
  assert.throws(() => readPTasks(dir), /task P02: tree third-party\/p02\/before-fix is not a directory/);
  assert.deepEqual(readPTasks(dir, { only: ['P01'] }), [task, reserve]);
  assert.throws(() => readPTasks(dir, { only: ['P01', 'P02'] }), /task P02: tree .* is not a directory/);
  assert.deepEqual(readPTasks(dir, { only: [] }), [task, reserve], 'none asked for, none checked on disk');
  const printed = [];
  assert.equal(await main(['prove', '--task', 'P01', '--dir', dir], { out: (l) => printed.push(l), err: (l) => printed.push(l), env }), 0, printed.join('\n'));
  assert.equal(await main(['prove', '--task', 'P02', '--dir', dir], { out: quiet, err: (l) => printed.push(l), env }), 1);
  assert.match(printed.join('\n'), /task P02: tree .* is not a directory/);

  // A line that is not sound as written is refused whoever was asked for; so is a second line with an id.
  write(task, { ...reserve, image: 'python:3.13' });
  assert.throws(() => readPTasks(dir, { only: ['P01'] }), /task P02: image .* is not an official image pinned by digest/);
  write(task, reserve, reserve);
  assert.throws(() => readPTasks(dir, { only: ['P01'] }), /task P02: a second task with this id/);
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

test('a hunk is as long as its header says: a removed "-- x" before an added "++ y" is its body, not a file header', () => {
  const diff = [
    '--- a/notes/a.sql',
    '+++ b/notes/a.sql',
    '@@ -1,3 +1,3 @@',
    ' select 1;',
    '--- invented/old.sql',
    '+++ invented/new.sql',
    ' select 2;',
    // No `diff --git` line: the hunk above is over by its counts, so this pair is a header.
    '--- a/notes/b.sql',
    '+++ b/notes/b.sql',
    '@@ -5 +5 @@',
    '--- /invented/absolute',
    '+++ ../invented/up',
    '',
  ].join('\n');
  assert.deepEqual(testFiles(diff), ['notes/a.sql', 'notes/b.sql']);
  assert.equal(linesChanged(diff), 4);
  // A CRLF diff: the carriage return is no part of a path.
  assert.deepEqual(testFiles(diff.replaceAll('\n', '\r\n')), ['notes/a.sql', 'notes/b.sql']);
  assert.equal(linesChanged(diff.replaceAll('\n', '\r\n')), 4);
  // A line the hunk has no room for ends it: no new line is left for `+b`, and `-c` is outside.
  assert.equal(linesChanged('@@ -1,2 +1,0 @@\n-a\n+b\n-c\n'), 1);
});

test('testFiles refuses a path that is absolute or climbs: run.sh would copy or remove outside its work tree', () => {
  const pair = (old, now) => `--- ${old}\n+++ ${now}\n@@ -1 +1 @@\n-a\n+b\n`;
  for (const [old, now, named] of [
    ['/invented/abs.go', 'b/x.go', '/invented/abs.go'], ['a/x.go', '/invented/abs.go', '/invented/abs.go'], ['a/../x.go', 'b/x.go', 'a/../x.go'],
    ['a/x.go', '../x.go', '../x.go'], ['a/dir/../../x.go', 'b/x.go', 'a/dir/../../x.go'], ['a//invented/abs.go', 'b/x.go', 'a//invented/abs.go'], ['a/x.go', 'b/dir/..', 'b/dir/..'],
  ]) {
    assert.throws(() => testFiles(pair(old, now)), (e) => e.message.includes(JSON.stringify(named)) && /absolute or holds a "\.\." segment/.test(e.message), `${old} ${now}`);
  }
  assert.deepEqual(testFiles(pair('a/-x.go', 'b/..x/y...go')), ['-x.go', '..x/y...go'], 'a dash or dots in a name are a name');
  assert.deepEqual(testFiles(pair('/dev/null', 'b/new.go')), ['new.go']);
});

test('a change naming a path outside the tree is refused on the host, before a stage exists', async () => {
  const { dir, task, fake, env } = setup();
  const hunk = '@@ -1 +1 @@\n-a\n+b\n';
  const file = `--- a/x.go\n+++ b/x.go\n${hunk}`;
  const unsafe = {
    'an absolute old side': `--- /invented/abs\n+++ b/x.go\n${hunk}`,
    'an absolute new side': `--- a/x.go\n+++ /invented/abs\n${hunk}`,
    'a climb behind the prefix': `--- a/../x.go\n+++ b/x.go\n${hunk}`,
    'a climb in the middle': `--- a/x.go\n+++ b/dir/../../x.go\n${hunk}`,
    'an absolute path behind the prefix': `--- a//invented/abs\n+++ b/x.go\n${hunk}`,
    'a CRLF header': `--- a/x.go\r\n+++ ../x.go\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n`,
    'a quoted path, its dots as escapes': `--- "a/\\056\\056/x.go"\n+++ "b/x.go"\n${hunk}`,
    'a quoted path with no end': `--- "a/x.go\n+++ b/x.go\n${hunk}`,
    'diff --git, the first name': `diff --git a/../x.go b/x.go\n${file}`,
    'diff --git, the second name': `diff --git a/x.go /invented/abs\n${file}`,
    'diff --git, quoted': `diff --git "a/\\056./x.go" "b/x.go"\n${file}`,
    'rename from': `diff --git a/x.go b/y.go\nrename from ../x.go\nrename to y.go\n`,
    'rename to': `diff --git a/x.go b/y.go\nrename from x.go\nrename to /invented/abs\n`,
    'copy from': `diff --git a/x.go b/y.go\ncopy from dir/../../x.go\ncopy to y.go\n`,
    'copy to': `diff --git a/x.go b/y.go\ncopy from x.go\ncopy to "\\057invented\\057abs"\n`,
    'Index:': `Index: ../x.go\n${file}`,
    'a header after a hunk that its counts ended': `${file}--- /invented/abs\n+++ /invented/abs\n${hunk}`,
    'a header where the hunk has no old line left to remove': `--- a/x.go\n+++ b/x.go\n@@ -1,0 +1,9 @@\n--- /invented/abs\n+++ /invented/abs\n${hunk}`,
  };
  const safe = {
    'the gold': GOLD,
    'a new file': `--- /dev/null\n+++ b/new.go\n@@ -0,0 +1 @@\n+a\n`,
    'a hunk whose body reads like a header': `--- a/x.sql\n+++ b/x.sql\n@@ -1,2 +1,2 @@\n select 1;\n--- /invented/abs\n+++ ../invented/up\n`,
    'dots and a dash in names': `diff --git a/-x.go b/..x/y...go\nrename from -x.go\nrename to ..x/y...go\n`,
    'a quoted name': `--- "a/na\\303\\257ve.go"\n+++ "b/na\\303\\257ve.go"\n${hunk}`,
  };
  const mine = tmp('omelette-evals-unsafe-');
  const was = process.env.TMPDIR;
  process.env.TMPDIR = mine;
  try {
    for (const [name, change] of Object.entries(unsafe)) {
      assert.throws(() => makeStage({ dir, task, change }), (e) => e.code === 'UNSAFE_PATH' && /^P01: the change names a path that is absolute or holds a "\.\." segment: "/.test(e.message), name);
      assert.deepEqual(readdirSync(mine), [], `${name}: no stage was made`);
    }
    for (const [name, change] of Object.entries(safe)) {
      const stage = makeStage({ dir, task, change });
      assert.equal(readFileSync(join(stage, 'change.diff'), 'utf8'), change, name);
      rmSync(stage, { recursive: true, force: true });
    }
  } finally {
    if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
  }

  // A gold with such a path fails its proof with that message, and so does a tests diff: no docker call for either.
  writeFileSync(join(dir, P01.gold), unsafe['a climb behind the prefix']);
  await assert.rejects(prove({ dir, task, docker: fake.bin, env, reps: 1, out: quiet }), (e) => e.code === 'UNSAFE_PATH' && /^P01: the change names a path .*"a\/\.\.\/x\.go"$/.test(e.message));
  writeFileSync(join(dir, P01.gold), GOLD);
  writeFileSync(join(dir, P01.tests), unsafe['an absolute new side']);
  await assert.rejects(prove({ dir, task, docker: fake.bin, env, reps: 1, out: quiet }), /^Error: P01: a path in the tests diff that is absolute or holds a "\.\." segment: "\/invented\/abs"$/);
  assert.deepEqual(fake.log(), []);
  assert.equal(existsSync(join(dir, 'checks')), false);
});

test('what a failed pull or build printed reaches the terminal without its control characters', async () => {
  for (const failing of ['pull', 'build']) {
    const { dir, task, fake, env } = setup({ task: failing === 'build' ? { build: 'suites/P/P01/build' } : {} });
    put(dir, 'suites/P/P01/build/Dockerfile', `FROM ${IMAGE}\n`);
    if (failing === 'build') fake.addImage(IMAGE);
    const loud = join(env.HOME, 'docker-loud');
    writeFileSync(loud, `#!${process.execPath}
if (process.argv[2] === ${JSON.stringify(failing)}) {
  process.stderr.write('an earlier line\\n\\u001b[2J\\u001b]0;invented title\\u0007denied:\\t\\u009b31minvented\\u007f\\r\\n');
  process.exit(1);
}
const r = require('child_process').spawnSync(${JSON.stringify(fake.bin)}, process.argv.slice(2), { stdio: 'inherit', timeout: 4000 });
process.exit(r.status);
`);
    chmodSync(loud, 0o755);
    await assert.rejects(prepareImage({ dir, task, docker: loud, env, out: quiet }), (e) => {
      assert.equal(e.message, `P01: docker ${failing} failed (exit 1): [2J]0;invented titledenied:31minvented`);
      return true;
    });
  }

  // The word an apply step prints is printed too, and kept in the proof.
  const { dir, task, fake, env } = setup();
  fake.addImage(IMAGE);
  const coloured = join(env.HOME, 'docker-coloured');
  writeFileSync(coloured, `#!${process.execPath}
if (process.argv[2] === 'run' && process.argv[process.argv.length - 1] === 'apply') {
  process.stdout.write('applied-by \\u001b[31mgit\\u0007\\n');
  process.exit(0);
}
const r = require('child_process').spawnSync(${JSON.stringify(fake.bin)}, process.argv.slice(2), { stdio: 'inherit', timeout: 4000 });
process.exit(r.status);
`);
  chmodSync(coloured, 0o755);
  const printed = [];
  const proof = await prove({ dir, task, docker: coloured, env, reps: 1, out: (l) => printed.push(l) });
  assert.deepEqual([proof.ok, proof.reps[0].gold.apply.method], [true, '[31mgit']);
  assert.ok(printed.some((l) => l.includes('gold applies ([31mgit)')), printed.join('\n'));
});

test('a step past its timeout is killed, removed and recorded as timed out', async () => {
  const { dir, task, fake, env } = setup();
  fake.addImage(IMAGE);
  const stage = makeStage({ dir, task, change: goldWith('FAKE: hangs') });
  try {
    const step = await runStep({ docker: fake.bin, imageId: idOf(IMAGE), stage, step: 'f2p', timeoutS: 1, env });
    assert.deepEqual([step.timedOut, step.exit], [true, null]);
    assert.ok(step.ms >= 900, `the step ran to its bound, not past a kill at once: ${step.ms} ms`);
    const [run, removal] = fake.log();
    assert.ok(run.includes('--rm'));
    assert.match(after(run, '--name'), /^omelette-evals-\d+-[0-9a-f]{8}$/);
    // `rm -f`, not `kill`: a container created and not yet started survives a kill.
    assert.deepEqual(removal, ['rm', '-f', after(run, '--name')]);
    assert.equal('leftContainer' in step, false, 'removed: nothing is left to name');
    // A step with no bound is not started at all (`apply`: were it started, the fake would answer at once, not hang).
    await assert.rejects(runStep({ docker: fake.bin, imageId: idOf(IMAGE), stage, step: 'apply', env }), /runStep needs timeoutS/);
    assert.equal(fake.log().length, 2);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test('a build fetches no image but the task\'s: no syntax directive, no --from or from= that is not a stage of the file', async () => {
  const stages = `FROM ${IMAGE} AS build\nRUN true\nFROM ${IMAGE}\n`;
  const refused = {
    'a syntax directive': [`# syntax=someone/frontend:1\nFROM ${IMAGE}\n`, /^Error: P01: the Dockerfile carries a "# syntax=" directive/],
    'a syntax directive, spaced and in capitals': [`#  SYNTAX = someone/frontend\nFROM ${IMAGE}\n`, /^Error: P01: the Dockerfile carries a "# syntax=" directive/],
    'COPY --from an image': [`${stages}COPY --from=someone/tool:1 /a /b\n`, /^Error: P01: the Dockerfile takes files from "someone\/tool:1", /],
    'ADD --from an image': [`${stages}ADD --from=other /a /b\n`, /^Error: P01: the Dockerfile takes files from "other", /],
    'RUN --mount from an image': [`${stages}RUN --mount=type=bind,from=other:1,source=/a,target=/b true\n`, /^Error: P01: the Dockerfile takes files from "other:1", /],
    'RUN --mount, from= first': [`${stages}RUN --mount=from=other,type=bind,target=/b true\n`, /^Error: P01: the Dockerfile takes files from "other", /],
    'a stage index the file does not have': [`${stages}COPY --from=2 /a /b\n`, /^Error: P01: the Dockerfile takes files from "2", /],
    'a variable': [`${stages}ARG FROM_IMAGE\nCOPY --from=\${FROM_IMAGE} /a /b\n`, /^Error: P01: the Dockerfile takes files from "\$\{FROM_IMAGE\}", /],
    'a flag on a continued line': [`${stages}COPY \\\n  --from=other /a /b\n`, /^Error: P01: the Dockerfile takes files from "other", /],
  };
  for (const [name, [text, message]] of Object.entries(refused)) {
    const { dir, task, fake, env } = setup({ task: { build: 'suites/P/P01/build' } });
    put(dir, 'suites/P/P01/build/Dockerfile', text);
    await assert.rejects(prepareImage({ dir, task, docker: fake.bin, env, out: quiet }), message, name);
    assert.deepEqual(fake.log(), [], `${name}: refused before docker is called`);
  }
  // A stage by its name in any case or by its index, a mount that takes from one or from nowhere, and prose that only reads alike.
  const accepted = [
    '# a comment about syntax', `FROM ${IMAGE} AS Build`, 'RUN echo "copied from the snapshot"', `FROM ${IMAGE}`,
    'COPY --from=build /a /b', 'COPY --from=0 /a /b', 'ADD --from=1 /a /b',
    'RUN --mount=type=bind,from=BUILD,source=/a,target=/b --mount=type=cache,target=/c true', '',
  ].join('\n');
  const { dir, task, fake, env } = setup({ task: { build: 'suites/P/P01/build' } });
  fake.addImage(IMAGE);
  put(dir, 'suites/P/P01/build/Dockerfile', accepted);
  assert.equal((await prepareImage({ dir, task, docker: fake.bin, env, out: quiet })).built, true);
});

test('a container that could not be removed is named, with the command that removes it', async () => {
  const { dir, task, fake, env } = setup({ task: { timeoutS: 1 }, gold: goldWith('FAKE: fixes FAKE: hangs') });
  fake.addImage(IMAGE);
  fake.noRm();
  const printed = [];
  const proof = await prove({ dir, task, docker: fake.bin, env, reps: 1, out: (l) => printed.push(l) });
  const removals = fake.log().filter((a) => a[0] === 'rm');
  assert.equal(removals.length, 1);
  const name = removals[0][2];
  assert.deepEqual(printed.filter((l) => l.includes(name)), [`P01: the container ${name} could not be removed — remove it with: ${fake.bin} rm -f ${name}`]);
  assert.deepEqual([proof.ok, proof.reps[0].gold.failToPass], [false, { exit: null, ms: proof.reps[0].gold.failToPass.ms, timedOut: true }], 'the proof holds the step as before');

  // A removal past its own bound is a failed one.
  const slow = setup();
  slow.fake.addImage(IMAGE);
  slow.fake.hangOn('rm');
  const stage = makeStage({ dir: slow.dir, task: slow.task, change: goldWith('FAKE: hangs') });
  const bound = CALL_BOUNDS_S.rm;
  CALL_BOUNDS_S.rm = 0.3;
  try {
    const step = await runStep({ docker: slow.fake.bin, imageId: idOf(IMAGE), stage, step: 'f2p', timeoutS: 1, env: slow.env });
    assert.deepEqual([step.timedOut, step.exit, step.leftContainer], [true, null, after(slow.fake.runs()[0], '--name')]);
  } finally {
    CALL_BOUNDS_S.rm = bound;
    rmSync(stage, { recursive: true, force: true });
  }
});

test('no docker call runs without a bound, and a call past it is killed and named', async () => {
  assert.deepEqual(CALL_BOUNDS_S, { 'image inspect': 60, pull: 1800, build: 3600, rm: 30 });
  const bounds = { ...CALL_BOUNDS_S };
  try {
    for (const [call, word] of [['image inspect', 'image'], ['pull', 'pull'], ['build', 'build']]) {
      const { dir, task, fake, env } = setup({ task: { build: 'suites/P/P01/build' } });
      put(dir, 'suites/P/P01/build/Dockerfile', `FROM ${IMAGE}\n`);
      fake.hangOn(word);
      if (call === 'build') fake.addImage(IMAGE);
      CALL_BOUNDS_S[call] = 0.3;
      const t0 = Date.now();
      await assert.rejects(prepareImage({ dir, task, docker: fake.bin, env, out: quiet }), new RegExp(`^Error: P01: docker ${call} did not end within 0\\.3 s$`), call);
      assert.ok(Date.now() - t0 < 20000, `${call}: killed at the bound set here, far from its own`);
      assert.ok(!calls(fake).includes('run'));
      Object.assign(CALL_BOUNDS_S, bounds);
    }
  } finally {
    Object.assign(CALL_BOUNDS_S, bounds);
  }
});

test('a signal mid-step leaves nothing behind: the docker client killed, the container removed, the stage gone', async () => {
  for (const [signal, exit] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
    const { dir, fake, env } = setup({ gold: goldWith('FAKE: fixes FAKE: hangs') });
    fake.addImage(IMAGE);
    const mine = tmp('omelette-evals-signal-');
    const child = spawn(process.execPath, [SCRIPT, 'prove', '--task', 'P01', '--dir', dir], { env: { ...env, TMPDIR: mine }, stdio: 'ignore', timeout: 5000, killSignal: 'SIGKILL' });
    const ended = new Promise((done) => { child.on('close', (code, sig) => done([code, sig])); });
    let hung = [];
    try {
      // The gold state's fail-to-pass step is in its container, and its stage holds the gold.
      hung = await until(() => fake.hanging(), (h) => h.length > 0, 4000);
      assert.equal(hung.length, 1, `${signal}: a step is in flight`);
      assert.equal(stagesIn(mine).length, 1);
      child.kill(signal);
      assert.deepEqual(await ended, [exit, null], signal);
      assert.deepEqual(readdirSync(mine), [], `${signal}: no stage outlives the run`);
      assert.deepEqual(fake.log().pop(), ['rm', '-f', hung[0].name], `${signal}: the container of the step in flight is removed`);
      assert.equal(await until(() => alive(hung[0].pid), (is) => !is, 2000), false, `${signal}: the docker client is gone`);
      assert.equal(existsSync(join(dir, 'checks')), false);
    } finally {
      child.kill('SIGKILL');
      for (const { pid } of hung) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone, as it should be */ } }
    }
  }

  // No step in flight, so no container to remove: the docker client of a pull is a process group of its own, and is killed.
  const { dir, fake, env } = setup();
  fake.hangOn('pull');
  const child = spawn(process.execPath, [SCRIPT, 'prove', '--task', 'P01', '--dir', dir], { env, stdio: 'ignore', timeout: 5000, killSignal: 'SIGKILL' });
  const ended = new Promise((done) => { child.on('close', (code, sig) => done([code, sig])); });
  let hung = [];
  try {
    hung = await until(() => fake.hanging(), (h) => h.length > 0, 4000);
    assert.deepEqual(hung.map((h) => h.name), ['pull']);
    child.kill('SIGTERM');
    assert.deepEqual(await ended, [143, null]);
    assert.equal(await until(() => alive(hung[0].pid), (is) => !is, 2000), false, 'the pull is gone');
    assert.deepEqual(calls(fake), ['image inspect', 'pull']);
  } finally {
    child.kill('SIGKILL');
    for (const { pid } of hung) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone, as it should be */ } }
  }
});

test('a stage that cannot be removed is reported by its path: beside the step\'s own error, never instead of it', { skip: process.getuid() === 0 ? 'root removes it whatever the modes' : false }, async () => {
  const contexts = [setup(), setup()];
  const mine = tmp('omelette-evals-kept-');
  const was = process.env.TMPDIR;
  process.env.TMPDIR = mine;
  try {
    // The OS temp dir loses its write bit while the first step runs: the stage in it can no longer be unlinked.
    const [whole, vanishing] = contexts.map((ctx, i) => {
      ctx.fake.addImage(IMAGE);
      const closes = `fs.chmodSync(${JSON.stringify(mine)}, 0o555);`;
      return { ...ctx, docker: dockerThat({ home: ctx.env.HOME, fake: ctx.fake, afterFirstRun: i === 0 ? closes : `${closes} fs.unlinkSync(__filename);` }) };
    });
    await assert.rejects(prove({ dir: whole.dir, task: whole.task, docker: whole.docker, env: whole.env, reps: 1, out: quiet }), (e) => {
      const [stage] = stagesIn(mine);
      assert.equal(e.message.startsWith(`P01: the stage ${join(mine, stage)} could not be removed (E`), true, e.message);
      return true;
    });
    assert.equal(whole.fake.runs().length, 3, 'the state\'s steps ran; the proof stops at the stage it could not remove');
    assert.equal(existsSync(join(whole.dir, 'checks')), false);
    chmodSync(mine, 0o700);
    for (const stage of stagesIn(mine)) rmSync(join(mine, stage), { recursive: true, force: true });

    await assert.rejects(prove({ dir: vanishing.dir, task: vanishing.task, docker: vanishing.docker, env: vanishing.env, reps: 1, out: quiet }), (e) => {
      const [stage] = stagesIn(mine);
      assert.match(e.message, /not found: suite P needs Docker/, 'the step\'s own error');
      assert.match(e.message, /; the stage \S+ could not be removed \(E[A-Z]+\)$/, 'and the stage, after it');
      assert.ok(e.message.includes(join(mine, stage)), e.message);
      return true;
    });
  } finally {
    if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
    chmodSync(mine, 0o700);
    for (const stage of stagesIn(mine)) rmSync(join(mine, stage), { recursive: true, force: true });
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
  // Each odd directory under a root of its own, all made before TMPDIR moves: no path holds another's character.
  const odd = ['a,b', 'a=b', 'a"b', 'a\nb', 'a\rb'].map((name) => {
    const place = join(tmp('omelette-evals-odd-'), name);
    mkdirSync(place);
    return place;
  });
  const sound = tmp('omelette-evals-odd-');
  try {
    for (const place of [...odd, relative(process.cwd(), sound)]) {
      process.env.TMPDIR = place;
      assert.throws(() => makeStage({ dir, task, change: null }), /holds "," or "="/, JSON.stringify(place));
      assert.deepEqual(readdirSync(place), [], `${JSON.stringify(place)}: no stage is left behind`);
    }
    // The same root, written absolute, is a stage's place.
    process.env.TMPDIR = sound;
    rmSync(makeStage({ dir, task, change: null }), { recursive: true, force: true });
  } finally {
    if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
  }
});

test('no test reached a binary named plain docker', () => {
  assert.equal(existsSync(join(TRIPWIRE, 'reached')), false);
});
