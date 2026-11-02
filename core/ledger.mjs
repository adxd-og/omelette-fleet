/**
 * omelette-fleet :: core/ledger.mjs
 * The 1.7.3 ledger lifecycle in one place: a ledger's `branch:` header, its
 * state through `git show-ref --verify` (open, closed, standing, untracked),
 * and `ledger open`. The CLI imports this module statically; the guard loads
 * it with one dynamic import. It writes only under the project's `.omelette/`
 * and to the decisions register.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync,
  unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gitChildEnv, readBoundedFile } from './check.mjs';
import { fleetHome } from './config.mjs';
import { visible } from './log.mjs';

export const LEDGER_FILE = /^ledger-(.+)\.md$/;
export const HEADER_LINES = 20;
export const HEADER_READ_BYTES = 8192;
export const GIT_TIMEOUT_MS = 2000;
export const PLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const HEADER = /^branch:[ \t]*(\S+)[ \t]*$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._\/-]+(?<![\/.])$/;

/**
 * The branch a ledger names: the first line among the first HEADER_LINES that
 * starts with `branch:` decides, and only a name git could hold is accepted.
 * @returns {string|null}
 */
export function parseLedgerHeader(text) {
  const lines = String(text ?? '').split(/\r?\n/).slice(0, HEADER_LINES);
  const line = lines.find((l) => l.startsWith('branch:'));
  if (line === undefined) return null;
  const m = HEADER.exec(line);
  return m && BRANCH.test(m[1]) ? m[1] : null;
}

/** One git call, no shell, in check's git environment, under a wall clock. */
function runGit(projectDir, args, { env = process.env, timeoutMs = GIT_TIMEOUT_MS, stdout = 'ignore' } = {}) {
  return spawnSync('git', ['--no-optional-locks', ...args], {
    cwd: projectDir,
    env: gitChildEnv(env),
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    stdio: ['ignore', stdout, 'pipe'],
    encoding: 'utf8',
    windowsHide: true,
  });
}

