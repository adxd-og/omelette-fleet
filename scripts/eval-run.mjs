#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/eval-run.mjs
 * The evals runner: one suite, one or more arms, every call through the real
 * unit path (plan docs/superpowers/plans/2026-10-16-evals-mvp.md, Task 1).
 *
 *   node scripts/eval-run.mjs --suite R|V --arm <unit>:<model>[:<effort>] [--arm …]
 *        [--runs N] [--batch] [--dir D] [--snapshot PATH] [--dry-run]
 *
 * PRIVATE IN, PRIVATE OUT. It reads `<D>/suites/<suite>/tasks.jsonl` and writes
 * `<D>/runs/<YYYY-MM-DD>/<suite>-<arm>.jsonl`, D defaulting to
 * `<repo>/.omelette/evals` (ignored by git). This file holds no task text, no
 * key and no answer, and nothing it prints quotes one: the plan of calls names
 * task ids and prompt lengths only.
 *
 * THE REAL PATH. Each call is `callUnitServer` on `servers/<unit>.mjs`, as
 * `omelette-fleet call` makes it, so the unit's guards, sandbox, env allowlist,
 * billing scrub, timeouts and config all apply. One server per call, calls one
 * at a time, arms in the order given. A failed call is a line with `ok: false`;
 * this runner never retries (the unit's own bounded retry is part of its path).
 *
 * USAGE, MODEL AND EFFORT come from the call's own result-spool record — the
 * record `omelette-fleet results --stats` totals (core/results.mjs). A unit
 * files each call under `<stamp>-<server pid>-<seq>`, and `callUnitServer`
 * hands back the pid of the server it ran, so the record is found by that pid
 * (plus the tool and a start no earlier than the call's): a neighbour's call
 * finishing in the same second, from another session, never matches. No
 * record — the spool switched off — is `null` for all three, never a guess.
 * The effort is the one the unit reports it used (a pairing or the operator's
 * configured effort, when the arm named none); for Gemini it is the level in
 * the model id the unit reports.
 *
 * THE V SNAPSHOT is `git archive` of the task's commit, extracted with no
 * `.git`. A review runs with it as `cwd`, so it is refused when git can still
 * reach a repository from it: inside the live checkout's tree git walks up to
 * its `.git`, and the later fixes would be one `git log` away.
 *
 * The vendor CLI's `--version` is read once per arm, the way `doctor` reads it
 * (core/spawn.mjs, with the unit's env allowlist and billing scrub).
 */
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { callUnitServer } from '../core/client.mjs';
import { fleetHome, unitConfig } from '../core/config.mjs';
import { createResultStore } from '../core/results.mjs';
import { runProcess } from '../core/spawn.mjs';
import { locateBin, resolveBin } from '../core/unit.mjs';
import codexUnit from '../units/codex/adapter.mjs';
import geminiUnit from '../units/gemini/adapter.mjs';
import grokUnit from '../units/grok/adapter.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_DIR = join(ROOT, '.omelette', 'evals');
export const UNITS = { gemini: geminiUnit, grok: grokUnit, codex: codexUnit };
export const SUITES = ['R', 'V'];

/** The tool each suite calls on each unit: the research tool for R; the review tool for V, Gemini having none. */
export const TOOL_FOR = {
  R: { gemini: 'gemini_research', grok: 'grok_research', codex: 'codex_research' },
  V: { gemini: 'gemini_research', grok: 'grok_code_review', codex: 'codex_code_review' },
};

const USAGE = 'usage: node scripts/eval-run.mjs --suite R|V --arm <unit>:<model>[:<effort>] [--arm …] [--runs N] [--batch] [--dir D] [--snapshot PATH] [--dry-run]';
const GEMINI_LEVEL = /\((Low|Medium|High)\)$/;
const COMMIT_RE = /^[0-9a-f]{4,40}$/i;

/**
 * `<unit>:<model>[:<effort>]` → the arm. Gemini's effort is part of its model
 * id (`gemini:Gemini 3.8 Flash:high` is `Gemini 3.8 Flash (High)`); Codex and
 * Grok take it as `effort`, and with none named the unit applies its own
 * (Codex: the model's pairing). The model is checked against the unit's
 * catalog here, before anything is spent. Throws on anything else.
 */
export function parseArm(spec) {
  const s = String(spec ?? '').trim();
  const [unitName, model = '', effort = '', ...extra] = s.split(':').map((p) => p.trim());
  const where = `arm "${s}"`;
  const unit = UNITS[unitName];
  if (!unit) throw new Error(`${where}: unknown unit "${unitName}" — known units: ${Object.keys(UNITS).join(', ')}`);
  if (!model) throw new Error(`${where}: no model — write <unit>:<model>[:<effort>]`);
  if (extra.length) throw new Error(`${where}: too many parts — write <unit>:<model>[:<effort>]`);
  const { catalog } = unit;
  if (unitName === 'gemini') {
    let id = model;
    if (effort) {
      if (GEMINI_LEVEL.test(model)) throw new Error(`${where}: the effort is already in the model id`);
      const level = effort.toLowerCase();
      id = `${model} (${level.charAt(0).toUpperCase()}${level.slice(1)})`;
    }
    if (!catalog.isAllowedModel(id)) {
      throw new Error(`${where}: unknown model "${id}"${effort ? ' (or effort)' : ''} — the catalog has: ${catalog.ids.join(', ')}`);
    }
    return { arm: `gemini:${id}`, unit: 'gemini', model: id, effort: null };
  }
  if (!catalog.isAllowedModel(model)) throw new Error(`${where}: unknown model "${model}" — the catalog has: ${catalog.ids.join(', ')}`);
  const e = effort.toLowerCase();
  if (e && !catalog.isAllowedEffort(e)) throw new Error(`${where}: unknown effort "${effort}" — allowed: ${catalog.efforts.join(', ')}`);
  return { arm: `${unitName}:${model}${e ? `:${e}` : ''}`, unit: unitName, model, effort: e || null };
}

/** The arm as a file-name part: `codex:gpt-6.1-sol` → `codex-gpt-6.1-sol`. */
export const armSlug = (arm) => String(arm).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');

/** Every question in one prompt, numbered, with an answer asked for under each number. */
export function batchPrompt(tasks) {
  return [
    `Answer each of the ${tasks.length} numbered questions below. Give every question its own answer, under its number ("1.", "2.", and so on), so that each number has an answer.`,
    ...tasks.map((t, i) => `${i + 1}. ${t.prompt}`),
  ].join('\n\n');
}

/** A code fence longer than any run of backticks in the text, so the file cannot close it early. */
function fenceFor(text) {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Gemini has no review tool: the brief, then the file's text from the snapshot. */
export function inlineFilePrompt(task) {
  const fence = fenceFor(task.fileText);
  return `${task.prompt}\n\nThe file under review, ${task.file}, as it stood at that commit:\n\n${fence}\n${task.fileText}\n${fence}`;
}

/**
 * The calls one run of an arm makes: `[{taskIds, tool, args}]`, in order. Pure.
 * V tasks arrive with `snapshot` (an absolute path) and, for Gemini, `fileText`.
 */
export function planCalls({ suite, arm, tasks, batch = false }) {
  const tool = TOOL_FOR[suite] && TOOL_FOR[suite][arm.unit];
  if (!tool) throw new Error(`no tool for suite "${suite}" on unit "${arm.unit}"`);
  if (batch && suite !== 'R') throw new Error('--batch is for suite R only: V has one brief per call');
  const base = { model: arm.model, ...(arm.effort ? { effort: arm.effort } : {}) };
  if (batch) return [{ taskIds: tasks.map((t) => t.id), tool, args: { prompt: batchPrompt(tasks), ...base } }];
  return tasks.map((t) => {
    if (suite === 'R') return { taskIds: [t.id], tool, args: { prompt: t.prompt, ...base } };
    if (arm.unit === 'gemini') return { taskIds: [t.id], tool, args: { prompt: inlineFilePrompt(t), ...base } };
    return { taskIds: [t.id], tool, args: { prompt: t.prompt, ...base, cwd: t.snapshot } };
  });
}

/** The environment git runs in here: the caller's, minus every GIT_* variable that could point it elsewhere. */
function gitEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
}

/**
 * Refuse a snapshot from which any git history is reachable: a `.git` of its
 * own, or a repository git finds by walking up from it.
 */
export function assertNoHistory(path) {
  let ownGit = false;
  try { lstatSync(join(path, '.git')); ownGit = true; } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  if (ownGit) throw new Error(`snapshot ${path} holds a .git — a review there could read the history that holds the later fixes`);
  const reached = reachableGitDir(path);
  if (reached) {
    throw new Error(
      `git reaches a repository from snapshot ${path} (${reached}): a review there could read the history ` +
      'that holds the later fixes — pass --snapshot with a path outside every git work tree',
    );
  }
}

/** The git directory git finds by walking up from `dir`, or `null` when it finds none. */
function reachableGitDir(dir) {
  const r = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: dir, encoding: 'utf8', env: gitEnv() });
  if (r.error) throw new Error(`git could not run to check the snapshot: ${r.error.message}`);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The nearest directory at or above `path` that exists. */
function nearestExisting(path) {
  let d = path;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return d;
}

/**
 * The tree of `commit` in `repo`, extracted at `path` with no `.git`; made when
 * absent, reused when present. With `guard` (the default) the snapshot is
 * refused when git history is reachable from it — always, for a review's cwd.
 * Returns `path`.
 */
export function ensureSnapshot({ repo = ROOT, commit, path, guard = true }) {
  if (!COMMIT_RE.test(String(commit ?? ''))) throw new Error(`"${commit}" is not a commit id`);
  if (!isAbsolute(path)) throw new Error(`snapshot path ${path} is not absolute`);
  if (existsSync(path)) {
    if (guard) assertNoHistory(path);
    return path;
  }
  // A file, not a pipe: a tar that stops reading at the end-of-archive marker
  // would leave the writer of a pipe with EPIPE on the padding behind it.
  const staging = `${path}.tmp-${process.pid}`;
  const archive = `${staging}.tar`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const a = spawnSync('git', ['archive', '--format=tar', `--output=${archive}`, commit], { cwd: repo, env: gitEnv(), encoding: 'utf8' });
    if (a.error || a.status !== 0) throw new Error(`git archive ${commit} failed: ${(a.error && a.error.message) || a.stderr.trim()}`);
    const x = spawnSync('tar', ['-x', '-f', archive, '-C', staging], { encoding: 'utf8' });
    if (x.error || x.status !== 0) throw new Error(`tar could not extract the snapshot: ${(x.error && x.error.message) || x.stderr.trim()}`);
    if (guard) assertNoHistory(staging);
    renameSync(staging, path);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(archive, { force: true });
  }
  return path;
}

/**
 * The spool record of the call a server with `pid` made with `tool`, started
 * no earlier than `sinceMs` (a second of slack for clock rounding): `{resultId,
 * model, effort, usage}`, or `null` when there is not exactly one.
 */
export function findCallRecord({ home, unit, pid, tool, sinceMs }) {
  if (!Number.isInteger(pid)) return null;
  const store = createResultStore({ home, unit });
  const hits = store.list(Number.MAX_SAFE_INTEGER).filter((e) => {
    const [, p] = e.resultId.split('-');
    const t = Date.parse(e.startedAt);
    return p === String(pid) && e.tool === tool && Number.isFinite(t) && t >= sinceMs - 1000;
  });
  if (hits.length !== 1) return null;
  const rec = store.read(hits[0].resultId);
  if (!rec) return null;
  const h = rec.header;
  return { resultId: h.resultId || hits[0].resultId, model: h.model || null, effort: h.effort || null, usage: h.usage || null };
}

/** The effort a record says was used: its own, or the level in a Gemini model id. */
const usedEffort = (rec) => {
  if (!rec) return null;
  if (rec.effort) return rec.effort;
  const m = GEMINI_LEVEL.exec(rec.model || '');
  return m ? m[1].toLowerCase() : null;
};

/** A version token, whole: `1.4.0`, `0.46.0-beta.2`. */
const VERSION_TOKEN = /^\d+\.\d+(\.\d+)?([-+.\w]*)?$/;

/**
 * `<bin> --version`, read as doctor reads it, in the env the unit gives its CLI:
 * the CLI's own name and the first version token of its first line (`agy 1.4.0`),
 * never the raw line, which may hold a path.
 */
export async function cliVersion(unit, env = process.env) {
  const bin = locateBin(resolveBin(unit, env), env);
  if (!bin) return 'unknown (not found)';
  let r;
  try {
    r = await runProcess({ bin, args: ['--version'], env, hardKillMs: 10000, envPassthrough: unit.envPassthrough, scrubEnv: unit.riskEnv });
  } catch (e) { return `unknown (${(e && e.message) || e})`; }
  if (r.killed) return 'unknown (no answer in 10s)';
  if (r.code !== 0) return `unknown (exit ${r.code})`;
  const first = (s) => String(s || '').trim().split('\n')[0].trim();
  const line = first(r.stdout) || first(r.stderr);
  if (!line) return 'unknown (no output)';
  const version = line.split(/\s+/).find((t) => VERSION_TOKEN.test(t));
  return version ? `${unit.bin.default} ${version}` : 'unknown (no version in its output)';
}

/** A local calendar date, `YYYY-MM-DD`: the day the operator ran the arm. */
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
  try { return JSON.parse(l); } catch (e) { throw new Error(`${path}:${i + 1}: not JSON (${e.message})`); }
});

