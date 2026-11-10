/**
 * omelette-fleet :: test/mod-roles-tester.test.mjs
 * Tester, 1.8.0 Task 8: what the first test file leaves open. The model's two
 * new events (a pin counted on the day, an effort flag on a row) and a
 * hostile definition file through roles.mjs. Ids and paths are made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce } from '../mods/omelette-fleet/hooks/model.mjs';
import { frontmatterOf, readRoleDefinitions } from '../mods/omelette-fleet/hooks/roles.mjs';
import { layout } from '../mods/omelette-fleet/hooks/layout.mjs';

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const node = (state, id) => state.nodes.find((n) => n.id === id);
const run = (state, ...events) => events.reduce((s, e) => reduce(s, e), state);
const spawned = () => run(initialState(T0), { type: 'spawn', at: T0, agentId: 'a1', role: 'omelette-coder', model: 'claude-opus-5-5' });

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

test('a pin is counted on its day and the agent\'s row keeps what was asked; another day starts the count again', () => {
  const one = run(spawned(), { type: 'pinned', at: T0, agentId: 'a1', from: 'haiku', to: 'claude-opus-5-5' });
  assert.equal(one.counts.pins, 1);
  assert.deepEqual(node(one, 'a1').pinned, { from: 'haiku', to: 'claude-opus-5-5' });

  const two = run(one, { type: 'pinned', at: T0 + 1000, agentId: 'a1', from: 'sonnet', to: 'claude-opus-5-5' });
  assert.equal(two.counts.pins, 2);

  const next = run(two, { type: 'pinned', at: T0 + DAY, from: 'haiku', to: 'claude-opus-5-5' });
  assert.equal(next.counts.pins, 1, 'the day before is not carried over');
  assert.equal(next.counts.day, '2026-10-09');
});

test('a pin for an agent the pane does not hold, or with no agent id, is counted and touches no row; a pin does not erase the refusals of its day', () => {
  const base = spawned();
  const ghost = run(base, { type: 'pinned', at: T0, agentId: 'nobody', from: 'haiku', to: 'claude-opus-5-5' });
  assert.equal(ghost.counts.pins, 1);
  assert.deepEqual(ghost.nodes, base.nodes);
  const bare = run(base, { type: 'pinned', at: T0, from: 'haiku', to: 'claude-opus-5-5' });
  assert.equal(bare.counts.pins, 1);

  const mixed = run(spawned(), { type: 'refused', at: T0, agentId: 'a1', callId: 'c1', by: 'mod' }, { type: 'pinned', at: T0 + 1, agentId: 'a1', from: 'haiku', to: 'claude-opus-5-5' }, { type: 'refused', at: T0 + 2, agentId: 'a1', callId: 'c2', by: 'hook' });
  assert.deepEqual(mixed.counts, { day: '2026-10-08', refusals: { mod: 1, hook: 1 }, pins: 1 });
});

test('a pin event that is not whole (no from, no to, an empty to) changes nothing', () => {
  const base = spawned();
  for (const event of [{ from: 'haiku' }, { to: 'claude-opus-5-5' }, { from: 'haiku', to: '' }, { from: 3, to: 'x' }]) {
    assert.deepEqual(reduce(base, { type: 'pinned', at: T0, agentId: 'a1', ...event }), base, JSON.stringify(event));
  }
});

test('an effort flag lands on an agent\'s row only: a unit, an unknown id and a half event leave the state as it was', () => {
  const base = run(spawned(), { type: 'call', at: T0, agentId: 'a1', callId: 'u1', tool: 'orion-gemini__gemini_research', subject: 'x' });
  assert.deepEqual(node(reduce(base, { type: 'effort-flag', at: T0, agentId: 'a1', effort: 'low', expected: 'xhigh' }), 'a1').effortFlag, { effort: 'low', expected: 'xhigh' });
  for (const event of [{ agentId: 'nobody', effort: 'low', expected: 'xhigh' }, { agentId: 'a1', effort: 'low' }, { agentId: 'a1', expected: 'xhigh' }, { agentId: 'a1', effort: 3, expected: 'xhigh' }]) {
    assert.deepEqual(reduce(base, { type: 'effort-flag', at: T0, ...event }), base, JSON.stringify(event));
  }
});

test('the two new events do not mutate a deep-frozen state', () => {
  const frozen = deepFreeze(spawned());
  reduce(frozen, { type: 'pinned', at: T0, agentId: 'a1', from: 'haiku', to: 'claude-opus-5-5' });
  reduce(frozen, { type: 'effort-flag', at: T0, agentId: 'a1', effort: 'low', expected: 'xhigh' });
});

test('a hostile definition: a value with words, a later bad line that voids an earlier good one, other spellings of the key', () => {
  assert.deepEqual(frontmatterOf('---\nmodel: claude-opus-5-5 and more\neffort: xhigh now\n---\n'), {}, 'a sentence is no id');
  assert.deepEqual(frontmatterOf('---\nmodel: claude-opus-5-5\nmodel: two words\n---\n'), {}, 'the last line decides, and it is bad');
  assert.deepEqual(frontmatterOf('---\nmodel: two words\nmodel: claude-opus-5-5\n---\n'), { model: 'claude-opus-5-5' }, 'the last line decides, and it is good');
  assert.deepEqual(frontmatterOf('---\nModel: claude-opus-5-5\nmodel : claude-opus-5-5\n models: x\nmodelx: y\n---\n'), {}, 'only `model:` at the start of its line');
  assert.deepEqual(frontmatterOf('---\nmodel: >\n  claude-opus-5-5\n---\n'), {}, 'a block scalar is no value');
  assert.deepEqual(frontmatterOf('---\nmodel:claude-opus-5-5\n---\n'), { model: 'claude-opus-5-5' }, 'no space after the colon');
  assert.deepEqual(frontmatterOf('---\nmodel: ' + 'a'.repeat(100_000) + '\n---\n'), {}, 'a 100 KB word is past the bound');
});

test('a definition with a 50 000-space value line is read in well under a second (a cloned project\'s file is the operator\'s session blocked otherwise)', () => {
  const text = `---\nname: omelette-coder\nmodel:${' '.repeat(50_000)}x\n---\n`;
  const start = process.hrtime.bigint();
  const read = frontmatterOf(text);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.deepEqual(read, { model: 'x' });
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms for one 50 KB line`);
});

test('readRoleDefinitions: a project file the read refuses (over 4 MiB, a bad link) falls through to HOME\'s; a non-text answer leaves the role with no model', async () => {
  const $ = {
    env: { get: async () => '/h' },
    fs: {
      read: async (path) => {
        if (path === '/w/.claude/agents/omelette-coder.md') throw new Error('EFBIG: over 4 MiB');
        if (path === '/h/.claude/agents/omelette-coder.md') return '---\nmodel: claude-opus-5-5\neffort: xhigh\n---\n';
        if (path === '/w/.claude/agents/omelette-tester.md') return { base64: 'AAAA' };
        throw new Error('ENOENT');
      },
    },
  };
  const roles = await readRoleDefinitions($, '/w/');
  assert.deepEqual(roles.get('omelette-coder'), { model: 'claude-opus-5-5', effort: 'xhigh' });
  assert.equal(roles.get('omelette-tester')?.model, undefined);
});

test('readRoleDefinitions with no cwd reads HOME\'s alone', async () => {
  const reads = [];
  const $ = { env: { get: async () => '/h' }, fs: { read: async (path) => { reads.push(path); throw new Error('ENOENT'); } } };
  assert.equal((await readRoleDefinitions($, undefined)).size, 0);
  assert.deepEqual(reads.every((path) => path.startsWith('/h/.claude/agents/')), true);
  assert.equal(reads.length, 6);
});

// Round 2.
test('the value bound is VALUE\'s: 128 characters read, bare or quoted or before a comment; 129 not; a `#` with no space before it is no comment', () => {
  const id = 'a'.repeat(128);
  assert.deepEqual(frontmatterOf(`---\nmodel: ${id}\n---\n`), { model: id });
  assert.deepEqual(frontmatterOf(`---\nmodel: "${id}"\n---\n`), { model: id }, 'quoted: 130 characters on the line');
  assert.deepEqual(frontmatterOf(`---\nmodel: ${id} # why\n---\n`), { model: id }, 'a comment past the bound is cut first');
  assert.deepEqual(frontmatterOf(`---\nmodel: ${id}a\n---\n`), {});
  assert.deepEqual(frontmatterOf(`---\nmodel: "${id}a"\n---\n`), {});
  assert.deepEqual(frontmatterOf('---\nmodel: claude-opus-5-5# not a comment\n---\n'), {}, 'no whitespace before the hash: part of the value, which is no id');
});

test('the tree draws a pin and an effort flag dim, as it draws a touched record', () => {
  const state = [
    { type: 'spawn', at: T0, agentId: 'c1c1c1c1', role: 'omelette-coder', model: 'claude-opus-5-5' },
    { type: 'pinned', at: T0, agentId: 'c1c1c1c1', from: 'haiku', to: 'claude-opus-5-5' },
    { type: 'effort-flag', at: T0, agentId: 'c1c1c1c1', effort: 'low', expected: 'xhigh' },
    { type: 'tick', at: T0 + 100 },
  ].reduce(reduce, initialState(T0));
  const rows = layout(state, { columns: 52, rows: 60 });
  const noted = rows.filter((row) => row.some((segment) => /pinned|definition says/.test(segment.text)));
  assert.equal(noted.length, 2);
  for (const row of noted) assert.ok(row.some((segment) => /pinned|definition says/.test(segment.text) && segment.tone === 'dim'), JSON.stringify(row));
});
