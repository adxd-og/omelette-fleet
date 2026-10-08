/**
 * omelette-fleet :: test/tester-1.7.0-t2.test.mjs
 * The tester's tests for 1.7.0 Task 2 (the fleet model): model.mjs, feed.mjs,
 * text.mjs under mods/omelette-fleet/hooks/. Written from the plan's Task 2,
 * its Review Focus 1, 2 and 5, the orchestrator's rulings where the plan was
 * open, and docs/STATUS-FEED.md (schema 2) - not from the code. Composed
 * sequences, purity on every event type, boundaries of every text function,
 * the feed's parser on the documented example, and the isolation of the
 * three files. Ids are made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAIN, STALE_MS, UNITS, initialState, reduce, unitOfTool } from '../mods/omelette-fleet/hooks/model.mjs';
import { parseSnapshot, snapshotNames } from '../mods/omelette-fleet/hooks/feed.mjs';
import { cells, clock, cut, duration, familyOf, shortModel, shortRole, subjectOf } from '../mods/omelette-fleet/hooks/text.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOKS = join(ROOT, 'mods', 'omelette-fleet', 'hooks');
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const GROK_REVIEW = 'mcp__orion-grok__grok_code_review';
const GEMINI_RESEARCH = 'mcp__orion-gemini__gemini_research';
const CODEX_REVIEW = 'mcp__orion-codex__codex_code_review';

const node = (s, id) => s.nodes.find((n) => n.id === id);
const run = (s, ...events) => events.reduce((acc, e) => reduce(acc, e), s);
const spawn = (at, agentId, role, extra = {}) => ({ type: 'spawn', at, agentId, role, ...extra });
const call = (at, agentId, callId, tool, subject, extra = {}) => ({ type: 'call', at, agentId, callId, tool, subject, ...extra });
const ret = (at, agentId, callId) => ({ type: 'return', at, agentId, callId });
const stop = (at, agentId) => ({ type: 'stop', at, agentId });
const agents = (at, list) => ({ type: 'agents', at, list });
const feedEv = (at, snapshots) => ({ type: 'feed', at, snapshots });
const snap = (unit, active = [], extra = {}) => ({ unit, pid: 4242, active, updatedAt: T0, isStale: false, ...extra });
const fcall = (tool, startedAt, model = 'm-1', effort = 'high') => ({ id: '4242-1', tool, model, effort, startedAt });

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// unitOfTool
// ---------------------------------------------------------------------------

test('unitOfTool: every unit under several server prefixes, and the names that must be null', () => {
  for (const server of ['orion-grok', 'omelette-grok', 'x', 'plugin_a_b', 'my-server']) {
    assert.deepEqual(unitOfTool(`mcp__${server}__grok_code_review`), { unit: 'grok', tool: 'code_review' }, server);
    assert.deepEqual(unitOfTool(`mcp__${server}__gemini_research`), { unit: 'gemini', tool: 'research' }, server);
    assert.deepEqual(unitOfTool(`mcp__${server}__codex_code_review`), { unit: 'codex', tool: 'code_review' }, server);
  }
  assert.deepEqual(unitOfTool('mcp__x__gemini_deep_research'), { unit: 'gemini', tool: 'deep_research' });
  assert.deepEqual(unitOfTool('mcp__x__codex_image'), { unit: 'codex', tool: 'image' });
  assert.deepEqual(unitOfTool('mcp__x__grok_image_edit'), { unit: 'grok', tool: 'image_edit' });
  for (const other of [
    'mcp__omelette__get_usage',
    'Bash',
    'Agent',
    'SendMessage',
    'grok_code_review', // not an MCP name at all
    'mcp__grok_code_review', // no server segment
    'mcp__x__grok', // no tool part
    'mcp__x__grok_', // empty tool part
    'mcp__x__grokx_review', // a look-alike unit
    'mcp__x__Grok_review', // case matters
    'mcp__x__xgrok_review',
    'mcp__x__jaravis_research', // retired unit
    'mcp__x__',
    'mcp__',
    '',
    undefined,
    null,
    42,
    {},
  ]) {
    assert.equal(unitOfTool(other), null, String(other));
  }
});

// ---------------------------------------------------------------------------
// events table: rows not pinned elsewhere
// ---------------------------------------------------------------------------

test('spawn: the agent is running under main by default, with order after the units; no model given leaves the field absent', () => {
  const s = reduce(initialState(T0), spawn(T0 + SEC, 'ag1', 'omelette-coder'));
  const a = node(s, 'ag1');
  assert.equal(a.kind, 'agent');
  assert.equal(a.role, 'omelette-coder');
  assert.equal(a.status, 'running');
  assert.equal(a.since, T0 + SEC);
  assert.equal(a.parentId, 'main');
  assert.equal(a.order, 4);
  assert.equal('model' in a, false);
  assert.deepEqual(s.history, [{ at: T0 + SEC, from: 'main', to: 'ag1', label: 'Agent' }]);
  // an empty parentId is still the main loop
  const s2 = reduce(s, spawn(T0 + 2 * SEC, 'ag2', 'Explore', { parentId: '', model: 'claude-haiku-4-5' }));
  assert.equal(node(s2, 'ag2').parentId, 'main');
  assert.equal(node(s2, 'ag2').order, 5);
  assert.equal(node(s2, 'ag2').model, 'claude-haiku-4-5');
});

test('spawn of a known agent updates it in place: running again, since the spawn, order kept, one more Agent link', () => {
  let s = run(initialState(T0), spawn(T0, 'ag1', 'omelette-coder', { model: 'claude-opus-5-5' }), spawn(T0 + SEC, 'ag2', 'x'), stop(T0 + 5 * SEC, 'ag1'));
  assert.equal(node(s, 'ag1').status, 'reported');
  s = reduce(s, spawn(T0 + 9 * SEC, 'ag1', 'omelette-coder', { model: 'claude-opus-5-5' }));
  assert.equal(s.nodes.filter((n) => n.id === 'ag1').length, 1);
  assert.equal(node(s, 'ag1').status, 'running');
  assert.equal(node(s, 'ag1').since, T0 + 9 * SEC);
  assert.equal(node(s, 'ag1').order, 4);
  assert.equal(s.history.filter((l) => l.label === 'Agent' && l.to === 'ag1').length, 2);
});

test('step: the main loop gets model and effort; a running agent keeps its since and activity; a call-bearing loop is not disturbed', () => {
  let s = run(initialState(T0), spawn(T0, 'ag1', 'x'), call(T0 + SEC, 'ag1', 'c1', 'Bash', 'Bash: npm test'));
  const before = node(s, 'ag1');
  s = reduce(s, { type: 'step', at: T0 + 5 * SEC, agentId: 'ag1', model: 'claude-opus-5-5', effort: 'xhigh' });
  const a = node(s, 'ag1');
  assert.equal(a.model, 'claude-opus-5-5');
  assert.equal(a.effort, 'xhigh');
  assert.equal(a.activity, 'Bash: npm test');
  assert.equal(a.activityCallId, 'c1');
  assert.equal(a.since, before.since);
  assert.equal(a.status, 'running');
  s = reduce(s, { type: 'step', at: T0 + 6 * SEC, agentId: MAIN, model: 'claude-fable-5-1', effort: 'xhigh' });
  assert.equal(node(s, MAIN).model, 'claude-fable-5-1');
  assert.equal(node(s, MAIN).effort, 'xhigh');
});

test('call: the loop and the unit both take since: at (the ruling), and main goes running from idle', () => {
  const s = reduce(initialState(T0), call(T0 + 7 * SEC, MAIN, 'c1', GROK_REVIEW, 'code_review'));
  assert.equal(node(s, MAIN).status, 'running');
  assert.equal(node(s, MAIN).since, T0 + 7 * SEC);
  assert.equal(node(s, MAIN).activity, 'code_review');
  assert.equal(node(s, MAIN).activityCallId, 'c1');
  const u = node(s, 'unit:grok');
  assert.equal(u.status, 'running');
  assert.equal(u.callerId, MAIN);
  assert.equal(u.activity, 'code_review');
  assert.equal(u.since, T0 + 7 * SEC);
  assert.deepEqual(s.history, [{ at: T0 + 7 * SEC, from: MAIN, to: 'unit:grok', label: 'code_review' }]);
});

test('call: no subject falls back to the tool name; a plain tool adds no link; a waiting or reported agent goes running', () => {
  let s = run(initialState(T0), spawn(T0, 'ag1', 'x'), agents(T0 + SEC, [{ id: 'ag1', type: 'x', status: 'waiting' }]));
  assert.equal(node(s, 'ag1').status, 'waiting');
  const hist = s.history.length;
  s = reduce(s, { type: 'call', at: T0 + 2 * SEC, agentId: 'ag1', callId: 'c1', tool: 'Grep' });
  assert.equal(node(s, 'ag1').activity, 'Grep');
  assert.equal(node(s, 'ag1').status, 'running');
  assert.equal(s.history.length, hist);
  s = run(s, stop(T0 + 3 * SEC, 'ag1'), call(T0 + 4 * SEC, 'ag1', 'c2', 'Read', 'Read a.mjs'));
  assert.equal(node(s, 'ag1').status, 'running');
  assert.equal(node(s, 'ag1').activity, 'Read a.mjs');
});

test('call: SendMessage to main, to an agent id and to a raw name; the caller is the link\'s from; no target, no link', () => {
  let s = run(initialState(T0), spawn(T0, 'ag1', 'x'), spawn(T0, 'ag2', 'y'));
  const base = s.history.length;
  s = run(
    s,
    call(T0 + SEC, 'ag1', 'c1', 'SendMessage', 'SendMessage', { target: 'main' }),
    call(T0 + 2 * SEC, MAIN, 'c2', 'SendMessage', 'SendMessage', { target: 'ag2' }),
    call(T0 + 3 * SEC, 'ag2', 'c3', 'SendMessage', 'SendMessage', { target: 'researcher' }),
    call(T0 + 4 * SEC, 'ag2', 'c4', 'SendMessage', 'SendMessage'),
  );
  assert.deepEqual(s.history.slice(base), [
    { at: T0 + SEC, from: 'ag1', to: 'main', label: 'SendMessage' },
    { at: T0 + 2 * SEC, from: 'main', to: 'ag2', label: 'SendMessage' },
    { at: T0 + 3 * SEC, from: 'ag2', to: 'researcher', label: 'SendMessage' },
  ]);
});

test('return: the loop\'s activity and the unit are both cleared by their own call; nothing else is touched', () => {
  let s = run(initialState(T0), call(T0 + SEC, MAIN, 'c1', CODEX_REVIEW, 'code_review'));
  s = reduce(s, ret(T0 + 30 * SEC, MAIN, 'c1'));
  assert.equal('activity' in node(s, MAIN), false);
  assert.equal('activityCallId' in node(s, MAIN), false);
  const u = node(s, 'unit:codex');
  assert.equal(u.status, 'idle');
  assert.equal(u.lastEndedAt, T0 + 30 * SEC);
  assert.equal('activity' in u, false);
  assert.equal('callerId' in u, false);
  assert.equal('activityCallId' in u, false);
});

test('return with a call id nobody holds, or none, changes nothing (deep-equal state)', () => {
  const s = run(initialState(T0), spawn(T0, 'ag1', 'x'), call(T0 + SEC, 'ag1', 'c1', GROK_REVIEW, 'code_review'));
  assert.deepEqual(reduce(s, ret(T0 + 5 * SEC, 'ag1', 'zzz')), s);
  assert.deepEqual(reduce(s, ret(T0 + 5 * SEC, MAIN, 'zzz')), s);
  assert.deepEqual(reduce(s, { type: 'return', at: T0 + 5 * SEC, agentId: 'ag1' }), s);
});

test('return whose call id belongs to another loop leaves this loop\'s own activity alone', () => {
  let s = run(initialState(T0), spawn(T0, 'ag1', 'x'), call(T0 + SEC, 'ag1', 'c1', 'Bash', 'Bash: ls'), call(T0 + 2 * SEC, MAIN, 'c2', 'Read', 'Read a.mjs'));
  // main reports the return of ag1's call id: ag1 keeps its activity, main keeps its own
  s = reduce(s, ret(T0 + 3 * SEC, MAIN, 'c1'));
  assert.equal(node(s, 'ag1').activity, 'Bash: ls');
  assert.equal(node(s, 'ag1').activityCallId, 'c1');
  assert.equal(node(s, MAIN).activity, 'Read a.mjs');
  assert.equal(node(s, MAIN).activityCallId, 'c2');
  // and the other way round
  s = reduce(s, ret(T0 + 4 * SEC, 'ag1', 'c2'));
  assert.equal(node(s, 'ag1').activity, 'Bash: ls');
  assert.equal(node(s, MAIN).activity, 'Read a.mjs');
  // the owners' returns clear them
  s = run(s, ret(T0 + 5 * SEC, 'ag1', 'c1'), ret(T0 + 6 * SEC, MAIN, 'c2'));
  assert.equal('activity' in node(s, 'ag1'), false);
  assert.equal('activity' in node(s, MAIN), false);
});

test('stop: since the stop, activity cleared, a link to the parent; an agent known only from the engine\'s list reports to its listed parent', () => {
  let s = run(
    initialState(T0),
    spawn(T0, 'a1', 'x'),
    agents(T0 + SEC, [{ id: 'listed', type: 'Explore', status: 'running', parentId: 'a1' }, { id: 'orphan', type: 'Plan', status: 'running' }]),
    call(T0 + 2 * SEC, 'listed', 'c1', 'Grep', 'Grep'),
  );
  s = run(s, stop(T0 + 9 * SEC, 'listed'), stop(T0 + 10 * SEC, 'orphan'));
  assert.equal(node(s, 'listed').status, 'reported');
  assert.equal(node(s, 'listed').since, T0 + 9 * SEC);
  assert.equal('activity' in node(s, 'listed'), false);
  assert.deepEqual(s.history.slice(-2), [
    { at: T0 + 9 * SEC, from: 'listed', to: 'a1', label: 'report' },
    { at: T0 + 10 * SEC, from: 'orphan', to: 'main', label: 'report' },
  ]);
});

test('usage replaces (does not merge) and does not alias the event\'s object', () => {
  const ev = { type: 'usage', at: T0, usage: { contextPercent: 40, costUsd: 1.5 } };
  let s = reduce(initialState(T0), ev);
  assert.deepEqual(s.usage, { contextPercent: 40, costUsd: 1.5 });
  ev.usage.contextPercent = 99; // the caller reuses its object
  assert.equal(s.usage.contextPercent, 40);
  s = reduce(s, { type: 'usage', at: T0 + SEC, usage: { fiveHour: 12 } });
  assert.deepEqual(s.usage, { fiveHour: 12 });
});

test('open and close: only isOpen changes, repeated events are harmless', () => {
  const s0 = run(initialState(T0), spawn(T0, 'a1', 'x'));
  const s1 = run(s0, { type: 'open', at: T0 + 1 }, { type: 'open', at: T0 + 2 });
  assert.equal(s1.isOpen, true);
  assert.deepEqual({ ...s1, isOpen: false }, s0);
  const s2 = run(s1, { type: 'close', at: T0 + 3 }, { type: 'close', at: T0 + 4 });
  assert.deepEqual(s2, s0);
});

// ---------------------------------------------------------------------------
// sequences
// ---------------------------------------------------------------------------

test('sequence: spawn -> step -> call -> unit call -> return -> stop, every intermediate state', () => {
  let s = initialState(T0);
  s = reduce(s, spawn(T0 + 1 * SEC, 'ag1', 'omelette-coder', { model: 'claude-opus-5-5' }));
  assert.equal(node(s, 'ag1').status, 'running');
  s = reduce(s, { type: 'step', at: T0 + 2 * SEC, agentId: 'ag1', model: 'claude-opus-5-5', effort: 'xhigh' });
  assert.equal(node(s, 'ag1').effort, 'xhigh');
  s = reduce(s, call(T0 + 3 * SEC, 'ag1', 'c1', 'Bash', 'Bash: npm test'));
  assert.equal(node(s, 'ag1').activity, 'Bash: npm test');
  // a second call of the same loop (parallel tools) replaces the slot; unit goes running
  s = reduce(s, call(T0 + 4 * SEC, 'ag1', 'c2', GEMINI_RESEARCH, 'research'));
  assert.equal(node(s, 'ag1').activity, 'research');
  assert.equal(node(s, 'ag1').activityCallId, 'c2');
  assert.equal(node(s, 'unit:gemini').status, 'running');
  assert.equal(node(s, 'unit:gemini').callerId, 'ag1');
  // the earlier call's late return is foreign now
  s = reduce(s, ret(T0 + 5 * SEC, 'ag1', 'c1'));
  assert.equal(node(s, 'ag1').activityCallId, 'c2');
  assert.equal(node(s, 'unit:gemini').status, 'running');
  s = reduce(s, ret(T0 + 20 * SEC, 'ag1', 'c2'));
  assert.equal('activity' in node(s, 'ag1'), false);
  assert.equal(node(s, 'unit:gemini').status, 'idle');
  assert.equal(node(s, 'unit:gemini').lastEndedAt, T0 + 20 * SEC);
  s = reduce(s, stop(T0 + 30 * SEC, 'ag1'));
  assert.equal(node(s, 'ag1').status, 'reported');
  assert.deepEqual(
    s.history.map((l) => [l.from, l.to, l.label]),
    [['main', 'ag1', 'Agent'], ['ag1', 'unit:gemini', 'research'], ['ag1', 'main', 'report']],
  );
  assert.deepEqual(s.history.map((l) => l.at), [T0 + SEC, T0 + 4 * SEC, T0 + 30 * SEC]);
});

test('sequence: nested agents - grandchild calls a unit, stops, then its parent stops; reports go one level up each', () => {
  let s = run(
    initialState(T0),
    spawn(T0 + 1, 'A', 'omelette-coder'),
    spawn(T0 + 2, 'B', 'Explore', { parentId: 'A' }),
    call(T0 + 3, 'B', 'c1', CODEX_REVIEW, 'code_review'),
  );
  assert.equal(node(s, 'B').parentId, 'A');
  assert.equal(node(s, 'unit:codex').callerId, 'B');
  s = run(s, ret(T0 + 4, 'B', 'c1'), stop(T0 + 5, 'B'), stop(T0 + 6, 'A'));
  assert.deepEqual(
    s.history.map((l) => `${l.from}>${l.to}:${l.label}`),
    ['main>A:Agent', 'A>B:Agent', 'B>unit:codex:code_review', 'B>A:report', 'A>main:report'],
  );
  assert.deepEqual(s.nodes.map((n) => n.order), [0, 1, 2, 3, 4, 5]);
});

test('sequence: two agents call the same unit; the first one\'s return does not idle a unit the second still holds', () => {
  let s = run(
    initialState(T0),
    spawn(T0, 'A', 'x'),
    spawn(T0, 'B', 'y'),
    call(T0 + 1 * SEC, 'A', 'cA', GROK_REVIEW, 'code_review'),
    call(T0 + 2 * SEC, 'B', 'cB', GROK_REVIEW, 'code_review'),
  );
  assert.equal(node(s, 'unit:grok').callerId, 'B');
  s = reduce(s, ret(T0 + 3 * SEC, 'A', 'cA'));
  assert.equal('activity' in node(s, 'A'), false);
  assert.equal(node(s, 'B').activity, 'code_review');
  assert.equal(node(s, 'unit:grok').status, 'running');
  assert.equal(node(s, 'unit:grok').callerId, 'B');
  s = reduce(s, ret(T0 + 4 * SEC, 'B', 'cB'));
  assert.equal(node(s, 'unit:grok').status, 'idle');
  assert.equal(s.history.filter((l) => l.to === 'unit:grok').length, 2);
});

test('sequence: a resumed agent - reported, then a step, a call or the engine\'s list brings it back with a new since', () => {
  const base = run(initialState(T0), spawn(T0, 'A', 'x'), stop(T0 + SEC, 'A'));
  assert.equal(node(base, 'A').status, 'reported');
  const viaStep = reduce(base, { type: 'step', at: T0 + 10 * SEC, agentId: 'A', model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(node(viaStep, 'A').status, 'running');
  assert.equal(node(viaStep, 'A').since, T0 + 10 * SEC);
  assert.equal('activity' in node(viaStep, 'A'), false);
  const viaCall = reduce(base, call(T0 + 11 * SEC, 'A', 'c1', 'Read', 'Read a.mjs'));
  assert.equal(node(viaCall, 'A').status, 'running');
  assert.equal(node(viaCall, 'A').since, T0 + 11 * SEC);
  const viaList = reduce(base, agents(T0 + 12 * SEC, [{ id: 'A', type: 'x', status: 'running' }]));
  assert.equal(node(viaList, 'A').status, 'running');
  assert.equal(node(viaList, 'A').since, T0 + 12 * SEC);
  // a second stop reports again
  const again = reduce(viaStep, stop(T0 + 20 * SEC, 'A'));
  assert.equal(node(again, 'A').status, 'reported');
  assert.equal(again.history.filter((l) => l.label === 'report').length, 2);
});

test('sequence: an unreturned unit call is replaced by the same loop\'s next call to that unit, and the old return is then foreign', () => {
  let s = run(initialState(T0), call(T0, MAIN, 'c1', GROK_REVIEW, 'code_review'), call(T0 + 5 * MIN, MAIN, 'c2', GROK_REVIEW, 'code_review'));
  assert.equal(node(s, 'unit:grok').activityCallId, 'c2');
  assert.equal(node(s, 'unit:grok').since, T0 + 5 * MIN);
  s = reduce(s, ret(T0 + 6 * MIN, MAIN, 'c1'));
  assert.equal(node(s, 'unit:grok').status, 'running');
  assert.equal(node(s, MAIN).activityCallId, 'c2');
  s = reduce(s, ret(T0 + 7 * MIN, MAIN, 'c2'));
  assert.equal(node(s, 'unit:grok').status, 'idle');
});

// ---------------------------------------------------------------------------
// agents event (Review Focus 1 and the status ruling)
// ---------------------------------------------------------------------------

test('agents (Review Focus 1): after a hot reload the engine\'s list alone builds the agents, in list order, without model or effort; a later step adds them', () => {
  let s = initialState(T0);
  s = reduce(s, agents(T0 + SEC, [
    { id: 'r1', type: 'omelette-coder', status: 'running' },
    { id: 'r2', type: 'omelette-tester', status: 'waiting', parentId: 'r1' },
    { id: 'r3', type: 'Explore', status: 'completed' },
  ]));
  assert.deepEqual(s.nodes.slice(4).map((n) => [n.id, n.kind, n.role, n.status, n.parentId, n.order]), [
    ['r1', 'agent', 'omelette-coder', 'running', 'main', 4],
    ['r2', 'agent', 'omelette-tester', 'waiting', 'r1', 5],
    ['r3', 'agent', 'Explore', 'reported', 'main', 6],
  ]);
  for (const n of s.nodes.slice(4)) {
    assert.equal('model' in n, false);
    assert.equal('effort' in n, false);
    assert.equal(n.since, T0 + SEC);
  }
  // the same list again is a no-op (nothing changed, so no since moves)
  assert.deepEqual(reduce(s, agents(T0 + 99 * SEC, [{ id: 'r1', type: 'omelette-coder', status: 'running' }, { id: 'r2', type: 'omelette-tester', status: 'idle', parentId: 'r1' }])), s);
  s = reduce(s, { type: 'step', at: T0 + 5 * SEC, agentId: 'r1', model: 'claude-opus-5-5', effort: 'xhigh' });
  assert.equal(node(s, 'r1').model, 'claude-opus-5-5');
  assert.equal(node(s, 'r1').effort, 'xhigh');
  assert.equal('model' in node(s, 'r2'), false);
  // a hot-reloaded agent can later be stopped, with its report going to its listed parent
  s = reduce(s, stop(T0 + 9 * SEC, 'r2'));
  assert.deepEqual(s.history.at(-1), { at: T0 + 9 * SEC, from: 'r2', to: 'r1', label: 'report' });
});

test('agents: all seven engine statuses map as ruled, for a new agent and for a known one that was running', () => {
  const table = [
    ['pending', 'running'],
    ['running', 'running'],
    ['waiting', 'waiting'],
    ['idle', 'waiting'],
    ['completed', 'reported'],
    ['failed', 'reported'],
    ['killed', 'reported'],
  ];
  for (const [engine, wanted] of table) {
    const fresh = reduce(initialState(T0), agents(T0, [{ id: 'z', type: 'x', status: engine }]));
    assert.equal(node(fresh, 'z').status, wanted, `new ${engine}`);
    const known = run(initialState(T0), spawn(T0, 'z', 'x'), agents(T0 + SEC, [{ id: 'z', type: 'x', status: engine }]));
    assert.equal(node(known, 'z').status, wanted, `known ${engine}`);
  }
});

test('agents: a change of status sets since to the event\'s at; an unchanged status leaves since and the whole node alone', () => {
  let s = run(initialState(T0), spawn(T0, 'z', 'x'), call(T0 + SEC, 'z', 'c1', 'Bash', 'Bash: ls'));
  const same = reduce(s, agents(T0 + 10 * SEC, [{ id: 'z', type: 'x', status: 'running' }]));
  assert.deepEqual(node(same, 'z'), node(s, 'z'));
  s = reduce(s, agents(T0 + 10 * SEC, [{ id: 'z', type: 'x', status: 'waiting' }]));
  assert.equal(node(s, 'z').status, 'waiting');
  assert.equal(node(s, 'z').since, T0 + 10 * SEC);
  s = reduce(s, agents(T0 + 20 * SEC, [{ id: 'z', type: 'x', status: 'running' }]));
  assert.equal(node(s, 'z').status, 'running');
  assert.equal(node(s, 'z').since, T0 + 20 * SEC);
});

test('agents: a reported agent stays reported while the engine says idle (any number of times), but runs again on running or waiting', () => {
  let s = run(initialState(T0), spawn(T0, 'z', 'x'), stop(T0 + SEC, 'z'));
  const idle = agents(T0 + 5 * SEC, [{ id: 'z', type: 'x', status: 'idle' }]);
  assert.deepEqual(reduce(s, idle), s);
  assert.deepEqual(run(s, idle, idle), s);
  for (const done of ['completed', 'failed', 'killed']) {
    assert.deepEqual(reduce(s, agents(T0 + 5 * SEC, [{ id: 'z', type: 'x', status: done }])), s, done);
  }
  assert.equal(node(reduce(s, agents(T0 + 5 * SEC, [{ id: 'z', type: 'x', status: 'running' }])), 'z').status, 'running');
  assert.equal(node(reduce(s, agents(T0 + 5 * SEC, [{ id: 'z', type: 'x', status: 'waiting' }])), 'z').status, 'waiting');
});

test('agents: ids of the orchestrator or a unit in the list do not turn them into agents; malformed entries are skipped', () => {
  const s0 = initialState(T0);
  const s = reduce(s0, agents(T0 + SEC, [{ id: 'main', type: 'x', status: 'completed' }, { id: 'unit:grok', type: 'x', status: 'running' }, null, {}, { id: '', type: 'x', status: 'running' }, { id: 'ok', type: 'x', status: 'running' }]));
  assert.equal(node(s, 'main').status, 'idle');
  assert.equal(node(s, 'main').kind, 'orchestrator');
  assert.equal(node(s, 'unit:grok').status, 'idle');
  assert.equal(node(s, 'unit:grok').kind, 'unit');
  assert.equal(s.nodes.length, 5);
  assert.equal(node(s, 'ok').kind, 'agent');
  assert.deepEqual(reduce(s0, agents(T0, [])), s0);
});

test('the model keeps every agent: ten spawned agents are ten nodes in spawn order', () => {
  let s = initialState(T0);
  for (let i = 0; i < 10; i++) s = reduce(s, spawn(T0 + i, `ag${i}`, 'x'));
  assert.equal(s.nodes.length, 14);
  assert.deepEqual(s.nodes.filter((n) => n.kind === 'agent').map((n) => n.order), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

// ---------------------------------------------------------------------------
// feed event
// ---------------------------------------------------------------------------

test('feed: this session\'s call takes model, effort and since from the same-tool entry that started nearest to it', () => {
  const callAt = T0 + 10 * SEC;
  const s0 = reduce(initialState(T0), call(callAt, MAIN, 'c1', GROK_REVIEW, 'code_review'));
  const s = reduce(s0, feedEv(T0 + 12 * SEC, [snap('grok', [
    fcall('grok_code_review', T0 - 5 * MIN, 'far-model', 'low'), // another session's older call of the same tool
    fcall('grok_code_review', T0 + 9 * SEC, 'near-model', 'high'),
    fcall('grok_research', T0 + 10 * SEC, 'other-tool-model', 'max'), // not the same tool
  ])]));
  const u = node(s, 'unit:grok');
  assert.equal(u.model, 'near-model');
  assert.equal(u.effort, 'high');
  assert.equal(u.since, T0 + 9 * SEC);
  assert.equal(u.status, 'running');
  assert.equal(u.callerId, MAIN);
  assert.equal(u.activity, 'code_review');
  assert.equal(u.feed, 'ok');
  assert.deepEqual(s.history, s0.history);
});

test('feed: the same-tool match works across the other direction in time (the entry started after the call) and a feed that lacks the call changes only the feed flag', () => {
  const s0 = reduce(initialState(T0), call(T0 + 10 * SEC, MAIN, 'c1', CODEX_REVIEW, 'code_review'));
  const later = reduce(s0, feedEv(T0 + 20 * SEC, [snap('codex', [fcall('codex_code_review', T0 + 11 * SEC, 'gpt-x', 'xhigh')])]));
  assert.equal(node(later, 'unit:codex').model, 'gpt-x');
  assert.equal(node(later, 'unit:codex').since, T0 + 11 * SEC);
  const lacking = reduce(s0, feedEv(T0 + 20 * SEC, [snap('codex', [fcall('codex_research', T0 + 10 * SEC)])]));
  const u = node(lacking, 'unit:codex');
  assert.equal(u.feed, 'ok');
  assert.equal(u.callerId, MAIN, 'a different tool is not this session\'s call and not an "other" call while we hold the unit');
  assert.equal(u.since, T0 + 10 * SEC);
  assert.equal('model' in u, false);
});

test('feed: a call this session did not make marks the idle unit running for "other", from the newest entry; its end, or the snapshot\'s end, makes it idle', () => {
  const s0 = initialState(T0);
  const s = reduce(s0, feedEv(T0 + 60 * SEC, [snap('grok', [fcall('grok_research', T0 + 10 * SEC, 'g-old', 'low'), fcall('grok_code_review', T0 + 40 * SEC, 'g-new', 'high')])]));
  const u = node(s, 'unit:grok');
  assert.equal(u.status, 'running');
  assert.equal(u.callerId, 'other');
  assert.equal(u.activity, 'code_review');
  assert.equal(u.since, T0 + 40 * SEC);
  assert.equal(u.model, 'g-new');
  assert.equal(u.effort, 'high');
  assert.equal(u.feed, 'ok');
  assert.deepEqual(s.history, [], 'a call of another session is not a link of this one');
  assert.equal(node(s, 'unit:gemini').status, 'idle');
  // the call leaves active[]
  const ended = reduce(s, feedEv(T0 + 90 * SEC, [snap('grok', [], { lastEndedAt: T0 + 80 * SEC })]));
  const e = node(ended, 'unit:grok');
  assert.equal(e.status, 'idle');
  assert.equal('callerId' in e, false);
  assert.equal('activity' in e, false);
  assert.equal(e.lastEndedAt, T0 + 80 * SEC);
  assert.equal(e.feed, 'ok');
  // the snapshot disappears
  const gone = reduce(s, feedEv(T0 + 90 * SEC, []));
  assert.equal(node(gone, 'unit:grok').status, 'idle');
  assert.equal(node(gone, 'unit:grok').feed, 'none');
  assert.equal('callerId' in node(gone, 'unit:grok'), false);
  assert.equal('activity' in node(gone, 'unit:grok'), false);
});

test('feed: while this session holds the unit, its own call is not overwritten as "other" and a vanished snapshot only drops the flag', () => {
  const s0 = reduce(initialState(T0), call(T0, 'main', 'c1', GEMINI_RESEARCH, 'research'));
  const withFeed = reduce(s0, feedEv(T0 + SEC, [snap('gemini', [fcall('gemini_research', T0 + 500, 'gm', 'high')])]));
  assert.equal(node(withFeed, 'unit:gemini').callerId, 'main');
  const gone = reduce(withFeed, feedEv(T0 + 2 * SEC, []));
  const u = node(gone, 'unit:gemini');
  assert.equal(u.feed, 'none');
  assert.equal(u.status, 'running');
  assert.equal(u.callerId, 'main');
  assert.equal(u.activity, 'research');
});

test('feed: our own call returns while another session\'s is still listed, then the unit reads as "other" on the next feed event', () => {
  let s = run(initialState(T0), call(T0, MAIN, 'c1', GROK_REVIEW, 'code_review'), ret(T0 + 5 * SEC, MAIN, 'c1'));
  assert.equal(node(s, 'unit:grok').status, 'idle');
  s = reduce(s, feedEv(T0 + 6 * SEC, [snap('grok', [fcall('grok_code_review', T0 + 2 * SEC)])]));
  assert.equal(node(s, 'unit:grok').callerId, 'other');
  // our next call takes the unit over
  s = reduce(s, call(T0 + 7 * SEC, MAIN, 'c2', GROK_REVIEW, 'code_review'));
  assert.equal(node(s, 'unit:grok').callerId, MAIN);
  s = reduce(s, ret(T0 + 8 * SEC, MAIN, 'c2'));
  assert.equal(node(s, 'unit:grok').status, 'idle');
});

test('feed: lastEndedAt is the newer of the model\'s and the feed\'s, whichever side wins', () => {
  const ended = run(initialState(T0), call(T0, MAIN, 'c1', GROK_REVIEW, 'code_review'), ret(T0 + 60 * SEC, MAIN, 'c1'));
  assert.equal(node(ended, 'unit:grok').lastEndedAt, T0 + 60 * SEC);
  const feedOlder = reduce(ended, feedEv(T0 + 70 * SEC, [snap('grok', [], { lastEndedAt: T0 + 30 * SEC })]));
  assert.equal(node(feedOlder, 'unit:grok').lastEndedAt, T0 + 60 * SEC);
  const feedNewer = reduce(ended, feedEv(T0 + 200 * SEC, [snap('grok', [], { lastEndedAt: T0 + 150 * SEC })]));
  assert.equal(node(feedNewer, 'unit:grok').lastEndedAt, T0 + 150 * SEC);
  // the feed alone sets it where the model has none; no feed value, no field
  const fresh = reduce(initialState(T0), feedEv(T0, [snap('codex', [], { lastEndedAt: T0 - MIN }), snap('gemini', [])]));
  assert.equal(node(fresh, 'unit:codex').lastEndedAt, T0 - MIN);
  assert.equal('lastEndedAt' in node(fresh, 'unit:gemini'), false);
  // and an older feed value never lowers a later one it has already given
  const again = reduce(fresh, feedEv(T0 + SEC, [snap('codex', [], { lastEndedAt: T0 - 2 * MIN })]));
  assert.equal(node(again, 'unit:codex').lastEndedAt, T0 - MIN);
});

test('feed: a null model or effort in the feed removes the field', () => {
  let s = reduce(initialState(T0), call(T0, MAIN, 'c1', GROK_REVIEW, 'code_review'));
  s = reduce(s, feedEv(T0 + SEC, [snap('grok', [fcall('grok_code_review', T0, 'gx', 'high')])]));
  assert.equal(node(s, 'unit:grok').model, 'gx');
  s = reduce(s, feedEv(T0 + 2 * SEC, [snap('grok', [{ id: '1-1', tool: 'grok_code_review', model: null, effort: null, startedAt: T0 }])]));
  assert.equal('model' in node(s, 'unit:grok'), false);
  assert.equal('effort' in node(s, 'unit:grok'), false);
  // same for an "other" call
  const o = reduce(initialState(T0), feedEv(T0, [snap('codex', [{ id: '1-1', tool: 'codex_research', model: 'gpt', effort: 'low', startedAt: T0 }])]));
  assert.equal(node(o, 'unit:codex').model, 'gpt');
  const o2 = reduce(o, feedEv(T0 + SEC, [snap('codex', [{ id: '1-1', tool: 'codex_research', model: null, effort: null, startedAt: T0 }])]));
  assert.equal('model' in node(o2, 'unit:codex'), false);
  assert.equal('effort' in node(o2, 'unit:codex'), false);
});

test('feed: several snapshots of one unit (two processes) are a union; the newest call across them wins, the newest lastEndedAt wins', () => {
  const s = reduce(initialState(T0), feedEv(T0 + MIN, [
    snap('grok', [fcall('grok_research', T0 + 10 * SEC, 'a', 'low')], { pid: 1, lastEndedAt: T0 - MIN }),
    snap('grok', [fcall('grok_code_review', T0 + 30 * SEC, 'b', 'high')], { pid: 2, lastEndedAt: T0 - 10 * SEC }),
  ]));
  const u = node(s, 'unit:grok');
  assert.equal(u.activity, 'code_review');
  assert.equal(u.model, 'b');
  assert.equal(u.lastEndedAt, T0 - 10 * SEC);
});

test('feed (Review Focus 2): parseSnapshot\'s nulls and a stale snapshot leave no feed and no "other" call; the agents and usage are untouched', () => {
  const stale = parseSnapshot(JSON.stringify({ schema: 2, unit: 'codex', pid: 1, active: [{ id: '1-1', tool: 'codex_research', model: null, effort: null, startedAt: new Date(T0 - 3 * HOUR).toISOString() }], lastEvent: null, updatedAt: new Date(T0 - 3 * HOUR).toISOString() }), T0);
  const garbage = parseSnapshot('{not json', T0);
  const schema1 = parseSnapshot(JSON.stringify({ schema: 1, unit: 'grok', active: [], updatedAt: new Date(T0).toISOString() }), T0);
  const unknown = parseSnapshot(JSON.stringify({ schema: 2, unit: 'jaravis', pid: 1, active: [], updatedAt: new Date(T0).toISOString() }), T0);
  assert.equal(garbage, null);
  assert.equal(schema1, null);
  assert.equal(unknown, null);
  const s0 = run(initialState(T0), spawn(T0, 'a1', 'x'), { type: 'usage', at: T0, usage: { costUsd: 2 } });
  const s = reduce(s0, feedEv(T0, [garbage, schema1, unknown, stale]));
  assert.equal(node(s, 'unit:grok').feed, 'none');
  assert.equal(node(s, 'unit:gemini').feed, 'none');
  assert.equal(node(s, 'unit:codex').feed, 'ok');
  assert.equal(node(s, 'unit:codex').status, 'idle', 'a 3-hour-old call is not a call');
  assert.equal('callerId' in node(s, 'unit:codex'), false);
  assert.deepEqual(s.usage, s0.usage);
  assert.deepEqual(node(s, 'a1'), node(s0, 'a1'));
  assert.deepEqual(s.history, s0.history);
});

test('feed: a snapshot for a unit the model does not have, and a missing snapshots field, do not throw or add nodes', () => {
  const s0 = initialState(T0);
  const a = reduce(s0, feedEv(T0, [snap('jaravis', [fcall('jaravis_x', T0)])]));
  assert.equal(a.nodes.length, 4);
  assert.ok(a.nodes.filter((n) => n.kind === 'unit').every((n) => n.feed === 'none' && n.status === 'idle'));
  const b = reduce(s0, { type: 'feed', at: T0 });
  assert.equal(b.nodes.length, 4);
});

// ---------------------------------------------------------------------------
// tick (Review Focus 5)
// ---------------------------------------------------------------------------

test('tick: exactly 2 hours keeps an activity, one millisecond past clears it; now follows the event', () => {
  const s = run(initialState(T0), call(T0, MAIN, 'c1', 'Bash', 'Bash: sleep'));
  const at30 = reduce(s, { type: 'tick', at: T0 + 2 * HOUR });
  assert.equal(node(at30, MAIN).activity, 'Bash: sleep');
  assert.equal(at30.now, T0 + 2 * HOUR);
  const past = reduce(s, { type: 'tick', at: T0 + 2 * HOUR + 1 });
  // 31 minutes is a long call but not a lost one
  assert.equal(node(reduce(s, { type: 'tick', at: T0 + 31 * MIN }), MAIN).activity, 'Bash: sleep');
  assert.equal('activity' in node(past, MAIN), false);
  assert.equal('activityCallId' in node(past, MAIN), false);
  assert.equal(node(past, MAIN).status, 'running', 'main keeps its status');
  assert.equal(past.now, T0 + 2 * HOUR + 1);
});

test('tick measures the current activity, not the agent: an agent spawned three hours ago on a fresh call keeps it', () => {
  let s = run(initialState(T0), spawn(T0, 'A', 'x'), call(T0 + 3 * HOUR - MIN, 'A', 'c1', 'Bash', 'Bash: ls'));
  s = reduce(s, { type: 'tick', at: T0 + 3 * HOUR + MIN });
  assert.equal(node(s, 'A').activity, 'Bash: ls');
  // main's too, and the unit of a fresh call
  s = run(s, call(T0 + 3 * HOUR, MAIN, 'c2', GROK_REVIEW, 'code_review'), { type: 'tick', at: T0 + 3 * HOUR + 2 * MIN });
  assert.equal(node(s, MAIN).activity, 'code_review');
  assert.equal(node(s, 'unit:grok').status, 'running');
});

test('tick past 2 hours: a unit goes idle with activity, call id and caller cleared; an agent loses its activity and keeps its status', () => {
  let s = run(initialState(T0), spawn(T0, 'A', 'x'), call(T0 + SEC, 'A', 'c1', CODEX_REVIEW, 'code_review'), spawn(T0, 'W', 'y'), agents(T0 + 2 * SEC, [{ id: 'W', type: 'y', status: 'waiting' }]));
  s = reduce(s, { type: 'tick', at: T0 + 2 * HOUR + 2 * SEC });
  const u = node(s, 'unit:codex');
  assert.equal(u.status, 'idle');
  for (const k of ['activity', 'activityCallId', 'callerId']) assert.equal(k in u, false, k);
  const a = node(s, 'A');
  assert.equal(a.status, 'running');
  assert.equal('activity' in a, false);
  assert.equal('activityCallId' in a, false);
  assert.equal(node(s, 'W').status, 'waiting');
  // the late return of the cleared call changes nothing
  assert.deepEqual(reduce(s, ret(T0 + 2 * HOUR + 3 * SEC, 'A', 'c1')).nodes.map((n) => n.id), s.nodes.map((n) => n.id));
  assert.equal(node(reduce(s, ret(T0 + 2 * HOUR + 3 * SEC, 'A', 'c1')), 'unit:codex').status, 'idle');
});

test('tick leaves a node with no activity alone, however old its since (idle units, reported agents)', () => {
  const s0 = run(initialState(T0), spawn(T0, 'A', 'x'), stop(T0 + SEC, 'A'));
  const s = reduce(s0, { type: 'tick', at: T0 + 5 * HOUR });
  assert.deepEqual(s.nodes, s0.nodes);
  assert.equal(s.now, T0 + 5 * HOUR);
});

test('Review Focus 5 end to end: a call that never returns is replaced by the next call, cleared by stop, or cleared by a tick', () => {
  // replaced
  let s = run(initialState(T0), spawn(T0, 'A', 'x'), call(T0 + SEC, 'A', 'c1', 'Bash', 'Bash: slow'), call(T0 + 2 * SEC, 'A', 'c2', 'Read', 'Read a.mjs'));
  assert.equal(node(s, 'A').activity, 'Read a.mjs');
  // cleared by stop
  const stopped = reduce(s, stop(T0 + 3 * SEC, 'A'));
  assert.equal('activity' in node(stopped, 'A'), false);
  assert.equal(node(stopped, 'A').status, 'reported');
  // cleared by a tick
  s = reduce(s, { type: 'tick', at: T0 + 2 * SEC + 2 * HOUR + 1 });
  assert.equal('activity' in node(s, 'A'), false);
  assert.equal(node(s, 'A').status, 'running');
});

// ---------------------------------------------------------------------------
// purity
// ---------------------------------------------------------------------------

function richState() {
  return run(
    initialState(T0),
    spawn(T0 + 1, 'A', 'omelette-coder', { model: 'claude-opus-5-5' }),
    spawn(T0 + 2, 'B', 'Explore', { parentId: 'A' }),
    agents(T0 + 3, [{ id: 'C', type: 'Plan', status: 'waiting' }]),
    call(T0 + 4, 'A', 'c1', GROK_REVIEW, 'code_review'),
    call(T0 + 5, 'B', 'c2', 'Bash', 'Bash: ls'),
    feedEv(T0 + 6, [snap('grok', [fcall('grok_code_review', T0 + 4)], { lastEndedAt: T0 })]),
    { type: 'usage', at: T0 + 7, usage: { fiveHour: 10 } },
  );
}

const EVERY_EVENT = [
  spawn(T0 + 10, 'D', 'y', { parentId: 'A', model: 'm' }),
  spawn(T0 + 10, 'A', 'omelette-coder'),
  { type: 'step', at: T0 + 11, agentId: 'A', model: 'm', effort: 'e' },
  { type: 'step', at: T0 + 11, agentId: 'main', model: 'm', effort: 'e' },
  call(T0 + 12, 'A', 'c9', GEMINI_RESEARCH, 'research'),
  call(T0 + 12, 'B', 'c8', 'SendMessage', 'SendMessage', { target: 'A' }),
  ret(T0 + 13, 'A', 'c1'),
  ret(T0 + 13, 'A', 'nope'),
  stop(T0 + 14, 'B'),
  agents(T0 + 15, [{ id: 'C', type: 'Plan', status: 'running' }, { id: 'E', type: 'z', status: 'idle', parentId: 'A' }]),
  feedEv(T0 + 16, [snap('grok', [], { lastEndedAt: T0 + 15 }), snap('codex', [fcall('codex_research', T0 + 9)])]),
  feedEv(T0 + 16, []),
  { type: 'usage', at: T0 + 17, usage: { costUsd: 3 } },
  { type: 'tick', at: T0 + 3 * HOUR },
  { type: 'open', at: T0 + 18 },
  { type: 'close', at: T0 + 19 },
  { type: 'nonsense', at: T0 + 20 },
];

test('purity: every event type on deep-frozen state and deep-frozen events neither throws nor changes the input', () => {
  for (const ev of EVERY_EVENT) {
    const state = richState();
    const snapshotOfState = structuredClone(state);
    const snapshotOfEvent = structuredClone(ev);
    deepFreeze(state);
    deepFreeze(ev);
    let out;
    assert.doesNotThrow(() => { out = reduce(state, ev); }, ev.type);
    assert.deepEqual(state, snapshotOfState, ev.type);
    assert.deepEqual(ev, snapshotOfEvent, ev.type);
    assert.ok(out && Array.isArray(out.nodes) && Array.isArray(out.history), ev.type);
  }
});

test('purity: the same input twice gives equal outputs, and the output can be edited without touching the input', () => {
  for (const ev of EVERY_EVENT) {
    const state = richState();
    const clone = structuredClone(state);
    const a = reduce(state, ev);
    const b = reduce(state, ev);
    assert.deepEqual(a, b, ev.type);
    if (a === state) continue; // an unchanged state is returned as given
    // edit every part the output holds as its own (a different reference from the input's), as a careless caller would;
    // parts the reducer reuses unchanged (structural sharing) are not the test's business
    if (a.history !== state.history) a.history.push({ at: 0, from: 'x', to: 'y', label: 'z' });
    if (a.nodes !== state.nodes) a.nodes.push({ id: 'junk' });
    if (a.usage !== state.usage) a.usage.costUsd = -1;
    for (const n of a.nodes) {
      const original = state.nodes.find((m) => m.id === n.id);
      if (original && original !== n) n.status = 'junk';
    }
    assert.deepEqual(state.history, clone.history, `${ev.type}: history`);
    assert.deepEqual(state.nodes, clone.nodes, `${ev.type}: nodes`);
  }
});

test('reduce on an unknown, missing or inherited-name event type returns the very state it was given', () => {
  const s = richState();
  for (const ev of [{ type: 'nope', at: 1 }, {}, null, undefined, { type: 42 }, { type: 'toString' }, { type: 'constructor' }, { type: '__proto__' }, { type: 'hasOwnProperty' }, { type: 'SPAWN' }]) {
    assert.equal(reduce(s, ev), s, JSON.stringify(ev));
  }
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test('history: the cap is 200 - 200 links are all kept, the 201st drops the first, order stays oldest first', () => {
  let s = initialState(T0);
  s = reduce(s, spawn(T0, 'A', 'x'));
  const sends = [];
  for (let i = 1; i <= 199; i++) sends.push(call(T0 + i, 'A', `c${i}`, 'SendMessage', 'SendMessage', { target: 'main' }));
  s = run(s, ...sends); // 1 spawn link + 199 = 200
  assert.equal(s.history.length, 200);
  assert.equal(s.history[0].label, 'Agent');
  s = reduce(s, call(T0 + 200, 'A', 'c200', 'SendMessage', 'SendMessage', { target: 'main' }));
  assert.equal(s.history.length, 200);
  assert.equal(s.history[0].at, T0 + 1, 'the spawn link, the oldest, fell off');
  assert.equal(s.history.at(-1).at, T0 + 200);
  const times = s.history.map((l) => l.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test('history: the cap holds across link kinds (Agent, unit call, report) and 500 events', () => {
  let s = initialState(T0);
  for (let i = 0; i < 100; i++) {
    s = run(s, spawn(T0 + i * 10, `a${i}`, 'x'), call(T0 + i * 10 + 1, `a${i}`, `c${i}`, GROK_REVIEW, 'r'), ret(T0 + i * 10 + 2, `a${i}`, `c${i}`), stop(T0 + i * 10 + 3, `a${i}`), { type: 'tick', at: T0 + i * 10 + 4 });
  }
  assert.equal(s.history.length, 200);
  assert.equal(s.history.at(-1).label, 'report');
  assert.equal(s.history.at(-1).from, 'a99');
  assert.equal(s.nodes.length, 104);
});

// ---------------------------------------------------------------------------
// feed.mjs
// ---------------------------------------------------------------------------

test('snapshotNames: the three units\' per-process files only; look-alikes, temp files, schema 1 and other programs\' files are dropped; order and duplicates kept', () => {
  const keep = ['status-codex-48123.json', 'status-grok-1.json', 'status-gemini-99999.json', 'status-codex-48123.json'];
  const drop = [
    'status-codex.json', // schema 1
    'status-codex-48123.json.48123.tmp',
    'status-codex-1.json.bak',
    'status-codex-1.jsonx',
    'status-codex-.json',
    'status-codex-abc.json',
    'status-codex--1.json',
    'status-codex-1-2.json',
    'status-codexx-1.json',
    'status-jaravis-1.json',
    'status-GROK-1.json',
    'xstatus-grok-1.json',
    ' status-grok-1.json',
    'status-grok-1.json\n',
    'sub/status-grok-1.json',
    '../status-grok-1.json',
    'fleet-log.ndjson',
    'status-.json',
    '',
    '.',
  ];
  assert.deepEqual(snapshotNames([drop[0], keep[0], drop[1], keep[1], ...drop.slice(2), keep[2], keep[3]]), keep);
  assert.deepEqual(snapshotNames([]), []);
  assert.deepEqual(snapshotNames(['status-grok-1.json', 7, null, undefined, {}, ['status-grok-2.json']]), ['status-grok-1.json']);
  assert.deepEqual(snapshotNames(undefined), []);
  assert.deepEqual(snapshotNames(null), []);
});

function documentedExample() {
  const doc = readFileSync(join(ROOT, 'docs', 'STATUS-FEED.md'), 'utf8');
  const block = /```json\n([\s\S]*?)\n```/.exec(doc);
  assert.ok(block, 'the first json block of STATUS-FEED.md');
  return block[1];
}

test('parseSnapshot: the STATUS-FEED example verbatim, whole result', () => {
  const text = documentedExample();
  assert.equal(JSON.parse(text).schema, 2);
  const updated = Date.parse('2026-09-03T09:14:02.119Z');
  const fresh = parseSnapshot(text, updated + 5 * SEC);
  assert.deepEqual(fresh, {
    unit: 'codex',
    pid: 48123,
    active: [{ id: '48123-2', tool: 'codex_code_review', model: 'gpt-5.6-terra', effort: 'high', startedAt: Date.parse('2026-09-03T09:14:02.118Z') }],
    updatedAt: updated,
    lastEndedAt: Date.parse('2026-09-03T09:13:44.902Z'),
    isStale: false,
  });
  // the same file read three hours later: stale, nothing active, the rest intact
  const old = parseSnapshot(text, updated + 3 * HOUR);
  assert.equal(old.isStale, true);
  assert.deepEqual(old.active, []);
  assert.equal(old.unit, 'codex');
  assert.equal(old.lastEndedAt, Date.parse('2026-09-03T09:13:44.902Z'));
});

test('parseSnapshot: staleness is strictly past 2 hours, and only with a call listed (Review Focus 2: a deep research of 36 minutes is not stale, 3 hours is)', () => {
  const doc = (active, updatedAt) => JSON.stringify({ schema: 2, unit: 'grok', pid: 7, active, lastEvent: null, updatedAt });
  const call1 = { id: '7-1', tool: 'grok_research', model: null, effort: null, startedAt: '2026-10-08T11:00:00.000Z' };
  const upd = '2026-10-08T12:00:00.000Z';
  const u = Date.parse(upd);
  assert.equal(parseSnapshot(doc([call1], upd), u + 2 * HOUR).isStale, false);
  assert.equal(parseSnapshot(doc([call1], upd), u + 2 * HOUR).active.length, 1);
  assert.equal(parseSnapshot(doc([call1], upd), u + 36 * MIN).isStale, false);
  const past = parseSnapshot(doc([call1], upd), u + 2 * HOUR + 1);
  assert.equal(past.isStale, true);
  assert.deepEqual(past.active, []);
  const forty = parseSnapshot(doc([call1], upd), u + 3 * HOUR);
  assert.equal(forty.isStale, true);
  assert.deepEqual(forty.active, []);
  assert.equal(parseSnapshot(doc([], upd), u + 5 * HOUR).isStale, false, 'nothing active, nothing to be stale about');
  assert.equal(parseSnapshot(doc([call1], upd), u - 10 * MIN).isStale, false, 'an updatedAt in the future is not stale');
});

test('parseSnapshot: schema 1, a wrong or missing schema, and every non-object JSON is null', () => {
  const base = { unit: 'grok', pid: 1, active: [], lastEvent: null, updatedAt: '2026-10-08T12:00:00.000Z' };
  for (const schema of [1, '2', 3, 0, null, undefined, true, [2]]) {
    assert.equal(parseSnapshot(JSON.stringify({ ...base, schema }), T0), null, `schema ${JSON.stringify(schema)}`);
  }
  for (const text of ['[]', '[{"schema":2}]', '"text"', '42', 'null', 'true', 'false', '', ' ', '{', '{"schema":2,', 'not json at all', '{schema:2}', "{'schema':2}"]) {
    assert.equal(parseSnapshot(text, T0), null, JSON.stringify(text));
  }
  for (const odd of [undefined, null, 5, {}, []]) assert.equal(parseSnapshot(odd, T0), null, String(odd));
});

test('parseSnapshot: a unit outside the three (or none) is null, including near-misses', () => {
  for (const unit of ['jaravis', 'Grok', 'grok ', 'gemin', 'codexx', '', null, undefined, 7, ['grok']]) {
    assert.equal(parseSnapshot(JSON.stringify({ schema: 2, unit, pid: 1, active: [], updatedAt: '2026-10-08T12:00:00.000Z' }), T0), null, JSON.stringify(unit));
  }
  for (const unit of UNITS) {
    const r = parseSnapshot(JSON.stringify({ schema: 2, unit, pid: 3, active: [], updatedAt: '2026-10-08T12:00:00.000Z' }), T0);
    assert.equal(r.unit, unit);
    assert.equal(r.pid, 3);
  }
});

test('parseSnapshot: an updatedAt that is not a time is null; so is a missing one', () => {
  for (const updatedAt of ['yesterday', '', '2026-13-45T99:99:99Z', null, undefined, 0, 1760000000000, {}]) {
    const text = JSON.stringify({ schema: 2, unit: 'grok', pid: 1, active: [], updatedAt });
    assert.equal(parseSnapshot(text, T0), null, JSON.stringify(updatedAt));
  }
});

test('parseSnapshot: active entries without a string tool or a parseable startedAt are dropped, the rest keep their fields; a missing or odd active is empty', () => {
  const entries = [
    { id: '1-1', tool: 'grok_research', model: 'gm', effort: 'high', startedAt: '2026-10-08T12:00:00.000Z' },
    { id: '1-2', startedAt: '2026-10-08T12:00:00.000Z' },
    { id: '1-3', tool: 42, startedAt: '2026-10-08T12:00:00.000Z' },
    { id: '1-4', tool: 'grok_research' },
    { id: '1-5', tool: 'grok_research', startedAt: 'soon' },
    { id: '1-6', tool: 'grok_code_review', startedAt: '2026-10-08T12:00:05.000Z' },
    null,
    'text',
    7,
    [],
  ];
  const r = parseSnapshot(JSON.stringify({ schema: 2, unit: 'grok', pid: 1, active: entries, updatedAt: '2026-10-08T12:00:06.000Z' }), Date.parse('2026-10-08T12:00:07.000Z'));
  assert.deepEqual(r.active, [
    { id: '1-1', tool: 'grok_research', model: 'gm', effort: 'high', startedAt: Date.parse('2026-10-08T12:00:00.000Z') },
    { id: '1-6', tool: 'grok_code_review', model: null, effort: null, startedAt: Date.parse('2026-10-08T12:00:05.000Z') },
  ]);
  for (const active of [undefined, null, 'x', {}, 5]) {
    const o = parseSnapshot(JSON.stringify({ schema: 2, unit: 'grok', pid: 1, active, updatedAt: '2026-10-08T12:00:06.000Z' }), T0);
    assert.deepEqual(o.active, [], JSON.stringify(active));
    assert.equal(o.isStale, false);
  }
});

test('parseSnapshot: lastEndedAt only from a parseable lastEvent.endedAt; a stale snapshot keeps it; no key otherwise', () => {
  const at = (lastEvent) => parseSnapshot(JSON.stringify({ schema: 2, unit: 'gemini', pid: 1, active: [], lastEvent, updatedAt: '2026-10-08T12:00:00.000Z' }), T0);
  assert.equal(at({ tool: 'gemini_research', status: 'ok', endedAt: '2026-10-08T11:59:00.000Z', durationMs: 1, error: null }).lastEndedAt, Date.parse('2026-10-08T11:59:00.000Z'));
  for (const lastEvent of [null, undefined, {}, { endedAt: 'never' }, { endedAt: null }, 'x', 4]) {
    assert.equal(Object.hasOwn(at(lastEvent), 'lastEndedAt'), false, JSON.stringify(lastEvent));
  }
  const staleWithEnd = parseSnapshot(
    JSON.stringify({ schema: 2, unit: 'gemini', pid: 1, active: [{ id: '1-1', tool: 'gemini_research', startedAt: '2026-10-08T07:00:00.000Z' }], lastEvent: { endedAt: '2026-10-08T06:00:00.000Z' }, updatedAt: '2026-10-08T07:00:00.000Z' }),
    Date.parse('2026-10-08T12:00:00.000Z'),
  );
  assert.equal(staleWithEnd.isStale, true);
  assert.equal(staleWithEnd.lastEndedAt, Date.parse('2026-10-08T06:00:00.000Z'));
});

test('parseSnapshot output feeds reduce directly: the documented example, read as another session\'s call, marks codex running for "other"', () => {
  const updated = Date.parse('2026-09-03T09:14:02.119Z');
  const parsed = parseSnapshot(documentedExample(), updated + SEC);
  const s = reduce(initialState(updated), feedEv(updated + SEC, [parsed]));
  const u = node(s, 'unit:codex');
  assert.equal(u.status, 'running');
  assert.equal(u.callerId, 'other');
  assert.equal(u.activity, 'code_review');
  assert.equal(u.model, 'gpt-5.6-terra');
  assert.equal(u.since, Date.parse('2026-09-03T09:14:02.118Z'));
  assert.equal(u.lastEndedAt, Date.parse('2026-09-03T09:13:44.902Z'));
});

// ---------------------------------------------------------------------------
// text.mjs
// ---------------------------------------------------------------------------

test('cut: boundaries in terminal cells - exact fit, one over, one cell, none, wide characters and emoji (2 cells), astral narrow characters (1)', () => {
  assert.equal(cut('abc', 3), 'abc');
  assert.equal(cut('abcd', 3), 'ab…');
  assert.equal(cut('abc', 1), '…');
  assert.equal(cut('a', 1), 'a');
  assert.equal(cut('', 5), '');
  assert.equal(cut('', 0), '');
  for (const width of [0, -1, -100, NaN, undefined, null]) assert.equal(cut('abc', width), '', String(width));
  assert.equal(cut('abc', 100), 'abc');
  // emoji are two cells each
  assert.equal(cut('😀😀😀', 6), '😀😀😀');
  assert.equal(cut('😀😀😀', 5), '😀😀…');
  assert.equal(cut('😀😀😀', 4), '😀…');
  assert.equal(cut('😀😀😀', 3), '😀…');
  assert.equal(cut('😀😀😀', 2), '…');
  assert.equal(cut('😀😀😀', 1), '…');
  assert.equal(cut('a😀b', 4), 'a😀b');
  assert.equal(cut('a😀b', 3), 'a…');
  assert.equal(cut('ab😀cd', 5), 'ab😀…');
  assert.equal(cut('😀a', 2), '…');
  // CJK is two cells each
  assert.equal(cut('日本語', 6), '日本語');
  assert.equal(cut('日本語', 5), '日本…');
  assert.equal(cut('日本語', 4), '日…');
  assert.equal(cut('日本語', 3), '日…');
  // astral characters outside the wide ranges stay one cell
  assert.equal(cut('𝒳𝒴𝒵', 3), '𝒳𝒴𝒵');
  assert.equal(cut('𝒳𝒴𝒵', 2), '𝒳…');
  // combining marks take no cell and are never cut off their base
  assert.equal(cut('e\u0301e\u0301e\u0301', 3), 'e\u0301e\u0301e\u0301');
  assert.equal(cut('e\u0301e\u0301e\u0301e\u0301', 3), 'e\u0301e\u0301…');
});

test('cells: narrow 1, wide CJK and emoji 2, combining marks, ZWJ and VS16 0; nothing, nothing', () => {
  assert.equal(cells(''), 0);
  assert.equal(cells(undefined), 0);
  assert.equal(cells(null), 0);
  assert.equal(cells('abc'), 3);
  assert.equal(cells('日本語'), 6);
  assert.equal(cells('한글'), 4);
  assert.equal(cells('Ａ'), 2); // fullwidth A
  assert.equal(cells('ｱ'), 1); // halfwidth katakana
  assert.equal(cells('😀'), 2);
  assert.equal(cells('🚀'), 2);
  assert.equal(cells('🤖'), 2);
  assert.equal(cells('e\u0301'), 1);
  assert.equal(cells('\u0301'), 0);
  assert.equal(cells('\u200d'), 0);
  assert.equal(cells('\ufe0f'), 0);
  assert.equal(cells('a\u200db'), 2);
  assert.equal(cells('日a日'), 5);
});

test('cut, a property: on mixed wide, narrow, combining, ZWJ and VS16 strings the result is whole code points, fits the cells with its ellipsis, and is the longest prefix that does', () => {
  const pool = ['a', 'Z', ' ', '日', '한', '😀', '🚀', 'e\u0301', '\u0301', '\u200d', '\ufe0f', '𝒳', 'Ａ', 'ｱ', '…'];
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let k = 0; k < 400; k++) {
    const text = Array.from({ length: rnd(12) }, () => pool[rnd(pool.length)]).join('');
    for (let width = 0; width <= 16; width++) {
      const out = cut(text, width);
      assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out), `lone surrogate: ${JSON.stringify(text)} @${width}`);
      assert.ok(cells(out) <= width, `${JSON.stringify(text)} @${width} -> ${JSON.stringify(out)} is ${cells(out)} cells`);
      if (cells(text) <= width) { assert.equal(out, text); continue; }
      if (width <= 0) { assert.equal(out, ''); continue; }
      assert.ok(out.endsWith('…'), `${JSON.stringify(text)} @${width}`);
      const kept = out.slice(0, -1);
      assert.ok(text.startsWith(kept), 'a prefix of the text');
      // The next unit is a code point with the VS16 that follows it: `cut` keeps or drops the pair whole (ruling 2026-10-08).
      const rest = [...text.slice(kept.length)];
      const next = rest[0] + (rest[0] !== '\ufe0f' && rest[1] === '\ufe0f' ? rest[1] : '');
      assert.ok(cells(kept) + cells(next) > width - 1, `longest prefix: ${JSON.stringify(text)} @${width} kept ${JSON.stringify(kept)} next ${JSON.stringify(next)}`);
    }
  }
});

test('duration: the ten-minute, one-hour and second boundaries', () => {
  const m = (min, sec = 0, ms = 0) => min * MIN + sec * SEC + ms;
  assert.equal(duration(0), '0:00');
  assert.equal(duration(999), '0:00');
  assert.equal(duration(1000), '0:01');
  assert.equal(duration(5000), '0:05');
  assert.equal(duration(42000), '0:42');
  assert.equal(duration(m(0, 59, 999)), '0:59');
  assert.equal(duration(m(1)), '1:00');
  assert.equal(duration(m(3, 10)), '3:10');
  assert.equal(duration(m(9, 59)), '9:59');
  assert.equal(duration(m(9, 59, 999)), '9:59');
  assert.equal(duration(m(10)), '10m');
  assert.equal(duration(m(10, 59, 999)), '10m');
  assert.equal(duration(m(12)), '12m');
  assert.equal(duration(m(59, 59)), '59m');
  assert.equal(duration(m(59, 59, 999)), '59m');
  assert.equal(duration(HOUR), '1h');
  assert.equal(duration(HOUR + 59 * MIN), '1h');
  assert.equal(duration(2 * HOUR + 5 * MIN), '2h');
  assert.equal(duration(30 * HOUR), '30h');
  for (const odd of [-1, -MIN, NaN, undefined, null]) assert.equal(duration(odd), '0:00', String(odd));
});

test('shortRole, shortModel, familyOf: the documented examples, and ids that must come back unchanged', () => {
  assert.equal(shortRole('omelette-coder-medium'), 'coder-medium');
  assert.equal(shortRole('omelette-coder'), 'coder');
  assert.equal(shortRole('omelette-tester'), 'tester');
  for (const r of ['Explore', 'general-purpose', 'Plan', 'my-omelette-coder', 'Omelette-coder', 'omelette', 'coder']) assert.equal(shortRole(r), r);
  assert.equal(shortModel('claude-opus-5-5'), 'opus-5-5');
  assert.equal(shortModel('claude-fable-5-1'), 'fable-5-1');
  assert.equal(shortModel('claude-sonnet-5-5'), 'sonnet-5-5');
  assert.equal(shortModel('claude-haiku-4-5-20251001'), 'haiku-4-5-20251001');
  for (const id of ['gpt-6.1-sol', 'gemini-3-pro', 'opus', 'Claude-opus-5', 'my-claude-opus', '']) assert.equal(shortModel(id), id);
  assert.equal(familyOf('claude-opus-5-5'), 'opus');
  assert.equal(familyOf('claude-fable-5-1'), 'fable');
  assert.equal(familyOf('claude-sonnet-5-5'), 'sonnet');
  assert.equal(familyOf('claude-haiku-4-5-20251001'), 'haiku');
  for (const id of ['gpt-6.1-sol', 'gemini-3-pro', 'opus-5-5', 'grok-4']) assert.equal(familyOf(id), id);
});

test('subjectOf: Bash words, whitespace, file tools, unit tools, everything else', () => {
  assert.equal(subjectOf('Bash', { command: 'npm test --silent' }), 'Bash: npm test');
  assert.equal(subjectOf('Bash', { command: 'ls' }), 'Bash: ls');
  assert.equal(subjectOf('Bash', { command: '  git   status\t-s\n' }), 'Bash: git status');
  assert.equal(subjectOf('Bash', { command: 'a b c d e' }), 'Bash: a', 'a program outside the subcommand list shows alone');
  assert.equal(subjectOf('Bash', { command: 'git status -s -b' }), 'Bash: git status');
  assert.equal(subjectOf('Bash', {}), 'Bash');
  assert.equal(subjectOf('Bash', undefined), 'Bash');
  assert.equal(subjectOf('Bash', { command: '' }), 'Bash');
  assert.equal(subjectOf('Bash', { command: 7 }), 'Bash');
  assert.equal(subjectOf('Edit', { file_path: '/home/op/proj/src/adapter.mjs' }), 'Edit adapter.mjs');
  assert.equal(subjectOf('Write', { file_path: '/home/op/proj/README.md' }), 'Write README.md');
  assert.equal(subjectOf('Read', { file_path: 'relative.txt' }), 'Read relative.txt');
  assert.equal(subjectOf('Read', { file_path: 'C:\\Users\\op\\a.txt' }), 'Read a.txt');
  assert.equal(subjectOf('NotebookEdit', { notebook_path: '/home/op/n.ipynb' }), 'NotebookEdit n.ipynb');
  assert.equal(subjectOf('Edit', {}), 'Edit');
  assert.equal(subjectOf('Read', undefined), 'Read');
  assert.equal(subjectOf('Edit', { file_path: 12 }), 'Edit');
  assert.equal(subjectOf('mcp__orion-grok__grok_code_review', { prompt: 'x' }), 'code_review');
  assert.equal(subjectOf('mcp__x__gemini_deep_research', undefined), 'deep_research');
  assert.equal(subjectOf('mcp__omelette__get_usage', {}), 'mcp__omelette__get_usage');
  assert.equal(subjectOf('Grep', { pattern: 'x' }), 'Grep');
  assert.equal(subjectOf('Agent', { description: 'x' }), 'Agent');
  assert.equal(subjectOf('SendMessage', { to: 'main' }), 'SendMessage');
  // a Bash-like input on another tool is ignored
  assert.equal(subjectOf('Grep', { command: 'rm -rf x' }), 'Grep');
});

test('clock: positive and negative offsets, across midnight both ways, whole-hour and half-hour zones, the day\'s edges', () => {
  const at = (h, m, s, ms = 0) => Date.UTC(2026, 9, 8, h, m, s, ms);
  assert.equal(clock(at(12, 34, 56), 0), '12:34:56');
  assert.equal(clock(at(12, 34, 56), -180), '15:34:56'); // UTC+3 reports -180
  assert.equal(clock(at(12, 34, 56), 300), '07:34:56'); // UTC-5 reports 300
  assert.equal(clock(at(23, 30, 0), -180), '02:30:00'); // forward over midnight
  assert.equal(clock(at(1, 0, 0), 300), '20:00:00'); // backward over midnight
  assert.equal(clock(at(20, 0, 0), -330), '01:30:00'); // UTC+5:30
  assert.equal(clock(at(0, 0, 0), 0), '00:00:00');
  assert.equal(clock(at(23, 59, 59, 999), 0), '23:59:59');
  assert.equal(clock(at(0, 0, 0), 1), '23:59:00');
  assert.equal(clock(at(0, 0, 0), -1), '00:01:00');
  assert.equal(clock(at(9, 5, 3), 0), '09:05:03');
  assert.equal(clock(-1000, 0), '23:59:59'); // before the epoch
  assert.equal(clock(Date.UTC(1969, 11, 31, 23, 0, 0), 120), '21:00:00');
  // against Date for a sweep of times and offsets
  for (const offset of [0, -60, -180, -330, -525, -840, 60, 300, 480, 720]) {
    for (let k = 0; k < 40; k++) {
      const t = at(0, 0, 0) + k * 37 * MIN + k * 1234;
      const expected = new Date(t - offset * MIN).toISOString().slice(11, 19);
      assert.equal(clock(t, offset), expected, `${offset} @ ${k}`);
    }
  }
});

// ---------------------------------------------------------------------------
// isolation
// ---------------------------------------------------------------------------

test('the three pure files import nothing but each other: no claude-code, no node:, no import(, no clock or randomness', () => {
  const SIBLINGS = new Set(['./model.mjs', './feed.mjs', './text.mjs']);
  for (const name of ['model.mjs', 'feed.mjs', 'text.mjs']) {
    const src = readFileSync(join(HOOKS, name), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const specifiers = [...code.matchAll(/(?:^|[;\s])(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    specifiers.push(...[...code.matchAll(/(?:^|[;\s])import\s*['"]([^'"]+)['"]/g)].map((m) => m[1]));
    for (const spec of specifiers) assert.ok(SIBLINGS.has(spec) && spec !== `./${name}`, `${name} imports ${spec}`);
    assert.doesNotMatch(code, /\bimport\s*\(/, `${name}: dynamic import`);
    assert.doesNotMatch(code, /\brequire\s*\(/, `${name}: require`);
    assert.doesNotMatch(code, /node:|claude-code/, `${name}: node: or claude-code`);
    assert.doesNotMatch(code, /\bprocess\./, `${name}: process`);
    assert.doesNotMatch(code, /Date\.now\s*\(|Math\.random\s*\(|new Date\s*\(\s*\)/, `${name}: a clock or randomness`);
  }
});

test('the three files stand alone: copied to an empty folder with no node_modules and no package.json, they load and work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t2-'));
  try {
    mkdirSync(join(dir, 'hooks'));
    for (const name of ['model.mjs', 'feed.mjs', 'text.mjs']) copyFileSync(join(HOOKS, name), join(dir, 'hooks', name));
    const model = await import(pathToFileURL(join(dir, 'hooks', 'model.mjs')).href);
    const feed = await import(pathToFileURL(join(dir, 'hooks', 'feed.mjs')).href);
    const text = await import(pathToFileURL(join(dir, 'hooks', 'text.mjs')).href);
    assert.equal(typeof model.reduce, 'function');
    assert.equal(model.initialState(1).nodes.length, 4);
    assert.deepEqual(model.unitOfTool('mcp__a__grok_x'), { unit: 'grok', tool: 'x' });
    assert.deepEqual(feed.snapshotNames(['status-grok-1.json', 'x']), ['status-grok-1.json']);
    assert.equal(text.cut('abcdef', 3), 'ab…');
    assert.deepEqual([...model.UNITS], ['gemini', 'grok', 'codex']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// rounds 2 and 3: a unit's open calls, the 2-hour bound, the Bash subject, the role namespace
// ---------------------------------------------------------------------------

test('openCalls: each unit call is listed with its caller, tool part and start; the unit shows the newest; a return removes only its own call', () => {
  let s = run(
    initialState(T0),
    spawn(T0, 'A', 'x'),
    spawn(T0, 'B', 'y'),
    call(T0 + 1 * SEC, 'A', 'cA', GROK_REVIEW, 'code_review'),
    call(T0 + 2 * SEC, 'B', 'cB', 'mcp__orion-grok__grok_research', 'research'),
  );
  let u = node(s, 'unit:grok');
  assert.deepEqual(u.openCalls, [
    { callId: 'cA', callerId: 'A', tool: 'code_review', since: T0 + 1 * SEC },
    { callId: 'cB', callerId: 'B', tool: 'research', since: T0 + 2 * SEC },
  ]);
  assert.deepEqual([u.status, u.callerId, u.activity, u.activityCallId, u.since], ['running', 'B', 'research', 'cB', T0 + 2 * SEC]);
  // the newest returns first: the unit falls back to A's call, still running
  s = reduce(s, ret(T0 + 3 * SEC, 'B', 'cB'));
  u = node(s, 'unit:grok');
  assert.deepEqual([u.status, u.callerId, u.activity, u.activityCallId, u.since], ['running', 'A', 'code_review', 'cA', T0 + 1 * SEC]);
  assert.equal(u.openCalls.length, 1);
  // the oldest returns first: the unit keeps showing the newest
  const t = run(
    initialState(T0),
    call(T0 + 1 * SEC, MAIN, 'c1', GROK_REVIEW, 'code_review'),
    call(T0 + 2 * SEC, MAIN, 'c2', GROK_REVIEW, 'code_review'),
    ret(T0 + 3 * SEC, MAIN, 'c1'),
  );
  assert.equal(node(t, 'unit:grok').activityCallId, 'c2');
  assert.equal(node(t, 'unit:grok').status, 'running');
  // the last return idles it, with lastEndedAt, and leaves no open calls behind
  s = reduce(s, ret(T0 + 9 * SEC, 'A', 'cA'));
  u = node(s, 'unit:grok');
  assert.equal(u.status, 'idle');
  assert.equal(u.lastEndedAt, T0 + 9 * SEC);
  for (const k of ['openCalls', 'callerId', 'activity', 'activityCallId']) assert.equal(k in u, false, k);
});

test('openCalls: a foreign call id on return removes nothing and leaves every unit as it was', () => {
  const s = run(initialState(T0), call(T0, MAIN, 'c1', CODEX_REVIEW, 'code_review'), call(T0 + SEC, MAIN, 'c2', GEMINI_RESEARCH, 'research'));
  assert.deepEqual(reduce(s, ret(T0 + 2 * SEC, MAIN, 'nope')), s);
  // one unit's call id never touches the other unit
  const r = reduce(s, ret(T0 + 2 * SEC, MAIN, 'c1'));
  assert.equal(node(r, 'unit:codex').status, 'idle');
  assert.equal(node(r, 'unit:gemini').status, 'running');
  assert.equal(node(r, 'unit:gemini').openCalls.length, 1);
});

test('stop drops the stopped agent\'s open unit calls: a unit it alone held goes idle (no lastEndedAt), a shared one falls back to the other caller', () => {
  let s = run(
    initialState(T0),
    spawn(T0, 'A', 'x'),
    spawn(T0, 'B', 'y'),
    call(T0 + 1 * SEC, 'A', 'cA', CODEX_REVIEW, 'code_review'),
    call(T0 + 2 * SEC, 'A', 'cA2', GROK_REVIEW, 'code_review'),
    call(T0 + 3 * SEC, 'B', 'cB', GROK_REVIEW, 'code_review'),
  );
  s = reduce(s, stop(T0 + 10 * SEC, 'B'));
  assert.deepEqual([node(s, 'unit:grok').callerId, node(s, 'unit:grok').activityCallId, node(s, 'unit:grok').status], ['A', 'cA2', 'running']);
  s = reduce(s, stop(T0 + 11 * SEC, 'A'));
  for (const id of ['unit:codex', 'unit:grok']) {
    const u = node(s, id);
    assert.equal(u.status, 'idle', id);
    for (const k of ['openCalls', 'callerId', 'activity', 'activityCallId', 'lastEndedAt']) assert.equal(k in u, false, `${id} ${k}`);
  }
  // a later return of a dropped call changes nothing
  assert.deepEqual(reduce(s, ret(T0 + 12 * SEC, 'A', 'cA')), s);
  // stopping an agent with no open call leaves the units alone
  const t = run(initialState(T0), spawn(T0, 'C', 'x'), call(T0, MAIN, 'm1', GROK_REVIEW, 'code_review'), stop(T0 + SEC, 'C'));
  assert.equal(node(t, 'unit:grok').status, 'running');
});

test('tick drops open unit calls older than 2 hours (not at exactly 2 hours), keeps the newer ones, and shows the newest remaining; no lastEndedAt', () => {
  let s = run(
    initialState(T0),
    call(T0, MAIN, 'old', GROK_REVIEW, 'code_review'),
    call(T0 + 1 * HOUR, MAIN, 'mid', 'mcp__orion-grok__grok_research', 'research'),
  );
  assert.equal(node(reduce(s, { type: 'tick', at: T0 + 2 * HOUR }), 'unit:grok').openCalls.length, 2);
  const one = reduce(s, { type: 'tick', at: T0 + 2 * HOUR + 1 });
  assert.equal(node(one, 'unit:grok').openCalls.length, 1);
  assert.equal(node(one, 'unit:grok').activityCallId, 'mid');
  assert.equal(node(one, 'unit:grok').status, 'running');
  s = reduce(s, { type: 'tick', at: T0 + 3 * HOUR + 1 });
  const u = node(s, 'unit:grok');
  assert.equal(u.status, 'idle');
  for (const k of ['openCalls', 'callerId', 'activity', 'activityCallId', 'lastEndedAt']) assert.equal(k in u, false, k);
  // and the loop that made the calls loses its own activity at the same bound
  assert.equal('activity' in node(s, MAIN), false);
});

test('tick on an "other" call (no open calls) goes by its since: kept at exactly 2 hours, dropped past it', () => {
  const s = reduce(initialState(T0), feedEv(T0, [snap('codex', [fcall('codex_research', T0 - HOUR)])]));
  assert.equal(node(s, 'unit:codex').callerId, 'other');
  assert.equal(node(reduce(s, { type: 'tick', at: T0 + HOUR }), 'unit:codex').status, 'running');
  const past = reduce(s, { type: 'tick', at: T0 + HOUR + 1 });
  assert.equal(node(past, 'unit:codex').status, 'idle');
  assert.equal('callerId' in node(past, 'unit:codex'), false);
});

test('a call of ours over an "other" call takes the unit; its return idles it', () => {
  let s = reduce(initialState(T0), feedEv(T0, [snap('grok', [fcall('grok_research', T0 - MIN)])]));
  s = reduce(s, call(T0 + SEC, MAIN, 'c1', GROK_REVIEW, 'code_review'));
  assert.equal(node(s, 'unit:grok').callerId, MAIN);
  s = reduce(s, ret(T0 + 2 * SEC, MAIN, 'c1'));
  assert.equal(node(s, 'unit:grok').status, 'idle');
});

test('purity holds for the open-call events too: frozen state with open calls through return, stop and tick', () => {
  const rich = run(initialState(T0), spawn(T0, 'A', 'x'), call(T0 + 1, 'A', 'c1', GROK_REVIEW, 'r'), call(T0 + 2, MAIN, 'c2', GROK_REVIEW, 'r'));
  for (const ev of [ret(T0 + 3, 'A', 'c1'), ret(T0 + 3, MAIN, 'c2'), stop(T0 + 3, 'A'), { type: 'tick', at: T0 + 3 * HOUR }, call(T0 + 3, 'A', 'c3', CODEX_REVIEW, 'r'), feedEv(T0 + 3, [snap('grok', [])])]) {
    const state = structuredClone(rich);
    deepFreeze(state);
    deepFreeze(ev);
    assert.doesNotThrow(() => reduce(state, ev), ev.type);
    assert.deepEqual(state, rich, ev.type);
  }
});

test('subjectOf Bash: leading NAME=value words are skipped (quoted values as one word), then the program and, for a listed program, its plain second word', () => {
  const b = (command) => subjectOf('Bash', { command });
  assert.equal(b('FOO=bar npm test'), 'Bash: npm test');
  assert.equal(b('A=1 B=2 C_3=x npm run build'), 'Bash: npm run');
  assert.equal(b('_X=1 node x.js'), 'Bash: node x.js');
  assert.equal(b('TOKEN="a b c" npm test'), 'Bash: npm test');
  assert.equal(b("TOKEN='a b c' npm test"), 'Bash: npm test');
  assert.equal(b('TOKEN="a b"c npm test'), 'Bash: npm test');
  assert.equal(b('TOKEN= npm test'), 'Bash: npm test'); // empty value
  assert.equal(b('A=1\nB=2 npm test'), 'Bash', 'the scan stops at the newline');
  assert.equal(b('  FOO=bar   npm   test  '), 'Bash: npm test');
  assert.equal(b('FOO=bar'), 'Bash');
  assert.equal(b('FOO=bar BAR=baz'), 'Bash');
  // not an assignment: the name must start with a letter or underscore, and must lead the command
  assert.equal(b('1A=b cmd'), 'Bash');
  assert.equal(b('echo A=b'), 'Bash: echo');
  assert.equal(b('npm test FOO=bar'), 'Bash: npm test');
  assert.equal(b('=x cmd'), 'Bash');
});

test('subjectOf Bash: an assignment whose quote never closes shows plain Bash, and never any of its value', () => {
  const b = (command) => subjectOf('Bash', { command });
  for (const command of ['TOKEN="abc npm test', "TOKEN='abc npm test", 'A=1 TOKEN="abc def', 'FOO="x" TOKEN=\'abc def']) {
    assert.equal(b(command), 'Bash', command);
  }
  for (const command of ['TOKEN="sk-live-123 npm test', 'cd /x && TOKEN="sk-live-123 npm test']) {
    assert.doesNotMatch(b(command), /sk-live/, command);
  }
});

test('subjectOf Bash: one leading cd segment is skipped only when && or ; follows it, with assignments around it', () => {
  const b = (command) => subjectOf('Bash', { command });
  assert.equal(b('cd /home/op/proj && npm test'), 'Bash: npm test');
  assert.equal(b('cd /home/op/proj; npm test'), 'Bash: npm test');
  assert.equal(b('cd /x&&npm test'), 'Bash: npm test');
  assert.equal(b('cd "/home/op/my proj" && make all'), 'Bash: make all');
  assert.equal(b('cd /x && FOO=bar npm test'), 'Bash: npm test');
  assert.equal(b('FOO=bar cd /x && npm test'), 'Bash: npm test');
  assert.equal(b('cd /x && cd /y && npm test'), 'Bash: cd', 'only one leading cd segment');
  assert.equal(b('cd /x && ls'), 'Bash: ls');
  assert.equal(b('cd /x'), 'Bash: cd', 'a lone cd is the command, without its directory');
  assert.equal(b('cd'), 'Bash: cd');
  assert.equal(b('cd /x && '), 'Bash');
  assert.equal(b('cd /x || npm test'), 'Bash: cd', 'only && and ; join the segment');
  assert.equal(b('cdx foo && bar'), 'Bash: cdx', 'cdx is not cd');
  assert.equal(b('echo hi && cd /x && ls'), 'Bash: echo');
});

test('shortRole: one plugin namespace is stripped first, then the package prefix', () => {
  assert.equal(shortRole('omelette-fleet:omelette-coder-medium'), 'coder-medium');
  assert.equal(shortRole('omelette-fleet:omelette-tester'), 'tester');
  assert.equal(shortRole('other:thing'), 'thing');
  assert.equal(shortRole('omelette-fleet:Explore'), 'Explore');
  assert.equal(shortRole('a:b:c'), 'b:c', 'only one namespace');
  assert.equal(shortRole('omelette-coder'), 'coder');
  assert.equal(shortRole('Explore'), 'Explore');
  assert.equal(shortRole('ns:'), 'ns:');
  assert.equal(shortRole(':x'), ':x');
  assert.equal(shortRole('omelette-fleet'), 'fleet');
});

// ---------------------------------------------------------------------------
// T2.1: the Bash subject's tokenizer, the model's open-call fixes, the one STALE_MS
// ---------------------------------------------------------------------------

const MARK = 'S3CR3T9';
const SUBCOMMAND_PROGRAMS = ['npm', 'npx', 'pnpm', 'yarn', 'git', 'gh', 'node', 'cargo', 'go', 'make', 'docker', 'python', 'python3', 'pytest', 'claude', 'omelette-fleet'];
/** What a Bash subject may look like at all: the program, and a second word only for a listed program. */
const SUBJECT_SHAPE = /^Bash(?:: ([A-Za-z0-9._+-]+)(?: ([a-z][a-z0-9:._-]*))?)?$/i;

