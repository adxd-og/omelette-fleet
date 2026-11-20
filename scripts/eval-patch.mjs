#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/eval-patch.mjs
 * Suite P's container: a task's gold patch proven before any model runs (plan
 * docs/superpowers/plans/2026-11-19-evals-neon.md, T15).
 *
 *   node scripts/eval-patch.mjs prove --task ID [--task ID …] [--dir D]
 *
 * PRIVATE IN, PRIVATE OUT. It reads `<D>/suites/P/tasks.jsonl`, the tree, the
 * gold diff and the tests diff each line names, and writes
 * `<D>/checks/proofs/<id>.json`, D defaulting to `<repo>/.omelette/evals`
 * (ignored by git). It prints task ids, exit codes and paths: never a prompt, a
 * diff or a test's output.
 *
 * THIRD-PARTY CODE RUNS IN ONE PLACE: a container step (`dockerRunArgs`) — no
 * network, no pull, no capability, no new privilege, the host's uid, one
 * read-only mount, removed when it ends. Nothing of a task runs on this
 * machine: the host copies files and starts `docker` with an argv, never a
 * shell, so no text of a tree, a diff or a command is read as a command here.
 *
 * THE MOUNT is the stage (`makeStage`): a fresh directory under the OS temp
 * dir holding a copy of the task's tree, the change to apply (the gold in a
 * gold state, a model's diff in a check, none for the snapshot), the
 * maintainers' tests diff, the two test commands and `RUN_SH`. Nothing else of
 * the private dir is in it. A link inside the tree is copied as the link it
 * is: in the container it resolves against the container's own files and the
 * stage, so it reaches nothing of this machine but the stage.
 *
 * WHERE A TASK'S FILES MAY BE. The tree sits strictly under `third-party/`,
 * the gold, the tests diff and a build directory strictly under `suites/P/`,
 * as written and as the kernel resolves them (`realpathSync.native`): a tree
 * of `.` would copy the keys into the mount, and a link named `tests.diff`
 * any file of the private dir.
 *
 * THE NETWORK IS USED ONLY TO GET THE IMAGE, and only by `prove`:
 * `docker pull` of an official image pinned by digest when it is absent, and
 * `docker build` when the task has a build directory. `prove` refuses a task
 * that already has a model's run line, so no model's diff exists before its
 * image does.
 *
 * A PROOF is three repetitions of two states: on the snapshot the
 * fail-to-pass test fails (the test, not the harness) and the pass-to-pass
 * tests pass; with the gold patch both pass. One miss fails the proof and the
 * task is dropped. The proof names its inputs by a hash, so an edited task
 * line, gold, tests diff or build directory makes it stale.
 *
 * This script imports no other script: scripts/eval-run.mjs imports it.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { inheritedEnv, runProcess } from '../core/spawn.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_DIR = join(ROOT, '.omelette', 'evals');

const USAGE = 'usage: node scripts/eval-patch.mjs prove --task ID [--task ID …] [--dir D]';

/** An official Docker Hub image (no `/` path) pinned by digest. */
export const OFFICIAL_IMAGE = /^(?:docker\.io\/library\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$/;

/** A step's exit codes that are the harness's, not a test's: the copy, the change, the tests diff, the step name, Docker's own. */
export const HARNESS_EXITS = [120, 121, 122, 123, 125];

/** The step every container runs, as `/bin/sh /task/run.sh <apply|f2p|p2p>`. */
export const RUN_SH = [
  '#!/bin/sh',
  '# omelette-evals suite P: one step in a throwaway container (scripts/eval-patch.mjs).',
  '# /task is a read-only copy of the task: tree/, and change.diff, tests.diff, test-files,',
  '# f2p.cmd, p2p.cmd. No task text is in this script.',
  'set -u',
  'step="${1:-}"',
  'cp -R /task/tree /tmp/work || exit 120',
  'cd /tmp/work || exit 120',
  'if [ -f /task/change.diff ]; then',
  '  if git apply --recount --whitespace=nowarn /task/change.diff 2>/tmp/apply.err; then',
  '    method=git',
  '  elif command -v patch >/dev/null 2>&1 && patch --batch --forward --fuzz=5 -p1 -i /task/change.diff >>/tmp/apply.err 2>&1; then',
  '    method=patch',
  '  else',
  '    cat /tmp/apply.err >&2',
  '    exit 121',
  '  fi',
  'else',
  '  method=none',
  'fi',
  'while IFS= read -r f; do',
  '  [ -n "$f" ] || continue',
  '  if [ -e "/task/tree/$f" ]; then',
  '    mkdir -p "$(dirname "$f")" && cp "/task/tree/$f" "$f" || exit 122',
  '  else',
  '    rm -f "$f" || exit 122',
  '  fi',
  'done < /task/test-files',
  'git apply --whitespace=nowarn /task/tests.diff 1>&2 || exit 122',
  'case "$step" in',
  '  apply) echo "applied-by $method"; exit 0 ;;',
  '  f2p) exec /bin/sh /task/f2p.cmd ;;',
  '  p2p) exec /bin/sh /task/p2p.cmd ;;',
  '  *) exit 123 ;;',
  'esac',
  '',
].join('\n');

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Where a P task's tree may sit in the private dir, and where its gold, its tests diff and its build directory may. */
const TREES = 'third-party';
const P_FILES = 'suites/P';
/** What `docker image inspect --format {{.Id}}` prints, and the only thing a step is started with. */
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_TIMEOUT_S = 600;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
  try { return JSON.parse(l); } catch (e) { throw new Error(`${path}:${i + 1}: not JSON (${e.message})`); }
});

