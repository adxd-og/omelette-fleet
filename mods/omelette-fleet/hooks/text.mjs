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
/** One leading assignment with its value, quoted parts included, and the space after it. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"'])*(?:\s+|$)/;
/** One leading `cd <dir>` segment joined to the rest by `&&` or `;`. */
const CD_SEGMENT = /^cd\s+[^;&]*?\s*(?:&&|;)\s*/;
/** The package's agent prefix, which every shipped role carries. */
const ROLE_PREFIX = 'omelette-';

/** The tools whose subject is a file, and the input field naming it. */
const FILE_FIELD = Object.freeze({ Edit: 'file_path', Write: 'file_path', Read: 'file_path', NotebookEdit: 'notebook_path' });

const two = (n) => String(n).padStart(2, '0');

/**
 * `text` in at most `cells` code points: longer text keeps `cells - 1` of them
 * and ends in '…'; no cells, no text.
 * @param {string} text
 * @param {number} cells
 * @returns {string}
 */
export function cut(text, cells) {
  const width = Math.floor(cells);
  if (!(width > 0)) return '';
  const points = [...String(text ?? '')];
  return points.length <= width ? points.join('') : `${points.slice(0, width - 1).join('')}…`;
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
  if (tool === 'Bash' && typeof args.command === 'string') {
    const words = commandWords(args.command);
    if (words.length) return `Bash: ${words.join(' ')}`;
  }
  if (Object.hasOwn(FILE_FIELD, tool)) {
    const path = args[FILE_FIELD[tool]];
    const base = typeof path === 'string' ? path.split(/[\\/]/).pop() : '';
    if (base) return `${tool} ${base}`;
  }
  return unitOfTool(tool)?.tool ?? tool;
}

/** `text` without its leading assignments; empty when one has a value it cannot delimit (an open quote). */
function withoutAssignments(text) {
  let rest = text;
  while (NAME_EQ.test(rest)) {
    const assignment = ASSIGNMENT.exec(rest);
    if (!assignment) return '';
    rest = rest.slice(assignment[0].length);
  }
  return rest;
}

/**
 * The first two words of a shell command that say what it runs: leading
 * assignments skipped, and one leading `cd <dir> &&` (or `;`) segment with them.
 */
function commandWords(command) {
  let rest = withoutAssignments(command.trim());
  const cd = CD_SEGMENT.exec(rest);
  if (cd) rest = withoutAssignments(rest.slice(cd[0].length));
  return rest.split(/\s+/).filter(Boolean).slice(0, 2);
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
