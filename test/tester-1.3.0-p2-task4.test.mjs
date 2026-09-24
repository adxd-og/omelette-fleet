// Clean-context test of 1.3.0 P2 Task 4 (spec
// docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md, "## P2 — a medium
// coder beside the deep one", "What ships" and "Docs"; "## Out of scope" last
// bullet: additions only, the definitions count line may change its fact; and
// a ledger ruling of 2026-09-24 that the rules' guard sentence names every
// shipped role).
//
// This task's own promise: in the rendered rules file
// (`renderRulesFile('1.3.0', { merge })`, both merge policies `session` and
// `pr`), the definitions bullet in "## Spawning sub-agents: model and effort"
// says four definitions and names `omelette-coder-medium` (Opus,
// `effort: medium`) right after the coder, still naming the coder Opus xhigh,
// the tester Sonnet xhigh maxTurns 80 and the reviewer Opus xhigh, and its
// "Select a definition with" clause lists four `subagent_type` names; the
// guard sentence (the last paragraph) names all four roles and nothing else
// in it changed; the operating model's coder line stays byte for byte; no
// rules line says "three definitions" or "installs three"; the rendered size
// stays under a ceiling (13 620), never pinned exactly.
//
// This file writes its own copies of the constants and helpers it needs
// (never imports test/rules-size.test.mjs or any other implementer test,
// which do not export them, and are never edited here) so it tests the
// rendered file directly, independent of the implementer's tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRulesFile } from '../core/rules.mjs';

const POLICIES = ['session', 'pr'];

/** The rendered rules file for a merge policy, current template, at the version this release ships. */
const rendered = (merge) => renderRulesFile('1.3.0', { merge });

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

// ── fixed strings this task promises, typed from the working tree itself ───

/** "Operating model": the coder line the spec says stays byte for byte in this release. */
const CODER_LINE = "- **Code changes go to a strong coding sub-agent** (Opus-class, xhigh — the shipped `omelette-coder`), briefed with the approved plan and the constraints. Never to a fleet unit.";

/** "Spawning sub-agents": the definitions bullet, four definitions, coder-medium right after the coder. */
const DEFINITIONS_LINE = "- `omelette-fleet rules --agents` installs four definitions — **`omelette-coder`** (Opus, `effort: xhigh`), **`omelette-coder-medium`** (Opus, `effort: medium`), **`omelette-tester`** (Sonnet, `effort: xhigh`, `maxTurns: 80` by default (config)) and **`omelette-reviewer`** (Opus, `effort: xhigh`) — plus the `/omelette-test` skill. Select a definition with `subagent_type: omelette-coder` / `omelette-coder-medium` / `omelette-tester` / `omelette-reviewer`.";

/** "Briefing a unit": the closing paragraph, whose last clause is the guard sentence naming every shipped role. */
const GUARD_LINE = "Full text with the model catalogs and escalation rules: `docs/ORCHESTRATION.md` in the omelette-fleet package. The git guard — it contains every shipped role — `omelette-coder`, `omelette-coder-medium`, `omelette-tester` and `omelette-reviewer` — and names the one it caught — and the compaction hook are one script: `omelette-fleet rules --hooks` writes it and prints the settings snippet that calls it — omelette-fleet never edits your settings files itself.";

/**
 * Every heading of the rendered file, in order, taken from the file itself
 * (read directly, not from a prior git revision): this pins structure —
 * nothing dropped or reordered — without comparing the tree to `git show
 * HEAD:…`, which the task forbids.
 */
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

// ── the ceiling is a ceiling, never an exact pin ─────────────────────────────

for (const merge of POLICIES) {
  test(`the rendered rules file stays at most 14 030 characters under ${merge}, and is not implausibly small`, () => {
    const text = rendered(merge);
    assert.ok(text.length <= 14030, `${merge}: ${text.length} characters, expected <= 14030`);
    assert.ok(text.length > 10000, `${merge}: ${text.length} characters — sanity floor, catches a truncated render`);
  });
}

// ── the definitions bullet: four definitions, coder-medium right after the coder ──

