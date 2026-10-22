#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/mutants.mjs
 * The mutant runner: the clean-up gate's objective judge (spec
 * docs/superpowers/specs/2026-10-21-cleanup-gate-design.md, "T0 — the mutant
 * catalogue"). Dev-only: `scripts/` is not in the npm package.
 *
 *   node scripts/mutants.mjs [--only <id,id,…>] [--files <glob,…>] [--timeout <s>]
 *        [--scratch <dir>] [--out <file>] [--list] [--dry-run]
 *   node scripts/mutants.mjs --stragglers [--kill]
 *
 * THE CATALOGUE is `scripts/mutants.json`: one-line mutants, each an `id`, a
 * `file` (repo-relative), a `find` fragment that occurs EXACTLY ONCE in that
 * file, its `replace`, and the behaviour it `breaks`. `--dry-run` validates
 * every entry against this checkout (the file exists, the fragment occurs once)
 * and runs nothing — that is the catalogue's own validity check. `--list`
 * prints it.
 *
 * NEVER THE TREE UNDER TEST. The repository's top-level entries the suite needs
 * are copied into a scratch directory (`mkdtemp` under the OS temp directory,
 * removed at the end; `--scratch <dir>` keeps one instead): `pristine/` is the
 * snapshot, `work/` is where a mutant is applied and the suite runs. `.git`,
 * `.omelette` and `node_modules` are never copied; the history the suite reads
 * comes from a local clone of its own (`cloneHistory`). Before every mutant each
 * catalogued file in `work/` is restored from `pristine/`, so a run that died
 * between apply and restore cannot leave a mutant behind for the next one.
 *
 * ONE RUN. The selected test files (`--files`, globs relative to test/; default
 * `test/*.test.mjs`) run unmutated first — that baseline must be green or the
 * runner stops. The judge's own tests are never part of the measurement:
 * `test/mutants*.test.mjs` is left out of every file set, default or `--files`
 * (one of them checks the real catalogue against the tree, so in a mutated
 * copy it would catch every mutant). Then, per mutant: apply, `node --test <files>` with a time cap
 * (`--timeout <s>`, default twice the baseline's wall time, at least 120 s),
 * record which test FILES failed, restore. A run that hits the cap is killed:
 * every file still running counts as caught (`caughtByTimeout`, flagged
 * `timedOut`). The cap is also node's own `--test-timeout`, so a suite whose
 * runner died still cancels a hung file by itself; a file node cancelled that
 * way counts exactly as one still running at the cap. Which file failed comes
 * from node's own test events, through this module's default export used as
 * the `--test-reporter` — loaded from a
 * copy in the scratch directory, so an edit of this file mid-run reaches no
 * later mutant.
 *
 * THE CHILDREN'S ENVIRONMENT (git and the suite) is the runner's own minus every
 * `GIT_*` variable (a hook's or a rebase's GIT_DIR would point `git -C work` at
 * the operator's repository) and minus the write gates and the passthrough
 * (OMELETTE_ALLOW_WRITE, ORION_ALLOW_GEMINI_MUTATE, OMELETTE_ENV_PASSTHROUGH);
 * HOME and OMELETTE_HOME are `<scratch>/home`, emptied before every suite run.
 * SIGINT, SIGTERM and SIGHUP kill the running suite as the cap does (below), sweep
 * the scratch's stragglers, remove a scratch the runner made itself (of a named
 * one, its `owner.pid`), and re-raise the signal.
 *
 * NO PROCESS LEFT BEHIND. A suite runs in a process group of its own, which a
 * test's own `detached` spawn leaves, and a runner killed without its handlers
 * (a SIGKILL) takes its cap with it: `node --test` (ppid 1) and a hung fixture
 * spinning, the picture of 2026-10-22, which node's `--test-timeout` now ends
 * unless the file ignores SIGTERM (node never escalates). So the cap and
 * the signal handlers stop the suite's group (SIGSTOP: nothing in it starts a
 * child after that), walk the process tree from the suite child (`ps`, every
 * descendant) and SIGKILL each pid, then the group, then check with `kill -0`
 * (a zombie counts as gone) and kill the survivors once more after 100 ms.
 * Every child the runner starts carries OMELETTE_MUTANTS_SCRATCH (the
 * scratch's real path), which every descendant inherits whatever its command
 * line. After the baseline, after every mutant and in the run's `finally`, any
 * process that carries this scratch, or whose command line holds it
 * (`pristine/`, `work/`, `reporter.mjs`), is killed, and the progress line says
 * `stragglers: N killed`. `--stragglers` lists every process whose command line
 * holds `omelette-mutants` or that carries the variable — pid, age, command —
 * and exits 1 when one is a leftover; `--kill` SIGKILLs the leftovers — ANY
 * process whose command line holds the mark, a launcher shell of yours
 * included, and a run started by a runner older than `owner.pid`. A
 * process of a LIVE run (its scratch's `owner.pid` names a live process, or it
 * is that owner) is listed under its own heading, never killed, and never
 * counted.
 *
 * OUTPUT: `.omelette/mutants/<YYYY-MM-DD>T<HHMM>.json` (gitignored; `--out`
 * overrides), rewritten after every mutant so a long run that dies keeps what
 * it measured: `{ date, baseline: { files, tests, wallMs }, timeoutMs,
 * mutants: [{ id, file, caughtBy, caughtByTimeout, timedOut, wallMs }],
 * uniqueCatches: { <test file>: [ids only it catches] }, uncaught: [ids] }`.
 * Progress goes to stderr, one line per mutant; a summary to stdout at the end.
 * An uncaught mutant is a hole in the suite: reported, not fixed.
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));
export const DEFAULT_CATALOGUE = join(ROOT, 'scripts', 'mutants.json');

