/**
 * omelette-fleet :: test/mod-layout.test.mjs
 * The fleet pane's terminal drawing (1.7.0, Task 3): mods/omelette-fleet/hooks/layout.mjs
 * turns the fleet model into rows of toned segments — the graph from 53 cells,
 * the tree below that or on a short pane, the history under either, the ASCII
 * form — and the status-line text. Ids and times are made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, plainRows, statusLine } from '../mods/omelette-fleet/hooks/layout.mjs';
import { cells } from '../mods/omelette-fleet/hooks/text.mjs';

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

/** `state` with `count` more agents, the first `running` of them running. */
function withAgents(state, count, running, extra = {}) {
  const agents = Array.from({ length: count }, (_, i) => ({
    id: `a${i}`, kind: 'agent', role: `omelette-role${i}`, parentId: 'main', status: i < running ? 'running' : 'reported',
    since: NOW - (count - i) * MIN, order: 10 + i, ...extra,
  }));
  return { ...state, nodes: [...state.nodes.filter((n) => n.kind !== 'agent'), ...agents] };
}

/** The tone of the cell at `col` of a row of segments. */
function toneAt(row, col) {
  let x = 0;
  for (const segment of row) {
    const width = cells(segment.text);
    if (col < x + width) return segment.tone;
    x += width;
  }
  return undefined;
}

/** Hand-built states for the motion tests: the orchestrator, the three units (`units` patches them by name), `agents`. */
const unitNode = (name, order, fields = {}) => ({ id: `unit:${name}`, kind: 'unit', role: name, status: 'idle', since: NOW - MIN, feed: 'ok', order, ...fields });
const agent = (id, fields = {}) => ({ id, kind: 'agent', role: `omelette-${id}`, parentId: 'main', status: 'running', since: NOW - MIN, order: 10 + Number(id.replace(/\D/g, '') || 0), ...fields });
const call = (callerId, callId = `${callerId}:c`) => ({ callId, callerId, tool: 'review', since: NOW - MIN });
const running = (...callers) => ({ status: 'running', callerId: callers.at(-1), activity: 'review', openCalls: callers.map((c, i) => call(c, `c${i}`)) });
const stateOf = (agents = [], units = {}) => ({
  now: NOW, isOpen: true, usage: {}, history: [],
  nodes: [{ id: 'main', kind: 'orchestrator', role: 'orchestrator', status: 'running', since: NOW - MIN, order: 0 }, ...['gemini', 'grok', 'codex'].map((name, i) => unitNode(name, i + 1, units[name])), ...agents],
});

const GOLDEN_53 = [
  'ctx 31% · 5h 11% · 7d 71%',
  '',
  '┌───────────────┐ ┌───────────────┐ ┌───────────────┐',
  '│ ▶ coder-medium│ │ · tester      │ │ ▶ reviewer    │',
  '│ opus · medium │ │ sonnet · high │ │ opus · xhigh  │',
  '│ Bash: npm test│ │ reported 3:10 │ │ Read models.js│',
  '└───────┬───────┘ └───────┬───────┘ └───────┬───────┘',
  '        └─────────────────┼─────────────────┘',
  '             ┌────────────┴────────────┐',
  '             │ ● orchestrator          │',
  '             │ fable-5-1 · high · 31%  │',
  '             └────────────┬────────────┘',
  '        ┌─────────────────┼─────────────────┐',
  '┌───────┴───────┐ ┌───────┴───────┐ ┌───────┴───────┐',
  '│ · gemini      │ │ ▶ grok        │ │ · codex       │',
  '│ idle 12m      │ │ code_review   │ │ idle          │',
  '│               │ │ grok-4.7 2:17 │ │               │',
  '└───────────────┘ └───────────────┘ └───────────────┘',
];

const TREE_35 = [
  'ctx 31% · 5h 11% · 7d 71%',
  '',
  '● orchestrator  fable-5-1 · high',
  '├ ▶ coder-medium  opus · medium',
  '│   Bash: npm test',
  '├ · tester  sonnet · high',
  '│   reported 3:10',
  '├ ▶ reviewer  opus · xhigh',
  '│   Read models.js',
  '├ · gemini  idle 12m',
  '├ ▶ grok  code_review',
  '│   grok-4.7 2:17',
  '└ · codex  idle',
];

