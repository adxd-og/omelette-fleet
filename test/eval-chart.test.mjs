// scripts/eval-chart.mjs — the four public charts (plan docs/superpowers/plans/2026-10-16-evals-mvp.md, Task 3).
// The SVG is parsed for its numbers: marks carry `data-*` attributes and the plot group its scale, and the
// geometry is checked against both. No whole-file snapshot. The aggregate below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from '../scripts/eval-blind.mjs';
import { renderCharts } from '../scripts/eval-chart.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'eval-chart.mjs');

const rArm = (arm, { effort = null, cli = 'agy 9.1.0', batch = false, runs, wallMs, tokens }) => {
  const mean = (k) => runs.reduce((a, r) => a + r[k], 0) / runs.length;
  return {
    suite: 'R', arm, unit: arm.split(':')[0], model: arm.split(':')[1], effort, cli: [cli], batch, tasks: 10, n: runs.length,
    runs: runs.map((r, i) => ({ run: i + 1, partly: 0, wrong: 0, noAnswer: 0, trap: null, failed: 0, wallMs, tokens, ...r })),
    mean: { correct: mean('correct'), inventedUrls: mean('inventedUrls'), partly: 0, wrong: 0, noAnswer: 0, trapPassed: null, failed: 0, wallMs, tokens },
    overturned: 0,
  };
};
const vArm = (arm, { effort = null, cli = 'agy 9.1.0', runs, wallMs, tokens }) => {
  const mean = (k) => runs.reduce((a, r) => a + r[k], 0) / runs.length;
  return {
    suite: 'V', arm, unit: arm.split(':')[0], model: arm.split(':')[1], effort, cli: [cli], batch: false, keyItems: 7, n: runs.length,
    runs: runs.map((r, i) => ({ run: i + 1, wallMs, tokens, ...r })),
    mean: { recall: mean('recall'), precision: mean('precision'), wallMs, tokens },
    overturned: 0,
  };
};

const AGG = {
  date: '2026-10-16',
  grades: 0,
  overturned: 0,
  arms: [
    rArm('gemini:Gemini 3.8 Flash (Low)', { effort: 'low', runs: [{ correct: 6, inventedUrls: 1 }, { correct: 7, inventedUrls: 0 }], wallMs: 10000, tokens: 2000 }),
    rArm('gemini:Gemini 3.8 Flash (High)', { effort: 'high', runs: [{ correct: 8, inventedUrls: 0 }, { correct: 8, inventedUrls: 2 }], wallMs: 30000, tokens: 9000 }),
    rArm('gemini:Gemini 4 Argon (High)', { effort: 'high', batch: true, runs: [{ correct: 9, inventedUrls: 2 }], wallMs: 90000, tokens: null }),
    rArm('codex:gpt-6.1-sol', { effort: 'xhigh', cli: 'codex-cli 9.2.0', runs: [{ correct: 7, inventedUrls: 0 }, { correct: 8, inventedUrls: 1 }], wallMs: 200000, tokens: 50000 }),
    vArm('codex:gpt-6.1-sol', { effort: 'xhigh', cli: 'codex-cli 9.2.0', runs: [{ recall: 4 / 7, precision: 0.8 }, { recall: 5 / 7, precision: 1 }], wallMs: 400000, tokens: 120000 }),
    vArm('gemini:Gemini 3.8 Flash (High)', { effort: 'high', runs: [{ recall: 2 / 7, precision: 0.5 }, { recall: 3 / 7, precision: 0.6 }], wallMs: 40000, tokens: 15000 }),
    vArm('gemini:Gemini 4 Argon (High)', { effort: 'high', runs: [{ recall: 6 / 7, precision: 0.75 }], wallMs: 80000, tokens: 30000 }),
  ],
};

