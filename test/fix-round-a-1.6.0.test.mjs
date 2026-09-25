/**
 * omelette-fleet :: test/fix-round-a-1.6.0.test.mjs
 * 1.6.0 fix round A, one block per ruled finding:
 *   A1 gemini deep research: every cancellation return carries the marker.
 *   A2 the regex knows `hard-killed after ?s` and `CLI exited null`.
 *   A3 the regex is tight: the cancel alternative ends where the marker does,
 *      and a hard-kill names the unit its prefix names.
 *   A4 the client acts on nothing once it has settled (a late tools/list).
 *   A5 a signal after stdin closed exits through the flush, not past it.
 *   A6 the status sweep reads a file before removing it.
 *   A7 the live-group registry keeps a group while it has members, no longer.
 *   A8 doctor: an empty `Default model:` does not capture the next line.
 *   A9 a signal during a call closes the call's feed entry as cancelled.
 *   A10 doctor's sandbox probe removes the snapshot its runtime wrote.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { partialMark, PARTIAL_MARK_RE, MARK_KINDS } from '../core/partial.mjs';
import { callUnitServer } from '../core/client.mjs';
import { createStatus } from '../core/status.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import * as spawnMod from '../core/spawn.mjs';
import gemini, { interpretAgy } from '../units/gemini/adapter.mjs';
import { interpretGrok } from '../units/grok/adapter.mjs';
import { extractResult } from '../units/codex/adapter.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const GEMINI_SERVER = join(ROOT, 'servers', 'gemini.mjs');
const DEADLINE_MS = 10_000;
const UNITS = ['gemini', 'grok', 'codex'];
const CANCEL_MARK = '[gemini: cancelled by the client — treat the answer as partial]';

/** Poll `check` until it returns truthy or the deadline passes; fails past it. */
async function until(check, what, ms = DEADLINE_MS) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    try { v = check(); } catch { v = undefined; }
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out after ${ms} ms waiting for ${what}`);
}

/** `promise`, or a failure once the deadline passes. */
function within(promise, what, ms = DEADLINE_MS) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/** Signal 0 probes a pid without touching it: ESRCH means gone, EPERM means alive but not ours. */
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
};
const killQuietly = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } };

/* ── A1: gemini deep research, the three cancellation returns ─────────────── */

/** A finished-run shape in exactly the form core/spawn.mjs resolves one. */
const spawnRes = (over) => Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, killed: false, capped: false, cancelled: false, ...over });
const say = (response) => spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response }) });
const DECOMPOSED = spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '{"subquestions":["alpha","beta"]}', structured_output: { subquestions: ['alpha', 'beta'] } }) });
const promptOf = (o) => o.args[o.args.indexOf('-p') + 1] || '';

/**
 * Runs gemini_deep_research under `cancel: kill` with every spawn answered by
 * `stub(prompt, controller)`, and returns the ADAPTER's own return — the
 * `partial` flag included, which callTool's MCP-shaped result does not carry.
 */
async function deepResearchCancelled(stub) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fra-a1-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { cancel: 'kill', timeoutS: 60 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const controller = new AbortController();
  const seen = {};
  const rt = createUnitRuntime(
    { ...gemini, tools: gemini.tools.map((t) => (t.run ? { ...t, run: async (a, ctx) => (seen.last = await t.run(a, { ...ctx, spawn: (o) => stub(promptOf(o), controller) })) } : t)) },
    { env },
  );
  const r = await rt.callTool('gemini_deep_research', { question: 'the big question' }, { id: 1, signal: controller.signal });
  assert.ok(seen.last, `the adapter returned nothing · callTool said: ${r.text}`);
  return seen.last;
}

const assertCancelMarked = (r, note) => {
  assert.equal(r.partial, true, r.text);
  assert.equal(PARTIAL_MARK_RE.test(r.text), true, `no marker the regex knows:\n${r.text}`);
  assert.ok(r.text.endsWith(`\n\n${CANCEL_MARK}`), `the marker is not at the end:\n${r.text}`);
  assert.ok(r.text.includes(note), `the note is gone:\n${r.text}`);
  assert.match(r.text, /### Sub-question 1: alpha/);
};

test('A1: a cancel before synthesis returns the findings with the note AND the cancel marker at the end', async () => {
  const r = await deepResearchCancelled((prompt, controller) => {
    if (/Decompose the following research question/.test(prompt)) return DECOMPOSED;
    if (/Question: beta$/.test(prompt)) controller.abort();
    if (/Synthesize the research findings/.test(prompt)) return say('SHOULD NOT RUN');
    return say('a finding');
  });
  assertCancelMarked(r, '> **Cancelled — the synthesis stage did not run.**');
  assert.doesNotMatch(r.text, /SHOULD NOT RUN/);
});

test('A1: a cancel that kills the synthesis with nothing printed returns the findings with the note AND the marker', async () => {
  const r = await deepResearchCancelled((prompt, controller) => {
    if (/Decompose the following research question/.test(prompt)) return DECOMPOSED;
    if (/Synthesize the research findings/.test(prompt)) {
      controller.abort();
      return spawnRes({ code: null, signal: 'SIGKILL', killed: true, cancelled: true });
    }
    return say('a finding');
  });
  assertCancelMarked(r, '> **Cancelled — the synthesis stage did not run.**');
  assert.match(r.text, /### Sub-question 2: beta\n\na finding/);
});

test('A1: a cancel mid-synthesis keeps the fragment under its note AND ends on the marker', async () => {
  // The cancel lands as the synthesis ends on its own: the stage returns a
  // clean answer that carries no marker of its own.
  const r = await deepResearchCancelled((prompt, controller) => {
    if (/Decompose the following research question/.test(prompt)) return DECOMPOSED;
    if (/Synthesize the research findings/.test(prompt)) {
      controller.abort();
      return say('a report that finished as the cancel landed');
    }
    return say('a finding');
  });
  assertCancelMarked(r, '> **Cancelled — the synthesis stage was cancelled before it finished.**');
  assert.match(r.text, /\[gemini: partial synthesis, cancelled\]\n\na report that finished as the cancel landed/);

  // …and a fragment the kill salvaged ends on the marker as well — once.
  const killed = await deepResearchCancelled((prompt, controller) => {
    if (/Decompose the following research question/.test(prompt)) return DECOMPOSED;
    if (/Synthesize the research findings/.test(prompt)) {
      controller.abort();
      return spawnRes({ stdout: 'half a report, cut off mid-', code: null, signal: 'SIGKILL', killed: true, cancelled: true });
    }
    return say('a finding');
  });
  assertCancelMarked(killed, '> **Cancelled — the synthesis stage was cancelled before it finished.**');
  assert.match(killed.text, /\[gemini: partial synthesis, cancelled\]\n\nhalf a report, cut off mid-/);
  assert.equal(killed.text.split(CANCEL_MARK).length - 1, 1, `the cancel marker appears more than once:\n${killed.text}`);
});

test('A1: a gather\'s hard-kill marker in the findings does not stand in for the cancel marker', async () => {
  const r = await deepResearchCancelled((prompt, controller) => {
    if (/Decompose the following research question/.test(prompt)) return DECOMPOSED;
    if (/Question: alpha$/.test(prompt)) {
      return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: 'a finding cut short' }), code: null, signal: 'SIGKILL', killed: true });
    }
    if (/Synthesize the research findings/.test(prompt)) {
      controller.abort();
      return say('a report that finished as the cancel landed');
    }
    return say('a finding');
  });
  assertCancelMarked(r, '> **Cancelled — the synthesis stage was cancelled before it finished.**');
  assert.match(r.text, /a finding cut short\n\n\[gemini: hard-killed after [\d.]+s — treat the answer as partial; raise gemini\.timeoutS in the fleet config\]/);
  assert.equal(r.text.split(CANCEL_MARK).length - 1, 1, r.text);
});

/* ── A2 / A3: PARTIAL_MARK_RE ──────────────────────────────────────────────── */

test('A2: the regex matches `hard-killed after ?s` and `CLI exited null`', () => {
  const unknownAfter = partialMark('codex', 'killed', { after: '?' });
  assert.equal(unknownAfter, '[codex: hard-killed after ?s — treat the answer as partial; raise codex.timeoutS in the fleet config]');
  assert.equal(PARTIAL_MARK_RE.test(unknownAfter), true);
  for (const unit of UNITS) {
    const exitedNull = partialMark(unit, 'exited', { code: null });
    assert.equal(exitedNull, `[${unit}: CLI exited null — treat the answer as partial]`);
    assert.equal(PARTIAL_MARK_RE.test(exitedNull), true, exitedNull);
  }
});

test('A2: codex killed with no timeoutS — flag and marker agree', () => {
  const stdout = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } });
  const r = extractResult({ stdout, stderr: '', code: null, killed: true, capped: false, cancelled: false }, {});
  assert.equal(r.partial, true);
  assert.match(r.text, /\[codex: hard-killed after \?s/);
  assert.equal(PARTIAL_MARK_RE.test(r.text), true, r.text);
});

test('A2: a vendor child killed by an outside signal (code null, killed false) — flag and marker agree in every interpreter', () => {
  const base = { stderr: '', code: null, killed: false, capped: false, cancelled: false };
  const agy = interpretAgy({ ...base, stdout: JSON.stringify({ status: 'SUCCESS', response: 'answer' }) }, { timeoutS: 300 });
  const grok = interpretGrok({
    ...base,
    stdout: [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } }),
      JSON.stringify({ type: 'result', result: 'answer', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n'),
  }, { jsonMode: true, timeoutS: 300 });
  const codex = extractResult({
    ...base,
    stdout: [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n'),
  }, { timeoutS: 600 });
  for (const [unit, r] of [['gemini', agy], ['grok', grok], ['codex', codex]]) {
    assert.equal(r.partial, true, `${unit}: ${r.text}`);
    assert.ok(r.text.includes(`[${unit}: CLI exited null — treat the answer as partial]`), `${unit}: ${r.text}`);
    assert.equal(PARTIAL_MARK_RE.test(r.text), true, `${unit}: ${r.text}`);
  }
});

test('A3: the cancel alternative ends where the marker does', () => {
  assert.equal(PARTIAL_MARK_RE.test('[gemini: cancelled by the clientish]'), false);
  assert.equal(PARTIAL_MARK_RE.test('[gemini: cancelled by the client]'), true);
  assert.equal(PARTIAL_MARK_RE.test('[grok: cancelled by the client — Grok had reported: boom]'), true);
});

test('A3: a hard-kill marker must name the unit its prefix names', () => {
  assert.equal(PARTIAL_MARK_RE.test('[codex: hard-killed after 5s — treat the answer as partial; raise grok.timeoutS in the fleet config]'), false);
  assert.equal(PARTIAL_MARK_RE.test('[codex: hard-killed after 5s — treat the answer as partial; raise codex.timeoutS in the fleet config]'), true);
});

test('A3: every partialMark output, every kind for every unit, still matches', () => {
  const detail = { outputCap: 400000, after: 360, code: 1, stopReason: 'max_tokens', status: 'TIMEOUT', n: 1, m: 4, subs: 'why; how' };
  for (const unit of UNITS) {
    for (const kind of MARK_KINDS) {
      const mark = partialMark(unit, kind, detail);
      assert.equal(PARTIAL_MARK_RE.test(mark), true, `${unit}/${kind}: ${mark}`);
    }
    for (const mark of [
      partialMark(unit, 'killed', { after: '?' }),
      partialMark(unit, 'killed', { after: 1.5 }),
      partialMark(unit, 'exited', { code: -1 }),
      partialMark(unit, 'exited', { code: null }),
      partialMark(unit, 'cancelled', { tail: ` — ${unit} had reported: boom` }),
    ]) assert.equal(PARTIAL_MARK_RE.test(mark), true, `${unit}: ${mark}`);
  }
});

/* ── A4: a late tools/list reply after the timeout ─────────────────────────── */

/**
 * An MCP server that answers `initialize` at once and `tools/list` only after
 * 1.5 s, logs its pid and every frame it receives, never answers `tools/call`,
 * logs and ignores SIGTERM, and is held up by a keep-alive timer.
 */
function lateListServer(dir) {
  const log = join(dir, 'frames.log');
  const p = join(dir, 'late-list-server.mjs');
  writeFileSync(p, [
    "import { appendFileSync } from 'node:fs';",
    `const note = (s) => appendFileSync(${JSON.stringify(log)}, s + '\\n');`,
    'note(`pid ${process.pid}`);',
    "process.on('SIGTERM', () => note('SIGTERM ignored'));",
    'setInterval(() => {}, 1000);',
    'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
    'const INIT = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "late", version: "0" } };',
    'const TOOLS = [{ name: "t", description: "d", inputSchema: { type: "object" } }];',
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => {',
    '  buf += c; let nl;',
    '  while ((nl = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);',
    '    if (!line) continue;',
    '    note(line);',
    '    const m = JSON.parse(line);',
    '    if (m.id === 1) send({ jsonrpc: "2.0", id: 1, result: INIT });',
    '    else if (m.id === 2) setTimeout(() => { note("tools/list answered"); send({ jsonrpc: "2.0", id: 2, result: { tools: TOOLS } }); }, 1500);',
    '  }',
    '});',
  ].join('\n'));
  return { server: p, log };
}

test('A4: a tools/list reply that lands after the timeout never sends tools/call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fra-a4-'));
  const { server, log } = lateListServer(dir);
  let pid = null;
  try {
    await assert.rejects(callUnitServer({ serverPath: server, tool: 't', timeoutS: 1 }), /no answer after 1s/);
    pid = Number(/^pid (\d+)$/m.exec(readFileSync(log, 'utf8'))[1]);
    // The late reply went out while the server was still alive to log what came back.
    await until(() => readFileSync(log, 'utf8').includes('tools/list answered'), 'the late tools/list reply');
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      assert.doesNotMatch(readFileSync(log, 'utf8'), /"method":"tools\/call"/, 'a tools/call reached the server after the timeout');
      await new Promise((r) => setTimeout(r, 50));
    }
    const frames = readFileSync(log, 'utf8');
    assert.doesNotMatch(frames, /"method":"tools\/call"/);
    assert.match(frames, /"method":"notifications\/cancelled"/);
  } finally {
    if (pid) killQuietly(pid);
  }
});

/* ── A5: a signal after stdin closed exits through the flush ──────────────── */

const BIG = 2 * 1024 * 1024;

/** A fake `agy` that answers at once with a `BIG`-character response. */
function bigAgy(dir) {
  const p = join(dir, 'fake-agy-big');
  writeFileSync(p, [
    `#!${process.execPath}`,
    `process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "x".repeat(${BIG}) }));`,
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

