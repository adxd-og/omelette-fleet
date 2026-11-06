/**
 * omelette-fleet :: test/mod-guard-1.8.0.test.mjs
 * Guard v2's mod delivery, the pure half (1.8.0, Task 7): the model's
 * `refused` event (the row shows `refused` for one tick; the day's count by
 * delivery), the touched line a stop carries, the role a forgotten agent
 * keeps, and guard.mjs's event and record names. The kit tests
 * (mods/omelette-fleet/tests/register.test.ts) run the hooks themselves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askGuard, toPreToolUse, touchedLine, touchedPath } from '../mods/omelette-fleet/hooks/guard.mjs';
import { layout, plainRows } from '../mods/omelette-fleet/hooks/layout.mjs';
import { FORGET_MS, initialState, reduce, roleOf } from '../mods/omelette-fleet/hooks/model.mjs';
import { svgOf } from '../mods/omelette-fleet/hooks/svg.mjs';

const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const run = (state, ...events) => events.reduce(reduce, state);
const nodeOf = (state, id) => state.nodes.find((n) => n.id === id);

/** An omelette-coder `c1`, running, with a Read of its own still out. */
const withCoder = () => run(initialState(T0),
  { type: 'spawn', at: T0, agentId: 'c1', role: 'omelette-coder' },
  { type: 'call', at: T0 + 10, agentId: 'c1', callId: 'read1', tool: 'Read', subject: 'Read: a.mjs' });

test('a refusal shows `refused` on its loop\'s row until a tick has drawn it, then the row shows its open call again', () => {
  const ticked = run(withCoder(), { type: 'tick', at: T0 + 500 });
  const refused = reduce(ticked, { type: 'refused', at: T0 + 700, agentId: 'c1', callId: 'bash1', by: 'mod' });

  assert.equal(nodeOf(refused, 'c1').activity, 'refused');
  assert.equal(nodeOf(refused, 'c1').status, 'running');

  const drawing = reduce(refused, { type: 'tick', at: T0 + 1500 });
  assert.equal(nodeOf(drawing, 'c1').activity, 'refused', 'the first tick after it draws it');

  const after = reduce(drawing, { type: 'tick', at: T0 + 2500 });
  assert.equal(nodeOf(after, 'c1').activity, 'Read: a.mjs');
  assert.equal(nodeOf(after, 'c1').activityCallId, 'read1');
  assert.equal(nodeOf(after, 'c1').refusedAt, undefined);
});

test('refusals are counted for the day by delivery, start again on a new UTC day, and an unknown delivery counts nothing', () => {
  const state = run(withCoder(),
    { type: 'refused', at: T0, agentId: 'c1', by: 'mod' },
    { type: 'refused', at: T0 + 1, agentId: 'main', by: 'mod' },
    { type: 'refused', at: T0 + 2, agentId: 'c1', by: 'hook' });

  assert.deepEqual(state.counts, { day: '2026-11-03', refusals: { mod: 2, hook: 1 } });
  assert.deepEqual(reduce(state, { type: 'refused', at: T0 + DAY, agentId: 'c1', by: 'mod' }).counts, { day: '2026-11-04', refusals: { mod: 1 } });
  assert.equal(reduce(state, { type: 'refused', at: T0 + 3, agentId: 'c1', by: 'settings' }), state);
});

test('a stop carries the touched line onto the row; a later stop without one leaves none', () => {
  const stopped = reduce(withCoder(), { type: 'stop', at: T0 + 100, agentId: 'c1', touched: 'touched: .omelette/reports/touched-omelette-coder-c1.md — 2 files' });

  assert.equal(nodeOf(stopped, 'c1').touched, 'touched: .omelette/reports/touched-omelette-coder-c1.md — 2 files');
  assert.equal('touched' in nodeOf(reduce(stopped, { type: 'stop', at: T0 + 200, agentId: 'c1' }), 'c1'), false);
});

