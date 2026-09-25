// Independent coverage for 1.2.0 P2 Task 3 (docs/ORCHESTRATION.md gains
// "### What each agent is handed" — the four rules in full, under "Evidence
// with pointers", plus its map row), written from the spec
// (docs/superpowers/specs/2026-09-20-1.2.0-context-design.md, "P2 — briefing
// from the map", last paragraph) and the plan
// (docs/superpowers/plans/2026-09-23-1.2.0-P2-briefing.md, Task 3, Interfaces,
// Rulings 5-6, Global Constraints). Never compares the working tree against
// `git show HEAD:…` or any commit, and never pins an exact rendered size —
// only the ceiling the plan already tests elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRulesFile } from '../core/rules.mjs';
import { parsePointers } from '../core/check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

// GitHub's heading slug (docs-map.test.mjs's own rule, reproduced here so this
// file does not depend on that one): lowercase, drop backticks and everything
// that is not a letter, digit, space, hyphen or underscore, spaces to hyphens.
function slug(text) {
  return text.replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}

/** 1-based line number of the first occurrence of `needle` in `text`. */
function lineOf(text, needle) {
  const at = text.indexOf(needle);
  assert.notEqual(at, -1, `${needle.slice(0, 40)}… present`);
  return text.slice(0, at).split('\n').length;
}

const SUBSECTION_HEADING = '### What each agent is handed';
const EVIDENCE_HEADING = '## Evidence with pointers';

/**
 * The four items exactly as the plan's Task 3, Step 3.4 puts them in
 * ORCHESTRATION (the full wording; the rules file carries a one-line
 * shortening of each — Ruling 2).
 */
const HANDED_DOC = [
  "- **A planner gets its section.** Its brief carries the package's section of the spec and the pointers the session hands it; the plan's header lists what it read. When several packages are planned by fresh delegates, a scout map is the way to hand them the same reading once — see [The scout map, when a fresh planner needs one](#the-scout-map-when-a-fresh-planner-needs-one).",
  "- **A coder gets its task, not the release.** Its brief carries the task's section of the plan and the pointers it needs, not the whole spec; the spec's path is there for the cases the plan did not settle. The brief also names which coder, by how much the section leaves to decide. **`omelette-coder-medium`** (`effort: medium`) when the section prints the exact text, the diff, the tests and the numbers they must print: the coder executes it, and on one plan-driven trial medium built the same behaviour as xhigh, which took 2.5× the cache reads and 3.6× the wall clock ([MEASUREMENTS](MEASUREMENTS.md#coder-effort-medium-high-xhigh-on-one-task), N = 1). **`omelette-coder`** (`effort: xhigh`) otherwise: a new thing with no written shape, debugging with no known cause, or a decision the brief *explicitly delegates* (decide X between A and B, report the trade-off) — effort buys depth on the decisions the brief hands over, not permission to guess. A brief that leaves a required decision open gets `NEEDS_CONTEXT` back at any effort: the coder template says so, and neither bucket changes it. The bucket and the reason for it go into the brief and into the task's ledger line.",
  "- **The session reviews a plan by its header, task list and Self-Review.** The full plan file goes to a unit — `codex_code_review` or `grok_code_review`, with the spec's path and the plan's path, asking for four-part findings — and the session opens the pointers of the findings, not the file. The ledger records the findings and the rulings as for any review.",
  "- **Pay for judgement, not for repetition.** Reviews, clean-context testers and arbitration are what the tokens are for; re-reading, re-running and re-deriving are where they are lost. A planner does not dry-run its plan: the review reads it, and the coder and the tester run it for real.",
];

// ── the four items, each a whole line, inside the subsection ────────────────

test('"### What each agent is handed" carries exactly the four items, each a whole line', () => {
  const md = read('docs/ORCHESTRATION.md');
  const sub = section(md, SUBSECTION_HEADING);
  const lines = sub.split('\n');
  for (const item of HANDED_DOC) assert.ok(lines.includes(item), `a whole line of its own: ${item.slice(0, 60)}`);
  const bullets = lines.filter((l) => l.startsWith('- '));
  assert.equal(bullets.length, 4, `exactly four bullets, found ${bullets.length}`);
});

