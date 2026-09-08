/**
 * omelette-fleet :: core/status.mjs
 * The fleet status feed — what each unit is doing right now, for a menu-bar
 * app, a HUD, or `tail -f`.
 *
 * FILE CONTRACT (schema 1 — readers are built against this; changes bump the
 * number, never silently reshape a field):
 *   <home>/status-<unit>.json   per-unit snapshot, written ATOMICALLY (tmp + rename)
 *     { schema, unit, active: [{id, tool, model, effort, promptPreview, startedAt, resultId}],
 *       lastEvent: {tool, status, endedAt, durationMs, error, resultId, ...extra} | null, updatedAt }
 *     `active` = tool calls running in THIS process right now (parallel calls
 *     are possible; a multi-spawn pipeline is ONE entry for the whole run).
 *   <home>/fleet-log.ndjson     shared append log, one compact JSON per line,
 *     a single O_APPEND write per event (start / end). Trimmed at process start
 *     when it grows past ~500 KB (last ~1000 lines kept).
 *
 * FAIL-SOFT ABSOLUTELY: every write is try/catch-wrapped and synchronous. An
 * fs error can never break, crash, or delay a tool call. `enabled` is read
 * per event through `resolve()`, so switching the feed off in the fleet
 * config takes effect on the next call without a restart.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATUS_SCHEMA = 1;
const LOG_TRIM_BYTES = 500 * 1024;
const LOG_KEEP_LINES = 1000;

/**
 * The one preview rule: control characters collapsed to spaces, trimmed, 200
 * characters. Exported because the result record (core/unit.mjs) must show the
 * SAME preview the feed shows — two rules would drift.
 */
export const previewText = (t) => String(t || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);

/**
 * @param {{unit:string, spawnTools:Set<string>, resolve:()=>{dir:string, enabled:boolean}}} o
 *   spawnTools: only tools that spawn a CLI are tracked — catalog reads never are.
 */
export function createStatus({ unit, spawnTools, resolve }) {
  let seq = 0;
  let lastEvent = null;
  const active = new Map();

  const paths = () => {
    const { dir } = resolve();
    return { dir, snapshot: join(dir, `status-${unit}.json`), log: join(dir, 'fleet-log.ndjson') };
  };

  function writeSnapshot() {
    try {
      const { dir, snapshot } = paths();
      mkdirSync(dir, { recursive: true });
      const tmp = `${snapshot}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        schema: STATUS_SCHEMA,
        unit,
        active: [...active.values()],
        lastEvent,
        updatedAt: new Date().toISOString(),
      }), { mode: 0o600 });
      renameSync(tmp, snapshot); // atomic — same directory
    } catch { /* fail-soft */ }
  }

  function logLine(obj) {
    try {
      const { dir, log } = paths();
      mkdirSync(dir, { recursive: true });
      appendFileSync(log, JSON.stringify({ schema: STATUS_SCHEMA, ...obj }) + '\n', { mode: 0o600 });
    } catch { /* fail-soft */ }
  }

  function trimLog() {
    try {
      const { log } = paths();
      if (statSync(log).size <= LOG_TRIM_BYTES) return;
      const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
      const tmp = `${log}.${process.pid}.tmp`;
      writeFileSync(tmp, lines.slice(-LOG_KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
      renameSync(tmp, log);
    } catch { /* log may not exist yet */ }
  }

  /** Process start: carry over the previous lastEvent, clear stale `active` from a crashed predecessor, trim the log. */
  function boot() {
    try {
      if (!resolve().enabled) return;
      try { lastEvent = JSON.parse(readFileSync(paths().snapshot, 'utf8')).lastEvent || null; } catch { /* first run */ }
      trimLog();
      writeSnapshot();
    } catch { /* fail-soft */ }
  }

  /**
   * Returns a token for end(), or null for untracked tools / disabled feed —
   * end(null) is a no-op, callers never branch. `resultId` is the runtime's own
   * id for this call (core/unit.mjs `makeResultId`), independent of the feed: it
   * is what a reader uses to find the spooled result, so it rides both events.
   */
  function start(tool, promptText, model, effort, resultId = null) {
    if (!spawnTools.has(tool)) return null;
    try {
      if (!resolve().enabled) return null;
      const id = `${process.pid}-${++seq}`;
      const startedAt = new Date().toISOString();
      const promptPreview = previewText(promptText);
      const rid = resultId || null;
      active.set(id, { id, tool, model: model || null, effort: effort || null, promptPreview, startedAt, resultId: rid });
      writeSnapshot();
      logLine({ ts: startedAt, unit, event: 'start', id, tool, model: model || null, promptPreview, resultId: rid });
      return { id, tool, t0: Date.now(), resultId: rid };
    } catch { return null; }
  }

  /**
   * Close an entry. `status` is 'ok' | 'error' | 'cancelled'. `extra` (token
   * usage, `partial`, `detached`) is merged into lastEvent and the log line.
   */
  function end(token, status, error, extra) {
    if (!token) return;
    try {
      active.delete(token.id);
      const endedAt = new Date().toISOString();
      const durationMs = Date.now() - token.t0;
      const errText = error ? String(error).slice(0, 500) : null;
      lastEvent = {
        tool: token.tool, status, endedAt, durationMs, error: errText,
        resultId: token.resultId || null, ...(extra || {}),
      };
      writeSnapshot();
      logLine({
        ts: endedAt, unit, event: 'end', id: token.id, tool: token.tool, status, durationMs,
        resultId: token.resultId || null,
        ...(errText ? { error: errText } : {}), ...(extra || {}),
      });
    } catch { /* fail-soft */ }
  }

  return { boot, start, end, get lastEvent() { return lastEvent; }, get activeCount() { return active.size; } };
}
