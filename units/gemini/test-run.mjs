/**
 * omelette-fleet :: units/gemini/test-run.mjs
 * The ground `gemini_test` stands on: the disposable copy Neon writes its tests
 * in, with the session's patch committed, and the scratch home agy runs under.
 *
 * THE RUN — core/clone.mjs's prepareClone under
 * `<OS temp>/omelette-gemini-test/run-*` (0700, the operator's), four dirs:
 * `clone/` (a HEAD-only clone of the work tree, the patch applied and committed
 * on top), `tmp/`, `home/` (agy's scratch HOME) and `out/` (the fresh `.git`
 * copy the diff is taken against; nothing sandboxed reads or writes it). Never
 * under the fleet home: the profiles deny it.
 *
 * WHY THE TOP — `cwd` must be the top of its work tree: the patch (`git diff
 * HEAD`), the `deps` entries and the test command all name paths from one root,
 * the top's, and a cwd below it would make each of them mean something else in
 * the clone. A cwd that is not the top, or no work tree at all, is refused
 * before anything is made.
 *
 * THE ISOLATED GIT — every git call on the work tree and in the clone runs with
 * core's CLONE_CONFIG and env: no system or global config, no hook, no
 * fsmonitor, no LFS filter. The patch is applied with `git apply --index` (git's
 * own checks hold: no write beyond a committed symlink) and committed as
 * omelette-fleet with `--no-verify`, before the `.git` copy into `out/`, so
 * Neon's diff is taken against the patched tree. A patch that does not apply, or
 * applies and changes nothing, removes the run dir and is refused naming the
 * work tree's HEAD.
 *
 * THE SCRATCH HOME — `home/` holds `Library/Keychains`, a link to the
 * operator's, and nothing else: agy signs in with a read of the Keychains and
 * the exec of /usr/bin/security, and needs nothing else of the home (measured
 * 2026-11-24 on agy 1.5.16); its state, conversations and settings stay in the
 * run, and the operator's agy state is never read or written.
 *
 * DEPS — the project's installed-dependency directories (`node_modules`,
 * `.venv`), named by the call and checked before any run dir exists: each a
 * directory inside the work tree (no link followed, none resolving outside it),
 * no glob character, none being or holding `.git` or `.omelette`, holding no
 * tracked file and ignored by git whole (the operator's global excludes count),
 * no two overlapping, each on the runs root's volume. Each is copied into the
 * clone at the same place by `cp -Rc` (APFS clones: no data duplicated; off the
 * volume `cp -c` would copy in full, so that is refused) where the patched tree
 * has nothing at it and only real directories above it, left out of the diff by
 * testDiff by path whatever the clone's `.gitignore` says (the out-dir `.git`'s
 * `info/exclude` too, for speed), and a
 * venv's console scripts get their shebang moved from the work tree's
 * interpreter, which profile B denies, to the copy's. Nothing else of the work
 * tree enters the copy.
 *
 * PROFILE B — the test command runs once per round under units/mistral/repro.sb,
 * read in place, byte for byte (runTestCommand): no network, writes only the
 * clone and the run's tmp, no read of the operator's home but the adapter's
 * node, the work tree, the fleet home, the out dir and every other run denied;
 * HOME and TMPDIR are the run's tmp, PATH the unit's own (testPath), both streams
 * go to `tmp/round-<n>.log` (node aborts at start on a stdout the profile denies
 * reading, and it denies `out/`), copied by the unit to `out/round-<n>.log`
 * after the run and removed from tmp, the group is killed when the command exits, a time
 * limit ends a run, and the model gets the last 16 KB, made safe to show.
 *
 * DROP — the workspace config paths agy honours, removed from the clone as
 * Mistral drops `.vibe`. G0 (2026-11-24, agy 1.5.16) found none: settings
 * files planted at seven candidate paths granted nothing. Empty; the constant
 * stays for the day a release of agy adds one.
 *
 * Zero deps.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLONE_CONFIG, cloneDiff, cloneGitEnv, gitRun, prepareClone, removeRun, runsRootAt } from '../../core/clone.mjs';
import { INVISIBLE_CHARS } from '../../core/log.mjs';
import { NODEUP_NONE, SANDBOX_EXEC, nodeEnv, nodeUp, regexLiteral } from '../../core/seatbelt.mjs';
import { locateBin } from '../../core/unit.mjs';

/** The name of gemini_test's runs root under the OS temp dir. */
export const TEST_RUNS = 'omelette-gemini-test';

/** The one parent of every gemini_test run: `<OS temp>/omelette-gemini-test`, 0700, the operator's. */
export const testRunsRoot = () => runsRootAt(TEST_RUNS, 'gemini');

/** Workspace config paths agy honours, dropped from the clone: G0 found none (agy 1.5.16). */
export const DROP = [];

const MB = 1024 * 1024;
/** The largest patch prepareTestRun takes. */
const PATCH_MAX = 16 * MB;

