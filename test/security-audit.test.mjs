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
