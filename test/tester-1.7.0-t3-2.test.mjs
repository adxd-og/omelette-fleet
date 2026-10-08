/**
 * omelette-fleet :: test/tester-1.7.0-t3-2.test.mjs
 * Tester's tests for 1.7.0 Task 3.2 (motion, the header without cost): only what the implementer's
 * tests leave to a mutant — the spinner's exact frame, the accent frames of units and of the SVG,
 * the links' direction, the motion CSS's coherence, the alt's width. Each pins a ruling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, plainRows } from '../mods/omelette-fleet/hooks/layout.mjs';
import { svgOf } from '../mods/omelette-fleet/hooks/svg.mjs';
import { cells } from '../mods/omelette-fleet/hooks/text.mjs';

const SEC = 1000;
const MIN = 60 * SEC;
const NOW = Date.UTC(2026, 9, 8, 9, 6, 0);
const UTC = () => 0;
const ACCENT = '#d97757';

const unit = (name, order, fields = {}) => ({ id: `unit:${name}`, kind: 'unit', role: name, status: 'idle', since: NOW - MIN, feed: 'ok', order, ...fields });
const agent = (id, fields = {}) => ({ id, kind: 'agent', role: `omelette-${id}`, parentId: 'main', status: 'running', since: NOW - MIN, order: 10 + Number(id.replace(/\D/g, '') || 0), ...fields });
const call = (callerId, callId = `${callerId}:c`) => ({ callId, callerId, tool: 'review', since: NOW - MIN });
const running = (...callers) => ({ status: 'running', callerId: callers.at(-1), activity: 'review', openCalls: callers.map((c, i) => call(c, `c${i}`)) });

/** The orchestrator, the three units (`units` patches them by name), `agents`. */
function stateOf(agents = [], units = {}, extra = {}) {
  return {
    now: NOW, isOpen: true, usage: {}, history: [], ...extra,
    nodes: [
      { id: 'main', kind: 'orchestrator', role: 'orchestrator', status: 'running', since: NOW - MIN, order: 0 },
      ...['gemini', 'grok', 'codex'].map((name, i) => unit(name, i + 1, units[name])),
      ...agents,
    ],
  };
}

/** The tone of the cell at `col` of a row of segments. */
function toneAt(row, col) {
  let x = 0;
  for (const segment of row) {
    if (col < x + cells(segment.text)) return segment.tone;
    x += cells(segment.text);
  }
  return undefined;
}

const attrsOf = (text) => Object.fromEntries([...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
const tags = (source, name) => [...source.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'g'))].map(([, attrs]) => attrsOf(attrs));

// ---------------------------------------------------------------------------
// The spinner

const UNICODE = [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'];
const ASCII = [...'|/-\\'];

test('the spinner frame is exactly floor(now / 250) % n of the ten glyphs (ASCII four): 249 ms is still the same frame, a full cycle returns to it', () => {
  const state = stateOf([agent('a1')]);
  const glyphAt = (now, isAscii) => plainRows(layout({ ...state, now }, { columns: 53, rows: 30, isAscii, animate: true, tzOffsetAt: UTC })).join('\n').match(/(\S) a1/)[1];
  for (const [isAscii, frames] of [[false, UNICODE], [true, ASCII]]) {
    for (const now of [0, 249, 250, 499, 500, 2499, 2500, 12_345_678, NOW, NOW + 249, NOW + 250, NOW + 251, NOW + 1000, NOW + 2750]) {
      assert.equal(glyphAt(now, isAscii), frames[Math.floor(now / 250) % frames.length], `ascii=${isAscii} now=${now}`);
    }
  }
});

test('with animate the tree form (narrow pane) shows the spinner as well, the static ▶ without it', () => {
  const state = stateOf([agent('a1')]);
  const tree = (animate, isAscii) => plainRows(layout({ ...state, now: NOW + 250 }, { columns: 35, rows: 30, isAscii, animate, tzOffsetAt: UTC })).filter((row) => row.includes('a1'));
  assert.match(tree(true, false)[0], /^├ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] a1/);
  assert.match(tree(true, true)[0], /^\+ [|/\\-] a1/);
  assert.match(tree(false, false)[0], /^├ ▶ a1/);
});

// ---------------------------------------------------------------------------
// The frames' tone

test('a running unit\'s frame is live with or without motion, whoever calls it; an idle unit\'s is dim; a waiting agent\'s is not live', () => {
  for (const animate of [false, true]) {
    for (const caller of ['main', 'other']) {
      const rows = layout(stateOf([agent('a1', { status: 'waiting' })], { grok: running(caller) }), { columns: 53, rows: 30, isAscii: false, animate, tzOffsetAt: UTC });
      const grokTop = plainRows(rows).findIndex((row, i) => i > 4 && row.startsWith('┌'));
      assert.ok(grokTop > 0, 'the units\' row');
      assert.equal(toneAt(rows[grokTop + 1], 18), 'live', `animate=${animate} caller=${caller}: grok's left frame`);
      assert.equal(toneAt(rows[grokTop + 1], 18 + 16), 'live', 'grok\'s right frame');
      assert.equal(toneAt(rows[grokTop + 1], 0), 'dim', 'gemini, idle');
      const waitingRow = plainRows(rows).findIndex((row) => row.includes('◌ a1'));
      assert.ok(waitingRow > 0, 'the waiting agent is drawn');
      assert.notEqual(toneAt(rows[waitingRow], plainRows(rows)[waitingRow].indexOf('◌') - 2), 'live', 'a waiting agent is not running');
    }
  }
});