/** The last non-empty line of a child's stderr, or a fallback. */
function lastLine(r, fallback) {
  const lines = (r.stderr ? r.stderr.toString() : '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : (r.error && r.error.message) || fallback;
}

/** `cwd`'s work tree top, which must be `cwd` itself (resolved); otherwise the refusal, naming the top or git's words. */
function workTreeTop(cwd) {
  const r = spawnSync('git', [...CLONE_CONFIG, '-C', cwd, 'rev-parse', '--show-toplevel'], { env: cloneGitEnv(), timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const top = r.status === 0 ? r.stdout.toString().trim() : lastLine(r, `exit ${r.status}`);
  let real = null;
  try { real = realpathSync(cwd); } catch { /* refused below */ }
  if (r.status !== 0 || top !== real) {
    throw new Error(`gemini: ${cwd} is not the top of its git work tree (${top}) — gemini_test clones the top; pass it as cwd`);
  }
  return top;
}

/** `patch` is an absolute path to a regular file (lstat: a link is not followed) of 1 byte to 16 MB. */
function checkPatch(patch) {
  const refused = () => new Error(`gemini: "patch" must be an absolute path to a regular file (got ${JSON.stringify(patch)})`);
  if (typeof patch !== 'string' || !isAbsolute(patch)) throw refused();
  let st;
  try { st = lstatSync(patch); } catch { throw refused(); }
  if (!st.isFile()) throw refused();
  if (st.size === 0) throw new Error(`gemini: the patch ${patch} is empty`);
  if (st.size > PATCH_MAX) throw new Error(`gemini: the patch ${patch} is larger than 16 MB`);
}

/**
 * gemini_test's run: a HEAD-only clone of the work tree at `cwd` (its top) with
 * the session's `patch` applied and committed, the run's `tmp/`, a scratch
 * `home/` holding only `Library/Keychains` linked to `<home>/Library/Keychains`,
 * and `out/`. `home` is the operator's resolved home. Each refusal comes before
 * anything is made; one after the run dir exists removes it first.
 * @param {{cwd: string, patch: string, home: string, log?: (line: string) => void}} o
 * @returns {{runDir: string, clone: string, tmp: string, home: string, out: string, top: string, head: string, ids: Record<string, {dev: number, ino: number}>, deps: []}}
 *   `head` is the work tree's short HEAD (the patch commit's parent); `ids` covers clone, tmp and home (assertRun); `deps` is empty until copyDeps
 */
export function prepareTestRun({ cwd, patch, home, log = () => {} }) {
  const top = workTreeTop(cwd);
  checkPatch(patch);
  let head = null;
  const setup = ({ clone, env, config, head: at }) => {
    head = at;
    const git = (args) => spawnSync('git', [...config, '-C', clone, ...args], { env, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const applied = git(['apply', '--index', '--whitespace=nowarn', '--', patch]);
    if (applied.error || applied.status !== 0) throw new Error(`gemini: the patch does not apply to HEAD ${at}: ${lastLine(applied, `exit ${applied.status}`)}`);
    // `--quiet` exits 0 when the index matches HEAD: the patch applied and changed nothing.
    const staged = git(['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv']);
    if (staged.status === 0) throw new Error(`gemini: the patch changes nothing at HEAD ${at}`);
    gitRun([...config, '-C', clone,
      '-c', 'user.name=omelette-fleet', '-c', 'user.email=gemini-test@omelette.invalid', '-c', 'commit.gpgsign=false',
      'commit', '-q', '--no-verify', '-m', 'gemini_test: the patch under test'], { env, timeout: 60_000 });
  };
  const run = prepareClone({ cwd: top, log, unit: 'gemini', root: testRunsRoot, drop: DROP, dirs: ['tmp', 'home', 'out'], setup });
  try {
    mkdirSync(join(run.home, 'Library'), { mode: 0o700 });
    symlinkSync(join(home, 'Library', 'Keychains'), join(run.home, 'Library', 'Keychains'));
  } catch (e) {
    removeRun(run.runDir);
    throw e;
  }
  return { runDir: run.runDir, clone: run.clone, tmp: run.tmp, home: run.home, out: run.out, top: run.top, head, ids: run.ids, deps: [] };
}

/**
 * The run's directory removed, clone and all, by removeRun with no `clear`:
 * for a run in which no model-written program has run (after that, removal
 * happens under a kernel profile). When the one recursive pass fails (a
 * directory a copied dependency holds 0555, which rm cannot empty), `fix` makes
 * what is under the run's `clone`, `tmp` and `home` removable — `/bin/chmod -R
 * u+rwX` on those three paths, no shell, 60 s, errors ignored; `chmod -R`
 * follows no link, so the scratch home's Keychains link is not followed — and
 * the removal is tried once more.
 * @param {{runDir: string}} run prepareTestRun's result
 * @returns {boolean} true when the run dir is gone
 */
export function discardRun(run) {
  const fix = () => {
    try {
      execFileSync('/bin/chmod', ['-R', 'u+rwX', join(run.runDir, 'clone'), join(run.runDir, 'tmp'), join(run.runDir, 'home')], { timeout: 60_000, stdio: 'ignore' });
    } catch { /* what chmod could not reach, the second pass reports */ }
  };
  return removeRun(run.runDir, { dirs: ['clone', 'tmp', 'home'], fix });
}

/**
 * The run's diff: what the model wrote in the clone, taken by core's cloneDiff
 * against the out-dir `.git` with the run's scratch index (`<out>/diff.index`),
 * every copied dependency left out by path whatever the clone's `.gitignore`
 * says. The one way to take this run's diff.
 * @param {{clone: string, out: string, deps: {rel: string}[]}} run prepareTestRun's result, after copyDeps
 * @returns {string}
 */
export function testDiff(run) {
  return cloneDiff(run.clone, join(run.out, 'git'), { keepKey: 'gemini.testKeep', indexFile: join(run.out, 'diff.index'), exclude: run.deps.map((d) => d.rel) });
}

/** The most a venv console script may weigh for relocateVenv to rewrite it. */
const SCRIPT_MAX = 64 * 1024;

/** git with no system config but the operator's global one, so his `core.excludesFile` counts in «ignored». */
const excludesEnv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1' });

/** `p`'s lstat, or null when nothing stands there. */
function lstatOrNull(p) {
  try { return lstatSync(p); } catch { return null; }
}

/**
 * The call's `deps` entries checked against the work tree's top, before any run
 * dir exists; each refusal opens `gemini: deps entry <the entry, JSON>`. An
 * entry must be a relative path inside the work tree (a string, not empty, not
 * absolute, not `.`, no `..` component, no control character); no glob
 * character (`*`, `?`, `[`, `]`, `\`): it is named literally; no component
 * named `.git` or `.omelette` and no such direct child (lstat); a directory
 * (lstat: a link is not followed) whose real path is the top's real path joined
 * with it; holding no file git tracks; ignored by git whole (`check-ignore` of
 * `<entry>/`, the operator's global excludes counted); overlapping no other
 * entry; on the volume of `root`, the runs root (`devOf`), so `cp -c` clones
 * instead of copying.
 * @param {{top: string, deps: unknown[], root: string, devOf?: (p: string) => number}} o
 * @returns {string[]} the entries normalised, no trailing `/`, in the order given
 */
export function checkDeps({ top, deps, root, devOf = (p) => statSync(p).dev }) {
  const realTop = realpathSync(top);
  const accepted = [];
  for (const entry of deps) {
    const refused = (tail) => new Error(`gemini: deps entry ${JSON.stringify(entry)} ${tail}`);
    if (typeof entry !== 'string' || entry === '' || isAbsolute(entry) || /[\u0000-\u001f\u007f]/.test(entry) || entry.split('/').includes('..')) {
      throw refused('must be a relative path inside the work tree');
    }
    const rel = posix.normalize(entry).replace(/\/+$/, '');
    if (rel === '.' || rel === '') throw refused('must be a relative path inside the work tree');
    // The entry becomes an exclude line: a glob in it would hide more than the copy (`te*` hides `test/`).
    if (/[*?[\]\\]/.test(rel)) throw refused('holds a glob character (* ? [ ] \\) — name the directory literally');
    const abs = join(realTop, rel);
    // Compared without case: on a case-insensitive volume `.GIT` is the work tree's `.git`.
    const reserved = (name) => ['.git', '.omelette'].includes(name.toLowerCase());
    if (rel.split('/').some(reserved) || lstatOrNull(join(abs, '.git')) || lstatOrNull(join(abs, '.omelette'))) {
      throw refused('is or holds .git or .omelette');
    }
    const st = lstatOrNull(abs);
    if (!st || !st.isDirectory()) throw refused('is not a directory (a symlink is not followed)');
    if (realpathSync(abs) !== abs) throw refused('resolves outside the work tree');
    if (gitRun([...CLONE_CONFIG, '-C', realTop, 'ls-files', '-z', '--', rel], { env: cloneGitEnv() }).text !== '') {
      throw refused('holds tracked files — only a directory git ignores whole is copied');
    }
    const ignored = spawnSync('git', [...CLONE_CONFIG, '-C', realTop, 'check-ignore', '-q', '--', `${rel}/`], { env: excludesEnv(), timeout: 60_000, stdio: 'ignore' });
    if (ignored.status !== 0) throw refused('is not ignored by git — only a directory git ignores whole is copied');
    const other = accepted.find((a) => a === rel || rel.startsWith(`${a}/`) || a.startsWith(`${rel}/`));
    if (other !== undefined) throw new Error(`gemini: deps entries ${JSON.stringify(other)} and ${JSON.stringify(rel)} overlap`);
    if (devOf(abs) !== devOf(root)) {
      throw refused(`is on another volume than ${root} — a copy-on-write clone (cp -c) is not possible; gemini_test copies dependencies within one volume only`);
    }
    accepted.push(rel);
  }
  return accepted;
}

/**
 * Each of checkDeps' entries copied from the work tree into the run's clone at
 * the same place. The clone is HEAD plus the patch, so the patch decides what
 * stands there: each directory from the clone down to the copy's parent must be
 * absent (then made, one level at a time, 0755) or, by lstat, a real directory,
 * and the copy's own path absent by lstat — a link, a file or a directory there
 * is refused, never written through or into. Then `/bin/cp -Rc` (APFS clones,
 * links copied as links; no shell, 120 s), `/<entry>/` appended to the out-dir
 * `.git`'s `info/exclude` (the ordinary case's fast path; testDiff leaves the
 * copy out whatever the clone's ignore files say), and a venv's console scripts
 * relocated (relocateVenv) when `<copy>/pyvenv.cfg` exists. Sets `run.deps` to
 * `[{ rel, copy, chain }]`, `chain` the lstat `{ path, dev, ino }` of each
 * directory from the clone down to the copy (the clone itself not included, the
 * copy last). Any failure — a refusal, a failed or timed-out `cp`, a failed
 * relocation — removes the run (discardRun) and rethrows.
 * @param {{runDir: string, clone: string, top: string, out: string}} run prepareTestRun's result
 * @param {string[]} deps checkDeps' result
 */
export function copyDeps(run, deps, { log = () => {} } = {}) {
  // Once per run: a second call would drop the first one's entries from run.deps, which the diff and the profile read.
  if (run.deps && run.deps.length) throw new Error('gemini: copyDeps already ran for this run');
  run.deps = [];
  try {
    for (const rel of deps) {
      const q = JSON.stringify(rel);
      const src = join(run.top, rel);
      const copy = join(run.clone, rel);
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        const at = parts.slice(0, i).join('/');
        const st = lstatOrNull(join(run.clone, at));
        if (!st) mkdirSync(join(run.clone, at), { mode: 0o755 });
        else if (!st.isDirectory()) throw new Error(`gemini: deps entry ${q} cannot be copied: ${JSON.stringify(at)} is not a directory in the patched tree (HEAD plus the patch)`);
      }
      if (lstatOrNull(copy)) throw new Error(`gemini: deps entry ${q} cannot be copied: it already exists in the patched tree (HEAD plus the patch) — a dependency directory is one git ignores whole`);
      const t0 = Date.now();
      try {
        execFileSync('/bin/cp', ['-Rc', src, copy], { timeout: 120_000, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        if (e && e.code === 'ETIMEDOUT') throw new Error(`gemini: copying deps entry ${q} did not finish in 120 s`);
        throw new Error(`gemini: copying deps entry ${q} failed: ${lastLine(e, e.message)}`);
      }
      const info = join(run.out, 'git', 'info');
      mkdirSync(info, { recursive: true });
      // A leading blank line: whatever the file ended with, the pattern stands on its own line.
      appendFileSync(join(info, 'exclude'), `\n/${rel}/\n`);
      const venv = existsSync(join(copy, 'pyvenv.cfg'));
      const relocated = venv ? relocateVenv(copy, src) : 0;
      const chain = parts.map((_, i) => {
        const path = join(run.clone, ...parts.slice(0, i + 1));
        const st = lstatSync(path);
        return { path, dev: st.dev, ino: st.ino };
      });
      run.deps.push({ rel, copy, chain });
      const venvNote = relocated ? `, ${relocated} venv script(s) relocated` : venv ? ', a venv with no script relocated — its scripts may name another spelling of its path' : '';
      log(`gemini_test: deps entry ${q} copied (cp -c) in ${((Date.now() - t0) / 1000).toFixed(1)} s${venvNote}`);
    }
  } catch (e) {
    discardRun(run);
    throw e;
  }
}

/**
 * A copied venv's console scripts made to run the copy's interpreter: each
 * regular file directly under `<copy>/bin` (lstat: a link is left as it is), at
 * most 64 KB, whose first line starts `#!<src>/bin/` gets that prefix replaced
 * by `#!<copy>/bin/`, its mode kept. A `bin` that is not a directory (a link
 * included) is left alone. Untouched, `.venv/bin/pytest` would name the work
 * tree's interpreter, which profile B denies.
 * @returns {number} how many scripts were rewritten
 */
export function relocateVenv(copy, src) {
  const bin = join(copy, 'bin');
  const st = lstatOrNull(bin);
  if (!st || !st.isDirectory()) return 0;
  const from = Buffer.from(`#!${src}/bin/`);
  const to = Buffer.from(`#!${copy}/bin/`);
  let count = 0;
  for (const name of readdirSync(bin)) {
    const p = join(bin, name);
    const f = lstatSync(p);
    if (!f.isFile() || f.size > SCRIPT_MAX) continue;
    const text = readFileSync(p);
    if (!text.subarray(0, from.length).equals(from)) continue;
    const mode = f.mode & 0o7777;
    if (!(mode & 0o200)) chmodSync(p, mode | 0o200);
    writeFileSync(p, Buffer.concat([to, text.subarray(from.length)]));
    chmodSync(p, mode);
    count++;
  }
  return count;
}

/**
 * Profile B: Mistral's repro profile, byte for byte, read in place (spec, «What
 * it leaves open»: «with the same profile») — never a copy that could drift.
 */
export const PROFILE_B = fileURLToPath(new URL('../mistral/repro.sb', import.meta.url));

/**
 * sandbox-exec's arguments for profile B over this run: a `-D` for every param
 * repro.sb reads, then `-f PROFILE_B`. Every path is resolved (Seatbelt matches
 * real paths; a spelling through a link would deny nothing): CLONE, TMP, OUT and
 * RUN from the run, RUNS the run dir's parent, HOME the operator's, FLEET the
 * fleet home, SRC the work tree's top, TMPROOT the OS temp root as a regex
 * literal; NODE and NODEUP are `reach`'s regexes (`{ node, up }`).
 * @param {{clone: string, tmp: string, out: string, runDir: string, top: string}} run
 * @param {{home: string, fleet: string, reach: {node: string, up: string}}} o
 * @returns {string[]}
 */
export function profileBArgs(run, { home, fleet, reach }) {
  const params = [
    ['CLONE', realpathSync(run.clone)],
    ['TMP', realpathSync(run.tmp)],
    ['HOME', realpathSync(home)],
    ['FLEET', realpathSync(fleet)],
    ['OUT', realpathSync(run.out)],
    ['RUNS', realpathSync(dirname(run.runDir))],
    ['RUN', realpathSync(run.runDir)],
    ['TMPROOT', regexLiteral(realpathSync(tmpdir()))],
    ['SRC', realpathSync(run.top)],
    ['NODE', reach.node],
    ['NODEUP', reach.up],
  ];
  return [...params.flatMap(([k, v]) => ['-D', `${k}=${v}`]), '-f', PROFILE_B];
}

/**
 * The test command's PATH (the session's ruling on T7's probe, 2026-11-25):
 * under repro.sb a stat through a symlink inside the home is EPERM, not ENOENT,
 * and a PATH search stops at it — npm's spawn of `sh` failed with the
 * operator's own PATH. In order, duplicates dropped (the first wins): the
 * program's own directory; each of `extra` as given — programDirs' resolved
 * directories the program needs (node's `bin` for nvm's npm), taken even under
 * the home: the reach re-allows them; each entry of `inherited` that is
 * absolute and resolves, kept only when neither its spelling nor its real path
 * is the home or under it (the home as given and resolved); then `/usr/bin` and
 * `/bin`. Nothing else under the home is searched.
 * @param {{program: string, home: string, inherited?: string, extra?: string[]}} o `program` the absolute path the runner executes
 * @returns {string}
 */
export function testPath({ program, home, inherited = process.env.PATH || '', extra = [] }) {
  const homes = [home];
  try { homes.push(realpathSync(home)); } catch { /* the spelling alone */ }
  const under = (p) => homes.some((h) => p === h || p.startsWith(h.endsWith('/') ? h : `${h}/`));
  const path = [];
  const add = (d) => { if (!path.includes(d)) path.push(d); };
  add(dirname(program));
  for (const d of extra) add(d);
  for (const entry of String(inherited).split(':')) {
    if (!entry || !isAbsolute(entry)) continue;
    let real;
    try { real = realpathSync(entry); } catch { continue; }
    if (under(entry) || under(real)) continue;
    add(entry);
  }
  add('/usr/bin');
  add('/bin');
  return path.join(':');
}

const INVISIBLE_ALL = new RegExp(INVISIBLE_CHARS.source, 'gu');
/** An OSC sequence (a title, a hyperlink), ended by BEL or ST. */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** A CSI sequence (colour, cursor). */
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * A command's output made safe to show: CRLF and lone CR become LF (a CR-only
 * line cannot overwrite what was printed before it), ANSI OSC and CSI sequences
 * removed, then every INVISIBLE_CHARS character but LF and TAB (control
 * characters, a stray ESC, bidi and zero-width characters).
 */
export function safeOutput(s) {
  return String(s)
    .replace(/\r\n?/g, '\n')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(INVISIBLE_ALL, (c) => (c === '\n' || c === '\t' ? c : ''));
}

/**
 * The last `bytes` bytes of the file at `path`, a UTF-8 character cut at the
 * start dropped, through safeOutput.
 */
export function readTail(path, bytes = 16384) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const r = readSync(fd, buf, got, len - got, size - len + got);
      if (r === 0) break;
      got += r;
    }
    let start = 0;
    // Continuation bytes (10xxxxxx) at the cut belong to a character whose lead was cut off.
    if (size > len) while (start < got && (buf[start] & 0xc0) === 0x80) start++;
    return safeOutput(buf.subarray(start, got).toString('utf8'));
  } finally { closeSync(fd); }
}

/**
 * One run of the test command under profile B: `args` (its first word the
 * absolute program) in the clone, through the unit's ctx.spawn — the env
 * allowlist, the billing scrub, the cancel signal and the live-group kill hold —
 * with `sandbox-exec` put in front (wrap), HOME and TMPDIR the run's tmp, PATH
 * testPath's with `pathDirs` (programDirs' result) right after the program's
 * own directory, the process group killed when the command exits, `timeoutMs`
 * its hard kill. Refused before anything is opened or spawned, in this order:
 * a `timeoutMs` that is not a finite number above 0 (undefined would fall back
 * to the unit's own time limit; 0, a negative or NaN start no timer); a `round`
 * that is not a positive integer, or whose `<out>/round-<round>.log` already
 * exists (lstat: a round number runs once per run); a copied dependency
 * replaced (assertDeps, called here so no caller can forget it); profile B's
 * arguments that cannot be built (profileBArgs resolves the home and the fleet
 * home) — so a refusal leaves no file in tmp/ and `run.sandboxed` as it was.
 * Both streams go, in the order written, to
 * `<tmp>/round-<round>-<12 random hex>.log` (created `wx+`, 0600, never
 * following a link; a name the model cannot plant ahead of the run, though it
 * writes in tmp/): node aborts at start when its
 * stdout is a file the profile denies reading, and repro.sb denies OUT. After
 * the run the unit copies that file's last 1 MB, through its own descriptor (a
 * path the command replaced is never followed), to `<out>/round-<round>.log`
 * (`wx`, 0600), which is `log`; `tail` is that copy's last 16 KB through safeOutput.
 * The descriptor closed, the live path is removed (removeLive), also after a
 * spawn that throws: the unit's own file of a round's output does not stay in tmp/
 * (what the command itself copied or hard-linked there is the command's).
 * Sets `run.sandboxed` before the spawn: from then on a model-written program
 * has run in the clone. `ms` is the unit's own wall time of the run.
 * @returns {Promise<{code: number|null, signal: string|null, killed: boolean, cancelled: boolean, ms: number, tail: string, log: string}>}
 */
export async function runTestCommand(ctx, run, { args, round, timeoutMs, reach, home, fleet, pathDirs = [] }) {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`gemini: runTestCommand needs a positive timeoutMs (got ${String(timeoutMs)})`);
  }
  // Past 2^31 - 1 ms node's timer clamps to 1 ms and the command would be killed at once.
  if (timeoutMs > 2147483647) throw new Error(`gemini: runTestCommand needs a positive timeoutMs of at most 2147483647 (got ${String(timeoutMs)})`);
  if (!Number.isInteger(round) || round < 1) throw new Error(`gemini: runTestCommand needs a positive whole round number (got ${typeof round === 'string' ? JSON.stringify(round) : String(round)})`);
  const log = join(run.out, `round-${round}.log`);
  if (lstatOrNull(log)) throw new Error(`gemini: round ${round} already ran in this run`);
  assertDeps(run);
  const sandboxArgs = profileBArgs(run, { home, fleet, reach });
  const live = join(run.tmp, `round-${round}-${randomBytes(6).toString('hex')}.log`);
  const outFd = openSync(live, 'wx+', 0o600);
  let r;
  let ms;
  try {
    run.sandboxed = true;
    const t0 = Date.now();
    r = await ctx.spawn({
      args,
      cwd: run.clone,
      extraEnv: { HOME: run.tmp, TMPDIR: run.tmp, PATH: testPath({ program: args[0], home, extra: pathDirs }) },
      hardKillMs: timeoutMs,
      killGroupOnExit: true,
      outFd,
      wrap: (_exe, a) => ({ bin: SANDBOX_EXEC, args: [...sandboxArgs, ...a] }),
    });
    ms = Date.now() - t0;
    copyFd(outFd, log);
  } finally {
    closeSync(outFd);
    removeLive(live);
  }
  return { code: r.code, signal: r.signal, killed: r.killed, cancelled: r.cancelled, ms, tail: readTail(log), log };
}

