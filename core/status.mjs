/**
 * omelette-fleet :: core/status.mjs
 * The fleet status feed — what each unit is doing right now, for a menu-bar
 * app, a HUD, or `tail -f`.
 *
 * FILE CONTRACT (schema 2 since 1.6.0, schema 1 through 1.5.0 — readers are
 * built against this; changes bump the number, never silently reshape a field):
 *   <home>/status-<unit>-<pid>.json   per-PROCESS snapshot, written ATOMICALLY (tmp + rename)
 *     { schema, unit, pid, active: [{id, tool, model, effort, promptPreview, startedAt, resultId}],
 *       lastEvent: {tool, status, endedAt, durationMs, error, resultId, ...extra} | null, updatedAt }
 *     `active` = tool calls running in THIS process right now (parallel calls
 *     are possible; a multi-spawn pipeline is ONE entry for the whole run).
 *     One file per process: two Claude Code sessions running one unit used to
 *     overwrite each other's file (schema 1). What runs now is the union of
 *     `active` over every file; a unit's last event is the newest `endedAt`
 *     across its files. `lastEvent` starts null in every process — nothing is
 *     read from a neighbour or a predecessor.
 *   <home>/fleet-log.ndjson     shared append log, one compact JSON per line,
 *     a single O_APPEND write per event (start / end). Trimmed at process start
 *     when it grows past ~500 KB (last ~1000 lines kept).
 *
 * LIFECYCLE: boot() sweeps, trims the log and writes this process's file;
 * dispose() removes this process's file (a clean exit). The SWEEP removes a
 * file only when all of these hold: it is named status-<this unit>-<pid>.json,
 * the pid is not this process's own, the OS answers ESRCH for that pid, and
 * the file itself says schema >= 2 with that same unit and pid. The last check
 * keeps another unit's file whose name happens to parse as ours (schema 1's
 * status-my-unit-999999.json is unit `my-unit-999999`, not `my-unit`'s pid);
 * a file that cannot be read or parsed is kept.
 * EPERM (alive, another user's) keeps the file, and so does any other error:
 * unknown is not dead. A reused pid keeps a dead file until the next boot finds
 * it dead — delayed cleanup, not wrong data (the file's updatedAt shows its age).
 *
 * FAIL-SOFT ABSOLUTELY: every fs call is try/catch-wrapped and synchronous. An
 * fs error can never break, crash, or delay a tool call. `enabled` is read
 * per event through `resolve()`, so switching the feed off in the fleet
 * config takes effect on the next call without a restart.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

export const STATUS_SCHEMA = 2;
const LOG_TRIM_BYTES = 500 * 1024;
const LOG_KEEP_LINES = 1000;
const NOFOLLOW = constants.O_NOFOLLOW || 0; // 0 where the platform has no such flag
// A FIFO planted at the log's name would block a plain O_WRONLY open until a
// reader appears — inside a tool call. Non-blocking, it fails (ENXIO) instead.
const NONBLOCK = constants.O_NONBLOCK || 0;
const LOG_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW | NONBLOCK;

/**
 * tmp + rename, 0600. The tmp name is unpredictable and opened O_EXCL (`wx`):
 * a file or link planted at it fails the open instead of being followed, and a
 * tmp we did not create is never removed. renameSync replaces a symlink at the
 * target with our regular file rather than following it — that is the intent.
 * THROWS; every caller wraps it in its own fail-soft catch.
 */
function writeAtomic(target, data) {
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600); // a failed open: the tmp is not ours, nothing to clean
  let open = true;
  try {
    writeFileSync(fd, data);
    closeSync(fd);
    open = false;
    renameSync(tmp, target); // atomic — same directory
  } catch (e) {
    if (open) { try { closeSync(fd); } catch { /* gone */ } }
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
}

/**
 * The one preview rule: control characters collapsed to spaces, trimmed, 200
 * characters. Exported because the result record (core/unit.mjs) must show the
 * SAME preview the feed shows — two rules would drift.
 */
export const previewText = (t) => String(t || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);

/** The one place a snapshot's name is spelled: `status-<unit>-<pid>.json`. */
export const snapshotPath = (dir, unit, pid) => join(dir, `status-${unit}-${pid}.json`);