/** The suite's tasks; each needs an id and a prompt, and a V task a commit and a file. */
export function readTasks(dir, suite) {
  const path = join(dir, 'suites', suite, 'tasks.jsonl');
  if (!existsSync(path)) throw new Error(`no suite at ${path}`);
  const tasks = readJsonl(path);
  for (const t of tasks) {
    if (!t || typeof t.id !== 'string' || !t.id || typeof t.prompt !== 'string' || !t.prompt) throw new Error(`${path}: every task needs an id and a prompt`);
    if (suite === 'V' && (typeof t.commit !== 'string' || typeof t.file !== 'string')) throw new Error(`${path}: task ${t.id} needs a commit and a file`);
  }
  if (!tasks.length) throw new Error(`${path} holds no task`);
  return tasks;
}

/** The first run number this arm's file has not used yet. */
function nextRun(file) {
  if (!existsSync(file)) return 1;
  const runs = readJsonl(file).map((l) => Number(l.run)).filter(Number.isInteger);
  return runs.length ? Math.max(...runs) + 1 : 1;
}

/**
 * V tasks with their snapshot (and, for Gemini, the file's text). A review's
 * snapshot is guarded; Gemini only has the file read out of it. `extract:
 * false` (the dry run) reads what is there and makes nothing.
 */
