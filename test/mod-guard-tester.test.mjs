/**
 * omelette-fleet :: test/mod-guard-tester.test.mjs
 * tester 1.8.0 Task 7: the mod's guard delivery at the edges the first file
 * leaves: guard.mjs against a fake `$` (the script lookup, the exit rule, a
 * failing run), and the model's `refused` event beside a new call and a day's end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_NODE, NO_SCRIPT, askGuard, denyText, findGuardScript, touchedLine } from '../mods/omelette-fleet/hooks/guard.mjs';
import { initialState, reduce } from '../mods/omelette-fleet/hooks/model.mjs';

/** A `$` with the files that exist, the environment, and what a run answers (a function, so a test can throw). */
function fake({ exists = [], env = {}, run = () => ({ exitCode: 0, stdout: '', stderr: '' }) } = {}) {
  const logs = [];
  const runs = [];
  return {
    logs,
    runs,
    $: {
      env: { get: async (name) => env[name] },
      fs: { exists: async (path) => exists.includes(path) },
      ui: { log: (text) => logs.push(text) },
      process: { run: async (argv, init) => { runs.push({ argv, init }); return run(argv, init); } },
    },
  };
}

const SCRIPT = '/p/.claude/hooks/omelette-guard.mjs';
const HOME_SCRIPT = '/h/.claude/hooks/omelette-guard.mjs';

test('the script lookup: the project first, then HOME; a relative or missing cwd is skipped; none says so once', async () => {
  const both = fake({ exists: [SCRIPT, HOME_SCRIPT], env: { HOME: '/h' } });
  assert.equal(await findGuardScript(both.$, '/p'), SCRIPT);
  assert.equal(await findGuardScript(both.$, '/p/'), SCRIPT, 'a trailing slash does not double');

  const homeOnly = fake({ exists: [HOME_SCRIPT], env: { HOME: '/h' } });
  assert.equal(await findGuardScript(homeOnly.$, '/p'), HOME_SCRIPT);
  assert.equal(await findGuardScript(homeOnly.$, undefined), HOME_SCRIPT, 'no cwd: HOME still answers');
  assert.equal(await findGuardScript(homeOnly.$, 'work'), HOME_SCRIPT, 'a relative cwd is never looked up');

  const none = fake({ env: { HOME: 'relative-home' } });
  assert.equal(await findGuardScript(none.$, '/p'), undefined);
  assert.equal(await findGuardScript(none.$, '/p'), undefined);
  assert.deepEqual(none.logs, [NO_SCRIPT]);
});

test('askGuard: exit 2 denies with the trimmed stderr, stdout and the other exits never do, a failed run lets the call go', async () => {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } };
  const ask = (run) => askGuard(fake({ exists: ['/n/node'], env: { PATH: '/n' }, run }).$, SCRIPT, event);

  assert.deepEqual(await ask(() => ({ exitCode: 2, stdout: 'OUT', stderr: ' no \n' })), { deny: 'no' });
  const unsaid = await ask(() => ({ exitCode: 2, stdout: 'OUT', stderr: '' }));
  assert.equal(typeof unsaid.deny, 'string');
  assert.ok(unsaid.deny.length > 0 && !unsaid.deny.includes('OUT'));
  for (const exitCode of [0, 1, 3, 126, 127]) assert.deepEqual(await ask(() => ({ exitCode, stdout: '', stderr: 'x' })), {}, `exit ${exitCode}`);
  assert.deepEqual(await ask(() => { throw new Error('timed out'); }), {});
});

test('askGuard: an event JSON cannot hold (a cycle, a BigInt) lets the call go and does not throw', async () => {
  const cyclic = { tool_input: {} };
  cyclic.tool_input.self = cyclic;
  for (const event of [cyclic, { tool_input: { n: 1n } }]) {
    const { $, runs, logs } = fake({ exists: ['/n/node'], env: { PATH: '/n' } });
    assert.deepEqual(await askGuard($, SCRIPT, event), {});
    assert.deepEqual(runs, [], 'nothing to run');
    assert.deepEqual(logs, [], 'node is on PATH: nothing to say');
  }
});

test('askGuard: the child gets node by name, the script, the event on stdin, a 2 s clock and the absolute PATH entries only', async () => {
  const { $, runs } = fake({ exists: ['/n/node'], env: { PATH: 'rel/bin:/n:./x::/m/' } });
  await askGuard($, SCRIPT, { tool_name: 'Edit' });
  assert.deepEqual(runs[0].argv, ['node', SCRIPT]);
  assert.equal(runs[0].init.stdin, '{"tool_name":"Edit"}');
  assert.equal(runs[0].init.timeoutMs, 2000);
  assert.deepEqual(runs[0].init.env, { PATH: '/n:/m/' });
});

