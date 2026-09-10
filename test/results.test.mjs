/**
 * omelette-fleet :: test/results.test.mjs
 * The result spool: the file format, the atomic write, retention, and the two
 * refusals that keep a fetch inside the spool — an id that is not one, and a
 * path that is a symlink. Every test gets its own throwaway fleet home; no
 * server, no vendor CLI and no clock is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResultStore, formatEntry, isValidResultId, parseResult, renderResult, RESULT_ID_RE } from '../core/results.mjs';

const posixPerms = !(process.platform === 'win32' || (process.getuid && process.getuid() === 0));
const symlinksWork = process.platform !== 'win32';

const home = () => mkdtempSync(join(tmpdir(), 'omelette-results-'));
const spool = (dir) => join(dir, 'results', 'fake');
const store = (dir, o = {}) => createResultStore({ home: dir, unit: 'fake', ...o });
const files = (dir) => { try { return readdirSync(spool(dir)).sort(); } catch { return []; } };

const REC = {
  resultId: '20260908T142501Z-19312-1',
  tool: 'codex_code_review',
  model: 'gpt-6-astra',
  effort: 'xhigh',
  startedAt: '2026-09-08T14:25:01.000Z',
  endedAt: '2026-09-08T14:43:02.000Z',
  durationMs: 1081000,
  status: 'ok',
  partial: false,
  detached: false,
  cwd: '/tmp/project',
  promptPreview: 'review the Movie app',
  // A `---` INSIDE the answer: the parser must split on the first terminator only.
  text: 'the review\n---\nnot a header\n',
};

test('renderResult writes the spec header block, and parseResult reads it back', () => {
  const body = renderResult({ ...REC, unit: 'codex' });
  assert.equal(body.split('\n').slice(0, 15).join('\n'), [
    '---',
    'unit: codex',
    'tool: codex_code_review',
    'resultId: 20260908T142501Z-19312-1',
    'model: gpt-6-astra',
    'effort: xhigh',
    'startedAt: 2026-09-08T14:25:01.000Z',
    'endedAt: 2026-09-08T14:43:02.000Z',
    'durationMs: 1081000',
    'status: ok',
    'partial: false',
    'detached: false',
    'cwd: /tmp/project',
    'promptPreview: "review the Movie app"',
    '---',
  ].join('\n'));
  const back = parseResult(body);
  assert.equal(back.text, REC.text, 'the text is verbatim, `---` inside it included');
  assert.equal(back.header.unit, 'codex');
  assert.equal(back.header.durationMs, 1081000);
  assert.equal(back.header.partial, false);
  assert.equal(back.header.detached, false);
  assert.equal(back.header.promptPreview, 'review the Movie app');
});

test('a header value can never forge a header: controls collapse, the preview is JSON-quoted and capped at 200', () => {
  const body = renderResult({ ...REC, unit: 'fake', model: 'm\n---\nstatus: ok', promptPreview: 'a"b\n' + 'x'.repeat(400) });
  const lines = body.split('\n');
  assert.equal(lines.filter((l) => l === '---').length, 3, 'two header rules and the one inside the text — no fourth');
  assert.equal(lines[4], 'model: m --- status: ok');
  const preview = JSON.parse(lines[13].slice('promptPreview: '.length));
  assert.equal(preview.length, 200);
  assert.ok(preview.startsWith('a"b x'));
  assert.equal(parseResult(body).header.model, 'm --- status: ok');
});

test('an empty header value renders without a trailing space and round-trips', () => {
  const body = renderResult({ resultId: REC.resultId, tool: 't', status: 'ok', text: '' });
  assert.ok(body.includes('\nmodel:\n'), 'no trailing whitespace on an empty value');
  assert.equal(parseResult(body).header.model, '');
  assert.equal(parseResult(body).text, '');
});

test('parseResult answers null for anything that is not one of our files', () => {
  assert.equal(parseResult('no header at all'), null);
  assert.equal(parseResult('---\nunit: fake\n'), null, 'never terminated');
  assert.equal(parseResult(''), null);
  assert.equal(parseResult(null), null);
});

test('a result id is exactly <YYYYMMDDTHHMMSSZ>-<pid>-<seq>; anything else is refused before a path is built', () => {
  assert.ok(isValidResultId('20260908T142501Z-19312-1'));
  assert.ok(RESULT_ID_RE.test('20260908T142501Z-1-1'));
  for (const bad of ['', '..', '../../etc/passwd', '20260908T142501Z-19312-1/../x', '20260908T142501Z-19312',
    '20260908T142501Z-19312-1.md', 'x20260908T142501Z-1-1', ' 20260908T142501Z-1-1', null, undefined, 42,
    '20260908T142501Z-1-' + '1'.repeat(80)]) {
    assert.equal(isValidResultId(bad), false, JSON.stringify(bad));
  }
});

test('write: a 0700 directory, a 0600 file, an atomic rename and no .tmp left behind', () => {
  const dir = home();
  const path = store(dir).write(REC);
  assert.equal(path, join(spool(dir), '20260908T142501Z-19312-1.md'));
  assert.deepEqual(files(dir), ['20260908T142501Z-19312-1.md']);
  const body = readFileSync(path, 'utf8');
  assert.match(body, /^---\nunit: fake\n/, 'the store names the unit, not the record');
  assert.equal(parseResult(body).text, REC.text);
  if (posixPerms) {
    assert.equal(statSync(spool(dir)).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test('a write that cannot happen is one log line and a null — never a half-written file, never another server\'s tmp', () => {
  const dir = home();
  mkdirSync(spool(dir), { recursive: true });
  const target = join(spool(dir), '20260908T142501Z-19312-1.md');
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(target, 'the previous answer');
  writeFileSync(tmp, 'someone else is mid-write'); // blocks the O_EXCL create
  const logged = [];
  assert.equal(createResultStore({ home: dir, unit: 'fake', log: (m) => logged.push(m) }).write(REC), null);
  assert.equal(readFileSync(target, 'utf8'), 'the previous answer', 'the old file is never partially overwritten');
  assert.equal(readFileSync(tmp, 'utf8'), 'someone else is mid-write', 'a tmp we did not create is never removed');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^results: could not spool 20260908T142501Z-19312-1 —/);
});

test('a spool directory that cannot be created is one log line, not an exception', () => {
  const dir = home();
  writeFileSync(join(dir, 'results'), 'not a directory');
  const logged = [];
  assert.equal(createResultStore({ home: dir, unit: 'fake', log: (m) => logged.push(m) }).write(REC), null);
  assert.equal(logged.length, 1);
});

test('a store for a name that is not a unit name is inert — no path is ever built from it', () => {
  const dir = home();
  const logged = [];
  const s = createResultStore({ home: dir, unit: '../evil', log: (m) => logged.push(m) });
  assert.equal(s.write(REC), null);
  assert.deepEqual(s.list(), []);
  assert.equal(s.read(REC.resultId), null);
  assert.doesNotThrow(() => s.prune());
  assert.equal(existsSync(join(dir, 'results')), false);
  assert.equal(logged.length, 1);
});

test('list: newest by endedAt first, the filename breaks a tie, and the limit is honoured', () => {
  const dir = home();
  const s = store(dir);
  s.write({ ...REC, resultId: '20260908T142501Z-1-1', endedAt: '2026-09-08T14:30:00.000Z', tool: 'a' });
  s.write({ ...REC, resultId: '20260908T142501Z-1-2', endedAt: '2026-09-08T14:40:00.000Z', tool: 'b',
    status: 'cancelled', partial: true, detached: true, durationMs: 5 });
  s.write({ ...REC, resultId: '20260908T142501Z-1-3', endedAt: '2026-09-08T14:40:00.000Z', tool: 'c' });
  const all = s.list();
  assert.deepEqual(all.map((e) => e.resultId), ['20260908T142501Z-1-3', '20260908T142501Z-1-2', '20260908T142501Z-1-1']);
  assert.deepEqual(all[1], {
    resultId: '20260908T142501Z-1-2', tool: 'b', status: 'cancelled', partial: true, detached: true,
    durationMs: 5, startedAt: REC.startedAt, endedAt: '2026-09-08T14:40:00.000Z',
    path: join(spool(dir), '20260908T142501Z-1-2.md'),
  });
  assert.equal(s.list(1).length, 1);
  assert.equal(s.list(0).length, 0);
  assert.equal(
    formatEntry(all[1], { unit: 'fake' }),
    '20260908T142501Z-1-2  fake  b  cancelled partial detached  5ms  2026-09-08T14:25:01.000Z',
  );
  assert.equal(formatEntry(all[2]), '20260908T142501Z-1-1  a  ok  1081000ms  2026-09-08T14:25:01.000Z');
});

test('retention by count: resultsKeep survivors, oldest dropped first', () => {
  const dir = home();
  const s = createResultStore({ home: dir, unit: 'fake', keep: 2 });
  for (let i = 1; i <= 5; i++) s.write({ ...REC, resultId: `20260908T142501Z-1-${i}`, endedAt: `2026-09-08T14:4${i}:00.000Z` });
  assert.deepEqual(files(dir), ['20260908T142501Z-1-4.md', '20260908T142501Z-1-5.md']);
});

test('retention by bytes: the oldest go until it fits, and the newest survives even alone over the cap', () => {
  const dir = home();
  const big = 'x'.repeat(4000); // ~4.3 KB per file with the header
  const s = createResultStore({ home: dir, unit: 'fake', keep: 50, maxBytes: 9000 });
  for (let i = 1; i <= 4; i++) s.write({ ...REC, resultId: `20260908T142501Z-1-${i}`, endedAt: `2026-09-08T14:4${i}:00.000Z`, text: big });
  assert.deepEqual(files(dir), ['20260908T142501Z-1-3.md', '20260908T142501Z-1-4.md']);
  const tiny = createResultStore({ home: dir, unit: 'fake', maxBytes: 10 });
  tiny.write({ ...REC, resultId: '20260908T142501Z-1-9', endedAt: '2026-09-08T14:49:00.000Z', text: big });
  assert.deepEqual(files(dir), ['20260908T142501Z-1-9.md'], 'the answer just paid for is never the one thrown away');
});

test('prune removes an abandoned .tmp older than an hour and leaves a fresh one alone', () => {
  const dir = home();
  const s = store(dir);
  s.write(REC);
  const old = join(spool(dir), 'abandoned.md.999.tmp');
  const fresh = join(spool(dir), 'inflight.md.998.tmp');
  writeFileSync(old, 'x');
  writeFileSync(fresh, 'x');
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  utimesSync(old, twoHoursAgo, twoHoursAgo);
  s.prune();
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true, 'another server may be writing it right now');
});

test('read refuses a symlink, an id that is not one, and an id that is not there', { skip: !symlinksWork && 'POSIX symlinks' }, () => {
  const dir = home();
  const s = store(dir);
  s.write(REC);
  const secret = join(dir, 'secret.txt');
  writeFileSync(secret, 'private');
  symlinkSync(secret, join(spool(dir), '20260908T142501Z-1-7.md'));
  assert.equal(s.read('20260908T142501Z-1-7'), null, 'a symlink is never followed');
  assert.equal(s.list().length, 1, 'and never listed');
  assert.equal(s.read('../../../etc/passwd'), null);
  assert.equal(s.read('20260908T142501Z-19312-2'), null);
  const got = s.read(REC.resultId);
  assert.equal(got.text, REC.text);
  assert.equal(got.header.tool, 'codex_code_review');
  assert.equal(got.path, join(spool(dir), `${REC.resultId}.md`));
});

test('a symlinked spool directory is refused by write, list, read and prune — the link target is never touched',
  { skip: !symlinksWork && 'POSIX symlinks' }, () => {
    // O_EXCL and O_NOFOLLOW guard the leaf FILE; the two directories on the way
    // to it are their own answer, and a link planted at either of them would
    // otherwise redirect every write, listing, read and unlink out of the spool.
    const planted = (linkAt) => {
      const dir = home();
      const outside = join(dir, 'elsewhere');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, '20260908T142501Z-19312-9.md'), renderResult({ ...REC, resultId: '20260908T142501Z-19312-9' }));
      if (linkAt === 'unit') mkdirSync(join(dir, 'results'));
      symlinkSync(outside, linkAt === 'unit' ? spool(dir) : join(dir, 'results'));
      return { dir, outside };
    };

    for (const linkAt of ['unit', 'results']) {
      const { dir, outside } = planted(linkAt);
      const logged = [];
      const s = createResultStore({ home: dir, unit: 'fake', log: (m) => logged.push(m) });
      assert.equal(s.write(REC), null, `${linkAt}: a link is not a spool directory`);
      assert.deepEqual(s.list(), [], `${linkAt}: nothing behind the link is listed`);
      assert.equal(s.read('20260908T142501Z-19312-9'), null, `${linkAt}: nothing behind the link is read`);
      assert.doesNotThrow(() => s.prune(), `${linkAt}: prune is a no-op, never an exception`);
      assert.deepEqual(readdirSync(outside).sort(), ['20260908T142501Z-19312-9.md'],
        `${linkAt}: nothing is created or deleted at the link target`);
      assert.ok(logged.length >= 1, `${linkAt}: the refusal is logged`);
      assert.ok(logged.every((m) => m.startsWith('results: spool off —')), logged.join(' | '));
    }
  });

test('a logger that throws is not a spool that throws — every refusal still answers fail-soft',
  { skip: !symlinksWork && 'POSIX symlinks' }, () => {
    // The log sink belongs to the caller (a unit's stderr, a test double), and
    // the spool's whole contract is that nothing it does can break a tool call.
    // A logger that throws must not turn a refusal into an exception.
    const dir = home();
    const outside = join(dir, 'elsewhere');
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(dir, 'results'));
    symlinkSync(outside, spool(dir));
    const boom = () => { throw new Error('boom'); };

    const s = createResultStore({ home: dir, unit: 'fake', log: boom });
    assert.deepEqual(s.list(), []);
    assert.equal(s.read('20260908T142501Z-19312-9'), null);
    assert.equal(s.write(REC), null);
    assert.doesNotThrow(() => s.prune());
    // …including the one logged before any directory is looked at.
    assert.doesNotThrow(() => createResultStore({ home: dir, unit: '../evil', log: boom }));
    // …and the "not a result id" refusal on the write path.
    const ok = createResultStore({ home: home(), unit: 'fake', log: boom });
    assert.equal(ok.write({ ...REC, resultId: 'not-an-id' }), null);
  });

test('a file with a result-id name and no header of ours is never listed, and retention takes it first', () => {
  const dir = home();
  const s = createResultStore({ home: dir, unit: 'fake', keep: 1 });
  mkdirSync(spool(dir), { recursive: true });
  writeFileSync(join(spool(dir), '20260908T142501Z-1-1.md'), 'someone else wrote this');
  writeFileSync(join(spool(dir), 'notes.txt'), 'not ours at all');
  assert.deepEqual(s.list(), []);
  s.write({ ...REC, resultId: '20260908T142501Z-1-2' });
  assert.deepEqual(s.list().map((e) => e.resultId), ['20260908T142501Z-1-2']);
  assert.equal(existsSync(join(spool(dir), '20260908T142501Z-1-1.md')), false, 'headerless: sorted oldest, dropped first');
  assert.equal(existsSync(join(spool(dir), 'notes.txt')), true, 'a name that is not a result id is left alone');
});

test('two servers prune the same directory: they agree, and an unlink that cannot happen is not an exception',
  { skip: !posixPerms && 'POSIX directory modes' }, () => {
    const dir = home();
    const a = createResultStore({ home: dir, unit: 'fake', keep: 2 });
    const b = createResultStore({ home: dir, unit: 'fake', keep: 2 });
    for (let i = 1; i <= 4; i++) a.write({ ...REC, resultId: `20260908T142501Z-1-${i}`, endedAt: `2026-09-08T14:4${i}:00.000Z` });
    assert.doesNotThrow(() => b.prune(), 'everything b would remove is already gone');
    assert.deepEqual(files(dir), ['20260908T142501Z-1-3.md', '20260908T142501Z-1-4.md']);
    chmodSync(spool(dir), 0o500); // no unlink can succeed any more
    try {
      const c = createResultStore({ home: dir, unit: 'fake', keep: 1 });
      assert.doesNotThrow(() => c.prune());
      assert.equal(readdirSync(spool(dir)).length, 2, 'nothing removed, and nothing thrown');
    } finally {
      chmodSync(spool(dir), 0o700);
    }
  });

/** A hand-written record, the way a file on disk is: header lines, then the text. */
const record = (...headers) => ['---', 'unit: fake', ...headers, '---', 'THE ANSWER'].join('\n');

