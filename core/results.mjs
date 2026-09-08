/**
 * omelette-fleet :: core/results.mjs
 * The result spool — every answer a unit produced, on disk, before the client
 * is told anything.
 *
 * WHY IT EXISTS: a tool call that outlives the client's timeout has been paid
 * for and then thrown away (2026-09-06: a 1081 s codex review answered a
 * request Claude Code had abandoned at 900 s). The spool is the copy that
 * survives a dropped request, a cancellation and a client restart;
 * `<unit>_result` and `omelette-fleet results` read it back, spending nothing.
 *
 * FILE CONTRACT: <home>/results/<unit>/<resultId>.md — directory 0700, file 0600.
 *   ---
 *   unit: codex
 *   ... one `key: value` per line, in HEADER_KEYS order ...
 *   ---
 *   <the answer, verbatim>
 * Header values are single-line BY CONSTRUCTION: control characters collapse to
 * spaces before they are written, so nothing a model produced can forge a
 * second header. `promptPreview` is JSON-quoted and capped at 200 characters,
 * like the status feed's. The text is whatever the tool returned — already
 * bounded by `outputCap` when it was produced — and a `---` inside it is text,
 * because only the FIRST terminator ends the header.
 *
 * FAIL-SOFT ABSOLUTELY, exactly like core/status.mjs: synchronous, every fs
 * call wrapped, `write` answers `null` and logs ONE line. A tool call is never
 * delayed, broken or crashed by the spool.
 *
 * ATOMIC: tmp in the same directory, created O_EXCL — a planted tmp fails the
 * write instead of being followed, and is never removed, because it may be
 * another server's live write — then `rename`, which a reader sees whole or
 * not at all.
 *
 * READS NEVER FOLLOW A SYMLINK: `lstat` first, regular files only, plus
 * O_NOFOLLOW where the platform defines it. Ids are validated against
 * RESULT_ID_RE before a path is built, so a traversal never reaches the
 * filesystem at all. NEITHER DO THE DIRECTORIES ON THE WAY THERE: O_EXCL and
 * O_NOFOLLOW answer for the leaf file only, so `<home>/results` and
 * `<home>/results/<unit>` are lstatted before every write, listing, read and
 * prune — a link planted at either of them would redirect the whole spool.
 */
import {
  closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** `<YYYYMMDDTHHMMSSZ>-<pid>-<seq>`, as core/unit.mjs's makeResultId builds it. */
export const RESULT_ID_RE = /^\d{8}T\d{6}Z-\d+-\d+$/;

/** The header, in order. A reader keys on the names; a writer never reorders them. */
export const HEADER_KEYS = [
  'unit', 'tool', 'resultId', 'model', 'effort', 'startedAt', 'endedAt',
  'durationMs', 'status', 'partial', 'detached', 'cwd', 'promptPreview',
];

const MAX_ID_LENGTH = 64;          // the format's own maximum is ~40; the guard is for the pathological argument
const HEADER_MAX_BYTES = 8192;     // a listing reads the header only, never a 400 KB answer
const TMP_STALE_MS = 60 * 60 * 1000;
const UNIT_RE = /^[a-z][a-z0-9-]*$/;
const NOFOLLOW = constants.O_NOFOLLOW || 0; // 0 where the platform has no such flag

export function isValidResultId(id) {
  return typeof id === 'string' && id.length <= MAX_ID_LENGTH && RESULT_ID_RE.test(id);
}

const line1 = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const flag = (v) => (v === true || v === 'true' ? 'true' : 'false');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const posint = (v, fallback) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : fallback; };

/** The file body: the header block, then the text verbatim. */
export function renderResult(record = {}) {
  const r = record && typeof record === 'object' ? record : {};
  const head = HEADER_KEYS.map((key) => {
    if (key === 'promptPreview') return `promptPreview: ${JSON.stringify(line1(r.promptPreview, 200))}`;
    if (key === 'durationMs') {
      const n = Number(r.durationMs);
      return `durationMs: ${Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0}`;
    }
    if (key === 'partial' || key === 'detached') return `${key}: ${flag(r[key])}`;
    const v = line1(r[key], key === 'cwd' ? 1024 : 200);
    return v ? `${key}: ${v}` : `${key}:`;
  });
  return ['---', ...head, '---'].join('\n') + '\n' + String(r.text ?? '');
}

/**
 * The inverse. `null` — never a throw — when the text is not one of our files:
 * no opening rule, no terminator, or a header line that is not `key: value`.
 * Safe on a TRUNCATED prefix too: a header that does not close inside the
 * prefix reads as "not ours", which is what a listing wants.
 */
