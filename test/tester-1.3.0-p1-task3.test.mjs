/**
 * omelette-fleet :: test/tester-1.3.0-p1-task3.test.mjs
 * Independent tester pass over docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md,
 * P1 bullet "Where it slots in" (line 40) and the rules bullet of "## Tests"
 * (line 71), plus "## Out of scope"'s last bullet (line 67: additions only,
 * byte for byte pinned — the definitions count line is the one fact allowed
 * to change). A ledger ruling of 2026-09-24 amends the spec: the three rules
 * lines that counted two shipped roles (the branch line, the nesting line,
 * the guard sentence) get a minimal count-free fact edit, explanatory words
 * untouched.
 *
 * Input: the spec above and the task's diff (rules/omelette-fleet.md, plus
 * the ceiling bump in test/p2-task1-tester.test.mjs, test/p2-task2-tester.test.mjs
 * and test/rules-size.test.mjs), taken from `git diff` — never the
 * implementer's summary. This file targets what is uncovered or only weakly
 * covered by the implementer's own tests (which already pin the new "Reviews"
 * line, the definitions line and the three count-free lines whole, under both
 * merge policies, in test/rules-size.test.mjs):
 *
 *   - the literal substrings the spec amendment says must be gone ("both
 *     shipped", "neither shipped", "two definitions") — the implementer's own
 *     stale-string list only checks longer, more specific phrases;
 *   - every heading of the rules file still present, IN ORDER, taken from the
 *     template file itself rather than from git or a hardcoded list;
 *   - the rendered ceiling as a ceiling (<=), never an exact size.
 *
 * Never edits the implementation or any of the implementer's own test files;
 * imports nothing from them. Never compares the tree against
 * `git show HEAD:…`, and never pins an exact rendered size.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRulesFile } from '../core/rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_PATH = path.join(ROOT, 'rules', 'omelette-fleet.md');

/** The rendered rules file for a merge policy, per the task brief's shape. */
const rendered = (merge) => renderRulesFile('1.3.0', { merge });

const POLICIES = ['session', 'pr'];

