// Clean-context tester run: 1.3.0 P2 Task 5 (spec
// docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md, "P2 — a medium
// coder beside the deep one", "The rule" and "The rules ceiling moves with
// the content"; "Out of scope" last bullet — additions only; "Tests" rules
// bullet). Own file: never imports from an implementer's test, never edits
// the implementation, never pins an exact size (a ceiling is a ceiling).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRulesFile } from '../core/rules.mjs';

const POLICIES = ['session', 'pr'];
const rendered = (merge) => renderRulesFile('1.3.0', { merge });

/** The whole "handed coder" line's 1.2.0 words — untouched by this package (spec: additions only). */
const CODER_1_2_0 =
  "- A coder gets its task's plan section and pointers, not the spec, whose path covers what the plan left open.";

/** rules line 9 (1-indexed in the rendered file), pinned as 1.2.0/1.3.0-P1 left it. */
const CODE_CHANGES_LINE =
  '- **Code changes go to a strong coding sub-agent** (Opus-class, xhigh — the shipped `omelette-coder`), briefed with the approved plan and the constraints. Never to a fleet unit.';

const PLANNER_LINE =
  '- A planner gets the map and its spec section: map first, three pointers opened by hand (one false: whole map unverified), then only what the map lacks; the plan header lists map lines relied on and re-taken.';

const PAY_LINE = '- Pay for judgement, not for repetition: planners do not dry-run plans.';

const HEADINGS_IN_ORDER = [
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

for (const merge of POLICIES) {
  test(`the coder-handed line starts with exactly the 1.2.0 words (${merge})`, () => {
    const lines = rendered(merge).split('\n');
    const coderLines = lines.filter((l) => l.startsWith(CODER_1_2_0));
    assert.equal(coderLines.length, 1, 'exactly one line carries the 1.2.0 opening — no stray duplicate of the old wording');
    assert.notEqual(coderLines[0], CODER_1_2_0, 'the 1.2.0 words are followed by something — not left bare');
  });

  test(`the appended clause names omelette-coder-medium for the plan-driven case (${merge})`, () => {
    const lines = rendered(merge).split('\n');
    const coder = lines.find((l) => l.startsWith(CODER_1_2_0));
    const clause = coder.slice(CODER_1_2_0.length).trim();
    assert.ok(clause.startsWith('Brief `omelette-coder-medium` when'), 'opens by naming the medium coder');
    assert.ok(clause.includes('the exact text, diff, tests and expected numbers'), 'names the four things a plan-driven section prints');
    assert.ok(clause.includes('the coder executes'), 'says what the medium coder does with that section');
  });

  test(`the appended clause names omelette-coder for the judgement case, its three examples (${merge})`, () => {
    const lines = rendered(merge).split('\n');
    const coder = lines.find((l) => l.startsWith(CODER_1_2_0));
    const clause = coder.slice(CODER_1_2_0.length).trim();
    assert.ok(clause.includes('`omelette-coder` otherwise'), 'the default bucket is named for the "otherwise" case');
    assert.ok(clause.includes('a new thing with no written shape'), 'first example');
    assert.ok(clause.includes('debugging with no known cause'), 'second example');
    assert.ok(clause.includes('a decision the brief explicitly delegates'), 'third example');
  });

  test(`the appended clause states the NEEDS_CONTEXT rule and the ledger obligation (${merge})`, () => {
    const lines = rendered(merge).split('\n');
    const coder = lines.find((l) => l.startsWith(CODER_1_2_0));
    assert.ok(coder.includes('a brief leaving a required decision open gets `NEEDS_CONTEXT` at any effort'), 'NEEDS_CONTEXT holds regardless of effort');
    assert.ok(coder.includes('the bucket and its reason go into the brief and the ledger line'), 'the bucket and reason are recorded');
  });

  test(`the coder-handed line carries no bold markers (${merge})`, () => {
    const lines = rendered(merge).split('\n');
    const coder = lines.find((l) => l.startsWith(CODER_1_2_0));
    assert.ok(!coder.includes('**'), 'no ** in the coder-handed line');
  });

  test(`the coder-handed line is the only one of its kind, sitting between the planner line and the pay-for-judgement line (${merge})`, () => {
    const lines = rendered(merge).split('\n');
    const plannerAt = lines.indexOf(PLANNER_LINE);
    const payAt = lines.indexOf(PAY_LINE);
    assert.notEqual(plannerAt, -1, 'the planner line is present, unchanged');
    assert.notEqual(payAt, -1, 'the pay-for-judgement line is present, unchanged');
    // Found by content, ordered — never by position, which any added line moves.
    const coderAt = lines.findIndex((l) => l.startsWith(CODER_1_2_0));
    assert.notEqual(coderAt, -1, 'the coder-handed line is present');
    assert.equal(lines.filter((l) => l.startsWith(CODER_1_2_0)).length, 1, 'and only once');
    assert.ok(plannerAt < coderAt && coderAt < payAt, `planner (${plannerAt}) < coder-handed (${coderAt}) < pay (${payAt})`);
  });

  test(`the "Opus-class, xhigh — the shipped omelette-coder" line is unchanged (${merge})`, () => {
    const lines = rendered(merge).split('\n');
    const codeAt = lines.indexOf(CODE_CHANGES_LINE);
    assert.notEqual(codeAt, -1, 'the untouched "Code changes go to..." line is present');
    assert.ok(codeAt < lines.indexOf(PLANNER_LINE), 'and it comes before the planner line');
  });

  test(`the rendered rules file stays within its ceiling — 14 030 characters, never an exact pin (${merge})`, () => {
    const text = rendered(merge);
    assert.ok(text.length <= 14030, `${merge}: ${text.length} characters, expected <= 14030 (a ceiling, not an exact size)`);
    assert.ok(text.length > 13000, `${merge}: ${text.length} characters — sanity floor, catches a truncated render`);
  });

  test(`every heading is present, in order (${merge})`, () => {
    const lines = rendered(merge).split('\n');
    const found = lines.filter((l) => /^#{1,2} /.test(l));
    assert.deepEqual(found, HEADINGS_IN_ORDER, 'headings present and in order');
  });
}

// ── content is identical across merge policies except the merge sentence ────

test('the coder-handed line, the planner line and the pay line render identically under both merge policies', () => {
  const session = renderRulesFile('1.3.0', { merge: 'session' }).split('\n');
  const pr = renderRulesFile('1.3.0', { merge: 'pr' }).split('\n');
  const coderS = session.find((l) => l.startsWith(CODER_1_2_0));
  const coderP = pr.find((l) => l.startsWith(CODER_1_2_0));
  assert.equal(coderS, coderP, 'the coder-handed line does not vary with the merge policy');
  assert.ok(session.includes(PLANNER_LINE) && pr.includes(PLANNER_LINE));
  assert.ok(session.includes(PAY_LINE) && pr.includes(PAY_LINE));
});

// ── the version passed to renderRulesFile only moves the marker line ────────

test('renderRulesFile("1.3.0", …) and renderRulesFile("1.2.0", …) render the same body past the marker line', () => {
  for (const merge of POLICIES) {
    const a = renderRulesFile('1.3.0', { merge }).split('\n');
    const b = renderRulesFile('1.2.0', { merge }).split('\n');
    assert.deepEqual(a.slice(1), b.slice(1), `${merge}: only the marker line (line 1) may differ by version`);
  }
});
