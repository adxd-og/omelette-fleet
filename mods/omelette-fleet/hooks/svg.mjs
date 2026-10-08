/**
 * omelette-fleet :: mods/omelette-fleet/hooks/svg.mjs
 * The pane's drawing for the surfaces that draw an `Svg` (the desktop app,
 * VS Code, mobile) (1.7.0): the fleet graph as one SVG document — a box per
 * actor with the terminal's lines, a real line per link (an agent to the loop
 * that spawned it, a caller to a unit whose call is in flight, a sub-agent's
 * call included), the live ones in the accent colour and `class="live"` — and
 * its alt text, the terminal's drawing at 53 columns. Pure, no imports but its
 * neighbours.
 *
 * Every string from the state is cleaned of control characters (`clean`), cut
 * to its box, then XML-escaped; none reaches an attribute, where every value
 * is a number or a constant. No script, no event attribute, no external
 * reference: the only URI is the SVG namespace.
 */
import { graphBoxes, layout, plainRows } from './layout.mjs';
import { MAIN } from './model.mjs';
import { clean, cut } from './text.mjs';

/** @import { FleetNode, FleetState } from './model.mjs' */
/** @typedef {{ x: number, y: number, w: number }} Place  a box's top-left corner and width, in px */
/** @typedef {{ from: { x: number, y: number }, to: { x: number, y: number }, d?: string, isLive: boolean }} Link  a line, or a path when `d` is set */

/** The accent a live link is drawn in: the Claude orange, which reads on a light and on a dark ground. */
const ACCENT = '#d97757';
/** Every other colour is `currentColor`; drawn as an isolated image, the SVG has no page colour to inherit, so a dark scheme sets its own. */
const STYLE = '<style>@media (prefers-color-scheme: dark){svg{color:#e8e6e3}}</style>';
const FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** px: the type size, the step between baselines, a box's inner margin. */
const FONT_PX = 12;
const LINE_PX = 16;
const PAD_PX = 10;
/** The cells a box line holds, as on the terminal: 14 in an agent's or a unit's box, 24 in the orchestrator's. */
const BOX_CELLS = 14;
const ORCH_CELLS = 24;
/** The code points a line keeps at most, per cell: a run of zero-width marks takes no cell and would pass the cut. */
const POINTS_PER_CELL = 4;
/** px: an agent's or a unit's box (14 cells of 0.6 em at 12 px, and the margins), the orchestrator's, the height of both. */
const BOX_W = 124;
const ORCH_W = 196;
const BOX_H = 64;
/** px: between boxes in a row, between layers (at least), around the drawing, and above the agent row when an agent links to another. */
const GAP_X = 16;
const GAP_Y = 44;
const MARGIN = 12;
const ARC_ROOM = 24;
/**
 * px: an agent's link to a unit runs across above the orchestrator's box, down
 * past its side and across below it, this far from the box for the first such
 * link and a step further for each next one (its levels by all such links, its
 * side by those on that side), so no two share a segment.
 */
const AROUND_PX = 10;
const AROUND_STEP_PX = 6;

const XML = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });

/**
 * `text` as XML character data: the five markup characters escaped, and the
 * code points XML cannot carry (a lone surrogate, U+FFFE, U+FFFF) dropped.
 * @param {string} text
 * @returns {string}
 */
