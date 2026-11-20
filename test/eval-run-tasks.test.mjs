// scripts/eval-run.mjs — suite V's task kinds, third-party trees and a diff shown (plan
// docs/superpowers/plans/2026-11-19-evals-neon.md, T8), and suite P (T16). Every unit is a FAKE and every task, file and diff is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { proofInputs } from '../scripts/eval-patch.mjs';
import { main, materializeTree, P_SUFFIX, parseArm, planCalls, readTasks, runArm } from '../scripts/eval-run.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

/** A private evals dir with the given suites, laid out as the runner reads it. */
function evalsDir(suites) {
  const dir = tmp('omelette-evals-tasks-');
  for (const [suite, tasks] of Object.entries(suites)) {
    mkdirSync(join(dir, 'suites', suite), { recursive: true });
    writeFileSync(join(dir, 'suites', suite, 'tasks.jsonl'), tasks.map((t) => JSON.stringify(t)).join('\n') + '\n');
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

/** git in a fixture: no user or system config, our own identity. */
function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: cwd,
      GIT_CONFIG_GLOBAL: join(cwd, 'no-such-gitconfig'), GIT_CONFIG_SYSTEM: join(cwd, 'no-such-gitconfig'),
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** A throwaway repository with one file, committed; the commit's later state differs. */
function fixtureRepo() {
  const repo = tmp('omelette-evals-tasks-repo-');
  git(repo, ['init', '-q']);
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'thing.js'), 'export const thing = 1; // the reviewed state\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'one']);
  const commit = git(repo, ['rev-parse', '--short', 'HEAD']);
  writeFileSync(join(repo, 'src', 'thing.js'), 'export const thing = 2; // the later fix\n');
  git(repo, ['commit', '-q', '-am', 'two']);
  return { repo, commit };
}

/** A fake `codex` that answers with the directory it ran in; `marker` records every run. */
function fakeCodex(dir, { marker } = {}) {
  const p = join(dir, 'fake-codex');
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const a = process.argv.slice(2);',
    'if (a[0] === "--version") { console.log("fake-codex 1.2.3"); process.exit(0); }',
    marker ? `require("fs").appendFileSync(${JSON.stringify(marker)}, "run\\n");` : '',
    'let s = ""; process.stdin.on("data", (c) => { s += c; }).on("end", () => {',
    '  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok " + process.cwd() } }) + "\\n");',
    '});',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** A fake `agy` that answers `--version` only: no test spawns the real CLI. */
function fakeAgy(dir) {
  const p = join(dir, 'fake-agy');
  writeFileSync(p, [`#!${process.execPath}`, 'console.log("agy 9.9.9");'].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** A fake MCP server for `tool` whose every call answers with the arguments it was sent; `marker` records every start. */
function echoServer(dir, tool, { marker } = {}) {
  const p = join(dir, 'echo-server.mjs');
  writeFileSync(p, [
    marker ? `(await import("node:fs")).appendFileSync(${JSON.stringify(marker)}, "started\\n");` : '',
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
const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const quiet = () => {};

/** Run `fn` with the OS temp dir pointed at a fresh directory, so no test shares the snapshot copies. */
async function withTmpdir(fn) {
  const fresh = tmp('omelette-evals-tasks-tmpdir-');
  const was = process.env.TMPDIR;
  process.env.TMPDIR = fresh;
  try { return await fn(fresh); } finally {
    if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
  }
}

const BRIEF = 'Invented review brief: read the change and report what you find.';
const DIFF = '--- a/lib/widget.js\n+++ b/lib/widget.js\n@@ -1 +1 @@\n-export const items = [];\n+export const items = [1];\n';

test('a V task line is refused when its kind, its source or what it shows is wrong', () => {
  const refused = [
    { id: 'V09', kind: 'other', commit: 'abc1234', file: 'a.js', prompt: BRIEF },
    { id: 'V09', commit: 'abc1234', tree: 'third-party/x', file: 'a.js', prompt: BRIEF },
    { id: 'V09', file: 'a.js', prompt: BRIEF },
    { id: 'V09', kind: 'recall', show: 'diff', tree: 'third-party/x', prompt: BRIEF },
    { id: 'V09', kind: 'recall', tree: '../outside', file: 'a.js', prompt: BRIEF },
    { id: 'V09', kind: 'recall', tree: '/abs', file: 'a.js', prompt: BRIEF },
    { id: 'V09', commit: 1234, file: 'a.js', prompt: BRIEF },
  ];
  for (const line of refused) {
    assert.throws(() => readTasks(evalsDir({ V: [line] }), 'V'), /task V09: /, JSON.stringify(line));
  }
  const twice = { id: 'V09', commit: 'abc1234', file: 'a.js', prompt: BRIEF };
  assert.throws(() => readTasks(evalsDir({ V: [twice, twice] }), 'V'), /task V09: /);

  const accepted = [
    { id: 'V01', commit: 'abc1234', file: 'src/thing.js', prompt: BRIEF },
    { id: 'V02', kind: 'keyed', show: 'file', commit: 'def5678', file: 'hooks/thing.mjs', prompt: BRIEF },
    { id: 'X01', kind: 'recall', show: 'diff', tree: 'third-party/x01/at-intro', diff: 'suites/V/X01.diff', prompt: BRIEF },
    { id: 'C01', kind: 'control', of: 'X01', show: 'diff', tree: 'third-party/x01/after-fix', diff: 'suites/V/C01.diff', prompt: BRIEF },
  ];
  const dir = evalsDir({ V: accepted });
  writeFileSync(join(dir, 'suites', 'V', 'X01.diff'), DIFF);
  writeFileSync(join(dir, 'suites', 'V', 'C01.diff'), DIFF);
  assert.deepEqual(readTasks(dir, 'V').map((t) => t.id), ['V01', 'V02', 'X01', 'C01']);
});

test('a place is allowlisted: a tree strictly under third-party/, a shown diff a .diff file', () => {
  for (const tree of ['.', 'suites', 'a/..', 'third-party', 'third-party/', 'third-party/x/..', 'third-party/../suites']) {
    const dir = evalsDir({ V: [{ id: 'X01', kind: 'recall', tree, file: 'V/tasks.jsonl', prompt: BRIEF }] });
    assert.throws(() => readTasks(dir, 'V'), /task X01: .*third-party/, JSON.stringify(tree));
  }
  const dir = evalsDir({ V: [{ id: 'X01', kind: 'recall', show: 'diff', tree: 'third-party/x01/at-intro', diff: 'suites/V/key.jsonl', prompt: BRIEF }] });
  writeFileSync(join(dir, 'suites', 'V', 'key.jsonl'), '{"id":"XK1","task":"X01"}\n');
  assert.throws(() => readTasks(dir, 'V'), /task X01: .*\.diff/);
  // A link named `.diff` is no diff file: it would put the key into the brief.
  const linked = evalsDir({ V: [{ id: 'X01', kind: 'recall', show: 'diff', tree: 'third-party/x01/at-intro', diff: 'suites/V/X01.diff', prompt: BRIEF }] });
  writeFileSync(join(linked, 'suites', 'V', 'key.jsonl'), '{"id":"XK1","task":"X01"}\n');
  symlinkSync('key.jsonl', join(linked, 'suites', 'V', 'X01.diff'));
  assert.throws(() => readTasks(linked, 'V'), /task X01: diff suites\/V\/X01\.diff is not a file/);
});

test('materializeTree copies only a directory strictly under the place it is given, as the kernel finds it', async () => {
  await withTmpdir(async (fresh) => {
    const dir = tmp('omelette-evals-tasks-place-');
    writeTree(dir, 'third-party/x01/before-fix', { 'lib/widget.js': 'export const items = [];\n' });
    writeTree(dir, 'suites/V', { 'key.jsonl': '{"id":"XK1"}\n' });
    assert.throws(() => materializeTree({ dir, rel: 'third-party/x01/before-fix', id: 'X01' }), /needs "under"/);
    for (const rel of ['suites', 'third-party', 'third-party/x01/..']) {
      assert.throws(() => materializeTree({ dir, rel, id: 'X01', under: 'third-party' }), /relative path inside/, rel);
    }
    // A link in the path to the tree, not in the tree: the place is checked as the kernel resolves it.
    symlinkSync('../suites', join(dir, 'third-party', 'x02'));
    assert.throws(() => materializeTree({ dir, rel: 'third-party/x02/V', id: 'X02', under: 'third-party' }), /through a link/);
    assert.equal(existsSync(join(fresh, 'omelette-evals', 'snapshots', 'X02')), false);
    // A link that leads nowhere is refused as a link out of the tree.
    symlinkSync('lib/gone.js', join(dir, 'third-party', 'x01', 'before-fix', 'dangling'));
    assert.throws(() => materializeTree({ dir, rel: 'third-party/x01/before-fix', id: 'X01', under: 'third-party' }), /a link in third-party\/x01\/before-fix points out of it: dangling/);
  });
});

test('a control\'s brief is word for word its task\'s', () => {
  const x01 = { id: 'X01', kind: 'recall', tree: 'third-party/x01/before-fix', file: 'lib/widget.js', prompt: BRIEF };
  const control = (over) => ({ id: 'C01', kind: 'control', of: 'X01', tree: 'third-party/x01/after-fix', file: 'lib/widget.js', prompt: BRIEF, ...over });
  assert.throws(() => readTasks(evalsDir({ V: [x01, control({ prompt: `${BRIEF} ` })] }), 'V'), /task C01: .*word for word/);
  const keyed = { id: 'V01', commit: 'abc1234', file: 'src/thing.js', prompt: BRIEF };
  assert.throws(() => readTasks(evalsDir({ V: [keyed, control({ of: 'V01' })] }), 'V'), /task C01: /);
  assert.throws(() => readTasks(evalsDir({ V: [x01, control({ of: 'X09' })] }), 'V'), /task C01: /);
  // The wrapper sentence is part of the brief: it says what is shown, and names a shown file.
  const shown = evalsDir({ V: [x01, control({ show: 'diff', file: undefined, diff: 'suites/V/C01.diff' })] });
  writeFileSync(join(shown, 'suites', 'V', 'C01.diff'), DIFF);
  assert.throws(() => readTasks(shown, 'V'), /task C01: .*shows/);
  assert.throws(() => readTasks(evalsDir({ V: [x01, control({ file: 'lib/other.js' })] }), 'V'), /task C01: .*lib\/other\.js/);
});

test('V runs controls last, and a third-party file or diff comes from the private dir', async () => {
  const home = tmp('omelette-evals-tasks-home-');
  const { repo, commit } = fixtureRepo();
  const dir = evalsDir({
    V: [
      { id: 'C01', kind: 'control', of: 'X01', tree: 'third-party/x01/after-fix', file: 'lib/widget.js', prompt: BRIEF },
      { id: 'V01', commit, file: 'src/thing.js', prompt: BRIEF },
      { id: 'X01', kind: 'recall', tree: 'third-party/x01/before-fix', file: 'lib/widget.js', prompt: BRIEF },
      { id: 'X02', kind: 'recall', show: 'diff', tree: 'third-party/x02/at-intro', diff: 'suites/V/X02.diff', prompt: BRIEF },
    ],
  });
  writeTree(dir, 'third-party/x01/before-fix', { 'lib/widget.js': 'export const items = []; // invented, before the fix\n' });
  writeTree(dir, 'third-party/x01/after-fix', { 'lib/widget.js': 'export const items = [1]; // invented, after the fix\n' });
  writeTree(dir, 'third-party/x02/at-intro', { 'lib/widget.js': 'export const items = [1];\n' });
  writeFileSync(join(dir, 'suites', 'V', 'X02.diff'), DIFF);
  const { lines } = await withTmpdir(() => runArm({
    suite: 'V', arm: parseArm('gemini:Gemini 4 Hydrogen:high'), dir, repo, out: quiet,
    serverPath: echoServer(home, 'gemini_research'), env: baseEnv(home, { AGY_BIN: fakeAgy(home) }),
  }));
  assert.deepEqual(lines.map((l) => l.taskIds[0]), ['V01', 'X01', 'X02', 'C01']);
  const sent = Object.fromEntries(lines.map((l) => [l.taskIds[0], JSON.parse(l.answer)]));
  assert.ok(sent.X01.prompt.startsWith(BRIEF));
  assert.ok(sent.X01.prompt.includes('invented, before the fix'), sent.X01.prompt);
  assert.ok(sent.X02.prompt.includes(`\`\`\`diff\n${DIFF}\n\`\`\``), sent.X02.prompt);
  assert.ok(sent.C01.prompt.includes('invented, after the fix'));
  for (const s of Object.values(sent)) assert.equal(s.cwd, undefined);
});

test('a Gemini arm reads a tree\'s file as the kernel finds it: a link chain out of the tree, or a tree reached through a link, is refused before any call', async () => {
  const home = tmp('omelette-evals-tasks-home-');
  const gemini = (dir) => runArm({
    suite: 'V', arm: parseArm('gemini:Gemini 4 Hydrogen:high'), dir, out: quiet,
    serverPath: echoServer(home, 'gemini_research'), env: baseEnv(home, { AGY_BIN: fakeAgy(home) }),
  });
  const tree = (tasks) => {
    const dir = evalsDir({ V: tasks });
    writeTree(dir, 'third-party/x01/before-fix', {
      'lib/widget.js': 'export const items = []; // invented, inside the tree\n',
      'outside.txt': 'invented decoy: where the text of the link points\n',
    });
    writeFileSync(join(dir, 'third-party', 'x01', 'outside.txt'), 'invented: where the kernel lands, outside the tree\n');
    const root = join(dir, 'third-party', 'x01', 'before-fix');
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    symlinkSync('..', join(root, 'a', 'b', 's'));
    symlinkSync('a/b/s/../..', join(root, 'reach'));
    symlinkSync('lib/widget.js', join(root, 'alias.js'));
    symlinkSync('../suites', join(dir, 'third-party', 'x02'));
    return dir;
  };
  const x = (id, file, at = 'third-party/x01/before-fix') => ({ id, kind: 'recall', tree: at, file, prompt: BRIEF });
  // `reach` reads as the tree's root and is its parent to the kernel: the decoy is what a lexical reading finds.
  const chain = tree([x('X01', 'reach/outside.txt')]);
  await withTmpdir(() => assert.rejects(gemini(chain), /task X01: file reach\/outside\.txt is outside/));
  assert.equal(existsSync(join(chain, 'runs')), false, 'no call was made');
  // `third-party/x02` is a link to the private dir's suites: the tree's place, not a link in it.
  const through = tree([x('X02', 'tasks.jsonl', 'third-party/x02/V')]);
  await withTmpdir(() => assert.rejects(gemini(through), /through a link/));
  assert.equal(existsSync(join(through, 'runs')), false, 'no call was made');
  // A plain file, and a link that stays inside, still read.
  const fine = tree([x('X01', 'lib/widget.js'), x('X03', 'alias.js')]);
  const { lines } = await withTmpdir(() => gemini(fine));
  for (const l of lines) assert.ok(JSON.parse(l.answer).prompt.includes('invented, inside the tree'), l.taskIds[0]);
});

test('a cwd arm reviews a fresh copy of a third-party tree outside every work tree', async () => {
  const home = tmp('omelette-evals-tasks-home-');
  const dir = evalsDir({ V: [{ id: 'X01', kind: 'recall', tree: 'third-party/x01/before-fix', file: 'lib/widget.js', prompt: BRIEF }] });
  writeTree(dir, 'third-party/x01/before-fix', { 'lib/widget.js': 'export const items = [];\n' });
  await withTmpdir(async (fresh) => {
    const snap = join(fresh, 'omelette-evals', 'snapshots', 'X01');
    mkdirSync(snap, { recursive: true });
    writeFileSync(join(snap, 'stray.txt'), 'left by an earlier run');
    const { lines } = await runArm({ suite: 'V', arm: parseArm('codex:gpt-6.1-sol'), dir, out: quiet, env: baseEnv(home, { CODEX_BIN: fakeCodex(home) }) });
    assert.equal(lines[0].ok, true, lines[0].error);
    const spooled = readFileSync(join(home, 'results', 'codex', `${lines[0].resultId}.md`), 'utf8');
    assert.match(spooled, new RegExp(`^cwd: ${snap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.equal(existsSync(join(snap, 'stray.txt')), false, 'the earlier copy is gone');
    assert.equal(existsSync(join(snap, 'lib', 'widget.js')), true);
    assert.equal(existsSync(join(snap, '.git')), false);
  });
});

test('a tree with a link out of it is refused before any call', async () => {
  const home = tmp('omelette-evals-tasks-home-');
  const dir = evalsDir({ V: [{ id: 'X01', kind: 'recall', tree: 'third-party/x01/before-fix', file: 'lib/widget.js', prompt: BRIEF }] });
  writeTree(dir, 'third-party/x01/before-fix', { 'lib/widget.js': 'export const items = [];\n' });
  symlinkSync('../../outside', join(dir, 'third-party', 'x01', 'before-fix', 'link'));
  const marker = join(home, 'vendor-ran');
  await withTmpdir(() => assert.rejects(
    runArm({ suite: 'V', arm: parseArm('codex:gpt-6.1-sol'), dir, out: quiet, env: baseEnv(home, { CODEX_BIN: fakeCodex(home, { marker }) }) }),
    /points out of it/,
  ));
  assert.equal(existsSync(marker), false, 'no vendor run');
});

test('--snapshot names a commit\'s tree only', async () => {
  const home = tmp('omelette-evals-tasks-home-');
  const dir = evalsDir({ V: [{ id: 'X01', kind: 'recall', tree: 'third-party/x01/before-fix', file: 'lib/widget.js', prompt: BRIEF }] });
  writeTree(dir, 'third-party/x01/before-fix', { 'lib/widget.js': 'export const items = [];\n' });
  await assert.rejects(
    runArm({ suite: 'V', arm: parseArm('codex:gpt-6.1-sol'), dir, snapshot: join(tmp('omelette-evals-tasks-snap-'), 's'), out: quiet, env: baseEnv(home, { CODEX_BIN: fakeCodex(home) }) }),
    /--snapshot is for tasks at a commit/,
  );
});

// Suite P (T16): the runner reads eval-patch's proof and copies the tree; no test here calls docker.
const P_GOLD = [
  'diff --git a/widget/widget.go b/widget/widget.go',
  '--- a/widget/widget.go',
  '+++ b/widget/widget.go',
  '@@ -1,3 +1,4 @@',
  ' package widget',
  ' ',
  '+// invented: the maintainers\' fix',
  ' func Last(items []string) string { return "" }',
  '',
].join('\n');
const P_TESTS = [
  'diff --git a/widget/widget_test.go b/widget/widget_test.go',
  '--- a/widget/widget_test.go',
  '+++ b/widget/widget_test.go',
  '@@ -1,3 +1,5 @@',
  ' package widget',
  ' ',
  ' import "testing"',
  '+',
  '+func TestInventedLastItem(t *testing.T) {}',
  '',
].join('\n');

/** An invented P task line; its files sit where eval-patch wants them. */
const pLine = (id, over = {}) => ({
  id, prompt: `Invented bug report ${id}: the widget drops its last item.`, tree: `third-party/${id.toLowerCase()}/before-fix`,
  image: `golang@sha256:${'0'.repeat(64)}`, build: null, gold: `suites/P/${id}/gold.diff`, tests: `suites/P/${id}/tests.diff`,
  failToPass: "go test ./widget -run '^TestInventedLastItem$'", passToPass: 'go test ./widget', timeoutS: 5, ...over,
});

/** The proof eval-patch writes for a task that held, made of the task's files as they are now: write it after them. */
function writeProof(dir, task) {
  mkdirSync(join(dir, 'checks', 'proofs'), { recursive: true });
  writeFileSync(join(dir, 'checks', 'proofs', `${task.id}.json`), JSON.stringify({ task: task.id, inputs: proofInputs({ dir, task }), ok: true, reps: [{ ok: true }] }));
}

/** A private dir with suite P's tasks `ids`, each with its tree, gold and tests diff; those in `proven` get a proof. */
function pSuite(ids, { proven = ids } = {}) {
  const tasks = ids.map((id) => pLine(id));
  const dir = evalsDir({ P: tasks });
  for (const t of tasks) {
    writeTree(dir, t.tree, { 'widget/widget.go': 'package widget\n\nfunc Last(items []string) string { return "" }\n', 'widget/widget_test.go': 'package widget\n\nimport "testing"\n' });
    writeTree(dir, `suites/P/${t.id}`, { 'gold.diff': P_GOLD, 'tests.diff': P_TESTS });
  }
  for (const t of tasks) if (proven.includes(t.id)) writeProof(dir, t);
  return { dir, tasks };
}

/** Every file under `root`, as [relative path, text], sorted. */
function filesUnder(root) {
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else found.push([relative(root, join(d, e.name)), readFileSync(join(d, e.name), 'utf8')]);
    }
  };
  walk(root);
  return found.sort(([a], [b]) => (a < b ? -1 : 1));
}

const HYDROGEN = 'gemini:Gemini 4 Hydrogen:high';

test('P: the bug report with the diff instruction, a fresh copy of the tree as cwd, and neither the gold nor the tests in it', async () => {
  const home = tmp('omelette-evals-tasks-home-');
  const { dir, tasks: [p01] } = pSuite(['P01']);
  await withTmpdir(async (fresh) => {
    const { lines } = await runArm({
      suite: 'P', arm: parseArm(HYDROGEN), dir, out: quiet,
      serverPath: echoServer(home, 'gemini_research'), env: baseEnv(home, { AGY_BIN: fakeAgy(home) }),
    });
    const copy = join(fresh, 'omelette-evals', 'snapshots', 'P01');
    assert.deepEqual(lines.map((l) => [l.suite, l.taskIds, l.ok]), [['P', ['P01'], true]]);
    // The whole of what the call sends: the report, a blank line, the instruction; the copy as cwd; nothing else.
    assert.deepEqual(JSON.parse(lines[0].answer), { prompt: `${p01.prompt}\n\n${P_SUFFIX}`, model: 'Gemini 4 Hydrogen (High)', cwd: copy });
    const files = filesUnder(copy);
    assert.deepEqual(files.map(([rel]) => rel), ['widget/widget.go', 'widget/widget_test.go'], 'a copy of the tree, no more');
    for (const [rel, text] of files) {
      assert.ok(!rel.split('/').includes('suites'), rel);
      for (const secret of [P_GOLD, P_TESTS]) {
        assert.notEqual(text, secret, rel);
        assert.ok(!text.includes(secret), rel);
      }
    }
  });
});

test('P refuses a task without a fresh gold proof before any call', async () => {
  const home = tmp('omelette-evals-tasks-home-');
  const marker = join(home, 'server-started');
  const { dir, tasks: [p01] } = pSuite(['P01', 'P02'], { proven: ['P02'] });
  const run = (only) => withTmpdir(() => runArm({
    suite: 'P', arm: parseArm(HYDROGEN), dir, only, out: quiet,
    serverPath: echoServer(home, 'gemini_research', { marker }), env: baseEnv(home, { AGY_BIN: fakeAgy(home) }),
  }));
  await assert.rejects(run(), { message: 'P01 has no fresh gold proof (missing): run node scripts/eval-patch.mjs prove --task P01 first' });
  writeProof(dir, p01);
  writeFileSync(join(dir, p01.gold), P_GOLD.replace('the maintainers\' fix', 'an edited fix'));
  await assert.rejects(run(), /P01 has no fresh gold proof \(stale\)/);
  assert.equal(existsSync(marker), false, 'no server was started');
  assert.equal(existsSync(join(dir, 'runs')), false, 'no run file was made');
  const { lines } = await run(['P02']);
  assert.deepEqual(lines.map((l) => [l.taskIds[0], l.ok]), [['P02', true]]);
  assert.equal(existsSync(marker), true);
});

test('P runs on Gemini only', () => {
  const t = { ...pLine('P01'), snapshot: '/invented/copy' };
  assert.throws(() => planCalls({ suite: 'P', arm: parseArm('codex:gpt-6.1-sol'), tasks: [t] }), /no tool for suite "P"/);
});

test('a P line is read by eval-patch\'s rules: its shape on every line, its files for the tasks the arm runs', () => {
  const { dir } = pSuite(['P01', 'P02']);
  rmSync(join(dir, 'third-party', 'p02'), { recursive: true });
  assert.throws(() => readTasks(dir, 'P'), /task P02: tree third-party\/p02\/before-fix is not a directory/);
  assert.deepEqual(readTasks(dir, 'P', { only: ['P01'] }).map((t) => t.id), ['P01', 'P02']);
  const shaped = evalsDir({ P: [pLine('P01'), pLine('P03', { image: 'golang:latest' })] });
  writeTree(shaped, 'third-party/p01/before-fix', { 'widget/widget.go': 'package widget\n' });
  writeTree(shaped, 'suites/P/P01', { 'gold.diff': P_GOLD, 'tests.diff': P_TESTS });
  assert.throws(() => readTasks(shaped, 'P', { only: ['P01'] }), /task P03: image "golang:latest" is not an official image pinned by digest/);
});

test('the P dry run names each task\'s proof, marks one without a fresh proof, and copies nothing', async () => {
  const { dir, tasks } = pSuite(['P01', 'P02'], { proven: ['P02'] });
  const said = [];
  await withTmpdir(async (fresh) => {
    const code = await main(['--suite', 'P', '--arm', HYDROGEN, '--dir', dir, '--dry-run'], { out: (l) => said.push(l), err: (l) => said.push(l) });
    assert.equal(code, 0, said.join('\n'));
    assert.equal(existsSync(join(fresh, 'omelette-evals')), false, 'no copy is made');
  });
  const text = said.join('\n');
  assert.match(text, /P01 gold proof missing — would be REFUSED: run node scripts\/eval-patch\.mjs prove --task P01 first/);
  assert.match(text, /P02 gold proof ok$/m);
  for (const t of tasks) assert.ok(!text.includes(t.prompt), 'no prompt is printed');
});

// The runner's hardenings (T16b): every unit is a fake, every value invented.
/** A fake `codex` whose answer is what of `names` its own environment holds. */
function envCodex(dir, names) {
  const p = join(dir, 'env-codex');
  writeFileSync(p, [
    `#!${process.execPath}`,
    'if (process.argv[2] === "--version") { console.log("fake-codex 1.2.3"); process.exit(0); }',
    `const seen = Object.fromEntries(${JSON.stringify(names)}.map((k) => [k, process.env[k] ?? null]));`,
    'process.stdin.on("data", () => {}).on("end", () => {',
    '  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(seen) } }) + "\\n");',
    '  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");',
    '});',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

test('an eval call runs under the stock env allowlist: an OMELETTE_ENV_PASSTHROUGH the shell exports widens nothing', async () => {
  const home = tmp('omelette-evals-tasks-home-');
  const dir = evalsDir({ R: [{ id: 'q1', prompt: 'Invented question: what colour is the imaginary widget?' }] });
  const env = baseEnv(home, {
    CODEX_BIN: envCodex(home, ['GIT_DIR', 'INVENTED_TOKEN']), OMELETTE_ENV_PASSTHROUGH: 'GIT_*,INVENTED_*',
    GIT_DIR: join(home, 'invented-git-dir'), INVENTED_TOKEN: 'invented-secret',
  });
  const { lines } = await runArm({ suite: 'R', arm: parseArm('codex:gpt-6.1-sol'), dir, env, out: quiet });
  assert.equal(lines[0].ok, true, lines[0].error);
  assert.deepEqual(JSON.parse(lines[0].answer), { GIT_DIR: null, INVENTED_TOKEN: null }, 'the vendor CLI saw neither');
  assert.equal(env.OMELETTE_ENV_PASSTHROUGH, 'GIT_*,INVENTED_*', 'the caller\'s env is left as it was');
});

test('a task whose id is another task\'s commit, in any case, is refused: the two would share one snapshot directory', () => {
  for (const id of ['abc1234', 'ABC1234']) {
    const dir = evalsDir({
      V: [
        { id: 'V01', commit: 'abc1234', file: 'src/thing.js', prompt: BRIEF },
        { id, kind: 'recall', tree: 'third-party/x01/before-fix', file: 'lib/widget.js', prompt: BRIEF },
      ],
    });
    assert.throws(() => readTasks(dir, 'V'), new RegExp(`task ${id}: its id is V01's commit`), id);
  }
});

test('a control character in a task\'s id, file, tree, diff or commit is refused by task id, in every suite', () => {
  const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const refused = [
    ['V', { id: 'V09', commit: 'abc1234', file: 'src/thing.js\n```\nInvented line outside the fence.', prompt: BRIEF }, 'V09', 'file'],
    ['V', { id: 'V09', commit: 'abc1234\u0085', file: 'src/thing.js', prompt: BRIEF }, 'V09', 'commit'],
    ['V', { id: 'X09', kind: 'recall', tree: 'third-party/x09/at\u007fintro', file: 'lib/widget.js', prompt: BRIEF }, 'X09', 'tree'],
    ['V', { id: 'X09', kind: 'recall', show: 'diff', tree: 'third-party/x09/at-intro', diff: 'suites/V/X09\u001b[2J.diff', prompt: BRIEF }, 'X09', 'diff'],
    ['V', { id: 'V\t09', commit: 'abc1234', file: 'src/thing.js', prompt: BRIEF }, '"V\\t09"', 'id'],
    ['R', { id: 'q\u00001', prompt: 'Invented question.' }, '"q\\u00001"', 'id'],
    ['P', pLine('P09', { tree: 'third-party/p09/before\u009ffix' }), 'P09', 'tree'],
  ];
  for (const [suite, line, named, field] of refused) {
    assert.throws(() => readTasks(evalsDir({ [suite]: [line] }), suite), new RegExp(`task ${escaped(named)}: ${field} holds a control character`), JSON.stringify(line));
  }
});

test('the run file is the operator\'s alone after every append, not only when it is made', async () => {
  const home = tmp('omelette-evals-tasks-home-');
  const dir = evalsDir({ R: [{ id: 'q1', prompt: 'Invented question: when did the made-up release ship?' }] });
  const file = join(dir, 'runs', '2026-11-20', 'R-codex-gpt-6.1-sol.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
  chmodSync(file, 0o644);
  await runArm({
    suite: 'R', arm: parseArm('codex:gpt-6.1-sol'), dir, now: () => new Date(2026, 10, 20, 12), out: quiet,
    serverPath: echoServer(home, 'codex_research'), env: baseEnv(home, { CODEX_BIN: fakeCodex(home) }),
  });
  assert.equal(readLines(file).length, 1, 'the line went into the file that was there');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
