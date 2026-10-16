#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/eval-chart.mjs
 * The public charts, drawn from one date's aggregate (plan
 * docs/superpowers/plans/2026-10-16-evals-mvp.md, Task 3).
 *
 *   node scripts/eval-chart.mjs --date YYYY-MM-DD [--dir D] [--out DIR]
 *
 * Reads `<D>/aggregates/<date>.json` (scripts/eval-blind.mjs --aggregate) and
 * writes `evals/charts/{r-accuracy,v-recall-precision,effort,cost}.svg` (or
 * `--out`). An aggregate is numbers and arm names only, and so is every chart:
 * nothing from a task, a key or an answer can reach one.
 *
 * HAND-WRITTEN SVG, no dependencies. Readable in GitHub's light and dark
 * themes: no painted background, and a `<style>` whose
 * `prefers-color-scheme: dark` block re-steps ink, grid and series (blue and
 * orange, validated for both surfaces). Every chart carries a `<title>` and a
 * `<desc>` that states every number drawn — the table view for a screen
 * reader — and every mark its own `<title>`.
 *
 * Marks carry their numbers as `data-*` attributes and each plot group its
 * scale, so a test can check the geometry against the aggregate without
 * snapshotting a file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CODEX_MODELS } from '../units/codex/models.js';
import { GEMINI_MODELS } from '../units/gemini/models.js';
import { GROK_MODELS } from '../units/grok/models.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_DIR = join(ROOT, '.omelette', 'evals');
const DEFAULT_OUT = join(ROOT, 'evals', 'charts');
const USAGE = 'usage: node scripts/eval-chart.mjs --date YYYY-MM-DD [--dir D] [--out DIR]';

const W = 760;
const LEVELS = ['Low', 'Medium', 'High'];
const LEVEL_RE = /^(.*) \((Low|Medium|High)\)$/;
const BATCH_NOTE = '* one prompt for all questions';
const GEMINI_TOKENS_NOTE = "Gemini's token counts exclude thinking tokens: the unit reports input and output only.";

const STYLE = `<style>
text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.t{fill:#0b0b0b}.t2{fill:#52514e}.grid{stroke:#e1e0d9}.base{stroke:#c3c2b7}
.c1{fill:#2a78d6}.c2{fill:#eb6834}.c3{fill:#1baf7a}.k1{stroke:#2a78d6}.k2{stroke:#eb6834}.k3{stroke:#1baf7a}
.ring{stroke:#ffffff;stroke-width:2}.line{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.run{fill-opacity:0.45}
@media (prefers-color-scheme: dark){
.t{fill:#f0efec}.t2{fill:#c3c2b7}.grid{stroke:#2c2c2a}.base{stroke:#383835}
.c1{fill:#3987e5}.c2{fill:#d95926}.c3{fill:#199e70}.k1{stroke:#3987e5}.k2{stroke:#d95926}.k3{stroke:#199e70}
.ring{stroke:#0d1117}
}
</style>`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (v) => Math.round(v * 10) / 10;
const px = (v) => Math.round(v * 100) / 100;
const fmtCount = (v) => (v === null || v === undefined ? 'n/a' : String(r1(v)));
const fmtPct = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v)} %`);
const textW = (s, size = 12) => String(s).length * size * 0.56;

const CATALOG = new Map([...GEMINI_MODELS, ...GROK_MODELS, ...CODEX_MODELS].map((m) => [m.id, m.label]));

/** An arm as a reader names it: the catalog's label (or the id, its level after a middle dot), then the effort Codex or Grok used. */
export function armLabel(a) {
  const level = LEVEL_RE.exec(a.model || '');
  const base = CATALOG.get(a.model) || (level ? `${level[1]} · ${level[2]}` : a.model || a.arm);
  return a.unit !== 'gemini' && a.effort ? `${base} · ${a.effort}` : base;
}

const UNIT_ORDER = ['gemini', 'grok', 'codex'];
const CATALOG_ORDER = [...GEMINI_MODELS, ...GROK_MODELS, ...CODEX_MODELS].map((m) => m.id);

/** The order arms are drawn and keyed in: the fleet's unit order, then model family, level, catalog order. */
function sortArms(arms) {
  const keyOf = (a) => {
    const level = LEVEL_RE.exec(a.model || '');
    const at = CATALOG_ORDER.indexOf(a.model);
    return [UNIT_ORDER.indexOf(a.unit), level ? level[1] : '', level ? LEVELS.indexOf(level[2]) : at < 0 ? 999 : at, a.arm];
  };
  return [...arms].sort((x, y) => {
    const [a, b] = [keyOf(x), keyOf(y)];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      return typeof a[i] === 'number' ? a[i] - b[i] : String(a[i]).localeCompare(String(b[i]));
    }
    return 0;
  });
}

/** A run whose calls all failed: it has no score, and is drawn hollow at the baseline. */
const failedRun = (r) => r.failed > 0 && (r.correct === null || r.recall === null);
const FAILED_TITLE = 'failed run';

/** Date, CLI versions and N for the arms one chart draws, and the failed runs when there are any. */
function caption(date, arms) {
  const ns = arms.map((a) => a.n);
  const lo = Math.min(...ns);
  const hi = Math.max(...ns);
  const n = lo === hi ? `N = ${lo} run${lo === 1 ? '' : 's'} per arm` : `N = ${lo}–${hi} runs per arm`;
  const clis = [...new Set(arms.flatMap((a) => a.cli || []))].sort();
  const failed = arms.reduce((k, a) => k + (a.failedRuns || 0), 0);
  return [`${date} · ${n}${hi <= 2 ? ' · runs shown, no intervals' : ''}`, `CLI versions: ${clis.join(', ') || 'not recorded'}`, ...(failed ? [`failed runs: ${failed}`] : [])];
}

/** The frame every chart shares: the svg element, its title and desc, the style. */
function frame({ id, height, title, desc, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="${id}-title ${id}-desc" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}">\n` +
    `<title id="${id}-title">${esc(title)}</title>\n<desc id="${id}-desc">${esc(desc)}</desc>\n${STYLE}\n${body.join('\n')}\n</svg>\n`;
}

