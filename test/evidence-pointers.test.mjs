// 1.1.0 (spec docs/superpowers/specs/2026-09-17-1.1.0-design.md §2, §3, §5): the
// shipped agent definitions ask for the five-section report with pointer lines,
// and the rules and ORCHESTRATION say how a report and a scout map are trusted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAgentFile, renderRulesFile, AGENT_FILES } from '../core/rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

test('the rendered rules carry the two evidence bullets, and stay short', () => {
  const text = renderRulesFile('1.1.0', { merge: 'session' });
  const evidence = text.split('\n').find((l) => l.startsWith('- **Evidence travels with pointers.**'));
  const scout = text.split('\n').find((l) => l.startsWith('- **One scout map per release, never to a first review.**'));
  assert.ok(evidence && scout, 'both bullets present');
  assert.match(evidence, /TASK \/ FINDINGS \/ DIFF \/ TEST RESULTS \/ OPEN QUESTIONS/);
  assert.match(evidence, /omelette-fleet check <file>/);
  assert.match(scout, /\.omelette\/map-<plan>\.md/);
  assert.match(scout, /## Not read/);
  assert.match(scout, /three pointers/);
  // The rules file is resident context in every session: the release that saves
  // tokens does not get to spend them here.
  assert.ok(evidence.length + scout.length < 800, `two bullets under 800 chars (${evidence.length + scout.length})`);
});

test('ORCHESTRATION explains the pointer line, the report shape, the scout map and check', () => {
  const md = fs.readFileSync(path.join(ROOT, 'docs/ORCHESTRATION.md'), 'utf8');
  // THE SECTION AND NOTHING AFTER IT: an unbounded slice would let a later
  // section satisfy these assertions with this one gutted.
  const from = md.indexOf('\n## Evidence with pointers\n');
  assert.notEqual(from, -1, 'section present');
  const to = md.indexOf('\n## ', from + 1);
  const section = md.slice(from, to === -1 ? undefined : to);
  for (const s of SECTIONS) assert.ok(section.includes(`\`${s}\``), `${s} named`);
  assert.match(section, /## Not read/);
  assert.match(section, /never goes to a first review/);
  assert.match(section, /three pointers of its own choosing/);
  // The contract a caller wires a gate to (three reviews found the first
  // wording overstated it): stale passes unless --strict, near-misses fail.
  assert.match(section, /`stale` too, unless `--strict`/);
  for (const status of ['weak', 'malformed', 'moved', 'mismatch', 'missing', 'outside', 'too-large']) {
    assert.ok(section.includes(`\`${status}\``), `${status} named`);
  }
  assert.match(section, /relative to the project root, never absolute/);
  assert.match(section, /1 MiB and 2000 pointer lines, targets of 2 MiB/);
  assert.match(section, /against the working tree/);
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
