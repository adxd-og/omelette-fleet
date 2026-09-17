// scripts/agent-usage.mjs — the measuring tool behind docs/MEASUREMENTS.md:
// task notifications in, one row per sub-agent out, and never a path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
