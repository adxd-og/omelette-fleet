// 1.3.0 P0 (spec docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md,
// "P0 — the security brief over this package"): SECURITY says how this package
// is audited. It quotes one section of Cloudflare's security-audit-skill (MIT)
// byte for byte, with Cloudflare's copyright line and permission notice beside
// it, and links two Trail of Bits skills (CC-BY-SA-4.0) without copying them.
// These tests hold the quote to its fixture, the fixture to the upstream bytes,
// and the repository clear of the Trail of Bits text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/**
 * One section of a Markdown text: its heading line up to the next heading of
 * the same or a higher level. A line inside a code fence is never a heading —
 * the quoted block opens with one.
 */
function section(md, heading) {
  const lines = md.split('\n');
  const from = lines.indexOf(heading);
  assert.notEqual(from, -1, `${heading} present`);
  const next = new RegExp(`^#{1,${heading.match(/^#+/)[0].length}} `);
  let fenced = false;
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i++) {
    if (lines[i].startsWith('```')) fenced = !fenced;
    else if (!fenced && next.test(lines[i])) { to = i; break; }
  }
  return lines.slice(from, to).join('\n');
}

/** The body of every text fence in a Markdown text, each ending with its last line's newline. */
const textFences = (md) => [...md.matchAll(/^```text\n([\s\S]*?)^```$/gm)].map((m) => m[1]);

const AUDITED = '## How this package is audited';

// ── Cloudflare: the quote, its fixture, its notice ───────────────────────────

const CF_COMMIT = 'c1c8a8c1471069fb0e188eeaff69b8e8db6564a8';
/** skills/security-audit/AI-AND-LLM.md lines 51–60 at CF_COMMIT, each with its newline: 1 202 bytes. */
const BLOCK_SHA256 = 'cf82b1d572c919d142c4fd43528e998d380619fc05733e4401ef45e3f3c81e8e';
/** LICENSE at CF_COMMIT from the copyright line to its last word, each line with its newline: 1 065 bytes. */
const NOTICE_SHA256 = '48f9dfc549fa78b0d084a1ce7e7fe62004610aa78c5de7dd7b6c63ef30b3dbe3';
const FIXTURE = 'test/fixtures/cloudflare-mcp-trust-classes.txt';
const CUT = '--- quoted block: byte for byte from the next line to the end of this file ---\n';

function fixture() {
  const text = read(FIXTURE);
  const at = text.indexOf(CUT);
  assert.notEqual(at, -1, 'the fixture has its cut line');
  return { header: text.slice(0, at), block: text.slice(at + CUT.length) };
}

/** Cloudflare's copyright line and permission notice, as a text carries them. */
function noticeOf(text) {
  const from = text.indexOf('Copyright (c) 2025-2026 Cloudflare, Inc.\n');
  assert.notEqual(from, -1, 'the copyright line');
  const end = text.indexOf('SOFTWARE.\n', from);
  assert.notEqual(end, -1, 'the notice runs to its last word');
  return text.slice(from, end + 'SOFTWARE.\n'.length);
}

test("the fixture names its upstream — repository, path, commit — and carries Cloudflare's copyright line and permission notice whole", () => {
  const { header } = fixture();
  for (const fact of ['cloudflare/security-audit-skill', 'skills/security-audit/AI-AND-LLM.md', CF_COMMIT]) {
    assert.ok(header.includes(fact), `the header names ${fact}`);
  }
  const notice = noticeOf(header);
  assert.ok(notice.includes('Permission is hereby granted, free of charge,'), 'the permission paragraph');
  assert.ok(notice.includes('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND'), 'the warranty paragraph');
  assert.equal(sha256(notice), NOTICE_SHA256, 'the notice is the upstream LICENSE text, byte for byte');
});

test("the fixture's quoted block is the upstream section, byte for byte", () => {
  const { block } = fixture();
  const lines = block.split('\n');
  assert.equal(lines[0], '## MCP and sub-agent trust classes (subagent_type: `general`)');
  assert.equal(lines.filter((l) => l.startsWith('## ')).length, 1, 'one section, up to the next "## "');
  assert.equal(sha256(block), BLOCK_SHA256, 'lines 51–60 of AI-AND-LLM.md at the pinned commit');
});