/** The top-level entries `npm test` needs, found by running the suite in a copy; a missing one is skipped. */
export const COPY_ENTRIES = [
  'bin', 'core', 'units', 'servers', 'hooks', 'rules', 'agents', 'skills', 'test', 'scripts', 'examples', 'docs',
  'mods', 'evals', '.claude-plugin', '.github', 'package.json', 'README.md', 'CHANGELOG.md', 'SECURITY.md',
  'CONTRIBUTING.md', 'LICENSE', '.gitignore', '.editorconfig',
];
const NEVER_COPIED = new Set(['.git', '.omelette', 'node_modules']);
/** What no child inherits: the test runner's own marker, the write gates, the fleet-wide passthrough. */
const DROPPED_ENV = ['NODE_TEST_CONTEXT', 'OMELETTE_ALLOW_WRITE', 'ORION_ALLOW_GEMINI_MUTATE', 'OMELETTE_ENV_PASSTHROUGH'];
/** The suite runs in flight, so a signal can kill their process groups. */
const LIVE_SUITES = new Set();
const SCRATCH_MARK = '.omelette-mutants';
/** In every runner scratch's name and every test sandbox's: what `--stragglers` looks for. */
const STRAGGLER_MARK = 'omelette-mutants';
/** Set on every child the runner starts: the real path of its scratch. */
const SCRATCH_ENV = 'OMELETTE_MUTANTS_SCRATCH';
/** In a scratch while its runner lives: the runner's pid. */
const OWNER_FILE = 'owner.pid';
const TIMEOUT_FLOOR_MS = 120_000;
const BASELINE_CAP_MS = 30 * 60_000;
const EVENT_PREFIX = '@@mutants ';

const USAGE = 'usage: node scripts/mutants.mjs [--only <id,id,…>] [--files <glob,…>] [--timeout <s>] [--scratch <dir>] [--out <file>] [--list] [--dry-run]\n'
  + '       node scripts/mutants.mjs --stragglers [--kill]';

/**
 * The `--test-reporter`: node's test events in, one marked JSON line per event
 * the runner reads out. `test:complete` arrives in completion order, as each
 * test ends — so a killed run still names every file that finished — and the
 * file-level `test:dequeue` / `test:complete` pair (name === file, nesting 0)
 * says which files were still running when the cap hit. A file-level complete
 * that failed as `testTimeoutFailure` is node's own `--test-timeout` cancelling
 * the file (the same cap): `timedOut`.
 */
export default async function* reporter(source) {
  for await (const { type, data = {} } of source) {
    // The file-level test is named by its absolute path on node 20 and by its cwd-relative one on node 22.
    const fileLevel = data.nesting === 0 && !!data.file && resolve(data.name || "") === data.file;
    if (type === 'test:dequeue' && fileLevel && data.file) {
      yield `${EVENT_PREFIX}${JSON.stringify({ e: 'start', file: data.file })}\n`;
    } else if (type === 'test:complete' && data.file) {
      const passed = !!(data.details && data.details.passed);
      const timedOut = fileLevel && !passed && !!(data.details.error && data.details.error.failureType === 'testTimeoutFailure');
      yield `${EVENT_PREFIX}${JSON.stringify({ e: 'complete', file: data.file, top: fileLevel, passed, todo: !!data.todo, timedOut })}\n`;
    } else if (type === 'test:diagnostic' && data.nesting === 0 && !data.file && typeof data.message === 'string') {
      yield `${EVENT_PREFIX}${JSON.stringify({ e: 'diag', message: data.message })}\n`;
    }
  }
}

