import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler, createLineSplitter, DEBUG_META_VAR, DEFAULT_PROTOCOL, MAX_FRAME_BYTES, serve } from '../core/jsonrpc.mjs';

const tools = [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }];
const handler = createHandler({
  serverInfo: { name: 'test', version: '0.0.0' },
  tools,
  callTool: async (name, args) => {
    if (name === 'boom') throw new Error('kaboom');
    if (name === 'bad') return { text: 'nope', isError: true };
    return { text: `${name}:${JSON.stringify(args)}` };
  },
});

test('initialize echoes the client protocol version and advertises tools', async () => {
  const r = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-01-01' } });
  assert.equal(r.result.protocolVersion, '2025-01-01');
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.equal(r.result.serverInfo.name, 'test');
  const d = await handler({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  assert.equal(d.result.protocolVersion, DEFAULT_PROTOCOL);
});

test('notifications produce no response; ping and tools/list do', async () => {
  assert.equal(await handler({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handler({ jsonrpc: '2.0', method: 'initialized' }), null);
  assert.deepEqual((await handler({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});
  assert.deepEqual((await handler({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).result.tools, tools);
});

test('tools/call wraps text into MCP content and propagates isError', async () => {
  const ok = await handler({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } });
  assert.deepEqual(ok.result, { content: [{ type: 'text', text: 'echo:{"a":1}' }] });
  const bad = await handler({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'bad' } });
  assert.equal(bad.result.isError, true);
  assert.equal(bad.result.content[0].text, 'nope');
});

test('a throwing tool becomes an isError result, never a protocol error', async () => {
  const r = await handler({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'boom' } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /kaboom/);
  assert.equal(r.error, undefined);
});

test('a request method sent WITHOUT an id is a notification: it is answered with silence, and tools/call still runs', async () => {
  // JSON-RPC 2.0 §4: a message with no `id` is a notification, and a server
  // MUST NOT reply to one. A frame carrying `"id": null` is the same thing —
  // answering it addresses a response to nobody.
  const calls = [];
  const h = createHandler({
    serverInfo: { name: 'test', version: '0.0.0' },
    tools,
    callTool: async (name, args) => { calls.push([name, args]); return { text: 'ran' }; },
  });
  for (const method of ['initialize', 'ping', 'tools/list']) {
    assert.equal(await h({ jsonrpc: '2.0', method }), null, `${method} without an id`);
    assert.equal(await h({ jsonrpc: '2.0', id: null, method }), null, `${method} with a null id`);
  }
  // Fire-and-forget: the tool is a side effect the client asked for, so it runs;
  // there is simply no request to answer.
  assert.equal(await h({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } }), null);
  assert.deepEqual(calls, [['echo', { a: 1 }]]);
  assert.equal(h.inflight(), 0, 'an id-less call is not tracked and leaves nothing behind');
});

test('unknown method: -32601 for requests, silence for notifications', async () => {
  const r = await handler({ jsonrpc: '2.0', id: 8, method: 'resources/list' });
  assert.equal(r.error.code, -32601);
  assert.equal(await handler({ jsonrpc: '2.0', method: 'whatever' }), null);
});

test('line splitter reassembles frames across chunk boundaries and drops blanks', () => {
  const seen = [];
  const feed = createLineSplitter((l) => seen.push(l));
  feed('{"a":1}\n\n{"b"');
  feed(':2}\n   \n{"c":3}');
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}']);
  feed('\n');
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('line splitter caps one un-terminated frame instead of growing until V8 dies', () => {
  const seen = [];
  const overflows = [];
  const feed = createLineSplitter((l) => seen.push(l), (n) => overflows.push(n));
  const half = 'x'.repeat(MAX_FRAME_BYTES / 2 + 1);
  feed(half);
  assert.deepEqual(overflows, []); // still under the cap
  feed(half);
  assert.equal(overflows.length, 1);
  assert.ok(overflows[0] > MAX_FRAME_BYTES);
  feed('x'.repeat(1000)); // more of the same frame: reported once, not per chunk
  assert.equal(overflows.length, 1);
  // The tail of the dropped frame is discarded with it, and the loop lives on.
  feed('garbage-tail\n{"a":1}\n');
  assert.deepEqual(seen, ['{"a":1}']);
});

test('initialize carries `instructions` when given and omits the key when not', async () => {
  const withIt = createHandler({ serverInfo: { name: 't', version: '0' }, tools, callTool: async () => ({ text: '' }), instructions: 'Be careful.' });
  const r = await withIt({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(r.result.instructions, 'Be careful.');
  const without = await handler({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
  assert.ok(!('instructions' in without.result));
  const empty = createHandler({ serverInfo: { name: 't', version: '0' }, tools, callTool: async () => ({ text: '' }), instructions: '   ' });
  assert.ok(!('instructions' in (await empty({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} })).result));
});

test('spike 1a: under OMELETTE_DEBUG_META the handler logs the tools/call _meta, and "null" when there is none', async () => {
  const lines = [];
  const h = createHandler({
    serverInfo: { name: 't', version: '0' },
    tools,
    callTool: async () => ({ text: 'ok' }),
    log: (m) => lines.push(m),
    env: { [DEBUG_META_VAR]: '1' },
  });
  await h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', _meta: { progressToken: 7 } } });
  assert.deepEqual(lines, ['tools/call _meta={"progressToken":7}']);
  // The answer the spike exists for: a client that sends no _meta at all.
  await h({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo' } });
  assert.equal(lines.at(-1), 'tools/call _meta=null');
  // …and nothing whatsoever without the flag.
  const quiet = [];
  const q = createHandler({
    serverInfo: { name: 't', version: '0' },
    tools,
    callTool: async () => ({ text: 'ok' }),
    log: (m) => quiet.push(m),
    env: {},
  });
  await q({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', _meta: { progressToken: 7 } } });
  assert.deepEqual(quiet, []);
});

// --- the per-request call context, cancellation, drain -----------------------

const tick = () => new Promise((r) => setImmediate(r));

/**
 * A handler whose callTool records the context it was given and can be held
 * open: `hold` parks until `release()`, which is how two requests are made to
 * overlap without a timer.
 */
function ctxHandler(over = {}) {
  const seen = [];
  const gates = [];
  const h = createHandler({
    serverInfo: { name: 't', version: '0' },
    tools,
    callTool: async (name, args, call) => {
      seen.push({ name, args, call });
      if (name === 'hold') await new Promise((resolve) => gates.push(resolve));
      return { text: `${name}:ok` };
    },
    ...over,
  });
  return { h, seen, release: () => gates.splice(0).forEach((r) => r()) };
}

test('tools/call hands the tool a call context: the id, the progress token and a live signal', async () => {
  const { h, seen } = ctxHandler();
  await h({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 }, _meta: { progressToken: 'p1' } } });
  assert.equal(seen[0].call.id, 5);
  assert.equal(seen[0].call.progressToken, 'p1');
  assert.equal(seen[0].call.signal.aborted, false);
  assert.deepEqual(seen[0].args, { a: 1 });
  // No _meta: a null token, never undefined — the runtime tests `!= null`.
  await h({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'echo' } });
  assert.equal(seen[1].call.progressToken, null);
});

test('call.notify emits a valid JSON-RPC notification and goes quiet once the response is out', async () => {
  const sent = [];
  let later = null;
  const h = createHandler({
    serverInfo: { name: 't', version: '0' },
    tools,
    callTool: async (name, args, call) => {
      call.notify('notifications/progress', { progressToken: call.progressToken, progress: 30 });
      later = call.notify;
      return { text: 'ok' };
    },
    notify: (m) => sent.push(m),
  });
  await h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', _meta: { progressToken: 3 } } });
  assert.deepEqual(sent, [{ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 3, progress: 30 } }]);
  assert.equal('id' in sent[0], false, 'a notification never carries an id');
  later('notifications/progress', { progressToken: 3, progress: 60 });
  assert.equal(sent.length, 1, 'nothing is sent after the response');
});

test('notifications/cancelled aborts the live request, and the cancelled response is dropped', async () => {
  const { h, seen, release } = ctxHandler();
  const p = h({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'hold' } });
  await tick();
  assert.equal(h.inflight(), 1);
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }), null);
  assert.equal(seen[0].call.signal.aborted, true);
  release();
  assert.equal(await p, null, 'a cancelled request gets no response at all');
  assert.equal(h.inflight(), 0);
});

test('a cancellation for an unknown, finished or absent id is ignored — never an error, never a throw', async () => {
  const { h } = ctxHandler();
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 404 } }), null);
  const done = await h({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo' } });
  assert.equal(done.result.content[0].text, 'echo:ok');
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } }), null);
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), null);
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/cancelled' }), null);
});

