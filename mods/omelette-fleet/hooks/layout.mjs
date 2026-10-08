/**
 * omelette-fleet :: mods/omelette-fleet/hooks/layout.mjs
 * The pane's terminal drawing (1.7.0): the fleet model as rows of toned
 * segments. From 53 cells, and with room for the graph and one history row,
 * the graph — sub-agents above, the orchestrator, the three units below, bus
 * rows between them; below that the same actors as an indented tree. Under
 * either, the history, newest first. Also the status-line text for a closed
 * pane; the graph's boxes, the header and the history rows serve the other
 * surfaces too (svg.mjs, register.tsx). Pure, no imports but its neighbours;
 * every string is cleaned of the characters a terminal acts on before it is
 * measured (`clean`), and every width is measured in terminal cells (`cells`,
 * `cut`), never in string length.
 */
import { MAIN } from './model.mjs';
import { cells, clean, clock, cut, duration, familyOf, shortModel, shortRole } from './text.mjs';

/** @import { FleetNode, FleetState } from './model.mjs' */
/** @typedef {'plain'|'live'|'dim'} Tone */
/** @typedef {{ text: string, tone: Tone }} Segment */
/** @typedef {{ columns: number, rows: number, isAscii?: boolean, tzOffsetAt?: (at: number) => number, animate?: boolean }} LayoutOptions */