/** mulberry32: a seeded generator whose low bits are as good as its high ones. */
function lcg(seed) {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
}

test('subjectOf Bash, the examples of the ruling: program, listed second word, the cases that show only the program or plain Bash', () => {
  const b = (command) => subjectOf('Bash', { command });
  assert.equal(b('npm test'), 'Bash: npm test');
  assert.equal(b('npm test --silent'), 'Bash: npm test');
  assert.equal(b('npm run build'), 'Bash: npm run');
  assert.equal(b('git status'), 'Bash: git status');
  assert.equal(b('git commit -m "msg"'), 'Bash: git commit');
  assert.equal(b('/usr/local/bin/node x.js'), 'Bash: node x.js');
  assert.equal(b('./scripts/build.sh --all'), 'Bash: build.sh');
  assert.equal(b('curl https://example.test'), 'Bash: curl');
  assert.equal(b('rm -rf node_modules'), 'Bash: rm');
  assert.equal(b('echo hello'), 'Bash: echo');
  for (const program of SUBCOMMAND_PROGRAMS) assert.equal(b(`${program} sub-cmd:x.y_z --flag`), `Bash: ${program} sub-cmd:x.y_z`, program);
  assert.equal(b('npm'), 'Bash: npm');
  // a program outside the list shows alone, whatever its second word looks like
  for (const command of ['curl abc', 'echo hello', 'ls src', 'rm file', 'cat README', 'sudo npm', 'env x', 'export TOKEN', 'bash script', 'ssh host', 'time npm']) assert.equal(b(command), `Bash: ${command.split(' ')[0]}`, command);
  // a second word may be any case, but must start with a letter
  assert.equal(b('git STATUS'), 'Bash: git STATUS');
  assert.equal(b('npm Test'), 'Bash: npm Test');
  assert.equal(b('npm _x'), 'Bash: npm');
  // the second word must be plain: no flag, no path, no =, no number first, no quote or $
  for (const next of ['-v', '--version', './x', '/abs', 'a=b', '1abc', '$X', '~', '@scope/pkg', 'a/b']) {
    assert.equal(b(`npm ${next}`), 'Bash: npm', next);
  }
  assert.equal(b('npm "a b"'), 'Bash: npm');
  // quoted words are grouped before the checks
  assert.equal(b('npm "test"'), 'Bash: npm test');
  assert.equal(b("git 'status' -s"), 'Bash: git status');
  assert.equal(b('np\\m test'), 'Bash: npm test');
  // a program word outside [A-Za-z0-9._+-] is plain Bash
  for (const command of ['$X test', '"a b" c', "'a b' c", '${X} y', 'a=b', '@x y', '{ npm test; }', '!npm', '<(x)', '\\$x y', 'a:b c', 'a,b c', 'é c']) {
    assert.equal(b(command), 'Bash', command);
  }
  // the program is the base name of its word
  assert.equal(b('/a/b/git status'), 'Bash: git status');
  assert.equal(b('../x/make all'), 'Bash: make all');
  assert.equal(b('/a/b/'), 'Bash');
  assert.equal(b('~/bin/x y'), 'Bash: x', 'the plain-word check is on the base name');
  assert.equal(b('/a/b/$X y'), 'Bash');
  // stops at the first unquoted separator
  for (const [command, shown] of [
    ['npm test | tee out', 'Bash: npm test'],
    ['npm test && echo done', 'Bash: npm test'],
    ['npm test || echo fail', 'Bash: npm test'],
    ['npm test; echo done', 'Bash: npm test'],
    ['npm test\necho done', 'Bash: npm test'],
    ['npm test & echo bg', 'Bash: npm test'],
    ['npm $(echo test)', 'Bash: npm'],
    ['npm `echo test`', 'Bash: npm'],
    ['npm (test)', 'Bash: npm'],
    ['git status)', 'Bash: git status'],
    ['(npm test)', 'Bash'],
    ['| npm test', 'Bash'],
    ['; npm test', 'Bash'],
    ['\nnpm test', 'Bash'],
    ['&& npm test', 'Bash'],
  ]) assert.equal(b(command), shown, JSON.stringify(command));
  // a separator glued to a word ends the scan there (and the word is not cut with it)
  for (const [command, shown] of [
    ['npm test|tee', 'Bash: npm test'],
    ['npm test;ls', 'Bash: npm test'],
    ['npm test&&ls', 'Bash: npm test'],
    ['npm test||ls', 'Bash: npm test'],
    ['npm test(x)', 'Bash: npm test'],
    ['npm test)x', 'Bash: npm test'],
    ['npm test`x`', 'Bash: npm test'],
    ['npm test$(x)', 'Bash: npm test'],
    ['npm test\nls', 'Bash: npm test'],
  ]) assert.equal(b(command), shown, JSON.stringify(command));
  assert.equal(b('cd /x || npm test'), 'Bash: cd');
  // inside quotes the separators are text, and a substitution inside double quotes stops the scan
  assert.equal(b('git "status; rm" -s'), 'Bash: git', 'the quoted word is not plain');
  assert.equal(b("git 'a|b'"), 'Bash: git');
  assert.equal(b('npm "te$(x)st"'), 'Bash: npm');
  assert.equal(b('npm "te`x`st"'), 'Bash: npm');
  assert.equal(b("npm 'te$(x)st'"), 'Bash: npm', 'single quotes keep the $( as text, and the word is not plain');
  // a substitution inside double quotes ends the scan and drops its word, so what follows is never read
  assert.equal(b('cd "a$(x)" && npm test'), 'Bash: cd');
  assert.equal(b('cd "a`x`" && npm test'), 'Bash: cd');
  assert.equal(b('npm "$(echo "'), 'Bash: npm');
  assert.equal(b('npm "`echo "'), 'Bash: npm');
  assert.equal(b('npm "te\\"st"'), 'Bash: npm', 'an escaped quote inside double quotes does not close them');
  assert.equal(b('npm test "a\\" b" c'), 'Bash: npm test');
  // an unclosed quote anywhere in the scanned part
  for (const command of ['npm "test', "npm 'test", 'echo "', "echo '", 'FOO="x npm test', 'npm test "unclosed']) assert.equal(b(command), 'Bash', command);
  assert.equal(b('npm test && echo "unclosed'), 'Bash: npm test', 'beyond the stop, nothing is read');
  // backslash escapes
  assert.equal(b('npm test\\'), 'Bash: npm test');
  assert.equal(b('np\\ m test'), 'Bash', 'an escaped space is part of the word');
  assert.equal(b('npm te\\;st'), 'Bash: npm', 'an escaped ; is text, and the word is not plain');
  assert.equal(b('npm \\|'), 'Bash: npm');
});