test('request ids compare by TYPE and value: cancelling "9" leaves request 9 alone', async () => {
  const { h, seen, release } = ctxHandler();
  const num = h({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'hold' } });
  const str = h({ jsonrpc: '2.0', id: '9', method: 'tools/call', params: { name: 'hold' } });
  await tick();
  assert.equal(h.inflight(), 2);
  await h({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '9' } });
  assert.equal(seen[0].call.signal.aborted, false, 'the number-id request is untouched');
  assert.equal(seen[1].call.signal.aborted, true);
  release();
  assert.equal((await num).id, 9, 'the other request is answered normally');
  assert.equal(await str, null);
});

test('inflight() counts live tools/call requests; drain() resolves when the last one lands', async () => {
  const { h, release } = ctxHandler();
  assert.equal(h.inflight(), 0);
  await h.drain(); // already at zero: resolves immediately
  const p = h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hold' } });
  await tick();
  assert.equal(h.inflight(), 1);
  let drained = false;
  const d = h.drain().then(() => { drained = true; });
  await tick();
  assert.equal(drained, false);
  release();
  await p;
  await d;
  assert.equal(drained, true);
  assert.equal(h.inflight(), 0);
});

test('serve: stdin end waits for a call in flight, answers it, and only then exits 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-serve-'));
  const script = join(dir, 'slow-server.mjs');
  writeFileSync(script, [
    `import { serve } from ${JSON.stringify(new URL('../core/jsonrpc.mjs', import.meta.url).href)};`,
    'serve({',
    '  serverInfo: { name: "slow", version: "0" },',
    '  tools: [{ name: "slow", description: "d", inputSchema: { type: "object", properties: {} } }],',
    // A megabyte: far more than a pipe holds, so the write CANNOT complete
    // synchronously and the exit has to wait for it to flush.
    '  callTool: async () => { await new Promise((r) => setTimeout(r, 600)); return { text: "late answer " + "x".repeat(1024 * 1024) }; },',
    '});',
  ].join('\n'));
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow' } }) + '\n');
  await new Promise((r) => setTimeout(r, 100));
  child.stdin.end(); // the client says goodbye while the call is still running
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0);
  assert.match(out, /late answer/, 'the answer was written before the exit');
  // Written is not the same as delivered: a frame cut off mid-way still starts
  // with the answer. The client only has it if the whole frame parses.
  const frames = out.split('\n').filter(Boolean);
  assert.equal(frames.length, 1);
  const msg = JSON.parse(frames[0]);
  assert.equal(msg.id, 1);
  assert.equal(msg.result.content[0].text.length, 'late answer '.length + 1024 * 1024);
});