/** True when `rel`, normalised, names something strictly below the relative directory `under`: never it, never beside it. */
function strictlyUnder(rel, under) {
  if (typeof rel !== 'string' || rel === '' || isAbsolute(rel)) return false;
  const path = normalize(rel).replace(/\/+$/, '');
  return path.startsWith(`${under}/`) && path.length > under.length + 1;
}

/**
 * Why `<dir>/<rel>` is not strictly under `<dir>/<under>` as the kernel
 * resolves it (`realpathSync.native`: Node's own realpath reads `..` after a
 * link lexically), or null when it is. `<under>` itself must be where it is
 * written: `third-party -> suites` would make the keys' directory a tree.
 */
function outOfPlace({ dir, rel, under, what }) {
  try {
    const place = realpathSync.native(resolve(dir, under));
    if (place !== resolve(realpathSync.native(dir), under)) return `${under}/ is reached through a link`;
    const from = relative(place, realpathSync.native(resolve(dir, rel)));
    const inside = from !== '' && from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from);
    return inside ? null : `${what} ${rel} leads out of ${under}/ through a link`;
  } catch (e) {
    return `${what} ${rel} cannot be resolved (${(e && e.code) || e})`;
  }
}

/** What is wrong with a sound task line's files as they are on disk under `dir`. `lstat`: a link is not the thing it names. */
function placeProblems({ dir, task }) {
  const problems = [];
  const kind = (rel) => {
    try { return lstatSync(resolve(dir, rel)); } catch { return null; }
  };
  const placed = (rel, under, what) => {
    const problem = outOfPlace({ dir, rel, under, what });
    if (problem) problems.push(problem);
  };
  const tree = kind(task.tree);
  if (!tree || !tree.isDirectory()) problems.push(`tree ${task.tree} is not a directory`);
  else placed(task.tree, TREES, 'tree');
  for (const field of ['gold', 'tests']) {
    const file = kind(task[field]);
    if (!file || !file.isFile()) problems.push(`${field} ${task[field]} is not a plain file`);
    else placed(task[field], P_FILES, field);
  }
  if (task.build != null) {
    const build = kind(task.build);
    const dockerfile = kind(join(task.build, 'Dockerfile'));
    if (!build || !build.isDirectory()) problems.push(`build ${task.build} is not a directory`);
    else if (!dockerfile || !dockerfile.isFile()) problems.push(`build ${task.build} holds no Dockerfile that is a plain file`);
    else placed(task.build, P_FILES, 'build');
  }
  return problems;
}

/**
 * What is wrong with one P task line, as messages (none: it is sound). With
 * `dir`, a line sound as written is also checked against the private dir: its
 * tree, gold, tests diff and build directory are there, are what they are
 * named as (not links), and are where they are written.
 */
