import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, createLineSplitter, DEFAULT_PROTOCOL } from '../core/jsonrpc.mjs';

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