/**
 * The live log's path removed from tmp/, errors ignored: the command may have
 * replaced it with a link or a directory, and rmSync never follows a link.
 */
function removeLive(live) {
  try { rmSync(live, { recursive: true, force: true }); } catch { /* left for the run's cleanup */ }
}

/** The most of a round's output the unit keeps in `out/`: the command can grow its live log by path (a sparse truncate) to any size. */
const LOG_KEEP = 1024 * 1024;

/**
 * The last LOG_KEEP bytes of the file open at `fd`, as large as it was when the copy began, written to a new file
 * at `to` (`wx`, 0600), after one line naming what was cut when anything was.
 */
function copyFd(fd, to) {
  const size = fstatSync(fd).size;
  const from = Math.max(0, size - LOG_KEEP);
  const outFd = openSync(to, 'wx', 0o600);
  try {
    if (from > 0) writeSync(outFd, `[omelette-fleet: the first ${from} bytes of this output cut; the last ${LOG_KEEP} kept]\n`);
    const buf = Buffer.alloc(Math.min(LOG_KEEP, size - from));
    for (let at = from; at < size;) {
      const got = readSync(fd, buf, 0, Math.min(buf.length, size - at), at);
      if (got === 0) break;
      writeSync(outFd, buf, 0, got);
      at += got;
    }
  } finally { closeSync(outFd); }
}

