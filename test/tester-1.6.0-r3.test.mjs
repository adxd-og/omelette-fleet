/**
 * omelette-fleet :: test/tester-1.6.0-r3.test.mjs
 * R3 (1.6.0), over real processes: two gemini servers sharing one
 * OMELETTE_HOME keep one snapshot each, each removes its own on a clean exit
 * (stdin closed, the in-flight call drained), and a killed server's file is
 * swept by the next server of that unit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GEMINI_SERVER = join(ROOT, 'servers', 'gemini.mjs');
const DEADLINE_MS = 10_000;

/**
 * A fake `agy` that answers only once `gate` exists (capped at 30 s so a failed
 * test never leaves it running): the test decides when the call ends, so
 * "both calls are active" is observed without racing a sleep.
 */
function fakeAgy(dir, gate) {
  const p = join(dir, 'fake-agy');
  writeFileSync(p, [
    `#!${process.execPath}`,
    "const { existsSync } = require('fs');",
    'const t0 = Date.now();',
    'const tick = setInterval(() => {',
    `  if (!existsSync(${JSON.stringify(gate)}) && Date.now() - t0 < 30000) return;`,
    '  clearInterval(tick);',
    '  process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "released" }));',
    '}, 25);',
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
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    exited,
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

const readSnap = (dir, pid) => JSON.parse(readFileSync(join(dir, `status-gemini-${pid}.json`), 'utf8'));
const geminiSnapshots = (dir) => readdirSync(dir).filter((n) => /^status-gemini-\d+\.json$/.test(n)).sort();

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-r3-'));
  const gate = join(dir, 'release');
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: fakeAgy(dir, gate), OMELETTE_UPDATE_CHECK: '0' };
  delete env.OMELETTE_STATUS; // the feed must be on whatever the runner's environment says
  return { dir, gate, env };
}

test('two gemini servers on one home: one snapshot each, each with its own active call; both files go when stdin closes', async () => {
  const w = workspace();
  const servers = [startServer(w.env, w.dir), startServer(w.env, w.dir)];
  try {
    for (const s of servers) {
      s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
      assert.ok((await s.reply(1)).result, 'initialize answered');
      s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gemini_research', arguments: { prompt: 'hold on' } } });
    }
    const pids = servers.map((s) => s.child.pid);
    await until(() => pids.every((pid) => readSnap(w.dir, pid).active.length === 1), 'both snapshots to show one active call');
    assert.deepEqual(geminiSnapshots(w.dir), pids.map((pid) => `status-gemini-${pid}.json`).sort());
    for (const pid of pids) {
      const snap = readSnap(w.dir, pid);
      assert.equal(snap.schema, 2);
      assert.equal(snap.pid, pid);
      assert.equal(snap.active[0].tool, 'gemini_research');
      assert.equal(snap.lastEvent, null, 'a new process carries no lastEvent over');
    }

    // Goodbye with the calls still in flight: each server drains its call,
    // answers it, and only then removes its own file and exits.
    for (const s of servers) s.child.stdin.end();
    writeFileSync(w.gate, '');
    for (const s of servers) {
      const r = await s.reply(2);
      assert.match(r.result.content[0].text, /released/);
      assert.deepEqual(await within(s.exited, 'the server to exit'), { code: 0, signal: null });
    }
    await until(() => geminiSnapshots(w.dir).length === 0, 'both snapshots to be removed');
  } finally {
    writeFileSync(w.gate, '');
    for (const s of servers) s.kill();
  }
});

test('a killed gemini server leaves its snapshot; the next gemini server to boot sweeps it', async () => {
  const w = workspace();
  writeFileSync(w.gate, ''); // no call is made here; nothing should wait
  const first = startServer(w.env, w.dir);
  let second;
  try {
    const dead = first.child.pid;
    await until(() => existsSync(join(w.dir, `status-gemini-${dead}.json`)), 'the first server to write its snapshot');
    first.kill();
    assert.equal((await within(first.exited, 'the killed server to exit')).signal, 'SIGKILL');
    assert.equal(existsSync(join(w.dir, `status-gemini-${dead}.json`)), true, 'a SIGKILLed server cannot clean up after itself');

    second = startServer(w.env, w.dir);
    const live = second.child.pid;
    await until(() => existsSync(join(w.dir, `status-gemini-${live}.json`)), 'the second server to write its snapshot');
    assert.deepEqual(geminiSnapshots(w.dir), [`status-gemini-${live}.json`]);
  } finally {
    first.kill();
    if (second) second.kill();
  }
});