function prepareV(tasks, { arm, dir, repo, snapshot, extract = true }) {
  const commits = new Set(tasks.map((t) => t.commit));
  if (snapshot && commits.size > 1) throw new Error('--snapshot names one tree, and these tasks are at more than one commit');
  const asCwd = arm.unit !== 'gemini';
  return tasks.map((t) => {
    // Outside every work tree by default: under the private dir, git would walk up to the live .git and its later fixes.
    const path = snapshot ? resolve(snapshot) : join(tmpdir(), 'omelette-evals', 'snapshots', t.commit);
    const present = existsSync(path);
    if (extract) ensureSnapshot({ repo, commit: t.commit, path, guard: asCwd });
    else if (present && asCwd) assertNoHistory(path);
    let fileText = null;
    if (arm.unit === 'gemini' && (extract || present)) {
      const file = resolve(path, t.file);
      const rel = relative(path, file);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`task ${t.id}: file ${t.file} is outside the snapshot`);
      fileText = readFileSync(file, 'utf8');
    }
    return { ...t, snapshot: path, snapshotPresent: present, fileText };
  });
}

/**
 * Run one arm of one suite `runs` times; every call appends its line as soon
 * as it ends. Returns `{file, lines}`. `serverPath` replaces the unit's server
 * (tests); `now` dates the run directory.
 */
