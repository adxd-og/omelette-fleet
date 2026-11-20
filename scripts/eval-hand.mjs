#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/eval-hand.mjs
 * A native arm filed by hand: a Claude Code sub-agent the session dispatches is
 * no unit, so its answers reach the evals as run lines, and blinding, grading
 * and the aggregate treat them like any other arm's (plan
 * docs/superpowers/plans/2026-11-19-evals-neon.md, T18).
 *
 *   node scripts/eval-hand.mjs brief --suite V|P --task ID [--dir D] [--out FILE]
 *   node scripts/eval-hand.mjs file --suite V|P --arm native:<role> --task ID (--answer FILE | --failed TEXT)
 *        --model ID --wall-ms N [--effort E] [--cli TEXT] [--tokens N] [--run N] [--started-at ISO] [--date YYYY-MM-DD] [--dir D]
 *
 * BRIEF makes the task's snapshot as eval-run makes a cwd arm's — a fresh copy
 * of a tree, `git archive` of a commit, both outside every work tree — and
 * writes the brief a cwd arm is sent to `--out` or `<D>/hand/<suite>-<id>.brief.md`,
 * the operator's alone, opened by one paragraph that confines the sub-agent to
 * the snapshot (it runs in the session's own directory, and nothing but its
 * brief confines it).
 * A P task without a fresh gold proof is refused, as eval-run refuses it. It
 * prints the snapshot's path and the brief's: never the brief's text.
 *
 * FILE appends one run line, marked `hand: true`, to
 * `<D>/runs/<date>/<suite>-<arm>.jsonl` (`<date>` defaulting to today, local):
 * the answer file's text (a P line's answer is the text holding its diff), or
 * the failure. `usage` is `{total}`, the harness's sub-agent token total — not
 * input plus output, which the harness does not report apart. A P task
 * without a fresh gold proof is refused, as BRIEF refuses it, and nothing is
 * filed; so is a `--run` the arm already filed for the task. Once the line is
 * filed, the copy BRIEF made of the task's tree is removed (a commit's
 * snapshot may stay). It prints the suite, arm, task, run and file: never the
 * answer.
 *
 * PRIVATE IN, PRIVATE OUT: D defaults to `<repo>/.omelette/evals` (ignored by
 * git). This file holds no task text, no key and no answer.
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { removeStage } from './eval-patch.mjs';
import {
  appendRunLine, armSlug, assertProven, briefFor, DEFAULT_DIR, isEmptyCall, localDate, nextRunFor, prepareTasks, readTasks, runsFor, selectTasks,
  treeCopyPath, writePrivate,
} from './eval-run.mjs';

const USAGE = [
  'usage: node scripts/eval-hand.mjs brief --suite V|P --task ID [--dir D] [--out FILE]',
  '       node scripts/eval-hand.mjs file --suite V|P --arm native:<role> --task ID (--answer FILE | --failed TEXT) --model ID --wall-ms N',
  '            [--effort E] [--cli TEXT] [--tokens N] [--run N] [--started-at ISO] [--date YYYY-MM-DD] [--dir D]',
].join('\n');

const HAND_SUITES = ['V', 'P'];
/** A role is lower-case letters and digits in groups joined by single hyphens: `native:a-` would share `native:a`'s run file. */
const NATIVE_ARM = /^native:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ANSWER_BYTES = 1024 * 1024;
/** Seven days: the longest wall time a hand-filed call may carry, so that its start is always a date. */
const MAX_WALL_MS = 7 * 24 * 60 * 60 * 1000;
/** A task id fit for a file name under `<D>/hand/`: nothing that climbs out of it. */
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A native arm reads its task's code as its cwd, as every arm but Gemini's does. */
const CWD_ARM = { unit: 'native' };

/**
 * What every brief opens with: a sub-agent runs in the session's own
 * directory, and nothing but its brief confines it to the snapshot.
 */