function header({ title, subtitle, lines }) {
  const out = [
    `<text class="t" x="16" y="26" font-size="16" font-weight="600">${esc(title)}</text>`,
    `<text class="t2" x="16" y="46" font-size="12">${esc(subtitle)}</text>`,
  ];
  lines.forEach((l, i) => out.push(`<text class="t2" x="16" y="${66 + i * 16}" font-size="12">${esc(l)}</text>`));
  return { out, bottom: 66 + lines.length * 16 };
}

/** A legend row: a swatch (square, circle or line) and its label per entry. */
function legend(y, entries) {
  const out = [];
  let x = 16;
  for (const e of entries) {
    if (e.shape === 'circle') out.push(`<circle class="${e.cls}" cx="${x + 5}" cy="${y - 4}" r="5"/>`);
    else out.push(`<rect class="${e.cls}" x="${x}" y="${y - 9}" width="10" height="10" rx="2"/>`);
    out.push(`<text class="t" x="${x + 16}" y="${y}" font-size="12">${esc(e.label)}</text>`);
    x += 16 + textW(e.label) + 24;
  }
  return out;
}

/** A horizontal bar from x0 to x1: square at the baseline, a 4px round at the data end. */
function barPath(x0, x1, y, h) {
  const r = Math.min(4, (x1 - x0) / 2, h / 2);
  if (r <= 0) return `M ${px(x0)} ${px(y)} H ${px(x0)} V ${px(y + h)} H ${px(x0)} Z`;
  return `M ${px(x0)} ${px(y)} H ${px(x1 - r)} Q ${px(x1)} ${px(y)} ${px(x1)} ${px(y + r)} V ${px(y + h - r)} Q ${px(x1)} ${px(y + h)} ${px(x1 - r)} ${px(y + h)} H ${px(x0)} Z`;
}

/** A tick step and a domain end that are round numbers, for a count axis. */
function countAxis(max) {
  const m = Math.max(1, max);
  const step = m <= 10 ? 1 : m <= 20 ? 2 : m <= 50 ? 5 : 10;
  return { max: Math.ceil(m / step) * step, step };
}

const emptyChart = (id, title, date) => frame({
  id, height: 90, title, desc: `${title}: nothing was measured for this chart on ${date}.`,
  body: [`<text class="t" x="16" y="26" font-size="16" font-weight="600">${esc(title)}</text>`,
    `<text class="t2" x="16" y="52" font-size="12">${esc(`Nothing was measured for this chart on ${date}.`)}</text>`],
});

