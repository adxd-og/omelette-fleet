/**
 * omelette-fleet :: core/ledger.mjs
 * The 1.7.3 ledger lifecycle in one place: a ledger's `branch:` header, its
 * state through `git show-ref --verify` (open, closed, standing, untracked),
 * and `ledger open`. The CLI imports this module statically; the guard loads
 * it with one dynamic import. It writes only under the project's `.omelette/`
 * and to the decisions register.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gitChildEnv, readBoundedFile } from './check.mjs';
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

/** Whether `dir`, or an ancestor of it below `root`, is the project's `.git` (dev+ino). */
function sameAsGitDir(projectDir, root, dir) {
  let git;
  try {
    git = lstatSync(join(projectDir, '.git'));
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
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return refuse('absolute path');
  if (value.split(/[\\/]/).includes('..')) return refuse('contains ..');
  const target = resolve(projectDir, value);
  const rel = relative(projectDir, target).split(sep).join('/');
  if (rel === REGISTER_DEFAULT) return refuse('points at itself');
  if (rel === '.git' || rel.startsWith('.git/')) return refuse('inside .git');
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
  if (sameAsGitDir(projectDir, realRoot, realDir)) return refuse('inside .git');
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