test('subjectOf Bash, a property: a marker secret never reaches the subject - assignments, prefixes, flags, substitutions, pipes, separators, quotes, escapes', () => {
  const rnd = lcg(20261008);
  const pick = (list) => list[rnd(list.length)];
  const values = [
    MARK, `"${MARK}"`, `'${MARK}'`, `"a ${MARK}"`, `'a ${MARK}'`, `a\\ ${MARK}`, `x${MARK}`, `"x"${MARK}`, `$(echo ${MARK})`, `\`echo ${MARK}\``,
    `"$(echo ${MARK})"`, `"x \`echo ${MARK}\`"`, `\${${MARK}}`, `$'${MARK}'`, `"it's ${MARK}"`, `'say "${MARK}"'`, `"a\\"${MARK}"`, `a\\;${MARK}`, `"a;b|c&&${MARK}"`, `'(${MARK})'`,
    `a\\\n${MARK}`, `"multi\nline ${MARK}"`, `$(a "$(b ${MARK})")`, `"$X"${MARK}`,
  ];
  const connectors = [' | ', ' && ', ' || ', '; ', '\n', ' & ', ' > ', ' 2>&1 | ', ' <<< ', ' $(', ' `', ' (', ' ) ', ';;', '|&', '\r\n'];
  const assignments = [(v) => `TOKEN=${v}`, (v) => `A_B1=${v}`, (v) => `_x=${v}`, (v) => `A+=${v}`, (v) => `A[0]=${v}`, () => 'TOKEN=', (v) => `export TOKEN=${v}`, (v) => `A=1 B=${v}`];
  // programs with the words that precede the secret slot: a listed program's second word is shown, so the slot comes after it
  const programs = [
    'npm test', 'git status', 'node x.js', 'docker run', 'gh auth', 'make deploy', 'claude -p', 'python3 -c', 'cargo build', 'pnpm install', 'yarn add', 'npx tool', 'go run', 'pytest -k', 'omelette-fleet set',
    'echo', 'curl', 'sudo', 'env', 'export', 'time', '/usr/bin/env', 'bash -c', 'sh -c', 'ssh', 'mysql', 'psql', 'wget', 'nohup', 'xargs', 'cat', 'printf', 'gpg --passphrase', 'aws', 'kubectl',
  ];
  const flagged = [(v) => `--token ${v}`, (v) => `--token=${v}`, (v) => `-p${v}`, (v) => `-H "Authorization: Bearer ${v}"`, (v) => `--password '${v}'`, (v) => v, (v) => `https://user:${v}@host/x`, (v) => `-e KEY=${v}`, (v) => `--env=KEY=${v}`, (v) => `${v} --flag`];
  const chains = ['', 'cd /x && ', 'cd /x; ', 'cd "a b" && ', 'cd /x && cd /y && ', `cd ${MARK} && `, `cd ${MARK}; `, `cd "${MARK}" && `, 'cd /x || ', 'cd /x | ', '(', '{ ', '! ', 'FOO=1 '];
  const leaks = [];
  // every program with every flag form and value, and every chain, connector and assignment form around a fixed program
  const check = (command) => {
    const out = subjectOf('Bash', { command });
    if (out.includes('S3CR')) leaks.push([command, out]);
    const m = SUBJECT_SHAPE.exec(out);
    assert.ok(m, `shape: ${JSON.stringify(command)} -> ${JSON.stringify(out)}`);
    if (m[2] !== undefined) assert.ok(SUBCOMMAND_PROGRAMS.includes(m[1]), `second word only for a listed program: ${JSON.stringify(command)} -> ${out}`);
  };
  for (const program of programs) for (const flag of flagged) for (const value of values) check(`${program} ${flag(value)}`);
  for (const chain of chains) for (const assign of assignments) for (const value of values) check(`${chain}${assign(value)} npm test --x`);
  for (const connector of connectors) for (const program of programs) for (const flag of flagged) for (const value of values) check(`npm test${connector}${program} ${flag(value)}`);
  for (const chain of chains) for (const value of values) check(`${chain}export X=${value}`);
  const N = 6000;
  for (let k = 0; k < N; k++) {
    const parts = [pick(chains)];
    if (rnd(3) > 0) for (let n = rnd(3) + 1; n > 0; n--) parts.push(`${pick(assignments)(pick(values))} `);
    parts.push(pick(programs));
    for (let n = rnd(3); n > 0; n--) parts.push(` ${pick(flagged)(pick(values))}`);
    if (rnd(2)) parts.push(pick(connectors) + pick(flagged)(pick(values)));
    if (rnd(4) === 0) parts.push(`${pick(connectors) + pick(programs)} ${pick(flagged)(pick(values))}`);
    check(parts.join(''));
  }
  assert.deepEqual(leaks.slice(0, 5), [], `${leaks.length} of ${N} generated commands put the marker on screen`);
});

