// scripts/eval-run.mjs, tasks T1–T7 of docs/superpowers/plans/2026-11-19-evals-neon.md — the tester's tests.
// Every unit is a FAKE (a fake agy behind the real gemini server, or a fake MCP server) and every text below is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArm, runArm, touchedConversations } from '../scripts/eval-run.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'eval-run.mjs');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const quiet = () => {};
const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const baseEnv = (home, extra = {}) => ({ PATH: process.env.PATH, HOME: home, OMELETTE_HOME: home, OMELETTE_UPDATE_CHECK: '0', ...extra });

const TASKS = [
  { id: 'q1', prompt: 'Invented question one: what colour is the imaginary widget?' },
  { id: 'q2', prompt: 'Invented question two: when did the made-up release ship?' },
];

function evalsDir(tasks = TASKS) {
  const dir = tmp('omelette-tester-neon-a-');
  mkdirSync(join(dir, 'suites', 'R'), { recursive: true });
  writeFileSync(join(dir, 'suites', 'R', 'tasks.jsonl'), tasks.map((t) => JSON.stringify(t)).join('\n') + '\n');
  return dir;
}

/** The one run file an arm of suite R wrote today under `dir`. */
const runFile = (dir, arm) => {
  const day = readdirOne(join(dir, 'runs'));
  return join(dir, 'runs', day, `R-${arm.replace(/[^a-z0-9.]+/gi, '-').toLowerCase()}.jsonl`);
};
const readdirOne = (d) => { const [x, ...more] = readdirSync(d); assert.equal(more.length, 0); return x; };

/**
 * A fake MCP server for `tool`. Call number n (counted in `counter`, a file: each call is a new process) answers
 * `replies[min(n, last)]`; `ops` first act on the agy conversation store under $HOME, on the first call only when
 * `firstOnly`.
 */
let scripted = 0;
function scriptedServer(dir, { tool = 'gemini_research', replies, counter, ops = [], firstOnly = false }) {
  const p = join(dir, `scripted-${++scripted}.mjs`);
  writeFileSync(p, [
    'import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
    `const REPLIES = ${JSON.stringify(replies)}; const OPS = ${JSON.stringify(ops)}; const COUNTER = ${JSON.stringify(counter)};`,
    'let buf = ""; process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { buf += c; let nl; while ((nl = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; const m = JSON.parse(l);',
    '  if (m.id === 1) send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "f", version: "0" } } });',
    `  else if (m.id === 2) send({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: ${JSON.stringify(tool)}, description: "d", inputSchema: { type: "object" } }] } });`,
    '  else if (m.id === 3) {',
    '    const n = existsSync(COUNTER) ? readFileSync(COUNTER, "utf8").length : 0; appendFileSync(COUNTER, "x");',
    `    if (!${firstOnly ? 'true' : 'false'} || n === 0) {`,
    '      const store = join(process.env.HOME, ".gemini", "antigravity-cli", "conversations");',
    '      for (const o of OPS) { mkdirSync(store, { recursive: true }); if (o.op === "mkdir") mkdirSync(join(store, o.name), { recursive: true }); else appendFileSync(join(store, o.name), "x"); }',
    '    }',
    '    const r = REPLIES[Math.min(n, REPLIES.length - 1)];',
    '    send({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: r.text }], isError: !!r.isError } }); } } });',
  ].join('\n'));
  return p;
}

