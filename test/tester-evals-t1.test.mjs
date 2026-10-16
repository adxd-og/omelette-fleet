// Tester's additions for the evals MVP (Tasks 1-3), written from the spec and plan without the implementer's
// summary. Each test pins behaviour through an exported function or a CLI, and exists to kill a mutant the
// implementer's tests left alive or to pin a defect the spec requires fixed. Every task, answer and key is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderResult } from '../core/results.mjs';
import { findCallRecord, ensureSnapshot, parseArm, runArm } from '../scripts/eval-run.mjs';
import { aggregate, redact, redactionTerms } from '../scripts/eval-blind.mjs';
import { renderCharts } from '../scripts/eval-chart.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BLIND = join(ROOT, 'scripts', 'eval-blind.mjs');
const CHART = join(ROOT, 'scripts', 'eval-chart.mjs');
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const quiet = () => {};
const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const baseEnv = (home, extra = {}) => ({ PATH: process.env.PATH, HOME: home, OMELETTE_HOME: home, OMELETTE_UPDATE_CHECK: '0', ...extra });

function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: join(cwd, 'nope'), GIT_CONFIG_SYSTEM: join(cwd, 'nope'),
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function fixtureRepo() {
  const repo = tmp('t1-repo-');
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
function evalsDir(suites) {
  const dir = tmp('t1-evals-');
  for (const [suite, tasks] of Object.entries(suites)) {
    mkdirSync(join(dir, 'suites', suite), { recursive: true });
    writeFileSync(join(dir, 'suites', suite, 'tasks.jsonl'), tasks.map((t) => JSON.stringify(t)).join('\n') + '\n');
  }
  return dir;
}

// ─── a call is matched to its own spool record, and to no other ──────────────

const stampOf = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
function spool(home, { pid, seq = 1, tool = 'codex_research', startedAt, usage }) {
  const resultId = `${stampOf(new Date(startedAt))}-${pid}-${seq}`;
  mkdirSync(join(home, 'results', 'codex'), { recursive: true });
  writeFileSync(join(home, 'results', 'codex', `${resultId}.md`), renderResult({
    unit: 'codex', tool, resultId, model: 'gpt-6.1-sol', effort: 'xhigh', usage, startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(new Date(startedAt).getTime() + 500).toISOString(), durationMs: 500, status: 'ok', text: 'invented',
  }));
  return resultId;
}

test('findCallRecord: the pid, the tool and a start no earlier than the call decide, and anything but exactly one hit is null', () => {
  const home = tmp('t1-home-');
  const t0 = Date.now();
  const find = (over = {}) => findCallRecord({ home, unit: 'codex', pid: 4242, tool: 'codex_research', sinceMs: t0, ...over });

  // Nothing filed yet.
  assert.equal(find(), null);
  // The same pid reused by an earlier process: a record from an hour before the call is not this call's.
  spool(home, { pid: 4242, startedAt: t0 - 3600_000, usage: { input: 1, output: 1 } });
  assert.equal(find(), null, 'a record from before the call');
  // Another tool under the same pid, started after the call: not ours either.
  spool(home, { pid: 4242, seq: 2, tool: 'codex_code_review', startedAt: t0 + 100, usage: { input: 2, output: 2 } });
  assert.equal(find(), null, 'another tool');
  // Another pid, same tool, same instant.
  spool(home, { pid: 4243, startedAt: t0 + 100, usage: { input: 3, output: 3 } });
  assert.equal(find(), null, 'another pid');
  // Ours.
  const ours = spool(home, { pid: 4242, seq: 3, startedAt: t0 + 100, usage: { input: 7, output: 8 } });
  const got = find();
  assert.equal(got.resultId, ours);
  assert.deepEqual(got.usage, { input: 7, output: 8 });
  assert.equal(got.model, 'gpt-6.1-sol');
  // The pid 42420 must not match 4242 (an id is split, not searched for a substring).
  assert.equal(find({ pid: 424 }), null);
  // Two records for one pid and tool after the call: ambiguous is null, never "the newest".
  spool(home, { pid: 4242, seq: 4, startedAt: t0 + 200, usage: { input: 9, output: 9 } });
  assert.equal(find(), null, 'ambiguous');
  // No pid, no match.
  assert.equal(find({ pid: undefined }), null);
});

test('two arms calling at once under one home each get their own usage, never a neighbour\'s', async () => {
  const home = tmp('t1-home-');
  const fake = join(home, 'fake-codex');
  // Usage = the prompt's own length, and the answer says it, so a swapped record shows.
  writeFileSync(fake, [
    `#!${process.execPath}`,
    'const a = process.argv.slice(2);',
    'if (a[0] === "--version") { console.log("fake-codex 1.0"); process.exit(0); }',
    'let s = ""; process.stdin.on("data", (c) => { s += c; }).on("end", () => {',
    '  const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    '  setTimeout(() => {',
    '    line({ type: "item.completed", item: { type: "agent_message", text: "len=" + s.length } });',
    '    line({ type: "turn.completed", usage: { input_tokens: s.length, output_tokens: s.length } });',
    '  }, 300);',
    '});',
  ].join('\n'));
  chmodSync(fake, 0o755);
  const env = baseEnv(home, { CODEX_BIN: fake });
  const mk = (n) => evalsDir({ R: Array.from({ length: 3 }, (_, i) => ({ id: `q${i}`, prompt: `Invented question ${i} ${'x'.repeat(n + i * 37)}` })) });
  const now = () => new Date(2026, 9, 16, 12);
  const [a, b] = await Promise.all([
    runArm({ suite: 'R', arm: parseArm('codex:gpt-6.1-sol'), dir: mk(10), env, now, out: quiet }),
    runArm({ suite: 'R', arm: parseArm('codex:gpt-6-astra'), dir: mk(500), env, now, out: quiet }),
  ]);
  for (const { lines } of [a, b]) {
    assert.equal(lines.length, 3);
    for (const l of lines) {
      const len = Number(/len=(\d+)/.exec(l.answer)[1]);
      assert.deepEqual(l.usage, { input: len, output: len }, `${l.arm} ${l.taskIds}`);
    }
  }
  assert.deepEqual(a.lines.map((l) => l.model), ['gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6.1-sol']);
  assert.deepEqual(b.lines.map((l) => l.model), ['gpt-6-astra', 'gpt-6-astra', 'gpt-6-astra']);
});

// ─── the V snapshot ──────────────────────────────────────────────────────────

test('a snapshot already on disk is checked too: a directory inside a work tree is refused, one outside is reused', () => {
  const { repo, commit } = fixtureRepo();
  const inside = join(repo, 'build', 'snap');
  mkdirSync(inside, { recursive: true });
  writeFileSync(join(inside, 'a.js'), 'x');
  assert.throws(() => ensureSnapshot({ repo, commit, path: inside }), /history|repository/);
  // A gemini-style extraction (no guard) may sit anywhere, because nothing reviews in it.
  assert.equal(ensureSnapshot({ repo, commit, path: inside, guard: false }), inside);
  // A .git that is a file (a linked work tree's pointer) or a link is still a .git.
  const outside = join(tmp('t1-snap-'), 'snap');
  mkdirSync(outside);
  writeFileSync(join(outside, '.git'), 'gitdir: /nowhere\n');
  assert.throws(() => ensureSnapshot({ repo, commit, path: outside }), /\.git/);
});

test('V by default extracts under the temp dir, outside every work tree, and reviews there; the later fix is not in it', async () => {
  const home = tmp('t1-home-');
  const { repo, commit } = fixtureRepo();
  const fakeTmp = tmp('t1-tmpdir-');
  const dir = evalsDir({ V: [{ id: 'v1', commit, file: 'src/thing.js', prompt: 'Invented review brief.' }] });
  const fake = join(home, 'fake-codex');
  writeFileSync(fake, [`#!${process.execPath}`, 'const a = process.argv.slice(2);',
    'if (a[0] === "--version") { console.log("fake 1"); process.exit(0); }',
    'let s = ""; process.stdin.on("data", (c) => { s += c; }).on("end", () => { process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok " + process.cwd() } }) + "\\n"); });'].join('\n'));
  chmodSync(fake, 0o755);
  const was = process.env.TMPDIR;
  process.env.TMPDIR = fakeTmp;
  try {
    const { lines } = await runArm({ suite: 'V', arm: parseArm('codex:gpt-6.1-sol'), dir, repo, env: baseEnv(home, { CODEX_BIN: fake }), out: quiet });
    assert.equal(lines[0].ok, true, lines[0].error);
    const snap = join(fakeTmp, 'omelette-evals', 'snapshots', commit);
    assert.equal(readFileSync(join(snap, 'src', 'thing.js'), 'utf8').includes('reviewed state'), true);
    assert.equal(existsSync(join(snap, '.git')), false);
    const spooled = readFileSync(join(home, 'results', 'codex', `${lines[0].resultId}.md`), 'utf8');
    assert.match(spooled, /^cwd: .*omelette-evals\/snapshots\//m);
  } finally {
    if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
  }
});

test('V with a temp dir that sits inside a work tree is refused before any call is made', async () => {
  const home = tmp('t1-home-');
  const { repo, commit } = fixtureRepo();
  const dir = evalsDir({ V: [{ id: 'v1', commit, file: 'src/thing.js', prompt: 'Invented review brief.' }] });
  const marker = join(home, 'ran');
  const fake = join(home, 'fake-codex');
  writeFileSync(fake, [`#!${process.execPath}`, `require("fs").appendFileSync(${JSON.stringify(marker)}, "x");`, 'console.log("fake 1");'].join('\n'));
  chmodSync(fake, 0o755);
  const was = process.env.TMPDIR;
  process.env.TMPDIR = join(repo, 'tmp');
  mkdirSync(process.env.TMPDIR);
  try {
    await assert.rejects(runArm({ suite: 'V', arm: parseArm('codex:gpt-6.1-sol'), dir, repo, env: baseEnv(home, { CODEX_BIN: fake }), out: quiet }), /history|repository/);
  } finally {
    if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was;
  }
  assert.equal(existsSync(marker), false, 'no vendor run');
});

test('V on Gemini: the brief carries the file as it stood at the commit, not the later state', async () => {
  const home = tmp('t1-home-');
  const { repo, commit } = fixtureRepo();
  const dir = evalsDir({ V: [{ id: 'v1', commit, file: 'src/thing.js', prompt: 'Invented review brief.' }] });
  const server = join(home, 'echo-server.mjs');
  writeFileSync(server, [
    'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
    'let buf = ""; process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { buf += c; let nl; while ((nl = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; const m = JSON.parse(l);',
    '  if (m.id === 1) send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "f", version: "0" } } });',
    '  else if (m.id === 2) send({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "gemini_research", description: "d", inputSchema: { type: "object" } }] } });',
    '  else if (m.id === 3) send({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: JSON.stringify(m.params.arguments) }] } }); } });',
  ].join('\n'));
  const snapshot = join(tmp('t1-snap-'), commit);
  const { lines } = await runArm({ suite: 'V', arm: parseArm('gemini:Gemini 3.8 Flash:low'), dir, repo, snapshot, serverPath: server, env: baseEnv(home), out: quiet });
  const sent = JSON.parse(lines[0].answer);
  assert.equal(sent.model, 'Gemini 3.8 Flash (Low)');
  assert.equal(sent.cwd, undefined);
  assert.ok(sent.prompt.includes('the reviewed state'));
  assert.ok(!sent.prompt.includes('the later fix'));
  assert.equal(existsSync(join(snapshot, '.git')), false);
});

// ─── aggregate → chart, through the CLIs, on a failed call ───────────────────

function writeRun(dir, date, name, lines) {
  mkdirSync(join(dir, 'runs', date), { recursive: true });
  writeFileSync(join(dir, 'runs', date, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
const rl = (over) => ({
  suite: 'V', taskIds: ['v1'], arm: 'codex:gpt-6.1-sol', unit: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', run: 1, cli: 'fake-codex 1.0',
  startedAt: '2026-10-16T10:00:00.000Z', wallMs: 4000, ok: true, answer: 'Invented finding.', error: null, usage: { input: 10, output: 20 }, resultId: null, ...over,
});

test('end to end: a failed call is never put to the grader, is counted failed, and every chart number is the aggregate\'s', () => {
  const dir = tmp('t1-e2e-');
  const date = '2026-10-16';
  writeRun(dir, date, 'V-codex-gpt-6.1-sol.jsonl', [
    rl({ run: 1, answer: 'Invented finding one.' }),
    rl({ run: 2, answer: 'Invented finding two.' }),
    rl({ run: 3, ok: false, answer: null, error: 'invented transport failure', usage: null }),
  ]);
  mkdirSync(join(dir, 'suites', 'V'), { recursive: true });
  writeFileSync(join(dir, 'suites', 'V', 'key.jsonl'), ['k1', 'k2', 'k3', 'k4'].map((id) => JSON.stringify({ id, defect: 'invented defect text for this test' })).join('\n') + '\n');
  assert.equal(spawnSync(process.execPath, [BLIND, '--date', date, '--dir', dir, '--seed', '5'], { encoding: 'utf8' }).status, 0);
  const g = join(dir, 'grading', date);
  const blinded = readLines(join(g, 'blinded.jsonl'));
  assert.equal(blinded.length, 2, 'the failed call is not in front of the grader');
  const mapping = JSON.parse(readFileSync(join(g, 'mapping.json'), 'utf8'));
  const idOf = (run) => Object.entries(mapping.blinds).find(([, v]) => v.run === run)[0];
  const grades = [
    ...['k1', 'k2'].map((k) => ({ blindId: idOf(1), taskId: 'v1', item: 'key', keyId: k, grade: 'found' })),
    ...['k3', 'k4'].map((k) => ({ blindId: idOf(1), taskId: 'v1', item: 'key', keyId: k, grade: 'not' })),
    ...['k1', 'k2', 'k3', 'k4'].map((k) => ({ blindId: idOf(2), taskId: 'v1', item: 'key', keyId: k, grade: k === 'k1' ? 'found' : 'not' })),
    { blindId: idOf(2), taskId: 'v1', item: 'finding', finding: 'invented', grade: 'false' },
  ];
  writeFileSync(join(g, 'grades.jsonl'), grades.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const ag = spawnSync(process.execPath, [BLIND, '--date', date, '--aggregate', '--dir', dir], { encoding: 'utf8' });
  assert.equal(ag.status, 0, ag.stderr);
  const agg = JSON.parse(readFileSync(join(dir, 'aggregates', `${date}.json`), 'utf8'));
  const arm = agg.arms[0];
  assert.equal(arm.n, 3);
  assert.deepEqual(arm.runs.map((r) => [r.run, r.found, r.failed]), [[1, 2, 0], [2, 1, 0], [3, null, 1]]);
  assert.equal(arm.runs[0].recall, 0.5);
  assert.equal(arm.runs[1].precision, 0.5);       // 1 key found over 1 + 1 false
  assert.equal(arm.runs[2].precision, null);      // no findings, no precision
  assert.equal(arm.mean.failed, 1 / 3);

  const out = tmp('t1-charts-');
  const cr = spawnSync(process.execPath, [CHART, '--date', date, '--dir', dir, '--out', out], { encoding: 'utf8' });
  assert.equal(cr.status, 0, cr.stderr);
  const svg = readFileSync(join(out, 'v-recall-precision.svg'), 'utf8');
  const dots = [...svg.matchAll(/<circle [^>]*data-series="recall"[^>]*data-run="(\d)"[^>]*data-value="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  // Ruling (session, 2026-10-16): a failed run has no score; it is a hollow marker, not a dot at 0.
  assert.deepEqual(dots, arm.runs.filter((r) => r.recall !== null).map((r) => [r.run, r.recall * 100]));
  assert.equal([...svg.matchAll(/<circle class="failed-run[^>]*data-series="recall"/g)].length, 1, 'the failed run is one hollow marker in the recall series');
  const bar = /<path [^>]*data-series="recall"[^>]*data-value="([\d.]+)"/.exec(svg);
  assert.ok(Math.abs(Number(bar[1]) - arm.mean.recall * 100) < 1e-4);
  for (const s of Object.values(renderCharts(agg))) assert.ok(!/NaN|undefined|Infinity|null %/.test(s));
});

test('a chart built from a hostile arm name or CLI string stays inert, and null means draw no NaN', () => {
  const evil = '"><script>alert(1)</script>&';
  const agg = {
    date: '2026-10-16', grades: 0, overturned: 0,
    arms: [{
      suite: 'R', arm: `gemini:${evil}`, unit: 'gemini', model: evil, effort: null, cli: [evil], batch: true, tasks: 10, n: 1,
      runs: [{ run: 1, correct: 0, partly: 0, wrong: 0, noAnswer: 0, inventedUrls: 0, failed: 10, trap: null, wallMs: null, tokens: null }],
      mean: { correct: 0, partly: 0, wrong: 0, noAnswer: 0, inventedUrls: 0, trapPassed: null, failed: 10, wallMs: null, tokens: null },
      overturned: 0,
    }],
  };
  for (const [name, svg] of Object.entries(renderCharts(agg))) {
    assert.ok(!svg.includes('<script'), name);
    assert.ok(!/NaN|undefined|Infinity/.test(svg), name);
  }
});

// ─── the aggregate on arithmetic the fixtures did not reach ───────────────────

test('aggregate: a grade overturned to "not" and a finding overturned to "false" leave the key and precision', () => {
  const b = (run) => ({ suite: 'V', arm: 'codex:gpt-6.1-sol', run, taskIds: ['v1'], unit: 'codex', model: 'm', effort: 'xhigh', cli: 'c', wallMs: 1, usage: null });
  const mapping = { date: 'd', blinds: { b1: b(1) }, failed: [] };
  const keys = { R: [], V: ['k1', 'k2'].map((id) => ({ id })) };
  const k = (keyId, grade, extra = {}) => ({ blindId: 'b1', taskId: 'v1', item: 'key', keyId, grade, ...extra });
  const f = (grade, extra = {}) => ({ blindId: 'b1', taskId: 'v1', item: 'finding', finding: 'x', grade, ...extra });
  const a = aggregate({
    grades: [k('k1', 'found', { overturned: { from: 'found', to: 'not' } }), k('k2', 'found'), f('plausible-new', { verified: true, overturned: { from: 'plausible-new', to: 'false' } }), f('plausible-new', { verified: true }), f('plausible-new')],
    mapping, keys,
  });
  const run = a.arms[0].runs[0];
  assert.equal(run.found, 1);
  assert.equal(run.recall, 0.5);
  assert.equal(run.verifiedNew, 1);
  assert.equal(run.unverifiedNew, 1);
  assert.equal(run.falseFindings, 1);
  assert.equal(run.findings, 4);                 // 1 key + 3 extra
  assert.equal(run.precision, 2 / 4);            // (1 key + 1 verified) / 4
  assert.equal(a.overturned, 2);
});

test('aggregate: the trap fails when ANY trap question in the run is not correct, and an overturned URL grade counts by its final value', () => {
  const b = (id, taskIds) => ({ suite: 'R', arm: 'codex:gpt-6.1-sol', run: 1, taskIds, unit: 'codex', model: 'm', effort: 'xhigh', cli: 'c', wallMs: 1, usage: null });
  const mapping = { date: 'd', blinds: { b1: b('b1', ['t1', 't2', 'q3']) }, failed: [] };
  const keys = { R: [{ id: 't1', trap: true }, { id: 't2', trap: true }, { id: 'q3' }], V: [] };
  const ans = (taskId, grade) => ({ blindId: 'b1', taskId, item: 'answer', grade });
  const url = (grade, extra = {}) => ({ blindId: 'b1', taskId: 'q3', item: 'url', url: 'https://example.invalid/x', grade, ...extra });
  const run = (grades) => aggregate({ grades, mapping, keys }).arms[0].runs[0];
  assert.equal(run([ans('t1', 'correct'), ans('t2', 'wrong'), ans('q3', 'correct')]).trap, 'failed');
  assert.equal(run([ans('t1', 'correct'), ans('t2', 'correct'), ans('q3', 'wrong')]).trap, 'passed');
  const r = run([
    ans('t1', 'correct'), ans('t2', 'correct'), ans('q3', 'correct'),
    url('unreachable-or-invented', { overturned: { from: 'unreachable-or-invented', to: 'supports' } }),
    url('unreachable-or-invented'),
  ]);
  assert.equal(r.urls, 2);
  assert.equal(r.inventedUrls, 1);
  const r2 = run([ans('t1', 'correct'), ans('t2', 'correct'), ans('q3', 'correct'),
    url('supports', { overturned: { from: 'supports', to: 'unreachable-or-invented' } })]);
  assert.equal(r2.inventedUrls, 1);
});

test('redaction never reaches into a longer word, at either end', () => {
  const out = redact('A parasol, a Hogrok, the flashback, a codexes list', redactionTerms());
  assert.equal(out, 'A parasol, a Hogrok, the flashback, a codexes list');
});

test('git variables in the caller\'s environment neither redirect the snapshot nor hide a work tree from the guard', () => {
  const { repo, commit } = fixtureRepo();
  const other = fixtureRepo().repo;
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    // GIT_DIR pointing elsewhere: the archive still comes from `repo`, and the guard does not take the other repository for a leak.
    process.env.GIT_DIR = join(other, '.git');
    const path = join(tmp('t1-snap-'), commit);
    ensureSnapshot({ repo, commit, path });
    assert.ok(readFileSync(join(path, 'src', 'thing.js'), 'utf8').includes('reviewed state'));
    delete process.env.GIT_DIR;
    // A ceiling at the work tree would stop git walking up from a subdirectory; the guard must not honour it.
    process.env.GIT_CEILING_DIRECTORIES = repo;
    const inside = join(repo, 'deep', 'snap');
    mkdirSync(inside, { recursive: true });
    assert.throws(() => ensureSnapshot({ repo, commit, path: inside }), /history|repository/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the line records the model and the effort the unit reports it used, not the ones the arm asked for', async () => {
  const home = tmp('t1-home-');
  const dir = evalsDir({ R: [{ id: 'q1', prompt: 'Invented question.' }] });
  const results = join(ROOT, 'core', 'results.mjs');
  const server = join(home, 'recording-server.mjs');
  // A fake server that files its own spool record, as a unit does: the model and effort IT used.
  writeFileSync(server, [
    `import { renderResult } from ${JSON.stringify(results)};`,
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
    'let buf = ""; process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { buf += c; let nl; while ((nl = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!l) continue; const m = JSON.parse(l);',
    '  if (m.id === 1) send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "f", version: "0" } } });',
    '  else if (m.id === 2) send({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "gemini_research", description: "d", inputSchema: { type: "object" } }, { name: "codex_research", description: "d", inputSchema: { type: "object" } }] } });',
    '  else if (m.id === 3) {',
    '    const tool = m.params.name; const unit = tool.split("_")[0];',
    '    const now = new Date(); const resultId = now.toISOString().replace(/[-:]/g, "").replace(/\\.\\d+Z$/, "Z") + "-" + process.pid + "-1";',
    '    const rec = unit === "gemini" ? { model: "Gemini 3.8 Flash (Medium)" } : { model: "gpt-6.1-sol", effort: "xhigh" };',
    '    mkdirSync(join(process.env.OMELETTE_HOME, "results", unit), { recursive: true });',
    '    writeFileSync(join(process.env.OMELETTE_HOME, "results", unit, resultId + ".md"), renderResult({ unit, tool, resultId, ...rec, startedAt: now.toISOString(), endedAt: now.toISOString(), durationMs: 1, status: "ok", text: "t" }));',
    '    send({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "answer" }] } }); } } });',
  ].join('\n'));
  const env = baseEnv(home);
  // Codex asked for low, the unit says it used xhigh: the line says xhigh.
  const c = await runArm({ suite: 'R', arm: parseArm('codex:gpt-6.1-sol:low'), dir, serverPath: server, env, out: quiet });
  assert.deepEqual([c.lines[0].model, c.lines[0].effort], ['gpt-6.1-sol', 'xhigh']);
  // Gemini's record carries no effort field: it is the level in the model id the unit reports.
  const g = await runArm({ suite: 'R', arm: parseArm('gemini:Gemini 3.8 Flash:high'), dir, serverPath: server, env, out: quiet });
  assert.deepEqual([g.lines[0].model, g.lines[0].effort], ['Gemini 3.8 Flash (Medium)', 'medium']);
});