/**
 * Rows of arms, two bars each (a mean per series), a dot per run on each bar.
 * `series`: [{key, name, cls, mean(arm), run(run)}]; values are on one axis.
 */
function barChart({ id, title, subtitle, date, arms, series, axis, fmt, axisTitle, notes = [] }) {
  if (!arms.length) return emptyChart(id, title, date);
  const head = header({ title, subtitle, lines: caption(date, arms) });
  const body = [...head.out, ...legend(head.bottom + 22, series.map((s) => ({ cls: s.cls, label: s.name })))];
  const labels = arms.map((a) => `${armLabel(a)}${a.batch ? ' *' : ''}`);
  const labelW = Math.min(300, Math.max(140, Math.max(...labels.map((l) => textW(l))) + 16));
  const x0 = 16 + labelW;
  const x1 = W - 60;
  const top = head.bottom + 44;
  const barH = 12;
  const band = 16 + series.length * barH + (series.length - 1) * 2;
  const bottom = top + arms.length * band;
  const xOf = (v) => x0 + (Math.max(0, v) / axis.max) * (x1 - x0);
  body.push(`<g class="plot" data-x0="${x0}" data-x1="${x1}" data-max="${axis.max}">`);
  for (let v = 0; v <= axis.max + 1e-9; v += axis.step) {
    const x = px(xOf(v));
    body.push(`<line class="grid" x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke-width="1"/>`);
    body.push(`<text class="t2" x="${x}" y="${bottom + 16}" font-size="11" text-anchor="middle">${esc(fmt(v))}</text>`);
  }
  body.push(`<text class="t2" x="${px((x0 + x1) / 2)}" y="${bottom + 34}" font-size="12" text-anchor="middle">${esc(axisTitle)}</text>`);
  arms.forEach((a, i) => {
    const rowTop = top + i * band;
    body.push(`<text class="t" x="${x0 - 10}" y="${px(rowTop + band / 2 + 4)}" font-size="12" text-anchor="end">${esc(labels[i])}</text>`);
    series.forEach((s, j) => {
      const y = rowTop + 8 + j * (barH + 2);
      const m = s.mean(a);
      const value = m === null ? '' : ` data-value="${r1(m * 1e6) / 1e6}"`;
      body.push(`<path class="bar ${s.cls}" data-arm="${esc(a.arm)}" data-series="${s.key}"${value} d="${barPath(x0, m === null ? x0 : xOf(m), y, barH)}"><title>${esc(`${armLabel(a)}: ${s.name}, mean ${fmt(m)}`)}</title></path>`);
      // The value sits past the bar's end and past every run dot on that bar.
      const runEnds = a.runs.map((r) => s.run(r)).filter((v) => typeof v === 'number').map(xOf);
      const labelX = Math.max(m === null ? x0 : xOf(m), ...runEnds.map((x) => x + 4));
      body.push(`<text class="t2" x="${px(labelX + 8)}" y="${y + barH - 2}" font-size="11">${esc(fmt(m))}</text>`);
      for (const r of a.runs) {
        if (failedRun(r)) {
          body.push(`<circle class="failed-run ${s.cls.replace('c', 'k')}" fill="none" stroke-width="1.5" data-arm="${esc(a.arm)}" data-series="${s.key}" data-run="${r.run}" cx="${px(x0)}" cy="${y + barH / 2}" r="4"><title>${esc(`${armLabel(a)}: ${s.name}, run ${r.run}: ${FAILED_TITLE}`)}</title></circle>`);
          continue;
        }
        const v = s.run(r);
        if (v === null || v === undefined) continue;
        body.push(`<circle class="dot ${s.cls} ring" data-arm="${esc(a.arm)}" data-series="${s.key}" data-run="${r.run}" data-value="${r1(v * 1e6) / 1e6}" cx="${px(xOf(v))}" cy="${y + barH / 2}" r="4"><title>${esc(`${armLabel(a)}: ${s.name}, run ${r.run}: ${fmt(v)}`)}</title></circle>`);
      }
    });
  });
  body.push(`<line class="base" x1="${x0}" y1="${top}" x2="${x0}" y2="${bottom}" stroke-width="1"/>`, '</g>');
  const footY = bottom + 58;
  notes.forEach((n, i) => body.push(`<text class="t2" x="16" y="${footY + i * 16}" font-size="12">${esc(n)}</text>`));
  const desc = `${subtitle}. ${caption(date, arms).join('. ')}. ` + arms.map((a) => `${armLabel(a)}${a.batch ? ' (one prompt for all questions)' : ''}: ` +
    series.map((s) => `${s.name} ${fmt(s.mean(a))} (runs ${a.runs.map((r) => (failedRun(r) ? FAILED_TITLE : fmt(s.run(r)))).join(', ')})`).join('; ')).join('. ') + '.';
  return frame({ id, height: footY + notes.length * 16 + 8, title, desc, body });
}

