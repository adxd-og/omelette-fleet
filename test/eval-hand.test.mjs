// scripts/eval-hand.mjs — a native arm's answers filed as run lines (plan
// docs/superpowers/plans/2026-11-19-evals-neon.md, T18). Every task, answer and diff is invented; no unit runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from '../scripts/eval-blind.mjs';
import { proofInputs } from '../scripts/eval-patch.mjs';
import { briefFor, P_SUFFIX } from '../scripts/eval-run.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HAND = join(ROOT, 'scripts', 'eval-hand.mjs');
const BLIND = join(ROOT, 'scripts', 'eval-blind.mjs');

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** A private evals dir with the given suites' task files. */
function evalsDir(suites) {
  const dir = tmp('omelette-evals-hand-');
  for (const [suite, tasks] of Object.entries(suites)) {
    mkdirSync(join(dir, 'suites', suite), { recursive: true });
    writeFileSync(join(dir, 'suites', suite, 'tasks.jsonl'), jsonl(tasks));
  }
  return dir;
}

/** Invented files under `<D>/<rel>`. */
function writeTree(dir, rel, files) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel, name)), { recursive: true });
    writeFileSync(join(dir, rel, name), text);
  }
}

/** `eval-hand <args>` in a child with a bare environment and a 5 s bound. */
const hand = (args, env = {}) => spawnSync(process.execPath, [HAND, ...args], {
  encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, HOME: tmp('omelette-evals-hand-home-'), ...env },
});

const BRIEF = 'Invented review brief: read the change and report what you find.';
const DIFF = '--- a/lib/widget.js\n+++ b/lib/widget.js\n@@ -1 +1 @@\n-export const items = [];\n+export const items = [1];\n';
const V01 = { id: 'V01', commit: 'abc1234', file: 'src/thing.js', prompt: BRIEF };
const ARM = 'native:omelette-reviewer';
/** The hand-filed run line's fields (plan, Record shapes). */
const HAND_KEYS = ['suite', 'taskIds', 'arm', 'unit', 'model', 'effort', 'run', 'cli', 'startedAt', 'wallMs', 'ok', 'answer', 'error', 'empty', 'usage', 'resultId', 'agyConversations', 'hand'];

/** `file` for V01 with the given extra arguments, into `dir`. */
const fileV01 = (dir, extra) => hand(['file', '--suite', 'V', '--arm', ARM, '--task', 'V01', '--model', 'claude-opus-5-5', '--date', '2026-11-20', '--dir', dir, ...extra]);
const answerFile = (dir, name, text) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

