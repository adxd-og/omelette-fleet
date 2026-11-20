// scripts/eval-run.mjs — suite V's task kinds, third-party trees and a diff shown (plan
// docs/superpowers/plans/2026-11-19-evals-neon.md, T8). Every unit is a FAKE and every task, file and diff is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { materializeTree, parseArm, readTasks, runArm } from '../scripts/eval-run.mjs';

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

/** A fake MCP server for `tool` whose every call answers with the arguments it was sent. */
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
