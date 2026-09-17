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
 * ONE GRAMMAR (spec 2026-09-17 §1), three required fields:
 *   - `core/unit.mjs:435` · `const finish = (text, isError` · the claim
 * The bullet is optional (`-`, `*`, `+`, `1.`, `1)`), the backticks around
 * `path:line` are optional (both or neither), the separator is ` · ` (U+00B7),
 * the fragment is in single backticks — so it can hold no backtick — and the
 * claim is free text this file NEVER checks, but does require.
 *
 * A NEAR-MISS IS NOT PROSE. A line that opens like a pointer and does not
 * parse is `malformed` and is reported, because evidence that silently fails
 * to count is the failure this release exists to prevent. A fragment too short
 * or too featureless to prove anything (under 8 normalised characters, or
 * without an alphanumeric run of 3) is `weak` and is not looked up at all.
 *
 * PURE APART FROM READING THE TARGETS. `checkPointers` takes the text, the
 * root and the set of changed paths, opens files under the root, and returns a
 * verdict per pointer. It writes nothing, anywhere, ever.
 *
 * WHAT A PATH MAY REACH. Everything resolves against the REAL path of the root
 * and is refused when it leaves it — containment is `path.relative`, so a root
 * of `/` works — including through a symlinked parent directory, which is why
 * the target's directory is realpath'd and not just the target. A symlink, a
 * directory, a device: `outside`; the open carries O_NOFOLLOW, so a symlink
 * swapped in after the lstat is refused by the kernel rather than followed.
 * Over 2 MiB: `too-large`, unread.
 *
 * ONE REPRESENTATION PER TARGET. A file is held once, as its whitespace-
 * normalised lines joined by `\n` plus a Uint32Array of line starts: `ok` is
 * then a slice, and `moved` is one indexOf forward and one lastIndexOf
 * backward from the pointed line, not a scan per pointer. The cache is charged
 * what it really holds against a 32 MiB budget; past it a target is read and
 * judged all the same, it is simply not kept.
 *
 * NOTHING BUT A HASH REACHES GIT, AND THE CHILD IS BOXED. `changedSince`
 * validates the `commit:` value as hex, spawns git through execFile with no
 * shell, and builds the child's environment instead of inheriting it, so
 * GIT_DIR, GIT_WORK_TREE, GIT_TRACE* and GIT_EXTERNAL_DIFF from this process
 * never arrive.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { devNull } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** At most this many pointer lines per checked file; more is a usage error. */
export const MAX_POINTERS = 2000;
/** A target over this is reported, not read. */
export const MAX_TARGET_BYTES = 2 * 1024 * 1024;
/**
 * How much of what was read a run may keep. 2000 pointers at 2 MiB each is
 * gigabytes if the cache is unbounded, so it is not: past this budget a target
 * is read and judged like any other and simply not kept.
 */
export const MAX_CACHE_BYTES = 32 * 1024 * 1024;
/** How far into a checked file a `commit:` line still counts. */
const COMMIT_SCAN_LINES = 20;
/** The floor a fragment must clear to be evidence at all (§1). */
const FRAGMENT_MIN = 8;
const FRAGMENT_RUN = /[\p{L}\p{N}]{3}/u;

/** A git object name we are willing to hand to git, and nothing else. */
const HASH = /^[0-9a-f]{7,40}$/i;
/**
 * The pointer line, all three fields. `\1` is the backtick or nothing, so one
 * lone backtick never opens a pointer; the path holds no whitespace, backtick
 * or colon; the line number is digits (leading zeros tolerated, zero itself
 * rejected below); the fragment holds no backtick; the claim must be there.
 */