test('file appends a run line the blinder and the aggregate treat like any other', () => {
  const dir = evalsDir({ V: [V01] });
  const said = ['An invented review one.', 'An invented review two.'].map((text, i) => {
    const r = fileV01(dir, ['--answer', answerFile(dir, `answer-${i}.md`, text), '--effort', 'xhigh', '--cli', 'claude-code 9.9.9', '--wall-ms', '300000', '--tokens', '5000']);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  });
  const file = join(dir, 'runs', '2026-11-20', 'V-native-omelette-reviewer.jsonl');
  assert.equal(said[1], `filed V ${ARM} V01 run 2 → ${file}\n`);
  const lines = readLines(file);
  for (const l of lines) assert.deepEqual(Object.keys(l).sort(), [...HAND_KEYS].sort());
  assert.deepEqual(lines.map(({ suite, taskIds, arm, unit, model, effort, run, cli, wallMs, ok, answer, error, empty, usage, resultId, agyConversations, hand: h }) => ({ suite, taskIds, arm, unit, model, effort, run, cli, wallMs, ok, answer, error, empty, usage, resultId, agyConversations, hand: h })), [1, 2].map((run) => ({
    suite: 'V', taskIds: ['V01'], arm: ARM, unit: 'native', model: 'claude-opus-5-5', effort: 'xhigh', run, cli: 'claude-code 9.9.9', wallMs: 300000,
    ok: true, answer: `An invented review ${run === 1 ? 'one' : 'two'}.`, error: null, empty: false, usage: { total: 5000 }, resultId: null, agyConversations: null, hand: true,
  })));
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const b = spawnSync(process.execPath, [BLIND, '--date', '2026-11-20', '--dir', dir, '--seed', '1'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(b.status, 0, b.stderr);
  const g = join(dir, 'grading', '2026-11-20');
  const mapping = JSON.parse(readFileSync(join(g, 'mapping.json'), 'utf8'));
  const blinded = readLines(join(g, 'blinded.jsonl'));
  assert.equal(blinded.length, 2);
  assert.deepEqual(blinded.map((x) => [mapping.blinds[x.blindId].arm, mapping.blinds[x.blindId].run]).sort(), [[ARM, 1], [ARM, 2]]);
  const grades = blinded.map((x) => ({ blindId: x.blindId, taskId: 'V01', item: 'key', keyId: 'K1', grade: 'found' }));
  const [arm] = aggregate({ grades, mapping, keys: { R: [], V: [{ id: 'K1', task: 'V01' }] } }).arms;
  assert.equal(arm.arm, ARM);
  assert.equal(arm.n, 2);
  assert.deepEqual(arm.runs.map((r) => [r.tokens, r.tokensReported]), [[5000, '1 of 1'], [5000, '1 of 1']]);
});

// Suite P: a proven task, laid out where eval-patch wants its files.
const P_GOLD = 'diff --git a/widget/widget.go b/widget/widget.go\n--- a/widget/widget.go\n+++ b/widget/widget.go\n@@ -1,2 +1,3 @@\n package widget\n+// invented: the maintainers\' fix\n func Last() {}\n';
const P_TESTS = 'diff --git a/widget/widget_test.go b/widget/widget_test.go\n--- a/widget/widget_test.go\n+++ b/widget/widget_test.go\n@@ -1 +1,2 @@\n package widget\n+// invented test\n';
const P01 = {
  id: 'P01', prompt: 'Invented bug report: the widget drops its last item.', tree: 'third-party/p01/before-fix', image: `golang@sha256:${'0'.repeat(64)}`, build: null,
  gold: 'suites/P/P01/gold.diff', tests: 'suites/P/P01/tests.diff', failToPass: 'go test ./widget', passToPass: 'go test ./widget', timeoutS: 5,
};
function pDir({ proven }) {
  const dir = evalsDir({ P: [P01] });
  writeTree(dir, P01.tree, { 'widget/widget.go': 'package widget\nfunc Last() {}\n', 'widget/widget_test.go': 'package widget\n' });
  writeTree(dir, 'suites/P/P01', { 'gold.diff': P_GOLD, 'tests.diff': P_TESTS });
  if (proven) writeTree(dir, 'checks/proofs', { 'P01.json': JSON.stringify({ task: 'P01', inputs: proofInputs({ dir, task: P01 }), ok: true, reps: [{ ok: true }] }) });
  return dir;
}

test('brief writes the cwd brief to a private file and prints paths, never the text', () => {
  const x01 = { id: 'X01', kind: 'recall', show: 'diff', tree: 'third-party/x01/at-intro', diff: 'suites/V/X01.diff', prompt: BRIEF };
  const dir = evalsDir({ V: [x01] });
  writeTree(dir, x01.tree, { 'lib/widget.js': 'export const items = [1];\n' });
  writeFileSync(join(dir, x01.diff), DIFF);
  const fresh = tmp('omelette-evals-hand-tmpdir-');
  const r = hand(['brief', '--suite', 'V', '--task', 'X01', '--dir', dir], { TMPDIR: fresh });
  assert.equal(r.status, 0, r.stderr);
  const snapshot = join(fresh, 'omelette-evals', 'snapshots', 'X01');
  const brief = join(dir, 'hand', 'V-X01.brief.md');
  assert.equal(r.stdout, `snapshot ${snapshot}\nbrief ${brief}\n`);
  assert.equal(readFileSync(join(snapshot, 'lib', 'widget.js'), 'utf8'), 'export const items = [1];\n');
  assert.equal(readFileSync(brief, 'utf8'), briefFor('V', { ...x01, diffText: DIFF }));
  assert.equal(statSync(brief).mode & 0o777, 0o600);
  assert.ok(!r.stdout.includes(BRIEF) && !r.stdout.includes('items = [1]'), 'no brief text on stdout');

  // P: the bug report and the diff instruction, to --out; refused without a fresh gold proof, as eval-run refuses it.
  const out = join(tmp('omelette-evals-hand-out-'), 'p01.md');
  const unproven = pDir({ proven: false });
  const refused = hand(['brief', '--suite', 'P', '--task', 'P01', '--dir', unproven, '--out', out], { TMPDIR: fresh });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /P01 has no fresh gold proof \(missing\)/);
  assert.equal(existsSync(out), false);
  const p = hand(['brief', '--suite', 'P', '--task', 'P01', '--dir', pDir({ proven: true }), '--out', out], { TMPDIR: fresh });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout, `snapshot ${join(fresh, 'omelette-evals', 'snapshots', 'P01')}\nbrief ${out}\n`);
  const text = readFileSync(out, 'utf8');
  assert.ok(text.endsWith(P_SUFFIX), text);
  assert.equal(text, briefFor('P', P01));
});