export function pTaskProblems(task, { dir } = {}) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return ['not a JSON object'];
  const problems = [];
  if (typeof task.id !== 'string' || !TASK_ID.test(task.id)) problems.push(`id ${JSON.stringify(task.id)} is not a task id (letters, digits, ".", "_", "-")`);
  for (const field of ['prompt', 'failToPass', 'passToPass']) {
    if (typeof task[field] !== 'string' || !task[field].trim()) problems.push(`needs a non-empty ${field}`);
  }
  if (!strictlyUnder(task.tree, TREES)) problems.push(`tree ${JSON.stringify(task.tree)} is not a directory strictly under the private dir's ${TREES}/`);
  for (const field of ['gold', 'tests']) {
    if (!strictlyUnder(task[field], P_FILES) || !normalize(task[field]).endsWith('.diff')) {
      problems.push(`${field} ${JSON.stringify(task[field])} is not a .diff file strictly under the private dir's ${P_FILES}/`);
    }
  }
  if (typeof task.image !== 'string' || !OFFICIAL_IMAGE.test(task.image)) problems.push(`image ${JSON.stringify(task.image)} is not an official image pinned by digest`);
  if (task.build != null && !strictlyUnder(task.build, P_FILES)) problems.push(`build ${JSON.stringify(task.build)} is not a directory strictly under the private dir's ${P_FILES}/`);
  if (task.timeoutS !== undefined && !(Number.isInteger(task.timeoutS) && task.timeoutS >= 1 && task.timeoutS <= 3600)) {
    problems.push(`timeoutS ${JSON.stringify(task.timeoutS)} is not a whole number from 1 to 3600`);
  }
  if (dir !== undefined && !problems.length) problems.push(...placeProblems({ dir, task }));
  return problems;
}

/** Suite P's tasks, every line checked as written and against the private dir (see pTaskProblems); ids are unique. */
export function readPTasks(dir) {
  const path = join(dir, 'suites', 'P', 'tasks.jsonl');
  if (!existsSync(path)) throw new Error(`no suite at ${path}`);
  const tasks = readJsonl(path);
  if (!tasks.length) throw new Error(`${path} holds no task`);
  const seen = new Set();
  tasks.forEach((t, i) => {
    const problems = pTaskProblems(t, { dir });
    const id = t && typeof t.id === 'string' && t.id ? t.id : `#${i + 1}`;
    if (seen.has(id)) problems.push('a second task with this id: ids are unique per suite');
    if (problems.length) throw new Error(`${path}: task ${id}: ${problems.join('; ')}`);
    seen.add(id);
  });
  return tasks;
}

/**
 * Where a task's files are, absolute — refused unless the line is sound and
 * every file is in its place, whatever the caller checked: this is the gate
 * before a file of the private dir is read, copied into a stage or handed to
 * `docker build`.
 */
function taskPaths({ dir, task }) {
  const problems = pTaskProblems(task, { dir });
  if (problems.length) throw new Error(`${task && typeof task.id === 'string' ? task.id : 'task'}: ${problems.join('; ')}`);
  return {
    tree: resolve(dir, task.tree),
    gold: resolve(dir, task.gold),
    tests: resolve(dir, task.tests),
    build: task.build == null ? null : resolve(dir, task.build),
  };
}

/** A `--- ` line directly followed by a `+++ ` line: a file header, not a removed line that starts with `-- `. */
const isFileHeader = (lines, i) => lines[i].startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');

/** The paths a diff touches, sorted: both sides of every file header, `/dev/null` aside. */
export function testFiles(diffText) {
  const lines = String(diffText).split('\n');
  const paths = new Set();
  lines.forEach((line, i) => {
    if (!isFileHeader(lines, i)) return;
    for (const side of [line, lines[i + 1]]) {
      const path = side.slice(4).split('\t')[0];
      if (path.startsWith('"')) throw new Error('a quoted path in the tests diff');
      if (path !== '/dev/null') paths.add(/^[ab]\//.test(path) ? path.slice(2) : path);
    }
  });
  return [...paths].sort();
}

/** The lines a diff adds or removes: those starting `+` or `-` inside its hunks, file headers aside. */
export function linesChanged(diffText) {
  const lines = String(diffText).split('\n');
  let inHunk = false;
  let changed = 0;
  lines.forEach((line, i) => {
    if (line.startsWith('diff --git ') || isFileHeader(lines, i)) inHunk = false;
    else if (line.startsWith('@@ ')) inHunk = true;
    else if (inHunk && (line.startsWith('+') || line.startsWith('-'))) changed += 1;
  });
  return changed;
}

/** Every file under a build directory as [relative path, sha256], sorted; a link by the text it holds, never followed. */
function buildFiles(root) {
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, e.name);
      if (e.isDirectory()) walk(path);
      else found.push([relative(root, path), sha256(e.isSymbolicLink() ? `link:${readlinkSync(path)}` : readFileSync(path))]);
    }
  };
  walk(root);
  return found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * What a proof was made of, as 16 hex: the task line's fields that decide a
 * step, the gold diff, the tests diff and the build directory. Not the tree's
 * content: an edited tree under the same path keeps its proof.
 */
