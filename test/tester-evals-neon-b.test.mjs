// Tester's tests for the evals-neon batch B/C (plan docs/superpowers/plans/2026-11-19-evals-neon.md, T8–T13, and the
// session's three rulings of 2026-11-19: a run is a task's n-th answer, an absent `empty` is unknown, the level collapse).
// Only what the implementer's own tests leave unpinned. Every task, key, answer and file below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, redact, redactionTerms } from '../scripts/eval-blind.mjs';
import { renderCharts } from '../scripts/eval-chart.mjs';
import { inlineDiffPrompt, isRelativeInside, materializeTree, parseArm, readTasks, runArm, snapshotFor } from '../scripts/eval-run.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BLIND = join(ROOT, 'scripts', 'eval-blind.mjs');
const RUN = join(ROOT, 'scripts', 'eval-run.mjs');

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const jsonl = (xs) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n';

// ─── helpers for the runner ──────────────────────────────────────────────────

function evalsDir(suites) {
  const dir = tmp('omelette-evals-tb-');
  for (const [suite, tasks] of Object.entries(suites)) {
    mkdirSync(join(dir, 'suites', suite), { recursive: true });
    writeFileSync(join(dir, 'suites', suite, 'tasks.jsonl'), jsonl(tasks));
  }
  return dir;
}
function writeTree(dir, rel, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel, name)), { recursive: true });
    writeFileSync(join(dir, rel, name), text);
  }
}
function fakeCodex(dir) {
  const p = join(dir, 'fake-codex');
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const a = process.argv.slice(2);',
    'if (a[0] === "--version") { console.log("fake-codex 1.2.3"); process.exit(0); }',
    'let s = ""; process.stdin.on("data", (c) => { s += c; }).on("end", () => {',
    '  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok " + process.cwd() } }) + "\\n");',
    '});',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
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
const quiet = () => {};
async function withTmpdir(fn) {
  const fresh = tmp('omelette-evals-tb-tmpdir-');
  const was = process.env.TMPDIR;
  process.env.TMPDIR = fresh;
  try { return await fn(fresh); } finally {
    if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
  }
}

const BRIEF = 'Invented review brief: read the change and report what you find.';
const DIFF = '--- a/lib/widget.js\n+++ b/lib/widget.js\n@@ -1 +1 @@\n-export const items = [];\n+export const items = [1];\n';

// ─── T8: task lines ──────────────────────────────────────────────────────────

test('a V task line with a show, a commit, a diff or a control that is wrong is refused by task id; a control may precede its task', () => {
  const dir = evalsDir({ V: [] });
  writeFileSync(join(dir, 'suites', 'V', 'X01.diff'), DIFF);
  const x01 = { id: 'X01', kind: 'recall', tree: 'third-party/x01/before-fix', file: 'lib/widget.js', prompt: BRIEF };
  const refused = [
    ['show not one of file|diff', { id: 'V09', commit: 'abc1234', file: 'a.js', show: 'both', prompt: BRIEF }],
    ['commit that is no commit id', { id: 'V09', commit: 'not-a-sha', file: 'a.js', prompt: BRIEF }],
    ['show file without a file', { id: 'V09', commit: 'abc1234', prompt: BRIEF }],
    ['a shown diff file that is missing', { id: 'V09', kind: 'recall', show: 'diff', tree: 'third-party/x', diff: 'suites/V/missing.diff', prompt: BRIEF }],
    ['a shown diff that leaves the private dir', { id: 'V09', kind: 'recall', show: 'diff', tree: 'third-party/x', diff: '../X01.diff', prompt: BRIEF }],
    ['a shown diff that is a directory', { id: 'V09', kind: 'recall', show: 'diff', tree: 'third-party/x', diff: 'suites/V', prompt: BRIEF }],
    ['a control of itself', { id: 'V09', kind: 'control', of: 'V09', tree: 'third-party/x', file: 'a.js', prompt: BRIEF }],
    ['a control with no "of"', { id: 'V09', kind: 'control', tree: 'third-party/x', file: 'a.js', prompt: BRIEF }],
    ['a control whose prompt differs by a line ending', { ...x01, id: 'V09', kind: 'control', of: 'X01', prompt: BRIEF.replace(': ', ':\r\n') }],
  ];
  for (const [what, line] of refused) {
    const d = evalsDir({ V: [x01, line] });
    writeFileSync(join(d, 'suites', 'V', 'X01.diff'), DIFF);
    assert.throws(() => readTasks(d, 'V'), /task V09: /, what);
  }
  // A control may come before the task it controls in the file.
  const ok = evalsDir({ V: [{ ...x01, id: 'C01', kind: 'control', of: 'X01' }, x01] });
  assert.deepEqual(readTasks(ok, 'V').map((t) => t.id), ['C01', 'X01']);
});

test('the dry run names a tree task\'s copy and makes none; a Gemini arm gets no snapshot line for a tree task', () => {
  const home = tmp('omelette-evals-tb-home-');
  const dir = evalsDir({
    V: [
      { id: 'C01', kind: 'control', of: 'X01', tree: 'third-party/x01/after-fix', file: 'lib/widget.js', prompt: BRIEF },
      { id: 'X01', kind: 'recall', tree: 'third-party/x01/before-fix', file: 'lib/widget.js', prompt: BRIEF },
    ],
  });
  writeTree(dir, 'third-party/x01/before-fix', { 'lib/widget.js': 'export const items = [];\n' });
  writeTree(dir, 'third-party/x01/after-fix', { 'lib/widget.js': 'export const items = [1];\n' });
  const dry = (arm) => spawnSync(process.execPath, [RUN, '--suite', 'V', '--arm', arm, '--dir', dir, '--dry-run'], {
    encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home },
  });
  const cwd = dry('codex:gpt-6.1-sol');
  assert.equal(cwd.status, 0, cwd.stderr);
  assert.match(cwd.stdout, /snapshot \S*X01 \(a fresh copy of third-party\/x01\/before-fix when it runs\)/);
  assert.match(cwd.stdout, /snapshot \S*C01 \(a fresh copy of third-party\/x01\/after-fix when it runs\)/);
  assert.ok(cwd.stdout.indexOf('run 1  X01') < cwd.stdout.indexOf('run 1  C01'), 'the control is planned last');
  assert.equal(existsSync(join(home, 'omelette-evals')), false, 'nothing was copied');
  assert.equal(existsSync(join(dir, 'runs')), false, 'nothing was written');
  const gem = dry('gemini:Gemini 4 Neon (High)');
  assert.equal(gem.status, 0, gem.stderr);
  assert.doesNotMatch(gem.stdout, /snapshot /);
  assert.match(gem.stdout, /run 1  X01  gemini_research/);
});

