/**
 * omelette-fleet :: test/tester-0.3.7-m4-postcompact-extra.test.mjs
 * Independent coverage for the 0.3.7 M4 diff (`PostCompact` — the compaction
 * summary on disk), written from
 * docs/superpowers/specs/2026-09-10-0.3.7-design.md against the working tree
 * (`hooks/omelette-guard.mjs`), not against the implementer's own tests in
 * test/hooks-handoff.test.mjs. Three gaps the implementer's own extensive
 * suite left uncovered:
 *
 *   1. The 8 KiB cap on the summary body is a BYTE cap (`Buffer.byteLength`),
 *      not a JS string-length cap — the implementer's own boundary test uses
 *      only ASCII, which cannot distinguish the two. Multi-byte UTF-8 content
 *      (Cyrillic here) can.
 *   2. Two compaction cycles in the same transcript tail: the handler must
 *      pick the summary of the LATEST cycle, not an older one still sitting
 *      further back in the same 256 KiB read.
 *   3. `isCompactSummary` is read with a strict `=== true` (per the guard's
 *      own source and the spec's "a record carrying isCompactSummary: true"),
 *      so a truthy-but-not-`true` value must not be mistaken for the flag.
 *
 * Never edits hooks/omelette-guard.mjs, core/rules.mjs, or any test the
 * implementer wrote.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

/** The guard exactly as `rules --hooks` writes it, with this test's handoff block in it. */
function guard(handoff = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-m4-extra-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3', { enabled: true, threshold: 90, contextWindow: 0, ...handoff }));
  return { dir, path };
}

/** A throwaway project: `.omelette/` with one ledger, and its own transcript path (not written here). */
function project(g, name, { ledgers = { 'ledger-0.3.4.md': '# ledger 0.3.4\n' } } = {}) {
  const dir = join(g.dir, name);
  mkdirSync(join(dir, '.omelette'), { recursive: true });
  for (const [file, text] of Object.entries(ledgers)) writeFileSync(join(dir, '.omelette', file), text);
  return {
    dir,
    transcript: join(dir, 'transcript.jsonl'),
    ledger: (file = 'ledger-0.3.4.md') => join(dir, '.omelette', file),
  };
}

/** One hook invocation: the event on stdin, the answer as code/stdout/stderr. */
function fire(g, input) {
  const r = spawnSync(process.execPath, [g.path], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', cwd: g.dir, timeout: 20000,
    env: { PATH: process.env.PATH, HOME: g.dir },
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const postCompact = (p, over = {}) => ({
  hook_event_name: 'PostCompact', session_id: 's-1', transcript_path: p.transcript, cwd: p.dir,
  trigger: 'auto', ...over,
});

const boundaryLine = (trigger = 'auto') => JSON.stringify({
  type: 'system',
  subtype: 'compact_boundary',
  compactMetadata: { trigger, preCompactTokenCount: 182000 },
  timestamp: '2026-09-10T12:00:00.000Z',
});

const summaryLine = (content) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content },
  isCompactSummary: true,
  timestamp: '2026-09-10T12:00:01.000Z',
});

const ledgerText = (p, name = 'ledger-0.3.4.md') => readFileSync(p.ledger(name), 'utf8');
const SUMMARY_HEADING = /\n## Compaction summary \d{4}-\d{2}-\d{2}T[\d:.]+Z \(trigger: (auto|manual|unknown)\)\n/;

