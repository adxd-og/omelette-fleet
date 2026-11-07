/**
 * omelette-fleet :: units/mistral/repro.mjs
 * The ground `mistral_security_repro` stands on: its own gate, the platform
 * check, the disposable clone, the diff the adapter appends, the cleanup.
 *
 * GATE — `OMELETTE_ALLOW_REPRO` alone (`1 | true | on | yes`), read at call
 * time. Executing code in a clone is a different thing from writing the tree:
 * `OMELETTE_ALLOW_WRITE` does not open it, and it opens no write.
 *
 * THE CLONE — `git clone --no-hardlinks --depth 1 file://<work tree>` into
 * `<OS temp>/omelette-mistral-repro/run-*` /clone, HEAD only: uncommitted
 * work, `.env` and ignored files are not in it. Never under the fleet home: the
 * profile read-denies it, and Seatbelt's last matching rule wins, so a clone
 * there would be unreadable to every sandboxed command. A committed `.vibe/`
 * is dropped before the spawn: Vibe honours a project config over its home,
 * so the repo under review would otherwise choose the model's shell. Every git
 * the adapter runs on the work tree or for the clone reads no system or global
 * config and runs no hook, fsmonitor or LFS smudge (CLONE_CONFIG): a filter or
 * hook the operator's global config names would otherwise run, unsandboxed, on
 * the reviewed repo's content. The clone holds LFS pointers, not content.
 *
 * RUNS — every run, and every review spool (adapter.mjs), lives under one
 * parent, runsRoot(), 0700 and the operator's. The profile denies all of it to
 * a sandboxed command and re-allows the run's own clone and tmp last, so a
 * command never reads or writes a sibling run's clone, tmp or out; RUNS and
 * the run's own dir (RUN, a literal path, never a regex) stay stat-able, not
 * listable, so node and git can walk down to the clone; it also
 * read-denies ~/.gnupg, ~/.netrc, ~/.kube, ~/.docker, ~/.npmrc and
 * ~/.git-credentials, refuses security, pbpaste and pbcopy, a signal to any
 * process outside the sandbox, a file flag in the clone and the unlink,
 * rename or replacement of the clone and tmp directories themselves (repro.sb).
 *
 * THE DIFF — taken by the adapter, outside the sandbox, against a copy of the
 * clone's fresh `.git` kept in the run's OUT dir (the profile denies every
 * sandboxed read and write there), never against the clone's own `.git`: the
 * model can write that one, and a `core.fsmonitor` or filter planted in it
 * would run as the operator the moment the adapter called git there. A
 * repository the model nests in the clone is the same door: it is never
 * entered (submodules off, its paths left out and named), and the diff
 * appended is at most DIFF_CAP bytes, so a big one never costs the answer.
 * Before it, the clone is made the adapter's own again (fixModes): a file or a
 * directory the model left unreadable is given back its owner bits by
 * `chmod -R` run through the repro wrapper, under the same profile.
 *
 * Zero deps.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { TRUE_WORDS } from '../../core/config.mjs';

/** The gate: `OMELETTE_ALLOW_REPRO` in the true words; `OMELETTE_ALLOW_WRITE` is not consulted. */
export function reproAllowed(env = process.env) {
  return TRUE_WORDS.has(String(env.OMELETTE_ALLOW_REPRO || '').trim().toLowerCase());
}

/** macOS with an executable `sandbox-exec`, or the reason repro cannot run here. */
export function reproSupported({ platform = process.platform, sandboxExec = '/usr/bin/sandbox-exec' } = {}) {
  if (platform === 'darwin') {
    try {
      accessSync(sandboxExec, constants.X_OK);
      return { ok: true };
    } catch { /* not there: the reason below */ }
  }
  return { ok: false, reason: `repro: macOS only (1.9.0) — sandbox-exec is not available on ${platform}` };
}

