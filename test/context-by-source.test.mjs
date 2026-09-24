// scripts/context-by-source.mjs — P0 of the 1.2.0 spec: where a sub-agent's
// context goes, read out of its own transcript; aggregates out, never content
// or a path. Every transcript here is synthetic, built entry by entry.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseTranscript, isReadCommand, renderMarkdown, summarise } from '../scripts/context-by-source.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'context-by-source.mjs');
const REPO = '/home/someone/omelette-fleet';

// A sub-agent transcript as Claude Code writes it: one entry per content block,
// every block of one API request under the same message id.
const usage = (input, cacheWrite, cacheRead, output) => ({ input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output });
const brief = (content) => ({ type: 'user', message: { role: 'user', content } });
const assistant = (id, u, block) => ({ type: 'assistant', message: { id, model: 'claude-opus-5-5', role: 'assistant', usage: u, content: [block] } });
const toolResult = (toolUseId, content) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });
const attachment = (content) => ({ type: 'attachment', attachment: { type: 'hook_additional_context', content } });

// One request that calls one tool, then the tool's result: two entries.
let calls = 0;
function call(name, input, result, u = usage(1, 0, 0, 1)) {
  const id = `toolu_${++calls}`;
  return [assistant(`msg_${id}`, u, { type: 'tool_use', id, name, input }), toolResult(id, result)];
}
const inputChars = (...inputs) => inputs.reduce((s, i) => s + JSON.stringify(i).length, 0);

test('one API request is one message id: context from its usage, output the largest value seen', () => {
  const r = analyseTranscript([
    brief('do it'),
    assistant('msg_1', usage(10, 100, 1000, 5), { type: 'thinking', thinking: 'hmm' }),
    assistant('msg_1', usage(10, 100, 1000, 40), { type: 'text', text: 'hello' }),
    assistant('msg_1', usage(10, 100, 1000, 25), { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }),
    toolResult('t1', 'a b c'),
    assistant('msg_2', usage(3, 20, 1110, 7), { type: 'text', text: 'done' }),
  ]);
  assert.equal(r.requests, 2);
  assert.equal(r.peak, 1133);
  assert.deepEqual(r.usage, { input: 13, cacheWrite: 120, cacheRead: 2110, output: 47 });
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(r.role, 'unknown');
  assert.equal(r.description, '');
});

test('a Bash command reads when any pipeline segment starts with a reading command', () => {
  for (const cmd of ['cat a.md', 'sed -n 1,40p core/check.mjs', 'git show HEAD:core/rules.mjs', 'git diff', 'git log -p core/x.mjs',
    'head -5 x', '  tail -f y', 'less z', 'more z', 'nl -ba x', 'bat x', 'npm test 2>&1 | tail -20', 'cd /x && cat y', 'echo a; nl y', 'false || less z']) {
    assert.equal(isReadCommand(cmd), true, cmd);
  }
  for (const cmd of ['npm test', 'sed -i s/a/b/ x', 'git log --oneline', 'git status', 'catalog x', 'grep cat x', 'ls -la', undefined]) {
    assert.equal(isReadCommand(cmd), false, String(cmd));
  }
});

test('logged text is split by source: brief, Read, Bash-read, Bash, Grep/Glob, Edit, other, attachments, own output', () => {
  const inputs = {
    read: { file_path: `${REPO}/core/rules.mjs` },
    sed: { command: `cd ${REPO} && sed -n 1,40p core/check.mjs` },
    piped: { command: 'npm test 2>&1 | tail -20' },
    test: { command: 'npm test' },
    grep: { pattern: 'roleOf', path: REPO },
    glob: { pattern: '**/*.mjs' },
    edit: { file_path: `${REPO}/core/rules.mjs`, old_string: 'a', new_string: 'b' },
    web: { url: 'https://example.com' },
  };
  const r = analyseTranscript([
    brief('BRIEF-TEXT'),
    ...call('Read', inputs.read, 'r'.repeat(100)),
    ...call('Bash', inputs.sed, 's'.repeat(50)),
    ...call('Bash', inputs.piped, 'p'.repeat(20)),
    ...call('Bash', inputs.test, 't'.repeat(30)),
    ...call('Grep', inputs.grep, 'g'.repeat(4)),
    ...call('Glob', inputs.glob, [{ type: 'text', text: 'abc' }]),
    ...call('Edit', inputs.edit, 'ok'),
    ...call('WebFetch', inputs.web, 'w'.repeat(9)),
    attachment('hook context'),
    assistant('msg_end', usage(1, 0, 0, 1), { type: 'thinking', thinking: 'think' }),
    assistant('msg_end', usage(1, 0, 0, 2), { type: 'text', text: 'done' }),
  ]);
  assert.deepEqual(r.src, {
    brief: 10, read: 100, 'bash-read': 70, bash: 30, search: 7, edit: 2, other: 9, attachment: 12,
    own: inputChars(...Object.values(inputs)) + 'think'.length + 'done'.length,
  });
  // A reading Bash command counts the files it names, as the repository names them.
  assert.deepEqual([...r.files], [['core/rules.mjs', 1], ['core/check.mjs', 1]]);
});

