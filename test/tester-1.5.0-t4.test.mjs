/**
 * omelette-fleet :: test/tester-1.5.0-t4.test.mjs
 * Independent tester coverage for 1.5.0 T4 (P4 "leftovers", first bullet):
 * `results` and `check` print through `visible()` — the spooled answer's
 * header line and the check report's echoed fragments are escaped; the body
 * of a spooled answer is model text and stays as it is. Written from the spec
 * and the diff (ba0de27..159f445), not from the coder's own tests, which this
 * file does not edit.
 *
 * Everything runs on temp directories under os.tmpdir(); no server, no vendor
 * CLI, no real fleet home is touched.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResultStore, renderResult, renderResultHeader } from '../core/results.mjs';
import { INVISIBLE_CHARS } from '../core/log.mjs';

const BIN = join(new URL('..', import.meta.url).pathname, 'bin', 'omelette-fleet.mjs');

const dirs = [];
function tmp(prefix = 'omelette-t4-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** Every byte a terminal acts on that is not `\t`/`\n`, plus the two line/bidi
 * format characters the spec calls out by name — the narrow, spec-literal
 * check. `INVISIBLE_CHARS` (imported from the module under test) is used
 * separately, below, as the stronger, whole-class check. */
const BAD_BYTES = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f" + String.fromCodePoint(0x2028) + String.fromCodePoint(0x202e) + "]");
const noBadBytes = (s, msg) => {
  assert.ok(!BAD_BYTES.test(s), `${msg}: a literal control/bidi byte reached stdout — ${JSON.stringify(s)}`);
  // The whole INVISIBLE_CHARS class, minus `\t`/`\n`, which are the only two
  // of that range legitimate in real output (a listing/header line separator).
  const strong = String(s).replace(/[\t\n]/g, '');
  assert.ok(!new RegExp(INVISIBLE_CHARS.source, 'u').test(strong), `${msg}: a character from the whole INVISIBLE_CHARS class reached stdout — ${JSON.stringify(s)}`);
};

// ─── results ────────────────────────────────────────────────────────────────