function xml(text) {
  return text.replace(/[\uD800-\uDFFF\uFFFE\uFFFF]/gu, '').replace(/[&<>"']/g, (ch) => XML[ch]);
}

/** A box line as the document holds it: cleaned, cut to `budget` cells and to its code points' share, escaped. */
function lineText(raw, budget) {
  const text = cut(clean(raw), budget);
  const points = [...text];
  return xml(points.length > POINTS_PER_CELL * budget ? points.slice(0, POINTS_PER_CELL * budget).join('') : text);
}

const topOf = (place) => ({ x: place.x + place.w / 2, y: place.y });
const bottomOf = (place) => ({ x: place.x + place.w / 2, y: place.y + BOX_H });

/** `count` boxes `w` wide in a row centred in `width`, their tops at `y`. */
function row(count, w, y, width) {
  const span = count > 0 ? count * w + (count - 1) * GAP_X : 0;
  const left = (width - span) / 2;
  return Array.from({ length: count }, (_, i) => ({ x: left + i * (w + GAP_X), y, w }));
}

/**
 * Whose calls to a unit are in flight: each open call's caller, or the one
 * the feed named (`'other'`, another session's, which no box draws).
 * @param {FleetNode} unit
 * @returns {string[]}
 */
function callersOf(unit) {
  if (unit.status !== 'running') return [];
  return unit.openCalls?.length ? unit.openCalls.map((c) => c.callerId) : unit.callerId ? [unit.callerId] : [];
}

/** One box: its frame, and a text per line that is not blank; a dim box at half opacity. */
function boxSvg(place, lines, budget, tone) {
  const texts = lines
    .map((line, i) => ({ text: lineText(line, budget), y: place.y + PAD_PX + FONT_PX + i * LINE_PX }))
    .filter((line) => line.text)
    .map((line) => `<text x="${place.x + PAD_PX}" y="${line.y}">${line.text}</text>`);
  const group = tone === 'dim' ? '<g opacity="0.5">' : '<g>';
  return `${group}<rect x="${place.x}" y="${place.y}" width="${place.w}" height="${BOX_H}" rx="6" fill="none" stroke="currentColor"/>${texts.join('')}</g>`;
}

/** One link: live in the accent at two pixels, else a faint `currentColor`. */
function linkSvg(link) {
  const stroke = link.isLive ? `class="live" stroke="${ACCENT}" stroke-width="2"` : 'stroke="currentColor" stroke-opacity="0.4"';
  if (link.d) return `<path d="${link.d}" fill="none" ${stroke}/>`;
  return `<line x1="${link.from.x}" y1="${link.from.y}" x2="${link.to.x}" y2="${link.to.y}" ${stroke}/>`;
}

/** A straight link between two layers: from one box's bottom centre to the other's top centre. */
const straight = (upper, lower, isLive) => ({ from: bottomOf(upper), to: topOf(lower), isLive });

/** An agent's link to its parent agent in the same row: an arc over the row, top centre to top centre. */
function arc(child, parent, isLive) {
  const from = topOf(child);
  const to = topOf(parent);
  const control = from.y - 2 * (ARC_ROOM - 4);
  return { from, to, d: `M${from.x} ${from.y}Q${(from.x + to.x) / 2} ${control} ${to.x} ${to.y}`, isLive };
}

/**
 * An agent's call to a unit, the `level`-th such link: down from the agent,
 * across above the orchestrator's box, down past the side of it nearer the
 * agent, across below it to the unit, down into it. `sides` counts the links
 * already on each side.
 */
function around(agent, orch, unit, level, sides, width) {
  const from = bottomOf(agent);
  const to = topOf(unit);
  const centre = orch.x + orch.w / 2;
  const isLeft = from.x < centre || (from.x === centre && to.x <= centre);
  const out = AROUND_PX + AROUND_STEP_PX * (isLeft ? sides.left++ : sides.right++);
  const x = isLeft ? Math.max(2, orch.x - out) : Math.min(width - 2, orch.x + orch.w + out);
  const above = orch.y - AROUND_PX - AROUND_STEP_PX * level;
  const below = orch.y + BOX_H + AROUND_PX + AROUND_STEP_PX * level;
  return { from, to, d: `M${from.x} ${from.y}V${above}H${x}V${below}H${to.x}V${to.y}`, isLive: true };
}

/**
 * The fleet as one SVG document: the agent row (six boxes at most, the rest
 * folded into `+K more`), the orchestrator, the three units; a line per link —
 * each shown agent to its parent (an arc to a parent agent, the fold box
 * standing in for a folded one), the fold to the orchestrator, each caller
 * whose call is in flight to its unit (the orchestrator straight down, an
 * agent around the orchestrator's box) — live when the agent runs or the call
 * is in flight. `alt` is the terminal's drawing at 53 columns and 40 rows;
 * `tzOffsetAt(at)` is `Date.prototype.getTimezoneOffset` at that instant.
 * `width` and `height` are the document's size in CSS pixels.
 * @param {FleetState} state
 * @param {{ tzOffsetAt?: (at: number) => number }} [options]
 * @returns {{ source: string, alt: string, width: number, height: number }}
 */
export function svgOf(state, { tzOffsetAt = () => 0 } = {}) {
  const { agents, fold, orchestrator, units } = graphBoxes(state);
  const shown = fold ? [...agents, fold] : agents;

  // The box an agent id draws in the row: its own, or the fold's for a folded one.
  const slots = new Map(agents.map((a, i) => [a.actor.id, i]));
  for (const hidden of fold?.hidden ?? []) slots.set(hidden.id, agents.length);
  const slotOf = (id) => (typeof id === 'string' && id !== MAIN && slots.has(id) ? slots.get(id) : -1);
  const parents = agents.map((a, i) => (slotOf(a.actor.parentId) === i ? -1 : slotOf(a.actor.parentId)));
  const hasArc = parents.some((p) => p >= 0);

  // Each unit's calls in flight, one per box that draws a caller: the orchestrator ('main') or a slot of the agent row.
  /** @type {{ slot: number | 'main', unit: number }[]} */
  const calls = [];
  units.forEach((u, unit) => {
    const drawn = new Set();
    for (const callerId of callersOf(u.actor)) {
      const slot = callerId === MAIN ? 'main' : slotOf(callerId);
      if (slot === -1 || drawn.has(slot)) continue;
      drawn.add(slot);
      calls.push({ slot, unit });
    }
  });
  const arounds = calls.filter((c) => c.slot !== 'main').length;

  const span = (count, w) => (count > 0 ? count * w + (count - 1) * GAP_X : 0);
  const width = Math.max(span(shown.length, BOX_W), span(units.length, BOX_W), ORCH_W) + 2 * MARGIN;
  const gap = Math.max(GAP_Y, 2 * AROUND_PX + AROUND_STEP_PX * (arounds - 1));
  let y = MARGIN + (hasArc ? ARC_ROOM : 0);
  const agentPlaces = row(shown.length, BOX_W, y, width);
  if (shown.length) y += BOX_H + gap;
  const [orchPlace] = row(1, ORCH_W, y, width);
  y += BOX_H + gap;
  const unitPlaces = row(units.length, BOX_W, y, width);
  const height = y + BOX_H + MARGIN;

  /** @type {Link[]} */
  const links = agents.map((a, i) => (parents[i] >= 0 ? arc(agentPlaces[i], agentPlaces[parents[i]], a.isLive) : straight(agentPlaces[i], orchPlace, a.isLive)));
  if (fold) links.push(straight(agentPlaces[agents.length], orchPlace, fold.isLive));
  const sides = { left: 0, right: 0 };
  let level = 0;
  for (const { slot, unit } of calls) {
    links.push(slot === 'main' ? straight(orchPlace, unitPlaces[unit], true) : around(agentPlaces[slot], orchPlace, unitPlaces[unit], level++, sides, width));
  }

  const boxes = [
    ...shown.map((b, i) => boxSvg(agentPlaces[i], b.lines, BOX_CELLS, b.tone)),
    boxSvg(orchPlace, orchestrator.lines, ORCH_CELLS, orchestrator.tone),
    ...units.map((u, i) => boxSvg(unitPlaces[i], u.lines, BOX_CELLS, u.tone)),
  ];
  const source = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT_FAMILY}" font-size="${FONT_PX}" fill="currentColor">`,
    STYLE,
    ...links.map(linkSvg),
    ...boxes,
    '</svg>',
  ].join('');
  const alt = plainRows(layout(state, { columns: 53, rows: 40, isAscii: false, tzOffsetAt })).join('\n');
  return { source, alt, width, height };
}
