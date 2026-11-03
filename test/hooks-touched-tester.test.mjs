/**
 * omelette-fleet :: test/hooks-touched-tester.test.mjs
 * 1.8.0 task 5, the touched record — the tester's rows, beside the coder's
 * (hooks-touched-1.8.0.test.mjs): the exact edges of both caps, the 2 s clock
 * (driven by a Date.now preload, so no row waits on a slow file), the shapes a
 * transcript line may take, the paths that must not be written through, and the
 * names a record may carry. The guard is rendered and run as a child process,
 * the event on stdin, the way Claude Code runs it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

const ID = 'abcdef0123456789';

function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3'));
  return path;
}

function fire(path, event, cwd, env, timeout = 60000) {
  const r = spawnSync(process.execPath, [path], { input: JSON.stringify(event), encoding: 'utf8', cwd, timeout, env });
  assert.equal(r.signal, null, `the guard hung or died: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-touched-t-')));
  const home = join(root, 'home');
  const subagents = join(home, '.claude', 'projects', '-proj', 's-1', 'subagents');
  mkdirSync(subagents, { recursive: true });
  const proj = join(root, 'proj');
  mkdirSync(join(proj, '.omelette'), { recursive: true });
  return { root, home, subagents, proj, transcript: join(subagents, `agent-${ID}.jsonl`), env: { PATH: process.env.PATH, HOME: home } };
}

const stop = (s, over = {}) => ({ hook_event_name: 'SubagentStop', cwd: s.proj, agent_id: ID, agent_type: 'omelette-coder', agent_transcript_path: s.transcript, ...over });
const recordFile = (s, agent = 'omelette-coder', id = ID) => join(s.proj, '.omelette', 'reports', `touched-${agent}-${id.slice(0, 8)}.md`);
const useLine = (id, name, input) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const pathLines = (text) => text.split('\n').filter((l) => l.startsWith('- '));
const lines = (text) => text.split('\n');

/** The guard said one stderr line, no stdout, exited 0 — and wrote no record. */
function assertOneLineNoRecord(r, s, label, agent = 'omelette-coder') {
  assert.equal(r.code, 0, `${label}: ${r.err}`);
  assert.equal(r.out, '', label);
  assert.equal(r.err.split('\n').filter(Boolean).length, 1, `${label}: ${r.err}`);
  assert.match(r.err, /^omelette-guard: .* — no touched record for omelette-coder\n$/, label);
  assert.equal(existsSync(recordFile(s, agent)), false, label);
}