/** Every element with a class, as {tag, attrs}. */
function elements(svg, cls) {
  const out = [];
  for (const m of svg.matchAll(/<(\w+)\s([^>]*?)\/?>/g)) {
    const attrs = Object.fromEntries([...m[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    if ((attrs.class || '').split(/\s+/).includes(cls)) out.push({ tag: m[1], attrs });
  }
  return out;
}
const num = (s) => Number(s);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.6, `${msg}: ${a} vs ${b}`);
/** The largest x an absolute path (M, L, H, Q, V) reaches: a horizontal bar's data end. */
function pathMaxX(d) {
  const xs = [];
  let cmd = null;
  let i = 0;
  for (const t of d.match(/[A-Za-z]|-?\d*\.?\d+/g)) {
    if (/[A-Za-z]/.test(t)) { cmd = t; i = 0; continue; }
    if (cmd === 'H' || ((cmd === 'M' || cmd === 'L' || cmd === 'Q') && i % 2 === 0)) xs.push(num(t));
    i += 1;
  }
  return Math.max(...xs);
}
/** Text content of every <text> element, entities decoded. */
const texts = (svg) => [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

const charts = renderCharts(AGG);

test('four charts, by the names the README embeds', () => {
  assert.deepEqual(Object.keys(charts).sort(), ['cost.svg', 'effort.svg', 'r-accuracy.svg', 'v-recall-precision.svg']);
});

test('r-accuracy: each arm\'s bar is its mean correct on the axis, each run a dot, invented URLs the second series', () => {
  const svg = charts['r-accuracy.svg'];
  const [plot] = elements(svg, 'plot');
  const x0 = num(plot.attrs['data-x0']);
  const x1 = num(plot.attrs['data-x1']);
  const max = num(plot.attrs['data-max']);
  const xOf = (v) => x0 + (v / max) * (x1 - x0);
  const bars = elements(svg, 'bar');
  const dots = elements(svg, 'dot');
  for (const arm of AGG.arms.filter((a) => a.suite === 'R')) {
    for (const [series, key] of [['correct', 'correct'], ['invented-urls', 'inventedUrls']]) {
      const bar = bars.find((b) => b.attrs['data-arm'] === arm.arm && b.attrs['data-series'] === series);
      assert.ok(bar, `${arm.arm} ${series} bar`);
      near(num(bar.attrs['data-value']), arm.mean[key], `${arm.arm} ${series} value`);
      if (arm.mean[key] > 0) near(pathMaxX(bar.attrs.d), xOf(arm.mean[key]), `${arm.arm} ${series} bar end`);
      const runDots = dots.filter((d) => d.attrs['data-arm'] === arm.arm && d.attrs['data-series'] === series);
      assert.deepEqual(runDots.map((d) => num(d.attrs['data-value'])), arm.runs.map((r) => r[key]));
      for (const d of runDots) near(num(d.attrs.cx), xOf(num(d.attrs['data-value'])), `${arm.arm} run dot`);
    }
  }
  const t = texts(svg);
  for (const label of ['6.5', '8', '9', '7.5']) assert.ok(t.includes(label), `value label ${label}`);
  assert.ok(t.some((s) => s.includes('Gemini 3.8 Flash · Low')));
  assert.ok(t.some((s) => s.includes('GPT-6.1 Sol · xhigh')));
  const caption = t.join('\n');
  assert.match(caption, /2026-10-16/);
  assert.match(caption, /agy 9\.1\.0/);
  assert.match(caption, /codex-cli 9\.2\.0/);
  assert.match(caption, /N = 1–2 runs per arm/);
  assert.match(caption, /runs shown, no intervals/);
  assert.match(caption, /one prompt for all questions/);
  assert.ok(t.some((s) => s.includes('Gemini 4 Argon · High *')), 'the batch arm is marked');
});

test('v-recall-precision: recall and precision per arm in percent, a dot per run', () => {
  const svg = charts['v-recall-precision.svg'];
  const [plot] = elements(svg, 'plot');
  const x0 = num(plot.attrs['data-x0']);
  const x1 = num(plot.attrs['data-x1']);
  assert.equal(num(plot.attrs['data-max']), 100);
  const bars = elements(svg, 'bar');
  for (const arm of AGG.arms.filter((a) => a.suite === 'V')) {
    for (const series of ['recall', 'precision']) {
      const bar = bars.find((b) => b.attrs['data-arm'] === arm.arm && b.attrs['data-series'] === series);
      near(num(bar.attrs['data-value']), arm.mean[series] * 100, `${arm.arm} ${series}`);
      near(pathMaxX(bar.attrs.d), x0 + arm.mean[series] * (x1 - x0), `${arm.arm} ${series} end`);
      const runDots = elements(svg, 'dot').filter((d) => d.attrs['data-arm'] === arm.arm && d.attrs['data-series'] === series);
      assert.equal(runDots.length, arm.n);
    }
  }
  const t = texts(svg);
  assert.ok(t.includes('64 %'), 'codex recall label, 9/14');
  assert.ok(t.includes('90 %'), 'codex precision label');
  assert.match(t.join('\n'), /runs shown, no intervals/);
});

test('effort: Flash and Argon, R and V, at Low, Medium and High', () => {
  const svg = charts['effort.svg'];
  const plots = elements(svg, 'plot');
  assert.deepEqual(plots.map((p) => p.attrs['data-suite']), ['R', 'V']);
  const points = elements(svg, 'mean');
  const expect = [
    ['R', 'Gemini 3.8 Flash', 'Low', 65], ['R', 'Gemini 3.8 Flash', 'High', 80], ['R', 'Gemini 4 Argon', 'High', 90],
    ['V', 'Gemini 3.8 Flash', 'High', (2.5 / 7) * 100], ['V', 'Gemini 4 Argon', 'High', (6 / 7) * 100],
  ];
  assert.equal(points.length, expect.length);
  for (const [suite, family, level, value] of expect) {
    const p = points.find((x) => x.attrs['data-suite'] === suite && x.attrs['data-family'] === family && x.attrs['data-level'] === level);
    assert.ok(p, `${suite} ${family} ${level}`);
    near(num(p.attrs['data-value']), value, `${suite} ${family} ${level}`);
    const plot = plots.find((x) => x.attrs['data-suite'] === suite);
    const y0 = num(plot.attrs['data-y0']);
    const y1 = num(plot.attrs['data-y1']);
    near(num(p.attrs.cy), y0 - (value / 100) * (y0 - y1), `${suite} ${family} ${level} height`);
    near(num(p.attrs.cx), num(plot.attrs[`data-x-${level.toLowerCase()}`]), `${suite} ${family} ${level} column`);
  }
  // Codex is not an effort arm here.
  assert.ok(!svg.includes('GPT-6.1 Sol'));
  assert.match(texts(svg).join('\n'), /one prompt for all questions/);
});

test('cost: one point per arm and suite against mean wall time; tokens only where reported', () => {
  const svg = charts['cost.svg'];
  const [wall, tok] = elements(svg, 'plot');
  assert.equal(wall.attrs['data-measure'], 'wallMs');
  assert.equal(tok.attrs['data-measure'], 'tokens');
  const pts = elements(svg, 'point');
  const inPanel = (m) => pts.filter((p) => p.attrs['data-measure'] === m);
  assert.equal(inPanel('wallMs').length, AGG.arms.length);
  assert.equal(inPanel('tokens').length, AGG.arms.filter((a) => a.mean.tokens !== null).length);
  for (const plot of [wall, tok]) {
    const [x0, x1, lo, hi] = ['data-x0', 'data-x1', 'data-min', 'data-max'].map((k) => num(plot.attrs[k]));
    const [y0, y1] = ['data-y0', 'data-y1'].map((k) => num(plot.attrs[k]));
    for (const p of inPanel(plot.attrs['data-measure'])) {
      const arm = AGG.arms.find((a) => a.suite === p.attrs['data-suite'] && a.arm === p.attrs['data-arm']);
      const x = arm.mean[plot.attrs['data-measure']];
      const score = arm.suite === 'R' ? arm.mean.correct / arm.tasks : arm.mean.recall;
      near(num(p.attrs['data-x']), x, 'x value');
      near(num(p.attrs['data-value']), score * 100, 'score');
      const cx = p.tag === 'circle' ? num(p.attrs.cx) : num(p.attrs.x) + num(p.attrs.width) / 2;
      const cy = p.tag === 'circle' ? num(p.attrs.cy) : num(p.attrs.y) + num(p.attrs.height) / 2;
      near(cx, x0 + ((Math.log10(x) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (x1 - x0), 'log x position');
      near(cy, y0 - score * (y0 - y1), 'y position');
    }
  }
  // Each arm keeps one number across suites and panels, keyed below the plot.
  const key = elements(svg, 'key');
  assert.equal(key.length, new Set(AGG.arms.map((a) => a.arm)).size);
  for (const p of pts) assert.ok(key.some((k) => k.attrs['data-arm'] === p.attrs['data-arm']), `${p.attrs['data-arm']} is keyed`);
});

test('every chart is labelled and themed for GitHub light and dark, with no painted background', () => {
  for (const [name, svg] of Object.entries(charts)) {
    assert.match(svg, /^<svg [^>]*role="img"[^>]*aria-labelledby="[^"]+"/, name);
    assert.match(svg, /<title id="[^"]+">[^<]+<\/title>/, name);
    assert.match(svg, /<desc id="[^"]+">[^<]+<\/desc>/, name);
    assert.match(svg, /<style>[\s\S]*@media \(prefers-color-scheme: dark\)[\s\S]*<\/style>/, name);
    assert.ok(!/fill="(#fff|#ffffff|white)"/i.test(svg), `${name}: no white fill`);
    assert.ok(!/<rect[^>]*width="100%"/.test(svg), `${name}: no full-size rect`);
    // The desc is the table view: every arm is in it.
    const desc = /<desc id="[^"]+">([^<]+)<\/desc>/.exec(svg)[1];
    assert.ok(desc.length > 40, name);
  }
});

test('with three runs or more the caption no longer says "no intervals"', () => {
  const three = { ...AGG, arms: AGG.arms.filter((a) => a.suite === 'R' && !a.batch).map((a) => ({ ...a, n: 3, runs: [...a.runs, { ...a.runs[0], run: 3 }] })) };
  const svg = renderCharts(three)['r-accuracy.svg'];
  assert.doesNotMatch(svg, /no intervals/);
  assert.match(svg, /N = 3 runs per arm/);
});

test('the CLI draws an aggregate from the private dir into the chart directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-evals-chart-'));
  mkdirSync(join(dir, 'aggregates'));
  writeFileSync(join(dir, 'aggregates', '2026-10-16.json'), JSON.stringify(AGG));
  const out = join(dir, 'charts');
  const r = spawnSync(process.execPath, [SCRIPT, '--date', '2026-10-16', '--dir', dir, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out).sort(), ['cost.svg', 'effort.svg', 'r-accuracy.svg', 'v-recall-precision.svg']);
  assert.equal(readFileSync(join(out, 'r-accuracy.svg'), 'utf8'), charts['r-accuracy.svg']);
  const missing = spawnSync(process.execPath, [SCRIPT, '--date', '2026-10-17', '--dir', dir, '--out', out], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
});

test('a failed run is a hollow marker at the baseline titled "failed run", never a filled dot at 0, and the caption counts it', () => {
  const arm = vArm('codex:gpt-6.1-sol', { effort: 'xhigh', cli: 'codex 9.2.0', runs: [{ recall: 0.5, precision: 1, failed: 0 }, { recall: 0.25, precision: 1, failed: 0 }], wallMs: 1000, tokens: 10 });
  arm.runs.push({ run: 3, found: null, recall: null, findings: null, precision: null, ungraded: 0, failed: 1, wallMs: null, tokens: null });
  arm.n = 3;
  arm.failedRuns = 1;
  const svg = renderCharts({ ...AGG, arms: [arm] })['v-recall-precision.svg'];
  const [plot] = elements(svg, 'plot');
  const inRecall = (cls) => elements(svg, cls).filter((e) => e.attrs['data-series'] === 'recall');
  const hollow = inRecall('failed-run');
  assert.equal(hollow.length, 1);
  assert.equal(inRecall('dot').length, 2);
  assert.equal(hollow[0].attrs.fill, 'none');
  near(num(hollow[0].attrs.cx), num(plot.attrs['data-x0']), 'at the baseline');
  assert.match(svg, /<circle class="failed-run[^>]*><title>[^<]*failed run<\/title>/);
  assert.ok(texts(svg).some((s) => s.includes('failed runs: 1')));
  assert.ok(!texts(renderCharts(AGG)['v-recall-precision.svg']).some((s) => s.includes('failed runs')), 'no failed-runs line at 0');
});

test('the cost chart\'s caption says Gemini\'s tokens exclude thinking', () => {
  assert.ok(texts(charts['cost.svg']).some((s) => /Gemini.*exclude thinking/.test(s)));
});

test('effort: an XHigh arm is a fourth column, right of High, labelled as the catalog labels it', () => {
  const agg = {
    date: '2026-11-20', grades: 0, overturned: 0,
    arms: [
      rArm('gemini:Gemini 4 Neon (High)', { effort: 'high', runs: [{ correct: 8, inventedUrls: 0 }], wallMs: 1000, tokens: 10 }),
      rArm('gemini:Gemini 4 Neon (XHigh)', { effort: 'xhigh', runs: [{ correct: 9, inventedUrls: 0 }], wallMs: 2000, tokens: 20 }),
    ],
  };
  const out = renderCharts(agg);
  const [plot] = elements(out['effort.svg'], 'plot');
  const cols = ['low', 'medium', 'high', 'xhigh'].map((l) => num(plot.attrs[`data-x-${l}`]));
  for (let i = 1; i < cols.length; i++) assert.ok(cols[i] > cols[i - 1], `column ${i} right of column ${i - 1}`);
  const p = elements(out['effort.svg'], 'mean').find((x) => x.attrs['data-level'] === 'XHigh');
  assert.ok(p, 'an XHigh mean point');
  near(num(p.attrs.cx), cols[3], 'in the XHigh column');
  near(num(p.attrs['data-value']), 90, 'its share correct');
  assert.ok(texts(out['r-accuracy.svg']).some((s) => s.includes('Gemini 4 Neon · XHigh')));
});

test('a P or an I arm in the aggregate is drawn on no chart', () => {
  const pi = (suite) => ({ suite, arm: 'gemini:Gemini 4 Neon (High)', unit: 'gemini', model: 'Gemini 4 Neon (High)', effort: 'high', cli: ['agy 9.1.0'], n: 1, runs: [{ run: 1, calls: 3, failed: 0, wallMs: 1000, tokens: 10 }], total: { calls: 3 }, mean: { failed: 0, wallMs: 1000, tokens: 10 } });
  const agg = { ...AGG, arms: [AGG.arms[0], pi('P'), pi('I')] };
  for (const [name, svg] of Object.entries(renderCharts(agg))) assert.ok(!svg.includes('Neon'), `${name} draws no P or I arm`);
});

test('the native reviewer is labelled by its role and its model', () => {
  const arm = vArm('native:omelette-reviewer', { effort: 'xhigh', cli: 'claude-code 9.0.0', runs: [{ recall: 0.5, precision: 0.8 }], wallMs: 300000, tokens: 50000 });
  arm.model = 'claude-opus-5-5';
  const t = texts(renderCharts({ ...AGG, arms: [arm] })['v-recall-precision.svg']);
  assert.ok(t.some((s) => s.includes('omelette-reviewer (claude-opus-5-5) · xhigh')), t.join('\n'));
});

test('carried arms are named in the caption with the date they came from', () => {
  const carried = { ...AGG.arms[4], carriedFrom: '2026-10-16' };
  const t = texts(renderCharts({ ...AGG, arms: [carried, AGG.arms[5]] })['v-recall-precision.svg']).join('\n');
  assert.match(t, /carried from 2026-10-16, with that round's tasks and CLIs: GPT-6\.1 Sol · xhigh/);
  assert.doesNotMatch(texts(charts['v-recall-precision.svg']).join('\n'), /carried from/);
});

// ─── bars from the arm's total; a dot for a run that held every task ─────────

const G = 'gemini:Gemini 4 Neon (High)';
const at = (suite, run, t, blindId) => [blindId, { suite, arm: G, run, taskIds: [t], unit: 'gemini', model: 'Gemini 4 Neon (High)', effort: 'high', cli: 'agy 9.1.0', wallMs: 1000, usage: null }];
const answer = (blindId, taskId, grade) => ({ blindId, taskId, item: 'answer', grade });
const keyLine = (blindId, taskId, keyId, grade) => ({ blindId, taskId, item: 'key', keyId, grade });
const barOf = (svg, arm, series) => num(elements(svg, 'bar').find((b) => b.attrs['data-arm'] === arm && b.attrs['data-series'] === series).attrs['data-value']);
const KEYS_RV = { R: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }], V: [{ id: 'K1', task: 'V01' }, { id: 'K2', task: 'V01' }, { id: 'K3', task: 'V02' }] };

test('a complete arm\'s bar, read from its total, is where its mean drew it', () => {
  const blinds = Object.fromEntries([
    at('R', 1, 'q1', 'r1'), at('R', 1, 'q2', 'r2'), at('R', 1, 'q3', 'r3'), at('R', 2, 'q1', 'r4'), at('R', 2, 'q2', 'r5'), at('R', 2, 'q3', 'r6'),
    at('V', 1, 'V01', 'v1'), at('V', 1, 'V02', 'v2'), at('V', 2, 'V01', 'v3'), at('V', 2, 'V02', 'v4'),
  ]);
  const grades = [
    answer('r1', 'q1', 'correct'), answer('r2', 'q2', 'correct'), answer('r3', 'q3', 'wrong'),
    answer('r4', 'q1', 'correct'), answer('r5', 'q2', 'no-answer'), answer('r6', 'q3', 'wrong'),
    { blindId: 'r1', taskId: 'q1', item: 'url', url: 'https://example.invalid/x', grade: 'unreachable-or-invented' },
    keyLine('v1', 'V01', 'K1', 'found'), keyLine('v1', 'V01', 'K2', 'not'), keyLine('v2', 'V02', 'K3', 'not'),
    { blindId: 'v1', taskId: 'V01', item: 'finding', finding: 'x', grade: 'fabricated' },
    keyLine('v3', 'V01', 'K1', 'found'), keyLine('v3', 'V01', 'K2', 'found'), keyLine('v4', 'V02', 'K3', 'not'),
  ];
  const agg = aggregate({ grades, mapping: { date: '2026-11-20', seed: 1, failed: [], blinds }, keys: KEYS_RV });
  const [r, v] = agg.arms;
  assert.equal(r.incomplete, null);
  const out = renderCharts(agg);
  near(barOf(out['r-accuracy.svg'], G, 'correct'), r.mean.correct, 'R correct');
  near(barOf(out['r-accuracy.svg'], G, 'invented-urls'), r.mean.inventedUrls, 'R invented URLs');
  near(barOf(out['v-recall-precision.svg'], G, 'recall'), v.mean.recall * 100, 'V recall');
  near(barOf(out['v-recall-precision.svg'], G, 'precision'), v.mean.precision * 100, 'V precision');
});

test('an incomplete arm: its bar is its total over the questions asked, a dot only for a run that held every task, and the caption counts it', () => {
  const blinds = Object.fromEntries([
    at('R', 1, 'q1', 'r1'), at('R', 1, 'q2', 'r2'), at('R', 1, 'q3', 'r3'), at('R', 2, 'q1', 'r4'),
    at('V', 1, 'V01', 'v1'), at('V', 1, 'V02', 'v2'), at('V', 2, 'V01', 'v3'),
  ]);
  const grades = [
    answer('r1', 'q1', 'correct'), answer('r2', 'q2', 'correct'), answer('r3', 'q3', 'wrong'), answer('r4', 'q1', 'correct'),
    keyLine('v1', 'V01', 'K1', 'found'), keyLine('v1', 'V01', 'K2', 'not'), keyLine('v2', 'V02', 'K3', 'not'),
    keyLine('v3', 'V01', 'K1', 'found'), keyLine('v3', 'V01', 'K2', 'found'),
  ];
  const agg = aggregate({ grades, mapping: { date: '2026-11-20', seed: 1, failed: [], blinds }, keys: KEYS_RV });
  const out = renderCharts(agg);
  // R: 3 correct over 4 questions asked, on 3 tasks — not the mean of a 2 and a 1.
  near(barOf(out['r-accuracy.svg'], G, 'correct'), 2.25, 'R correct');
  near(barOf(out['v-recall-precision.svg'], G, 'recall'), (3 / 5) * 100, 'V recall');
  for (const [chart, series, value] of [['r-accuracy.svg', 'correct', 2], ['v-recall-precision.svg', 'recall', (1 / 3) * 100]]) {
    const dots = elements(out[chart], 'dot').filter((d) => d.attrs['data-series'] === series);
    assert.deepEqual(dots.map((d) => [d.attrs['data-run'], Math.round(num(d.attrs['data-value']))]), [['1', Math.round(value)]], chart);
  }
  const t = texts(out['r-accuracy.svg']);
  assert.ok(t.includes('R Gemini 4 Neon · High: incomplete, tasks per run 3, 1 of 3'), t.join('\n'));
  assert.doesNotMatch(t.join('\n'), /each dot a run/);
});

test('a V run of recall-only tasks has no keyed recall and is no failed run', () => {
  const arm = vArm('codex:gpt-6.1-sol', { effort: 'xhigh', cli: 'codex 9.2.0', runs: [{ recall: 0.5, precision: 1, failed: 0 }], wallMs: 1000, tokens: 10 });
  arm.runs.push({ run: 2, found: null, recall: null, findings: null, precision: null, recallOnly: { tasks: 1, bugs: 1, found: 1, findings: 1, plausible: 0, fabricated: 0 }, control: null, ungraded: 0, failed: 1, wallMs: 1000, tokens: 10 });
  arm.n = 2;
  const svg = renderCharts({ ...AGG, arms: [arm] })['v-recall-precision.svg'];
  assert.equal(elements(svg, 'failed-run').length, 0);
});

test('the effort chart draws Gemini models only, not Claude through agy', () => {
  const claude = rArm('gemini:Claude Opus 5.5 (High)', { effort: 'high', runs: [{ correct: 9, inventedUrls: 0 }], wallMs: 1000, tokens: 10 });
  const svg = renderCharts({ ...AGG, arms: [AGG.arms[0], claude] })['effort.svg'];
  assert.ok(!svg.includes('Claude'), 'no Claude family on the effort chart');
});