test('subjectOf Bash, a property: whatever bytes come in, the subject has the allowed shape and the call returns', () => {
  const rnd = lcg(99);
  const alphabet = ['n', 'p', 'm', ' ', ' ', 't', 'e', 's', 'c', 'd', '=', 'A', '_', '0', '"', "'", '\\', '$', '(', ')', '`', '|', '&', ';', '\n', '\t', '/', '.', '-', ':', 'é', '日', '😀', '\u0000'];
  const words = ['npm', 'cd', 'git', 'status', 'FOO=bar', '&&', '||', ';', 'sudo', 'env', 'export'];
  for (let k = 0; k < 8000; k++) {
    let command = '';
    for (let n = rnd(40); n > 0; n--) command += rnd(3) === 0 ? ` ${words[rnd(words.length)]} ` : alphabet[rnd(alphabet.length)];
    const out = subjectOf('Bash', { command });
    const m = SUBJECT_SHAPE.exec(out);
    assert.ok(m, `${JSON.stringify(command)} -> ${JSON.stringify(out)}`);
    if (m[2] !== undefined) assert.ok(SUBCOMMAND_PROGRAMS.includes(m[1]), `${JSON.stringify(command)} -> ${out}`);
  }
});

test('subjectOf Bash is linear: 100 000-character commands of spaces, quotes, backslashes, =, cd, separators and assignments each take under 50 ms', () => {
  const n = 100000;
  const cases = {
    spaces: ' '.repeat(n),
    'cd and spaces': `cd ${' '.repeat(n)}x`,
    'cd and spaces then &&': `cd ${' '.repeat(n)}&& npm test`,
    'npm and spaces': `npm${' '.repeat(n)}test`,
    'double quotes': '"'.repeat(n),
    'single quotes': "'".repeat(n),
    'open quote then text': `FOO="${'x'.repeat(n)}`,
    'quote pairs': '""'.repeat(n / 2),
    backslashes: '\\'.repeat(n),
    'backslash pairs': '\\ '.repeat(n / 2),
    'equals signs': '='.repeat(n),
    'name equals': `A${'='.repeat(n)}`,
    assignments: 'A=1 '.repeat(n / 4),
    'assignment of a long word': `A=${'b'.repeat(n)} npm test`,
    'a long word': 'a'.repeat(n),
    'a long name without =': `${'A'.repeat(n)} x`,
    'cd words': 'cd '.repeat(n / 3),
    'cd and &&': 'cd x && '.repeat(n / 8),
    'cd and ;': 'cd x; '.repeat(n / 6),
    'dollar-parens': '$('.repeat(n / 2),
    'double quote then dollar-parens': `"${'$('.repeat(n / 2)}`,
    backticks: '`'.repeat(n),
    newlines: '\n'.repeat(n),
    pipes: '|'.repeat(n),
    ampersands: '&'.repeat(n),
    'many words': 'a '.repeat(n / 2),
    'many words after npm': `npm ${'t '.repeat(n / 2)}`,
    tabs: '\t'.repeat(n),
    'cd tab runs': `cd${'\t '.repeat(n / 2)}`,
  };
  subjectOf('Bash', { command: 'npm test' }); // warm up
  for (const [name, command] of Object.entries(cases)) {
    let best = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      const t = performance.now();
      subjectOf('Bash', { command });
      best = Math.min(best, performance.now() - t);
    }
    assert.ok(best < 50, `${name}: ${best.toFixed(1)} ms for ${command.length} characters`);
  }
});

