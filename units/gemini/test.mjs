/**
 * omelette-fleet :: units/gemini/test.mjs
 * gemini_test's answer: the unit's own header and round lines, each round's
 * test output as the unit measured it (its last 40 lines, fenced), Neon's last
 * message made unable to pass for the unit's lines, the files Neon changed
 * outside the test directories, and the diff under the unit's own heading.
 *
 * Zero deps.
 */
import { appendDiff, longestRun, neutraliseModelText } from '../../core/clone.mjs';
import { INVISIBLE_CHARS } from '../../core/log.mjs';
import { safeOutput } from './test-run.mjs';

/** The unit's heading the diff goes under. */
export const TEST_HEADING = '## proposed tests (not applied)';
/** That heading's name as a model may write it (demoteHeadings). */
export const TEST_HEADING_NAME = String.raw`proposed[ \t]+tests[ \t]*\([ \t]*not[ \t]+applied[ \t]*\)`;
/** The lines only the unit writes: marked model-written when Neon's message holds one. */
export const TEST_ADAPTER_LINES = String.raw`^[ \t]*(_\((gemini_test:|changed outside the test directories|no file outside the test directories|ignore or attributes files changed in the copy|the copy is unchanged|run kept:|diff unavailable:|Neon's last message is from round|Neon left no message|no output)|round \d+ · |\[gemini: )`;

/** The most names the outside list and the notice's list print. */
const LIST_MAX = 50;
/** The most characters (code points) of a name either list prints; a longer one is cut there and ends in an ellipsis (U+2026). */
const NAME_MAX = 200;
const INVISIBLE_ALL = new RegExp(INVISIBLE_CHARS.source, 'gu');

/**
 * A changed name as the answer prints it: as it is, or JSON-quoted when
 * safeOutput would change it, or it holds a control (C0, DEL, C1), a bidi or
 * zero-width character, U+2028/U+2029 (INVISIBLE_CHARS) or a comma — each such
 * character written as a `\uXXXX` escape (per UTF-16 unit), never raw.
 */
