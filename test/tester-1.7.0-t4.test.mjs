/**
 * omelette-fleet :: test/tester-1.7.0-t4.test.mjs
 * Tester's tests for 1.7.0 Task 4 (the desktop drawing): what the implementer's
 * tests leave to a mutant — the characters XML cannot carry, the fold's and the
 * nested agents' links, the sub-agent call paths, the drawing staying inside its
 * viewBox. They parse the document svgOf returns; none reads a source file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, plainRows } from '../mods/omelette-fleet/hooks/layout.mjs';
import { svgOf } from '../mods/omelette-fleet/hooks/svg.mjs';

const SEC = 1000;
const MIN = 60 * SEC;
const NOW = Date.UTC(2026, 9, 8, 9, 6, 0);
const UTC = () => 0;

const unitNode = (name, order, fields = {}) => ({ id: `unit:${name}`, kind: 'unit', role: name, status: 'idle', since: NOW, feed: 'ok', order, ...fields });
const agent = (id, fields = {}) => ({ id, kind: 'agent', role: `omelette-${id}`, parentId: 'main', status: 'running', since: NOW - MIN, order: 10 + Number(id.replace(/\D/g, '') || 0), ...fields });
const call = (callerId, tool = 'review', callId = `${callerId}:${tool}`) => ({ callId, callerId, tool, since: NOW - MIN });
const running = (callerId, ...callers) => ({ status: 'running', callerId, activity: 'review', openCalls: callers.map((c) => call(c)) });

/** A state: the orchestrator, the three units (`units` patches them by name), `agents`. */
function stateOf(agents = [], units = {}) {
  return {
    now: NOW, isOpen: true, usage: {}, history: [],
    nodes: [
      { id: 'main', kind: 'orchestrator', role: 'orchestrator', status: 'running', since: NOW, order: 0 },
      ...['gemini', 'grok', 'codex'].map((name, i) => unitNode(name, i + 1, units[name])),
      ...agents,
    ],
  };
}

const attrsOf = (text) => Object.fromEntries([...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
const tags = (source, name) => [...source.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'g'))].map(([, attrs]) => attrsOf(attrs));
const unescape = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function boxesOf(source) {
  const texts = [...source.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map(([, attrs, body]) => {
    const { x, y } = attrsOf(attrs);
    return { x: Number(x), y: Number(y), body: unescape(body) };
  });
  return tags(source, 'rect').map((rect) => {
    const [x, y, w, h] = [rect.x, rect.y, rect.width, rect.height].map(Number);
    const lines = texts.filter((t) => t.x >= x && t.x <= x + w && t.y >= y && t.y <= y + h).sort((a, b) => a.y - b.y).map((t) => t.body);
    return { x, y, w, h, lines, name: (lines[0] ?? '').replace(/^[●▶◌·] /, '') };
  });
}

/** A path's points: each M, L, H, V, Q command's end point, in order, plus the Q controls. */
function pointsOf(d) {
  let x = 0;
  let y = 0;
  const points = [];
  const controls = [];
  for (const [, command, args] of d.matchAll(/([MLHVQ])([^MLHVQ]*)/g)) {
    const n = args.trim().split(/[\s,]+/).map(Number);
    if (command === 'H') x = n[0];
    else if (command === 'V') y = n[0];
    else {
      if (command === 'Q') controls.push({ x: n[0], y: n[1] });
      [x, y] = n.slice(-2);
    }
    points.push({ x, y, command });
  }
  return { points, controls };
}

/** Every link: its end points, the names of the boxes the ends touch (top or bottom centre), whether live, and its path points. */
function linksOf(source) {
  const boxes = boxesOf(source);
  const at = ({ x, y }) => boxes.find((b) => Math.abs(b.x + b.w / 2 - x) < 0.5 && (Math.abs(b.y - y) < 0.5 || Math.abs(b.y + b.h - y) < 0.5))?.name;
  const lines = tags(source, 'line').map((l) => ({ pts: [{ x: Number(l.x1), y: Number(l.y1), command: 'M' }, { x: Number(l.x2), y: Number(l.y2), command: 'L' }], controls: [], isLive: l.class === 'live', kind: 'line' }));
  const paths = tags(source, 'path').map((p) => ({ ...(({ points, controls }) => ({ pts: points, controls }))(pointsOf(p.d)), isLive: p.class === 'live', kind: 'path' }));
  return [...lines, ...paths].map(({ pts, controls, isLive, kind }) => ({
    pair: [at(pts[0]), at(pts.at(-1))].sort().join(' – '), from: at(pts[0]), to: at(pts.at(-1)), isLive, pts, controls, kind,
  }));
}

const pairs = (state) => linksOf(svgOf(state, { tzOffsetAt: UTC }).source).map((l) => `${l.pair}${l.isLive ? ' (live)' : ''}`).sort();

// ---------------------------------------------------------------------------

test('every character the document holds is one XML 1.0 can carry: U+FFFE, U+FFFF, lone surrogates, controls and bidi marks are gone, a valid astral pair stays, an already-escaped & is escaped again', () => {
  // each short enough to survive the cut to a box
  const A = 'a\uFFFEb\uFFFFc';
  const B = 'd\uD800e\uDC00f';
  const C = 'g\u202eh\u0085i\u007fj\u0000k';
  const D = '\u{1F600}]]>&amp;';
  let state = stateOf([agent('a1', { role: `omelette-${A}`, model: B, effort: 'x', activity: D })], { grok: { status: 'running', callerId: 'a1', activity: C, model: A, openCalls: [call('a1')] } });
  state = { ...state, nodes: state.nodes.map((n) => (n.id === 'main' ? { ...n, model: B, effort: C } : n)) };
  const { source } = svgOf(state, { tzOffsetAt: UTC });
  const bad = [...source].filter((ch) => {
    const c = ch.codePointAt(0);
    return !(c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff));
  });
  assert.deepEqual(bad.map((ch) => ch.codePointAt(0).toString(16)), [], 'no character outside the XML 1.0 Char production');
  assert.doesNotMatch(source, /[\u202a-\u202e\u2066-\u2069\u061c\u200e\u200f]/u);
  assert.ok(source.includes('>\u{1F600}]]&gt;&amp;amp;'), 'a valid astral pair stays; ]]> and an escaped & come out escaped once more');
  assert.ok(source.includes('abc'), 'the non-characters are dropped, the text around them kept');
});

