/**
 * omelette-fleet :: test/mod-model.test.mjs
 * The fleet pane's model (1.7.0, Task 2): mods/omelette-fleet/hooks/model.mjs,
 * a pure reducer from engine-shaped events to nodes, links and history. One
 * test per row of the plan's events table, then the composed cases: a nested
 * spawn, a unit call from the main loop and from a sub-agent, a foreign
 * return, purity on deep-frozen input, the history cap, and the Review Focus
 * cases 1 (agents known only from $.agent.list()), 2 (a broken or stale
 * snapshot) and 5 (a tool call that never returns). Ids are made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN, STALE_MS, UNITS, initialState, reduce, unitOfTool } from '../mods/omelette-fleet/hooks/model.mjs';
import { parseSnapshot } from '../mods/omelette-fleet/hooks/feed.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const CODER = 'a7c0de01';
const TESTER = 'b7e57e02';
const HELPER = 'c4e1b003';

const node = (state, id) => state.nodes.find((n) => n.id === id);
const run = (state, ...events) => events.reduce((s, e) => reduce(s, e), state);
const spawn = (at, agentId, role, extra = {}) => ({ type: 'spawn', at, agentId, role, ...extra });
const call = (at, agentId, callId, tool, subject, extra = {}) => ({ type: 'call', at, agentId, callId, tool, subject, ...extra });

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

test('initialState: the orchestrator and the three units, all idle, the units without a feed, nothing in history', () => {
  const s = initialState(T0);
  assert.deepEqual(s.nodes.map((n) => n.id), ['main', 'unit:gemini', 'unit:grok', 'unit:codex']);
  assert.deepEqual(node(s, MAIN), { id: 'main', kind: 'orchestrator', role: 'orchestrator', status: 'idle', since: T0, order: 0 });
  assert.deepEqual(node(s, 'unit:grok'), { id: 'unit:grok', kind: 'unit', role: 'grok', status: 'idle', since: T0, feed: 'none', order: 2 });
  for (const unit of UNITS) assert.equal(node(s, `unit:${unit}`).feed, 'none');
  assert.deepEqual(s.history, []);
  assert.deepEqual(s.usage, {});
  assert.equal(s.now, T0);
  assert.equal(s.isOpen, false);
});

test('UNITS names exactly the directories under units/, and MAIN is the main loop\'s id', () => {
  const dirs = readdirSync(join(ROOT, 'units')).filter((n) => statSync(join(ROOT, 'units', n)).isDirectory()).sort();
  assert.deepEqual([...UNITS].sort(), dirs);
  assert.equal(MAIN, 'main');
});

test('unitOfTool: a unit\'s MCP tool under any server prefix splits into unit and tool part; anything else is null', () => {
  assert.deepEqual(unitOfTool('mcp__orion-grok__grok_code_review'), { unit: 'grok', tool: 'code_review' });
  assert.deepEqual(unitOfTool('mcp__x__gemini_deep_research'), { unit: 'gemini', tool: 'deep_research' });
  assert.deepEqual(unitOfTool('mcp__omelette-codex__codex_research'), { unit: 'codex', tool: 'research' });
  assert.equal(unitOfTool('mcp__omelette__get_usage'), null);
  assert.equal(unitOfTool('Bash'), null);
  assert.equal(unitOfTool('grok_code_review'), null, 'not an MCP name');
  assert.equal(unitOfTool('mcp__orion-grok__grok_'), null, 'no tool part');
  for (const other of ['mcp__grok_code_review', 'mcp__x__grokx_review', 'mcp__x__Grok_review', 'mcp__x__xgrok_review', 'mcp__x__jaravis_research']) assert.equal(unitOfTool(other), null, other);
  assert.equal(unitOfTool(undefined), null);
});

test('spawn: adds a running agent under the main loop, with its role and model, and links main → agent · Agent', () => {
  const s = reduce(initialState(T0), spawn(T0 + SEC, CODER, 'omelette-coder-medium', { model: 'claude-opus-5-5' }));
  assert.deepEqual(node(s, CODER), {
    id: CODER, kind: 'agent', role: 'omelette-coder-medium', parentId: 'main', model: 'claude-opus-5-5',
    status: 'running', since: T0 + SEC, order: 4,
  });
  assert.deepEqual(s.history, [{ at: T0 + SEC, from: 'main', to: CODER, label: 'Agent' }]);
  const second = reduce(s, spawn(T0 + 2 * SEC, TESTER, 'omelette-tester', { model: 'claude-sonnet-5-5', parentId: '' }));
  assert.equal(node(second, TESTER).order, 5, 'order is the spawn sequence');
  assert.equal(node(second, TESTER).parentId, 'main', 'an empty parentId is the main loop');
});

test('spawn of an agent the model already holds updates it in place, keeping its order', () => {
  const listed = reduce(initialState(T0), { type: 'agents', at: T0, list: [{ id: CODER, type: 'omelette-coder', status: 'running' }] });
  const s = reduce(listed, spawn(T0 + SEC, CODER, 'omelette-coder', { model: 'claude-opus-5-5' }));
  assert.equal(s.nodes.length, 5);
  assert.equal(node(s, CODER).model, 'claude-opus-5-5');
  assert.equal(node(s, CODER).order, node(listed, CODER).order);
  assert.equal(node(s, CODER).status, 'running');
});

test('step: sets model and effort on the main loop and on an agent; the activity is not touched', () => {
  let s = run(initialState(T0),
    spawn(T0, CODER, 'omelette-coder-medium', { model: 'claude-opus-5-5' }),
    call(T0 + SEC, CODER, 'k1', 'Bash', 'Bash: npm test'),
    { type: 'step', at: T0 + 2 * SEC, agentId: CODER, model: 'claude-opus-5-5', effort: 'medium' },
    { type: 'step', at: T0 + 2 * SEC, agentId: MAIN, model: 'claude-fable-5-1', effort: 'high' });
  assert.equal(node(s, CODER).effort, 'medium');
  assert.equal(node(s, CODER).activity, 'Bash: npm test');
  assert.equal(node(s, CODER).activityCallId, 'k1');
  assert.equal(node(s, MAIN).model, 'claude-fable-5-1');
  assert.equal(node(s, MAIN).effort, 'high');
  assert.equal(node(s, MAIN).since, T0, 'a step of a loop that was not reported keeps its since');
  // A model without effort leaves none.
  s = reduce(s, { type: 'step', at: T0 + 3 * SEC, agentId: MAIN, model: 'claude-haiku-5-5' });
  assert.equal(node(s, MAIN).model, 'claude-haiku-5-5');
  assert.equal('effort' in node(s, MAIN), false);
});

test('step: a reported agent becomes running again (it was resumed), since the step', () => {
  const s = run(initialState(T0),
    spawn(T0, TESTER, 'omelette-tester'),
    { type: 'stop', at: T0 + MIN, agentId: TESTER },
    { type: 'step', at: T0 + 5 * MIN, agentId: TESTER, model: 'claude-sonnet-5-5', effort: 'high' });
  assert.equal(node(s, TESTER).status, 'running');
  assert.equal(node(s, TESTER).since, T0 + 5 * MIN);
  assert.equal(node(s, TESTER).model, 'claude-sonnet-5-5');
});

test('step of a loop the model does not know returns the state as given', () => {
  const s = initialState(T0);
  assert.equal(reduce(s, { type: 'step', at: T0, agentId: 'ffff0000', model: 'claude-opus-5-5', effort: 'high' }), s);
});

test('call: sets the loop\'s activity (the subject, else the tool\'s name), its call id and running', () => {
  let s = run(initialState(T0), spawn(T0, CODER, 'omelette-coder-medium'), call(T0 + MIN, CODER, 'k1', 'Bash', 'Bash: npm test'));
  assert.equal(node(s, CODER).activity, 'Bash: npm test');
  assert.equal(node(s, CODER).activityCallId, 'k1');
  assert.equal(node(s, CODER).status, 'running');
  // The activity's start: what a tick measures its age from.
  assert.equal(node(s, CODER).since, T0 + MIN);
  s = reduce(s, call(T0 + 2 * MIN, CODER, 'k2', 'Grep'));
  assert.equal(node(s, CODER).activity, 'Grep');
  assert.equal(node(s, CODER).activityCallId, 'k2');
  assert.deepEqual(s.history.map((l) => l.label), ['Agent'], 'a plain tool call adds no link');
  for (const held of [{ type: 'stop', at: T0 + 3 * MIN, agentId: CODER }, { type: 'agents', at: T0 + 3 * MIN, list: [{ id: CODER, type: 'omelette-coder-medium', status: 'waiting' }] }]) {
    assert.equal(node(run(s, held, call(T0 + 4 * MIN, CODER, 'k3', 'Read', 'Read a.mjs')), CODER).status, 'running', `a call after ${held.type}`);
  }
});

test('call: a unit tool from the main loop sets the unit running, called by main, and links main → unit · tool part', () => {
  const s = reduce(initialState(T0), call(T0 + MIN, MAIN, 'u1', 'mcp__orion-grok__grok_code_review', 'code_review'));
  assert.deepEqual(node(s, 'unit:grok'), {
    id: 'unit:grok', kind: 'unit', role: 'grok', status: 'running', since: T0 + MIN, feed: 'none', order: 2,
    callerId: 'main', activity: 'code_review', activityCallId: 'u1',
    openCalls: [{ callId: 'u1', callerId: 'main', tool: 'code_review', since: T0 + MIN }],
  });
  assert.equal(node(s, MAIN).activity, 'code_review');
  assert.equal(node(s, MAIN).status, 'running');
  assert.deepEqual(s.history, [{ at: T0 + MIN, from: 'main', to: 'unit:grok', label: 'code_review' }]);
});

test('call: a unit tool from a sub-agent\'s loop names that agent as the caller', () => {
  const s = run(initialState(T0),
    spawn(T0, CODER, 'omelette-coder-medium'),
    call(T0 + MIN, CODER, 'u2', 'mcp__x__gemini_research', 'research'));
  assert.equal(node(s, 'unit:gemini').callerId, CODER);
  assert.equal(node(s, 'unit:gemini').status, 'running');
  assert.equal(node(s, 'unit:gemini').activity, 'research');
  assert.equal(node(s, CODER).activity, 'research');
  assert.deepEqual(s.history.at(-1), { at: T0 + MIN, from: CODER, to: 'unit:gemini', label: 'research' });
});

test('call: SendMessage links the caller to its target — a node id, or the raw name when no node has it', () => {
  const s = run(initialState(T0),
    spawn(T0, TESTER, 'omelette-tester'),
    call(T0 + MIN, MAIN, 'm1', 'SendMessage', 'SendMessage', { target: TESTER }),
    call(T0 + 2 * MIN, TESTER, 'm2', 'SendMessage', 'SendMessage', { target: 'main' }),
    call(T0 + 3 * MIN, MAIN, 'm3', 'SendMessage', 'SendMessage', { target: 'reviewer-2' }),
    call(T0 + 4 * MIN, MAIN, 'm4', 'SendMessage', 'SendMessage'));
  assert.deepEqual(s.history.slice(1), [
    { at: T0 + MIN, from: 'main', to: TESTER, label: 'SendMessage' },
    { at: T0 + 2 * MIN, from: TESTER, to: 'main', label: 'SendMessage' },
    { at: T0 + 3 * MIN, from: 'main', to: 'reviewer-2', label: 'SendMessage' },
  ], 'no target, no link');
});

test('return: clears the loop\'s activity when the call id matches; the unit whose call it was becomes idle with lastEndedAt', () => {
  const s = run(initialState(T0),
    spawn(T0, CODER, 'omelette-coder-medium'),
    call(T0 + MIN, CODER, 'u2', 'mcp__orion-grok__grok_code_review', 'code_review'),
    { type: 'return', at: T0 + 3 * MIN, agentId: CODER, callId: 'u2' });
  assert.equal('activity' in node(s, CODER), false);
  assert.equal('activityCallId' in node(s, CODER), false);
  assert.equal(node(s, CODER).status, 'running', 'the loop goes on after a call returns');
  assert.deepEqual(node(s, 'unit:grok'), {
    id: 'unit:grok', kind: 'unit', role: 'grok', status: 'idle', since: T0 + MIN, feed: 'none', order: 2, lastEndedAt: T0 + 3 * MIN,
  });
});

test('return with a foreign call id changes nothing', () => {
  const before = run(initialState(T0),
    spawn(T0, CODER, 'omelette-coder-medium'),
    call(T0 + MIN, CODER, 'k1', 'Bash', 'Bash: npm test'),
    call(T0 + MIN, MAIN, 'u1', 'mcp__orion-codex__codex_research', 'research'));
  for (const e of [
    { type: 'return', at: T0 + 2 * MIN, agentId: CODER, callId: 'zz' },
    { type: 'return', at: T0 + 2 * MIN, agentId: CODER },
    { type: 'return', at: T0 + 2 * MIN, agentId: 'ffff0000', callId: 'k1' },
  ]) {
    const after = reduce(before, e);
    assert.deepEqual(after, before, JSON.stringify(e));
  }
});

test('an agent with two parallel calls, the newer returning first, still shows the older one\'s subject; the last return clears it', () => {
  let s = run(initialState(T0),
    spawn(T0, CODER, 'omelette-coder'),
    call(T0 + SEC, CODER, 'k1', 'Bash', 'Bash: npm test'),
    call(T0 + 2 * SEC, CODER, 'k2', 'Read', 'Read a.mjs'));
  assert.equal(node(s, CODER).activity, 'Read a.mjs', 'the newest shows');
  s = reduce(s, { type: 'return', at: T0 + 3 * SEC, agentId: CODER, callId: 'k2' });
  const held = node(s, CODER);
  assert.deepEqual([held.activity, held.activityCallId, held.since, held.status], ['Bash: npm test', 'k1', T0 + SEC, 'running']);
  s = reduce(s, { type: 'return', at: T0 + 4 * SEC, agentId: CODER, callId: 'k1' });
  for (const k of ['activity', 'activityCallId', 'loopCalls']) assert.equal(k in node(s, CODER), false, k);
});

test('a loop\'s newest remaining call shows when the newest returns, and only 20 are held: the oldest past the cap is dropped, its return changes nothing', () => {
  let s = run(initialState(T0),
    spawn(T0, CODER, 'omelette-coder'),
    call(T0 + SEC, CODER, 'k1', 'Bash', 'Bash: npm test'),
    call(T0 + 2 * SEC, CODER, 'k2', 'Read', 'Read a.mjs'),
    call(T0 + 3 * SEC, CODER, 'k3', 'Grep', 'Grep'));
  s = reduce(s, { type: 'return', at: T0 + 4 * SEC, agentId: CODER, callId: 'k3' });
  const held = node(s, CODER);
  assert.deepEqual([held.activity, held.activityCallId, held.since], ['Read a.mjs', 'k2', T0 + 2 * SEC], 'the newest of those remaining, not the oldest');
  let capped = run(initialState(T0), spawn(T0, CODER, 'omelette-coder'));
  for (let i = 0; i < 25; i++) capped = reduce(capped, call(T0 + (i + 1) * SEC, CODER, `c${i}`, 'Read', `Read f${i}.mjs`));
  assert.deepEqual(node(capped, CODER).loopCalls.map((c) => c.callId), Array.from({ length: 20 }, (_, i) => `c${i + 5}`));
  assert.equal(reduce(capped, { type: 'return', at: T0 + HOUR / 4, agentId: CODER, callId: 'c0' }), capped, 'a dropped call\'s return is foreign');
});

test('a loop\'s open calls stay pure: call, return, stop and tick on deep-frozen state never write into an earlier loopCalls', () => {
  let state = deepFreeze(run(initialState(T0), spawn(T0, CODER, 'omelette-coder')));
  for (const e of [
    call(T0 + SEC, CODER, 'a', 'Bash', 'Bash: npm test'),
    call(T0 + 2 * SEC, CODER, 'b', 'Read', 'Read a.mjs'),
    call(T0 + 3 * SEC, MAIN, 'c', 'Grep'),
    call(T0 + 4 * SEC, MAIN, 'd', 'Read', 'Read b.mjs'),
    { type: 'return', at: T0 + 5 * SEC, agentId: CODER, callId: 'b' },
    { type: 'stop', at: T0 + 6 * SEC, agentId: CODER },
    { type: 'tick', at: T0 + 3 * SEC + 2 * HOUR + 1 },
  ]) {
    const copy = JSON.stringify(state);
    const next = reduce(state, deepFreeze(e));
    assert.equal(JSON.stringify(state), copy, `${e.type} changed its input`);
    state = deepFreeze(next);
  }
  assert.deepEqual(node(state, MAIN).loopCalls, [{ callId: 'd', subject: 'Read b.mjs', since: T0 + 4 * SEC }], 'the tick dropped only the call past 2 hours');
  assert.equal('loopCalls' in node(state, CODER), false, 'the stop cleared the agent\'s');
});

test('settle: a loop\'s next model request clears its open calls and its activity; a loop with none, a unit or an unknown id is returned as given', () => {
  const lost = deepFreeze(run(initialState(T0),
    spawn(T0, CODER, 'omelette-coder'),
    call(T0 + SEC, CODER, 'k1', 'Bash', 'Bash: npm test'),
    call(T0 + 2 * SEC, MAIN, 'u1', GROK, 'code_review')));
  const settled = reduce(lost, { type: 'settle', at: T0 + MIN, agentId: CODER });
  for (const k of ['loopCalls', 'activity', 'activityCallId']) assert.equal(k in node(settled, CODER), false, k);
  assert.deepEqual([node(settled, CODER).status, node(settled, CODER).since], ['running', T0 + SEC], 'the loop still runs; only its calls are over');
  assert.equal(node(settled, MAIN).activity, 'code_review', 'another loop\'s calls stay');
  assert.equal(node(settled, 'unit:grok').status, 'running', 'a unit\'s calls are its own');
  assert.equal(reduce(settled, { type: 'settle', at: T0 + MIN, agentId: CODER }), settled, 'no open calls: as given');
  for (const agentId of ['unit:grok', 'ffff0000']) assert.equal(reduce(lost, { type: 'settle', at: T0 + MIN, agentId }), lost, agentId);
});

const GROK = 'mcp__orion-grok__grok_code_review';
const CODEX = 'mcp__orion-codex__codex_research';

test('parallel calls on one unit: the later returning first leaves the unit running the earlier one; the last return makes it idle', () => {
  let s = run(initialState(T0),
    spawn(T0, CODER, 'omelette-coder'),
    spawn(T0, TESTER, 'omelette-tester'),
    call(T0 + SEC, CODER, 'cA', GROK, 'code_review'),
    call(T0 + 2 * SEC, TESTER, 'cB', GROK, 'code_review'));
  assert.equal(node(s, 'unit:grok').callerId, TESTER, 'the newest open call shows');
  assert.equal(node(s, 'unit:grok').openCalls.length, 2);
  s = reduce(s, { type: 'return', at: T0 + 3 * SEC, agentId: TESTER, callId: 'cB' });
  const held = node(s, 'unit:grok');
  assert.equal(held.status, 'running', 'A\'s call is still out');
  assert.equal(held.callerId, CODER);
  assert.equal(held.activityCallId, 'cA');
  assert.equal(held.since, T0 + SEC);
  assert.deepEqual(held.openCalls, [{ callId: 'cA', callerId: CODER, tool: 'code_review', since: T0 + SEC }]);
  assert.equal('lastEndedAt' in held, false, 'nothing has ended for the unit yet');
  s = reduce(s, { type: 'return', at: T0 + 4 * SEC, agentId: CODER, callId: 'cA' });
  const done = node(s, 'unit:grok');
  assert.equal(done.status, 'idle');
  assert.equal(done.lastEndedAt, T0 + 4 * SEC);
  for (const k of ['openCalls', 'callerId', 'activity', 'activityCallId']) assert.equal(k in done, false, k);
  assert.equal(s.history.filter((l) => l.to === 'unit:grok').length, 2, 'one link per call');
});

test('parallel calls from the main loop on one unit (two narrow briefs): the first return keeps the unit running the other', () => {
  const s = run(initialState(T0),
    call(T0, MAIN, 'c1', CODEX, 'research'),
    call(T0 + SEC, MAIN, 'c2', CODEX, 'research'),
    { type: 'return', at: T0 + 5 * SEC, agentId: MAIN, callId: 'c2' });
  assert.equal(node(s, 'unit:codex').status, 'running');
  assert.equal(node(s, 'unit:codex').activityCallId, 'c1');
});

test('stop of an agent with a unit call never returned: its calls leave every unit — idle when none is left, else the newest remaining', () => {
  const out = run(initialState(T0), spawn(T0, CODER, 'omelette-coder'), call(T0 + SEC, CODER, 'u1', GROK, 'code_review'));
  const alone = reduce(out, { type: 'stop', at: T0 + MIN, agentId: CODER });
  const grok = node(alone, 'unit:grok');
  assert.equal(grok.status, 'idle');
  for (const k of ['openCalls', 'callerId', 'activity', 'activityCallId']) assert.equal(k in grok, false, k);
  assert.equal(node(alone, CODER).status, 'reported');
  const shared = run(out,
    call(T0 + 2 * SEC, MAIN, 'u2', GROK, 'code_review'),
    call(T0 + 3 * SEC, CODER, 'u3', CODEX, 'research'),
    call(T0 + 4 * SEC, CODER, 'u4', GROK, 'code_review'),
    { type: 'stop', at: T0 + MIN, agentId: CODER });
  const held = node(shared, 'unit:grok');
  assert.equal(held.status, 'running');
  assert.equal(held.callerId, MAIN);
  assert.equal(held.activityCallId, 'u2');
  assert.equal(held.since, T0 + 2 * SEC);
  assert.deepEqual(held.openCalls, [{ callId: 'u2', callerId: MAIN, tool: 'code_review', since: T0 + 2 * SEC }]);
  assert.equal(node(shared, 'unit:codex').status, 'idle');
});

test('tick drops only the open calls older than 2 hours; the late return of a dropped one is foreign', () => {
  let s = run(initialState(T0),
    spawn(T0, CODER, 'omelette-coder'),
    call(T0, MAIN, 'old', GROK, 'code_review'),
    call(T0 + 90 * MIN, CODER, 'new', GROK, 'code_review'),
    { type: 'tick', at: T0 + 2 * HOUR });
  assert.deepEqual(node(s, 'unit:grok').openCalls.map((c) => c.callId), ['old', 'new'], 'exactly 2 hours is not more than 2 hours');
  s = reduce(s, { type: 'tick', at: T0 + 2 * HOUR + 1 });
  const grok = node(s, 'unit:grok');
  assert.equal(grok.status, 'running');
  assert.equal(grok.activityCallId, 'new');
  assert.equal(grok.callerId, CODER);
  assert.deepEqual(grok.openCalls.map((c) => c.callId), ['new']);
  s = reduce(s, { type: 'return', at: T0 + 2 * HOUR + MIN, agentId: MAIN, callId: 'old' });
  assert.equal(node(s, 'unit:grok').status, 'running');
  s = reduce(s, { type: 'tick', at: T0 + 90 * MIN + 2 * HOUR + 1 });
  assert.equal(node(s, 'unit:grok').status, 'idle');
  assert.equal('openCalls' in node(s, 'unit:grok'), false);
});

test('open calls stay pure: call, return, stop and tick on deep-frozen state never write into an earlier openCalls', () => {
  let state = deepFreeze(run(initialState(T0), spawn(T0, CODER, 'omelette-coder')));
  for (const e of [
    call(T0 + SEC, CODER, 'a', GROK, 'code_review'),
    call(T0 + 2 * SEC, MAIN, 'b', GROK, 'code_review'),
    call(T0 + 3 * SEC, MAIN, 'c', GROK, 'code_review'),
    { type: 'return', at: T0 + 4 * SEC, agentId: MAIN, callId: 'c' },
    { type: 'stop', at: T0 + 5 * SEC, agentId: CODER },
    { type: 'tick', at: T0 + 2 * SEC + 2 * HOUR + 1 },
  ]) {
    const copy = JSON.stringify(state);
    const next = reduce(state, deepFreeze(e));
    assert.equal(JSON.stringify(state), copy, `${e.type} changed its input`);
    state = deepFreeze(next);
  }
  assert.equal(node(state, 'unit:grok').status, 'idle');
});

test('a unit call with no call id holds no open call on the unit, but its link and the loop\'s activity are recorded; an open call beside it stays', () => {
  for (const callId of [undefined, '', null]) {
    const s = reduce(initialState(T0), call(T0 + SEC, MAIN, callId, GROK, 'code_review'));
    const grok = node(s, 'unit:grok');
    assert.equal(grok.status, 'idle', String(callId));
    assert.equal('openCalls' in grok, false, String(callId));
    assert.equal(node(s, MAIN).activity, 'code_review');
    assert.deepEqual(s.history, [{ at: T0 + SEC, from: MAIN, to: 'unit:grok', label: 'code_review' }]);
  }
  const s = run(initialState(T0), call(T0, MAIN, 'c1', GROK, 'code_review'), call(T0 + SEC, MAIN, undefined, GROK, 'code_review'));
  assert.deepEqual(node(s, 'unit:grok').openCalls.map((c) => c.callId), ['c1']);
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
  const grokFeed = (at, startedAt) => ({ type: 'feed', at, snapshots: [snap('grok', [entry('grok_code_review', startedAt, 'grok-4.7', 'high')], { updatedAt: startedAt })] });
  const two = run(initialState(T0), call(T0, MAIN, 'old', GROK, 'code_review'), call(T0 + SEC, MAIN, 'new', GROK, 'code_review'), grokFeed(T0 + 2 * SEC, T0 + SEC));
  assert.equal(node(two, 'unit:grok').model, 'grok-4.7');
  const afterReturn = node(reduce(two, { type: 'return', at: T0 + 3 * SEC, agentId: MAIN, callId: 'new' }), 'unit:grok');
  assert.equal(afterReturn.activityCallId, 'old');
  assert.equal('model' in afterReturn, false);
  assert.equal('effort' in afterReturn, false);
  const oldGone = node(reduce(two, { type: 'return', at: T0 + 3 * SEC, agentId: MAIN, callId: 'old' }), 'unit:grok');
  assert.deepEqual([oldGone.activityCallId, oldGone.model, oldGone.effort], ['new', 'grok-4.7', 'high'], 'the call shown did not change');
  const byAgent = run(initialState(T0), spawn(T0, 'ag1', 'omelette-coder'), call(T0, MAIN, 'old', GROK, 'code_review'), call(T0 + SEC, 'ag1', 'new', GROK, 'code_review'), grokFeed(T0 + 2 * SEC, T0 + SEC), { type: 'stop', at: T0 + 3 * SEC, agentId: 'ag1' });
  assert.equal(node(byAgent, 'unit:grok').activityCallId, 'old');
  assert.equal('model' in node(byAgent, 'unit:grok'), false, 'after a stop');
  const byTick = node(reduce(two, { type: 'tick', at: T0 + STALE_MS + 1 }), 'unit:grok');
  assert.deepEqual([byTick.openCalls.map((c) => c.callId), byTick.model], [['new'], 'grok-4.7'], 'a tick that drops only the old call keeps the newest and its model');
});

test('STALE_MS is the one 2-hour bound of the model\'s tick', () => {
  assert.equal(STALE_MS, 2 * HOUR);
  const s = run(initialState(T0), call(T0, MAIN, 'c1', 'Bash', 'Bash: x'));
  assert.equal(node(reduce(s, { type: 'tick', at: T0 + STALE_MS }), MAIN).activity, 'Bash: x');
  assert.equal('activity' in node(reduce(s, { type: 'tick', at: T0 + STALE_MS + 1 }), MAIN), false);
});

test('stop: the agent is reported since the stop, its activity cleared, and links agent → main · report', () => {
  const s = run(initialState(T0),
    spawn(T0, TESTER, 'omelette-tester'),
    call(T0 + MIN, TESTER, 'k1', 'Read', 'Read models.js'),
    { type: 'stop', at: T0 + 4 * MIN, agentId: TESTER });
  assert.equal(node(s, TESTER).status, 'reported');
  assert.equal(node(s, TESTER).since, T0 + 4 * MIN);
  assert.equal('activity' in node(s, TESTER), false);
  assert.equal('activityCallId' in node(s, TESTER), false);
  assert.deepEqual(s.history.at(-1), { at: T0 + 4 * MIN, from: TESTER, to: 'main', label: 'report' });
});

test('a nested spawn hangs under the agent that spawned it, and its report link goes back to that agent', () => {
  const s = run(initialState(T0),
    spawn(T0, CODER, 'omelette-coder'),
    spawn(T0 + MIN, HELPER, 'Explore', { parentId: CODER, model: 'claude-haiku-5-5' }),
    { type: 'stop', at: T0 + 2 * MIN, agentId: HELPER });
  assert.equal(node(s, HELPER).parentId, CODER);
  assert.deepEqual(s.history, [
    { at: T0, from: 'main', to: CODER, label: 'Agent' },
    { at: T0 + MIN, from: CODER, to: HELPER, label: 'Agent' },
    { at: T0 + 2 * MIN, from: HELPER, to: CODER, label: 'report' },
  ]);
});

test('stop of an agent the model does not know returns the state as given', () => {
  const s = initialState(T0);
  assert.equal(reduce(s, { type: 'stop', at: T0, agentId: 'ffff0000' }), s);
  assert.equal(reduce(s, { type: 'stop', at: T0, agentId: MAIN }), s, 'the main loop never reports');
});

test('agents (Review Focus 1): agents the model never saw spawn appear with role, parent and status, without model or effort until their next step', () => {
  let s = reduce(initialState(T0), {
    type: 'agents', at: T0 + MIN, list: [
      { id: CODER, type: 'omelette-coder-medium', status: 'running' },
      { id: TESTER, type: 'omelette-tester', status: 'idle' },
      { id: HELPER, type: 'Explore', status: 'running', parentId: CODER },
    ],
  });
  assert.deepEqual(node(s, CODER), { id: CODER, kind: 'agent', role: 'omelette-coder-medium', parentId: 'main', status: 'running', since: T0 + MIN, order: 4 });
  assert.deepEqual(node(s, TESTER), { id: TESTER, kind: 'agent', role: 'omelette-tester', parentId: 'main', status: 'waiting', since: T0 + MIN, order: 5 });
  assert.equal(node(s, HELPER).parentId, CODER);
  assert.equal(node(s, HELPER).status, 'running');
  assert.deepEqual(s.history, [], 'a listed agent is not a spawn the session saw');
  s = run(s,
    { type: 'step', at: T0 + 2 * MIN, agentId: CODER, model: 'claude-opus-5-5', effort: 'medium' },
    call(T0 + 2 * MIN, CODER, 'k1', 'Edit', 'Edit adapter.mjs'));
  assert.equal(node(s, CODER).model, 'claude-opus-5-5');
  assert.equal(node(s, CODER).effort, 'medium');
  assert.equal(node(s, CODER).activity, 'Edit adapter.mjs');
  s = reduce(s, { type: 'stop', at: T0 + 3 * MIN, agentId: HELPER });
  assert.deepEqual(s.history.at(-1), { at: T0 + 3 * MIN, from: HELPER, to: CODER, label: 'report' }, 'a listed agent reports to its listed parent');
});

test('agents: a known agent takes the engine\'s status, except that a reported one stays reported while the engine says idle', () => {
  let s = run(initialState(T0),
    spawn(T0, CODER, 'omelette-coder'),
    spawn(T0, TESTER, 'omelette-tester'),
    { type: 'stop', at: T0 + MIN, agentId: TESTER });
  s = reduce(s, { type: 'agents', at: T0 + 2 * MIN, list: [
    { id: CODER, type: 'omelette-coder', status: 'idle' },
    { id: TESTER, type: 'omelette-tester', status: 'idle' },
  ] });
  assert.equal(node(s, CODER).status, 'waiting');
  assert.equal(node(s, CODER).since, T0 + 2 * MIN, 'a status change restarts its duration');
  assert.equal(node(s, TESTER).status, 'reported');
  assert.equal(node(s, TESTER).since, T0 + MIN, 'still the time of its stop');
  s = reduce(s, { type: 'agents', at: T0 + 3 * MIN, list: [
    { id: CODER, type: 'omelette-coder', status: 'running' },
    { id: TESTER, type: 'omelette-tester', status: 'running' },
  ] });
  assert.equal(node(s, CODER).status, 'running');
  assert.equal(node(s, TESTER).status, 'running', 'resumed');
  assert.equal(s.nodes.length, 6, 'nothing added');
  const again = reduce(s, { type: 'agents', at: T0 + 9 * MIN, list: [{ id: CODER, type: 'omelette-coder', status: 'running' }] });
  assert.deepEqual(node(again, CODER), node(s, CODER), 'an unchanged status keeps its since');
});

test('agents: the orchestrator\'s or a unit\'s id in the list stays what it is, and malformed entries are skipped', () => {
  const s = reduce(initialState(T0), { type: 'agents', at: T0, list: [{ id: 'main', type: 'x', status: 'completed' }, { id: 'unit:grok', type: 'x', status: 'running' }, null, {}, { id: '', type: 'x', status: 'running' }, { id: 'ok', type: 'x', status: 'running' }] });
  assert.deepEqual([node(s, MAIN).status, node(s, 'unit:grok').status, node(s, 'unit:grok').kind], ['idle', 'idle', 'unit']);
  assert.deepEqual(s.nodes.map((n) => n.id), ['main', 'unit:gemini', 'unit:grok', 'unit:codex', 'ok']);
});

test('agents: an ended agent (completed, failed, killed) reads as reported; one the engine holds reads as waiting; one not yet started reads as running', () => {
  const s = reduce(initialState(T0), { type: 'agents', at: T0, list: [
    { id: 'e1', type: 'Explore', status: 'completed' },
    { id: 'e2', type: 'Explore', status: 'failed' },
    { id: 'e3', type: 'Explore', status: 'killed' },
    { id: 'e4', type: 'Explore', status: 'waiting' },
    { id: 'e5', type: 'Explore', status: 'pending' },
  ] });
  assert.deepEqual(['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => node(s, id).status), ['reported', 'reported', 'reported', 'waiting', 'running']);
});

test('feed: a unit with a snapshot has a feed; this session\'s running call gets model, effort and start time; lastEndedAt comes from lastEvent; a unit with none keeps no feed', () => {
  const s = run(initialState(T0),
    call(T0 + MIN, MAIN, 'u1', 'mcp__orion-grok__grok_code_review', 'code_review'),
    { type: 'feed', at: T0 + MIN + 2 * SEC, snapshots: [
      { unit: 'grok', pid: 4242, active: [{ id: '4242-3', tool: 'grok_code_review', model: 'grok-4.7', effort: 'high', startedAt: T0 + MIN - 300 }], updatedAt: T0 + MIN, lastEndedAt: T0 - 5 * MIN, isStale: false },
      { unit: 'codex', pid: 5151, active: [], updatedAt: T0 - 12 * MIN, lastEndedAt: T0 - 12 * MIN, isStale: false },
    ] });
  assert.deepEqual(node(s, 'unit:grok'), {
    id: 'unit:grok', kind: 'unit', role: 'grok', status: 'running', since: T0 + MIN - 300, feed: 'ok', order: 2,
    callerId: 'main', activity: 'code_review', activityCallId: 'u1', model: 'grok-4.7', effort: 'high', lastEndedAt: T0 - 5 * MIN,
    openCalls: [{ callId: 'u1', callerId: 'main', tool: 'code_review', since: T0 + MIN }],
  });
  assert.equal(node(s, 'unit:codex').feed, 'ok');
  assert.equal(node(s, 'unit:codex').status, 'idle');
  assert.equal(node(s, 'unit:codex').lastEndedAt, T0 - 12 * MIN);
  assert.equal(node(s, 'unit:gemini').feed, 'none');
  // The call still returns by its own id.
  const done = reduce(s, { type: 'return', at: T0 + 3 * MIN, agentId: MAIN, callId: 'u1' });
  assert.equal(node(done, 'unit:grok').status, 'idle');
  assert.equal(node(done, 'unit:grok').lastEndedAt, T0 + 3 * MIN);
});

test('feed: a call in active[] that this session did not make marks the unit running for another session, and its end returns the unit to idle', () => {
  let s = reduce(initialState(T0), { type: 'feed', at: T0 + MIN, snapshots: [
    { unit: 'codex', pid: 6161, active: [{ id: '6161-1', tool: 'codex_research', model: 'gpt-6.1-sol', effort: null, startedAt: T0 + 30 * SEC }], updatedAt: T0 + 30 * SEC, isStale: false },
  ] });
  assert.deepEqual(node(s, 'unit:codex'), {
    id: 'unit:codex', kind: 'unit', role: 'codex', status: 'running', since: T0 + 30 * SEC, feed: 'ok', order: 3,
    callerId: 'other', activity: 'research', model: 'gpt-6.1-sol',
  });
  assert.deepEqual(s.history, [], 'another session\'s call is not this session\'s link');
  s = reduce(s, { type: 'feed', at: T0 + 2 * MIN, snapshots: [
    { unit: 'codex', pid: 6161, active: [], updatedAt: T0 + 90 * SEC, lastEndedAt: T0 + 90 * SEC, isStale: false },
  ] });
  assert.equal(node(s, 'unit:codex').status, 'idle');
  assert.equal('callerId' in node(s, 'unit:codex'), false);
  assert.equal('activity' in node(s, 'unit:codex'), false);
  assert.equal(node(s, 'unit:codex').lastEndedAt, T0 + 90 * SEC);
});

test('feed (Review Focus 2): a snapshot that is not JSON, is schema 1 or names an unknown unit leaves no feed; a call 40 minutes without an update still runs, one past 2 hours reads as idle', () => {
  const now = T0 + 3 * HOUR;
  const texts = [
    'not json {',
    JSON.stringify({ schema: 1, unit: 'gemini', active: [], updatedAt: new Date(now).toISOString() }),
    JSON.stringify({ schema: 2, unit: 'claude', pid: 1, active: [], updatedAt: new Date(now).toISOString() }),
    JSON.stringify({ schema: 2, unit: 'grok', pid: 88, active: [{ id: '88-1', tool: 'grok_research', model: 'grok-4.7', effort: null, startedAt: new Date(now - 2 * HOUR - 2 * MIN).toISOString() }], lastEvent: null, updatedAt: new Date(now - 2 * HOUR - MIN).toISOString() }),
    // The feed is written on events only: a call 40 minutes in has not touched its snapshot since it started.
    JSON.stringify({ schema: 2, unit: 'codex', pid: 99, active: [{ id: '99-1', tool: 'codex_research', model: 'gpt-6.1-sol', effort: null, startedAt: new Date(now - 40 * MIN).toISOString() }], lastEvent: null, updatedAt: new Date(now - 40 * MIN).toISOString() }),
  ];
  const snapshots = texts.map((t) => parseSnapshot(t, now)).filter(Boolean);
  const s = reduce(initialState(T0), { type: 'feed', at: now, snapshots });
  assert.equal(snapshots.length, 2, 'the broken three parse to null');
  assert.equal(node(s, 'unit:gemini').feed, 'none');
  assert.equal(node(s, 'unit:grok').feed, 'ok');
  assert.equal(node(s, 'unit:grok').status, 'idle');
  assert.equal(node(s, 'unit:codex').feed, 'ok');
  assert.equal(node(s, 'unit:codex').status, 'running');
  assert.equal(node(s, 'unit:codex').activity, 'research');
});

test('feed: a unit whose snapshot is gone loses its feed, and another session\'s call on it ends', () => {
  let s = reduce(initialState(T0), { type: 'feed', at: T0, snapshots: [
    { unit: 'gemini', pid: 9, active: [{ id: '9-1', tool: 'gemini_research', model: null, effort: null, startedAt: T0 }], updatedAt: T0, isStale: false },
  ] });
  assert.equal(node(s, 'unit:gemini').status, 'running');
  assert.equal('model' in node(s, 'unit:gemini'), false, 'a vendor default model (null) is no model');
  s = reduce(s, { type: 'feed', at: T0 + 2 * SEC, snapshots: [] });
  assert.equal(node(s, 'unit:gemini').feed, 'none');
  assert.equal(node(s, 'unit:gemini').status, 'idle');
  // A snapshot of a unit the model does not have, or no snapshots field at all, adds nothing.
  assert.equal(reduce(s, { type: 'feed', at: T0, snapshots: [{ unit: 'jaravis', pid: 1, active: [], updatedAt: T0, isStale: false }] }).nodes.length, 4);
  assert.equal(reduce(s, { type: 'feed', at: T0 }).nodes.length, 4);
});

const snap = (unit, active = [], extra = {}) => ({ unit, pid: 4242, active, updatedAt: T0, isStale: false, ...extra });
const entry = (tool, startedAt, model = 'm-1', effort = 'high') => ({ id: '4242-1', tool, model, effort, startedAt });

test('feed: this session\'s call takes model, effort and since from the same-tool entry that started nearest to it', () => {
  const s0 = reduce(initialState(T0), call(T0 + 10 * SEC, MAIN, 'c1', GROK, 'code_review'));
  const s = reduce(s0, { type: 'feed', at: T0 + 12 * SEC, snapshots: [snap('grok', [
    entry('grok_code_review', T0 - 5 * MIN, 'far-model', 'low'),
    entry('grok_code_review', T0 + 9 * SEC, 'near-model', 'high'),
    entry('grok_research', T0 + 10 * SEC, 'other-tool-model', 'max'),
  ])] });
  assert.deepEqual([node(s, 'unit:grok').model, node(s, 'unit:grok').effort, node(s, 'unit:grok').since, node(s, 'unit:grok').callerId], ['near-model', 'high', T0 + 9 * SEC, MAIN]);
});

test('feed: another session\'s call shows from the newest entry; several snapshots of one unit (two processes) are one union', () => {
  const s = reduce(initialState(T0), { type: 'feed', at: T0 + MIN, snapshots: [snap('grok', [entry('grok_research', T0 + 10 * SEC, 'g-old', 'low'), entry('grok_code_review', T0 + 40 * SEC, 'g-new', 'high')])] });
  assert.deepEqual([node(s, 'unit:grok').callerId, node(s, 'unit:grok').activity, node(s, 'unit:grok').model, node(s, 'unit:grok').since], ['other', 'code_review', 'g-new', T0 + 40 * SEC]);
  const two = reduce(initialState(T0), { type: 'feed', at: T0 + MIN, snapshots: [
    snap('grok', [entry('grok_research', T0 + 10 * SEC, 'a', 'low')], { pid: 1, lastEndedAt: T0 - MIN }),
    snap('grok', [entry('grok_code_review', T0 + 30 * SEC, 'b', 'high')], { pid: 2, lastEndedAt: T0 - 10 * SEC }),
  ] });
  assert.deepEqual([node(two, 'unit:grok').activity, node(two, 'unit:grok').model, node(two, 'unit:grok').lastEndedAt], ['code_review', 'b', T0 - 10 * SEC]);
});

test('feed: lastEndedAt is the newer of the model\'s and the feed\'s, whichever side gives it', () => {
  const ended = run(initialState(T0), call(T0, MAIN, 'c1', GROK, 'code_review'), { type: 'return', at: T0 + 60 * SEC, agentId: MAIN, callId: 'c1' });
  assert.equal(node(reduce(ended, { type: 'feed', at: T0 + 70 * SEC, snapshots: [snap('grok', [], { lastEndedAt: T0 + 30 * SEC })] }), 'unit:grok').lastEndedAt, T0 + 60 * SEC);
  assert.equal(node(reduce(ended, { type: 'feed', at: T0 + 200 * SEC, snapshots: [snap('grok', [], { lastEndedAt: T0 + 150 * SEC })] }), 'unit:grok').lastEndedAt, T0 + 150 * SEC);
  const fresh = reduce(initialState(T0), { type: 'feed', at: T0, snapshots: [snap('codex', [], { lastEndedAt: T0 - MIN })] });
  assert.equal(node(reduce(fresh, { type: 'feed', at: T0 + SEC, snapshots: [snap('codex', [], { lastEndedAt: T0 - 2 * MIN })] }), 'unit:codex').lastEndedAt, T0 - MIN);
});

test('usage: replaces the usage figures', () => {
  let s = reduce(initialState(T0), { type: 'usage', at: T0, usage: { contextPercent: 31, fiveHour: 11, sevenDay: 71, costUsd: 646 } });
  assert.deepEqual(s.usage, { contextPercent: 31, fiveHour: 11, sevenDay: 71, costUsd: 646 });
  s = reduce(s, { type: 'usage', at: T0 + MIN, usage: { contextPercent: 33 } });
  assert.deepEqual(s.usage, { contextPercent: 33 });
});

test('tick: sets now, and clears an activity older than 2 hours — a unit back to idle, an agent keeping its status', () => {
  const start = run(initialState(T0),
    spawn(T0, CODER, 'omelette-coder'),
    call(T0, CODER, 'k1', 'Bash', 'Bash: npm test'),
    call(T0, MAIN, 'u1', 'mcp__orion-codex__codex_code_review', 'code_review'),
    call(T0 + 100 * MIN, MAIN, 'k2', 'Read', 'Read plan.md'));
  const atBound = reduce(start, { type: 'tick', at: T0 + 2 * HOUR });
  assert.equal(atBound.now, T0 + 2 * HOUR);
  assert.equal(node(atBound, CODER).activity, 'Bash: npm test', 'exactly 2 hours is not more than 2 hours');
  assert.equal(node(atBound, 'unit:codex').status, 'running');
  const later = reduce(start, { type: 'tick', at: T0 + 2 * HOUR + 1 });
  assert.equal('activity' in node(later, CODER), false);
  assert.equal('activityCallId' in node(later, CODER), false);
  assert.equal(node(later, CODER).status, 'running');
  assert.equal(node(later, 'unit:codex').status, 'idle');
  assert.equal('activity' in node(later, 'unit:codex'), false);
  assert.equal('callerId' in node(later, 'unit:codex'), false);
  assert.equal(node(later, MAIN).activity, 'Read plan.md', 'a call twenty minutes old stays');
});

test('a tool call that never returns (Review Focus 5): the loop\'s next call shows over it, its stop clears it, a tick clears one older than 2 hours', () => {
  const lost = run(initialState(T0), spawn(T0, CODER, 'omelette-coder'), call(T0 + MIN, CODER, 'k1', 'Bash', 'Bash: npm test'));
  const replaced = reduce(lost, call(T0 + 2 * MIN, CODER, 'k2', 'Read', 'Read a.mjs'));
  assert.equal(node(replaced, CODER).activity, 'Read a.mjs');
  const late = node(reduce(replaced, { type: 'return', at: T0 + 3 * MIN, agentId: CODER, callId: 'k1' }), CODER);
  assert.deepEqual([late.activity, late.activityCallId], ['Read a.mjs', 'k2'], 'the lost call\'s late return leaves the newer call shown');
  const stopped = reduce(lost, { type: 'stop', at: T0 + 2 * MIN, agentId: CODER });
  assert.equal('activity' in node(stopped, CODER), false);
  const main = run(initialState(T0), call(T0, MAIN, 'k9', 'Bash', 'Bash: sleep 9999'), { type: 'tick', at: T0 + 2 * HOUR + MIN });
  assert.equal('activity' in node(main, MAIN), false);
  const deep = run(initialState(T0), call(T0, MAIN, 'u9', 'mcp__orion-gemini__gemini_deep_research', 'deep_research'), { type: 'tick', at: T0 + 40 * MIN });
  assert.equal(node(deep, 'unit:gemini').status, 'running', 'a 40-minute deep research is a live call');
});

test('open and close set isOpen', () => {
  const opened = reduce(initialState(T0), { type: 'open', at: T0 });
  assert.equal(opened.isOpen, true);
  assert.equal(reduce(opened, { type: 'close', at: T0 }).isOpen, false);
});

test('an unknown event type returns the state as given', () => {
  const s = initialState(T0);
  for (const e of [{ type: 'compact', at: T0 }, { type: 'toString', at: T0 }, { at: T0 }, null, undefined]) assert.equal(reduce(s, e), s, JSON.stringify(e));
});

test('reduce never mutates its input: every event type on deep-frozen state and events', () => {
  const events = [
    { type: 'open', at: T0 },
    spawn(T0, CODER, 'omelette-coder-medium', { model: 'claude-opus-5-5' }),
    spawn(T0 + SEC, HELPER, 'Explore', { parentId: CODER }),
    { type: 'step', at: T0 + SEC, agentId: CODER, model: 'claude-opus-5-5', effort: 'medium' },
    call(T0 + 2 * SEC, CODER, 'u1', 'mcp__orion-grok__grok_code_review', 'code_review'),
    call(T0 + 2 * SEC, MAIN, 'm1', 'SendMessage', 'SendMessage', { target: CODER }),
    { type: 'feed', at: T0 + 3 * SEC, snapshots: [
      { unit: 'grok', pid: 1, active: [{ id: '1-1', tool: 'grok_code_review', model: 'grok-4.7', effort: 'high', startedAt: T0 + 2 * SEC }], updatedAt: T0 + 2 * SEC, lastEndedAt: T0 - MIN, isStale: false },
      { unit: 'codex', pid: 2, active: [{ id: '2-1', tool: 'codex_research', model: 'gpt-6.1-sol', effort: 'xhigh', startedAt: T0 }], updatedAt: T0, isStale: false },
    ] },
    { type: 'return', at: T0 + 4 * SEC, agentId: CODER, callId: 'u1' },
    { type: 'agents', at: T0 + 5 * SEC, list: [{ id: CODER, type: 'omelette-coder-medium', status: 'idle' }, { id: TESTER, type: 'omelette-tester', status: 'running' }] },
    { type: 'stop', at: T0 + 6 * SEC, agentId: HELPER },
    { type: 'usage', at: T0 + 6 * SEC, usage: { contextPercent: 40 } },
    { type: 'tick', at: T0 + 3 * HOUR },
    { type: 'close', at: T0 + 3 * HOUR },
  ];
  let state = deepFreeze(initialState(T0));
  for (const e of events) {
    const copy = JSON.stringify(state);
    const next = reduce(state, deepFreeze(e));
    assert.equal(JSON.stringify(state), copy, `${e.type} changed its input`);
    assert.notEqual(next, state, `${e.type} returned its input`);
    state = deepFreeze(next);
  }
});

test('history keeps the newest 200 links, newest last', () => {
  const sends = Array.from({ length: 250 }, (_, i) => call(T0 + i, MAIN, `m${i}`, 'SendMessage', 'SendMessage', { target: `peer-${i}` }));
  const s = run(initialState(T0), ...sends);
  assert.equal(s.history.length, 200);
  assert.equal(s.history[0].to, 'peer-50');
  assert.equal(s.history.at(-1).to, 'peer-249');
});

test('settle also ends the loop\'s own unit calls that never returned; another caller\'s call stays', () => {
  const T = Date.UTC(2026, 9, 8, 12);
  let s = initialState(T);
  s = reduce(s, { type: 'spawn', at: T, agentId: 'a1', role: 'omelette-coder', parentId: 'main', model: 'claude-opus-5-5' });
  s = reduce(s, { type: 'call', at: T + 1, agentId: 'a1', callId: 'g1', tool: 'mcp__orion-grok__grok_code_review', subject: 'code_review' });
  s = reduce(s, { type: 'call', at: T + 2, agentId: 'main', callId: 'g2', tool: 'mcp__orion-grok__grok_code_review', subject: 'code_review' });
  s = reduce(s, { type: 'settle', at: T + 3, agentId: 'a1' });
  const grok = s.nodes.find((n) => n.id === 'unit:grok');
  assert.deepEqual(grok.openCalls.map((c) => c.callId), ['g2']);
  assert.equal(grok.callerId, 'main');
});