export function proofInputs({ dir, task }) {
  const paths = taskPaths({ dir, task });
  const { image, build, tree, gold, tests, failToPass, passToPass, timeoutS } = task;
  return sha256(JSON.stringify({
    task: { image, build, tree, gold, tests, failToPass, passToPass, timeoutS },
    gold: readFileSync(paths.gold, 'utf8'),
    tests: readFileSync(paths.tests, 'utf8'),
    build: paths.build ? buildFiles(paths.build) : null,
  })).slice(0, 16);
}

const proofPath = (dir, id) => join(dir, 'checks', 'proofs', `${id}.json`);

/** `missing` (no proof file), `stale` (made of other inputs, or unreadable), `failed` (the proof did not hold) or `ok`. */
export function proofStatus({ dir, task }) {
  const file = proofPath(dir, task.id);
  if (!existsSync(file)) return 'missing';
  let proof = null;
  try { proof = JSON.parse(readFileSync(file, 'utf8')); } catch { /* not a proof of anything: stale */ }
  if (!proof || proof.inputs !== proofInputs({ dir, task })) return 'stale';
  return proof.ok === true ? 'ok' : 'failed';
}

/** One container step's argv: the whole profile. */
export function dockerRunArgs({ imageId, stage, name, step, uid, gid }) {
  return [
    'run', '--rm', '--pull', 'never', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '1024', '--memory', '4g', '--cpus', '2', '--user', `${uid}:${gid}`, '--env', 'HOME=/tmp',
    '--mount', `type=bind,source=${stage},target=/task,readonly`, '--name', name, '--entrypoint', '/bin/sh',
    imageId, '/task/run.sh', step,
  ];
}

/**
 * The read-only copy of a task a container is given, and its only mount: a
 * fresh directory under the OS temp dir with `tree/` (the task's tree, links
 * as links), `change.diff` (`change`: the gold or a model's diff, written as
 * the text it is; `null` for the snapshot state, and then no such file),
 * `tests.diff`, `test-files`, `f2p.cmd`, `p2p.cmd` and `run.sh`. The caller
 * removes it. Returns its path.
 */