test("SECURITY quotes the section byte for byte, keeps Cloudflare's notice right beside it, and its map links the section", () => {
  const md = read('docs/SECURITY.md');
  const sec = section(md, AUDITED);
  const { header, block } = fixture();
  const fences = textFences(sec);
  assert.equal(fences.length, 2, 'two text fences: the quote, then the notice');
  assert.equal(fences[0], block, "the quote is the fixture's block, byte for byte");
  assert.equal(fences[1], noticeOf(header), "the notice is Cloudflare's, whole");
  const lines = sec.split('\n');
  const quote = lines.indexOf('```text');
  const notice = lines.indexOf('```text', quote + 1);
  assert.ok(notice - lines.indexOf('```', quote) <= 4, 'one short paragraph between the quote and its notice');
  assert.ok(sec.includes(`\`${CF_COMMIT}\``), 'the upstream commit is named');
  const head = md.slice(0, md.indexOf('\n## '));
  assert.match(head, /^\| .+ \| \[How this package is audited\]\(#how-this-package-is-audited\) \|$/m, 'the map at the top links the section');
});

const TOB_COMMIT = '32e34f8173796e3566a51aee877dc96bc5191f64';

test('SECURITY names the four parts, the three runs over one revision and the result line, and links Trail of Bits at a pinned commit', () => {
  const sec = section(read('docs/SECURITY.md'), AUDITED);
  const lines = sec.split('\n');
  const rows = lines.filter((l) => l.startsWith('| '));
  for (const part of ['`servers/*.mjs`', '`hooks/omelette-guard.mjs`', '`bin/omelette-fleet.mjs`', '`agents/`']) {
    assert.ok(rows.some((r) => r.includes(part)), `a trust-class row for ${part}`);
  }
  for (const run of ['1. **Plain**', '2. **Brief**', '3. **Plugin**']) {
    assert.ok(lines.some((l) => l.startsWith(run)), `the run ${run}`);
  }
  for (const fact of ['`d7180b2`', '`gpt-6-astra`', '`claude-security`', 'CC-BY-SA-4.0']) assert.ok(sec.includes(fact), `names ${fact}`);
  for (const skill of ['plugins/differential-review/skills/differential-review/SKILL.md', 'plugins/fp-check/skills/fp-check/SKILL.md']) {
    assert.ok(sec.includes(`(https://github.com/trailofbits/skills/blob/${TOB_COMMIT}/${skill})`), `links ${skill} at the pinned commit`);
  }
  assert.ok(lines.some((l) => l.startsWith('**Result.** ')), 'the result line');
});

// ── Trail of Bits: linked, never copied ──────────────────────────────────────

/**
 * Three sentences of the two Trail of Bits skills, held without their text: a
 * three-word lead to find a candidate, the sentence's length and its SHA-256,
 * whitespace squashed to single spaces on both sides so a re-wrapped copy is
 * still caught. No file of this repository holds the sentences; that the key
 * finds each one was checked once against the upstream files, outside the
 * repository (1.3.0 ledger, P0).
 */
const TOB = [
  { from: 'differential-review SKILL.md:97-100', lead: 'Follows the 5-step ', length: 189, sha256: '4046e4750e875025551556128780f417ad98341b07badef236b5faae87aee389' },
  { from: 'fp-check SKILL.md:40', lead: 'Half of false ', length: 110, sha256: '7d33fae04ad7683eb424a2881c024ef3ea637674d07a33eece6a8595cd5dd464' },
  { from: 'fp-check SKILL.md:86', lead: 'Standard verification has ', length: 126, sha256: '1bf872375a3cc5b423172867403d4a67bcb442739018a0db355ac0fd2321fbbb' },
];

/** How many times a sentence of the key occurs in a text. */
function occurrences(text, key) {
  const flat = text.replace(/\s+/g, ' ');
  let n = 0;
  for (let at = flat.indexOf(key.lead); at !== -1; at = flat.indexOf(key.lead, at + 1)) {
    if (sha256(flat.slice(at, at + key.length)) === key.sha256) n++;
  }
  return n;
}

test('no file in the repository carries a Trail of Bits sentence', { skip: !gitAvailable && 'git not available' }, () => {
  // Tracked files plus the untracked ones git would offer to commit, so a copy
  // is caught before `git add`; ignored paths (.claude/, .omelette/) are not
  // ours to ship. safe.directory: a container running the suite as another user
  // than the checkout's owner must still be able to list it — a read, nothing else.
  const files = execFileSync('git', ['-c', 'safe.directory=*', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  assert.ok(files.includes('docs/SECURITY.md'), 'the listing is this repository');
  const found = [];
  for (const rel of new Set(files)) {
    let stat;
    try { stat = fs.lstatSync(path.join(ROOT, rel)); } catch { continue; } // listed, but deleted in the working tree
    if (!stat.isFile()) continue;
    const text = read(rel);
    for (const key of TOB) if (occurrences(text, key)) found.push(`${rel}: ${key.from}`);
  }
  assert.deepEqual(found, []);
});

test('SECURITY says what the P0 refutations found true: proxy URLs pass as they are, the stdin cap fails open, gemini per tool, the probe\'s environment, the kill\'s limit (Task 13)', () => {
  const security = read('docs/SECURITY.md');
  for (const rel of ['docs/SECURITY.md', 'core/spawn.mjs']) {
    assert.doesNotMatch(read(rel), /Nothing here is a credential/, `${rel} still says the allowlist holds no credential`);
  }
  assert.match(security, /forwarded \*\*exactly as they are set, userinfo included\*\*/);
  assert.match(security, /On a `PreToolUse` event that is a fail-open, by design/);
  assert.match(security, /`gemini_research` with the ceiling closed passes \*\*no\*\* `--mode` at all/);
  assert.match(security, /in `doctor`'s own environment/);
  assert.match(security, /unit-timeouts spec planned for 1\.4\.0/);
  assert.match(security, /`GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CREDENTIALS` and the Vertex switch `GOOGLE_GENAI_USE_VERTEXAI`/);
  assert.match(security, /git diff --name-only -z --relative <hash> --/);
  for (const rel of ['docs/SECURITY.md', 'docs/ORCHESTRATION.md']) {
    assert.match(read(rel), /alone or inside a cluster like `-qb`/, `${rel} lists the branch-creating flags as Task 4 reads them`);
  }
});

// ── Task 3: the row, and the line SECURITY carries from it ───────────────────
// Two runs, plain and brief: the plugin run needs the operator's own
// `/claude-security` invocation, which has not happened, so its column reads
// `not run` in every cell and stays out of the arithmetic (1.3.0 ledger ruling).

const ROW = '## Security audit: plain, brief and plugin over one revision';
const ROW_ANCHOR = 'security-audit-plain-brief-and-plugin-over-one-revision';
const SUMMARY = /^\*\*In one line\.\*\* (Over `d7180b2`: plain (\d+) found, (\d+) verified; brief (\d+) found, (\d+) verified; plugin not run; (\d+) verified by the brief only\.)$/;
const COUNTS = ['Calls', 'Found', 'Verified', 'Refuted'];

/** The row's table, by run: one column per run, one line per measure. */
function runs(row) {
  const lines = row.split('\n').filter((l) => l.startsWith('| '));
  const cells = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
  const [head] = lines;
  const columns = cells(head).slice(1);
  const index = Object.fromEntries(['Plain', 'Brief', 'Plugin'].map((run) => {
    const at = columns.findIndex((c) => c.startsWith(run));
    assert.notEqual(at, -1, `a ${run} column in the table`);
    return [run, at + 1];
  }));
  const byMeasure = Object.fromEntries(lines.slice(1).map((l) => [cells(l)[0], cells(l)]));
  for (const m of ['Model', ...COUNTS]) assert.ok(byMeasure[m], `a ${m} line in the table`);
  const out = {};
  for (const [run, at] of Object.entries(index)) {
    const model = byMeasure.Model[at];
    const counts = COUNTS.map((m) => byMeasure[m][at]);
    if (run === 'Plugin') {
      out[run] = { model, counts };
      continue;
    }
    for (const n of counts) assert.match(n, /^\d+$/, `${run}: ${n} is a count`);
    const [calls, found, verified, refuted] = counts.map(Number);
    out[run] = { model, calls, found, verified, refuted };
  }
  return out;
}

test('MEASUREMENTS has the security-audit row: plain and brief over d7180b2, each with its model, every finding verified or refuted, the plugin not run, the lines agreeing', () => {
  const md = read('docs/MEASUREMENTS.md');
  const row = section(md, ROW);
  assert.doesNotMatch(row, /\[\[[^\]\n]+\]\]/, 'every slot filled from the ledger');
  assert.ok(row.includes('`d7180b2`'), 'the revision is named');
  const t = runs(row);
  assert.equal(t.Plain.model, '`gpt-6-astra`');
  assert.equal(t.Brief.model, '`gpt-6-astra`');
  assert.equal(t.Plugin.model, 'not run', 'the plugin column says it did not run');
  assert.deepEqual(t.Plugin.counts, COUNTS.map(() => 'not run'), 'in every cell');
  assert.ok(row.includes('`/claude-security`'), "the row says the plugin waits for the operator's own invocation");
  for (const run of ['Plain', 'Brief']) {
    const r = t[run];
    assert.ok(r.calls >= 1, `${run}: at least one call`);
    assert.equal(r.verified + r.refuted, r.found, `${run}: every finding ends verified or refuted`);
  }
  const lines = row.split('\n');
  const refutation = lines.find((l) => l.startsWith('**Refutation.** '));
  assert.ok(refutation && /`[^`]+`/.test(refutation), "the refuting agents' model is named");
  assert.match(refutation, /[Cc]onfound/, 'and the shared-context confound');
  const overlap = (lines.find((l) => l.startsWith('**Overlap.** ')) || '').match(/plain and brief (\d+)\.$/);
  assert.ok(overlap, 'the overlap line, in its one count');
  const both = Number(overlap[1]);
  const [P, B] = [t.Plain.verified, t.Brief.verified];
  // The three disjoint regions of two sets: every one is a count of defects,
  // so none can be negative.
  const regions = { 'plain only': P - both, 'brief only': B - both, both };
  for (const [region, n] of Object.entries(regions)) assert.ok(n >= 0, `${region}: ${n} is not a count — the overlap line and the table disagree`);
  const only = (lines.find((l) => l.startsWith('**Verified by the brief only.** ')) || '').match(/^\*\*Verified by the brief only\.\*\* (\d+)(\.| — .+)$/);
  assert.ok(only, 'the brief-only line: a count, then the findings');
  const briefOnly = Number(only[1]);
  assert.equal(briefOnly, regions['brief only'], 'brief-only = what the brief verified less what plain verified too');
  const summary = lines.find((l) => SUMMARY.test(l));
  assert.ok(summary, 'the one-line summary');
  const [pf, pv, bf, bv, bo] = summary.match(SUMMARY).slice(2).map(Number);
  assert.deepEqual([pf, pv, bf, bv, bo], [t.Plain.found, t.Plain.verified, t.Brief.found, t.Brief.verified, briefOnly], 'the summary says what the table says');
  const reading = lines.find((l) => l.startsWith('Reading: '));
  assert.ok(reading, 'the reading');
  assert.equal(reading.startsWith('Reading: the brief verified nothing that'), briefOnly === 0, 'the reading follows the brief-only count');
  const head = md.slice(0, md.indexOf('\n## '));
  assert.ok(head.split('\n').some((l) => l.endsWith(`| [${ROW.slice(3)}](#${ROW_ANCHOR}) |`)), 'the map at the top links the row');
  assert.ok(section(md, '## How the numbers are taken').includes('\n- **Security-audit counts.** '), 'and says how the counts are taken');
});

test("SECURITY carries the row's one-line summary word for word, linked to the row", () => {
  const line = section(read('docs/MEASUREMENTS.md'), ROW).split('\n').find((l) => SUMMARY.test(l));
  assert.ok(line, 'the summary line');
  const summary = line.match(SUMMARY)[1];
  const result = section(read('docs/SECURITY.md'), AUDITED).split('\n').find((l) => l.startsWith('**Result.** '));
  assert.ok(result.startsWith(`**Result.** ${summary} `), 'the summary, word for word, first');
  assert.match(result, /omelette-auditor. is not built/, 'what the result decided');
  assert.ok(result.endsWith(` The row, with the overlap and what only the brief found: [MEASUREMENTS](MEASUREMENTS.md#${ROW_ANCHOR}).`), 'linked to the row');
});