/** A program name on gemini.testPrograms: a word, never a path. */
const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** A control character (C0, DEL, C1), refused in a test command word. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The config value `gemini.testPrograms` as a list: split on `,`, trimmed,
 * empties dropped; each a program name, never a path or a word with a space.
 * @returns {string[]}
 */
export function parsePrograms(value) {
  const list = String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of list) {
    if (!PROGRAM_NAME.test(p)) throw new Error(`gemini: gemini.testPrograms holds ${JSON.stringify(p)}, not a program name`);
  }
  return list;
}

/**
 * The call's `testCommand`: an argv array of 1 to 64 strings, each 1 to 4096
 * characters with no control character (C0, DEL or C1). Every word is read by
 * index: a hole is not a string. No shell ever reads it.
 * @returns {string[]} a dense copy
 */
export function checkTestCommand(argv) {
  const refused = () => new Error('gemini: "testCommand" must be an argv array of 1 to 64 strings with no control characters');
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64) throw refused();
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (typeof w !== 'string' || w.length < 1 || w.length > 4096 || CONTROL.test(w)) throw refused();
    words.push(w);
  }
  return words;
}

/** `p` is `dir` or under it (both resolved). */
const within = (p, dir) => p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

/**
 * The absolute program the test command runs, from its first word — a file
 * Neon cannot write either way:
 *   - a word with no `/` must be on `programs` (gemini.testPrograms) and is
 *     found by locateBin in the absolute PATH entries of `env` only, returned
 *     resolved; one that resolves to `run.top` or under it (both resolved) is
 *     refused — profile B denies the work tree, so a PATH entry inside the
 *     project (`node_modules/.bin` put there by a shell hook) would end as an
 *     exit 126 with the work tree's path in the output the model reads;
 *   - a word with `/` must be relative, with no `..` component, strictly under a
 *     `deps` entry (checkDeps' names), a file in the clone, and resolve either
 *     inside that dependency's copy or outside the run dir (a link to a system
 *     interpreter); returned as `<clone>/<word>`, normalised.
 * @param {{word: string, programs: string[], deps: string[], run: {runDir: string, clone: string, top: string}, env?: object}} o
 * @returns {string}
 */
