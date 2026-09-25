/**
 * omelette-fleet :: test/tester-1.6.0-t45.test.mjs
 * Clean-context tester file for 1.6.0's R4 (an honest protocol version) and
 * R5 + the "Docs and leftovers" bullets (README's read-only sentence, the
 * billingRiskEnv alias removal, the MEASUREMENTS additions), covering what
 * test/tester-1.6.0-r4.test.mjs and test/tester-1.6.0-r5.test.mjs do NOT:
 *   - the negotiation over REAL stdio (a spawned unit server), not just
 *     `createHandler` called in-process;
 *   - `omelette-fleet call`'s progress line actually saying "(protocol
 *     2025-11-25)", both at the transport level (what byte is on the wire)
 *     and end to end through the CLI against a real server;
 *   - that 2025-03-26's exclusion is a real, harmless no-op (a batch sent to
 *     a live server does not crash it and does not wedge it);
 *   - that `billingRiskEnv` is gone from the tree outside the throw site,
 *     CHANGELOG and the tests that pin it;
 *   - that the anchor README's new sentence links to actually resolves to a
 *     heading in SECURITY.md;
 *   - that the two new MEASUREMENTS sections the map table promises both
 *     exist as `## ` headings with slugs matching the map's links, and the
 *     1.5.0 matrix row carries the exact versions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callUnitServer } from '../core/client.mjs';
import { defineUnit } from '../core/unit.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const GEMINI_SERVER = join(ROOT, 'servers', 'gemini.mjs');

/** A fresh OMELETTE_HOME per test; nothing here touches the real one. */
function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-t45-'));
}

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

/* ── R4: negotiation over real stdio ──────────────────────────────────────── */

const NEGOTIATION_CASES = [
  ['2025-11-25', '2025-11-25'],
  ['2025-06-18', '2025-06-18'],
  ['2024-11-05', '2024-11-05'],
  ['2025-03-26', '2025-11-25'], // excluded on purpose (mandatory batches) — see R4
  ['banana', '2025-11-25'],
];

for (const [requested, expected] of NEGOTIATION_CASES) {
  test(`real stdio: initialize(${JSON.stringify(requested)}) answers ${expected}, and the connection keeps working`, async () => {
    const s = spawnServer(GEMINI_SERVER, { ...process.env, OMELETTE_HOME: home(), AGY_BIN: process.execPath, OMELETTE_UPDATE_CHECK: '0' });
    try {
      s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: requested } });
      const init = await s.next();
      assert.equal(init.id, 1);
      assert.equal(init.result.protocolVersion, expected, JSON.stringify(init));

      // notifications/initialized is id-less: the server must say nothing back.
      s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const list = await s.next();
      assert.equal(list.id, 2);
      assert.ok(Array.isArray(list.result.tools) && list.result.tools.length > 0, JSON.stringify(list));
      assert.ok(list.result.tools.some((t) => t.name === 'gemini_research'), JSON.stringify(list.result.tools.map((t) => t.name)));
    } finally { s.kill(); }
  });
}

test('real stdio: initialize with NO params at all still answers 2025-11-25', async () => {
  const s = spawnServer(GEMINI_SERVER, { ...process.env, OMELETTE_HOME: home(), AGY_BIN: process.execPath, OMELETTE_UPDATE_CHECK: '0' });
  try {
    s.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const init = await s.next();
    assert.equal(init.result.protocolVersion, '2025-11-25', JSON.stringify(init));
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await s.next();
    assert.ok(Array.isArray(list.result.tools) && list.result.tools.length > 0);
  } finally { s.kill(); }
});

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

test('omelette-fleet call, end to end against a real unit server, prints "initialize → … (protocol 2025-11-25)"', () => {
  const dir = home();
  const r = spawnSync(process.execPath, [BIN, 'call', 'codex', 'codex_models', '{}'], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /initialize → omelette-codex [^\n]*\(protocol 2025-11-25\)/, r.stdout);
});

/* ── Leftovers: billingRiskEnv is gone outside the throw, CHANGELOG and pins ─ */

test('defineUnit throws the exact spec text for billingRiskEnv; riskEnv alone carries no billingRiskEnv key', () => {
  const spec = (extra) => ({ name: 'acme', bin: 'acme', catalog: { isAllowedModel: () => true }, tools: [{ name: 'acme_models', description: 'd', inputSchema: {}, kind: 'catalog' }], ...extra });
  assert.throws(
    () => defineUnit(spec({ billingRiskEnv: ['X'] })),
    (e) => e.message === 'defineUnit(acme): billingRiskEnv was renamed riskEnv in 1.5.0',
  );
  const u = defineUnit(spec({ riskEnv: ['ACME_KEY'] }));
  assert.equal(Object.prototype.hasOwnProperty.call(u, 'billingRiskEnv'), false);
  assert.deepEqual(u.riskEnv, ['ACME_KEY']);
});