test('touched: a transcript with no tool use, or an empty one, is a record with no path lines and `tool calls: 0`', () => {
  const g = guard();
  const s = sandbox();
  for (const body of ['', '\n\n  \n', `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })}\n`]) {
    writeFileSync(s.transcript, body);
    const r = fire(g, stop(s), s.proj, s.env);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, '');
    assert.equal(readFileSync(recordFile(s), 'utf8'), `# touched — omelette-coder ${ID}\n\ntranscript: ${s.transcript}\n\ntool calls: 0\n`, JSON.stringify(body));
  }
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: a line of exactly 1 MiB is read, one byte more is skipped and counted', () => {
  const g = guard();
  const s = sandbox();
  const sized = (bytes) => {
    const bare = useLine('big', 'Write', { file_path: 'big.txt', content: '' });
    const line = useLine('big', 'Write', { file_path: 'big.txt', content: 'x'.repeat(bytes - Buffer.byteLength(bare)) });
    assert.equal(Buffer.byteLength(line), bytes);
    return line;
  };
  for (const [bytes, listed, skipped] of [[1024 * 1024, true, null], [1024 * 1024 + 1, false, 'skipped: 1 line (malformed, over 1 MB)']]) {
    writeFileSync(s.transcript, `${useLine('t1', 'Write', { file_path: 'before.txt' })}\n${sized(bytes)}\n${useLine('t2', 'Write', { file_path: 'after.txt' })}\n`);
    const r = fire(g, stop(s), s.proj, s.env);
    assert.equal(r.code, 0, r.err);
    const text = readFileSync(recordFile(s), 'utf8');
    assert.equal(pathLines(text).includes('- big.txt (Write)'), listed, `${bytes}: ${text}`);
    assert.equal(lines(text).find((l) => l.startsWith('skipped:')) || null, skipped, `${bytes}: ${text}`);
    assert.ok(pathLines(text).includes('- before.txt (Write)') && pathLines(text).includes('- after.txt (Write)'), `${bytes}: the lines around it are read: ${text}`);
    assert.ok(lines(text).includes(`tool calls: ${listed ? 3 : 2} (Write: ${listed ? 3 : 2})`), `${bytes}: ${text}`);
  }
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: CRLF lines, a final line with no newline, a line over many chunks and a UTF-8 character cut by a chunk edge are all read', () => {
  const g = guard();
  const s = sandbox();
  // CRLF and an unterminated last line.
  writeFileSync(s.transcript, [useLine('c1', 'Write', { file_path: 'crlf-one.txt' }), useLine('c2', 'Bash', { command: 'echo > crlf-two.txt' })].join('\r\n') + '\r\n' + useLine('c3', 'Write', { file_path: 'no-newline.txt' }));
  let r = fire(g, stop(s), s.proj, s.env);
  assert.equal(r.code, 0, r.err);
  let text = readFileSync(recordFile(s), 'utf8');
  assert.deepEqual(pathLines(text), ['- crlf-one.txt (Write)', '- crlf-two.txt (bash write)', '- no-newline.txt (Write)'], text);
  assert.ok(lines(text).includes('tool calls: 3 (Write: 2, Bash: 1)'), text);
  assert.ok(!lines(text).some((l) => l.startsWith('skipped:')), text);

  // A 300 KB line (five chunks), then a record whose 4-byte character starts 1..3 bytes before the 64 KB edge.
  for (const before of [1, 2, 3]) {
    const head = '{"message":{"content":[{"type":"tool_use","id":"m","name":"Write","input":{"file_path":"';
    const line = `${head}${'x'.repeat(65536 - Buffer.byteLength(head) - before)}😀é.txt"}}]}}\n`;
    assert.equal(Buffer.from(line).indexOf(Buffer.from('😀')), 65536 - before, 'the emoji straddles the edge');
    writeFileSync(s.transcript, `${line}${useLine('long', 'Write', { file_path: 'spanning.txt', content: 'y'.repeat(300000) })}\n`);
    r = fire(g, stop(s), s.proj, s.env);
    text = readFileSync(recordFile(s), 'utf8');
    assert.ok(text.includes('😀é.txt (Write)'), `${before}: ${text.slice(-300)}`);
    assert.ok(!text.includes('�'), `${before}: no replacement character`);
    assert.ok(pathLines(text).includes('- spanning.txt (Write)'), `${before}: ${text.slice(-300)}`);
  }
  rmSync(s.root, { recursive: true, force: true });
});

/** A transcript of exactly `size` bytes: the first record, fillers, then `last` with no newline at the end. */
function transcriptOf(size, last) {
  const first = `${useLine('first', 'Write', { file_path: 'first.txt' })}\n`;
  const room = size - Buffer.byteLength(first) - Buffer.byteLength(last);
  const step = 500000;
  const FRAME = Buffer.byteLength('{"type":"progress","pad":""}\n'); // the bytes a filler line spends besides its padding
  const filler = (n) => `{"type":"progress","pad":"${'x'.repeat(n - FRAME)}"}\n`;
  const parts = [first];
  let left = room;
  while (left > step + 100) { parts.push(filler(step)); left -= step; }
  parts.push(filler(left));
  parts.push(last);
  const buf = Buffer.from(parts.join(''));
  assert.equal(buf.length, size);
  return buf;
}

