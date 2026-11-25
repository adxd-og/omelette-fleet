/**
 * omelette-fleet :: units/mistral/repro.mjs
 * The ground `mistral_security_repro` stands on: its own gate, the platform
 * check, the disposable clone, the diff the adapter appends, the cleanup.
 *
 * SHARED — the clone, `assertRun`, the diff, the removal and the model-text
 * neutraliser are core/clone.mjs's; `sandbox-exec`, `regexLiteral` and the
 * node reach (`nodeUp`, `nodeReach`, `nodeEnv`) are core/seatbelt.mjs's; the
 * gate is core/config.mjs's `reproAllowed`. This file hands them on under
 * Mistral's names, messages and runs root, so the adapter and its tests import
 * from here alone. What runs through Vibe's wrapper stays here: outsideLinks,
 * fixModes, clearRun.
 *
 * GATE — `OMELETTE_ALLOW_REPRO` alone (`1 | true | on | yes`), read at call
 * time. Executing code in a clone is a different thing from writing the tree:
 * `OMELETTE_ALLOW_WRITE` does not open it, and it opens no write.
 *
 * THE CLONE — core's HEAD-only clone into
 * `<OS temp>/omelette-mistral-repro/run-*` /clone: its `origin` and reflog are
 * removed, so the clone does not name the work tree, which the profile
 * read-denies (SRC) with the operator's whole home. Never under the fleet
 * home: the profile read-denies it, and Seatbelt's last matching rule wins, so
 * a clone there would be unreadable to every sandboxed command. A committed
 * `.vibe/` is dropped before the spawn: Vibe honours a project config over its
 * home, so the repo under review would otherwise choose the model's shell.
 *
 * RUNS — every run, and every review spool (adapter.mjs), lives under one
 * parent, runsRoot(), 0700 and the operator's. The profile denies all of it to
 * a sandboxed command and re-allows the run's own clone and tmp last, so a
 * command never reads or writes a sibling run's clone, tmp or out; RUNS and
 * the run's own dir (RUN, a literal path, never a regex) stay stat-able, not
 * listable, so node and git can walk down to the clone. What else it denies:
 * repro.sb's header.
 *
 * THE DIFF — core's, against the copy of the clone's fresh `.git` kept in the
 * run's OUT dir (the profile denies every sandboxed read and write there).
 * Before it, the clone is made the adapter's own again (fixModes): a file or a
 * directory the model left unreadable is given back its owner bits by
 * `chmod -R` run through the repro wrapper, under the same profile.
 *
 * Zero deps.
 */
import { spawnSync } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import * as shared from '../../core/clone.mjs';
import { SANDBOX_EXEC, sandboxExecFound } from '../../core/seatbelt.mjs';

export { reproAllowed } from '../../core/config.mjs';
export { DIFF_CAP, cloneDiff, removeRun } from '../../core/clone.mjs';
export { NODEUP_NONE, nodeEnv, nodeReach, nodeUp, regexLiteral } from '../../core/seatbelt.mjs';

/** macOS with an executable `sandbox-exec`, or the reason repro cannot run here. */
export function reproSupported({ platform = process.platform, sandboxExec = SANDBOX_EXEC } = {}) {
  if (sandboxExecFound({ platform, sandboxExec })) return { ok: true };
  return { ok: false, reason: `repro: macOS only (1.9.0) — sandbox-exec is not available on ${platform}` };
}

const MB = 1024 * 1024;

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
  return shared.runsRootAt('omelette-mistral-repro', 'mistral');
}

/** The most symlinks outsideLinks reads under a directory; past it the directory is refused as unchecked. */
export const LINKS_CAP = 20_000;

/**
 * The first symlink under `dir` that resolves outside it, or null — review's
 * check before the spawn: Vibe's read_file follows a link out of its workdir
 * whatever `outside_workdir` says (probe 2026-11-06). The tree itself is
 * walked (`find -type l`, links not followed), git work tree or not: Vibe reads
 * the tree, so an untracked, ignored or submodule link is the same hole as a
 * committed one. At most LINKS_CAP links; more, or a walk that does not finish
 * in a minute, is refused as unchecked. Each target is resolved against the
 * link's own directory (followed to the end when it exists) and compared with
 * the real `dir`. Returns `{ path, target }` for the first one outside (each on
 * one line, JSON-quoted when it holds a control character), `{ unchecked:
 * <why> }` when the walk could not be finished.
 */
