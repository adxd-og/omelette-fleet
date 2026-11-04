#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/docs-chart.mjs
 * The two charts docs/MEASUREMENTS.md embeds, drawn from the literals below.
 *
 *   node scripts/docs-chart.mjs
 *
 * Writes docs/assets/charts/review-yield.svg and docs/assets/charts/test-suite.svg.
 * The numbers are copied by hand from the MEASUREMENTS tables each literal
 * names: change the table, change the literal, run the script. Same literals,
 * same bytes (no clock, no random id), so a re-run leaves the tree clean.
 *
 * Drawn the way scripts/eval-chart.mjs draws, so the charts in MEASUREMENTS
 * read as one set: hand-written SVG, no dependencies, no painted background, a
 * `<style>` whose `prefers-color-scheme: dark` block re-steps ink, axes and the
 * blue series; a `<title>` and a `<desc>` that states every number drawn; every
 * mark its own `<title>` and its numbers as `data-*` attributes, each plot
 * group its scale. One series in blue, the other in a gray that reads the same
 * on both themes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * docs/MEASUREMENTS.md, "Review yield per release": [release, found, accepted].
 * Rejected is found − accepted: for some releases the table's own column holds
 * text ("1 / 1", "1 rejected + 4 duplicates") whose parts sum to it.
 */
const REVIEW_YIELD = [
  ['0.3.4', 33, 32],
  ['0.3.5', 25, 23],
  ['0.3.6', 27, 25],
  ['0.3.7', 31, 28],
  ['1.0.0', 10, 8],
  ['1.1.0', 37, 29],
  ['1.2.0', 24, 17],
  ['1.3.0', 34, 30],
  ['1.4.0', 53, 49],
  ['1.5.0', 21, 15],
  ['1.6.0', 43, 38],
  ['1.6.1', 22, 18],
  ['1.6.2', 15, 13],
  ['1.7.0', 31, 25],
  ['1.7.1', 20, 18],
  ['1.7.2', 33, 29],
  ['1.7.3', 53, 39],
  ['1.8.0', 23, 17],
];
const REVIEW_YIELD_NOTE = '0.3.4 and 0.3.5 were reconstructed after the fact; the yield line is kept from 0.3.6 on.';

/**
 * docs/MEASUREMENTS.md, "The test suite before and after the clean-up gate":
 * the whole suite and the tester-written tests before (f336303) and after
 * (858d0a2) the gate. Then two later counts the table does not hold (`npm test`,
 * 2026-11-04): v1.8.0, and the docs pass after it removed 89 documentation
 * tests. Tester-written tests were counted only at the gate: null there.
 */
const TEST_SUITE = [
  { label: 'Before the gate', detail: 'f336303 · 2026-10-22', tests: 1871, testerWritten: 587 },
  { label: 'After the gate', detail: '858d0a2 · 2026-10-23', tests: 1556, testerWritten: 312 },
  { label: 'v1.8.0', detail: 'release · 2026-11-04', tests: 1855, testerWritten: null },
  { label: 'After the docs pass', detail: 'docs pass · 2026-11-04', tests: 1766, testerWritten: null },
];
const TEST_SUITE_NOTES = [
  'No catalogue mutant the suite caught before the gate went uncaught after it.',
  'Tester-written tests were counted only at the gate. The docs pass of 2026-11-04 removed the 89 documentation tests.',
];

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'docs', 'assets', 'charts');
const W = 880;

const STYLE = `<style>
text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.t{fill:#0b0b0b}.t2{fill:#52514e}.grid{stroke:#e1e0d9}.base{stroke:#c3c2b7}
.c1{fill:#2a78d6}.c0{fill:#898781}.in{fill:#ffffff}
@media (prefers-color-scheme: dark){
.t{fill:#f0efec}.t2{fill:#c3c2b7}.grid{stroke:#2c2c2a}.base{stroke:#383835}
.c1{fill:#3987e5}
}
</style>`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const px = (v) => Math.round(v * 100) / 100;
const textW = (s, size = 12) => String(s).length * size * 0.56;

/** The frame both charts share: the XML declaration, the svg element, its title and desc, the style. */
function frame({ id, height, title, desc, body }) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="${id}-title ${id}-desc" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}">\n` +
    `<title id="${id}-title">${esc(title)}</title>\n<desc id="${id}-desc">${esc(desc)}</desc>\n${STYLE}\n${body.join('\n')}\n</svg>\n`;
}

/** The one-line title and the subtitle lines under it; returns the baseline of the last. */
function header(title, lines) {
  const out = [`<text class="t" x="16" y="26" font-size="16" font-weight="600">${esc(title)}</text>`];
  lines.forEach((l, i) => out.push(`<text class="t2" x="16" y="${48 + i * 18}" font-size="12">${esc(l)}</text>`));
  return { out, bottom: 48 + (lines.length - 1) * 18 };
}

