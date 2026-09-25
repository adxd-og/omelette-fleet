/**
 * omelette-fleet :: core/log.mjs
 * stderr-only logger. stdout belongs to JSON-RPC (the MCP stdio transport) —
 * a single stray byte there corrupts the stream and the client shows the
 * server as offline. Every write is wrapped: a closed stderr must never throw
 * into a tool call.
 */

/**
 * Every character that can hide, reorder or rewrite what the operator reads on
 * a terminal: the C0/C1 controls and DEL, the soft hyphen, the Arabic letter
 * mark, the Mongolian vowel separator, the zero-width, bidi and line/paragraph
 * separator format characters, the word joiner and invisible operators, the
 * BOM, the interlinear annotation controls, and the astral tag characters
 * (1.4.0 P3 and D-2). A value read from a JSON file, a config warning or a
 * cache can carry any of them — `\u001b[2K` erases a line, U+202E turns a
 * path around. Shared: core/config.mjs refuses an agent setting holding one,
 * and bin/omelette-fleet.mjs prints through `visible`.
 */
export const INVISIBLE_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/u;
const INVISIBLE_ALL = new RegExp(INVISIBLE_CHARS.source, 'gu');

/**
 * `s` with every INVISIBLE_CHARS character replaced by its escape — `\uXXXX`,
 * or `\u{XXXXX}` above the BMP. It is not injective: a value holding the six
 * characters `\u001b` and one holding a real ESC print alike, and that is
 * accepted — the output is for reading, not parsing.
 */
export const visible = (s) => String(s ?? '').replace(INVISIBLE_ALL, (c) => {
  const cp = c.codePointAt(0);
  return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
});

export function makeLog(prefix) {
  return (msg) => {
    // A unit's log line carries config warnings and vendor text: printed through
    // `visible`, so none of it reaches the operator's terminal as a control.
    try { process.stderr.write(`[${prefix}] ${visible(msg)}\n`); } catch { /* never throw from a log */ }
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