test('touched: the 16 MiB cap is exact — a record ending on the last byte is read and nothing is skipped, one byte more skips it', () => {
  const g = guard();
  const s = sandbox();
  const cap = 16 * 1024 * 1024;
  const last = useLine('last', 'Write', { file_path: 'last.txt' });
  writeFileSync(s.transcript, transcriptOf(cap, last));
  let r = fire(g, stop(s), s.proj, s.env);
  assert.equal(r.code, 0, r.err);
  let text = readFileSync(recordFile(s), 'utf8');
  assert.deepEqual(pathLines(text), ['- first.txt (Write)', '- last.txt (Write)'], text.slice(-400));
  assert.ok(!lines(text).some((l) => l.startsWith('skipped:')), text.slice(-400));

  writeFileSync(s.transcript, transcriptOf(cap + 1, `${last}\n`));
  r = fire(g, stop(s), s.proj, s.env);
  assert.equal(r.code, 0, r.err);
  text = readFileSync(recordFile(s), 'utf8');
  assert.deepEqual(pathLines(text), ['- first.txt (Write)'], 'the line the cap cut is not read');
  assert.ok(lines(text).includes("skipped: the file's bytes past 16 MB"), text.slice(-400));
  assert.ok(lines(text).includes('tool calls: 1 (Write: 1)'), text.slice(-400));
  rmSync(s.root, { recursive: true, force: true });
});

/** A preload for `node --import`: Date.now moves 3 s forward on every call, so any later check of the clock finds it expired. */
function clockPreload(dir) {
  const path = join(dir, 'fast-clock.mjs');
  writeFileSync(path, 'const real = Date.now; let calls = 0; Date.now = () => real() + 3000 * calls++;\n');
  return path;
}