function rAccuracy(agg) {
  const arms = sortArms(agg.arms.filter((a) => a.suite === 'R'));
  const tasks = Math.max(0, ...arms.map((a) => a.tasks || 0));
  const most = Math.max(tasks, ...arms.flatMap((a) => [a.mean.inventedUrls || 0, ...a.runs.map((r) => r.inventedUrls || 0)]));
  return barChart({
    id: 'r-accuracy',
    title: 'R: research answers that match the key',
    subtitle: `Correct answers out of ${tasks} questions, and cited URLs that were unreachable or invented: the bar is the mean, each dot a run`,
    date: agg.date,
    arms,
    series: [
      { key: 'correct', name: `Correct (of ${tasks})`, cls: 'c1', mean: (a) => a.mean.correct, run: (r) => r.correct },
      { key: 'invented-urls', name: 'Invented or unreachable URLs', cls: 'c2', mean: (a) => a.mean.inventedUrls, run: (r) => r.inventedUrls },
    ],
    axis: countAxis(most),
    fmt: fmtCount,
    axisTitle: 'Count per run',
    notes: arms.some((a) => a.batch) ? [BATCH_NOTE] : [],
  });
}

function vRecallPrecision(agg) {
  const arms = sortArms(agg.arms.filter((a) => a.suite === 'V'));
  const keyItems = Math.max(0, ...arms.map((a) => a.keyItems || 0));
  const pct = (v) => (v === null || v === undefined ? null : v * 100);
  return barChart({
    id: 'v-recall-precision',
    title: 'V: review against a known-defect key',
    subtitle: `Recall (key defects found, of ${keyItems}) and precision (real findings over all findings): the bar is the mean, each dot a run`,
    date: agg.date,
    arms,
    series: [
      { key: 'recall', name: 'Recall', cls: 'c1', mean: (a) => pct(a.mean.recall), run: (r) => pct(r.recall) },
      { key: 'precision', name: 'Precision', cls: 'c2', mean: (a) => pct(a.mean.precision), run: (r) => pct(r.precision) },
    ],
    axis: { max: 100, step: 20 },
    fmt: fmtPct,
    axisTitle: 'Percent',
    notes: ['Codex and Grok review a snapshot of the commit; Gemini, which has no review tool, gets the file as text in its brief.'],
  });
}

/** The score a suite is charted by, 0–100: R the share answered correctly, V recall. */
const score = (a, src = a.mean) => {
  const v = a.suite === 'R' ? (a.tasks && src.correct !== null && src.correct !== undefined ? src.correct / a.tasks : null) : src.recall;
  return v === null || v === undefined ? null : v * 100;
};