// ── placement: inside "Evidence with pointers", before the next "## " heading ─

test('the subsection sits inside "## Evidence with pointers" and ends before the next "## " heading', () => {
  const md = read('docs/ORCHESTRATION.md');
  const evidence = section(md, EVIDENCE_HEADING);
  assert.ok(evidence.includes(SUBSECTION_HEADING), 'the subsection heading is inside "Evidence with pointers"');
  const sub = section(md, SUBSECTION_HEADING);
  assert.ok(evidence.includes(sub), 'the whole subsection body is inside "Evidence with pointers"');

  // Independent boundary check, not reusing section()'s own next-heading regex:
  // the subsection heading must come after "Evidence with pointers" and before
  // the very next "## " heading found anywhere past it.
  const evidenceAt = md.indexOf(`\n${EVIDENCE_HEADING}\n`);
  const subAt = md.indexOf(`\n${SUBSECTION_HEADING}\n`);
  assert.ok(subAt > evidenceAt, 'the subsection heading is textually after "Evidence with pointers"');
  const nextH2 = md.indexOf('\n## ', subAt + 1);
  assert.notEqual(nextH2, -1, 'there is a following "## " heading (the file does not end mid-section)');
  assert.equal(md.slice(nextH2 + 1, nextH2 + 3), '##', 'sanity: the boundary really is a "## " heading');
  assert.ok(!md.slice(subAt, nextH2).includes('\n## Spawning sub-agents'), 'the next top-level heading has not leaked inside');
});

// ── the map row: opening table, before the first "## " heading, slug resolves ─

