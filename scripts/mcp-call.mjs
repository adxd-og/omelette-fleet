#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/mcp-call.mjs
 * Drive one unit server over real stdio JSON-RPC, exactly as an MCP client
 * would: initialize → tools/list → tools/call, keeping stdin OPEN until the
 * call answers (a server exits on stdin EOF by design — that is how a client
 * says goodbye — so a naive `printf | node server` cuts every real call off).
 *
 *   node scripts/mcp-call.mjs <servers/x.mjs> <tool> '<json args>' [--timeout 900]
 *   node scripts/mcp-call.mjs servers/codex.mjs codex_models '{}'
 *
 * Prints the server's stderr as it arrives (prefixed), then the tool result.
 * Exit code 0 on an ok result, 2 on an isError result, 1 on transport failure.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const [,, serverPath, tool, argsJson = '{}', ...rest] = process.argv;
if (!serverPath || !tool) {
  console.error('usage: mcp-call.mjs <server.mjs> <tool> [json-args] [--timeout S]');
  process.exit(1);
}
const ti = rest.indexOf('--timeout');
const timeoutS = ti >= 0 ? Number(rest[ti + 1]) || 900 : 900;
let args;
try { args = JSON.parse(argsJson); } catch (e) { console.error('bad json args:', e.message); process.exit(1); }

const child = spawn(process.execPath, [resolve(serverPath)], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => process.stderr.write(c.replace(/^/gm, '  │ ')));

const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
let buf = '';
let listed = false;
const t0 = Date.now();
const timer = setTimeout(() => { console.error(`\n[mcp-call] no answer after ${timeoutS}s — killing server`); child.kill('SIGKILL'); process.exit(1); }, timeoutS * 1000);

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { console.error('[mcp-call] non-JSON on stdout:', line.slice(0, 200)); continue; }
    if (m.id === 1) {
      console.log(`initialize → ${m.result.serverInfo.name} ${m.result.serverInfo.version} (protocol ${m.result.protocolVersion})`);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    } else if (m.id === 2) {
      listed = true;
      const names = m.result.tools.map((t) => t.name);
      console.log(`tools/list → ${names.join(', ')}`);
      if (!names.includes(tool)) { console.error(`[mcp-call] tool "${tool}" not offered`); child.kill(); process.exit(1); }
      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: args } });
    } else if (m.id === 3) {
      clearTimeout(timer);
      const r = m.result || {};
      const text = (r.content || []).map((c) => c.text).join('\n');
      console.log(`tools/call → ${r.isError ? 'ERROR' : 'ok'} in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
      console.log(text);
      child.stdin.end(); // goodbye — server exits on EOF
      setTimeout(() => process.exit(r.isError ? 2 : 0), 100);
    }
  }
});
child.on('exit', (code) => { if (!listed) { console.error(`[mcp-call] server exited early (code ${code})`); process.exit(1); } });

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'mcp-call', version: '0' } } });