export async function runArm({
  suite, arm, runs = 1, batch = false, dir = DEFAULT_DIR, repo = ROOT, snapshot, env = process.env,
  now = () => new Date(), serverPath, out = (l) => console.log(l),
}) {
  const unit = UNITS[arm.unit];
  let tasks = readTasks(dir, suite);
  if (suite === 'V') tasks = prepareV(tasks, { arm, dir, repo, snapshot });
  const calls = planCalls({ suite, arm, tasks, batch });
  const file = join(dir, 'runs', localDate(now()), `${suite}-${armSlug(arm.arm)}.jsonl`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const first = nextRun(file);
  const cli = await cliVersion(unit, env);
  const cfg = unitConfig({ unit: unit.name, envMap: unit.envMap, builtin: unit.builtin, extraSchema: unit.extraSchema, supportedModes: unit.supportedModes, env });
  // The unit's own hard kill governs, and its bounded retry may run the CLI twice.
  const timeoutS = cfg.values.timeoutS * 2 + 60;
  const server = serverPath || join(ROOT, 'servers', `${arm.unit}.mjs`);
  const home = fleetHome(env);
  out(`${suite} ${arm.arm} · ${cli} · ${calls.length} call(s) × ${runs} run(s) → ${file}`);
  const lines = [];
  let unmatched = 0;
  for (let run = first; run < first + runs; run++) {
    for (const call of calls) {
      const t0 = Date.now();
      let res = null;
      let failure = null;
      try {
        res = await callUnitServer({ serverPath: server, tool: call.tool, args: call.args, timeoutS, env });
      } catch (e) { failure = (e && e.message) || String(e); }
      const rec = res ? findCallRecord({ home, unit: arm.unit, pid: res.pid, tool: call.tool, sinceMs: t0 }) : null;
      if (res && !rec) unmatched += 1;
      const ok = !!res && !res.isError;
      const line = {
        suite,
        taskIds: call.taskIds,
        arm: arm.arm,
        unit: arm.unit,
        model: rec ? rec.model : null,
        effort: usedEffort(rec),
        run,
        cli,
        startedAt: new Date(t0).toISOString(),
        wallMs: res ? res.durationMs : Date.now() - t0,
        ok,
        answer: ok ? res.text : null,
        error: ok ? null : (res ? res.text : failure),
        usage: rec ? rec.usage : null,
        resultId: rec ? rec.resultId : null,
      };
      appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 });
      lines.push(line);
      out(`  run ${run}  ${call.taskIds.join(',')}  ${ok ? 'ok' : 'FAILED'}  ${(line.wallMs / 1000).toFixed(1)}s`);
    }
  }
  if (unmatched) out(`  note: ${unmatched} call(s) had no spool record (is \`results\` off for ${arm.unit}?) — their model, effort and usage are null`);
  return { file, lines };
}

