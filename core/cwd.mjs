/**
 * omelette-fleet :: core/cwd.mjs
 * The one pre-spawn check on a caller-supplied run directory.
 *
 * Every tool that takes a `cwd` — the three research tools, the two review
 * tools — validates it the same way and says the same thing when it is wrong.
 * It lived as three identical copies in the three adapters until 0.3.6; the
 * wording is part of the tools' contract (tests pin it), so there is exactly
 * one of it now.
 */
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * Absolute, existing, a directory — checked BEFORE any spawn, because a bad
 * `cwd` is the caller's mistake and a vendor run is not how they should learn
 * about it.
 * @param {*} raw the `cwd` argument as it arrived (undefined = not asked for)
 * @returns {{cwd:string}|{error:string}} the trimmed path ('' when omitted), or the refusal
 */
export function checkCwd(raw) {
  if (raw === undefined) return { cwd: '' };
  const cwd = typeof raw === 'string' ? raw.trim() : '';
  if (!cwd || !isAbsolute(cwd)) return { error: `Error: "cwd" must be an absolute path (got ${JSON.stringify(raw)}).` };
  let st;
  try { st = statSync(cwd); } catch { st = null; }
  if (!st || !st.isDirectory()) return { error: `Error: "cwd" is not an existing directory: ${cwd}` };
  return { cwd };
}
