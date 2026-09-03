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
