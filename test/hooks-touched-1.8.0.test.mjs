/**
 * omelette-fleet :: test/hooks-touched-1.8.0.test.mjs
 * 1.8.0 task 5, the touched record: SubagentStop for a guarded role reads the
 * agent's transcript and writes `.omelette/reports/touched-<role>-<id8>.md`.
 * Driven as Claude Code drives the guard — a child process, the event on stdin.
 * The transcript must lie under `~/.claude/projects` or
 * `$CLAUDE_CONFIG_DIR/projects`, so each test builds a home of its own.
 *
 * The 2 s deadline has no row: a slow regular file is not reproducible here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcript-touched.jsonl');
const ID = 'abcdef0123456789';

function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3'));
  return path;
}

function fire(path, event, cwd, env) {
  const r = spawnSync(process.execPath, [path], { input: JSON.stringify(event), encoding: 'utf8', cwd, timeout: 30000, env });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/** A temp root holding a home, its `.claude/projects/-proj/s-1/subagents`, and a project with `.omelette/`. */
function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-touched-')));
  const home = join(root, 'home');
  const subagents = join(home, '.claude', 'projects', '-proj', 's-1', 'subagents');
  mkdirSync(subagents, { recursive: true });
  const proj = join(root, 'proj');
  mkdirSync(join(proj, '.omelette'), { recursive: true });
  return { root, home, subagents, proj, env: { PATH: process.env.PATH, HOME: home } };
}

const stopEvent = (proj, transcript, agent = 'omelette-coder') => ({
  hook_event_name: 'SubagentStop', cwd: proj, agent_id: ID, agent_transcript_path: transcript, ...(agent ? { agent_type: agent } : {}),
});

const recordPath = (proj, agent = 'omelette-coder') => join(proj, '.omelette', 'reports', `touched-${agent}-${ID.slice(0, 8)}.md`);

/** One transcript line holding one tool use, as the harness writes it. */
const useLine = (id, name, input) => JSON.stringify({ type: 'assistant', isSidechain: true, agentId: ID, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });

test('touched: the fixture transcript yields every written path once, the skipped lines and the tool counts', () => {
  const g = guard();
  const s = sandbox();
  const transcript = join(s.subagents, `agent-${ID}.jsonl`);
  // The over-1-MB line is built here, not kept in the repository, and put
  // first: everything the record lists is read after the reader skipped it.
  const long = useLine('toolu_99', 'Write', { file_path: 'too-long.txt', content: ' '.repeat(Math.ceil(1.1 * 1024 * 1024)) });
  writeFileSync(transcript, `${long}\n${readFileSync(FIXTURE, 'utf8')}`);
  const r = fire(g, stopEvent(s.proj, transcript), s.proj, s.env);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '', 'no stdout, no additionalContext');
  assert.equal(r.err, '');
  // The long line holds a Write of too-long.txt and the malformed one a Write
  // of malformed.txt: neither is read. The api-request-blob record repeats
  // toolu_01 and toolu_02 by id and is not counted twice. `make 2>/dev/null
  // >/dev/stderr` is a Bash call whose writes touch nothing: counted, not listed.
  const text = readFileSync(recordPath(s.proj), 'utf8');
  assert.doesNotMatch(text, /\/dev\//, text);
  assert.equal(text, [
    `# touched — omelette-coder ${ID}`,
    '',
    `transcript: ${transcript}`,
    'skipped: 2 lines (malformed, over 1 MB)',
    '',
    '- a.txt (bash write)',
    '- src/one.js (Write)',
    '- b.txt (bash append)',
    '- src/two.js (Write)',
    '- /tmp/omelette-touched/nb.ipynb (NotebookEdit)',
    '',
    'tool calls: 9 (Bash: 4, Write: 2, Edit: 2, NotebookEdit: 1)',
    '',
  ].join('\n'));
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: a transcript outside ~/.claude/projects, or reached through a symlink, is one stderr line and no record', () => {
  const g = guard();
  const s = sandbox();
  const outside = join(s.root, 'elsewhere');
  mkdirSync(outside);
  copyFileSync(FIXTURE, join(outside, 'agent.jsonl'));
  mkdirSync(join(s.home, '.claude', 'projects-evil'));
  copyFileSync(FIXTURE, join(s.home, '.claude', 'projects-evil', 'agent.jsonl'));
  symlinkSync(join(outside, 'agent.jsonl'), join(s.subagents, 'linked.jsonl'));
  for (const transcript of [
    join(outside, 'agent.jsonl'),
    `${join(s.home, '.claude', 'projects')}/../../../elsewhere/agent.jsonl`, // folded before the check
    join(s.home, '.claude', 'projects-evil', 'agent.jsonl'), //             a sibling sharing the prefix
    join(s.subagents, 'linked.jsonl'), //                                   O_NOFOLLOW on the open
  ]) {
    const r = fire(g, stopEvent(s.proj, transcript), s.proj, s.env);
    assert.equal(r.code, 0, `${transcript}: ${r.err}`);
    assert.equal(r.out, '', transcript);
    assert.equal(r.err.trim().split('\n').length, 1, `${transcript}: ${r.err}`);
    assert.match(r.err, /^omelette-guard: /, transcript);
    assert.equal(existsSync(recordPath(s.proj)), false, transcript);
  }
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: a 17 MB transcript is read for its first 16 MB, under $CLAUDE_CONFIG_DIR/projects', () => {
  const g = guard();
  const s = sandbox();
  const config = join(s.root, 'config');
  const dir = join(config, 'projects', '-proj', 's-1', 'subagents');
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, `agent-${ID}.jsonl`);
  const fd = openSync(transcript, 'w');
  let size = 0;
  const put = (line) => { size += writeSync(fd, `${line}\n`); };
  put(useLine('t1', 'Write', { file_path: 'x.txt', content: 'x' }));
  put(useLine('t2', 'Bash', { command: 'echo y > y.txt' }));
  const filler = JSON.stringify({ type: 'progress', pad: ' '.repeat(1000000) });
  while (size < 17 * 1024 * 1024) put(filler);
  put(useLine('t3', 'Write', { file_path: 'past-the-cap.txt', content: 'z' }));
  closeSync(fd);

  // HOME's own projects directory exists too; the transcript is under the config dir's.
  const r = fire(g, stopEvent(s.proj, transcript), s.proj, { ...s.env, CLAUDE_CONFIG_DIR: config });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  const lines = readFileSync(recordPath(s.proj), 'utf8').split('\n');
  assert.ok(lines.includes("skipped: the file's bytes past 16 MB"), lines.join('\n'));
  assert.ok(lines.includes('- x.txt (Write)'), lines.join('\n'));
  assert.ok(lines.includes('- y.txt (bash write)'), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('past-the-cap.txt')), lines.join('\n'));
  assert.ok(lines.includes('tool calls: 2 (Write: 1, Bash: 1)'), lines.join('\n'));
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: an agent that is not a guarded role, or the main thread, writes nothing', () => {
  const g = guard();
  const s = sandbox();
  const transcript = join(s.subagents, `agent-${ID}.jsonl`);
  copyFileSync(FIXTURE, transcript);
  for (const agent of ['general-purpose', 'omelette-coder-2', null]) { // null: the main thread, no agent_type
    const r = fire(g, stopEvent(s.proj, transcript, agent), s.proj, s.env);
    assert.equal(r.code, 0, `${agent}: ${r.err}`);
    assert.equal(r.out, '', String(agent));
    assert.equal(existsSync(join(s.proj, '.omelette', 'reports')), false, String(agent));
  }
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: tee, sed -i, mv and cp are bash writes of their targets; a command too deep to read is counted under skipped', () => {
  const g = guard();
  const s = sandbox();
  const transcript = join(s.subagents, `agent-${ID}.jsonl`);
  writeFileSync(transcript, `${[
    useLine('b1', 'Bash', { command: 'echo x | tee a.txt' }),
    useLine('b2', 'Bash', { command: "sed -i '' s/x/y/ b.txt" }),
    useLine('b3', 'Bash', { command: 'mv c d.txt' }),
    useLine('b4', 'Bash', { command: 'cp e f.txt' }),
    useLine('b5', 'Bash', { command: `${'a['.repeat(100000)}; cat > g.txt` }),
  ].join('\n')}\n`);
  const r = fire(g, stopEvent(s.proj, transcript, 'omelette-tester'), s.proj, s.env);
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(recordPath(s.proj, 'omelette-tester'), 'utf8');
  assert.deepEqual(text.split('\n').filter((l) => l.startsWith('- ')), [
    '- a.txt (bash write)', '- b.txt (bash write)', '- d.txt (bash write)', '- f.txt (bash write)',
  ], text);
  assert.ok(text.split('\n').includes('skipped: 1 command too deep to read'), text);
  assert.ok(text.split('\n').includes('tool calls: 5 (Bash: 5)'), text);
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: after a cd the path is listed as written, resolved against the event cwd, and says `after cd`', () => {
  const g = guard();
  const s = sandbox();
  const transcript = join(s.subagents, `agent-${ID}.jsonl`);
  writeFileSync(transcript, `${[
    useLine('c1', 'Bash', { command: 'cd src && echo x > a.txt' }),
    useLine('c2', 'Bash', { command: 'cd src && echo x > sub/b.txt' }),
    useLine('c3', 'Bash', { command: 'cd /tmp/scratch; rm -f logs/*' }),
    useLine('c4', 'Bash', { command: 'echo y > c.txt; cd src' }), //                  the cd comes after the write
    useLine('c5', 'Bash', { command: 'cd src && echo x > /tmp/omelette-abs.txt' }), // an absolute path is known
  ].join('\n')}\n`);
  const r = fire(g, stopEvent(s.proj, transcript), s.proj, s.env);
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(recordPath(s.proj), 'utf8');
  assert.deepEqual(text.split('\n').filter((l) => l.startsWith('- ')), [
    '- a.txt (bash write, after cd)',
    '- sub/b.txt (bash write, after cd)',
    '- logs/* (bash write, after cd)',
    '- c.txt (bash write)',
    '- /tmp/omelette-abs.txt (bash write)',
  ], text);
  rmSync(s.root, { recursive: true, force: true });
});
