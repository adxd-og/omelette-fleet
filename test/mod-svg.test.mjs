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
    return { x, y, w, h, lines, name: lines[0].replace(/^[●▶◌·] /, '') };
  });
}

/** A path's first and last points (absolute M, L, H, V, Q, C). */
function endsOf(d) {
  let x = 0;
  let y = 0;
  let first;
  for (const [, command, args] of d.matchAll(/([MLHVQC])([^MLHVQC]*)/g)) {
    const n = args.trim().split(/[\s,]+/).map(Number);
    if (command === 'H') x = n.at(-1);
    else if (command === 'V') y = n.at(-1);
    else [x, y] = n.slice(-2);
    first ??= { x, y };
  }
  return [first, { x, y }];
}

/** The drawing's links: each line or path as the names of the boxes its ends touch (a top or bottom centre), and whether it is live. */
function linksOf(source) {
  const boxes = boxesOf(source);
  const at = ({ x, y }) => boxes.find((b) => Math.abs(b.x + b.w / 2 - x) < 0.5 && (Math.abs(b.y - y) < 0.5 || Math.abs(b.y + b.h - y) < 0.5))?.name;
  const lines = tags(source, 'line').map((l) => ({ ends: [{ x: Number(l.x1), y: Number(l.y1) }, { x: Number(l.x2), y: Number(l.y2) }], isLive: l.class === 'live' }));
  const paths = tags(source, 'path').map((p) => ({ ends: endsOf(p.d), isLive: p.class === 'live' }));
  return [...lines, ...paths].map(({ ends, isLive }) => ({ pair: ends.map(at).sort().join(' – '), isLive }));
}

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
