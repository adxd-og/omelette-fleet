// Tester's tests for the evals-neon fix round (FX1-FX6: places and links, V's total, XHigh, the snapshot prefix, the chart,
// the inline path). Only what the implementer's tests and test/tester-evals-neon-b.test.mjs leave unpinned.
// Every task, key, answer and file below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { aggregate, blind, redact, redactionTerms } from '../scripts/eval-blind.mjs';
import { renderCharts } from '../scripts/eval-chart.mjs';
import { materializeTree, parseArm, readTasks, runArm } from '../scripts/eval-run.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const jsonl = (xs) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';
const quiet = () => {};
const BRIEF = 'Invented review brief: read the change and report what you find.';

function evalsDir(tasks) {
  const dir = tmp('omelette-evals-tc-');
  mkdirSync(join(dir, 'suites', 'V'), { recursive: true });
  writeFileSync(join(dir, 'suites', 'V', 'tasks.jsonl'), jsonl(tasks));
  return dir;
}
function writeTree(dir, rel, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel, name)), { recursive: true });
    writeFileSync(join(dir, rel, name), text);
  }
}
async function withTmpdir(fn) {
  const fresh = tmp('omelette-evals-tc-tmpdir-');
  const was = process.env.TMPDIR;
  process.env.TMPDIR = fresh;
  try { return await fn(fresh); } finally {
    if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
  }
}
function fakeAgy(dir) {
  const p = join(dir, 'fake-agy');
  writeFileSync(p, [`#!${process.execPath}`, 'console.log("agy 9.9.9");'].join('\n'));
  chmodSync(p, 0o755);
  return p;
}
function echoServer(dir, tool) {
  const p = join(dir, 'echo-server.mjs');
  writeFileSync(p, [
    'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
    'let buf = ""; process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { buf += c; let nl; while ((nl = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; const m = JSON.parse(l);',
    '  if (m.id === 1) send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "f", version: "0" } } });',
    `  else if (m.id === 2) send({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: ${JSON.stringify(tool)}, description: "d", inputSchema: { type: "object" } }] } });`,
    '  else if (m.id === 3) send({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: JSON.stringify(m.params.arguments) }] } }); } });',
  ].join('\n'));
  return p;
}
const baseEnv = (home, extra = {}) => ({ PATH: process.env.PATH, HOME: home, OMELETTE_HOME: home, OMELETTE_UPDATE_CHECK: '0', ...extra });

// ─── FX1 / FX6: places and links ─────────────────────────────────────────────

test('FX1: the place and the tree may be spelt with a trailing slash, a leading ./ or a doubled slash, and still name the same strict place', async () => {
  await withTmpdir(async () => {
    const dir = tmp('omelette-evals-tc-place-');
    writeTree(dir, 'third-party/t', { 'lib/widget.js': 'export const items = [];\n' });
    for (const [rel, under] of [['./third-party/t', 'third-party'], ['third-party//t', 'third-party'], ['third-party/t/', 'third-party'], ['third-party/t', 'third-party/'], ['third-party/t', './third-party']]) {
      assert.ok(existsSync(materializeTree({ dir, rel, id: 'T1', under })), `${rel} under ${under}`);
    }
    // Strictly under, whatever the spelling of the place: the place itself and a way back out are no tree.
    for (const [rel, under] of [['third-party/', 'third-party/'], ['third-party/t/..', './third-party'], ['third-party/./', 'third-party'], ['third-party/t/../..', 'third-party/']]) {
      assert.throws(() => materializeTree({ dir, rel, id: 'T1', under }), /relative path inside/, `${rel} under ${under}`);
    }
  });
});

test('FX1: a task\'s tree may be spelt ./third-party/t; a control may say show: file where its task says nothing, and the other way round', () => {
  const x = { id: 'X01', kind: 'recall', tree: './third-party/t', file: 'lib/widget.js', prompt: BRIEF };
  const control = (over) => ({ id: 'C01', kind: 'control', of: 'X01', tree: 'third-party/c', file: 'lib/widget.js', prompt: BRIEF, ...over });
  assert.deepEqual(readTasks(evalsDir([x, control({ show: 'file' })]), 'V').map((t) => t.id), ['X01', 'C01']);
  assert.deepEqual(readTasks(evalsDir([{ ...x, show: 'file' }, control({})]), 'V').map((t) => t.id), ['X01', 'C01']);
  assert.throws(() => readTasks(evalsDir([{ ...x, tree: 'third-party/' }, control({})]), 'V'), /task X01: /);
});