function quoteName(p) {
  const s = String(p);
  if (safeOutput(s) === s && !INVISIBLE_CHARS.test(s) && !s.includes(',')) return s;
  const hex = (c) => [...Array(c.length).keys()].map((i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join('');
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`).replace(INVISIBLE_ALL, hex)}"`;
}

/**
 * Names as one of the answer's lists prints them, joined by `, `: at most
 * LIST_MAX, then ` <ellipsis> and <n> more`; a name longer than NAME_MAX code
 * points cut to its first NAME_MAX followed by an ellipsis (U+2026), then
 * quoted (quoteName).
 */
function nameList(names) {
  const cut = (p) => { const cps = [...String(p)]; return cps.length > NAME_MAX ? `${cps.slice(0, NAME_MAX).join('')}\u{2026}` : String(p); };
  const more = names.length > LIST_MAX ? ` \u{2026} and ${names.length - LIST_MAX} more` : '';
  return `${names.slice(0, LIST_MAX).map((p) => quoteName(cut(p))).join(', ')}${more}`;
}

/** A caller's string made safe to print in one of the unit's lines: safeOutput, cut at its first newline. */
const oneSafeLine = (s) => safeOutput(String(s)).split('\n')[0];

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs']);
const TEST_FILE = [/^test_.*\.py$/, /_test\.(py|go)$/, /\.(test|spec)\.[cm]?[jt]sx?$/, /^conftest\.py$/];

/**
 * A path in the test directories: a directory component `test`, `tests`,
 * `__tests__`, `spec` or `specs`, or a test file by its base name.
 */
export function isTestPath(p) {
  const parts = String(p).split('/');
  const name = parts.pop();
  return parts.some((d) => TEST_DIRS.has(d)) || TEST_FILE.some((re) => re.test(name));
}

/** `text` in a fence of backticks one longer than its longest run (at least 3); one trailing newline dropped. */
export function fenced(text) {
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return `${fence}\n${text.replace(/\n$/, '')}\n${fence}`;
}

const secs = (ms) => (ms / 1000).toFixed(1);

/**
 * One round's line: agy's end and time, the test command's end and time (none
 * when `testMs` is null); each end made safe and cut at its first newline.
 */
export function roundLine({ k, agyEnd, agyMs, testEnd, testMs }) {
  const end = oneSafeLine(testEnd);
  const test = testMs === null || testMs === undefined ? end : `${end} (${secs(testMs)} s)`;
  return `round ${k} · agy: ${oneSafeLine(agyEnd)} (${secs(agyMs)} s) · test command: ${test}`;
}

/** The last 40 lines of a test output, made safe to show. */
function last40(tail) {
  const lines = safeOutput(tail).replace(/\n$/, '').split('\n');
  return lines.slice(-40).join('\n');
}

/**
 * gemini_test's answer, blocks joined by a blank line: the header; per round
 * its roundLine with, on the next line, its last 40 lines fenced or
 * `_(no output)_` (a round's `tail` is null when its log was empty or the test
 * command did not run); Neon's last message neutralised (headed by the round
 * it is from when that is not the last round), or `_(Neon left no message)_`
 * — the message goes through safeOutput before it is neutralised; the files of
 * `changed` outside the test directories (isTestPath), or the line saying there
 * are none; when `guards` (testGuards' names) holds any, the line naming them
 * (a model-written ignore or attributes file can hide files from the diff or
 * blank their content); both lists through nameList: at most 50 names, then
 * ` <ellipsis> and <n> more`, a name past 200 characters cut, an odd one quoted; the
 * diff under TEST_HEADING, or `_(the copy is unchanged)_`;
 * `_(run kept: <keptRun>)_` when a run dir is kept. `model`, `ended`, `keptRun`
 * and each round's ends are made safe and cut at their first newline (a caller
 * may pass an error message); `rounds`, `changed` and `guards` that are not
 * arrays are refused.
 * @param {{model: string, argv: string[], rounds: {k: number, agyEnd: string, agyMs: number, testEnd: string, testMs: number|null, tail: string|null}[], maxRounds: number, ended: string, totalMs: number, lastMessage: string, lastFrom: number, diff: string, changed: string[], guards?: string[], keptRun?: string|null}} o
 * @returns {string}
 */
export function assembleAnswer({ model, argv, rounds, maxRounds, ended, totalMs, lastMessage, lastFrom, diff, changed, guards = [], keptRun }) {
  if (!Array.isArray(rounds) || !Array.isArray(changed)) throw new Error('gemini: assembleAnswer needs rounds and changed as arrays');
  if (!Array.isArray(guards)) throw new Error('gemini: assembleAnswer needs guards as an array');
  const blocks = [`_(gemini_test: ${oneSafeLine(model)} · ${rounds.length} of at most ${maxRounds} rounds · ended: ${oneSafeLine(ended)} · ${secs(totalMs)} s · test command ${JSON.stringify(argv)})_`];
  for (const r of rounds) blocks.push(`${roundLine(r)}\n${r.tail === null || r.tail === undefined ? '_(no output)_' : fenced(last40(r.tail))}`);
  const message = safeOutput(String(lastMessage ?? ''));
  if (message.trim() === '') blocks.push('_(Neon left no message)_');
  else {
    const last = rounds.length ? rounds[rounds.length - 1].k : 0;
    if (lastFrom !== last) blocks.push(`_(Neon's last message is from round ${lastFrom})_`);
    blocks.push(neutraliseModelText(message, { headingName: TEST_HEADING_NAME, adapterLines: TEST_ADAPTER_LINES }));
  }
  const outside = changed.filter((p) => !isTestPath(p));
  blocks.push(outside.length ? `_(changed outside the test directories: ${nameList(outside)})_` : '_(no file outside the test directories changed)_');
  if (guards.length) blocks.push(`_(ignore or attributes files changed in the copy: ${nameList(guards)} \u{2014} files they cover may be missing from this diff, or shown without their content)_`);
  blocks.push(appendDiff('', diff, { heading: TEST_HEADING, headingName: TEST_HEADING_NAME, unchanged: '_(the copy is unchanged)_' }).replace(/^\n+/, ''));
  if (keptRun) blocks.push(`_(run kept: ${oneSafeLine(keptRun)})_`);
  return blocks.join('\n\n');
}