export function resolveProgram({ word, programs, deps, run, env = process.env }) {
  const q = JSON.stringify(word);
  if (!word.includes('/')) {
    if (!programs.includes(word)) {
      throw new Error(`gemini: ${q} is not on gemini.testPrograms (${programs.join(', ')}) — name a program on it, add one with omelette-fleet set gemini.testPrograms=…, or name a path under a deps entry`);
    }
    const found = locateBin(word, env);
    if (!found) throw new Error(`gemini: ${q} is not found in PATH`);
    const real = realpathSync(found);
    if (within(real, realpathSync(run.top))) {
      throw new Error(`gemini: ${q} resolves into the work tree (${JSON.stringify(real)}) — the test command cannot read the work tree; name a program outside it, or a path under a deps entry`);
    }
    return real;
  }
  const notUnder = () => new Error(`gemini: ${q} is not under a deps entry — a program in the copy outside the dependencies is a file the model can write`);
  if (isAbsolute(word) || word.split('/').includes('..')) throw notUnder();
  const rel = posix.normalize(word).replace(/\/+$/, '');
  const dep = deps.find((d) => rel.startsWith(`${d}/`));
  if (dep === undefined) throw notUnder();
  const program = join(run.clone, rel);
  let real;
  try {
    real = realpathSync(program);
    if (!statSync(real).isFile()) throw new Error('not a file');
  } catch { throw new Error(`gemini: ${q} is not a file in the copy`); }
  // A link in the dependency that names the work tree itself (an absolute link an installer left): profile B denies it.
  if (within(real, realpathSync(run.top))) {
    throw new Error(`gemini: ${q} resolves into the work tree (${JSON.stringify(real)}) — the test command cannot read the work tree; name a program outside it, or a path under a deps entry`);
  }
  if (!within(real, realpathSync(join(run.clone, dep))) && within(real, realpathSync(run.runDir))) {
    throw new Error(`gemini: ${q} resolves into the copy outside its dependency directory`);
  }
  return program;
}