test('FX1: a link loop in a tree, or a tree whose own name is a link to a sibling inside third-party/, is refused and leaves no copy', async () => {
  await withTmpdir(async (fresh) => {
    const dir = tmp('omelette-evals-tc-loop-');
    writeTree(dir, 'third-party/t', { 'lib/widget.js': 'export const items = [];\n' });
    writeTree(dir, 'third-party/sib', { 'lib/widget.js': 'export const items = [1];\n' });
    symlinkSync('../sib', join(dir, 'third-party', 'alias'));
    assert.throws(() => materializeTree({ dir, rel: 'third-party/alias', id: 'T2', under: 'third-party' }), /not a directory/);
    symlinkSync('loop', join(dir, 'third-party', 't', 'loop'));
    assert.throws(() => materializeTree({ dir, rel: 'third-party/t', id: 'T3', under: 'third-party' }), /points out of it: loop/);
    for (const id of ['T2', 'T3']) assert.equal(existsSync(join(fresh, 'omelette-evals', 'snapshots', id)), false, id);
  });
});

test('FX6: a Gemini arm refuses a tree whose own name is a link out (third-party/x -> ../suites), and a file reached through a dangling link, before any call', async () => {
  const home = tmp('omelette-evals-tc-home-');
  const gemini = (dir) => runArm({
    suite: 'V', arm: parseArm('gemini:Gemini 4 Neon (High)'), dir, out: quiet,
    serverPath: echoServer(home, 'gemini_research'), env: baseEnv(home, { AGY_BIN: fakeAgy(home) }),
  });
  const fixture = (task) => {
    const dir = evalsDir([task]);
    writeTree(dir, 'suites/V', { 'key.jsonl': 'INVENTED-KEY-TEXT\n' });
    writeTree(dir, 'third-party/real', { 'lib/widget.js': 'export const items = [];\n' });
    symlinkSync('../suites', join(dir, 'third-party', 'x'));
    symlinkSync('../real', join(dir, 'third-party', 'twin'));
    symlinkSync('lib/gone.js', join(dir, 'third-party', 'real', 'dangling.js'));
    return dir;
  };
  const x = (tree, file) => ({ id: 'X01', kind: 'recall', tree, file, prompt: BRIEF });
  const cases = [
    ['a tree that is a link to the private dir\'s suites', x('third-party/x', 'V/key.jsonl'), /not a directory/],
    ['a tree that is a link to a sibling', x('third-party/twin', 'lib/widget.js'), /not a directory/],
    ['a file behind a dangling link', x('third-party/real', 'dangling.js'), /no file dangling\.js/],
  ];
  for (const [what, task, re] of cases) {
    const dir = fixture(task);
    await withTmpdir(() => assert.rejects(gemini(dir), re, what));
    assert.equal(existsSync(join(dir, 'runs')), false, `${what}: no call was made`);
  }
});

test('FX1: a place that is itself a link into the private dir (third-party -> suites) hands out no tree', async () => {
  // Spec, Contamination: the key stays "outside any directory a run is given". The tree below is `suites/V`, key and all.
  await withTmpdir(async (fresh) => {
    const dir = tmp('omelette-evals-tc-linkplace-');
    writeTree(dir, 'suites/V', { 'key.jsonl': 'INVENTED-KEY-TEXT\n' });
    symlinkSync('suites', join(dir, 'third-party'));
    let copy = null;
    try { copy = materializeTree({ dir, rel: 'third-party/V', id: 'T4', under: 'third-party' }); } catch { /* refused: the right answer */ }
    assert.equal(copy, null, `the key's directory was copied to ${copy}`);
    assert.equal(existsSync(join(fresh, 'omelette-evals', 'snapshots', 'T4', 'key.jsonl')), false);
  });
});

