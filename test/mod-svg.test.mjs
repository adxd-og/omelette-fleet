/**
 * omelette-fleet :: test/mod-svg.test.mjs
 * The fleet pane's desktop drawing (1.7.0, Task 4): mods/omelette-fleet/hooks/svg.mjs
 * draws the fleet model as one SVG document — a box per actor, a line per
 * link, the live ones marked — with the terminal's drawing as its alt text.
 * Ids and times are made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, plainRows } from '../mods/omelette-fleet/hooks/layout.mjs';
import { svgOf } from '../mods/omelette-fleet/hooks/svg.mjs';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 8, 9, 6, 0);
const UTC = () => 0;

/** The plan's golden state: three agents, grok running from the orchestrator, gemini idle 12 minutes, codex never ran. */
function golden() {
  return {
    now: NOW,
    isOpen: true,
    usage: { contextPercent: 31, fiveHour: 11, sevenDay: 71, costUsd: 646 },
    history: [],
    nodes: [
      { id: 'main', kind: 'orchestrator', role: 'orchestrator', model: 'claude-fable-5-1', effort: 'high', status: 'running', since: NOW - 10 * MIN, order: 0 },
      { id: 'unit:gemini', kind: 'unit', role: 'gemini', status: 'idle', since: NOW - HOUR, feed: 'ok', lastEndedAt: NOW - 12 * MIN, order: 1 },
      {
        id: 'unit:grok', kind: 'unit', role: 'grok', status: 'running', callerId: 'main', activity: 'code_review', activityCallId: 'toolu_g1',
        model: 'grok-4.7', effort: 'high', since: NOW - (2 * MIN + 17 * SEC), feed: 'ok', order: 2,
        openCalls: [{ callId: 'toolu_g1', callerId: 'main', tool: 'code_review', since: NOW - (2 * MIN + 17 * SEC) }],
      },
      { id: 'unit:codex', kind: 'unit', role: 'codex', status: 'idle', since: NOW - HOUR, feed: 'ok', order: 3 },
      { id: 'a-coder', kind: 'agent', role: 'omelette-coder-medium', parentId: 'main', model: 'claude-opus-5-5', effort: 'medium', status: 'running', activity: 'Bash: npm test', activityCallId: 'toolu_c1', since: NOW - MIN, order: 4 },
      { id: 'a-tester', kind: 'agent', role: 'omelette-tester', parentId: 'main', model: 'claude-sonnet-5-5', effort: 'high', status: 'reported', since: NOW - (3 * MIN + 10 * SEC), order: 5 },
      { id: 'a-reviewer', kind: 'agent', role: 'omelette-reviewer', parentId: 'main', model: 'claude-opus-5-5', effort: 'xhigh', status: 'running', activity: 'Read models.js', activityCallId: 'toolu_r1', since: NOW - 30 * SEC, order: 6 },
    ],
  };
}

/** `state` with the node `id` patched. */
const patch = (state, id, fields) => ({ ...state, nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...fields } : n)) });

const attrsOf = (text) => Object.fromEntries([...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));

/** The attributes of every `<name …>` tag in `source`. */
const tags = (source, name) => [...source.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'g'))].map(([, attrs]) => attrsOf(attrs));

const unescape = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** The drawing's boxes: each rect with the text lines inside it, top to bottom; `name` is the first line without its glyph. */
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


/** Hand-built states: the orchestrator, the three units (`units` patches them by name), `agents`. */
const unitNode = (name, order, fields = {}) => ({ id: `unit:${name}`, kind: 'unit', role: name, status: 'idle', since: NOW, feed: 'ok', order, ...fields });
const agent = (id, fields = {}) => ({ id, kind: 'agent', role: `omelette-${id}`, parentId: 'main', status: 'running', since: NOW - MIN, order: 10 + Number(id.replace(/\D/g, '') || 0), ...fields });
const call = (callerId, tool = 'review', callId = `${callerId}:${tool}`) => ({ callId, callerId, tool, since: NOW - MIN });
const running = (callerId, ...callers) => ({ status: 'running', callerId, activity: 'review', openCalls: callers.map((c) => call(c)) });
function stateOf(agents = [], units = {}, extra = {}) {
  return {
    now: NOW, isOpen: true, usage: {}, history: [], ...extra,
    nodes: [
      { id: 'main', kind: 'orchestrator', role: 'orchestrator', status: 'running', since: NOW, order: 0 },
      ...['gemini', 'grok', 'codex'].map((name, i) => unitNode(name, i + 1, units[name])),
      ...agents,
    ],
  };
}