test('model: a unit call with no call id opens nothing (the unit stays idle) but the link is still recorded', () => {
  for (const callId of [undefined, '', null]) {
    const s = reduce(initialState(T0), { type: 'call', at: T0 + SEC, agentId: MAIN, callId, tool: GROK_REVIEW, subject: 'code_review' });
    const u = node(s, 'unit:grok');
    assert.equal(u.status, 'idle', String(callId));
    assert.equal('openCalls' in u, false);
    assert.equal('callerId' in u, false);
    assert.deepEqual(s.history, [{ at: T0 + SEC, from: MAIN, to: 'unit:grok', label: 'code_review' }]);
  }
  // an id-less call next to an open one leaves the open one alone
  let s = run(initialState(T0), call(T0, MAIN, 'c1', GROK_REVIEW, 'code_review'));
  s = reduce(s, { type: 'call', at: T0 + SEC, agentId: MAIN, tool: GROK_REVIEW, subject: 'code_review' });
  assert.deepEqual(node(s, 'unit:grok').openCalls.map((c) => c.callId), ['c1']);
  assert.equal(s.history.length, 2);
});

test('model: a unit keeps at most 20 open calls, the oldest dropped; the cap is per unit; a dropped call\'s return is foreign', () => {
  let s = initialState(T0);
  for (let i = 0; i < 20; i++) s = reduce(s, call(T0 + i, MAIN, `c${i}`, GROK_REVIEW, 'code_review'));
  assert.equal(node(s, 'unit:grok').openCalls.length, 20, 'exactly 20 are all kept');
  assert.equal(node(s, 'unit:grok').openCalls[0].callId, 'c0');
  for (let i = 20; i < 25; i++) s = reduce(s, call(T0 + i, MAIN, `c${i}`, GROK_REVIEW, 'code_review'));
  const u = node(s, 'unit:grok');
  assert.equal(u.openCalls.length, 20);
  assert.deepEqual(u.openCalls.map((c) => c.callId), Array.from({ length: 20 }, (_, i) => `c${i + 5}`));
  assert.equal(u.activityCallId, 'c24');
  assert.equal(s.history.length, 25, 'the history keeps every link');
  // another unit has its own 20
  s = reduce(s, call(T0 + 30, MAIN, 'g1', GEMINI_RESEARCH, 'research'));
  assert.equal(node(s, 'unit:gemini').openCalls.length, 1);
  assert.equal(node(s, 'unit:grok').openCalls.length, 20);
  // c0 fell off: its return changes nothing about the unit
  const foreign = reduce(s, ret(T0 + 40, MAIN, 'c0'));
  assert.equal(node(foreign, 'unit:grok').openCalls.length, 20);
  assert.equal('lastEndedAt' in node(foreign, 'unit:grok'), false);
  // one still held returns: 19 left
  assert.equal(node(reduce(s, ret(T0 + 40, MAIN, 'c24')), 'unit:grok').openCalls.length, 19);
});