// ─── FX2: V's total, byTask and incomplete ───────────────────────────────────

const V = 'gemini:Gemini 4 Neon (High)';
const call = (suite, run, ids, extra = {}) => ({
  suite, arm: V, run, taskIds: ids, unit: 'gemini', model: 'Gemini 4 Neon (High)', effort: 'high', cli: 'agy 9.9.9', wallMs: 1000, usage: null, ...extra,
});
const failedCall = (suite, run, ids, empty = false) => ({ ...call(suite, run, ids), error: 'invented failure', empty });
const key = (blindId, taskId, keyId, grade) => ({ blindId, taskId, item: 'key', keyId, grade });
const TASKS_V = [{ id: 'V01' }, { id: 'V02' }, { id: 'X01', kind: 'recall' }, { id: 'C01', kind: 'control', of: 'X01' }];
const KEY_V = [{ id: 'K1', task: 'V01' }, { id: 'K2', task: 'V01' }, { id: 'K3', task: 'V02' }, { id: 'XK1', task: 'X01' }];

test('FX2: a V task whose every call failed keeps its key items in the arm\'s total, and an arm that ran only some of the file\'s tasks says which count is missing', () => {
  const mapping = {
    date: 'd', seed: 1, blinds: { b1: call('V', 1, ['V01']), b2: call('V', 2, ['V01']) },
    failed: [failedCall('V', 1, ['V02']), failedCall('V', 2, ['V02'])],
  };
  const grades = [key('b1', 'V01', 'K1', 'found'), key('b1', 'V01', 'K2', 'not'), key('b2', 'V01', 'K1', 'found'), key('b2', 'V01', 'K2', 'found')];
  const [arm] = aggregate({ grades, mapping, keys: { R: [], V: KEY_V }, tasks: { V: TASKS_V } }).arms;
  // Four V01 key items asked over the two runs and two V02 ones: three found of six, not of four.
  assert.deepEqual([arm.total.calls, arm.total.keyItems, arm.total.found, arm.total.recall, arm.total.failed], [4, 6, 3, 0.5, 2]);
  assert.deepEqual(arm.runs.map((r) => [r.run, r.calls, r.keyItems, r.recall]), [[1, 2, 3, 1 / 3], [2, 2, 3, 2 / 3]]);
  assert.deepEqual([arm.byTask.V02.failed, arm.byTask.V02.keyItems, arm.byTask.V02.foundInRuns, arm.byTask.V01.foundInRuns], [2, 2, 0, 2]);
  // Both runs hold both tasks the arm ran; the file also has a recall task and its control, which no run holds.
  assert.deepEqual(arm.incomplete, { runs: [{ run: 1, tasks: 2 }, { run: 2, tasks: 2 }], of: 2, missing: ['X01', 'C01'] });
});

test('FX2: a batch R call counts every task it covers in `incomplete`, one call or several, and an arm of one run is complete when that run holds the file\'s tasks', () => {
  const keys = { R: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }], V: [] };
  const RT = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }];
  const batch = (run, ids) => call('R', run, ids);
  const a = (blinds, tasks = RT) => aggregate({ grades: [], mapping: { date: 'd', seed: 1, failed: [], blinds }, keys, tasks: { R: tasks } }).arms[0];
  assert.equal(a({ b1: batch(1, ['q1', 'q2', 'q3']), b2: batch(2, ['q1', 'q2', 'q3']) }).incomplete, null);
  assert.equal(a({ b1: batch(1, ['q1', 'q2', 'q3']) }).incomplete, null, 'a single run of a single call');
  assert.deepEqual(a({ b1: batch(1, ['q1', 'q2', 'q3']), b2: batch(2, ['q1', 'q2']) }).incomplete, { runs: [{ run: 1, tasks: 3 }, { run: 2, tasks: 2 }], of: 3, missing: [] });
  // The same three tasks answered one call each, in a run that failed one of them, still hold all three.
  const one = aggregate({
    grades: [], keys, tasks: { R: RT },
    mapping: { date: 'd', seed: 1, blinds: { b1: batch(1, ['q1']), b2: batch(1, ['q2']) }, failed: [failedCall('R', 1, ['q3'])] },
  }).arms[0];
  assert.equal(one.incomplete, null);
});