test('the usage: header is written only for a reported pair, sits under effort, and round-trips', () => {
  const full = renderResult({ ...REC, unit: 'codex', usage: { input: 60835, cachedInput: 45312, output: 236, reasoning: 103 } });
  const lines = full.split('\n');
  assert.equal(lines[5], 'effort: xhigh');
  assert.equal(lines[6], 'usage: input=60835 output=236 cachedInput=45312 reasoning=103', 'directly after effort, in the fixed order');
  assert.deepEqual(parseResult(full).header.usage, { input: 60835, output: 236, cachedInput: 45312, reasoning: 103 });

  // Gemini and Grok report the pair and nothing else.
  const pair = renderResult({ ...REC, unit: 'grok', usage: { input: 7, output: 3 } });
  assert.ok(pair.includes('\nusage: input=7 output=3\n'));
  assert.deepEqual(parseResult(pair).header.usage, { input: 7, output: 3 });

  // Nothing reported, or half of it: no line at all — never a zero nobody measured.
  for (const usage of [undefined, null, {}, { out: 1 }, { input: 5, output: null }, { input: null, output: 5 }, 'nope', 42]) {
    const body = renderResult({ ...REC, unit: 'fake', usage });
    assert.ok(!body.includes('\nusage:'), `no line for ${JSON.stringify(usage)}`);
    assert.equal(parseResult(body).header.usage, undefined, `absent, not null, for ${JSON.stringify(usage)}`);
  }
});