for (const merge of POLICIES) {
  test(`"Spawning sub-agents" says four definitions, coder-medium right after the coder, each with model and effort (${merge})`, () => {
    const lines = section(rendered(merge), '## Spawning sub-agents: model and effort').split('\n');
    assert.ok(lines.includes(DEFINITIONS_LINE), 'the definitions line, whole, matches the promised wording');
  });

  test(`the definitions line names the coder xhigh, the medium coder right after it, the tester and the reviewer, and the select clause lists all four (${merge})`, () => {
    const lines = section(rendered(merge), '## Spawning sub-agents: model and effort').split('\n');
    const line = lines.find((l) => l.startsWith('- `omelette-fleet rules --agents` installs'));
    assert.notEqual(line, undefined, 'the definitions line is present');
    assert.ok(line.includes('installs four definitions'), 'says four definitions');
    assert.ok(
      line.includes('**`omelette-coder`** (Opus, `effort: xhigh`), **`omelette-coder-medium`** (Opus, `effort: medium`)'),
      'the medium coder is named right after the coder, with its own model and effort',
    );
    assert.ok(line.includes('**`omelette-tester`** (Sonnet, `effort: xhigh`, `maxTurns: 80` by default (config))'), 'the tester keeps its model, effort and maxTurns');
    assert.ok(line.includes('**`omelette-reviewer`** (Opus, `effort: xhigh`)'), 'the reviewer keeps its model and effort');
    assert.ok(
      line.includes('Select a definition with `subagent_type: omelette-coder` / `omelette-coder-medium` / `omelette-tester` / `omelette-reviewer`.'),
      'the select clause lists all four subagent_type names, in order',
    );
  });
}

// ── the old count is gone everywhere, not just off the definitions line ─────

for (const merge of POLICIES) {
  test(`no line says "three definitions" or "installs three" anywhere in the rendered file (${merge})`, () => {
    const text = rendered(merge);
    assert.ok(!text.includes('three definitions'), 'no "three definitions" left');
    assert.ok(!text.includes('installs three'), 'no "installs three" left');
  });
}

// ── the guard sentence: the last paragraph, naming all four roles, nothing else changed ──

for (const merge of POLICIES) {
  test(`"Briefing a unit" ends with the guard sentence naming all four shipped roles, unchanged otherwise (${merge})`, () => {
    const text = rendered(merge);
    const nonBlank = text.split('\n').filter((l) => l.trim().length > 0);
    assert.equal(nonBlank[nonBlank.length - 1], GUARD_LINE, 'the guard sentence is the last paragraph of the file, whole, unchanged apart from the added name');
  });

  test(`the guard sentence names exactly the four shipped roles, each once (${merge})`, () => {
    const section_ = section(rendered(merge), '## Briefing a unit');
    const guardParagraph = section_.split('\n').find((l) => l.startsWith('Full text with the model catalogs'));
    assert.notEqual(guardParagraph, undefined, 'the guard paragraph is present');
    for (const role of ['`omelette-coder`', '`omelette-coder-medium`', '`omelette-tester`', '`omelette-reviewer`']) {
      const count = guardParagraph.split(role).length - 1;
      assert.equal(count, 1, `${role} named exactly once in the guard sentence`);
    }
  });
}

// ── nothing else in "Operating model" moved: the coder line stays byte for byte ──

for (const merge of POLICIES) {
  test(`the operating model's coder line ("Opus-class, xhigh") stays byte for byte (${merge})`, () => {
    const lines = section(rendered(merge), '## Operating model for the session').split('\n');
    assert.ok(lines.includes(CODER_LINE), 'the coder line is present, unchanged');
  });
}

// ── structure: every heading still present, in order, under both policies ──

test('every heading of the template is present, in the same order, under both merge policies', () => {
  for (const merge of POLICIES) {
    const text = rendered(merge);
    const found = text.split('\n').filter((l) => /^#{1,2} /.test(l));
    assert.deepEqual(found, HEADINGS_IN_ORDER, `${merge}: headings in order`);
  }
});

// ── additions only: the two changed lines are additions to an otherwise stable frame ──

test('the two lines this task touches sit inside the sections the spec names, and neither section header text changed', () => {
  for (const merge of POLICIES) {
    const text = rendered(merge);
    assert.ok(section(text, '## Spawning sub-agents: model and effort').includes(DEFINITIONS_LINE), `${merge}: definitions line inside its own section`);
    assert.ok(section(text, '## Briefing a unit').includes(GUARD_LINE), `${merge}: guard line inside its own section`);
  }
});
