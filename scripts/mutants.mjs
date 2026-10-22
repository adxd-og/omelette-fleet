#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/mutants.mjs
 * The mutant runner: the clean-up gate's objective judge (spec
 * docs/superpowers/specs/2026-10-21-cleanup-gate-design.md, "T0 — the mutant
 * catalogue"). Dev-only: `scripts/` is not in the npm package.
 *
 *   node scripts/mutants.mjs [--only <id,id,…>] [--files <glob,…>] [--timeout <s>]
 *        [--scratch <dir>] [--out <file>] [--list] [--dry-run]
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
 * `timedOut`). Which file failed comes from node's own test events, through
 * this module's default export used as the `--test-reporter` — loaded from a
 * copy in the scratch directory, so an edit of this file mid-run reaches no
 * later mutant.
 *
 * THE CHILDREN'S ENVIRONMENT (git and the suite) is the runner's own minus every
 * `GIT_*` variable (a hook's or a rebase's GIT_DIR would point `git -C work` at
 * the operator's repository) and minus the write gates and the passthrough
 * (OMELETTE_ALLOW_WRITE, ORION_ALLOW_GEMINI_MUTATE, OMELETTE_ENV_PASSTHROUGH);
 * HOME and OMELETTE_HOME are `<scratch>/home`, emptied before every suite run.
 * SIGINT, SIGTERM and SIGHUP kill the running suite's process group, remove a scratch
 * the runner made itself, and re-raise the signal.
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
const TIMEOUT_FLOOR_MS = 120_000;
const BASELINE_CAP_MS = 30 * 60_000;
const EVENT_PREFIX = '@@mutants ';

const USAGE = 'usage: node scripts/mutants.mjs [--only <id,id,…>] [--files <glob,…>] [--timeout <s>] [--scratch <dir>] [--out <file>] [--list] [--dry-run]';

/**
 * The `--test-reporter`: node's test events in, one marked JSON line per event
 * the runner reads out. `test:complete` arrives in completion order, as each
 * test ends — so a killed run still names every file that finished — and the
 * file-level `test:dequeue` / `test:complete` pair (name === file, nesting 0)
 * says which files were still running when the cap hit.
 */
export default async function* reporter(source) {
  for await (const { type, data = {} } of source) {
    const fileLevel = data.nesting === 0 && data.name === data.file;
    if (type === 'test:dequeue' && fileLevel && data.file) {
      yield `${EVENT_PREFIX}${JSON.stringify({ e: 'start', file: data.file })}\n`;
    } else if (type === 'test:complete' && data.file) {
      const passed = !!(data.details && data.details.passed);
      yield `${EVENT_PREFIX}${JSON.stringify({ e: 'complete', file: data.file, top: fileLevel, passed, todo: !!data.todo })}\n`;
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
 * HOME, and `reporter.mjs`, this file as it is now.
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
 * `home`. PATH and everything else pass.
 */
export function childEnv(home, env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('GIT_') && !DROPPED_ENV.includes(k)) out[k] = v;
  out.HOME = home;
  out.OMELETTE_HOME = home;
  return out;
}

/**
 * `node --test <files>` in `cwd`, with `reporter` as its `--test-reporter`,
 * killed (its whole process group) at `timeoutMs`. `home` is emptied first:
 * nothing a test left there reaches the next run. Resolves to the files that
 * failed, the files still running at a kill, the test count node reported, the
 * exit code and the wall time.
 */
export function runSuite({ cwd, files, timeoutMs, home, reporter = SELF, env = process.env }) {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  // node names each file by its real path (macOS: /var is /private/var), so the base must be real too.
  const base = realpathSync(cwd);
  return new Promise((resolveRun, rejectRun) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--test', `--test-reporter=${pathToFileURL(reporter).href}`, ...files], {
      cwd, env: childEnv(home, env), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    LIVE_SUITES.add(child);
    const started = new Set();
    const finished = new Set();
    const failed = new Set();
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
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); LIVE_SUITES.delete(child); rejectRun(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      LIVE_SUITES.delete(child);
      if (buf) take(buf);
      killGroup(); // a straggler a test left in the group
      const stillRunning = timedOut ? [...started].filter((f) => !finished.has(f)).sort() : [];
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
  const dir = scratch || mkdtempSync(join(tmpdir(), 'omelette-mutants-'));
  // A signal ends the run as the signal says, but first: no suite left running, no scratch of ours left in the OS temp.
  const handlers = {};
  const unhook = () => { for (const [sig, h] of Object.entries(handlers)) process.off(sig, h); };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    handlers[sig] = () => {
      unhook();
      for (const c of LIVE_SUITES) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* the group is gone */ } }
      if (ownScratch) rmSync(dir, { recursive: true, force: true });
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
    progress(`baseline: ${files.length} file(s), ${base.tests ?? '?'} test(s), ${(base.wallMs / 1000).toFixed(1)}s — green; cap per mutant ${(timeoutMs / 1000).toFixed(0)}s`);

    const results = [];
    if (out) writeReport(out, buildReport({ date, baseline, timeoutMs, results }));
    for (const [i, m] of catalogue.entries()) {
      restoreFiles(paths, touched); // from pristine at the START of every mutant, not only after the last
      applyMutant(paths.work, m);
      let run;
      try { run = await runSuite({ ...suite, timeoutMs }); }
      finally { restoreFiles(paths, [m.file]); }
      if (run.code !== 0 && !run.timedOut && !run.failed.length) {
        // node --test failed without naming a file: the measurement is broken, not the mutant caught.
        throw new Error(`${m.id}: node --test exited ${run.code} with no failing test file${run.stderr ? `\n${run.stderr.trim()}` : ''}`);
      }
      const caughtBy = [...new Set([...run.failed, ...run.stillRunning])].sort();
      results.push({ id: m.id, file: m.file, caughtBy, caughtByTimeout: run.stillRunning, timedOut: run.timedOut, wallMs: run.wallMs });
      const verdict = run.timedOut
        ? `timed out, caught by ${caughtBy.length} file(s) (${run.stillRunning.length} still running)`
        : caughtBy.length ? `caught by ${caughtBy.length} file(s)` : 'UNCAUGHT';
      progress(`[${String(i + 1).padStart(String(catalogue.length).length)}/${catalogue.length}] ${m.id}  ${verdict}  ${(run.wallMs / 1000).toFixed(1)}s`);
      if (out) writeReport(out, buildReport({ date, baseline, timeoutMs, results }));
    }
    return buildReport({ date, baseline, timeoutMs, results });
  } finally {
    unhook();
    if (ownScratch) rmSync(dir, { recursive: true, force: true });
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
 * instead of this checkout. Returns the exit code: 0 done, 1 a problem, 2 usage.
 */
export async function main(argv = process.argv.slice(2), {
  root = ROOT, cataloguePath = DEFAULT_CATALOGUE, entries = COPY_ENTRIES,
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
      },
      strict: true,
    }));
  } catch (e) { err(`mutants: ${e.message}`); err(USAGE); return 2; }
  if (values.help) { out(USAGE); return 0; }
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