test('a Read overlaps when its range meets an earlier Read of the same file; disjoint ranges do not', () => {
  const a = `${REPO}/core/check.mjs`, b = `${REPO}/core/rules.mjs`;
  const r = analyseTranscript([
    brief('go'),
    ...call('Read', { file_path: a }, 'x'), // the whole file
    ...call('Read', { file_path: a, offset: 400, limit: 50 }, 'x'), // inside it: overlapping
    ...call('Read', { file_path: b, offset: 1, limit: 100 }, 'x'), // lines 1-100
    ...call('Read', { file_path: b, offset: 101, limit: 100 }, 'x'), // 101-200: disjoint
    ...call('Read', { file_path: b, offset: 150, limit: 10 }, 'x'), // inside the second: overlapping
  ]);
  assert.equal(r.readCalls, 5);
  assert.equal(r.overlappingReads, 2);
  assert.deepEqual([...r.files], [['core/check.mjs', 2], ['core/rules.mjs', 3]]);
  assert.equal(r.totalReads, 5);
  assert.equal(r.repeated, 3);
});

test('the crossing is the first request past 200 000, and the split after it counts only what came later', () => {
  const r = analyseTranscript([
    brief('go'),
    ...call('Read', { file_path: `${REPO}/a.md` }, 'r'.repeat(10), usage(1000, 50_000, 99_000, 10)), // 150 000
    ...call('Bash', { command: 'npm test' }, 'b'.repeat(20), usage(0, 0, 200_000, 10)), // exactly 200 000: not past it
    ...call('Read', { file_path: `${REPO}/b.md` }, 'r'.repeat(30), usage(5, 1000, 200_000, 10)), // 201 005: the crossing
    ...call('Bash', { command: 'cat c.md' }, 'c'.repeat(40), usage(1, 100, 201_000, 10)),
    { type: 'system', subtype: 'compact_boundary' },
  ]);
  assert.equal(r.requests, 4);
  assert.equal(r.peak, 201_101);
  assert.equal(r.crossing.at, 3);
  // The crossing request's own tool result lands after it, so it counts as after.
  assert.deepEqual(r.crossing.src, { read: 30, 'bash-read': 40, bash: 0, search: 0, edit: 0, other: 0 });
  assert.equal(r.compactions, 1);

  const quiet = analyseTranscript([brief('go'), ...call('Bash', { command: 'ls' }, 'x', usage(0, 0, 200_000, 1))]);
  assert.equal(quiet.crossing, null);

  const s = summarise([{ ...r, role: 'coder' }, { ...quiet, role: 'planner' }]);
  assert.deepEqual(s.crossed, { agents: 1, of: 2, at: [3], requests: [4], src: r.crossing.src });
  assert.deepEqual(s.byRole.map((t) => [t.role, t.crossed]), [['coder', 1], ['planner', 0]]);
  assert.equal(s.compactions, 1);
  assert.deepEqual(s.models, ['claude-opus-5-5']);
});

test('the role table names every source and reports means per agent; the lines under it follow', () => {
  const coder = (peak) => analyseTranscript([
    brief('go'),
    ...call('Read', { file_path: `${REPO}/core/a.mjs` }, 'r'.repeat(90), usage(0, 0, peak, 1)),
  ], { role: 'coder', description: 'Implement A' });
  const records = [coder(100_000), coder(300_000)];
  // Per agent: brief 2, Read 90, own output 55 (the Read input as JSON); 147 each, 294 in all.
  assert.equal(inputChars({ file_path: `${REPO}/core/a.mjs` }), 55);
  assert.deepEqual(renderMarkdown(summarise(records), records).split('\n'), [
    '| Role | Agents | Mean peak context (tokens) | Mean requests | Logged text by source (chars): brief · Read · Bash-read · Bash other · Grep/Glob · Edit · attachments · own output (thinking, text, tool inputs) | Read calls whose range overlaps an earlier Read of the same file | Crossed 200k |',
    '|---|---:|---:|---:|---|---:|---:|',
    '| coder | 2 | 200 000 | 1 | 1 % · 61 % · 0 % · 0 % · 0 % · 0 % · 0 % · 37 % (294) | 0 of 2 | 1 |',
    '',
    'planners — files read most (reads across all 0 agents): ',
    '',
    'coders — files read most (reads across all 2 agents): core/a.mjs ×2',
    '',
    'Crossed 200k: 1 of 2. After the crossing, logged input by source (chars), summed:',
    'read 100 % · bash-read 0 % · bash 0 % · search 0 % · edit 0 % · other 0 % (90 chars); crossing at request 1 of 1',
    'Compaction markers seen in sub-agent transcripts: 0. Models: claude-opus-5-5',
  ]);

  // Per agent, raw usage sums and no cost: the reader applies the prices.
  const table = renderMarkdown(summarise(records), records, { agents: true }).split('\n').slice(-4);
  assert.equal(table[0], '| Agent | Role | Model | Requests | Peak ctx | Fresh input tok Σ | Cache-write tok Σ | Cache-read tok Σ | Output tok Σ | Read | Bash-read | Bash | Own | Overlapping reads |');
  assert.equal(table[1].split('|').length, table[0].split('|').length);
  assert.equal(table[2], '| Implement A | coder | claude-opus-5-5 | 1 | 300 000 | 0 | 0 | 300 000 | 1 | 90 | 0 | 0 | 55 | 0/1 |');
});