/** A fake `agy` for the REAL gemini server: `--version`, then one behaviour per `mode`, after touching one conversation's WAL. */
function fakeAgy(dir, mode) {
  const p = join(dir, `fake-agy-${mode}`);
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const fs = require("fs"); const path = require("path");',
    'const a = process.argv.slice(2);',
    'if (a[0] === "--version") { console.log("agy 9.9.9"); process.exit(0); }',
    'const d = path.join(process.env.HOME, ".gemini", "antigravity-cli", "conversations");',
    'fs.mkdirSync(d, { recursive: true });',
    'fs.appendFileSync(path.join(d, "00000000-0000-4000-8000-0000000000aa.db-wal"), "x");',
    `const mode = ${JSON.stringify(mode)};`,
    'if (mode === "exhausted") { process.stderr.write("429 RESOURCE_EXHAUSTED: invented bucket is empty\\n"); process.exit(1); }',
    'if (mode === "denied") { process.stderr.write("a tool required the \\"command\\" permission that headless mode cannot prompt for\\n"); process.exit(0); }',
    'if (mode === "timeout") { process.stdout.write(JSON.stringify({ status: "TIMEOUT", response: "" })); process.exit(0); }',
    'process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "An invented answer.", usage: { input_tokens: 5, output_tokens: 6 } }));',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

const OLD = 1577836800; // 2020-01-01, seconds
const aged = (path) => utimesSync(path, OLD, OLD);

// ─── T1 ──────────────────────────────────────────────────────────────────────

test('T1: a Gemini level word is read in any case, and a word that is not a level is refused by name', () => {
  assert.equal(parseArm('gemini:Gemini 4 Neon:High').model, 'Gemini 4 Neon (High)');
  assert.equal(parseArm('gemini:Gemini 4 Neon:XHIGH').model, 'Gemini 4 Neon (XHigh)');
  assert.equal(parseArm('gemini:Gemini 4 Hydrogen:LOW').model, 'Gemini 4 Hydrogen (Low)');
  assert.throws(() => parseArm('gemini:Gemini 4 Neon:max'), /unknown effort "max"/);
});

test('T1: a word that is a property name of the level table is refused by name too', () => {
  for (const word of ['constructor', 'toString']) {
    assert.throws(() => parseArm(`gemini:Gemini 4 Neon:${word}`), new RegExp(`unknown effort "${word}"`), word);
  }
});

// ─── T3 and T6 against the real gemini unit's own error texts ─────────────────

test('T3/T6 through the real gemini server and a fake agy: its quota error stops the arm; "no output" and a TIMEOUT envelope are filed empty and the arm goes on', async () => {
  const home = tmp('omelette-tester-neon-a-home-');
  const dir = evalsDir();
  const arm = parseArm('gemini:Claude Opus 5.5:high');

  const spent = await runArm({ suite: 'R', arm, runs: 2, dir, out: quiet, env: baseEnv(home, { AGY_BIN: fakeAgy(home, 'exhausted') }) });
  assert.equal(spent.lines.length, 1, 'the first exhausted call is the last call');
  assert.equal(spent.lines[0].ok, false);
  assert.equal(spent.lines[0].empty, false, 'a quota failure is a failure, not an empty answer');
  assert.deepEqual(spent.stopped, { after: ['q1'], left: 3 });
  assert.equal(readLines(spent.file).length, 1, 'nothing is written for a call that was not made');
  assert.deepEqual(spent.lines[0].agyConversations, ['00000000-0000-4000-8000-0000000000aa.db'], 'a failed call names the conversation it opened');

  const denied = await runArm({ suite: 'R', arm: parseArm('gemini:Gemini 4 Hydrogen:high'), dir, out: quiet, env: baseEnv(home, { AGY_BIN: fakeAgy(home, 'denied') }) });
  assert.equal(denied.stopped, null);
  assert.deepEqual(denied.lines.map((l) => [l.ok, l.empty]), [[false, true], [false, true]]);
  assert.match(denied.lines[0].error, /produced no output/);

  const slow = await runArm({ suite: 'R', arm: parseArm('gemini:Gemini 4 Neon:medium'), dir, out: quiet, env: baseEnv(home, { AGY_BIN: fakeAgy(home, 'timeout') }) });
  assert.equal(slow.stopped, null);
  assert.deepEqual(slow.lines.map((l) => [l.ok, l.empty]), [[false, true], [false, true]]);
  assert.match(slow.lines[0].error, /ended with no answer/);
});

// ─── T4: the layout of agy's conversation store ──────────────────────────────

test('T4: a database touched alone, a WAL touched alone, a new -journal or -shm, a new database; a directory, an untouched file and a file only beside its WAL are not', async () => {
  const home = tmp('omelette-tester-neon-a-home-');
  const store = join(home, '.gemini', 'antigravity-cli', 'conversations');
  mkdirSync(store, { recursive: true });
  for (const n of ['A.db', 'A.db-wal', 'B.db', 'B.db-wal', 'C.db', 'C.db-shm']) { writeFileSync(join(store, n), 'old'); aged(join(store, n)); }
  const dir = evalsDir(TASKS.slice(0, 1));
  const server = scriptedServer(home, {
    counter: join(home, 'n'), replies: [{ text: 'An invented answer.' }],
    ops: [{ op: 'append', name: 'A.db' }, { op: 'append', name: 'B.db-wal' }, { op: 'append', name: 'E.db-journal' }, { op: 'append', name: 'F.db-shm' },
      { op: 'mkdir', name: 'G.db' }, { op: 'append', name: 'H.db' }],
  });
  const { lines } = await runArm({ suite: 'R', arm: parseArm('gemini:Gemini 4 Hydrogen:high'), dir, serverPath: server, env: baseEnv(home, { AGY_BIN: fakeAgy(home, 'ok') }), out: quiet });
  assert.deepEqual(lines[0].agyConversations, ['A.db', 'B.db', 'E.db', 'F.db', 'H.db']);
});

test('T4: no store at all is an empty list, not null; a failed call and each call are judged by what that call wrote', async () => {
  const home = tmp('omelette-tester-neon-a-home-');
  const dir = evalsDir();
  const env = baseEnv(home, { AGY_BIN: fakeAgy(home, 'ok') });
  const arm = parseArm('gemini:Gemini 4 Hydrogen:high');
  const none = await runArm({ suite: 'R', arm, dir, env, out: quiet, serverPath: scriptedServer(home, { counter: join(home, 'n0'), replies: [{ text: 'An invented answer.' }] }) });
  assert.deepEqual(none.lines.map((l) => l.agyConversations), [[], []]);
  assert.equal(existsSync(join(home, '.gemini')), false, 'the runner makes no store of its own');

  // The first call writes a conversation and fails; the second writes nothing.
  const server = scriptedServer(home, {
    counter: join(home, 'n1'), firstOnly: true, ops: [{ op: 'append', name: 'X.db' }],
    replies: [{ text: 'invented failure', isError: true }, { text: 'An invented answer.' }],
  });
  const two = await runArm({ suite: 'R', arm, dir, env, out: quiet, serverPath: server });
  assert.deepEqual(two.lines.map((l) => [l.ok, l.agyConversations]), [[false, ['X.db']], [true, []]]);
});

test('T4: touchedConversations returns new and later-written names, sorted, and ignores one that is gone', () => {
  assert.deepEqual(touchedConversations({ a: 1, b: 2, gone: 5 }, { c: 0, b: 3, a: 1, d: 1 }), ['b', 'c', 'd']);
});

// ─── T5 ──────────────────────────────────────────────────────────────────────

const THREE = [...TASKS, { id: 'q3', prompt: 'Invented question three: which imaginary port?' }];

test('T5: run numbers follow each task through a file that holds lines for some tasks and not others; a batch numbers by its own task set; a repeated id runs once', async () => {
  const home = tmp('omelette-tester-neon-a-home-');
  const dir = evalsDir(THREE);
  const arm = parseArm('codex:gpt-6.1-sol');
  const run = (extra) => runArm({ suite: 'R', arm, dir, out: quiet, env: baseEnv(home, { CODEX_BIN: '/nonexistent/codex' }), ...extra });
  const ok = (counter) => scriptedServer(home, { tool: 'codex_research', counter: join(home, counter), replies: [{ text: 'An invented answer.' }] });
  const pairs = (r) => r.lines.map((l) => [l.taskIds.join('+'), l.run]);

  assert.deepEqual(pairs(await run({ only: ['q3', 'q1', 'q3'], runs: 2, serverPath: ok('a') })), [['q1', 1], ['q3', 1], ['q1', 2], ['q3', 2]], 'suite order, a repeated id once');
  assert.deepEqual(pairs(await run({ runs: 2, serverPath: ok('b') })), [['q1', 3], ['q2', 1], ['q3', 3], ['q1', 4], ['q2', 2], ['q3', 4]]);
  assert.deepEqual(pairs(await run({ batch: true, only: ['q1', 'q2'], serverPath: ok('c') })), [['q1+q2', 1]]);
  assert.deepEqual(pairs(await run({ batch: true, only: ['q1', 'q2'], serverPath: ok('d') })), [['q1+q2', 2]]);
  assert.deepEqual(pairs(await run({ batch: true, serverPath: ok('e') })), [['q1+q2+q3', 1]]);
  assert.equal(readLines(runFile(dir, arm.arm)).length, 4 + 6 + 1 + 1 + 1);
});

test('T5: an unknown id stops the run before any call or file; the CLI says so and exits 1, with or without --dry-run', () => {
  const home = tmp('omelette-tester-neon-a-home-');
  const dir = evalsDir(THREE);
  for (const extra of [[], ['--dry-run']]) {
    const r = spawnSync(process.execPath, [SCRIPT, '--suite', 'R', '--arm', 'codex:gpt-6.1-sol', '--task', 'q1', '--task', 'q9', '--dir', dir, ...extra],
      { encoding: 'utf8', cwd: home, env: baseEnv(home, { CODEX_BIN: '/nonexistent/codex' }), timeout: 5000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no task q9/);
    assert.equal(r.stdout.includes('q1'), false, 'nothing of the valid id was planned either');
  }
  assert.equal(existsSync(join(dir, 'runs')), false, 'no run directory made');
});

test('T5: a dry run numbers each task from the file as it stands', async () => {
  const home = tmp('omelette-tester-neon-a-home-');
  const dir = evalsDir(THREE);
  const arm = parseArm('codex:gpt-6.1-sol');
  await runArm({ suite: 'R', arm, dir, only: ['q1'], out: quiet, env: baseEnv(home, { CODEX_BIN: '/nonexistent/codex' }),
    serverPath: scriptedServer(home, { tool: 'codex_research', counter: join(home, 'n'), replies: [{ text: 'An invented answer.' }] }) });
  const r = spawnSync(process.execPath, [SCRIPT, '--suite', 'R', '--arm', arm.arm, '--dir', dir, '--dry-run'], { encoding: 'utf8', cwd: home, env: baseEnv(home), timeout: 5000 });
  assert.equal(r.status, 0, r.stderr);
  const planned = r.stdout.split('\n').filter((l) => /codex_research/.test(l)).map((l) => /run (\d+) {2}(q\d)/.exec(l).slice(1, 3).join(':'));
  assert.deepEqual(planned, ['2:q1', '1:q2', '1:q3']);
});

// ─── T6 ──────────────────────────────────────────────────────────────────────

test('T6: only a FAILED call stops the arm — an answer about quotas, and a failure that is not the quota, go on', async () => {
  const home = tmp('omelette-tester-neon-a-home-');
  const dir = evalsDir();
  const env = baseEnv(home, { CODEX_BIN: '/nonexistent/codex' });
  const arm = parseArm('codex:gpt-6.1-sol');
  const talk = await runArm({ suite: 'R', arm, runs: 2, dir, env, out: quiet,
    serverPath: scriptedServer(home, { tool: 'codex_research', counter: join(home, 'a'), replies: [{ text: 'Antigravity says RESOURCE_EXHAUSTED when a Claude quota exhausted is reported.' }] }) });
  assert.equal(talk.lines.length, 4);
  assert.equal(talk.stopped, null);
  const other = await runArm({ suite: 'R', arm, runs: 2, dir, env, out: quiet,
    serverPath: scriptedServer(home, { tool: 'codex_research', counter: join(home, 'b'), replies: [{ text: 'an invented failure that is not about the bucket', isError: true }] }) });
  assert.equal(other.lines.length, 4);
  assert.equal(other.stopped, null);
});

test('T6: the stop counts the calls this invocation did not make — a later pass, a file that already holds lines — and every spelling of the quota stops it', async () => {
  const home = tmp('omelette-tester-neon-a-home-');
  const dir = evalsDir(THREE);
  const env = baseEnv(home, { CODEX_BIN: '/nonexistent/codex' });
  const arm = parseArm('codex:gpt-6.1-sol');
  const server = (counter, replies) => scriptedServer(home, { tool: 'codex_research', counter: join(home, counter), replies });
  // q1 already holds runs 1–4 in the file.
  await runArm({ suite: 'R', arm, only: ['q1'], runs: 4, dir, env, out: quiet, serverPath: server('seed', [{ text: 'An invented answer.' }]) });
  const out = [];
  const r = await runArm({ suite: 'R', arm, runs: 2, dir, env, out: (l) => out.push(l),
    serverPath: server('one', [{ text: 'An invented answer.' }, { text: 'Error: 429 resource_exhausted', isError: true }]) });
  assert.deepEqual(r.lines.map((l) => [l.taskIds[0], l.run, l.ok]), [['q1', 5, true], ['q2', 1, false]]);
  assert.deepEqual(r.stopped, { after: ['q2'], left: 4 });
  assert.ok(out.some((l) => /stopped/.test(l) && /4 call/.test(l)), out.join('\n'));
  // A second pass: the first pass runs whole, the stop falls on pass 2's first call.
  const r2 = await runArm({ suite: 'R', arm, runs: 2, dir, env, out: quiet,
    serverPath: server('two', [{ text: 'ok' }, { text: 'ok' }, { text: 'ok' }, { text: 'Gemini quota exhausted — the invented bucket is empty', isError: true }]) });
  assert.deepEqual(r2.lines.map((l) => l.ok), [true, true, true, false]);
  assert.deepEqual(r2.stopped, { after: ['q1'], left: 2 });
});

test('T6: the CLI reports the calls not made, through the real gemini server', () => {
  const home = tmp('omelette-tester-neon-a-home-');
  const dir = evalsDir(THREE);
  const r = spawnSync(process.execPath, [SCRIPT, '--suite', 'R', '--arm', 'gemini:Claude Opus 5.5:high', '--dir', dir],
    { encoding: 'utf8', cwd: home, env: baseEnv(home, { AGY_BIN: fakeAgy(home, 'exhausted') }), timeout: 5000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /stopped: the quota is exhausted after q1 — 2 call\(s\) not made/);
  assert.match(r.stdout, /1 call\(s\), 1 failed, 2 not made \(quota\)/);
});

// ─── T1: the effort chart's four columns lie inside the panel ───────────────

test('T1: the four effort columns are evenly spaced and all inside the panel the gridlines span, both panels', async () => {
  const { renderCharts } = await import('../scripts/eval-chart.mjs');
  const arm = (suite, level, v) => ({
    suite, arm: `gemini:Gemini 4 Neon (${level})`, unit: 'gemini', model: `Gemini 4 Neon (${level})`, effort: level.toLowerCase(), cli: ['agy 9.1.0'], batch: false,
    ...(suite === 'R'
      ? { tasks: 10, n: 1, runs: [{ run: 1, correct: v, partly: 0, wrong: 0, noAnswer: 0, trap: null, failed: 0, wallMs: 1000, tokens: 10 }], mean: { correct: v, inventedUrls: 0, partly: 0, wrong: 0, noAnswer: 0, trapPassed: null, failed: 0, wallMs: 1000, tokens: 10 } }
      : { keyItems: 7, n: 1, runs: [{ run: 1, recall: v / 10, precision: 1, wallMs: 1000, tokens: 10 }], mean: { recall: v / 10, precision: 1, wallMs: 1000, tokens: 10 } }),
    overturned: 0,
  });
  const arms = ['Low', 'Medium', 'High', 'XHigh'].flatMap((l, i) => [arm('R', l, 5 + i), arm('V', l, 3 + i)]);
  const svg = renderCharts({ date: '2026-11-20', grades: 0, overturned: 0, arms })['effort.svg'];
  const attrsOf = (tag, cls) => [...svg.matchAll(new RegExp(`<${tag}\\s([^>]*?)/?>`, 'g'))]
    .map((m) => Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])))
    .filter((a) => (a.class || '').split(/\s+/).includes(cls));
  const plots = attrsOf('g', 'plot');
  const bases = attrsOf('line', 'base');
  assert.equal(plots.length, 2);
  assert.equal(bases.length, 2);
  plots.forEach((p, k) => {
    const cols = ['low', 'medium', 'high', 'xhigh'].map((l) => Number(p[`data-x-${l}`]));
    const [x1, x2] = [Number(bases[k].x1), Number(bases[k].x2)];
    assert.ok(cols[0] > x1 && cols[3] < x2, `panel ${p['data-suite']}: columns ${cols} inside ${x1}–${x2}`);
    const steps = cols.slice(1).map((c, i) => c - cols[i]);
    assert.ok(Math.max(...steps) - Math.min(...steps) < 0.6, `even steps: ${steps}`);
  });
  assert.ok(Number(plots[0]['data-x-xhigh']) < Number(plots[1]['data-x-low']), 'the R panel\'s last column stays left of the V panel\'s first');
});