test('the usage: line survives a vendor that counts in strings, and a line that says nothing usable reads as no usage', () => {
  // A count is rounded, never negative — the same treatment durationMs gets.
  assert.ok(renderResult({ ...REC, usage: { input: '100', output: '2.6' } }).includes('\nusage: input=100 output=3\n'));
  assert.ok(renderResult({ ...REC, usage: { input: -5, output: 2 } }).includes('\nusage: input=0 output=2\n'));

  // Parsing is the tolerant half: a key we do not know is skipped like any
  // other unknown header key, and a line without a pair is null.
  assert.deepEqual(parseResult(record('usage: input=1 output=2 futureKey=9')).header.usage, { input: 1, output: 2 });
  assert.deepEqual(parseResult(record('usage: input=4 output=5 cachedInput=nope')).header.usage, { input: 4, output: 5 });
  assert.equal(parseResult(record('usage: input=1')).header.usage, null);
  assert.equal(parseResult(record('usage: nonsense')).header.usage, null);
  assert.equal(parseResult(record('usage:')).header.usage, null);
});

test('a record written before 0.3.7 has no usage line, parses whole, and re-renders unchanged', () => {
  const old = ['---', 'unit: codex', 'tool: codex_research', 'resultId: 20260908T142501Z-1-1',
    'model: gpt-6-astra', 'effort: high', 'startedAt: 2026-09-08T14:25:01.000Z',
    'endedAt: 2026-09-08T14:25:42.000Z', 'durationMs: 41000', 'status: ok', 'partial: false',
    'detached: false', 'cwd:', 'promptPreview: "x"', '---', 'THE ANSWER'].join('\n');
  const back = parseResult(old);
  assert.equal(back.header.usage, undefined, 'absent, which is not the same as zero');
  assert.equal(back.text, 'THE ANSWER');
  assert.equal(renderResult({ ...back.header, text: back.text }), old, 'reading and re-writing invents no line');
});

