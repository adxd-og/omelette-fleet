/**
 * omelette-fleet :: mods/omelette-fleet/hooks/text.mjs
 * The pane's strings (1.7.0): a cut to a width, durations and clock times,
 * short roles and model ids, and the few words that say what a tool call is
 * doing. Pure, no imports but its neighbours.
 */
import { unitOfTool } from './model.mjs';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A word that starts `NAME=`: a leading shell assignment, whose value is often a secret. */
const NAME_EQ = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** The programs whose second word says what they do (`npm test`, `git status`); any other shows alone. */
const SUBCOMMAND_PROGRAMS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'git', 'gh', 'node', 'cargo', 'go', 'make', 'docker', 'python', 'python3', 'pytest', 'claude', 'omelette-fleet']);
/** A second word plain enough to show: no flag, no `=`, no path, no quote. */
const PLAIN_WORD = /^[a-z][a-z0-9:._-]*$/i;
/** A program name plain enough to show: no `=`, `$`, quote or other shell syntax. */
const PLAIN_PROGRAM = /^[A-Za-z0-9._+-]+$/;
/** The package's agent prefix, which every shipped role carries. */
const ROLE_PREFIX = 'omelette-';

/** The tools whose subject is a file, and the input field naming it. */
const FILE_FIELD = Object.freeze({ Edit: 'file_path', Write: 'file_path', Read: 'file_path', NotebookEdit: 'notebook_path' });

const two = (n) => String(n).padStart(2, '0');

/**
 * The code points a terminal draws two cells wide: every East Asian Width W
 * (Wide) and F (Fullwidth) code point of Unicode 16.0.0, emoji included, as
 * sorted [low, high] ranges. Generated, not written by hand: Python 3.14's
 * `unicodedata.east_asian_width` over 0..0x10FFFF, kept where it reads 'W' or
 * 'F' (unassigned code points in the CJK blocks and planes 2 and 3 read 'W',
 * as UAX #11 defaults them), adjacent code points merged — 122 ranges.
 */
const WIDE = Object.freeze([
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2630, 0x2637], [0x2648, 0x2653], [0x267f, 0x267f], [0x268a, 0x268f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55], [0x2e80, 0x2e99], [0x2e9b, 0x2ef3], [0x2f00, 0x2fd5], [0x2ff0, 0x303e], [0x3041, 0x3096],
  [0x3099, 0x30ff], [0x3105, 0x312f], [0x3131, 0x318e], [0x3190, 0x31e5], [0x31ef, 0x321e], [0x3220, 0x3247],
  [0x3250, 0xa48c], [0xa490, 0xa4c6], [0xa960, 0xa97c], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe52], [0xfe54, 0xfe66], [0xfe68, 0xfe6b], [0xff01, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff1], [0x17000, 0x187f7], [0x18800, 0x18cd5], [0x18cff, 0x18d08], [0x1aff0, 0x1aff3], [0x1aff5, 0x1affb],
  [0x1affd, 0x1affe], [0x1b000, 0x1b122], [0x1b132, 0x1b132], [0x1b150, 0x1b152], [0x1b155, 0x1b155], [0x1b164, 0x1b167],
  [0x1b170, 0x1b2fb], [0x1d300, 0x1d356], [0x1d360, 0x1d376], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251], [0x1f260, 0x1f265],
  [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c], [0x1fa80, 0x1fa89], [0x1fa8f, 0x1fac6], [0x1face, 0x1fadc], [0x1fadf, 0x1fae9], [0x1faf0, 0x1faf8],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]);

/** The characters a terminal acts on instead of drawing: C0 controls, DEL, C1 controls, and the bidi controls. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * `text` without the characters a terminal would act on — C0 and C1 controls,
 * DEL, and the bidi controls (U+061C, U+200E, U+200F, U+202A–202E,
 * U+2066–2069) — since roles, model ids and file names come from outside. One
 * pass, linear in the length; anything not a string is ''.
 * @param {unknown} text
 * @returns {string}
 */
export function clean(text) {
  return typeof text === 'string' ? text.replace(UNSAFE, '') : '';
}

/** Whether a code point is in WIDE: a binary search over its sorted ranges. */
function isWide(point) {
  let low = 0;
  let high = WIDE.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [first, last] = WIDE[mid];
    if (point < first) high = mid - 1;
    else if (point > last) low = mid + 1;
    else return true;
  }
  return false;
}

/** Variation selector 16: asks for the emoji presentation of the code point before it. */
const VS16 = 0xfe0f;

