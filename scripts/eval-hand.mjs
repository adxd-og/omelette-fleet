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
 * the operator's alone. A P task without a fresh gold proof is refused, as
 * eval-run refuses it. It prints the snapshot's path and the brief's: never the
 * brief's text.
 *
 * FILE appends one run line, marked `hand: true`, to
 * `<D>/runs/<date>/<suite>-<arm>.jsonl` (`<date>` defaulting to today, local):
 * the answer file's text (a P line's answer is the text holding its diff), or
 * the failure. `usage` is `{total}`, the harness's sub-agent token total — not
 * input plus output, which the harness does not report apart. It prints the
 * suite, arm, task, run and file: never the answer.
 *
 * PRIVATE IN, PRIVATE OUT: D defaults to `<repo>/.omelette/evals` (ignored by
 * git). This file holds no task text, no key and no answer.
 */
import { closeSync, fchmodSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  appendRunLine, armSlug, assertProven, briefFor, DEFAULT_DIR, isEmptyCall, localDate, nextRunFor, prepareTasks, readTasks, selectTasks,
} from './eval-run.mjs';

const USAGE = [
  'usage: node scripts/eval-hand.mjs brief --suite V|P --task ID [--dir D] [--out FILE]',
  '       node scripts/eval-hand.mjs file --suite V|P --arm native:<role> --task ID (--answer FILE | --failed TEXT) --model ID --wall-ms N',
  '            [--effort E] [--cli TEXT] [--tokens N] [--run N] [--started-at ISO] [--date YYYY-MM-DD] [--dir D]',
].join('\n');

const HAND_SUITES = ['V', 'P'];
const NATIVE_ARM = /^native:[a-z0-9][a-z0-9-]*$/;
const MAX_ANSWER_BYTES = 1024 * 1024;
/** A task id fit for a file name under `<D>/hand/`: nothing that climbs out of it. */
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A native arm reads its task's code as its cwd, as every arm but Gemini's does. */
const CWD_ARM = { unit: 'native' };

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
  if (!NATIVE_ARM.test(v.arm ?? '')) p.push('--arm must be native:<role>, the role in lower-case letters, digits and "-"');
  if ((v.answer === undefined) === (v.failed === undefined)) p.push('exactly one of --answer FILE and --failed TEXT');
  else if (v.failed !== undefined && !v.failed.trim()) p.push('--failed needs the failure\'s text');
  if (!v.model || !v.model.trim()) p.push('--model ID is required');
  if (wholeFrom(v['wall-ms'], 0) === null) p.push('--wall-ms must be a whole number of milliseconds, 0 or more');
  if (v.tokens !== undefined && wholeFrom(v.tokens, 0) === null) p.push('--tokens must be a whole number, 0 or more');
  if (v.run !== undefined && wholeFrom(v.run, 1) === null) p.push('--run must be a whole number, 1 or more');
  if (v['started-at'] !== undefined && !Number.isFinite(Date.parse(v['started-at']))) p.push('--started-at must be a date and time (ISO 8601)');
  if (v.date !== undefined && !/^\d{4}-\d\d-\d\d$/.test(v.date)) p.push('--date must be YYYY-MM-DD');
  if (v.answer !== undefined) {
    let st = null;
    try { st = statSync(v.answer); } catch { /* reported below */ }
    if (!st || !st.isFile()) p.push(`--answer ${v.answer} is not a file`);
    else if (st.size > MAX_ANSWER_BYTES) p.push('--answer: the file is over 1 MiB');
  }
  return p;
}

/** The task `id` of `suite`, read and checked as eval-run reads it; throws when the suite has no such task. */
function taskOf(dir, suite, id) {
  const [task] = selectTasks(readTasks(dir, suite, { only: [id] }), [id]);
  return task;
}

/** `text` to `path`, the operator's alone (0600) before a byte lands, whatever mode a file already there had. */
function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'w', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** `brief`: the snapshot and the brief file; returns the lines to print. */
function cmdBrief({ dir, suite, id, out }) {
  const task = taskOf(dir, suite, id);
  if (!out && !FILE_ID.test(task.id)) throw new Error(`task id ${JSON.stringify(task.id)} cannot name a file under ${join(dir, 'hand')}: pass --out`);
  if (suite === 'P') assertProven({ dir, tasks: [task] });
  const [ready] = prepareTasks(suite, [task], { arm: CWD_ARM, dir });
  const path = out ? resolve(out) : join(dir, 'hand', `${suite}-${task.id}.brief.md`);
  writePrivate(path, briefFor(suite, ready, { inline: false }));
  return [`snapshot ${ready.snapshot}`, `brief ${path}`];
}

/** `file`: one hand-filed run line appended; returns the line to print. */
function cmdFile({ dir, suite, v, now }) {
  const task = taskOf(dir, suite, v.task);
  const wallMs = wholeFrom(v['wall-ms'], 0);
  const ok = v.answer !== undefined;
  const answer = ok ? readFileSync(v.answer, 'utf8') : null;
  const error = ok ? null : v.failed;
  const date = v.date ?? localDate(now());
  const file = join(dir, 'runs', date, `${suite}-${armSlug(v.arm)}.jsonl`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const run = v.run === undefined ? nextRunFor(file, [task.id]) : wholeFrom(v.run, 1);
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
    else out(cmdFile({ dir, suite: v.suite, v, now }));
  } catch (e) { err(`eval-hand: ${(e && e.message) || e}`); return 1; }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = main();
}
