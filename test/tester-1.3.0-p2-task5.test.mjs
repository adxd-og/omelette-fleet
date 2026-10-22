// Clean-context tester run: 1.3.0 P2 Task 5 (spec
// docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md). What is left after
// the clean-up gate: the version passed to renderRulesFile moves only the
// marker line, under both merge policies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRulesFile } from '../core/rules.mjs';

const POLICIES = ['session', 'pr'];

// ── the version passed to renderRulesFile only moves the marker line ────────

test('renderRulesFile("1.3.0", …) and renderRulesFile("1.2.0", …) render the same body past the marker line', () => {
  for (const merge of POLICIES) {
    const a = renderRulesFile('1.3.0', { merge }).split('\n');
    const b = renderRulesFile('1.2.0', { merge }).split('\n');
    assert.deepEqual(a.slice(1), b.slice(1), `${merge}: only the marker line (line 1) may differ by version`);
  }
});