/** A legend row: a square swatch and its label per entry. */
function legend(y, entries) {
  const out = [];
  let x = 16;
  for (const e of entries) {
    out.push(`<rect class="${e.cls}" x="${x}" y="${y - 9}" width="10" height="10" rx="2"/>`);
    out.push(`<text class="t" x="${x + 16}" y="${y}" font-size="12">${esc(e.label)}</text>`);
    x += 16 + textW(e.label) + 24;
  }
  return out;
}

/** A round step (1, 2 or 5 × a power of ten) and the domain end it gives, at most six steps. */
function niceAxis(max) {
  const m = Math.max(1, max);
  for (let mag = 1; ; mag *= 10) {
    for (const k of [1, 2, 5]) {
      const step = k * mag;
      if (Math.ceil(m / step) <= 6) return { step, max: Math.ceil(m / step) * step };
    }
  }
}

/** A column from yBottom (square) up to yTop, with a 4px round at the top when `round`. */
function columnPath(x, w, yBottom, yTop, round) {
  const r = round ? Math.min(4, w / 2, (yBottom - yTop) / 2) : 0;
  if (r <= 0) return `M ${px(x)} ${px(yBottom)} V ${px(yTop)} H ${px(x + w)} V ${px(yBottom)} Z`;
  return `M ${px(x)} ${px(yBottom)} V ${px(yTop + r)} Q ${px(x)} ${px(yTop)} ${px(x + r)} ${px(yTop)} H ${px(x + w - r)} Q ${px(x + w)} ${px(yTop)} ${px(x + w)} ${px(yTop + r)} V ${px(yBottom)} Z`;
}

/** A horizontal bar from x0 (square) to x1, a 4px round at the data end. */
function barPath(x0, x1, y, h) {
  const r = Math.min(4, (x1 - x0) / 2, h / 2);
  if (r <= 0) return `M ${px(x0)} ${px(y)} H ${px(x0)} V ${px(y + h)} H ${px(x0)} Z`;
  return `M ${px(x0)} ${px(y)} H ${px(x1 - r)} Q ${px(x1)} ${px(y)} ${px(x1)} ${px(y + r)} V ${px(y + h - r)} Q ${px(x1)} ${px(y + h)} ${px(x1 - r)} ${px(y + h)} H ${px(x0)} Z`;
}

const REJECTED = 'rejected, not changed or duplicate';

/** Stacked columns, one per release in release order: accepted (blue, its number on it) under the rest (gray). */
function reviewYield() {
  const id = 'review-yield';
  const title = 'Review yield per release';
  const rows = REVIEW_YIELD.map(([release, found, accepted]) => ({ release, found, accepted, rejected: found - accepted }));
  const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
  const totals = `${rows.length} releases: ${sum('found')} findings, ${sum('accepted')} accepted, ${sum('rejected')} ${REJECTED}.`;
  const head = header(title, [`Findings per release, stacked: accepted (the number on each bar) and the rest, ${REJECTED}.`, totals, REVIEW_YIELD_NOTE]);
  const body = [...head.out, ...legend(head.bottom + 28, [{ cls: 'c1', label: 'Accepted' }, { cls: 'c0', label: `Rejected, not changed or duplicate (found − accepted)` }])];
  const axis = niceAxis(Math.max(...rows.map((r) => r.found)));
  const x0 = 56;
  const x1 = W - 16;
  const top = head.bottom + 72;
  const bottom = top + 240;
  const band = (x1 - x0) / rows.length;
  const barW = 24;
  const yOf = (v) => bottom - (v / axis.max) * (bottom - top);
  body.push(`<text class="t2" x="16" y="${top - 16}" font-size="12">Findings (count)</text>`);
  body.push(`<g class="plot" data-x0="${x0}" data-x1="${x1}" data-y0="${bottom}" data-y1="${top}" data-max="${axis.max}">`);
  for (let v = 0; v <= axis.max; v += axis.step) {
    const y = px(yOf(v));
    body.push(`<line class="${v === 0 ? 'base' : 'grid'}" x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke-width="1"/>`);
    body.push(`<text class="t2" x="${x0 - 8}" y="${px(yOf(v) + 4)}" font-size="11" text-anchor="end">${v}</text>`);
  }
  rows.forEach((r, i) => {
    const cx = x0 + band * (i + 0.5);
    const bx = cx - barW / 2;
    const yAcc = yOf(r.accepted);
    // A 2px gap at the seam, taken 1px from each segment, so the stack keeps its height.
    const accTop = r.rejected > 0 ? yAcc + 1 : yAcc;
    body.push(`<path class="bar c1" data-release="${r.release}" data-series="accepted" data-value="${r.accepted}" data-found="${r.found}" d="${columnPath(bx, barW, bottom, accTop, r.rejected === 0)}"><title>${esc(`${r.release}: ${r.accepted} accepted of ${r.found} found`)}</title></path>`);
    if (r.rejected > 0) {
      body.push(`<path class="bar c0" data-release="${r.release}" data-series="rejected" data-value="${r.rejected}" data-found="${r.found}" d="${columnPath(bx, barW, yAcc - 1, yOf(r.found), true)}"><title>${esc(`${r.release}: ${r.rejected} ${REJECTED}, of ${r.found} found`)}</title></path>`);
    }
    // The accepted number sits inside the blue segment when it fits, above the whole bar when it does not.
    const inside = bottom - accTop >= 18;
    body.push(inside
      ? `<text class="in" x="${px(cx)}" y="${px(accTop + 14)}" font-size="11" font-weight="600" text-anchor="middle">${r.accepted}</text>`
      : `<text class="t2" x="${px(cx)}" y="${px(yOf(r.found) - 6)}" font-size="11" text-anchor="middle">${r.accepted}</text>`);
    body.push(`<text class="t2" x="${px(cx)}" y="${bottom + 18}" font-size="12" text-anchor="middle">${esc(r.release)}</text>`);
  });
  body.push('</g>');
  body.push(`<text class="t2" x="${px((x0 + x1) / 2)}" y="${bottom + 40}" font-size="12" text-anchor="middle">Release, oldest first</text>`);
  const desc = `${title}: stacked bars, one per release in release order, found = accepted + ${REJECTED}. ${REVIEW_YIELD_NOTE} ` +
    rows.map((r) => `${r.release}: found ${r.found}, accepted ${r.accepted}, rejected ${r.rejected}`).join('. ') + `. Across ${totals}`;
  return frame({ id, height: bottom + 56, title, desc, body });
}

