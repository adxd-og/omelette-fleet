// The tester's rows for T19's mutation pass (scripts/eval-patch.mjs: `extractDiff` and `check`), beside
// test/eval-patch.test.mjs and the earlier testers' files: each test below kills a change to the code that
// none of them noticed, or pins a defect found on the way (named in its title).
// Docker is the fake (test/fixtures/fake-docker.mjs), or a wrapper around it that changes an exit code, writes a long
// stderr, kills its own client or deletes itself; a tripwire named `docker` stands first on PATH. Everything is invented.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { check, extractDiff, main, prove } from '../scripts/eval-patch.mjs';
import { fakeDocker } from './fixtures/fake-docker.mjs';

const made = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const quiet = () => {};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const TRIPWIRE = tmp('omelette-evals-htrip-');
writeFileSync(join(TRIPWIRE, 'docker'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(join(TRIPWIRE, 'reached'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(97);\n`);
chmodSync(join(TRIPWIRE, 'docker'), 0o755);

// —— extractDiff ——

const FILE = ['diff --git a/widget/widget.go b/widget/widget.go', '--- a/widget/widget.go', '+++ b/widget/widget.go', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
const indented = (text, by) => text.split('\n').map((l) => (l ? `${' '.repeat(by)}${l}` : l)).join('\n');
const HUNK_ONLY = '+++ b/widget/widget.go\n@@ -1 +1 @@\n-a\n+b\n';

test('extractDiff: what opens a fence — three or more characters, at most three spaces in; a tilde fence\'s info string holds anything', () => {
  // The prose after the diff is not in it only where no fence took it in.
  assert.equal(extractDiff(`    \`\`\`diff\n${FILE}A closing remark.\n`), FILE, 'four spaces in is no fence: the unfenced reading stops before the remark');
  assert.equal(extractDiff(`\`\`\n${FILE}A closing remark.\n`), FILE, 'two backticks are no fence');
  assert.equal(extractDiff(`~~\n${FILE}A closing remark.\n`), FILE, 'two tildes are no fence');
  assert.equal(extractDiff(`  ~~~ a~b\n${indented(FILE, 2)}  ~~~\n`), FILE, 'a tilde in a tilde fence\'s info string');
  assert.equal(extractDiff(`  ~~~ x\`y\n${indented(FILE, 2)}  ~~~\n`), FILE, 'a backtick in a tilde fence\'s info string');
});

test('extractDiff: a fence the answer never closes is closed by its end, and loses its indent all the same', () => {
  assert.equal(extractDiff(`\`\`\`diff\n${HUNK_ONLY}`), HUNK_ONLY, 'a block with no file header and no closing fence');
  assert.equal(extractDiff(`  \`\`\`diff\n${indented(FILE, 2)}`), FILE);
});

test('extractDiff: a fenced body loses its common indent, at most the fence\'s own, ignoring empty and whitespace-only lines, spaces only', () => {
  const withBlank = ['diff --git a/widget/widget.go b/widget/widget.go', '--- a/widget/widget.go', '+++ b/widget/widget.go', '@@ -1,3 +1,3 @@', ' a', '', '-old', '+new', ' d', ''].join('\n');
  assert.equal(extractDiff(`  \`\`\`diff\n${indented(withBlank, 2)}  \`\`\`\n`), withBlank, 'an empty line does not set the indent');
  // A one-space line under a fence three in: it does not set the indent either, and it becomes empty.
  const shortLine = withBlank.replace('\n\n', '\n \n');
  assert.equal(extractDiff(`   \`\`\`diff\n${indented(shortLine, 3).replace('   \n', ' \n')}   \`\`\`\n`), withBlank, 'a whitespace-only line does not set the indent');
  // Body lines deeper than the fence lose the fence's indent and no more: ` +++ b` is no `+++ ` line.
  assert.equal(extractDiff(`  \`\`\`diff\n${indented(FILE, 3)}  \`\`\`\n`), null, 'two lost of three');
  // A tab is no indent: a line of a tab alone keeps it.
  const tabbed = ['--- a/widget/widget.go', '+++ b/widget/widget.go', '@@ -1,3 +1,3 @@', ' a', '\t', '-old', '+new', ' d', ''];
  const body = tabbed.map((l) => (l === '\t' || l === '' ? l : `  ${l}`)).join('\n');
  assert.equal(extractDiff(`  \`\`\`diff\n${body}  \`\`\`\n`), tabbed.join('\n'), 'the tab stays');
});