function effort(agg) {
  const id = 'effort';
  const title = 'Effort: Gemini scores at Low, Medium and High';
  const arms = agg.arms.filter((a) => a.unit === 'gemini' && LEVEL_RE.test(a.model || ''));
  if (!arms.length) return emptyChart(id, title, agg.date);
  const families = [...new Set(arms.map((a) => LEVEL_RE.exec(a.model)[1]))].sort((x, y) => x.localeCompare(y)).slice(0, 3);
  const cls = (f) => families.indexOf(f) + 1;
  const batchFamilies = new Set(arms.filter((a) => a.suite === 'R' && a.batch).map((a) => LEVEL_RE.exec(a.model)[1]));
  const head = header({ title, subtitle: 'R: share of questions answered correctly · V: recall. The large point is the mean, the small ones the runs', lines: caption(agg.date, arms) });
  const body = [...head.out, ...legend(head.bottom + 22, families.map((f) => ({ shape: 'circle', cls: `c${cls(f)}`, label: `${f}${batchFamilies.has(f) ? ' *' : ''}` })))];
  const top = head.bottom + 58;
  const h = 220;
  const gap = 56;
  const pw = (W - 32 - 48 - gap) / 2;
  const descParts = [];
  ['R', 'V'].forEach((suite, k) => {
    const x0 = 16 + 48 + k * (pw + gap);
    const x1 = x0 + pw;
    const y0 = top + h;
    const y1 = top;
    const xs = Object.fromEntries(LEVELS.map((l, i) => [l, x0 + 24 + i * ((pw - 48) / 2)]));
    const yOf = (v) => y0 - (v / 100) * (y0 - y1);
    body.push(`<text class="t" x="${x0}" y="${top - 14}" font-size="13" font-weight="600">${suite === 'R' ? 'R · share correct' : 'V · recall'}</text>`);
    body.push(`<g class="plot" data-suite="${suite}" data-y0="${y0}" data-y1="${y1}" ${LEVELS.map((l) => `data-x-${l.toLowerCase()}="${px(xs[l])}"`).join(' ')}>`);
    for (let v = 0; v <= 100; v += 25) {
      body.push(`<line class="${v === 0 ? 'base' : 'grid'}" x1="${x0}" y1="${px(yOf(v))}" x2="${x1}" y2="${px(yOf(v))}" stroke-width="1"/>`);
      body.push(`<text class="t2" x="${x0 - 8}" y="${px(yOf(v) + 4)}" font-size="11" text-anchor="end">${v} %</text>`);
    }
    for (const l of LEVELS) body.push(`<text class="t2" x="${px(xs[l])}" y="${y0 + 18}" font-size="11" text-anchor="middle">${l}</text>`);
    for (const f of families) {
      const points = LEVELS.map((l) => ({ l, a: arms.find((a) => a.suite === suite && a.model === `${f} (${l})`) })).filter((p) => p.a);
      const withMean = points.filter((p) => score(p.a) !== null);
      if (withMean.length > 1) {
        body.push(`<path class="line k${cls(f)}" d="${withMean.map((p, i) => `${i ? 'L' : 'M'} ${px(xs[p.l])} ${px(yOf(score(p.a)))}`).join(' ')}"/>`);
      }
      for (const p of points) {
        for (const r of p.a.runs) {
          if (failedRun(r)) {
            body.push(`<circle class="failed-run k${cls(f)}" fill="none" stroke-width="1.5" data-suite="${suite}" data-family="${esc(f)}" data-level="${p.l}" data-run="${r.run}" cx="${px(xs[p.l])}" cy="${px(y0)}" r="4"><title>${esc(`${f} · ${p.l}, ${suite} run ${r.run}: ${FAILED_TITLE}`)}</title></circle>`);
            continue;
          }
          const v = score(p.a, r);
          if (v === null) continue;
          body.push(`<circle class="c${cls(f)} run ring" data-suite="${suite}" data-family="${esc(f)}" data-level="${p.l}" data-run="${r.run}" data-value="${r1(v * 1e4) / 1e4}" cx="${px(xs[p.l])}" cy="${px(yOf(v))}" r="4"><title>${esc(`${f} · ${p.l}, ${suite} run ${r.run}: ${fmtPct(v)}`)}</title></circle>`);
        }
        const m = score(p.a);
        if (m === null) continue;
        body.push(`<circle class="mean c${cls(f)} ring" data-suite="${suite}" data-family="${esc(f)}" data-level="${p.l}" data-value="${r1(m * 1e4) / 1e4}" cx="${px(xs[p.l])}" cy="${px(yOf(m))}" r="6"><title>${esc(`${f} · ${p.l}, ${suite} mean: ${fmtPct(m)}`)}</title></circle>`);
        descParts.push(`${suite} ${f} · ${p.l}: ${fmtPct(m)} (runs ${p.a.runs.map((r) => (failedRun(r) ? FAILED_TITLE : fmtPct(score(p.a, r)))).join(', ')})${suite === 'R' && p.a.batch ? ', one prompt for all questions' : ''}`);
      }
      const last = withMean.at(-1);
      if (last) body.push(`<text class="t2" x="${px(xs[last.l] + 10)}" y="${px(yOf(score(last.a)) - 8)}" font-size="11">${esc(fmtPct(score(last.a)))}</text>`);
    }
    body.push('</g>');
  });
  const notes = batchFamilies.size ? [`${BATCH_NOTE} in R, one call per level`] : [];
  const footY = top + h + 46;
  notes.forEach((n, i) => body.push(`<text class="t2" x="16" y="${footY + i * 16}" font-size="12">${esc(n)}</text>`));
  return frame({ id, height: footY + notes.length * 16 + 8, title, desc: `${title}. ${caption(agg.date, arms).join('. ')}. ${descParts.join('. ')}.`, body });
}

