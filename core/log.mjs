/**
 * omelette-fleet :: core/log.mjs
 * stderr-only logger. stdout belongs to JSON-RPC (the MCP stdio transport) —
 * a single stray byte there corrupts the stream and the client shows the
 * server as offline. Every write is wrapped: a closed stderr must never throw
 * into a tool call.
 */
export function makeLog(prefix) {
  return (msg) => {
    try { process.stderr.write(`[${prefix}] ${msg}\n`); } catch { /* never throw from a log */ }
  };
}

/** Log each distinct message once per process — for config warnings that would otherwise repeat on every call. */
export function makeOnceLog(log) {
  const seen = new Set();
  return (msg) => {
    if (seen.has(msg)) return;
    seen.add(msg);
    log(msg);
  };
}
