/**
 * omelette-fleet :: test/tester-0.3.3-p1.test.mjs
 *
 * Independent coverage for 0.3.3 package P1 (spec sections 1a, 1b, 3):
 * progress notifications, the JSON-RPC request lifecycle (in-flight table,
 * cancellation, drain) and the runtime's cancel policy (finish|kill), tested
 * as a WHOLE STACK — core/jsonrpc.mjs's createHandler wired to a real
 * core/unit.mjs runtime with a fake vendor "CLI" (node -e / a written
 * script), the way the units are wired in production. The implementer's own
 * tests are strong at the unit level (jsonrpc.test.mjs with a fake callTool,
 * unit.test.mjs with a hand-rolled `call` context); this file's job is the
 * seam between them, plus a few edges the spec calls out explicitly:
 *   - a cancel arriving before a spawn starts (not mid-flight);
 *   - two concurrent requests, one cancelled, the other answered — with real
 *     child processes, not just held promises;
 *   - `finish` mode: response dropped AND the real child left running AND the
 *     in-flight table only clears when the child actually finishes;
 *   - `kill` mode: response dropped AND a grandchild process is reaped;
 *   - progress notifications assembled by the REAL ticker, through the REAL
 *     call.notify wrapper, checked for JSON-RPC shape and increasing elapsed
 *     seconds.
 *
 * Never edits core/*.mjs; only adds coverage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from '../core/jsonrpc.mjs';
import { defineUnit, createUnitRuntime } from '../core/unit.mjs';
import { makeCatalog } from '../core/catalog.mjs';

const node = process.execPath;
const catalog = makeCatalog({
  models: [{ id: 'm-fast', useFor: 'speed', avoid: 'depth' }],
  efforts: ['low', 'high'],
  guide: 'pick by task',
  title: 'TESTER CATALOG',
});

/** Same shape as unit.test.mjs's env() helper: an isolated OMELETTE_HOME per test. */
function env(config, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-p1tester-'));
  if (config) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(config));
  return { dir, env: { ...process.env, OMELETTE_HOME: dir, ...extra } };
}

/**
 * A unit whose "CLI" is node itself, with tools built for cancellation and
 * progress scenarios: a delayed writer (proves a `finish`-mode child really
 * keeps running), a grandchild-spawning script (proves `kill` reaps the
 * whole group through the real stack), a parametrisable echo-after-delay
 * (for the two-concurrent-requests case), and a plain in-process waiter (for
 * progress).
 */
function fakeUnit(overrides = {}) {
  return defineUnit({
    name: 'p1fake',
    label: 'P1Fake',
    bin: { env: 'P1FAKE_BIN', default: node },
    tools: [
      {
        // Spawns a child that writes `marker` after `ms`. Under `finish` the
        // client's cancel must not stop this child: the marker either exists
        // (child ran to completion) or does not (child was killed).
        name: 'p1_delay', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run(args, ctx) {
          const r = await ctx.spawn({
            args: ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(args.marker)}, 'done'), ${Number(args.ms) || 300})`],
          });
          return `killed=${r.killed};cancelled=${r.cancelled}`;
        },
      },
      {
        // Spawns a PARENT that itself spawns a detached GRANDCHILD which
        // writes `marker` well after the parent's own natural exit. Only a
        // whole-process-GROUP kill stops the grandchild — a kill of the
        // parent handle alone would not.
        name: 'p1_grandchild', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run(args, ctx) {
          const r = await ctx.spawn({ args: [args.script] });
          return `killed=${r.killed};cancelled=${r.cancelled}`;
        },
      },
      {
        // Writes `text` to stdout after `ms` — used to prove two concurrent
        // real spawns do not cross-contaminate when only one is cancelled.
        name: 'p1_echo', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run(args, ctx) {
          const r = await ctx.spawn({
            args: ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(String(args.text))}), ${Number(args.ms) || 200})`],
          });
          return r.stdout || `killed=${r.killed}`;
        },
      },
      {
        // A pure in-process wait: no child noise, just something the
        // progress ticker has time to tick against.
        name: 'p1_wait', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run(args) { await new Promise((r) => setTimeout(r, Number(args.ms) || 50)); return 'waited'; },
      },
      {
        // Calls ctx.retry() the way a real adapter does (see units/gemini,
        // codex, grok: `ctx.retry(() => run(...), { skipIf })`) — proving the
        // RUNTIME'S wiring of the kill signal into ctx.retry, not just
        // boundedRetry called directly with a hand-built signal.
        name: 'p1_retry', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
        async run(args, ctx) {
          let n = 0;
          try {
            await ctx.retry(async () => { n++; return n === 1 ? '' : 'second'; }, { delayMs: Number(args.delayMs) || 5000 });
            return `n=${n};resolved`;
          } catch (e) {
            return `n=${n};rejected:${(e && e.message) || e}`;
          }
        },
      },
    ],
    catalog,
    ...overrides,
  });
}

