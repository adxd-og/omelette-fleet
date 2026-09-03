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
 * EVERY WAY THE CALL CAN DIE IS A REJECTION, and none of them waits out the
 * timeout: a JSON-RPC `error` reply (to any of the three requests), a child
 * that exits, a stdin that closes under us. The one that used to hurt: an
 * `error` reply to tools/call was read as an empty result and reported as
 * SUCCESS, exit 0.
 *
 * Rejects only on transport failure. A tool that answers with isError is a
 * RESOLVED result — that is the unit talking, not the pipe breaking, and
 * callers map it to their own exit code.
 */
import { spawn } from 'node:child_process';
import { createLineSplitter } from './jsonrpc.mjs';

/**
 * Node's timers are int32 milliseconds: anything past ~24.8 days silently
 * becomes 1 ms and fires an INSTANT false "no answer". Clamp instead — a day
 * is already far past any real tool call.
 */
export const MAX_TIMEOUT_S = 86400;

const REQUESTS = { 1: 'initialize', 2: 'tools/list', 3: 'tools/call' };

/** JSON-RPC errors are `{code, message}`; keep whatever shape actually arrives readable. */
const rpcError = (m) => {
  if (!m || m.error === undefined || m.error === null) return null;
  const e = m.error;
  if (typeof e === 'string') return e;
  const msg = e.message || JSON.stringify(e);
  return e.code === undefined ? msg : `${msg} (code ${e.code})`;
};

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
    const seconds = Math.min(Math.max(Number(timeoutS) || 0, 1), MAX_TIMEOUT_S);
    let child;
    try {
      child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (e) {
      reject(new Error(`could not start ${serverPath}: ${(e && e.message) || e}`));
      return;
    }

    const t0 = Date.now();
    let settled = false;
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

    timer = setTimeout(() => fail(new Error(`no answer after ${seconds}s — server killed`)), seconds * 1000);

    const send = (m) => { try { child.stdin.write(JSON.stringify(m) + '\n'); } catch { /* the handlers below report it */ } };
    // A pipe that breaks under an unanswered request is a dead call, not a
    // detail to swallow. Once we have settled these are only the goodbye we
    // asked for, and `finish` makes them no-ops.
    child.stdin.on('error', (e) => fail(new Error(`server stdin failed: ${(e && e.message) || e}`)));
    child.stdin.on('close', () => fail(new Error('server closed its stdin before answering')));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', onStderr);
    child.stderr.on('error', () => {});
    child.on('error', (e) => fail(new Error(`server process error: ${(e && e.message) || e}`)));
    // An exit at ANY unsettled point — after tools/list too, not just before
    // it — fails now. Waiting out the timeout for a process that is already
    // gone helps nobody.
    child.on('exit', (code, signal) => fail(new Error(
      `server exited early (code ${code}${signal ? `, signal ${signal}` : ''})`,
    )));

    child.stdout.setEncoding('utf8');
    child.stdout.on('error', () => {});
    child.stdout.on('data', createLineSplitter((line) => {
      let m;
      try { m = JSON.parse(line); } catch { onProgress(`non-JSON on stdout: ${line.slice(0, 200)}`); return; }
      if (!REQUESTS[m.id]) return; // a notification, or someone else's id
      const e = rpcError(m);
      if (e) { fail(new Error(`server error on ${REQUESTS[m.id]}: ${e}`)); return; }
      if (!m.result || typeof m.result !== 'object') {
        fail(new Error(`server answered ${REQUESTS[m.id]} with neither result nor error`));
        return;
      }
      if (m.id === 1) {
        serverInfo = m.result.serverInfo || {};
        onProgress(`initialize → ${serverInfo.name} ${serverInfo.version} (protocol ${m.result.protocolVersion})`);
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      } else if (m.id === 2) {
        toolNames = (m.result.tools || []).map((t) => t.name);
        onProgress(`tools/list → ${toolNames.join(', ')}`);
        if (!toolNames.includes(tool)) {
          fail(new Error(`tool "${tool}" is not offered by ${serverPath} (has: ${toolNames.join(', ') || 'none'})`));
          return;
        }
        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: args } });
      } else {
        const r = m.result;
        const text = (r.content || []).map((c) => c && c.text).filter(Boolean).join('\n');
        // Settle FIRST: everything below is the goodbye, and the stdin close
        // it causes must not read as the server hanging up on us.
        ok({ text, isError: !!r.isError, durationMs: Date.now() - t0, serverInfo: serverInfo || {}, tools: toolNames });
        child.stdin.end(); // the server exits on EOF
        const bye = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
        if (bye.unref) bye.unref();
        child.on('close', () => clearTimeout(bye));
      }
    }, (bytes) => onProgress(`dropped ${bytes} bytes of stdout with no newline — still listening`)));

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', clientInfo: { name: 'omelette-fleet', version: '0' } },
    });
  });
}
