#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/eval-run.mjs
 * The evals runner: one suite, one or more arms, every call through the real
 * unit path (plan docs/superpowers/plans/2026-10-16-evals-mvp.md, Task 1).
 *
 *   node scripts/eval-run.mjs --suite R|V|P|I --arm <unit>:<model>[:<effort>] [--arm …]
 *        [--runs N] [--task ID …] [--batch] [--dir D] [--snapshot PATH] [--dry-run]
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
 * `.git`, or for a task of another project (`tree`) a fresh copy of its
 * directory, which sits strictly under the private dir's `third-party/` (a
 * shown diff is a `.diff` file), refused when a link in it points out of it as
 * the kernel follows it.
 * A review runs with it as `cwd`, so it is refused when git can still reach a
 * repository from it: inside the live checkout's tree git walks up to its
 * `.git`, and the later fixes would be one `git log` away. A V task is keyed,
 * recall-only or a control (run after the others), and shows a file or the
 * diff of the commit that introduced its bug (`show: "diff"`, every arm gets
 * it in its brief). Gemini, which has no review tool, gets the shown text in
 * its brief and no `cwd`.
 *
 * SUITE P runs on Gemini only, and only a task whose gold patch is proven
 * (scripts/eval-patch.mjs, `proofStatus` ok): the bug report and a request for
 * a unified diff, with a fresh copy of the task's tree as `cwd`. The gold and
 * the maintainers' tests stay in the private dir, out of the copy and the brief.
 *
 * SUITE I runs on Gemini only: the honest question about a local document,
 * with a fresh copy of the document's directory (strictly under the private
 * dir's `suites/I/docs/`) as `cwd`. What was planted and what a correct answer
 * holds stay in the task line, outside that directory; eval-inject scores them.
 *
 * A COPY OF A TREE (V's `tree` for a cwd arm, P's tree, I's document directory)
 * is made just before its own call and removed when that call ends, so no
 * model's cwd has another task's copy beside it; every tree is checked before
 * the arm's first call. A commit's snapshot is extracted before it and stays.
 * Every arm's tool is resolved before the first call of any arm.
 *
 * The vendor CLI's `--version` is read once per arm, the way `doctor` reads it
 * (core/spawn.mjs, with the unit's env allowlist and billing scrub).
 */
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  appendFileSync, closeSync, cpSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { callUnitServer } from '../core/client.mjs';
import { fleetHome, unitConfig } from '../core/config.mjs';
import { createResultStore } from '../core/results.mjs';
import { ENV_PASSTHROUGH_VAR, runProcess } from '../core/spawn.mjs';
import { locateBin, resolveBin } from '../core/unit.mjs';
import codexUnit from '../units/codex/adapter.mjs';
import geminiUnit from '../units/gemini/adapter.mjs';
import grokUnit from '../units/grok/adapter.mjs';
import mistralUnit from '../units/mistral/adapter.mjs';
import { proofStatus, pTaskProblems, removeStage } from './eval-patch.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_DIR = join(ROOT, '.omelette', 'evals');
export const UNITS = { gemini: geminiUnit, grok: grokUnit, codex: codexUnit, mistral: mistralUnit };
export const SUITES = ['R', 'V', 'P', 'I'];

/** The tool each suite calls on each unit: the research tool for R; the review tool for V, Gemini having none; P and I on Gemini alone. */
export const TOOL_FOR = {
  R: { gemini: 'gemini_research', grok: 'grok_research', codex: 'codex_research', mistral: 'mistral_security_review' },
  V: { gemini: 'gemini_research', grok: 'grok_code_review', codex: 'codex_code_review', mistral: 'mistral_security_review' },
  P: { gemini: 'gemini_research' },
  I: { gemini: 'gemini_research' },
};

/** The tool `suite` calls on `unit`; throws when the unit has none for that suite. */
function toolFor(suite, unit) {
  const tool = TOOL_FOR[suite] && TOOL_FOR[suite][unit];
  if (!tool) throw new Error(`no tool for suite "${suite}" on unit "${unit}"`);
  return tool;
}

/** What a P brief asks for after the bug report: the fix as a diff, given as text. */
export const P_SUFFIX = 'Answer with the change that fixes it, as one unified diff against the files in the working directory, paths as `git diff` prints them (a/ and b/), inside one ```diff fenced block.';

const USAGE = 'usage: node scripts/eval-run.mjs --suite R|V|P|I --arm <unit>:<model>[:<effort>] [--arm …] [--task ID …] [--runs N] [--batch] [--dir D] [--snapshot PATH] [--dry-run]';
const GEMINI_LEVEL = /\((Low|Medium|High|XHigh)\)$/;
/** The catalog's spelling of each level word an arm may name: `xhigh` is `XHigh`, not `Xhigh`. */
const GEMINI_LEVEL_WORD = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh' };
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
      const word = effort.toLowerCase();
      const level = Object.hasOwn(GEMINI_LEVEL_WORD, word) ? GEMINI_LEVEL_WORD[word] : undefined;
      if (!level) throw new Error(`${where}: unknown effort "${effort}" — a Gemini level is one of ${Object.keys(GEMINI_LEVEL_WORD).join(', ')}`);
      id = `${model} (${level})`;
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

/** The brief, then the diff of the commit that introduced the bug: what every arm is shown for `show: "diff"`. */
export function inlineDiffPrompt(task) {
  const fence = fenceFor(task.diffText);
  return `${task.prompt}\n\nThe change under review, as a unified diff:\n\n${fence}diff\n${task.diffText}\n${fence}`;
}

/**
 * The prompt one task's call sends. V: a shown diff is in every arm's brief; a
 * shown file is in the brief when `inline` (Gemini), and otherwise read from the cwd.
 * P: the bug report, a blank line and `P_SUFFIX` — the tree is the cwd.
 * I: the honest question alone — the document's directory is the cwd.
 */
export function briefFor(suite, task, { inline = false } = {}) {
  switch (suite) {
    case 'V':
      if (task.show === 'diff') return inlineDiffPrompt(task);
      return inline ? inlineFilePrompt(task) : task.prompt;
    case 'P':
      return `${task.prompt}\n\n${P_SUFFIX}`;
    case 'I':
      return task.prompt;
    default:
      throw new Error(`no brief for suite ${suite}`);
  }
}

/**
 * The calls one run of an arm makes: `[{taskIds, tool, args}]`, in order. Pure.
 * V tasks arrive with `snapshot` (an absolute path) for a cwd arm, `fileText`
 * for Gemini, and `diffText` for a task that shows a diff; P tasks with
 * `snapshot`, the copy of their tree; I tasks with `snapshot`, the copy of
 * their document's directory.
 */
export function planCalls({ suite, arm, tasks, batch = false }) {
  const tool = toolFor(suite, arm.unit);
  if (batch && suite !== 'R') throw new Error('--batch is for suite R only: V has one brief per call');
  const base = { model: arm.model, ...(arm.effort ? { effort: arm.effort } : {}) };
  if (batch) return [{ taskIds: tasks.map((t) => t.id), tool, args: { prompt: batchPrompt(tasks), ...base } }];
  const gemini = arm.unit === 'gemini';
  return tasks.map((t) => {
    if (suite === 'R') return { taskIds: [t.id], tool, args: { prompt: t.prompt, ...base } };
    if (suite === 'P') return { taskIds: [t.id], tool, args: { prompt: briefFor('P', t), ...base, cwd: t.snapshot } };
    if (suite === 'I') return { taskIds: [t.id], tool, args: { prompt: briefFor('I', t), ...base, cwd: t.snapshot } };
    // Gemini V calls keep round one's construction: the shown text inline, no cwd.
    return { taskIds: [t.id], tool, args: { prompt: briefFor('V', t, { inline: gemini }), ...base, ...(gemini ? {} : { cwd: t.snapshot }) } };
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

/** True for a non-empty relative path that stays inside the directory it is read against. */
export function isRelativeInside(rel) {
  return typeof rel === 'string' && rel !== '' && !isAbsolute(rel) && !normalize(rel).startsWith('..');
}

/** True when `rel`, normalised, names something strictly below the relative directory `under`: never `under` itself, never beside it. */
function isStrictlyUnder(rel, under) {
  if (!isRelativeInside(rel) || !isRelativeInside(under)) return false;
  const base = normalize(under).replace(/\/+$/, '');
  if (base === '.') return false;
  const r = normalize(rel);
  return r.startsWith(`${base}/`) && r.slice(base.length + 1).replace(/\/+$/, '') !== '';
}

/** `path` is `root` or under it (both as given: resolve or realpath them alike). */
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Where every V tree sits in the private dir: an allowlist, so the keys and the other suites are never a tree. */
const V_TREES = 'third-party';
/** Where every P tree sits: the place eval-patch checks a P line's tree against. */
const P_TREES = 'third-party';
/** Where every I document's directory sits: under the suite's own directory, never it — its task file holds what was planted. */
const I_DOCS = 'suites/I/docs';

const TREE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Said wherever `--snapshot` meets a task that is not at a commit of this repository. */
const SNAPSHOT_IS_FOR_COMMITS = '--snapshot is for tasks at a commit of this repository';

/**
 * Where a tree task's copy lives: under the OS temp dir, outside every work
 * tree, named by the task id — never an id that reads as a commit id, since a
 * commit's snapshot sits in the same directory, named by its commit.
 */
function treeCopyPath(id) {
  if (!TREE_ID.test(String(id ?? ''))) throw new Error(`task id ${JSON.stringify(id)} cannot name a snapshot directory`);
  if (COMMIT_RE.test(id)) throw new Error(`task id ${JSON.stringify(id)} cannot name a snapshot directory: it reads as a commit id, and the commits' snapshots share that directory`);
  return join(tmpdir(), 'omelette-evals', 'snapshots', id);
}

/**
 * The first link under `root` that is absolute, leads nowhere, or lands outside
 * it, relative to `root`; null when none does. Where a link lands is where the
 * kernel takes it (`realpathSync.native`): `s/..` after a link `s` is the parent
 * of `s`'s target, which a lexical check, or Node's own realpath, reads as `.`.
 */
function linkOutOf(root) {
  const realRoot = realpathSync.native(root);
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) {
        const target = readlinkSync(p);
        if (isAbsolute(target) || !within(root, resolve(d, target))) return relative(root, p);
        let real = null;
        try { real = realpathSync.native(p); } catch { /* dangling, or a loop: refused below */ }
        if (!real || !within(realRoot, real)) return relative(root, p);
      } else if (e.isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(root);
}

/**
 * `<dir>/<rel>`, a third-party tree, refused unless it is a directory strictly
 * under `<dir>/<under>` (required) as written and as the kernel resolves it: a
 * link in the path to the tree, not in it, could still lead out of the place.
 */
function treeIn({ dir, rel, under, who }) {
  if (!isRelativeInside(under) || normalize(under).replace(/\/+$/, '') === '.') {
    throw new Error(`${who} needs "under": the directory of ${dir} its tree must sit strictly under`);
  }
  const place = resolve(dir, under);
  if (!isStrictlyUnder(rel, under)) throw new Error(`tree ${JSON.stringify(rel)} is not a relative path inside ${place}`);
  const src = resolve(dir, rel);
  let st = null;
  try { st = lstatSync(src); } catch { /* reported below */ }
  if (!st || !st.isDirectory()) throw new Error(`tree ${rel} is not a directory under ${dir}`);
  // The place itself is where it is written: `third-party -> suites` would hand out the keys' own directory.
  const realPlace = realpathSync.native(place);
  if (realPlace !== resolve(realpathSync.native(dir), under)) throw new Error(`${place} is reached through a link`);
  const fromPlace = relative(realPlace, realpathSync.native(src));
  if (fromPlace === '' || fromPlace.startsWith('..') || isAbsolute(fromPlace)) throw new Error(`tree ${rel} leads out of ${place} through a link`);
  return src;
}

/**
 * `<dir>/<rel>` checked as a tree to copy, before anything is copied: a
 * directory strictly under `<dir>/<under>` (treeIn), with no link in it that
 * leads out of it and no `.git` of its own — what the copy is refused for,
 * read on the tree itself, so that the runner refuses every task's tree before
 * the arm's first call. Returns the tree's path.
 */
function checkTreeSource({ dir, rel, under, who }) {
  const src = treeIn({ dir, rel, under, who });
  const out = linkOutOf(src);
  if (out) throw new Error(`a link in ${rel} points out of it: ${out}`);
  if (lstatSync(join(src, '.git'), { throwIfNoEntry: false })) throw new Error(`tree ${rel} holds a .git — a review there could read the history that holds the later fixes`);
  return src;
}

/**
 * A fresh copy of `<dir>/<rel>` (a third-party tree) for task `id`, under the
 * OS temp dir; any earlier copy is removed first. `rel` must sit strictly under
 * `<dir>/<under>` (required: `third-party` for V and P, `suites/I/docs` for I),
 * as written and as the kernel resolves it, whatever the caller checked. Links are copied as they are and
 * refused when one points out of the tree; then no git history may be
 * reachable from the copy. Returns its path.
 */
export function materializeTree({ dir, rel, id, under }) {
  const path = treeCopyPath(id);
  const src = checkTreeSource({ dir, rel, under, who: 'materializeTree' });
  rmSync(path, { recursive: true, force: true });
  const staging = `${path}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    cpSync(src, staging, { recursive: true, verbatimSymlinks: true });
    const out = linkOutOf(staging);
    if (out) throw new Error(`a link in ${rel} points out of it: ${out}`);
    assertNoHistory(staging);
    renameSync(staging, path);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  return path;
}

/**
 * The directory a cwd arm reviews for a V task: the commit's tree (at
 * `snapshot` when given) or a fresh copy of the task's tree. `extract: false`
 * (the dry run) returns the path it would use and makes nothing.
 */
export function snapshotFor({ task, dir, repo = ROOT, snapshot, extract = true }) {
  if (task.tree !== undefined) {
    if (snapshot) throw new Error(SNAPSHOT_IS_FOR_COMMITS);
    return extract ? materializeTree({ dir, rel: task.tree, id: task.id, under: V_TREES }) : treeCopyPath(task.id);
  }
  const path = snapshot ? resolve(snapshot) : join(tmpdir(), 'omelette-evals', 'snapshots', task.commit);
  if (extract) return ensureSnapshot({ repo, commit: task.commit, path });
  if (existsSync(path)) assertNoHistory(path);
  return path;
}

/**
 * `file`'s text under `root`, found as the kernel finds it: `file` is appended
 * to the root's native real path unnormalised, so a `..` after a link goes
 * where the kernel takes it. Refused when it, or a link on its way, leads out
 * of `root` or nowhere.
 */
function readInside(root, file, id) {
  let real;
  let realRoot;
  try {
    realRoot = realpathSync.native(root);
    real = realpathSync.native(`${realRoot}${sep}${file}`);
  } catch { throw new Error(`task ${id}: no file ${file} under ${root}, or a link on its way leads nowhere`); }
  if (!within(realRoot, real)) throw new Error(`task ${id}: file ${file} is outside ${root}`);
  return readFileSync(real, 'utf8');
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
  if (!bin) return 'unknown';
  let r;
  try {
    r = await runProcess({ bin, args: ['--version'], env, hardKillMs: 10000, envPassthrough: unit.envPassthrough, scrubEnv: unit.riskEnv });
  } catch { return 'unknown'; }
  if (r.killed) return 'unknown (no answer in 10s)';
  if (r.code !== 0) return `unknown (exit ${r.code})`;
  const first = (s) => String(s || '').trim().split('\n')[0].trim();
  const line = first(r.stdout) || first(r.stderr);
  if (!line) return 'unknown (no output)';
  const version = line.split(/\s+/).find((t) => VERSION_TOKEN.test(t));
  return version ? `${unit.bin.default} ${version}` : 'unknown (no version in its output)';
}

/** A local calendar date, `YYYY-MM-DD`: the day the operator ran the arm. */
export const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * `path`'s JSON lines, blank ones skipped. A line that is not JSON is refused
 * by its line number in the file (blank lines counted) alone: nothing of it —
 * a task's or an answer's text — is quoted.
 */
const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').flatMap((l, i) => {
  if (!l.trim()) return [];
  try { return [JSON.parse(l)]; } catch { throw new Error(`${path}:${i + 1}: not JSON`); }
});

const V_KINDS = ['keyed', 'recall', 'control'];
const V_SHOWS = ['file', 'diff'];

/** What an I document plants: a canary to answer with, a command or link to pass on, a tool call to make, a falsehood to state. */
export const I_CLASSES = ['canary', 'instruct', 'tool', 'falsehood'];
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

/** What is wrong with an I task line: [] when nothing is. */
export function iTaskProblems(t) {
  const p = [];
  if (!isStrictlyUnder(t.doc, I_DOCS)) p.push(`needs a doc: a directory strictly under the private dir's ${I_DOCS}/`);
  if (!I_CLASSES.includes(t.class)) p.push(`needs a class: ${I_CLASSES.join(', ')}`);
  const planted = t.planted && typeof t.planted === 'object' ? t.planted : {};
  if (!Array.isArray(planted.strings) || !planted.strings.every(nonEmpty)) p.push('needs planted.strings: a list of strings');
  else if (!planted.strings.length && t.class !== 'tool') p.push('plants no string: only a tool class may');
  if (planted.call != null && !nonEmpty(planted.call)) p.push('planted.call is a string or null');
  if (t.class === 'tool' && !nonEmpty(planted.call)) p.push('a tool class needs planted.call');
  if (planted.permission != null && !nonEmpty(planted.permission)) p.push('planted.permission is a string or null');
  const alternative = (e) => nonEmpty(e) || (Array.isArray(e) && e.length > 0 && e.every(nonEmpty));
  if (!Array.isArray(t.expect) || !t.expect.length || !t.expect.every(alternative)) p.push('needs expect: strings, or lists of alternatives, a correct answer holds');
  return p;
}

/** A file that is itself there: a link named `x.diff` could show an arm any file of the private dir. */
const isFile = (path) => {
  try { return lstatSync(path).isFile(); } catch { return false; }
};

/**
 * What is wrong with one task line of `suite`, as messages (none: it is
 * sound). `all` is every line of the suite's file, `dir` the private dir.
 * A P line is eval-patch's to judge: its shape always, its files on disk
 * when `onDisk` (a task the arm runs).
 */
function taskProblems(suite, task, all, dir, { onDisk = true } = {}) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return ['not a JSON object'];
  const own = typeof task.id !== 'string' || !task.id || typeof task.prompt !== 'string' || !task.prompt ? ['needs an id and a prompt'] : [];
  switch (suite) {
    case 'R':
      return own;
    case 'P':
      return pTaskProblems(task, onDisk ? { dir } : {});
    case 'I':
      return [...own, ...iTaskProblems(task)];
    case 'V': {
      const kind = task.kind ?? 'keyed';
      const show = task.show ?? 'file';
      if (!V_KINDS.includes(kind)) own.push(`kind ${JSON.stringify(task.kind)} is not one of ${V_KINDS.join(', ')}`);
      if (!V_SHOWS.includes(show)) own.push(`show ${JSON.stringify(task.show)} is not one of ${V_SHOWS.join(', ')}`);
      const hasCommit = task.commit !== undefined;
      if (hasCommit === (task.tree !== undefined)) {
        own.push(hasCommit ? 'names a commit and a tree: exactly one says where its code is' : `needs a commit of this repository or a tree under the private dir's ${V_TREES}/`);
      } else if (hasCommit && (typeof task.commit !== 'string' || !COMMIT_RE.test(task.commit))) own.push(`commit ${JSON.stringify(task.commit)} is not a commit id`);
      else if (!hasCommit && !isStrictlyUnder(task.tree, V_TREES)) own.push(`tree ${JSON.stringify(task.tree)} is not a directory strictly under the private dir's ${V_TREES}/`);
      if (show === 'file' && !isRelativeInside(task.file)) own.push('shows a file, and needs "file": a relative path inside its code');
      if (show === 'diff') {
        if (!isRelativeInside(task.diff)) own.push('shows a diff, and needs "diff": a relative path inside the private dir');
        else if (!task.diff.endsWith('.diff')) own.push(`diff ${JSON.stringify(task.diff)} is not a .diff file`);
        else if (!isFile(resolve(dir, task.diff))) own.push(`diff ${task.diff} is not a file under ${dir}`);
      }
      if (kind === 'control') {
        const of = typeof task.of === 'string' && task.of ? all.find((t) => t && t.id === task.of) : undefined;
        if (typeof task.of !== 'string' || !task.of) own.push('a control needs "of": the recall task it is the control of');
        else if (!of) own.push(`"of" names ${task.of}, and the suite has no such task`);
        else if ((of.kind ?? 'keyed') !== 'recall') own.push(`"of" names ${task.of}, a ${of.kind ?? 'keyed'} task: a control is the control of a recall task`);
        else if (task.prompt !== of.prompt) own.push(`its prompt is not word for word ${task.of}'s: a control's brief is its task's`);
        // The wrapper sentence is part of the brief: it says what is shown, and names a shown file.
        else if (show !== (of.show ?? 'file')) own.push(`it shows a ${show}, and ${task.of} shows a ${of.show ?? 'file'}: a control's brief is its task's, the wrapper sentence included`);
        else if (show === 'file' && task.file !== of.file) own.push(`it shows ${task.file}, and ${task.of} shows ${of.file}: a control's brief names its task's file`);
      }
      return own;
    }
    default:
      return [`suite ${suite} has no task rules`];
  }
}

/** A control character (C0, DEL, C1): in a name written into a brief, a path or a message, it can end a line or a fence. */
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;
/** The fields of a task line that name something, in every suite. */
const NAMING_FIELDS = ['id', 'file', 'tree', 'diff', 'commit', 'doc'];
/**
 * A task id fit for a message: as it is, or, when it holds a control character,
 * quoted with every control character written as its `\uXXXX` escape (and a
 * quote or backslash escaped) — `JSON.stringify` alone leaves U+007F–U+009F raw.
 */
const shownId = (id) => {
  const s = String(id);
  if (!CONTROL_CHAR.test(s)) return id;
  const escape = (c) => (c === '"' || c === '\\' ? `\\${c}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${s.replace(/["\\\u0000-\u001f\u007f-\u009f]/g, escape)}"`;
};

/**
 * The suite's tasks, every line checked (see taskProblems); ids are unique per
 * suite. A line whose id, file, tree, diff, commit or doc holds a control
 * character is refused, as is a task whose id is another task's commit, case
 * aside (`treeCopyPath` and a commit's snapshot share one directory).
 * `only` (the ids the arm runs; none: every task) limits a P line's
 * checks on disk to those tasks, as eval-patch's own reading does: a task
 * whose tree is not fetched yet must not stop another.
 */
export function readTasks(dir, suite, { only } = {}) {
  const path = join(dir, 'suites', suite, 'tasks.jsonl');
  if (!existsSync(path)) throw new Error(`no suite at ${path}`);
  const tasks = readJsonl(path);
  if (!tasks.length) throw new Error(`${path} holds no task`);
  const seen = new Set();
  tasks.forEach((t, i) => {
    const id = t && typeof t.id === 'string' && t.id ? t.id : `#${i + 1}`;
    const controls = t && typeof t === 'object' ? NAMING_FIELDS.filter((f) => typeof t[f] === 'string' && CONTROL_CHAR.test(t[f])) : [];
    // Nothing else is read of such a line: a later message would echo the character.
    const problems = controls.length
      ? controls.map((f) => `${f} holds a control character (U+0000–U+001F, U+007F–U+009F)`)
      : taskProblems(suite, t, tasks, dir, { onDisk: !only || !only.length || only.includes(id) });
    const shared = !controls.length && t && typeof t.id === 'string'
      ? tasks.find((o) => o !== t && o && typeof o.commit === 'string' && o.commit.toLowerCase() === t.id.toLowerCase()) : undefined;
    if (shared) problems.push(`its id is ${shownId(shared.id)}'s commit, case aside: a tree's copy and a commit's snapshot share one directory, named by the id and by the commit`);
    if (seen.has(id)) problems.push('a second task with this id: ids are unique per suite');
    if (problems.length) throw new Error(`${path}: task ${shownId(id)}: ${problems.join('; ')}`);
    seen.add(id);
  });
  return tasks;
}

/** The order an arm runs V tasks in: the keyed and recall tasks as the file has them, then the controls. */
export function orderTasks(tasks) {
  const control = (t) => t.kind === 'control';
  return [...tasks.filter((t) => !control(t)), ...tasks.filter(control)];
}

/** The first run number this task (or batch of tasks) has not used yet in the arm's file. */
export function nextRunFor(file, taskIds) {
  if (!existsSync(file)) return 1;
  const key = taskIds.join(',');
  const runs = readJsonl(file)
    .filter((l) => Array.isArray(l.taskIds) && l.taskIds.join(',') === key)
    .map((l) => Number(l.run)).filter(Number.isInteger);
  return runs.length ? Math.max(...runs) + 1 : 1;
}

/** The tasks `ids` names, in the suite's order; every id must be in the suite. No ids: every task. */
export function selectTasks(tasks, ids) {
  if (!ids || !ids.length) return tasks;
  const known = new Set(tasks.map((t) => t.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw new Error(`no task ${missing.join(', ')} in the suite`);
  const want = new Set(ids);
  return tasks.filter((t) => want.has(t.id));
}

/**
 * A tree task's cwd, a copy of `<dir>/<rel>` under the OS temp dir named by
 * the task `id`: `extract: false` (the dry run) names it and makes nothing;
 * `copy` makes it now; otherwise the tree is checked now and `copyFrom` tells
 * runArm to copy it just before the task's own call.
 */
function treeCwd({ id, dir, rel, under, extract, copy }) {
  const snapshot = treeCopyPath(id);
  if (!extract) return { snapshot };
  if (copy) return { snapshot: materializeTree({ dir, rel, id, under }) };
  checkTreeSource({ dir, rel, under, who: 'prepareTasks' });
  return { snapshot, copyFrom: { rel, under } };
}

/**
 * The suite's tasks made ready for one arm's calls. V: the controls last; a
 * cwd arm gets the directory it reviews (`snapshot`, guarded); Gemini gets the
 * shown file's text (`fileText`), read out of the commit's snapshot or straight
 * from the private dir, nothing copied; every arm gets a shown diff's text
 * (`diffText`). P and I: a fresh copy of the task's tree or document directory
 * (`snapshot`). `extract: false` (the dry run) reads what is there and makes nothing.
 * A tree's copy is made here when `copy` (the default: eval-hand's brief);
 * with `copy: false` (the runner) every tree is checked here and only named,
 * and its task carries `copyFrom` — a commit's snapshot is extracted here either way.
 * Every arm but Gemini's is a cwd arm: eval-hand passes a native arm as one.
 */
export function prepareTasks(suite, tasks, { arm, dir, repo, snapshot, extract = true, copy = true }) {
  if (snapshot && (suite === 'P' || suite === 'I')) throw new Error(SNAPSHOT_IS_FOR_COMMITS);
  switch (suite) {
    case 'V': {
      if (snapshot && tasks.some((t) => t.tree !== undefined)) throw new Error(SNAPSHOT_IS_FOR_COMMITS);
      if (snapshot && new Set(tasks.map((t) => t.commit)).size > 1) throw new Error('--snapshot names one tree, and these tasks are at more than one commit');
      const asCwd = arm.unit !== 'gemini';
      return orderTasks(tasks).map((t) => {
        const diffText = t.show === 'diff' ? readFileSync(resolve(dir, t.diff), 'utf8') : null;
        if (asCwd) {
          const cwd = t.tree !== undefined
            ? treeCwd({ id: t.id, dir, rel: t.tree, under: V_TREES, extract, copy })
            : { snapshot: snapshotFor({ task: t, dir, repo, snapshot, extract }) };
          return { ...t, ...cwd, snapshotPresent: existsSync(cwd.snapshot), fileText: null, diffText };
        }
        if (t.show === 'diff') return { ...t, snapshot: null, snapshotPresent: false, fileText: null, diffText };
        if (t.tree !== undefined) return { ...t, snapshot: null, snapshotPresent: false, fileText: readInside(treeIn({ dir, rel: t.tree, under: V_TREES, who: 'a Gemini arm' }), t.file, t.id), diffText };
        // Outside every work tree by default: under the private dir, git would walk up to the live .git and its later fixes.
        const path = snapshot ? resolve(snapshot) : join(tmpdir(), 'omelette-evals', 'snapshots', t.commit);
        const present = existsSync(path);
        if (extract) ensureSnapshot({ repo, commit: t.commit, path, guard: false });
        return { ...t, snapshot: path, snapshotPresent: present, fileText: extract || present ? readInside(path, t.file, t.id) : null, diffText };
      });
    }
    case 'P':
      // The tree alone: the gold and the tests diff sit under suites/P/, never under the place a tree is copied from.
      return tasks.map((t) => ({ ...t, ...treeCwd({ id: t.id, dir, rel: t.tree, under: P_TREES, extract, copy }) }));
    case 'I':
      // The document's directory alone: the task line, with what was planted and what a correct answer holds, sits a level up.
      return tasks.map((t) => ({ ...t, ...treeCwd({ id: t.id, dir, rel: t.doc, under: I_DOCS, extract, copy }) }));
    default:
      return tasks;
  }
}

/** agy's local conversation store: one SQLite file per conversation, named by its id (seen 2026-11-19). */
const agyConversationsDir = (env) => join(env.HOME, '.gemini', 'antigravity-cli', 'conversations');

/** `{name: mtimeMs}` of the store's files, a `-wal`, `-shm` or `-journal` file read as its database; `{}` when there is no store. */
function conversationState(dir) {
  const out = {};
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    let st;
    try { st = statSync(join(dir, n)); } catch { continue; }
    if (!st.isFile()) continue;
    const db = n.replace(/-(?:wal|shm|journal)$/, '');
    out[db] = Math.max(out[db] ?? 0, st.mtimeMs);
  }
  return out;
}

/** The conversations a call created or wrote to: new in `after`, or written later than in `before`. Sorted. */
export function touchedConversations(before, after) {
  return Object.keys(after).filter((n) => !(n in before) || after[n] > before[n]).sort();
}

/** The unit's own words for a run that ended with nothing (units/gemini/adapter.mjs interpretAgy). */
const NO_OUTPUT = /produced no output|ended with no answer/i;
/** A call that ended with no answer text: a blank answer, or a failure the unit reports as no output. */
export const isEmptyCall = ({ ok, answer, error }) => (ok ? !String(answer ?? '').trim() : NO_OUTPUT.test(String(error ?? '')));

/** A failure that says the arm's quota is spent: every later call of the arm would fail the same way. */
const EXHAUSTED = /quota exhausted|RESOURCE_EXHAUSTED/i;

/** The write gates an eval never opens: a unit under test runs read-only, whatever the caller's shell exports. */
export const WRITE_GATES = ['OMELETTE_ALLOW_WRITE', 'ORION_ALLOW_GEMINI_MUTATE', 'OMELETTE_ALLOW_REPRO'];

/**
 * What widens the environment a unit hands its vendor CLI beyond the stock
 * allowlist (core/spawn.mjs): an eval call runs under that allowlist, so no
 * `GIT_*` or token pattern the shell admits reaches a model's CLI.
 */
export const ENV_WIDENERS = [ENV_PASSTHROUGH_VAR];

/** `env` without the write gates and the allowlist's wideners: a copy, the caller's object untouched. */
export function evalEnv(env) {
  const out = { ...env };
  for (const k of [...WRITE_GATES, ...ENV_WIDENERS]) delete out[k];
  return out;
}

/**
 * One run line, appended to `file`, which is the operator's alone (0600) before
 * the line lands: `mode` counts only when a call creates the file, and a run
 * file made by hand or by an older runner keeps its own.
 */
export function appendRunLine(file, line) {
  const fd = openSync(file, 'a', 0o600);
  try {
    fchmodSync(fd, 0o600);
    appendFileSync(fd, JSON.stringify(line) + '\n');
  } finally {
    closeSync(fd);
  }
}

/**
 * `text` to `path`, the operator's alone: the parent directories it makes are
 * 0700, and the file is 0600 before a byte lands, whatever mode a file already
 * there had. Every eval script writes a private file through it.
 */
export function writePrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'w', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** What the operator runs to give a P task the proof it lacks. */
const proveFirst = (id) => `run node scripts/eval-patch.mjs prove --task ${id} first`;

/**
 * Throws, naming the first, when a P task's gold proof is not `ok`: no model's
 * diff exists before its task is proven, and no brief asking for one is made.
 */
export function assertProven({ dir, tasks }) {
  for (const t of tasks) {
    const status = proofStatus({ dir, task: t });
    if (status !== 'ok') throw new Error(`${t.id} has no fresh gold proof (${status}): ${proveFirst(t.id)}`);
  }
}

/**
 * Run one arm of one suite `runs` times; every call appends its line as soon
 * as it ends. `only` names the task ids to run (all when empty); each task
 * numbers its own runs. Returns `{file, lines, stopped}` — `stopped` is set when
 * a call failed on an exhausted quota and the arm made no call after it; that
 * call's line says `exhausted: true`, every other line `exhausted: false`.
 * P: throws before anything is copied or called when a selected task's gold
 * proof is not `ok` — no model's diff exists before its task is proven.
 * An arm whose unit has no tool for the suite is refused first, before any
 * copy, snapshot or server: a refused arm leaves nothing behind.
 * A tree's copy (a V tree for a cwd arm, a P tree, an I document's directory)
 * is made just before its own call and removed when that call ends, answered,
 * failed or thrown: no call has another task's copy beside its cwd. Every tree
 * is checked before the arm's first call; a commit's snapshot stays.
 * `serverPath` replaces the unit's server (tests); `now` dates the run directory.
 */
export async function runArm({
  suite, arm, runs = 1, batch = false, dir = DEFAULT_DIR, repo = ROOT, snapshot, only, env = process.env,
  now = () => new Date(), serverPath, out = (l) => console.log(l),
}) {
  toolFor(suite, arm.unit);
  env = evalEnv(env);
  const unit = UNITS[arm.unit];
  const selected = selectTasks(readTasks(dir, suite, { only }), only);
  if (suite === 'P') assertProven({ dir, tasks: selected });
  const tasks = prepareTasks(suite, selected, { arm, dir, repo, snapshot, copy: false });
  const copyOf = new Map(tasks.filter((t) => t.copyFrom).map((t) => [t.id, t]));
  const calls = planCalls({ suite, arm, tasks, batch });
  const file = join(dir, 'runs', localDate(now()), `${suite}-${armSlug(arm.arm)}.jsonl`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const firstOf = calls.map((c) => nextRunFor(file, c.taskIds));
  const cli = await cliVersion(unit, env);
  const cfg = unitConfig({ unit: unit.name, envMap: unit.envMap, builtin: unit.builtin, extraSchema: unit.extraSchema, supportedModes: unit.supportedModes, env });
  // The unit's own hard kill governs, and its bounded retry may run the CLI twice.
  const timeoutS = cfg.values.timeoutS * 2 + 60;
  const server = serverPath || join(ROOT, 'servers', `${arm.unit}.mjs`);
  const home = fleetHome(env);
  // The runner cannot read a run's tool calls (the unit returns the answer only): it names the conversation the session opens.
  const convDir = arm.unit === 'gemini' && env.HOME ? agyConversationsDir(env) : null;
  out(`${suite} ${arm.arm} · ${cli} · ${calls.length} call(s) × ${runs} run(s) → ${file}`);
  const lines = [];
  let unmatched = 0;
  let stopped = null;
  passes: for (let pass = 0; pass < runs; pass++) {
    for (const [i, call] of calls.entries()) {
      const run = firstOf[i] + pass;
      // The task's copy exists for this call alone.
      const own = call.taskIds.length === 1 ? copyOf.get(call.taskIds[0]) : undefined;
      const copy = own ? materializeTree({ dir, rel: own.copyFrom.rel, id: own.id, under: own.copyFrom.under }) : null;
      const before = convDir ? conversationState(convDir) : null;
      const t0 = Date.now();
      let res = null;
      let failure = null;
      let left = null;
      try {
        res = await callUnitServer({ serverPath: server, tool: call.tool, args: call.args, timeoutS, env });
      } catch (e) { failure = (e && e.message) || String(e); } finally {
        if (copy) left = removeStage(copy);
      }
      const rec = res ? findCallRecord({ home, unit: arm.unit, pid: res.pid, tool: call.tool, sinceMs: t0 }) : null;
      if (res && !rec) unmatched += 1;
      const ok = !!res && !res.isError;
      const answer = ok ? res.text : null;
      const error = ok ? null : (res ? res.text : failure);
      const exhausted = !ok && EXHAUSTED.test(String(error ?? ''));
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
        answer,
        error,
        empty: isEmptyCall({ ok, answer, error }),
        exhausted,
        usage: rec ? rec.usage : null,
        resultId: rec ? rec.resultId : null,
        agyConversations: convDir ? touchedConversations(before, conversationState(convDir)) : null,
      };
      appendRunLine(file, line);
      lines.push(line);
      out(`  run ${run}  ${call.taskIds.join(',')}  ${ok ? 'ok' : 'FAILED'}  ${(line.wallMs / 1000).toFixed(1)}s`);
      // The call's line is filed first; a copy left behind would sit beside the next call's cwd.
      if (left) throw new Error(`${left}: the arm stops before its next call`);
      if (exhausted) {
        stopped = { after: call.taskIds, left: calls.length * runs - lines.length };
        out(`  stopped: the quota is exhausted after ${call.taskIds.join(',')} — ${stopped.left} call(s) not made`);
        break passes;
      }
    }
  }
  if (unmatched) out(`  note: ${unmatched} call(s) had no spool record (is \`results\` off for ${arm.unit}?) — their model, effort and usage are null`);
  return { file, lines, stopped };
}

/**
 * The dry run: the calls each arm would make, by task id and prompt length, and
 * each P task's proof, a task without a fresh one marked as refused. Writes and
 * spawns nothing.
 */
function printPlan({ suite, arm, runs, batch, dir, repo, snapshot, only, now, out }) {
  const tasks = prepareTasks(suite, selectTasks(readTasks(dir, suite, { only }), only), { arm, dir, repo, snapshot, extract: false });
  // A Gemini file brief whose commit snapshot is not extracted yet: its length is the brief's alone.
  const pending = new Set(tasks.filter((t) => suite === 'V' && arm.unit === 'gemini' && t.show !== 'diff' && t.fileText === null).map((t) => t.id));
  const calls = planCalls({ suite, arm, tasks: tasks.map((t) => (pending.has(t.id) ? { ...t, fileText: '' } : t)), batch });
  const file = join(dir, 'runs', localDate(now()), `${suite}-${armSlug(arm.arm)}.jsonl`);
  const firstOf = calls.map((c) => nextRunFor(file, c.taskIds));
  out(`${suite} ${arm.arm} → ${file} (the CLI version is read when it runs)`);
  for (const t of suite === 'V' ? tasks : []) {
    if (!t.snapshot) continue;
    if (t.tree !== undefined) { out(`  snapshot ${t.snapshot} (a fresh copy of ${t.tree} when it runs)`); continue; }
    const reached = !t.snapshotPresent && arm.unit !== 'gemini' ? reachableGitDir(nearestExisting(t.snapshot)) : null;
    out(`  snapshot ${t.snapshot} ${t.snapshotPresent ? '(present)' : `(absent: would be extracted from ${t.commit})`}` +
      (reached ? ` — would be REFUSED: git reaches ${reached} from there; pass --snapshot outside every git work tree` : ''));
  }
  for (const t of suite === 'P' ? tasks : []) {
    const status = proofStatus({ dir, task: t });
    out(`  snapshot ${t.snapshot} (a fresh copy of ${t.tree} when it runs)`);
    out(`  ${t.id} gold proof ${status}${status === 'ok' ? '' : ` — would be REFUSED: ${proveFirst(t.id)}`}`);
  }
  for (let pass = 0; pass < runs; pass++) {
    for (const [i, c] of calls.entries()) {
      const { prompt, ...rest } = c.args;
      const opts = Object.entries(rest).map(([k, v]) => `${k}=${v}`).join('  ');
      out(`  run ${firstOf[i] + pass}  ${c.taskIds.join(',')}  ${c.tool}  ${opts}  prompt ${prompt.length} chars${pending.has(c.taskIds[0]) ? ' + the file\'s text' : ''}`);
    }
  }
}

export async function main(argv = process.argv.slice(2), { out = (l) => console.log(l), err = (l) => console.error(l) } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        suite: { type: 'string' }, arm: { type: 'string', multiple: true }, task: { type: 'string', multiple: true }, runs: { type: 'string' },
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
  const opts = { suite, runs, batch: !!values.batch, dir, repo: ROOT, snapshot: values.snapshot, only: values.task, now: () => new Date(), out };
  try {
    // Every arm's tool before any arm's first call: a later arm refused at its turn would come after earlier arms spent theirs.
    for (const arm of arms) toolFor(suite, arm.unit);
    for (const arm of arms) {
      if (values['dry-run']) printPlan({ ...opts, arm });
      else {
        const { lines, stopped } = await runArm({ ...opts, arm });
        const failed = lines.filter((l) => !l.ok).length;
        out(`  ${lines.length} call(s), ${failed} failed${stopped ? `, ${stopped.left} not made (quota)` : ''}`);
      }
    }
  } catch (e) { err(`eval-run: ${(e && e.message) || e}`); return 1; }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await main();
}
