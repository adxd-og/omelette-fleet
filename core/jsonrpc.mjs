/**
 * omelette-fleet :: core/jsonrpc.mjs
 * Newline-delimited JSON-RPC 2.0 over stdin/stdout — the MCP stdio transport.
 *
 * `createHandler` is pure (message in, response object or null out) so the
 * protocol is testable without a process; `serve` wires it to stdin/stdout.
 * stdout carries ONLY JSON-RPC. Diagnostics go through `log` (stderr).
 *
 * A `tools/call` is a REQUEST with a lifecycle, not a bare promise: the handler
 * keeps it in an in-flight table keyed by its id, hands the tool a context
 * (id, progress token, abort signal, notify) and drops the response of a
 * request the client cancelled. `serve` drains that table before it exits.
 */
export const DEFAULT_PROTOCOL = '2024-11-05';

/**
 * SPIKE 1a (2026-09-08), kept as a debugging aid: MCP progress can only be sent
 * for a request whose client supplied `params._meta.progressToken`, and nothing
 * in the protocol says whether a given client does. With this set, every
 * `tools/call` logs the `_meta` it arrived with — run one real call, read the
 * unit's stderr, and the question is settled for that client.
 */
export const DEBUG_META_VAR = 'OMELETTE_DEBUG_META';
const DEBUG_WORDS = new Set(['1', 'true', 'on', 'yes']);

/** Never throws, never floods stderr — this is a debug line, not a payload. */
function safeJson(v) {
  try { return JSON.stringify(v ?? null).slice(0, 2000); } catch { return '(unserialisable)'; }
}

/**
 * @param {{serverInfo:{name:string,version:string}, tools:object[],
 *          callTool:(name:string,args:object,call:object)=>Promise<{text:string,isError?:boolean}>,
 *          instructions?:string, notify?:(msg:object)=>void, log?:(m:string)=>void, env?:object}} o
 *   `instructions` is MCP's `InitializeResult.instructions`: text the client puts
 *   in the model's context at connect time. Blank or absent → the key is omitted.
 * @returns {(msg:object)=>Promise<object|null>} null = notification, nothing to send
 */
export function createHandler({
  serverInfo, tools, callTool, instructions,
  notify = () => {}, log = () => {}, env = process.env,
}) {
  const ins = typeof instructions === 'string' && instructions.trim() ? instructions : null;
  const debugMeta = DEBUG_WORDS.has(String(env[DEBUG_META_VAR] || '').trim().toLowerCase());
  // In-flight `tools/call` requests. The key carries the id's TYPE as well as
  // its value: `1` and `"1"` are two different requests on the wire, and a
  // cancellation naming one must never reach the other.
  const inflight = new Map();
  const drainWaiters = [];
  const keyOf = (id) => `${typeof id} ${String(id)}`;
  const releaseDrain = () => {
    if (inflight.size) return;
    while (drainWaiters.length) drainWaiters.shift()();
  };

  async function handle(msg) {
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
            ...(ins ? { instructions: ins } : {}),
          },
        };
      case 'notifications/initialized':
      case 'initialized':
        return null;
      case 'notifications/cancelled': {
        // MCP: a receiver MAY ignore a cancellation it cannot honour, and an
        // unknown or already-finished id is exactly that. There is no id to
        // answer on a notification, so this is silence either way.
        const rid = params && params.requestId;
        if (rid !== undefined && rid !== null) {
          const entry = inflight.get(keyOf(rid));
          if (entry) {
            log(`notifications/cancelled · request ${JSON.stringify(rid)}`);
            entry.controller.abort();
          }
        }
        return null;
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools } };
      case 'tools/call': {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const meta = params && params._meta && typeof params._meta === 'object' ? params._meta : null;
        if (debugMeta) log(`tools/call _meta=${safeJson(meta)}`);
        const controller = new AbortController();
        // An id-less `tools/call` is not a request anyone can cancel or wait
        // for, so it is not tracked; it still gets a (never aborted) signal.
        const key = hasId ? keyOf(id) : null;
        if (key !== null) inflight.set(key, { id, controller });
        let done = false;
        const call = {
          id: hasId ? id : null,
          progressToken: meta && meta.progressToken !== undefined && meta.progressToken !== null
            ? meta.progressToken
            : null,
          signal: controller.signal,
          notify(m, p) {
            // The response ends the exchange: nothing is sent after it, and a
            // broken stdout is a log line, never a failed tool call.
            if (done) return;
            try { notify({ jsonrpc: '2.0', method: m, ...(p === undefined ? {} : { params: p }) }); }
            catch (e) { log('notify: ' + ((e && e.message) || e)); }
          },
        };
        let out;
        try {
          out = await callTool(name, args, call);
        } catch (e) {
          out = { text: 'Error: ' + ((e && e.message) || e), isError: true };
        } finally {
          done = true;
          if (key !== null) inflight.delete(key);
          releaseDrain();
        }
        // Cancelled: the client stopped waiting for this one. The spec says a
        // response to a cancelled request is ignored, and sending it anyway
        // confuses a client that has already moved on.
        if (controller.signal.aborted) {
          log(`tools/call ${name} · cancelled · response dropped`);
          return null;
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
  }

  handle.inflight = () => inflight.size;
  handle.drain = () => (inflight.size === 0
    ? Promise.resolve()
    : new Promise((resolve) => { drainWaiters.push(resolve); }));
  return handle;
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

/**
 * Attach a handler to this process's stdin/stdout and never let a stray error kill the loop.
 * `instructions` is passed straight through to `createHandler`; `send` doubles
 * as the notification sink, so progress reaches the client on the same stream.
 */
export function serve({ serverInfo, tools, callTool, instructions, log = () => {}, env = process.env }) {
  const send = (m) => { process.stdout.write(JSON.stringify(m) + '\n'); };
  const handle = createHandler({ serverInfo, tools, callTool, instructions, notify: send, log, env });
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
  process.stdin.on('end', () => {
    // A client that closed stdin has said goodbye — but a run it already paid
    // for may still be in flight, and each one is bounded by the unit's
    // timeoutS. Stop reading, let them land, then go.
    process.stdin.removeListener('data', feed);
    process.stdin.pause();
    const n = handle.inflight();
    if (n) log(`stdin closed with ${n} call(s) in flight — finishing them before exit`);
    // setImmediate, not a bare exit: the drain resolves inside the handler's
    // `finally`, one microtask BEFORE the response is handed to `send`. The
    // check phase runs after every pending microtask, so the answer is written.
    // Written is not flushed: a write to a PIPE is asynchronous, and a response
    // larger than the pipe buffer is still queued when the check phase runs —
    // process.exit() there would cut the frame off mid-string. The callback of
    // an empty write runs only once every write queued before it has gone out,
    // so this exits on the last byte of the answer, not on the first.
    handle.drain().then(
      () => setImmediate(() => process.stdout.write('', () => process.exit(0))),
      () => setImmediate(() => process.stdout.write('', () => process.exit(0))),
    );
  });
}