test('stats: one pass over the spool — calls by status, partials, wall time, bytes, tokens where they were reported', () => {
  const dir = home();
  const s = store(dir);
  const base = { ...REC, text: 'x' };
  s.write({ ...base, resultId: '20260908T142501Z-1-1', startedAt: '2026-09-08T14:00:00.000Z', endedAt: '2026-09-08T14:01:00.000Z', durationMs: 60000, status: 'ok', usage: { input: 100, output: 10, cachedInput: 40 } });
  s.write({ ...base, resultId: '20260908T142501Z-1-2', startedAt: '2026-09-08T15:00:00.000Z', endedAt: '2026-09-08T15:00:01.000Z', durationMs: 1000, status: 'error' });
  s.write({ ...base, resultId: '20260908T142501Z-1-3', startedAt: '2026-09-08T16:00:00.000Z', endedAt: '2026-09-08T16:00:22.000Z', durationMs: 22000, status: 'cancelled', partial: true, usage: { input: 7, output: 3 } });

  const all = s.stats();
  assert.equal(all.calls, 3);
  assert.equal(all.ok, 1);
  assert.equal(all.error, 1);
  assert.equal(all.cancelled, 1);
  assert.equal(all.partial, 1);
  assert.equal(all.durationMs, 83000);
  assert.equal(all.reported, 2, 'the middle call reported no tokens');
  assert.equal(all.input, 107);
  assert.equal(all.output, 13, 'the sum over the calls that reported, and only those');
  const bytes = readdirSync(spool(dir)).reduce((n, f) => n + statSync(join(spool(dir), f)).size, 0);
  assert.equal(all.bytes, bytes, 'the bytes those records actually occupy');
});

