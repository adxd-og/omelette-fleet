import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, SUPPORTED_PROTOCOLS, DEFAULT_PROTOCOL } from '../core/jsonrpc.mjs';

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

test('initialize answers a listed version with itself, anything else with the newest supported', async () => {
  assert.deepEqual(SUPPORTED_PROTOCOLS, ['2025-11-25', '2025-06-18', '2024-11-05']);
  assert.equal(DEFAULT_PROTOCOL, '2025-11-25');
  for (const v of SUPPORTED_PROTOCOLS) {
    const r = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v } });
    assert.equal(r.result.protocolVersion, v);
  }
  for (const v of ['2025-03-26', 'banana', '2026-07-28', '', 42]) {
    const r = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v } });
    assert.equal(r.result.protocolVersion, '2025-11-25', `requested ${JSON.stringify(v)}`);
  }
  assert.equal((await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).result.protocolVersion, '2025-11-25');
  assert.equal((await handler({ jsonrpc: '2.0', id: 1, method: 'initialize' })).result.protocolVersion, '2025-11-25', 'Review Focus 4: no params');
});