// ─── FX3: XHigh ──────────────────────────────────────────────────────────────

test('FX3: XHigh goes with the name whatever follows it, after a space, a slash or a comma and in any case; a longer word keeps it', () => {
  const terms = redactionTerms();
  const gone = [
    ['Neon XHigh-thinking found it', '[model]-thinking found it'],
    ['Neon/xhigh-thinking', '[model]-thinking'],
    ['Neon, XHIGH-thinking.', '[model]-thinking.'],
    ['Neon xhigh—thinking', '[model]—thinking'],
    ['Neon\nXHigh\nThe retry never ends.', '[model]\nThe retry never ends.'],
  ];
  for (const [text, want] of gone) assert.equal(redact(text, terms), want, JSON.stringify(text));
  for (const kept of ['Neon XHighlights it', 'Neon/xhighway', 'Neon, XHigh2 is a label', 'Neon\nXHigh found it', 'Neon Low-thinking', 'Neon Medium-thinking']) {
    assert.equal(redact(kept, terms), kept.replace('Neon', '[model]'), kept);
  }
  // Inside an address the name goes and the level word that is part of the path with it, but a longer word is left alone.
  assert.equal(redact('see https://example.invalid/neon/xhigh/page and https://example.invalid/xhighs', terms), 'see https://example.invalid/[model]/page and https://example.invalid/xhighs');
});

// ─── FX4: the snapshot prefix ────────────────────────────────────────────────

test('FX4: a snapshot\'s path is cut inside a link, a fence, a file:// address and a sentence with two roots; a mention that names no snapshot is left alone', () => {
  const snap = '/var/folders/zz/T/omelette-evals/snapshots/X01';
  const lines = [
    ['V', ['X01'], `[a.js](${snap}/lib/a.js) and [${snap}/lib/b.js](${snap}/lib/b.js)`, '[a.js](lib/a.js) and [lib/b.js](lib/b.js)'],
    ['V', ['X02'], `\`\`\`\n${snap}/lib/a.js:12:3\n\`\`\``, '```\nlib/a.js:12:3\n```'],
    ['V', ['X03'], `Compared ${snap} with ${snap.replace('X01', 'X02')}, then file://${snap}/lib/c.js.`, 'Compared <snapshot> with <snapshot>, then lib/c.js.'],
    ['R', ['q1'], `At ${snap}:12 and /private${snap}/lib/a.js; docs/omelette-evals/snapshots is a folder name, and so is omelette-evals/snapshots/.`, 'At <snapshot>:12 and lib/a.js; docs/omelette-evals/snapshots is a folder name, and so is omelette-evals/snapshots/.'],
    ['R', ['q2'], 'On Windows: C:\\Users\\invented\\Temp\\omelette-evals\\snapshots\\X01\\lib\\a.js', 'On Windows: lib\\a.js'],
  ];
  const run = (suite, taskIds, answer) => ({ suite, arm: V, run: 1, taskIds, unit: 'gemini', model: 'm', effort: 'high', cli: 'c', wallMs: 1, ok: true, answer });
  const out = blind({ lines: lines.map(([s, t, a]) => run(s, t, a)), seed: 3, terms: redactionTerms() }).blinded;
  for (const [, taskIds, , want] of lines) assert.equal(out.find((b) => b.taskIds[0] === taskIds[0]).answer, want, taskIds[0]);
});

// ─── FX5: the chart ──────────────────────────────────────────────────────────

const attrsOf = (svg, cls) => [...svg.matchAll(/<(\w+)\s([^>]*?)\/?>/g)]
  .map((m) => Object.fromEntries([...m[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])))
  .filter((a) => (a.class || '').split(/\s+/).includes(cls));
const valueOf = (svg, arm, series) => Number(attrsOf(svg, 'bar').find((b) => b['data-arm'] === arm && b['data-series'] === series)['data-value']);
const KEYS_R = { R: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }], V: [] };
const ans = (blindId, taskId, grade) => ({ blindId, taskId, item: 'answer', grade });