test('extractDiff: a block is a diff when it holds a line opening with `+++ ` and a line that is a hunk header', () => {
  assert.equal(extractDiff('```\n@@ -1 +1 @@\n-a\n+++b\n```\n'), null, '`+++` with no blank after it');
  assert.equal(extractDiff('```\nnote +++ here\n@@ -1 +1 @@\n-a\n+b\n```\n'), null, '`+++ ` not at the start of a line');
  assert.equal(extractDiff('```\n+++ b/widget/widget.go\nsee @@ -1 +1 @@ here\n```\n'), null, 'a hunk header not at the start of a line');
});

test('extractDiff: the unfenced diff starts at its first `diff --git ` line or its first `--- `/`+++ ` pair, and holds what lies between a header and its hunk', () => {
  assert.equal(extractDiff(`Notes\n--- not a header\nSome prose.\n${FILE}`), FILE, 'a `--- ` line with no `+++ ` after it');
  assert.equal(extractDiff(`+++ x\n--- y\nSome prose.\n${FILE}`), FILE, 'a `+++ ` line before a `--- ` one');
  assert.equal(extractDiff(`diff --github is a tool\nSome prose.\n${FILE}`), FILE, '`diff --git` with no blank after it');
  assert.equal(extractDiff(`--- note\n+ item\nSome prose.\n${FILE}`), FILE, 'a `--- ` line then a line of `+`');
  assert.equal(extractDiff(`--- a\nfiller\n+++ b\nSome prose.\n${FILE}`), FILE, 'a `--- ` line and a `+++ ` line apart');
  // Before a hunk has begun nothing ends the diff.
  const gap = '--- a/widget/widget.go\n+++ b/widget/widget.go\nA note between the header and the hunk.\n@@ -1 +1 @@\n-a\n+b\n';
  assert.equal(extractDiff(gap), gap);
  const nonsense = '--- a/widget/widget.go\n+++ b/widget/widget.go\n@@ nonsense\nA note.\n@@ -1 +1 @@\n-a\n+b\n';
  assert.equal(extractDiff(nonsense), nonsense, 'an `@@` line that is no hunk header begins no hunk');
  // A hunk header with no `+++ ` line is no diff (the reverse of the case the build's tests hold).
  assert.equal(extractDiff('diff --git a/widget/widget.go b/widget/widget.go\nindex 1111111..2222222 100644\n@@ -1 +1 @@\n-a\n+b\n'), null);
});

test('extractDiff: an unfenced diff keeps the `index` line of a later file and a last context line that is a single space; a lone CR stays', () => {
  const two = [
    'diff --git a/widget/widget.go b/widget/widget.go', 'index 1111111..2222222 100644', '--- a/widget/widget.go', '+++ b/widget/widget.go', '@@ -1 +1 @@', '-old', '+new',
    'diff --git a/widget/other.go b/widget/other.go', 'index 3333333..4444444 100644', '--- a/widget/other.go', '+++ b/widget/other.go', '@@ -1 +1 @@', '-a', '+b', '',
  ].join('\n');
  assert.equal(extractDiff(`Invented lead-in.\n${two}Prose after.\n`), two);
  const lastBlank = '--- a/widget/widget.go\n+++ b/widget/widget.go\n@@ -1,2 +1,2 @@\n-old\n+new\n \n';
  assert.equal(extractDiff(`${lastBlank}Prose after.\n`), lastBlank, 'the context line that is one space is a diff line');
  const lone = '--- a/widget/widget.go\n+++ b/widget/widget.go\n@@ -1 +1 @@\n-a\n+b\rc\n';
  assert.equal(extractDiff(`\`\`\`diff\n${lone}\`\`\`\n`), lone, 'only CRLF becomes LF');
});