/** The cells one code point takes on its own: 0 for a combining mark, ZWJ or VS16, 2 for a wide one, else 1. */
function cellsOf(point) {
  if ((point >= 0x300 && point <= 0x36f) || point === 0x200d || point === VS16) return 0;
  return isWide(point) ? 2 : 1;
}

/**
 * The terminal cells `text` takes. A VS16 right after a one-cell code point
 * turns that pair into an emoji two cells wide (one more cell); after a wide
 * code point, or alone, it adds nothing.
 * @param {string} text
 * @returns {number}
 */
export function cells(text) {
  let width = 0;
  let before = 0;
  for (const ch of String(text ?? '')) {
    const point = ch.codePointAt(0);
    const w = point === VS16 ? (before === 1 ? 1 : 0) : cellsOf(point);
    width += w;
    before = point === VS16 ? 0 : w;
  }
  return width;
}

/** The code points `cut` keeps per cell: a run of zero-width marks takes no cell, so the cells alone would not bound it. */
const POINTS_PER_CELL = 4;

/**
 * `text` in at most `width` terminal cells and `4 × width + 1` code points:
 * longer text (more cells, or more code points) keeps what fits in
 * `width - 1` cells and `4 × width` code points, whole code points only, a
 * base and the VS16 after it kept or dropped together, and ends in '…'; no
 * width, no text. A long text is never spread whole: only its head is read.
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function cut(text, width) {
  const max = Math.floor(width);
  if (!(max > 0)) return '';
  const whole = String(text ?? '');
  const room = POINTS_PER_CELL * max;
  // One code point more than the text may keep tells a text past the bound; a code point is at most two UTF-16 units.
  const points = [...whole.slice(0, 2 * (room + 2))].slice(0, room + 2);
  if (points.length <= room + 1 && cells(whole) <= max) return whole;
  let kept = '';
  let used = 0;
  let count = 0;
  for (let i = 0; i < points.length; i++) {
    let unit = points[i];
    const point = unit.codePointAt(0);
    let w = cellsOf(point);
    let size = 1;
    if (point !== VS16 && points[i + 1]?.codePointAt(0) === VS16) {
      unit += points[i + 1];
      i += 1;
      size = 2;
      if (w === 1) w = 2;
    }
    if (used + w > max - 1 || count + size > room) break;
    kept += unit;
    used += w;
    count += size;
  }
  return `${kept}…`;
}

/**
 * A span as the pane writes it: `m:ss` below ten minutes (`0:42`, `3:10`),
 * whole minutes from ten (`12m`), whole hours from one (`2h`).
 * @param {number} ms
 * @returns {string}
 */
export function duration(ms) {
  const span = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (span >= HOUR) return `${Math.floor(span / HOUR)}h`;
  if (span >= 10 * MIN) return `${Math.floor(span / MIN)}m`;
  return `${Math.floor(span / MIN)}:${two(Math.floor((span % MIN) / SEC))}`;
}

/**
 * An agent type without a plugin namespace and the package's prefix:
 * 'omelette-fleet:omelette-coder-medium' → 'coder-medium', 'other:thing' → 'thing'.
 * @param {string} type
 * @returns {string}
 */
export function shortRole(type) {
  if (typeof type !== 'string') return type;
  const name = type.replace(/^[^:]+:(?=.)/, '');
  return name.startsWith(ROLE_PREFIX) && name.length > ROLE_PREFIX.length ? name.slice(ROLE_PREFIX.length) : name;
}

/**
 * A Claude model id without its prefix: 'claude-opus-5-5' → 'opus-5-5'.
 * @param {string} id
 * @returns {string}
 */
export function shortModel(id) {
  return typeof id === 'string' && id.startsWith('claude-') && id.length > 'claude-'.length ? id.slice('claude-'.length) : id;
}

/**
 * A Claude model's family: 'claude-opus-5-5' → 'opus'; a non-Claude id unchanged.
 * @param {string} id
 * @returns {string}
 */
export function familyOf(id) {
  const short = shortModel(id);
  return short === id ? id : short.split('-')[0];
}

/**
 * What a tool call is doing, in a few words: `Bash: npm test`,
 * `Edit adapter.mjs`, a unit tool's part (`code_review`), else the tool's name.
 * @param {string} tool
 * @param {Record<string, unknown> | undefined} input
 * @returns {string}
 */