/** The catalogue file's entries, shape-checked. THROWS on a file that is not a JSON array. */
export function loadCatalogue(path = DEFAULT_CATALOGUE) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path}: the catalogue must be a JSON array`);
  return parsed;
}

/** How often `fragment` occurs in `text` (non-overlapping, as a replace would see it). */
export function occurrences(text, fragment) {
  if (!fragment) return 0;
  let n = 0;
  for (let at = text.indexOf(fragment); at >= 0; at = text.indexOf(fragment, at + fragment.length)) n++;
  return n;
}

/**
 * Every problem with the catalogue against the tree at `root`: a missing field,
 * a duplicate id, a file that is not there, a `find` that occurs 0 or 2+ times,
 * a `replace` that changes nothing. An empty list is a valid catalogue.
 */
export function validateCatalogue(root, catalogue) {
  const problems = [];
  const seen = new Set();
  for (const [i, m] of catalogue.entries()) {
    const label = m && typeof m.id === 'string' && m.id ? m.id : `entry ${i}`;
    const missing = ['id', 'file', 'find', 'replace', 'breaks'].filter((k) => !m || typeof m[k] !== 'string' || (k !== 'replace' && !m[k]));
    if (missing.length) { problems.push(`${label}: missing or empty ${missing.join(', ')}`); continue; }
    if (seen.has(m.id)) problems.push(`${label}: duplicate id`);
    seen.add(m.id);
    if (m.find === m.replace) { problems.push(`${label}: replace equals find`); continue; }
    const path = join(root, m.file);
    if (isAbsolute(m.file) || relative(root, path).startsWith('..') || !existsSync(path)) { problems.push(`${label}: ${m.file} does not exist in the tree`); continue; }
    const n = occurrences(readFileSync(path, 'utf8'), m.find);
    if (n !== 1) problems.push(`${label}: the fragment occurs ${n} times in ${m.file} (it must occur exactly once)`);
  }
  return problems;
}

/** `--only` applied: the catalogue entries named, in catalogue order. THROWS on an unknown id. */
export function selectMutants(catalogue, only) {
  if (!only) return catalogue;
  const wanted = only.split(',').map((s) => s.trim()).filter(Boolean);
  const known = new Set(catalogue.map((m) => m.id));
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`--only names unknown mutant(s): ${unknown.join(', ')}`);
  return catalogue.filter((m) => wanted.includes(m.id));
}

/** The runner's own tests: never in the file set it measures with. */
const OWN_TESTS = /^mutants.*\.test\.mjs$/;

const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);

/**
 * The test files (repo-relative, sorted) that `--files` selects — default
 * `test/*.test.mjs` — and the runner's own tests the selection matched but
 * leaves out. THROWS when nothing is left to run.
 */
export function selectTestFiles(root, files) {
  const names = readdirSync(join(root, 'test'));
  const globs = (files || '*.test.mjs').split(',').map((s) => s.trim()).filter(Boolean);
  const res = globs.map(globToRegExp);
  const matched = names.filter((n) => res.some((re) => re.test(n))).sort();
  const excluded = matched.filter((n) => OWN_TESTS.test(n)).map((n) => `test/${n}`);
  const picked = matched.filter((n) => !OWN_TESTS.test(n)).map((n) => `test/${n}`);
  if (!picked.length) throw new Error(`--files ${globs.join(',')} matches no file under test/${excluded.length ? ' but the runner\'s own tests, which are never run' : ''}`);
  return { files: picked, excluded };
}

/**
 * The real path of `p`, for one that does not exist yet as well: the deepest
 * existing ancestor is resolved (every symlink on the way followed) and the
 * missing tail re-attached to it.
 */
function realPathOf(p) {
  const tail = [];
  for (let cur = resolve(p); ; cur = dirname(cur)) {
    try { return join(realpathSync(cur), ...tail); } catch (e) {
      if (!e || e.code !== 'ENOENT' || dirname(cur) === cur) throw e;
      tail.unshift(basename(cur));
    }
  }
}

/**
 * A scratch directory ready for this run: `pristine/` and `work/` copied fresh
 * from `root`. One we did not create is used only when it is empty or carries
 * our mark, and never inside the tree under test — compared by real paths, so
 * a symlink into the tree (the scratch itself or an ancestor) is refused too,
 * before anything is created. Beside the two copies: `home/`, the children's
 * HOME, `reporter.mjs`, this file as it is now, and `owner.pid`, the runner's
 * pid (removed when the run ends).
 */
export function prepareScratch({ root, scratch, entries = COPY_ENTRIES }) {
  const rel = relative(realpathSync(root), realPathOf(scratch));
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    throw new Error(`--scratch ${scratch} is inside the tree under test — pick a directory outside it`);
  }
  mkdirSync(scratch, { recursive: true });
  const present = readdirSync(scratch);
  if (present.length && !present.includes(SCRATCH_MARK)) {
    throw new Error(`--scratch ${scratch} is not empty and was not made by this runner — refusing to write there`);
  }
  writeFileSync(join(scratch, SCRATCH_MARK), 'omelette-fleet mutant runner scratch: everything here is rewritten on every run\n');
  writeFileSync(join(scratch, OWNER_FILE), `${process.pid}\n`); // while this pid lives, `--stragglers` reads the scratch as a live run
  const home = join(scratch, 'home');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home);
  const reporter = join(scratch, 'reporter.mjs');
  copyFileSync(SELF, reporter); // its imports are node built-ins only, so the copy stands alone
  const pristine = join(scratch, 'pristine');
  const work = join(scratch, 'work');
  for (const dir of [pristine, work]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const e of entries) {
      if (!existsSync(join(root, e))) continue;
      cpSync(join(root, e), join(dir, e), { recursive: true, verbatimSymlinks: true, filter: (src) => !NEVER_COPIED.has(basename(src)) });
    }
  }
  if (existsSync(join(root, '.git'))) cloneHistory(root, work, home);
  return { pristine, work, home, reporter };
}

