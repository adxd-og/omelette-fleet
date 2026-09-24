// 1.2.0 P1 (spec docs/superpowers/specs/2026-09-20-1.2.0-context-design.md,
// "P1 — the rules file as a map"): the rules file keeps every rule byte for byte
// and loses only the prose that explained how the handoff hooks work, which now
// lives in CONFIG "The handoff hooks". These tests pin both halves: what left the
// rules, and where it went.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRulesFile } from '../core/rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** The rules file as a session loads it: rendered, under the default merge policy. */
const rules = () => renderRulesFile('1.2.0', { merge: 'session' });

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

/** How the handoff hooks work, in the words that carry it: CONFIG's to say, never the rules'. */
const MECHANICS = ['40 lines', '4 KB', '12 KB', '8 KB', 'PreCompact', 'SessionStart', 'PostToolUse', 'PostCompact', 'Stop'];

test('CONFIG carries the handoff hooks the rules file used to explain', () => {
  const md = read('docs/CONFIG.md');
  const hooks = section(md, '## The handoff hooks');
  for (const mechanism of MECHANICS) assert.ok(hooks.includes(mechanism), `CONFIG "The handoff hooks" carries: ${mechanism}`);
  for (const event of ['PreCompact', 'SessionStart', 'PostToolUse', 'Stop', 'PostCompact']) {
    assert.ok(hooks.includes(`\`${event}\``), `${event} named`);
  }
  for (const fact of [
    '<session cwd>/.omelette/ledger-*.md',
    'a ledger kept in another repository gets neither the stamp nor the print',
    '40 lines / 4 KB per ledger, 12 KB in all',
    '## Compaction summary <ISO> (trigger: …)',
    'Bounded to 8 KB',
    '`handoff.compactSummary=false`',
    '`handoff.enabled=false`',
    'remind **once** and gate **once** per crossing',
    'the handoff block is still yours to write',
    'A manual `/compact` below the threshold gets no reminder',
    'handoffs at every natural pause, and the hook is the net under it',
  ]) assert.ok(hooks.includes(fact), `CONFIG "The handoff hooks" says: ${fact}`);
  assert.match(md, /^\| .+ \| \[The handoff hooks\]\(#the-handoff-hooks\) \|$/m, 'the map at the top links it');
});

// ── the rules file: explanation out, every rule kept ─────────────────────────

/** Every heading the 1.1.0 file had. */
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

/** The two bullets test/evidence-pointers.test.mjs pins, byte for byte as 1.1.0 shipped them. */
const EVIDENCE = '- **Evidence travels with pointers.** Coder and tester reports come as `TASK / FINDINGS / DIFF / TEST RESULTS / OPEN QUESTIONS`, each finding a pointer line — `path:line` (relative to the project root, one line) · a verbatim fragment in backticks · the claim. `omelette-fleet check <file>` verifies the pointers: check before you trust.';
const SCOUT = '- **One scout map per release, never to a first review.** Before planning several packages, one read-only scout writes `.omelette/map-<plan>.md` — `commit: <hash>`, factual pointer lines, a closing `## Not read` — and the planners get it instead of re-reading. Run `check` on it, open three pointers yourself, re-take stale lines.';

/**
 * The five obligations the three hook bullets carried, each by its full
 * sentence as the 1.1.0 text words it (a sentence that opened mid-bullet
 * gains its capital letter, nothing else), and each a bullet of its own.
 */
const DUTIES = [
  '**After a compaction, re-read the ledger before doing anything else.**',
  '**A ledger kept in another repository gets neither the stamp nor the print.**',
  'The handoff block is still yours to write.',
  'A manual `/compact` below the threshold gets no reminder.',
  'The discipline is unchanged: handoffs at every natural pause, and the hook is the net under it.',
];

test('the rendered rules file is at most 13 100 characters under either merge policy', () => {
  for (const merge of ['session', 'pr']) {
    const text = renderRulesFile('1.2.0', { merge });
    assert.ok(text.length <= 13100, `${merge}: ${text.length} characters`);
  }
});

test('the rules keep every heading and the two evidence bullets byte for byte', () => {
  const lines = rules().split('\n');
  for (const h of HEADINGS) assert.ok(lines.includes(h), `heading kept: ${h}`);
  assert.ok(lines.includes(EVIDENCE), 'the evidence bullet is unchanged');
  assert.ok(lines.includes(SCOUT), 'the scout-map bullet is unchanged');
});

test('"Ledger and handoff" states the five hook obligations in full, one line each, and points at CONFIG for the rest', () => {
  const text = rules();
  const lines = section(text, '## Ledger and handoff').split('\n');
  for (const duty of DUTIES) assert.ok(lines.includes(`- ${duty}`), `a line of its own: ${duty}`);
  const wiring = lines.filter((l) => l.includes('rules --hooks`'));
  assert.equal(wiring.length, 1, 'one sentence says what `rules --hooks` wires');
  assert.ok(wiring[0].includes('docs/CONFIG.md'), 'and points at CONFIG');
  for (const mechanism of MECHANICS) assert.ok(!text.includes(mechanism), `mechanism moved out of the rules: ${mechanism}`);
});

// ── 1.2.0 P2: what each agent is handed ──────────────────────────────────────

/**
 * P2's rules for the operating model (spec "P2 — briefing from the map", and
 * the principle the release measured), as the template words them. Each is
 * pinned as a whole line: a condition dropped from one fails here, where a
 * substring pin would stay green. They follow the scout-map bullet, whose map
 * they are about.
 */
const HANDED = [
  "- A planner gets the map and its spec section: map first, three pointers opened by hand (one false: whole map unverified), then only what the map lacks; the plan header lists map lines relied on and re-taken.",
  "- A coder gets its task's plan section and pointers, not the spec, whose path covers what the plan left open.",
  "- Pay for judgement, not for repetition: planners do not dry-run plans.",
];

test('the operating model says what a planner and a coder are handed, and what the session pays for, right after the scout map', () => {
  const lines = section(rules(), '## Operating model for the session').split('\n');
  const scout = lines.indexOf(SCOUT);
  assert.notEqual(scout, -1, 'the scout-map bullet is in the operating model');
  assert.deepEqual(lines.slice(scout + 1, scout + 1 + HANDED.length), HANDED, 'the three lines follow the scout-map bullet');
});

/**
 * How the session reviews a plan (spec P2, the third rule), a whole line of
 * "Reviews", after the two rules it rests on: the four-part finding with its
 * ledger ruling, and the clean first review.
 */
const PLAN_REVIEW = "- Review a plan by header, task list and Self-Review; a unit gets the full file (spec, plan, four-part findings); open the findings' pointers, not the file.";

test('"Reviews" says how the session reviews a plan, after the four-part finding and the clean first review', () => {
  const lines = section(rules(), '## Reviews').split('\n');
  const at = lines.indexOf(PLAN_REVIEW);
  assert.notEqual(at, -1, 'Reviews has the plan-review rule as a line of its own');
  const four = lines.findIndex((l) => l.startsWith('- **A finding has four parts, or it is a question.**'));
  const clean = lines.findIndex((l) => l.startsWith('- **First review clean, re-review continued.**'));
  assert.ok(four !== -1 && clean !== -1 && four < at && clean < at, 'it follows the two rules it rests on');
});