/** 'no-git' or 'timeout' when the call itself failed, else null. */
const gitFailure = (r) => {
  if (r.error && r.error.code === 'ENOENT') return 'no-git';
  if ((r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGKILL') return 'timeout';
  return null;
};

/**
 * Whether `refs/heads/<branch>` exists in the repository at projectDir.
 * @returns {{exists:boolean}|{error:'no-git'|'not-a-repo'|'timeout'|'git-failed'}}
 */
export function branchExists(projectDir, branch, { env = process.env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const r = runGit(projectDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { env, timeoutMs });
  const failure = gitFailure(r);
  if (failure) return { error: failure };
  if (r.status === 0) return { exists: true };
  if (r.status === 1) return { exists: false };
  if (/not a git repository/i.test(r.stderr || '')) return { error: 'not-a-repo' };
  return { error: 'git-failed' };
}

/** Whether `dir` is the fleet home itself (by real path; an unresolvable path is not). */
function isFleetHome(dir, env) {
  try {
    return realpathSync(dir) === realpathSync(fleetHome(env));
  } catch {
    return false;
  }
}

/** classifyLedger, with the git error an earlier ledger hit standing in for git. */
function classify(projectDir, name, opts, knownError) {
  const m = LEDGER_FILE.exec(String(name));
  if (!m) return null;
  const path = join(projectDir, '.omelette', name);
  try {
    if (!lstatSync(path).isFile()) return null;
  } catch {
    return null;
  }
  const text = readBoundedFile(path, HEADER_READ_BYTES);
  if (text === null) return null;
  const plan = m[1];
  const branch = parseLedgerHeader(text);
  if (branch === null) return { name, plan, state: 'untracked' };
  if (branch === 'main') return { name, plan, state: 'standing', branch };
  const found = knownError ? { error: knownError } : branchExists(projectDir, branch, opts);
  if (found.error) return { name, plan, state: 'unknown', branch, error: found.error };
  return { name, plan, state: found.exists ? 'open' : 'closed', branch };
}

/**
 * A ledger's state: `untracked` without a header, `standing` on main, `open`
 * while its branch exists, `closed` once it is gone, `unknown` (with the git
 * error) when git cannot say. null for a name that is not a ledger file or a
 * path that is not a regular file.
 */
export function classifyLedger(projectDir, name, { env = process.env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return classify(projectDir, name, { env, timeoutMs }, null);
}

/**
 * Every ledger in `.omelette/`, sorted by name, classified; after the first git
 * error no later ledger asks git again. `archived` counts the ledger names in
 * `.omelette/archive/` (names only, never contents).
 */
export function listLedgers(projectDir, { env = process.env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const dir = join(projectDir, '.omelette');
  const notDir = { ledgers: [], archived: 0, error: 'not-a-directory' };
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ledgers: [], archived: 0, error: null, absent: true };
    return notDir;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return notDir;
  // The fleet home (`~/.omelette` by default) is the operator's config
  // directory, not a project's: a doctor or a session started in $HOME finds
  // it under the same name and must not read or sweep it.
  if (isFleetHome(dir, env)) return { ledgers: [], archived: 0, error: null, absent: true };
  let names;
  try {
    names = readdirSync(dir).filter((n) => LEDGER_FILE.test(n)).sort();
  } catch {
    return notDir;
  }
  const ledgers = [];
  let error = null;
  for (const name of names) {
    const l = classify(projectDir, name, { env, timeoutMs }, error);
    if (!l) continue;
    if (l.error && !error) error = l.error;
    ledgers.push(l);
  }
  let archived = 0;
  try {
    const archive = join(dir, 'archive');
    const a = lstatSync(archive);
    if (a.isDirectory() && !a.isSymbolicLink()) archived = readdirSync(archive).filter((n) => LEDGER_FILE.test(n)).length;
  } catch { /* no archive */ }
  return { ledgers, archived, error };
}

/**
 * `ledger open <plan>`: create `.omelette/ledger-<plan>.md` with the header of
 * the current branch. Never overwrites; refuses a detached HEAD.
 * @returns {{rel:string, branch:string}|{error:string}}
 */
export function openLedger(projectDir, plan, { env = process.env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  if (typeof plan !== 'string' || !PLAN_NAME.test(plan)) {
    return { error: `plan name "${visible(plan)}" must start with a letter or digit and hold only letters, digits, ".", "_" or "-"` };
  }
  const r = runGit(projectDir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { env, timeoutMs, stdout: 'pipe' });
  const failure = gitFailure(r);
  if (failure === 'no-git') return { error: 'git not found on PATH' };
  if (failure === 'timeout') return { error: `git symbolic-ref did not answer within ${timeoutMs / 1000} s` };
  if (r.status === 1) return { error: "HEAD is detached — check out the plan's branch first" };
  if (r.status === 128 && /not a git repository/i.test(r.stderr || '')) return { error: 'not inside a git repository' };
  if (r.status !== 0) return { error: 'git symbolic-ref failed' };
  const branch = String(r.stdout || '').trim();
  if (!BRANCH.test(branch)) return { error: `branch "${visible(branch)}" cannot be written as a ledger header` };

  const dir = join(projectDir, '.omelette');
  const notDir = { error: '.omelette is not a directory of this project' };
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return notDir;
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return notDir;
    try { mkdirSync(dir); } catch { return notDir; }
  }

  const rel = `.omelette/ledger-${plan}.md`;
  let fd;
  try {
    fd = openSync(join(dir, `ledger-${plan}.md`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  } catch (e) {
    if (e && e.code === 'EEXIST') return { error: `${rel} exists` };
    return { error: `${rel} could not be created (${(e && e.code) || 'error'})` };
  }
  try {
    writeSync(fd, `# ledger ${plan}\nbranch: ${branch}\n\n`);
  } finally {
    closeSync(fd);
  }
  return { rel, branch };
}

export const BINDING = 'Ruling(binding):';
export const REGISTER_DEFAULT = '.omelette/decisions.md';

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const LINE_DATE = /^[ \t]*(?:[-*+][ \t]+)?(\d{4}-\d{2}-\d{2})\b/;
const TRAILING_POINTER = /[ \t]+·[ \t]+(`?)([^\s`:]+):(\d+)\1[ \t]+·[ \t]+`([^`]+)`[ \t]*$/;

/**
 * The binding rulings of a ledger: every line outside fenced code that holds
 * the marker not quoted inline, from the marker to the end of the line, with
 * the date the line opens with (or null).
 * @returns {Array<{ruling:string, date:string|null}>}
 */
export function harvestBindings(text) {
  const out = [];
  let fence = '';
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = '';
      continue;
    }
    if (fence) continue;
    let at = line.indexOf(BINDING);
    while (at > 0 && line[at - 1] === '`') at = line.indexOf(BINDING, at + 1);
    if (at < 0) continue;
    const d = LINE_DATE.exec(line);
    out.push({ ruling: line.slice(at).trimEnd(), date: d ? d[1] : null });
  }
  return out;
}

/**
 * The register line of one binding ruling. A trailing pointer moves to the
 * front in check's grammar; the text is written to a file, never escaped.
 */
export function registerLine({ ruling, date, plan }) {
  const m = TRAILING_POINTER.exec(ruling);
  if (!m) return `- ${date} · ${plan} · ${ruling}`;
  return `- ${m[2]}:${m[3]} · \`${m[4]}\` · ${date} · ${plan} · ${ruling.slice(0, m.index)}`;
}

/** Whether `dir`, or an ancestor of it below `root`, is the project's `<name>` directory (dev+ino, not spelling). */
function underProjectDir(projectDir, root, dir, name) {
  let git;
  try {
    git = lstatSync(join(projectDir, name));
  } catch {
    return false;
  }
  if (!git.isDirectory()) return false;
  let at = dir;
  for (let i = 0; i < 64; i++) {
    let st;
    try {
      st = lstatSync(at);
    } catch {
      return false;
    }
    if (st.dev === git.dev && st.ino === git.ino) return true;
    if (at === root) return false;
    const parent = dirname(at);
    if (parent === at) return false;
    at = parent;
  }
  return false;
}

/**
 * Where the register is: `.omelette/decisions.md`, or the file its first line
 * `register: <relative path>` names inside the project (followed once).
 * @returns {{path:string, rel:string, via:string|null}|{error:string}}
 */
export function readRegisterPath(projectDir) {
  const own = join(projectDir, '.omelette', 'decisions.md');
  const fallback = { path: own, rel: REGISTER_DEFAULT, via: null };
  try {
    if (!lstatSync(own).isFile()) return { error: `register: ${REGISTER_DEFAULT} is not a regular file` };
  } catch (e) {
    if (e && e.code === 'ENOENT') return fallback;
    return { error: `register: ${REGISTER_DEFAULT} is unreadable` };
  }
  const text = readBoundedFile(own, 4096);
  if (text === null) return { error: `register: ${REGISTER_DEFAULT} is unreadable` };
  const first = text.split('\n', 1)[0].replace(/^﻿/, '').replace(/\r$/, '');
  const m = /^register:[ \t]*(.*?)[ \t]*$/.exec(first);
  if (!m) return fallback;

  const value = m[1];
  const refuse = (reason) => ({ error: `register: ${visible(value) || '(nothing)'} refused (${reason})` });
  if (value === '') return refuse('empty');
  if (/[\x00-\x1f\x7f]/.test(value)) return refuse('control characters');
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return refuse('absolute path');
  if (value.split(/[\\/]/).includes('..')) return refuse('contains ..');
  const target = resolve(projectDir, value);
  const rel = relative(projectDir, target).split(sep).join('/');
  if (rel === REGISTER_DEFAULT) return refuse('points at itself');
  if (rel === '.git' || rel.startsWith('.git/')) return refuse('inside .git');
  if (rel === '.omelette' || rel.startsWith('.omelette/')) return refuse('inside .omelette');
  let realDir;
  try {
    realDir = realpathSync(dirname(target));
  } catch {
    return refuse('its directory does not exist');
  }
  let realRoot;
  try {
    realRoot = realpathSync(projectDir);
  } catch {
    return refuse('outside the project');
  }
  const up = relative(realRoot, realDir);
  if (!(up === '' || (up !== '..' && !up.startsWith(`..${sep}`) && !isAbsolute(up)))) return refuse('outside the project');
  // `.git` by inode, not by spelling: the target's directory and each of its
  // ancestors up to the project root are compared with the repository's own
  // `.git` — a symlinked directory or another case on a case-insensitive
  // filesystem reaches the same inode under another name.
  if (underProjectDir(projectDir, realRoot, realDir, '.git')) return refuse('inside .git');
  if (underProjectDir(projectDir, realRoot, realDir, '.omelette')) return refuse('inside .omelette');
  // A register is a markdown file: a redirect at `.env` or any other file the
  // project holds would print its tail into the session after a /clear.
  if (!/\.md$/i.test(value)) return refuse('not a .md file');
  let st = null;
  try {
    st = lstatSync(target);
  } catch (e) {
    if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) return refuse('not a regular file');
  }
  if (st && st.isSymbolicLink()) return refuse('a symlink');
  if (st && !st.isFile()) return refuse('not a regular file');
  // The same inode under another spelling — a symlinked directory on the way,
  // or another case on a case-insensitive filesystem — is the register itself.
  if (st) {
    try {
      const o = lstatSync(own);
      if (o.dev === st.dev && o.ino === st.ino) return refuse('points at itself');
    } catch {
      return refuse(`${REGISTER_DEFAULT} is unreadable`);
    }
  }
  return { path: target, rel, via: REGISTER_DEFAULT };
}