test('file --suite P meets the gold-proof gate brief meets: no proof, the gate\'s message and nothing filed; a proof, it files', () => {
  const args = (dir) => ['file', '--suite', 'P', '--arm', 'native:session', '--task', 'P01', '--answer', answerFile(dir, 'a.diff', 'An invented diff.'), '--model', 'm', '--wall-ms', '1', '--date', '2026-11-20', '--dir', dir];
  const unproven = pDir({ proven: false });
  const refused = hand(args(unproven));
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.stderr, 'eval-hand: P01 has no fresh gold proof (missing): run node scripts/eval-patch.mjs prove --task P01 first\n');
  assert.equal(existsSync(join(unproven, 'runs')), false, 'nothing filed');
  const proven = pDir({ proven: true });
  const filed = hand(args(proven));
  assert.equal(filed.status, 0, filed.stderr);
  assert.deepEqual(readLines(join(proven, 'runs', '2026-11-20', 'P-native-session.jsonl')).map((l) => [l.suite, l.taskIds, l.answer]), [['P', ['P01'], 'An invented diff.']]);
});

test('a failed hand call is filed failed, and an empty answer empty', () => {
  const dir = evalsDir({ V: [V01] });
  const before = Date.now();
  const failed = fileV01(dir, ['--failed', 'invented failure', '--wall-ms', '60000']);
  const after = Date.now();
  assert.equal(failed.status, 0, failed.stderr);
  const blank = fileV01(dir, ['--answer', answerFile(dir, 'blank.md', ' \n\t\n'), '--wall-ms', '1000', '--started-at', '2026-11-20T11:00:00.000Z']);
  assert.equal(blank.status, 0, blank.stderr);
  const [f, e] = readLines(join(dir, 'runs', '2026-11-20', 'V-native-omelette-reviewer.jsonl'));
  assert.deepEqual([f.ok, f.answer, f.error, f.empty, f.usage, f.cli, f.effort], [false, null, 'invented failure', false, null, 'unknown', null]);
  // With no --started-at, the call started its wall time before it was filed.
  const started = Date.parse(f.startedAt);
  assert.ok(started >= before - 60000 && started <= after - 60000, f.startedAt);
  assert.deepEqual([e.ok, e.empty, e.run, e.startedAt], [true, true, 2, '2026-11-20T11:00:00.000Z']);
});

test('usage errors exit 2 and file nothing; an unknown task exits 1', () => {
  const dir = evalsDir({ V: [V01] });
  const answer = answerFile(dir, 'answer.md', 'An invented review.');
  const big = answerFile(dir, 'big.md', 'x'.repeat(1024 * 1024 + 1));
  const ok = ['--answer', answer, '--wall-ms', '1000'];
  const refused = [
    ['--arm', 'native:Omelette-Reviewer'], ['--arm', 'codex:gpt-6.1-sol'], ['--arm', 'native:'], ['--arm', 'native:-x'],
    // A role begins and ends with a letter or digit, its groups joined by single hyphens: `native:a-` and `native:a` share a run file.
    ['--arm', 'native:a-'], ['--arm', 'native:a--b'],
    ['--failed', 'invented failure'], ['--answer', undefined],
    ['--model', ''], ['--wall-ms', '-1'], ['--wall-ms', '1.5'], ['--wall-ms', '1e3'], ['--wall-ms', '604800001'],
    ['--tokens', 'x'], ['--tokens', '-5'], ['--run', '0'],
    ['--answer', big],
  ];
  for (const [flag, value] of refused) {
    let args = [...ok];
    if (flag === '--failed') args.push(flag, value); // both
    else if (value === undefined) args = ['--wall-ms', '1000']; // neither
    else if (args.includes(flag)) args[args.indexOf(flag) + 1] = value;
    else args.push(flag, value);
    const armAt = args.indexOf('--arm');
    const r = armAt < 0
      ? fileV01(dir, args)
      : hand(['file', '--suite', 'V', '--task', 'V01', '--model', 'claude-opus-5-5', '--date', '2026-11-20', '--dir', dir, ...args]);
    assert.equal(r.status, 2, `${flag} ${value}: ${r.stderr}`);
  }
  const noModel = hand(['file', '--suite', 'V', '--arm', ARM, '--task', 'V01', '--date', '2026-11-20', '--dir', dir, ...ok]);
  assert.equal(noModel.status, 2, noModel.stderr);
  assert.equal(existsSync(join(dir, 'runs')), false, 'nothing filed');
  const unknown = hand(['file', '--suite', 'V', '--arm', ARM, '--task', 'V09', '--model', 'm', '--date', '2026-11-20', '--dir', dir, ...ok]);
  assert.equal(unknown.status, 1, unknown.stderr);
  assert.match(unknown.stderr, /no task V09/);
  assert.equal(existsSync(join(dir, 'runs')), false, 'nothing filed');
  // The bounds that are fine: seven days of wall time, a role of hyphen-joined groups.
  const week = hand(['file', '--suite', 'V', '--arm', 'native:a1-b2', '--task', 'V01', '--model', 'm', '--date', '2026-11-20', '--dir', dir, '--answer', answer, '--wall-ms', '604800000']);
  assert.equal(week.status, 0, week.stderr);
  const [line] = readLines(join(dir, 'runs', '2026-11-20', 'V-native-a1-b2.jsonl'));
  assert.deepEqual([line.arm, line.wallMs], ['native:a1-b2', 604800000]);
});
