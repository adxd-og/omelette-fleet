/**
 * omelette-fleet :: test/tester-1.6.0-t7.test.mjs
 * Tester T7 — coverage the coder's own U1 file (test/tester-1.6.0-u1.test.mjs)
 * does not reach: the timeout chain through the REAL `bin/omelette-fleet.mjs
 * call` binary (not `callUnitServer` alone), SIGHUP (the coder only tried
 * SIGTERM), a server with nothing in flight (N=0 is silent), two calls in
 * flight in one server, the stdin-end path's silence on `shutdown: killed`,
 * `killLiveGroups()` against a group that is already gone, and the SECURITY.md
 * bullet's exact wording plus its MEASUREMENTS anchor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as spawnMod from '../core/spawn.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const GEMINI_SERVER = join(ROOT, 'servers', 'gemini.mjs');
const DEADLINE_MS = 10_000;

/** Poll `check` until it returns truthy or the deadline passes; fails past it. */
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
 * A fake `agy` that starts a grandchild in its OWN process group (no
 * `detached`, so it shares agy's group), writes both pids AND the fake agy's
 * `process.ppid` (the real unit server that spawned it) to `pidFile` (renamed
 * into place), then sleeps 60 s without answering.
 */
function groupAgy(dir, pidFile) {
  const p = join(dir, 'fake-agy-group');
  writeFileSync(p, [
    `#!${process.execPath}`,
    "const { spawn } = require('child_process');",
    "const { renameSync, writeFileSync } = require('fs');",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(pidFile + '.tmp')}, JSON.stringify({ agy: process.pid, grandchild: g.pid, server: process.ppid }));`,
    `renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)});`,
    'setTimeout(() => {}, 60000);',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** A fake `agy` that appends its own pid to `log` on start, then sleeps 60 s without answering. */
function loudAgy(dir, name, log) {
  const p = join(dir, name);
  writeFileSync(p, [
    `#!${process.execPath}`,
    "const { appendFileSync } = require('fs');",
    `appendFileSync(${JSON.stringify(log)}, 'pid ' + process.pid + '\\n');`,
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
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t7-'));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: agyFor(dir), OMELETTE_UPDATE_CHECK: '0' };
  delete env.OMELETTE_STATUS; // the feed must be on whatever the runner's environment says
  return { dir, env };
}

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } };
const research = (id, prompt) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'gemini_research', arguments: { prompt } } });

// ─── 1. the real CLI, end to end ────────────────────────────────────────────