const git = (args, home) => execFileSync('git', args, { env: childEnv(home), stdio: ['ignore', 'ignore', 'pipe'] });

/**
 * The suite reads this repository's history (`git show <commit>:<path>`,
 * `git ls-files`, detectInstall's `.git`), so `work/` gets a repository of its
 * own — never this checkout's `.git` (its hooks, config, index and stashes stay
 * where they are): a local clone's `.git`, objects hard-linked, not a worktree
 * of this checkout, its `origin` removed so nothing in it reaches back here,
 * its index set to HEAD. The working files stay the copied ones, uncommitted
 * changes included.
 */
function cloneHistory(root, work, home) {
  const tmp = mkdtempSync(join(dirname(work), 'clone-'));
  try {
    git(['clone', '--quiet', '--local', '--no-checkout', root, tmp], home);
    renameSync(join(tmp, '.git'), join(work, '.git'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  git(['-C', work, 'remote', 'remove', 'origin'], home);
  git(['-C', work, 'read-tree', 'HEAD'], home);
}

/** Put every catalogued file in `work` back to its pristine bytes. */
export function restoreFiles({ pristine, work }, files) {
  for (const f of files) copyFileSync(join(pristine, f), join(work, f));
}

/** Apply one mutant in `work`. THROWS when its fragment does not occur exactly once there. */
export function applyMutant(work, m) {
  const path = join(work, m.file);
  const text = readFileSync(path, 'utf8');
  const n = occurrences(text, m.find);
  if (n !== 1) throw new Error(`${m.id}: the fragment occurs ${n} times in ${m.file} (it must occur exactly once)`);
  writeFileSync(path, text.replace(m.find, () => m.replace));
}

/**
 * The environment of every child the runner starts, git and the suite: no
 * `GIT_*` variable (a GIT_DIR or GIT_INDEX_FILE set by a hook, a bisect or a
 * rebase --exec would point `git -C work` at the operator's repository), none
 * of DROPPED_ENV (NODE_TEST_CONTEXT, set inside a test process, would make the
 * suite's `node --test` act as a child of that one), HOME and OMELETTE_HOME on
 * `home`, and OMELETTE_MUTANTS_SCRATCH on the real path of the scratch (home's
 * parent) — inherited by every descendant whatever its command line, so the
 * sweep and `--stragglers` know a run's processes by it. PATH and everything
 * else pass.
 */
export function childEnv(home, env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('GIT_') && !DROPPED_ENV.includes(k)) out[k] = v;
  out.HOME = home;
  out.OMELETTE_HOME = home;
  out[SCRATCH_ENV] = realPathOf(dirname(home));
  return out;
}

const PS_OPTS = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] };

/**
 * Every process as `ps` sees it — pid, parent, state, age, whole command line —
 * on macOS and Linux alike (`-A`, never `-e`: on macOS that adds the
 * environment). With `env`, each row also carries `scratch`, its
 * OMELETTE_MUTANTS_SCRATCH ('' when it has none or it cannot be read). Empty
 * where `ps` cannot run: the kills below then come down to the process group
 * alone.
 */
function processTable({ env = false } = {}) {
  let text;
  try { text = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,stat=,etime=,command='], PS_OPTS); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], etime: m[4], command: m[5] });
  }
  if (env) {
    const scratchOf = scratchVariables(rows);
    for (const r of rows) r.scratch = scratchOf.get(r.pid) || '';
  }
  return rows;
}

/**
 * Each process's OMELETTE_MUTANTS_SCRATCH, by pid: on Linux from
 * `/proc/<pid>/environ` (NUL-separated, exact); elsewhere from `ps -Eww`, which
 * on macOS appends the environment to the command line, space-separated — the
 * value runs to the next ` NAME=`. Only this user's processes show theirs.
 * Neither readable: an empty map, and matching comes down to command lines.
 */
function scratchVariables(rows) {
  const out = new Map();
  const prefix = `${SCRATCH_ENV}=`;
  if (existsSync('/proc/self/environ')) {
    for (const { pid } of rows) {
      try {
        const hit = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((v) => v.startsWith(prefix));
        if (hit) out.set(pid, hit.slice(prefix.length));
      } catch { /* gone, or not ours to read */ }
    }
    return out;
  }
  let text;
  try { text = execFileSync('ps', ['-A', '-Eww', '-o', 'pid=,command='], PS_OPTS); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    const at = m ? m[2].lastIndexOf(` ${prefix}`) : -1;
    if (at < 0) continue;
    const rest = m[2].slice(at + prefix.length + 1);
    const end = rest.search(/ [A-Za-z_][A-Za-z0-9_]*=/);
    out.set(Number(m[1]), end < 0 ? rest : rest.slice(0, end));
  }
  return out;
}