test('hostile strings never leave the element text: the document has the expected elements and attributes only, every attribute value a number or a constant', () => {
  const hostile = '"><script>alert(1)</script><a href="http://x" onload="y">\'&';
  const state = stateOf(
    [agent('a1', { role: `omelette-${hostile}`, parentId: hostile, model: hostile, effort: hostile, activity: hostile }), agent(hostile, { role: hostile, parentId: 'a1' })],
    { grok: { status: 'running', callerId: hostile, activity: hostile, model: hostile, openCalls: [call(hostile), call('a1')] } },
  );
  const { source } = svgOf(state, { tzOffsetAt: UTC });
  const allowed = { svg: ['xmlns', 'width', 'height', 'viewBox', 'font-family', 'font-size', 'fill'], style: [], g: ['opacity'], rect: ['x', 'y', 'width', 'height', 'rx', 'fill', 'stroke'], text: ['x', 'y'], line: ['x1', 'y1', 'x2', 'y2', 'class', 'stroke', 'stroke-width', 'stroke-opacity'], path: ['d', 'fill', 'class', 'stroke', 'stroke-width', 'stroke-opacity'] };
  const TAG = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:-]+="[^"<>]*")*)\s*(\/?)>/g;
  const open = [];
  for (const [, close, name, attrs, selfClose] of source.matchAll(TAG)) {
    assert.ok(Object.hasOwn(allowed, name), `element ${name}`);
    for (const [attr, value] of Object.entries(attrsOf(attrs))) {
      assert.ok(allowed[name].includes(attr), `${name}@${attr}`);
      if (!['xmlns', 'font-family', 'fill', 'stroke', 'class', 'viewBox', 'd'].includes(attr)) assert.match(value, /^-?[\d.]+$/, `${name}@${attr}=${value}`);
    }
    if (close) assert.equal(open.pop(), name);
    else if (!selfClose) open.push(name);
  }
  assert.deepEqual(open, []);
  const between = source.replace(TAG, '').replace(/<style>[^<]*<\/style>/, '');
  assert.doesNotMatch(between, /[<>]/, 'no markup character outside a tag');
  assert.doesNotMatch(between.replace(/&(?:amp|lt|gt|quot|#39);/g, ''), /&/);
  assert.doesNotMatch(source, /<script|href=|onload=|<foreignObject/i);
});

test('the fold box is linked to the orchestrator, live exactly when a folded agent runs', () => {
  const eight = (runningHidden) => Array.from({ length: 8 }, (_, i) => agent(`a${i + 1}`, { status: i < 5 || (runningHidden && i === 7) ? 'running' : 'reported', since: NOW - (20 - i) * MIN }));
  for (const runningHidden of [false, true]) {
    const source = svgOf(stateOf(eight(runningHidden)), { tzOffsetAt: UTC }).source;
    const fold = boxesOf(source).find((b) => /^\+\d+ more$/.test(b.lines[0]));
    assert.ok(fold, 'a fold box');
    const toFold = linksOf(source).filter((l) => l.pair.includes(fold.name));
    assert.equal(toFold.length, 1, 'one link from the fold');
    assert.equal(toFold[0].pair, `${fold.name} – orchestrator`);
    assert.equal(toFold[0].isLive, runningHidden, `fold link live=${runningHidden}`);
  }
});

test('nested agents: a child is linked to its parent agent, not to the orchestrator; a self-parent or an unknown parent hangs on the orchestrator', () => {
  const nested = stateOf([agent('a1'), agent('a2', { parentId: 'a1' }), agent('a3', { parentId: 'a2', status: 'reported' }), agent('a4', { parentId: 'a4' }), agent('a5', { parentId: 'ghost' })]);
  assert.deepEqual(pairs(nested), [
    'a1 – a2 (live)', 'a1 – orchestrator (live)', 'a2 – a3', 'a4 – orchestrator (live)', 'a5 – orchestrator (live)',
  ]);
});

test('a child whose parent agent is folded away is linked to the fold box', () => {
  // a1 reported long ago and folded; a2..a6 run and are shown; a7 runs and is folded with it.
  const agents = [agent('a1', { status: 'reported', since: NOW - 60 * MIN })];
  for (let i = 2; i <= 7; i += 1) agents.push(agent(`a${i}`, i === 2 ? { parentId: 'a1' } : {}));
  const source = svgOf(stateOf(agents), { tzOffsetAt: UTC }).source;
  const fold = boxesOf(source).find((b) => /^\+\d+ more$/.test(b.lines[0]));
  assert.ok(fold && fold.lines[0] === '+2 more', fold?.lines[0]);
  const links = linksOf(source);
  assert.ok(links.some((l) => l.pair === [fold.name, 'a2'].sort().join(' – ') && l.isLive), links.map((l) => l.pair).join('; '));
  assert.equal(links.filter((l) => l.pair.includes('a2')).length, 1);
});

test('a call to a unit from two callers draws one link each (the orchestrator straight, the agent around); one caller with two calls draws one', () => {
  const both = stateOf([agent('a1')], { grok: running('a1', 'main', 'a1') });
  assert.deepEqual(pairs(both), ['a1 – grok (live)', 'a1 – orchestrator (live)', 'grok – orchestrator (live)']);
  const twice = stateOf([agent('a1')], { grok: { status: 'running', callerId: 'a1', activity: 'x', openCalls: [call('a1', 'x', '1'), call('a1', 'y', '2')] } });
  assert.deepEqual(pairs(twice), ['a1 – grok (live)', 'a1 – orchestrator (live)']);
});

test('a call from an agent folded into the fold box is drawn from the fold box; from an id no box draws, not at all', () => {
  const agents = Array.from({ length: 8 }, (_, i) => agent(`a${i + 1}`, { status: i < 5 ? 'running' : 'reported', since: NOW - (20 - i) * MIN }));
  const fromHidden = svgOf(stateOf(agents, { codex: running('a8', 'a8') }), { tzOffsetAt: UTC }).source;
  const fold = boxesOf(fromHidden).find((b) => /^\+\d+ more$/.test(b.lines[0]));
  assert.ok(linksOf(fromHidden).some((l) => l.pair === [fold.name, 'codex'].sort().join(' – ') && l.isLive));
  const fromGhost = svgOf(stateOf(agents, { codex: running('ghost', 'ghost') }), { tzOffsetAt: UTC }).source;
  assert.ok(linksOf(fromGhost).every((l) => !l.pair.includes('codex')));
});

test('an idle unit draws no call link even if a stale openCalls or callerId is left on it', () => {
  const state = stateOf([agent('a1')], { grok: { status: 'idle', callerId: 'a1', openCalls: [call('a1')] } });
  assert.ok(pairs(state).every((p) => !p.includes('grok')), pairs(state).join('; '));
});

/** The axis-aligned segments of a path, in order, as [x1, y1, x2, y2]. */
function segmentsOf(pts) {
  return pts.slice(1).map((p, i) => [pts[i].x, pts[i].y, p.x, p.y]);
}

test('sub-agent call paths: every link and box lies inside the viewBox, each path runs down the page, and no two paths share a middle segment', () => {
  const agents = [agent('a1'), agent('a2'), agent('a3', { parentId: 'a1' }), agent('a4', { parentId: 'a3' }), agent('a5'), agent('a6', { status: 'reported' })];
  const all = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const state = stateOf(agents, { gemini: running('a1', ...all), grok: running('a2', ...all, 'main'), codex: running('a3', ...all) });
  const { source, width, height } = svgOf(state, { tzOffsetAt: UTC });
  const view = source.match(/viewBox="0 0 (\d+) (\d+)"/);
  assert.deepEqual(view.slice(1).map(Number), [width, height]);
  for (const b of boxesOf(source)) assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= width && b.y + b.h <= height, `box ${b.name} outside`);

  const links = linksOf(source);
  assert.ok(links.filter((l) => l.kind === 'path' && l.to && ['gemini', 'grok', 'codex'].includes(l.to)).length >= 15, 'a path per (agent, unit)');
  for (const l of links) {
    for (const p of l.pts) assert.ok(p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height, `${l.pair}: point ${p.x},${p.y} outside`);
    // a quadratic's peak is a quarter of the ends plus half the control.
    l.controls.forEach((c, i) => {
      const peak = (l.pts[0].y + 2 * c.y + l.pts[i + 1].y) / 4;
      assert.ok(peak >= 0, `${l.pair}: arc peaks at ${peak}`);
    });
  }
  const around = links.filter((l) => l.kind === 'path' && l.controls.length === 0);
  for (const l of around) {
    const ys = l.pts.filter((p) => p.command === 'M' || p.command === 'V').map((p) => p.y);
    assert.deepEqual(ys, [...ys].sort((a, b) => a - b), `${l.pair}: its vertical steps run down`);
    assert.equal(new Set(ys).size, ys.length, `${l.pair}: no vertical step of zero length`);
  }
  const middle = around.map((l) => segmentsOf(l.pts).slice(1, -1));
  const overlap = ([ax1, ay1, ax2, ay2], [bx1, by1, bx2, by2]) => {
    if (ay1 === ay2 && by1 === by2) return ay1 === by1 && Math.min(Math.max(ax1, ax2), Math.max(bx1, bx2)) > Math.max(Math.min(ax1, ax2), Math.min(bx1, bx2));
    if (ax1 === ax2 && bx1 === bx2) return ax1 === bx1 && Math.min(Math.max(ay1, ay2), Math.max(by1, by2)) > Math.max(Math.min(ay1, ay2), Math.min(by1, by2));
    return false;
  };
  for (let i = 0; i < middle.length; i += 1) {
    for (let j = i + 1; j < middle.length; j += 1) {
      for (const a of middle[i]) for (const b of middle[j]) assert.ok(!overlap(a, b), `${around[i].pair} and ${around[j].pair} share ${a} / ${b}`);
    }
  }
});