test('call --timeout through the real CLI binary: exit 1 with the new message, and the fake agy, its grandchild and the server are all gone', async () => {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t7-'));
  const pidFile = join(dir, 'pids.json');
  const agy = groupAgy(dir, pidFile);
  const env = { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: agy };
  let pids = null;
  try {
    // spawnSync returns only once the CLI's OWN process has exited — and that
    // process does not exit until the server it spawned does (the SIGTERM/
    // SIGKILL timers in core/client.mjs are not unref'd), so this return is
    // already proof the whole chain has settled, not just the client promise.
    const r = spawnSync(process.execPath, [
      BIN, 'call', 'gemini', 'gemini_research', JSON.stringify({ prompt: 'run long — t7 e2e' }), '--timeout', '3',
    ], { cwd: dir, encoding: 'utf8', env, timeout: 9500 });
    assert.equal(r.status, 1, `exit code · stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /omelette-fleet call: no answer after 3s — server cancelled and killed/);
    pids = JSON.parse(readFileSync(pidFile, 'utf8'));
    await until(() => !alive(pids.agy) && !alive(pids.grandchild) && !alive(pids.server),
      'the fake agy, its grandchild and the server to all be gone');
    assert.ok(Date.now() - t0 < DEADLINE_MS, `took ${Date.now() - t0} ms`);
  } finally {
    if (pids) { killQuietly(pids.agy); killQuietly(pids.grandchild); killQuietly(pids.server); }
  }
});

// ─── 2. SIGHUP (the coder only tried SIGTERM) ───────────────────────────────

test('SIGHUP to a unit server kills its live process groups and removes the snapshot, same as SIGTERM', async () => {
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

    process.kill(s.child.pid, 'SIGHUP');
    assert.deepEqual(await within(s.exited, 'the server to exit on SIGHUP'), { code: 0, signal: null });
    await until(() => !alive(pids.agy) && !alive(pids.grandchild), 'the fake agy and its grandchild to be gone');
    assert.equal(existsSync(snapshot), false, 'the snapshot went with the process');
    assert.match(s.stderr, /SIGHUP: shutting down/);
    assert.match(s.stderr, /shutdown: killed 1 process group\(s\)/);
  } finally {
    s.kill();
    if (pids) { killQuietly(pids.agy); killQuietly(pids.grandchild); }
  }
});

// ─── 3. SIGTERM with nothing in flight: N=0 is silent ───────────────────────

test('SIGTERM with no call in flight: exit 0, snapshot removed, no "shutdown: killed" line', async () => {
  const w = workspace(slowAgy); // never invoked — no call is made
  const s = startServer(w.env, w.dir);
  try {
    const snapshot = join(w.dir, `status-gemini-${s.child.pid}.json`);
    s.send(INITIALIZE);
    assert.ok((await s.reply(1)).result, 'initialize answered');
    await until(() => existsSync(snapshot), 'the snapshot to be written at boot, before any call');

    process.kill(s.child.pid, 'SIGTERM');
    assert.deepEqual(await within(s.exited, 'the server to exit on SIGTERM'), { code: 0, signal: null });
    assert.equal(existsSync(snapshot), false, 'the snapshot went with the process');
    assert.match(s.stderr, /SIGTERM: shutting down/);
    assert.doesNotMatch(s.stderr, /shutdown: killed/, `N=0 must be silent · stderr:\n${s.stderr}`);
  } finally {
    s.kill();
  }
});

// ─── 4. two calls in flight: both groups gone, the count says 2 ────────────

test('SIGTERM with two calls in flight kills both vendor groups; the log names the count', async () => {
  const log = mkdtempSync(join(tmpdir(), 'omelette-t7-'));
  const agyLog = join(log, 'agy-started.log');
  const w = workspace((dir) => loudAgy(dir, 'fake-agy-multi', agyLog));
  const s = startServer(w.env, w.dir);
  let pids = null;
  try {
    s.send(INITIALIZE);
    assert.ok((await s.reply(1)).result, 'initialize answered');
    s.send(research(3, 'first'));
    s.send(research(4, 'second'));
    pids = await until(() => {
      const lines = existsSync(agyLog) ? readFileSync(agyLog, 'utf8').split('\n').filter(Boolean) : [];
      return lines.length >= 2 ? lines.map((l) => Number(l.split(' ')[1])) : null;
    }, 'both fake agy processes to start');
    assert.equal(pids.length, 2, 'exactly two vendor processes started');
    assert.ok(pids.every(alive), 'both vendor processes run before the signal');

    process.kill(s.child.pid, 'SIGTERM');
    assert.deepEqual(await within(s.exited, 'the server to exit on SIGTERM'), { code: 0, signal: null });
    await until(() => pids.every((pid) => !alive(pid)), 'both fake agy processes to be gone');
    assert.match(s.stderr, /shutdown: killed 2 process group\(s\)/);
  } finally {
    s.kill();
    if (pids) pids.forEach(killQuietly);
  }
});

// ─── 5. stdin end with a call still landing: no "shutdown: killed" either ──

test('stdin end with a 2 s call in flight: the answer still lands, exit 0, no "shutdown: killed" line (the group is empty by then)', async () => {
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
    assert.doesNotMatch(s.stderr, /shutdown: killed/, `the run already ended, nothing left to kill · stderr:\n${s.stderr}`);
    assert.ok(Date.now() - t0 < DEADLINE_MS, `took ${Date.now() - t0} ms`);
  } finally {
    s.kill();
  }
});

// ─── 6. killLiveGroups(): safety on an already-gone group ──────────────────

test('killLiveGroups(): safe on a pid whose group is already gone — never throws, returns 0, forgets it either way', async () => {
  const { killLiveGroups, liveGroupCount, runProcess } = spawnMod;
  assert.equal(liveGroupCount(), 0, 'starts empty');
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t7-'));
  const pidFile = join(dir, 'pid.txt');
  const script = join(dir, 'self.mjs');
  writeFileSync(script, [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'setTimeout(() => {}, 60000);',
  ].join('\n'));
  const p = runProcess({ bin: process.execPath, args: [script] });
  assert.equal(liveGroupCount(), 1, 'tracked as soon as it is spawned');
  const pid = Number(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 'the run to report its own pid'));

  // Kill the OS-level group ourselves, bypassing killLiveGroups: the group is
  // now genuinely gone, whether or not the registry has noticed yet.
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  await until(() => !alive(pid), 'the process to actually be dead');

  let n;
  assert.doesNotThrow(() => { n = killLiveGroups(); }, 'killLiveGroups never throws on an already-gone group');
  assert.equal(n, 0, 'nothing was actually reached — it was already gone');
  assert.equal(liveGroupCount(), 0, 'forgotten either way');
  await within(p, 'the run to settle');
});

// ─── 7. SECURITY.md's bullet ────────────────────────────────────────────────

test('SECURITY.md: the process-group-kill bullet names SIGTERM/SIGHUP, call --timeout, the SIGKILL case, its own group, and a MEASUREMENTS anchor that exists', () => {
  const security = readFileSync(join(ROOT, 'docs', 'SECURITY.md'), 'utf8');
  const line = security.split('\n').find((l) => l.includes('The process-group kill.'));
  assert.ok(line, 'the bullet exists');
  for (const fragment of [
    'SIGTERM or SIGHUP',
    '`omelette-fleet call --timeout` cancels',
    'SIGKILLed outright',
    'own process group',
    'MEASUREMENTS.md#unit-processes-after-the-server-is-gone',
  ]) {
    assert.ok(line.includes(fragment), `bullet contains ${JSON.stringify(fragment)} · line:\n${line}`);
  }
  const measurements = readFileSync(join(ROOT, 'docs', 'MEASUREMENTS.md'), 'utf8');
  assert.ok(measurements.includes('## Unit processes after the server is gone'), 'the linked section exists in MEASUREMENTS.md');
});