const REGISTER_READ_MAX = 4 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const NONBLOCK = constants.O_NONBLOCK || 0;
const READ_FLAGS = constants.O_RDONLY | NOFOLLOW | NONBLOCK;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | NOFOLLOW | NONBLOCK;

/** An Error whose code goes into the line's parenthesis. */
const coded = (code) => Object.assign(new Error(code), { code });

/**
 * A file read whole through its own fd: lstat, an O_NOFOLLOW | O_NONBLOCK open,
 * fstat on the fd. `single` also asks for one name (nlink 1). Throws.
 */
function readRegular(path, { maxBytes = Infinity, single = false } = {}) {
  if (!lstatSync(path).isFile()) throw coded('EINVAL');
  const fd = openSync(path, READ_FLAGS);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (single && st.nlink !== 1)) throw coded('EINVAL');
    if (st.size > maxBytes) throw coded('EFBIG');
    return { text: readFileSync(fd, 'utf8'), mode: st.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

/** The register's text and mode; a register not written yet is empty, 0644. Throws. */
function readRegister(path) {
  try {
    return readRegular(path, { maxBytes: REGISTER_READ_MAX });
  } catch (e) {
    if (e && e.code === 'ENOENT') return { text: '', mode: 0o644 };
    throw e;
  }
}

/** `data` through `<target>.<pid>.<12 hex>.tmp`, opened `wx`, renamed over the target. Throws. */
function replaceFile(target, data, mode) {
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', mode); // a failed open: the tmp is not ours, nothing to clean
  let open = true;
  try {
    writeFileSync(fd, data);
    closeSync(fd);
    open = false;
    renameSync(tmp, target);
  } catch (e) {
    if (open) { try { closeSync(fd); } catch { /* gone */ } }
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
}

/** One O_APPEND write to a ledger that is a single regular file. Throws. */
function appendToLedger(path, text) {
  const fd = openSync(path, APPEND_FLAGS);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw coded('EINVAL');
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** Whether `path` is taken: anything lstat can see, or a name lstat cannot vouch for. */
function taken(path) {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    return !e || e.code !== 'ENOENT';
  }
}

function gitLine(error, timeoutMs) {
  if (error === 'no-git') return 'sweep: git not found on PATH — nothing swept';
  if (error === 'not-a-repo') return 'sweep: not inside a git repository — nothing swept';
  if (error === 'timeout') return `sweep: git show-ref did not answer within ${timeoutMs / 1000} s — nothing swept`;
  return 'sweep: git show-ref failed — nothing swept';
}

/**
 * `ledger sweep`: every closed root ledger's binding rulings go to the
 * register (dated, with the plan), the ledger gets a `closed` line and moves
 * to `.omelette/archive/`. Every precondition is settled before the first
 * write; the register never gains a line it already holds, so a second run, or
 * one cut short, adds nothing; a move never overwrites. `dryRun` returns the
 * same lines and writes nothing.
 * @returns {{lines:string[], error:string|null, ledgers:object[], archived:number,
 *   register:{path:string, rel:string, via:string|null}|{error:string}|null}}
 */
export function sweepLedgers(projectDir, { dryRun = false, now = new Date(), env = process.env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const listed = listLedgers(projectDir, { env, timeoutMs });
  if (listed.absent) return { lines: [], error: null, ledgers: [], archived: 0, register: readRegisterPath(projectDir), absent: true };
  if (listed.error === 'not-a-directory') {
    const L = 'sweep: .omelette is not a directory of this project — nothing swept';
    return { lines: [L], error: L, ledgers: [], archived: 0, register: null };
  }
  const register = readRegisterPath(projectDir);
  const stop = (L) => ({ lines: [L], error: L, ledgers: listed.ledgers, archived: listed.archived, register });
  if (listed.error) return stop(gitLine(listed.error, timeoutMs));
  if (register.error) return stop(`${register.error} — nothing swept`);
  const dir = join(projectDir, '.omelette');
  const archive = join(dir, 'archive');
  if (listed.ledgers.some((l) => l.state === 'closed')) {
    let ok = true;
    try {
      ok = lstatSync(archive).isDirectory();
    } catch (e) {
      ok = !!e && e.code === 'ENOENT';
    }
    if (!ok) return stop('sweep: .omelette/archive is not a directory — nothing swept');
  }

  // Phase B, read only: one slot per ledger, in name order.
  const slots = [];
  const pending = [];
  const collision = (name) => `collision: ${visible(name)} — .omelette/archive/${visible(name)} exists; left in place`;
  listed.ledgers.forEach((l, i) => {
    if (l.state === 'untracked') {
      slots[i] = `untracked: ${visible(l.name)} (no branch: header — add one, or move it to archive/ by hand)`;
      return;
    }
    if (l.state !== 'closed') return;
    if (taken(join(archive, l.name))) {
      slots[i] = collision(l.name);
      return;
    }
    const src = join(dir, l.name);
    let text;
    try {
      ({ text } = readRegular(src, { single: true }));
    } catch {
      slots[i] = `skipped: ${visible(l.name)} (closed, but not a single regular file — move it by hand)`;
      return;
    }
    pending.push({ i, name: l.name, plan: l.plan, branch: l.branch, src, text, rulings: harvestBindings(text) });
  });

  // Phase C, the writes: the register first, then each ledger's closed line and move.
  if (!dryRun && pending.length) {
    const day = now.toISOString().slice(0, 10);
    const candidates = pending.flatMap((p) => p.rulings.map(({ ruling, date }) => registerLine({ ruling, date: date ?? day, plan: p.plan })));
    if (candidates.length) {
      try {
        const { text, mode } = readRegister(register.path);
        // A line the register already holds, or one earlier in this batch, is not appended again.
        const held = new Set(text.split(/\r?\n/));
        const fresh = [];
        for (const line of candidates) {
          if (held.has(line)) continue;
          held.add(line);
          fresh.push(line);
        }
        if (fresh.length) replaceFile(register.path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${fresh.join('\n')}\n`, mode);
      } catch (e) {
        return stop(`register: cannot write ${visible(register.rel)} (${(e && e.code) || 'error'}) — nothing swept`);
      }
    }
  }
  const moved = new Set();
  for (const p of pending) {
    const n = p.rulings.length;
    const s = n === 1 ? '' : 's';
    const head = `closed: ${visible(p.name)} (${visible(p.branch)} gone) — ${n} binding ruling${s} → ${visible(register.rel)}`;
    if (!dryRun) {
      try {
        // A retry after a failed move finds the closed line already there: the append is done once.
        const last = p.text.trimEnd().split(/\r?\n/).pop() || '';
        if (!/^closed \S+ by sweep — /.test(last)) {
          appendToLedger(p.src, `${p.text.endsWith('\n') ? '' : '\n'}closed ${now.toISOString()} by sweep — ${n} binding ruling${s} → ${register.rel}\n`);
        }
        try { mkdirSync(archive); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
        linkSync(p.src, join(archive, p.name));
        unlinkSync(p.src);
      } catch (e) {
        slots[p.i] = e && e.code === 'EEXIST' ? collision(p.name) : `${head}; not moved (${(e && e.code) || 'error'})`;
        continue;
      }
    }
    slots[p.i] = `${head}, moved to .omelette/archive/`;
    moved.add(p.name);
  }
  return {
    lines: slots.filter(Boolean),
    error: null,
    ledgers: listed.ledgers.filter((l) => !moved.has(l.name)),
    archived: listed.archived + moved.size,
    register,
  };
}

/**
 * What doctor says about a register: `entries` are its `- ` lines, `struck`
 * those that say "superseded by" (any case), `unstruck` the others, in order.
 * @returns {{entries:number, struck:number, unstruck:string[]}}
 */
export function registerStats(text) {
  const entries = String(text).split(/\r?\n/).filter((l) => l.startsWith('- '));
  const unstruck = entries.filter((l) => !/superseded by/i.test(l));
  return { entries: entries.length, struck: entries.length - unstruck.length, unstruck };
}