const confineTo = (snapshot) => `You are reviewing a snapshot of code. Work only inside the directory ${snapshot}: read no file outside it, do not use the web, do not read git history or any other checkout, and run nothing from the snapshot — no install, no build, no test, no script. Your tool calls are read after the run, and a run that leaves the snapshot is discarded.`;

/** The copy `brief` made of a task's tree under the OS temp dir, or null: a commit's snapshot may stay, and an id that names no copy had none. */
function treeCopyOf(suite, task) {
  if (suite !== 'P' && task.tree === undefined) return null;
  try { return treeCopyPath(task.id); } catch { return null; }
}

const OPTIONS = {
  brief: { suite: { type: 'string' }, task: { type: 'string' }, dir: { type: 'string' }, out: { type: 'string' } },
  file: {
    suite: { type: 'string' }, arm: { type: 'string' }, task: { type: 'string' }, answer: { type: 'string' }, failed: { type: 'string' },
    model: { type: 'string' }, 'wall-ms': { type: 'string' }, effort: { type: 'string' }, cli: { type: 'string' }, tokens: { type: 'string' },
    run: { type: 'string' }, 'started-at': { type: 'string' }, date: { type: 'string' }, dir: { type: 'string' },
  },
};

/** A whole number written in digits, `min` or more, as a safe integer; null when the text is not one. */
const wholeFrom = (text, min) => (typeof text === 'string' && /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) >= min ? Number(text) : null);

/** What is wrong with `file`'s arguments, as messages: each one a usage error. */
function fileProblems(v) {
  const p = [];
  if (!NATIVE_ARM.test(v.arm ?? '')) p.push('--arm must be native:<role>, the role lower-case letters and digits in groups joined by single hyphens');
  if ((v.answer === undefined) === (v.failed === undefined)) p.push('exactly one of --answer FILE and --failed TEXT');
  else if (v.failed !== undefined && !v.failed.trim()) p.push('--failed needs the failure\'s text');
  if (!v.model || !v.model.trim()) p.push('--model ID is required');
  const wallMs = wholeFrom(v['wall-ms'], 0);
  if (wallMs === null || wallMs > MAX_WALL_MS) p.push(`--wall-ms must be a whole number of milliseconds from 0 to ${MAX_WALL_MS} (seven days)`);
  if (v.tokens !== undefined && wholeFrom(v.tokens, 0) === null) p.push('--tokens must be a whole number, 0 or more');
  if (v.run !== undefined && wholeFrom(v.run, 1) === null) p.push('--run must be a whole number, 1 or more');
  if (v['started-at'] !== undefined && !Number.isFinite(Date.parse(v['started-at']))) p.push('--started-at must be a date and time (ISO 8601)');
  if (v.date !== undefined && !/^\d{4}-\d\d-\d\d$/.test(v.date)) p.push('--date must be YYYY-MM-DD');
  if (v.answer !== undefined) {
    let st = null;
    try { st = statSync(v.answer); } catch { /* reported below */ }
    // The flag, never its value: an operator who pasted the answer's text here would see it echoed.
    if (!st || !st.isFile()) p.push('--answer is not a file');
    else if (st.size > MAX_ANSWER_BYTES) p.push('--answer: the file is over 1 MiB');
  }
  return p;
}

/** The task `id` of `suite`, read and checked as eval-run reads it; throws when the suite has no such task. */
function taskOf(dir, suite, id) {
  const [task] = selectTasks(readTasks(dir, suite, { only: [id] }), [id]);
  return task;
}

/** `brief`: the snapshot and the brief file; returns the lines to print. */
function cmdBrief({ dir, suite, id, out }) {
  const task = taskOf(dir, suite, id);
  if (!out && !FILE_ID.test(task.id)) throw new Error(`task id ${JSON.stringify(task.id)} cannot name a file under ${join(dir, 'hand')}: pass --out`);
  if (suite === 'P') assertProven({ dir, tasks: [task] });
  const [ready] = prepareTasks(suite, [task], { arm: CWD_ARM, dir });
  const path = out ? resolve(out) : join(dir, 'hand', `${suite}-${task.id}.brief.md`);
  writePrivate(path, `${confineTo(ready.snapshot)}\n\n${briefFor(suite, ready, { inline: false })}`);
  return [`snapshot ${ready.snapshot}`, `brief ${path}`];
}

