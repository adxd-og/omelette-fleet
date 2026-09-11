/**
 * omelette-fleet :: test/tester-0.3.7-independent-review.test.mjs
 *
 * An independent tester pass over the 0.3.7 design
 * (docs/superpowers/specs/2026-09-10-0.3.7-design.md), written with a clean
 * context against the diff on feat/0.3.7 vs main. The implementer's own tests
 * (test/*.test.mjs) and several earlier tester rounds (test/tester-0.3.7-*,
 * test/review-0.3.7-fixes.test.mjs, test/m3-stats-extra.test.mjs) already
 * cover the spec's bullets in depth; this file targets three points that
 * survived that review with either a loosened bound or no direct coverage:
 *
 *  - M2: the spec's own memory bound ("cap + 8 MB") — the implementer's test
 *    (test/spawn.test.mjs) measures the same 50 MB / 4 MB-cap run but asserts
 *    against "cap + 40 MB" instead, with a comment explaining the wider bound
 *    was chosen from real measurements. This test asserts the LITERAL spec
 *    bound, to make that gap between the spec's text and the shipped test
 *    visible rather than assumed.
 *  - M4: "the last record with isCompactSummary: true that sits after the
 *    last compact_boundary record" — covered for two compaction CYCLES
 *    (boundary, summary, boundary, summary) but not for two isCompactSummary
 *    records after the SAME boundary, which is the more literal reading of
 *    "the last such record".
 *  - M1: contractFor's marker test is a bounded read (CONTRACT_READ_BYTES =
 *    8192) of whatever sits at the rules path; there is no test proving that
 *    bound actually holds against a multi-megabyte file, marked or not.
 *
 * Never edits the implementation or another file's tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, contractFor, renderHookFile, renderRulesFile, rulesTarget } from '../core/rules.mjs';

const node = process.execPath;

// ─── M2: the spec's literal "cap + 8 MB" heap bound ──────────────────────────

// M2's heap bound: the spec's literal "cap + 8 MB" was superseded at planning (ledger 0.3.7, measured 21–23 MiB
// for the queue vs 68–72 MiB for the string it replaced); test/spawn.test.mjs pins cap + 40 MiB. No second pin here.

// ─── M4: two isCompactSummary records after the SAME boundary ───────────────

/** The guard exactly as `rules --hooks` writes it, with this test's handoff block in it. */
function guard(handoff = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-handoff-m4-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3', { enabled: true, threshold: 90, contextWindow: 0, ...handoff }));
  return { dir, path };
}

/** A throwaway project: `.omelette/` with the ledgers it was given, and a transcript of its own. */
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

const postCompact = (p, over = {}) => ({
  hook_event_name: 'PostCompact', session_id: 's-1', transcript_path: p.transcript, cwd: p.dir,
  trigger: 'auto', ...over,
});

const SUMMARY_HEADING = /\n## Compaction summary \d{4}-\d{2}-\d{2}T[\d:.]+Z \(trigger: (auto|manual|unknown)\)\n/;

test('M4: two isCompactSummary records after the SAME boundary — the LAST one is written, not the first', () => {
  const g = guard();
  const p = project(g, 'two-summaries-one-boundary');
  const lines = [
    boundaryLine(),
    summaryLine('FIRST summary record after this boundary — superseded.'),
    'ordinary traffic between the two summary records',
    summaryLine('SECOND summary record after the same boundary — this is the one that should land.'),
  ];
  writeFileSync(p.transcript, lines.join('\n') + '\n');

  const r = fire(g, postCompact(p));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');

  const text = readFileSync(p.ledger(), 'utf8');
  const body = text.split(SUMMARY_HEADING).pop();
  assert.equal(body, 'SECOND summary record after the same boundary — this is the one that should land.\n\n');
  assert.ok(!body.includes('FIRST summary'), 'the earlier summary record after the same boundary must not win');
});

// ─── M1: the marker test is bounded even against a multi-megabyte file ──────

test('M1: contractFor\'s marker read stays bounded against a multi-megabyte rules file, marked or not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-contract-huge-'));
  const globalDir = join(dir, 'global');
  mkdirSync(globalDir, { recursive: true });
  const o = { cwd: dir, env: { OMELETTE_HOME: dir, CLAUDE_CONFIG_DIR: globalDir } };
  const { path } = rulesTarget({ cwd: o.cwd, env: o.env });
  mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });

  // A genuinely OURS file — marker on line 1 — padded well past the 8 KiB read
  // bound with several megabytes of ordinary rules-file prose.
  const marked = renderRulesFile('1.2.3') + '\n'.repeat(2) + '#'.repeat(80).concat('\n').repeat(60000); // ~5 MB tail
  writeFileSync(path, marked);

  const t0 = Date.now();
  const short = contractFor(o);
  const ms = Date.now() - t0;
  assert.equal(short.short, true, 'the marker on line 1 is found even though the file is several MB long');
  assert.equal(short.reason, 'rules installed here');
  assert.ok(ms < 2000, `contractFor took ${ms} ms against a multi-MB marked file — the read should be bounded, not proportional to file size`);

  // A multi-megabyte file at the SAME path that carries no marker at all —
  // somebody else's huge document — must still read as "no rules file of
  // ours" rather than being (or seeming to be) read in full.
  const foreign = '# somebody else\'s huge unrelated document\n'.concat('lorem ipsum dolor sit amet '.repeat(2000)).repeat(400); // several MB
  writeFileSync(path, foreign);
  const t1 = Date.now();
  const full = contractFor(o);
  const ms2 = Date.now() - t1;
  assert.equal(full.short, false);
  assert.equal(full.reason, `no rules file in ${dir}`);
  assert.ok(ms2 < 2000, `contractFor took ${ms2} ms against a multi-MB foreign file — the read should be bounded, not proportional to file size`);
});