const MB = 1024 * 1024;
/** The most of the clone's diff an answer carries; the rest is the clone's, kept with `reproKeep`. */
export const DIFF_CAP = MB;
const DIFF_TRUNCATED = '… diff truncated at 1 MB — set mistral.reproKeep=true to inspect the clone';
/** The adapter's own git reads no system or global config: only the repository's. */
const isolatedGitEnv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
/** Every git call of the adapter's diff: no fsmonitor, and no repository nested in the clone is ever entered. */
const DIFF_CONFIG = [
  '-c', 'core.fsmonitor=false', '-c', 'diff.ignoreSubmodules=all', '-c', 'submodule.recurse=false',
  '-c', 'status.submoduleSummary=false', '-c', 'protocol.allow=never',
];
/** The env of every git call on the work tree and for the clone: isolated, and git-lfs smudges nothing. */
const cloneGitEnv = () => ({ ...isolatedGitEnv(), GIT_LFS_SKIP_SMUDGE: '1' });
/** Every git call on the work tree and for the clone: no hook, no fsmonitor, no LFS filter. */
const CLONE_CONFIG = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false',
];

/**
 * One git command, no shell: `{ text, truncated }`. With `cap`, stdout is read
 * up to the cap plus a margin and cut at the last line end within the cap —
 * `truncated` then — never an error. Otherwise a non-zero exit throws, naming
 * the command and git's last words.
 */
function gitRun(args, { timeout = 60_000, cwd, env, input, cap = 0 } = {}) {
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

/**
 * `s` as a regex matching it literally: its metacharacters escaped. The repro
 * profile uses TMPROOT only inside a regex, so a `.` or a `+` in the OS temp
 * root must not widen or break the deny built from it.
 */
export const regexLiteral = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A path on one line: JSON-quoted when it holds a control character (a newline would forge a diff line). */
const oneLine = (p) => (/[\u0000-\u001f\u007f]/.test(p) ? JSON.stringify(p) : p);

/**
 * The one parent of every repro run (`run-*`) and every review spool
 * (`review-*`): `<OS temp>/omelette-mistral-repro`, created 0700 when absent.
 * Already there, it must be a real directory of this user's — a symlink, a
 * file or another user's directory is refused — and a drifted mode is put
 * back to 0700. The repro profile denies it (RUNS) to every sandboxed command
 * but the run's own clone and tmp.
 * @returns {string} the parent's path (unresolved: the caller resolves it)
 */
export function runsRoot() {
  const root = join(tmpdir(), 'omelette-mistral-repro');
  try { mkdirSync(root, { mode: 0o700 }); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
  const st = lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`mistral: ${root} is not a directory — remove it`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`mistral: ${root} belongs to uid ${st.uid}, not this user — remove it`);
  }
  if ((st.mode & 0o777) !== 0o700) chmodSync(root, 0o700);
  return root;
}

/**
 * The run's directories and a HEAD-only clone of the work tree at `cwd`:
 * `runDir` (mkdtemp `run-*` under runsRoot(), resolved), `clone`, `tmp` (the
 * run's TMPDIR, 0700), `out` (Vibe's output dir and the prompt, 0700), the
 * clone's short `head`, `dirty` — the work tree had uncommitted changes —
 * and `ids`, the lstat `{ dev, ino }` of the clone and tmp dirs (assertRun).
 * Throws, before making anything, when `cwd` is not inside a git work tree.
 */