const TREE_20 = [
  'ctx 31% · 5h 11% · …',
  '',
  '● orchestrator  fab…',
  '├ ▶ coder-medium  o…',
  '│   Bash: npm test',
  '├ · tester  sonnet …',
  '│   reported 3:10',
  '├ ▶ reviewer  opus …',
  '│   Read models.js',
  '├ · gemini  idle 12m',
  '├ ▶ grok  code_revi…',
  '│   grok-4.7 2:17',
  '└ · codex  idle',
];

test('the golden at 53 columns: the first 18 rows are the plan\'s drawing, the spinner\'s first frame in place of ▶', () => {
  const rows = layout(golden(), { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC, animate: true });
  assert.deepEqual(plainRows(rows).slice(0, 18), GOLDEN_53.map((row) => row.replaceAll('▶', '⠋')));
});

test('with animate, a running box\'s glyph is the spinner\'s frame for the model\'s clock: 250 ms on, the next frame; one of ten, ASCII one of four', () => {
  const glyphAt = (now, isAscii) => plainRows(layout({ ...golden(), now }, { columns: 53, rows: 30, isAscii, tzOffsetAt: UTC, animate: true }))[3][2];
  for (const [isAscii, frames] of [[false, [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏']], [true, [...'|/-\\']]]) {
    assert.notEqual(glyphAt(NOW, isAscii), glyphAt(NOW + 250, isAscii), `ascii=${isAscii}`);
    for (const now of [NOW, NOW + 250, NOW + 1234]) assert.ok(frames.includes(glyphAt(now, isAscii)), `ascii=${isAscii} @${now}: ${glyphAt(now, isAscii)}`);
  }
});

test('the spinner frame is exactly floor(now / 250) % n of the ten glyphs (ASCII four): 249 ms is still the same frame, a full cycle returns to it', () => {
  const state = stateOf([agent('a1')]);
  const glyphAt = (now, isAscii) => plainRows(layout({ ...state, now }, { columns: 53, rows: 30, isAscii, animate: true, tzOffsetAt: UTC })).join('\n').match(/(\S) a1/)[1];
  for (const [isAscii, frames] of [[false, [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏']], [true, [...'|/-\\']]]) {
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

test('units and agents appear in `order`, whatever the order of the nodes array', () => {
  const state = golden();
  assert.deepEqual(plainRows(layout({ ...state, nodes: [...state.nodes].reverse() }, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC })).slice(0, 18), GOLDEN_53);
});

test('plainRows joins a row\'s segments and trims its right end', () => {
  assert.deepEqual(plainRows([[{ text: 'ab ', tone: 'plain' }, { text: 'c  ', tone: 'dim' }], []]), ['ab c', '']);
});

test('71 columns with a fourth agent: four boxes, the junction under the orchestrator is ┬ and the unit bus\'s is ┼', () => {
  const state = golden();
  state.nodes.push({ id: 'a-fourth', kind: 'agent', role: 'omelette-coder', parentId: 'main', model: 'claude-opus-5-5', effort: 'xhigh', status: 'waiting', since: NOW - 5 * SEC, order: 7 });
  const rows = plainRows(layout(state, { columns: 71, rows: 30, isAscii: false, tzOffsetAt: UTC }));
  assert.equal(rows[2], '┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐');
  assert.equal(rows[3], '│ ▶ coder-medium│ │ · tester      │ │ ▶ reviewer    │ │ ◌ coder       │');
  assert.equal(rows[5], '│ Bash: npm test│ │ reported 3:10 │ │ Read models.js│ │ waiting 0:05  │');
  assert.equal(rows[7], `${' '.repeat(8)}└${'─'.repeat(17)}┴${'─'.repeat(8)}┬${'─'.repeat(8)}┴${'─'.repeat(17)}┘`);
  assert.equal(rows[7][35], '┬', 'the column under the orchestrator\'s centre');
  assert.equal(rows[8], `${' '.repeat(22)}┌${'─'.repeat(12)}┴${'─'.repeat(12)}┐`);
  assert.equal(rows[12], `${' '.repeat(17)}┌${'─'.repeat(17)}┼${'─'.repeat(17)}┐`);
  assert.equal(rows[13], `${' '.repeat(9)}┌───────┴───────┐ ┌───────┴───────┐ ┌───────┴───────┐`);
});

test('two agents: the bus reads └────────┬────────┘ under them', () => {
  const state = { ...golden(), nodes: golden().nodes.filter((n) => n.id !== 'a-reviewer') };
  const rows = plainRows(layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC }));
  assert.equal(rows[2], `${' '.repeat(9)}┌───────────────┐ ┌───────────────┐`);
  assert.equal(rows[7], `${' '.repeat(17)}└────────┬────────┘`);
  assert.equal(rows[8], '             ┌────────────┴────────────┐');
});

test('one agent: the bus row is a single │ between its box and the orchestrator', () => {
  const state = { ...golden(), nodes: golden().nodes.filter((n) => n.id !== 'a-reviewer' && n.id !== 'a-tester') };
  const rows = plainRows(layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC }));
  assert.equal(rows[6], `${' '.repeat(18)}└───────┬───────┘`);
  assert.equal(rows[7], `${' '.repeat(26)}│`);
});

test('no agents: no agent row and no upper bus; the orchestrator\'s top frame has no junction', () => {
  const state = { ...golden(), nodes: golden().nodes.filter((n) => n.kind !== 'agent') };
  const rows = plainRows(layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC }));
  assert.deepEqual(rows.slice(0, 12), ['ctx 31% · 5h 11% · 7d 71%', '', ...GOLDEN_53.slice(8, 18)].map((row, i) =>
    (i === 2 ? '             ┌─────────────────────────┐' : row)));
  assert.equal(rows.length, 12, 'no history, no blank row after the graph');
});

test('seven agents at 53 columns, the two running ones the oldest: both shown, the third box +5 more', () => {
  const state = withAgents(golden(), 7, 2);
  const rows = plainRows(layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC }));
  assert.equal(rows[3], '│ ▶ role0       │ │ ▶ role1       │ │ +5 more       │');
  assert.equal(rows[4].slice(36), '│               │', 'no hidden one runs: line two blank');
  assert.equal(rows[5], '│               │ │               │ │               │', 'running with no call out: line three blank');
});

