// The tester's rows for T19 (scripts/eval-patch.mjs: `extractDiff` and `check`), beside test/eval-patch.test.mjs.
// Specs: docs/superpowers/specs/2026-11-19-evals-neon-design.md (Part three, the safety rules) and the plan's T19.
// A test titled «ruled after the build» pins an orchestrator's ruling the build did not have: it fails until the fix round.
// Docker is the fake (test/fixtures/fake-docker.mjs), or a wrapper around it that only changes an exit code or hangs; the
// tripwire named `docker` stands first on PATH. Every tree, diff, answer and log below is invented.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, extractDiff, main, prove } from '../scripts/eval-patch.mjs';
import { fakeDocker } from './fixtures/fake-docker.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'eval-patch.mjs');

const made = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const quiet = () => {};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const TRIPWIRE = tmp('omelette-evals-tripwire-');
writeFileSync(join(TRIPWIRE, 'docker'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(join(TRIPWIRE, 'reached'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(99);\n`);
chmodSync(join(TRIPWIRE, 'docker'), 0o755);

const IMAGE = `toolchain@sha256:${'1'.repeat(64)}`;
const idOf = (ref) => `sha256:${sha256(ref)}`;
const GOLD_ONLY = 'INVENTED-GOLD-ONLY';

const P01 = {
  id: 'P01', prompt: 'Invented bug report: the widget drops its last item.', tree: 'third-party/p01/before-fix', image: IMAGE, build: null,
  gold: 'suites/P/P01/gold.diff', tests: 'suites/P/P01/tests.diff',
  failToPass: "run-tests widget --only LastItem", passToPass: 'run-tests widget', timeoutS: 5,
};
const WIDGET = 'package widget\n\nfunc Last(items []string) string { return "" }\n';
const OTHER = 'package widget\n\nfunc Other() {}\n';
const goldWith = (marker) => [
  'diff --git a/widget/widget.go b/widget/widget.go', '--- a/widget/widget.go', '+++ b/widget/widget.go', '@@ -1,3 +1,4 @@',
  ' package widget', ' ', `+// ${marker}`, ' func Last(items []string) string { return "" }', '',
].join('\n');
const TESTS = [
  'diff --git a/widget/widget_test.go b/widget/widget_test.go', '--- a/widget/widget_test.go', '+++ b/widget/widget_test.go', '@@ -1,3 +1,5 @@',
  ' package widget', ' ', ' import "testing"', '+', '+func TestInventedLastItem(t *testing.T) {}', '',
].join('\n');

function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function setup({ task = {}, gold = goldWith(`FAKE: fixes ${GOLD_ONLY}`) } = {}) {
  const dir = tmp('omelette-evals-g-dir-');
  const line = { ...P01, ...task };
  put(dir, `${P01.tree}/widget/widget.go`, WIDGET);
  put(dir, `${P01.tree}/widget/widget_test.go`, 'package widget\n\nimport "testing"\n');
  put(dir, `${P01.tree}/widget/other.go`, OTHER);
  put(dir, P01.gold, gold);
  put(dir, P01.tests, TESTS);
  put(dir, 'suites/P/tasks.jsonl', `${JSON.stringify(line)}\n`);
  const home = tmp('omelette-evals-g-home-');
  const fake = fakeDocker(home);
  return { dir, task: line, home, fake, env: { PATH: `${TRIPWIRE}:${process.env.PATH}`, HOME: home, OMELETTE_EVALS_DOCKER: fake.bin } };
}

const DATE = '2026-11-20';
const ARM = 'gemini:Invented Model (High)';
const answerWith = (diff) => `An invented explanation.\n\n\`\`\`diff\n${diff}\`\`\`\n\nAn invented closing remark.\n`;
const pRunLine = (over = {}) => ({
  suite: 'P', taskIds: ['P01'], arm: ARM, unit: 'gemini', model: 'Invented Model (High)', effort: 'high', run: 1, cli: 'agy 0.0.0',
  startedAt: '2026-11-20T09:00:00.000Z', wallMs: 1000, ok: true, answer: 'An invented answer.', error: null, empty: false,
  usage: { input: 1, output: 1 }, resultId: null, agyConversations: [], ...over,
});
const fileRuns = (dir, lines, name = 'P-gemini-invented-model-high.jsonl') => put(dir, `runs/${DATE}/${name}`, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
const checksFile = (dir) => join(dir, 'checks', DATE, 'P.jsonl');
const checksAt = (dir) => (existsSync(checksFile(dir)) ? readFileSync(checksFile(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** P01 proven once, and `lines` filed as the date's run lines; `docker` is the fake unless `docker` says another. */
async function proven(lines, opts = {}) {
  const ctx = setup(opts);
  ctx.fake.addImage(IMAGE);
  await prove({ dir: ctx.dir, task: ctx.task, docker: ctx.fake.bin, env: ctx.env, reps: 1, out: quiet });
  fileRuns(ctx.dir, lines);
  const printed = [];
  const run = (args = [], docker = ctx.fake.bin) => main(['check', '--date', DATE, '--dir', ctx.dir, ...args], {
    out: (l) => printed.push(l), err: (l) => printed.push(l), env: { ...ctx.env, OMELETTE_EVALS_DOCKER: docker },
  });
  return { ...ctx, printed, run, log0: ctx.fake.log().length, stages0: ctx.fake.stages().length };
}

/** A docker that hands every call to the fake, then, for a `run` whose staged diff holds `WRAP: <step> <code|hang>`, exits that code or never ends. */
function wrappedDocker({ home, fake }) {
  const bin = join(home, 'docker-wrapped');
  writeFileSync(bin, String.raw`#!${process.execPath}
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const r = require('child_process').spawnSync(${JSON.stringify(fake.bin)}, argv, { stdio: 'inherit', timeout: 4000 });
let want = null;
if (argv[0] === 'run' && !fs.existsSync(${JSON.stringify(join(home, 'wrap-off'))})) {
  const stage = (/source=([^,]+)/.exec(argv[argv.indexOf('--mount') + 1] || '') || [])[1];
  const step = argv[argv.length - 1];
  let change = '';
  try { change = fs.readFileSync(path.join(stage, 'change.diff'), 'utf8'); } catch { /* no change */ }
  const m = new RegExp('WRAP: ' + step + ' (\\w+)').exec(change);
  want = m ? m[1] : null;
}
if (want === 'hang') { setTimeout(() => process.exit(124), 4000); } else { process.exit(want !== null ? Number(want) : r.status); }
`);
  chmodSync(bin, 0o755);
  return bin;
}

const FILE_A = ['diff --git a/widget/widget.go b/widget/widget.go', '--- a/widget/widget.go', '+++ b/widget/widget.go', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
const FILE_B = ['--- a/widget/other.go', '+++ b/widget/other.go', '@@ -3 +3 @@', '-before', '+after', ''].join('\n');
const indented = (text, by) => text.split('\n').map((l) => (l ? `${' '.repeat(by)}${l}` : l)).join('\n');

// —— extractDiff ——

test('extractDiff, ruled after the build (9): a fence opened n spaces in is closed by a fence up to n spaces in, and its body loses up to n spaces', () => {
  const asList = `1. Apply this:\n\n   \`\`\`diff\n${indented(FILE_A, 3)}   \`\`\`\n\n2. Run the tests.\n`;
  assert.equal(extractDiff(asList), FILE_A, 'a numbered list item: three spaces in, three spaces out');
  assert.equal(extractDiff(`  \`\`\`diff\n${indented(FILE_A, 2)}  \`\`\`\nInvented prose.\n`), FILE_A, 'two in, two out');
  assert.equal(extractDiff(`  ~~~\n${indented(FILE_A, 2)}~~~\n`), FILE_A, 'a closing fence indented less than the opening one closes it');
  // A body line indented past the opening fence keeps what it has beyond it: this one is no `+++ ` line, so no diff.
  assert.equal(extractDiff(` \`\`\`diff\n${indented(FILE_A, 3)} \`\`\`\n`), null, 'only n spaces are lost');
  // A fence indented MORE than the opening one is a body line (here, the context line of a Markdown diff), not its end.
  const overMarkdown = ['--- a/docs/notes.md', '+++ b/docs/notes.md', '@@ -1,3 +1,3 @@', ' ```', '-old', '+new', ' ```', ''].join('\n');
  assert.equal(extractDiff(`  \`\`\`diff\n${indented(overMarkdown, 2)}  \`\`\`\n`), overMarkdown, 'three spaces in, opened by two: not a close');
});

test('extractDiff (9, the other half): a fence opened at column 0 is closed by a fence at column 0 only', () => {
  const overMarkdown = ['--- a/docs/notes.md', '+++ b/docs/notes.md', '@@ -1,4 +1,4 @@', ' ```', '   ```', '-old', '+new', ' ```', ''].join('\n');
  assert.equal(extractDiff(`\`\`\`diff\n${overMarkdown}\`\`\`\nInvented prose.\n`), overMarkdown);
  // The same text with the real closing fence missing: the answer ends the block, and nothing indented ended it earlier.
  assert.equal(extractDiff(`\`\`\`diff\n${overMarkdown}`), overMarkdown);
});

test('extractDiff, ruled after the build (10): an opening fence line holds an info string and no further run of its character', () => {
  const inline = `\`\`\`inline\`\`\` prose\nAn invented line.\n\`\`\`diff\n${FILE_A}\`\`\`\n`;
  assert.equal(extractDiff(inline), FILE_A, 'the first line opens nothing; the diff fence is the only block');
  assert.equal(extractDiff(`\`\`\`diff title="fix.patch" {1,3}\n${FILE_A}\`\`\`\n`), FILE_A, 'attributes in an info string still open');
});

test('extractDiff, ruled after the build (11): an unfenced diff ends before the first line no diff line can be', () => {
  const prose = 'That is the whole invented fix:\n- it renames nothing\n';
  assert.equal(extractDiff(`Invented lead-in.\n${FILE_A}\n${prose}`), FILE_A, 'a blank line, then prose');
  assert.equal(extractDiff(`${FILE_A}Done, and it is invented.\n`), FILE_A, 'prose with no blank before it');
  assert.equal(extractDiff(`${FILE_A}\n\n\n${prose}`), FILE_A, 'several blank lines, then prose: none belongs');
  assert.equal(extractDiff(`${FILE_A}\`\`\`\n${prose}`), FILE_A, 'a stray closing fence is no diff line');
  // A blank line belongs where a diff line follows it.
  const across = extractDiff(`${FILE_A}\n${FILE_B}\nA last invented word.\n`);
  assert.ok(across.startsWith(FILE_A) && across.endsWith(FILE_B), JSON.stringify(across));
  // Every line a diff holds stays: index, mode, rename, copy, binary and no-newline lines among them.
  const whole = [
    'diff --git a/widget/widget.go b/widget/widget.go', 'index 1111111..2222222 100644', '--- a/widget/widget.go', '+++ b/widget/widget.go', '@@ -1 +1 @@', '-old', '+new',
    '\\ No newline at end of file',
    'diff --git a/widget/fresh.go b/widget/fresh.go', 'new file mode 100644', '--- /dev/null', '+++ b/widget/fresh.go', '@@ -0,0 +1 @@', '+package widget',
    'diff --git a/widget/gone.go b/widget/gone.go', 'deleted file mode 100644', '--- a/widget/gone.go', '+++ /dev/null', '@@ -1 +0,0 @@', '-package widget',
    'diff --git a/tools/run.sh b/tools/run.sh', 'old mode 100644', 'new mode 100755',
    'diff --git a/widget/old.go b/widget/new.go', 'similarity index 100%', 'rename from widget/old.go', 'rename to widget/new.go',
    'diff --git a/widget/dup.go b/widget/copy.go', 'copy from widget/dup.go', 'copy to widget/copy.go',
    'diff --git a/assets/logo.bin b/assets/logo.bin', 'Binary files a/assets/logo.bin and b/assets/logo.bin differ', '',
  ].join('\n');
  assert.equal(extractDiff(`Invented lead-in.\n${whole}\n${prose}`), whole);
});

test('extractDiff, ruled after the build (12): fenced blocks are joined without the blank lines a block ends with', () => {
  const answer = `One file:\n\n\`\`\`diff\n${FILE_A}\n\n\`\`\`\n\nAnd the other:\n\n\`\`\`diff\n${FILE_B}\n\`\`\`\n`;
  assert.equal(extractDiff(answer), `${FILE_A}${FILE_B}`);
  assert.equal(extractDiff(`\`\`\`diff\n${FILE_A}\n\n\n\`\`\`\n`), FILE_A, 'a single block ends with one line break');
});

test('extractDiff takes only a string, and takes linear time over a megabyte of fence characters', () => {
  for (const text of [undefined, 42, {}, [], '', ' ']) assert.equal(extractDiff(text), null, String(text));
  const started = Date.now();
  for (const text of ['`'.repeat(1e6), '```\n'.repeat(250000), '~~~\n```\n'.repeat(125000), `${'`'.repeat(1e6)}\n${FILE_A}`, '\n'.repeat(1e6)]) extractDiff(text);
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  // A 1M-character fence that never closes holds the diff behind it: the end of the answer ends the block.
  assert.equal(extractDiff(`${'`'.repeat(1e6)}\n${FILE_A}`), FILE_A);
});

// —— check ——

test('check: a harness exit code from a test step is `error`, re-checked next time, never `red`; ruled after the build (13)', async () => {
  const marked = (step, code, i) => answerWith(goldWith(`FAKE: fixes WRAP: ${step} ${code} ${i}`));
  const rows = [['f2p', 120], ['f2p', 121], ['f2p', 122], ['f2p', 123], ['f2p', 125], ['p2p', 120], ['p2p', 121], ['p2p', 122], ['p2p', 123]];
  const ctx = await proven([
    ...rows.map(([step, code], i) => pRunLine({ run: i + 1, answer: marked(step, code, i) })),
    pRunLine({ run: 10, answer: marked('f2p', 1, 10) }),
    pRunLine({ run: 11, answer: marked('p2p', 1, 11) }),
  ]);
  const docker = wrappedDocker(ctx);
  assert.equal(await ctx.run([], docker), 0, ctx.printed.join('\n'));
  const outcomes = checksAt(ctx.dir).map((l) => [l.run, l.outcome]);
  assert.deepEqual(outcomes, [...rows.map((_, i) => [i + 1, 'error']), [10, 'red'], [11, 'red']]);
  const lines = checksAt(ctx.dir);
  for (const [i, [step, code]] of rows.entries()) assert.match(lines[i].error, new RegExp(`${step}.*${code}`), `run ${i + 1}`);
  assert.deepEqual(lines[9].failToPass.exit, 1);
  assert.equal(readFileSync(join(ctx.dir, 'checks', DATE, 'P.jsonl'), 'utf8').includes(GOLD_ONLY), false);

  // Next time, with the harness well again: the errors are checked again, the reds are not.
  writeFileSync(join(ctx.home, 'wrap-off'), '');
  const before = ctx.fake.runs().length;
  ctx.printed.length = 0;
  assert.equal(await ctx.run([], docker), 0, ctx.printed.join('\n'));
  assert.equal(ctx.printed.length, rows.length + 1, ctx.printed.join('\n'));
  assert.equal(ctx.fake.runs().slice(before).filter((a) => a[a.length - 1] === 'apply').length, rows.length, 'each errored key is checked again, the two reds are not');
  assert.deepEqual(checksAt(ctx.dir).slice(rows.length + 2).map((l) => [l.run, l.outcome]), rows.map((_, i) => [i + 1, 'green']));
});

test('check: from the apply step 121 is does-not-apply and every other harness exit is `error`', async () => {
  const marked = (code) => answerWith(goldWith(`FAKE: fixes WRAP: apply ${code}`));
  const ctx = await proven([120, 121, 122, 123, 125].map((code, i) => pRunLine({ run: i + 1, answer: marked(code) })));
  assert.equal(await ctx.run([], wrappedDocker(ctx)), 0, ctx.printed.join('\n'));
  assert.deepEqual(checksAt(ctx.dir).map((l) => [l.run, l.outcome]), [[1, 'error'], [2, 'does-not-apply'], [3, 'error'], [4, 'error'], [5, 'error']]);
  assert.deepEqual(checksAt(ctx.dir).map((l) => [l.failToPass, l.passToPass]), Array(5).fill([null, null]));
  assert.equal(ctx.fake.runs().length - 6, 5, 'one apply step each, and no test step after a failed apply');
});

test('check: a timed-out apply step is `error`, not does-not-apply and not red; the stage held no gold; the key is checked again', async () => {
  const ctx = await proven([pRunLine({ answer: answerWith(goldWith('FAKE: fixes WRAP: apply hang')) })], { task: { timeoutS: 1 } });
  const docker = wrappedDocker(ctx);
  assert.equal(await ctx.run([], docker), 0, ctx.printed.join('\n'));
  const [line] = checksAt(ctx.dir);
  assert.deepEqual([line.outcome, line.method, line.failToPass, line.passToPass, line.diffFound, line.linesChanged], ['error', null, null, null, true, 1]);
  assert.match(line.error, /apply step did not end within 1 s/);
  assert.deepEqual(ctx.fake.stages().slice(ctx.stages0).map((s) => s.step), ['apply']);
  assert.deepEqual(ctx.fake.stages().slice(ctx.stages0).filter((s) => Object.values(s.contents).some((text) => text.includes(GOLD_ONLY))), []);
  writeFileSync(join(ctx.home, 'wrap-off'), '');
  assert.equal(await ctx.run([], docker), 0);
  assert.deepEqual(checksAt(ctx.dir).map((l) => l.outcome), ['error', 'green']);
});

test('check: a diff applied by the patch fallback is checked all the same; CRLF in the answer reaches the stage as LF; a failed call is no diff however its answer reads', async () => {
  const fixing = goldWith('FAKE: fixes FAKE: needs-fuzz');
  const ctx = await proven([
    pRunLine({ run: 1, answer: answerWith(fixing).replaceAll('\n', '\r\n') }),
    pRunLine({ run: 2, ok: false, answer: answerWith(goldWith('FAKE: fixes')), error: 'An invented failure.' }),
    pRunLine({ run: 3, ok: true, answer: null }),
    pRunLine({ run: 4, ok: true, answer: 42 }),
  ]);
  assert.equal(await ctx.run(), 0, ctx.printed.join('\n'));
  assert.deepEqual(checksAt(ctx.dir).map((l) => [l.run, l.outcome, l.method, l.diffFound]), [[1, 'green', 'patch', true], [2, 'call-failed', null, false], [3, 'no-diff', null, false], [4, 'no-diff', null, false]]);
  const staged = ctx.fake.stages().slice(ctx.stages0).map((s) => s.contents['change.diff']);
  assert.deepEqual(staged, [fixing, fixing, fixing]);
  assert.equal(ctx.fake.runs().length - 6, 3, 'no container for the three that had no diff to check');
});

test('check: the paths of the maintainers\' tests diff are not outside the gold either: the restore discards a model\'s edits there; ruled after the build (14)', async () => {
  const touching = (...files) => files.map((f) => `--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`).join('');
  const withFix = (rest) => `${goldWith('FAKE: fixes')}${rest}`;
  const ctx = await proven([
    pRunLine({ run: 1, answer: answerWith(withFix(touching('widget/widget_test.go'))) }),
    pRunLine({ run: 2, answer: answerWith(withFix(touching('widget/widget_test.go', 'widget/other.go'))) }),
    pRunLine({ run: 3, answer: answerWith(withFix(touching('widget/other.go'))) }),
  ]);
  assert.equal(await ctx.run(), 0, ctx.printed.join('\n'));
  assert.deepEqual(checksAt(ctx.dir).map((l) => [l.run, l.outcome, l.paths, l.outsideGold]), [
    [1, 'green', ['widget/widget.go', 'widget/widget_test.go'], []],
    [2, 'green', ['widget/other.go', 'widget/widget.go', 'widget/widget_test.go'], ['widget/other.go']],
    [3, 'green', ['widget/other.go', 'widget/widget.go'], ['widget/other.go']],
  ]);
  assert.deepEqual(ctx.printed.slice(0, 3), [`  ${ARM}  run 1  P01  green`, `  ${ARM}  run 2  P01  green*`, `  ${ARM}  run 3  P01  green*`]);
});

test('check: the last line of a key wins, a key is (arm, run, task), and only the keys whose last line is `error` run again', async () => {
  const other = 'native:session';
  const ctx = await proven([]);
  const fixing = answerWith(goldWith('FAKE: fixes'));
  fileRuns(ctx.dir, [
    pRunLine({ run: 1, answer: fixing }), pRunLine({ run: 2, answer: fixing }), pRunLine({ run: 3, answer: fixing }),
    pRunLine({ arm: other, run: 1, hand: true, answer: fixing }),
  ]);
  const seeded = (arm, run, outcome) => ({ suite: 'P', taskId: 'P01', arm, run, outcome, error: outcome === 'error' ? 'an invented failure' : null });
  put(ctx.dir, `checks/${DATE}/P.jsonl`, [
    seeded(ARM, 1, 'green'), seeded(ARM, 1, 'error'), // last is error: runs again
    seeded(ARM, 2, 'error'), seeded(ARM, 2, 'green'), // last is green: skipped
    seeded(other, 1, 'error'), // the hand-filed arm's key is its own: runs
  ].map((l) => `${JSON.stringify(l)}\n`).join(''));
  assert.equal(await ctx.run(), 0, ctx.printed.join('\n'));
  assert.deepEqual(ctx.printed.slice(-1), [`3 checked, 1 already checked → ${checksFile(ctx.dir)}`]);
  assert.deepEqual(checksAt(ctx.dir).slice(5).map((l) => [l.arm, l.run, l.hand, l.outcome]), [[ARM, 1, false, 'green'], [ARM, 3, false, 'green'], [other, 1, true, 'green']]);
});

test('check: a bad line in the check file is refused by its own number, with nothing of it quoted, before docker is called', async () => {
  const ctx = await proven([pRunLine({ answer: answerWith(goldWith('FAKE: fixes')) })]);
  put(ctx.dir, `checks/${DATE}/P.jsonl`, `\n${JSON.stringify({ suite: 'P', taskId: 'P01', arm: ARM, run: 9, outcome: 'green' })}\n\r\n{"outcome": SECRET-INVENTED-CHECK-LINE\n`);
  assert.equal(await ctx.run(), 1);
  assert.deepEqual(ctx.printed, [`eval-patch: ${checksFile(ctx.dir)}:4: not JSON`]);
  assert.equal(ctx.fake.log().length, ctx.log0);
});

test('check: a run line of a task the suite lacks, and a proof that is missing or failed, are refused before docker is called, naming the task', async () => {
  const ctx = await proven([pRunLine({ answer: answerWith(goldWith('FAKE: fixes')) })]);
  fileRuns(ctx.dir, [pRunLine({ taskIds: ['P02'], answer: answerWith(goldWith('FAKE: fixes')) })]);
  assert.equal(await ctx.run(), 1);
  assert.match(ctx.printed.join('\n'), /P02: suite P has no such task/);
  // The proof file gone.
  fileRuns(ctx.dir, [pRunLine({ answer: answerWith(goldWith('FAKE: fixes')) })]);
  rmSync(join(ctx.dir, 'checks', 'proofs', 'P01.json'));
  ctx.printed.length = 0;
  assert.equal(await ctx.run(), 1);
  assert.match(ctx.printed.join('\n'), /P01 has no fresh gold proof \(missing\)/);
  // A proof that did not hold: the gold no longer fixes anything.
  const bad = await proven([pRunLine({ answer: answerWith(goldWith('FAKE: fixes')) })], { gold: goldWith(`an invented comment ${GOLD_ONLY}`) });
  assert.equal(JSON.parse(readFileSync(join(bad.dir, 'checks', 'proofs', 'P01.json'), 'utf8')).ok, false);
  assert.equal(await bad.run(), 1);
  assert.match(bad.printed.join('\n'), /P01 has no fresh gold proof \(failed\)/);
  assert.equal(bad.fake.log().length, bad.log0);
  assert.equal(ctx.fake.log().length, ctx.log0);
  assert.equal(existsSync(checksFile(ctx.dir)) || existsSync(checksFile(bad.dir)), false, 'nothing filed');
});

test('check, through the CLI: stdout and stderr hold the outcome lines and no diff, answer, apply log or refused path', async () => {
  const secret = 'SECRET-INVENTED-ANSWER';
  const ctx = await proven([
    pRunLine({ run: 1, answer: `${secret}\n\`\`\`diff\n${goldWith('FAKE: does-not-apply SECRET-INVENTED-DIFF')}\`\`\`\n` }),
    pRunLine({ run: 2, answer: `${secret}\n--- a/x.go\n+++ b/../SECRET-INVENTED-PATH.go\n@@ -1 +1 @@\n-a\n+b\n` }),
    pRunLine({ run: 3, answer: `${secret}: prose only` }),
    pRunLine({ run: 4, ok: false, answer: null, error: 'SECRET-INVENTED-ERROR', empty: true }),
  ]);
  const res = spawnSync(process.execPath, [SCRIPT, 'check', '--date', DATE, '--dir', ctx.dir], { env: ctx.env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  assert.equal(res.stdout, [
    `  ${ARM}  run 1  P01  does-not-apply`, `  ${ARM}  run 2  P01  does-not-apply`, `  ${ARM}  run 3  P01  no-diff`, `  ${ARM}  run 4  P01  call-failed`,
    `4 checked, 0 already checked → ${checksFile(ctx.dir)}`, '',
  ].join('\n'));
  assert.ok(!/SECRET|patch failed|FAKE|widget/.test(`${res.stdout}${res.stderr}`));
  assert.equal(existsSync(join(TRIPWIRE, 'reached')), false, 'plain docker was never reached');
});

test('check, called as a function, returns what it filed and skipped, and refuses a date that is not one', async () => {
  const ctx = await proven([pRunLine({ answer: answerWith(goldWith('FAKE: fixes')) })]);
  const first = await check({ dir: ctx.dir, date: DATE, docker: ctx.fake.bin, env: ctx.env, out: quiet });
  assert.deepEqual([first.file, first.checked.length, first.skipped], [checksFile(ctx.dir), 1, 0]);
  const again = await check({ dir: ctx.dir, date: DATE, docker: ctx.fake.bin, env: ctx.env, out: quiet });
  assert.deepEqual([again.checked.length, again.skipped], [0, 1]);
  for (const date of [undefined, '2026-1-2', '../2026-11-20', '2026-11-20/..']) await assert.rejects(check({ dir: ctx.dir, date, docker: ctx.fake.bin, env: ctx.env }), TypeError, String(date));
  assert.equal(existsSync(join(TRIPWIRE, 'reached')), false);
  assert.equal(idOf(IMAGE), checksAt(ctx.dir)[0].imageId);
});