const pairs = (state) => linksOf(svgOf(state, { tzOffsetAt: UTC }).source).map((l) => `${l.pair}${l.isLive ? ' (live)' : ''}`).sort();
/** Every rect with its stroke. */
const rectsOf = (source) => tags(source, 'rect').map((r) => ({ x: Number(r.x), y: Number(r.y), w: Number(r.width), h: Number(r.height), stroke: r.stroke }));
const ACCENT = '#d97757';

test('the golden state: one <rect> per node, one line or path per link — each agent to the orchestrator, the orchestrator to grok', () => {
  const { source } = svgOf(golden(), { tzOffsetAt: UTC });
  assert.equal(tags(source, 'rect').length, golden().nodes.length);
  assert.deepEqual(linksOf(source).map((l) => l.pair).sort(), [
    'coder-medium – orchestrator',
    'grok – orchestrator',
    'orchestrator – reviewer',
    'orchestrator – tester',
  ]);
});

test('class="live" marks exactly the live links: a running agent\'s, and a caller\'s to a unit in flight — a sub-agent\'s call a real line from its box', () => {
  const liveOf = (state) => {
    const { source } = svgOf(state, { tzOffsetAt: UTC });
    const live = linksOf(source).filter((l) => l.isLive).map((l) => l.pair).sort();
    assert.equal(source.match(/class="live"/g)?.length ?? 0, live.length, 'no other element carries the class');
    return live;
  };
  assert.deepEqual(liveOf(golden()), ['coder-medium – orchestrator', 'grok – orchestrator', 'orchestrator – reviewer']);

  const fromCoder = patch(golden(), 'unit:grok', { callerId: 'a-coder', openCalls: [{ callId: 'toolu_g1', callerId: 'a-coder', tool: 'code_review', since: NOW - MIN }] });
  assert.deepEqual(liveOf(fromCoder), ['coder-medium – grok', 'coder-medium – orchestrator', 'orchestrator – reviewer']);
  assert.deepEqual(linksOf(svgOf(fromCoder, { tzOffsetAt: UTC }).source).filter((l) => !l.isLive).map((l) => l.pair), ['orchestrator – tester']);
});