test('the fold keeps running and waiting ones first, then the newest reported; within the row boxes keep their order', () => {
  // a0..a6: a5 runs, a2 waits, the rest reported; a6 is the newest reported.
  let state = withAgents(golden(), 7, 0);
  state = patch(state, 'a5', { status: 'running' });
  state = patch(state, 'a2', { status: 'waiting' });
  const rows = plainRows(layout(state, { columns: 71, rows: 30, isAscii: false, tzOffsetAt: UTC }));
  assert.equal(rows[3], '│ ◌ role2       │ │ ▶ role5       │ │ · role6       │ │ +4 more       │');
});

test('a hidden running agent: the +N more box says how many run, and its link is live', () => {
  const state = withAgents(golden(), 7, 3);
  const laid = layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC });
  const rows = plainRows(laid);
  assert.equal(rows[3], '│ ▶ role0       │ │ ▶ role1       │ │ +5 more       │');
  assert.equal(rows[4].slice(36), '│ 1 running     │');
  assert.equal(toneAt(laid[6], 44), 'live', 'the more box\'s junction');
  for (let col = 26; col <= 44; col++) assert.equal(toneAt(laid[7], col), 'live', `bus col ${col}`);
});

test('the tree golden at 35 columns', () => {
  const rows = plainRows(layout(golden(), { columns: 35, rows: 40, isAscii: false, tzOffsetAt: UTC }));
  assert.deepEqual(rows, TREE_35);
});

test('the tree golden at 20 columns: every row cut by cells, none wider than 20', () => {
  const rows = plainRows(layout(golden(), { columns: 20, rows: 40, isAscii: false, tzOffsetAt: UTC }));
  assert.deepEqual(rows, TREE_20);
  for (const row of rows) assert.ok(cells(row) <= 20, row);
});

test('a pane of 8 rows at 80 columns: the tree, not the graph, eight rows, the last … +N', () => {
  const rows = plainRows(layout(golden(), { columns: 80, rows: 8, isAscii: false, tzOffsetAt: UTC }));
  assert.deepEqual(rows, [
    'ctx 31% · 5h 11% · 7d 71%',
    '',
    '● orchestrator  fable-5-1 · high',
    '├ ▶ coder-medium  opus · medium',
    '│   Bash: npm test',
    '├ · tester  sonnet · high',
    '│   reported 3:10',
    '… +4',
  ]);
});