/** The narrowest pane the graph is drawn on: three units side by side. */
const GRAPH_MIN = 53;
/** An agent's or a unit's box: 17 cells wide, frame + three lines + frame. */
const BOX = 17;
/** A box and the one cell between it and the next. */
const STEP = BOX + 1;
/** The orchestrator's box: 27 cells wide, frame + two lines + frame. */
const ORCH = 27;
/** The most agent boxes one row holds. */
const ROW_MAX = 6;
/** The status line's width. */
const STATUS_CELLS = 60;
/** A unit call by another session, as the model writes `callerId`. */
const OTHER = 'other';
/** A running box's glyph when motion is on: one frame per 250 ms of the model's clock. */
const SPINNER = Object.freeze({ unicode: [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'], ascii: [...'|/-\\'] });
const SPIN_MS = 250;

const SYMBOLS = Object.freeze({
  unicode: { orchestrator: '●', running: '▶', waiting: '◌', idle: '·', sep: ' · ', to: '→', from: '←', more: '…', times: '×', branch: '├', last: '└', spine: '│' },
  ascii: { orchestrator: '*', running: '>', waiting: 'o', idle: '.', sep: ' - ', to: '->', from: '<-', more: '~', times: 'x', branch: '+', last: '+', spine: '|' },
});

/** A frame or bus glyph in the ASCII form: lines stay lines, every corner and junction is '+'. */
const ASCII_LINE = Object.freeze({ '─': '-', '│': '|' });

/**
 * The bus glyph of a column, by which of up / down / left / right it joins.
 * @type {Record<string, string>}
 */
const JUNCTION = Object.freeze({
  'udlr': '┼', 'u-lr': '┴', '-dlr': '┬', 'u--r': '└', 'u-l-': '┘', '-d-r': '┌', '-dl-': '┐',
  'ud--': '│', 'ud-r': '├', 'udl-': '┤', '--lr': '─', 'u---': '│', '-d--': '│',
});

/**
 * The pane as rows of segments: the header, a blank row, the graph or the
 * tree, then (when there is history and room) a blank row and the history,
 * newest first. Never more than `rows` rows, none wider than `columns` cells.
 * `tzOffsetAt(at)` is `Date.prototype.getTimezoneOffset` at that instant, so
 * each history time is shown in the zone it fell in. With `animate`, a running
 * box's glyph is the spinner's frame for `state.now`, so the drawing stays a
 * function of the state; without it, a static ▶.
 * @param {FleetState} state
 * @param {LayoutOptions} options
 * @returns {Segment[][]}
 */
export function layout(state, { columns, rows, isAscii = false, tzOffsetAt = () => 0, animate = false }) {
  const width = Math.floor(columns);
  const height = Math.floor(rows);
  if (!(width > 0) || !(height > 0)) return [];
  const base = isAscii ? SYMBOLS.ascii : SYMBOLS.unicode;
  const sym = animate ? { ...base, running: spinnerOf(state.now, isAscii) } : base;

  const out = [headerRow(state, { columns: width, isAscii }), []];
  const graphHeight = graphRowsFor(state);
  if (width >= GRAPH_MIN && height >= 2 + graphHeight + 2) {
    out.push(...graph(state, width, sym, isAscii));
  } else {
    out.push(...tree(state, width, height - 2, sym));
  }
  const history = historyRows(state, { columns: width, count: height - out.length - 1, isAscii, tzOffsetAt });
  if (history.length > 0) out.push([], ...history);
  return out.slice(0, height);
}

/**
 * The header row: `ctx 31% · 5h 11% · 7d 71%`, each figure left out when
 * absent, cut to `columns`; an empty row when there is no figure. The
 * session's cost is not shown: on a subscription it is an API price, not a bill.
 * @param {FleetState} state
 * @param {{ columns: number, isAscii?: boolean }} options
 * @returns {Segment[]}
 */
export function headerRow(state, { columns, isAscii = false }) {
  const sym = isAscii ? SYMBOLS.ascii : SYMBOLS.unicode;
  return textRow(fitted(headerText(state.usage ?? {}, sym), Math.floor(columns), sym));
}

/**
 * The history, newest first, at most `count` links, one row each cut to
 * `columns`: `HH:MM:SS <from role> → <to role> · <label>`, each time in the
 * zone `tzOffsetAt` gives for it. The terminal draws it under the graph or the
 * tree, the other surfaces under the Svg.
 * @param {FleetState} state
 * @param {{ columns: number, count: number, isAscii?: boolean, tzOffsetAt?: (at: number) => number }} options
 * @returns {Segment[][]}
 */
export function historyRows(state, { columns, count, isAscii = false, tzOffsetAt = () => 0 }) {
  const sym = isAscii ? SYMBOLS.ascii : SYMBOLS.unicode;
  const history = Array.isArray(state.history) ? state.history : [];
  const max = Math.floor(count);
  if (!(max > 0)) return [];
  return history.slice(-max).reverse().map((link) => textRow(fitted(
    `${clock(link.at, tzOffsetAt(link.at))} ${roleOf(state, link.from)} ${sym.to} ${roleOf(state, link.to)}${sym.sep}${link.label}`,
    Math.floor(columns),
    sym,
  )));
}

/**
 * Each row's segments joined, its right end trimmed (for tests, and for the
 * SVG's alt text).
 * @param {Segment[][]} rows
 * @returns {string[]}
 */
export function plainRows(rows) {
  return rows.map((row) => row.map((segment) => segment.text).join('').trimEnd());
}

/**
 * What the status line shows while the pane is closed: `fleet: ` and the
 * running agents' roles and running units, a unit with its call's duration,
 * cut to 60 cells; undefined when nothing runs.
 * @param {FleetState} state
 * @param {number} now
 * @returns {string | undefined}
 */
export function statusLine(state, now) {
  const running = byOrder(state.nodes).filter((n) => n.status === 'running');
  const parts = [
    ...running.filter((n) => n.kind === 'agent').map((n) => shortRole(n.role)),
    ...running.filter((n) => n.kind === 'unit').map((n) => `${n.role} ${duration(now - n.since)}`),
  ];
  return parts.length ? cut(clean(`fleet: ${parts.join(', ')}`), STATUS_CELLS) : undefined;
}

// ---------------------------------------------------------------------------
// Words

/**
 * `text` cleaned (roles, models and file names come from outside), then cut to
 * `width` cells; in the ASCII form the cut's ellipsis is '~'. Every string the
 * layout draws passes here.
 */
function fitted(raw, width, sym) {
  const text = clean(raw);
  const out = cut(text, width);
  return out !== text && sym.more !== '…' && out.endsWith('…') ? `${out.slice(0, -1)}${sym.more}` : out;
}

/** One row of one plain segment; an empty text is an empty row. */
const textRow = (text, tone = /** @type {Tone} */ ('plain')) => (text ? [{ text, tone }] : []);

/** `ctx 31% · 5h 11% · 7d 71%`, each figure left out when absent. */
function headerText(usage, sym) {
  const percent = (value) => `${Math.round(value)}%`;
  const parts = [];
  if (Number.isFinite(usage.contextPercent)) parts.push(`ctx ${percent(usage.contextPercent)}`);
  if (Number.isFinite(usage.fiveHour)) parts.push(`5h ${percent(usage.fiveHour)}`);
  if (Number.isFinite(usage.sevenDay)) parts.push(`7d ${percent(usage.sevenDay)}`);
  return parts.join(sym.sep);
}

/** The spinner's frame for the model's time `now`: the next frame every 250 ms. */
function spinnerOf(now, isAscii) {
  const frames = isAscii ? SPINNER.ascii : SPINNER.unicode;
  const step = Number.isFinite(now) ? Math.floor(now / SPIN_MS) : 0;
  return frames[((step % frames.length) + frames.length) % frames.length];
}

/**
 * How a link's end reads in the history and in a unit's box: a role, a unit,
 * or the raw target; another session's call is `other`, so `← other` fits a
 * box's 14 cells.
 */
function roleOf(state, id) {
  if (id === MAIN) return 'orchestrator';
  if (id === OTHER) return 'other';
  const node = state.nodes.find((n) => n.id === id);
  if (!node) return String(id);
  return node.kind === 'agent' ? shortRole(node.role) : node.role;
}

const byOrder = (nodes) => [...nodes].sort((a, b) => a.order - b.order);
const agentsOf = (state) => byOrder(state.nodes.filter((n) => n.kind === 'agent'));
const unitsOf = (state) => byOrder(state.nodes.filter((n) => n.kind === 'unit'));
const orchestratorOf = (state) => state.nodes.find((n) => n.id === MAIN) ?? { id: MAIN, kind: 'orchestrator', role: 'orchestrator', status: 'idle', since: state.now, order: 0 };

const isActive = (n) => n.status === 'running' || n.status === 'waiting';
/** A box that is idle or reported is dim. */
const isDim = (n) => n.status === 'idle' || n.status === 'reported';
/** A unit with a call in flight from the orchestrator (any of its open calls): its link is drawn live. */
const isLiveUnit = (n) => n.status === 'running' && (n.openCalls?.length ? n.openCalls.some((c) => c.callerId === MAIN) : n.callerId === MAIN);
/** A running agent's or unit's frame is drawn live, like a live line. */
const frameToneOf = (n, tone) => (n?.status === 'running' ? 'live' : tone);

/** An agent's three lines: glyph and role; model family · effort; what it does, or its state with a duration. */
function agentLines(node, now, sym) {
  const glyph = node.status === 'running' ? sym.running : node.status === 'waiting' ? sym.waiting : sym.idle;
  const kind = [node.model ? familyOf(node.model) : '', node.effort ?? ''].filter(Boolean).join(sym.sep);
  let doing = node.activity ?? '';
  if (!doing && node.status === 'reported') doing = `reported ${duration(now - node.since)}`;
  if (!doing && node.status === 'waiting') doing = `waiting ${duration(now - node.since)}`;
  return [`${glyph} ${shortRole(node.role)}`, kind, doing];
}

/** A unit's three lines: glyph and name; its tool, or how long idle; who called it, or model and duration. */
function unitLines(state, node, now, sym) {
  if (node.status !== 'running') {
    const idle = Number.isFinite(node.lastEndedAt) ? `idle ${duration(now - node.lastEndedAt)}` : node.feed === 'ok' ? 'idle' : 'no feed';
    return [`${sym.idle} ${node.role}`, idle, ''];
  }
  const open = node.openCalls?.length ?? 0;
  const tool = `${node.activity ?? ''}${open > 1 ? ` ${sym.times}${open}` : ''}`;
  const caller = node.callerId && node.callerId !== MAIN ? `${sym.from} ${roleOf(state, node.callerId)}` : [node.model, duration(now - node.since)].filter(Boolean).join(' ');
  return [`${sym.running} ${node.role}`, tool, caller];
}

/** The orchestrator's two lines; the context fill rides with its model. */
function orchestratorLines(node, usage, sym) {
  const pct = Number.isFinite(usage.contextPercent) ? `${Math.round(usage.contextPercent)}%` : '';
  return [`${sym.orchestrator} orchestrator`, [node.model ? shortModel(node.model) : '', node.effort ?? '', pct].filter(Boolean).join(sym.sep)];
}

/**
 * The agents one row shows: all of them when they fit; otherwise the first
 * `n - 1` by running and waiting first, then reported by newest `since`, the
 * rest folded into a last `+K more` box. Within the row, by `order`.
 */
function agentRow(agents, n) {
  if (agents.length <= n) return { shown: agents, hidden: [] };
  const rest = agents.filter((a) => !isActive(a)).sort((a, b) => b.since - a.since);
  const keep = new Set([...agents.filter(isActive), ...rest].slice(0, n - 1));
  return { shown: agents.filter((a) => keep.has(a)), hidden: agents.filter((a) => !keep.has(a)) };
}

// ---------------------------------------------------------------------------
// The graph

/** @typedef {{ actor: FleetNode, lines: string[], tone: Tone, isLive: boolean }} GraphBox */
/** @typedef {{ hidden: FleetNode[], lines: string[], tone: Tone, isLive: boolean }} FoldBox */

/**
 * The graph's boxes, the terminal's and the desktop's: the agent row (at most
 * `perRow` boxes; past that its first `perRow - 1` and a last `+K more` box
 * folding the rest), the orchestrator and the units, by `order`. Each box has
 * its lines as the model gives them (not yet cleaned or cut), its tone, and
 * whether its link to the orchestrator is live — an agent's or the fold's when
 * one it draws runs, a unit's when the orchestrator calls it.
 * @param {FleetState} state
 * @param {number} [perRow]
 * @param {typeof SYMBOLS.unicode} [sym]
 * @returns {{ agents: GraphBox[], fold: FoldBox | undefined, orchestrator: GraphBox, units: GraphBox[] }}
 */
export function graphBoxes(state, perRow = ROW_MAX, sym = SYMBOLS.unicode) {
  const now = state.now;
  const toneOf = (n) => /** @type {Tone} */ (isDim(n) ? 'dim' : 'plain');
  const { shown, hidden } = agentRow(agentsOf(state), Math.min(ROW_MAX, perRow));
  const agents = shown.map((actor) => ({ actor, lines: agentLines(actor, now, sym), tone: toneOf(actor), isLive: actor.status === 'running' }));
  let fold;
  if (hidden.length) {
    const runs = hidden.filter((a) => a.status === 'running').length;
    fold = { hidden, lines: [`+${hidden.length} more`, runs ? `${runs} running` : '', ''], tone: /** @type {Tone} */ (hidden.every(isDim) ? 'dim' : 'plain'), isLive: runs > 0 };
  }
  const main = orchestratorOf(state);
  const orchestrator = { actor: main, lines: orchestratorLines(main, state.usage ?? {}, sym), tone: /** @type {Tone} */ ('plain'), isLive: false };
  const units = unitsOf(state).map((actor) => ({ actor, lines: unitLines(state, actor, now, sym), tone: toneOf(actor), isLive: isLiveUnit(actor) }));
  return { agents, fold, orchestrator, units };
}

/**
 * The cells across the graph needs to draw `boxes` boxes in its agent row: the
 * three units' 53 at least. (The SVG's alt is the terminal drawing at this
 * width, so every box the image shows is in it.)
 * @param {number} boxes
 * @returns {number}
 */
export function graphColumns(boxes) {
  return Math.max(GRAPH_MIN, Math.floor(boxes) * STEP - 1);
}

/** The graph's rows: an agent row and its bus when there are agents, the orchestrator, the unit bus, the units. */
const graphRowsFor = (state) => (state.nodes.some((n) => n.kind === 'agent') ? 6 : 0) + 4 + 1 + 5;

/** A grid of cells, each a glyph and a tone; a wide character's second cell is '' . */
function grid(width, height) {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: ' ', tone: /** @type {Tone} */ ('plain') })));
}