test('a unit\'s link is live when ANY open call is the orchestrator\'s, even if the first listed is another caller\'s', () => {
  const state = stateOf([], { grok: { status: 'running', callerId: 'main', activity: 'review', openCalls: [call('a-x', 'c0'), call('main', 'c1')] } });
  const rows = layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC });
  const top = plainRows(rows).findIndex((row, i) => i > 4 && row.startsWith('┌'));
  assert.equal(toneAt(rows[top], 26), 'live', 'grok\'s top junction');
});

// ---------------------------------------------------------------------------
// The SVG

/** Every rect with its stroke, and its centre column. */
const rectsOf = (source) => tags(source, 'rect').map((r) => ({ x: Number(r.x), y: Number(r.y), w: Number(r.width), h: Number(r.height), stroke: r.stroke }));

test('a running agent\'s and a running unit\'s frame carry the accent, with motion or not; idle, reported and the orchestrator\'s do not', () => {
  const state = stateOf([agent('a1'), agent('a2', { status: 'reported' })], { grok: running('main'), codex: running('other') });
  for (const animate of [false, true]) {
    const { source } = svgOf(state, { tzOffsetAt: UTC, animate });
    const accent = rectsOf(source).filter((r) => r.stroke === ACCENT);
    // a1, grok, codex run; the orchestrator, a2 and gemini do not
    assert.equal(accent.length, 3, `animate=${animate}`);
    assert.equal(rectsOf(source).length, 6);
  }
});

test('links run caller to callee: the orchestrator to the agent it spawned, a parent agent to its child, the orchestrator to a unit', () => {
  const state = stateOf([agent('a1'), agent('a2', { parentId: 'a1' })], { grok: running('main') });
  const { source } = svgOf(state, { tzOffsetAt: UTC });
  const rects = rectsOf(source);
  const texts = [...source.matchAll(/<text x="([\d.]+)" y="([\d.]+)">([^<]*)<\/text>/g)].map(([, x, y, body]) => ({ x: Number(x), y: Number(y), body }));
  const boxNamed = (name) => rects.find((r) => texts.some((t) => t.body.endsWith(` ${name}`) && t.x >= r.x && t.x <= r.x + r.w && t.y >= r.y && t.y <= r.y + r.h));
  const [orch, a1, a2, grok] = ['orchestrator', 'a1', 'a2', 'grok'].map(boxNamed);
  const top = (r) => ({ x: r.x + r.w / 2, y: r.y });
  const bottom = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h });
  const ends = [
    ...tags(source, 'line').map((l) => ({ a: { x: Number(l.x1), y: Number(l.y1) }, b: { x: Number(l.x2), y: Number(l.y2) } })),
    ...tags(source, 'path').map((p) => {
      const nums = [...p.d.matchAll(/(-?[\d.]+)/g)].map((m) => Number(m[1]));
      return { a: { x: nums[0], y: nums[1] }, b: { x: nums.at(-2), y: nums.at(-1) } };
    }),
  ];
  const has = (a, b) => ends.some((e) => Math.abs(e.a.x - a.x) < 0.5 && Math.abs(e.a.y - a.y) < 0.5 && Math.abs(e.b.x - b.x) < 0.5 && Math.abs(e.b.y - b.y) < 0.5);
  assert.ok(has(top(orch), bottom(a1)), 'orchestrator → a1');
  assert.ok(has(top(a1), top(a2)), 'a1 → its child a2');
  assert.ok(has(bottom(orch), top(grok)), 'orchestrator → grok');
});

test('the motion CSS is coherent: the flow targets the class the live links carry, loops seamlessly in the direction of the line, and the pulse targets the accent frames', () => {
  const { source } = svgOf(stateOf([agent('a1')], { grok: running('main') }), { tzOffsetAt: UTC, animate: true });
  const css = source.match(/<style>(.*)<\/style>/)[1];
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\)\{\.live\{/);
  assert.ok(tags(source, 'line').some((l) => l.class === 'live'), 'a link carries the class the CSS selects');
  const [, on, off] = css.match(/stroke-dasharray:(\d+) (\d+)/);
  const [, offset] = css.match(/@keyframes fleet-flow\{to\{stroke-dashoffset:(-?\d+)\}/);
  assert.equal(Number(offset), -(Number(on) + Number(off)), 'a negative offset of one dash period: the dashes run from the line\'s start to its end, and the loop is seamless');
  const [, accent] = css.match(/rect\[stroke="([^"]+)"\]\{animation:fleet-pulse/);
  assert.equal(accent, ACCENT, 'the pulse selects the accent frames, not every frame');
  assert.equal(rectsOf(source).filter((r) => r.stroke === accent).length, 2, 'the agent and the unit that run');
});

// ---------------------------------------------------------------------------
// The alt

test('the alt is drawn at the SVG\'s own width whatever the agents: none, one or two (53 cells), four and five with a long history label (no cell lost to the width), ten (the fold is in it)', () => {
  const label = 'a history label far too long to fit any pane at all, so the width it is cut at shows';
  for (const count of [0, 1, 2, 4, 5, 10]) {
    const agents = Array.from({ length: count }, (_, i) => agent(`a${i + 1}`));
    const state = stateOf(agents, {}, { history: [{ at: NOW - MIN, from: 'main', to: 'unit:grok', label }] });
    const { source, alt } = svgOf(state, { tzOffsetAt: UTC });
    const shown = Math.min(count, count > 6 ? 6 : count);
    const width = Math.max(53, shown * 18 - 1);
    assert.equal(alt, plainRows(layout(state, { columns: width, rows: 40, isAscii: false, tzOffsetAt: UTC })).join('\n'), `${count} agents`);
    assert.ok(alt.length > 0);
    const imageAgents = rectsOf(source).length - 4;
    const altTops = (alt.split('\n').find((row) => row.includes('┌')) ?? '').split('┌').length - 1;
    if (count > 0) assert.equal(altTops, imageAgents, `${count} agents: as many boxes in the alt as in the image`);
  }
});