test('the graph needs room for one history row: 19 rows at 53 columns draw the tree, 20 the graph', () => {
  assert.equal(plainRows(layout(golden(), { columns: 53, rows: 19, isAscii: false, tzOffsetAt: UTC }))[2], TREE_35[2]);
  assert.equal(plainRows(layout(golden(), { columns: 53, rows: 20, isAscii: false, tzOffsetAt: UTC }))[2], GOLDEN_53[2]);
});

test('tones: with only the coder running, the upper bus is live from its centre to the orchestrator\'s and dim beyond; gemini\'s box is dim', () => {
  let state = patch(golden(), 'a-reviewer', { status: 'reported', activity: undefined, activityCallId: undefined });
  state = patch(state, 'unit:grok', { status: 'idle', callerId: undefined, activity: undefined, activityCallId: undefined, openCalls: undefined });
  const rows = layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC });
  for (let col = 8; col <= 26; col++) assert.equal(toneAt(rows[7], col), 'live', `upper bus col ${col}`);
  for (let col = 27; col <= 44; col++) assert.equal(toneAt(rows[7], col), 'dim', `upper bus col ${col}`);
  assert.equal(toneAt(rows[6], 8), 'live', 'the coder\'s frame junction');
  assert.equal(toneAt(rows[6], 26), 'dim', 'the reported tester\'s junction');
  assert.equal(toneAt(rows[8], 26), 'live', 'the orchestrator\'s top junction');
  assert.equal(toneAt(rows[3], 0), 'live', 'a running box\'s frame is live');
  assert.equal(toneAt(rows[2], 4), 'live');
  assert.equal(toneAt(rows[3], 4), 'plain', 'its lines are not');
  assert.equal(toneAt(rows[3], 20), 'dim', 'a reported box is dim');
  for (let row = 13; row <= 17; row++) for (const col of [0, 2, 8, 16]) assert.equal(toneAt(rows[row], col), 'dim', `gemini row ${row} col ${col}`);
  for (let col = 8; col <= 44; col++) assert.equal(toneAt(rows[12], col), 'dim', `lower bus col ${col}: no unit runs`);
  assert.equal(toneAt(rows[11], 26), 'plain', 'the orchestrator\'s bottom junction, no live unit link');
});

test('tones: a unit the orchestrator calls has a live link; one a sub-agent calls shows ← its role and no live line', () => {
  const live = layout(golden(), { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC });
  assert.equal(toneAt(live[11], 26), 'live', 'orchestrator bottom junction');
  assert.equal(toneAt(live[12], 26), 'live', 'lower bus under the orchestrator');
  assert.equal(toneAt(live[12], 25), 'dim');
  assert.equal(toneAt(live[13], 26), 'live', 'grok\'s top junction');
  assert.equal(toneAt(live[14], 20), 'plain', 'a running unit\'s box is plain');

  const state = patch(golden(), 'unit:grok', { callerId: 'a-coder', openCalls: [{ callId: 'toolu_g1', callerId: 'a-coder', tool: 'code_review', since: NOW - MIN }] });
  const rows = layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC });
  assert.equal(plainRows(rows)[16], '│               │ │ ← coder-medium│ │               │');
  for (let col = 8; col <= 44; col++) assert.notEqual(toneAt(rows[12], col), 'live', `lower bus col ${col}`);
  assert.notEqual(toneAt(rows[13], 26), 'live');
  assert.notEqual(toneAt(rows[11], 26), 'live');

  const other = patch(golden(), 'unit:grok', { callerId: 'other', openCalls: undefined });
  assert.equal(plainRows(layout(other, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC }))[16], '│               │ │ ← other       │ │               │');
  assert.equal(plainRows(layout(other, { columns: 53, rows: 30, isAscii: true, tzOffsetAt: UTC }))[16], '|               | | <- other      | |               |');
  assert.equal(plainRows(layout(other, { columns: 35, rows: 40, isAscii: false, tzOffsetAt: UTC }))[11], '│   ← other', 'the tree says the same');
  assert.equal(plainRows(layout(other, { columns: 35, rows: 40, isAscii: true, tzOffsetAt: UTC }))[11], '|   <- other');
});

test('a unit\'s link is live when any of its open calls is the orchestrator\'s, not only when the newest is', () => {
  const state = patch(golden(), 'unit:grok', {
    callerId: 'a-coder',
    openCalls: [
      { callId: 'toolu_g0', callerId: 'main', tool: 'code_review', since: NOW - 3 * MIN },
      { callId: 'toolu_g1', callerId: 'a-coder', tool: 'code_review', since: NOW - MIN },
    ],
  });
  const rows = layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC });
  assert.equal(plainRows(rows)[16], '│               │ │ ← coder-medium│ │               │', 'the newest caller is still the one named');
  for (const [row, what] of [[11, 'the orchestrator\'s bottom junction'], [12, 'the bus under it'], [13, 'grok\'s top junction']]) assert.equal(toneAt(rows[row], 26), 'live', what);
});