export function makeStage({ dir, task, change }) {
  const paths = taskPaths({ dir, task });
  const tests = readFileSync(paths.tests, 'utf8');
  const restored = testFiles(tests);
  const stage = mkdtempSync(join(tmpdir(), 'omelette-evals-p-'));
  try {
    // `--mount` takes comma-separated key=value pairs: such a path would be read as more of them.
    if (/[,=]/.test(stage)) throw new Error(`the stage's path ${stage} holds "," or "=", which --mount would misread: set TMPDIR to a path without them`);
    cpSync(paths.tree, join(stage, 'tree'), { recursive: true, verbatimSymlinks: true });
    if (change !== null) writeFileSync(join(stage, 'change.diff'), change);
    writeFileSync(join(stage, 'tests.diff'), tests);
    writeFileSync(join(stage, 'test-files'), `${restored.join('\n')}\n`);
    writeFileSync(join(stage, 'f2p.cmd'), `${task.failToPass}\n`);
    writeFileSync(join(stage, 'p2p.cmd'), `${task.passToPass}\n`);
    writeFileSync(join(stage, 'run.sh'), RUN_SH, { mode: 0o755 });
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  return stage;
}

/** `docker <args>` as the operator's own tool: an argv, the operator's environment, no shell. */
const dockerCall = ({ docker, args, env, hardKillMs = 0 }) => runProcess({
  bin: docker, args, env, inheritEnv: true, hardKillMs, outputCap: 1000000,
  notFoundHelp: `${docker} not found: suite P needs Docker on this machine`,
});

/**
 * One step (`apply`, `f2p` or `p2p`) of a stage in a container of its own →
 * `{ exit, ms, timedOut, stdout, stderr }`. Past `timeoutS` the docker client
 * is killed and the container with it (`docker kill`: killing the client does
 * not stop it), and the step is `exit: null, timedOut: true`.
 */
export async function runStep({ docker, imageId, stage, step, timeoutS, env }) {
  // No bound, no container: a missing `timeoutS` would otherwise start a step nothing ever kills.
  if (!Number.isInteger(timeoutS) || timeoutS < 1) throw new TypeError(`runStep needs timeoutS, a whole number of seconds (got ${JSON.stringify(timeoutS)})`);
  const name = `omelette-evals-${process.pid}-${randomBytes(4).toString('hex')}`;
  const args = dockerRunArgs({ imageId, stage, name, step, uid: process.getuid(), gid: process.getgid() });
  const t0 = Date.now();
  const res = await dockerCall({ docker, args, env, hardKillMs: timeoutS * 1000 });
  const ms = Date.now() - t0;
  if (res.killed) {
    spawnSync(docker, ['kill', name], { env: inheritedEnv(env), stdio: 'ignore', timeout: 30000 });
    return { exit: null, ms, timedOut: true, stdout: res.stdout, stderr: res.stderr };
  }
  return { exit: res.code, ms, timedOut: false, stdout: res.stdout, stderr: res.stderr };
}

/** The id of an image the daemon holds, or null when it holds none by that name. */
async function imageIdOf({ docker, env, ref }) {
  const res = await dockerCall({ docker, args: ['image', 'inspect', '--format', '{{.Id}}', ref], env });
  if (res.code !== 0) return null;
  const id = res.stdout.trim();
  if (!IMAGE_ID.test(id)) throw new Error(`docker image inspect printed no image id for ${ref}`);
  return id;
}

const FROM_LINE = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/gim;
const lastLine = (text) => String(text || '').trim().split('\n').pop();

/**
 * The image a task's steps run, got before any model's diff exists →
 * `{ imageId, built }`. The task's own image is pulled when the daemon does
 * not hold it; with a build directory, an image is built from its Dockerfile,
 * whose every `FROM` must name the task's image (read before docker is
 * called). This is the only place the network is used.
 */
export async function prepareImage({ dir, task, docker, env, out = () => {} }) {
  const paths = taskPaths({ dir, task });
  if (paths.build) {
    for (const [, ref] of readFileSync(join(paths.build, 'Dockerfile'), 'utf8').matchAll(FROM_LINE)) {
      if (ref !== task.image) throw new Error(`${task.id}: the Dockerfile builds FROM ${ref}, not the task's image`);
    }
  }
  let imageId = await imageIdOf({ docker, env, ref: task.image });
  if (!imageId) {
    out(`${task.id}: pulling ${task.image}`);
    const pull = await dockerCall({ docker, args: ['pull', task.image], env });
    if (pull.code !== 0) throw new Error(`${task.id}: docker pull failed (exit ${pull.code}): ${lastLine(pull.stderr)}`);
    imageId = await imageIdOf({ docker, env, ref: task.image });
    if (!imageId) throw new Error(`${task.id}: docker pull ended well and the daemon still holds no ${task.image}`);
  }
  if (!paths.build) return { imageId, built: false };
  const tag = `omelette-evals-${task.id.toLowerCase()}:${proofInputs({ dir, task })}`;
  out(`${task.id}: building ${tag}`);
  const build = await dockerCall({ docker, args: ['build', '--pull=false', '-t', tag, paths.build], env });
  if (build.code !== 0) throw new Error(`${task.id}: docker build failed (exit ${build.code}): ${lastLine(build.stderr)}`);
  const builtId = await imageIdOf({ docker, env, ref: tag });
  if (!builtId) throw new Error(`${task.id}: docker build ended well and the daemon holds no ${tag}`);
  return { imageId: builtId, built: true };
}

/** True when a run line for the task is filed: an arm's answer, or one filed by hand, in any `runs/<date>/P-*.jsonl`. */
function hasRunLine(dir, id) {
  const runs = join(dir, 'runs');
  if (!existsSync(runs)) return false;
  for (const day of readdirSync(runs, { withFileTypes: true })) {
    if (!day.isDirectory()) continue;
    for (const file of readdirSync(join(runs, day.name))) {
      if (!/^P-.*\.jsonl$/.test(file)) continue;
      if (readJsonl(join(runs, day.name, file)).some((l) => l && Array.isArray(l.taskIds) && l.taskIds.includes(id))) return true;
    }
  }
  return false;
}

/** One state of a task (the snapshot, or the snapshot with `change`) through its steps, in a stage of its own. */
async function runState({ dir, task, change, docker, imageId, env }) {
  const stage = makeStage({ dir, task, change });
  try {
    const step = (name) => runStep({ docker, imageId, stage, step: name, timeoutS: task.timeoutS ?? DEFAULT_TIMEOUT_S, env });
    const test = async (name) => {
      const { exit, ms, timedOut } = await step(name);
      return { exit, ms, timedOut };
    };
    const applied = await step('apply');
    const method = applied.exit === 0 ? /^applied-by (\S+)/m.exec(applied.stdout) : null;
    const apply = { exit: applied.exit, method: method ? method[1] : null };
    if (applied.exit !== 0) return { apply, failToPass: null, passToPass: null };
    return { apply, failToPass: await test('f2p'), passToPass: await test('p2p') };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** The fail-to-pass test failed: it ran to its end and the exit code is the test's own, not the harness's. */
const failed = (step) => !!step && !step.timedOut && Number.isInteger(step.exit) && step.exit !== 0 && !HARNESS_EXITS.includes(step.exit);
const passed = (step) => !!step && step.exit === 0;
const exitWord = (step) => (!step ? '-' : step.timedOut ? 'timeout' : String(step.exit));

/**
 * Prove a task's gold patch `reps` times over and write the proof to
 * `<dir>/checks/proofs/<id>.json`; returns it (`ok` says whether it held).
 * Throws, before docker is called, for a task that is not sound or that
 * already has a model's run line.
 */
export async function prove({ dir, task, docker, env, reps = 3, out = () => {} }) {
  const paths = taskPaths({ dir, task });
  if (hasRunLine(dir, task.id)) throw new Error(`${task.id}: a model's diff already exists — a build now would use the network after it`);
  const gold = readFileSync(paths.gold, 'utf8');
  const inputs = proofInputs({ dir, task });
  const { imageId, built } = await prepareImage({ dir, task, docker, env, out });
  const results = [];
  for (let rep = 1; rep <= reps; rep++) {
    const snapshot = await runState({ dir, task, change: null, docker, imageId, env });
    const withGold = await runState({ dir, task, change: gold, docker, imageId, env });
    const ok = snapshot.apply.exit === 0 && failed(snapshot.failToPass) && passed(snapshot.passToPass)
      && withGold.apply.exit === 0 && passed(withGold.failToPass) && passed(withGold.passToPass);
    results.push({ rep, snapshot, gold: withGold, ok });
    out(`${task.id} rep ${rep}: snapshot F2P exit ${exitWord(snapshot.failToPass)}, P2P exit ${exitWord(snapshot.passToPass)}`
      + ` · gold ${withGold.apply.exit === 0 ? `applies (${withGold.apply.method})` : 'does not apply'}, F2P exit ${exitWord(withGold.failToPass)}, P2P exit ${exitWord(withGold.passToPass)}`
      + ` — ${ok ? 'ok' : 'FAILED'}`);
  }
  const proof = {
    task: task.id, inputs, image: task.image, imageId, built, provedAt: new Date().toISOString(), goldLines: linesChanged(gold),
    reps: results, ok: results.every((r) => r.ok),
  };
  const file = proofPath(dir, task.id);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  return proof;
}

export async function main(argv = process.argv.slice(2), { out = (l) => console.log(l), err = (l) => console.error(l), env = process.env } = {}) {
  const [command, ...rest] = argv;
  if (command !== 'prove') { err(`eval-patch: ${command === undefined ? 'a command is needed' : `unknown command ${JSON.stringify(command)}`}\n${USAGE}`); return 2; }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { task: { type: 'string', multiple: true }, dir: { type: 'string' } },
      strict: true, allowPositionals: false,
    }));
  } catch (e) { err(`eval-patch: ${e.message}\n${USAGE}`); return 2; }
  if (!(values.task || []).length) { err(`eval-patch: at least one --task\n${USAGE}`); return 2; }

  const dir = resolve(values.dir || DEFAULT_DIR);
  const docker = env.OMELETTE_EVALS_DOCKER || 'docker';
  let tasks;
  try { tasks = readPTasks(dir); } catch (e) { err(`eval-patch: ${(e && e.message) || e}`); return 1; }
  let allOk = true;
  for (const id of new Set(values.task)) {
    try {
      const task = tasks.find((t) => t.id === id);
      if (!task) throw new Error(`${id}: suite P has no such task`);
      const proof = await prove({ dir, task, docker, env, out });
      out(`${id}: ${proof.ok ? 'proven' : 'NOT proven — the task is dropped'} → ${proofPath(dir, id)}`);
      if (!proof.ok) allOk = false;
    } catch (e) {
      err(`eval-patch: ${(e && e.message) || e}`);
      allOk = false;
    }
  }
  return allOk ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await main();
}
