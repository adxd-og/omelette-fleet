/**
 * omelette-fleet :: test/docs-anchors-1.6.1.test.mjs
 * 1.6.1 Task 5: every topic has one home and every other copy is a link, so a
 * link that points at a heading that moved is now the way a fact gets lost.
 * Every `](file#anchor)` and `](#anchor)` in the docs set must name a heading
 * of the file it points at (GitHub's slug rule, duplicates numbered).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FILES = ['README.md', 'CHANGELOG.md', 'docs/ORCHESTRATION.md', 'docs/CONFIG.md', 'docs/SECURITY.md',
  'docs/ADAPTERS.md', 'docs/STATUS-FEED.md', 'docs/ARCHITECTURE.md', 'docs/MEASUREMENTS.md'];
const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');

function headings(rel) {
  const seen = new Map(); const out = new Set(); let fence = false;
  for (const line of readFileSync(join(ROOT, rel), 'utf8').split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^#{1,6} (.+)$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]); const n = seen.get(base);
    out.add(n === undefined ? base : `${base}-${n + 1}`);
    seen.set(base, n === undefined ? 0 : n + 1);
  }
  return out;
}

test('every anchored link in the docs set names a heading of the file it points at', () => {
  const heads = new Map(FILES.map((f) => [f, headings(f)]));
  const broken = []; let checked = 0;
  for (const f of FILES) {
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/\]\(([^)\s]*)#([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(m[1])) continue; // an external URL
      const target = m[1] ? normalize(join(dirname(f), m[1])) : f;
      if (!heads.has(target)) {
        if (!existsSync(join(ROOT, target))) broken.push(`${f}: ${m[0]} — no such file`);
        continue; // a file outside the docs set: its headings are not read here
      }
      checked += 1;
      if (!heads.get(target).has(m[2])) broken.push(`${f}: ${target}#${m[2]} is not a heading`);
    }
  }
  assert.deepEqual(broken, []);
  assert.ok(checked > 200, `the docs set carries its cross-links (checked ${checked})`);
});
