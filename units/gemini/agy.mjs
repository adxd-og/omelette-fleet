/**
 * omelette-fleet :: units/gemini/agy.mjs
 * What every agy run of the Gemini unit reads off the CLI, shared by the
 * adapter's tools (adapter.mjs) and gemini_test (test.mjs): agy's
 * `--output-format json` envelope, the strings that mean the quota is empty,
 * and the grace the process-group kill leaves above `--print-timeout`. Its own
 * module so test.mjs never imports the adapter, which imports test.mjs.
 *
 * Zero deps.
 */

/** Exhaustion strings => quota is empty. Checked ONLY on FAILED turns (adapter.mjs, QUOTA). */
export const EXHAUSTED_PATTERNS = [
  /RESOURCE_EXHAUSTED/i,
  /exhausted your (?:current )?quota/i,
  /\bquota\b.*\b(exceeded|exhausted|reached|limit)\b/i,
  /\b(exceeded|exhausted|reached)\b.*\bquota\b/i,
];

/** The hard kill sits this far above `--print-timeout`, so agy reports its own timeout first. */
export const HARD_KILL_GRACE_MS = 60000;

/**
 * Parse agy's `--output-format json` payload, or null when stdout is not that.
 * The output cap keeps the TAIL, so an over-cap run arrives front-truncated and
 * fails the `{` check. Null therefore means one of two things, and only the
 * run's `capped` flag tells them apart: a CLI that printed plain text (fail
 * open to it) or an envelope the cap cut open (throw — see interpretAgy).
 */
export function parseAgyResult(out) {
  const s = String(out || '').trim();
  if (!s || s[0] !== '{') return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}