/**
 * The interpreter a script's `#!` line names: the path as written, or for
 * `/usr/bin/env <name>` (`-S` allowed) the program locateBin finds for `<name>`
 * in `env`'s absolute PATH entries — pass the test command's own PATH
 * (testPath), which is where env will look. One level: the interpreter's own
 * `#!` is not read. Null for no `#!`, a relative interpreter, an env with any
 * other option or an assignment, or a name not found.
 * @returns {string|null}
 */
export function shebangOf(path, { env = process.env } = {}) {
  let head;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(512);
    head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
  } finally { closeSync(fd); }
  if (!head.startsWith('#!')) return null;
  const words = head.slice(2).split('\n')[0].trim().split(/[ \t]+/).filter(Boolean);
  const interp = words[0];
  if (!interp || !isAbsolute(interp)) return null;
  if (interp !== '/usr/bin/env') return interp;
  let i = 1;
  if (words[i] === '-S') i++;
  const name = words[i];
  if (!name || name.startsWith('-') || name.includes('=') || name.includes('/')) return null;
  return locateBin(name, env);
}

/** The alternation inside a nodeReach / nodeUp regex of the given shape, or null when it has no path (`^$`). */
function alternation(re, close) {
  if (re === NODEUP_NONE) return null;
  if (!re.startsWith('^(') || !re.endsWith(close)) throw new Error(`gemini: a reach regex of an unknown shape: ${re}`);
  return re.slice(2, -close.length);
}

/**
 * What profile B re-allows under the home (NODE, NODEUP) for the test
 * command's toolchain: `base` (nodeEnv's pair — the adapter's node, repro.sb's
 * own reach) widened by each of `binaries` that resolves under `home`. For a
 * binary `b` (resolved), its prefix is the parent of its directory when that
 * directory is named `bin`, else its directory:
 *   - a prefix that is the home or an ancestor of it: the binary alone;
 *   - a prefix holding `bin/node`: nodeReach's three paths (`bin`,
 *     `lib/node_modules/npm`, `lib/node_modules/corepack`);
 *   - a prefix that is a direct child of the home (`~/.cargo`, `~/miniconda3`):
 *     its `bin` and `lib` only, or the binary alone when it sits in no `bin` —
 *     never the whole directory, which holds credentials and data
 *     (`~/.cargo/credentials.toml`, `~/.local/share`); narrower than the plan's
 *     «re-allowed whole» (the session's ruling on T8, 2026-11-25);
 *   - any other prefix (`~/.pyenv/versions/3.12.1`, uv's
 *     `~/.local/share/uv/python/cpython-…`): the prefix whole.
 * A binary that does not resolve, or resolves outside the home, adds nothing.
 * The directories from the home down to each allowed path's parent are
 * stat-able (nodeUp). `binaries`: the program, its shebang interpreter (one
 * level) and, for each copied venv, `realpath(<copy>/bin/python)`. The tool
 * computes `program` (resolveProgram), then programNeeds, and passes its
 * `interpreter` here and its `dirs` to runTestCommand as `pathDirs`: one lookup,
 * so the interpreter re-allowed is the one the PATH will find.
 * @param {{home: string, binaries: string[], base?: {OMELETTE_REPRO_NODE: string, OMELETTE_REPRO_NODEUP: string}}} o
 * @returns {{node: string, up: string}} `node` one `^(…)(/|$)` regex, `up` one `^(…)$` regex (NODEUP_NONE when empty)
 */
