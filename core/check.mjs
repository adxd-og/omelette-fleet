/**
 * omelette-fleet :: core/check.mjs
 * The mechanical half of `omelette-fleet check`: read a report or a scout map,
 * and say of every pointer line in it whether the evidence is still there.
 *
 * WHY IT EXISTS. A funnel that passes compact evidence upward fails in one
 * way: a digest nobody can check turns one agent's mistake into everyone's
 * premise. So every line of evidence carries `path:line` and a VERBATIM
 * fragment of that line, and this file re-reads the file and looks.
 *
 * ONE GRAMMAR (spec 2026-09-17 §1), and everything that does not match it is
 * prose:
 *   - `core/unit.mjs:436` · `const finish = (text, isError` · the claim
 * The bullet and the backticks around `path:line` are optional, the separator
 * is ` · ` (U+00B7), the fragment is in single backticks — so it can hold no
 * backtick — and the claim after it is free text this file NEVER checks.
 *
 * PURE APART FROM READING THE TARGETS. `checkPointers` takes the text, the
 * root and the set of changed paths, opens files under the root, and returns a
 * verdict per pointer. It writes nothing, anywhere, ever.
 *
 * WHAT A PATH MAY REACH. Everything resolves against the REAL path of the root
 * and is refused when it leaves it — including through a symlinked parent
 * directory, which is why the target's directory is realpath'd and not just
 * the target. A symlink, a directory, a device: `outside`. Over 2 MiB:
 * `too-large`, unread. Each target is read at most once per run.
 *
 * NOTHING BUT A HASH REACHES GIT. `changedSince` validates the `commit:` value
 * as hex before it builds a revision range, and spawns git through execFile
 * with no shell — a `commit: --output=x` line is a parse failure, not an
 * argument.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** At most this many pointer lines per checked file; more is a usage error. */
export const MAX_POINTERS = 2000;
/** A target over this is reported, not read. */
export const MAX_TARGET_BYTES = 2 * 1024 * 1024;
/** How far into a checked file a `commit:` line still counts. */
const COMMIT_SCAN_LINES = 20;

/** A git object name we are willing to put in front of `..HEAD`, and nothing else. */
const HASH = /^[0-9a-f]{7,40}$/i;
/**
 * The pointer line. `\1` is the backtick or nothing, so one lone backtick
 * never opens a pointer; the path holds no whitespace, backtick or colon; the
 * line number starts at 1 (a `path:0` is prose); the fragment is non-empty.
 */
