/**
 * omelette-fleet :: test/hooks-stamp.test.mjs
 * 1.8.0 Task 6 — the PreCompact stamp carries facts (branch, short HEAD, dirty
 * count). test/hooks.test.mjs pins the happy path, `unknown` without git, `über`,
 * `we ird`, a detached HEAD and a relative PATH entry; this file holds what those
 * rows leave open: the shapes of a repository (untracked only, staged rename, no
 * commit yet, a subdirectory, no repository), the 64/65 name bound, a git that
 * hangs, floods or lies, the env git is run in, and the print reading past the
 * stamp. The guard is the rendered script, driven as a child process; git runs
 * from the test runner, never from the guard under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

const HAVE_GIT = spawnSync('git', ['--version']).status === 0;
const SKIP = !HAVE_GIT || process.platform === 'win32';

function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-stamp-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.8.0-test'));
  return { dir, path };
}

function fire(path, input, cwd, env) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path], { input: JSON.stringify(input), encoding: 'utf8', cwd, env, timeout: 30000 });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', ms: Date.now() - t0 };
}

/** A repo with a ledger; `commit: false` leaves it unborn. `.omelette/` is ignored. */
function repo(g, name, branch, { commit = true } = {}) {
  const proj = join(g.dir, name);
  mkdirSync(join(proj, '.omelette'), { recursive: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: proj, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  git('init', '-q', '-b', branch);
  writeFileSync(join(proj, '.gitignore'), '.omelette/\n');
  writeFileSync(join(proj, 'a.txt'), 'a\n');
  if (commit) { git('add', '.'); git('commit', '-q', '-m', 'one'); }
  writeFileSync(join(proj, '.omelette', 'ledger-x.md'), '# x\n');
  return { proj, git };
}

const stamp = (proj) => readFileSync(join(proj, '.omelette', 'ledger-x.md'), 'utf8').split('\n').filter((l) => l.startsWith('## Compaction')).pop() || '';
const pre = (g, proj, spawnCwd = proj, env) => fire(g.path, { hook_event_name: 'PreCompact', trigger: 'manual', cwd: proj }, spawnCwd, env);
const FACTS = /— branch (\S+) · HEAD (\S+) · (\S+) dirty files —/;
const factsOf = (proj) => { const m = FACTS.exec(stamp(proj)); assert.ok(m, `no facts in: ${stamp(proj)}`); return { branch: m[1], head: m[2], dirty: m[3] }; };

/** A directory holding one `git` script, to be the whole PATH. */
function fakeGit(body) {
  const d = mkdtempSync(join(tmpdir(), 'omelette-fakegit-'));
  writeFileSync(join(d, 'git'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(d, 'git'), 0o755);
  return d;
}

test('repository shapes: clean, untracked only, staged rename, subdirectory', { skip: SKIP }, () => {
  const g = guard();
  const { proj, git } = repo(g, 'shapes', 'main');
  assert.equal(pre(g, proj).code, 0);
  assert.deepEqual(factsOf(proj), { branch: 'main', head: factsOf(proj).head, dirty: '0' });

  writeFileSync(join(proj, 'new.txt'), 'n\n');
  pre(g, proj);
  assert.equal(factsOf(proj).dirty, '1', 'an untracked file counts, once');

  git('mv', 'a.txt', 'c.txt');
  pre(g, proj);
  assert.equal(factsOf(proj).dirty, '2', 'a staged rename is one line, plus the untracked file');

  // the event's cwd is a subdirectory of the repo (with a ledger of its own); the hook's own cwd is elsewhere
  const sub = join(proj, 'sub');
  mkdirSync(join(sub, '.omelette'), { recursive: true });
  writeFileSync(join(sub, '.omelette', 'ledger-x.md'), '# x\n');
  const elsewhere = mkdtempSync(join(tmpdir(), 'omelette-elsewhere-'));
  assert.equal(pre(g, sub, elsewhere).code, 0);
  assert.deepEqual(factsOf(sub), { branch: 'main', head: factsOf(sub).head, dirty: '2' }, 'the repo of the event cwd, whose hook process stands elsewhere');
});

test('a repository with no commit yet, and a cwd that is no repository', { skip: SKIP }, () => {
  const g = guard();
  const { proj } = repo(g, 'unborn', 'main', { commit: false });
  assert.equal(pre(g, proj).code, 0);
  const f = factsOf(proj);
  assert.equal(f.head, 'unknown', 'rev-parse --short HEAD fails with no commit');
  assert.equal(f.branch, 'unknown', 'rev-parse --abbrev-ref HEAD fails with no commit');
  assert.notEqual(f.dirty, 'unknown', 'status works on an unborn branch');

  const plain = join(g.dir, 'plain');
  mkdirSync(join(plain, '.omelette'), { recursive: true });
  writeFileSync(join(plain, '.omelette', 'ledger-x.md'), '# x\n');
  assert.equal(pre(g, plain).code, 0);
  assert.deepEqual(factsOf(plain), { branch: 'unknown', head: 'unknown', dirty: 'unknown' });
});

test('a branch name of 64 characters is kept, of 65 is `unknown`; `/` and `.` are kept', { skip: SKIP }, () => {
  const g = guard();
  const b64 = 'b'.repeat(64);
  const a = repo(g, 'b64', b64);
  pre(g, a.proj);
  assert.equal(factsOf(a.proj).branch, b64);
  const b = repo(g, 'b65', 'b'.repeat(65));
  pre(g, b.proj);
  assert.equal(factsOf(b.proj).branch, 'unknown');
  const c = repo(g, 'dots', 'release/v1.8.0-rc.1');
  pre(g, c.proj);
  assert.equal(factsOf(c.proj).branch, 'release/v1.8.0-rc.1');
});

test('git runs in its own env: no GIT_DIR or foreign variable, optional locks off, no prompt', { skip: SKIP }, () => {
  const g = guard();
  const { proj } = repo(g, 'envrow', 'feat/real');
  const other = repo(g, 'other', 'feat/other');
  // GIT_DIR from the operator's shell must not redirect the facts to another repository
  pre(g, proj, proj, { ...process.env, GIT_DIR: join(other.proj, '.git'), GIT_WORK_TREE: other.proj });
  assert.equal(factsOf(proj).branch, 'feat/real');

  const probe = fakeGit('echo "$GIT_OPTIONAL_LOCKS-$GIT_TERMINAL_PROMPT-${OMELETTE_PROBE:-none}-${GIT_DIR:-none}"');
  const p = repo(g, 'probe', 'main');
  pre(g, p.proj, p.proj, { PATH: probe, OMELETTE_PROBE: 'leak', GIT_DIR: join(other.proj, '.git') });
  assert.equal(factsOf(p.proj).branch, '0-0-none-none');
});

test('a git that lies: newline, control characters, empty lines, a 10 MB flood — every fact is `unknown` or counted sanely, never a crash', { skip: SKIP }, () => {
  const g = guard();
  const r = (name, body) => { const x = repo(g, name, 'main'); const res = pre(g, x.proj, x.proj, { PATH: fakeGit(body) }); assert.equal(res.code, 0, res.err); return { ...factsOf(x.proj), res }; };

  const nl = r('nl', 'printf "a\\nb\\n"');
  assert.equal(nl.branch, 'unknown');
  assert.equal(nl.head, 'unknown');
  const ctl = r('ctl', 'printf "a\\001b\\n"');
  assert.equal(ctl.branch, 'unknown');
  const esc = r('esc', 'printf "ok\\033[2Jx\\n"');
  assert.equal(esc.head, 'unknown');

  const empties = r('empties', 'if [ "$1" = status ]; then printf "\\n\\n M a\\n\\n"; else echo abc; fi');
  assert.equal(empties.dirty, '1', 'only non-empty lines are counted');

  const flood = r('flood', '/usr/bin/head -c 10000000 /dev/zero | /usr/bin/tr "\\0" a');
  assert.deepEqual([flood.branch, flood.head, flood.dirty], ['unknown', 'unknown', 'unknown']);
  assert.match(stamp(join(g.dir, 'flood')), /re-read this ledger before continuing$/);
});

test('a git that hangs: each fact is `unknown`, the stamp lands, the hook ends inside its budget', { skip: SKIP }, () => {
  const g = guard();
  const { proj } = repo(g, 'hang', 'main');
  const res = pre(g, proj, proj, { PATH: fakeGit('exec /bin/sleep 20') });
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(factsOf(proj), { branch: 'unknown', head: 'unknown', dirty: 'unknown' });
  assert.ok(res.ms < 9000, `three 2 s timeouts, not three hangs: ${res.ms} ms`);
  console.log(`# hang row: ${res.ms} ms`);
});

test('the SessionStart print still ends the handoff block at the stamp: the facts never print as handoff', { skip: SKIP }, () => {
  const g = guard();
  const { proj } = repo(g, 'print', 'feat/p');
  writeFileSync(join(proj, '.omelette', 'ledger-x.md'), '# x\n\n## Handoff\nwhere the work stands: T6\n');
  assert.equal(pre(g, proj).code, 0);
  assert.match(stamp(proj), /branch feat\/p · HEAD [0-9a-f]+ · 0 dirty files/);
  const start = fire(g.path, { hook_event_name: 'SessionStart', source: 'compact', cwd: proj }, proj);
  assert.equal(start.code, 0, start.err);
  assert.match(start.out, /where the work stands: T6/);
  assert.doesNotMatch(start.out, /dirty files|Compaction|feat\/p/);
});

test('a git that ignores SIGTERM is still cut at 2 s per call (spec rule 7: "each 2 s")', { skip: SKIP }, () => {
  const g = guard();
  const { proj } = repo(g, 'hang-term', 'main');
  // 4 s per call: cut at 2 s each the hook takes ~6 s; waited out it takes ~12 s
  const res = pre(g, proj, proj, { PATH: fakeGit('trap "" TERM\n/bin/sleep 4\necho late') });
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(factsOf(proj), { branch: 'unknown', head: 'unknown', dirty: 'unknown' });
  assert.ok(res.ms < 9000, `a git that ignores SIGTERM held the hook ${res.ms} ms`);
});