test('the report carries no transcript content, no absolute path and no home directory', () => {
  const secret = 'SECRET-FILE-CONTENT';
  const lines = [
    brief(`Work in ${REPO}. ${secret}`),
    ...call('Read', { file_path: `${REPO}/core/rules.mjs` }, secret),
    ...call('Read', { file_path: '/home/someone/private/notes.md' }, secret),
    ...call('Read', { file_path: 'C:\\Users\\someone\\diary.md' }, secret),
    ...call('Read', { file_path: '~/todo.md' }, secret),
    ...call('Bash', { command: 'cat /home/someone/.claude/settings.json' }, secret),
    attachment(secret),
    assistant('msg_end', usage(1, 0, 0, 1), { type: 'text', text: secret }),
  ];
  const records = [{ id: 'a1', ...analyseTranscript(lines, { role: 'planner', description: 'Plan P1 from /home/someone/omelette-fleet/docs/spec.md' }) }];
  const md = renderMarkdown(summarise(records), records, { agents: true });
  assert.doesNotMatch(md, /\/home\/|someone|C:\\|~\/|SECRET/);
  assert.match(md, /: core\/rules\.mjs ×1 · <outside>\/notes\.md ×1 · <outside>\/diary\.md ×1 · <outside>\/todo\.md ×1 · <outside>\/settings\.json ×1$/m);
  assert.match(md, /^\| Plan P1 from spec\.md \| planner \|/m);
});