/** Every descendant of `pid` in `table`, parents before their children. */
function descendantsOf(pid, table) {
  const children = new Map();
  for (const p of table) children.set(p.ppid, [...(children.get(p.ppid) || []), p.pid]);
  const out = [];
  const seen = new Set([pid]);
  for (const queue = [pid]; queue.length;) {
    for (const c of children.get(queue.shift()) || []) if (!seen.has(c)) { seen.add(c); out.push(c); queue.push(c); }
  }
  return out;
}

const sigkill = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone already, or not ours to kill */ } };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The pids `kill -0` still answers for, less the zombies (dead, waiting for a parent to reap them). */
function stillAlive(pids) {
  const answering = pids.filter((p) => { try { process.kill(p, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; } });
  if (!answering.length) return [];
  const zombies = new Set(processTable().filter((p) => p.stat.startsWith('Z')).map((p) => p.pid));
  return answering.filter((p) => !zombies.has(p));
}

/** SIGKILL every pid (and the process group `group`, when given); check; once more after 100 ms. Returns the survivors. */
function killAndCheck(pids, group) {
  pids.forEach(sigkill);
  if (group) { try { process.kill(-group, 'SIGKILL'); } catch { /* the group is gone */ } }
  let left = stillAlive(pids);
  if (left.length) { sleepSync(100); left.forEach(sigkill); left = stillAlive(left); }
  return left;
}

/**
 * Kill the suite child at `pid` and everything under it. The group is stopped
 * first (SIGSTOP), so no member can start a child between the table read and
 * the kill — a file just starting up when the cap lands would otherwise leave a
 * `detached` grandchild the read never saw. Then each descendant the table
 * shows — read while `pid` is alive, before a kill hands its children to init —
 * parents first; then the group. The walk is what reaches a grandchild that
 * left the group (a test's own `detached` spawn). Synchronous, so a signal
 * handler can call it. Returns the pids still alive after the second try.
 *
 * Belt and braces, each beside a defence that already covers its case, so no
 * test can tell it is there: the parents-first order (moot once the group is
 * stopped), the group argument (the walk and the `close` handler's group kill
 * cover the members), the `pid <= 1` guard (no caller passes one), the callers'
 * reaped-child check (a pid reused in between — no deterministic test), and the
 * ancestor exclusion in findProcesses (an ancestor holds a needle only in an
 * unusual launch).
 */
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return [];
  try { process.kill(-pid, 'SIGSTOP'); } catch { /* the group is gone */ }
  return killAndCheck([pid, ...descendantsOf(pid, processTable())], pid);
}

/**
 * What a process of the run in `dir` carries in its command line: a path under
 * `pristine/` or `work/`, or the reporter copy — for the scratch as named and as
 * its real path (node names test files by their real path), as plain paths and
 * as the file URL `--test-reporter` is given. Never the bare scratch: the
 * runner's own `--scratch <dir>` would match.
 */
function scratchNeedles(dir) {
  const needles = new Set();
  for (const base of new Set([resolve(dir), realPathOf(dir)])) {
    for (const p of [join(base, 'pristine') + sep, join(base, 'work') + sep, join(base, 'reporter.mjs')]) {
      needles.add(p);
      needles.add(pathToFileURL(p).pathname); // keeps the trailing separator
    }
  }
  return [...needles];
}

/** Every live process `matches` accepts (rows with `scratch`) — never this process, nor one of its ancestors. */
function findProcesses(matches, table = processTable({ env: true })) {
  const parentOf = new Map(table.map((p) => [p.pid, p.ppid]));
  const mine = new Set([process.pid]);
  for (let p = process.ppid; p > 1 && !mine.has(p); p = parentOf.get(p) ?? 0) mine.add(p);
  return table.filter((p) => !mine.has(p.pid) && !p.stat.startsWith('Z') && matches(p));
}

/**
 * Kill this run's stragglers: every process whose command line holds one of
 * the scratch's needles or whose OMELETTE_MUTANTS_SCRATCH is this scratch.
 * Only this run's own scratch matches, so no other run is touched.
 * Returns `{ killed, alive }` counts.
 */
function sweepStragglers({ needles, scratch }) {
  const found = findProcesses((p) => p.scratch === scratch || needles.some((n) => p.command.includes(n)));
  const alive = found.length ? killAndCheck(found.map((p) => p.pid)).length : 0;
  return { killed: found.length - alive, alive };
}

/**
 * The scratch directories a command line names: the path before each
 * `/work/`, `/pristine/` or `/reporter.mjs` in it (a file URL decoded) — every
 * candidate, since a path may hold a `work/` of its own above the scratch.
 */
function scratchesIn(command) {
  const out = [];
  for (const m of command.matchAll(/\/(?:work\/|pristine\/|reporter\.mjs)/g)) {
    const before = command.slice(0, m.index);
    let p = before.slice(Math.max(before.lastIndexOf(' '), before.lastIndexOf('=')) + 1);
    if (p.startsWith('file://')) { try { p = decodeURIComponent(p.slice('file://'.length)); } catch { continue; } }
    if (p.startsWith('/')) out.push(p);
  }
  return out;
}

