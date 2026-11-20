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
 * A DIFF IS TEXT NOBODY VOUCHES FOR, and is read as such before a stage
 * exists: a change (the gold, later a model's diff) whose headers name a path
 * that is absolute or climbs with `..` is refused on the host (`UNSAFE_PATH`)
 * — git refuses such a path, the `patch` an image falls back to may not — and
 * so is a tests diff that would have `RUN_SH` restore a file outside its work
 * tree.
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
 * line, gold, tests diff, build directory or tree makes it stale.
 *
 * NOTHING OUTLIVES ITS BOUND. A step is killed at its task's `timeoutS`, every
 * other docker call at `CALL_BOUNDS_S`; the container of a killed step is
 * removed (`docker rm -f`: killing the client does not stop it, and one created
 * and not yet started survives a `docker kill`), and one that could not be is
 * named with the command that removes it. A stage is removed whatever modes
 * its copy of the tree carries. On SIGINT, SIGTERM or SIGHUP the CLI
 * (`installCleanup`) kills its docker clients, removes the containers of the
 * steps in flight and every stage, and exits 130, 143 or 129.
 *
 * This script imports no other script: scripts/eval-run.mjs imports it.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { inheritedEnv, killLiveGroups, runProcess } from '../core/spawn.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_DIR = join(ROOT, '.omelette', 'evals');

const USAGE = 'usage: node scripts/eval-patch.mjs prove --task ID [--task ID …] [--dir D]';

/** An official Docker Hub image (no `/` path) pinned by digest. */
export const OFFICIAL_IMAGE = /^(?:docker\.io\/library\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$/;

/** A step's exit codes that are the harness's, not a test's: the copy, the change, the tests diff, the step name, Docker's own. */
export const HARNESS_EXITS = [120, 121, 122, 123, 125];

/**
 * The step every container runs, as `/bin/sh /task/run.sh <apply|f2p|p2p>`.
 * `patch` is the fallback, with a fuzz of 2 (5 would ignore all context) and
 * no `.orig` left in the tree the tests run in; a restored path gets `./`
 * before it, so one that opens with `-` is not read as an option.
 */
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
  '  elif command -v patch >/dev/null 2>&1 && patch --batch --forward --fuzz=2 --no-backup-if-mismatch -p1 -i /task/change.diff >>/tmp/apply.err 2>&1; then',
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
  '    mkdir -p "$(dirname "./$f")" && cp "/task/tree/$f" "./$f" || exit 122',
  '  else',
  '    rm -f "./$f" || exit 122',
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

/** The seconds each docker call that is not a step may take; a step's bound is its task's `timeoutS`. Past it the client is killed. (An object, so that a test can shorten one.) */
export const CALL_BOUNDS_S = { 'image inspect': 60, pull: 1800, build: 3600, rm: 30 };

/**
 * What this process must not leave behind when it is told to stop
 * (`installCleanup`): the stages it made and has not removed, and the
 * containers of its steps in flight, each with the docker that started it.
 */
const LIVE_STAGES = new Set();
const LIVE_CONTAINERS = new Map();

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** Text this script did not write, fit for a terminal: without its control characters (C0, DEL, C1). */
const plain = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

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

/**
 * Suite P's tasks, ids unique. Every line is checked as written; against the
 * private dir (see pTaskProblems) every line too, or, with `only`, the tasks
 * of those ids alone: a reserve task whose tree is not fetched yet must not
 * stop the proof of another.
 */
export function readPTasks(dir, { only } = {}) {
  const path = join(dir, 'suites', 'P', 'tasks.jsonl');
  if (!existsSync(path)) throw new Error(`no suite at ${path}`);
  const tasks = readJsonl(path);
  if (!tasks.length) throw new Error(`${path} holds no task`);
  const seen = new Set();
  tasks.forEach((t, i) => {
    const id = t && typeof t.id === 'string' && t.id ? t.id : `#${i + 1}`;
    const problems = pTaskProblems(t, only === undefined || only.includes(id) ? { dir } : {});
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

/** A hunk's header, `@@ -a,b +c,d @@`: `b` and `d` are how many lines it has on each side, 1 when left out. */
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
/** The headers of a git or `diff -u` change that name one path each, the rest of the line being the path. */
const PATH_LINE = /^(?:rename from|rename to|copy from|copy to|Index:) (.*)$/;

/**
 * A unified diff nobody vouches for, read once → what its headers name and how
 * many lines its hunks change. A hunk is as long as its header says: inside it
 * a removed line `-- x` followed by an added line `++ y` (the diff reads
 * `--- x` / `+++ y`) is body, and a `--- ` line directly followed by a `+++ `
 * line is a file header only where no hunk is open. A line the open hunk
 * cannot hold — its side is used up, or it opens with nothing a hunk's line
 * opens with — ends the hunk and is read as any other. A trailing carriage
 * return is no part of a line.
 *   pairs: the text after `--- ` and after `+++ ` of every file header;
 *   gitLines: the text after `diff --git `; pathLines: the text of every PATH_LINE.
 */
function scanDiff(diffText) {
  const lines = String(diffText).split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const found = { pairs: [], gitLines: [], pathLines: [], changed: 0 };
  let oldLeft = 0;
  let newLeft = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (oldLeft > 0 || newLeft > 0) {
      const mark = line === '' ? ' ' : line[0]; // a context line that lost its blank
      if (mark === '\\') continue; // `\ No newline at end of file`
      if (mark === ' ' && oldLeft > 0 && newLeft > 0) { oldLeft -= 1; newLeft -= 1; continue; }
      if (mark === '-' && oldLeft > 0) { oldLeft -= 1; found.changed += 1; continue; }
      if (mark === '+' && newLeft > 0) { newLeft -= 1; found.changed += 1; continue; }
      oldLeft = 0;
      newLeft = 0;
    }
    const hunk = HUNK_HEADER.exec(line);
    const pathLine = PATH_LINE.exec(line);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      found.pairs.push(line.slice(4), lines[i + 1].slice(4));
      i += 1;
    } else if (line.startsWith('diff --git ')) {
      found.gitLines.push(line.slice('diff --git '.length));
    } else if (pathLine) {
      found.pathLines.push(pathLine[1]);
    }
  }
  return found;
}

/** A path that would land outside the tree it is applied in: absolute, or with a `..` segment. */
const leavesTree = (path) => path.startsWith('/') || path.split('/').includes('..');
/** A header's path as `-p1` reads it: without its `a/` or `b/`. */
const unprefixed = (path) => (/^[ab]\//.test(path) ? path.slice(2) : path);

/** The paths a diff touches, sorted: both sides of every file header, `/dev/null` aside. Throws for a quoted path, and for one that leaves the tree. */
export function testFiles(diffText) {
  const paths = new Set();
  for (const side of scanDiff(diffText).pairs) {
    const path = side.split('\t')[0];
    if (path.startsWith('"')) throw new Error('a quoted path in the tests diff');
    if (path === '/dev/null') continue;
    // RUN_SH copies or removes each of these under its work tree: one that leaves it would do so elsewhere.
    if (leavesTree(path) || leavesTree(unprefixed(path))) throw new Error(`a path in the tests diff that is absolute or holds a ".." segment: ${JSON.stringify(path)}`);
    paths.add(unprefixed(path));
  }
  return [...paths].sort();
}

/** The lines a diff adds or removes: those starting `+` or `-` inside its hunks, each hunk as long as its header says. */
export function linesChanged(diffText) {
  return scanDiff(diffText).changed;
}

const C_ESCAPES = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
/** The escapes of a C-quoted name, as git writes one with an unusual byte: `\056` is a dot, and it counts as one. */
const unescaped = (text) => text.replace(/\\([0-7]{1,3}|.)/g, (_, e) => (/^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8) & 0xff) : C_ESCAPES[e] ?? e));
/** A header's path as written, or what its quotes hold; null for a quoted path that does not end. */
function namedPath(text) {
  if (!text.startsWith('"')) return text;
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(text);
  return quoted ? unescaped(quoted[1]) : null;
}

/**
 * Refuse, on the host, a change one of whose headers names a path outside the
 * tree: the two sides of a file header, the names of a `diff --git` line (each
 * word of it: where one name ends is not written), `rename` and `copy` lines,
 * `Index:` lines. git refuses such a path; the `patch` an unknown image falls
 * back to may not. Throws an error whose `code` is `UNSAFE_PATH`.
 */
function refuseUnsafeChange(change) {
  const { pairs, gitLines, pathLines } = scanDiff(change);
  const refuse = (text) => { throw Object.assign(new Error(`the change names a path that is absolute or holds a ".." segment: ${JSON.stringify(text)}`), { code: 'UNSAFE_PATH' }); };
  const check = (text, path) => {
    if (path === null || leavesTree(path) || leavesTree(unprefixed(path))) refuse(text);
  };
  for (const side of pairs) {
    const text = side.split('\t')[0];
    if (text !== '/dev/null') check(text, namedPath(text));
  }
  for (const text of pathLines) check(text, namedPath(text));
  for (const text of gitLines) {
    for (const word of unescaped(text).split(/[\s"]+/)) check(text, word);
  }
}

/** Every file under a directory as [relative path, sha256 of its bytes], sorted; a link by the text it holds, never followed. */
function hashedFiles(root) {
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, e.name);
      if (e.isDirectory()) walk(path);
      else found.push([relative(root, path), sha256(e.isSymbolicLink() ? `link:${readlinkSync(path)}` : e.isFile() ? readFileSync(path) : 'neither a file nor a link')]);
    }
  };
  walk(root);
  return found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * What a proof was made of, as 16 hex: the task line's fields that decide a
 * step, the gold diff, the tests diff, the build directory and the tree, file
 * by file: an edited tree under the same path is another task.
 */
export function proofInputs({ dir, task }) {
  const paths = taskPaths({ dir, task });
  const { image, build, tree, gold, tests, failToPass, passToPass, timeoutS } = task;
  return sha256(JSON.stringify({
    task: { image, build, tree, gold, tests, failToPass, passToPass, timeoutS },
    gold: readFileSync(paths.gold, 'utf8'),
    tests: readFileSync(paths.tests, 'utf8'),
    build: paths.build ? hashedFiles(paths.build) : null,
    tree: hashedFiles(paths.tree),
  })).slice(0, 16);
}

const proofPath = (dir, id) => join(dir, 'checks', 'proofs', `${id}.json`);

/**
 * `missing` (no proof file), `stale` (not this task's proof: another id,
 * other inputs, no repetition, or unreadable), `failed` (it did not hold) or
 * `ok` — `ok: true` and every repetition `ok`.
 */
export function proofStatus({ dir, task }) {
  const file = proofPath(dir, task.id);
  if (!existsSync(file)) return 'missing';
  let proof = null;
  try { proof = JSON.parse(readFileSync(file, 'utf8')); } catch { /* not a proof of anything: stale */ }
  if (!proof || proof.task !== task.id || proof.inputs !== proofInputs({ dir, task })) return 'stale';
  if (!Array.isArray(proof.reps) || !proof.reps.length) return 'stale';
  return proof.ok === true && proof.reps.every((rep) => !!rep && rep.ok === true) ? 'ok' : 'failed';
}

/** One container step's argv: the whole profile. `--memory-swap` equal to `--memory`: alone, `--memory` allows as much swap again. */
export function dockerRunArgs({ imageId, stage, name, step, uid, gid }) {
  return [
    'run', '--rm', '--pull', 'never', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '1024', '--memory', '4g', '--memory-swap', '4g', '--cpus', '2', '--user', `${uid}:${gid}`, '--env', 'HOME=/tmp',
    '--mount', `type=bind,source=${stage},target=/task,readonly`, '--name', name, '--entrypoint', '/bin/sh',
    imageId, '/task/run.sh', step,
  ];
}

/**
 * What a stage is made of, read and refused on the host before a stage exists
 * (and, in `prove`, before docker is called): the task's files in their
 * places, the tests diff and the paths it restores (`testFiles` refuses one
 * that leaves the tree), and a change whose headers name no path outside the
 * tree (`refuseUnsafeChange`, `code: 'UNSAFE_PATH'`).
 */
function stageTexts({ dir, task, change }) {
  const paths = taskPaths({ dir, task });
  const tests = readFileSync(paths.tests, 'utf8');
  try {
    if (change !== null) refuseUnsafeChange(change);
    return { paths, tests, restored: testFiles(tests) };
  } catch (e) {
    e.message = `${task.id}: ${e.message}`;
    throw e;
  }
}

/**
 * The read-only copy of a task a container is given, and its only mount: a
 * fresh directory under the OS temp dir with `tree/` (the task's tree, links
 * as links), `change.diff` (`change`: the gold or a model's diff, written as
 * the text it is; `null` for the snapshot state, and then no such file),
 * `tests.diff`, `test-files`, `f2p.cmd`, `p2p.cmd` and `run.sh`. The caller
 * removes it, with `removeStage`. Returns its path.
 */
export function makeStage({ dir, task, change }) {
  const { paths, tests, restored } = stageTexts({ dir, task, change });
  // `--mount` takes comma-separated key=value pairs, quoted as CSV, and the daemon an absolute source: another path would be read as something else.
  const place = join(tmpdir(), 'omelette-evals-p-');
  if (!isAbsolute(place) || /[,="\n\r]/.test(place)) {
    throw new Error(`the OS temp dir ${JSON.stringify(tmpdir())} is relative or holds "," or "=", a double quote or a line break, which --mount would misread: set TMPDIR to an absolute path without them`);
  }
  const stage = mkdtempSync(place);
  LIVE_STAGES.add(stage);
  try {
    cpSync(paths.tree, join(stage, 'tree'), { recursive: true, verbatimSymlinks: true });
    if (change !== null) writeFileSync(join(stage, 'change.diff'), change);
    writeFileSync(join(stage, 'tests.diff'), tests);
    writeFileSync(join(stage, 'test-files'), `${restored.join('\n')}\n`);
    writeFileSync(join(stage, 'f2p.cmd'), `${task.failToPass}\n`);
    writeFileSync(join(stage, 'p2p.cmd'), `${task.passToPass}\n`);
    writeFileSync(join(stage, 'run.sh'), RUN_SH, { mode: 0o755 });
  } catch (e) {
    const left = removeStage(stage);
    if (left && e instanceof Error) e.message = `${e.message}; ${left}`;
    throw e;
  }
  return stage;
}

/**
 * Remove a stage, whatever modes its copy of the tree carries: a directory its
 * owner may not write in copies fine and then keeps its files, so every
 * directory is made the owner's first (no link followed). Returns null, or
 * what is left as a message naming the path — returned, not thrown, so that it
 * never stands in for the error of the step before it.
 */
export function removeStage(stage) {
  const open = (d) => {
    try {
      chmodSync(d, 0o700);
      for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) open(join(d, e.name));
    } catch { /* what could not be opened, rmSync reports below */ }
  };
  try {
    if (lstatSync(stage, { throwIfNoEntry: false })?.isDirectory()) open(stage);
    rmSync(stage, { recursive: true, force: true });
  } catch (e) {
    return `the stage ${stage} could not be removed (${(e && e.code) || e})`;
  }
  LIVE_STAGES.delete(stage);
  return null;
}

/** `docker <args>` as the operator's own tool: an argv, the operator's environment, no shell, killed after `hardKillMs`. */
const dockerCall = ({ docker, args, env, hardKillMs }) => runProcess({
  bin: docker, args, env, inheritEnv: true, hardKillMs, outputCap: 1000000,
  notFoundHelp: `${docker} not found: suite P needs Docker on this machine`,
});

/** A docker call that is not a step (`call`: a key of `CALL_BOUNDS_S`), for the task `id`: past its bound it is killed and this throws, naming it. */
async function boundedCall({ call, id, docker, args, env }) {
  const boundS = CALL_BOUNDS_S[call];
  const res = await dockerCall({ docker, args, env, hardKillMs: boundS * 1000 });
  if (res.killed) throw new Error(`${id}: docker ${call} did not end within ${boundS} s`);
  return res;
}

/**
 * `docker rm -f <name>`, bounded (`CALL_BOUNDS_S.rm`) → true when docker says
 * the container is gone, false when the removal failed or did not end in time:
 * then the name stays listed, and a signal tries once more.
 */
function removeContainer({ docker, env, name }) {
  const res = spawnSync(docker, ['rm', '-f', name], {
    env: inheritedEnv(env ?? process.env), stdio: 'ignore', timeout: CALL_BOUNDS_S.rm * 1000, killSignal: 'SIGKILL',
  });
  if (res.status !== 0) return false;
  LIVE_CONTAINERS.delete(name);
  return true;
}

const leftContainerLine = (docker, name) => `the container ${name} could not be removed — remove it with: ${docker} rm -f ${name}`;

/**
 * One step (`apply`, `f2p` or `p2p`) of a stage in a container of its own →
 * `{ exit, ms, timedOut, stdout, stderr }`. Past `timeoutS` the docker client
 * is killed and the container removed (`docker rm -f`: killing the client does
 * not stop it), and the step is `exit: null, timedOut: true` — with
 * `leftContainer: <name>` when the removal failed or did not end in time.
 */
export async function runStep({ docker, imageId, stage, step, timeoutS, env }) {
  // No bound, no container: a missing `timeoutS` would otherwise start a step nothing ever kills.
  if (!Number.isInteger(timeoutS) || timeoutS < 1) throw new TypeError(`runStep needs timeoutS, a whole number of seconds (got ${JSON.stringify(timeoutS)})`);
  const name = `omelette-evals-${process.pid}-${randomBytes(4).toString('hex')}`;
  const args = dockerRunArgs({ imageId, stage, name, step, uid: process.getuid(), gid: process.getgid() });
  const t0 = Date.now();
  LIVE_CONTAINERS.set(name, { docker, env });
  let res;
  try {
    res = await dockerCall({ docker, args, env, hardKillMs: timeoutS * 1000 });
  } catch (e) {
    LIVE_CONTAINERS.delete(name); // docker did not start: there is no container
    throw e;
  }
  const ms = Date.now() - t0;
  if (res.killed) {
    const timedOut = { exit: null, ms, timedOut: true, stdout: res.stdout, stderr: res.stderr };
    return removeContainer({ docker, env, name }) ? timedOut : { ...timedOut, leftContainer: name };
  }
  LIVE_CONTAINERS.delete(name); // `--rm`: it went with its step
  return { exit: res.code, ms, timedOut: false, stdout: res.stdout, stderr: res.stderr };
}

const SIGNAL_EXITS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
let cleanupInstalled = false;

/**
 * For a CLI that runs steps: told to stop (SIGINT, SIGTERM, SIGHUP), it kills
 * its docker clients (each a process group of its own, so the signal did not
 * reach them), removes the container of every step in flight and every stage
 * — a stage can hold the gold — and exits 130, 143 or 129. What could not be
 * removed is named on `err`. Installed once per process.
 */
export function installCleanup({ err = (l) => console.error(l) } = {}) {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const say = (line) => { try { err(`eval-patch: ${line}`); } catch { /* the terminal is gone */ } };
  for (const [signal, code] of Object.entries(SIGNAL_EXITS)) {
    process.on(signal, () => {
      killLiveGroups();
      for (const [name, { docker, env }] of [...LIVE_CONTAINERS]) {
        if (!removeContainer({ docker, env, name })) say(leftContainerLine(docker, name));
      }
      for (const stage of [...LIVE_STAGES]) {
        const left = removeStage(stage);
        if (left) say(left);
      }
      process.exit(code);
    });
  }
}

/** The id of an image the daemon holds, or null when it holds none by that name. */
async function imageIdOf({ id, docker, env, ref }) {
  const res = await boundedCall({ call: 'image inspect', id, docker, args: ['image', 'inspect', '--format', '{{.Id}}', ref], env });
  if (res.code !== 0) return null;
  const imageId = res.stdout.trim();
  if (!IMAGE_ID.test(imageId)) throw new Error(`docker image inspect printed no image id for ${ref}`);
  return imageId;
}

/** A `FROM` line: the image it names and, after `AS`, the stage's name. */
const FROM_LINE = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:[ \t]+AS[ \t]+(\S+))?/gim;

/**
 * Why building a Dockerfile could fetch an image other than `image`, or null:
 * a `FROM` naming another one; a `# syntax=` directive (the frontend it names
 * is an image); a `--from=<x>` flag or a `from=<x>` of a `--mount` whose `<x>`
 * is neither a stage the file declares (`FROM … AS <x>`, any case) nor the
 * index of one. Read word by word, whatever instruction the word is in: a
 * shell command with such a word in it is refused too.
 */
function dockerfileProblem(text, image) {
  const stages = [];
  let count = 0;
  for (const [, ref, name] of text.matchAll(FROM_LINE)) {
    if (ref !== image) return `builds FROM ${ref}, not the task's image`;
    count += 1;
    if (name) stages.push(name.toLowerCase());
  }
  if (/^[ \t]*#[ \t]*syntax[ \t]*=/im.test(text)) return 'carries a "# syntax=" directive, which fetches the image of another frontend';
  for (const word of text.split(/\s+/)) {
    const flag = /^--from=(.*)$/i.exec(word);
    const mount = /^--mount=(.*)$/i.exec(word);
    const sources = flag ? [flag[1]] : mount ? mount[1].split(',').filter((o) => /^from=/i.test(o)).map((o) => o.slice('from='.length)) : [];
    for (const from of sources) {
      const known = /^\d+$/.test(from) ? Number(from) < count : stages.includes(from.toLowerCase());
      if (!known) return `takes files from ${JSON.stringify(from)}, which is neither a stage it declares nor the index of one`;
    }
  }
  return null;
}

const lastLine = (text) => plain(String(text || '').trim().split('\n').pop());

/**
 * The image a task's steps run, got before any model's diff exists →
 * `{ imageId, built }`. The task's own image is pulled when the daemon does
 * not hold it; with a build directory, an image is built from its Dockerfile,
 * which may fetch no other image (`dockerfileProblem`, read before docker is
 * called). This is the only place the network is used.
 */
export async function prepareImage({ dir, task, docker, env, out = () => {} }) {
  const paths = taskPaths({ dir, task });
  if (paths.build) {
    const problem = dockerfileProblem(readFileSync(join(paths.build, 'Dockerfile'), 'utf8'), task.image);
    if (problem) throw new Error(`${task.id}: the Dockerfile ${problem}`);
  }
  const { id } = task;
  let imageId = await imageIdOf({ id, docker, env, ref: task.image });
  if (!imageId) {
    out(`${task.id}: pulling ${task.image}`);
    const pull = await boundedCall({ call: 'pull', id, docker, args: ['pull', task.image], env });
    if (pull.code !== 0) throw new Error(`${task.id}: docker pull failed (exit ${pull.code}): ${lastLine(pull.stderr)}`);
    imageId = await imageIdOf({ id, docker, env, ref: task.image });
    if (!imageId) throw new Error(`${task.id}: docker pull ended well and the daemon still holds no ${task.image}`);
  }
  if (!paths.build) return { imageId, built: false };
  const tag = `omelette-evals-${task.id.toLowerCase()}:${proofInputs({ dir, task })}`;
  out(`${task.id}: building ${tag}`);
  const build = await boundedCall({ call: 'build', id, docker, args: ['build', '--pull=false', '-t', tag, paths.build], env });
  if (build.code !== 0) throw new Error(`${task.id}: docker build failed (exit ${build.code}): ${lastLine(build.stderr)}`);
  const builtId = await imageIdOf({ id, docker, env, ref: tag });
  if (!builtId) throw new Error(`${task.id}: docker build ended well and the daemon holds no ${tag}`);
  return { imageId: builtId, built: true };
}

/** True when a P run line for the task is filed — an arm's answer, or one filed by hand — in any `runs/<date>/*.jsonl`, whatever the file is called. */
function hasRunLine(dir, id) {
  const runs = join(dir, 'runs');
  if (!existsSync(runs)) return false;
  for (const day of readdirSync(runs, { withFileTypes: true })) {
    if (!day.isDirectory()) continue;
    for (const file of readdirSync(join(runs, day.name))) {
      if (!file.endsWith('.jsonl')) continue;
      if (readJsonl(join(runs, day.name, file)).some((l) => l && l.suite === 'P' && Array.isArray(l.taskIds) && l.taskIds.includes(id))) return true;
    }
  }
  return false;
}

/**
 * One state of a task (the snapshot, or the snapshot with `change`) through
 * its steps, in a stage of its own, removed after them. A stage that could not
 * be removed is an error naming its path: this state's own when its steps
 * ended well, added to the steps' error when they did not.
 */
async function runState({ dir, task, change, docker, imageId, env, out }) {
  const stage = makeStage({ dir, task, change });
  const step = async (name) => {
    const res = await runStep({ docker, imageId, stage, step: name, timeoutS: task.timeoutS ?? DEFAULT_TIMEOUT_S, env });
    if (res.leftContainer) out(`${task.id}: ${leftContainerLine(docker, res.leftContainer)}`);
    return res;
  };
  const test = async (name) => {
    const { exit, ms, timedOut } = await step(name);
    return { exit, ms, timedOut };
  };
  let state = null;
  let failure = null;
  try {
    const applied = await step('apply');
    const method = applied.exit === 0 ? /^applied-by (\S+)/m.exec(applied.stdout) : null;
    const apply = { exit: applied.exit, method: method ? plain(method[1]) : null };
    state = applied.exit !== 0 ? { apply, failToPass: null, passToPass: null } : { apply, failToPass: await test('f2p'), passToPass: await test('p2p') };
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e));
  }
  const left = removeStage(stage);
  if (failure) {
    if (left) failure.message = `${failure.message}; ${left}`;
    throw failure;
  }
  if (left) throw new Error(`${task.id}: ${left}`);
  return state;
}

/** The fail-to-pass test failed: it ran to its end and the exit code is the test's own, not the harness's. */
const failed = (step) => !!step && !step.timedOut && Number.isInteger(step.exit) && step.exit !== 0 && !HARNESS_EXITS.includes(step.exit);
const passed = (step) => !!step && step.exit === 0;
const exitWord = (step) => (!step ? '-' : step.timedOut ? 'timeout' : String(step.exit));

/**
 * Prove a task's gold patch `reps` times over and write the proof to
 * `<dir>/checks/proofs/<id>.json`, the operator's alone; returns it (`ok`
 * says whether it held). Throws, before docker is called, for `reps` that is
 * not a whole number of at least 1, and for a task that is not sound or that
 * already has a model's run line. Says which daemon docker is pointed at when
 * the environment points it at one.
 */
export async function prove({ dir, task, docker, env, reps = 3, out = () => {} }) {
  if (!Number.isInteger(reps) || reps < 1) throw new TypeError(`prove needs reps, a whole number of at least 1 (got ${JSON.stringify(reps)})`);
  const paths = taskPaths({ dir, task });
  if (hasRunLine(dir, task.id)) throw new Error(`${task.id}: a model's diff already exists — a build now would use the network after it`);
  const gold = readFileSync(paths.gold, 'utf8');
  stageTexts({ dir, task, change: gold }); // what its stages would be refused for, before docker is called
  const inputs = proofInputs({ dir, task });
  const pointed = ['DOCKER_HOST', 'DOCKER_CONTEXT'].filter((name) => (env ?? process.env)[name]).map((name) => `${name}=${plain((env ?? process.env)[name])}`);
  if (pointed.length) out(`${task.id}: docker is pointed at a daemon by ${pointed.join(', ')}`);
  const { imageId, built } = await prepareImage({ dir, task, docker, env, out });
  const results = [];
  for (let rep = 1; rep <= reps; rep++) {
    const snapshot = await runState({ dir, task, change: null, docker, imageId, env, out });
    const withGold = await runState({ dir, task, change: gold, docker, imageId, env, out });
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
  // `mode` counts for what a call creates: a file or a directory that was there keeps its own.
  chmodSync(file, 0o600);
  for (const made of [dirname(file), dirname(dirname(file))]) chmodSync(made, 0o700);
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
  try { tasks = readPTasks(dir, { only: values.task }); } catch (e) { err(`eval-patch: ${(e && e.message) || e}`); return 1; }
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
  installCleanup();
  process.exitCode = await main();
}