export function subjectOf(tool, input) {
  // A subject lives in the pane's state (up to 20 per loop): a file name of any length is kept to 128 code points.
  const subject = subjectWhole(tool, input);
  const points = [...subject.slice(0, 2 * SUBJECT_POINTS)];
  return points.length > SUBJECT_POINTS ? points.slice(0, SUBJECT_POINTS).join('') : points.join('');
}

const SUBJECT_POINTS = 128;

function subjectWhole(tool, input) {
  const args = input && typeof input === 'object' ? input : {};
  if (tool === 'Bash') return typeof args.command === 'string' ? bashSubject(args.command) : 'Bash';
  if (Object.hasOwn(FILE_FIELD, tool)) {
    const path = args[FILE_FIELD[tool]];
    const base = typeof path === 'string' ? path.split(/[\\/]/).pop() : '';
    if (base) return `${tool} ${base}`;
  }
  return unitOfTool(tool)?.tool ?? tool;
}

/**
 * The words of the simple command starting at `from`, in one left-to-right
 * scan: whitespace separates, quotes group, a backslash escapes the next
 * character. The scan stops at the first unquoted `|`, `&&`, `||`, `;`,
 * newline, `(`, `)`, backtick or `$(` (`stop` names it, `end` is just past it),
 * and at a backtick or `$(` inside double quotes (the word it is in is dropped).
 * Null when a quote never closes.
 * @param {string} command
 * @param {number} from
 * @returns {{ words: string[], stop: string, end: number } | null}
 */
function simpleCommand(command, from) {
  const words = [];
  let word = '';
  let inWord = false;
  let quote = '';
  let i = from;
  const finish = (stop, end, keepWord = true) => {
    if (inWord && keepWord) words.push(word);
    return { words, stop, end };
  };
  while (i < command.length) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = '';
      else word += ch;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = '';
      else if (ch === '`' || (ch === '$' && command[i + 1] === '(')) return finish('substitution', i, false);
      else if (ch === '\\' && i + 1 < command.length) { word += command[i + 1]; i += 1; }
      else word += ch;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inWord = true; i += 1; continue; }
    if (ch === '\\') {
      if (i + 1 < command.length) word += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '$(') return finish(two, i + 2);
    if (ch === '|' || ch === ';' || ch === '\n' || ch === '(' || ch === ')' || ch === '`') return finish(ch, i + 1);
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      i += 1;
      continue;
    }
    word += ch;
    inWord = true;
    i += 1;
  }
  if (quote) return null;
  return finish('', i);
}

/** `words` without its leading `NAME=value` words. */
const withoutAssignments = (words) => {
  let i = 0;
  while (i < words.length && NAME_EQ.test(words[i])) i += 1;
  return words.slice(i);
};

/**
 * What a shell command runs, as the pane shows it: `Bash: <program>`, plus a
 * second word only for a program in SUBCOMMAND_PROGRAMS and a plain word.
 * Leading assignments are skipped, and one leading `cd …` with them when an
 * `&&` or `;` follows it; nothing to show, or an open quote, is plain `Bash`.
 */
function bashSubject(command) {
  let scanned = simpleCommand(command, 0);
  if (!scanned) return 'Bash';
  let words = withoutAssignments(scanned.words);
  if (words[0] === 'cd') {
    if (scanned.stop !== '&&' && scanned.stop !== ';') return 'Bash: cd';
    scanned = simpleCommand(command, scanned.end);
    if (!scanned) return 'Bash';
    words = withoutAssignments(scanned.words);
  }
  if (words.length === 0) return 'Bash';
  const program = words[0].split('/').pop();
  if (!PLAIN_PROGRAM.test(program)) return 'Bash';
  const next = words[1];
  const showsNext = SUBCOMMAND_PROGRAMS.has(program) && typeof next === 'string' && PLAIN_WORD.test(next);
  return showsNext ? `Bash: ${program} ${next}` : `Bash: ${program}`;
}

/**
 * `HH:MM:SS` of `at` in the zone whose `Date.prototype.getTimezoneOffset` is
 * `tzOffsetMinutes` (minutes behind UTC: UTC+3 reports -180).
 * @param {number} at
 * @param {number} tzOffsetMinutes
 * @returns {string}
 */
export function clock(at, tzOffsetMinutes) {
  const local = at - (tzOffsetMinutes || 0) * MIN;
  const ofDay = ((local % DAY) + DAY) % DAY;
  return `${two(Math.floor(ofDay / HOUR))}:${two(Math.floor((ofDay % HOUR) / MIN))}:${two(Math.floor((ofDay % MIN) / SEC))}`;
}