/**
 * `--stragglers`: every process whose command line holds `mark` or that
 * carries OMELETTE_MUTANTS_SCRATCH (a test's own mark narrows that to a value
 * holding it), split into `leftovers` and `live`. A process belongs to a live
 * run when its scratch — the variable's value, or one its command line names —
 * has an `owner.pid` naming a live process, or when it is such an owner itself:
 * never listed as a leftover, never killed. No owner file, or a dead owner: a
 * leftover. (A reused owner pid errs towards live, the side that kills nothing.)
 */
function classifyStragglers(mark) {
  const table = processTable({ env: true });
  const alive = new Set(table.filter((p) => !p.stat.startsWith('Z')).map((p) => p.pid));
  const owners = new Map();
  const liveOwner = (scratch) => {
    if (!owners.has(scratch)) {
      let pid = 0;
      try { pid = Number.parseInt(readFileSync(join(scratch, OWNER_FILE), 'utf8'), 10); } catch { /* no owner file */ }
      owners.set(scratch, alive.has(pid) ? pid : 0);
    }
    return owners.get(scratch);
  };
  const found = findProcesses((p) => p.command.includes(mark) || (!!p.scratch && (mark === STRAGGLER_MARK || p.scratch.includes(mark))), table);
  const liveOwners = new Set();
  const inLiveRun = new Set();
  for (const p of found) {
    const owner = [p.scratch, ...scratchesIn(p.command)].filter(Boolean).map(liveOwner).find(Boolean);
    if (owner) { inLiveRun.add(p.pid); liveOwners.add(owner); }
  }
  const live = found.filter((p) => inLiveRun.has(p.pid) || liveOwners.has(p.pid));
  return { leftovers: found.filter((p) => !live.includes(p)), live };
}

/** Remove the scratch's `owner.pid` when it names this process — never a file someone else wrote. */
function releaseOwner(dir) {
  try {
    if (readFileSync(join(dir, OWNER_FILE), 'utf8').trim() === String(process.pid)) rmSync(join(dir, OWNER_FILE), { force: true });
  } catch { /* none, or not ours */ }
}

const stragglerNote = ({ killed, alive }) => (killed || alive ? `stragglers: ${killed} killed${alive ? `, ${alive} still alive` : ''}` : '');

/**
 * `node --test <files>` in `cwd`, with `reporter` as its `--test-reporter` and
 * `timeoutMs` as its `--test-timeout`, killed (killTree: every descendant and
 * the process group) at `timeoutMs`. `home` is emptied first: nothing a test
 * left there reaches the next run. Resolves to the files that failed, the files
 * still running at the cap (or cancelled by node at it), the test count node
 * reported, the exit code and the wall time.
 */