/** Writes `text` into a row from column `x`, by cells: a wide character takes two, a combining mark joins the cell before. */
function put(row, x, text, tone) {
  let col = x;
  for (const ch of text) {
    const w = cells(ch);
    if (w === 0) {
      if (col > x) row[col - 1].ch += ch;
      continue;
    }
    if (col + w > row.length) break;
    row[col] = { ch, tone };
    if (w === 2) row[col + 1] = { ch: '', tone };
    col += w;
  }
}

/**
 * A box at (`y`, `x`): frame, one row per line (a space and the line cut to
 * the width less three), frame; the frame in `frameTone` (a running box's is
 * live), the lines in `tone`; `top` / `bottom` put a junction at the box's
 * centre in that tone.
 */
function box(cells2d, y, x, width, lines, tone, sym, { top, bottom, frameTone = tone } = {}) {
  const inner = width - 2;
  const centre = x + Math.floor(width / 2);
  const frame = (r, left, right, junction, junctionTone) => {
    put(cells2d[r], x, `${left}${'─'.repeat(inner)}${right}`, frameTone);
    if (junction) put(cells2d[r], centre, junction, junctionTone);
  };
  frame(y, '┌', '┐', top && '┴', top);
  lines.forEach((line, i) => {
    const row = cells2d[y + 1 + i];
    put(row, x, '│', frameTone);
    put(row, x + 1, ' '.repeat(inner), tone);
    put(row, x + width - 1, '│', frameTone);
    put(row, x + 2, fitted(line, inner - 1, sym), tone);
  });
  frame(y + 1 + lines.length, '└', '┘', bottom && '┬', bottom);
}