test('a Gemini arm refuses a shown file that a link in the third-party tree leads out of the tree', async () => {
  const home = tmp('omelette-evals-tb-home-');
  const dir = evalsDir({ V: [{ id: 'X01', kind: 'recall', tree: 'third-party/x01/before-fix', file: 'lib/widget.js', prompt: BRIEF }] });
  writeFileSync(join(dir, 'outside.txt'), 'invented text outside the tree');
  mkdirSync(join(dir, 'third-party', 'x01', 'before-fix', 'lib'), { recursive: true });
  symlinkSync('../../../../outside.txt', join(dir, 'third-party', 'x01', 'before-fix', 'lib', 'widget.js'));
  await withTmpdir(() => assert.rejects(
    runArm({
      suite: 'V', arm: parseArm('gemini:Gemini 4 Neon (High)'), dir, out: quiet,
      serverPath: echoServer(home, 'gemini_research'), env: baseEnv(home, { AGY_BIN: fakeAgy(home) }),
    }),
    /outside/,
  ));
});

test('the key stays out of reach: a tree that holds the private dir\'s key is never handed to a cwd arm', async () => {
  // Spec, Contamination: "outside the snapshot, outside any directory a run is given". A tree of `.` (or of `suites`) is the private dir itself.
  for (const tree of ['.', 'suites']) {
    const home = tmp('omelette-evals-tb-home-');
    const dir = evalsDir({ V: [{ id: 'X01', kind: 'recall', tree, file: 'V/tasks.jsonl', prompt: BRIEF }] });
    writeFileSync(join(dir, 'suites', 'V', 'key.jsonl'), jsonl([{ id: 'XK1', task: 'X01', defect: 'INVENTED-KEY-TEXT' }]));
    await withTmpdir(async (fresh) => {
      let refused = false;
      try {
        await runArm({ suite: 'V', arm: parseArm('codex:gpt-6.1-sol'), dir, out: quiet, env: baseEnv(home, { CODEX_BIN: fakeCodex(home) }) });
      } catch { refused = true; }
      const snap = join(fresh, 'omelette-evals', 'snapshots', 'X01');
      const handed = !refused && existsSync(snap) ? readdirSync(snap, { recursive: true }).filter((f) => String(f).endsWith('key.jsonl')) : [];
      assert.deepEqual(handed, [], `tree ${JSON.stringify(tree)} put the key in the reviewer's cwd`);
    });
  }
});

// ─── T9/T10/T12 and ruling 1, 2: the aggregate ───────────────────────────────

const N = 'gemini:Gemini 4 Neon (High)';
const entry = (suite, run, task, extra = {}) => ({
  suite, arm: N, run, taskIds: [task], unit: 'gemini', model: 'Gemini 4 Neon (High)', effort: 'high', cli: 'agy 9.9.9', wallMs: 1000, usage: { input: 10, output: 10 }, ...extra,
});
const keyOn = (blindId, taskId, keyId, grade) => ({ blindId, taskId, item: 'key', keyId, grade });
const finding = (blindId, taskId, grade, extra = {}) => ({ blindId, taskId, item: 'finding', finding: 'invented location', grade, ...extra });

