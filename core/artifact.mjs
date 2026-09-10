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
import { statSync } from 'node:fs';

/**
 * Pull the saved-artifact path out of an image run's output: scan for
 * absolute-path tokens, keep the LAST one that exists as a regular file (the
 * final answer wins over narration), never return `excludePath` (an edit's
 * source image). Returns '' when nothing on disk matches — which is the signal
 * that the run produced no artifact, however confident its prose was.
 * @param {string} text raw stdout / final message from the run
 * @param {string} [excludePath] a path that must never be returned
 * @returns {string} an absolute path to an existing file, or ''
 */
export function extractImagePath(text, excludePath = '') {
  const tokens = (text || '').match(/\/[^\s"'`)\]]+/g) || [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const p = tokens[i].replace(/[.,;:]+$/, '');
    if (!p || p === excludePath) continue;
    try { if (statSync(p).isFile()) return p; } catch { /* not on disk */ }
  }
  return '';
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
