/**
 * omelette-fleet :: core/artifact.mjs
 * Shared artifact extraction for image runs.
 *
 * Every image tool in the fleet has the same contract: the vendor CLI saves a
 * file somewhere it chose, the model is asked to reply with the absolute path,
 * and the adapter must return a path that ACTUALLY EXISTS rather than whatever
 * the model claimed. Models pad the answer (markdown, quotes, a trailing full
 * stop), mention the source image, and sometimes name a path they never wrote.
 * The only way to tell an artifact from a hallucination is to stat it.
 *
 * Lifted out of units/grok/adapter.mjs (2026-09-03) when the codex unit grew
 * its own image tool and needed the identical scan.
 */
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What an image artifact's name may end in. A run's answer names paths of every
 * kind — a source image, a config file, a directory it worked in — and only
 * one of them is the thing this tool promised to produce.
 */
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)$/i;

/**
 * How far below the run's own directory the scan goes. A vendor CLI names the
 * file AND the directory — agy saves `generated/image.png` under the cwd it was
 * given — so a scan of the top level alone misses the artifact it was written
 * to find. Bounded because this walks a directory a model chose the contents
 * of: three levels covers every layout seen, and no run can turn the scan into
 * a tree walk of everything it dropped there.
 */
const MAX_SCAN_DEPTH = 3;

/**
 * The newest image file a run left in ITS OWN directory (the throwaway cwd an
 * image tool creates before it spawns), or '' when there is none. This is what
 * a run that ended badly still leaves behind: a CLI that saved the file and was
 * then killed, capped or simply said nothing has produced the artifact the tool
 * promised, and the filesystem is the only place left to read it from. `since`
 * — the run's own start — keeps a file that predates the run out of it.
 *
 * The scan is recursive to `MAX_SCAN_DEPTH` and NEVER follows a symlink: every
 * entry is `lstat`ed, so a symlinked directory is not descended into and a
 * symlinked file is not an artifact. A link is the one entry in the tree that
 * can name a file this run did not write — the walk stays inside the directory
 * it was handed.
 */
/**
 * How far BEFORE the run's start a file's mtime may sit and still be this
 * run's. Filesystem timestamps come from the kernel's coarse clock (Linux:
 * a tick behind the fine clock `Date.now()` reads), so a file written in
 * the first milliseconds after `since` was taken can carry an mtime a few
 * ms EARLIER than `since`. Five seconds keeps that case and still rejects a
 * leftover from an earlier run or the source image of an edit.
 */
export const MTIME_SKEW_MS = 5000;

export function newestImage(dir, since = 0) {
  let newest = '';
  let newestMs = -1;
  const walk = (d, depth) => {
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try { st = lstatSync(p); } catch { continue; /* gone between the listing and the stat */ }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (depth < MAX_SCAN_DEPTH) walk(p, depth + 1); continue; }
      if (!st.isFile() || !IMAGE_EXT_RE.test(name) || st.mtimeMs < since - MTIME_SKEW_MS) continue;
      if (st.mtimeMs > newestMs) { newestMs = st.mtimeMs; newest = p; }
    }
  };
  walk(dir, 0);
  return newest;
}

/**
 * Pull the saved-artifact path out of an image run's output: scan for
 * absolute-path tokens, keep the LAST one that is an IMAGE FILE THIS RUN WROTE
 * (the final answer wins over narration), never return `excludePath` (an edit's
 * source image). Returns '' when nothing on disk matches — which is the signal
 * that the run produced no artifact, however confident its prose was.
 *
 * Two things a stat alone cannot tell apart, and both of them are files a run
 * merely MENTIONED: a path with no image extension (a model that narrates
 * reading `/etc/hosts` has not produced an artifact) and an image that already
 * existed when the run started (the source image of an edit, a leftover in a
 * directory the CLI named). `since` — the run's own start, which every caller
 * takes before it spawns — excludes the second; 0 keeps every existing file
 * eligible, for a caller that has no run to date from.
 * @param {string} text raw stdout / final message from the run
 * @param {string} [excludePath] a path that must never be returned
 * @param {number} [since] epoch ms: a file older than this is not this run's
 * @returns {string} an absolute path to an existing image file, or ''
 */
export function extractImagePath(text, excludePath = '', since = 0) {
  const tokens = (text || '').match(/\/[^\s"'`)\]]+/g) || [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const p = tokens[i].replace(/[.,;:]+$/, '');
    if (!p || p === excludePath || !IMAGE_EXT_RE.test(p)) continue;
    try {
      const st = statSync(p);
      if (st.isFile() && st.mtimeMs >= since - MTIME_SKEW_MS) return p;
    } catch { /* not on disk */ }
  }
  return '';
}

/**
 * Did this run finish cleanly? An image tool answers with a bare path, so the
 * ONE thing a caller has left to read the run's health from is `partial` —
 * and a cap, a kill, a cancel or a non-zero exit all mean the same thing about
 * the file that came back: it is what a run that did not finish left behind.
 * The interpreters already flag the cap and the kill; this is what catches the
 * exit code an image tool would otherwise return as a clean answer, because the
 * marker their text carries is exactly what the bare-path contract drops.
 * @param {{code?:number|null, killed?:boolean, capped?:boolean, cancelled?:boolean}} res
 */
export function unfinishedRun(res) {
  if (!res || typeof res !== 'object') return false;
  return !!(res.killed || res.cancelled || res.capped || (res.code !== undefined && res.code !== 0));
}

/**
 * Why an image run has no artifact to hand back, when the run's OWN bounds
 * explain it — and '' when they do not.
 *
 * An image tool answers with a bare path or an error, so a run that was cut
 * short and saved nothing cannot say so in the text the way a research answer
 * does: it has to say it in the error, and it has to name the key that fixes
 * it. Callers compose it into their own wording; the clause is the shared
 * part, so four tools cannot drift into four explanations of one event.
 *
 * @param {string} unit the unit name, for the config keys the clause names
 * @param {{capped?:boolean, killed?:boolean, cancelled?:boolean}} res the run's own flags
 * @param {{outputCap?:number, timeoutS?:number}} bounds what it ran under
 * @returns {string} one clause, or ''
 */
export function artifactMiss(unit, res = {}, { outputCap, timeoutS } = {}) {
  // The kill is answered FIRST, as it is everywhere else in the fleet — and a
  // cancel is a kill the client asked for, where neither bound was reached, so
  // neither is named.
  if (res && res.cancelled) return 'the run was cancelled by the client before it saved one';
  if (res && res.killed) return `the run was hard-killed after ${timeoutS}s — raise ${unit}.timeoutS in the fleet config`;
  // A tail cap drops the BEGINNING of the output and the saved path usually
  // rides at the end — but a run whose output was cut has an explanation its
  // prose does not, and raising the cap is something an operator can do.
  if (res && res.capped) return `the run's output exceeded the ${outputCap} char cap — raise ${unit}.outputCap or narrow the task`;
  return '';
}