export function parseResult(fileText) {
  const s = String(fileText ?? '');
  if (!s.startsWith('---\n')) return null;
  const header = {};
  let i = 4;
  for (;;) {
    const nl = s.indexOf('\n', i);
    if (nl < 0) return null;
    const line = s.slice(i, nl);
    i = nl + 1;
    if (line === '---') break;
    const c = line.indexOf(':');
    if (c < 0) return null;
    const key = line.slice(0, c);
    let value = line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (!HEADER_KEYS.includes(key)) continue; // a key a later version added
    if (key === 'durationMs') { const n = Number(value); header[key] = Number.isFinite(n) ? n : 0; continue; }
    if (key === 'partial' || key === 'detached') { header[key] = value === 'true'; continue; }
    if (key === 'promptPreview') { try { header[key] = JSON.parse(value); } catch { header[key] = value; } continue; }
    header[key] = value;
  }
  return { header, text: s.slice(i) };
}

/** One listing line: `<resultId>  [<unit>  ]<tool>  <status>[ partial][ detached]  <durationMs>ms  <startedAt>`. */
export function formatEntry(entry, { unit = '' } = {}) {
  const e = entry || {};
  const state = `${e.status || '?'}${e.partial ? ' partial' : ''}${e.detached ? ' detached' : ''}`;
  return [e.resultId, ...(unit ? [unit] : []), e.tool || '?', state, `${e.durationMs || 0}ms`, e.startedAt || ''].join('  ');
}

/**
 * One unit's spool directory.
 * @param {{home:string, unit:string, keep?:number, maxBytes?:number, log?:(m:string)=>void}} o
 */
