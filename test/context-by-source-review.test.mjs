// Independent review of scripts/context-by-source.mjs against the P0 section
// of docs/superpowers/specs/2026-09-20-1.2.0-context-design.md. Synthetic
// transcripts only, built here; none of this reuses the coder's assertions.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseTranscript, isReadCommand, renderMarkdown, summarise } from '../scripts/context-by-source.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'context-by-source.mjs');
// A synthetic home, never the tester's real one.
const REPO = '/home/someone/omelette-fleet';

const use = (input, cacheWrite, cacheRead, output) => ({ input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output });
const userBrief = (content) => ({ type: 'user', message: { role: 'user', content } });
const asst = (id, u, block) => ({ type: 'assistant', message: { id, model: 'claude-opus-5-5', role: 'assistant', usage: u, content: [block] } });
const toolResult = (id, content) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const attach = (content) => ({ type: 'attachment', attachment: { type: 'hook_additional_context', content } });

// One request = one tool call: an assistant message with a tool_use block,
// followed by the user turn carrying its tool_result. Each call gets its own
// message id, so each is its own API request.
let callCount = 0;
function invoke(name, input, resultText, usage = use(1, 0, 0, 1)) {
  callCount += 1;
  const toolId = `tool_${callCount}`;
  return [asst(`req_${callCount}`, usage, { type: 'tool_use', id: toolId, name, input }), toolResult(toolId, resultText)];
}