// The CLI, end to end, on a session laid out as Claude Code lays it out.
const roots = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
function sessionDir(files) {
  const root = mkdtempSync(join(tmpdir(), 'context-by-source-'));
  roots.push(root);
  mkdirSync(join(root, 'subagents'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
const notice = (id, description) => JSON.stringify({
  type: 'user',
  message: { content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "${description}" finished</summary>\n<usage><subagent_tokens>1000</subagent_tokens><tool_uses>1</tool_uses><duration_ms>60000</duration_ms></usage>\n</task-notification>` },
});
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('a .meta.json beside the transcript names the agent over the notification', () => {
  const agent = jsonl([brief('go'), ...call('Read', { file_path: '/home/someone/private/notes.md' }, 'x')]);
  const root = sessionDir({
    'session.jsonl': [notice('a1', 'Implement P1'), notice('a2', 'Plan P2'), notice('a3', 'Implement P3')].join('\n'),
    'subagents/agent-a1.jsonl': agent,
    'subagents/agent-a1.meta.json': JSON.stringify({ agentType: 'omelette-tester', description: '/omelette-test /home/someone/omelette-fleet/docs/spec.md', model: 'sonnet' }),
    'subagents/agent-a2.jsonl': agent, // no meta: the notification names it
    'subagents/agent-a3.jsonl': agent,
    'subagents/agent-a3.meta.json': '{ not json', // an unreadable meta: the notification still names it
    'subagents/agent-a4.jsonl': agent, // neither
    'subagents/agent-a5.jsonl': agent,
    'subagents/agent-a5.meta.json': JSON.stringify({ agentType: 'omelette-coder', description: 'Plan the widget, then build it', model: 'opus' }), // agentType beats the description's "Plan"
    'subagents/agent-a6.jsonl': agent,
    'subagents/agent-a6.meta.json': JSON.stringify({ agentType: 'omelette-coder-medium', description: 'Effort trial', model: 'opus' }), // an effort suffix is still the coder
  });
  const json = run(join(root, 'session.jsonl'), join(root, 'subagents'), '--json');
  assert.equal(json.status, 0, json.stderr);
  const { records } = JSON.parse(json.stdout);
  assert.deepEqual(Object.fromEntries(records.map((r) => [r.id, [r.role, r.description]])), {
    a1: ['tester', '/omelette-test spec.md'], a2: ['planner', 'Plan P2'], a3: ['coder', 'Implement P3'], a4: ['unknown', ''],
    a5: ['coder', 'Plan the widget, then build it'], a6: ['coder', 'Effort trial'],
  });
  assert.deepEqual(records.find((r) => r.id === 'a1').files, { '<outside>/notes.md': 1 });

  const md = run(join(root, 'session.jsonl'), join(root, 'subagents'), '--agents');
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /^\| Role \| Agents \|/);
  for (const out of [json.stdout, md.stdout]) {
    assert.ok(!out.includes(root), 'no temp path in the output');
    assert.doesNotMatch(out, /\/home\/|someone/);
  }
});

test('without both arguments the CLI prints its usage and exits 2', () => {
  const r = run('only-one.jsonl');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^usage: node scripts\/context-by-source\.mjs <session\.jsonl> <subagents dir> \[--agents\] \[--json\]/);
});

test('--before keeps only transcripts whose first entry is older than the date', () => {
  const old = jsonl([{ ...brief('go'), timestamp: '2026-09-10T10:00:00.000Z' }, ...call('Read', { file_path: '/home/someone/omelette-fleet/a.mjs' }, 'x')]);
  const fresh = jsonl([{ ...brief('go'), timestamp: '2026-09-20T10:00:00.000Z' }, ...call('Read', { file_path: '/home/someone/omelette-fleet/b.mjs' }, 'x')]);
  const root = sessionDir({ 'session.jsonl': notice('a1', 'Implement P1') + '\n' + notice('a2', 'Implement P2'), 'subagents/agent-a1.jsonl': old, 'subagents/agent-a2.jsonl': fresh });
  const cut = run(join(root, 'session.jsonl'), join(root, 'subagents'), '--json', '--before', '2026-09-18');
  assert.equal(cut.status, 0, cut.stderr);
  assert.deepEqual(JSON.parse(cut.stdout).records.map((r) => r.id), ['a1']);
  const all = run(join(root, 'session.jsonl'), join(root, 'subagents'), '--json');
  assert.equal(JSON.parse(all.stdout).records.length, 2);
  const bare = run(join(root, 'session.jsonl'), join(root, 'subagents'), '--before');
  assert.equal(bare.status, 2, 'a --before without a date is a usage error');
  // Dates compare as instants, not strings: a cutoff with a timezone offset still cuts at the right moment.
  const offset = run(join(root, 'session.jsonl'), join(root, 'subagents'), '--json', '--before', '2026-09-10T11:30:00+02:00'); // = 09:30Z, before a1's 10:00Z
  assert.deepEqual(JSON.parse(offset.stdout).records.map((r) => r.id), [], 'a1 (10:00Z) is not older than 09:30Z');
});

test('a transcript line that is valid JSON but not an entry (null, a number, an array) is an error naming file and physical line, never a stack trace', () => {
  const root = sessionDir({ 'session.jsonl': '', 'subagents/agent-a1.jsonl': `${JSON.stringify(brief('go'))}\n\nnull\n` });
  const out = run(join(root, 'session.jsonl'), join(root, 'subagents'));
  assert.equal(out.status, 2);
  assert.match(out.stderr, /agent-a1\.jsonl line 3 is not a transcript entry/, 'the physical line, blank lines counted');
  assert.doesNotMatch(out.stderr, /at .*\.mjs|file:\/\//, 'no stack trace, no path of this checkout');
  assert.ok(!out.stderr.includes(root));
});

test('a null or scalar content block is skipped, never an uncaught throw', () => {
  const entries = [brief('go'), { type: 'assistant', message: { id: 'r1', model: 'm', usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }, content: [null, 7, { type: 'text', text: 'ok' }] } },
    { type: 'user', message: { role: 'user', content: [null, { type: 'tool_result', tool_use_id: 'none', content: 'x' }] } }];
  const r = analyseTranscript(entries, { role: 'coder', description: '' });
  assert.equal(r.requests, 1);
  assert.equal(r.src.own, 2);
});

test('a .meta.json with agentType and no description still names the role', () => {
  const agent = jsonl([brief('go')]);
  const root = sessionDir({ 'session.jsonl': '', 'subagents/agent-a1.jsonl': agent, 'subagents/agent-a1.meta.json': JSON.stringify({ agentType: 'omelette-tester' }) });
  const json = run(join(root, 'session.jsonl'), join(root, 'subagents'), '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).records.map((r) => [r.id, r.role, r.description]), [['a1', 'tester', '']]);
});
