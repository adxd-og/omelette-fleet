// scripts/eval-run.mjs — the evals runner (plan docs/superpowers/plans/2026-10-16-evals-mvp.md, Task 1).
// Every unit here is a FAKE: a fake vendor binary behind the real servers/<unit>.mjs, or a fake MCP
// server. No real agy, grok or codex is ever spawned, and every task text below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callUnitServer } from '../core/client.mjs';
import { renderResult } from '../core/results.mjs';
import { cliVersion, ensureSnapshot, parseArm, planCalls, runArm, UNITS } from '../scripts/eval-run.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'eval-run.mjs');

const R_TASKS = [
  { id: 'q1', prompt: 'Invented question one: what colour is the imaginary widget?' },
  { id: 'q2', prompt: 'Invented question two: when did the made-up release ship?' },
];

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

/** A private evals dir with the given suites, laid out as the runner reads it. */
function evalsDir(suites) {
  const dir = tmp('omelette-evals-');
  for (const [suite, tasks] of Object.entries(suites)) {
    mkdirSync(join(dir, 'suites', suite), { recursive: true });
    writeFileSync(join(dir, 'suites', suite, 'tasks.jsonl'), tasks.map((t) => JSON.stringify(t)).join('\n') + '\n');
  }
  return dir;
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
  const repo = tmp('omelette-evals-repo-');
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

/**
 * A fake `codex`: answers `--version`, and for a run reads the prompt from stdin and prints codex's
 * JSONL with a usage block. `marker` records every run, so a test can count them.
 */
function fakeCodex(dir, { usage, marker } = {}) {
  const p = join(dir, 'fake-codex');
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const fs = require("fs");',
    'const a = process.argv.slice(2);',
    'if (a[0] === "--version") { console.log("fake-codex 1.2.3"); process.exit(0); }',
    marker ? `fs.appendFileSync(${JSON.stringify(marker)}, "run\\n");` : '',
    'let s = ""; process.stdin.on("data", (c) => { s += c; }).on("end", () => {',
    '  const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    '  line({ type: "item.completed", item: { type: "agent_message", text: "invented answer, prompt length " + s.length } });',
    `  line({ type: "turn.completed", usage: ${JSON.stringify(usage || { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 7 })} });`,
    '});',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** A fake MCP server for tool `codex_research` that answers isError and counts its calls. */
function failingServer(dir, counter) {
  const p = join(dir, 'failing-server.mjs');
  writeFileSync(p, [
    'import { appendFileSync } from "node:fs";',
    'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => {',
    '  buf += c; let nl;',
    '  while ((nl = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);',
    '    if (!line) continue;',
    '    const m = JSON.parse(line);',
    '    if (m.id === 1) send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });',
    '    else if (m.id === 2) send({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "codex_research", description: "d", inputSchema: { type: "object" } }] } });',
    `    else if (m.id === 3) { appendFileSync(${JSON.stringify(counter)}, "call\\n"); send({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "invented failure" }], isError: true } }); }`,
    '  }',
    '});',
  ].join('\n'));
  return p;
}

const baseEnv = (home, extra = {}) => ({
  PATH: process.env.PATH, HOME: home, OMELETTE_HOME: home, OMELETTE_UPDATE_CHECK: '0', ...extra,
});

const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const quiet = () => {};

// ─── the arm ─────────────────────────────────────────────────────────────────

test('an arm names a catalog model; Gemini carries its effort in the model id, Codex and Grok as an effort', () => {
  assert.deepEqual(parseArm('gemini:Gemini 3.8 Flash:high'), { arm: 'gemini:Gemini 3.8 Flash (High)', unit: 'gemini', model: 'Gemini 3.8 Flash (High)', effort: null });
  assert.deepEqual(parseArm('gemini:Gemini 3.8 Flash (Low)'), { arm: 'gemini:Gemini 3.8 Flash (Low)', unit: 'gemini', model: 'Gemini 3.8 Flash (Low)', effort: null });
  assert.deepEqual(parseArm('codex:gpt-6.1-sol'), { arm: 'codex:gpt-6.1-sol', unit: 'codex', model: 'gpt-6.1-sol', effort: null });
  assert.deepEqual(parseArm('codex:gpt-6-astra:xhigh'), { arm: 'codex:gpt-6-astra:xhigh', unit: 'codex', model: 'gpt-6-astra', effort: 'xhigh' });
  assert.deepEqual(parseArm('grok:grok-4.7'), { arm: 'grok:grok-4.7', unit: 'grok', model: 'grok-4.7', effort: null });
  assert.throws(() => parseArm('claude:opus'), /unit/);
  assert.throws(() => parseArm('codex:no-such-model'), /model/);
  assert.throws(() => parseArm('codex:gpt-6.1-sol:loud'), /effort/);
  assert.throws(() => parseArm('gemini:Gemini 3.8 Flash (Low):high'), /effort/);
  assert.throws(() => parseArm('codex'), /model/);
});

// ─── the call plan ───────────────────────────────────────────────────────────

test('R: one research call per question, through each unit\'s research tool, with model and (Codex, Grok) effort', () => {
  const g = planCalls({ suite: 'R', arm: parseArm('gemini:Gemini 3.8 Flash:medium'), tasks: R_TASKS });
  assert.deepEqual(g, [
    { taskIds: ['q1'], tool: 'gemini_research', args: { prompt: R_TASKS[0].prompt, model: 'Gemini 3.8 Flash (Medium)' } },
    { taskIds: ['q2'], tool: 'gemini_research', args: { prompt: R_TASKS[1].prompt, model: 'Gemini 3.8 Flash (Medium)' } },
  ]);
  const k = planCalls({ suite: 'R', arm: parseArm('grok:grok-4.7:high'), tasks: R_TASKS });
  assert.deepEqual(k.map((c) => [c.tool, c.args]), [
    ['grok_research', { prompt: R_TASKS[0].prompt, model: 'grok-4.7', effort: 'high' }],
    ['grok_research', { prompt: R_TASKS[1].prompt, model: 'grok-4.7', effort: 'high' }],
  ]);
  // No effort named: none is sent, and the unit applies its pairing.
  const c = planCalls({ suite: 'R', arm: parseArm('codex:gpt-6.1-sol'), tasks: R_TASKS });
  assert.deepEqual(c.map((x) => [x.tool, x.args]), [
    ['codex_research', { prompt: R_TASKS[0].prompt, model: 'gpt-6.1-sol' }],
    ['codex_research', { prompt: R_TASKS[1].prompt, model: 'gpt-6.1-sol' }],
  ]);
});

test('R --batch: one call holding every question, numbered, asking for an answer per number', () => {
  const [call, ...rest] = planCalls({ suite: 'R', arm: parseArm('gemini:Gemini 3.8 Flash:high'), tasks: R_TASKS, batch: true });
  assert.equal(rest.length, 0);
  assert.deepEqual(call.taskIds, ['q1', 'q2']);
  assert.equal(call.tool, 'gemini_research');
  assert.equal(call.args.model, 'Gemini 3.8 Flash (High)');
  const p = call.args.prompt;
  assert.ok(p.includes(`1. ${R_TASKS[0].prompt}`), p);
  assert.ok(p.includes(`2. ${R_TASKS[1].prompt}`), p);
  assert.ok(p.indexOf('1. ') < p.indexOf('2. '));
  assert.match(p, /each/i);
  assert.match(p, /number/i);
});

test('V: Codex and Grok review the snapshot as cwd; Gemini gets the file\'s text in the brief and no cwd', () => {
  const task = { id: 'v1', commit: 'abc1234', file: 'src/thing.js', prompt: 'Invented review brief: find the defects.', snapshot: '/abs/snap', fileText: 'export const thing = 1;\n' };
  const c = planCalls({ suite: 'V', arm: parseArm('codex:gpt-6-astra:xhigh'), tasks: [task] });
  assert.deepEqual(c, [{ taskIds: ['v1'], tool: 'codex_code_review', args: { prompt: task.prompt, model: 'gpt-6-astra', effort: 'xhigh', cwd: '/abs/snap' } }]);
  const k = planCalls({ suite: 'V', arm: parseArm('grok:grok-4.7'), tasks: [task] });
  assert.deepEqual(k, [{ taskIds: ['v1'], tool: 'grok_code_review', args: { prompt: task.prompt, model: 'grok-4.7', cwd: '/abs/snap' } }]);
  const [g] = planCalls({ suite: 'V', arm: parseArm('gemini:Gemini 3.8 Flash:low'), tasks: [task] });
  assert.equal(g.tool, 'gemini_research');
  assert.equal(g.args.cwd, undefined);
  assert.ok(g.args.prompt.startsWith(task.prompt));
  assert.ok(g.args.prompt.includes(task.fileText));
  assert.ok(g.args.prompt.includes(task.file));
});

test('V has no batch form', () => {
  const task = { id: 'v1', commit: 'abc1234', file: 'a.js', prompt: 'Invented brief.', snapshot: '/abs/snap', fileText: 'x' };
  assert.throws(() => planCalls({ suite: 'V', arm: parseArm('codex:gpt-6.1-sol'), tasks: [task], batch: true }), /batch/);
});

// ─── the snapshot ────────────────────────────────────────────────────────────

test('the V snapshot is the commit\'s tree with no .git, and no git history is reachable from it', () => {
  const { repo, commit } = fixtureRepo();
  const path = join(tmp('omelette-evals-snap-'), commit);
  assert.equal(ensureSnapshot({ repo, commit, path }), path);
  assert.equal(readFileSync(join(path, 'src', 'thing.js'), 'utf8'), 'export const thing = 1; // the reviewed state\n');
  assert.equal(existsSync(join(path, '.git')), false);
  const probe = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: path, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.notEqual(probe.status, 0, 'git finds no repository from the snapshot');
  // Present: reused as it is, not extracted again.
  writeFileSync(join(path, 'kept'), 'x');
  ensureSnapshot({ repo, commit, path });
  assert.equal(existsSync(join(path, 'kept')), true);
});

test('a snapshot git can reach history from is refused: one with .git, and one inside a work tree', () => {
  const { repo, commit } = fixtureRepo();
  // Inside the live checkout's tree, git walks up to its .git and the later fix is one `git log` away.
  assert.throws(() => ensureSnapshot({ repo, commit, path: join(repo, '.omelette', 'evals', 'snapshots', commit) }), /history|repository/);
  const withGit = join(tmp('omelette-evals-snap-'), 'snap');
  mkdirSync(join(withGit, '.git'), { recursive: true });
  assert.throws(() => ensureSnapshot({ repo, commit, path: withGit }), /\.git/);
  assert.throws(() => ensureSnapshot({ repo, commit: '--output=/tmp/x', path: join(tmp('omelette-evals-snap-'), 's') }), /commit/);
});

// ─── running, through the real unit path ─────────────────────────────────────

test('callUnitServer reports the pid of the server it ran — the key the spool files a call under', async () => {
  const dir = tmp('omelette-evals-pid-');
  const server = join(dir, 'pid-server.mjs');
  writeFileSync(server, [
    'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
    'let buf = ""; process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { buf += c; let nl; while ((nl = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; const m = JSON.parse(l);',
    '  if (m.id === 1) send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "f", version: "0" } } });',
    '  else if (m.id === 2) send({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }] } });',
    '  else if (m.id === 3) send({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: String(process.pid) }] } }); } });',
  ].join('\n'));
  const r = await callUnitServer({ serverPath: server, tool: 't', timeoutS: 20 });
  assert.equal(r.pid, Number(r.text));
});

test('R through the real codex server: one line per call with every field, usage read from that call\'s own spool record', async () => {
  const home = tmp('omelette-evals-home-');
  const dir = evalsDir({ R: R_TASKS });
  const fake = fakeCodex(home);
  const env = baseEnv(home, { CODEX_BIN: fake });
  // A neighbour's record, filed in the same spool within the same seconds under another pid, with the
  // same tool: it must never be read as ours.
  const decoyId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-1-1`;
  mkdirSync(join(home, 'results', 'codex'), { recursive: true });
  writeFileSync(join(home, 'results', 'codex', `${decoyId}.md`), renderResult({
    unit: 'codex', tool: 'codex_research', resultId: decoyId, model: 'gpt-6-luna', effort: 'low',
    usage: { input: 999999, output: 999999 }, startedAt: new Date(Date.now() + 5000).toISOString(),
    endedAt: new Date(Date.now() + 6000).toISOString(), durationMs: 1, status: 'ok', text: 'not ours',
  }));
  const now = new Date(2026, 9, 16, 12, 0, 0);
  const { file } = await runArm({ suite: 'R', arm: parseArm('codex:gpt-6.1-sol'), runs: 1, dir, env, now: () => now, out: quiet });
  assert.equal(file, join(dir, 'runs', '2026-10-16', 'R-codex-gpt-6.1-sol.jsonl'));
  const lines = readLines(file);
  assert.equal(lines.length, 2);
  for (const [i, l] of lines.entries()) {
    assert.deepEqual(Object.keys(l).sort(), ['answer', 'arm', 'cli', 'effort', 'error', 'model', 'ok', 'resultId', 'run', 'startedAt', 'suite', 'taskIds', 'unit', 'usage', 'wallMs'].sort());
    assert.equal(l.suite, 'R');
    assert.deepEqual(l.taskIds, [R_TASKS[i].id]);
    assert.equal(l.arm, 'codex:gpt-6.1-sol');
    assert.equal(l.unit, 'codex');
    // What the unit reports it used: the model asked for, and the effort it paired it with.
    assert.equal(l.model, 'gpt-6.1-sol');
    assert.equal(l.effort, 'xhigh');
    assert.equal(l.run, 1);
    assert.equal(l.cli, 'codex 1.2.3');
    assert.ok(Number.isFinite(Date.parse(l.startedAt)));
    assert.ok(Number.isInteger(l.wallMs) && l.wallMs >= 0);
    assert.equal(l.ok, true);
    assert.match(l.answer, /^invented answer, prompt length \d+$/);
    assert.equal(l.error, null);
    assert.deepEqual(l.usage, { input: 120, output: 30, cachedInput: 20, reasoning: 7 });
    assert.notEqual(l.resultId, decoyId);
    assert.ok(existsSync(join(home, 'results', 'codex', `${l.resultId}.md`)));
  }
  // A second invocation continues the run numbering instead of writing a second "run 1".
  await runArm({ suite: 'R', arm: parseArm('codex:gpt-6.1-sol'), runs: 2, dir, env, now: () => now, out: quiet });
  assert.deepEqual(readLines(file).map((l) => l.run), [1, 1, 2, 2, 3, 3]);
});

test('a call whose unit reported no tokens is filed with usage null, not zero', async () => {
  const home = tmp('omelette-evals-home-');
  const dir = evalsDir({ R: R_TASKS.slice(0, 1) });
  const fake = fakeCodex(home, { usage: {} });
  const { file } = await runArm({ suite: 'R', arm: parseArm('codex:gpt-6.1-sol'), dir, env: baseEnv(home, { CODEX_BIN: fake }), out: quiet });
  const [l] = readLines(file);
  assert.equal(l.ok, true);
  assert.equal(l.usage, null);
});

test('V through the real codex server: the run happens in the snapshot, never in the live checkout', async () => {
  const home = tmp('omelette-evals-home-');
  const { repo, commit } = fixtureRepo();
  const dir = evalsDir({ V: [{ id: 'v1', commit, file: 'src/thing.js', prompt: 'Invented review brief: find the defects.' }] });
  const snapshot = join(tmp('omelette-evals-snap-'), commit);
  const fake = fakeCodex(home);
  const { file } = await runArm({ suite: 'V', arm: parseArm('codex:gpt-6.1-sol'), dir, repo, snapshot, env: baseEnv(home, { CODEX_BIN: fake }), out: quiet });
  const [l] = readLines(file);
  assert.equal(l.ok, true, l.error);
  const spooled = readFileSync(join(home, 'results', 'codex', `${l.resultId}.md`), 'utf8');
  assert.match(spooled, new RegExp(`^cwd: ${snapshot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.equal(existsSync(join(snapshot, '.git')), false);
});

test('a failed call is filed as failed, once — the runner never retries it', async () => {
  const home = tmp('omelette-evals-home-');
  const dir = evalsDir({ R: R_TASKS });
  const counter = join(home, 'calls');
  const serverPath = failingServer(home, counter);
  const fake = fakeCodex(home);
  const { file } = await runArm({ suite: 'R', arm: parseArm('codex:gpt-6.1-sol'), dir, serverPath, env: baseEnv(home, { CODEX_BIN: fake }), out: quiet });
  const lines = readLines(file);
  assert.equal(readFileSync(counter, 'utf8'), 'call\ncall\n', 'one tools/call per planned call');
  assert.deepEqual(lines.map((l) => [l.ok, l.error, l.usage]), [[false, 'invented failure', null], [false, 'invented failure', null]]);
});

test('a server that dies mid-call is a failed line with the transport\'s error, and the arm goes on', async () => {
  const home = tmp('omelette-evals-home-');
  const dir = evalsDir({ R: R_TASKS });
  const serverPath = join(home, 'dying-server.mjs');
  writeFileSync(serverPath, 'process.exit(3);\n');
  const { file } = await runArm({ suite: 'R', arm: parseArm('codex:gpt-6.1-sol'), dir, serverPath, env: baseEnv(home, { CODEX_BIN: fakeCodex(home) }), out: quiet });
  const lines = readLines(file);
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.equal(l.ok, false);
    assert.equal(l.answer, null);
    assert.match(l.error, /exited early/);
  }
});

test('--dry-run prints the plan of calls and makes none: no vendor run, no run file', () => {
  const home = tmp('omelette-evals-home-');
  const dir = evalsDir({ R: R_TASKS });
  const marker = join(home, 'vendor-ran');
  const fake = fakeCodex(home, { marker });
  const r = spawnSync(process.execPath, [SCRIPT, '--suite', 'R', '--arm', 'codex:gpt-6.1-sol', '--runs', '2', '--dir', dir, '--dry-run'], {
    encoding: 'utf8', cwd: home, env: baseEnv(home, { CODEX_BIN: fake }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(dir, 'runs')), false);
  assert.equal(existsSync(join(home, 'results')), false);
  const calls = r.stdout.split('\n').filter((l) => /codex_research/.test(l));
  assert.equal(calls.length, 4, r.stdout); // 2 questions × 2 runs
  // The plan names ids, never the task text.
  for (const t of R_TASKS) assert.ok(!r.stdout.includes(t.prompt));
});

test('usage errors exit 2 and run nothing', () => {
  const dir = evalsDir({ R: R_TASKS });
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: baseEnv(dir) });
  assert.equal(run(['--arm', 'codex:gpt-6.1-sol', '--dir', dir]).status, 2);           // no suite
  assert.equal(run(['--suite', 'R', '--dir', dir]).status, 2);                          // no arm
  assert.equal(run(['--suite', 'X', '--arm', 'codex:gpt-6.1-sol', '--dir', dir]).status, 2);
  assert.equal(run(['--suite', 'R', '--arm', 'codex:nope', '--dir', dir]).status, 2);
  assert.equal(run(['--suite', 'R', '--arm', 'codex:gpt-6.1-sol', '--runs', '0', '--dir', dir]).status, 2);
  assert.equal(run(['--suite', 'V', '--arm', 'codex:gpt-6.1-sol', '--batch', '--dir', dir]).status, 2);
  assert.equal(existsSync(join(dir, 'runs')), false);
  assert.deepEqual(readdirSync(dir), ['suites']);
});

test('the CLI version is the CLI\'s name and the first version token, never the raw line', async () => {
  const home = tmp('omelette-evals-version-');
  const fake = join(home, 'fake-agy');
  writeFileSync(fake, [
    `#!${process.execPath}`,
    'console.log("/opt/tools-2.1/bin/agy version 1.4.0-beta.2 (built from /Users/someone/src/agy-9.9)");',
  ].join('\n'));
  chmodSync(fake, 0o755);
  assert.equal(await cliVersion(UNITS.gemini, baseEnv(home, { AGY_BIN: fake })), 'agy 1.4.0-beta.2');
});