/**
 * A bus row: a line from the leftmost to the rightmost of `ups` (columns with
 * a box above) and `downs` (below), each column's glyph by what it joins; a
 * cell between a live centre and `hub` is live, every other bus cell dim.
 */
function bus(row, ups, downs, hub, liveCentres) {
  const all = [...ups, ...downs];
  const left = Math.min(...all);
  const right = Math.max(...all);
  for (let col = left; col <= right; col++) {
    const key = `${ups.includes(col) ? 'u' : '-'}${downs.includes(col) ? 'd' : '-'}${col > left ? 'l' : '-'}${col < right ? 'r' : '-'}`;
    const isLive = liveCentres.some((c) => col >= Math.min(c, hub) && col <= Math.max(c, hub));
    row[col] = { ch: JUNCTION[key] ?? '─', tone: isLive ? 'live' : 'dim' };
  }
}

/** The graph, as rows of segments. */
function graph(state, width, sym, isAscii) {
  const { agents, fold, orchestrator, units } = graphBoxes(state, Math.floor((width + 1) / STEP), sym);
  /** @type {(GraphBox | FoldBox)[]} */
  const boxes = fold ? [...agents, fold] : agents;

  const W = Math.max(GRAPH_MIN, boxes.length * STEP - 1);
  const hub = Math.floor(W / 2);
  const out = grid(W, graphRowsFor(state));
  let y = 0;

  if (boxes.length) {
    const left = (W - (boxes.length * STEP - 1)) / 2;
    const centres = boxes.map((_, i) => left + i * STEP + Math.floor(BOX / 2));
    boxes.forEach((b, i) => box(out, y, left + i * STEP, BOX, b.lines, b.tone, sym, { bottom: b.isLive ? 'live' : b.tone, frameTone: frameToneOf(b.actor, b.tone) }));
    bus(out[y + 5], centres, [hub], hub, centres.filter((_, i) => boxes[i].isLive));
    y += 6;
  }

  const anyAgentLive = boxes.some((b) => b.isLive);
  const anyUnitLive = units.some((u) => u.isLive);
  box(out, y, hub - Math.floor(ORCH / 2), ORCH, orchestrator.lines, 'plain', sym, {
    top: boxes.length ? (anyAgentLive ? 'live' : 'plain') : undefined,
    bottom: anyUnitLive ? 'live' : 'plain',
  });
  y += 4;

  const unitLeft = (W - (units.length * STEP - 1)) / 2;
  const unitCentres = units.map((_, i) => unitLeft + i * STEP + Math.floor(BOX / 2));
  bus(out[y], [hub], unitCentres, hub, unitCentres.filter((_, i) => units[i].isLive));
  units.forEach((u, i) => {
    box(out, y + 1, unitLeft + i * STEP, BOX, u.lines, u.tone, sym, { top: u.isLive ? 'live' : u.tone, frameTone: frameToneOf(u.actor, u.tone) });
  });

  return out.map((row) => segmentsOf(row, isAscii));
}