test('a forgotten agent keeps its role for the guard: roleOf reads the forgotten list', () => {
  const forgotten = run(withCoder(), { type: 'stop', at: T0 + 100, agentId: 'c1' }, { type: 'tick', at: T0 + 100 + FORGET_MS + 1 });

  assert.equal(nodeOf(forgotten, 'c1'), undefined);
  assert.equal(roleOf(forgotten, 'c1'), 'omelette-coder');
  assert.equal(roleOf(forgotten, 'main'), undefined, 'the main loop has no role to send');
});

test('the touched record\'s name takes plain names only, and its line counts the listed paths', () => {
  assert.equal(touchedPath('omelette-coder', 'a1b2c3d4e5f6'), '.omelette/reports/touched-omelette-coder-a1b2c3d4.md');
  for (const [role, id] of [['../../x', 'a1b2c3d4'], ['omelette-coder', 'a/b'], ['plugin:coder', 'a1'], ['', 'a1'], ['omelette-coder', 'x'.repeat(65)]]) {
    assert.equal(touchedPath(role, id), undefined, `${role} ${id}`);
  }
  assert.equal(touchedLine('r.md', '# touched — r\n\n- a.mjs (Write)\n\ntool calls: 1 (Write: 1)\n'), 'touched: r.md — 1 file');
});