export function toolchainReach({ home, binaries, base = nodeEnv({ home }) }) {
  const realHome = realpathSync(home);
  const nodeParts = [alternation(base.OMELETTE_REPRO_NODE, ')(/|$)')];
  const upParts = [alternation(base.OMELETTE_REPRO_NODEUP, ')$')].filter((p) => p !== null);
  const allowed = [];
  const add = (paths, upTo) => {
    for (const p of paths) if (!allowed.includes(p)) allowed.push(p);
    const up = alternation(nodeUp({ home: realHome, node: upTo }), ')$');
    if (up !== null && !upParts.includes(up)) upParts.push(up);
  };
  for (const b of binaries) {
    let real;
    try { real = realpathSync(b); } catch { continue; }
    if (!within(real, realHome) || real === realHome) continue;
    const dir = dirname(real);
    const inBin = basename(dir) === 'bin';
    const prefix = inBin ? dirname(dir) : dir;
    if (within(realHome, prefix)) add([real], real);
    else if (existsSync(join(prefix, 'bin', 'node'))) {
      const modules = join(prefix, 'lib', 'node_modules');
      add([join(prefix, 'bin'), join(modules, 'npm'), join(modules, 'corepack')], join(modules, 'npm'));
    } else if (dirname(prefix) === realHome) {
      if (inBin) add([dir, join(prefix, 'lib')], dir); else add([real], real);
    } else add([prefix], prefix);
  }
  if (allowed.length) nodeParts.push(allowed.map(regexLiteral).join('|'));
  return {
    node: `^(${nodeParts.join('|')})(/|$)`,
    up: upParts.length ? `^(${upParts.join('|')})$` : NODEUP_NONE,
  };
}

/**
 * The copied dependency directories are still the ones copyDeps made: every
 * `chain` entry (the directories from the clone down to each copy) still lstats
 * as a directory with its recorded dev and ino — a rename of an ancestor and a
 * new directory, or a link, in its place is caught before the program runs.
 * runTestCommand calls it itself before every run; no caller needs to.
 * @param {{deps: {chain: {path: string, dev: number, ino: number}[]}[]}} run
 */
export function assertDeps(run) {
  for (const d of run.deps) {
    for (const c of d.chain) {
      const st = lstatOrNull(c.path);
      if (!st || !st.isDirectory() || st.dev !== c.dev || st.ino !== c.ino) {
        throw new Error('gemini: a dependency directory of the copy was replaced during the run — the test command is not run');
      }
    }
  }
}

/**
 * What the program needs beyond its own directory, from one lookup (the
 * session's ruling on T8, 2026-11-25: nvm's npm resolves to
 * `…/lib/node_modules/npm/bin/npm-cli.js`, whose `#!/usr/bin/env node` finds no
 * node in its own directory and exits 127):
 *   - `dirs`, in order, without duplicates or `dirname(program)` itself:
 *     (a) for a bare name, the directory locateBin found it in, resolved (for
 *     nvm's `npm`, node's own `bin`); nothing for a path under a deps entry;
 *     (b) the directory of the program's shebang interpreter, resolved —
 *     looked up by shebangOf on `[dirname(program), (a), env.PATH]`.
 *     Every one resolved: a spelling through a link inside the home stops a
 *     PATH search under the profile.
 *   - `interpreter`: that interpreter, resolved, or null.
 * The tool computes `program` (resolveProgram), then this, and passes `dirs` to
 * runTestCommand as `pathDirs` and `interpreter` to toolchainReach's binaries —
 * so the interpreter re-allowed is the one the PATH will find.
 * @param {{word: string, program: string, env?: object}} o `word` the command's first word, `program` resolveProgram's result
 * @returns {{dirs: string[], interpreter: string|null}}
 */
export function programNeeds({ word, program, env = process.env }) {
  const own = dirname(program);
  const dirs = [];
  const add = (d) => { if (d !== own && !dirs.includes(d)) dirs.push(d); };
  if (!word.includes('/')) {
    const found = locateBin(word, env);
    if (found) add(realpathSync(dirname(found)));
  }
  const PATH = [own, ...dirs, env.PATH || ''].filter(Boolean).join(':');
  let interpreter = shebangOf(program, { env: { PATH } });
  if (interpreter) {
    try {
      interpreter = realpathSync(interpreter);
      add(dirname(interpreter));
    } catch { interpreter = null; }
  }
  return { dirs, interpreter };
}

/** programNeeds' `dirs`: the resolved directories the program needs on its PATH beside its own. */
export const programDirs = (o) => programNeeds(o).dirs;

/**
 * A path as a Seatbelt string: `"` + `s` with `\` and `"` escaped + `"`. A
 * path holding a control character (C0, DEL or C1) is refused, never rendered.
 */