const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
const notice = (id, description) => JSON.stringify({
  type: 'user',
  message: { content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "${description}" finished</summary>\n<usage><subagent_tokens>1000</subagent_tokens><tool_uses>1</tool_uses><duration_ms>60000</duration_ms></usage>\n</task-notification>` },
});

const roots = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
function makeSessionDir() {
  const root = mkdtempSync(join(tmpdir(), 'cbs-review-'));
  roots.push(root);
  mkdirSync(join(root, 'subagents'));
  return root;
}
const runCli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

// --- (1) one API request = one message.id; context and output ------------

test('one API request is one message.id across several transcript entries: context is input+cache_creation+cache_read, output is the largest value seen for the id', () => {
  const r = analyseTranscript([
    userBrief('go'),
    asst('reqA', use(10, 200, 2300, 12), { type: 'thinking', thinking: 'thinking about it' }),
    asst('reqA', use(10, 200, 2300, 12), { type: 'text', text: 'partial' }),
    asst('reqA', use(10, 200, 2300, 77), { type: 'text', text: 'final answer' }), // same request: output climbs to 77
    asst('reqB', use(4, 0, 2596, 9), { type: 'text', text: 'second request' }),
  ]);
  assert.equal(r.requests, 2, 'two distinct message ids means two requests, not five blocks');
  assert.equal(r.peak, 2600, 'peak context is the larger of the two requests (10+200+2300=2510 vs 4+0+2596=2600)');
  assert.deepEqual(r.usage, { input: 14, cacheWrite: 200, cacheRead: 4896, output: 86 });
});

// --- (2) the 200k crossing and the after-crossing split -------------------

test('the crossing is the first request whose context passes 200 000; the after-crossing split by source counts only tool results that came later', () => {
  const entries = [
    userBrief('start'),
    ...invoke('Read', { file_path: `${REPO}/one.md` }, 'R'.repeat(500), use(1000, 50_000, 99_000, 10)), // context 150 000: before
    ...invoke('Bash', { command: 'cat two.md' }, 'B'.repeat(300), use(0, 0, 200_000, 10)), // context exactly 200 000: not past it
    ...invoke('Read', { file_path: `${REPO}/three.md` }, 'C'.repeat(77), use(5_000, 100_000, 100_000, 10)), // context 205 000: the crossing, request 3
    ...invoke('Grep', { pattern: 'x' }, 'G'.repeat(9), use(1, 0, 205_500, 5)),
    ...invoke('Edit', { file_path: `${REPO}/three.md`, old_string: 'a', new_string: 'b' }, 'ok', use(1, 0, 205_600, 5)),
  ];
  const r = analyseTranscript(entries);
  assert.equal(r.requests, 5);
  assert.equal(r.crossing.at, 3, 'the request that first exceeds 200 000, not the count of everything seen so far');
  assert.deepEqual(r.crossing.src, { read: 77, 'bash-read': 0, bash: 0, search: 9, edit: 2, other: 0 },
    'bash-read from the pre-crossing call (300 chars) is excluded; only the crossing request\'s own result (77) and what came after are counted');
  // The full-transcript totals still include the pre-crossing text: the split
  // is only a property of `crossing`, not a change to `src`.
  assert.equal(r.src.read, 577, 'total read chars (500 before + 77 at the crossing) are unaffected by the after-crossing split');
  assert.equal(r.src['bash-read'], 300, 'the pre-crossing bash-read is still counted in the transcript total');

  const quiet = analyseTranscript([userBrief('go'), ...invoke('Bash', { command: 'ls' }, 'x', use(0, 0, 199_999, 1))]);
  assert.equal(quiet.crossing, null, 'never crossing 200 000 means no crossing record at all');
});

// --- (3) Bash reading classification --------------------------------------

test('Bash reading classification: piping into a non-reading command still reads; grep alone does not; git diff reads; sed -n reads; sed -i does not', () => {
  assert.equal(isReadCommand('cat x | grep y'), true, 'the first pipeline segment (cat x) is a reading command');
  assert.equal(isReadCommand('grep y x'), false, 'grep on its own is a search, not a read');
  assert.equal(isReadCommand('git diff'), true);
  assert.equal(isReadCommand('sed -n 5,9p f'), true);
  assert.equal(isReadCommand('sed -i'), false, 'sed -i writes; only sed -n reads');
});

// --- (4) overlapping Read ranges -------------------------------------------

test('overlapping Reads: a whole-file read then a range inside it overlaps; adjacent ranges do not; a different file with the identical range never overlaps', () => {
  const a = `${REPO}/a.mjs`, b = `${REPO}/b.mjs`, c = `${REPO}/c.mjs`;
  const r = analyseTranscript([
    userBrief('go'),
    ...invoke('Read', { file_path: a }, 'x'), // whole file: [1, Infinity)
    ...invoke('Read', { file_path: a, offset: 10, limit: 5 }, 'x'), // [10,15) inside it: overlaps
    ...invoke('Read', { file_path: b, offset: 1, limit: 49 }, 'x'), // [1,50)
    ...invoke('Read', { file_path: b, offset: 50, limit: 50 }, 'x'), // [50,100): adjacent, disjoint
    ...invoke('Read', { file_path: c, offset: 1, limit: 49 }, 'x'), // [1,50) again, but a different file
  ]);
  assert.equal(r.readCalls, 5);
  assert.equal(r.overlappingReads, 1, 'only the a.mjs range-inside-whole-file counts; b.mjs ranges are disjoint and c.mjs is a different file entirely, even with the same numeric range as b.mjs');
  assert.deepEqual([...r.files], [['a.mjs', 2], ['b.mjs', 2], ['c.mjs', 1]]);
});

// --- (5) attachments and own output are separate, never "reading" ---------

test('attachments and the agent\'s own output are their own sources and are never counted as reading', () => {
  const readInput = { file_path: `${REPO}/read.md` };
  const r = analyseTranscript([
    userBrief('BRIEF'),
    ...invoke('Read', readInput, 'R'.repeat(40)),
    attach('A'.repeat(30)),
    asst('reqThink', use(1, 0, 0, 1), { type: 'thinking', thinking: 'T'.repeat(10) }),
    asst('reqThink', use(1, 0, 0, 2), { type: 'text', text: 'X'.repeat(11) }),
  ]);
  const ownFromReadCall = JSON.stringify(readInput).length; // the tool_use input JSON also counts as the agent's own output
  assert.equal(r.src.read, 40);
  assert.equal(r.src.attachment, 30);
  assert.equal(r.src.own, ownFromReadCall + 10 + 11);
  assert.equal(r.src.brief, 5);
  // Nothing leaked into a reading bucket or any other bucket.
  assert.deepEqual({ bash: r.src.bash, 'bash-read': r.src['bash-read'], search: r.src.search, edit: r.src.edit, other: r.src.other }, { bash: 0, 'bash-read': 0, search: 0, edit: 0, other: 0 });
});

// --- (6) .meta.json wins over the notification -----------------------------

test('.meta.json beside a transcript wins over the session\'s task notification for role and description, and the description is sanitised', () => {
  const root = makeSessionDir();
  const agentLines = jsonl([userBrief('go'), ...invoke('Read', { file_path: `${REPO}/x.mjs` }, 'x')]);
  writeFileSync(join(root, 'session.jsonl'), [notice('m1', 'Plan the wrong thing'), notice('m2', 'Plan the wrong thing too')].join('\n'));
  writeFileSync(join(root, 'subagents', 'agent-m1.jsonl'), agentLines);
  writeFileSync(join(root, 'subagents', 'agent-m1.meta.json'), JSON.stringify({ agentType: 'omelette-coder', description: `Implement in ${REPO}/core/target.mjs`, model: 'opus' }));
  writeFileSync(join(root, 'subagents', 'agent-m2.jsonl'), agentLines); // no meta.json: falls back to the notification

  const out = runCli(join(root, 'session.jsonl'), join(root, 'subagents'), '--json');
  assert.equal(out.status, 0, out.stderr);
  const { records } = JSON.parse(out.stdout);
  const m1 = records.find((r) => r.id === 'm1');
  const m2 = records.find((r) => r.id === 'm2');
  assert.equal(m1.role, 'coder', 'the notification said "Plan…" (planner); the meta.json description says otherwise and wins');
  assert.equal(m1.description, 'Implement in target.mjs', 'the meta.json description is sanitised: the absolute path is cut to its basename');
  assert.equal(m2.role, 'planner');
  assert.equal(m2.description, 'Plan the wrong thing too', 'no meta.json: the notification is used as-is');
});

// --- (7) privacy: no absolute path, no home dir; outside-repo reads --------

test('the rendered markdown never contains an absolute path or the home directory; a Read outside the repository prints <outside>/basename', () => {
  const lines = [
    userBrief(`Work under ${REPO}. plain instructions`),
    ...invoke('Read', { file_path: `${REPO}/core/inside.mjs` }, 'ok'),
    ...invoke('Read', { file_path: '/home/someone/.ssh/config' }, 'ok'),
  ];
  const rec = { id: 'p1', ...analyseTranscript(lines, { role: 'coder', description: 'Implement things' }) };
  const md = renderMarkdown(summarise([rec]), [rec]);
  assert.doesNotMatch(md, /\/home\//, 'no absolute path leaks into the rendered report');
  assert.doesNotMatch(md, /someone/, 'no home-directory username leaks either');
  assert.match(md, /<outside>\/config/, 'a file outside the repository is reduced to <outside>/basename');
  assert.match(md, /core\/inside\.mjs/, 'a file inside the repository keeps its repo-relative name');
});

// --- (8) a malformed JSON line stops the tool, naming file+line, not content

test('a malformed JSON line stops the tool with an error naming the file\'s basename and the line number, never the line\'s content', () => {
  const root = makeSessionDir();
  writeFileSync(join(root, 'session.jsonl'), '');
  const secret = 'SECRET-MARKER-DO-NOT-LEAK';
  writeFileSync(join(root, 'subagents', 'agent-bad1.jsonl'), `${JSON.stringify(userBrief('ok'))}\nnot-json-${secret}\n`);
  const out = runCli(join(root, 'session.jsonl'), join(root, 'subagents'));
  assert.equal(out.status, 2);
  assert.match(out.stderr, /agent-bad1\.jsonl/, 'names the transcript\'s basename');
  assert.match(out.stderr, /line 2/, 'names the 1-based line number of the bad entry');
  assert.doesNotMatch(out.stderr, new RegExp(secret), 'never echoes the malformed line\'s content');
  assert.doesNotMatch(out.stdout, new RegExp(secret));
});

// --- (9) CLI argument handling ---------------------------------------------

test('CLI: no arguments at all exits 2 with a usage line', () => {
  const out = runCli();
  assert.equal(out.status, 2);
  assert.match(out.stderr, /^usage: node scripts\/context-by-source\.mjs <session\.jsonl> <subagents dir> \[--agents\] \[--json\]/);
});

test('CLI: --json prints output that parses as JSON, with a summary and records', () => {
  const root = makeSessionDir();
  writeFileSync(join(root, 'session.jsonl'), '');
  writeFileSync(join(root, 'subagents', 'agent-j1.jsonl'), jsonl([userBrief('go'), ...invoke('Read', { file_path: `${REPO}/x.mjs` }, 'x')]));
  const out = runCli(join(root, 'session.jsonl'), join(root, 'subagents'), '--json');
  assert.equal(out.status, 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  assert.ok(parsed.summary, 'top-level summary key');
  assert.ok(Array.isArray(parsed.records), 'top-level records array');
});
