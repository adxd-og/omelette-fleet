/**
 * omelette-fleet :: test/tester-1.7.0-t3.test.mjs
 * Tester's tests for 1.7.0 Task 3 (the terminal drawing): mods/omelette-fleet/hooks/layout.mjs
 * against the plan's goldens and the rulings, from states built here. Ids and times are made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, plainRows, statusLine } from '../mods/omelette-fleet/hooks/layout.mjs';
import { cells } from '../mods/omelette-fleet/hooks/text.mjs';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

// ---------------------------------------------------------------------------
// States, built by hand

const MAIN_NODE = { id: 'main', kind: 'orchestrator', role: 'orchestrator', model: 'claude-fable-5-1', effort: 'high', status: 'running', since: NOW - HOUR, order: 0 };
const unit = (name, order, extra = {}) => ({ id: `unit:${name}`, kind: 'unit', role: name, status: 'idle', since: NOW - HOUR, feed: 'ok', order, ...extra });
const agent = (id, role, order, extra = {}) => ({ id, kind: 'agent', role, parentId: 'main', status: 'running', since: NOW - MIN, order, ...extra });
const running = (callerId, tool, extra = {}) => ({
  status: 'running', callerId, activity: tool, activityCallId: `call-${callerId}-${tool}`, since: NOW - (2 * MIN + 17 * SEC), model: 'grok-4.7',
  openCalls: [{ callId: `call-${callerId}-${tool}`, callerId, tool, since: NOW - (2 * MIN + 17 * SEC) }], ...extra,
});
const usageFull = { contextPercent: 31, fiveHour: 11, sevenDay: 71, costUsd: 646.74 };

/** The plan's golden state. */
function goldenState() {
  return {
    now: NOW, isOpen: true, usage: { ...usageFull }, history: [],
    nodes: [
      MAIN_NODE,
      unit('gemini', 1, { lastEndedAt: NOW - 12 * MIN }),
      unit('grok', 2, running('main', 'code_review')),
      unit('codex', 3),
      agent('a1', 'omelette-coder-medium', 4, { model: 'claude-opus-5-5', effort: 'medium', activity: 'Bash: npm test', activityCallId: 'x1' }),
      agent('a2', 'omelette-tester', 5, { model: 'claude-sonnet-5-5', effort: 'high', status: 'reported', since: NOW - (3 * MIN + 10 * SEC) }),
      agent('a3', 'omelette-reviewer', 6, { model: 'claude-opus-5-5', effort: 'xhigh', activity: 'Read models.js', activityCallId: 'x2' }),
    ],
  };
}
const idleUnits = () => [unit('gemini', 1), unit('grok', 2), unit('codex', 3)];
const stateOf = (nodes, extra = {}) => ({ now: NOW, isOpen: true, usage: {}, history: [], nodes: [MAIN_NODE, ...nodes], ...extra });
const patched = (state, id, fields) => ({ ...state, nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...fields } : n)) });
const UTC = () => 0;
const lay = (state, columns, rows, extra = {}) => layout(state, { columns, rows, isAscii: false, tzOffsetAt: UTC, ...extra });
const plain = (state, columns, rows, extra = {}) => plainRows(lay(state, columns, rows, extra));

/** One terminal cell per entry: a wide character is its glyph then ''. */
function expand(row) {
  const out = [];
  for (const segment of row) {
    for (const ch of segment.text) {
      out.push({ ch, tone: segment.tone });
      if (cells(ch) === 2) out.push({ ch: '', tone: segment.tone });
    }
  }
  return out;
}
const toneAt = (rows, y, x) => expand(rows[y])[x]?.tone;
const charAt = (rows, y, x) => expand(rows[y])[x]?.ch;
const win = (text, i) => text.slice(i * 18, i * 18 + 17);

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/u;

// ---------------------------------------------------------------------------
// The plan's goldens

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

const GOLDEN_53_ASCII = [
  'ctx 31% - 5h 11% - 7d 71%',
  '',
  '+---------------+ +---------------+ +---------------+',
  '| > coder-medium| | . tester      | | > reviewer    |',
  '| opus - medium | | sonnet - high | | opus - xhigh  |',
  '| Bash: npm test| | reported 3:10 | | Read models.js|',
  '+-------+-------+ +-------+-------+ +-------+-------+',
  '        +-----------------+-----------------+',
  '             +------------+------------+',
  '             | * orchestrator          |',
  '             | fable-5-1 - high - 31%  |',
  '             +------------+------------+',
  '        +-----------------+-----------------+',
  '+-------+-------+ +-------+-------+ +-------+-------+',
  '| . gemini      | | > grok        | | . codex       |',
  '| idle 12m      | | code_review   | | idle          |',
  '|               | | grok-4.7 2:17 | |               |',
  '+---------------+ +---------------+ +---------------+',
];