test('the opening map carries a row for the subsection, before the first "## " heading, and its anchor is the GitHub slug of the heading', () => {
  const md = read('docs/ORCHESTRATION.md');
  const firstH2 = md.indexOf('\n## ');
  assert.notEqual(firstH2, -1, 'the file has at least one "## " heading');
  const head = md.slice(0, firstH2);
  const rowMatch = head.match(/^\| .+ \| \[What each agent is handed\]\(#([^)]+)\) \|$/m);
  assert.ok(rowMatch, 'the map row is present before the first "## " heading');
  const anchor = rowMatch[1];
  const expected = slug(SUBSECTION_HEADING.replace(/^#+\s*/, ''));
  assert.equal(anchor, expected, 'the row\'s anchor is the GitHub-style slug of the heading text');
  // and the row appears exactly once
  const occurrences = (head.match(/\[What each agent is handed\]/g) || []).length;
  assert.equal(occurrences, 1, 'the map links the subsection exactly once');
});

// ── each ORCHESTRATION item carries every condition of its rules-file line ──

/**
 * The four one-line rules (rules/omelette-fleet.md via renderRulesFile), and,
 * for each, the key phrases its ORCHESTRATION counterpart must carry — every
 * condition the short line states, in the doc's fuller words. A phrase the
 * doc item drops (a condition silently lost between the rules and the docs)
 * fails one of these, where a plain substring pin on the doc alone would not
 * notice it went missing from the correspondence.
 */
const CORRESPONDENCE = [
  {
    rulesLine: "- A planner gets its spec section and the pointers the session hands it, and the plan header lists what it read.",
    docItem: HANDED_DOC[0],
    phrases: [
      "the package's section of the spec",
      'the pointers the session hands it',
      "the plan's header lists what it read",
    ],
  },
  {
    rulesLine: "- A coder gets its task's plan section and pointers, not the spec, whose path covers what the plan left open. Brief `omelette-coder-medium` when the section prints the exact text, diff, tests and expected numbers (the coder executes), `omelette-coder` otherwise (a new thing with no written shape, debugging with no known cause, a decision the brief explicitly delegates); a brief leaving a required decision open gets `NEEDS_CONTEXT` at any effort; the bucket and its reason go into the brief and the ledger line.",
    docItem: HANDED_DOC[1],
    phrases: [
      "the task's section of the plan and the pointers it needs",
      'not the whole spec',
      'the spec\'s path is there for the cases the plan did not settle',
      '**`omelette-coder-medium`** (`effort: medium`) when the section prints the exact text, the diff, the tests and the numbers they must print',
      'the coder executes it',
      '**`omelette-coder`** (`effort: xhigh`) otherwise',
      'a new thing with no written shape',
      'debugging with no known cause',
      'a decision the brief *explicitly delegates*',
      'A brief that leaves a required decision open gets `NEEDS_CONTEXT` back at any effort',
      "The bucket and the reason for it go into the brief and into the task's ledger line",
    ],
  },
  {
    rulesLine: "- Review a plan by header, task list and Self-Review; a unit gets the full file (spec, plan, four-part findings); open the findings' pointers, not the file.",
    docItem: HANDED_DOC[2],
    phrases: [
      'header, task list and Self-Review',
      'The full plan file goes to a unit',
      'asking for four-part findings',
      'the session opens the pointers of the findings, not the file',
    ],
  },
  {
    rulesLine: "- Pay for judgement, not for repetition: planners do not dry-run plans.",
    docItem: HANDED_DOC[3],
    phrases: [
      'Pay for judgement, not for repetition.',
      'A planner does not dry-run its plan',
    ],
  },
];

for (const merge of ['session', 'pr']) {
  test(`the four rules-file lines exist in the rendered file under the "${merge}" merge policy`, () => {
    const text = renderRulesFile('1.2.0', { merge });
    const lines = text.split('\n');
    for (const { rulesLine } of CORRESPONDENCE) {
      assert.ok(lines.includes(rulesLine), `rules line present: ${rulesLine.slice(0, 60)}`);
    }
  });
}

test('each ORCHESTRATION item carries every condition of its one-line rules-file counterpart', () => {
  for (const { docItem, phrases } of CORRESPONDENCE) {
    for (const phrase of phrases) {
      assert.ok(docItem.includes(phrase), `"${docItem.slice(0, 50)}…" carries "${phrase}"`);
    }
  }
});

// ── none of the new lines opens like a pointer for `omelette-fleet check` ───

test('no line the subsection adds parses as a pointer or a malformed near-miss (omelette-fleet check)', () => {
  const md = read('docs/ORCHESTRATION.md');
  const headingLine = lineOf(md, `\n${SUBSECTION_HEADING}\n`) + 1; // the heading line itself, 1-based
  const introEnd = md.indexOf('\n## Spawning sub-agents');
  const subEndLine = md.slice(0, introEnd).split('\n').length;

  const entries = parsePointers(md);
  const inSubsection = entries.filter((e) => e.line >= headingLine && e.line <= subEndLine);
  assert.deepEqual(inSubsection, [], `no pointer-shaped or malformed line inside the subsection (lines ${headingLine}-${subEndLine})`);
});

test('each of the four items, checked on its own, parses as prose (no pointer, no malformed near-miss)', () => {
  for (const item of HANDED_DOC) {
    const entries = parsePointers(item);
    assert.deepEqual(entries, [], `parses as prose: ${item.slice(0, 60)}`);
  }
});

test('the intro paragraph of the subsection (the MEASUREMENTS.md link) parses as prose too', () => {
  const md = read('docs/ORCHESTRATION.md');
  const sub = section(md, SUBSECTION_HEADING);
  const intro = sub.split('\n\n')[1]; // heading, blank, intro paragraph, blank, bullets…
  assert.match(intro, /MEASUREMENTS\.md#where-a-sub-agents-context-goes/, 'sanity: this is the intro paragraph with the link');
  const entries = parsePointers(intro);
  assert.deepEqual(entries, [], `the intro paragraph parses as prose: ${intro}`);
});