export function outsideLinks(dir) {
  const real = realpathSync(dir);
  const found = spawnSync('/usr/bin/find', [real, '-type', 'l', '-print0'], { timeout: 60_000, maxBuffer: 256 * MB });
  if (found.error) return { unchecked: `find: ${found.error.code || found.error.message}` };
  const links = found.stdout.toString().split('\0').filter(Boolean);
  if (links.length > LINKS_CAP) return { unchecked: `more than ${LINKS_CAP} symlinks` };
  for (const path of links) {
    let target;
    try { target = readlinkSync(path); } catch { continue; } // gone since the walk: nothing to follow
    let to = resolve(dirname(path), target);
    try { to = realpathSync(to); } catch { /* dangling: its own path is where a read would go */ }
    if (to !== real && !to.startsWith(real + sep)) return { path: shared.oneLine(path), target: shared.oneLine(target) };
  }
  return null;
}

/**
 * The run's directories and a HEAD-only clone of the work tree at `cwd`
 * (core's prepareClone under runsRoot(), a committed `.vibe` dropped):
 * `runDir` (mkdtemp `run-*` under runsRoot(), resolved), `clone`, `tmp` (the
 * run's TMPDIR, 0700), `out` (Vibe's output dir and the prompt, 0700), the
 * clone's short `head`, `dirty` — the work tree had uncommitted changes —
 * `ids`, the lstat `{ dev, ino }` of the clone and tmp dirs (assertRun), and
 * `top`, the work tree's top (the profile's SRC). The clone keeps no remote and no reflog.
 * Throws, before making anything, when `cwd` is not inside a git work tree.
 */
export function prepareClone({ cwd, log = () => {} }) {
  return shared.prepareClone({ cwd, log, unit: 'mistral', root: runsRoot, drop: ['.vibe'] });
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
  shared.assertRun(run, 'mistral: the clone or its tmp directory was replaced during the run — the answer is withheld');
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

/**
 * Removes what the run left in `paths` (its clone and tmp): `/bin/rm -rf` run THROUGH the repro wrapper, so the
 * same profile stands. rm never follows a link, and the kernel refuses a write behind one that resolves outside the
 * clone and tmp, so a process the run left behind cannot point the removal at the operator's files by swapping a
 * directory for a link mid-walk — the race an unsandboxed recursive delete would lose. The two directories
 * themselves stay (the profile keeps them) and rm says so: its exit is not read. removeRun takes them, empty.
 */
export function clearRun({ wrapper, env, paths }) {
  spawnSync(wrapper, ['-c', 'exec /bin/rm -rf "$@"', 'rm', ...paths], { env, stdio: 'ignore', timeout: 120_000 });
}

const HEADING = '## proposed patch (not applied)';
const HEADING_NAME = String.raw`proposed[ \t]+patch[ \t]*\([ \t]*not[ \t]+applied[ \t]*\)`;
/** The lines only the adapter writes, its partial markers (core/partial.mjs) among them. */
const ADAPTER_LINE_SRC = String.raw`^[ \t]*(_\((clone unchanged|clone kept:|the clone is HEAD|vibe:|diff unavailable:)|\[mistral: )`;

/**
 * The model's answer made unable to pass for the adapter's lines (core's
 * neutraliseModelText): its line ends made LF, then a line that opens like one
 * of the adapter's (`_(clone unchanged)_`, `_(clone kept: …)_`,
 * `_(the clone is HEAD …)_`, `_(vibe: …)_`, `_(diff unavailable: …)_`, a
 * `[mistral: …]` partial marker) and a heading of the adapter's name (ATX,
 * setext or HTML) get the model-written prefix, and a code fence the answer
 * left open is closed, so nothing the adapter appends after it lands inside
 * the model's block.
 */
export function neutraliseModelText(text) {
  return shared.neutraliseModelText(text, { headingName: HEADING_NAME, adapterLines: ADAPTER_LINE_SRC });
}

/**
 * The answer with the clone's diff appended under the adapter's heading, or
 * `_(clone unchanged)_` when there is none (core's appendDiff). A heading of
 * that name already in `text` is the model's: it is demoted on its own line,
 * so the adapter's is the one heading left. The fence is longer than any
 * backtick run in the answer or the diff.
 */
export function appendPatch(text, diff) {
  return shared.appendDiff(text, diff, { heading: HEADING, headingName: HEADING_NAME, unchanged: '_(clone unchanged)_' });
}