export function sbString(s) {
  if (typeof s !== 'string') throw new Error(`gemini: a profile A path must be a string (got ${typeof s})`);
  if (CONTROL.test(s)) throw new Error(`gemini: a profile A path holds a control character: ${JSON.stringify(s)}`);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Profile A — agy whole under the kernel (variant N, G0 2026-11-24): writes
 * only the run's clone, tmp and scratch home (never a copied dependency, never
 * the copy's `.gemini`, `.agents` or `.antigravity`); the operator's home
 * unreadable but `Library/Keychains` (read only), agy's binary and the metadata
 * of the directories down to both; the work tree, the fleet home, every other
 * `omelette-*` temp dir and every other run denied, this run's dirs re-allowed
 * last; no hand-off outside the profile but `/usr/bin/security`, which agy's
 * sign-in runs; the network open. Every path comes resolved, absolute, and goes
 * in through sbString; `deps` are the copies' absolute paths, each strictly
 * under `clone` and normalised. The ancestors in the unlink deny are every
 * directory strictly between the clone and each copy, in order, once each.
 * @param {{clone: string, tmp: string, shome: string, home: string, agyExe: string, src: string, fleet: string, runs: string, run: string, tmproot: string, deps: string[]}} p
 * @returns {string}
 */
export function renderProfileA({ clone, tmp, shome, home, agyExe, src, fleet, runs, run, tmproot, deps }) {
  for (const [k, v] of Object.entries({ clone, tmp, shome, home, agyExe, src, fleet, runs, run, tmproot })) {
    if (typeof v !== 'string' || !isAbsolute(v)) throw new Error(`gemini: profile A needs an absolute ${k} (got ${JSON.stringify(v)})`);
  }
  if (!Array.isArray(deps)) throw new Error('gemini: profile A needs deps as an array of paths');
  const ancestors = [];
  for (const d of deps) {
    if (typeof d !== 'string' || !d.startsWith(`${clone}/`) || d.endsWith('/') || posix.normalize(d) !== d) {
      throw new Error(`gemini: profile A: the dep copy ${JSON.stringify(d)} is not under the clone`);
    }
    const chain = [];
    for (let a = dirname(d); a !== clone; a = dirname(a)) chain.unshift(a);
    for (const a of chain) if (!ancestors.includes(a)) ancestors.push(a);
  }
  const q = sbString;
  const keychains = join(home, 'Library', 'Keychains');
  // The two nodeUp chains in one regex: home down to agy's directory, and down to Library (the Keychains' parent).
  const up = [nodeUp({ home, node: agyExe }), nodeUp({ home, node: keychains })].filter((r) => r !== NODEUP_NONE).map((r) => r.slice(2, -2));
  const omelette = `^${regexLiteral(tmproot)}/omelette-`;
  const subpaths = (...ps) => ps.map((p) => `(subpath ${q(p)})`).join(' ');
  const literals = (...ps) => ps.map((p) => `(literal ${q(p)})`).join(' ');
  const lines = [
    '(version 1)',
    '; omelette-fleet gemini_test — profile A: agy whole under the kernel, rendered per run by units/gemini/test-run.mjs.',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${subpaths(clone, tmp, shome)} (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))`,
    '(deny file-read* (regex #"^/dev/ttys"))',
    '(deny file-write* (regex #"^/dev/ttys"))',
    '; the operator\'s home, whole: agy gets the Keychain for its sign-in and its own binary (Measured 1, 3)',
    `(deny file-read* ${subpaths(home)})`,
    `(allow file-read-metadata (regex ${q(`^(${up.join('|')})$`)}))`,
    `(allow file-read* ${literals(agyExe)})`,
    `(allow file-read* ${subpaths(keychains)})`,
    `(deny file-read* ${subpaths(src)})`,
    `(deny file-read* ${subpaths(fleet)})`,
    '; no hand-off outside the profile, as repro.sb — but /usr/bin/security, which agy\'s sign-in runs (Measured 3)',
    '(deny appleevent-send)',
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl") (literal "/usr/bin/automator") (literal "/usr/bin/pbpaste") (literal "/usr/bin/pbcopy"))',
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb") (global-name "com.apple.lsd.modifydb"))',
    '(deny mach-lookup (global-name "com.apple.sysmond"))',
    '(deny job-creation)',
    '(deny user-preference-write)',
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    '(deny sysctl-read (sysctl-name-prefix "kern.procargs"))',
    '(deny process-info*)',
    '(allow process-info* (target same-sandbox))',
    '; every other omelette-* temp dir and every other run; this run\'s own dirs re-allowed last',
    `(deny file-read* (regex ${q(omelette)}))`,
    `(deny file-write* (regex ${q(omelette)}))`,
    `(deny file-read* ${subpaths(runs)})`,
    `(deny file-write* ${subpaths(runs)})`,
    `(allow file-read-metadata ${literals(runs, run)})`,
    `(allow file-read* ${subpaths(clone, tmp, shome)})`,
    `(allow file-write* ${subpaths(clone, tmp, shome)})`,
    `(deny file-write-flags ${subpaths(clone, tmp, shome)})`,
    `(deny file-write-unlink ${literals(clone, tmp, shome, ...ancestors)})`,
    '; the copied dependencies: read, never written (git ignores them, and the test program may live there)',
    ...deps.map((d) => `(deny file-write* ${subpaths(d)})`),
    '; agy\'s workspace-level config directories in the copy: read, never written — Neon plants no agent config (rules, hooks, plugins) for its own next round (Measured 8)',
    `(deny file-write* ${subpaths(join(clone, '.gemini'), join(clone, '.agents'), join(clone, '.antigravity'))})`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Profile A for this run, rendered once into `<out>/a.sb` (`wx`, 0600: a
 * second call fails EEXIST) with every path resolved — the run's own from
 * `run.*`, never from testRunsRoot(), `agyExe` the real path of `exe`, the dep
 * copies from `run.deps` — and `run.sandboxed` set once it is written.
 * @param {{runDir: string, clone: string, tmp: string, home: string, out: string, top: string, deps: {copy: string}[]}} run
 * @param {string} exe agy's binary as found
 * @param {{home: string, fleet: string}} o the operator's home and the fleet home
 * @returns {string} the profile's path
 */
export function writeProfileA(run, exe, { home, fleet }) {
  const text = renderProfileA({
    clone: realpathSync(run.clone),
    tmp: realpathSync(run.tmp),
    shome: realpathSync(run.home),
    home: realpathSync(home),
    agyExe: realpathSync(exe),
    src: realpathSync(run.top),
    fleet: realpathSync(fleet),
    runs: realpathSync(dirname(run.runDir)),
    run: realpathSync(run.runDir),
    tmproot: realpathSync(tmpdir()),
    deps: run.deps.map((d) => d.copy),
  });
  const path = join(run.out, 'a.sb');
  writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  run.sandboxed = true;
  return path;
}