test('a unit\'s link is live when ANY open call is the orchestrator\'s, even if the first listed is another caller\'s', () => {
  const state = stateOf([], { grok: { status: 'running', callerId: 'main', activity: 'review', openCalls: [call('a-x', 'c0'), call('main', 'c1')] } });
  const rows = layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC });
  const top = plainRows(rows).findIndex((row, i) => i > 4 && row.startsWith('┌'));
  assert.equal(toneAt(rows[top], 26), 'live', 'grok\'s top junction');
});

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

test('a unit with two open calls may show the count; the line is still one box line', () => {
  const state = patch(golden(), 'unit:grok', {
    openCalls: [
      { callId: 'toolu_g0', callerId: 'main', tool: 'code_review', since: NOW - 3 * MIN },
      { callId: 'toolu_g1', callerId: 'main', tool: 'code_review', since: NOW - (2 * MIN + 17 * SEC) },
    ],
  });
  assert.equal(plainRows(layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC }))[15], '│ idle 12m      │ │ code_review ×2│ │ idle          │');
});

test('a unit with no feed and no call says no feed; one that ended a call says idle with its duration', () => {
  let state = patch(golden(), 'unit:codex', { feed: 'none' });
  state = patch(state, 'unit:gemini', { feed: 'none' });
  const rows = plainRows(layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC }));
  assert.equal(rows[15], '│ idle 12m      │ │ code_review   │ │ no feed       │');
});

test('a role or a tool name longer than its box is cut with an ellipsis; the box keeps its 17 cells', () => {
  let state = patch(golden(), 'a-coder', { role: 'omelette-a-role-far-longer-than-the-box', activity: 'Edit 日本語のファイル名.mjs' });
  state = patch(state, 'unit:grok', { activity: 'a_tool_name_longer_than_the_box' });
  const rows = plainRows(layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC }));
  assert.equal(rows[3].slice(0, 17), '│ ▶ a-role-far-…│');
  assert.equal(rows[5], '│ Edit 日本語の…│ │ reported 3:10 │ │ Read models.js│');
  assert.equal(cells(rows[5]), 53);
  assert.equal(rows[15], '│ idle 12m      │ │ a_tool_name_l…│ │ idle          │');
});

test('the orchestrator without a model yet, and a header with figures missing; the header never shows the cost', () => {
  let state = patch(golden(), 'main', { model: undefined, effort: undefined });
  state = { ...state, usage: { sevenDay: 71.4, costUsd: 3.456 } };
  const rows = plainRows(layout(state, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC }));
  assert.equal(rows[0], '7d 71%');
  assert.doesNotMatch(plainRows(layout(golden(), { columns: 80, rows: 30, isAscii: false, tzOffsetAt: UTC }))[0], /\$/);
  assert.equal(rows[10], '             │                         │');
  assert.equal(plainRows(layout({ ...state, usage: {} }, { columns: 53, rows: 30, isAscii: false, tzOffsetAt: UTC }))[0], '');
});

test('the ASCII form of the 53-column golden holds printable ASCII only', () => {
  const rows = plainRows(layout(golden(), { columns: 53, rows: 30, isAscii: true, tzOffsetAt: UTC }));
  for (const row of rows) assert.match(row, /^[\x20-\x7e]*$/, row);
  assert.equal(rows[0], 'ctx 31% - 5h 11% - 7d 71%');
  assert.equal(rows[2], '+---------------+ +---------------+ +---------------+');
  assert.equal(rows[3], '| > coder-medium| | . tester      | | > reviewer    |');
  assert.equal(rows[4], '| opus - medium | | sonnet - high | | opus - xhigh  |');
  assert.equal(rows[7], '        +-----------------+-----------------+');
  assert.equal(rows[9], '             | * orchestrator          |');
  assert.equal(rows[13], '+-------+-------+ +-------+-------+ +-------+-------+');
});

