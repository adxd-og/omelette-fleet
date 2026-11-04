/**
 * omelette-fleet :: mods/omelette-fleet/hooks/handoff.mjs
 * The handoff in the mod (1.8.0): the marker the rendered guard leads its
 * SessionStart print with (an entry it leads is the settings hook's copy, and
 * the mod then adds none of its own), whether a ledger's last handoff is
 * fresh, and the open ledgers the compaction gate reads. Nothing here writes.
 *
 * `$` is always spelled `$.noun.method(...)` literally: the engine scans the
 * source and refuses a call it did not see.
 */

/** The guard's HANDOFF_MARKER, the same literal: a node test renders the guard and compares its first printed line. */
export const HANDOFF_MARKER = '--- omelette-fleet · read before continuing ---';

/** How far a heading's HH:MM may lie from now, either way, and still be fresh: 30 minutes before; ahead of now (a clock skew), the same bound. */
export const FRESH_MS = 30 * 60 * 1000;

/** THE HANDOFF HEADING, as the guard's print reads it (`^##[ \t]+handoff\b`, any case), a line at a time. */
const HANDOFF_HEADING = /^##[ \t]+handoff\b/i;

/** The heading's stamp: `## Handoff (2026-11-03 — title)` or `## Handoff (2026-11-03 14:05 — title)`. */
const STAMP = /^##[ \t]+handoff[ \t]*\([ \t]*(\d{4})-(\d{2})-(\d{2})(?:[ \t]+(\d{2}):(\d{2}))?(?![\d:])/i;

/** Where a ledger line ends: the guard's HANDOFF_LINE_BREAK. */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/**
 * Whether the last handoff heading anywhere in `text` is fresh at `now`: its
 * date is today's local date, and, when it carries HH:MM, that time lies
 * within FRESH_MS of `now` (before it, or ahead by a skew of at most as much).
 * No heading, or a last heading with no date, is stale. The mod reads a ledger
 * whole, under `$.fs.read`'s 4 MiB bound: a longer one is never read and is
 * stale (openLedgers hands it on with no text).
 * @param {string} text the ledger
 * @param {number} now milliseconds since the epoch
 * @returns {boolean}
 */
export function lastHandoffFresh(text, now) {
  const last = String(text ?? '').split(LINE_BREAK).findLast((line) => HANDOFF_HEADING.test(line));
  const stamp = last === undefined ? null : STAMP.exec(last);
  if (!stamp) return false;
  const [year, month, day] = [stamp[1], stamp[2], stamp[3]].map(Number);
  const today = new Date(now);
  if (year !== today.getFullYear() || month !== today.getMonth() + 1 || day !== today.getDate()) return false;
  if (stamp[4] === undefined) return true;
  const [hours, minutes] = [Number(stamp[4]), Number(stamp[5])];
  if (hours > 23 || minutes > 59) return false;
  return Math.abs(now - new Date(year, month - 1, day, hours, minutes).getTime()) <= FRESH_MS;
}

/** A ledger's file name, as core/ledger.mjs LEDGER_FILE reads it. */
const LEDGER_FILE = /^ledger-.+\.md$/;

/** The `branch:` header, as core/ledger.mjs parseLedgerHeader reads it: the first line of the first HEADER_LINES that starts with `branch:`. */
const HEADER_LINES = 20;
const HEADER = /^branch:[ \t]*(\S+)[ \t]*$/;

/** A branch name the gate hands git; any other name is a closed ledger, and nothing reaches git. */
const BRANCH = /^[\w./-]{1,128}$/;

/** core/ledger.mjs STANDING_BRANCHES: open, never asked of git. */
const STANDING = new Set(['main', 'master', 'trunk']);

/** `$.fs.read` rejects a file over 4 MiB. */
const READ_MAX = 4 * 1024 * 1024;

/** One git run's wall clock, the guard's GIT_TIMEOUT_MS. */
const GIT_TIMEOUT_MS = 2000;

/**
 * The branch a ledger's header names: `null` with no `branch:` line in its
 * first HEADER_LINES lines (headerless), else the name the line carries ('' for
 * a line that does not hold one name).
 * @param {string} text
 * @returns {string | null}
 */
function headerBranch(text) {
  const line = text.split(/\r?\n/).slice(0, HEADER_LINES).find((one) => one.startsWith('branch:'));
  if (line === undefined) return null;
  return HEADER.exec(line)?.[1] ?? '';
}

/**
 * Whether a ledger naming `branch` is open: headerless or standing, yes;
 * a name git could not be handed, no; else `git show-ref --verify --quiet
 * refs/heads/<branch>` exits 0 (one run, 2 s; a run that fails is not open).
 * @param {any} $ the engine interface
 * @param {string} cwd
 * @param {string | null} branch
 * @returns {Promise<boolean>}
 */
async function isOpen($, cwd, branch) {
  if (branch === null || STANDING.has(branch)) return true;
  if (!BRANCH.test(branch)) return false;
  try {
    const ran = await $.process.run(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd, timeoutMs: GIT_TIMEOUT_MS });
    return ran.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * The open ledgers under `<cwd>/.omelette`: regular files named `ledger-*.md`
 * (a link is not one), each read whole and kept while its header says open.
 * A ledger over READ_MAX cannot be read: its header unknown, it counts as open
 * and comes with no text, so it is stale. A ledger whose read fails is
 * skipped; a listing that fails is no ledger at all.
 * @param {any} $ the engine interface
 * @param {string} cwd the session's directory, absolute
 * @returns {Promise<{ name: string, mtimeMs: number, text: string }[]>}
 */
export async function openLedgers($, cwd) {
  const dir = `${String(cwd).replace(/\/+$/, '')}/.omelette`;
  let entries;
  try {
    entries = await $.fs.list(dir);
  } catch {
    return [];
  }
  const open = [];
  for (const entry of entries) {
    if (entry.kind !== 'file' || entry.isLink || !LEDGER_FILE.test(entry.name)) continue;
    if (entry.size > READ_MAX) {
      open.push({ name: entry.name, mtimeMs: entry.mtimeMs, text: '' });
      continue;
    }
    let text;
    try {
      text = String(await $.fs.read(`${dir}/${entry.name}`));
    } catch {
      continue;
    }
    if (await isOpen($, cwd, headerBranch(text))) open.push({ name: entry.name, mtimeMs: entry.mtimeMs, text });
  }
  return open;
}

/**
 * The open ledger modified last (openLedgers), or none.
 * @param {any} $ the engine interface
 * @param {string} cwd
 * @returns {Promise<{ name: string, mtimeMs: number, text: string } | undefined>}
 */
export async function newestOpenLedger($, cwd) {
  const open = await openLedgers($, cwd);
  return open.reduce((newest, one) => (newest === undefined || one.mtimeMs > newest.mtimeMs ? one : newest), undefined);
}