test('billingRiskEnv appears nowhere outside core/unit.mjs, CHANGELOG.md, the pinning tests and docs/superpowers/', () => {
  const grep = spawnSync('grep', [
    '-rln', 'billingRiskEnv',
    '--include=*.mjs', '--include=*.js', '--include=*.md',
    'README.md', 'docs', 'core', 'units', 'test', 'CHANGELOG.md',
  ], { cwd: ROOT, encoding: 'utf8' });
  // grep exit 1 = no matches; that would also be a pass, but this repo does
  // have pinning hits, so treat "no matches at all" as a fixture problem.
  assert.notEqual(grep.status, 2, grep.stderr);
  const hits = grep.stdout.split('\n').filter(Boolean);
  const allowed = new Set([
    'core/unit.mjs',
    'CHANGELOG.md',
    'test/tester-1.5.0-t3.test.mjs',
    'test/tester-1.6.0-r5.test.mjs',
    'test/env-allowlist-1.5.0.test.mjs',
    'test/tester-1.6.0-t45.test.mjs', // this file
  ]);
  const unexpected = hits.filter((f) => !allowed.has(f) && !f.startsWith('docs/superpowers/'));
  assert.deepEqual(unexpected, [], `billingRiskEnv leaked into: ${unexpected.join(', ')}`);
});

test('docs/CONFIG.md and docs/ADAPTERS.md mention only riskEnv, never billingRiskEnv', () => {
  for (const f of ['docs/CONFIG.md', 'docs/ADAPTERS.md']) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(text, /billingRiskEnv/, f);
  }
});

/* ── R5: README's read-only sentence and its anchor ───────────────────────── */

test('README:198 area links docs/SECURITY.md#threat-model, and that heading exists in SECURITY.md', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(
    readme,
    /Every unit tool is read-only by design — each vendor CLI runs under that vendor's own read-only enforcement \(a kernel sandbox for Codex, a permission policy for Gemini; \[SECURITY\]\(docs\/SECURITY\.md#threat-model\) says which is which\) under the default read-only mode \(`OMELETTE_ALLOW_WRITE` closed; \[SECURITY, "The ceiling"\]\(docs\/SECURITY\.md#the-ceiling\)\) — so approving each call one at a time buys you nothing\./,
  );
  assert.doesNotMatch(readme, /cannot write your repository/);
  const security = readFileSync(join(ROOT, 'docs', 'SECURITY.md'), 'utf8');
  assert.match(security, /^## Threat model$/m, 'no "## Threat model" heading in SECURITY.md — the README anchor would 404');
});

/* ── MEASUREMENTS: the two new sections, and the 1.5.0 matrix row ────────── */

test('MEASUREMENTS map table links both new 1.6.0 sections, and each resolves to a real heading', () => {
  const md = readFileSync(join(ROOT, 'docs', 'MEASUREMENTS.md'), 'utf8');
  const slug = (heading) => heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  const sections = [
    'What Claude Code sends at `initialize`',
    'Vendor CLI versions per release',
  ];
  for (const heading of sections) {
    const anchor = `#${slug(heading)}`;
    assert.ok(md.includes(`(${anchor})`), `map table has no link to ${anchor}`);
    assert.match(md, new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `no "## ${heading}" heading`);
  }
});

test('MEASUREMENTS: the vendor CLI matrix carries the 1.5.0 row with 1.2.11 | 1.0.41 | 0.156.1', () => {
  const md = readFileSync(join(ROOT, 'docs', 'MEASUREMENTS.md'), 'utf8');
  const from = md.indexOf('## Vendor CLI versions per release');
  assert.ok(from !== -1);
  const section = md.slice(from, from + 1500);
  assert.match(section, /\|\s*1\.5\.0 \(2026-09-25\)\s*\|\s*1\.2\.11\s*\|\s*1\.0\.41\s*\|\s*0\.156\.1\s*\|/);
});

test('MEASUREMENTS: the 1.6.0 matrix row is filled at the release (re-pinned from the placeholder, 2026-09-26)', () => {
  const md = readFileSync(join(ROOT, 'docs', 'MEASUREMENTS.md'), 'utf8');
  const from = md.indexOf('## Vendor CLI versions per release');
  const section = md.slice(from, from + 1500);
  assert.match(section, /\|\s*1\.6\.0 \(\d{4}-\d{2}-\d{2}\)\s*\|\s*1\.2\.11\s*\|\s*1\.0\.41\s*\|\s*0\.157\.0\s*\|/);
});