test('strings from outside are cleaned, then XML-escaped (& < > " \'): the document holds only its own elements, balanced, with no script, foreignObject, event attribute or external reference', () => {
  let state = patch(golden(), 'a-coder', { role: 'omelette-<script>&"\'', activity: '<g onload="x">' });
  state = patch(state, 'a-reviewer', { model: 'claude-<m>&\u001b[31m', effort: '\'e"\u0007' });
  state = patch(state, 'unit:grok', { activity: '<t>&\u202e\'', model: '</svg>\uD800' });
  state = patch(state, 'main', { model: 'claude-<o>"', effort: '<foreignObject>' });
  const { source } = svgOf(state, { tzOffsetAt: UTC });

  assert.doesNotMatch(source, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/, 'no control or bidi character');
  assert.doesNotMatch(source, /[\uD800-\uDFFF]/u, 'no lone surrogate');
  for (const escaped of ['&lt;script&gt;&amp;&quot;&#39;', '&lt;g onload=&quot;x&quot;&gt;', '&lt;m&gt;&amp;[31m · &#39;e&quot;', '&lt;t&gt;&amp;&#39;', '&lt;/svg&gt; 2:17', '&lt;o&gt;&quot; · &lt;foreignObj']) {
    assert.ok(source.includes(escaped), escaped);
  }

  const TAG = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w:-]+="[^"<>]*")*)\s*(\/?)>/g;
  const open = [];
  for (const [, close, name, attrs, selfClose] of source.matchAll(TAG)) {
    assert.ok(['svg', 'style', 'g', 'rect', 'text', 'line', 'path'].includes(name), name);
    for (const [, attr] of attrs.matchAll(/([\w:-]+)=/g)) assert.doesNotMatch(attr, /^on|href$/i, attr);
    if (close) assert.equal(open.pop(), name);
    else if (!selfClose) open.push(name);
  }
  assert.deepEqual(open, [], 'every element closed');
  const between = source.replace(TAG, '');
  assert.doesNotMatch(between, /[<>]/);
  assert.doesNotMatch(between.replace(/&(?:amp|lt|gt|quot|#39);/g, ''), /&/, 'every & starts an entity');
  assert.equal(source.split('://').length - 1, 1, 'the one URI is the SVG namespace');
  assert.doesNotMatch(source, /url\(|@import/);
});

test('forty agents, each role a run of 30 000 combining marks: at most six agent boxes (the fold), and the source stays under 131 072 characters', () => {
  const marks = '\u0301'.repeat(30_000);
  const agents = Array.from({ length: 40 }, (_, i) => ({
    id: `a${i}`, kind: 'agent', role: `omelette-r${i}${marks}`, parentId: 'main', status: i < 2 ? 'running' : 'reported', since: NOW - (40 - i) * MIN, order: 10 + i,
  }));
  const state = { ...golden(), nodes: [...golden().nodes.filter((n) => n.kind !== 'agent'), ...agents] };
  const { source } = svgOf(state, { tzOffsetAt: UTC });
  assert.ok(source.length < 131_072, `${source.length} characters`);
  const boxes = boxesOf(source);
  assert.equal(boxes.length, 1 + 3 + 6);
  assert.ok(boxes.some((b) => b.lines[0] === '+35 more'));
});

test('alt is the terminal drawing at 53 columns and 40 rows, history included, each time in the zone it fell in', () => {
  const state = {
    ...golden(),
    history: [
      { at: NOW - 5 * MIN, from: 'main', to: 'a-coder', label: 'Agent' },
      { at: NOW - MIN, from: 'main', to: 'unit:grok', label: 'code_review' },
    ],
  };
  const tzOffsetAt = (at) => (at < NOW - 2 * MIN ? -180 : -120);
  const { alt } = svgOf(state, { tzOffsetAt });
  assert.equal(alt, plainRows(layout(state, { columns: 53, rows: 40, isAscii: false, tzOffsetAt })).join('\n'));
  assert.ok(alt.includes('12:01:00 orchestrator → coder-medium · Agent'), alt);
  assert.ok(alt.includes('11:05:00 orchestrator → grok · code_review'), alt);
});

test('a unit with several open calls shows <tool> ×N on one link; one another session calls shows ← other and has no link', () => {
  const two = patch(golden(), 'unit:grok', {
    openCalls: [
      { callId: 'toolu_g0', callerId: 'main', tool: 'code_review', since: NOW - 3 * MIN },
      { callId: 'toolu_g1', callerId: 'main', tool: 'code_review', since: NOW - (2 * MIN + 17 * SEC) },
    ],
  });
  const twoSource = svgOf(two, { tzOffsetAt: UTC }).source;
  assert.deepEqual(boxesOf(twoSource).find((b) => b.name === 'grok').lines, ['▶ grok', 'code_review ×2', 'grok-4.7 2:17']);
  assert.equal(linksOf(twoSource).filter((l) => l.pair.includes('grok')).length, 1);

  const other = patch(golden(), 'unit:grok', { callerId: 'other', openCalls: undefined });
  const { source } = svgOf(other, { tzOffsetAt: UTC });
  assert.deepEqual(boxesOf(source).find((b) => b.name === 'grok').lines, ['▶ grok', 'code_review', '← other']);
  assert.ok(linksOf(source).every((l) => !l.pair.includes('grok')));
});

test('motion: with animate, the dash flow and the pulse sit only inside the reduced-motion query; without it there is none, and nothing else differs', () => {
  const still = svgOf(golden(), { tzOffsetAt: UTC }).source;
  const moving = svgOf(golden(), { tzOffsetAt: UTC, animate: true }).source;
  for (const word of ['animation', '@keyframes', 'stroke-dasharray', 'prefers-reduced-motion']) assert.ok(!still.includes(word), `still: ${word}`);
  const QUERY = '@media (prefers-reduced-motion: no-preference){';
  const start = moving.indexOf(QUERY);
  assert.ok(start >= 0, 'the query');
  let depth = 0;
  let end = -1;
  for (let i = start + QUERY.length - 1; i < moving.length && end < 0; i++) {
    if (moving[i] === '{') depth += 1;
    else if (moving[i] === '}' && --depth === 0) end = i;
  }
  const inside = moving.slice(start, end + 1);
  const outside = moving.slice(0, start) + moving.slice(end + 1);
  for (const word of ['animation', '@keyframes', 'stroke-dasharray', 'stroke-dashoffset']) {
    assert.ok(inside.includes(word), `inside: ${word}`);
    assert.ok(!outside.includes(word), `outside: ${word}`);
  }
  assert.equal(outside, still, 'the accent frames and every element are the same either way');
});

test('an idle box is dim: its group carries the half opacity', () => {
  const { source } = svgOf(golden(), { tzOffsetAt: UTC });
  const groupOf = (name) => source.match(new RegExp(`<g([^>]*)><rect[^>]*/><text[^>]*>[^<]* ${name}</text>`))?.[1];
  assert.equal(groupOf('gemini'), ' opacity="0.5"');
  assert.equal(groupOf('codex'), ' opacity="0.5"');
  assert.equal(groupOf('grok'), '', 'a running one is not');
});

test('alt is the terminal drawing at the columns that show every box the image shows: five agents, five boxes in both', () => {
  const agents = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, kind: 'agent', role: `omelette-role${i}`, parentId: 'main', status: 'running', since: NOW - MIN, order: 10 + i }));
  const state = { ...golden(), nodes: [...golden().nodes.filter((n) => n.kind !== 'agent'), ...agents] };
  const { source, alt } = svgOf(state, { tzOffsetAt: UTC });
  assert.equal(alt, plainRows(layout(state, { columns: 89, rows: 40, isAscii: false, tzOffsetAt: UTC })).join('\n'));
  for (let i = 0; i < 5; i++) {
    assert.ok(boxesOf(source).some((b) => b.name === `role${i}`), `the image draws role${i}`);
    assert.ok(alt.includes(`▶ role${i}`), `the alt holds role${i}`);
  }
  assert.ok(!alt.includes(' more'), 'no fold in the alt where the image has none');
});

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

test('a running agent\'s and a running unit\'s frame carry the accent, with motion or not; idle, reported and the orchestrator\'s do not', () => {
  const state = stateOf([agent('a1'), agent('a2', { status: 'reported' })], { grok: running('main', 'main'), codex: running('other', 'other') });
  for (const animate of [false, true]) {
    const { source } = svgOf(state, { tzOffsetAt: UTC, animate });
    const accent = rectsOf(source).filter((r) => r.stroke === ACCENT);
    // a1, grok, codex run; the orchestrator, a2 and gemini do not
    assert.equal(accent.length, 3, `animate=${animate}`);
    assert.equal(rectsOf(source).length, 6);
  }
});

test('links run caller to callee: the orchestrator to the agent it spawned, a parent agent to its child, the orchestrator to a unit', () => {
  const state = stateOf([agent('a1'), agent('a2', { parentId: 'a1' })], { grok: running('main', 'main') });
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
  const { source } = svgOf(stateOf([agent('a1')], { grok: running('main', 'main') }), { tzOffsetAt: UTC, animate: true });
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
