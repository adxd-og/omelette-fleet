/**
 * omelette-fleet :: core/jsonrpc.mjs
 * Newline-delimited JSON-RPC 2.0 over stdin/stdout — the MCP stdio transport.
 *
 * `createHandler` is pure (message in, response object or null out) so the
 * protocol is testable without a process; `serve` wires it to stdin/stdout.
 * stdout carries ONLY JSON-RPC. Diagnostics go through `log` (stderr).
 */
export const DEFAULT_PROTOCOL = '2024-11-05';

/**
 * @param {{serverInfo:{name:string,version:string}, tools:object[],
 *          callTool:(name:string,args:object)=>Promise<{text:string,isError?:boolean}>}} o
 * @returns {(msg:object)=>Promise<object|null>} null = notification, nothing to send
 */
export function createHandler({ serverInfo, tools, callTool }) {
  return async function handle(msg) {
    const { id, method, params } = msg || {};
    const hasId = id !== undefined && id !== null;
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
            capabilities: { tools: {} },
            serverInfo,
          },
        };
      case 'notifications/initialized':
      case 'initialized':
        return null;
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools } };
      case 'tools/call': {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        let out;
        try {
          out = await callTool(name, args);
        } catch (e) {
          out = { text: 'Error: ' + ((e && e.message) || e), isError: true };
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: String((out && out.text) ?? '') }],
            ...(out && out.isError ? { isError: true } : {}),
          },
        };
      }
      default:
        return hasId
          ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } }
          : null;
    }
  };
}

/**
 * Hard cap on ONE un-terminated frame. A client that sends bytes and never a
 * newline would otherwise grow the buffer until V8 aborts the process — and
 * all the operator sees is the server going "offline" with no explanation.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Reassemble newline-delimited frames from arbitrary chunk boundaries; blank
 * lines are skipped. A frame that passes MAX_FRAME_BYTES without a newline is
 * DROPPED (and so is its tail, up to the next newline), `onOverflow` is called
 * ONCE per overflow episode, and the loop stays alive: one hostile or broken
 * frame must not take the server down.
 * @param {(line:string)=>void} onLine
 * @param {(droppedBytes:number)=>void} [onOverflow]
 */
export function createLineSplitter(onLine, onOverflow = () => {}) {
  let buf = '';
  let dropping = false;
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (dropping) { dropping = false; continue; } // the tail of a dropped frame
      if (line) onLine(line);
    }
    if (buf.length > MAX_FRAME_BYTES) {
      const dropped = buf.length;
      buf = '';
      if (!dropping) { dropping = true; onOverflow(dropped); }
    }
  };
}

/** Attach a handler to this process's stdin/stdout and never let a stray error kill the loop. */
export function serve({ serverInfo, tools, callTool, log = () => {} }) {
  const handle = createHandler({ serverInfo, tools, callTool });
  const send = (m) => { process.stdout.write(JSON.stringify(m) + '\n'); };
  process.on('uncaughtException', (e) => log('uncaught: ' + ((e && e.stack) || e)));
  process.on('unhandledRejection', (e) => log('unhandledRejection: ' + ((e && e.stack) || e)));
  const feed = createLineSplitter(
    (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; } // foreign bytes: drop the frame, keep the loop
      Promise.resolve(handle(msg))
        .then((res) => { if (res) send(res); })
        .catch((e) => log('handler: ' + ((e && e.stack) || e)));
    },
    (bytes) => log(`stdin: dropped a frame of ${bytes} bytes with no newline (cap ${MAX_FRAME_BYTES}) — still listening`),
  );
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', feed);
  process.stdin.on('end', () => process.exit(0));
}
