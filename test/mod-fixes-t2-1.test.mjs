/**
 * omelette-fleet :: test/mod-fixes-t2-1.test.mjs
 * The fleet pane's model after the T2 tester's second pass (1.7.0): a unit
 * call with no call id holds nothing open, a unit keeps at most 20 open calls,
 * a unit falling back to an older call drops the newer one's model and effort,
 * one 2-hour bound shared by the model and the feed, and the test script that
 * keeps `claude plugin test` files out of `npm test`. Ids are made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN, STALE_MS, initialState, reduce } from '../mods/omelette-fleet/hooks/model.mjs';
import { parseSnapshot } from '../mods/omelette-fleet/hooks/feed.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const SEC = 1000;
const HOUR = 60 * 60 * SEC;
const GROK = 'mcp__orion-grok__grok_code_review';

const node = (state, id) => state.nodes.find((n) => n.id === id);
const run = (state, ...events) => events.reduce((s, e) => reduce(s, e), state);
const call = (at, agentId, callId, tool, subject) => ({ type: 'call', at, agentId, callId, tool, subject });
const grokFeed = (at, startedAt, model, effort) => ({
  type: 'feed', at,
  snapshots: [{ unit: 'grok', pid: 1, active: [{ id: '1-1', tool: 'grok_code_review', model, effort, startedAt }], updatedAt: startedAt, isStale: false }],
});

test('a unit call with no call id holds no open call on the unit; the loop\'s own activity is still set', () => {
  for (const callId of [undefined, '', null]) {
    const s = reduce(initialState(T0), call(T0 + SEC, MAIN, callId, GROK, 'code_review'));
    const grok = node(s, 'unit:grok');
    assert.equal(grok.status, 'idle', String(callId));
    assert.equal('openCalls' in grok, false, String(callId));
    assert.equal(node(s, MAIN).activity, 'code_review');
    assert.equal(node(s, MAIN).status, 'running');
  }
});

test('a unit keeps at most 20 open calls, the oldest dropped', () => {
  const calls = Array.from({ length: 25 }, (_, i) => call(T0 + i * SEC, MAIN, `c${i}`, GROK, 'code_review'));
  const grok = node(run(initialState(T0), ...calls), 'unit:grok');
  assert.equal(grok.openCalls.length, 20);
  assert.equal(grok.openCalls[0].callId, 'c5');
  assert.equal(grok.openCalls.at(-1).callId, 'c24');
  assert.equal(grok.activityCallId, 'c24');
});

test('a unit falling back to an older open call drops model and effort; one that keeps showing the same call keeps them', () => {
  const two = run(initialState(T0),
    call(T0, MAIN, 'old', GROK, 'code_review'),
    call(T0 + SEC, MAIN, 'new', GROK, 'code_review'),
    grokFeed(T0 + 2 * SEC, T0 + SEC, 'grok-4.7', 'high'));
  assert.equal(node(two, 'unit:grok').model, 'grok-4.7');
  assert.equal(node(two, 'unit:grok').effort, 'high');
  const afterReturn = node(reduce(two, { type: 'return', at: T0 + 3 * SEC, agentId: MAIN, callId: 'new' }), 'unit:grok');
  assert.equal(afterReturn.activityCallId, 'old');
  assert.equal('model' in afterReturn, false);
  assert.equal('effort' in afterReturn, false);
  const oldGone = node(reduce(two, { type: 'return', at: T0 + 3 * SEC, agentId: MAIN, callId: 'old' }), 'unit:grok');
  assert.equal(oldGone.activityCallId, 'new');
  assert.equal(oldGone.model, 'grok-4.7', 'the call shown did not change');

  const byAgent = run(initialState(T0),
    { type: 'spawn', at: T0, agentId: 'ag1', role: 'omelette-coder' },
    call(T0, MAIN, 'old', GROK, 'code_review'),
    call(T0 + SEC, 'ag1', 'new', GROK, 'code_review'),
    grokFeed(T0 + 2 * SEC, T0 + SEC, 'grok-4.7', 'high'),
    { type: 'stop', at: T0 + 3 * SEC, agentId: 'ag1' });
  assert.equal(node(byAgent, 'unit:grok').activityCallId, 'old');
  assert.equal('model' in node(byAgent, 'unit:grok'), false, 'after a stop');
});

test('one 2-hour bound: the model exports STALE_MS, and the feed\'s staleness turns on it', () => {
  assert.equal(STALE_MS, 2 * HOUR);
  const now = T0 + 5 * HOUR;
  const text = (updatedAt) => JSON.stringify({ schema: 2, unit: 'grok', pid: 1, updatedAt: new Date(updatedAt).toISOString(), active: [{ id: '1-1', tool: 'grok_research', startedAt: new Date(updatedAt).toISOString() }] });
  assert.equal(parseSnapshot(text(now - STALE_MS), now).isStale, false);
  assert.equal(parseSnapshot(text(now - STALE_MS - 1), now).isStale, true);
  const feedSource = readFileSync(join(ROOT, 'mods/omelette-fleet/hooks/feed.mjs'), 'utf8');
  assert.match(feedSource, /import \{[^}]*\bSTALE_MS\b[^}]*\} from '\.\/model\.mjs'/);
  assert.doesNotMatch(feedSource, /const STALE_MS/);
});

test('a tick past STALE_MS drops the old call and the unit falls back without the newer model', () => {
  const s = run(initialState(T0),
    call(T0, MAIN, 'kept', GROK, 'code_review'),
    call(T0 - HOUR, MAIN, 'gone', GROK, 'code_review'));
  const later = reduce(s, { type: 'tick', at: T0 - HOUR + STALE_MS + 1 });
  assert.deepEqual(node(later, 'unit:grok').openCalls.map((c) => c.callId), ['kept']);
});

test('npm test runs node --test over test/ only, so mods/**/tests/*.test.ts stays with claude plugin test', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test test/');
});