test('touched: the 2 s clock stops the read between chunks and the record says so; what was read before it stays', () => {
  const g = guard();
  const s = sandbox();
  const preload = clockPreload(s.root);
  // Chunk 1 (64 KB) holds one record and padding; the record after it lies in a later chunk.
  const early = `${useLine('e1', 'Write', { file_path: 'early.txt' })}\n`;
  const pad = `{"type":"progress","pad":"${'x'.repeat(65536)}"}\n`;
  writeFileSync(s.transcript, `${early}${pad}${useLine('l1', 'Write', { file_path: 'late.txt' })}\n${pad}${pad}`);
  const r = fire(g, stop(s), s.proj, { ...s.env, NODE_OPTIONS: `--import ${preload}` });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  assert.equal(r.out, '');
  const text = readFileSync(recordFile(s), 'utf8');
  assert.ok(lines(text).includes('skipped: reading stopped at 2 s'), text);
  assert.deepEqual(pathLines(text), ['- early.txt (Write)'], text);
  assert.ok(lines(text).includes('tool calls: 1 (Write: 1)'), text);
  // Without the preload the same file is read whole.
  const whole = fire(g, stop(s), s.proj, s.env);
  assert.equal(whole.code, 0, whole.err);
  const full = readFileSync(recordFile(s), 'utf8');
  assert.deepEqual(pathLines(full), ['- early.txt (Write)', '- late.txt (Write)'], full);
  assert.ok(!full.includes('skipped:'), full);
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: records of every odd shape are passed over or counted, never thrown on', () => {
  const g = guard();
  const s = sandbox();
  const J = JSON.stringify;
  const content = (...c) => J({ message: { content: c } });
  writeFileSync(s.transcript, `${[
    J({ message: { content: 'a string' } }), J({ message: { content: null } }), J({ message: [] }), J('text'), J(null), J(7), J([1]),
    J({ message: { content: { type: 'tool_use', name: 'Write', input: { file_path: 'object-content.txt' } } } }),
    content(null, 5, 'x', [], { type: 'tool_use' }, { type: 'tool_use', name: 7, input: 'x' }),
    content({ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 5 } }, { type: 'tool_use', id: 'w2', name: 'Write', input: {} }, { type: 'tool_use', id: 'w3', name: 'Write', input: null }, { type: 'tool_use', id: 'w4', name: 'Edit', input: { file_path: ['a.txt'] } }, { type: 'tool_use', id: 'w5', name: 'NotebookEdit', input: { file_path: 'wrong-key.ipynb' } }, { type: 'tool_use', id: 'w6', name: 'Write', input: { file_path: '' } }),
    content({ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 5 } }, { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: ['cat > arr.txt'] } }, { type: 'tool_use', id: 'b3', name: 'Bash' }),
    content({ type: 'tool_use', id: 'p1', name: '__proto__', input: { file_path: 'proto.txt' } }, { type: 'tool_use', id: 'p2', name: 'constructor', input: { file_path: 'ctor.txt' } }, { type: 'tool_use', id: 'p3', name: 'bash', input: { command: 'cat > lower.txt' } }),
    content({ type: 'tool_use', id: 'same', name: 'Write', input: { file_path: 'once.txt' } }), content({ type: 'tool_use', id: 'same', name: 'Write', input: { file_path: 'twice.txt' } }),
    useLine('ok', 'Write', { file_path: 'fine.txt' }),
  ].join('\n')}\n`);
  const r = fire(g, stop(s), s.proj, s.env);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  const text = readFileSync(recordFile(s), 'utf8');
  assert.deepEqual(pathLines(text), ['- once.txt (Write)', '- fine.txt (Write)'], text);
  assert.ok(!lines(text).some((l) => l.startsWith('skipped:')), text);
  // 2 unnamed, 6 Write (w1..w3, w6, once, fine), 3 Bash, 1 Edit, 1 NotebookEdit, and the three odd names once each.
  assert.ok(lines(text).includes('tool calls: 16 (Write: 6, Bash: 3, unknown: 2, Edit: 1, NotebookEdit: 1, __proto__: 1, constructor: 1, bash: 1)'), text);
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: a path with a newline or a control character is one escaped line, in a Write and in a Bash redirect alike', () => {
  const g = guard();
  const s = sandbox();
  writeFileSync(s.transcript, `${[
    useLine('c1', 'Write', { file_path: 'two\nlines.txt' }),
    useLine('c2', 'Bash', { command: 'echo x > "quoted\nnewline.txt"' }),
    useLine('c3', 'Edit', { file_path: 'esc\x1b[31mred.txt' }),
    useLine('c4', 'Write', { file_path: 'sep\u2028arator.txt' }),
    useLine('c5', 'Write', { file_path: 'nul\x00byte.txt' }),
  ].join('\n')}\n`);
  const r = fire(g, stop(s), s.proj, s.env);
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(recordFile(s), 'utf8');
  assert.deepEqual(pathLines(text), [
    '- two\\x0alines.txt (Write)', '- quoted\\x0anewline.txt (bash write)', '- esc\\x1b[31mred.txt (Edit)', '- sep\\u2028arator.txt (Write)', '- nul\\x00byte.txt (Write)',
  ], text);
  assert.doesNotMatch(text, /[\x00-\x09\x0b-\x1f\x7f\u2028\u2029]/, 'no raw control character in the record');
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: a tool name cannot forge a line of the record', () => {
  const g = guard();
  const s = sandbox();
  writeFileSync(s.transcript, `${[
    useLine('f1', 'Glob\n- forged.txt (Write)', { pattern: '*' }),
    useLine('f2', 'Write', { file_path: 'real.txt' }),
  ].join('\n')}\n`);
  const r = fire(g, stop(s), s.proj, s.env);
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(recordFile(s), 'utf8');
  assert.deepEqual(pathLines(text), ['- real.txt (Write)'], text);
  assert.ok(lines(text).includes('tool calls: 2 (Glob\\x0a- forged.txt (Write): 1, Write: 1)'), text);
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: what cannot be read or written is one stderr line and no record — a directory, a FIFO, a symlinked or plain reports, no .omelette, a bad id', () => {
  const g = guard();
  const base = () => { const s = sandbox(); writeFileSync(s.transcript, `${useLine('t1', 'Write', { file_path: 'x.txt' })}\n`); return s; };
  let s = base();

  const dir = join(s.subagents, 'a-directory');
  mkdirSync(dir);
  assertOneLineNoRecord(fire(g, stop(s, { agent_transcript_path: dir }), s.proj, s.env, 10000), s, 'a directory');

  const fifo = join(s.subagents, 'a-fifo');
  execFileSync('mkfifo', [fifo]);
  assertOneLineNoRecord(fire(g, stop(s, { agent_transcript_path: fifo }), s.proj, s.env, 10000), s, 'a FIFO');

  assertOneLineNoRecord(fire(g, stop(s, { agent_transcript_path: join(s.subagents, 'missing.jsonl') }), s.proj, s.env), s, 'a missing file');

  // reports/ a symlink to a directory elsewhere: nothing is written through it.
  s = base();
  const elsewhere = join(s.root, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(s.proj, '.omelette', 'reports'));
  assertOneLineNoRecord(fire(g, stop(s), s.proj, s.env), s, 'reports is a symlink');
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the symlinked reports/');

  // reports a regular file: left as it is.
  s = base();
  writeFileSync(join(s.proj, '.omelette', 'reports'), 'not a directory');
  assertOneLineNoRecord(fire(g, stop(s), s.proj, s.env), s, 'reports is a file');
  assert.equal(readFileSync(join(s.proj, '.omelette', 'reports'), 'utf8'), 'not a directory');

  // .omelette a symlink, or absent: not ours, and not made.
  s = base();
  rmSync(join(s.proj, '.omelette'), { recursive: true });
  assertOneLineNoRecord(fire(g, stop(s), s.proj, s.env), s, 'no .omelette');
  assert.equal(existsSync(join(s.proj, '.omelette')), false, '.omelette is not created for a record');
  mkdirSync(join(s.root, 'om-elsewhere'));
  symlinkSync(join(s.root, 'om-elsewhere'), join(s.proj, '.omelette'));
  assertOneLineNoRecord(fire(g, stop(s), s.proj, s.env), s, '.omelette is a symlink');
  assert.deepEqual(readdirSync(join(s.root, 'om-elsewhere')), []);

  // An id that walks a path, or is empty, spaced or too long: nothing written, here or above.
  s = base();
  for (const id of ['../../x', 'a/b', '', 'a b', 'a\nb', 'é1234567', 'a'.repeat(65)]) {
    const r = fire(g, stop(s, { agent_id: id }), s.proj, s.env);
    assert.equal(r.code, 0, JSON.stringify(id));
    assert.equal(r.out, '', JSON.stringify(id));
    assert.equal(r.err.split('\n').filter(Boolean).length, 1, `${JSON.stringify(id)}: ${r.err}`);
    assert.equal(existsSync(join(s.proj, '.omelette', 'reports')), false, JSON.stringify(id));
  }
  assert.deepEqual(readdirSync(s.root).sort(), ['home', 'proj'], 'nothing written beside the project');
  assert.deepEqual(readdirSync(s.proj), ['.omelette']);
  // The ends of the id's range are accepted, named by their first 8 characters.
  for (const id of ['a'.repeat(64), 'x-y_z']) {
    assert.equal(fire(g, stop(s, { agent_id: id }), s.proj, s.env).err, '', id);
    assert.ok(existsSync(recordFile(s, 'omelette-coder', id)), id);
  }
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: every guarded role gets a record under its own name, and an unreadable transcript file is one stderr line', () => {
  const g = guard();
  const s = sandbox();
  writeFileSync(s.transcript, `${useLine('t1', 'Write', { file_path: 'x.txt' })}\n`);
  for (const agent of ['omelette-coder', 'omelette-coder-medium', 'omelette-tester', 'omelette-reviewer']) {
    const r = fire(g, stop(s, { agent_type: agent }), s.proj, s.env);
    assert.equal(r.code, 0, `${agent}: ${r.err}`);
    assert.equal(r.err, '', agent);
    const text = readFileSync(recordFile(s, agent), 'utf8');
    assert.ok(text.startsWith(`# touched — ${agent} ${ID}\n`), text);
  }
  assert.deepEqual(readdirSync(join(s.proj, '.omelette', 'reports')).sort(), ['omelette-coder', 'omelette-coder-medium', 'omelette-reviewer', 'omelette-tester'].map((a) => `touched-${a}-abcdef01.md`));
  chmodSync(s.transcript, 0);
  if (process.getuid && process.getuid() !== 0) {
    rmSync(recordFile(s), { force: true });
    assertOneLineNoRecord(fire(g, stop(s), s.proj, s.env), s, 'chmod 000');
  }
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: a second stop of the same agent replaces the record whole and leaves no temp file', () => {
  const g = guard();
  const s = sandbox();
  writeFileSync(s.transcript, `${useLine('t1', 'Write', { file_path: 'first.txt' })}\n`);
  assert.equal(fire(g, stop(s), s.proj, s.env).code, 0);
  assert.ok(readFileSync(recordFile(s), 'utf8').includes('- first.txt (Write)'));
  writeFileSync(s.transcript, `${useLine('t1', 'Edit', { file_path: 'second.txt' })}\n`);
  const r = fire(g, stop(s), s.proj, s.env);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  const text = readFileSync(recordFile(s), 'utf8');
  assert.deepEqual(pathLines(text), ['- second.txt (Edit)'], 'replaced, not appended to');
  assert.deepEqual(readdirSync(join(s.proj, '.omelette', 'reports')), ['touched-omelette-coder-abcdef01.md']);
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: a symlink already standing at the record\'s name is replaced by the record, not written through', () => {
  const g = guard();
  const s = sandbox();
  writeFileSync(s.transcript, `${useLine('t1', 'Write', { file_path: 'x.txt' })}\n`);
  const victim = join(s.root, 'victim.txt');
  writeFileSync(victim, 'PRECIOUS');
  mkdirSync(join(s.proj, '.omelette', 'reports'));
  symlinkSync(victim, recordFile(s));
  const r = fire(g, stop(s), s.proj, s.env);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  assert.equal(readFileSync(victim, 'utf8'), 'PRECIOUS', 'the link target is untouched');
  assert.ok(readFileSync(recordFile(s), 'utf8').includes('- x.txt (Write)'));
  assert.equal(lstatSync(recordFile(s)).isSymbolicLink(), false, 'the name now holds the record itself');
  rmSync(s.root, { recursive: true, force: true });
});

test('touched: a symlink planted at the temp name is not written through — one stderr line, the link target untouched', () => {
  const g = guard();
  // The preload fixes Date.now and plants the link at the name the guard will pick for its temp file: pid and clock.
  const plant = (dir) => {
    const path = join(dir, 'plant.mjs');
    writeFileSync(path, [
      "import { mkdirSync, symlinkSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'Date.now = () => 1700000000000;',
      "const reports = join(process.env.PLANT_PROJ, '.omelette', 'reports');",
      'mkdirSync(reports, { recursive: true });',
      'symlinkSync(process.env.PLANT_TARGET, join(reports, `.touched-omelette-coder-abcdef01.md.${process.pid}.1700000000000.tmp`));',
      '',
    ].join('\n'));
    return path;
  };
  for (const dangling of [false, true]) {
    const s = sandbox();
    writeFileSync(s.transcript, `${useLine('t1', 'Write', { file_path: 'x.txt' })}\n`);
    const target = join(s.root, 'victim.txt');
    if (!dangling) writeFileSync(target, 'PRECIOUS');
    const env = { ...s.env, NODE_OPTIONS: `--import ${plant(s.root)}`, PLANT_PROJ: s.proj, PLANT_TARGET: target };
    const r = fire(g, stop(s), s.proj, env);
    assertOneLineNoRecord(r, s, `dangling=${dangling}`);
    assert.match(r.err, /EEXIST/);
    if (dangling) assert.equal(existsSync(target), false, 'a dangling link was not created through');
    else assert.equal(readFileSync(target, 'utf8'), 'PRECIOUS');
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('touched: $CLAUDE_CONFIG_DIR with a trailing slash roots the transcripts too', () => {
  const g = guard();
  const s = sandbox();
  const config = join(s.root, 'config');
  const dir = join(config, 'projects', '-proj');
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, `agent-${ID}.jsonl`);
  writeFileSync(transcript, `${useLine('t1', 'Write', { file_path: 'x.txt' })}\n`);
  const r = fire(g, stop(s, { agent_transcript_path: transcript }), s.proj, { ...s.env, HOME: join(s.root, 'no-home'), CLAUDE_CONFIG_DIR: `${config}/` });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  assert.ok(readFileSync(recordFile(s), 'utf8').includes('- x.txt (Write)'));
  rmSync(s.root, { recursive: true, force: true });
});