test('FX5: a batch arm is scaled by the tasks it was asked, not by its calls, and only the run that held every task is a dot', () => {
  const hy = 'gemini:Gemini 4 Hydrogen (High)';
  const blinds = {
    b2: { ...call('R', 1, ['q1', 'q2', 'q3']), arm: hy, model: 'Gemini 4 Hydrogen (High)' },
    b3: { ...call('R', 2, ['q1', 'q2']), arm: hy, model: 'Gemini 4 Hydrogen (High)' },
  };
  const grades = [ans('b2', 'q1', 'correct'), ans('b2', 'q2', 'correct'), ans('b2', 'q3', 'wrong'), ans('b3', 'q1', 'correct'), ans('b3', 'q2', 'wrong')];
  const agg = aggregate({ grades, mapping: { date: '2026-11-20', seed: 1, failed: [], blinds }, keys: KEYS_R, tasks: { R: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }] } });
  const svg = renderCharts(agg)['r-accuracy.svg'];
  // Three correct answers of the five questions asked, over the arm's three tasks (two calls would make it 3 / 2 * 3).
  assert.equal(Math.round(valueOf(svg, hy, 'correct') * 1e4) / 1e4, 1.8);
  const dots = attrsOf(svg, 'dot').filter((d) => d['data-series'] === 'correct');
  assert.deepEqual(dots.map((d) => [d['data-arm'], d['data-run']]), [[hy, '1']], 'only the run that asked all three is a dot');
});

test('FX5: a wholly failed run of a complete arm is a hollow marker, and the bar counts it as asked and found nothing', () => {
  const blinds = { b1: call('R', 1, ['q1']), b2: call('R', 1, ['q2']), b3: call('R', 1, ['q3']) };
  const failed = [failedCall('R', 2, ['q1']), failedCall('R', 2, ['q2']), failedCall('R', 2, ['q3'])];
  const grades = [ans('b1', 'q1', 'correct'), ans('b2', 'q2', 'correct'), ans('b3', 'q3', 'wrong')];
  const agg = aggregate({ grades, mapping: { date: '2026-11-20', seed: 1, failed, blinds }, keys: KEYS_R, tasks: { R: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }] } });
  const [arm] = agg.arms;
  assert.equal(arm.incomplete, null);
  const svg = renderCharts(agg)['r-accuracy.svg'];
  assert.equal(attrsOf(svg, 'failed-run').filter((d) => d['data-series'] === 'correct').length, 1);
  assert.deepEqual(attrsOf(svg, 'dot').filter((d) => d['data-series'] === 'correct').map((d) => d['data-run']), ['1']);
  assert.equal(valueOf(svg, V, 'correct'), 1, 'two correct over two runs');
});

test('FX5: an aggregate from before the totals draws beside a new one: the old arm from its means, with all its runs as dots', () => {
  const old = {
    suite: 'R', arm: 'codex:gpt-6.1-sol', unit: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', cli: ['codex 9'], batch: false, tasks: 3, n: 2,
    runs: [{ run: 1, correct: 3, inventedUrls: 0, failed: 0, wallMs: 1, tokens: 1 }, { run: 2, correct: 1, inventedUrls: 2, failed: 0, wallMs: 1, tokens: 1 }],
    mean: { correct: 2, inventedUrls: 1, failed: 0, wallMs: 1, tokens: 1 }, overturned: 0, carriedFrom: '2026-10-16',
  };
  const blinds = { b1: call('R', 1, ['q1']), b2: call('R', 1, ['q2']), b3: call('R', 1, ['q3']) };
  const grades = [ans('b1', 'q1', 'correct'), ans('b2', 'q2', 'wrong'), ans('b3', 'q3', 'wrong')];
  const fresh = aggregate({ grades, mapping: { date: '2026-11-20', seed: 1, failed: [], blinds }, keys: KEYS_R, tasks: { R: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }] } });
  const svg = renderCharts({ ...fresh, arms: [...fresh.arms, old] })['r-accuracy.svg'];
  assert.equal(valueOf(svg, 'codex:gpt-6.1-sol', 'correct'), 2);
  assert.equal(valueOf(svg, 'codex:gpt-6.1-sol', 'invented-urls'), 1);
  assert.equal(valueOf(svg, V, 'correct'), 1);
  assert.deepEqual(attrsOf(svg, 'dot').filter((d) => d['data-arm'] === 'codex:gpt-6.1-sol' && d['data-series'] === 'correct').map((d) => d['data-run']), ['1', '2']);
});

