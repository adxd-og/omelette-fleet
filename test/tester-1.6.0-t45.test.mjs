/**
 * omelette-fleet :: test/tester-1.6.0-t45.test.mjs
 * Clean-context tester file for 1.6.0's R4 (an honest protocol version):
 * `omelette-fleet call`'s client asks for 2025-11-25 at initialize and its
 * progress line says "(protocol 2025-11-25)" — checked against a server that
 * echoes whatever was requested, so the printed version is the one the client
 * sent. The server side of the negotiation is pinned in
 * test/tester-1.6.0-r4.test.mjs. Also: an array frame (a 2025-03-26 batch)
 * sent to a live server neither crashes nor wedges it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callUnitServer } from '../core/client.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GEMINI_SERVER = join(ROOT, 'servers', 'gemini.mjs');

/** A fresh OMELETTE_HOME per test; nothing here touches the real one. */
function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-t45-'));
}

/* ── R4: the client always asks for 2025-11-25 ────────────────────────────── */

function fakeEchoServer(dir) {
  const p = join(dir, 'echo-server.mjs');
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => {',
    '  buf += c; let nl;',
    '  while ((nl = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);',
    '    if (!line) continue;',
    '    const m = JSON.parse(line);',
    '    if (m.id === undefined) continue;',
    '    if (m.method === "initialize") {',
    // Echo back exactly what was requested — a real, listed-version server
    // would too, so this is the same wire behaviour without needing a fake CLI.
    '      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || "(none)", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "0" } } });',
    '    } else if (m.method === "tools/list") {',
    '      send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }] } });',
    '    } else {',
    '      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } });',
    '    }',
    '  }',
    '});',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

test('core/client.mjs (callUnitServer) requests protocolVersion 2025-11-25 at initialize, and says so in its progress line', async () => {
  const dir = home();
  const echo = fakeEchoServer(dir);
  const lines = [];
  const res = await callUnitServer({ serverPath: echo, tool: 't', args: {}, timeoutS: 20, onProgress: (l) => lines.push(l) });
  assert.equal(res.text, 'ok');
  const initLine = lines.find((l) => l.startsWith('initialize'));
  assert.ok(initLine, lines.join('\n'));
  // The server echoed back whatever was requested — so if the printed
  // protocol is 2025-11-25, the client asked for 2025-11-25.
  assert.match(initLine, /\(protocol 2025-11-25\)/, initLine);
});

/**
 * Spawn a real MCP stdio server and let the caller drive it message by
 * message. `next()` resolves the next parsed JSON line off stdout (queued if
 * it already arrived), so the caller can interleave `send`/`next` exactly
 * like a real client does, including id-less notifications.
 */
function spawnServer(serverPath, env) {
  const child = spawn(process.execPath, [serverPath], { env });
  const queue = [];
  const waiters = [];
  let buf = '';
  let stderrText = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (waiters.length) waiters.shift()(m);
      else queue.push(m);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderrText += c; });
  child.on('error', () => {});
  return {
    child,
    send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); },
    sendRawLine(text) { child.stdin.write(text + '\n'); },
    next(timeoutMs = 8000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`no message from ${serverPath} in ${timeoutMs}ms · stderr: ${stderrText.trim() || '(none)'}`)),
          timeoutMs,
        );
        waiters.push((m) => { clearTimeout(t); resolve(m); });
      });
    },
    stderrText: () => stderrText,
    kill() { try { child.kill('SIGKILL'); } catch { /* already gone */ } },
  };
}

/* ── R4: 2025-03-26 exclusion is honest — a batch is harmless, not fatal ──── */

test('a JSON-RPC batch (array) sent to a live server gets no crash and no reply, and the server keeps answering afterward', async () => {
  const s = spawnServer(GEMINI_SERVER, { ...process.env, OMELETTE_HOME: home(), AGY_BIN: process.execPath, OMELETTE_UPDATE_CHECK: '0' });
  try {
    s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    await s.next();

    // A batch: one JSON-RPC frame that is an array, on one line, exactly as
    // a 2025-03-26-aware client sending "receiving batches is mandatory"
    // would send it.
    s.sendRawLine(JSON.stringify([
      { jsonrpc: '2.0', id: 99, method: 'ping' },
      { jsonrpc: '2.0', id: 100, method: 'ping' },
    ]));

    // The server must not die from it: prove the process is still alive and
    // still answering by sending a plain request right after and getting a
    // reply — if the batch had produced an error frame or a pong, it would
    // arrive first and this assertion would see it instead.
    s.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const reply = await s.next(8000);
    assert.equal(reply.id, 2, `expected the ping's own reply, got ${JSON.stringify(reply)} — the batch produced an unexpected frame`);
    assert.deepEqual(reply.result, {});
    assert.equal(s.child.exitCode, null, 'server must still be alive');
  } finally { s.kill(); }
});