const POINTER = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(`?)([^\s`:]+):(\d+)\1 · `([^`]+)` · (.*)$/;
/**
 * What it takes to *open* like a pointer: a bullet, a backtick, something with
 * no space in it, a colon, digits — and a separator somewhere after. Its path
 * part deliberately allows colons and its line part deliberately allows zero,
 * so `C:/x.js:3` and `a.txt:0` land here rather than passing as prose.
 */
const OPENER = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?`?[^\s`]+:\d+/;
/** `commit: <value>` — the whole value, so a trailing note is seen and refused. */
const COMMIT = /^[ \t]*commit:[ \t]*(.*)$/i;

/**
 * HOW A TARGET IS OPENED, exported so a test can see the flags rather than
 * trust a comment. O_NONBLOCK so the open cannot wait on a FIFO that appeared
 * between the lstat and the open; O_NOFOLLOW so a symlink swapped in over the
 * same race is refused by the kernel (ELOOP) instead of followed — the lstat
 * decides what the path WAS, these flags decide what we may actually open.
 * Each folds to 0 where the platform does not define it.
 */
export const TARGET_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0);

/** One whitespace rule for both sides of every comparison. */
const normalise = (s) => String(s).replace(/\s+/g, ' ').trim();
/** The path as git and the `changed` set spell it: forward slashes, no leading `./`. */
const normalisePath = (p) => p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
/** Is this location the root or under it? `path.relative`, so a root of `/` works. */
const inside = (realRoot, path) => {
  const rel = relative(realRoot, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const isAbsent = (e) => Boolean(e) && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

/**
 * Every pointer line of a report or a map, in the order they appear — the ones
 * that parse and the ones that only look like they should.
 *
 * @param {string} text
 * @returns {Array<{line:number, path?:string, lineNo?:number, fragment?:string, malformed?:true, raw?:string}>}
 *   `line` is the 1-based line of the CHECKED file, so the reader can find the
 *   claim again; `lineNo` is the line it points AT.
 * @throws {Error} past MAX_POINTERS — the caller turns that into a usage error.
 */
export function parsePointers(text) {
  const found = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    // A CRLF file's `\r` is a line terminator to a regex: strip it here, once,
    // rather than let it fail the claim and make every pointer malformed.
    const entry = parseLine(lines[i].replace(/\r$/, ''), i + 1);
    if (!entry) continue; // prose
    if (found.length === MAX_POINTERS) {
      throw new Error(`more than ${MAX_POINTERS} pointer lines — ${MAX_POINTERS} is the most a checked file may carry`);
    }
    found.push(entry);
  }
  return found;
}

/** One line: a pointer, a malformed near-miss, or null for prose. */
function parseLine(line, at) {
  const m = POINTER.exec(line);
  if (m) {
    const lineNo = Number(m[3]);
    // Line 0 is no line, a claim of whitespace is no claim, and a fragment of
    // whitespace is no fragment: each of the three fields has to be there.
    if (lineNo >= 1 && /\S/.test(m[5]) && normalise(m[4]) !== '') {
      return { line: at, path: m[2], lineNo, fragment: m[4] };
    }
  }
  const opener = OPENER.exec(line);
  if (opener && line.slice(opener[0].length).includes(' · ')) return { line: at, malformed: true, raw: line };
  return null;
}

/**
 * The commit a map was taken at: the first `commit:` line of the first 20.
 *
 * THREE ANSWERS, not two. `undefined` — no such line, staleness is off and
 * nothing is said about it. `null` — there is a line and its value is not a
 * 7–40 hex hash (a ref, a tag, a hash with a note, a flag): nothing reaches
 * git and the run says the value was unusable. Otherwise the hash itself.
 *
 * @param {string} text
 * @returns {string|null|undefined}
 */
export function parseCommit(text) {
  for (const line of String(text).split('\n').slice(0, COMMIT_SCAN_LINES)) {
    const m = COMMIT.exec(line);
    if (!m) continue;
    const value = m[1].trim().replace(/^`(.*)`$/, '$1'); // the backticks a markdown map puts round it
    return HASH.test(value) ? value : null; // the first `commit:` line decides
  }
  return undefined;
}

/**
 * The environment the git child gets — BUILT, never inherited, so nothing this
 * process was started with can redirect the child at another repository, hand
 * it another config, or make it run a program of someone else's choosing.
 *
 * @param {object} parentEnv
 * @returns {object} PATH, HOME and the locale when the parent had them, plus
 *   the five settings that switch off lazy fetches, locks, prompts and every
 *   config file outside the repository itself.
 */
export function gitChildEnv(parentEnv = process.env) {
  const env = {
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
  };
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL']) {
    if (parentEnv && parentEnv[key] !== undefined) env[key] = parentEnv[key];
  }
  return env;
}

/**
 * The files that changed between a commit and the WORKING TREE — uncommitted
 * edits included, because a map is stale the moment the file it quotes is
 * edited, not the moment the edit is committed.
 *
 * @param {{hash:string, root:string}} o
 * @returns {{changed:Set<string>}|{reason:string}} a short reason the caller
 *   prints as `staleness: not checked (<reason>)` — never an exception.
 */
export function changedSince({ hash, root }) {
  if (!HASH.test(String(hash || ''))) return { reason: 'invalid commit' }; // defence in depth: the parser already refused it
  try {
    const stdout = execFileSync('git', [
      '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${devNull}`,
      'diff', '--no-ext-diff', '--no-textconv', `-O${devNull}`, '--name-only', '--relative', hash, '--',
    ], {
      cwd: root,
      env: gitChildEnv(process.env),
      timeout: 5000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
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
  if (e && (e.killed || e.signal === 'SIGKILL' || e.signal === 'SIGTERM')) return 'git timed out';
  const stderr = String((e && e.stderr) || '');
  if (/not a git repository/i.test(stderr)) return 'not a git repository';
  if (/unknown revision|bad revision|ambiguous argument/i.test(stderr)) return `unknown commit ${hash}`;
  return 'git failed';
}