test('stats: the window filters on startedAt, and a record it cannot place in time is outside every window', () => {
  const dir = home();
  const s = store(dir);
  const now = Date.now();
  const at = (hoursAgo) => new Date(now - hoursAgo * 3600 * 1000).toISOString();
  s.write({ ...REC, resultId: '20260908T142501Z-1-1', startedAt: at(23), endedAt: at(23), durationMs: 1, text: 'x' });
  s.write({ ...REC, resultId: '20260908T142501Z-1-2', startedAt: at(25), endedAt: at(25), durationMs: 1, text: 'x' });
  s.write({ ...REC, resultId: '20260908T142501Z-1-3', startedAt: '', endedAt: at(1), durationMs: 1, text: 'x' });
  writeFileSync(join(spool(dir), '20260908T142501Z-1-4.md'), 'not one of ours');

  assert.equal(s.stats().calls, 3, 'no window: every readable record, the undated one included');
  assert.equal(s.stats({ since: now - 24 * 3600 * 1000 }).calls, 1, '23h in, 25h out, undated out');
  assert.equal(s.stats({ since: now + 1000 }).calls, 0);
  assert.equal(s.stats({ since: 'yesterday' }).calls, 3, 'a since that is not a number is no window at all');
  const ours = readdirSync(spool(dir))
    .filter((f) => f !== '20260908T142501Z-1-4.md')
    .reduce((n, f) => n + statSync(join(spool(dir), f)).size, 0);
  assert.equal(s.stats().bytes, ours, 'the file that is not one of ours is counted by nothing, bytes included');
});

test('stats on a spool that is not there, or is not ours, is a row of zeros', () => {
  const dir = home();
  const zeros = { calls: 0, ok: 0, error: 0, cancelled: 0, partial: 0, durationMs: 0, bytes: 0, reported: 0, input: 0, output: 0 };
  assert.deepEqual(store(dir).stats(), zeros);
  assert.equal(existsSync(join(dir, 'results')), false, 'counting never creates the spool');
  assert.deepEqual(createResultStore({ home: dir, unit: '../evil' }).stats(), zeros);
});