const TREE = [
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

test('golden: the 53-column graph, exactly, from a state built here (first 18 rows)', () => {
  assert.deepEqual(plain(goldenState(), 53, 24).slice(0, 18), GOLDEN_53);
});

test('golden: with no history the graph ends at row 18 (no trailing blank row)', () => {
  assert.equal(plain(goldenState(), 53, 40).length, 18);
});

test('golden: the ASCII form of the same graph, character for character', () => {
  assert.deepEqual(plain(goldenState(), 53, 24, { isAscii: true }).slice(0, 18), GOLDEN_53_ASCII);
});

test('golden: the tree at 35 columns (header, blank, the plan\'s tree)', () => {
  assert.deepEqual(plain(goldenState(), 35, 40), ['ctx 31% · 5h 11% · 7d 71%', '', ...TREE]);
});

test('golden: the tree at 20 columns, each row cut by `cut`: the plan\'s rows ending in an ellipsis within 20 cells', () => {
  const cutTo20 = (s) => (Array.from(s).length <= 20 ? s : `${Array.from(s).slice(0, 19).join('')}…`);
  const got = plain(goldenState(), 20, 40);
  assert.deepEqual(got, ['ctx 31% · 5h 11% · 7d 71%', '', ...TREE].map(cutTo20));
  assert.equal(got[0], 'ctx 31% · 5h 11% · …');
  assert.equal(got[2], '● orchestrator  fab…');
  assert.equal(got[3], '├ ▶ coder-medium  o…');
  for (const row of got) assert.ok(cells(row) <= 20, row);
});

test('golden: 71 columns with a fourth agent: four boxes, ┬ under the orchestrator, ┼ on the unit bus', () => {
  const state = goldenState();
  state.nodes.push(agent('a4', 'omelette-planner', 7, { model: 'claude-opus-5-5', effort: 'high', status: 'reported', since: NOW - 5 * MIN }));
  const got = plain(state, 71, 30);
  assert.equal(got.length, 18);
  // the four boxes are one cell apart, 71 cells across
  for (const y of [2, 6]) assert.equal(cells(got[y]), 71);
  assert.equal(got[2], Array(4).fill('┌───────────────┐').join(' '));
  assert.equal(got[6], Array(4).fill('└───────┬───────┘').join(' '));
  // centres 8, 26, 44, 62; the orchestrator's centre is 35
  assert.equal(got[7], `${' '.repeat(8)}└${'─'.repeat(17)}┴${'─'.repeat(8)}┬${'─'.repeat(8)}┴${'─'.repeat(17)}┘`);
  assert.equal(got[8], `${' '.repeat(22)}┌${'─'.repeat(12)}┴${'─'.repeat(12)}┐`);
  assert.equal(got[11], `${' '.repeat(22)}└${'─'.repeat(12)}┬${'─'.repeat(12)}┘`);
  assert.equal(got[12], `${' '.repeat(17)}┌${'─'.repeat(17)}┼${'─'.repeat(17)}┐`);
  // the units are centred under the 71 cells
  assert.equal(got[13], `${' '.repeat(9)}${Array(3).fill('┌───────┴───────┐').join(' ')}`);
});

test('golden: two agents: the bus reads └────────┬────────┘ under them', () => {
  const state = stateOf([...idleUnits(), agent('a1', 'alpha', 4, { status: 'reported' }), agent('a2', 'beta', 5, { status: 'reported' })]);
  const got = plain(state, 53, 24);
  assert.equal(got[7], `${' '.repeat(17)}└────────┬────────┘`);
  assert.equal(got[2], `${' '.repeat(9)}┌───────────────┐ ┌───────────────┐`);
  assert.equal(got[8], `${' '.repeat(13)}┌────────────┴────────────┐`);
});

test('golden: one agent: the bus row is a single │ at the orchestrator\'s centre', () => {
  const state = stateOf([...idleUnits(), agent('a1', 'alpha', 4)]);
  const got = plain(state, 53, 24);
  assert.equal(got[7], `${' '.repeat(26)}│`);
  assert.equal(got[2], `${' '.repeat(18)}┌───────────────┐`);
  assert.equal(got[6], `${' '.repeat(18)}└───────┬───────┘`);
});

test('golden: no agents: no agent row, no upper bus, no junction on the orchestrator\'s top frame', () => {
  const got = plain(stateOf(idleUnits()), 53, 24);
  assert.equal(got.length, 12);
  assert.equal(got[2], `${' '.repeat(13)}┌${'─'.repeat(25)}┐`);
  assert.equal(got[3].trim(), '│ ● orchestrator          │');
  assert.equal(got[5], `${' '.repeat(13)}└────────────┬────────────┘`);
  assert.equal(got[6], `${' '.repeat(8)}┌${'─'.repeat(17)}┼${'─'.repeat(17)}┐`);
});

test('golden: seven agents at 53 columns, two running and the oldest: both shown, the third box is `+5 more`', () => {
  const agents = Array.from({ length: 7 }, (_, i) => agent(`s${i}`, `r${i + 1}`, 4 + i, { status: i < 2 ? 'running' : 'reported', since: NOW - (10 - i) * MIN }));
  const got = plain(stateOf([...idleUnits(), ...agents]), 53, 30);
  assert.equal(win(got[3], 0), '│ ▶ r1          │');
  assert.equal(win(got[3], 1), '│ ▶ r2          │');
  assert.equal(win(got[3], 2), '│ +5 more       │');
  assert.equal(win(got[4], 2), '│               │', 'no hidden one runs: line two blank');
  assert.equal(win(got[5], 2), '│               │');
  assert.equal(cells(got[2]), 53);
});

test('the fold: running and waiting first, then reported by newest `since`; the row is in spawn order', () => {
  const nodes = [
    ...idleUnits(),
    agent('o1', 'r1', 4, { status: 'reported', since: NOW - 50 * MIN }),
    agent('o2', 'r2', 5, { status: 'reported', since: NOW - 5 * MIN }),
    agent('o3', 'r3', 6, { status: 'waiting', since: NOW - 60 * MIN }),
    agent('o4', 'r4', 7, { status: 'reported', since: NOW - 40 * MIN }),
    agent('o5', 'r5', 8, { status: 'reported', since: NOW - 1 * MIN }),
  ];
  const got = plain(stateOf(nodes), 53, 30);
  // n = 3: the waiting r3 first, then the newest reported r5; order puts r3 before r5
  assert.equal(win(got[3], 0).slice(2, 4), '◌ ');
  assert.match(win(got[3], 0), /r3/);
  assert.match(win(got[3], 1), /r5/);
  assert.match(win(got[3], 2), /\+3 more/);
});

test('the fold with a running agent hidden: `<x> running` on line two and its link live', () => {
  const agents = Array.from({ length: 7 }, (_, i) => agent(`s${i}`, `r${i + 1}`, 4 + i, { status: i < 3 ? 'running' : 'reported', since: NOW - (10 - i) * MIN }));
  const rows = lay(stateOf([...idleUnits(), ...agents]), 53, 30);
  const text = plainRows(rows);
  assert.match(win(text[3], 2), /\+5 more/);
  assert.match(win(text[4], 2), /1 running/);
  assert.equal(toneAt(rows, 6, 44), 'live', 'the +K more box\'s junction');
  assert.equal(toneAt(rows, 7, 40), 'live', 'bus between it and the orchestrator');
});

test('wider panes show more boxes: 71 columns four, 107 columns six, and the fold at the cap', () => {
  const agents = Array.from({ length: 9 }, (_, i) => agent(`s${i}`, `r${i + 1}`, 4 + i, { status: 'reported', since: NOW - (20 - i) * MIN }));
  const four = plain(stateOf([...idleUnits(), ...agents]), 71, 30);
  assert.equal(cells(four[2]), 71);
  assert.match(four[3], /\+6 more/, '71 columns: three shown, six folded');
  const six = plain(stateOf([...idleUnits(), ...agents]), 107, 30);
  assert.equal(cells(six[2]), 107);
  assert.match(six[3], /\+4 more/, '107 columns: five shown, four folded');
  const huge = plain(stateOf([...idleUnits(), ...agents]), 400, 30);
  assert.equal(cells(huge[2]), 107, 'never more than six boxes');
});

test('the graph needs 20 rows at 53 columns (graph plus a blank and one history row); 17, 18 and 19 rows draw the tree', () => {
  assert.match(plain(goldenState(), 53, 20)[2], /^┌/);
  for (const rows of [17, 18, 19]) assert.doesNotMatch(plain(goldenState(), 53, rows).join('\n'), /┌/, `${rows} rows`);
});

test('a pane of 8 rows at 80 columns: the tree, eight rows, the last `… +N` counting the actors left out', () => {
  const got = plain(goldenState(), 80, 8);
  assert.deepEqual(got, [
    'ctx 31% · 5h 11% · 7d 71%', '',
    '● orchestrator  fable-5-1 · high',
    '├ ▶ coder-medium  opus · medium',
    '│   Bash: npm test',
    '├ · tester  sonnet · high',
    '│   reported 3:10',
    '… +4',
  ]);
});

test('Review Focus 3: 20 columns by 6 rows with a role and a tool longer than their boxes', () => {
  const state = patched(patched(goldenState(), 'a1', { role: 'omelette-an-extraordinarily-long-role-name', activity: 'a-very-long-activity-for-the-box' }), 'unit:grok', { activity: 'deep_research_with_a_long_name' });
  const got = plain(state, 20, 6);
  assert.ok(got.length <= 6);
  for (const row of got) assert.ok(cells(row) <= 20, row);
  assert.match(got.at(-1), /^… \+\d+$/);
  const graph = plain(state, 53, 24);
  assert.equal(win(graph[3], 0), '│ ▶ an-extraord…│');
  for (const y of [3, 4, 5, 14, 15, 16]) assert.equal(cells(graph[y]), 53, `box row ${y} keeps its frame`);
});

// ---------------------------------------------------------------------------
// Box contents

test('a running agent between calls shows a blank third line; a waiting one `waiting <duration>`; a resumed-list one has no model line', () => {
  const state = stateOf([
    ...idleUnits(),
    agent('a1', 'alpha', 4, { model: 'claude-opus-5-5', effort: 'high' }),
    agent('a2', 'beta', 5, { status: 'waiting', since: NOW - 42 * SEC, model: 'claude-opus-5-5', effort: 'low' }),
    agent('a3', 'gamma', 6),
  ]);
  const got = plain(state, 53, 24);
  assert.equal(win(got[3], 0), '│ ▶ alpha       │');
  assert.equal(win(got[4], 0), '│ opus · high   │');
  assert.equal(win(got[5], 0), '│               │');
  assert.equal(win(got[3], 1), '│ ◌ beta        │');
  assert.equal(win(got[5], 1), '│ waiting 0:42  │');
  assert.equal(win(got[4], 2), '│               │', 'no model, no effort: blank');
});

test('unit lines: idle with a past call, idle with a feed, no feed, a call from a sub-agent, from another session, two open calls', () => {
  const nodes = [
    agent('a1', 'omelette-coder-medium', 4),
    unit('gemini', 1, { feed: 'none' }),
    unit('grok', 2, running('a1', 'code_review')),
    unit('codex', 3, { ...running('other', 'research'), activityCallId: undefined, openCalls: undefined }),
  ];
  const got = plain(stateOf(nodes), 53, 24);
  // units sit at y 13..17 once there is one agent row (rows: 2 + 6 + 4 + 1)
  const unitRow = (line) => got[14 + line];
  assert.equal(win(unitRow(0), 0), '│ · gemini      │');
  assert.equal(win(unitRow(1), 0), '│ no feed       │');
  assert.equal(win(unitRow(1), 1), '│ code_review   │');
  assert.equal(win(unitRow(2), 1), '│ ← coder-medium│');
  assert.equal(win(unitRow(0), 2), '│ ▶ codex       │');
  assert.equal(win(unitRow(1), 2), '│ research      │');
  // another session's call reads `← other` and fits the box
  assert.equal(win(unitRow(2), 2), '│ ← other       │');
  assert.equal(win(plain(stateOf(nodes), 53, 24, { isAscii: true })[16], 2), '| <- other      |');
  assert.equal(cells(unitRow(2)), 53);

  const two = patched(stateOf(nodes), 'unit:grok', { openCalls: [...nodes[2].openCalls, { callId: 'c2', callerId: 'a1', tool: 'code_review', since: NOW - MIN }] });
  assert.equal(win(plain(two, 53, 24)[15], 1), '│ code_review ×2│');
  assert.equal(win(plain(two, 53, 24, { isAscii: true })[15], 1), '| code_review x2|');
});

test('the tree writes `← other` and `← <role>` in full where there is room', () => {
  const nodes = [
    agent('a1', 'omelette-coder-medium', 4),
    unit('gemini', 1),
    unit('grok', 2, running('a1', 'code_review')),
    unit('codex', 3, { ...running('other', 'research'), activityCallId: undefined, openCalls: undefined }),
  ];
  const got = plain(stateOf(nodes), 52, 40).join('\n');
  assert.match(got, /← coder-medium/);
  assert.match(got, /← other/);
  assert.doesNotMatch(got, /other session/);
});

test('the orchestrator box is plain whatever the orchestrator is doing; its frame carries no dim', () => {
  for (const status of ['idle', 'running', 'waiting']) {
    const state = patched(goldenState(), 'main', { status });
    const rows = lay(state, 53, 24);
    for (let y = 8; y <= 11; y++) {
      for (let x = 13; x <= 39; x++) {
        if (x === 26 && (y === 8 || y === 11)) continue; // the junctions carry the link's tone
        assert.equal(toneAt(rows, y, x), 'plain', `status ${status} cell ${y},${x}`);
      }
    }
  }
});

test('units and agents appear in `order`, whatever the order of the nodes array', () => {
  const state = goldenState();
  const shuffled = { ...state, nodes: [...state.nodes].reverse() };
  assert.deepEqual(plain(shuffled, 53, 24).slice(0, 18), GOLDEN_53);
});

test('layout does not mutate its input (deep-frozen state)', () => {
  const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  const state = deepFreeze({ ...goldenState(), history: [{ at: NOW - SEC, from: 'main', to: 'a1', label: 'Agent' }] });
  for (const columns of [20, 53, 80]) assert.doesNotThrow(() => layout(state, { columns, rows: 40, isAscii: false, tzOffsetAt: UTC }));
});

// ---------------------------------------------------------------------------
// The header

test('the header: context and the two windows, each figure left out when absent; the cost is never shown (ruling 2026-10-08)', () => {
  const header = (usage, columns = 80) => plain(stateOf(idleUnits(), { usage }), columns, 24)[0];
  assert.equal(header(usageFull), 'ctx 31% · 5h 11% · 7d 71%');
  assert.equal(header({ costUsd: 9.5 }), '');
  assert.equal(header({ contextPercent: 31 }), 'ctx 31%');
  assert.equal(header({ fiveHour: 0, sevenDay: 5 }), '5h 0% · 7d 5%');
  assert.equal(header({}), '');
  assert.equal(plain(stateOf(idleUnits(), { usage: usageFull }), 80, 24, { isAscii: true })[0], 'ctx 31% - 5h 11% - 7d 71%');
});

// ---------------------------------------------------------------------------
// Tones

test('tones: only the coder running: the upper bus is live from its centre to the orchestrator\'s and dim beyond; the idle boxes are dim', () => {
  let state = goldenState();
  state = patched(state, 'a3', { status: 'reported', activity: undefined });
  state = patched(state, 'unit:grok', { status: 'idle', openCalls: undefined, callerId: undefined, activity: undefined });
  const rows = lay(state, 53, 24);
  // centres 8, 26, 44; the orchestrator's 26
  for (let x = 8; x <= 26; x++) assert.equal(toneAt(rows, 7, x), 'live', `bus col ${x}`);
  for (let x = 27; x <= 44; x++) assert.equal(toneAt(rows, 7, x), 'dim', `bus col ${x}`);
  assert.equal(toneAt(rows, 6, 8), 'live', 'the coder\'s frame junction');
  assert.equal(toneAt(rows, 8, 26), 'live', 'the orchestrator\'s top junction');
  assert.notEqual(toneAt(rows, 11, 26), 'live', 'no unit runs: the lower junction is not live');
  // gemini's box: dim, frame and text
  for (let y = 13; y <= 17; y++) for (let x = 0; x <= 16; x++) assert.equal(toneAt(rows, y, x), 'dim', `gemini cell ${y},${x}`);
  // the tester's (reported) box too; the running coder's is plain
  for (let y = 2; y <= 6; y++) for (let x = 18; x <= 34; x++) assert.equal(toneAt(rows, y, x), 'dim', `tester cell ${y},${x}`);
  assert.equal(toneAt(rows, 3, 3), 'plain', 'the running coder\'s own box is plain');
  // every unit-bus cell is dim when nothing runs below
  for (let x = 8; x <= 44; x++) assert.equal(toneAt(rows, 12, x), 'dim', `unit bus col ${x}`);
});

test('tones: two running agents either side: live between the outer centres, dim outside them', () => {
  const nodes = [
    ...idleUnits(),
    agent('a1', 'one', 4, { status: 'reported' }),
    agent('a2', 'two', 5),
    agent('a3', 'three', 6),
    agent('a4', 'four', 7, { status: 'reported' }),
  ];
  const rows = lay(stateOf(nodes), 71, 30);
  // centres 8, 26, 44, 62, orchestrator at 35
  for (let x = 8; x <= 25; x++) assert.equal(toneAt(rows, 7, x), 'dim', `col ${x}`);
  for (let x = 26; x <= 44; x++) assert.equal(toneAt(rows, 7, x), 'live', `col ${x}`);
  for (let x = 45; x <= 62; x++) assert.equal(toneAt(rows, 7, x), 'dim', `col ${x}`);
  assert.equal(toneAt(rows, 6, 26), 'live');
  assert.equal(toneAt(rows, 6, 44), 'live');
  assert.equal(toneAt(rows, 6, 8), 'dim');
  assert.equal(toneAt(rows, 6, 62), 'dim');
  assert.equal(toneAt(rows, 8, 35), 'live');
});

test('tones: a unit the orchestrator calls is live (box plain, junction and bus to the hub live); one called by a sub-agent or `other` is not', () => {
  const fromMain = lay(stateOf([agent('a1', 'alpha', 4), unit('gemini', 1, running('main', 'research')), unit('grok', 2), unit('codex', 3)]), 53, 24);
  // gemini centre 8: live from 8 to the hub (26)
  for (let x = 8; x <= 26; x++) assert.equal(toneAt(fromMain, 12, x), 'live', `unit bus col ${x}`);
  for (let x = 27; x <= 44; x++) assert.equal(toneAt(fromMain, 12, x), 'dim', `unit bus col ${x}`);
  assert.equal(toneAt(fromMain, 13, 8), 'live', 'its top junction');
  assert.equal(toneAt(fromMain, 11, 26), 'live', 'the orchestrator\'s lower junction');
  assert.equal(toneAt(fromMain, 15, 3), 'plain', 'a running unit\'s box is not dim');

  for (const caller of ['a1', 'other']) {
    const state = stateOf([agent('a1', 'alpha', 4, { status: 'reported' }), unit('gemini', 1, running(caller, 'research')), unit('grok', 2), unit('codex', 3)]);
    const rows = lay(state, 53, 24);
    for (let x = 8; x <= 44; x++) assert.equal(toneAt(rows, 12, x), 'dim', `caller ${caller} bus col ${x}`);
    assert.notEqual(toneAt(rows, 13, 8), 'live');
    assert.notEqual(toneAt(rows, 11, 26), 'live');
    assert.equal(toneAt(rows, 15, 3), 'plain', 'it runs, so the box is not dim');
  }
});

test('tones: the golden has grok live: only the hub cell of the unit bus, with the junction below the orchestrator', () => {
  const rows = lay(goldenState(), 53, 24);
  assert.equal(toneAt(rows, 12, 26), 'live');
  assert.equal(toneAt(rows, 12, 25), 'dim');
  assert.equal(toneAt(rows, 12, 27), 'dim');
  assert.equal(toneAt(rows, 11, 26), 'live');
  assert.equal(toneAt(rows, 13, 26), 'live');
  // both running agents: bus live from 8 to 26 (coder) and 26 (reviewer)
  assert.equal(toneAt(rows, 7, 8), 'live');
  assert.equal(toneAt(rows, 7, 26), 'live');
  assert.equal(toneAt(rows, 7, 44), 'live');
});

test('tones: in the tree an idle or reported actor\'s rows are dim, a running one\'s are not', () => {
  const rows = lay(goldenState(), 80, 40);
  const toneOfText = (needle) => rows.find((r) => r.map((s) => s.text).join('').includes(needle)).filter((s) => s.text.includes(needle))[0].tone;
  assert.equal(toneOfText('tester'), 'dim');
  assert.equal(toneOfText('gemini'), 'dim');
  assert.equal(toneOfText('codex'), 'dim');
  assert.notEqual(toneOfText('coder-medium'), 'dim');
  assert.notEqual(toneOfText('grok'), 'dim');
});

// ---------------------------------------------------------------------------
// ASCII

test('ASCII: every row of the graph, the tree and the history is printable ASCII, at every width and height', () => {
  const state = goldenState();
  state.history = [
    { at: NOW - 3 * SEC, from: 'main', to: 'a1', label: 'Agent' },
    { at: NOW - 2 * SEC, from: 'a1', to: 'unit:grok', label: 'code_review' },
    { at: NOW - SEC, from: 'a1', to: 'researcher', label: 'SendMessage' },
    { at: NOW, from: 'a1', to: 'main', label: 'report' },
  ];
  state.nodes = state.nodes.map((n) => (n.id === 'unit:codex' ? { ...n, ...running('a1', 'code_review'), openCalls: [...running('a1', 'code_review').openCalls, { callId: 'z', callerId: 'a1', tool: 'code_review', since: NOW }] } : n));
  for (const columns of [1, 5, 20, 35, 52, 53, 54, 71, 80, 120]) {
    for (const rows of [1, 3, 6, 8, 18, 20, 24, 40]) {
      for (const row of plain(state, columns, rows, { isAscii: true })) {
        assert.match(row, /^[\x20-\x7e]*$/, `${columns}x${rows}: ${JSON.stringify(row)}`);
      }
    }
  }
});

test('ASCII: the cut ends in ~ and the arrows are -> / <-', () => {
  const state = goldenState();
  state.history = [{ at: NOW, from: 'main', to: 'a1', label: 'Agent' }];
  const tree = plain(state, 24, 40, { isAscii: true });
  assert.ok(tree.some((r) => r.endsWith('~')), 'a cut row ends in ~');
  assert.ok(tree.every((r) => !r.includes('…')));
  assert.ok(plain(state, 80, 40, { isAscii: true }).includes('12:00:00 orchestrator -> coder-medium - Agent'));
  const sub = patched(state, 'unit:grok', running('a1', 'code_review'));
  assert.ok(plain(sub, 52, 40, { isAscii: true }).some((r) => r.includes('<- coder-medium')), 'the tree has room for the whole arrow and role');
});

// ---------------------------------------------------------------------------
// History

const LINKS = [
  { at: NOW + 1 * SEC, from: 'main', to: 'a1', label: 'Agent' },
  { at: NOW + 2 * SEC, from: 'a1', to: 'unit:grok', label: 'code_review' },
  { at: NOW + 3 * SEC, from: 'a1', to: 'researcher', label: 'SendMessage' },
  { at: NOW + 4 * SEC, from: 'a3', to: 'main', label: 'report' },
  { at: NOW + 5 * SEC, from: 'main', to: 'unit:codex', label: 'code_review' },
];

test('history: newest first, `HH:MM:SS <from role> → <to role> · <label>`, after a blank row, as many as the rows hold', () => {
  const state = { ...goldenState(), history: LINKS };
  const full = plain(state, 53, 40);
  assert.equal(full.length, 18 + 1 + 5);
  assert.equal(full[18], '');
  assert.deepEqual(full.slice(19), [
    '12:00:05 orchestrator → codex · code_review',
    '12:00:04 reviewer → orchestrator · report',
    '12:00:03 coder-medium → researcher · SendMessage',
    '12:00:02 coder-medium → grok · code_review',
    '12:00:01 orchestrator → coder-medium · Agent',
  ]);
  const two = plain(state, 53, 21);
  assert.equal(two.length, 21);
  assert.deepEqual(two.slice(19), ['12:00:05 orchestrator → codex · code_review', '12:00:04 reviewer → orchestrator · report']);
  assert.equal(plain(state, 53, 20).length, 20);
  assert.equal(plain(state, 53, 20)[19], '12:00:05 orchestrator → codex · code_review');
});

test('history in the tree: after a blank row, newest first, never past the rows', () => {
  const state = { ...goldenState(), history: LINKS };
  const full = plain(state, 52, 40);
  const tail = full.slice(2 + TREE.length);
  assert.equal(tail[0], '');
  assert.equal(tail[1], '12:00:05 orchestrator → codex · code_review');
  assert.equal(tail.length, 1 + 5);
  for (let rows = 1; rows <= 24; rows++) assert.ok(plain(state, 52, rows).length <= rows, `rows ${rows}`);
});

test('history: a long label is cut within the pane; a 200-link history is shown only as far as the rows go, newest first', () => {
  const links = Array.from({ length: 200 }, (_, i) => ({ at: NOW + i * SEC, from: 'main', to: 'a1', label: `label-${i}-${'x'.repeat(80)}` }));
  const got = plain({ ...goldenState(), history: links }, 60, 30);
  assert.equal(got.length, 30);
  assert.ok(got.slice(19).every((r) => cells(r) <= 60));
  assert.ok(got[19].startsWith('12:03:19 orchestrator → coder-medium · label-199-'));
  assert.ok(got[19].endsWith('…'));
  assert.ok(got[29].startsWith('12:03:09 '));
});

test('history: each row uses the zone offset of its own instant (tzOffsetAt(at), minutes as getTimezoneOffset)', () => {
  const boundary = NOW + 2.5 * SEC;
  const seen = [];
  const tzOffsetAt = (at) => { seen.push(at); return at < boundary ? -120 : -180; };
  const got = plainRows(layout({ ...goldenState(), history: LINKS }, { columns: 80, rows: 40, isAscii: false, tzOffsetAt }));
  const tail = got.slice(-5);
  assert.deepEqual(tail.map((r) => r.slice(0, 8)), ['15:00:05', '15:00:04', '15:00:03', '14:00:02', '14:00:01']);
  for (const link of LINKS) assert.ok(seen.includes(link.at), 'asked for each link\'s own instant');
});

// ---------------------------------------------------------------------------
// Strings from outside

const HOSTILE = '\x1b[31mR\x1b]0;pwn\x07\x9b2J\x85‮EVIL⁦x⁩؜‎‏‪‫‬‭\x00\x7f\r\n\tZ';

function hostileState() {
  return {
    now: NOW, isOpen: true, usage: { ...usageFull },
    history: [
      { at: NOW, from: 'a1', to: HOSTILE, label: HOSTILE },
      { at: NOW + SEC, from: HOSTILE, to: 'main', label: 'report' },
    ],
    nodes: [
      { ...MAIN_NODE, model: HOSTILE, effort: HOSTILE },
      unit('gemini', 1, { feed: HOSTILE }),
      unit('grok', 2, running(HOSTILE, HOSTILE, { model: HOSTILE, effort: HOSTILE })),
      unit('codex', 3, running('a1', HOSTILE, { model: HOSTILE, openCalls: [{ callId: '1', callerId: 'a1', tool: HOSTILE, since: NOW }, { callId: '2', callerId: 'a1', tool: HOSTILE, since: NOW }] })),
      agent('a1', HOSTILE, 4, { model: HOSTILE, effort: HOSTILE, activity: HOSTILE }),
      agent('a2', `omelette-${HOSTILE}`, 5, { status: 'waiting', model: 'claude-opus-5-5', effort: HOSTILE }),
      agent('a3', 'omelette-tester', 6, { status: 'reported', activity: HOSTILE }),
    ],
  };
}

test('hostile strings (ESC, BEL, CSI, OSC, C1, bidi) in roles, models, efforts, activities, unit tools, callers and history never reach a row', () => {
  const state = hostileState();
  for (const isAscii of [false, true]) {
    for (const columns of [20, 35, 53, 71, 120]) {
      for (const rows of [6, 8, 20, 40]) {
        const out = lay(state, columns, rows, { isAscii });
        for (const row of out) for (const seg of row) assert.doesNotMatch(seg.text, UNSAFE, `${columns}x${rows} ascii=${isAscii}: ${JSON.stringify(seg.text)}`);
        for (const row of plainRows(out)) assert.ok(cells(row) <= columns, `${columns}x${rows}: ${JSON.stringify(row)}`);
        assert.ok(out.length <= rows);
      }
    }
  }
});

test('hostile strings in the status line are cleaned and cut to 60 cells', () => {
  const line = statusLine(hostileState(), NOW + MIN);
  assert.ok(line);
  assert.doesNotMatch(line, UNSAFE);
  assert.ok(cells(line) <= 60);
});

test('every width 1..160 at several heights: no row over `columns` cells, never more rows than `rows`, graph or tree, unicode or ASCII', () => {
  const rich = { ...goldenState(), history: LINKS };
  rich.nodes = [...rich.nodes, ...Array.from({ length: 6 }, (_, i) => agent(`m${i}`, `omelette-role-${'x'.repeat(i * 8)}-中文`, 10 + i, { status: i % 2 ? 'reported' : 'waiting', activity: '日本語のアクティビティ' }))];
  const bare = stateOf(idleUnits());
  for (const state of [rich, bare, hostileState()]) {
    for (const isAscii of [false, true]) {
      for (let columns = 1; columns <= 160; columns++) {
        for (const rows of [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 18, 19, 20, 21, 24, 32, 48]) {
          const out = lay(state, columns, rows, { isAscii });
          assert.ok(out.length <= rows, `${columns}x${rows} gave ${out.length} rows`);
          for (const row of plainRows(out)) assert.ok(cells(row) <= columns, `${columns}x${rows}: ${JSON.stringify(row)} is ${cells(row)} cells`);
        }
      }
    }
  }
});

test('degenerate sizes: no width or no height is no rows; a fractional size is floored', () => {
  assert.deepEqual(lay(goldenState(), 0, 24), []);
  assert.deepEqual(lay(goldenState(), 53, 0), []);
  assert.deepEqual(lay(goldenState(), -3, 10), []);
  assert.deepEqual(lay(goldenState(), Number.NaN, 10), []);
  assert.deepEqual(plain(goldenState(), 53.9, 24.9).slice(0, 18), GOLDEN_53);
});

test('wide characters in a box keep the frames aligned (measured in cells)', () => {
  const state = patched(patched(goldenState(), 'a1', { role: 'omelette-中文角色中文角色中文', activity: '日本語のテキスト長い長い' }), 'unit:grok', { activity: '検索ツール検索ツール', model: '中文模型' });
  const rows = lay(state, 53, 24);
  for (const y of [3, 4, 5, 14, 15, 16]) {
    const cellsOfRow = expand(rows[y]);
    assert.equal(cellsOfRow.length, 53, `row ${y} is 53 cells`);
    for (const x of [0, 16, 18, 34, 36, 52]) assert.equal(cellsOfRow[x].ch, '│', `row ${y} frame at ${x}`);
  }
  assert.ok(plainRows(rows)[3].includes('…'), 'the wide role is cut');
});

test('combining marks and zero-width joiners add no cells', () => {
  const state = patched(goldenState(), 'a2', { role: 'omelette-téster‍' });
  const rows = lay(state, 53, 24);
  assert.equal(cells(plainRows(rows)[3]), 53);
});

test('wide emoji in the BMP (✅ ⚡ ❌ ⭐) take two terminal cells, as Ink draws them: a row still fits `columns` by that measure', () => {
  // Reference measure for the test: the emoji-presentation BMP characters are two cells wide on a terminal.
  const ref = (text) => Array.from(text).reduce((n, ch) => n + (/[⌚⌛⏩-⏬☔☕⚡✅❌⭐⭕]/u.test(ch) ? 2 : cells(ch)), 0);
  const state = patched(goldenState(), 'a1', { role: 'omelette-✅✅✅✅✅✅✅✅✅✅✅✅', activity: '⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡' });
  const graph = plainRows(lay(state, 53, 24));
  for (const y of [3, 4, 5]) assert.equal(ref(graph[y]), 53, `graph row ${y} measured as a terminal draws it`);
  for (const columns of [20, 35]) for (const row of plain(state, columns, 40)) assert.ok(ref(row) <= columns, `${columns}: ${row} is ${ref(row)}`);
});

// ---------------------------------------------------------------------------
// The status line

test('statusLine: running agents, then running units with their durations; nothing running is undefined', () => {
  assert.equal(statusLine(goldenState(), NOW), 'fleet: coder-medium, reviewer, grok 2:17');
  const idle = stateOf([...idleUnits(), agent('a1', 'alpha', 4, { status: 'reported' }), agent('a2', 'beta', 5, { status: 'waiting' })]);
  assert.equal(statusLine(idle, NOW), undefined, 'a waiting agent is not running');
  assert.equal(statusLine(stateOf(idleUnits()), NOW), undefined);
});

test('statusLine: order is agents (by order) then units (by order); the orchestrator is not listed; units from another session count', () => {
  const state = stateOf([
    unit('codex', 3, running('other', 'research', { since: NOW - 12 * MIN, openCalls: undefined, activityCallId: undefined })),
    unit('gemini', 1, running('main', 'research', { since: NOW - 42 * SEC })),
    unit('grok', 2),
    agent('a2', 'omelette-tester', 6),
    agent('a1', 'omelette-coder', 5),
  ]);
  assert.equal(statusLine(state, NOW), 'fleet: coder, tester, gemini 0:42, codex 12m');
});

test('statusLine: cut to 60 cells with an ellipsis, in cells and not in characters', () => {
  const many = Array.from({ length: 12 }, (_, i) => agent(`s${i}`, `omelette-agent-number-${i}`, 4 + i));
  const line = statusLine(stateOf([...idleUnits(), ...many]), NOW);
  assert.ok(line.endsWith('…'));
  assert.ok(cells(line) <= 60);
  const wide = statusLine(stateOf([...idleUnits(), ...Array.from({ length: 12 }, (_, i) => agent(`w${i}`, `中文角色${i}`, 4 + i))]), NOW);
  assert.ok(cells(wide) <= 60, `${cells(wide)}`);
  assert.ok(wide.endsWith('…'));
  assert.equal(statusLine(stateOf([...idleUnits(), agent('a1', 'x'.repeat(200), 4)]), NOW).length <= 60, true);
});

// ---------------------------------------------------------------------------
// Scale

test('a state of 500 agents and 200 history links lays out in well under a second', () => {
  const agents = Array.from({ length: 500 }, (_, i) => agent(`s${i}`, `omelette-role${i}`, 10 + i, { status: i % 3 === 0 ? 'running' : 'reported', since: NOW - i * SEC }));
  const history = Array.from({ length: 200 }, (_, i) => ({ at: NOW + i, from: 'main', to: `s${i}`, label: 'Agent' }));
  const state = stateOf([...idleUnits(), ...agents], { history });
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) lay(state, 107, 48);
  assert.ok(performance.now() - t0 < 1000);
  assert.match(plain(state, 107, 48).join('\n'), /\+\d+ more/);
});