// A model's runaway answer: one fenced block of 200 000 lines is a megabyte and a half. `dedented` spreads its lines into
// `Math.min(...)`, whose argument list V8 caps (about 120 000): extractDiff throws a RangeError, and `check` stops there.
test('extractDiff: a fenced block of 200 000 lines is read, not refused with a RangeError', () => {
  const body = `${FILE}${'+x\n'.repeat(200000)}`;
  const started = Date.now();
  assert.equal(extractDiff(`\`\`\`diff\n${body}\`\`\`\n`), body);
  assert.equal(extractDiff(`  \`\`\`diff\n${indented(body, 2)}  \`\`\`\n`), body, 'indented, too');
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
});

// —— check ——

const IMAGE = `toolchain@sha256:${'1'.repeat(64)}`;
const idOf = (ref) => `sha256:${sha256(ref)}`;
const WIDGET = 'package widget\n\nfunc Last(items []string) string { return "" }\n';
const OTHER = 'package widget\n\nfunc Other() {}\n';
const taskLine = (n) => ({
  id: `P0${n}`, prompt: 'Invented bug report: the widget drops its last item.', tree: `third-party/p0${n}/before-fix`, image: IMAGE, build: null,
  gold: `suites/P/P0${n}/gold.diff`, tests: `suites/P/P0${n}/tests.diff`,
  failToPass: 'run-tests widget --only LastItem', passToPass: 'run-tests widget', timeoutS: 5,
});
const GOLD = [
  'diff --git a/widget/widget.go b/widget/widget.go', '--- a/widget/widget.go', '+++ b/widget/widget.go', '@@ -1,3 +1,4 @@',
  ' package widget', ' ', '+// FAKE: fixes INVENTED-GOLD-ONLY', ' func Last(items []string) string { return "" }', '',
].join('\n');
const TESTS = [
  'diff --git a/widget/widget_test.go b/widget/widget_test.go', '--- a/widget/widget_test.go', '+++ b/widget/widget_test.go', '@@ -1,3 +1,5 @@',
  ' package widget', ' ', ' import "testing"', '+', '+func TestInventedLastItem(t *testing.T) {}', '',
].join('\n');