/** A log axis over the values: whole decades, ticks at 1 and 3 of each. */
function logAxis(values) {
  const v = values.filter((x) => typeof x === 'number' && x > 0);
  if (!v.length) return { min: 1, max: 10, ticks: [1, 3, 10] };
  let min = 10 ** Math.floor(Math.log10(Math.min(...v)));
  let max = 10 ** Math.ceil(Math.log10(Math.max(...v)));
  if (max <= min) max = min * 10;
  const ticks = [];
  for (let d = min; d <= max * 1.0001; d *= 10) { ticks.push(d); if (d * 3 < max) ticks.push(d * 3); }
  return { min, max, ticks };
}

const fmtSeconds = (ms) => { const s = ms / 1000; return `${s < 1 ? r1(s) : Math.round(s)} s`; };
const fmtTokens = (n) => (n >= 1e6 ? `${r1(n / 1e6)}M` : n >= 1e3 ? `${r1(n / 1e3)}K` : String(Math.round(n)));

function cost(agg) {
  const id = 'cost';
  const title = 'Cost: score against time and tokens per call';
  const arms = sortArms(agg.arms.filter((a) => score(a) !== null));
  if (!arms.length) return emptyChart(id, title, agg.date);
  const names = [...new Set(arms.map((a) => a.arm))];
  const numberOf = (a) => names.indexOf(a.arm) + 1;
  const lines = [...caption(agg.date, arms), GEMINI_TOKENS_NOTE];
  const head = header({ title, subtitle: 'One point per arm and suite: R the share answered correctly, V recall. Numbers name the arms (key below)', lines });
  const body = [...head.out, ...legend(head.bottom + 22, [
    { shape: 'circle', cls: 'c1', label: 'R · share correct' },
    { cls: 'c2', label: 'V · recall' },
  ])];
  const top = head.bottom + 58;
  const h = 220;
  const gap = 56;
  const pw = (W - 32 - 48 - gap) / 2;
  const descParts = [];
  [
    { measure: 'wallMs', name: 'Mean wall time per call (log scale)', fmt: fmtSeconds },
    { measure: 'tokens', name: 'Mean tokens per call, where reported (log scale)', fmt: fmtTokens },
  ].forEach((panel, k) => {
    const x0 = 16 + 48 + k * (pw + gap);
    const x1 = x0 + pw;
    const y0 = top + h;
    const y1 = top;
    const shown = arms.filter((a) => typeof a.mean[panel.measure] === 'number' && a.mean[panel.measure] > 0);
    const ax = logAxis(shown.map((a) => a.mean[panel.measure]));
    const xOf = (v) => x0 + ((Math.log10(v) - Math.log10(ax.min)) / (Math.log10(ax.max) - Math.log10(ax.min))) * (x1 - x0);
    const yOf = (v) => y0 - (v / 100) * (y0 - y1);
    body.push(`<text class="t" x="${x0}" y="${top - 14}" font-size="13" font-weight="600">${esc(panel.name)}</text>`);
    body.push(`<g class="plot" data-measure="${panel.measure}" data-x0="${px(x0)}" data-x1="${px(x1)}" data-min="${ax.min}" data-max="${ax.max}" data-y0="${y0}" data-y1="${y1}">`);
    for (let v = 0; v <= 100; v += 25) {
      body.push(`<line class="${v === 0 ? 'base' : 'grid'}" x1="${px(x0)}" y1="${px(yOf(v))}" x2="${px(x1)}" y2="${px(yOf(v))}" stroke-width="1"/>`);
      body.push(`<text class="t2" x="${px(x0 - 8)}" y="${px(yOf(v) + 4)}" font-size="11" text-anchor="end">${v} %</text>`);
    }
    for (const t of ax.ticks) {
      body.push(`<line class="grid" x1="${px(xOf(t))}" y1="${y1}" x2="${px(xOf(t))}" y2="${y0}" stroke-width="1"/>`);
      body.push(`<text class="t2" x="${px(xOf(t))}" y="${y0 + 18}" font-size="11" text-anchor="middle">${esc(panel.fmt(t))}</text>`);
    }
    if (!shown.length) body.push(`<text class="t2" x="${px((x0 + x1) / 2)}" y="${px((y0 + y1) / 2)}" font-size="12" text-anchor="middle">No unit reported this</text>`);
    for (const a of shown) {
      const x = a.mean[panel.measure];
      const s = score(a);
      const cx = px(xOf(x));
      const cy = px(yOf(s));
      const data = `data-suite="${a.suite}" data-arm="${esc(a.arm)}" data-measure="${panel.measure}" data-x="${r1(x * 100) / 100}" data-value="${r1(s * 1e4) / 1e4}"`;
      const tip = `<title>${esc(`${numberOf(a)} ${armLabel(a)}, ${a.suite}: ${fmtPct(s)} at ${panel.fmt(x)}`)}</title>`;
      body.push(a.suite === 'R'
        ? `<circle class="point c1 ring" ${data} cx="${cx}" cy="${cy}" r="5">${tip}</circle>`
        : `<rect class="point c2 ring" ${data} x="${px(cx - 5)}" y="${px(cy - 5)}" width="10" height="10" rx="1">${tip}</rect>`);
      body.push(`<text class="t2" x="${px(cx + 8)}" y="${px(cy - 6)}" font-size="10">${numberOf(a)}</text>`);
      descParts.push(`${numberOf(a)} ${armLabel(a)} ${a.suite}: ${fmtPct(s)}, ${panel.fmt(x)}`);
    }
    body.push('</g>');
  });
  const keyTop = top + h + 46;
  const perCol = Math.ceil(names.length / 2);
  names.forEach((name, i) => {
    const a = arms.find((x) => x.arm === name);
    const batch = arms.some((x) => x.arm === name && x.suite === 'R' && x.batch);
    const col = Math.floor(i / perCol);
    body.push(`<text class="key t2" data-arm="${esc(name)}" x="${16 + col * (W / 2)}" y="${keyTop + (i % perCol) * 16}" font-size="12">${esc(`${i + 1}  ${armLabel(a)}${batch ? ' *' : ''}`)}</text>`);
  });
  const notes = arms.some((a) => a.suite === 'R' && a.batch) ? [`${BATCH_NOTE} (its R point)`] : [];
  const footY = keyTop + perCol * 16 + 12;
  notes.forEach((n, i) => body.push(`<text class="t2" x="16" y="${footY + i * 16}" font-size="12">${esc(n)}</text>`));
  return frame({ id, height: footY + notes.length * 16 + 8, title, desc: `${title}. ${lines.join('. ')} ${descParts.join('. ')}.`, body });
}