const POINTER = /^[ \t]*(?:[-*][ \t]+)?(`?)([^\s`:]+):([1-9]\d*)\1 · `([^`]+)`/;
/** `commit: <value>` — the value is validated as hex before it is believed. */
const COMMIT = /^[ \t]*commit:[ \t]*`?([^\s`]+)`?[ \t]*$/i;

/** O_NONBLOCK where the platform defines it, 0 where it does not. */
const NONBLOCK = constants.O_NONBLOCK || 0;

/** One whitespace rule for both sides of every comparison. */
const normalise = (s) => String(s).replace(/\s+/g, ' ').trim();
/** The path as git and the `changed` set spell it: forward slashes, no leading `./`. */
const normalisePath = (p) => p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');

/**
 * Every pointer line of a report or a map, in the order they appear.
 *
 * @param {string} text
 * @returns {Array<{line:number, path:string, lineNo:number, fragment:string}>}
 *   `line` is the 1-based line of the CHECKED file, so the reader can find the
 *   claim again; `lineNo` is the line it points AT.
 * @throws {Error} past MAX_POINTERS — the caller turns that into a usage error.
 */
export function parsePointers(text) {
  const found = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = POINTER.exec(lines[i]);
    if (!m) continue; // prose
    if (found.length === MAX_POINTERS) {
      throw new Error(`more than ${MAX_POINTERS} pointer lines — ${MAX_POINTERS} is the most a checked file may carry`);
    }
    found.push({ line: i + 1, path: m[2], lineNo: Number(m[3]), fragment: m[4] });
  }
  return found;
}

/**
 * The commit a map was taken at: a `commit: <7–40 hex>` line in the first 20
 * lines. Anything else — a ref name, a flag, a shell fragment — is null, and
 * null means staleness is simply off, not "unchecked".
 *
 * @param {string} text
 * @returns {string|null}
 */
export function parseCommit(text) {
  for (const line of String(text).split('\n').slice(0, COMMIT_SCAN_LINES)) {
    const m = COMMIT.exec(line);
    if (!m) continue;
    return HASH.test(m[1]) ? m[1] : null; // the first `commit:` line decides
  }
  return null;
}

/**
 * The files a commit range touched, for the `stale` verdict.
 *
 * @param {{hash:string, root:string}} o
 * @returns {{changed:Set<string>}|{reason:string}} a short reason the caller
 *   prints as `staleness: not checked (<reason>)` — never an exception.
 */
export function changedSince({ hash, root }) {
  if (!HASH.test(String(hash || ''))) return { reason: 'invalid commit' }; // defence in depth: the parser already refused it
  try {
    const stdout = execFileSync('git', ['diff', '--name-only', `${hash}..HEAD`, '--'], {
      cwd: root, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    });
    const changed = new Set(stdout.split('\n').map((l) => normalisePath(l.trim())).filter(Boolean));
    return { changed };
  } catch (e) {
    return { reason: gitReason(e, hash) };
  }
}

/** Why git could not answer, in the fewest words that still say what to do. */
function gitReason(e, hash) {
  if (e && e.code === 'ENOENT') return 'git not found';
  if (e && (e.killed || e.signal === 'SIGTERM')) return 'git timed out';
  const stderr = String((e && e.stderr) || '');
  if (/not a git repository/i.test(stderr)) return 'not a git repository';
  if (/unknown revision|bad revision|ambiguous argument/i.test(stderr)) return `unknown commit ${hash}`;
  return 'git failed';
}

/**
 * The verdict on every pointer of a checked file.
 *
 * @param {{text:string, root:string, changed:Set<string>|null}} o
 *   `changed` is null when staleness was not checked at all — `stale` then
 *   never happens, which is not the same as "nothing changed".
 * @returns {{pointers:Array<object>, counts:object}} each pointer with its
 *   `status` (and `foundAt` for `moved`), plus the tally the summary prints.
 */
export function checkPointers({ text, root, changed = null }) {
  const realRoot = realpathSync(root);
  const cache = new Map(); // resolved path → lines, so a target is read once a run
  const pointers = parsePointers(text).map((p) => {
    const status = verdict(p, realRoot, cache);
    if (status.status === 'ok' && changed && changed.has(normalisePath(p.path))) return { ...p, status: 'stale' };
    return { ...p, ...status };
  });
  const counts = { total: pointers.length, ok: 0, moved: 0, mismatch: 0, missing: 0, outside: 0, stale: 0, 'too-large': 0 };
  for (const p of pointers) counts[p.status]++;
  return { pointers, counts };
}

/** One pointer against the file it names. `{status, foundAt?}`. */
function verdict(p, realRoot, cache) {
  const rel = normalisePath(p.path);
  if (isAbsolute(p.path) || isAbsolute(rel)) return { status: 'outside' };
  const target = resolve(realRoot, rel);
  if (target !== realRoot && !target.startsWith(realRoot + sep)) return { status: 'outside' };

  const lines = readLines(target, realRoot, cache);
  if (typeof lines === 'string') return { status: lines }; // missing / outside / too-large

  const fragment = normalise(p.fragment);
  if (!fragment) return { status: 'mismatch' }; // a fragment of nothing proves nothing
  const at = lines[p.lineNo - 1];
  if (at !== undefined && normalise(at).includes(fragment)) return { status: 'ok' };
  // Not there: the nearest line that does carry it, ties to the lower line.
  let foundAt = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!normalise(lines[i]).includes(fragment)) continue;
    if (!foundAt || Math.abs(i + 1 - p.lineNo) < Math.abs(foundAt - p.lineNo)) foundAt = i + 1;
  }
  return foundAt ? { status: 'moved', foundAt } : { status: 'mismatch' };
}

/**
 * The target's lines, or the status that says why there are none.
 *
 * THE DIRECTORY IS REALPATH'D, not just the target: a symlinked parent
 * component is the escape a check on the final path alone would miss. The
 * target itself is lstat'd, so a symlink is seen as a symlink and never
 * followed.
 */
function readLines(target, realRoot, cache) {
  let dir;
  try {
    dir = realpathSync(dirname(target));
  } catch (e) {
    return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'missing' : 'outside';
  }
  if (dir !== realRoot && !dir.startsWith(realRoot + sep)) return 'outside';
  const path = join(dir, basename(target));
  if (cache.has(path)) return cache.get(path);

  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'missing' : 'outside';
  }
  if (!st.isFile()) return 'outside'; // a symlink, a directory, a device: not evidence
  if (st.size > MAX_TARGET_BYTES) return 'too-large';

  const text = readBounded(path, MAX_TARGET_BYTES);
  if (text === null) return 'outside'; // it is there and we may not read it
  const lines = text.split('\n');
  cache.set(path, lines);
  return lines;
}

/**
 * A bounded, non-blocking read of a regular file — the pattern core/rules.mjs
 * uses for a rules file: lstat, O_NONBLOCK so the open cannot wait on a FIFO
 * that appeared between the two syscalls, fstat on the descriptor actually
 * opened. Never throws; null means "not a file we could read".
 */
function readBounded(path, maxBytes) {
  let fd = null;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const length = Math.max(0, Math.min(maxBytes, st.size));
    if (!length) return '';
    const buf = Buffer.alloc(length);
    return buf.subarray(0, readSync(fd, buf, 0, length, 0)).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}