export function runSuite({ cwd, files, timeoutMs, home, reporter = SELF, env = process.env }) {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  // node names each file by its real path (macOS: /var is /private/var), so the base must be real too.
  const base = realpathSync(cwd);
  return new Promise((resolveRun, rejectRun) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--test', `--test-reporter=${pathToFileURL(reporter).href}`, `--test-timeout=${timeoutMs}`, ...files], {
      cwd, env: childEnv(home, env), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    LIVE_SUITES.add(child);
    const started = new Set();
    const finished = new Set();
    const failed = new Set();
    const cancelled = new Set(); // the files node's own --test-timeout cancelled
    let tests = null;
    let stderr = '';
    let buf = '';
    const take = (line) => {
      if (!line.startsWith(EVENT_PREFIX)) return;
      let ev;
      try { ev = JSON.parse(line.slice(EVENT_PREFIX.length)); } catch { return; }
      const file = ev.file ? relative(base, ev.file).split(sep).join('/') : '';
      if (ev.e === 'start') started.add(file);
      else if (ev.e === 'complete') {
        if (!ev.passed && !ev.todo) failed.add(file);
        if (ev.top) finished.add(file);
        if (ev.top && ev.timedOut) cancelled.add(file);
      } else if (ev.e === 'diag') {
        const m = /^tests (\d+)$/.exec(ev.message);
        if (m) tests = Number(m[1]);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { take(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is gone */ } };
    let capHit = false;
    const timer = setTimeout(() => {
      capHit = true;
      // Walked only while node has not reaped the child: a reaped pid may already be someone else's.
      if (child.exitCode === null && child.signalCode === null) killTree(child.pid); else killGroup();
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); LIVE_SUITES.delete(child); rejectRun(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      LIVE_SUITES.delete(child);
      if (buf) take(buf);
      killGroup(); // a straggler a test left in the group
      const atCap = capHit ? [...started].filter((f) => !finished.has(f)) : [];
      const stillRunning = [...new Set([...cancelled, ...atCap])].sort();
      const timedOut = capHit || cancelled.size > 0;
      resolveRun({ failed: [...failed].sort(), stillRunning, timedOut, tests, code, wallMs: Date.now() - t0, stderr });
    });
  });
}

/** Per test file, the mutants ONLY it catches; files with none are left out. */
export function uniqueCatches(results) {
  const out = {};
  for (const r of results) {
    if (r.caughtBy.length !== 1) continue;
    const [file] = r.caughtBy;
    (out[file] ||= []).push(r.id);
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

function buildReport({ date, baseline, timeoutMs, results }) {
  return {
    date,
    baseline,
    timeoutMs,
    mutants: results,
    uniqueCatches: uniqueCatches(results),
    uncaught: results.filter((r) => !r.caughtBy.length).map((r) => r.id),
  };
}

const writeReport = (path, report) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
};

/**
 * The whole run: copy, baseline, every selected mutant, restore. Returns the
 * report; when `out` is given it is (re)written after the baseline and after
 * every mutant. THROWS on an invalid catalogue or a red baseline.
 */
export async function runMutants({
  root = ROOT, catalogue, files, timeoutS, scratch, out, entries = COPY_ENTRIES,
  progress = () => {}, now = () => new Date(),
}) {
  const problems = validateCatalogue(root, catalogue);
  if (problems.length) throw new Error(`the catalogue is not valid against ${root}:\n  ${problems.join('\n  ')}`);
  const ownScratch = !scratch;
  const dir = scratch || mkdtempSync(join(tmpdir(), `${STRAGGLER_MARK}-`));
  const own = { needles: scratchNeedles(dir), scratch: realPathOf(dir) };
  // A signal ends the run as the signal says, but first: no suite left running, no scratch of ours left in the OS temp.
  const handlers = {};
  const unhook = () => { for (const [sig, h] of Object.entries(handlers)) process.off(sig, h); };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    handlers[sig] = () => {
      unhook();
      for (const c of LIVE_SUITES) {
        if (c.exitCode === null && c.signalCode === null) killTree(c.pid);
        else { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* the group is gone */ } }
      }
      sweepStragglers(own);
      if (ownScratch) rmSync(dir, { recursive: true, force: true }); else releaseOwner(dir);
      process.kill(process.pid, sig); // no listener left: the default action ends the runner
    };
    process.on(sig, handlers[sig]);
  }
  try {
    const paths = prepareScratch({ root, scratch: dir, entries });
    const touched = [...new Set(catalogue.map((m) => m.file))];
    const date = now().toISOString();

    const suite = { cwd: paths.work, files, home: paths.home, reporter: paths.reporter };
    const base = await runSuite({ ...suite, timeoutMs: timeoutS ? timeoutS * 1000 : BASELINE_CAP_MS });
    if (base.timedOut || base.code !== 0 || base.failed.length) {
      const why = base.timedOut ? `timed out (${base.stillRunning.join(', ')} still running)` : `failed: ${base.failed.join(', ') || `exit ${base.code}`}`;
      throw new Error(`the unmutated baseline is not green in ${paths.work} — ${why}${base.stderr ? `\n${base.stderr.trim()}` : ''}`);
    }
    const baseline = { files: files.length, tests: base.tests, wallMs: base.wallMs };
    const timeoutMs = timeoutS ? timeoutS * 1000 : Math.max(2 * base.wallMs, TIMEOUT_FLOOR_MS);
    const baseStrays = stragglerNote(sweepStragglers(own));
    progress(`baseline: ${files.length} file(s), ${base.tests ?? '?'} test(s), ${(base.wallMs / 1000).toFixed(1)}s — green; cap per mutant ${(timeoutMs / 1000).toFixed(0)}s${baseStrays ? `  ${baseStrays}` : ''}`);

    const results = [];
    if (out) writeReport(out, buildReport({ date, baseline, timeoutMs, results }));
    for (const [i, m] of catalogue.entries()) {
      restoreFiles(paths, touched); // from pristine at the START of every mutant, not only after the last
      applyMutant(paths.work, m);
      let run;
      try { run = await runSuite({ ...suite, timeoutMs }); }
      finally { restoreFiles(paths, [m.file]); }
      const strays = stragglerNote(sweepStragglers(own));
      if (run.code !== 0 && !run.timedOut && !run.failed.length) {
        // node --test failed without naming a file: the measurement is broken, not the mutant caught.
        throw new Error(`${m.id}: node --test exited ${run.code} with no failing test file${run.stderr ? `\n${run.stderr.trim()}` : ''}`);
      }
      const caughtBy = [...new Set([...run.failed, ...run.stillRunning])].sort();
      results.push({ id: m.id, file: m.file, caughtBy, caughtByTimeout: run.stillRunning, timedOut: run.timedOut, wallMs: run.wallMs });
      const verdict = run.timedOut
        ? `timed out, caught by ${caughtBy.length} file(s) (${run.stillRunning.length} still running)`
        : caughtBy.length ? `caught by ${caughtBy.length} file(s)` : 'UNCAUGHT';
      progress(`[${String(i + 1).padStart(String(catalogue.length).length)}/${catalogue.length}] ${m.id}  ${verdict}  ${(run.wallMs / 1000).toFixed(1)}s${strays ? `  ${strays}` : ''}`);
      if (out) writeReport(out, buildReport({ date, baseline, timeoutMs, results }));
    }
    return buildReport({ date, baseline, timeoutMs, results });
  } finally {
    const strays = stragglerNote(sweepStragglers(own));
    if (strays) progress(strays);
    unhook();
    if (ownScratch) rmSync(dir, { recursive: true, force: true }); else releaseOwner(dir);
  }
}