test('ruling 1, V: with uneven runs the arm\'s total sums found, findings and fabricated over its calls, not over its run rows', () => {
  // Run 1 reviews V01 (2 key items) and V02 (3); run 2 is only V01 again (a task's second answer). The spec's rules read the total.
  const keys = { R: [], V: [{ id: 'K1', task: 'V01' }, { id: 'K2', task: 'V01' }, { id: 'K3', task: 'V02' }, { id: 'K4', task: 'V02' }, { id: 'K5', task: 'V02' }] };
  const mapping = { date: 'd', seed: 1, failed: [], blinds: { b1: entry('V', 1, 'V01'), b2: entry('V', 1, 'V02'), b3: entry('V', 2, 'V01') } };
  const grades = [
    keyOn('b1', 'V01', 'K1', 'found'), keyOn('b1', 'V01', 'K2', 'found'),
    keyOn('b2', 'V02', 'K3', 'not'), keyOn('b2', 'V02', 'K4', 'not'), keyOn('b2', 'V02', 'K5', 'not'), finding('b2', 'V02', 'fabricated'),
    keyOn('b3', 'V01', 'K1', 'found'), keyOn('b3', 'V01', 'K2', 'not'),
  ];
  const [arm] = aggregate({ grades, mapping, keys, tasks: { V: [{ id: 'V01' }, { id: 'V02' }] } }).arms;
  assert.deepEqual(arm.runs.map((r) => [r.run, r.found, r.findings, r.fabricated]), [[1, 2, 3, 1], [2, 1, 1, 0]]);
  assert.deepEqual([arm.total.found, arm.total.findings, arm.total.fabricated], [3, 4, 1]);
});

test('ruling 2, V: a failed line from before `empty` leaves the run\'s and the arm\'s empty count unknown (null), whatever a later line says', () => {
  const keys = { R: [], V: [{ id: 'K1', task: 'V01' }] };
  const old = { ...entry('V', 1, 'V02'), error: 'agy produced no output: invented', empty: null };
  const known = { ...entry('V', 2, 'V02'), error: 'agy produced no output: invented', empty: true };
  const mapping = { date: 'd', seed: 1, blinds: { b1: entry('V', 1, 'V01'), b2: entry('V', 2, 'V01') }, failed: [old, known] };
  const grades = [keyOn('b1', 'V01', 'K1', 'found'), keyOn('b2', 'V01', 'K1', 'not')];
  const [arm] = aggregate({ grades, mapping, keys, tasks: { V: [{ id: 'V01' }, { id: 'V02' }] } }).arms;
  assert.deepEqual(arm.runs.map((r) => [r.run, r.failed, r.empty]), [[1, 1, null], [2, 1, 1]]);
  assert.deepEqual([arm.total.failed, arm.total.empty], [2, null]);
});

test('a grade line that does not belong is refused by line: an unknown finding grade, `verified` on a key or an answer', () => {
  const keys = { R: [{ id: 'q1' }], V: [{ id: 'K1', task: 'V01' }] };
  const mapping = { date: 'd', seed: 1, failed: [], blinds: { b1: entry('V', 1, 'V01'), b2: entry('R', 1, 'q1') } };
  const tasks = { V: [{ id: 'V01' }] };
  const run = (line) => aggregate({ grades: [line], mapping, keys, tasks });
  assert.throws(() => run(finding('b1', 'V01', 'confirmed')), /grades line 1: .*not a grade/);
  assert.throws(() => run({ ...keyOn('b1', 'V01', 'K1', 'found'), verified: true }), /grades line 1: .*verified/);
  assert.throws(() => run({ blindId: 'b2', taskId: 'q1', item: 'answer', grade: 'correct', verified: true }), /grades line 1: .*verified/);
  // An overturn counts as the new grade: a fabricated finding the session lifted to plausible is plausible, and confirmed once verified.
  const [arm] = run(finding('b1', 'V01', 'fabricated', { overturned: { from: 'fabricated', to: 'plausible' }, verified: true })).arms.filter((a) => a.suite === 'V');
  assert.deepEqual([arm.runs[0].confirmed, arm.runs[0].plausible, arm.runs[0].fabricated], [1, 0, 0]);
});

// ─── T11: --merge ────────────────────────────────────────────────────────────