/** `file`: one hand-filed run line appended, then the task's tree copy removed; returns the line to print. */
function cmdFile({ dir, suite, v, now, err }) {
  const task = taskOf(dir, suite, v.task);
  // Brief's gate: a diff filed before its task is proven would make `prove` refuse the task for ever.
  if (suite === 'P') assertProven({ dir, tasks: [task] });
  const wallMs = wholeFrom(v['wall-ms'], 0);
  const ok = v.answer !== undefined;
  const answer = ok ? readFileSync(v.answer, 'utf8') : null;
  const error = ok ? null : v.failed;
  const date = v.date ?? localDate(now());
  const file = join(dir, 'runs', date, `${suite}-${armSlug(v.arm)}.jsonl`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const run = v.run === undefined ? nextRunFor(file, [task.id]) : wholeFrom(v.run, 1);
  // Two lines of one (arm, run, task) make eval-patch check refuse the whole date.
  if (v.run !== undefined && runsFor(file, [task.id]).includes(run)) throw new Error(`run ${run} of ${v.arm} ${task.id} is filed already in ${file}`);
  const line = {
    suite,
    taskIds: [task.id],
    arm: v.arm,
    unit: 'native',
    model: v.model,
    effort: v.effort || null,
    run,
    cli: v.cli || 'unknown',
    startedAt: new Date(v['started-at'] === undefined ? now().getTime() - wallMs : Date.parse(v['started-at'])).toISOString(),
    wallMs,
    ok,
    answer,
    error,
    empty: isEmptyCall({ ok, answer, error }),
    usage: v.tokens === undefined ? null : { total: wholeFrom(v.tokens, 0) },
    resultId: null,
    agyConversations: null,
    hand: true,
  };
  appendRunLine(file, line);
  // The run is over: its copy goes, as the runner's does when a call ends. The line stays filed whatever the removal does.
  const copy = treeCopyOf(suite, task);
  const left = copy ? removeStage(copy) : null;
  if (left) err(`eval-hand: the copy ${copy} could not be removed — remove it by hand (${left})`);
  return `filed ${suite} ${v.arm} ${task.id} run ${run} → ${file}`;
}

export function main(argv = process.argv.slice(2), { out = (l) => console.log(l), err = (l) => console.error(l), now = () => new Date() } = {}) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(OPTIONS, command ?? '')) { err(`eval-hand: ${command === undefined ? 'a command is needed' : `unknown command ${JSON.stringify(command)}`}\n${USAGE}`); return 2; }
  let v;
  try {
    ({ values: v } = parseArgs({ args: rest, options: OPTIONS[command], strict: true, allowPositionals: false }));
  } catch (e) { err(`eval-hand: ${e.message}\n${USAGE}`); return 2; }
  const errors = [];
  if (!HAND_SUITES.includes(v.suite)) errors.push(`--suite must be one of ${HAND_SUITES.join(', ')}`);
  if (!v.task) errors.push('--task ID is required');
  if (command === 'file') errors.push(...fileProblems(v));
  if (errors.length) { for (const e of errors) err(`eval-hand: ${e}`); err(USAGE); return 2; }

  const dir = resolve(v.dir || DEFAULT_DIR);
  try {
    if (command === 'brief') for (const l of cmdBrief({ dir, suite: v.suite, id: v.task, out: v.out })) out(l);
    else out(cmdFile({ dir, suite: v.suite, v, now, err }));
  } catch (e) { err(`eval-hand: ${(e && e.message) || e}`); return 1; }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = main();
}
