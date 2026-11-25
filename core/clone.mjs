/**
 * omelette-fleet :: core/clone.mjs
 * A disposable HEAD-only clone of a work tree for a unit whose model runs
 * commands: the runs root, the clone, the check that its directories are still
 * the ones made, the diff of what the run changed, the removal, and the model's
 * text made unable to pass for the lines the unit appends after it.
 *
 * Used by Mistral's `mistral_security_repro` (units/mistral/repro.mjs
 * re-exports it under its own names and messages) and Gemini's `gemini_test`
 * (units/gemini/test-run.mjs, its own runs root). What is a unit's own comes
 * in as an argument: the error prefix (`unit`), the runs root (`root`, from
 * runsRootAt), the paths dropped from the clone (`drop`), the run's directories
 * beside the clone (`dirs`), the config key the diff's truncation line names,
 * the heading the diff goes under, and the lines only the unit writes.
 *
 * THE CLONE — `git clone --no-hardlinks --depth 1 file://<work tree>` into
 * `<root>/run-*` /clone, HEAD only: uncommitted work, `.env` and ignored files
 * are not in it, and its `origin` and reflog are removed, so the clone does not
 * name the work tree. Every git run on the work tree or for the clone reads no
 * system or global config and runs no hook, fsmonitor or LFS smudge
 * (CLONE_CONFIG): a filter or hook the operator's global config names would
 * otherwise run, unsandboxed, on the cloned repo's content. The clone holds LFS
 * pointers, not content.
 *
 * THE DIFF — taken outside the sandbox, against a copy of the clone's fresh
 * `.git` kept in the run's `out` dir, never against the clone's own `.git`: the
 * model can write that one, and a `core.fsmonitor` or filter planted in it
 * would run as the operator the moment the unit called git there. A repository
 * the model nests in the clone is the same door: it is never entered
 * (submodules off, its paths left out and named), and the diff is at most
 * DIFF_CAP bytes, so a big one never costs the answer.
 *
 * Zero deps.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const MB = 1024 * 1024;
/** The most of the clone's diff an answer carries; the rest is the clone's, kept with the unit's keep key. */
export const DIFF_CAP = MB;
/** The unit's own git reads no system or global config: only the repository's. */
export const isolatedGitEnv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
/** Every git call of the unit's diff: no fsmonitor, and no repository nested in the clone is ever entered. */
const DIFF_CONFIG = [
  '-c', 'core.fsmonitor=false', '-c', 'diff.ignoreSubmodules=all', '-c', 'submodule.recurse=false',
  '-c', 'status.submoduleSummary=false', '-c', 'protocol.allow=never',
];
/** The env of every git call on the work tree and for the clone: isolated, and git-lfs smudges nothing. */
export const cloneGitEnv = () => ({ ...isolatedGitEnv(), GIT_LFS_SKIP_SMUDGE: '1' });
/** Every git call on the work tree and for the clone: no hook, no fsmonitor, no LFS filter. */
export const CLONE_CONFIG = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false',
];

/**
 * One git command, no shell: `{ text, truncated }`. With `cap`, stdout is read
 * up to the cap plus a margin and cut at the last line end within the cap —
 * `truncated` then — never an error. Otherwise a non-zero exit throws, naming
 * the command and git's last words.
 */
export function gitRun(args, { timeout = 60_000, cwd, env, input, cap = 0 } = {}) {
  const r = spawnSync('git', args, { cwd, env, input, timeout, maxBuffer: cap ? cap + 64 * 1024 : 64 * MB });
  const overflow = cap > 0 && !!r.error && r.error.code === 'ENOBUFS';
  if (!overflow && (r.error || r.status !== 0)) {
    const err = r.stderr ? r.stderr.toString().trim() : '';
    throw new Error(`git ${args.join(' ')}: ${err ? err.split('\n').slice(-2).join(' ') : (r.error && r.error.message) || `exit ${r.status}`}`);
  }
  const out = r.stdout;
  if (!cap || out.length <= cap) return { text: out.toString(), truncated: false };
  const end = out.lastIndexOf(0x0a, cap - 1);
  return { text: out.subarray(0, end >= 0 ? end + 1 : cap).toString(), truncated: true };
}
const git = (args, o) => gitRun(args, o).text;