/** A dated grading directory of one R arm, a key, and (when `rTasks`) the R question file; returns the dir. */
function mergeFixture({ rTasks, prevSets }) {
  const dir = tmp('omelette-evals-tb-merge-');
  const g = join(dir, 'grading', '2026-11-20');
  mkdirSync(g, { recursive: true });
  mkdirSync(join(dir, 'aggregates'), { recursive: true });
  mkdirSync(join(dir, 'suites', 'R'), { recursive: true });
  writeFileSync(join(g, 'mapping.json'), JSON.stringify({ date: '2026-11-20', seed: 1, failed: [], blinds: { b1: entry('R', 1, 'q1') } }));
  writeFileSync(join(g, 'grades.jsonl'), jsonl([{ blindId: 'b1', taskId: 'q1', item: 'answer', grade: 'correct' }]));
  writeFileSync(join(dir, 'suites', 'R', 'key.jsonl'), jsonl([{ id: 'q1', answer: 'invented', trap: false }]));
  if (rTasks) writeFileSync(join(dir, 'suites', 'R', 'tasks.jsonl'), jsonl(rTasks));
  const oldArm = (suite, arm) => ({ suite, arm, unit: 'codex', model: 'm', effort: 'xhigh', cli: ['c 1'], n: 1, runs: [], mean: {}, total: {} });
  writeFileSync(join(dir, 'aggregates', '2026-10-16.json'), JSON.stringify({
    date: '2026-10-16', arms: [oldArm('R', 'codex:old'), oldArm('V', 'codex:old')], grades: 0, overturned: 0, ...(prevSets === undefined ? {} : { sets: prevSets }),
  }));
  return dir;
}
const merge = (dir) => spawnSync(process.execPath, [BLIND, '--date', '2026-11-20', '--dir', dir, '--aggregate', '--merge', '2026-10-16', '--carry', 'codex:old'], { encoding: 'utf8', timeout: 5000 });
const armsOf = (dir) => JSON.parse(readFileSync(join(dir, 'aggregates', '2026-11-20.json'), 'utf8')).arms.map((a) => [a.suite, a.arm, a.carriedFrom || null]);

test('--merge leaves out R arms when both aggregates record an R set and the sets differ, or when this round has no question file', () => {
  const differs = mergeFixture({ rTasks: [{ id: 'q1', prompt: 'Invented question.' }], prevSets: { R: '0123456789abcdef' } });
  const a = merge(differs);
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(armsOf(differs), [['R', N, null], ['V', 'codex:old', '2026-10-16']]);
  assert.match(a.stdout, /R: 1 arm\(s\) of 2026-10-16 not carried/);
  // Without a question file here the set is unknown, and an unknown set is not the same set as another unknown one.
  const unknown = mergeFixture({ rTasks: null, prevSets: { R: null } });
  const b = merge(unknown);
  assert.equal(b.status, 0, b.stderr);
  assert.deepEqual(armsOf(unknown), [['R', N, null], ['V', 'codex:old', '2026-10-16']]);
});

