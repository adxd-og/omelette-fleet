#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/mcp-call.mjs
 * Drive one unit server over real stdio JSON-RPC, exactly as an MCP client
 * would: initialize → tools/list → tools/call.
 *
 *   node scripts/mcp-call.mjs <servers/x.mjs> <tool> '<json args>' [--timeout 900]
 *   node scripts/mcp-call.mjs servers/codex.mjs codex_models '{}'
 *
 * The transport itself moved to core/client.mjs when the CLI grew an
 * `omelette-fleet call` — both drive the same code path, so a fix in one is a
 * fix in the other. This stays as the low-level entry point that takes a
 * SERVER PATH rather than a unit name (any server, including one outside the
 * fleet), and every existing reference to it keeps working.
 *
 * Prints the server's stderr as it arrives (prefixed), then the tool result.
 * Exit code 0 on an ok result, 2 on an isError result, 1 on transport failure.
 */
import { resolve } from 'node:path';
import { callUnitServer } from '../core/client.mjs';

const [,, serverPath, tool, argsJson = '{}', ...rest] = process.argv;
if (!serverPath || !tool) {
  console.error('usage: mcp-call.mjs <server.mjs> <tool> [json-args] [--timeout S]');
  process.exit(1);
}
const ti = rest.indexOf('--timeout');
const timeoutS = ti >= 0 ? Number(rest[ti + 1]) || 900 : 900;
let args;
try { args = JSON.parse(argsJson); } catch (e) { console.error('bad json args:', e.message); process.exit(1); }

try {
  const res = await callUnitServer({
    serverPath: resolve(serverPath), tool, args, timeoutS,
    // `^` also matches after a trailing newline — skip that empty last line so
    // the phantom prefix does not land in front of the next stdout line.
    onStderr: (c) => process.stderr.write(String(c).replace(/^(?!$)/gm, '  │ ')),
    onProgress: (line) => console.log(line),
  });
  console.log(`tools/call → ${res.isError ? 'ERROR' : 'ok'} in ${(res.durationMs / 1000).toFixed(1)}s\n`);
  console.log(res.text);
  process.exitCode = res.isError ? 2 : 0;
} catch (e) {
  console.error(`[mcp-call] ${(e && e.message) || e}`);
  process.exitCode = 1;
}
