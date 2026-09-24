// Independent tester coverage for 1.3.0 Task 12 (C8, C10):
// scripts/agent-usage.mjs reads a transcript in one left-to-right pass, never
// backtracking, and scripts/context-by-source.mjs shares its sanitise so a
// spaced directory name never reaches an exported report. Never imports from
// the implementer's own test files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUsage, sanitise } from '../scripts/agent-usage.mjs';
import { analyseTranscript } from '../scripts/context-by-source.mjs';

const CONTEXT_BY_SOURCE = new URL('../scripts/context-by-source.mjs', import.meta.url).pathname;

const usage = (t, u, ms) => `<usage><subagent_tokens>${t}</subagent_tokens><tool_uses>${u}</tool_uses><duration_ms>${ms}</duration_ms></usage>`;
// A notification as it sits in a transcript: inside a JSON string, so escaped
// (mirrors the implementer's own `notice` helper, built independently here).
const notice = (id, description, tokens, tools, ms) => JSON.stringify({
  type: 'user',
  message: { content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "${description}" finished</summary>\n${usage(tokens, tools, ms)}\n</task-notification>` },
});

// ---------------------------------------------------------------------------
// C8 — one left-to-right pass, no backtracking
// ---------------------------------------------------------------------------

test('C8: an adversarial transcript is parsed in-process at n=2000 and n=20000 without the old cubic blow-up', () => {
  const timings = [];
  for (const n of [2000, 20000]) {
    const text = ('<task-id>x</task-id><summary>Agent "x" finished</summary>').repeat(n);
    const started = Date.now();
    const rows = parseUsage(text);
    const elapsed = Date.now() - started;
    timings.push({ n, chars: text.length, elapsed });
    // No usage block anywhere in this text: every id/summary pair is unpaired, so no rows.
    assert.deepEqual(rows, []);
  }
  // Evidence, not an assertion: the old pattern took ~7 s at 45 KB (n=800); a
  // cubic regression at n=20000 (11x the length of that 45 KB case) would not
  // finish in seconds, let alone milliseconds. The bound below only guards
  // against a return of that blow-up — it is not a performance target.
  console.log('C8 timings (n, chars, ms):', JSON.stringify(timings));
  const at20000 = timings.find((t) => t.n === 20000);
  assert.ok(at20000.elapsed < 5000, `parseUsage at n=20000 took ${at20000.elapsed} ms, expected < 5000 ms`);
});

test('C8: a description holding the literal closing tag still yields one row with the right id and tokens', () => {
  const text = notice('z1', 'Review </task-notification> stray tag in the description', 500, 3, 4000);
  const rows = parseUsage(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'z1');
  assert.equal(rows[0].tokens, 500);
  assert.equal(rows[0].toolUses, 3);
  assert.match(rows[0].description, /Review <\/task-notification> stray tag/);
});

test('C8: a description holding literal <task-id> text does not start a new record', () => {
  const text = `<task-id>y1</task-id><summary>Agent "Contains <task-id>fake</task-id> text" finished</summary>${usage(7, 2, 3000)}`;
  const rows = parseUsage(text);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows.map((r) => r.id), ['y1']);
  assert.ok(!rows.some((r) => r.id === 'fake'), 'the text "fake" inside the summary never becomes an id of its own');
});

test('C8: two notices back to back produce two rows', () => {
  const text = [notice('n1', 'First notice', 100, 1, 1000), notice('n2', 'Second notice', 200, 2, 2000)].join('\n');
  const rows = parseUsage(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.id), ['n1', 'n2']);
  assert.deepEqual(rows.map((r) => r.tokens), [100, 200]);
});

test('C8: a usage block out of order, or missing a field, pairs with nothing — the same as before the fix', () => {
  // Field order swapped (tool_uses before subagent_tokens): the fixed tag
  // sequence the pattern looks for is not there, so no row at all — not a
  // row with swapped values. This is inherited from the old single pattern,
  // which required the same fixed order; the fix did not change it.
  const reordered = `<task-id>o1</task-id><summary>Agent "Order test" finished</summary><usage><tool_uses>2</tool_uses><subagent_tokens>9</subagent_tokens><duration_ms>1000</duration_ms></usage>`;
  assert.deepEqual(parseUsage(reordered), []);

  // duration_ms missing entirely: same result, no row.
  const missing = `<task-id>o2</task-id><summary>Agent "Missing test" finished</summary><subagent_tokens>9</subagent_tokens><tool_uses>2</tool_uses>`;
  assert.deepEqual(parseUsage(missing), []);
});

// ---------------------------------------------------------------------------
// C10 — a path segment may hold inner spaces, but a report never keeps one
// ---------------------------------------------------------------------------

test('C10: sanitise drops a spaced macOS home directory, keeping only the last segment', () => {
  assert.equal(sanitise('open /Users/Jane Doe/private/report.md'), 'open report.md');
});

test('C10: sanitise on two paths in one description — the connecting word survives when a space still separates the matches, and is swallowed when it does not', () => {
  // A space precedes the second path's leading slash: the first match stops
  // there, so "with" stays attached as the tail of the first match's last
  // segment and survives.
  assert.equal(sanitise('compare /Users/Jane Doe/a.md with /Users/Bob Smith/b.md'), 'compare a.md with b.md');
  // No space before the second path's leading slash: nothing stops the first
  // match's repetition, so the whole run — both paths and the word between
  // them — becomes ONE match, and only its last segment (the split-on-"/"
  // final component) survives. "c.md and" is lost, not just re-labelled.
  assert.equal(sanitise('diff /a/b/c.md and/x/y/z.md'), 'diff z.md');
});

test('C10: sanitise on a Windows-style path', () => {
  assert.equal(sanitise('C:\\Users\\Jane Doe\\report.md'), 'report.md');
});

test('C10: sanitise on a path ending with a trailing space before a word keeps the word attached to the last segment', () => {
  assert.equal(sanitise('/a/b/c report'), 'c report');
});

test('C10: sanitise on a path inside quotes stops at the quote, leaving the quotes in place', () => {
  assert.equal(sanitise('open "/Users/Jane Doe/notes.md" now'), 'open "notes.md" now');
  assert.equal(sanitise("open '/Users/Jane Doe/notes.md' now"), "open 'notes.md' now");
});

test('C10: sanitise leaves a single-slash relative path unchanged', () => {
  assert.equal(sanitise('review docs/spec.md now'), 'review docs/spec.md now');
});

test('C10: sanitise leaves a lone slash unchanged (fewer than two path segments)', () => {
  assert.equal(sanitise('just / alone'), 'just / alone');
  assert.equal(sanitise('/'), '/');
});

// ---------------------------------------------------------------------------
// C10 — context-by-source.mjs shares the same sanitise
// ---------------------------------------------------------------------------

test('C10: analyseTranscript (context-by-source.mjs) sanitises meta.description with the very same rule', () => {
  const r = analyseTranscript([{ type: 'user', message: { role: 'user', content: 'go' } }], {
    role: 'coder',
    description: 'edit /Users/Jane Doe/private/module.mjs',
  });
  assert.equal(r.description, 'edit module.mjs');
  assert.ok(!r.description.includes('Jane'), 'no directory name leaks through analyseTranscript');
});

test('C10: the context-by-source CLI resolves a spaced-path .meta.json description through the same sanitise, never leaking the directory name', () => {
  const root = mkdtempSync(join(tmpdir(), 'tester-1.3.0-fix12-'));
  try {
    mkdirSync(join(root, 'subagents'));
    const notify = JSON.stringify({
      type: 'user',
      message: { content: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "Implement P1" finished</summary>\n<usage><subagent_tokens>1000</subagent_tokens><tool_uses>1</tool_uses><duration_ms>60000</duration_ms></usage>\n</task-notification>' },
    });
    writeFileSync(join(root, 'session.jsonl'), notify + '\n');
    writeFileSync(join(root, 'subagents', 'agent-a1.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }) + '\n');
    writeFileSync(join(root, 'subagents', 'agent-a1.meta.json'), JSON.stringify({
      agentType: 'omelette-coder',
      description: 'edit /Users/Jane Doe/private/module.mjs',
      model: 'opus',
    }));
    const r = spawnSync(process.execPath, [CONTEXT_BY_SOURCE, join(root, 'session.jsonl'), join(root, 'subagents'), '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const { records } = JSON.parse(r.stdout);
    assert.equal(records.length, 1);
    assert.equal(records[0].description, 'edit module.mjs');
    assert.ok(!r.stdout.includes('Jane'), 'the CLI\'s own JSON output carries no directory name');
    assert.ok(!r.stdout.includes(root), 'no absolute temp path either');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
