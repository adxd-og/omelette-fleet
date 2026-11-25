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
 * after the run, the group is killed when the command exits, a time
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
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLONE_CONFIG, cloneDiff, cloneGitEnv, gitRun, prepareClone, removeRun, runsRootAt } from '../../core/clone.mjs';
import { INVISIBLE_CHARS } from '../../core/log.mjs';
import { SANDBOX_EXEC, regexLiteral } from '../../core/seatbelt.mjs';

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
 * program's own directory; each entry of `inherited` that is absolute and
 * resolves, kept only when neither its spelling nor its real path is the home
 * or under it (the home as given and resolved); then `/usr/bin` and `/bin`.
 * Nothing under the home is searched but the program's own directory.
 * @param {{program: string, home: string, inherited?: string}} o `program` the absolute path the runner executes
 * @returns {string}
 */
export function testPath({ program, home, inherited = process.env.PATH || '' }) {
  const homes = [home];
  try { homes.push(realpathSync(home)); } catch { /* the spelling alone */ }
  const under = (p) => homes.some((h) => p === h || p.startsWith(h.endsWith('/') ? h : `${h}/`));
  const path = [];
  const add = (d) => { if (!path.includes(d)) path.push(d); };
  add(dirname(program));
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
 * testPath's, the process group killed when the command exits, `timeoutMs` its
 * hard kill. Both streams go, in the order written, to `<tmp>/round-<round>.log`
 * (created `wx+`, 0600, never following a link): node aborts at start when its
 * stdout is a file the profile denies reading, and repro.sb denies OUT. After
 * the run the unit copies that file's last 1 MB, through its own descriptor (a
 * path the command replaced is never followed), to `<out>/round-<round>.log`
 * (`wx`, 0600), which is `log`; `tail` is that copy's last 16 KB through safeOutput.
 * Sets `run.sandboxed` before the spawn: from then on a model-written program
 * has run in the clone. `ms` is the unit's own wall time of the run.
 * @returns {Promise<{code: number|null, signal: string|null, killed: boolean, cancelled: boolean, ms: number, tail: string, log: string}>}
 */
export async function runTestCommand(ctx, run, { args, round, timeoutMs, reach, home, fleet }) {
  const live = join(run.tmp, `round-${round}.log`);
  const log = join(run.out, `round-${round}.log`);
  const outFd = openSync(live, 'wx+', 0o600);
  let r;
  let ms;
  try {
    run.sandboxed = true;
    const t0 = Date.now();
    r = await ctx.spawn({
      args,
      cwd: run.clone,
      extraEnv: { HOME: run.tmp, TMPDIR: run.tmp, PATH: testPath({ program: args[0], home }) },
      hardKillMs: timeoutMs,
      killGroupOnExit: true,
      outFd,
      wrap: (_exe, a) => ({ bin: SANDBOX_EXEC, args: [...profileBArgs(run, { home, fleet, reach }), ...a] }),
    });
    ms = Date.now() - t0;
    copyFd(outFd, log);
  } finally { closeSync(outFd); }
  return { code: r.code, signal: r.signal, killed: r.killed, cancelled: r.cancelled, ms, tail: readTail(log), log };
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