test('the ASCII tree: connectors +, the spine |, the cut ~, arrows ->', () => {
  const state = { ...golden(), history: [{ at: NOW, from: 'main', to: 'unit:grok', label: 'code_review' }] };
  const rows = plainRows(layout(state, { columns: 20, rows: 40, isAscii: true, tzOffsetAt: UTC }));
  for (const row of rows) assert.match(row, /^[\x20-\x7e]*$/, row);
  assert.equal(rows[3], '+ > coder-medium  o~');
  assert.equal(rows[4], '|   Bash: npm test');
  assert.equal(rows[12], '+ . codex  idle');
  assert.equal(rows[14], '09:06:00 orchestrat~');
});

test('history: newest first, HH:MM:SS from → to · label, each link with its own zone offset', () => {
  const at = (h, m, s) => Date.UTC(2026, 9, 8, h, m, s);
  const state = {
    ...golden(),
    history: [
      { at: at(9, 4, 10), from: 'main', to: 'a-coder', label: 'Agent' },
      { at: at(9, 4, 52), from: 'a-coder', to: 'main', label: 'report' },
      { at: at(9, 5, 40), from: 'main', to: 'unit:grok', label: 'code_review' },
    ],
  };
  const asked = [];
  const tzOffsetAt = (when) => {
    asked.push(when);
    return -180;
  };
  const rows = plainRows(layout(state, { columns: 53, rows: 40, isAscii: false, tzOffsetAt }));
  assert.deepEqual(rows.slice(18), [
    '',
    '12:05:40 orchestrator → grok · code_review',
    '12:04:52 coder-medium → orchestrator · report',
    '12:04:10 orchestrator → coder-medium · Agent',
  ]);
  assert.deepEqual(asked.sort(), [at(9, 4, 10), at(9, 4, 52), at(9, 5, 40)].sort());

  const dst = plainRows(layout(state, { columns: 53, rows: 40, isAscii: false, tzOffsetAt: (when) => (when < at(9, 5, 0) ? -120 : -180) }));
  assert.deepEqual(dst.slice(19), [
    '12:05:40 orchestrator → grok · code_review',
    '11:04:52 coder-medium → orchestrator · report',
    '11:04:10 orchestrator → coder-medium · Agent',
  ]);
});

test('history fills the remaining rows and never exceeds them; a raw SendMessage target stays as written', () => {
  const links = Array.from({ length: 30 }, (_, i) => ({ at: NOW - (30 - i) * SEC, from: 'main', to: i === 29 ? 'helper@team' : 'a-coder', label: i === 29 ? 'SendMessage' : 'Agent' }));
  const state = { ...golden(), history: links };
  for (const height of [20, 21, 24, 48]) {
    const rows = plainRows(layout(state, { columns: 53, rows: height, isAscii: false, tzOffsetAt: UTC }));
    assert.equal(rows.length, height, `height ${height}`);
    assert.equal(rows[18], '');
    assert.equal(rows[19], '09:05:59 orchestrator → helper@team · SendMessage');
  }
  const tree = plainRows(layout(state, { columns: 40, rows: 16, isAscii: false, tzOffsetAt: UTC }));
  assert.equal(tree.length, 16);
  assert.equal(tree[13], '');
  assert.equal(tree[14], '09:05:59 orchestrator → helper@team · S…');
});

test('no row is wider than the pane and no pane taller than asked, for every width from 1 to 120', () => {
  const links = Array.from({ length: 50 }, (_, i) => ({ at: NOW - i * SEC, from: 'a3', to: 'unit:codex', label: 'a_rather_long_tool_label_日本語' }));
  const states = [
    golden(),
    { ...withAgents(golden(), 9, 4, { activity: 'Edit 日本語のファイル名.mjs', model: 'claude-opus-5-5', effort: 'xhigh' }), history: links },
    { ...golden(), nodes: golden().nodes.filter((n) => n.kind !== 'agent'), usage: {} },
  ];
  for (const state of states) {
    for (let columns = 1; columns <= 120; columns++) {
      for (const height of [1, 2, 6, 8, 19, 40]) {
        for (const isAscii of [false, true]) {
          const rows = layout(state, { columns, rows: height, isAscii, tzOffsetAt: UTC });
          assert.ok(rows.length <= height, `${columns}x${height}: ${rows.length} rows`);
          for (const row of rows) {
            const width = row.reduce((sum, segment) => sum + cells(segment.text), 0);
            assert.ok(width <= columns, `${columns}x${height} ascii=${isAscii}: ${width} cells: ${plainRows([row])[0]}`);
          }
        }
      }
    }
  }
});