/** The one-screen summary printed at the end of a run. */
export function summarise(report) {
  const all = report.mutants;
  const caught = all.filter((r) => r.caughtBy.length);
  const timed = all.filter((r) => r.timedOut);
  const lines = [
    `mutants: ${all.length} run · ${caught.length} caught · ${report.uncaught.length} uncaught${timed.length ? ` · ${timed.length} timed out` : ''}`,
    `uncaught: ${report.uncaught.length ? report.uncaught.join(', ') : 'none'}`,
  ];
  if (timed.length) lines.push(`timed out: ${timed.map((r) => `${r.id} (${r.caughtByTimeout.join(', ') || 'no file running'})`).join('; ')}`);
  const unique = Object.entries(report.uniqueCatches);
  lines.push(`unique catches (${unique.length} file(s)):`);
  for (const [file, ids] of unique) lines.push(`  ${file}  ${ids.length}  ${ids.join(', ')}`);
  return lines.join('\n');
}

const stamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}`;
};

/**
 * The CLI. `deps` lets a test point it at a fixture repository and catalogue
 * instead of this checkout, and `--stragglers` at a mark of its own instead of
 * every `omelette-mutants` process on the machine. Returns the exit code: 0
 * done, 1 a problem (or, for `--stragglers`, a straggler found), 2 usage.
 */
export async function main(argv = process.argv.slice(2), {
  root = ROOT, cataloguePath = DEFAULT_CATALOGUE, entries = COPY_ENTRIES, stragglerMark = STRAGGLER_MARK,
  out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n'),
} = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        only: { type: 'string' }, files: { type: 'string' }, timeout: { type: 'string' },
        scratch: { type: 'string' }, out: { type: 'string' },
        list: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
        stragglers: { type: 'boolean' }, kill: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch (e) { err(`mutants: ${e.message}`); err(USAGE); return 2; }
  if (values.help) { out(USAGE); return 0; }
  if (values.kill && !values.stragglers) { err('mutants: --kill goes with --stragglers'); err(USAGE); return 2; }
  if (values.stragglers) {
    // Nothing found prints nothing; each leftover is `pid  age  command`, a live run's processes follow under their own heading.
    const { leftovers, live } = classifyStragglers(stragglerMark);
    for (const p of leftovers) out(`${p.pid}  ${p.etime}  ${p.command}`);
    if (live.length) {
      out('live runs (never killed):');
      for (const p of live) out(`  ${p.pid}  ${p.etime}  ${p.command}`);
    }
    if (!values.kill) return leftovers.length ? 1 : 0;
    if (!leftovers.length) return 0;
    const alive = killAndCheck(leftovers.map((p) => p.pid));
    err(stragglerNote({ killed: leftovers.length - alive.length, alive: alive.length }));
    return alive.length ? 1 : 0;
  }
  const timeoutS = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeoutS !== undefined && !(Number.isFinite(timeoutS) && timeoutS > 0)) { err('mutants: --timeout must be a positive number of seconds'); return 2; }

  let catalogue;
  try { catalogue = loadCatalogue(cataloguePath); }
  catch (e) { err(`mutants: ${e.message}`); return 1; }
  let selected;
  try { selected = selectMutants(catalogue, values.only); }
  catch (e) { err(`mutants: ${e.message}`); return 2; }

  if (values.list) {
    for (const m of selected) out(`${m.id}  ${m.file}  ${m.breaks}`);
    const perFile = {};
    for (const m of selected) perFile[m.file] = (perFile[m.file] || 0) + 1;
    out(`${selected.length} mutant(s): ${Object.entries(perFile).map(([f, n]) => `${f} ${n}`).join(' · ')}`);
    return 0;
  }
  if (values['dry-run']) {
    const problems = validateCatalogue(root, selected);
    for (const p of problems) err(`mutants: ${p}`);
    if (problems.length) return 1;
    out(`${selected.length} mutant(s) valid: every fragment occurs exactly once`);
    return 0;
  }

  try {
    const { files, excluded } = selectTestFiles(root, values.files);
    if (excluded.length) err(`excluded: the runner's own tests (${excluded.join(', ')})`);
    const outPath = values.out ? resolve(values.out) : join(root, '.omelette', 'mutants', `${stamp(new Date())}.json`);
    const report = await runMutants({
      root, catalogue: selected, files, timeoutS, scratch: values.scratch && resolve(values.scratch), out: outPath, entries,
      progress: err,
    });
    out(summarise(report));
    out(`report: ${outPath}`);
    return 0;
  } catch (e) {
    err(`mutants: ${(e && e.message) || e}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await main();
}