/** One section of a Markdown text: its heading line up to the next heading of the same or a higher level. Own copy — never imported from an implementer test file. */
function section(md, heading) {
  const from = md.indexOf(`\n${heading}\n`);
  assert.notEqual(from, -1, `${heading} present`);
  const level = heading.match(/^#+/)[0].length;
  const next = new RegExp(`\\n#{1,${level}} `, 'g');
  next.lastIndex = from + 1;
  const m = next.exec(md);
  return md.slice(from, m ? m.index : undefined);
}

// ── the two rules lines land, and name what the spec says ───────────────────

const P1_REVIEWS_LINE = "- **A sub-agent review goes to `omelette-reviewer`.** It writes nothing but `.omelette/reports/<name>-review.md`; run `git status --porcelain` after it and reject the review outright if anything but that report changed.";
const P1_DEFINITIONS_LINE = "- `omelette-fleet rules --agents` installs three definitions — **`omelette-coder`** (Opus, `effort: xhigh`), **`omelette-tester`** (Sonnet, `effort: xhigh`, `maxTurns: 80` by default (config)) and **`omelette-reviewer`** (Opus, `effort: xhigh`) — plus the `/omelette-test` skill. Select a definition with `subagent_type: omelette-coder` / `omelette-tester` / `omelette-reviewer`.";
const CODER_PARENTHETICAL = '(Opus-class, xhigh — the shipped `omelette-coder`)';

for (const merge of POLICIES) {
  test(`"Reviews" names the reviewer, its one file and the git status check as a whole line, inside the section (${merge})`, () => {
    const text = rendered(merge);
    const reviewsSection = section(text, '## Reviews');
    assert.ok(reviewsSection.split('\n').includes(P1_REVIEWS_LINE), `the line sits inside "## Reviews" (${merge})`);
  });

  test(`"Spawning sub-agents" still names the coder as Opus/xhigh and the tester as Sonnet/xhigh with maxTurns 80, beside the reviewer (${merge})`, () => {
    const text = rendered(merge);
    const spawnSection = section(text, '## Spawning sub-agents: model and effort');
    assert.ok(spawnSection.includes(P1_DEFINITIONS_LINE), `the definitions line, whole (${merge})`);
    assert.ok(spawnSection.includes('**`omelette-coder`** (Opus, `effort: xhigh`)'), `the coder is still Opus xhigh (${merge})`);
    assert.ok(spawnSection.includes('**`omelette-tester`** (Sonnet, `effort: xhigh`, `maxTurns: 80` by default (config))'), `the tester is still Sonnet xhigh, maxTurns 80 (${merge})`);
  });

  test(`line 9's "Opus-class, xhigh" parenthetical for the coder is unchanged (${merge})`, () => {
    const text = rendered(merge);
    const opModel = section(text, '## Operating model for the session');
    assert.ok(opModel.includes(CODER_PARENTHETICAL), `the parenthetical is present, unchanged (${merge})`);
  });
}

// ── the ledger amendment: the exact stale substrings are gone everywhere ────

/**
 * The three exact phrases the 2026-09-24 ledger amendment retires (not the
 * longer, more specific phrases the implementer's own test already checks —
 * "neither shipped sub-agent role", "both shipped definitions", "**both**
 * shipped roles" — but the bare substrings the spec amendment names).
 */
const RETIRED_SUBSTRINGS = ['both shipped', 'neither shipped', 'two definitions'];

for (const merge of POLICIES) {
  test(`no rendered line contains the literal substring "both shipped", "neither shipped" or "two definitions" (${merge})`, () => {
    const text = rendered(merge);
    for (const stale of RETIRED_SUBSTRINGS) {
      assert.ok(!text.includes(stale), `${merge}: retired substring absent: ${stale}`);
    }
  });
}

// ── every heading survives, in the same order, taken from the file itself ──

/** Every top-level (#) or section (##) heading line in the raw template, in the order they appear — read directly from the template file, never from git. */
function templateHeadings() {
  const raw = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return raw.split('\n').filter((l) => /^#{1,2} /.test(l));
}

test('the raw template names at least the headings the spec section list requires, each once', () => {
  const headings = templateHeadings();
  const required = [
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
  for (const h of required) {
    assert.equal(headings.filter((l) => l === h).length, 1, `heading present exactly once: ${h}`);
  }
});

for (const merge of POLICIES) {
  test(`every heading of the template appears in the rendered file, in the same relative order (${merge})`, () => {
    const headings = templateHeadings();
    const text = rendered(merge);
    let cursor = -1;
    for (const h of headings) {
      const marker = `\n${h}\n`;
      const at = text.indexOf(marker, cursor + 1);
      assert.notEqual(at, -1, `${merge}: heading present after the previous one: ${h}`);
      assert.ok(at > cursor, `${merge}: heading in order: ${h}`);
      cursor = at;
    }
  });
}

// ── the ceiling is a ceiling, never an exact size ───────────────────────────

for (const merge of POLICIES) {
  test(`the rendered rules file is at most 13 510 characters, a ceiling not an exact pin (${merge})`, () => {
    const text = rendered(merge);
    assert.ok(text.length <= 13510, `${merge}: ${text.length} characters, expected <= 13510`);
    assert.ok(text.length > 0, `${merge}: sanity — the file is not empty`);
  });
}

// ── exactly one {{merge}} placeholder remains in the raw template ──────────

test('the raw template keeps exactly one {{merge}} placeholder', () => {
  const raw = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const count = (raw.match(/\{\{merge\}\}/g) || []).length;
  assert.equal(count, 1, 'exactly one {{merge}} placeholder remains');
});

// ── additions only: the three count-free lines keep their explanatory words ─

/**
 * The ledger amendment says these three lines lose only their count of two
 * roles; their explanatory words stay. A spot check on the words that carry
 * the explanation (not the count), for each of the three lines the amendment
 * touches, against both merge policies where the line is rendered at all.
 */
test('the branch-per-feature line keeps its explanatory words: reports its diff, reports what it ran, reports its findings', () => {
  const text = rendered('session');
  const opModel = section(text, '## Operating model for the session');
  const branchLine = opModel.split('\n').find((l) => l.startsWith('- **Branch per feature; main is gated.**'));
  assert.ok(branchLine, 'the branch-per-feature line is present');
  for (const phrase of ['the coder reports its diff', 'the tester reports what it ran', 'the reviewer reports its findings']) {
    assert.ok(branchLine.includes(phrase), `explanatory words kept: ${phrase}`);
  }
});

test('the nesting line keeps its explanation of what disallowedTools: Agent does', () => {
  const spawnSection = section(rendered('session'), '## Spawning sub-agents: model and effort');
  const nestingLine = spawnSection.split('\n').find((l) => l.startsWith('- Sub-agents may nest up to three levels deep'));
  assert.ok(nestingLine, 'the nesting line is present');
  assert.ok(nestingLine.includes('disallowedTools: Agent'), 'names the tool restriction');
  assert.ok(nestingLine.includes('they cannot spawn anything'), 'keeps the explanation');
  assert.ok(nestingLine.includes('the **orchestrator** spawns the tester, never the coder'), 'keeps the orchestrator clause');
});

test('the guard sentence names all three shipped roles and keeps the rest of the sentence', () => {
  const briefing = section(rendered('session'), '## Briefing a unit');
  const guardLine = briefing.split('\n').find((l) => l.includes('The git guard'));
  assert.ok(guardLine, 'the guard sentence is present');
  for (const role of ['`omelette-coder`', '`omelette-tester`', '`omelette-reviewer`']) {
    assert.ok(guardLine.includes(role), `names: ${role}`);
  }
  assert.ok(guardLine.includes('names the one it caught'), 'keeps the explanation of what the guard prints');
  assert.ok(guardLine.includes('docs/ORCHESTRATION.md'), 'keeps the pointer to the full text');
});
