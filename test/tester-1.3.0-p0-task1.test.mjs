// Tester coverage for 1.3.0 P0 (spec docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md,
// "P0 — the security brief over this package", and the P0 bullet of "## Tests").
// Written from the spec against the rendered doc and its fixture directly —
// never against the implementer's test/security-audit.test.mjs, which this
// file imports nothing from. No Trail of Bits text is copied here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SECURITY = 'docs/SECURITY.md';
const FIXTURE = 'test/fixtures/cloudflare-mcp-trust-classes.txt';
const IMPL_TEST = 'test/security-audit.test.mjs';
const HEADING = '## How this package is audited';
const CF_COMMIT = 'c1c8a8c1471069fb0e188eeaff69b8e8db6564a8';
const TOB_COMMIT = '32e34f8173796e3566a51aee877dc96bc5191f64';
const CUT = '--- quoted block: byte for byte from the next line to the end of this file ---\n';

// GitHub's heading slug rule (see test/docs-map.test.mjs): lowercase, drop
// backticks and everything that is not a letter, digit, space, hyphen or
// underscore, spaces to hyphens.
function slug(text) {
  return text.replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}

function headingIds(md) {
  const ids = new Set();
  const prose = md.replace(/^```[\s\S]*?^```[ \t]*$/gm, '');
  for (const m of prose.matchAll(/^#{1,6}[ \t]+(.+?)\s*#*\s*$/gm)) ids.add(slug(m[1]));
  return ids;
}

// The section from a "## " heading line to the next "## " heading line, fence-aware.
function section(md, heading) {
  const lines = md.split('\n');
  const from = lines.indexOf(heading);
  assert.notEqual(from, -1, `${heading} is a heading of the doc`);
  let fenced = false;
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i++) {
    if (lines[i].startsWith('```')) fenced = !fenced;
    else if (!fenced && /^## /.test(lines[i])) { to = i; break; }
  }
  return lines.slice(from, to).join('\n');
}

const textFences = (md) => [...md.matchAll(/^```text\n([\s\S]*?)^```$/gm)].map((m) => m[1]);

function fixtureParts() {
  const text = read(FIXTURE);
  const at = text.indexOf(CUT);
  assert.notEqual(at, -1, 'the fixture carries the cut marker');
  return { header: text.slice(0, at), block: text.slice(at + CUT.length) };
}

// ── map row ───────────────────────────────────────────────────────────────

test('SECURITY.md opens with a map row for the new section, and its anchor resolves under the GitHub slug rule', () => {
  const md = read(SECURITY);
  const headerLine = md.split('\n').findIndex((l) => l === '| Question | Where |');
  assert.notEqual(headerLine, -1, 'the map table is present');
  const mapBody = md.slice(md.indexOf('| Question | Where |')).split(/\n\n/)[0];
  assert.match(
    mapBody,
    /\| How is this package itself audited[^|]*\| \[How this package is audited\]\(#how-this-package-is-audited\) \|/,
    'a map row links the new section with the expected question and anchor text',
  );
  const ids = headingIds(md);
  assert.ok(ids.has('how-this-package-is-audited'), 'the anchor resolves to a real heading under the GitHub slug rule');
});

// ── quoted block byte-for-byte against the fixture ──────────────────────────

test("the SECURITY quoted block equals the fixture's quoted block byte for byte", () => {
  const sec = section(read(SECURITY), HEADING);
  const fences = textFences(sec);
  assert.ok(fences.length >= 1, 'the section has at least one text fence (the quote)');
  const { block } = fixtureParts();
  assert.equal(fences[0], block, 'the first text fence in the doc is the fixture block, byte for byte');
});

test('the notice fence is kept beside the quoted block, inside the same section, right after it', () => {
  const sec = section(read(SECURITY), HEADING);
  const fences = textFences(sec);
  assert.equal(fences.length, 2, 'exactly two text fences: the quote, then the notice');
  assert.ok(fences[1].includes('Copyright (c) 2025-2026 Cloudflare, Inc.'), 'the second fence carries the copyright line');
  const lines = sec.split('\n');
  const quoteOpen = lines.indexOf('```text');
  const quoteClose = lines.indexOf('```', quoteOpen + 1);
  const noticeOpen = lines.indexOf('```text', quoteClose + 1);
  assert.ok(noticeOpen > quoteClose, 'the notice fence opens after the quote fence closes');
  assert.ok(noticeOpen - quoteClose <= 4, 'no more than one short paragraph sits between the quote and its notice');
});

// ── fixture header: upstream repo, path, commit, Cloudflare notice ─────────

test('the fixture header names the upstream repo, path and pinned commit', () => {
  const { header } = fixtureParts();
  for (const fact of ['cloudflare/security-audit-skill', 'skills/security-audit/AI-AND-LLM.md', CF_COMMIT]) {
    assert.ok(header.includes(fact), `the fixture header names ${fact}`);
  }
});

test("the fixture header carries Cloudflare's copyright line, the MIT permission paragraph and the warranty paragraph", () => {
  const { header } = fixtureParts();
  assert.ok(header.includes('Copyright (c) 2025-2026 Cloudflare, Inc.'), 'the copyright line');
  assert.ok(header.includes('Permission is hereby granted, free of charge,'), 'the MIT permission paragraph');
  assert.ok(
    header.includes('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND'),
    'the warranty paragraph',
  );
});

test('the doc names the upstream commit next to the quote', () => {
  const sec = section(read(SECURITY), HEADING);
  assert.ok(sec.includes(`\`${CF_COMMIT}\``), 'the upstream commit hash is named in the section');
});

// ── Trail of Bits: linked, at the pinned commit, labelled CC-BY-SA-4.0 ─────

test('the doc links both Trail of Bits skills at the pinned commit and labels them CC-BY-SA-4.0', () => {
  const sec = section(read(SECURITY), HEADING);
  assert.ok(sec.includes('CC-BY-SA-4.0'), 'the license is named');
  for (const skillPath of [
    'plugins/differential-review/skills/differential-review/SKILL.md',
    'plugins/fp-check/skills/fp-check/SKILL.md',
  ]) {
    assert.ok(
      sec.includes(`https://github.com/trailofbits/skills/blob/${TOB_COMMIT}/${skillPath}`),
      `links ${skillPath} at ${TOB_COMMIT}`,
    );
  }
  assert.doesNotMatch(sec, /```[\s\S]*trailofbits[\s\S]*```/i, 'no code fence in the section quotes Trail of Bits material');
});

// ── the four parts, each with a trust class ─────────────────────────────────

test('the doc names the four parts, each with a non-empty trust class', () => {
  const sec = section(read(SECURITY), HEADING);
  const rows = sec.split('\n').filter((l) => l.startsWith('| ') && !/^\|\s*-+\s*\|/.test(l));
  const parts = ['servers/*.mjs', 'hooks/omelette-guard.mjs', 'bin/omelette-fleet.mjs', 'agents/'];
  for (const part of parts) {
    const row = rows.find((r) => r.includes(`\`${part}\``));
    assert.ok(row, `a table row names ${part}`);
    const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
    assert.ok(cells.length >= 3, `${part}'s row has a Files and a Trust class column`);
    const trustClass = cells[2];
    assert.ok(trustClass && trustClass.length > 10, `${part} carries a real trust-class description, not a placeholder`);
  }
});

// ── the three runs and the refutation gate ──────────────────────────────────

test('the doc describes the three runs — plain, brief, plugin — over the same revision', () => {
  const sec = section(read(SECURITY), HEADING);
  assert.ok(/\*\*Plain\*\*/.test(sec), 'names the plain run');
  assert.ok(/\*\*Brief\*\*/.test(sec), 'names the brief run');
  assert.ok(/\*\*Plugin\*\*/.test(sec), 'names the plugin run');
  assert.ok(sec.includes('`d7180b2`'), 'the runs are pinned to the same revision');
  assert.ok(sec.includes('gpt-6-astra'), 'the plain/brief run names its model');
  assert.ok(sec.includes('claude-security'), 'the plugin run names the installed plugin');
});

test('the doc describes the refutation gate: a fresh reader tries to disprove each finding before it counts', () => {
  const sec = section(read(SECURITY), HEADING);
  assert.ok(/disprove/i.test(sec), 'the gate is described as an attempt to disprove a finding');
  assert.ok(/`verified`/.test(sec) && /`refuted`/.test(sec), 'the two outcomes are named');
});

// ── no absolute home path in any changed file ───────────────────────────────

test('no absolute home path appears in the changed files', () => {
  const home = os.homedir();
  const pattern = /\/(Users|home)\/[^/\s'")]+/;
  for (const rel of [SECURITY, FIXTURE, IMPL_TEST]) {
    const text = read(rel);
    assert.ok(!text.includes(home), `${rel} does not literally contain this machine's home directory`);
    const hit = text.match(pattern);
    assert.equal(hit, null, `${rel} carries no absolute home path (found: ${hit && hit[0]})`);
  }
});