/** The dry run: the calls each arm would make, by task id and prompt length. Writes and spawns nothing. */
function printPlan({ suite, arm, runs, batch, dir, repo, snapshot, now, out }) {
  let tasks = readTasks(dir, suite);
  if (suite === 'V') tasks = prepareV(tasks, { arm, dir, repo, snapshot, extract: false });
  const pending = suite === 'V' && arm.unit === 'gemini' && tasks.some((t) => t.fileText === null);
  const calls = planCalls({ suite, arm, tasks: tasks.map((t) => (t.fileText === null ? { ...t, fileText: '' } : t)), batch });
  const file = join(dir, 'runs', localDate(now()), `${suite}-${armSlug(arm.arm)}.jsonl`);
  const first = nextRun(file);
  out(`${suite} ${arm.arm} → ${file} (runs ${first}–${first + runs - 1}; the CLI version is read when it runs)`);
  for (const t of suite === 'V' ? tasks : []) {
    const reached = !t.snapshotPresent && arm.unit !== 'gemini' ? reachableGitDir(nearestExisting(t.snapshot)) : null;
    out(`  snapshot ${t.snapshot} ${t.snapshotPresent ? '(present)' : `(absent: would be extracted from ${t.commit})`}` +
      (reached ? ` — would be REFUSED: git reaches ${reached} from there; pass --snapshot outside every git work tree` : ''));
  }
  for (let run = first; run < first + runs; run++) {
    for (const c of calls) {
      const { prompt, ...rest } = c.args;
      const opts = Object.entries(rest).map(([k, v]) => `${k}=${v}`).join('  ');
      out(`  run ${run}  ${c.taskIds.join(',')}  ${c.tool}  ${opts}  prompt ${prompt.length} chars${pending ? ' + the file\'s text' : ''}`);
    }
  }
}

export async function main(argv = process.argv.slice(2), { out = (l) => console.log(l), err = (l) => console.error(l) } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        suite: { type: 'string' }, arm: { type: 'string', multiple: true }, runs: { type: 'string' },
        batch: { type: 'boolean' }, dir: { type: 'string' }, snapshot: { type: 'string' }, 'dry-run': { type: 'boolean' },
      },
      strict: true, allowPositionals: false,
    }));
  } catch (e) { err(`eval-run: ${e.message}\n${USAGE}`); return 2; }
  const errors = [];
  const suite = values.suite;
  if (!SUITES.includes(suite)) errors.push(`--suite must be one of ${SUITES.join(', ')}`);
  const arms = [];
  for (const spec of values.arm || []) {
    try { arms.push(parseArm(spec)); } catch (e) { errors.push(e.message); }
  }
  if (!(values.arm || []).length) errors.push('at least one --arm');
  const runs = values.runs === undefined ? 1 : Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 100) errors.push('--runs must be a whole number from 1 to 100');
  if (values.batch && suite !== 'R') errors.push('--batch is for suite R only');
  if (errors.length) { for (const e of errors) err(`eval-run: ${e}`); err(USAGE); return 2; }

  const dir = resolve(values.dir || DEFAULT_DIR);
  const opts = { suite, runs, batch: !!values.batch, dir, repo: ROOT, snapshot: values.snapshot, now: () => new Date(), out };
  try {
    for (const arm of arms) {
      if (values['dry-run']) printPlan({ ...opts, arm });
      else {
        const { lines } = await runArm({ ...opts, arm });
        const failed = lines.filter((l) => !l.ok).length;
        out(`  ${lines.length} call(s), ${failed} failed`);
      }
    }
  } catch (e) { err(`eval-run: ${(e && e.message) || e}`); return 1; }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await main();
}