test('PostCompact: the 8 KiB cap is a BYTE cap, not a JS string-length cap — multi-byte lines are cut so the file stays valid UTF-8 under the cap', () => {
  const g = guard();
  const p = project(g, 'utf8-cap');
  // Each line: 199 Cyrillic characters (2 bytes each in UTF-8 = 398 bytes) plus
  // one ASCII digit, mirroring the implementer's own 200-"byte"-line shape but
  // with content whose BYTE length is roughly double its JS .length. If the cap
  // were measured in characters rather than bytes, far more of this would be
  // kept than 8 KiB actually holds.
  const long = Array.from({ length: 200 }, (_, i) => `${'Ж'.repeat(199)}${i % 10}`).join('\n');
  writeFileSync(p.transcript, [boundaryLine(), summaryLine(long)].join('\n') + '\n');

  const r = fire(g, postCompact(p));
  assert.equal(r.code, 0, r.err);
  const text = ledgerText(p);
  assert.match(text, SUMMARY_HEADING);
  const body = text.split(SUMMARY_HEADING).pop();

  // The body — as written to disk, read back as UTF-8 — must contain no
  // replacement character: a byte-boundary cut that fell mid-character would
  // corrupt the last kept line into one on decode.
  assert.ok(!body.includes('�'), `a multi-byte character was split at the cap:\n${JSON.stringify(body.slice(-40))}`);

  // The body itself, re-encoded to bytes, has to respect the 8 KiB cap (plus
  // the small, generous slack the implementer's own test allows for the
  // truncation marker) — not some multiple of it that a char-count cap would
  // let through given ~2-byte characters.
  const bytes = Buffer.byteLength(body, 'utf8');
  assert.ok(bytes < 8 * 1024 + 64, `expected a byte-bounded body, got ${bytes} bytes`);

  // …and, since every kept content line here is exactly 398 + 1 = 399 bytes
  // (line + digit), far fewer than all 200 lines fit — the cut is governed by
  // BYTES, so at most ~8192/400 ≈ 20 of the 200 lines survive.
  const kept = body.split('\n').filter((l) => l && l !== '[… truncated]');
  assert.ok(kept.length < 30, `expected well under 200 lines to survive a byte cap on 2-byte characters, kept ${kept.length}`);
  assert.ok(body.trimEnd().endsWith('[… truncated]'), 'the huge multi-byte summary must still be reported as truncated');
});

test('PostCompact: two compaction cycles in the same tail — the LATEST cycle\'s summary is written, not the earlier one', () => {
  const g = guard();
  const p = project(g, 'two-cycles');
  const lines = [
    boundaryLine('manual'),
    summaryLine('FIRST compaction: the session built P1.'),
    'not json, ordinary traffic between the two compactions',
    boundaryLine('auto'),
    summaryLine('SECOND compaction: the session built P2. Open: P3 not started.'),
  ];
  writeFileSync(p.transcript, lines.join('\n') + '\n');

  const r = fire(g, postCompact(p));
  assert.equal(r.code, 0, r.err);
  const body = ledgerText(p).split(SUMMARY_HEADING).pop();
  assert.equal(body, 'SECOND compaction: the session built P2. Open: P3 not started.\n\n');
  assert.ok(!body.includes('FIRST compaction'), 'the older cycle\'s summary must not leak into the newer ledger block');
  // The trigger recorded is the EVENT's own trigger (the running session's, not
  // either boundary record's `compactMetadata.trigger`) — same rule PreCompact
  // already follows for its stamp.
  assert.match(ledgerText(p), /\(trigger: auto\)/);
});

test('PostCompact: `isCompactSummary` is read strictly — a truthy-but-not-`true` value is not a summary flag', () => {
  const g = guard();

  const stringTrue = project(g, 'string-true');
  writeFileSync(stringTrue.transcript, [
    boundaryLine(),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'looks like a summary' }, isCompactSummary: 'true', timestamp: '2026-09-10T12:00:01.000Z' }),
  ].join('\n') + '\n');
  const r1 = fire(g, postCompact(stringTrue));
  assert.equal(r1.code, 0, r1.err);
  assert.equal(r1.out, '');
  assert.equal(ledgerText(stringTrue), '# ledger 0.3.4\n', 'a string "true" must not be treated as the summary flag');

  const numericOne = project(g, 'numeric-one');
  writeFileSync(numericOne.transcript, [
    boundaryLine(),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'looks like a summary too' }, isCompactSummary: 1, timestamp: '2026-09-10T12:00:01.000Z' }),
  ].join('\n') + '\n');
  const r2 = fire(g, postCompact(numericOne));
  assert.equal(r2.code, 0, r2.err);
  assert.equal(r2.out, '');
  assert.equal(ledgerText(numericOne), '# ledger 0.3.4\n', 'a numeric 1 must not be treated as the summary flag');

  // Sanity: the literal boolean `true` on the same shape IS picked up, so the
  // two cases above are failing the flag check specifically, not something else
  // about the record shape.
  const real = project(g, 'real-true');
  writeFileSync(real.transcript, [boundaryLine(), summaryLine('the real summary')].join('\n') + '\n');
  const r3 = fire(g, postCompact(real));
  assert.equal(r3.code, 0, r3.err);
  assert.match(ledgerText(real), SUMMARY_HEADING);
  assert.equal(ledgerText(real).split(SUMMARY_HEADING).pop(), 'the real summary\n\n');
});