test('the PreToolUse event leaves the engine\'s keys out of tool_input, and says no role and no cwd it does not have', () => {
  const event = toPreToolUse({ tool: 'Bash', command: 'ls', tool_use_id: 't1', agentId: 'c1', requestMeta: { k: 'v' }, consent: 'yes' }, undefined, undefined);

  assert.deepEqual(event, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
});

// Round 2: the deny text is capped, and the pane draws the touched line.

const bytesOf = (text) => new TextEncoder().encode(text).length;
/** askGuard against a `$` whose `node <script>` exits 2 with `stderr`. */
const denyOf = async (stderr) => (await askGuard({
  env: { get: async () => '/n' },
  fs: { exists: async () => true },
  ui: { log: () => undefined },
  process: { run: async () => ({ exitCode: 2, stdout: '', stderr }) },
}, '/p/.claude/hooks/omelette-guard.mjs', {})).deny;

test('the deny text: ANSI escapes stripped, cut to 2 KB of UTF-8 with " …" when cut, whole when short', async () => {
  const coloured = await denyOf('\x1b[31mrefused\x1b[0m: \x1b]8;;https://x\x07link\x1b]8;;\x07 \x1b[1;4mbold\x1b[m\n');
  assert.equal(coloured, 'refused: link bold');

  for (const unit of ['\x1b[31mrefused\x1b[0m ', 'é€😀 ']) {
    const deny = await denyOf(unit.repeat(Math.ceil((1 << 20) / unit.length)));
    assert.ok(bytesOf(deny) <= 2048, `${bytesOf(deny)} bytes`);
    assert.ok(bytesOf(deny) > 2000, 'cut near the cap, not far below it');
    assert.equal(deny.includes('\x1b'), false);
    assert.ok(deny.endsWith(' …'));
    assert.equal(deny.includes('\uFFFD'), false, 'no code point cut in half');
  }
});

const TOUCHED = 'touched: .omelette/reports/touched-omelette-coder-a1b2c3d4.md — 2 files';
const SHORT = 'touched-omelette-coder-a1b2c3d4.md — 2 files';
/** A coder `a1b2c3d4e5f6` that stopped with a touched record (or none), and a reviewer still running. */
const stoppedCoder = (touched) => run(initialState(T0),
  { type: 'spawn', at: T0, agentId: 'a1b2c3d4e5f6', role: 'omelette-coder' },
  { type: 'spawn', at: T0, agentId: 'r1', role: 'omelette-reviewer' },
  { type: 'stop', at: T0 + 100, agentId: 'a1b2c3d4e5f6', ...(touched === undefined ? {} : { touched }) },
  { type: 'tick', at: T0 + 200 });
const drawn = (state, columns) => layout(state, { columns, rows: 60 });
const touchedRowsOf = (rows) => rows.filter((row) => row.some((segment) => segment.text.includes('touched')));

test('the terminal draws a reported agent\'s touched line as one dim row under the graph, whole when it fits, the file name and count when not', () => {
  const wide = drawn(stoppedCoder(TOUCHED), 100);
  assert.deepEqual(touchedRowsOf(wide), [[{ text: TOUCHED, tone: 'dim' }]]);
  const at = plainRows(wide).indexOf(TOUCHED);
  assert.ok(at > plainRows(wide).findIndex((row) => row.includes('gemini')), 'under the graph');
  assert.ok(at < plainRows(wide).findIndex((row) => / → /.test(row)), 'above the history');

  // TOUCHED is 71 cells, the narrowest graph: one more file and it no longer fits.
  const longer = TOUCHED.replace('— 2 files', '— 12 files');
  assert.deepEqual(touchedRowsOf(drawn(stoppedCoder(longer), 71)), [[{ text: SHORT.replace('— 2 files', '— 12 files'), tone: 'dim' }]]);
  assert.deepEqual(touchedRowsOf(drawn(stoppedCoder(undefined), 100)), [], 'no record, no row');
  const resumed = reduce(stoppedCoder(TOUCHED), { type: 'step', at: T0 + 300, agentId: 'a1b2c3d4e5f6', model: 'claude-opus-5-5' });
  assert.deepEqual(touchedRowsOf(drawn(resumed, 100)), [], 'running again: the line is the last run\'s, not drawn');
});

test('the tree draws the touched line under its agent\'s own rows', () => {
  const rows = plainRows(drawn(stoppedCoder(TOUCHED), 52));
  const coder = rows.findIndex((row) => row.includes('· coder'));
  assert.equal(rows[coder + 2], `│   ${SHORT}`);
  assert.match(rows[coder + 3], /reviewer/, 'the next actor follows it');
  assert.equal(touchedRowsOf(drawn(stoppedCoder(undefined), 52)).length, 0);
});

test('the Svg draws the touched line dim under the units and grows by its row; the alt carries it too', () => {
  const bare = svgOf(stoppedCoder(undefined));
  const with1 = svgOf(stoppedCoder(TOUCHED));
  assert.equal(bare.source.includes('touched'), false);
  // The Svg is drawn at 71 cells, where TOUCHED (71 cells) fits whole.
  const whole = TOUCHED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(with1.source, new RegExp(`<g opacity="0\\.5"><text x="\\d+" y="\\d+">${whole}</text></g></svg>$`));
  assert.equal(with1.height, bare.height + 16 + 10);
  assert.ok(with1.alt.split('\n').includes(TOUCHED));
});

test('past six notes the graph and the Svg show the newest six under a "+K more notes" line', () => {
  let state = initialState(T0);
  for (let i = 1; i <= 8; i++) {
    const id = `${i}`.repeat(8);
    state = run(state, { type: 'spawn', at: T0, agentId: id, role: 'omelette-tester' }, { type: 'stop', at: T0 + i, agentId: id, touched: `touched: .omelette/reports/touched-omelette-tester-${id}.md — ${i} files` });
  }
  const rows = plainRows(drawn(state, 160)).filter((row) => row.includes('touched') || row.includes('more notes'));
  assert.deepEqual(rows, ['+2 more notes', ...[3, 4, 5, 6, 7, 8].map((i) => `touched: .omelette/reports/touched-omelette-tester-${`${i}`.repeat(8)}.md — ${i} files`)]);
  const { source } = svgOf(state);
  assert.equal((source.match(/ files<\/text>/g) ?? []).length, 6);
  assert.ok(source.includes('>+2 more notes</text>'));
});
