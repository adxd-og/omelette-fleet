// Independent coverage for 1.2.0 P2 Task 2 ("Reviews" says how the session
// reviews a plan), written from the spec (P2, the third rule) and the plan
// (docs/superpowers/plans/2026-09-23-1.2.0-P2-briefing.md, Task 2, Rulings 3-4,
// Global Constraints). This file never compares the working tree or the
// rendered template against `git show HEAD:…` or any commit — that breaks the
// moment the change is committed — and never pins an exact rendered size, only
// the spec's ceiling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRulesFile } from '../core/rules.mjs';

/** Both merge policies the operator can choose (core/rules.mjs MERGE_SENTENCES). */
const POLICIES = ['session', 'pr'];

/** The plan's exact line (Task 2, Step 2.3), a bullet with no bold label (Ruling 2's last note). */
const PLAN_REVIEW =
  "- Review a plan by header, task list and Self-Review; a unit gets the full file (spec, plan, four-part findings); open the findings' pointers, not the file.";

/** The two existing "Reviews" bullets the new line rests on (Task 2's Interfaces / Step 2.1). */
const FOUR_PART_PREFIX = '- **A finding has four parts, or it is a question.**';
const CLEAN_REVIEW_PREFIX = '- **First review clean, re-review continued.**';

/**
 * How the handoff hooks work, in CONFIG's words now, not the rules' (P1). A
 * line added by P2 must not reintroduce any of these (Global Constraints:
 * "no added line contains any MECHANICS string").
 */
const MECHANICS = ['40 lines', '4 KB', '12 KB', '8 KB', 'PreCompact', 'SessionStart', 'PostToolUse', 'PostCompact', 'Stop'];

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

for (const merge of POLICIES) {
  test(`the plan-review line is a whole line of the rendered file under the "${merge}" merge policy`, () => {
    const text = renderRulesFile('1.2.0', { merge });
    const lines = text.split('\n');
    assert.equal(lines.filter((l) => l === PLAN_REVIEW).length, 1, 'the exact line appears exactly once, as a line of its own');
  });
}

for (const merge of POLICIES) {
  test(`the plan-review line sits inside "## Reviews", directly after the two existing bullets, before the next "## " heading (${merge})`, () => {
    const text = renderRulesFile('1.2.0', { merge });
    const reviews = section(text, '## Reviews').split('\n');

    const four = reviews.findIndex((l) => l.startsWith(FOUR_PART_PREFIX));
    const clean = reviews.findIndex((l) => l.startsWith(CLEAN_REVIEW_PREFIX));
    const at = reviews.indexOf(PLAN_REVIEW);
    assert.notEqual(four, -1, 'the four-part-finding bullet is present');
    assert.notEqual(clean, -1, 'the clean-first-review bullet is present');
    assert.notEqual(at, -1, 'the plan-review line is present in the section');

    // "directly after": no other bullet or blank content line between the
    // clean-review bullet and the new line.
    assert.equal(at, clean + 1, 'the new line immediately follows the clean-first-review bullet, with nothing between');
    assert.equal(clean, four + 1, 'the clean-first-review bullet immediately follows the four-part-finding bullet');

    // "before the next ## heading": what follows the new line in the section is
    // blank or a bullet of its own (1.3.0 P1 adds the reviewer line there) — no
    // prose leaks in, and the section (which already stops at the next "## "
    // heading) does not contain one either.
    const rest = reviews.slice(at + 1);
    assert.ok(rest.every((l) => l.trim() === '' || l.startsWith('- ')), 'only blank lines and bullets follow the new line before the section ends');

    // The section itself does not contain a further "## " heading (section()
    // already guarantees this by construction, but pin it against the literal
    // next heading name too, as a second, independent check).
    assert.ok(!reviews.some((l) => l === '## Spawning sub-agents: model and effort'), '"## Reviews" does not swallow the next heading');
  });
}

for (const merge of POLICIES) {
  test(`the rendered rules file stays at or under the 13 620-character ceiling (${merge})`, () => {
    const text = renderRulesFile('1.2.0', { merge });
    assert.ok(text.length <= 13620, `${merge}: ${text.length} characters, expected <= 13620`);
  });
}

test('the plan-review line reintroduces no hook-mechanics string', () => {
  for (const mechanism of MECHANICS) {
    assert.ok(!PLAN_REVIEW.includes(mechanism), `the new line does not contain the mechanics string: ${mechanism}`);
  }
});

test('no rendered copy (either merge policy) gains a new occurrence of a hook-mechanics string beyond what already existed', () => {
  // P1 already moved hook mechanics out of the rules file entirely (test/rules-size.test.mjs
  // "mechanism moved out of the rules"). Task 2 must not bring any of it back.
  for (const merge of POLICIES) {
    const text = renderRulesFile('1.2.0', { merge });
    for (const mechanism of MECHANICS) {
      assert.ok(!text.includes(mechanism), `${merge}: rendered file does not contain: ${mechanism}`);
    }
  }
});