test('--aggregate reads suites/V/tasks.jsonl for each task\'s kind: a recall task and a control are counted apart on the written aggregate', () => {
  const dir = tmp('omelette-evals-tb-kinds-');
  const g = join(dir, 'grading', '2026-11-20');
  mkdirSync(g, { recursive: true });
  mkdirSync(join(dir, 'suites', 'V'), { recursive: true });
  const tasks = [
    { id: 'X01', kind: 'recall', tree: 't/x', file: 'a.js', prompt: BRIEF },
    { id: 'C01', kind: 'control', of: 'X01', tree: 't/c', file: 'a.js', prompt: BRIEF },
  ];
  writeFileSync(join(dir, 'suites', 'V', 'tasks.jsonl'), jsonl(tasks));
  writeFileSync(join(dir, 'suites', 'V', 'key.jsonl'), jsonl([{ id: 'XK1', task: 'X01', defect: 'invented' }]));
  writeFileSync(join(g, 'mapping.json'), JSON.stringify({ date: '2026-11-20', seed: 1, failed: [], blinds: { b1: entry('V', 1, 'X01'), b2: entry('V', 1, 'C01') } }));
  writeFileSync(join(g, 'grades.jsonl'), jsonl([keyOn('b1', 'X01', 'XK1', 'found'), finding('b2', 'C01', 'plausible'), finding('b2', 'C01', 'fabricated')]));
  const res = spawnSync(process.execPath, [BLIND, '--date', '2026-11-20', '--dir', dir, '--aggregate'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(res.status, 0, res.stderr);
  const [arm] = JSON.parse(readFileSync(join(dir, 'aggregates', '2026-11-20.json'), 'utf8')).arms;
  assert.deepEqual(arm.runs[0].recallOnly, { tasks: 1, bugs: 1, found: 1, findings: 1, plausible: 0, fabricated: 0 });
  assert.deepEqual(arm.runs[0].control, { tasks: 1, findings: 2, plausible: 1, fabricated: 1 });
  assert.equal(arm.runs[0].found, null, 'no keyed task: no keyed recall');
});

// ─── ruling 3 (T9b): the level collapse ──────────────────────────────────────

test('level collapse: a level beside the name goes in any case and spacing; an ordinary word or a compound beside it stays', () => {
  const terms = redactionTerms();
  const gone = [
    ['NEON/XHIGH', '[model]'],
    ['Neon , XHigh', '[model]'],
    ['Neon xhigh', '[model]'],
    ['Neon  \n  (High)', '[model]'],
    ['Neon\n  · XHigh found it', '[model] found it'],
    ['Neon/low.', '[model].'],
  ];
  for (const [text, want] of gone) assert.equal(redact(text, terms), want, JSON.stringify(text));
  const kept = [
    ['Neon XHighlights the bug', '[model] XHighlights the bug'],
    ['Neon/low-latency paths', '[model]/low-latency paths'],
    ['Neon, low recall', '[model], low recall'],
    ['Neon, medium-sized', '[model], medium-sized'],
    ['Neon, High and Low severity', '[model], High and Low severity'],
    ['Neon\n\n(High) latency', '[model]\n\n(High) latency'],
    ['Neon\n1. High', '[model]\n1. High'],
  ];
  for (const [text, want] of kept) assert.equal(redact(text, terms), want, JSON.stringify(text));
});

test('level collapse: XHigh is no English word, so it goes with the name even where a hyphen joins it to another word', () => {
  const out = redact('Neon XHigh-thinking found it; Hydrogen XHigh-level did not.', redactionTerms());
  assert.ok(!/xhigh/i.test(out), out);
});

// ─── T13: the charts ─────────────────────────────────────────────────────────

test('the native reviewer is drawn after the fleet\'s units, not before them', () => {
  const v = (arm, unit, model, effort) => ({
    suite: 'V', arm, unit, model, effort, cli: ['x 1'], batch: false, keyItems: 7, n: 1,
    runs: [{ run: 1, recall: 0.5, precision: 0.5, failed: 0, wallMs: 1, tokens: 1 }], mean: { recall: 0.5, precision: 0.5, wallMs: 1, tokens: 1 }, overturned: 0,
  });
  const arms = [
    v('native:omelette-reviewer', 'native', 'claude-opus-5-5', 'xhigh'),
    v('codex:gpt-6.1-sol', 'codex', 'gpt-6.1-sol', 'xhigh'),
    v('gemini:Gemini 4 Neon (High)', 'gemini', 'Gemini 4 Neon (High)', 'high'),
  ];
  const svg = renderCharts({ date: '2026-11-20', grades: 0, overturned: 0, arms })['v-recall-precision.svg'];
  const order = [...new Set([...svg.matchAll(/data-arm="([^"]*)" data-series="recall"/g)].map((m) => m[1]))];
  assert.deepEqual(order, ['gemini:Gemini 4 Neon (High)', 'codex:gpt-6.1-sol', 'native:omelette-reviewer']);
});

// ═══ second pass: tests that kill what the mutation check left alive ═══════════

// ─── T8: paths, tree copies ──────────────────────────────────────────────────

test('isRelativeInside: a path that is empty, absolute or leaves its base after normalising is refused, however it is spelt', () => {
  for (const bad of ['', '/abs', '..', '../x', 'a/../..', 'a/b/../../../c', undefined, null, 5]) assert.equal(isRelativeInside(bad), false, String(bad));
  for (const good of ['a', 'a/b', 'a/../b', 'lib/widget.js']) assert.equal(isRelativeInside(good), true, good);
});

test('a task line whose tree is empty or only leaves the private dir after normalising is refused; an empty task file is refused', () => {
  for (const tree of ['', 'a/../../outside']) {
    assert.throws(() => readTasks(evalsDir({ V: [{ id: 'X01', kind: 'recall', tree, file: 'a.js', prompt: BRIEF }] }), 'V'), /task X01: /, JSON.stringify(tree));
  }
  assert.throws(() => readTasks(evalsDir({ V: [] }), 'V'), /holds no task/);
  // A control is its task's brief character for character: a different line ending is another brief.
  const x = { id: 'X01', kind: 'recall', tree: 'third-party/x', file: 'a.js', prompt: 'line one\nline two' };
  assert.throws(() => readTasks(evalsDir({ V: [x, { ...x, id: 'C01', kind: 'control', of: 'X01', prompt: 'line one\r\nline two' }] }), 'V'), /task C01: .*word for word/);
});

test('materializeTree: links that stay inside survive as links, every way out is refused and leaves nothing behind', async () => {
  await withTmpdir(async (fresh) => {
    const snaps = join(fresh, 'omelette-evals', 'snapshots');
    const fixture = (name, setup) => {
      const dir = tmp('omelette-evals-tb-mt-');
      writeTree(dir, name, { 'lib/widget.js': 'export const items = [];\n' });
      mkdirSync(join(dir, 'outside'), { recursive: true });
      writeFileSync(join(dir, 'outside', 'secret.txt'), 'invented secret');
      setup(join(dir, name));
      return dir;
    };
    // Inside: a relative link to a file and one to the root itself are copied as they are.
    const okDir = fixture('third-party/t', (r) => { symlinkSync('lib/widget.js', join(r, 'alias.js')); symlinkSync('.', join(r, 'self')); });
    const copy = materializeTree({ dir: okDir, rel: 'third-party/t', id: 'T1', under: 'third-party' });
    assert.equal(readlinkSync(join(copy, 'alias.js')), 'lib/widget.js', 'the link stays relative: it points into the copy, not the original');
    assert.equal(readFileSync(join(copy, 'alias.js'), 'utf8'), 'export const items = [];\n');
    assert.equal(readlinkSync(join(copy, 'self')), '.');
    // Out: deep in the tree, a history, a file as a tree, a link as a tree.
    const refusals = [
      ['a link deep in the tree', (r) => { mkdirSync(join(r, 'a', 'b'), { recursive: true }); symlinkSync('../../../outside/secret.txt', join(r, 'a', 'b', 'bad')); }, /points out of it: a\/b\/bad/],
      ['a .git directory', (r) => mkdirSync(join(r, '.git')), /\.git/],
    ];
    for (const [what, setup, re] of refusals) {
      const dir = fixture('third-party/t', setup);
      assert.throws(() => materializeTree({ dir, rel: 'third-party/t', id: 'T2', under: 'third-party' }), re, what);
      assert.deepEqual(existsSync(snaps) ? readdirSync(snaps).filter((n) => n.startsWith('T2')) : [], [], `${what}: no copy and no staging left`);
    }
    const dir = fixture('third-party/t', () => {});
    writeFileSync(join(dir, 'third-party', 'afile'), 'x');
    symlinkSync(join(dir, 'outside'), join(dir, 'third-party', 'linked'));
    assert.throws(() => materializeTree({ dir, rel: 'third-party/afile', id: 'T3', under: 'third-party' }), /not a directory/);
    assert.throws(() => materializeTree({ dir, rel: 'third-party/linked', id: 'T3', under: 'third-party' }), /not a directory/, 'a tree that is itself a link is not a directory of the private dir');
    assert.throws(() => materializeTree({ dir, rel: '../x', id: 'T3', under: 'third-party' }), /relative path inside/);
    for (const id of ['../evil', 'a/b', '', '.hidden']) assert.throws(() => materializeTree({ dir, rel: 't', id }), /cannot name a snapshot directory/, JSON.stringify(id));
  });
});

test('a shown diff is fenced by more backticks than any run in it, so it cannot close the fence and add text after it', () => {
  const diffText = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+```\n+````\n+`````` after\n';
  const prompt = inlineDiffPrompt({ prompt: BRIEF, diffText });
  const open = /^(`{3,})diff$/m.exec(prompt);
  assert.ok(open, prompt);
  assert.ok(open[1].length > 6, `the fence is ${open[1].length} backticks, the diff holds a run of 6`);
  assert.ok(prompt.endsWith(`\n${open[1]}`));
});

test('--snapshot is refused for a tree task by a Gemini arm too, by snapshotFor itself, and for tasks at two commits', async () => {
  const home = tmp('omelette-evals-tb-home-');
  const snapshot = join(tmp('omelette-evals-tb-snap-'), 's');
  const tree = { id: 'X01', kind: 'recall', tree: 'third-party/x01/before-fix', file: 'lib/widget.js', prompt: BRIEF };
  const dir = evalsDir({ V: [tree] });
  writeTree(dir, 'third-party/x01/before-fix', { 'lib/widget.js': 'export const items = [];\n' });
  await assert.rejects(
    runArm({ suite: 'V', arm: parseArm('gemini:Gemini 4 Neon (High)'), dir, snapshot, out: quiet, serverPath: echoServer(home, 'gemini_research'), env: baseEnv(home, { AGY_BIN: fakeAgy(home) }) }),
    /--snapshot is for tasks at a commit/,
  );
  assert.throws(() => snapshotFor({ task: tree, dir, snapshot }), /--snapshot is for tasks at a commit/);
  const two = evalsDir({ V: [{ id: 'V01', commit: 'abc1234', file: 'a.js', prompt: BRIEF }, { id: 'V02', commit: 'def5678', file: 'a.js', prompt: BRIEF }] });
  await assert.rejects(runArm({ suite: 'V', arm: parseArm('codex:gpt-6.1-sol'), dir: two, snapshot, out: quiet, env: baseEnv(home, { CODEX_BIN: fakeCodex(home) }) }), /more than one commit/);
});

// ─── T9/T10/T12: the aggregate, edges ────────────────────────────────────────

test('R: a batch call that ended empty counts every question it held; a run counts only the traps it covered; the median is numeric and over answered calls', () => {
  const keys = { R: [{ id: 'q1' }, { id: 'q2', trap: true }, { id: 'q3', trap: true }], V: [] };
  const batch = { ...entry('R', 1, 'q1'), taskIds: ['q1', 'q2', 'q3'], error: 'agy produced no output: invented', empty: true };
  const [a] = aggregate({ grades: [], mapping: { date: 'd', seed: 1, blinds: {}, failed: [batch] }, keys }).arms;
  assert.deepEqual([a.runs[0].failed, a.runs[0].empty, a.runs[0].traps], [3, 3, 2]);
  const g = (blindId, taskId) => ({ blindId, taskId, item: 'answer', grade: 'correct' });
  const mapping = { date: 'd', seed: 1, failed: [], blinds: { b1: entry('R', 1, 'q1', { wallMs: 9000 }), b2: entry('R', 1, 'q2', { wallMs: 10000 }), b3: entry('R', 2, 'q3', { wallMs: 1000 }) } };
  const [b] = aggregate({ grades: [g('b1', 'q1'), g('b2', 'q2'), g('b3', 'q3')], mapping, keys }).arms;
  assert.deepEqual(b.runs.map((r) => [r.traps, r.trapsPassed]), [[1, 1], [1, 1]]);
  assert.deepEqual([b.total.traps, b.total.trapsPassed], [2, 2]);
  assert.equal(b.wallMsMedian, 9000, 'numeric order 1000, 9000, 10000 (a text sort puts 10000 first)');
  // A failed call's time is not an answered call's: the median ignores it, and an arm with no answered call has none.
  const slow = { ...entry('R', 2, 'q1', { wallMs: 500000 }), error: 'invented', empty: false };
  const [c] = aggregate({ grades: [g('b1', 'q1'), g('b2', 'q2')], mapping: { ...mapping, blinds: { b1: mapping.blinds.b1, b2: mapping.blinds.b2 }, failed: [slow] }, keys }).arms;
  assert.equal(c.wallMsMedian, 9500);
  const [d] = aggregate({ grades: [], mapping: { date: 'd', seed: 1, blinds: {}, failed: [slow] }, keys }).arms;
  assert.equal(d.wallMsMedian, null);
});

test('V: a task-less key belongs to the one keyed task — a control beside it, or an empty key, is no second owner; a failed call is a covered task', () => {
  const tasks = { V: [{ id: 'V01' }, { id: 'V02' }, { id: 'X01', kind: 'recall' }, { id: 'C01', kind: 'control', of: 'X01' }] };
  const map = (blinds, failed = []) => ({ date: 'd', seed: 1, failed, blinds: Object.fromEntries(Object.entries(blinds).map(([b, t]) => [b, entry('V', 1, t)])) });
  const [a] = aggregate({ grades: [keyOn('b1', 'V01', 'k1', 'found')], mapping: map({ b1: 'V01', b2: 'C01' }), keys: { R: [], V: [{ id: 'k1' }] }, tasks }).arms;
  assert.equal(a.runs[0].found, 1);
  assert.doesNotThrow(() => aggregate({ grades: [], mapping: map({ b1: 'V01', b2: 'V02' }), keys: { R: [], V: [] }, tasks }));
  assert.throws(
    () => aggregate({ grades: [], mapping: map({ b1: 'V01' }, [{ ...entry('V', 1, 'V02'), error: 'x', empty: false }]), keys: { R: [], V: [{ id: 'k1' }] }, tasks }),
    /names no task/,
  );
});

test('V: one credit per keyed bug even when two answers of the run were graded found; no key item or no finding is null, never NaN', () => {
  const keys = { R: [], V: [{ id: 'K1', task: 'V01' }, { id: 'K2', task: 'V01' }, { id: 'XK1', task: 'X01' }, { id: 'XK2', task: 'X01' }] };
  const tasks = { V: [{ id: 'V01' }, { id: 'V02' }, { id: 'X01', kind: 'recall' }, { id: 'C01', kind: 'control', of: 'X01' }, { id: 'C02', kind: 'control', of: 'X01' }] };
  const two = { date: 'd', seed: 1, failed: [], blinds: { b1: entry('V', 1, 'V01'), b2: entry('V', 1, 'V01') } };
  const [a] = aggregate({ grades: [keyOn('b1', 'V01', 'K1', 'found'), keyOn('b2', 'V01', 'K1', 'found'), keyOn('b2', 'V01', 'K2', 'not')], mapping: two, keys, tasks }).arms;
  assert.deepEqual([a.runs[0].found, a.runs[0].recall], [1, 0.5]);
  // A keyed task with no key line has nothing to find: recall is null; a run with no finding has no precision.
  const [b] = aggregate({ grades: [], mapping: { date: 'd', seed: 1, failed: [], blinds: { b1: entry('V', 1, 'V02') } }, keys, tasks }).arms;
  assert.deepEqual([b.runs[0].recall, b.runs[0].precision, b.runs[0].findings], [null, null, 0]);
  const [c] = aggregate({ grades: [keyOn('b1', 'V01', 'K1', 'not'), keyOn('b1', 'V01', 'K2', 'not')], mapping: { date: 'd', seed: 1, failed: [], blinds: { b1: entry('V', 1, 'V01') } }, keys, tasks }).arms;
  assert.deepEqual([c.runs[0].recall, c.runs[0].precision], [0, null]);
  // Recall-only: bugs is the task's key items, found a subset; controls are counted by task.
  const m = { date: 'd', seed: 1, failed: [], blinds: { b1: entry('V', 1, 'X01'), b2: entry('V', 1, 'C01'), b3: entry('V', 1, 'C02') } };
  const [d] = aggregate({ grades: [keyOn('b1', 'X01', 'XK1', 'found'), keyOn('b1', 'X01', 'XK2', 'not')], mapping: m, keys, tasks }).arms;
  assert.deepEqual([d.runs[0].recallOnly.tasks, d.runs[0].recallOnly.bugs, d.runs[0].recallOnly.found, d.runs[0].control.tasks], [1, 2, 1, 2]);
});

test('a `verified` field is refused wherever it is present, `false` included, on a key line or a recall task\'s finding', () => {
  const keys = { R: [], V: [{ id: 'K1', task: 'V01' }] };
  const mapping = { date: 'd', seed: 1, failed: [], blinds: { b1: entry('V', 1, 'V01'), b2: entry('V', 1, 'X01') } };
  const tasks = { V: [{ id: 'V01' }, { id: 'X01', kind: 'recall' }] };
  assert.throws(() => aggregate({ grades: [{ ...keyOn('b1', 'V01', 'K1', 'found'), verified: false }], mapping, keys, tasks }), /grades line 1: .*verified/);
  assert.throws(() => aggregate({ grades: [finding('b2', 'X01', 'plausible', { verified: false })], mapping, keys, tasks }), /grades line 1: .*not our own code/);
});

// ─── ruling 3, second pass: the collapse alternatives the first set did not reach ──

test('level collapse: capitalised levels at a clause end, slug forms, a version after any join, and a level in brackets all go with the name', () => {
  const terms = redactionTerms();
  const gone = [
    ['Neon HIGH', '[model]'], ['Neon LOW', '[model]'], ['Neon Low.', '[model].'], ['Neon MEDIUM,', '[model],'], ['Neon Medium)', '[model])'],
    ['Neon High\nnext line', '[model]\nnext line'], ['Neon High. Then it', '[model]. Then it'],
    ['Neon/Medium.', '[model].'], ['Neon, Medium.', '[model].'], ['Neon/low then', '[model] then'],
    ['neon-max and neon_ultra', '[model] and [model]'], ['Neon (Max)', '[model]'], ['Neon (Ultra)', '[model]'],
    ['Neon v2 and Neon V3', '[model] and [model]'], ['Neon/5', '[model]'], ['Neon·5', '[model]'], ['Neon_5', '[model]'],
  ];
  for (const [text, want] of gone) assert.equal(redact(text, terms), want, JSON.stringify(text));
  const kept = [
    ['Neon-lowercase text', '[model]-lowercase text'], ['Neon-highway signs', '[model]-highway signs'],
    ['Neon · high2 is a label', '[model] · high2 is a label'], ['Neon/low2 paths', '[model]/low2 paths'],
  ];
  for (const [text, want] of kept) assert.equal(redact(text, terms), want, JSON.stringify(text));
});

// ─── T13, second pass ────────────────────────────────────────────────────────

test('charts: the native arm is labelled by its role alone, a GPT-OSS arm through agy is no Gemini curve, and carried arms of one date share a line', () => {
  const arm = (suite, name, unit, model, extra = {}) => ({
    suite, arm: name, unit, model, effort: suite === 'V' ? 'xhigh' : 'medium', cli: ['x 1'], batch: false, tasks: 10, keyItems: 7, n: 1,
    runs: [{ run: 1, correct: 5, inventedUrls: 0, recall: 0.5, precision: 0.5, failed: 0, wallMs: 1, tokens: 1 }],
    mean: { correct: 5, inventedUrls: 0, recall: 0.5, precision: 0.5, wallMs: 1, tokens: 1 }, overturned: 0, ...extra,
  });
  const decode = (svg) => [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
  const native = arm('V', 'native:omelette-reviewer', 'native', 'claude-opus-5-5');
  const v = renderCharts({ date: 'd', arms: [native] })['v-recall-precision.svg'];
  assert.ok(decode(v).includes('omelette-reviewer (claude-opus-5-5) · xhigh'), decode(v).join('\n'));
  const oss = arm('R', 'gemini:GPT-OSS 120B (Medium)', 'gemini', 'GPT-OSS 120B (Medium)');
  assert.ok(!renderCharts({ date: 'd', arms: [oss] })['effort.svg'].includes('GPT-OSS'));
  const a = arm('V', 'codex:old-a', 'codex', 'gpt-6.1-sol', { carriedFrom: '2026-10-16' });
  const b = arm('V', 'grok:old-b', 'grok', 'grok-4', { carriedFrom: '2026-10-16' });
  const lines = decode(renderCharts({ date: 'd', arms: [a, b] })['v-recall-precision.svg']).filter((t) => t.startsWith('carried from'));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(/GPT-6\.1 Sol/.test(lines[0]) && /grok-4/.test(lines[0]), lines[0]);
});

test('a link that only reaches out when the kernel follows it (a `..` after a link) is refused like any link out of the tree', () => {
  // `a/b/s` points up to `a`; `t` is `a/b/s/../..`. Read as text that is the root; followed by the kernel it is the root's parent.
  return withTmpdir(async () => {
    const dir = tmp('omelette-evals-tb-mt-');
    writeTree(dir, 'third-party/t', { 'lib/widget.js': 'export const items = [];\n' });
    mkdirSync(join(dir, 'third-party', 't', 'a', 'b'), { recursive: true });
    symlinkSync('..', join(dir, 'third-party', 't', 'a', 'b', 's'));
    symlinkSync('a/b/s/../..', join(dir, 'third-party', 't', 'reach'));
    let copy = null;
    try { copy = materializeTree({ dir, rel: 'third-party/t', id: 'T9', under: 'third-party' }); } catch (e) { assert.match(e.message, /points out of it/); return; }
    // Accepted: then the link must not lead out of the copy.
    const listed = readdirSync(join(copy, 'reach'));
    assert.ok(!listed.includes('T9'), `the copy's link "reach" lists its parent directory (${listed.join(', ')})`);
  });
});