/**
 * The verdict on every pointer of a checked file.
 *
 * @param {{text:string, root:string, changed:Set<string>|null, cacheBytes:number}} o
 *   `changed` is null when staleness was not checked at all — `stale` then
 *   never happens, which is not the same as "nothing changed". `cacheBytes` is
 *   the read cache's budget, there so a test can starve it: the verdicts are
 *   the same at any budget.
 * @returns {{pointers:Array<object>, counts:object}} each pointer with its
 *   `status` (and `foundAt` for `moved`), plus the tally the summary prints —
 *   including `distinct`, the number of different `path:line` pairs, which is
 *   what `--require` is about.
 */
export function checkPointers({ text, root, changed = null, cacheBytes = MAX_CACHE_BYTES }) {
  const realRoot = realpathSync(root);
  const cache = { targets: new Map(), bytes: 0, budget: cacheBytes };
  const pairs = new Set();
  const pointers = parsePointers(text).map((p) => {
    if (p.malformed) return { ...p, status: 'malformed' };
    pairs.add(`${normalisePath(p.path)}:${p.lineNo}`);
    // `resolved` is the root-relative path of the file actually READ — the
    // spelling git uses, so `sub/../a.txt` and `./a.txt` are the same file to
    // the changed set, as they are on disk.
    const { resolved, ...answer } = verdict(p, realRoot, cache);
    const stale = answer.status === 'ok' && changed !== null && resolved !== undefined && changed.has(resolved);
    return { ...p, ...answer, status: stale ? 'stale' : answer.status };
  });
  const counts = {
    total: pointers.length, distinct: pairs.size,
    ok: 0, moved: 0, mismatch: 0, missing: 0, outside: 0, stale: 0, 'too-large': 0, weak: 0, malformed: 0,
  };
  for (const p of pointers) counts[p.status]++;
  return { pointers, counts };
}

/**
 * One pointer against the file it names: `{status, foundAt?, resolved?}`, where
 * `resolved` is that file's root-relative path and is there only when a file
 * was read — the caller needs it for the staleness lookup and resolving it
 * twice would be resolving it two ways.
 */
