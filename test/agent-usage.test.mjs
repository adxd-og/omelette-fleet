// scripts/agent-usage.mjs — the measuring tool behind docs/MEASUREMENTS.md:
// task notifications in, one row per sub-agent out, and never a path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseUsage, byRole, renderMarkdown, sanitise, roleOf } from '../scripts/agent-usage.mjs';

// A notification as it sits in a transcript: inside a JSON string, so escaped.
const notice = (id, description, tokens, tools, ms) => JSON.stringify({
  type: 'user',
  message: { content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "${description}" finished</summary>\n<usage><subagent_tokens>${tokens}</subagent_tokens><tool_uses>${tools}</tool_uses><duration_ms>${ms}</duration_ms></usage>\n</task-notification>` },
});

test('one row per agent; a resumed agent keeps its largest report and adds up its work', () => {
  const text = [
    notice('a1', 'Plan P1 contract + spawn', 343286, 74, 1778000),
    notice('a2', 'Implement check subcommand', 139834, 42, 908000),
    notice('a2', 'Implement check subcommand', 184245, 70, 505000), // resumed
    notice('a2', 'Implement check subcommand', 184245, 70, 505000), // the same notification quoted back
    '{"type":"assistant","message":{"content":"no notification here"}}',
  ].join('\n');
  const rows = parseUsage(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: 'a1', description: 'Plan P1 contract + spawn', role: 'planner', tokens: 343286, toolUses: 74, seconds: 1778, reports: 1 });
  assert.deepEqual(rows[1], { id: 'a2', description: 'Implement check subcommand', role: 'coder', tokens: 184245, toolUses: 112, seconds: 1413, reports: 2 });
});

test('a description never carries a path out of the transcript', () => {
  assert.equal(sanitise('/omelette-test /home/someone/proj/docs/spec-design.md'), '/omelette-test spec-design.md');
  assert.equal(sanitise('review C:\\work\\someone\\proj\\file.md now'), 'review file.md now');
  assert.equal(sanitise('Plan P2 results --stats'), 'Plan P2 results --stats');
  const [row] = parseUsage(notice('t1', '/omelette-test /home/someone/proj/docs/spec-design.md', 118330, 49, 712000));
  assert.equal(row.description, '/omelette-test spec-design.md');
  assert.equal(row.role, 'tester');
  assert.doesNotMatch(renderMarkdown([row]), /home|someone/);
});

test('roles follow the words the briefs use', () => {
  assert.equal(roleOf('Plan P3 PostCompact'), 'planner');
  assert.equal(roleOf('0.3.7 release-review fix round'), 'coder');
  assert.equal(roleOf('Opus whole-branch review 1.1.0'), 'reviewer');
  assert.equal(roleOf('Clean-context tester for 1.1.0'), 'tester');
  assert.equal(roleOf('Draw six diagrams (Opus)'), 'docs');
  assert.equal(roleOf('something else entirely'), 'other');
});

test('totals per role, largest first, and a table that says so', () => {
  const rows = parseUsage([notice('p1', 'Plan A', 300000, 50, 600000), notice('p2', 'Plan B', 200000, 40, 600000), notice('c1', 'Implement A', 150000, 90, 1200000)].join('\n'));
  assert.deepEqual(byRole(rows).map((t) => [t.role, t.agents, t.tokens]), [['planner', 2, 500000], ['coder', 1, 150000]]);
  const md = renderMarkdown(rows);
  assert.match(md, /^\| Role \| Agents \| Tokens \| Tool uses \| Minutes \|$/m);
  assert.match(md, /^\| planner \| 2 \| 500 000 \| 90 \| 20 \|$/m);
});

test("a background command's notification does not lend its id to the agent after it", () => {
  const bash = JSON.stringify({ type: 'user', message: { content: '<task-notification>\n<task-id>b9</task-id>\n<status>completed</status>\n<summary>Background command "Run the suite" completed (exit code 0)</summary>\n</task-notification>' } });
  const rows = parseUsage([bash, notice('a7', 'Plan P2 results --stats', 221426, 44, 886000)].join('\n'));
  assert.deepEqual(rows.map((r) => r.id), ['a7']);
  // …also when both sit in one string, back to back.
  const both = JSON.parse(bash).message.content + '\n' + JSON.parse(notice('a7', 'Plan P2 results --stats', 221426, 44, 886000)).message.content;
  assert.deepEqual(parseUsage(JSON.stringify({ message: { content: both } })).map((r) => r.id), ['a7']);
});

/** parseUsage as it was until 1.3.0 — the reference the new read must agree with, on inputs small enough for it. */
const GAP = String.raw`(?:(?!<\/task-notification>)[\s\S])*?`;
const REFERENCE = new RegExp(String.raw`<task-id>([^<]+)<\/task-id>${GAP}<summary>Agent "([^"]*)" (?:finished|completed)<\/summary>${GAP}<subagent_tokens>(\d+)<\/subagent_tokens><tool_uses>(\d+)<\/tool_uses><duration_ms>(\d+)<\/duration_ms>`, 'g');
function referenceParse(text) {
  const plain = String(text).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  const byId = new Map();
  for (const [, id, description, tokens, toolUses, ms] of plain.matchAll(REFERENCE)) {
    const seen = byId.get(id);
    const report = { tokens: Number(tokens), toolUses: Number(toolUses), seconds: Math.round(Number(ms) / 1000) };
    const key = `${report.tokens}/${report.toolUses}/${report.seconds}`;
    if (!seen) {
      const label = sanitise(description);
      byId.set(id, { id, description: label, role: roleOf(label), ...report, reports: 1, keys: new Set([key]) });
    } else if (!seen.keys.has(key)) {
      seen.keys.add(key);
      seen.reports += 1;
      seen.toolUses += report.toolUses;
      seen.seconds += report.seconds;
      seen.tokens = Math.max(seen.tokens, report.tokens);
    }
  }
  return [...byId.values()].map(({ keys, ...row }) => row);
}

test('the new read pairs ids, summaries and usage exactly as the old pattern did (C8)', () => {
  const usage = (t, u, ms) => `<usage><subagent_tokens>${t}</subagent_tokens><tool_uses>${u}</tool_uses><duration_ms>${ms}</duration_ms></usage>`;
  const bash = JSON.stringify({ type: 'user', message: { content: '<task-notification>\n<task-id>b9</task-id>\n<status>completed</status>\n<summary>Background command "Run the suite" completed (exit code 0)</summary>\n</task-notification>' } });
  const a7 = notice('a7', 'Plan P2 results --stats', 221426, 44, 886000);
  const fixtures = [
    [notice('a1', 'Plan P1 contract + spawn', 343286, 74, 1778000), notice('a2', 'Implement check subcommand', 139834, 42, 908000),
      notice('a2', 'Implement check subcommand', 184245, 70, 505000), notice('a2', 'Implement check subcommand', 184245, 70, 505000),
      '{"type":"assistant","message":{"content":"no notification here"}}'].join('\n'),
    [bash, a7].join('\n'),
    JSON.stringify({ message: { content: `${JSON.parse(bash).message.content}\n${JSON.parse(a7).message.content}` } }),
    // an id with no summary before a whole notification, inside ONE block
    `<task-notification><task-id>lost</task-id><task-id>c3</task-id><summary>Agent "Implement C" completed</summary>${usage(9, 1, 1000)}</task-notification>`,
    // a summary whose usage sits past a closing tag is not paired with it
    `<task-id>d4</task-id><summary>Agent "Plan D" finished</summary></task-notification>${usage(5, 1, 1000)}`,
    // two whole notifications with no closing tag between them
    `<task-id>e1</task-id><summary>Agent "Plan E" finished</summary>${usage(1, 1, 1000)}<task-id>e2</task-id><summary>Agent "Implement E" finished</summary>${usage(2, 2, 2000)}`,
    ('<task-id>x</task-id><summary>Agent "x" finished</summary>').repeat(50),
    // a closing tag INSIDE a summary's quoted description is text, not a boundary…
    `<task-notification><task-id>f1</task-id><summary>Agent "Quote </task-notification> in a label" finished</summary>${usage(3, 1, 1000)}</task-notification>`,
    // …and when the first summary finds its usage past such a tag, the summary holding the tag is the one that pairs
    `<task-id>g1</task-id><summary>Agent "First" finished</summary><summary>Agent "Holds </task-notification> it" finished</summary>${usage(4, 1, 1000)}`,
  ];
  for (const text of fixtures) assert.deepEqual(parseUsage(text), referenceParse(text), text.slice(0, 80));
  // The last two are rows, not an agreement on nothing: pre-splitting the text at
  // every closing tag would have lost both.
  assert.deepEqual(parseUsage(fixtures.at(-2)).map((r) => [r.id, r.description]), [['f1', 'Quote </task-notification> in a label']]);
  assert.deepEqual(parseUsage(fixtures.at(-1)).map((r) => [r.id, r.description]), [['g1', 'Holds </task-notification> it']]);
});

test('an adversarial transcript — ids and summaries with no usage behind them — is read without backtracking (C8)', () => {
  // 228 KB of it. The pattern this replaced took 7 s at 45 KB and grows with
  // the cube of the length; the read runs in a child, so a regression is a
  // KILLED child rather than a suite that never ends.
  const script = new URL('../scripts/agent-usage.mjs', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', [
    `const { parseUsage } = await import(${JSON.stringify(script)});`,
    "const rows = parseUsage(('<task-id>x</task-id><summary>Agent \"x\" finished</summary>').repeat(4000));",
    'process.stdout.write(JSON.stringify(rows));',
  ].join('\n')], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.signal, null, 'the parse did not finish inside 20 s');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '[]');
});

test('a path whose directories hold spaces loses all of them — the report keeps the last segment only (C10)', () => {
  assert.equal(sanitise('review /Users/Jane Doe/private/report.md'), 'review report.md');
  assert.equal(sanitise('review /Users/jdoe/Acme Secret Project/src/a.mjs'), 'review a.mjs');
  assert.equal(sanitise('review /Users/jdoe/project/report.md'), 'review report.md');
  assert.equal(sanitise('review C:\\Users\\Jane Doe\\private\\report.md'), 'review report.md');
  // …and what the old rule got right, it still gets right.
  assert.equal(sanitise('/omelette-test /home/someone/proj/docs/spec-design.md'), '/omelette-test spec-design.md');
  assert.equal(sanitise('review C:\\work\\someone\\proj\\file.md now'), 'review file.md now');
  assert.equal(sanitise('Plan P2 results --stats'), 'Plan P2 results --stats');
  const [row] = parseUsage(notice('t2', 'review /Users/Jane Doe/private/report.md', 1000, 1, 60000));
  assert.equal(row.description, 'review report.md');
  assert.doesNotMatch(renderMarkdown([row]), /Jane|Doe|private|Users/);
});