/** All four charts for one aggregate: `{file name: svg text}`. */
export function renderCharts(agg) {
  return {
    'r-accuracy.svg': rAccuracy(agg),
    'v-recall-precision.svg': vRecallPrecision(agg),
    'effort.svg': effort(agg),
    'cost.svg': cost(agg),
  };
}

export function main(argv = process.argv.slice(2), { out = (l) => console.log(l), err = (l) => console.error(l) } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { date: { type: 'string' }, dir: { type: 'string' }, out: { type: 'string' } }, strict: true, allowPositionals: false }));
  } catch (e) { err(`eval-chart: ${e.message}\n${USAGE}`); return 2; }
  if (!/^\d{4}-\d\d-\d\d$/.test(values.date || '')) { err(`eval-chart: --date YYYY-MM-DD is required\n${USAGE}`); return 2; }
  const path = join(resolve(values.dir || DEFAULT_DIR), 'aggregates', `${values.date}.json`);
  if (!existsSync(path)) { err(`eval-chart: no aggregate at ${path} — run eval-blind.mjs --aggregate first`); return 1; }
  let agg;
  try { agg = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { err(`eval-chart: ${path}: ${e.message}`); return 1; }
  const dest = resolve(values.out || DEFAULT_OUT);
  mkdirSync(dest, { recursive: true });
  for (const [name, svg] of Object.entries(renderCharts(agg))) {
    writeFileSync(join(dest, name), svg);
    out(`wrote ${join(dest, name)}`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = main();
}