const SNAPSHOT_NAME_RE = /^status-(.+)-(\d+)\.json$/;

/** Only ESRCH is dead. EPERM is a live process of another user; anything else is unknown, and unknown is kept. */
function pidIsGone(pid) {
  try { process.kill(pid, 0); return false; } catch (e) { return !!e && e.code === 'ESRCH'; }
}

/**
 * @param {{unit:string, spawnTools:Set<string>, resolve:()=>{dir:string, enabled:boolean}, pid?:number}} o
 *   spawnTools: only tools that spawn a CLI are tracked — catalog reads never are.
 *   pid: the process that owns this snapshot — process.pid; tests set it to
 *   play two processes in one.
 */
export function createStatus({ unit, spawnTools, resolve, pid = process.pid }) {
  let seq = 0;
  let lastEvent = null;
  const active = new Map();

  const paths = () => {
    const { dir } = resolve();
    return { dir, snapshot: snapshotPath(dir, unit, pid), log: join(dir, 'fleet-log.ndjson') };
  };

  function writeSnapshot() {
    try {
      const { dir, snapshot } = paths();
      mkdirSync(dir, { recursive: true });
      writeAtomic(snapshot, JSON.stringify({
        schema: STATUS_SCHEMA,
        unit,
        pid,
        active: [...active.values()],
        lastEvent,
        updatedAt: new Date().toISOString(),
      }));
    } catch { /* fail-soft */ }
  }

  /**
   * One O_APPEND write per event, never through a link: O_NOFOLLOW refuses a
   * symlink at the log's name (the line is dropped, the link left as it is),
   * and anything that opens but is not a regular file is skipped. A log left
   * wider than 0600 is narrowed before the line goes in — `mode` on the open
   * applies only to a file the open creates.
   */
  function logLine(obj) {
    let fd = null;
    try {
      const { dir, log } = paths();
      mkdirSync(dir, { recursive: true });
      fd = openSync(log, LOG_FLAGS, 0o600);
      const st = fstatSync(fd);
      if (!st.isFile()) return;
      if (st.mode & 0o777 & ~0o600) fchmodSync(fd, 0o600);
      writeSync(fd, JSON.stringify({ schema: STATUS_SCHEMA, ...obj }) + '\n');
    } catch { /* fail-soft */ } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* gone */ } }
    }
  }

  function trimLog() {
    try {
      const { log } = paths();
      // A link at the log's name would otherwise have its target's tail copied into a new fleet log.
      if (!lstatSync(log).isFile()) return;
      if (statSync(log).size <= LOG_TRIM_BYTES) return;
      const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
      writeAtomic(log, lines.slice(-LOG_KEEP_LINES).join('\n') + '\n');
    } catch { /* log may not exist yet */ }
  }

  /** Remove the snapshots of this unit's dead processes; a live or unknown one is never touched. */
  function sweep() {
    let dir;
    let names;
    try { dir = paths().dir; names = readdirSync(dir); } catch { return; /* no home yet */ }
    for (const name of names) {
      try {
        const m = SNAPSHOT_NAME_RE.exec(name);
        if (!m || m[1] !== unit || m[2] === String(pid)) continue;
        if (!pidIsGone(Number(m[2]))) continue;
        const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        if (!(parsed && parsed.schema >= 2 && parsed.unit === unit && parsed.pid === Number(m[2]))) continue;
        rmSync(join(dir, name), { force: true });
      } catch { /* this file only; the next one is still looked at */ }
    }
  }

  /** Process start: sweep dead predecessors, trim the log, write this process's own file. Reads no snapshot. */
  function boot() {
    try {
      if (!resolve().enabled) return;
      sweep();
      trimLog();
      writeSnapshot();
    } catch { /* fail-soft */ }
  }

  /** Clean exit: this process's file goes; every other file stays. */
  function dispose() {
    try { rmSync(paths().snapshot, { force: true }); } catch { /* fail-soft */ }
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
      const id = `${pid}-${++seq}`;
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

  return { boot, start, end, dispose, get lastEvent() { return lastEvent; }, get activeCount() { return active.size; } };
}