const home = () => tmp('omelette-t4-results-');
const resultsCli = (dir, args) => {
  const r = spawnSync(process.execPath, [BIN, 'results', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};

test('results <unit> <id>: model/promptPreview/cwd escape U+202E, U+200B, U+2028 and a C1 control, one header line per line; the body prints raw', () => {
  const dir = home();
  const store = createResultStore({ home: dir, unit: 'codex' });
  const id = '20260925T120000Z-1-1';
  const rec = {
    resultId: id,
    tool: 'codex_research',
    // A C1 control (NEL, U+0085) — line1() only folds C0 (\u0000-\u001f) and
    // DEL, so a C1 control survives renderResultHeader and reaches `visible`.
    model: 'gpt\u0085-6-astra',
    startedAt: '2026-09-25T12:00:00.000Z',
    endedAt: '2026-09-25T12:00:01.000Z',
    durationMs: 1000,
    status: 'ok',
    partial: false,
    detached: false,
    // A zero-width space, U+200B.
    cwd: '/tmp/p​',
    // The line separator U+2028 and the bidi override U+202E, inside a JSON
    // string: JSON.stringify/JSON.parse round-trip both raw (neither is a
    // control character or one JSON itself escapes), so both reach `visible`.
    promptPreview: 'one two ‮ reversed',
    // The body: a raw ESC and a raw U+202E, which must print UNTOUCHED — it is
    // model text and the evidence (SECURITY, "What is best-effort").
    text: 'body text \u001b[2K with an escape, and ‮ a bidi override, unescaped.\n',
  };
  const path = store.write(rec);
  assert.ok(path, 'the record was spooled');

  const r = resultsCli(dir, ['codex', id]);
  assert.equal(r.code, 0, r.err);

  // The header, hand-computed: `unit` and `effort`/`usage` are exactly what
  // renderResultHeader always writes (`effort:` empty since the record never
  // set one, `usage` dropped since it never carries a value) — one line per
  // header key, real newlines between them, nothing folded onto one line.
  const expectedHeader = [
    '---',
    'unit: codex',
    'tool: codex_research',
    `resultId: ${id}`,
    'model: gpt\\u0085-6-astra',
    'effort:',
    'startedAt: 2026-09-25T12:00:00.000Z',
    'endedAt: 2026-09-25T12:00:01.000Z',
    'durationMs: 1000',
    'status: ok',
    'partial: false',
    'detached: false',
    'cwd: /tmp/p\\u200b',
    'promptPreview: "one\\u2028two \\u202e reversed"',
    '---',
  ].join('\n');
  assert.equal(expectedHeader.split('\n').length, 15, 'fixture sanity: one header line per line, none folded');

  const expectedStdout = `${expectedHeader}\n${rec.text}\n`; // out() appends the final \n
  assert.equal(r.out, expectedStdout);
  // The body's raw ESC and raw U+202E are untouched: they are still literally
  // there (not escaped), immediately after the header prints escaped.
  assert.ok(r.out.includes('\u001b[2K with an escape'), 'the raw ESC in the body is untouched');
  assert.ok(r.out.includes('‮ a bidi override'), 'the raw U+202E in the body is untouched');
  noBadBytes(expectedHeader, 'the escaped header');
});

test('renderResult on disk is exactly renderResultHeader(header) + "\\n" + text — the same bytes as before the header was split out', () => {
  const dir = home();
  const store = createResultStore({ home: dir, unit: 'codex' });
  const rec = {
    resultId: '20260925T130000Z-1-1',
    tool: 'codex_code_review',
    model: 'gpt-6-astra',
    effort: 'xhigh',
    startedAt: '2026-09-25T13:00:00.000Z',
    endedAt: '2026-09-25T13:00:05.000Z',
    durationMs: 5000,
    status: 'ok',
    partial: false,
    detached: false,
    cwd: '/tmp/project',
    promptPreview: 'review the thing',
    // A `---` inside the answer, as the parser round-trip test already checks
    // for `renderResult`/`parseResult` — kept here too, since this is the same
    // writer.
    text: 'the review\n---\nnot a header\n',
  };
  const path = store.write(rec);
  const onDisk = readFileSync(path, 'utf8');
  const header = renderResultHeader({ ...rec, unit: 'codex' });
  assert.equal(onDisk, `${header}\n${rec.text}`, 'the exact separator the code uses is "\\n", once');
  assert.equal(onDisk, renderResult({ ...rec, unit: 'codex' }), 'renderResult is the same split, unchanged');
});

test('results listing: tool, status and startedAt escape their format characters; --path prints the path unchanged', () => {
  // The home directory's own name carries a zero-width space: `results
  // --path` must hand it back exactly as it is, unescaped — it is a path a
  // script or an editor opens next, not a line for a human to read.
  const base = tmp('omelette-t4-path-');
  const dir = join(base, 'home​with-a-zero-width-space');
  mkdirSync(dir, { recursive: true });
  const store = createResultStore({ home: dir, unit: 'codex' });
  const id = '20260925T130000Z-1-2';
  store.write({
    resultId: id,
    tool: 'codex_re search',
    model: 'm',
    startedAt: '2026-09-25T13:00:00.000Z​',
    endedAt: '2026-09-25T13:00:01.000Z',
    durationMs: 500,
    status: 'o\u0085k',
    partial: false,
    detached: false,
    cwd: '/tmp',
    promptPreview: 'hi',
    text: 'body',
  });

  const listing = resultsCli(dir, ['codex']);
  assert.equal(listing.code, 0, listing.err);
  assert.ok(listing.out.includes('codex_re\\u2028search'), listing.out);
  assert.ok(listing.out.includes('o\\u0085k'), listing.out);
  assert.ok(listing.out.includes('2026-09-25T13:00:00.000Z\\u200b'), listing.out);
  noBadBytes(listing.out, 'the listing');

  const listingPath = resultsCli(dir, ['codex', '--path']);
  assert.equal(listingPath.code, 0, listingPath.err);
  assert.ok(listingPath.out.includes('home​with-a-zero-width-space'), 'the raw path, zero-width space and all, is unchanged');
  assert.ok(!listingPath.out.includes('\\u200b'), '--path is never escaped');

  const idPath = resultsCli(dir, ['codex', id, '--path']);
  assert.equal(idPath.code, 0, idPath.err);
  assert.ok(idPath.out.includes('home​with-a-zero-width-space'), 'the single-result --path is unchanged too');
  assert.ok(!idPath.out.includes('\\u200b'), '--path is never escaped, single result or listing');
});

// ─── check ──────────────────────────────────────────────────────────────────

function project(files) {
  const root = tmp('omelette-t4-check-project-');
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
  return root;
}

function cli(args, { cwd, env = {} } = {}) {
  const checkHome = tmp('omelette-t4-check-home-');
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: checkHome, OMELETTE_HOME: checkHome, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const summary = (n, { ok = 0, moved = 0, mismatch = 0, missing = 0, outside = 0, stale = 0, tooLarge = 0, weak = 0, malformed = 0 } = {}) =>
  `check: ${n} pointers · ${ok} ok · ${moved} moved · ${mismatch} mismatch · ${missing} missing · ${outside} outside · ${stale} stale`
  + (tooLarge ? ` · ${tooLarge} too-large` : '')
  + (weak ? ` · ${weak} weak` : '')
  + (malformed ? ` · ${malformed} malformed` : '');

test('check: an ok run prints only the unchanged summary line', () => {
  const root = project({
    'a.txt': 'first line here\nthe second line\n',
    'report.md': 'a.txt:1 · `first line here` · c\n',
  });
  const r = cli(['check', 'report.md'], { cwd: root });
  assert.equal(r.code, 0);
  assert.equal(r.out, `${summary(1, { ok: 1 })}\n`);
});

test('check: missing/mismatch/moved lines and the malformed echo escape a bidi path override, an ANSI erase and a line separator in the fragment', () => {
  const root = project({
    'note.txt': 'plain text one\nplain text two\n',
    'moved.txt': 'header line\nerase \u001b[2K sequence   marker\nfooter line\nerase \u001b[2K sequence   marker\n',
  });
  const reportText = [
    // path carries U+202E; file does not exist -> missing.
    'weird‮-gone.mjs:1 · `plainly missing text` · missing case',
    // fragment carries an ANSI erase (\u001b[2K) and a line separator (U+2028);
    // not present anywhere in note.txt -> mismatch.
    'note.txt:1 · `erase \u001b[2K vanish   gone` · mismatch case',
    // same fragment shape, present two lines down from where it is pointed -> moved.
    'moved.txt:1 · `erase \u001b[2K sequence   marker` · moved case',
    // no backticks around the fragment -> malformed; echo carries a BEL and a
    // zero-width space.
    'alpha.txt:1 · no backticks \u0007​ here · malformed case',
    '',
  ].join('\n');
  writeFileSync(join(root, 'report.md'), reportText);

  const r = cli(['check', 'report.md'], { cwd: root });
  assert.equal(r.code, 1);
  const lines = r.out.split('\n');
  // line 1: missing, path escaped
  assert.equal(lines[0], 'missing  weird\\u202e-gone.mjs:1  plainly missing text');
  // line 2: mismatch, fragment escaped (ESC and U+2028 both)
  assert.equal(lines[1], 'mismatch  note.txt:1  erase \\u001b[2K vanish \\u2028 gone');
  // line 3: moved, fragment escaped, foundAt is a plain line number
  assert.equal(lines[2], 'moved  moved.txt:1  erase \\u001b[2K sequence \\u2028 marker  → found at 2');
  // line 4: malformed echo escaped; `p.line` is the report's own 4th line
  assert.equal(lines[3], 'malformed  line 4  alpha.txt:1 · no backticks \\u0007\\u200b here · malformed case');
  assert.equal(lines[4], summary(4, { moved: 1, mismatch: 1, missing: 1, malformed: 1 }));
  assert.equal(lines[5], '');
  assert.equal(lines.length, 6);
  noBadBytes(r.out, 'the check report');
});

test('check: --root a directory whose commit: line is not a hash reports the fixed, unescaped reason, alongside escaped pointer echoes', () => {
  const root = project({
    'note.txt': 'plain text one\nplain text two\n',
  });
  const elsewhere = tmp('omelette-t4-check-elsewhere-');
  const reportPath = join(elsewhere, 'report.md');
  writeFileSync(reportPath, [
    'commit: not-a-real-hash',
    '',
    'weird‮-gone.mjs:1 · `plainly missing text` · missing case',
    'note.txt:1 · `erase \u001b[2K vanish   gone` · mismatch case',
    '',
  ].join('\n'));

  const r = cli(['check', reportPath, '--root', root], { cwd: elsewhere });
  assert.equal(r.code, 1);
  const lines = r.out.split('\n');
  // The "not a hash" branch never carries a value to escape — it is the fixed
  // string, printed exactly as it always was.
  assert.equal(lines[0], 'staleness: not checked (unusable commit value)');
  assert.equal(lines[1], 'missing  weird\\u202e-gone.mjs:1  plainly missing text');
  assert.equal(lines[2], 'mismatch  note.txt:1  erase \\u001b[2K vanish \\u2028 gone');
  assert.equal(lines[3], summary(2, { mismatch: 1, missing: 1 }));
  assert.equal(lines[4], '');
  assert.equal(lines.length, 5);
  noBadBytes(r.out, 'the report with an unusable commit line');
});
