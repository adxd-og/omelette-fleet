/**
 * omelette-fleet :: test/rules-tester.test.mjs
 * Independent tester pass over spec sections 1-2 ("One source of truth:
 * core/rules.mjs", "MCP instructions plumbing") of
 * docs/superpowers/specs/2026-09-05-rules-delivery-design.md.
 *
 * These tests are ADDITIONAL to test/rules.test.mjs, test/jsonrpc.test.mjs and
 * test/unit.test.mjs — they target behaviours the spec promises that were not
 * covered, or only weakly covered, by the implementer's own tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHandler } from '../core/jsonrpc.mjs';
import {
  RULES_MARKER, RULES_TEMPLATE_PATH, parseRulesMarker, renderRulesFile, rulesTarget, unitInstructions,
} from '../core/rules.mjs';

// --- renderRulesFile substitutes EVERY placeholder --------------------------

test('renderRulesFile substitutes every {{placeholder}} in the real template, not just the first', () => {
  // The marker line is a `{{marker}}` placeholder filled from core/rules.mjs's
  // RULES_MARKER builder, so the version reaches the file through it; any other
  // `{{version}}` in the body is substituted by the same pass.
  const raw = readFileSync(RULES_TEMPLATE_PATH, 'utf8');
  const occurrences = (raw.match(/\{\{[a-z]+\}\}/g) || []).length;
  assert.ok(occurrences >= 1, 'the fixture template should contain a placeholder at least once');
  const rendered = renderRulesFile('9.9.9-test');
  assert.equal(/\{\{[a-z]+\}\}/.test(rendered), false, 'no placeholder should survive rendering');
  assert.equal(rendered.split('\n')[0], RULES_MARKER('9.9.9-test'), 'the marker placeholder became the shared marker line');
  assert.ok(rendered.includes('9.9.9-test'), 'the version reached the rendered file');
});

// --- parseRulesMarker: prerelease versions ----------------------------------

test('parseRulesMarker accepts a prerelease version like 1.2.3-rc.1', () => {
  const text = renderRulesFile('1.2.3-rc.1');
  assert.equal(parseRulesMarker(text), '1.2.3-rc.1');
  assert.equal(parseRulesMarker('<!-- omelette-fleet rules v2.0.0-beta.2 · managed by `omelette-fleet rules` · edits are overwritten on refresh -->'), '2.0.0-beta.2');
});

// --- unitInstructions: whitespace-only instructions -------------------------

test('a unit whose instructions is only whitespace yields the bare contract', () => {
  const bare = unitInstructions({ name: 'x' });
  assert.equal(unitInstructions({ name: 'x', instructions: '   ' }), bare);
  assert.equal(unitInstructions({ name: 'x', instructions: '\n\t \n' }), bare);
});

// --- initialize: serverInfo/capabilities survive alongside instructions ----

test('initialize still reports serverInfo, capabilities and protocolVersion alongside instructions', async () => {
  const handler = createHandler({
    serverInfo: { name: 'omelette-fake', version: '1.2.3' },
    tools: [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } }],
    callTool: async () => ({ text: '' }),
    instructions: unitInstructions({ name: 'fake', instructions: 'This unit: Fake.' }),
  });
  const r = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-01-01' } });
  assert.equal(r.result.protocolVersion, '2025-01-01');
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.deepEqual(r.result.serverInfo, { name: 'omelette-fake', version: '1.2.3' });
  assert.match(r.result.instructions, /^omelette-fleet: this server is one read-only unit/);
  assert.match(r.result.instructions, /This unit: Fake\./);
});

// --- tools/list is unchanged by the new `instructions` field ----------------

test('tools/list payloads are unchanged by the new instructions field: no leak into tool objects', async () => {
  const tools = [
    { name: 'a', description: 'A', inputSchema: { type: 'object', properties: {} } },
    { name: 'b', description: 'B', inputSchema: { type: 'object', properties: {} } },
  ];
  const withInstructions = createHandler({
    serverInfo: { name: 't', version: '0' }, tools, callTool: async () => ({ text: '' }), instructions: 'Be careful.',
  });
  const without = createHandler({
    serverInfo: { name: 't', version: '0' }, tools, callTool: async () => ({ text: '' }),
  });
  const rWith = await withInstructions({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const rWithout = await without({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(rWith.result.tools, tools);
  assert.deepEqual(rWithout.result.tools, tools);
  assert.deepEqual(rWith.result, rWithout.result, 'instructions must not alter the tools/list result at all');
  for (const t of rWith.result.tools) assert.ok(!('instructions' in t), `tool "${t.name}" must not carry an instructions field`);
});

// --- rendered file ends with exactly one newline ----------------------------

test('renderRulesFile output ends with exactly one newline, never zero or several', () => {
  const rendered = renderRulesFile('4.5.6');
  assert.ok(rendered.endsWith('\n'), 'must end with a newline');
  assert.ok(!rendered.endsWith('\n\n'), 'must not end with a blank line / double newline');
  const trailing = rendered.match(/\n+$/)[0];
  assert.equal(trailing, '\n', `expected exactly one trailing newline, found ${trailing.length}`);
});

// --- rulesTarget with a relative CLAUDE_CONFIG_DIR --------------------------

test('rulesTarget with CLAUDE_CONFIG_DIR set to a relative path mirrors doctor\'s own (unresolved) join', () => {
  // bin/omelette-fleet.mjs's readClaudeConfig() does `join(dir, '.claude.json')`
  // with no path.resolve — a relative CLAUDE_CONFIG_DIR stays relative and is
  // interpreted against process.cwd() wherever it is later opened. rulesTarget
  // must follow the same convention rather than silently anchoring it.
  const relDir = join('relative', 'config', 'dir');
  const r = rulesTarget({ global: true, env: { CLAUDE_CONFIG_DIR: relDir } });
  assert.equal(r.scope, 'global');
  assert.equal(r.path, join(relDir, 'rules', 'omelette-fleet.md'));
  assert.equal(r.path.startsWith('/'), false, 'a relative CLAUDE_CONFIG_DIR must not be silently made absolute');
});