function verdict(p, realRoot, cache) {
  const fragment = normalise(p.fragment);
  // `weak` is decided first: a fragment that proves nothing is not worth a
  // syscall, and the answer must not depend on whether the file happens to be
  // there.
  if (fragment.length < FRAGMENT_MIN || !FRAGMENT_RUN.test(fragment)) return { status: 'weak' };

  const rel = normalisePath(p.path);
  if (isAbsolute(p.path) || isAbsolute(rel)) return { status: 'outside' };
  const target = resolve(realRoot, rel);
  if (!inside(realRoot, target)) return { status: 'outside' };

  const read = readTarget(target, realRoot, cache);
  if (read.status) return { status: read.status }; // missing / outside / too-large
  const { norm, starts } = read;
  const resolved = normalisePath(relative(realRoot, read.path));

  const count = starts.length;
  if (p.lineNo <= count) {
    const from = starts[p.lineNo - 1];
    const to = p.lineNo < count ? starts[p.lineNo] - 1 : norm.length;
    if (norm.slice(from, to).includes(fragment)) return { status: 'ok', resolved };
  }
  // Not on that line: one look back and one forward from it — a pointed line
  // past the end looks back from the end, which is the same rule. The earliest
  // occurrence ANYWHERE is asked for first because it settles two cases on one
  // forward scan: there is none (mismatch), or the first one already lies at or
  // after the pointed line, which makes it the nearest with nothing behind it.
  const at = p.lineNo <= count ? starts[p.lineNo - 1] : norm.length;
  const first = norm.indexOf(fragment);
  if (first < 0) return { status: 'mismatch', resolved };
  if (first >= at) return { status: 'moved', foundAt: lineAt(starts, first), resolved };
  const ahead = norm.indexOf(fragment, at);
  let foundAt = lineAt(starts, norm.lastIndexOf(fragment, at)); // `first` proves there is one
  if (ahead >= 0) {
    const line = lineAt(starts, ahead);
    // Ties go to the smaller line number, which is the one already held.
    if (Math.abs(line - p.lineNo) < Math.abs(foundAt - p.lineNo)) foundAt = line;
  }
  return { status: 'moved', foundAt, resolved };
}

/** The 1-based line an offset falls in: the last start at or before it. */
function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/**
 * The target as one representation — `{norm, starts, path}` — or `{status}`
 * saying why there is none.
 *
 * THE DIRECTORY IS REALPATH'D, not just the target: a symlinked parent
 * component is the escape a check on the final path alone would miss. The
 * target itself is lstat'd, so a symlink is seen as a symlink and never
 * followed, and `path` is where the bytes actually came from.
 */
function readTarget(target, realRoot, cache) {
  let dir;
  try {
    dir = realpathSync(dirname(target));
  } catch (e) {
    return { status: isAbsent(e) ? 'missing' : 'outside' };
  }
  if (!inside(realRoot, dir)) return { status: 'outside' };
  const path = join(dir, basename(target));
  const held = cache.targets.get(path);
  if (held) return { ...held, path };

  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    return { status: isAbsent(e) ? 'missing' : 'outside' };
  }
  if (!st.isFile()) return { status: 'outside' }; // a symlink, a directory, a device: not evidence
  if (st.size > MAX_TARGET_BYTES) return { status: 'too-large' };

  const text = readBoundedFile(path, MAX_TARGET_BYTES);
  if (text === null) return { status: 'outside' }; // it is there and we may not read it
  const view = represent(text);
  // Charged what it really holds — two bytes a character plus the index —
  // after the read, and past the budget simply not kept.
  const cost = 2 * view.norm.length + view.starts.byteLength;
  if (cache.bytes + cost <= cache.budget) {
    cache.targets.set(path, view);
    cache.bytes += cost;
  }
  return { ...view, path };
}

/**
 * A file as one string and one index: every line whitespace-normalised (which
 * is also what removes a CRLF's `\r`) and joined by `\n`, plus where each line
 * starts in it. Every comparison a pointer needs is then a slice or an
 * indexOf, and neither costs a pass over the lines.
 */
function represent(text) {
  const lines = text.split('\n');
  const starts = new Uint32Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    lines[i] = normalise(lines[i]);
    starts[i] = offset;
    offset += lines[i].length + 1; // the `\n` the join puts back
  }
  return { norm: lines.join('\n'), starts };
}

/**
 * A bounded read of a regular file — the pattern core/rules.mjs uses for a
 * rules file, and the one the CLI reads the checked file with too: lstat, an
 * open that can neither wait nor follow a link (TARGET_OPEN_FLAGS), fstat on
 * the descriptor actually opened. Never throws: an ELOOP from a swapped-in
 * symlink comes back as null like any other refusal.
 *
 * @returns {string|null} the first `maxBytes` bytes as UTF-8, or null for
 *   anything that is not a regular file we could read.
 */
export function readBoundedFile(path, maxBytes) {
  let fd = null;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, TARGET_OPEN_FLAGS);
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
