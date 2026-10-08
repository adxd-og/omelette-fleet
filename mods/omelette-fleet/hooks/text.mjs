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

/** Code point ranges a terminal draws two cells wide: East Asian Wide/Fullwidth and emoji. */
const WIDE = Object.freeze([
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
]);

/** The cells one code point takes: 0 for a combining mark, ZWJ or VS16, 2 for a wide one, else 1. */
function cellsOf(point) {
  if ((point >= 0x300 && point <= 0x36f) || point === 0x200d || point === 0xfe0f) return 0;
  for (const [low, high] of WIDE) if (point >= low && point <= high) return 2;
  return 1;
}

/**
 * The terminal cells `text` takes.
 * @param {string} text
 * @returns {number}
 */
export function cells(text) {
  let width = 0;
  for (const ch of String(text ?? '')) width += cellsOf(ch.codePointAt(0));
  return width;
}

/**
 * `text` in at most `width` terminal cells: longer text keeps what fits in
 * `width - 1` of them, whole code points only, and ends in '…'; no width, no text.
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function cut(text, width) {
  const max = Math.floor(width);
  if (!(max > 0)) return '';
  const whole = String(text ?? '');
  if (cells(whole) <= max) return whole;
  let kept = '';
  let used = 0;
  for (const ch of whole) {
    const w = cellsOf(ch.codePointAt(0));
    if (used + w > max - 1) break;
    kept += ch;
    used += w;
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
