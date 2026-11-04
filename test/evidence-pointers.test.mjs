// 1.1.0 (spec docs/superpowers/specs/2026-09-17-1.1.0-design.md §2, §3, §5): the
// shipped agent definitions ask for the five-section report with pointer lines,
// and the rules say how a report is trusted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAgentFile, renderRulesFile, AGENT_FILES } from '../core/rules.mjs';

const SECTIONS = ['## TASK', '## FINDINGS', '## DIFF', '## TEST RESULTS', '## OPEN QUESTIONS'];

for (const name of AGENT_FILES) {
  test(`${name} asks for the five report sections, in order, with pointer lines`, () => {
    const text = renderAgentFile(name, '1.1.0');
    let at = -1;
    for (const s of SECTIONS) {
      const next = text.indexOf(`\`${s}\``, at + 1);
      assert.ok(next > at, `${s} present after the previous section`);
      at = next;
    }
    assert.match(text, /`path:line` · a verbatim fragment of that line in backticks/);
    assert.match(text, /omelette-fleet check/);
    assert.match(text, /never paraphrase/);
  });
}

// 1.5.0 P2: the scout-map mandate left the rules.
test('the rendered rules carry the evidence bullet and the planner line, and no scout-map mandate', () => {
  const text = renderRulesFile('1.1.0', { merge: 'session' });
  const evidence = text.split('\n').find((l) => l.startsWith('- **Evidence travels with pointers.**'));
  assert.ok(evidence, 'the evidence bullet is present');
  assert.match(evidence, /TASK \/ FINDINGS \/ DIFF \/ TEST RESULTS \/ OPEN QUESTIONS/);
  assert.match(evidence, /omelette-fleet check <file>/);
  assert.ok(!text.includes('One scout map per release'));
  assert.ok(text.includes('- A planner gets its spec section and the pointers the session hands it, and the plan header lists what it read.'));
});

test('the templates tell a sub-agent the three things its default habits get wrong', () => {
  for (const name of AGENT_FILES) {
    const text = renderAgentFile(name, '1.1.0');
    assert.match(text, /relative to the project root/, `${name}: relative paths`);
    assert.match(text, /never absolute/, `${name}: not absolute`);
    assert.match(text, /not a range/, `${name}: one line`);
    assert.match(text, /at least 8 characters/, `${name}: a fragment that proves something`);
    assert.match(text, /holds no backtick/, `${name}: no backtick`);
  }
});
