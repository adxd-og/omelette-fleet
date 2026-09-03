/**
 * omelette-fleet :: core/client.mjs
 * The other side of core/jsonrpc.mjs — drive ONE unit server over real stdio
 * the way an MCP client does: initialize → tools/list → tools/call.
 *
 * WHY A CLIENT AT ALL: the only honest test of a unit is the transport a real
 * client uses. Importing the adapter and calling `run()` skips the framing,
 * the tool list, and the stdin lifetime — exactly where stdio servers break.
 *
 * STDIN STAYS OPEN until the call answers. A server exits on stdin EOF by
 * design (that is how a client says goodbye), so `printf | node server` cuts
 * every real call off mid-flight. We write frames, wait, and only then end
 * stdin — with an unref'd SIGKILL backstop for a server that ignores EOF.
 *
 * NEVER SHELLS OUT: spawn(process.execPath, [serverPath]) with an args array,
 * so a path with a space or a `$` is a path, not shell syntax.
 *
 * Rejects only on transport failure (no answer, tool not offered, server died
 * early). A tool that answers with isError is a RESOLVED result — that is the
 * unit talking, not the pipe breaking, and callers map it to their own exit
 * code.
 */
import { spawn } from 'node:child_process';
import { createLineSplitter } from './jsonrpc.mjs';

/**
 * @param {{serverPath:string, tool:string, args?:object, timeoutS?:number, env?:object,
 *          onStderr?:(chunk:string)=>void, onProgress?:(line:string)=>void}} o
 * @returns {Promise<{text:string, isError:boolean, durationMs:number, serverInfo:object, tools:string[]}>}
 */
export function callUnitServer({
  serverPath, tool, args = {}, timeoutS = 900, env = process.env,
  onStderr = () => {}, onProgress = () => {},
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (e) {
      reject(new Error(`could not start ${serverPath}: ${(e && e.message) || e}`));
      return;
    }

    const t0 = Date.now();
    let settled = false;
    let listed = false;
    let serverInfo = null;
    let toolNames = [];
    let timer = null;

    const finish = (fn) => (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(v);
    };
    const ok = finish(resolve);
    const fail = finish((e) => { try { child.kill('SIGKILL'); } catch { /* gone */ } reject(e); });

    timer = setTimeout(() => fail(new Error(`no answer after ${timeoutS}s — server killed`)), timeoutS * 1000);

    const send = (m) => { try { child.stdin.write(JSON.stringify(m) + '\n'); } catch { /* closed */ } };
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', onStderr);
    child.stderr.on('error', () => {});
    child.on('error', (e) => fail(new Error(`server process error: ${(e && e.message) || e}`)));
    child.on('exit', (code) => { if (!listed) fail(new Error(`server exited early (code ${code})`)); });

    child.stdout.setEncoding('utf8');
    child.stdout.on('error', () => {});
    child.stdout.on('data', createLineSplitter((line) => {
      let m;
      try { m = JSON.parse(line); } catch { onProgress(`non-JSON on stdout: ${line.slice(0, 200)}`); return; }
      if (m.id === 1) {
        serverInfo = (m.result && m.result.serverInfo) || {};
        onProgress(`initialize → ${serverInfo.name} ${serverInfo.version} (protocol ${m.result && m.result.protocolVersion})`);
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      } else if (m.id === 2) {
        listed = true;
        toolNames = ((m.result && m.result.tools) || []).map((t) => t.name);
        onProgress(`tools/list → ${toolNames.join(', ')}`);
        if (!toolNames.includes(tool)) {
          fail(new Error(`tool "${tool}" is not offered by ${serverPath} (has: ${toolNames.join(', ') || 'none'})`));
          return;
        }
        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: args } });
      } else if (m.id === 3) {
        const r = m.result || {};
        const text = (r.content || []).map((c) => c && c.text).filter(Boolean).join('\n');
        child.stdin.end(); // goodbye — the server exits on EOF
        const bye = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
        if (bye.unref) bye.unref();
        child.on('close', () => clearTimeout(bye));
        ok({ text, isError: !!r.isError, durationMs: Date.now() - t0, serverInfo: serverInfo || {}, tools: toolNames });
      }
    }, (bytes) => onProgress(`dropped ${bytes} bytes of stdout with no newline — still listening`)));

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', clientInfo: { name: 'omelette-fleet', version: '0' } },
    });
  });
}