/** Writes the grandchild-spawning parent script used by p1_grandchild; returns its path and the marker path. */
function grandchildFixture(dir, { markerDelayMs = 1200, parentExitMs = 300 } = {}) {
  const marker = join(dir, 'grandchild-marker');
  const script = join(dir, 'gc-parent.mjs');
  const inner = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), ${markerDelayMs})`;
  writeFileSync(script, [
    'import { spawn } from "node:child_process";',
    `spawn(process.execPath, ["-e", ${JSON.stringify(inner)}], { stdio: "ignore" });`,
    `setTimeout(() => process.exit(0), ${parentExitMs});`,
  ].join('\n'));
  return { script, marker };
}

const tick = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1b. progress, through the real ticker and the real notify wrapper -----

test('progress: the real ticker, through the real call.notify wrapper, produces valid JSON-RPC notifications with increasing elapsed seconds, and stops once the response is out', async () => {
  const { env: e } = env(null);
  // `progress` is Math.round(elapsedMs / 1000): ticks close together within
  // the same rounded second would not visibly grow, so this spaces them out
  // (200ms apart, over 900ms) to reliably cross a second boundary — a timing
  // choice for THIS test's assertion, not a promise the spec makes about any
  // particular interval.
  const rt = createUnitRuntime(fakeUnit(), { env: e, progressEveryMs: 200 });
  const notes = [];
  const h = createHandler({
    serverInfo: { name: 'p1fake', version: '0' },
    tools: rt.tools,
    callTool: rt.callTool,
    notify: (m) => notes.push(m),
  });
  const r = await h({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'p1_wait', arguments: { ms: 900 }, _meta: { progressToken: 'tok-abc' } },
  });
  assert.equal(r.result.content[0].text, 'waited');
  assert.ok(notes.length >= 3, `expected several progress notifications through the real stack, got ${notes.length}`);
  let prev = -1;
  for (const n of notes) {
    assert.equal(n.jsonrpc, '2.0');
    assert.equal(n.method, 'notifications/progress');
    assert.equal('id' in n, false, 'a notification never carries an id');
    assert.equal(n.params.progressToken, 'tok-abc');
    assert.equal(typeof n.params.progress, 'number');
    assert.equal('total' in n.params, false, 'total is unknown by construction');
    assert.match(n.params.message, /^p1fake p1_wait running · \d+s$/);
    assert.ok(n.params.progress >= prev, 'progress never goes backwards');
    prev = n.params.progress;
  }
  assert.ok(notes.at(-1).params.progress > notes[0].params.progress, 'elapsed seconds actually grew over the run');
  const seenAtResponse = notes.length;
  await wait(300);
  assert.equal(notes.length, seenAtResponse, 'nothing is sent once the response has gone out');
});

test('progress: no token means no notifications at all, through the real stack', async () => {
  const { env: e } = env(null);
  const rt = createUnitRuntime(fakeUnit(), { env: e, progressEveryMs: 30 });
  const notes = [];
  const h = createHandler({
    serverInfo: { name: 'p1fake', version: '0' }, tools: rt.tools, callTool: rt.callTool, notify: (m) => notes.push(m),
  });
  await h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'p1_wait', arguments: { ms: 150 } } });
  assert.deepEqual(notes, []);
});

// --- 3. cancellation, through the real stack --------------------------------

test('cancel `finish`, whole stack: the response is dropped at once, but the real child keeps running to completion and the in-flight table only clears when it does', async () => {
  const { dir, env: e } = env(null); // cancel defaults to "finish"
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const h = createHandler({ serverInfo: { name: 'p1fake', version: '0' }, tools: rt.tools, callTool: rt.callTool });
  const marker = join(dir, 'delay-marker');
  const p = h({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'p1_delay', arguments: { marker, ms: 350 } },
  });
  await wait(80); // well before the request registers as done, safely after the spawn started
  assert.equal(h.inflight(), 1);
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
  await tick();
  // The client cancelled, but `finish` means the vendor CLI runs on: the
  // request must STILL be in flight, and the marker must NOT exist yet.
  assert.equal(h.inflight(), 1, 'a `finish`-mode cancel does not clear the in-flight entry early');
  assert.equal(existsSync(marker), false, 'the child has not had time to finish yet');
  const result = await p;
  assert.equal(result, null, 'no response is sent for a cancelled request, whatever the mode');
  assert.equal(h.inflight(), 0, 'the entry clears once the child actually finishes');
  assert.equal(existsSync(marker), true, 'the child ran to completion untouched');
  const snap = JSON.parse(readFileSync(join(dir, 'status-p1fake.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'ok', 'the outcome is whatever the run produced');
  assert.equal(snap.lastEvent.detached, true, 'but nobody is listening any more');
});

test('cancel `kill`, whole stack: the response is dropped, the whole process GROUP is reaped (grandchild included), and it happens fast', async () => {
  const { dir, env: e } = env({ units: { p1fake: { cancel: 'kill' } } });
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const h = createHandler({ serverInfo: { name: 'p1fake', version: '0' }, tools: rt.tools, callTool: rt.callTool });
  const { script, marker } = grandchildFixture(dir, { markerDelayMs: 1200, parentExitMs: 400 });
  const t0 = Date.now();
  const p = h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'p1_grandchild', arguments: { script } } });
  await wait(80);
  assert.equal(h.inflight(), 1);
  await h({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  const result = await p;
  assert.equal(result, null, 'no response is sent for a cancelled request');
  assert.ok(Date.now() - t0 < 1000, '`kill` ends the call with the cancel, not on the process tree\'s own schedule');
  assert.equal(h.inflight(), 0);
  const snap = JSON.parse(readFileSync(join(dir, 'status-p1fake.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'cancelled');
  assert.equal('detached' in snap.lastEvent, false, 'a killed run was not left to finish');
  await wait(1300); // long past markerDelayMs, to be sure this isn't a race
  assert.equal(existsSync(marker), false, 'the grandchild died with the group — a parent-only kill would have missed it');
});

test('two concurrent requests, whole stack: cancelling one under `kill` leaves the other\'s real child untouched and correctly answered', async () => {
  const { dir, env: e } = env({ units: { p1fake: { cancel: 'kill' } } });
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const h = createHandler({ serverInfo: { name: 'p1fake', version: '0' }, tools: rt.tools, callTool: rt.callTool });
  const pCancel = h({
    jsonrpc: '2.0', id: 'a', method: 'tools/call',
    params: { name: 'p1_echo', arguments: { text: 'CANCELLED-ANSWER', ms: 600 } },
  });
  const pSurvive = h({
    jsonrpc: '2.0', id: 'b', method: 'tools/call',
    params: { name: 'p1_echo', arguments: { text: 'SURVIVOR-ANSWER', ms: 150 } },
  });
  await tick();
  assert.equal(h.inflight(), 2);
  await h({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'a' } });
  const [cancelled, survived] = await Promise.all([pCancel, pSurvive]);
  assert.equal(cancelled, null, 'the cancelled request gets no response');
  assert.equal(survived.result.content[0].text, 'SURVIVOR-ANSWER', 'the other request is answered normally, unaffected by the sibling\'s cancel');
  assert.equal(h.inflight(), 0);
});

test('a cancel that arrives before the spawn even starts (`kill`, signal pre-aborted) still kills fast — this is not the same as a mid-flight cancel', async () => {
  const { dir, env: e } = env({ units: { p1fake: { cancel: 'kill' } } });
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const marker = join(dir, 'preabort-marker');
  const c = new AbortController();
  c.abort(); // aborted BEFORE callTool is ever invoked — not mid-run
  const t0 = Date.now();
  const r = await rt.callTool('p1_delay', { marker, ms: 5000 }, { id: 1, signal: c.signal });
  assert.match(r.text, /killed=true/);
  assert.match(r.text, /cancelled=true/);
  assert.ok(Date.now() - t0 < 2000, 'the run ended almost immediately, not after the full 5s the child was scheduled for');
  assert.equal(existsSync(marker), false);
  const snap = JSON.parse(readFileSync(join(dir, 'status-p1fake.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'cancelled');
});

test('ctx.retry, wired through the RUNTIME (not boundedRetry called directly): a `kill`-mode cancel during the delay stops the second attempt', async () => {
  const { env: e } = env({ units: { p1fake: { cancel: 'kill' } } });
  const rt = createUnitRuntime(fakeUnit(), { env: e });
  const c = new AbortController();
  const abortTimer = setTimeout(() => c.abort(), 60);
  if (abortTimer.unref) abortTimer.unref();
  const t0 = Date.now();
  const r = await rt.callTool('p1_retry', { delayMs: 5000 }, { id: 1, signal: c.signal });
  assert.equal(r.text, 'n=1;rejected:cancelled', 'the second attempt never ran: ctx.retry really carries the kill signal, not just boundedRetry called in isolation');
  assert.ok(Date.now() - t0 < 2000, 'the delay (configured at 5s) was cut short by the signal, not waited out');
  // Under `finish`, ctx.retry gets no signal at all — a plain retry runs to
  // its normal conclusion, same as today (a short delay here: nothing cuts it off).
  const { env: fe } = env(null);
  const finishing = createUnitRuntime(fakeUnit(), { env: fe });
  const r2 = await finishing.callTool('p1_retry', { delayMs: 20 }, { id: 2, signal: new AbortController().signal });
  assert.equal(r2.text, 'n=2;resolved');
});

test('stdin end waits out a `finish`-style call still in flight (drop the response, keep waiting) before it exits — real subprocess, real protocol', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-p1-serve-'));
  const script = join(dir, 'finish-server.mjs');
  writeFileSync(script, [
    `import { serve } from ${JSON.stringify(new URL('../core/jsonrpc.mjs', import.meta.url).href)};`,
    'serve({',
    '  serverInfo: { name: "p1serve", version: "0" },',
    '  tools: [{ name: "slow", description: "d", inputSchema: { type: "object", properties: {} } }],',
    // Ignores call.signal entirely — exactly what `finish` mode does: the run
    // is deliberately left to end on its own schedule, cancel or not.
    '  callTool: async () => { await new Promise((r) => setTimeout(r, 700)); return { text: "late" }; },',
    '});',
  ].join('\n'));
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stdin.on('error', () => {});
  const t0 = Date.now();
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow' } }) + '\n');
  await wait(100);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }) + '\n');
  await wait(50);
  child.stdin.end(); // client says goodbye while the (cancelled, but still finishing) call is running
  const code = await new Promise((r) => child.on('close', r));
  const elapsed = Date.now() - t0;
  assert.equal(code, 0);
  assert.ok(elapsed >= 650, `exited too early (${elapsed}ms): stdin end must wait for the in-flight call, cancelled or not`);
  assert.equal(out.trim(), '', 'no response frame at all: the request was cancelled, so nothing is written even though the server waited for it');
});