test('a state with no agents, no usage and a unit called by the orchestrator: one straight live link, the viewBox as wide as the units', () => {
  const state = stateOf([], { grok: running('main', 'main') });
  const { source, width } = svgOf(state, { tzOffsetAt: UTC });
  assert.deepEqual(linksOf(source).map((l) => `${l.pair}${l.isLive ? ' live' : ''}`), ['grok – orchestrator live']);
  assert.equal(width, 3 * 124 + 2 * 16 + 24);
});

test('no link passes through the inside of a box, with the most sub-agent calls the fold allows', () => {
  const agents = [agent('a1'), agent('a2'), agent('a3', { parentId: 'a1' }), agent('a4', { parentId: 'a3' }), agent('a5'), agent('a6', { status: 'reported' })];
  const all = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const state = stateOf(agents, { gemini: running('a1', ...all, 'main'), grok: running('a2', ...all, 'main'), codex: running('a3', ...all, 'main') });
  const { source } = svgOf(state, { tzOffsetAt: UTC });
  const boxes = boxesOf(source);
  for (const l of linksOf(source)) {
    const samples = [];
    for (const [i, to] of l.pts.slice(1).entries()) {
      const from = l.pts[i];
      const control = to.command === 'Q' ? l.controls[l.pts.slice(1, i + 1).filter((p) => p.command === 'Q').length] : undefined;
      for (let k = 0; k <= 40; k += 1) {
        const t = k / 40;
        samples.push(control
          ? { x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t * t * to.x, y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t * t * to.y }
          : { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
      }
    }
    for (const p of samples) {
      const inside = boxes.find((b) => p.x > b.x + 0.5 && p.x < b.x + b.w - 0.5 && p.y > b.y + 0.5 && p.y < b.y + b.h - 0.5);
      assert.ok(!inside, `${l.pair} enters ${inside?.name} at ${p.x},${p.y}`);
    }
  }
});

test('a box line that is blank writes no <text>, and no <text> is empty', () => {
  const { source } = svgOf(stateOf([agent('a1', { activity: undefined })]), { tzOffsetAt: UTC });
  assert.doesNotMatch(source, /<text\b[^>]*><\/text>/);
  assert.equal(boxesOf(source).find((b) => b.name === 'codex').lines.length, 2, 'an idle unit with no last call: its name and "idle"');
});

// The 53-column alt test went with the ruling of 2026-10-08: the alt is drawn at the SVG's own width (test/mod-svg.test.mjs pins it).