export function createResultStore({ home, unit, keep = 50, maxBytes = 50 * 1024 * 1024, log = () => {} } = {}) {
  /**
   * The one way this module says anything. `log` is the CALLER's sink — a
   * unit's stderr, a test double, whatever a later caller passes — and a sink
   * that throws would turn a fail-soft refusal into the exception the whole
   * module exists not to raise, on the read paths especially, where the log
   * call sits outside every try. Every `log(...)` in here goes through this.
   */
  const say = (msg) => { try { log(msg); } catch { /* a broken logger is not a broken spool */ } };

  const usable = typeof home === 'string' && home.trim() !== '' && typeof unit === 'string' && UNIT_RE.test(unit);
  if (!usable) {
    say(`results: spool off — ${JSON.stringify(String(unit ?? ''))} under ${JSON.stringify(String(home ?? ''))} is not a place this fleet writes`);
  }
  const root = usable ? join(home, 'results') : null;
  const dir = usable ? join(home, 'results', unit) : null;
  const keepN = posint(keep, 50);
  const capBytes = posint(maxBytes, 50 * 1024 * 1024);

  /**
   * May this spool be touched at all? Both directories, lstatted (never
   * stat): a SYMLINK at either of them sends every write, listing and unlink
   * below to wherever it points, and O_NOFOLLOW on the leaf file cannot see
   * that. Anything that is not a plain directory is refused the same way — one
   * log line, and the caller answers null / [] / nothing.
   *
   * A directory that is simply ABSENT is not a refusal: it is a spool nobody
   * has written to yet, silent for a read and created for a write.
   *
   * @param {{create?:boolean}} o `create` — the write path, and only it.
   */
  function dirsReady({ create = false } = {}) {
    if (!dir) return false; // an unusable store: already logged, once, at construction
    for (const d of [root, dir]) {
      let st = null;
      try { st = lstatSync(d); } catch (e) {
        if (!e || e.code !== 'ENOENT') { say(`results: spool off — ${d} could not be read: ${(e && e.message) || e}`); return false; }
        if (!create) return false;
        try { mkdirSync(d, { recursive: true, mode: 0o700 }); } catch (err) {
          say(`results: spool off — ${d} could not be created: ${(err && err.message) || err}`);
          return false;
        }
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) {
        say(`results: spool off — ${d} is ${st.isSymbolicLink() ? 'a symlink' : 'not a directory'}`);
        return false;
      }
    }
    return true;
  }

  /** The header of one file, read as a bounded prefix — a listing must not pull whole answers into memory. */
  function headerOf(path) {
    let fd = null;
    try {
      const st = lstatSync(path);
      if (!st.isFile()) return null;
      fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
      const buf = Buffer.alloc(HEADER_MAX_BYTES);
      const n = readSync(fd, buf, 0, HEADER_MAX_BYTES, 0);
      closeSync(fd);
      fd = null;
      const parsed = parseResult(buf.toString('utf8', 0, n));
      return parsed ? parsed.header : null;
    } catch {
      return null;
    } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
    }
  }

  /**
   * Everything in the directory, newest `endedAt` first, the filename breaking
   * a tie. A file whose header we cannot read sorts OLDEST on purpose: it is
   * never listed, and retention takes it before a real answer.
   *
   * Called only behind `dirsReady`, so it never has to ask again — one refusal
   * is one log line, whichever public call it came through.
   */
  function scan() {
    let names = [];
    try { names = readdirSync(dir); } catch { return []; }
    const rows = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const resultId = name.slice(0, -3);
      if (!isValidResultId(resultId)) continue;
      const path = join(dir, name);
      let size = 0;
      try {
        const st = lstatSync(path);
        if (!st.isFile()) continue; // a symlink is not a result, and is not followed
        size = st.size;
      } catch { continue; }
      const h = headerOf(path);
      rows.push({
        resultId, path, size, readable: !!h,
        tool: (h && h.tool) || '',
        status: (h && h.status) || '',
        partial: !!(h && h.partial),
        detached: !!(h && h.detached),
        durationMs: (h && h.durationMs) || 0,
        startedAt: (h && h.startedAt) || '',
        endedAt: (h && h.endedAt) || '',
      });
    }
    rows.sort((a, b) => (a.endedAt === b.endedAt ? cmp(b.resultId, a.resultId) : cmp(b.endedAt, a.endedAt)));
    return rows;
  }

  const publicShape = ({ resultId, tool, status, partial, detached, durationMs, startedAt, endedAt, path }) =>
    ({ resultId, tool, status, partial, detached, durationMs, startedAt, endedAt, path });

  function list(limit = 10) {
    const n = Number(limit);
    const take = Number.isInteger(n) && n >= 0 ? n : 10;
    if (!dirsReady()) return [];
    return scan().filter((r) => r.readable).slice(0, take).map(publicShape);
  }

  function read(resultId) {
    if (!dir || !isValidResultId(resultId) || !dirsReady()) return null;
    const path = join(dir, `${resultId}.md`);
    let fd = null;
    try {
      const st = lstatSync(path); // the symlink refusal, before anything is opened
      if (!st.isFile()) return null;
      fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
      const raw = readFileSync(fd, 'utf8');
      closeSync(fd);
      fd = null;
      const parsed = parseResult(raw);
      return parsed ? { header: parsed.header, text: parsed.text, path } : null;
    } catch {
      return null;
    } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
    }
  }

  function write(record) {
    if (!dir) return null;
    const resultId = record && record.resultId;
    if (!isValidResultId(resultId)) {
      say(`results: not spooling — ${JSON.stringify(String(resultId ?? '').slice(0, 80))} is not a result id`);
      return null;
    }
    if (!dirsReady({ create: true })) return null;
    const path = join(dir, `${resultId}.md`);
    const tmp = `${path}.${process.pid}.tmp`;
    let fd = null;
    let mine = false;
    try {
      fd = openSync(tmp, 'wx', 0o600); // O_EXCL: a planted tmp fails the write rather than being followed
      mine = true;
      writeFileSync(fd, renderResult({ ...record, unit }));
      closeSync(fd);
      fd = null;
      renameSync(tmp, path); // atomic within the directory
    } catch (e) {
      if (fd !== null) { try { closeSync(fd); } catch { /* gone */ } }
      // Only ever OUR leftover: a tmp we did not create is another server's live write.
      if (mine) { try { unlinkSync(tmp); } catch { /* gone */ } }
      say(`results: could not spool ${resultId} — ${(e && e.message) || e}`);
      return null;
    }
    prune();
    return path;
  }

  /** Retention: the count, then the byte budget, then abandoned tmp files. Every unlink is guarded. */
  function prune() {
    if (!dirsReady()) return;
    const rows = scan();
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
      total += rows[i].size;
      // `i > 0` for the byte rule: one answer larger than the whole budget is
      // still the answer that was just paid for.
      if (i >= keepN || (i > 0 && total > capBytes)) {
        try { unlinkSync(rows[i].path); } catch { /* another server got there first */ }
      }
    }
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    const cutoff = Date.now() - TMP_STALE_MS;
    for (const name of names) {
      if (!name.endsWith('.tmp')) continue;
      const p = join(dir, name);
      try {
        const st = lstatSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(p);
      } catch { /* raced with the server that owns it */ }
    }
  }

  return { write, list, read, prune, dir };
}