function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const DATE = '2026-11-20';
const ARM = 'gemini:Invented Model (High)';
const answerWith = (diff) => `An invented explanation.\n\n\`\`\`diff\n${diff}\`\`\`\n\nAn invented closing remark.\n`;
const fixing = (rest = '') => `${GOLD.replace('INVENTED-GOLD-ONLY', 'INVENTED-MODEL-FIX')}${rest}`;
const pRunLine = (over = {}) => ({
  suite: 'P', taskIds: ['P01'], arm: ARM, unit: 'gemini', model: 'Invented Model (High)', effort: 'high', run: 1, cli: 'agy 0.0.0',
  startedAt: '2026-11-20T09:00:00.000Z', wallMs: 1000, ok: true, answer: 'An invented answer.', error: null, empty: false,
  usage: { input: 1, output: 1 }, resultId: null, agyConversations: [], ...over,
});
const fileRuns = (dir, lines, name = 'P-gemini-invented-model-high.jsonl') => put(dir, `runs/${DATE}/${name}`, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
const checksFile = (dir) => join(dir, 'checks', DATE, 'P.jsonl');
const checksAt = (dir) => (existsSync(checksFile(dir)) ? readFileSync(checksFile(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A private dir holding tasks P01 (and P02 with `tasks: 2`), each proven once, and `lines` filed as the date's run lines. */
async function proven(lines, { tasks = 1 } = {}) {
  const dir = tmp('omelette-evals-h-dir-');
  const home = tmp('omelette-evals-h-home-');
  const list = Array.from({ length: tasks }, (_, i) => taskLine(i + 1));
  for (const t of list) {
    put(dir, `${t.tree}/widget/widget.go`, WIDGET);
    put(dir, `${t.tree}/widget/widget_test.go`, 'package widget\n\nimport "testing"\n');
    put(dir, `${t.tree}/widget/other.go`, OTHER);
    put(dir, t.gold, GOLD);
    put(dir, t.tests, TESTS);
  }
  put(dir, 'suites/P/tasks.jsonl', list.map((t) => `${JSON.stringify(t)}\n`).join(''));
  const fake = fakeDocker(home);
  fake.addImage(IMAGE);
  const env = { PATH: `${TRIPWIRE}:${process.env.PATH}`, HOME: home, OMELETTE_EVALS_DOCKER: fake.bin };
  for (const t of list) await prove({ dir, task: t, docker: fake.bin, env, reps: 1, out: quiet });
  fileRuns(dir, lines);
  const printed = [];
  const run = (args = [], docker = fake.bin) => main(['check', '--date', DATE, '--dir', dir, ...args], {
    out: (l) => printed.push(l), err: (l) => printed.push(l), env: { ...env, OMELETTE_EVALS_DOCKER: docker },
  });
  return { dir, home, fake, env, printed, run, log0: fake.log().length };
}

const LONG_STDERR = Array.from({ length: 2600 }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join('');

/**
 * A docker that hands every call to the fake, then, for a `run` whose staged diff holds `WRAP: <step> <word>`:
 * a number exits it; `long` writes 2 600 characters on stderr and exits 121; `kill` kills the client; `vanish` deletes this file.
 */
function wrappedDocker({ home, fake }) {
  const bin = join(home, 'docker-wrapped');
  writeFileSync(bin, String.raw`#!${process.execPath}
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const r = require('child_process').spawnSync(${JSON.stringify(fake.bin)}, argv, { stdio: 'inherit', timeout: 4000 });
let want = null;
if (argv[0] === 'run') {
  const stage = (/source=([^,]+)/.exec(argv[argv.indexOf('--mount') + 1] || '') || [])[1];
  const step = argv[argv.length - 1];
  let change = '';
  try { change = fs.readFileSync(path.join(stage, 'change.diff'), 'utf8'); } catch { /* no change */ }
  const m = new RegExp('WRAP: ' + step + ' (\\w+)').exec(change);
  want = m ? m[1] : null;
}
if (want === 'long') { process.stderr.write(${JSON.stringify(LONG_STDERR)}); process.exit(121); }
if (want === 'kill') process.kill(process.pid, 'SIGKILL');
if (want === 'vanish') { fs.unlinkSync(process.argv[1]); process.exit(0); }
process.exit(want !== null ? Number(want) : r.status);
`);
  chmodSync(bin, 0o755);
  return bin;
}

test('check: the apply log filed is the last 2 000 characters of stderr; a test exit of 124, 126, 127 or 137 is the test\'s own (`red`); a client killed at apply is `error`', async () => {
  const codes = [124, 126, 127, 137];
  const lines = [
    pRunLine({ run: 1, answer: answerWith(fixing('# FAKE: does-not-apply WRAP: apply long\n')) }),
    ...codes.map((c, i) => pRunLine({ run: 2 + i, answer: answerWith(fixing(`# WRAP: f2p ${c}\n`)) })),
    ...codes.map((c, i) => pRunLine({ run: 6 + i, answer: answerWith(fixing(`# WRAP: p2p ${c}\n`)) })),
    pRunLine({ run: 10, answer: answerWith(fixing('# WRAP: apply kill\n')) }),
  ];
  const ctx = await proven(lines);
  assert.equal(await ctx.run([], wrappedDocker(ctx)), 0, ctx.printed.join('\n'));
  const filed = checksAt(ctx.dir);
  assert.deepEqual(filed.map((l) => [l.run, l.outcome]), [[1, 'does-not-apply'], ...codes.map((_, i) => [2 + i, 'red']), ...codes.map((_, i) => [6 + i, 'red']), [10, 'error']]);
  assert.equal(filed[0].applyLog, LONG_STDERR.slice(-2000));
  assert.deepEqual(filed.slice(1, 5).map((l) => [l.failToPass.exit, l.failToPass.timedOut]), codes.map((c) => [c, false]));
  assert.deepEqual(filed.slice(5, 9).map((l) => [l.failToPass.exit, l.passToPass.exit, l.passToPass.timedOut]), codes.map((c) => [0, c, false]));
  assert.deepEqual([filed[9].failToPass, filed[9].passToPass], [null, null]);
});

test('check: an error that is not a refused path is no `does-not-apply`: a docker that vanishes mid-check stops the check and files nothing for that call', async () => {
  const ctx = await proven([pRunLine({ answer: answerWith(fixing('# WRAP: apply vanish\n')) })]);
  await assert.rejects(check({ dir: ctx.dir, date: DATE, docker: wrappedDocker(ctx), env: ctx.env, out: quiet }), /not found|ENOENT/i);
  assert.deepEqual(checksAt(ctx.dir), []);
});

test('check: a hunk header that declares more lines than its hunk holds does not hide the next file\'s header from `paths`, `outsideGold` and the star', async () => {
  const overlong = [
    'diff --git a/widget/widget.go b/widget/widget.go', '--- a/widget/widget.go', '+++ b/widget/widget.go', '@@ -1,9 +1,9 @@', '-old', '+// FAKE: fixes',
    '--- a/widget/other.go', '+++ b/widget/other.go', '@@ -1 +1 @@', '-a', '+b', '',
  ].join('\n');
  const ctx = await proven([pRunLine({ answer: answerWith(overlong) })]);
  assert.equal(await ctx.run(), 0, ctx.printed.join('\n'));
  const [line] = checksAt(ctx.dir);
  assert.deepEqual([line.outcome, line.paths, line.outsideGold, line.linesChanged], ['green', ['widget/other.go', 'widget/widget.go'], ['widget/other.go'], 4]);
  assert.equal(ctx.printed[0], `  ${ARM}  run 1  P01  green*`);
});

test('check: a `diff --git` line names a path only where both sides are told to be one', async () => {
  const base = fixing();
  const variants = [
    ['a/ b/', []],
    ['a/x b/xx', []],
    ['c/x b/x', []],
    ['a/x c/x', []],
    ['"a/x"X"b/x"', []],
    ['"c/x" "b/x"', []],
    ['"a/x" "c/x"', []],
    ['Xa/x" "b/x"', []],
    ['"a/x\\"\\"" "b/x\\""Z', []], // junk after the second name: its end is not told, though what is left reads as the first name
    ['a/y b/y', ['y']],
    ['a/q r b/q r', ['q r']],
    ['"a/x\\"y" "b/x\\"y"', ['x"y']],
  ];
  const ctx = await proven(variants.map(([text], i) => pRunLine({ run: i + 1, answer: answerWith(`${base}diff --git ${text}\nold mode 100644\nnew mode 100755\n`) })));
  assert.equal(await ctx.run(), 0, ctx.printed.join('\n'));
  const got = checksAt(ctx.dir).map((l) => [l.run, l.paths]);
  const want = variants.map(([, names], i) => [i + 1, [...names, 'widget/widget.go'].sort()]);
  assert.deepEqual(got, want);
});

test('check: --task and --arm select the calls checked, a key is (arm, run, task), a task and an arm that never meet select none', async () => {
  const OTHER_ARM = 'native:session';
  const ctx = await proven([pRunLine({ run: 1, answer: answerWith(fixing()) }), pRunLine({ taskIds: ['P02'], run: 1, answer: answerWith(fixing()) })], { tasks: 2 });
  assert.equal(await ctx.run(['--task', 'P01']), 0, ctx.printed.join('\n'));
  assert.deepEqual(checksAt(ctx.dir).map((l) => [l.taskId, l.run, l.outcome]), [['P01', 1, 'green']], 'P02 was not asked for');
  ctx.printed.length = 0;
  assert.equal(await ctx.run(), 0, ctx.printed.join('\n'));
  assert.deepEqual(checksAt(ctx.dir).map((l) => [l.taskId, l.run]), [['P01', 1], ['P02', 1]], 'the same arm and run of another task is another key');
  assert.deepEqual(ctx.printed.slice(-1), [`1 checked, 1 already checked → ${checksFile(ctx.dir)}`]);
  fileRuns(ctx.dir, [pRunLine({ run: 1, answer: answerWith(fixing()) }), pRunLine({ taskIds: ['P02'], arm: OTHER_ARM, run: 1, answer: answerWith(fixing()) })]);
  const calls = ctx.fake.log().length;
  ctx.printed.length = 0;
  assert.equal(await ctx.run(['--task', 'P01', '--arm', OTHER_ARM]), 1, ctx.printed.join('\n'));
  assert.equal(ctx.fake.log().length, calls, 'refused before docker');
  assert.equal(checksAt(ctx.dir).length, 2);
});

test('check: a P run line that names no call is refused by its file and line, and a file of the P- family that is no .jsonl is not read', async () => {
  const good = pRunLine({ run: 1, answer: answerWith(fixing()) });
  const ctx = await proven([good]);
  const bads = [
    ['no taskIds', (l) => { delete l.taskIds; }],
    ['taskIds a string', (l) => { l.taskIds = 'P01'; }],
    ['taskIds empty', (l) => { l.taskIds = []; }],
    ['two taskIds', (l) => { l.taskIds = ['P01', 'P02']; }],
    ['a taskId that is no string', (l) => { l.taskIds = [7]; }],
    ['no arm', (l) => { delete l.arm; }],
    ['an arm that is no string', (l) => { l.arm = 7; }],
    ['no run', (l) => { delete l.run; }],
    ['a run that is a string', (l) => { l.run = '2'; }],
    ['a run that is not whole', (l) => { l.run = 2.5; }],
  ];
  for (const [what, mutate] of bads) {
    const bad = pRunLine({ run: 2 });
    mutate(bad);
    fileRuns(ctx.dir, [good, bad]);
    ctx.printed.length = 0;
    assert.equal(await ctx.run(), 1, `${what}: ${ctx.printed.join('\n')}`);
    assert.match(ctx.printed.join('\n'), /P-gemini-invented-model-high\.jsonl:2\b/, what);
  }
  assert.equal(ctx.fake.log().length, ctx.log0, 'no container for any of them');
  fileRuns(ctx.dir, [good]);
  put(ctx.dir, `runs/${DATE}/P-notes.txt`, 'not JSON at all, and not a run file\n');
  put(ctx.dir, `runs/${DATE}/P-gemini-invented-model-high.jsonl.bak`, '{ nor this\n');
  ctx.printed.length = 0;
  assert.equal(await ctx.run(), 0, ctx.printed.join('\n'));
});

test('check: the arm printed has its control characters taken out; the check line keeps the arm as filed', async () => {
  const arm = 'gemini:\u001b[31mInvented\nModel';
  const ctx = await proven([pRunLine({ arm, answer: answerWith(fixing()) })]);
  assert.equal(await ctx.run(), 0, ctx.printed.join('\n'));
  assert.equal(ctx.printed[0], '  gemini:[31mInventedModel  run 1  P01  green');
  assert.equal(checksAt(ctx.dir)[0].arm, arm);
});

test('check: a proof whose recorded image id is not an id is refused before docker is called', async () => {
  const ctx = await proven([pRunLine({ answer: answerWith(fixing()) })]);
  const file = join(ctx.dir, 'checks', 'proofs', 'P01.json');
  const proof = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...proof, imageId: 'invented-image:latest' }));
  assert.equal(await ctx.run(), 1, ctx.printed.join('\n'));
  assert.equal(ctx.fake.log().length, ctx.log0);
  assert.equal(existsSync(checksFile(ctx.dir)), false);
  assert.equal(idOf(IMAGE), proof.imageId);
});