/** A grid row as segments: trailing blanks dropped, runs of one tone joined; in the ASCII form lines become - | and junctions +. */
function segmentsOf(row, isAscii) {
  let end = row.length;
  while (end > 0 && row[end - 1].ch === ' ') end -= 1;
  /** @type {Segment[]} */
  const out = [];
  for (const cell of row.slice(0, end)) {
    const ch = isAscii ? asciiOf(cell.ch) : cell.ch;
    const last = out[out.length - 1];
    if (last && last.tone === cell.tone) last.text += ch;
    else out.push({ text: ch, tone: cell.tone });
  }
  return out;
}

/** A frame or bus glyph in ASCII; anything else as it is. */
function asciiOf(ch) {
  if (Object.hasOwn(ASCII_LINE, ch)) return ASCII_LINE[ch];
  return /^[┌┐└┘┬┴┼├┤]$/u.test(ch) ? '+' : ch;
}

// ---------------------------------------------------------------------------
// The tree

/**
 * The same actors as an indented tree within `room` rows: the orchestrator,
 * then each agent and unit as `├ <glyph> <role>  <line two>` and, when it has
 * one, `│   <line three>`. A tree taller than `room` ends in `… +N`, N the
 * actors it left out.
 */
function tree(state, width, room, sym) {
  if (room <= 0) return [];
  const now = state.now;
  const orch = orchestratorOf(state);
  const orchKind = [orch.model ? shortModel(orch.model) : '', orch.effort ?? ''].filter(Boolean).join(sym.sep);
  const actors = [
    ...agentsOf(state).map((a) => ({ lines: agentLines(a, now, sym), tone: isDim(a) ? 'dim' : 'plain', isLive: a.status === 'running' })),
    ...unitsOf(state).map((u) => ({ lines: unitLines(state, u, now, sym), tone: isDim(u) ? 'dim' : 'plain', isLive: isLiveUnit(u) })),
  ];
  /** @type {Segment[][][]} one list of rows per actor, the orchestrator first */
  const drawn = [[textRow(fitted(`${sym.orchestrator} orchestrator${orchKind ? `  ${orchKind}` : ''}`, width, sym))]];
  actors.forEach((actor, i) => {
    const isLast = i === actors.length - 1;
    const [head, two, three] = actor.lines;
    const connector = { text: isLast ? sym.last : sym.branch, tone: /** @type {Tone} */ (actor.isLive ? 'live' : 'dim') };
    const rows = [branchRow(connector, ` ${head}${two ? `  ${two}` : ''}`, actor.tone, width, sym)];
    if (three) rows.push(branchRow({ text: isLast ? ' ' : sym.spine, tone: 'dim' }, `   ${three}`, actor.tone, width, sym));
    drawn.push(rows);
  });

  const total = drawn.reduce((sum, rows) => sum + rows.length, 0);
  if (total <= room) return drawn.flat();
  const out = [];
  let kept = 0;
  while (kept < drawn.length && out.length + drawn[kept].length <= room - 1) out.push(...drawn[kept++]);
  out.push(textRow(fitted(`${sym.more} +${drawn.length - kept}`, width, sym)));
  return out;
}

/** A tree row: its one-cell connector, then the rest cut to what is left of the width. */
function branchRow(connector, rest, tone, width, sym) {
  if (width < 1) return [];
  const text = fitted(rest, width - 1, sym);
  return text.trimEnd() ? [connector, { text, tone }] : [connector];
}
