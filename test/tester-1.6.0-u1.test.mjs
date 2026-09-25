/**
 * omelette-fleet :: test/tester-1.6.0-u1.test.mjs
 * U1 (1.6.0), over real processes: `call --timeout` cancels the request before
 * it signals the server (SIGTERM, then SIGKILL for a server that ignores both);
 * a unit server that receives SIGTERM kills its live vendor process groups —
 * the vendor child AND what it spawned — and removes its status snapshot; a
 * client that closes stdin still gets the answer to a short call in flight.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callUnitServer } from '../core/client.mjs';
// A namespace import: a missing export is `undefined` here, not a link error
// that would take the file's other tests down with it.
import * as spawnMod from '../core/spawn.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GEMINI_SERVER = join(ROOT, 'servers', 'gemini.mjs');
const DEADLINE_MS = 10_000;

/** Poll `check` until it returns truthy or the deadline passes; returns the last value. */
async function until(check, what) {
  const end = Date.now() + DEADLINE_MS;
  let v;
  while (Date.now() < end) {
    try { v = check(); } catch { v = undefined; }
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out after ${DEADLINE_MS} ms waiting for ${what}`);
}

/** `promise`, or a failure once the deadline passes. */
function within(promise, what) {
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`timed out after ${DEADLINE_MS} ms waiting for ${what}`)), DEADLINE_MS); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/** Signal 0 probes a pid without touching it: ESRCH means gone, EPERM means alive but not ours. */
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
};
const killQuietly = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } };

/**
 * An MCP server that answers `initialize` and `tools/list`, logs its pid and
 * every frame it receives to `log`, and then ignores everything: it never
 * answers `tools/call`, ignores the cancel, logs and ignores SIGTERM, and a
 * keep-alive timer holds it up after stdin ends. Only SIGKILL takes it down.
 */
function deafServer(dir) {
  const log = join(dir, 'frames.log');
  const p = join(dir, 'deaf-server.mjs');
  writeFileSync(p, [
    "import { appendFileSync } from 'node:fs';",
    `const note = (s) => appendFileSync(${JSON.stringify(log)}, s + '\\n');`,
    'note(`pid ${process.pid}`);',
    "process.on('SIGTERM', () => note('SIGTERM ignored'));",
    'setInterval(() => {}, 1000);',
    'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
    'const INIT = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "deaf", version: "0" } };',
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
    '    else if (m.id === 2) send({ jsonrpc: "2.0", id: 2, result: { tools: TOOLS } });',
    '  }',
    '});',
  ].join('\n'));
  return { server: p, log };
}

/**
 * A fake `agy` for the SIGTERM test: it starts a grandchild in its OWN process
 * group (no `detached`), writes both pids to `pidFile` (renamed into place, so
 * a reader never sees half a file), and then sleeps 60 s without answering.
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

/** A fake `agy` that answers after 2 s. */
function slowAgy(dir) {
  const p = join(dir, 'fake-agy-slow');
  writeFileSync(p, [
    `#!${process.execPath}`,
    'setTimeout(() => process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "landed after stdin closed" })), 2000);',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** A real server over stdio: `send` a frame, `reply(id)` resolves that id's response. */
function startServer(env, cwd) {
  const child = spawn(process.execPath, [GEMINI_SERVER], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  const waiters = new Map();
  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id === undefined) continue; // progress notifications
      if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } else replies.set(m.id, m);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    exited,
    get stderr() { return stderr; },
    send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); },
    reply(id) {
      if (replies.has(id)) return Promise.resolve(replies.get(id));
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no reply to id ${id} in ${DEADLINE_MS} ms · stderr: ${stderr.trim() || '(none)'}`)), DEADLINE_MS);
        waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
      });
    },
    kill() { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
  };
}

function workspace(agyFor) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-u1-'));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: agyFor(dir), OMELETTE_UPDATE_CHECK: '0' };
  delete env.OMELETTE_STATUS; // the feed must be on whatever the runner's environment says
  return { dir, env };
}

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } };
const research = (id, prompt) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'gemini_research', arguments: { prompt } } });

test('call timeout: the cancel reaches the server first, then SIGTERM, then SIGKILL for a server that ignores both', async () => {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'omelette-u1-'));
  const { server, log } = deafServer(dir);
  let pid = null;
  try {
    await assert.rejects(callUnitServer({ serverPath: server, tool: 't', timeoutS: 1 }), /no answer after 1s/);
    pid = Number(/^pid (\d+)$/m.exec(readFileSync(log, 'utf8'))[1]);
    await until(() => !alive(pid), 'the deaf server to be gone (only SIGKILL can do it)');

    // Everything in the log was written by the server itself, so every line
    // below reached it while it was still alive.
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const cancelAt = lines.findIndex((l) => l.includes('"method":"notifications/cancelled"'));
    assert.ok(cancelAt >= 0, `the cancel reached the server · log:\n${lines.join('\n')}`);
    assert.match(lines[cancelAt], /"requestId":3/);
    assert.equal(JSON.parse(lines[cancelAt]).params.requestId, 3, 'the cancel names the tools/call id');
    const termAt = lines.indexOf('SIGTERM ignored');
    assert.ok(termAt > cancelAt, `SIGTERM followed the cancel · log:\n${lines.join('\n')}`);
    assert.ok(Date.now() - t0 < DEADLINE_MS, `the whole goodbye took ${Date.now() - t0} ms`);
  } finally {
    if (pid) killQuietly(pid);
  }
});

test('SIGTERM to a unit server kills its live process groups — the vendor child and its grandchild — and removes the snapshot', async () => {
  let pidFile;
  const w = workspace((dir) => { pidFile = join(dir, 'pids.json'); return groupAgy(dir, pidFile); });
  const s = startServer(w.env, w.dir);
  let pids = null;
  try {
    const snapshot = join(w.dir, `status-gemini-${s.child.pid}.json`);
    s.send(INITIALIZE);
    assert.ok((await s.reply(1)).result, 'initialize answered');
    s.send(research(2, 'run long'));
    pids = await until(() => JSON.parse(readFileSync(pidFile, 'utf8')), 'the fake agy to write its pids');
    assert.ok(alive(pids.agy) && alive(pids.grandchild), 'both vendor processes run before the signal');
    assert.equal(existsSync(snapshot), true, 'the snapshot exists before the signal');

    process.kill(s.child.pid, 'SIGTERM');
    assert.deepEqual(await within(s.exited, 'the server to exit on SIGTERM'), { code: 0, signal: null });
    await until(() => !alive(pids.agy) && !alive(pids.grandchild), 'the fake agy and its grandchild to be gone');
    assert.equal(existsSync(snapshot), false, 'the snapshot went with the process');
    assert.match(s.stderr, /SIGTERM: shutting down/);
    assert.match(s.stderr, /shutdown: killed 1 process group\(s\)/);
  } finally {
    s.kill();
    if (pids) { killQuietly(pids.agy); killQuietly(pids.grandchild); }
  }
});

test('stdin end still lets a short call land: the answer arrives, then the server exits', async () => {
  const t0 = Date.now();
  const w = workspace(slowAgy);
  const s = startServer(w.env, w.dir);
  try {
    s.send(INITIALIZE);
    assert.ok((await s.reply(1)).result, 'initialize answered');
    s.send(research(2, 'short'));
    s.child.stdin.end();
    const r = await s.reply(2);
    assert.match(r.result.content[0].text, /landed after stdin closed/);
    assert.deepEqual(await within(s.exited, 'the server to exit after the drain'), { code: 0, signal: null });
    assert.ok(Date.now() - t0 < DEADLINE_MS, `took ${Date.now() - t0} ms`);
  } finally {
    s.kill();
  }
});

test('the live-group registry: a running spawn is listed, killLiveGroups signals it and forgets it, a closed run leaves it', async () => {
  const { killLiveGroups, liveGroupCount, runProcess } = spawnMod;
  assert.equal(liveGroupCount(), 0);
  const long = runProcess({ bin: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'] });
  assert.equal(liveGroupCount(), 1);
  assert.equal(killLiveGroups(), 1);
  assert.equal(liveGroupCount(), 0);
  const r = await within(long, 'the killed run to resolve');
  assert.equal(r.signal, 'SIGKILL');

  await within(runProcess({ bin: process.execPath, args: ['-e', ''] }), 'a short run to close');
  assert.equal(liveGroupCount(), 0, 'a run that closed is no longer listed');
  await assert.rejects(runProcess({ bin: join(tmpdir(), 'omelette-u1-no-such-bin'), args: [] }), /not found/);
  assert.equal(liveGroupCount(), 0, 'a spawn that never ran is not listed');
  assert.equal(killLiveGroups(), 0);
});