test('askGuard: a failed run with node on PATH says nothing; with none, the notice once', async () => {
  const failing = () => { throw new Error('boom'); };
  const present = fake({ exists: ['/n/node'], env: { PATH: '/n' }, run: failing });
  await askGuard(present.$, SCRIPT, {});
  assert.deepEqual(present.logs, []);

  const absent = fake({ env: { PATH: '/n:/usr/bin' }, run: failing });
  await askGuard(absent.$, SCRIPT, {});
  await askGuard(absent.$, SCRIPT, {});
  assert.deepEqual(absent.logs.filter((line) => line === NO_NODE), [NO_NODE]);
});

test('touchedLine: no listed path reads 0 files; only lines that start with "- " count', () => {
  assert.equal(touchedLine('r.md', '# touched\n\ntool calls: 0\n'), 'touched: r.md — 0 files');
  assert.equal(touchedLine('r.md', '# t\n- a\n  - indented\nx - y\n-b\n- c\n'), 'touched: r.md — 2 files');
});

const T0 = Date.UTC(2026, 10, 3, 23, 59, 59);
const nodeOf = (state, id) => state.nodes.find((n) => n.id === id);
const coder = () => reduce(initialState(T0), { type: 'spawn', at: T0, agentId: 'c1', role: 'omelette-coder' });

test('the day of the counts turns at UTC midnight: 23:59:59 and 00:00:01 count apart; an agent the pane never saw still counts', () => {
  const state = [
    { type: 'refused', at: Date.UTC(2026, 10, 3, 23, 59, 59), agentId: 'c1', by: 'mod' },
    { type: 'refused', at: Date.UTC(2026, 10, 3, 23, 59, 59), agentId: 'ghost', by: 'mod' },
  ].reduce(reduce, coder());
  assert.deepEqual(state.counts, { day: '2026-11-03', refusals: { mod: 2 } });
  assert.deepEqual(reduce(state, { type: 'refused', at: Date.UTC(2026, 10, 4, 0, 0, 1), agentId: 'c1', by: 'mod' }).counts, { day: '2026-11-04', refusals: { mod: 1 } });
  assert.equal(nodeOf(state, 'ghost'), undefined, 'no row is made for it');
});

test('a call after a refusal takes the row and clears the refusal; the tick that follows leaves the call showing', () => {
  const refused = reduce(coder(), { type: 'refused', at: T0 + 10, agentId: 'c1', callId: 'b1', by: 'mod' });
  assert.equal(nodeOf(refused, 'c1').activity, 'refused');

  const called = reduce(refused, { type: 'call', at: T0 + 20, agentId: 'c1', callId: 'b2', tool: 'Bash', subject: 'Bash: npm test' });
  assert.equal(nodeOf(called, 'c1').activity, 'Bash: npm test');
  assert.equal(nodeOf(called, 'c1').refusedAt, undefined);

  const ticked = reduce(reduce(called, { type: 'tick', at: T0 + 30 }), { type: 'tick', at: T0 + 1030 });
  assert.equal(nodeOf(ticked, 'c1').activity, 'Bash: npm test');
});

test('a refusal on an idle loop: the tick after the one that drew it leaves no activity, not `refused`', () => {
  const refused = reduce(reduce(coder(), { type: 'tick', at: T0 + 5 }), { type: 'refused', at: T0 + 10, agentId: 'c1', by: 'mod' });
  const gone = [{ type: 'tick', at: T0 + 1010 }, { type: 'tick', at: T0 + 2010 }].reduce(reduce, refused);
  assert.equal(nodeOf(gone, 'c1').activity, undefined);
  assert.equal(nodeOf(gone, 'c1').refusedAt, undefined);
});

test('denyText: no ESC survives a bare, truncated or unterminated escape, and an unterminated OSC takes only the rest of the text', () => {
  for (const stderr of ['a\x1bb', 'a\x1b', 'a\x1b[31', 'a\x1b[', '\x1b\x1b[31m', 'a\x1b]0;title and more', 'a\x1b(Bb', 'a\x1bPq\x1b\\b', '\x1b[3\x1b[1m1m']) {
    assert.equal(denyText(stderr).includes('\x1b'), false, JSON.stringify(stderr));
  }
  assert.equal(denyText('refused: no commit\x1b[0m'), 'refused: no commit');
});

test('denyText: no C1 control introducer (U+009B CSI) survives, alone or at the end of the text', () => {
  for (const stderr of ['a\x9b', 'a\x9b\nb', 'a\x9b\u00e9', '\x9b\x9b31m']) {
    assert.equal(denyText(stderr).includes('\x9b'), false, JSON.stringify(stderr));
  }
});