/** Horizontal bars, one row per count in time order: the whole suite (blue) and its tester-written part (gray). */
function testSuite() {
  const id = 'test-suite';
  const title = 'Tests in the suite, before and after the clean-up gate';
  const [before, after] = TEST_SUITE;
  const cut = `The gate cut ${before.tests - after.tests} tests, ${before.testerWritten - after.testerWritten} of them tester-written.`;
  const head = header(title, [cut, ...TEST_SUITE_NOTES]);
  const series = [
    { key: 'tests', name: 'Whole suite', cls: 'c1' },
    { key: 'testerWritten', name: 'Tester-written', cls: 'c0' },
  ];
  const body = [...head.out, ...legend(head.bottom + 28, series.map((s) => ({ cls: s.cls, label: s.name })))];
  const axis = niceAxis(Math.max(...TEST_SUITE.map((r) => r.tests)));
  const labelW = Math.max(...TEST_SUITE.map((r) => Math.max(textW(r.label, 12), textW(r.detail, 11)))) + 16;
  const x0 = px(16 + labelW);
  const x1 = W - 64;
  const top = head.bottom + 48;
  const barH = 14;
  const band = 56;
  const bottom = top + TEST_SUITE.length * band;
  const xOf = (v) => x0 + (v / axis.max) * (x1 - x0);
  body.push(`<g class="plot" data-x0="${x0}" data-x1="${x1}" data-max="${axis.max}">`);
  for (let v = 0; v <= axis.max; v += axis.step) {
    body.push(`<text class="t2" x="${px(xOf(v))}" y="${bottom + 16}" font-size="11" text-anchor="middle">${v}</text>`);
  }
  TEST_SUITE.forEach((r, i) => {
    const rowTop = top + i * band;
    body.push(`<text class="t" x="${px(x0 - 12)}" y="${rowTop + 26}" font-size="12" text-anchor="end">${esc(r.label)}</text>`);
    body.push(`<text class="t2" x="${px(x0 - 12)}" y="${rowTop + 41}" font-size="11" text-anchor="end">${esc(r.detail)}</text>`);
    series.forEach((s, j) => {
      const y = rowTop + 13 + j * (barH + 2);
      const v = r[s.key];
      if (v === null) {
        body.push(`<text class="t2" x="${px(x0 + 8)}" y="${y + barH - 3}" font-size="11">not counted</text>`);
        return;
      }
      body.push(`<path class="bar ${s.cls}" data-row="${esc(r.label)}" data-series="${s.key}" data-value="${v}" d="${barPath(x0, xOf(v), y, barH)}"><title>${esc(`${r.label} (${r.detail}): ${s.name.toLowerCase()}, ${v} tests`)}</title></path>`);
      body.push(`<text class="t2" x="${px(xOf(v) + 8)}" y="${y + barH - 2}" font-size="12">${v}</text>`);
    });
  });
  body.push(`<line class="base" x1="${x0}" y1="${top}" x2="${x0}" y2="${bottom}" stroke-width="1"/>`, '</g>');
  body.push(`<text class="t2" x="${px((x0 + x1) / 2)}" y="${bottom + 38}" font-size="12" text-anchor="middle">Tests in the suite (count)</text>`);
  const desc = `${title}. ${cut} ${TEST_SUITE_NOTES.join(' ')} ` +
    TEST_SUITE.map((r) => `${r.label} (${r.detail}): ${r.tests} tests, ${r.testerWritten === null ? 'tester-written not counted' : `${r.testerWritten} tester-written`}`).join('. ') + '.';
  return frame({ id, height: bottom + 54, title, desc, body });
}

mkdirSync(OUT, { recursive: true });
for (const [name, svg] of [['review-yield.svg', reviewYield()], ['test-suite.svg', testSuite()]]) {
  writeFileSync(join(OUT, name), svg);
  console.log(`wrote docs/assets/charts/${name}`);
}