test('model: a unit that falls back to an older open call drops model and effort; keeping the newest keeps them; the feed sets them again', () => {
  const base = run(
    initialState(T0),
    spawn(T0, 'A', 'x'),
    spawn(T0, 'B', 'y'),
    call(T0 + 1 * SEC, 'A', 'cA', GROK_REVIEW, 'code_review'),
    call(T0 + 5 * SEC, 'B', 'cB', GROK_REVIEW, 'code_review'),
    feedEv(T0 + 6 * SEC, [snap('grok', [fcall('grok_code_review', T0 + 5 * SEC, 'm-b', 'high')])]),
  );
  assert.equal(node(base, 'unit:grok').model, 'm-b');
  const noModel = (s) => !('model' in node(s, 'unit:grok')) && !('effort' in node(s, 'unit:grok'));
  // the newest returns: fall back to A's call
  const viaReturn = reduce(base, ret(T0 + 7 * SEC, 'B', 'cB'));
  assert.equal(node(viaReturn, 'unit:grok').activityCallId, 'cA');
  assert.ok(noModel(viaReturn), 'return');
  // the agent that made the newest stops
  const viaStop = reduce(base, stop(T0 + 7 * SEC, 'B'));
  assert.equal(node(viaStop, 'unit:grok').activityCallId, 'cA');
  assert.ok(noModel(viaStop), 'stop');
  // the older call returns: the newest stays, and so do its model and effort
  const older = reduce(base, ret(T0 + 7 * SEC, 'A', 'cA'));
  assert.equal(node(older, 'unit:grok').activityCallId, 'cB');
  assert.equal(node(older, 'unit:grok').model, 'm-b');
  assert.equal(node(older, 'unit:grok').effort, 'high');
  // a tick that drops only the old call keeps the newest and its model
  const viaTick = reduce(base, { type: 'tick', at: T0 + 5 * SEC + STALE_MS });
  assert.equal(node(viaTick, 'unit:grok').activityCallId, 'cB');
  assert.equal(node(viaTick, 'unit:grok').model, 'm-b');
  // the feed sets them again for the call that is shown
  const again = reduce(viaReturn, feedEv(T0 + 8 * SEC, [snap('grok', [fcall('grok_code_review', T0 + 1 * SEC, 'm-a', 'medium')])]));
  assert.equal(node(again, 'unit:grok').model, 'm-a');
  assert.equal(node(again, 'unit:grok').effort, 'medium');
});