/** `<clone>/<p>/.git` is there, whatever it is — lstat, no link followed at the leaf. */
function holdsGit(clone, p) {
  try { lstatSync(join(clone, p, '.git')); return true; } catch { return false; }
}

/**
 * An untracked path the diff must not touch: its own name is `.git`, or it
 * is, or sits under, a directory of the clone holding a `.git` entry — a
 * repository the model nested there, whose config git would honour inside it.
 */
function inNestedRepo(clone, path) {
  const p = path.replace(/\/+$/, '');
  if (basename(p) === '.git') return true;
  for (let d = path.endsWith('/') ? p : dirname(p); d && d !== '.'; d = dirname(d)) {
    if (holdsGit(clone, d)) return true;
  }
  return false;
}

/** A path on one line: JSON-quoted when it holds a control character (a newline would forge a diff line). */
export const oneLine = (p) => (/[\u0000-\u001f\u007f]/.test(p) ? JSON.stringify(p) : p);

/**
 * A unit's one parent of every run (`run-*`): `<OS temp>/<name>`, created 0700
 * when absent. Already there, it must be a real directory of this user's — a
 * symlink, a file or another user's directory is refused, the refusal opening
 * with `<unit>:` — and a drifted mode is put back to 0700.
 * @returns {string} the parent's path (unresolved: the caller resolves it)
 */