test('strings from outside are cleaned before they are measured: no ESC, BEL or bidi override reaches a row, and no row grows', () => {
  const hostile = '\u001b[2J\u001b]0;pwned\u0007x\u202e.mjs';
  let state = patch(golden(), 'a-coder', { role: `omelette-${hostile}`, model: `claude-${hostile}`, effort: `hi\u001bgh`, activity: `Edit ${hostile}` });
  state = patch(state, 'main', { model: `claude-fable\u0007-5-1`, effort: `high\u009b` });
  state = patch(state, 'unit:grok', { activity: `code\u001b_review`, model: `grok\u202e-4.7`, callerId: 'a-coder' });
  state = {
    ...state,
    history: [
      { at: NOW, from: 'a-coder', to: `name\u001b]8;;x\u0007@team`, label: `Send\u2066Message` },
      { at: NOW, from: 'main', to: 'a-coder', label: `Agent\u0000` },
    ],
  };
  const forbidden = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
  for (let columns = 1; columns <= 120; columns++) {
    for (const height of [8, 40]) {
      for (const isAscii of [false, true]) {
        const rows = layout(state, { columns, rows: height, isAscii, tzOffsetAt: UTC });
        for (const row of rows) {
          const text = row.map((segment) => segment.text).join('');
          assert.doesNotMatch(text, forbidden, `${columns} ascii=${isAscii}: ${JSON.stringify(text)}`);
          assert.ok(cells(text) <= columns, `${columns}: ${text}`);
        }
      }
    }
  }
  const rows = plainRows(layout(state, { columns: 53, rows: 40, isAscii: false, tzOffsetAt: UTC }));
  assert.equal(rows[3].slice(0, 17), '│ ▶ [2J]0;pwned…│');
  assert.equal(rows[5].slice(0, 17), '│ Edit [2J]0;pw…│');
  assert.equal(rows[19], '09:06:00 orchestrator → [2J]0;pwnedx.mjs · Agent');
  assert.equal(rows[20], '09:06:00 [2J]0;pwnedx.mjs → name]8;;x@team · SendMes…', 'cut at 53 cells');
  assert.equal(statusLine(state, NOW), 'fleet: [2J]0;pwnedx.mjs, reviewer, grok 2:17');
});

test('statusLine: running roles and units, a unit with its duration; nothing when nothing runs', () => {
  assert.equal(statusLine(golden(), NOW), 'fleet: coder-medium, reviewer, grok 2:17');
  let idle = patch(golden(), 'a-coder', { status: 'reported', activity: undefined });
  idle = patch(idle, 'a-reviewer', { status: 'waiting', activity: undefined });
  idle = patch(idle, 'unit:grok', { status: 'idle', callerId: undefined, activity: undefined, openCalls: undefined });
  assert.equal(statusLine(idle, NOW), undefined, 'the orchestrator and a waiting agent are not "running" here');
  const many = withAgents(golden(), 12, 12);
  const line = statusLine(many, NOW);
  assert.ok(cells(line) <= 60, line);
  assert.ok(line.startsWith('fleet: role0, role1'), line);
  assert.ok(line.endsWith('…'), line);
});

test('a run of zero-width marks cannot make a row or the alt unbounded: at most four code points per cell', async () => {
  const { svgOf } = await import('../mods/omelette-fleet/hooks/svg.mjs');
  const { initialState, reduce } = await import('../mods/omelette-fleet/hooks/model.mjs');
  const T0 = Date.UTC(2026, 9, 8, 12);
  const flood = 'a' + '\u0301'.repeat(30000);
  let state = initialState(T0);
  state = reduce(state, { type: 'spawn', at: T0, agentId: 'a1', role: flood, parentId: 'main', model: 'claude-opus-5-5' });
  state = reduce(state, { type: 'call', at: T0, agentId: 'a1', callId: 'c1', tool: 'Bash', subject: flood });
  state = { ...state, history: [{ at: T0, from: 'main', to: 'a1', label: flood }] };
  for (const columns of [20, 53, 120]) {
    for (const row of plainRows(layout(state, { columns, rows: 40, isAscii: false }))) assert.ok([...row].length <= 4 * columns + 1, `${columns}: ${[...row].length} code points`);
  }
  assert.ok(svgOf(state, { tzOffsetAt: () => 0 }).alt.length < 131072);
});
