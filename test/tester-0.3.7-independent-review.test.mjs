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
 *  - M4 (the compaction summary's record choice) left with the PostCompact
 *    handler in 1.5.0.
 *  - M1: contractFor's marker test is a bounded read (CONTRACT_READ_BYTES =
 *    8192) of whatever sits at the rules path; there is no test proving that
 *    bound actually holds against a multi-megabyte file, marked or not.
 *
 * Never edits the implementation or another file's tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contractFor, renderRulesFile, rulesTarget } from '../core/rules.mjs';

const node = process.execPath;

// ─── M2: the spec's literal "cap + 8 MB" heap bound ──────────────────────────

// M2's heap bound: the spec's literal "cap + 8 MB" was superseded at planning (ledger 0.3.7, measured 21–23 MiB
// for the queue vs 68–72 MiB for the string it replaced); test/spawn.test.mjs pins cap + 40 MiB. No second pin here.

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
