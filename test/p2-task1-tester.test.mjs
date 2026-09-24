// Clean-context test of 1.2.0 P2 Task 1 (plan
// docs/superpowers/plans/2026-09-23-1.2.0-P2-briefing.md, "### Task 1"; spec
// docs/superpowers/specs/2026-09-20-1.2.0-context-design.md "P2 — briefing
// from the map"). Task 1's own promise, from the plan's Step 1.4 and its
// Global Constraints: three whole lines are added to the rules template right
// after the scout-map bullet, under BOTH merge policies (the implementer's
// own test in test/rules-size.test.mjs only exercises `session`); no other
// template line changes; the render stays under the 13 100 ceiling.
//
// This file writes its own copies of the constants and helpers it needs
// (never imports test/rules-size.test.mjs, which does not export them, and
// never edits it) so it tests the rendered file directly, independent of the
// implementer's test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRulesFile } from '../core/rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The scout-map bullet, byte for byte as the template (before and after this diff) words it. */
const SCOUT = "- **One scout map per release, never to a first review.** Before planning several packages, one read-only scout writes `.omelette/map-<plan>.md` — `commit: <hash>`, factual pointer lines, a closing `## Not read` — and the planners get it instead of re-reading. Run `check` on it, open three pointers yourself, re-take stale lines.";

/** The three lines Task 1 adds, in order, byte for byte (plan Step 1.4). */
const HANDED = [
  "- A planner gets the map and its spec section: map first, three pointers opened by hand (one false: whole map unverified), then only what the map lacks; the plan header lists map lines relied on and re-taken.",
  "- A coder gets its task's plan section and pointers, not the spec, whose path covers what the plan left open. Brief `omelette-coder-medium` when the section prints the exact text, diff, tests and expected numbers (the coder executes), `omelette-coder` otherwise (a new thing with no written shape, debugging with no known cause, a decision the brief explicitly delegates); a brief leaving a required decision open gets `NEEDS_CONTEXT` at any effort; the bucket and its reason go into the brief and the ledger line.",
  "- Pay for judgement, not for repetition: planners do not dry-run plans.",
];

/** Hook-mechanics strings that P1 moved out of the rules file (test/rules-size.test.mjs MECHANICS); Task 1's new lines must not reintroduce any of them. */
const MECHANICS = ['40 lines', '4 KB', '12 KB', '8 KB', 'PreCompact', 'SessionStart', 'PostToolUse', 'PostCompact', 'Stop'];

/** The rendered rules file for a merge policy, current template. */
const rendered = (merge) => renderRulesFile('1.2.0', { merge });

// ── the three lines land, whole, right after the scout bullet ───────────────

test('the three lines are whole lines in the rendered file, immediately after the scout-map bullet, under both merge policies', () => {
  for (const merge of ['session', 'pr']) {
    const lines = rendered(merge).split('\n');
    const scout = lines.indexOf(SCOUT);
    assert.notEqual(scout, -1, `${merge}: the scout-map bullet is present, unchanged`);
    assert.deepEqual(
      lines.slice(scout + 1, scout + 1 + HANDED.length),
      HANDED,
      `${merge}: the three lines follow the scout-map bullet, in order`,
    );
  }
});

test('the insertion sits inside "Operating model for the session", before "## Ledger and handoff", under both merge policies', () => {
  for (const merge of ['session', 'pr']) {
    const lines = rendered(merge).split('\n');
    const opModel = lines.indexOf('## Operating model for the session');
    const ledger = lines.indexOf('## Ledger and handoff');
    const first = lines.indexOf(HANDED[0]);
    assert.ok(opModel !== -1 && ledger !== -1 && first !== -1, `${merge}: all three headings/lines present`);
    assert.ok(opModel < first && first < ledger, `${merge}: the new lines sit between the two headings`);
  }
});

// (A test comparing the template against `HEAD:rules/omelette-fleet.md` was
// dropped by the session before Task 2: it held only while Task 1 was
// uncommitted. "Nothing else moved" was verified on the diff at commit time.)

// ── the render stays under the ceiling ───────────────────────────────────────

// The ceiling follows the content: 14 030 since 1.3.0 P2's Task 5 (test/rules-size.test.mjs says why).
test('the rendered rules file stays at most 14 030 characters under both merge policies', () => {
  for (const merge of ['session', 'pr']) {
    const text = rendered(merge);
    assert.ok(text.length <= 14030, `${merge}: ${text.length} characters`);
  }
});

// ── the three lines respect the plan's own constraints on their shape ───────

test('the three added lines carry no bold label, no hook-mechanics string, and no unresolved template placeholder', () => {
  for (const line of HANDED) {
    assert.ok(line.startsWith('- '), `starts as a plain bullet: ${line}`);
    assert.ok(!line.includes('**'), `no bold label (Ruling 2 — a precedent for an unlabelled bullet): ${line}`);
    for (const mechanism of MECHANICS) assert.ok(!line.includes(mechanism), `no hook-mechanics string (${mechanism}): ${line}`);
    for (const placeholder of ['{{marker}}', '{{version}}', '{{merge}}']) {
      assert.ok(!line.includes(placeholder), `no unresolved placeholder (${placeholder}): ${line}`);
    }
  }
});

test('the raw template (working tree, as this diff leaves it) keeps exactly one `{{merge}}` placeholder', () => {
  const templateText = fs.readFileSync(path.join(ROOT, 'rules/omelette-fleet.md'), 'utf8');
  const count = (templateText.match(/\{\{merge\}\}/g) || []).length;
  assert.equal(count, 1, 'exactly one `{{merge}}` placeholder remains in the template');
});