test('FX5: the caption of an incomplete arm counts what is missing and names no task id, on every chart that carries the caption', () => {
  const blinds = { b1: call('R', 1, ['q1']), b2: call('R', 1, ['q2']), b3: call('R', 2, ['q1']) };
  const RT = ['q1', 'q2', 'SECRET-Q9', 'SECRET-Q10'].map((id) => ({ id }));
  const agg = aggregate({ grades: [], mapping: { date: '2026-11-20', seed: 1, failed: [], blinds }, keys: KEYS_R, tasks: { R: RT } });
  assert.deepEqual(agg.arms[0].incomplete.missing, ['SECRET-Q9', 'SECRET-Q10']);
  const out = renderCharts(agg);
  for (const name of ['r-accuracy.svg', 'effort.svg', 'cost.svg']) assert.doesNotMatch(out[name], /SECRET-Q/, name);
  assert.match(out['r-accuracy.svg'], /incomplete, tasks per run 2, 1 of 2, 2 of the suite's tasks never run/);
});

// ─── second pass: what the mutation check left alive ─────────────────────────

test('FX1: a place named like third-party/ but longer is no place, and a path back to the place itself through a link is no tree', async () => {
  await withTmpdir(async (fresh) => {
    const dir = tmp('omelette-evals-tc-sibling-');
    writeTree(dir, 'third-party/t', { 'lib/widget.js': 'export const items = [];\n' });
    writeTree(dir, 'third-party-old/t', { 'lib/widget.js': 'export const items = [1];\n' });
    for (const tree of ['third-party-old/t', 'third-party.x/t']) {
      assert.throws(() => readTasks(evalsDir([{ id: 'X01', kind: 'recall', tree, file: 'lib/widget.js', prompt: BRIEF }]), 'V'), /task X01: .*third-party/, tree);
    }
    assert.throws(() => materializeTree({ dir, rel: 'third-party-old/t', id: 'T5', under: 'third-party' }), /relative path inside/);
    // `up` leads out of the place and `up/third-party` back to it: a real directory by name, the place itself by where it lands.
    symlinkSync('..', join(dir, 'third-party', 'up'));
    assert.throws(() => materializeTree({ dir, rel: 'third-party/up/third-party', id: 'T6', under: 'third-party' }), /through a link/);
    for (const id of ['T5', 'T6']) assert.equal(existsSync(join(fresh, 'omelette-evals', 'snapshots', id)), false, id);
  });
});

test('FX6: a `..` after a link in a Gemini arm\'s file is followed as the kernel follows it, not read as text', async () => {
  const home = tmp('omelette-evals-tc-home-');
  const dir = evalsDir([{ id: 'X01', kind: 'recall', tree: 'third-party/x/t', file: 'a/b/s/../../outside.txt', prompt: BRIEF }]);
  writeTree(dir, 'third-party/x/t', { 'a/outside.txt': 'invented decoy: where the text of the path points\n' });
  writeTree(dir, 'third-party/x', { 'outside.txt': 'invented: where the kernel lands, outside the tree\n' });
  mkdirSync(join(dir, 'third-party', 'x', 't', 'a', 'b'), { recursive: true });
  symlinkSync('..', join(dir, 'third-party', 'x', 't', 'a', 'b', 's'));
  await withTmpdir(() => assert.rejects(runArm({
    suite: 'V', arm: parseArm('gemini:Gemini 4 Neon (High)'), dir, out: quiet,
    serverPath: echoServer(home, 'gemini_research'), env: baseEnv(home, { AGY_BIN: fakeAgy(home) }),
  }), /outside/));
  assert.equal(existsSync(join(dir, 'runs')), false, 'no call was made');
});

const finding = (blindId, taskId, grade, extra = {}) => ({ blindId, taskId, item: 'finding', finding: 'invented location', grade, ...extra });
const KEY_X = [...KEY_V, { id: 'XK2', task: 'X01' }];

test('FX2: V\'s total keeps each grade count apart — confirmed, plausible and fabricated for keyed, recall-only and control calls', () => {
  const mapping = { date: 'd', seed: 1, failed: [], blinds: { b1: call('V', 1, ['V01']), b2: call('V', 1, ['X01']), b3: call('V', 1, ['C01']), b4: call('V', 2, ['V01']) } };
  const grades = [
    key('b1', 'V01', 'K1', 'found'), key('b1', 'V01', 'K2', 'not'),
    finding('b1', 'V01', 'plausible', { verified: true }), finding('b1', 'V01', 'plausible'), finding('b1', 'V01', 'plausible'),
    finding('b1', 'V01', 'fabricated'), finding('b1', 'V01', 'fabricated'), finding('b1', 'V01', 'fabricated'),
    key('b2', 'X01', 'XK1', 'found'), key('b2', 'X01', 'XK2', 'not'),
    finding('b2', 'X01', 'plausible'), finding('b2', 'X01', 'plausible'), finding('b2', 'X01', 'fabricated'),
    finding('b3', 'C01', 'plausible'), finding('b3', 'C01', 'fabricated'), finding('b3', 'C01', 'fabricated'),
    key('b4', 'V01', 'K1', 'found'), key('b4', 'V01', 'K2', 'found'), finding('b4', 'V01', 'fabricated'),
  ];
  const [arm] = aggregate({ grades, mapping, keys: { R: [], V: KEY_X }, tasks: { V: TASKS_V } }).arms;
  assert.deepEqual(arm.total, {
    calls: 4, keyItems: 4, found: 3, findings: 10, confirmed: 1, plausible: 2, fabricated: 4, recall: 0.75, precision: 0.4,
    recallOnly: { calls: 1, bugs: 2, found: 1, findings: 4, plausible: 2, fabricated: 1 },
    control: { calls: 1, findings: 3, plausible: 1, fabricated: 2 },
    failed: 0, empty: 0,
  });
});

test('FX5: V\'s precision bar is the pooled total, not the mean of the runs\' precisions; an old V aggregate (a total of failed and empty only) still draws from its means', () => {
  const mapping = { date: 'd', seed: 1, failed: [], blinds: { b1: call('V', 1, ['V01']), b2: call('V', 2, ['V01']) } };
  const grades = [key('b1', 'V01', 'K1', 'found'), key('b1', 'V01', 'K2', 'not'), key('b2', 'V01', 'K1', 'not'), key('b2', 'V01', 'K2', 'not'), finding('b2', 'V01', 'fabricated'), finding('b2', 'V01', 'fabricated'), finding('b2', 'V01', 'fabricated')];
  const agg = aggregate({ grades, mapping, keys: { R: [], V: KEY_V }, tasks: { V: [{ id: 'V01' }] } });
  assert.deepEqual(agg.arms[0].runs.map((r) => r.precision), [1, 0]);
  assert.equal(agg.arms[0].incomplete, null);
  const svg = renderCharts(agg)['v-recall-precision.svg'];
  assert.equal(valueOf(svg, V, 'precision'), 25, 'one real finding of four, pooled');
  assert.equal(valueOf(svg, V, 'recall'), 25);
  const old = {
    suite: 'V', arm: 'codex:gpt-6.1-sol', unit: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', cli: ['codex 9'], batch: false, keyItems: 7, n: 2, carriedFrom: '2026-10-16',
    runs: [{ run: 1, recall: 0.5, precision: 1, failed: 0 }, { run: 2, recall: 1, precision: 0.5, failed: 0 }],
    mean: { recall: 0.75, precision: 0.75 }, total: { failed: 0, empty: 0 }, overturned: 0,
  };
  const beside = renderCharts({ ...agg, arms: [...agg.arms, old] })['v-recall-precision.svg'];
  assert.equal(valueOf(beside, 'codex:gpt-6.1-sol', 'recall'), 75);
  assert.equal(valueOf(beside, 'codex:gpt-6.1-sol', 'precision'), 75);
});

test('FX5: a run that answered some of its calls is no failed run, whatever it answered — a keyed task, an R question, or only controls — and an arm with no gradable answer draws no bar', () => {
  const tasks = [...TASKS_V, { id: 'C02', kind: 'control', of: 'X01' }];
  // V: V01 answered and V02 failed in one run.
  const keyed = aggregate({
    grades: [key('b1', 'V01', 'K1', 'found')], keys: { R: [], V: KEY_V }, tasks: { V: tasks },
    mapping: { date: 'd', seed: 1, blinds: { b1: call('V', 1, ['V01']) }, failed: [failedCall('V', 1, ['V02'])] },
  });
  const k = renderCharts(keyed)['v-recall-precision.svg'];
  assert.equal(attrsOf(k, 'failed-run').length, 0, 'keyed answered, keyed failed');
  assert.equal(attrsOf(k, 'dot').filter((d) => d['data-series'] === 'recall').length, 1);
  // V: only controls, one answered and one failed.
  const controls = aggregate({
    grades: [finding('b1', 'C01', 'fabricated')], keys: { R: [], V: KEY_V }, tasks: { V: tasks },
    mapping: { date: 'd', seed: 1, blinds: { b1: call('V', 1, ['C01']) }, failed: [failedCall('V', 1, ['C02'])] },
  });
  assert.equal(attrsOf(renderCharts(controls)['v-recall-precision.svg'], 'failed-run').length, 0, 'only controls');
  // R: q1 and q3 answered, q2 failed.
  const r = aggregate({
    grades: [ans('b1', 'q1', 'correct'), ans('b3', 'q3', 'wrong')], keys: KEYS_R, tasks: { R: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }] },
    mapping: { date: 'd', seed: 1, blinds: { b1: call('R', 1, ['q1']), b3: call('R', 1, ['q3']) }, failed: [failedCall('R', 1, ['q2'])] },
  });
  const rs = renderCharts(r)['r-accuracy.svg'];
  assert.equal(attrsOf(rs, 'failed-run').length, 0, 'R answered some');
  assert.equal(attrsOf(rs, 'dot').filter((d) => d['data-series'] === 'correct').length, 1);
  // R: every call failed, so the arm has no correct count at all: no bar value, never a zero.
  const none = aggregate({
    grades: [], keys: KEYS_R, tasks: { R: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }] },
    mapping: { date: 'd', seed: 1, blinds: {}, failed: [failedCall('R', 1, ['q1']), failedCall('R', 1, ['q2']), failedCall('R', 1, ['q3'])] },
  });
  const ns = renderCharts(none)['r-accuracy.svg'];
  assert.equal(attrsOf(ns, 'bar').find((b) => b['data-series'] === 'correct')['data-value'], undefined);
  assert.equal(attrsOf(ns, 'failed-run').filter((d) => d['data-series'] === 'correct').length, 1);
});

test('FX5: an incomplete R arm\'s invented URLs are scaled like its correct answers: the total over the questions asked, times the arm\'s tasks', () => {
  const blinds = { b1: call('R', 1, ['q1']), b2: call('R', 1, ['q2']), b3: call('R', 1, ['q3']), b4: call('R', 2, ['q1']) };
  const url = (blindId, taskId) => ({ blindId, taskId, item: 'url', url: 'https://example.invalid/x', grade: 'unreachable-or-invented' });
  const grades = [ans('b1', 'q1', 'correct'), ans('b2', 'q2', 'correct'), ans('b3', 'q3', 'correct'), ans('b4', 'q1', 'correct'), url('b1', 'q1'), url('b2', 'q2'), url('b4', 'q1')];
  const agg = aggregate({ grades, mapping: { date: 'd', seed: 1, failed: [], blinds }, keys: KEYS_R, tasks: { R: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }] } });
  const svg = renderCharts(agg)['r-accuracy.svg'];
  assert.equal(valueOf(svg, V, 'invented-urls'), (3 / 4) * 3);
  assert.equal(valueOf(svg, V, 'correct'), 3);
});