test('model: one exported STALE_MS of 2 hours serves feed.mjs and tick alike', () => {
  assert.equal(STALE_MS, 2 * 60 * 60 * 1000);
  const feedSrc = readFileSync(join(HOOKS, 'feed.mjs'), 'utf8');
  assert.match(feedSrc, /import \{[^}]*\bSTALE_MS\b[^}]*\} from '\.\/model\.mjs'/);
  assert.doesNotMatch(feedSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /\b60 \* 60|\b120 \* 60|7200|3600/, 'feed.mjs carries no second copy of the bound');
  const doc = JSON.stringify({ schema: 2, unit: 'grok', pid: 7, active: [{ id: '7-1', tool: 'grok_research', startedAt: '2026-10-08T11:00:00.000Z' }], lastEvent: null, updatedAt: '2026-10-08T12:00:00.000Z' });
  const u = Date.parse('2026-10-08T12:00:00.000Z');
  assert.equal(parseSnapshot(doc, u + STALE_MS).isStale, false);
  assert.equal(parseSnapshot(doc, u + STALE_MS + 1).isStale, true);
  const s = run(initialState(T0), call(T0, MAIN, 'c1', 'Bash', 'Bash: x'));
  assert.equal(node(reduce(s, { type: 'tick', at: T0 + STALE_MS }), MAIN).activity, 'Bash: x');
  assert.equal('activity' in node(reduce(s, { type: 'tick', at: T0 + STALE_MS + 1 }), MAIN), false);
});

test('package.json: npm test runs the test directory', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test test/');
});
