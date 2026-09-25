/**
 * omelette-fleet :: test/tester-1.6.0-r5.test.mjs
 * 1.6.0 Task 5 (R5): the billingRiskEnv alias is gone — defineUnit throws on
 * the old key — and README's "Fewer permission prompts" paragraph says the
 * units are read-only by design, not that a vendor CLI "cannot write".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineUnit } from '../core/unit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = (extra) => ({ name: 'acme', bin: 'acme', catalog: { isAllowedModel: () => true }, tools: [{ name: 'acme_models', description: 'd', inputSchema: {}, kind: 'catalog' }], ...extra });

test('defineUnit throws on billingRiskEnv, naming the rename', () => {
  assert.throws(() => defineUnit(spec({ billingRiskEnv: [] })), /defineUnit\(acme\): billingRiskEnv was renamed riskEnv in 1\.5\.0/);
  assert.throws(() => defineUnit(spec({ riskEnv: ['A'], billingRiskEnv: ['B'] })), /billingRiskEnv was renamed riskEnv in 1\.5\.0/);
});

test('defineUnit takes riskEnv as is and carries no billingRiskEnv key', () => {
  const u = defineUnit(spec({ riskEnv: ['ACME_API_KEY'] }));
  assert.deepEqual(u.riskEnv, ['ACME_API_KEY']);
  assert.equal('billingRiskEnv' in u, false);
  assert.deepEqual(defineUnit(spec({})).riskEnv, []);
});

test('README "Fewer permission prompts": read-only by design, not "cannot write your repository"', () => {
  const md = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const from = md.indexOf('### Fewer permission prompts');
  assert.ok(from !== -1, 'section not found');
  const para = md.slice(from, md.indexOf('```', from));
  assert.doesNotMatch(para, /cannot write your repository/);
  assert.match(para, /Every unit tool is read-only by design — each vendor CLI runs under that vendor's own read-only enforcement \(a kernel sandbox for Codex, a permission policy for Gemini; \[SECURITY\]\(docs\/SECURITY\.md#threat-model\) says which is which\) under the default read-only mode \(`OMELETTE_ALLOW_WRITE` closed; \[SECURITY, "The ceiling"\]\(docs\/SECURITY\.md#the-ceiling\)\) — so approving each call one at a time buys you nothing\./);
});