function a5Workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fra-a5-'));
  // The 2 MB envelope must pass whole: the default output cap would cut it open.
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { outputCap: 5_000_000, timeoutS: 60 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: bigAgy(dir), OMELETTE_UPDATE_CHECK: '0' };
  delete env.OMELETTE_STATUS;
  return { dir, env };
}

test('A5: SIGTERM after stdin closed, with a 2 MB answer queued on an unread pipe — the answer arrives whole, exit 0', async () => {
  const w = a5Workspace();
  const child = spawn(process.execPath, [GEMINI_SERVER], { env: w.env, cwd: w.dir, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdin.on('error', () => {});
  child.on('error', () => {});
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const closed = new Promise((resolve) => child.stdout.on('close', resolve));
  try {
    child.stdout.on('data', (c) => { out += c; });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
    await until(() => out.includes('"id":1'), 'the initialize reply');

    child.stdout.pause();
    const pausedAt = Date.now();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gemini_research', arguments: { prompt: 'big' } } })}\n`);
    // The feed's `end` line is written in the same turn that hands the answer
    // to stdout, so once it is in the log the 2 MB frame is queued.
    const logPath = join(w.dir, 'fleet-log.ndjson');
    await until(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('"event":"end"'), 'the call to finish');
    await until(() => Date.now() - pausedAt >= 300, '300 ms of an unread stdout');
    child.stdin.end();
    process.kill(child.pid, 'SIGTERM');
    await until(() => stderr.includes('SIGTERM: shutting down'), `the server to meet SIGTERM · stderr: ${stderr}`);
    child.stdout.resume();

    assert.deepEqual(await within(exited, 'the server to exit'), { code: 0, signal: null });
    await within(closed, 'stdout to close');
    // Only newline-terminated lines are frames: a cut-off answer has no newline.
    const frame = out.split('\n').slice(0, -1).find((l) => l.includes('"id":3'));
    assert.ok(frame, `no complete frame for id 3 · ${out.length} chars read · stderr:\n${stderr}`);
    const m = JSON.parse(frame);
    assert.equal(m.result.content[0].text, 'x'.repeat(BIG));
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('A5: SIGTERM with nothing queued still exits 0 — the flush cap never holds a clean exit', async () => {
  const w = a5Workspace();
  const child = spawn(process.execPath, [GEMINI_SERVER], { env: w.env, cwd: w.dir, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stdin.on('error', () => {});
  child.on('error', () => {});
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
    await until(() => out.includes('"id":1'), 'the initialize reply');
    process.kill(child.pid, 'SIGTERM');
    assert.deepEqual(await within(exited, 'the server to exit on SIGTERM'), { code: 0, signal: null });
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

/* ── A6: the status sweep reads before it removes ─────────────────────────── */

const boot = (dir, unit) => createStatus({ unit, spawnTools: new Set(['t']), resolve: () => ({ dir, enabled: true }), pid: 33333 }).boot();
const snap2 = (unit, pid) => JSON.stringify({ schema: 2, unit, pid, active: [], lastEvent: null, updatedAt: '2000-01-01T00:00:00.000Z' });

test('A6: another unit\'s schema-1 file whose name looks like ours is kept', () => {
  assert.throws(() => process.kill(999999, 0));
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fra-a6-'));
  // Schema 1 named its file status-<unit>.json: this is unit `my-unit-999999`, no pid inside.
  const legacy = join(dir, 'status-my-unit-999999.json');
  writeFileSync(legacy, JSON.stringify({ schema: 1, unit: 'my-unit-999999', active: [], lastEvent: null, updatedAt: '2000-01-01T00:00:00.000Z' }));
  boot(dir, 'my-unit');
  assert.equal(existsSync(legacy), true);
});

test('A6: this unit\'s schema-2 dead file is still swept', () => {
  assert.throws(() => process.kill(999999, 0));
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fra-a6-'));
  const dead = join(dir, 'status-my-unit-999999.json');
  writeFileSync(dead, snap2('my-unit', 999999));
  boot(dir, 'my-unit');
  assert.equal(existsSync(dead), false);
});

test('A6: a schema-2 dead file whose inner unit or pid differs from its name is kept', () => {
  assert.throws(() => process.kill(999999, 0));
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fra-a6-'));
  const otherUnit = join(dir, 'status-my-unit-999999.json');
  writeFileSync(otherUnit, snap2('other', 999999));
  boot(dir, 'my-unit');
  assert.equal(existsSync(otherUnit), true, 'inner unit differs');
  const otherPid = join(dir, 'status-u-999999.json');
  writeFileSync(otherPid, snap2('u', 999998));
  boot(dir, 'u');
  assert.equal(existsSync(otherPid), true, 'inner pid differs');
});

test('A6: an unparsable dead file is kept', () => {
  assert.throws(() => process.kill(999999, 0));
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fra-a6-'));
  const garbage = join(dir, 'status-my-unit-999999.json');
  writeFileSync(garbage, '{ not json');
  boot(dir, 'my-unit');
  assert.equal(existsSync(garbage), true);
});

/* ── A7: the registry keeps a group while it has members ────────────────── */

/**
 * A leader script for runProcess: it starts a grandchild that sleeps 60 s and
 * inherits stdout/stderr (so the run's `close` waits for it), in the leader's
 * own group or — `detached` — in a group of its own, writes both pids
 * (renamed into place), and exits at once.
 */
function leaderScript(dir, { detached }) {
  const pidFile = join(dir, 'pids.json');
  const script = join(dir, 'leader.cjs');
  writeFileSync(script, [
    "const { spawn } = require('child_process');",
    "const { renameSync, writeFileSync } = require('fs');",
    `const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { detached: ${detached}, stdio: ['ignore', 'inherit', 'inherit'] });`,
    'g.unref();',
    `writeFileSync(${JSON.stringify(pidFile + '.tmp')}, JSON.stringify({ leader: process.pid, grandchild: g.pid }));`,
    `renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)});`,
  ].join('\n'));
  return { script, pidFile };
}

test('A7: a leader that exits while a same-group grandchild lives stays listed, and killLiveGroups reaches the grandchild', async () => {
  const { killLiveGroups, liveGroupCount, runProcess } = spawnMod;
  assert.equal(liveGroupCount(), 0, 'starts empty');
  const { script, pidFile } = leaderScript(mkdtempSync(join(tmpdir(), 'omelette-fra-a7-')), { detached: false });
  const run = runProcess({ bin: process.execPath, args: [script] });
  let pids = null;
  try {
    pids = await until(() => JSON.parse(readFileSync(pidFile, 'utf8')), 'the leader to write its pids');
    await until(() => !alive(pids.leader), 'the leader to exit');
    assert.equal(alive(pids.grandchild), true, 'the grandchild outlives the leader');
    assert.equal(liveGroupCount(), 1, 'the group still has a member, so the entry stays');
    assert.equal(killLiveGroups(), 1);
    await until(() => !alive(pids.grandchild), 'the grandchild to die');
    assert.equal(liveGroupCount(), 0);
  } finally {
    if (pids) killQuietly(pids.grandchild);
  }
  await within(run, 'the run to close once the grandchild is gone');
});

test('A7: a leader whose group is empty at its exit is forgotten at exit — before close — and never signalled', async () => {
  const { killLiveGroups, liveGroupCount, runProcess } = spawnMod;
  assert.equal(liveGroupCount(), 0, 'starts empty');
  // The only other process is in a group of its OWN, and it holds the pipes:
  // `close` cannot come while it lives, so a zero count below can only be
  // the exit-time deletion. (A leader with no pipe-holder at all closes at
  // once, and could not tell the two apart.)
  const { script, pidFile } = leaderScript(mkdtempSync(join(tmpdir(), 'omelette-fra-a7-')), { detached: true });
  const run = runProcess({ bin: process.execPath, args: [script] });
  let pids = null;
  const realKill = process.kill;
  const signalled = [];
  try {
    pids = await until(() => JSON.parse(readFileSync(pidFile, 'utf8')), 'the leader to write its pids');
    await until(() => !alive(pids.leader), 'the leader to exit');
    assert.equal(alive(pids.grandchild), true, 'the grandchild still holds the pipes, so the run has not closed');
    assert.equal(liveGroupCount(), 0, 'the empty group was forgotten at its leader\'s exit');
    process.kill = (pid, sig) => { signalled.push([pid, sig]); return realKill.call(process, pid, sig); };
    assert.equal(killLiveGroups(), 0);
    process.kill = realKill;
    assert.deepEqual(signalled, [], 'nothing was probed or signalled');
    assert.equal(alive(pids.grandchild), true);
  } finally {
    process.kill = realKill;
    if (pids) killQuietly(pids.grandchild);
  }
  await within(run, 'the run to close once the grandchild is gone');
  assert.equal(liveGroupCount(), 0);
});

/* ── A8: doctor and an empty `Default model:` ─────────────────────────────── */

/** A fake vendor CLI whose `models` prints `modelsOut` verbatim (the fixture of tester-1.6.0-r5b). */
function fakeBin(dir, modelsOut) {
  const p = join(dir, 'fake-cli');
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    `if (a[0] === 'models') { process.stdout.write(${JSON.stringify(modelsOut)}); process.exit(0); }`,
    "console.error('unexpected argv: ' + a.join(' '));",
    'process.exit(1);',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** doctor with a fresh fleet home; only grok has a binary, and its `models` prints `modelsOut`. */
function doctorWith(modelsOut) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fra-a8-'));
  const fake = fakeBin(dir, modelsOut);
  const gone = join(dir, 'no-such');
  const r = spawnSync(process.execPath, [BIN, 'doctor'], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone },
  });
  const out = r.stdout || '';
  return { out, err: r.stderr || '', grok: out.slice(out.indexOf('── grok'), out.indexOf('── codex')) };
}

test('A8: doctor — `Default model:` with nothing after it prints no models line', () => {
  const r = doctorWith('Default model:\n\nAvailable models:\n  - grok-4.7\n');
  assert.match(r.grok, /^  login       OK/m, r.out + r.err);
  assert.doesNotMatch(r.out, /^  models /m, r.out);
  assert.doesNotMatch(r.out, /CLI default Available/, r.out);
});

test('A8: doctor — a CRLF `Default model:` line is read, and an empty CRLF one still captures nothing', () => {
  const crlf = doctorWith('Default model: grok-4.7\r\n\r\nAvailable models:\r\n  - grok-4.7\r\n');
  assert.match(crlf.grok, /^  models      CLI default grok-4\.7 — /m, crlf.out + crlf.err);
  const empty = doctorWith('Default model:\r\n\r\nAvailable models:\r\n  - grok-4.7\r\n');
  assert.match(empty.grok, /^  login       OK/m, empty.out + empty.err);
  assert.doesNotMatch(empty.out, /^  models /m, empty.out);
});

/* ── A9: a signal during a call closes its feed entry ─────────────────────── */

/**
 * A fake `agy` that starts a grandchild in its own process group, writes both
 * pids to `pidFile` (renamed into place), then sleeps 60 s without answering.
 */
function groupAgy(dir, pidFile) {
  const p = join(dir, 'fake-agy-group');
  writeFileSync(p, [
    `#!${process.execPath}`,
    "const { spawn } = require('child_process');",
    "const { renameSync, writeFileSync } = require('fs');",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(pidFile + '.tmp')}, JSON.stringify({ agy: process.pid, grandchild: g.pid }));`,
    `renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)});`,
    'setTimeout(() => {}, 60000);',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

test('A9: SIGTERM during a call leaves a paired start/end in the log — cancelled, with the reason — and no spool record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fra-a9-'));
  const pidFile = join(dir, 'pids.json');
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: groupAgy(dir, pidFile), OMELETTE_UPDATE_CHECK: '0' };
  delete env.OMELETTE_STATUS;
  const child = spawn(process.execPath, [GEMINI_SERVER], { env, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  child.on('error', () => {});
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  let pids = null;
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
    await until(() => out.includes('"id":1'), 'the initialize reply');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gemini_research', arguments: { prompt: 'run long' } } })}\n`);
    pids = await until(() => JSON.parse(readFileSync(pidFile, 'utf8')), 'the fake agy to write its pids');

    process.kill(child.pid, 'SIGTERM');
    assert.deepEqual(await within(exited, 'the server to exit on SIGTERM'), { code: 0, signal: null });

    const lines = readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const starts = lines.filter((l) => l.event === 'start');
    const ends = lines.filter((l) => l.event === 'end');
    assert.equal(starts.length, 1, JSON.stringify(lines));
    assert.equal(ends.length, 1, JSON.stringify(lines));
    assert.equal(ends[0].id, starts[0].id);
    assert.equal(ends[0].status, 'cancelled');
    assert.equal(ends[0].error, 'server shut down before the call finished');
    assert.equal(ends[0].resultId, starts[0].resultId);
    const spool = join(dir, 'results', 'gemini');
    assert.deepEqual(existsSync(spool) ? readdirSync(spool).filter((f) => f.endsWith('.md')) : [], [], 'nothing spooled');
    assert.equal(existsSync(join(dir, `status-gemini-${child.pid}.json`)), false, 'the snapshot went with the process');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    if (pids) { killQuietly(pids.agy); killQuietly(pids.grandchild); }
  }
});

/* ── A10: doctor's sandbox probe leaves no snapshot behind ────────────────── */

/** A fake vendor CLI that answers doctor's probes and replies to a research run without writing (cli.test.mjs `probeBin`, mode 'refuse'). */
function refusingBin(dir) {
  const p = join(dir, 'probe-cli');
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    "if (a[0] === 'models') { console.log('model-a'); console.log('model-b'); process.exit(0); }",
    "console.log('refused'); process.exit(0);",
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

test('A10: doctor --probe-sandbox leaves no status snapshot in the fleet home', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fra-a10-'));
  const gone = join(dir, 'no-such');
  // grok registered as OURS, so the probe's "enabled AND registered" gate opens for it.
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { 'omelette-grok': { command: 'node', args: [join(ROOT, 'servers', 'grok.mjs')] } } }));
  const r = spawnSync(process.execPath, [BIN, 'doctor', '--probe-sandbox'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: refusingBin(dir), CODEX_BIN: gone },
  });
  assert.match(r.stdout || '', /sandbox\s+held \(\d+ s, replied "refused"\)/, (r.stdout || '') + (r.stderr || ''));
  assert.ok(existsSync(join(dir, 'fleet-log.ndjson')), 'the probe ran through the feed');
  assert.deepEqual(readdirSync(dir).filter((n) => /^status-.*\.json$/.test(n)), []);
});