export function runsRootAt(name, unit) {
  const root = join(tmpdir(), name);
  try { mkdirSync(root, { mode: 0o700 }); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
  const st = lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${unit}: ${root} is not a directory — remove it`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`${unit}: ${root} belongs to uid ${st.uid}, not this user — remove it`);
  }
  if ((st.mode & 0o777) !== 0o700) chmodSync(root, 0o700);
  return root;
}

/**
 * The run's directories and a HEAD-only clone of the work tree at `cwd`:
 * `runDir` (mkdtemp `run-*` under `root`, resolved while `root` may not be —
 * `root` is the runs root or a function returning it, called after the
 * work-tree check), `clone`, one key per entry of `dirs` (each
 * `<runDir>/<dir>`, 0700, made before the clone; `out` is made and keyed
 * whether or not `dirs` names it — the `.git` copy the diff is taken against
 * goes there), the clone's short `head`, `dirty` — the work tree had
 * uncommitted changes — `ids`, the lstat `{ dev, ino }` of the clone and of
 * every dir but `out` (assertRun), and `top`, the work tree's top. Each entry
 * of `dirs` is a plain name (`[a-z][a-z0-9-]*`) and no key of the result, or
 * prepareClone throws before anything else. The clone keeps no remote and no
 * reflog; each path of `drop` — literal relative paths, the caller's
 * constants (git reads them as pathspecs, the removal as plain paths) — is
 * removed from it and from its index; then `setup({ clone, env, config, head })`
 * runs, before the `.git` copy, so what it commits is in the copy the diff is
 * taken against. `setup` runs git with `[...config, '-C', clone, …]` and
 * `env` (config is CLONE_CONFIG, env the clone's git env) and sets its own
 * commit identity; `head` is the clone's short HEAD read just before the call
 * (the work tree's commit), while the result's `head` is read after `setup`,
 * so it names a commit `setup` made. `setup` must be synchronous: one that
 * returns a promise is refused (the run dir removed).
 * Throws, before making anything, when `cwd` is not inside a git work tree (the
 * refusal opening with `<unit>:`); any later failure removes the run dir.
 */
export function prepareClone({ cwd, log = () => {}, unit, root, drop = [], dirs = ['tmp', 'out'], setup = null }) {
  if (!Array.isArray(dirs)) throw new Error('prepareClone: dirs must be an array of directory names');
  for (const d of dirs) {
    if (!/^[a-z][a-z0-9-]*$/.test(d) || ['clone', 'head', 'dirty', 'ids', 'top'].includes(d)) {
      throw new Error(`prepareClone: dirs entry ${JSON.stringify(d)} is not a plain directory name, or collides with a key of the result`);
    }
  }
  const runDirs = dirs.includes('out') ? dirs : [...dirs, 'out'];
  const env = cloneGitEnv();
  let inside;
  try {
    inside = execFileSync('git', [...CLONE_CONFIG, '-C', cwd, 'rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000, env }).toString().trim();
  } catch (e) {
    inside = (e && e.stderr && e.stderr.toString().trim().split('\n')[0]) || (e && e.code) || 'failed';
  }
  if (inside !== 'true') {
    throw new Error(`${unit}: ${cwd} is not a git work tree (git rev-parse --is-inside-work-tree: ${inside}) — repro clones its HEAD, so it needs one`);
  }
  const top = git([...CLONE_CONFIG, '-C', cwd, 'rev-parse', '--show-toplevel'], { env }).trim();
  const dirty = git([...CLONE_CONFIG, '-C', cwd, 'status', '--porcelain'], { env }).trim() !== '';
  // `root` as a function is called only now: a refused cwd has made nothing, and its refusal comes before the runs root's own.
  const runDir = realpathSync(mkdtempSync(join(typeof root === 'function' ? root() : root, 'run-')));
  try {
    const clone = join(runDir, 'clone');
    const made = Object.fromEntries(runDirs.map((d) => [d, join(runDir, d)]));
    for (const p of Object.values(made)) mkdirSync(p, { mode: 0o700 });
    // git URL-decodes a file:// URL: a literal % in the path is sent as %25.
    git([...CLONE_CONFIG, 'clone', '--no-hardlinks', '--depth', '1', '--quiet', `file://${top.replace(/%/g, '%25')}`, clone], { env, timeout: 300_000 });
    // No remote and no reflog: either would name the work tree to a command in the clone.
    git([...CLONE_CONFIG, '-C', clone, 'remote', 'remove', 'origin'], { env });
    rmSync(join(clone, '.git', 'logs'), { recursive: true, force: true });
    for (const p of drop) rmSync(join(clone, p), { recursive: true, force: true });
    // The drop is the unit's, not the model's: out of the index too, so it is never proposed as a patch.
    if (drop.length) git([...CLONE_CONFIG, '-C', clone, 'rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...drop], { env });
    if (setup) {
      const head = git([...CLONE_CONFIG, '-C', clone, 'rev-parse', '--short', 'HEAD'], { env }).trim();
      const r = setup({ clone, env, config: [...CLONE_CONFIG], head });
      if (r && typeof r.then === 'function') {
        r.then(null, () => {});
        throw new Error('prepareClone: setup must be synchronous — it returned a promise');
      }
    }
    // The diff is taken against this copy of the fresh .git, in OUT, which no sandboxed command can read or write.
    cpSync(join(clone, '.git'), join(runDir, 'out', 'git'), { recursive: true });
    const head = git([...CLONE_CONFIG, '-C', clone, 'rev-parse', '--short', 'HEAD'], { env }).trim();
    const idOf = (p) => { const st = lstatSync(p); return { dev: st.dev, ino: st.ino }; };
    const ids = { clone: idOf(clone), ...Object.fromEntries(dirs.filter((d) => d !== 'out').map((d) => [d, idOf(made[d])])) };
    log(`repro clone of ${top} at ${head}${dirty ? ' (the work tree had uncommitted changes, not in the clone)' : ''}: ${clone} — LFS files are pointers, not content`);
    return { runDir, clone, ...made, head, dirty, ids, top };
  } catch (e) {
    removeRun(runDir);
    throw e;
  }
}

/**
 * Every directory `run.ids` names (the clone, and each of prepareClone's dirs
 * but `out`) is still the one prepareClone made: lstat'ed (a link is a link), a
 * directory with the recorded `dev` and `ino`. Otherwise throws `message` — the
 * unit's git and chmod would run on whatever now stands at that path.
 * @param {{ids: Record<string, {dev: number, ino: number}>}} run prepareClone's result: a path under each key of `ids`
 * @param {string} message
 */
export function assertRun(run, message) {
  const same = (p, id) => {
    try {
      const st = lstatSync(p);
      return st.isDirectory() && st.dev === id.dev && st.ino === id.ino;
    } catch { return false; }
  };
  for (const [key, id] of Object.entries(run.ids)) {
    if (!same(run[key], id)) throw new Error(message);
  }
}

/**
 * What the run changed in the clone, as one `git diff` ('' when nothing):
 * the tracked files, and the untracked ones as new files (intent-to-add), a
 * symlink as its target path, never the bytes behind it. A repository the
 * model nested in the clone is not diffed: one `(nested repository <path> not
 * diffed)` line each, first, the path JSON-quoted when it holds a control
 * character. Past DIFF_CAP bytes the diff is cut at a line end and its last
 * line says so, naming `keepKey`. With `indexFile`, every git call of the diff
 * uses that index (GIT_INDEX_FILE) instead of the git dir's own: a scratch
 * path (absolute, outside the clone) core overwrites with a fresh copy of the
 * git dir's index before each diff, so the git dir's own index stays pristine
 * and one path serves every diff of a run. A run passes it on every diff or on
 * none: a diff without it writes its intent-to-add entries into the git dir's
 * own index.
 *
 * This runs outside the sandbox, so it reads nothing the model could have
 * written but the work tree itself: the git dir is `gitDir`, the copy
 * prepareClone kept in OUT — never the clone's own `.git`, where a planted
 * `core.fsmonitor` or filter would run here, unsandboxed — no system or
 * global config applies (no external diff, textconv or filter driver), and
 * submodules and nested repositories are never entered.
 */
export function cloneDiff(clone, gitDir = join(dirname(clone), 'out', 'git'), { keepKey = 'mistral.reproKeep', indexFile } = {}) {
  const base = ['--git-dir', gitDir, '--work-tree', clone, '--literal-pathspecs', ...DIFF_CONFIG];
  const env = isolatedGitEnv();
  if (indexFile !== undefined) {
    if (typeof indexFile !== 'string' || !isAbsolute(indexFile)) throw new Error(`cloneDiff: indexFile must be an absolute path (got ${JSON.stringify(indexFile)})`);
    const at = resolve(indexFile);
    const root = resolve(clone);
    if (at === root || at.startsWith(root + sep)) throw new Error('cloneDiff: indexFile must lie outside the clone — the clone is the model\'s to write');
    if (at === resolve(gitDir, 'index')) throw new Error('cloneDiff: indexFile must not be the git dir\'s own index');
    // The scratch path is core's own: a lock a killed git left beside it, or a link standing at it, goes before the fresh copy.
    for (const p of [indexFile, `${indexFile}.lock`]) rmSync(p, { force: true });
    copyFileSync(join(gitDir, 'index'), indexFile);
    env.GIT_INDEX_FILE = indexFile;
  }
  const opts = { cwd: clone, env };
  const untracked = git([...base, 'ls-files', '--others', '--exclude-standard', '-z'], opts).split('\0').filter(Boolean);
  const nested = untracked.filter((p) => inNestedRepo(clone, p));
  const plain = untracked.filter((p) => !nested.includes(p));
  if (plain.length) git([...base, 'add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], { ...opts, input: plain.join('\0') });
  const diff = gitRun([...base, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all'], { ...opts, cap: DIFF_CAP });
  const lines = [
    ...nested.map((p) => `(nested repository ${oneLine(p.replace(/\/+$/, ''))} not diffed)\n`),
    diff.text,
    ...(diff.truncated ? [`… diff truncated at 1 MB — set ${keepKey}=true to inspect the clone\n`] : []),
  ];
  return lines.join('');
}

/** `p` gone, never followed: rmdir, or unlink when a link or a file stands there; absent is gone. Throws otherwise (a directory not empty). */
function removeEntry(p) {
  try { rmdirSync(p); } catch (e) {
    if (e && e.code === 'ENOENT') return;
    if (e && e.code === 'ENOTDIR') { unlinkSync(p); return; }
    throw e;
  }
}

/** The run dir once its `dirs` are emptied: OUT (no command can write it) recursively, each of `dirs` and the run dir only when empty. */
function removeEmptied(runDir, dirs) {
  rmSync(join(runDir, 'out'), { recursive: true, force: true });
  for (const d of dirs) removeEntry(join(runDir, d));
  removeEntry(runDir);
}

/**
 * The run's directory, clone and all; never throws. A run a model command
 * touched passes `clear` (the unit's removal of the contents of `dirs`, under
 * its sandbox): the unit's code itself removes only OUT and the `dirs` once
 * empty — it never walks a directory a command could still write. When that
 * fails (a directory the model left mode 000, which rm cannot enter), `fix`
 * runs and the removal is tried once more; what still stands is one log line.
 * Without `clear` (no command ran: prepareClone's own failure) the run dir is
 * removed in one recursive pass.
 * @param {string} runDir
 * @param {{log?: (line: string) => void, fix?: (() => void) | null, clear?: (() => void) | null, dirs?: string[]}} [opts]
 * @returns {boolean} true when the directory is gone
 */
export function removeRun(runDir, { log = () => {}, fix = null, clear = null, dirs = ['clone', 'tmp'] } = {}) {
  const remove = clear ? () => { clear(); removeEmptied(runDir, dirs); } : () => rmSync(runDir, { recursive: true, force: true });
  try { remove(); return true; } catch { /* fixed, then once more */ }
  if (fix) fix();
  try {
    remove();
    return true;
  } catch (e) {
    log(`repro run dir not removed: ${runDir} — ${(e && e.message) || e}`);
    return false;
  }
}

const MODEL_WRITTEN = '> (model-written, not the adapter\'s) ';

/**
 * `text` with every heading of `headingName` (a regex source: the unit's
 * heading as a model may write it) marked model-written: ATX at any level, an
 * HTML `<h1>`–`<h6>`, or setext (a line opening with the name over a line of
 * `=` or `-`); any case, indent or spacing.
 */
export function demoteHeadings(text, headingName) {
  const atx = String.raw`^[ \t]*(?:#+[ \t]*|<h[1-6](?:[ \t][^>\n]*)?>[ \t]*)${headingName}`;
  const setext = String.raw`^[ \t]*${headingName}[^\n]*(?=\n[ \t]{0,3}(?:=+|-+)[ \t]*$)`;
  return text
    .replace(new RegExp(atx, 'gim'), (h) => MODEL_WRITTEN + h)
    .replace(new RegExp(setext, 'gim'), (h) => MODEL_WRITTEN + h);
}

/** The longest run of `char` (a backtick or a tilde) in `text`. */
export const longestRun = (text, char) => (text.match(char === '`' ? /`+/g : /~+/g) || []).reduce((m, run) => Math.max(m, run.length), 0);

/**
 * The code fence a markdown reader still has open at the end of `text`, as `{ char }`, or null: a fence line is three
 * or more backticks or tildes after at most three spaces (a backtick one with no backtick behind it); the open fence
 * closes on a line of the same character, at least as long, with nothing else on it.
 */
function openFence(text) {
  let open = null;
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const [char, length, rest] = [m[1][0], m[1].length, m[2]];
    if (!open) { if (char === '~' || !rest.includes('`')) open = { char, length }; }
    else if (char === open.char && length >= open.length && !rest.trim()) open = null;
  }
  return open;
}

/**
 * The model's answer made unable to pass for the unit's lines: its line ends
 * made LF (a CR alone ends a line for a renderer), then a line matching
 * `adapterLines` (a regex source, read per line: the lines only the unit
 * writes, its partial markers among them) and a heading of `headingName`
 * (demoteHeadings) get the model-written prefix, and a code fence the answer
 * left open (backticks or tildes) is closed by one of its character, one
 * longer than the longest run of it in the answer, so nothing the unit
 * appends after it lands inside the model's block.
 */
export function neutraliseModelText(text, { headingName, adapterLines }) {
  const plain = String(text).replace(/\r\n?/g, '\n');
  const own = demoteHeadings(plain.replace(new RegExp(adapterLines, 'gm'), (l) => MODEL_WRITTEN + l), headingName);
  const open = openFence(own);
  return open ? `${own}\n${open.char.repeat(Math.max(3, longestRun(own, open.char) + 1))}` : own;
}

/**
 * The answer with the clone's diff appended under the unit's `heading`, or
 * the `unchanged` line when there is none. A heading of `headingName` already
 * in `text` is the model's: it is demoted on its own line, so the unit's is
 * the one heading left. The fence is longer than any backtick run in the
 * answer or the diff.
 */
export function appendDiff(text, diff, { heading, headingName, unchanged }) {
  const own = demoteHeadings(text, headingName);
  if (!diff) return `${own}\n\n${unchanged}`;
  const fence = '`'.repeat(Math.max(3, longestRun(`${own}\n${diff}`, '`') + 1));
  return `${own}\n\n${heading}\n\n${fence}diff\n${diff.replace(/\n$/, '')}\n${fence}`;
}
