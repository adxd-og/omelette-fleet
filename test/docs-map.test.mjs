// The docs are maps (1.0.0, spec docs/superpowers/specs/2026-09-11-1.0.0-design.md §1, §2, §5):
// every doc opens with a `| Question | Where |` table whose links resolve to
// real headings under GitHub's slug rule, README maps the set, and every
// diagram the docs embed is a committed, standalone, offline SVG.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = [
  'README.md',
  'docs/ORCHESTRATION.md',
  'docs/CONFIG.md',
  'docs/SECURITY.md',
  'docs/ADAPTERS.md',
  'docs/STATUS-FEED.md',
  'docs/ARCHITECTURE.md',
];
const MAP_HEADER = /^\| Question \| Where \|$/m;
const SET_HEADER = /^\| If you want to know… \| Read \|$/m;
const DIAGRAM_DIR = 'docs/assets/diagrams';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// GitHub's heading slug: lowercase, drop backticks and everything that is not a
// letter, digit, space, hyphen or underscore, spaces to hyphens; a repeated
// heading gets -1, -2, …
function slug(text) {
  return text.replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}
function headingIds(md) {
  const seen = new Map();
  const ids = new Set();
  for (const m of md.matchAll(/^#{1,6}[ \t]+(.+?)\s*#*\s*$/gm)) {
    let id = slug(m[1]);
    if (seen.has(id)) { seen.set(id, seen.get(id) + 1); id = `${id}-${seen.get(id)}`; } else seen.set(id, 0);
    ids.add(id);
  }
  return ids;
}
// The map is the first table after the header line; rows until a blank line.
function mapRows(md, header) {
  const at = md.search(header);
  assert.notEqual(at, -1, 'map header present');
  const body = md.slice(at).split(/\n\n/)[0].split('\n').slice(2);
  return body.map((row) => row.split('|').map((c) => c.trim()).filter(Boolean));
}

for (const rel of DOCS) {
  test(`${rel} opens with a map whose anchors resolve`, () => {
    const md = read(rel);
    const headerLine = md.split('\n').findIndex((l) => MAP_HEADER.test(l));
    assert.notEqual(headerLine, -1, 'map table present');
    assert.ok(headerLine < 60, `map sits in the first 60 lines (line ${headerLine + 1})`);
    const rows = mapRows(md, MAP_HEADER);
    assert.ok(rows.length >= 4, `at least four rows (${rows.length})`);
    const ids = headingIds(md);
    for (const [question, where] of rows) {
      assert.ok(question.length > 8, `a real question: ${question}`);
      const link = where.match(/^\[[^\]]+\]\(#([^)]+)\)$/);
      assert.ok(link, `Where cell is an intra-file link: ${where}`);
      assert.ok(ids.has(link[1]), `#${link[1]} is a heading of ${rel}`);
    }
  });
}

test('README maps the docs set: every row points at a file that exists', () => {
  const md = read('README.md');
  const rows = mapRows(md, SET_HEADER);
  const targets = rows.map(([, where]) => where.match(/^\[[^\]]+\]\(([^)#]+)\)$/)?.[1]);
  for (const t of targets) {
    assert.ok(t, 'Read cell is a file link');
    assert.ok(fs.existsSync(path.join(ROOT, t)), `${t} exists`);
  }
  for (const doc of DOCS.slice(1).concat('CHANGELOG.md')) assert.ok(targets.includes(doc), `${doc} is mapped`);
});

test('every diagram the docs embed is a standalone offline SVG, and every shipped SVG is embedded', () => {
  const embedded = new Set();
  for (const rel of DOCS) {
    for (const m of read(rel).matchAll(/<img src="([^"]+\.svg)"/g)) {
      if (/^[a-z]+:/.test(m[1])) continue; // a badge from a remote host is not a diagram
      const abs = path.resolve(ROOT, path.dirname(rel), m[1]);
      assert.ok(fs.existsSync(abs), `${rel} embeds ${m[1]}, which exists`);
      embedded.add(path.relative(ROOT, abs));
    }
  }
  const dir = path.join(ROOT, DIAGRAM_DIR);
  const shipped = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.svg')) : [];
  for (const f of shipped) {
    const rel = `${DIAGRAM_DIR}/${f}`;
    assert.ok(embedded.has(rel), `${rel} is embedded by a doc`);
    const svg = read(rel);
    assert.ok(svg.startsWith('<?xml'), `${rel} opens with the XML declaration`);
    assert.match(svg, /<svg[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${rel} declares the SVG namespace`);
    assert.match(svg, /<svg[^>]*\sviewBox="/, `${rel} has a viewBox`);
    assert.doesNotMatch(svg, /@import/, `${rel} imports no font`);
    const urls = [...svg.matchAll(/https?:\/\/[^"' )]+/g)].map((m) => m[0]).filter((u) => !u.startsWith('http://www.w3.org/'));
    assert.deepEqual(urls, [], `${rel} references no external URL`);
  }
});