export function prepareClone({ cwd, log = () => {} }) {
  const env = cloneGitEnv();
  let inside;
  try {
    inside = execFileSync('git', [...CLONE_CONFIG, '-C', cwd, 'rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000, env }).toString().trim();
  } catch (e) {
    inside = (e && e.stderr && e.stderr.toString().trim().split('\n')[0]) || (e && e.code) || 'failed';
  }
  if (inside !== 'true') {
    throw new Error(`mistral: ${cwd} is not a git work tree (git rev-parse --is-inside-work-tree: ${inside}) — repro clones its HEAD, so it needs one`);
  }
  const top = git([...CLONE_CONFIG, '-C', cwd, 'rev-parse', '--show-toplevel'], { env }).trim();
  const dirty = git([...CLONE_CONFIG, '-C', cwd, 'status', '--porcelain'], { env }).trim() !== '';
  const runDir = realpathSync(mkdtempSync(join(runsRoot(), 'run-')));
  try {
    const clone = join(runDir, 'clone');
    const tmp = join(runDir, 'tmp');
    const out = join(runDir, 'out');
    mkdirSync(tmp, { mode: 0o700 });
    mkdirSync(out, { mode: 0o700 });
    // git URL-decodes a file:// URL: a literal % in the path is sent as %25.
    git([...CLONE_CONFIG, 'clone', '--no-hardlinks', '--depth', '1', '--quiet', `file://${top.replace(/%/g, '%25')}`, clone], { env, timeout: 300_000 });
    rmSync(join(clone, '.vibe'), { recursive: true, force: true });
    // The drop is the adapter's, not the model's: out of the index too, so it is never proposed as a patch.
    git([...CLONE_CONFIG, '-C', clone, 'rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.vibe'], { env });
    // The diff is taken against this copy of the fresh .git, in OUT, which no sandboxed command can read or write.
    cpSync(join(clone, '.git'), join(out, 'git'), { recursive: true });
    const head = git([...CLONE_CONFIG, '-C', clone, 'rev-parse', '--short', 'HEAD'], { env }).trim();
    const idOf = (p) => { const st = lstatSync(p); return { dev: st.dev, ino: st.ino }; };
    const ids = { clone: idOf(clone), tmp: idOf(tmp) };
    log(`repro clone of ${top} at ${head}${dirty ? ' (the work tree had uncommitted changes, not in the clone)' : ''}: ${clone} — LFS files are pointers, not content`);
    return { runDir, clone, tmp, out, head, dirty, ids };
  } catch (e) {
    removeRun(runDir);
    throw e;
  }
}

/**
 * The run's clone and tmp are still the directories prepareClone made: each,
 * lstat'ed (a link is a link), a directory with the recorded `dev` and `ino`.
 * Otherwise throws — the adapter's git and chmod would run on whatever now
 * stands at that path. The refusal is never retried: the repro tool never
 * retries.
 * @param {{clone: string, tmp: string, ids: {clone: {dev: number, ino: number}, tmp: {dev: number, ino: number}}}} run
 */
export function assertRun(run) {
  const same = (p, id) => {
    try {
      const st = lstatSync(p);
      return st.isDirectory() && st.dev === id.dev && st.ino === id.ino;
    } catch { return false; }
  };
  if (!same(run.clone, run.ids.clone) || !same(run.tmp, run.ids.tmp)) {
    throw new Error('mistral: the clone or its tmp directory was replaced during the run — the answer is withheld');
  }
}

/**
 * What the run changed in the clone, as one `git diff` ('' when nothing):
 * the tracked files, and the untracked ones as new files (intent-to-add), a
 * symlink as its target path, never the bytes behind it. A repository the
 * model nested in the clone is not diffed: one `(nested repository <path> not
 * diffed)` line each, first, the path JSON-quoted when it holds a control
 * character. Past DIFF_CAP bytes the diff is cut at a line end and its last
 * line says so.
 *
 * This runs outside the sandbox, so it reads nothing the model could have
 * written but the work tree itself: the git dir is `gitDir`, the copy
 * prepareClone kept in OUT — never the clone's own `.git`, where a planted
 * `core.fsmonitor` or filter would run here, unsandboxed — no system or
 * global config applies (no external diff, textconv or filter driver), and
 * submodules and nested repositories are never entered.
 */
export function cloneDiff(clone, gitDir = join(dirname(clone), 'out', 'git')) {
  const base = ['--git-dir', gitDir, '--work-tree', clone, '--literal-pathspecs', ...DIFF_CONFIG];
  const opts = { cwd: clone, env: isolatedGitEnv() };
  const untracked = git([...base, 'ls-files', '--others', '--exclude-standard', '-z'], opts).split('\0').filter(Boolean);
  const nested = untracked.filter((p) => inNestedRepo(clone, p));
  const plain = untracked.filter((p) => !nested.includes(p));
  if (plain.length) git([...base, 'add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], { ...opts, input: plain.join('\0') });
  const diff = gitRun([...base, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all'], { ...opts, cap: DIFF_CAP });
  const lines = [
    ...nested.map((p) => `(nested repository ${oneLine(p.replace(/\/+$/, ''))} not diffed)\n`),
    diff.text,
    ...(diff.truncated ? [`${DIFF_TRUNCATED}\n`] : []),
  ];
  return lines.join('');
}

/**
 * Gives the adapter back what the model locked in `paths` (chmod 000 and the like):
 * `/bin/chmod -R u+rwX` run THROUGH the repro wrapper, so the same profile stands —
 * a write behind a link that resolves outside the clone and tmp is refused by the
 * kernel, and chmod -R never follows a link itself. `X` touches no file's exec bit.
 * Never throws: a non-zero exit is one log line.
 */
export function fixModes({ wrapper, env, paths, log = () => {} }) {
  const r = spawnSync(wrapper, ['-c', 'exec /bin/chmod -R u+rwX "$@"', 'chmod', ...paths], { env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
  if (r.status !== 0) log(`repro: chmod -R under the sandbox exited ${r.status ?? r.signal}: ${String(r.stderr || '').trim().split('\n').slice(-1)[0] || ''}`);
  return r.status === 0;
}

const HEADING = '## proposed patch (not applied)';
/** A heading of the adapter's name as a model writes it: any level, case, indent or spacing. */
const HEADING_SRC = String.raw`^[ \t]*#+[ \t]*proposed[ \t]+patch[ \t]*\([ \t]*not[ \t]+applied[ \t]*\)`;
/** The lines only the adapter writes, its partial markers (core/partial.mjs) among them. */
const ADAPTER_LINE_SRC = String.raw`^[ \t]*(_\((clone unchanged|clone kept:|the clone is HEAD|vibe:|diff unavailable:)|\[mistral: )`;
const MODEL_WRITTEN = '> (model-written, not the adapter\'s) ';
const demoteHeadings = (text) => text.replace(new RegExp(HEADING_SRC, 'gim'), (h) => MODEL_WRITTEN + h);

/**
 * The model's answer made unable to pass for the adapter's lines: a line that
 * opens like one of the adapter's (`_(clone unchanged)_`, `_(clone kept: …)_`,
 * `_(the clone is HEAD …)_`, `_(vibe: …)_`, `_(diff unavailable: …)_`, a
 * `[mistral: …]` partial marker) and a
 * heading of the adapter's name get the model-written prefix, and a code
 * fence the answer left open is closed, so nothing the adapter appends after
 * it lands inside the model's block.
 */
export function neutraliseModelText(text) {
  const own = demoteHeadings(String(text).replace(new RegExp(ADAPTER_LINE_SRC, 'gm'), (l) => MODEL_WRITTEN + l));
  const fences = own.split(/\r\n|\r|\n/).filter((l) => /^`{3,}/.test(l)).length;
  return fences % 2 ? `${own}\n\`\`\`` : own;
}

/**
 * The answer with the clone's diff appended under the adapter's heading, or
 * `_(clone unchanged)_` when there is none. A heading of that name already in
 * `text` is the model's: it is demoted on its own line, so the adapter's is
 * the one heading left. The fence is longer than any backtick run in the diff.
 */
export function appendPatch(text, diff) {
  const own = demoteHeadings(text);
  if (!diff) return `${own}\n\n_(clone unchanged)_`;
  const longest = (diff.match(/`+/g) || []).reduce((m, run) => Math.max(m, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${own}\n\n${HEADING}\n\n${fence}diff\n${diff.replace(/\n$/, '')}\n${fence}`;
}

/**
 * The run's directory, clone and all; never throws. When the first removal
 * fails (a directory the model left mode 000), `fix` — the adapter's
 * fixModes over the clone and tmp, under the sandbox — runs and the removal
 * is tried once more; what still stands is one log line.
 * @param {string} runDir
 * @param {{log?: (line: string) => void, fix?: (() => void) | null}} [opts]
 * @returns {boolean} true when the directory is gone
 */
export function removeRun(runDir, { log = () => {}, fix = null } = {}) {
  try { rmSync(runDir, { recursive: true, force: true }); return true; } catch { /* fixed, then once more */ }
  if (fix) fix();
  try {
    rmSync(runDir, { recursive: true, force: true });
    return true;
  } catch (e) {
    log(`repro run dir not removed: ${runDir} — ${(e && e.message) || e}`);
    return false;
  }
}
