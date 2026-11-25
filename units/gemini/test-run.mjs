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
 * DROP — the workspace config paths agy honours, removed from the clone as
 * Mistral drops `.vibe`. G0 (2026-11-24, agy 1.5.16) found none: settings
 * files planted at seven candidate paths granted nothing. Empty; the constant
 * stays for the day a release of agy adds one.
 *
 * Zero deps.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CLONE_CONFIG, cloneGitEnv, gitRun, prepareClone, removeRun, runsRootAt } from '../../core/clone.mjs';

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
 * @returns {{runDir: string, clone: string, tmp: string, home: string, out: string, top: string, head: string, ids: Record<string, {dev: number, ino: number}>}}
 *   `head` is the work tree's short HEAD (the patch commit's parent); `ids` covers clone, tmp and home (assertRun)
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
  return { runDir: run.runDir, clone: run.clone, tmp: run.tmp, home: run.home, out: run.out, top: run.top, head, ids: run.ids };
}
