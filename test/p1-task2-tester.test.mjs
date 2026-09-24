// Tester coverage for 1.2.0 P1 Task 2 (spec
// docs/superpowers/specs/2026-09-20-1.2.0-context-design.md, "P1 — the rules
// file as a map"; plan docs/superpowers/plans/2026-09-22-1.2.0-P1-rules-map.md,
// "Task 2"). Judges the change against the spec and the plan's binding
// rulings, not against the coder's own test/rules-size.test.mjs assertions:
//   - the five obligation sentences and the wiring line hold under BOTH merge
//     policies, not just the default (`session`) the coder's test used;
//   - the hook-mechanics strings are absent from the rendered rules under
//     both policies too;
//   - the rendered headings are the 1.1.0 set, in the same order, with none
//     added or dropped;
//   - the unrendered template still keeps `{{marker}}` on line 1 and
//     `{{merge}}` exactly once (a regression a bad edit to the hook bullets
//     could in principle disturb).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRulesFile, RULES_TEMPLATE_PATH } from '../core/rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** One section of a Markdown text: its heading line up to the next heading of the same or a higher level. */
function section(md, heading) {
  const from = md.indexOf(`\n${heading}\n`);
  assert.notEqual(from, -1, `${heading} present`);
  const level = heading.match(/^#+/)[0].length;
  const next = new RegExp(`\\n#{1,${level}} `, 'g');
  next.lastIndex = from + 1;
  const m = next.exec(md);
  return md.slice(from, m ? m.index : undefined);
}

const MECHANICS = ['40 lines', '4 KB', '12 KB', '8 KB', 'PreCompact', 'SessionStart', 'PostToolUse', 'PostCompact', 'Stop'];

const DUTIES = [
  '**After a compaction, re-read the ledger before doing anything else.**',
  '**A ledger kept in another repository gets neither the stamp nor the print.**',
  'The handoff block is still yours to write.',
  'A manual `/compact` below the threshold gets no reminder.',
  'The discipline is unchanged: handoffs at every natural pause, and the hook is the net under it.',
];

/** The wiring sentence text the plan's ruling 2 gives verbatim. */
const WIRING_LINE = '- `omelette-fleet rules --hooks` wires the ledger hooks, which say nothing unless `.omelette/` holds a `ledger-*.md`; how each one works: `docs/CONFIG.md`, "The handoff hooks".';

const HEADINGS = [
  '# Working with the omelette fleet',
  '## Operating model for the session',
  '## Ledger and handoff',
  '## Tester flow',
  '## Reviews',
  '## Spawning sub-agents: model and effort',
  '## Routing',
  '## Never a sole source',
  '## Briefing a unit',
];

// ── both merge policies, not just the default ────────────────────────────────

for (const merge of ['session', 'pr']) {
  test(`"Ledger and handoff" states the five obligations and the wiring line under merge=${merge}`, () => {
    const text = renderRulesFile('1.2.0', { merge });
    const lines = section(text, '## Ledger and handoff').split('\n');
    for (const duty of DUTIES) assert.ok(lines.includes(`- ${duty}`), `a line of its own: ${duty}`);
    assert.ok(lines.includes(WIRING_LINE), 'the wiring line is present verbatim');
    const wiring = lines.filter((l) => l.includes('rules --hooks`'));
    assert.equal(wiring.length, 1, 'the wiring sentence appears exactly once');
    for (const mechanism of MECHANICS) assert.ok(!text.includes(mechanism), `mechanism moved out of the rules: ${mechanism}`);
  });

  test(`the rendered headings under merge=${merge} are the 1.1.0 set, in order, with none added or dropped`, () => {
    const text = renderRulesFile('1.2.0', { merge });
    const heads = text.split('\n').filter((l) => /^#{1,2} /.test(l));
    assert.deepEqual(heads, HEADINGS);
  });
}

test('the replaced block is exactly six bullet lines, each starting "- "', () => {
  const working = fs.readFileSync(RULES_TEMPLATE_PATH, 'utf8').split('\n');
  const block = working.slice(28, 34); // 0-indexed: lines 29-34
  assert.equal(block.length, 6);
  for (const line of block) assert.match(line, /^- /, `bullet line: ${JSON.stringify(line)}`);
});

// ── the unrendered template keeps its placeholders intact ────────────────────

test('the unrendered template keeps {{marker}} on line 1 and {{merge}} exactly once', () => {
  const raw = fs.readFileSync(RULES_TEMPLATE_PATH, 'utf8');
  const lines = raw.split('\n');
  assert.equal(lines[0], '{{marker}}');
  const mergeOccurrences = (raw.match(/\{\{merge\}\}/g) || []).length;
  assert.equal(mergeOccurrences, 1);
  assert.doesNotMatch(raw, /pull request/);
  assert.doesNotMatch(raw, /merges the branch into main itself/);
});
