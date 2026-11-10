/**
 * omelette-fleet :: test/hooks.test.mjs
 * The guard script is driven the way Claude Code drives it: a CHILD PROCESS
 * with the event as JSON on stdin, because its whole contract is stdin in,
 * exit code + stderr out. Importing it would test a different program — and it
 * is EXIT 2 that blocks a tool call, so nothing but a real exit code proves it.
 *
 * Every run gets the script rendered into its own temp directory: the shipped
 * template carries `{{marker}}` on line 1 and is not runnable until `rules
 * --hooks` renders it, which is exactly what these tests do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { HOOK_FILES, HOOK_MARKER, parseHookMarker, renderHookFile } from '../core/rules.mjs';
import { printed } from './fixtures/ledger-1.7.3.mjs';

/** The refusal names the agent it caught, so two guarded roles never read each other's line. */
const REFUSAL = (agent) => `${agent} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`;

/** The guard exactly as `rules --hooks` writes it, in a throwaway directory. */
function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3'));
  return { dir, path };
}

/** One hook invocation: the event on stdin, the answer as code/stdout/stderr. */
function fire(path, input, cwd, env) {
  const r = spawnSync(process.execPath, [path], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', cwd, env, timeout: 20000,
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  const out = r.stdout || '';
  return { code: r.status, out: input?.hook_event_name === 'SessionStart' ? printed(out) : out, err: r.stderr || '' };
}

/**
 * The same invocation with the STDIN PIPE under the test's control: spawnSync
 * always closes stdin for you, and the two things worth proving here are what
 * the guard does when the pipe carries too much (`write` and never read past
 * the cap — the write may EPIPE, which is the point) and when it never closes
 * at all (`end: false`). Resolves with how long the run took.
 */
function fireOpenStdin(path, { write = '', end = true } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => { /* the guard stopping short of the write is the behaviour under test */ });
    child.on('close', (code, signal) => resolve({ code, signal, out, err, ms: Date.now() - started }));
    child.stdin.write(write, () => { if (end) child.stdin.end(); });
    if (!write && end) child.stdin.end();
  });
}

const preToolUse = (over = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: 'omelette-coder',
  tool_input: { command: 'git commit -m "x"' }, ...over,
});

test('the rendered guard carries the marker on line 1 and round-trips through parseHookMarker', () => {
  const text = renderHookFile(HOOK_FILES[0], '1.2.3');
  assert.equal(text.split('\n')[0], HOOK_MARKER('1.2.3'));
  assert.equal(parseHookMarker(text), '1.2.3');
  assert.ok(!text.includes('{{'), 'no placeholder survives rendering');
});

test('PreToolUse: the coder is blocked with exit 2 and the refusal on stderr', () => {
  const g = guard();
  for (const command of [
    'git commit -m "wip"',
    'git push origin main',
    'git stash',
    'git checkout -b feat/x',
    'git switch -c feat/x',
    'git worktree add ../wt',
    'cd /tmp && git commit --amend --no-edit',
    // Real git syntax the tidy form does not cover: global flags ahead of the
    // subcommand, and a branch name attached to its flag (`-B`/`-C` force it).
    'git -C /x commit -m y',
    'git -c user.name=a commit',
    'git --no-pager push',
    'git checkout -bfeat',
    'git switch -cfeat',
    'git checkout -Bfeat',
    'git switch -Cfeat',
    // An option value is quoted the moment it contains a space, and a long
    // option takes its value with a space as readily as with an `=`.
    'git -C "/My Dir" commit',
    "git -C '/My Dir' commit",
    'git -c user.name="A B" commit',
    "git -c user.name='A B' commit",
    'git --work-tree /tmp/x commit',
    'git --git-dir /x/.git commit',
    // Value-less short flags and the bare `--` separator are options too.
    'git -p commit',
    'git -P commit',
    'git -C a -p commit',
    'git -- commit',
    // Creating a branch is creating a branch however it is spelled…
    'git branch feat',
    // …and moving one that already exists is the same write: rename, copy,
    // force-reset to another ref, or repoint its upstream.
    'git branch -m old new',
    'git branch -M old new',
    'git branch -c a b',
    'git branch -C a b',
    'git branch -f feat main',
    'git branch --force feat main',
    'git branch -u origin/x',
    'git branch --set-upstream-to=origin/x',
    'git branch -fm old new',
    'git checkout -q -b feat',
    'git checkout -q -B feat',
    'git checkout --orphan x',
    'git checkout --track origin/feat',
    'git switch --create feat',
    'git switch --force-create feat',
    // Everything else that writes history or a ref.
    'git merge main',
    'git rebase -i main',
    'git cherry-pick abc123',
    'git revert abc123',
    'git am /tmp/p.patch',
    'git pull',
    'git tag v1.0.0',
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder'));
    assert.equal(r.out, '', 'a block says nothing on stdout');
  }
});

test('PreToolUse: everything else runs — other git commands, other tools, other agents, the main thread', () => {
  const g = guard();
  const allowed = [
    preToolUse({ tool_input: { command: 'git status' } }),
    preToolUse({ tool_input: { command: 'git log --oneline -3' } }),
    preToolUse({ tool_input: { command: 'git diff HEAD' } }),
    preToolUse({ tool_input: { command: 'npm test' } }),
    // A longer subcommand that merely starts like a forbidden one: commit-tree
    // writes an object and commits nothing, and checkout without -b/-c moves.
    preToolUse({ tool_input: { command: 'git commit-tree $t -m x' } }),
    preToolUse({ tool_input: { command: 'git checkout main' } }),
    preToolUse({ tool_input: { command: 'git switch main' } }),
    preToolUse({ tool_input: { command: 'git checkout -- file.txt' } }),
    preToolUse({ tool_input: { command: 'git merge-base main HEAD' } }),
    // `git branch` READS until it is given a name or a flag that moves a ref:
    // listing, deleting and the remote/all/verbose views are how a coder finds
    // out where it is.
    preToolUse({ tool_input: { command: 'git branch' } }),
    preToolUse({ tool_input: { command: 'git branch --list' } }),
    preToolUse({ tool_input: { command: 'git branch -l' } }),
    preToolUse({ tool_input: { command: 'git branch -a' } }),
    preToolUse({ tool_input: { command: 'git branch -r' } }),
    preToolUse({ tool_input: { command: 'git branch -v' } }),
    preToolUse({ tool_input: { command: 'git branch -av' } }),
    preToolUse({ tool_input: { command: 'git branch -d x' } }),
    preToolUse({ tool_input: { command: 'git branch -D x' } }),
    preToolUse({ tool_input: { command: 'git branch --list feature-c' } }),
    // the same command from anything that is not one of the two guarded roles
    // (`omelette-tester` sat here until 0.3.4 — it is guarded now, below)
    preToolUse({ agent_type: undefined }), //         the main thread carries no agent_type
    preToolUse({ agent_type: 'omelette-coder-2' }),
    // …and a coder that is not running a shell command
    preToolUse({ tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'git commit' } }),
    preToolUse({ tool_input: {} }),
    preToolUse({ tool_input: undefined }),
  ];
  for (const event of allowed) {
    const r = fire(g.path, event);
    assert.equal(r.code, 0, `${JSON.stringify(event)} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

test('PreToolUse: `git tag` reads and `git rebase --abort` pass; the tag writes and the rebase continuations still block', () => {
  const g = guard();
  // `git tag` with nothing after it LISTS tags, and so do -l / --list / -n
  // (with or without a count) — a coder finding out where it is.
  for (const command of [
    'git tag',
    'git tag -l',
    'git tag --list',
    'git tag -n',
    'git tag -n5',
    'git tag -l "v1.*"',
    "git tag --list 'v*'",
    'git tag --sort=-v:refname',
    'git tag --contains HEAD',
    // A listing MODE is a listing however the pattern is spelled and wherever
    // the flag sits: the mode flag is what git dispatches on, not the position.
    'git tag v1 --list',
    'git tag --list v1*',
    'git tag --contains abc',
    'git tag --no-contains abc',
    'git tag --points-at HEAD',
    'git tag --merged main',
    'git tag --no-merged main',
    // --with/--without are the listing aliases of --contains/--no-contains.
    'git tag --with HEAD',
    'git tag --without HEAD',
    // A quoted span is ONE opaque value: the flags inside it are text, and the
    // whitespace inside it does not end the token.
    "git tag -l --format='%(refname) -a %(objectname)'",
    "git tag -l --format='%(refname)'",
    // An option's VALUE is a value, not a tag name — `--sort refname` sorts a
    // listing and creates nothing, whether the value arrives attached or as
    // the next word.
    'git tag --sort refname',
    'git tag --format "%(refname)"',
    // `--column` and `--color` take a value only ATTACHED: git 2.38.1 reads
    // `git tag --column always` as creating a tag called `always`, so that
    // command is in the refused list below (1.3.0, G5).
    'git tag --column=always',
    // A shell comment is not part of the command — and a `git tag` inside one
    // is not a command at all.
    'echo hi # git tag v1',
    // -v/--verify VERIFIES a signature: it reads a tag that already exists.
    'git tag -v v1',
    'git tag --verify v1',
    // …and the rebases that UNDO or explain rather than write: the recovery an
    // agent needs after a rebase it should never have started, wherever the
    // flag sits among the arguments.
    'git rebase --abort',
    'git -C /x rebase --abort',
    'git rebase -q --abort',
    'git rebase --quit',
    'git rebase --help',
    'git rebase -h',
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
  for (const command of [
    // Naming a tag creates one, and so does every flag that writes or deletes one.
    'git tag v1.0.0',
    'git tag -a v1.0.0 -m "release"',
    'git tag --annotate v1.0.0',
    'git tag -m "release" v1.0.0',
    'git tag -s v1.0.0',
    'git tag -f v1.0.0 HEAD',
    'git tag --force v1.0.0',
    'git tag -d v1.0.0',
    'git tag --delete v1.0.0',
    // -F/--file take the message from a file and --cleanup grooms one: each of
    // them implies -a, so each creates an annotated tag exactly as -m does.
    'git tag -F msg v1',
    'git tag --file=m v1',
    'git tag --file m v1',
    'git tag --cleanup=verbatim v1',
    'git -C /x tag v1.0.0',
    // A NAME is a name whatever stands in front of it: an option separator, an
    // option that takes no value, or a negation that is not a listing mode.
    'git tag -- v1',
    'git tag --create-reflog v1',
    'git tag --end-of-options v1',
    'git tag --no-sign v1',
    'git tag --no-annotate v1',
    'git tag -a v1',
    'git tag -d v1',
    // --format and --sort DECORATE a listing, they do not select one: with a
    // name and no listing flag beside it, git creates the tag and ignores them.
    'git tag v1 --format=x',
    'git tag v1 --sort=refname',
    // A comment does not turn a command into a listing — the tag is created
    // before the `#` is ever read.
    'git tag v1 # --list',
    // …and a comment ends where its LINE ends: what follows on the next line is
    // a command of its own, whatever the line above it said.
    'echo hi # a note\ngit tag v1',
    'echo hi # a note\r\ngit tag v1',
    // A separator INSIDE quotes separates nothing: the value carries the `;`
    // and the tag name after it is still the name of a tag being created.
    'git tag --format="x; y" v1',
    "git tag --format='x && y' v1",
    // A name is a name after an option that took its own value, too.
    'git tag --sort refname v1',
    'git tag -m msg v1',
    // …and after an option whose value is attached-only: `--column` takes
    // none from the next word, so `always` here is the tag it creates.
    'git tag --column always',
    // …and a flag quoted inside a value is text, not a flag: `--exec` runs its
    // argument once per commit, which is a rebase in every sense.
    "git rebase --exec 'echo --abort now' HEAD~1",
    // `--continue` and `--skip` each create a commit; a bare `git rebase` rebases.
    'git rebase --continue',
    'git rebase --skip',
    'git rebase',
    'git rebase main',
    'git rebase -i main',
    'git rebase --onto main x y',
    'git -C /x rebase --continue',
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder'));
  }
});

test('PreCompact: every ledger gets the re-read marker and the handoff line goes to stdout', () => {
  const g = guard();
  const proj = join(g.dir, 'proj');
  mkdirSync(join(proj, '.omelette'), { recursive: true });
  const ledgers = ['ledger-0.3.1.md', 'ledger-rules-delivery.md'];
  for (const l of ledgers) writeFileSync(join(proj, '.omelette', l), `# ${l}\n`);
  // Not a ledger, and a directory that only looks like one: neither is touched.
  writeFileSync(join(proj, '.omelette', 'notes.md'), 'untouched\n');
  writeFileSync(join(proj, '.omelette', 'ledger-old.txt'), 'untouched\n');

  const r = fire(g.path, { hook_event_name: 'PreCompact', trigger: 'manual', cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'HANDOFF: re-read .omelette/ledger-*.md before continuing.');
  for (const l of ledgers) {
    const text = readFileSync(join(proj, '.omelette', l), 'utf8');
    assert.ok(text.startsWith(`# ${l}\n`), 'the ledger is appended to, never rewritten');
    assert.match(
      text.slice(`# ${l}\n`.length),
      /^\n## Compaction \d{4}-\d{2}-\d{2}T[\d:.]+Z \(trigger: manual\) — branch \S+ · HEAD \S+ · \S+ dirty files — re-read this ledger before continuing\n$/,
    );
  }
  assert.equal(readFileSync(join(proj, '.omelette', 'notes.md'), 'utf8'), 'untouched\n');
  assert.equal(readFileSync(join(proj, '.omelette', 'ledger-old.txt'), 'utf8'), 'untouched\n');
});

/* ── 1.8.0 · the stamp carries facts: branch, HEAD and the dirty count ─────── */

/** Where the real git lives, so a test PATH can hold it and nothing else of the operator's. */
const GIT_DIR = (() => {
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  const w = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  return r.status === 0 && w.status === 0 ? dirname(w.stdout.trim()) : null;
})();

/** A git repo on `branch` with one commit; `.omelette/` is ignored, as a project holding a ledger keeps it. */
function stampRepo(g, name, branch) {
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
  writeFileSync(join(proj, 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  writeFileSync(join(proj, '.omelette', 'ledger-x.md'), '# x\n');
  return { proj, git };
}

const stampOf = (proj) => readFileSync(join(proj, '.omelette', 'ledger-x.md'), 'utf8');

test('PreCompact (1.8.0): the stamp names the branch, the short HEAD and the number of dirty files', { skip: !GIT_DIR && 'git is not installed' }, () => {
  const g = guard();
  const { proj } = stampRepo(g, 'facts', 'feat/x');
  writeFileSync(join(proj, 'a.txt'), 'a2\n');
  writeFileSync(join(proj, 'b.txt'), 'b2\n');
  const r = fire(g.path, { hook_event_name: 'PreCompact', trigger: 'manual', cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.match(stampOf(proj), /\n## Compaction \S+ \(trigger: manual\) — branch feat\/x · HEAD [0-9a-f]{7,12} · 2 dirty files — re-read this ledger before continuing\n$/);
});

test('PreCompact (1.8.0): without git on PATH every fact is `unknown`, and the stamp still lands', () => {
  const g = guard();
  const proj = join(g.dir, 'nogit');
  mkdirSync(join(proj, '.omelette'), { recursive: true });
  writeFileSync(join(proj, '.omelette', 'ledger-x.md'), '# x\n');
  const empty = mkdtempSync(join(tmpdir(), 'omelette-nogit-'));
  const r = fire(g.path, { hook_event_name: 'PreCompact', trigger: 'manual', cwd: proj }, proj, { ...process.env, PATH: empty });
  assert.equal(r.code, 0, r.err);
  assert.match(stampOf(proj), /— branch unknown · HEAD unknown · unknown dirty files — re-read this ledger before continuing\n$/);
});

test('PreCompact (1.8.0): a branch name outside ^[\\w./-]{1,64}$ is `unknown`; a detached HEAD is `HEAD`', { skip: !GIT_DIR && 'git is not installed' }, () => {
  const g = guard();
  const { proj: uber } = stampRepo(g, 'uber', 'über');
  let r = fire(g.path, { hook_event_name: 'PreCompact', trigger: 'manual', cwd: uber });
  assert.equal(r.code, 0, r.err);
  assert.match(stampOf(uber), /— branch unknown · HEAD [0-9a-f]{7,12} · 0 dirty files —/);

  // git itself refuses `we ird` as a branch name, so a git on PATH says it.
  const { proj: weird } = stampRepo(g, 'weird', 'main');
  const fake = mkdtempSync(join(tmpdir(), 'omelette-fakegit-'));
  writeFileSync(join(fake, 'git'), '#!/bin/sh\nif [ "$2" = "--abbrev-ref" ]; then echo "we ird"; else echo "abc1234"; fi\n');
  chmodSync(join(fake, 'git'), 0o755);
  r = fire(g.path, { hook_event_name: 'PreCompact', trigger: 'manual', cwd: weird }, weird, { ...process.env, PATH: fake });
  assert.equal(r.code, 0, r.err);
  assert.match(stampOf(weird), /— branch unknown · HEAD abc1234 · 1 dirty files —/);

  const { proj: detached, git } = stampRepo(g, 'detached', 'main');
  git('checkout', '-q', '--detach');
  r = fire(g.path, { hook_event_name: 'PreCompact', trigger: 'manual', cwd: detached });
  assert.equal(r.code, 0, r.err);
  assert.match(stampOf(detached), /— branch HEAD · HEAD [0-9a-f]{7,12} · 0 dirty files —/);
});

test('PreCompact (1.8.0): a relative PATH entry is dropped — a `bin/git` in the project never answers for git', { skip: (!GIT_DIR || process.platform === 'win32') && 'git and a POSIX shell' }, () => {
  const g = guard();
  const { proj } = stampRepo(g, 'relpath', 'feat/real');
  mkdirSync(join(proj, 'bin'));
  writeFileSync(join(proj, 'bin', 'git'), '#!/bin/sh\necho evil\n');
  chmodSync(join(proj, 'bin', 'git'), 0o755);
  const r = fire(g.path, { hook_event_name: 'PreCompact', trigger: 'manual', cwd: proj }, proj, { ...process.env, PATH: ['bin', GIT_DIR, '/usr/bin'].join(delimiter) });
  assert.equal(r.code, 0, r.err);
  const text = stampOf(proj);
  assert.match(text, /— branch feat\/real · HEAD [0-9a-f]{7,12} · /);
  assert.doesNotMatch(text, /evil/);
});

test('PreCompact: no ledger — no .omelette at all, or one without a ledger-*.md — is a clean, silent exit (1.2.0: the ledger is the opt-in)', () => {
  const g = guard();
  const proj = join(g.dir, 'empty');
  mkdirSync(proj);
  let r = fire(g.path, { hook_event_name: 'PreCompact', trigger: 'auto', cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '', 'nothing was stamped, so nothing is announced');
  assert.deepEqual(readdirSync(proj), [], 'a missing ledger is not a reason to create one');
  mkdirSync(join(proj, '.omelette'));
  writeFileSync(join(proj, '.omelette', 'notes.md'), 'untouched\n');
  r = fire(g.path, { hook_event_name: 'PreCompact', trigger: 'auto', cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '', 'a .omelette without a ledger-*.md is the same as none');
  assert.deepEqual(readdirSync(join(proj, '.omelette')), ['notes.md']);
  // The moment a ledger appears, the stamp and the line are back.
  writeFileSync(join(proj, '.omelette', 'ledger-x.md'), '# x\n');
  r = fire(g.path, { hook_event_name: 'PreCompact', trigger: 'auto', cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^HANDOFF: /);
  assert.match(readFileSync(join(proj, '.omelette', 'ledger-x.md'), 'utf8'), /## Compaction /);
});

test('PreCompact: a ledger that is not a regular file is skipped — a symlink is never followed, a FIFO never blocks', { skip: process.platform === 'win32' && 'POSIX symlinks and FIFOs' }, () => {
  const g = guard();
  const proj = join(g.dir, 'special');
  mkdirSync(join(proj, '.omelette'), { recursive: true });
  writeFileSync(join(proj, '.omelette', 'ledger-real.md'), '# real\n');
  // A symlink out of .omelette is how an append becomes a write to somewhere
  // else entirely; a FIFO is how it becomes a hang that never ends.
  const outside = join(g.dir, 'outside.md');
  writeFileSync(outside, 'untouched\n');
  symlinkSync(outside, join(proj, '.omelette', 'ledger-link.md'));
  const fifo = join(proj, '.omelette', 'ledger-fifo.md');
  const madeFifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' }).status === 0;

  const r = fire(g.path, { hook_event_name: 'PreCompact', trigger: 'auto', cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^HANDOFF: /);
  assert.match(readFileSync(join(proj, '.omelette', 'ledger-real.md'), 'utf8'), /\n## Compaction .* \(trigger: auto\) —/);
  assert.equal(readFileSync(outside, 'utf8'), 'untouched\n', 'a symlinked ledger is skipped, not followed');
  if (madeFifo) assert.ok(statSync(fifo).isFIFO(), 'the FIFO is still a FIFO and the run did not hang on it');
});

test('PreCompact falls back to the process cwd when the event carries none', () => {
  const g = guard();
  const proj = join(g.dir, 'nocwd');
  mkdirSync(join(proj, '.omelette'), { recursive: true });
  writeFileSync(join(proj, '.omelette', 'ledger-x.md'), 'x\n');
  const r = fire(g.path, { hook_event_name: 'PreCompact' }, proj);
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(join(proj, '.omelette', 'ledger-x.md'), 'utf8'), /## Compaction .* \(trigger: unknown\) —/);
});

test('the guard never throws: malformed, empty, hostile and unknown input all exit 0 in silence', () => {
  const g = guard();
  for (const input of [
    '', '   ', 'not json at all', '{"unterminated": ', 'null', 'true', '42', '[1,2,3]', '"a string"',
    '{}',
    JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git push' } }),
    JSON.stringify({ hook_event_name: 'SessionStart' }),
    JSON.stringify({ hook_event_name: 42 }),
    JSON.stringify({ hook_event_name: 'PreToolUse', agent_type: 'omelette-coder', tool_name: 'Bash', tool_input: 'git commit' }),
    JSON.stringify({ hook_event_name: 'PreCompact', cwd: 42, trigger: { not: 'a string' } }),
    JSON.stringify({ hook_event_name: 'PreCompact', cwd: '/nope/does/not/exist' }),
  ]) {
    // cwd is the throwaway directory: a PreCompact event whose own cwd is
    // unusable falls back to the process's, and that must not be this checkout.
    const r = fire(g.path, input, g.dir);
    assert.equal(r.code, 0, `${input} should exit 0: ${r.out}${r.err}`);
    assert.equal(r.err, '', `${input} printed to stderr: ${r.err}`);
  }
});

test('stdin over the 8 MiB cap is refused unread: the guard stops reading and exits 2 (1.9.0; exit 0 before)', async () => {
  const g = guard();
  // The forbidden command is the first thing in the event and the 9 MiB of
  // padding comes after: unread, it cannot be let through.
  const oversized = JSON.stringify(preToolUse({
    tool_input: { command: 'git push origin main' }, padding: 'x'.repeat(9 * 1024 * 1024),
  }));
  const r = await fireOpenStdin(g.path, { write: oversized });
  assert.equal(r.code, 2, `${r.out}${r.err}`);
  assert.equal(r.signal, null);
  assert.equal(r.err.trim(), 'omelette-guard: event over 8 MiB — refused unread');
  assert.ok(r.ms < 15000, `the guard should give up at once, took ${r.ms}ms`);

  // …and an event UNDER the cap is still read whole, however big it is: a
  // PostToolUse event carries the tool's own response, and a few megabytes of
  // command output on one call is ordinary. At 1 MiB this refusal was lost.
  const large = JSON.stringify(preToolUse({
    tool_input: { command: 'git push origin main' }, tool_response: { stdout: 'x'.repeat(4 * 1024 * 1024) },
  }));
  const read = await fireOpenStdin(g.path, { write: large });
  assert.equal(read.code, 2, `a 4 MiB event is still an event: ${read.out}${read.err}`);
  assert.equal(read.err.trim(), REFUSAL('omelette-coder'));
});

test('stdin that never closes: the guard gives up at its deadline and exits 0 rather than holding the session', async () => {
  const g = guard();
  const r = await fireOpenStdin(g.path, { write: '{"hook_event_name":"PreToolUse"', end: false });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.equal(r.signal, null);
  assert.equal(r.err, '');
  assert.ok(r.ms >= 4000 && r.ms < 15000, `expected the ~5 s stdin deadline, exited after ${r.ms}ms`);
});

test('PreToolUse: a command of nothing but option-shaped tokens is answered at once, not tiled', () => {
  // Overlapping alternatives in the option run give a NON-matching command
  // exponentially many tilings — ` -c` readable as its own flag or as the
  // previous option's value. Measured on the earlier form: 5 ms at 20 tokens,
  // 94 ms at 30, 11.4 s at 40. On the guard's hot path that is every Bash call
  // in the session, so the run is deliberately unambiguous instead.
  const g = guard();
  for (const command of [
    `git${' -c'.repeat(60)} zzz`,
    `git${' --foo'.repeat(60)}`,
    // A tag listing narrowed 60 times over: the subcommand's own arguments are
    // classified by scanning them once, so they cannot be tiled either.
    `git tag${' --contains x'.repeat(60)}`,
    // …and the same shape at 10 KB, because the comment scan, the tokenizer and
    // the classifier each walk the command once; only a quoted word is read
    // again, as a command of its own, and never deeper than QUOTE_DEPTH.
    `git tag${' --contains x'.repeat(800)}`,
    `echo ${'x'.repeat(5000)} # ${'a comment '.repeat(500)}`,
  ]) {
    // The net is fire()'s own: a guard still running at 20 s is killed and
    // fails as hung. Sixty tokens put the tiled form past it many times over
    // (11.4 s at forty), while one scanning run takes a process start-up.
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command.slice(0, 40)}… should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

/** A throwaway project with an empty `.omelette` beside the rendered guard. */
function ledgerProject(g, name) {
  const proj = join(g.dir, name);
  mkdirSync(join(proj, '.omelette'), { recursive: true });
  return proj;
}

const sessionStart = (over = {}) => ({ hook_event_name: 'SessionStart', source: 'compact', ...over });

test('SessionStart(compact): the LAST handoff block is printed under the ledger it came from, and the ledger is not written to', () => {
  const g = guard();
  const proj = ledgerProject(g, 'blocks');
  const ledger = join(proj, '.omelette', 'ledger-0.3.3.md');
  const text = [
    '# ledger 0.3.3',
    '',
    '## Handoff 2026-09-08T10:00Z',
    'stale: the first block, superseded by the one below',
    '',
    '## Task 2 — done (commit abc1234)',
    'Ruling: keep the cap — a truncated tail beats a flooded context — costs the oldest lines',
    '',
    '## Handoff 2026-09-08T18:00Z',
    'Where it stands: T2 committed, T3 in review.',
    '',
    // A heading inside a fence is TEXT: a ledger quoting its own vocabulary
    // must not cut the block it is quoted in.
    '```md',
    '## Handoff (an example inside a fence)',
    '```',
    'Next action: run npm test, then report.',
    '',
    '',
  ].join('\n');
  writeFileSync(ledger, text);

  const r = fire(g.path, sessionStart({ cwd: proj }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  assert.equal(r.out, [
    '--- ledger-0.3.3.md · last handoff ---',
    '## Handoff 2026-09-08T18:00Z',
    'Where it stands: T2 committed, T3 in review.',
    '',
    '```md',
    '## Handoff (an example inside a fence)',
    '```',
    'Next action: run npm test, then report.',
    '',
  ].join('\n'));
  assert.equal(readFileSync(ledger, 'utf8'), text, 'SessionStart READS the ledger; only PreCompact writes one');
});

test('SessionStart(compact): a ledger with no handoff block prints nothing at all', () => {
  const g = guard();
  const proj = ledgerProject(g, 'noblock');
  writeFileSync(join(proj, '.omelette', 'ledger-plain.md'), [
    '# ledger',
    '## Task 1 — done (commit abc1234)',
    'Ruling: X — because Y — costs Z',
    // The vocabulary is `## Handoff`: a level-3 heading and a `#` with no space
    // after it are not level-2 headings at all, a heading ABOUT handoffs is not
    // one either, and `##` and `Handoff` on two lines is two things.
    '### Handoff notes',
    '##Handoff',
    '## Handoffs, and why we write them',
    '##',
    'Handoff 2026-09-09T09:00Z',
    'nothing here is a handoff block',
  ].join('\n'));
  const r = fire(g.path, sessionStart({ cwd: proj }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '', 'nothing to print is printed as nothing — no header, no blank line');
  assert.equal(r.err, '');
});

test('SessionStart: only `compact` and `clear` print — a startup, a resume and a fork lost no context', () => {
  const g = guard();
  const proj = ledgerProject(g, 'sources');
  writeFileSync(join(proj, '.omelette', 'ledger-x.md'), '## Handoff\nnext action: run npm test\n');
  for (const source of ['startup', 'resume', 'fork', '', 'Compact', 42, undefined]) {
    const r = fire(g.path, sessionStart({ source, cwd: proj }));
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, '', `source ${JSON.stringify(source)} must print nothing`);
    assert.equal(r.err, '');
  }
  const compacted = fire(g.path, sessionStart({ cwd: proj }));
  assert.equal(compacted.out, '--- ledger-x.md · last handoff ---\n## Handoff\nnext action: run npm test\n');
  assert.equal(fire(g.path, sessionStart({ source: 'clear', cwd: proj })).out, compacted.out);
});

test('SessionStart(compact): one ledger is capped at 40 lines and at 4 KB, and says the rest was dropped', () => {
  const g = guard();
  const lines = ledgerProject(g, 'caps-lines');
  writeFileSync(join(lines, '.omelette', 'ledger-lines.md'),
    ['# ledger', '## Handoff', ...Array.from({ length: 60 }, (_, i) => `line ${i}`)].join('\n'));
  const capped = fire(g.path, sessionStart({ cwd: lines }));
  assert.equal(capped.code, 0, capped.err);
  const body = capped.out.split('\n');
  assert.equal(body[0], '--- ledger-lines.md · last handoff ---');
  assert.equal(body[1], '## Handoff');
  assert.equal(body[40], 'line 38', '40 lines kept, the heading among them');
  assert.equal(body[41], '[… truncated]');
  assert.equal(capped.out.includes('line 39'), false);

  // 301-byte lines: the BYTE cap bites long before the line cap does.
  const bytes = ledgerProject(g, 'caps-bytes');
  writeFileSync(join(bytes, '.omelette', 'ledger-wide.md'),
    ['## Handoff', ...Array.from({ length: 20 }, () => 'x'.repeat(300))].join('\n'));
  const wide = fire(g.path, sessionStart({ cwd: bytes }));
  const wideLines = wide.out.split('\n');
  assert.equal(wideLines.filter((l) => l.startsWith('xxx')).length, 13, '4096 bytes is the heading plus 13 of them');
  assert.equal(wideLines[wideLines.length - 2], '[… truncated]');
  assert.ok(Buffer.byteLength(wide.out, 'utf8') < 4096 + 64, `per-ledger cap: ${Buffer.byteLength(wide.out, 'utf8')} bytes`);
});

test('SessionStart(compact): the caps are hard — a handoff line longer than 4 KB leaves only the truncation marker', () => {
  const g = guard();
  const proj = ledgerProject(g, 'huge');
  writeFileSync(join(proj, '.omelette', 'ledger-huge.md'), `## Handoff ${'x'.repeat(5000)}\nnext action: nothing\n`);
  const r = fire(g.path, sessionStart({ cwd: proj }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '--- ledger-huge.md · last handoff ---\n[… truncated]\n');
});

test('SessionStart(compact): every ledger contributes its own block, in name order, with the same filter PreCompact uses', () => {
  const g = guard();
  const proj = ledgerProject(g, 'two');
  writeFileSync(join(proj, '.omelette', 'ledger-b-second.md'), '## Handoff\nB: review pending\n');
  writeFileSync(join(proj, '.omelette', 'ledger-a-first.md'), '## Handoff\nA: T3 in flight\n');
  writeFileSync(join(proj, '.omelette', 'notes.md'), '## Handoff\nnot a ledger\n');
  writeFileSync(join(proj, '.omelette', 'ledger-old.txt'), '## Handoff\nnot markdown\n');
  const r = fire(g.path, sessionStart({ cwd: proj }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [
    '--- ledger-a-first.md · last handoff ---',
    '## Handoff',
    'A: T3 in flight',
    '',
    '--- ledger-b-second.md · last handoff ---',
    '## Handoff',
    'B: review pending',
    '',
  ].join('\n'));
});

test('SessionStart(compact): the whole print is capped at 12 KB across ledgers, and a ledger past it is dropped whole', () => {
  const g = guard();
  const proj = ledgerProject(g, 'total');
  const big = ['## Handoff', ...Array.from({ length: 39 }, (_, i) => `${'y'.repeat(99)}${i % 10}`)].join('\n');
  for (const name of ['ledger-a.md', 'ledger-b.md', 'ledger-c.md', 'ledger-d.md']) {
    writeFileSync(join(proj, '.omelette', name), big);
  }
  const r = fire(g.path, sessionStart({ cwd: proj }));
  assert.equal(r.code, 0, r.err);
  const size = Buffer.byteLength(r.out, 'utf8');
  assert.ok(size <= 12 * 1024 + 32, `12 KB total, got ${size}`);
  assert.ok(r.out.includes('--- ledger-a.md · last handoff ---'), r.out.slice(0, 200));
  assert.ok(r.out.includes('--- ledger-b.md · last handoff ---'), r.out.slice(0, 200));
  assert.equal(r.out.includes('ledger-d.md'), false, 'a ledger past the cap is dropped whole, never half-printed');
  assert.equal(r.out.split('\n').filter(Boolean).pop(), '[… truncated]');
});

test('SessionStart(compact): a ledger that is not a regular file is skipped — the symlink is never read', { skip: process.platform === 'win32' && 'POSIX symlinks' }, () => {
  const g = guard();
  const proj = ledgerProject(g, 'special-start');
  writeFileSync(join(proj, '.omelette', 'ledger-real.md'), '## Handoff\nreal: T4 next\n');
  // A symlink out of .omelette is how a read reaches somewhere else entirely.
  const outside = join(g.dir, 'outside-handoff.md');
  writeFileSync(outside, '## Handoff\nSECRET from outside .omelette\n');
  symlinkSync(outside, join(proj, '.omelette', 'ledger-link.md'));
  const r = fire(g.path, sessionStart({ cwd: proj }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '--- ledger-real.md · last handoff ---\n## Handoff\nreal: T4 next\n');
  assert.equal(r.out.includes('SECRET'), false, 'a symlinked ledger is skipped, not followed');
});

test('SessionStart(compact): no .omelette directory is silence, a clean exit, and nothing created', () => {
  const g = guard();
  const proj = join(g.dir, 'bare');
  mkdirSync(proj);
  const r = fire(g.path, sessionStart({ cwd: proj }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
  assert.equal(r.err, '');
  assert.deepEqual(readdirSync(proj), [], 'a missing ledger is not a reason to create one');
});

test('a `.omelette` that is a symlink is refused by BOTH events — nothing appended, nothing read, nothing printed',
  { skip: process.platform === 'win32' && 'POSIX symlinks' }, () => {
    const g = guard();
    const proj = join(g.dir, 'linked-dir');
    mkdirSync(proj);
    // The per-ledger lstat cannot see this one: the link is the DIRECTORY, and
    // every ledger inside it is a perfectly regular file somewhere else.
    const outside = join(g.dir, 'outside-omelette');
    mkdirSync(outside);
    const ledger = join(outside, 'ledger-x.md');
    writeFileSync(ledger, '## Handoff\nSECRET from outside the project\n');
    symlinkSync(outside, join(proj, '.omelette'));

    const pre = fire(g.path, { hook_event_name: 'PreCompact', trigger: 'auto', cwd: proj });
    assert.equal(pre.code, 0, pre.err);
    assert.equal(pre.out, '', 'a linked ledger directory is skipped whole — not even the handoff line');
    assert.equal(readFileSync(ledger, 'utf8'), '## Handoff\nSECRET from outside the project\n', 'never appended to');

    const start = fire(g.path, sessionStart({ cwd: proj }));
    assert.equal(start.code, 0, start.err);
    assert.equal(start.out, '', 'and never read into the next context');
    assert.equal(start.err, '');
  });

test('a cwd that cannot be read is exit 0 and silence, for both events', () => {
  const g = guard();
  // A regular file where a project directory should be: every path under it
  // fails with ENOTDIR, and none of that is worth an exit code or a word.
  const file = join(g.dir, 'not-a-directory');
  writeFileSync(file, 'a file where a project should be\n');
  for (const event of [{ hook_event_name: 'PreCompact', trigger: 'auto', cwd: file }, sessionStart({ cwd: file })]) {
    const r = fire(g.path, event);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, '', `${event.hook_event_name} printed: ${JSON.stringify(r.out)}`);
    assert.equal(r.err, '');
  }
});

test('SessionStart(compact): a ledger past 1 MiB is read from its TAIL, and the block says so', () => {
  const g = guard();
  const proj = ledgerProject(g, 'tail');
  // The handoff a reader needs is the LAST one, and on a long-running plan it
  // sits past the first megabyte — where a head-first read never finds it.
  const filler = Array.from({ length: 12000 }, (_, i) => `Ruling: filler ${i} — ${'x'.repeat(80)}`).join('\n');
  writeFileSync(join(proj, '.omelette', 'ledger-long.md'), [
    '## Handoff 2026-09-01T00:00Z',
    'STALE: the first handoff, a megabyte of ledger ago',
    filler,
    '## Handoff 2026-09-08T18:00Z',
    'Where it stands: T4 in review.',
    '',
  ].join('\n'));

  const r = fire(g.path, sessionStart({ cwd: proj }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [
    '--- ledger-long.md · last handoff ---',
    '[… ledger larger than 1 MiB — read from its tail; a fenced block cut by the read may hide or fake a heading]',
    '## Handoff 2026-09-08T18:00Z',
    'Where it stands: T4 in review.',
    '',
  ].join('\n'));
  assert.equal(r.out.includes('STALE'), false, 'the stale first block is behind the tail, and stays there');
});

test('PreToolUse: every shipped role is guarded, and the refusal names the agent it caught', () => {
  const g = guard();
  for (const agent of ['omelette-coder', 'omelette-tester', 'omelette-reviewer']) {
    for (const command of [
      'git commit -m "wip"',
      'git stash',
      'git push origin main',
      'git checkout -b feat/x',
      'git worktree add ../wt',
      'git tag v1.0.0',
      'git rebase main',
    ]) {
      const r = fire(g.path, preToolUse({ agent_type: agent, tool_input: { command } }));
      assert.equal(r.code, 2, `${agent}: ${command} should be blocked: ${r.out}${r.err}`);
      assert.equal(r.err.trim(), REFUSAL(agent), 'the refusal names the agent that was caught');
      assert.equal(r.out, '', 'a block says nothing on stdout');
    }
    // …and no role loses a read: the tester runs the suite and reads the diff
    // it was handed, the coder reads its own history, the reviewer reads the
    // change it judges. Containment is about what moves the tree, and nothing
    // here moves it.
    for (const command of ['git status', 'git diff HEAD', 'git log --oneline -3', 'git branch --list', 'npm test']) {
      const r = fire(g.path, preToolUse({ agent_type: agent, tool_input: { command } }));
      assert.equal(r.code, 0, `${agent}: ${command} should pass: ${r.out}${r.err}`);
      assert.equal(r.err, '');
    }
  }
});

test('PreToolUse: the guarded set is EXACT — the main thread is nobody, and a name that merely contains one is not one', () => {
  const g = guard();
  for (const agent_type of [
    undefined,               // the main thread carries no agent_type at all
    null, '', 42, { name: 'omelette-coder' },
    'omelette-coder-2', 'omelette-tester-2', 'my-omelette-coder', 'omelette',
    'omelette-reviewer-2', 'my-omelette-reviewer', 'reviewer',
    'OMELETTE-CODER',        // matched whole and case-sensitively, as Claude Code spells it
  ]) {
    const r = fire(g.path, preToolUse({ agent_type, tool_input: { command: 'git commit -m "x"' } }));
    assert.equal(r.code, 0, `agent_type ${JSON.stringify(agent_type)} is not guarded: ${r.out}${r.err}`);
    assert.equal(r.err, '', `agent_type ${JSON.stringify(agent_type)} printed to stderr`);
  }
});

/**
 * `git rebase` OPTION VALUES. Every expectation below was measured against a
 * real git (2.38.1) before it was written down, and the comment beside each
 * case says what git DOES with it — that, and not the shape of the word, is
 * what decides whether the guard may let it through.
 */
test('PreToolUse: a rebase option VALUE that reads like `--abort` is a value — git rebases, and the guard refuses', () => {
  const g = guard();
  for (const command of [
    // `--exec`/`-x` take the next word as a shell command to run after every
    // commit. git: "Rebasing (2/2) … Executing: --abort … error: cannot run
    // --abort", and the repository is left in `.git/rebase-merge`. That is a
    // rebase, whatever the word in the value position says.
    'git rebase --exec --abort main',
    'git rebase -x --abort main',
    // A short run is a cluster and only its LAST letter takes the next word:
    // `-qx --abort main` is `-q` plus `-x --abort` — measured, the same rebase.
    'git rebase -qx --abort main',
    // The attached form was already refused before 0.3.4 (the token is not the
    // bare `--abort`), and it stays refused: git runs the same rebase.
    'git rebase --exec=--abort main',
    // `--onto`, `-s`/`--strategy` and `-X`/`--strategy-option` each REQUIRE a
    // value too. git on `--onto --abort main`: "fatal: Does not point to a
    // valid commit '--abort'" — a rebase it tried to start; on `--strategy
    // --abort main` the rebase runs with a strategy called `--abort`.
    'git rebase --onto --abort main',
    'git rebase --strategy --abort main',
    'git rebase -s --abort main',
    'git rebase --strategy-option --abort main',
    'git rebase -X --abort main',
    // The three measured for 0.3.4 (git 2.38.1, see the git-driven test below):
    // each reads the next word as its own value and complains about the VALUE —
    // `fatal: Invalid whitespace option: '--abort'`, `fatal: unrecognized empty
    // type '--abort'`, ``fatal: switch `C' expects a numerical value`` — so not
    // one of them is the abort the word looks like.
    'git rebase --whitespace --abort main',
    'git rebase --empty --abort main',
    'git rebase -C --abort main',
    // After a bare `--` every token is a POSITIONAL: git reads `--abort` as the
    // upstream ("fatal: invalid upstream '--abort'"), which is a rebase it
    // tried to start rather than one it undid.
    'git rebase -- --abort',
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder'));
  }

  for (const command of [
    // The recovery forms keep passing — they are why the rule is a value SKIP
    // and not a blanket refusal of anything with an option in it.
    'git rebase --abort',
    'git rebase --quit',
    'git rebase --help',
    'git rebase -h',
    'git -C /x rebase --abort',
    // `-q` takes no value, so `--abort` is still an action word here. git
    // answers `git rebase -q --abort` with `usage: git rebase …` and exit 129 —
    // an action option must be the whole argument list — so nothing is written
    // either way, and the guard keeps the reading it has had since 0.3.2.
    'git rebase -q --abort',
    // …and the same for a bare `--abort` behind a quoted exec value: the quoted
    // word is the exec command, the bare one is an action, and git rejects the
    // combination with that same usage error rather than rebasing.
    "git rebase --exec 'echo --abort' --abort",
    // `-S`/`--gpg-sign` takes its key-id ATTACHED only (`-Skeyid`,
    // `--gpg-sign=keyid`), so the word behind it was never its value: 0.3.3 kept
    // them in the value set and cost the coder `git rebase -S -h`, a command
    // that prints usage and writes nothing. git answers all of these with
    // `usage: git rebase …` and exit 129 — an action option must be the WHOLE
    // argument list — so nothing is written either way.
    'git rebase -S -h',
    'git rebase -S --abort',
    'git rebase --gpg-sign --abort',
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

test('PreToolUse: a QUOTED rebase option still takes its value, and an abbreviation of one does too', () => {
  const g = guard();
  for (const command of [
    // The shell strips the quotes before git sees them, so a quoted option is
    // an option: `"--exec"` takes the next word exactly as the bare form does,
    // and the classifier's quote rule belongs to the ACTION words alone.
    'git rebase "--exec" --abort main',
    "git rebase '--onto' --abort main",
    'git rebase "-x" --abort main',
    // git accepts any unambiguous abbreviation of a long option, and the value
    // it takes is the same value: `--ex` is `--exec`. Anything three characters
    // and up that opens one of the value-taking options is read as that option
    // — over-blocking an abbreviation git itself would refuse as ambiguous
    // costs a command that does nothing anyway.
    'git rebase --ex --abort main',
    'git rebase --exe --abort main',
    'git rebase --ont --abort main',
    'git rebase --strat --abort main',
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder'));
  }

  for (const command of [
    // A long option that opens NO value-taking option keeps its old reading:
    // the action word behind it is an action word.
    'git rebase --verbose --abort',
    'git rebase --no-verify --abort',
    // …and a quoted ACTION word is still text rather than an action: quoting is
    // how `--exec 'echo --abort now'` says the word is data.
    "git rebase --exec 'echo --abort now' --quit",
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

test('PreToolUse: quoting that STARTS INSIDE a token is quoting too — the shell joins it and git sees one option', () => {
  const g = guard();
  for (const command of [
    // `--ex"ec"` reaches git as `--exec`, whose value is the next word: the
    // `--abort` behind it is that value and the rebase runs, exactly as the
    // bare and the fully quoted forms do. Reading the token as an unknown
    // option (it matches nothing with the quotes still in it) is what let the
    // `--abort` behind it read as the recovery flag until 0.3.4.
    'git rebase --ex"ec" --abort main',
    "git rebase --'exec' --abort main",
    'git rebase --exec"" --abort main',
    'git rebase --on"to" --abort main',
    // The same for a short option: `-"x"` is `-x`, which takes the next word.
    'git rebase -"x" --abort main',
    // …and for an abbreviation spelled with quoting in the middle of it.
    "git rebase --ex'e' --abort main",
    // An ACTION word that arrived with ANY quoting in it is text, wherever the
    // quoting starts: `--abort` is recovery only when it is typed as itself.
    // Over-blocking a `--ab"ort"` costs a recovery command spelled the hard way
    // — reading one as recovery would cost a rebase that ran.
    'git rebase "--abort"',
    'git rebase --ab"ort"',
    "git rebase --qu'it'",
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder'));
  }

  for (const command of [
    // The plainly spelled recovery forms are untouched by any of it.
    'git rebase --abort',
    'git rebase -q --abort',
    // …and a quoted VALUE still hides the action word inside it: the quoted
    // token is the exec command and the bare `--abort` behind it is the action,
    // which git answers with `usage: git rebase …` rather than a rebase.
    "git rebase --exec 'echo --abort' --abort",
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

test('PreToolUse: `-S` takes its key-id ATTACHED, so the rest of the cluster is that key and never a value skip', () => {
  const g = guard();
  for (const command of [
    // git's parse-options gives an optional attached argument the WHOLE rest of
    // the token, so `-SABC` is `--gpg-sign=ABC` and the `C` inside `ABC` is a
    // letter of the key, not the `-C` that takes a value. `-h` behind it is the
    // action: git prints usage and writes nothing.
    'git rebase -SABC -h',
    'git rebase -SABC --abort',
    // …and a value-taking letter BEHIND the `S` is part of the key too.
    'git rebase -Sx --abort',
    // `-qS` ends at the `S` the same way; git answers the pair with `usage: git
    // rebase …` and exit 129 — an action option must be the whole argument
    // list — so nothing is written either way.
    'git rebase -qS --abort',
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }

  for (const command of [
    // A cluster that reaches a real value-taking letter still swallows the word
    // behind it: `-C` wants a numerical value and reads `--abort` as one.
    'git rebase -C --abort main',
    'git rebase -qC --abort main',
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder'));
  }
});

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/** A throwaway repository where `feature` and `main` have each moved on by one commit. */
function gitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'omelette-git-rebase-'));
  const run = (...args) => spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: repo,
      GIT_CONFIG_GLOBAL: join(repo, 'no-gitconfig'),
      GIT_CONFIG_SYSTEM: join(repo, 'no-gitconfig'),
      GIT_AUTHOR_NAME: 'x',
      GIT_AUTHOR_EMAIL: 'x@x',
      GIT_COMMITTER_NAME: 'x',
      GIT_COMMITTER_EMAIL: 'x@x',
    },
  });
  assert.equal(run('init', '-q', '-b', 'main').status, 0);
  assert.equal(run('commit', '-q', '--allow-empty', '-m', 'init').status, 0);
  assert.equal(run('checkout', '-q', '-b', 'feature').status, 0);
  assert.equal(run('commit', '-q', '--allow-empty', '-m', 'f1').status, 0);
  assert.equal(run('checkout', '-q', 'main').status, 0);
  assert.equal(run('commit', '-q', '--allow-empty', '-m', 'm1').status, 0);
  assert.equal(run('checkout', '-q', 'feature').status, 0);
  return { repo, run };
}

test('git itself: `--exec --abort` REBASES and `-q --abort` aborts nothing — the two readings the classifier encodes',
  { skip: !gitAvailable && 'git is not installed' }, () => {
    const { repo, run } = gitRepo();
    // The word in the value position is the exec command, and the rebase starts:
    // it replays the commit, fails to run `--abort` as a program, and stops with
    // the repository in a rebase state. A failure here is git disagreeing with
    // the classifier, not a typo in the test.
    const rebased = run('rebase', '--exec', '--abort', 'main');
    assert.match(`${rebased.stdout}${rebased.stderr}`, /--abort/);
    assert.ok(
      existsSync(join(repo, '.git', 'rebase-merge')) || existsSync(join(repo, '.git', 'rebase-apply')),
      `a rebase should be in progress: ${rebased.stdout}${rebased.stderr}`,
    );
    assert.equal(run('rebase', '--abort').status, 0, 'and the real --abort undoes it');

    // …while an action option is only an action when it is the whole argument
    // list: `-q --abort` is a usage error, not an abort.
    const quiet = run('rebase', '-q', '--abort');
    assert.equal(quiet.status, 129, `${quiet.stdout}${quiet.stderr}`);
    assert.match(`${quiet.stdout}${quiet.stderr}`, /usage: git rebase/);
  });

test('git itself: `--whitespace`, `--empty` and `-C` swallow the word behind them — measured, not assumed',
  { skip: !gitAvailable && 'git is not installed' }, () => {
    // The three options 0.3.4 added to the value set, each pinned against the
    // git on this machine: what makes them values is that git complains about
    // the VALUE `--abort` rather than aborting anything. Measured on 2.38.1:
    //   --whitespace --abort main  → fatal: Invalid whitespace option: '--abort'
    //   --empty --abort main       → fatal: unrecognized empty type '--abort'
    //   -C --abort main            → fatal: switch `C' expects a numerical value
    // None of them starts a rebase and none of them undoes one, so a coder that
    // ran one would be running a rebase whose value happened to be malformed.
    for (const [option, complaint] of [
      ['--whitespace', /whitespace option: '?--abort/],
      ['--empty', /empty type '?--abort/],
      ['-C', /expects a numerical value|--abort/],
    ]) {
      const { repo, run } = gitRepo();
      const head = run('rev-parse', 'HEAD').stdout.trim();
      const r = run('rebase', option, '--abort', 'main');
      const output = `${r.stdout}${r.stderr}`;
      assert.notEqual(r.status, 0, `git rebase ${option} --abort main should fail: ${output}`);
      assert.match(output, complaint, `git rebase ${option} --abort main: ${output}`);
      assert.equal(
        existsSync(join(repo, '.git', 'rebase-merge')) || existsSync(join(repo, '.git', 'rebase-apply')),
        false,
        `git rebase ${option} --abort main should not leave a rebase in progress: ${output}`,
      );
      assert.equal(run('rev-parse', 'HEAD').stdout.trim(), head, 'and it moves nothing — the value was refused');
    }
  });

test('PreToolUse: `git tag --sort` swallows the flag behind it — the listing passes, a name behind it is still a creation', () => {
  const g = guard();
  // `--sort` takes a value, so the token behind it is that value and selects no
  // listing mode. Measured on git 2.38.1:
  //   git tag --sort --list      → `fatal: unknown field name: -list`; no tag
  //                                written, nothing listed. There is no name in
  //                                the command to create, so the guard passes it.
  //   git tag --list --sort v1   → `--list` selects the listing and `v1` is the
  //                                sort key: `fatal: unknown field name: v1`,
  //                                nothing written. Order is what decides.
  for (const command of ['git tag --sort --list', 'git tag --list --sort v1', 'git tag --sort=-v:refname']) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
  // …and with a NAME behind the swallowed flag the command has the SHAPE of a
  // creation, which is what the guard classifies. On git 2.38.1 the bad sort key
  // is rejected before anything is written, so that version creates nothing
  // either — but strike the `--sort` and `git tag --list v1` lists while `git
  // tag v1` creates, and which of those the operator meant is not the guard's
  // to guess. It refuses, as it has since 0.3.3.
  for (const command of ['git tag --sort --list v1', 'git tag --sort refname v1']) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder'));
  }
});

// ── 1.3.0 P2: the medium coder is the coder, contained the same way ─────────

test('PreToolUse: omelette-coder-medium is guarded like the coder, and the refusal names it', () => {
  const g = guard();
  for (const command of [
    'git commit -m "wip"',
    'git stash',
    'git branch feat/x',
    'git checkout -b feat/x',
    'git switch -c feat/x',
    'git worktree add ../wt',
  ]) {
    const r = fire(g.path, preToolUse({ agent_type: 'omelette-coder-medium', tool_input: { command } }));
    assert.equal(r.code, 2, `omelette-coder-medium: ${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder-medium'), 'the refusal names the medium coder, not the coder');
    assert.equal(r.out, '', 'a block says nothing on stdout');
  }
  // …and it keeps every read the coder keeps.
  for (const command of ['git status', 'git diff HEAD', 'git log --oneline -3', 'git branch --list', 'npm test']) {
    const r = fire(g.path, preToolUse({ agent_type: 'omelette-coder-medium', tool_input: { command } }));
    assert.equal(r.code, 0, `omelette-coder-medium: ${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

test('PreToolUse: omelette-coder-medium is matched WHOLE — a name around it, or a private coder variant, is somebody else\'s agent', () => {
  const g = guard();
  for (const agent_type of [
    'omelette-coder-medium-2', 'my-omelette-coder-medium', 'omelette-coder-mediu', 'omelette-coder-medium ',
    'OMELETTE-CODER-MEDIUM', 'omelette-coder-high', 'omelette-coder-xhigh',
    // the 0.3.4 look-alikes, unchanged by a longer name in the set
    'omelette-coder-2', 'omelette-tester-2', 'my-omelette-coder', 'omelette',
  ]) {
    const r = fire(g.path, preToolUse({ agent_type, tool_input: { command: 'git commit -m "x"' } }));
    assert.equal(r.code, 0, `agent_type ${JSON.stringify(agent_type)} is not guarded: ${r.out}${r.err}`);
    assert.equal(r.err, '', `agent_type ${JSON.stringify(agent_type)} printed to stderr`);
  }
});

/*
 * 1.3.0 P0 Task 4, review round 2: two writes the base guard refused and the
 * first token-level classifier let through.
 */
test('PreToolUse: a global long option git takes without a value never swallows the subcommand behind it', () => {
  const g = guard();
  for (const command of [
    // `--no-pager` takes no value, so `checkout` is the subcommand and `tag/v1`
    // the branch it creates — not a `tag` listing that happens to come last.
    'git --no-pager checkout -b tag/v1',
    'git --no-pager switch -c tag/fix',
    'git --no-optional-locks branch tag',
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder'));
  }
  const r = fire(g.path, preToolUse({ tool_input: { command: 'git --no-pager tag -l' } }));
  assert.equal(r.code, 0, `git --no-pager tag -l should pass: ${r.out}${r.err}`);
  assert.equal(r.err, '');
});

test('PreToolUse: adjacent quoted pieces are ONE shell word — a split-quoted `sh -c` script is read whole', () => {
  const g = guard();
  for (const command of [
    // The shell joins `'git tag '` and `"v1"` into the one word `git tag v1`,
    // which is the script `sh -c` runs; read piece by piece it looked like a listing.
    `sh -c 'git tag '"v1"`,
    `BR=x; bash -c 'git branch '"$BR"`,
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder'));
  }
  const r = fire(g.path, preToolUse({ tool_input: { command: `sh -c 'git tag '"-l"` } }));
  assert.equal(r.code, 0, `sh -c 'git tag '"-l" should pass: ${r.out}${r.err}`);
  assert.equal(r.err, '');
});

/*
 * 1.3.0 P0 Task 4, review round 2's one open finding: a history write, or a
 * write by argument, hidden inside nested quoting is still refused at every
 * depth — the quoted word is re-read as a command of its own — while a
 * listing nested the same way still passes, so the depth bound (QUOTE_DEPTH)
 * is not a blanket refusal of quotes.
 */
test('PreToolUse: a git write inside nested quoting is refused at every depth; a nested listing still passes', () => {
  const g = guard();
  // Real nesting: each level wraps the previous command in `sh -c "…"` with the
  // inner quotes and backslashes escaped, the way a shell script would.
  const wrap = (s) => `sh -c "${s.replace(/(["\\])/g, '\\$1')}"`;
  const nest = (s, n) => { let out = s; for (let i = 0; i < n; i++) out = wrap(out); return out; };
  for (const base of ['git push', 'git commit -m x', 'git tag v1', 'git checkout -b x', 'git branch x']) {
    for (const depth of [1, 3, 6]) {
      const command = base === 'git push' && depth === 1 ? `sh -c "bash -c 'git push'"` : nest(base, depth);
      const r = fire(g.path, preToolUse({ tool_input: { command } }));
      assert.equal(r.code, 2, `${base} at depth ${depth} should be blocked: ${r.out}${r.err}`);
    }
  }
  for (const base of ['git tag -l', 'echo hi']) {
    for (const depth of [1, 3, 6]) {
      // Since the 1.8.0 release fix `\"` inside double quotes is read as the shell
      // reads it, so every `sh -c` here is a real level: a listing six deep is past
      // QUOTE_DEPTH and refused unread, as any text naming git past the last level is.
      const code = base === 'git tag -l' && depth === 6 ? 2 : 0;
      const r = fire(g.path, preToolUse({ tool_input: { command: nest(base, depth) } }));
      assert.equal(r.code, code, `${base} at depth ${depth} should exit ${code}: ${r.out}${r.err}`);
      if (code === 0) assert.equal(r.err, '');
    }
  }
});

/*
 * 1.3.0 release fix round: two writes the 1.2.0 guard refused and the token
 * classifier let through.
 */
test('PreToolUse: a command substitution is ONE word of the command around it, and what it runs is read as a command of its own', () => {
  const g = guard();
  for (const command of [
    // The substitution is the start point; `-b new` belongs to the checkout,
    // not to the `tag` listing inside the substitution.
    'git checkout $(git tag -l v1) -b new',
    'git switch $(git tag -l v1) -c new',
    'git checkout `git tag -l v1` -b new',
    'git switch `git tag -l v1` -c new',
    // The substitution is `-C`'s value, and `commit` is the subcommand.
    'git -C $(git rev-parse --show-toplevel) commit -m x',
    'git -C $(mktemp -d) commit -m x',
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder'));
  }
  for (const command of ['git tag -l $(git rev-parse HEAD)', 'echo $(git tag -l)']) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

test('PreToolUse: a tag, branch, checkout or switch fed its arguments by xargs is a write — the names never appear in the command', () => {
  const g = guard();
  for (const command of ['xargs git tag < names.txt', 'xargs git branch < names.txt']) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder'));
  }
  // Without xargs, a redirection still adds nothing: these list.
  for (const command of ['git tag > tags.txt', 'git tag 2>/dev/null']) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

/*
 * 1.3.0 release re-review, round 3: a process substitution in a redirection's
 * target, and the git writes that move HEAD or a ref with nothing left in the
 * tree for `git status --porcelain` to see.
 */
test('PreToolUse: a process substitution is read as a command of its own wherever it sits — a redirection\'s target included', () => {
  const g = guard();
  for (const command of [
    'echo x > >(git commit -m y)',
    'cat < <(git commit -m x)',
    'make &> >(git push)',
    'exec > >(git tag v1)',
    'while read l; do :; done < <(git commit -m x)',
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder'));
  }
  for (const command of ['diff <(git tag -l) <(git branch -l)', 'cat <(git log -1)']) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

test('PreToolUse: a reset that rewrites the tree, update-ref and a writing symbolic-ref are refused for every guarded role; the index resets and the reads pass', () => {
  const g = guard();
  for (const agent of ['omelette-coder', 'omelette-coder-medium', 'omelette-tester', 'omelette-reviewer']) {
    for (const command of [
      // Each moves HEAD or a ref, and `git status --porcelain` reads clean after it.
      'git reset --hard HEAD~1',
      'git reset --merge x',
      'git reset --keep x',
      'git reset -q --hard',
      'git update-ref refs/heads/main HEAD~1',
      'git update-ref -d refs/heads/x',
      'git symbolic-ref HEAD refs/heads/x',
      'git symbolic-ref -m reason HEAD refs/heads/x',
      'git symbolic-ref -d HEAD',
    ]) {
      const r = fire(g.path, preToolUse({ agent_type: agent, tool_input: { command } }));
      assert.equal(r.code, 2, `${agent}: ${command} should be blocked: ${r.out}${r.err}`);
      assert.equal(r.err.trim(), REFUSAL(agent), 'the refusal names the agent that was caught');
    }
    for (const command of [
      'git reset',
      'git reset --soft',
      'git reset HEAD -- file',
      'git reset --mixed',
      // A path called `--hard` behind a bare `--` is a path.
      'git reset -- --hard',
      'git symbolic-ref --short HEAD',
      'git symbolic-ref HEAD',
    ]) {
      const r = fire(g.path, preToolUse({ agent_type: agent, tool_input: { command } }));
      assert.equal(r.code, 0, `${agent}: ${command} should pass: ${r.out}${r.err}`);
      assert.equal(r.err, '');
    }
  }
});

test('PreToolUse: a `(` right behind any redirection operator opens a process substitution — zsh runs what is inside it', () => {
  const g = guard();
  for (const command of [
    // zsh reads each as a redirection into a process substitution and runs the
    // command inside; the operator must not swallow the `(` behind it.
    'echo x >>(git commit -m y)',
    'echo x 2>>(git push)',
    'cat <<(git push)',
    'echo x &>>(git push)',
    'echo x >|(git commit -m y)',
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder'));
  }
  // An ordinary target, a heredoc marker and an appending listing stay what they are.
  for (const command of ['echo x >> out.txt', 'cat << EOF', 'git tag >> tags.txt']) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

test('PreToolUse: a heredoc body is text — only its unquoted substitutions run, and the command line after the operator is still read', () => {
  const g = guard();
  for (const [command, code] of [
    ['cat > a.mjs <<\'EOF\'\nconst x = "git commit";\nEOF\n', 0],
    ['cat > a.mjs <<EOF\nconst x = "git commit";\nEOF\n', 0],
    ['cat > a.mjs <<EOF\n$(git commit -m x)\nEOF\n', 2],
    ['cat > a.mjs <<\'EOF\'\n$(git commit -m x)\nEOF\n', 0],
    ['cat <<EOF\n`git push`\nEOF\n', 2],
    // `<<-` strips leading tabs, so the tab-indented terminator ends the body.
    ['cat <<-EOF\n\tgit commit\n\tEOF\n', 0],
    // A line that only starts with the word is body, not the end.
    ['cat <<EOF\nEOF text\ngit commit\nEOF\n', 0],
    // A body that never terminates runs to the end of the command.
    ['cat <<EOF\ngit commit\n', 0],
    // Two heredocs on one line: their bodies follow in order.
    ['cat <<A <<B\ngit commit\nA\ngit push\nB\n', 0],
    // What follows the operator on its own line is a command line.
    ['cat <<EOF; git commit\nbody\nEOF\n', 2],
    // A `((`, `${` or subscript is opaque to `<<`, never to what its substitutions run.
    ['(( $(git commit -m x) ))', 2],
    ['echo ${x:-$(git push)}', 2],
    ['a[$(git push)]=x', 2],
    // `((` that does not close with `))` is two subshells, and a blank ends a subscript.
    ['((git commit -m x); echo y)', 2],
    ['echo a[ ; git commit -m x ]', 2],
    // An unquoted body joins a line ending in an odd run of backslashes to the
    // next one: `EO\` + `F` is the terminator. A quoted body joins nothing.
    ['cat <<EOF\nfoo\nEO\\\nF\ngit commit -m x\n', 2],
    ['cat <<\'EOF\'\nfoo\nEO\\\nF\ngit commit -m x\n', 0],
    ['cat <<EOF\nfoo\\\\\nEOF\ngit commit\n', 2],
    ['cat <<EOF\n$(git \\\npush)\nEOF\n', 2],
  ]) {
    const r = fire(g.path, preToolUse({ agent_type: 'omelette-coder', tool_name: 'Bash', tool_input: { command } }));
    assert.equal(r.code, code, `${JSON.stringify(command)} should exit ${code}: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), code === 2 ? REFUSAL('omelette-coder') : '');
  }
});

test('PreToolUse: quoted git word — quotes hide neither the git word nor the subcommand', () => {
  const g = guard();
  for (const [command, code] of [
    ['"git" commit -m x', 2],
    ['git "commit" -m x', 2],
    ["g'it' commit -m x", 2],
    ['git co"mm"it -m x', 2],
    // One quoted word: its span is re-read as a command.
    ["'git commit'", 2],
    // A quoted action flag is data, so this rebase writes.
    ['git rebase "--abort"', 2],
    // A `git` word anywhere starts an invocation; `sh -c 'git commit'` depends on it.
    ['echo "git commit"', 2],
    ['echo git commit', 2],
    // A quoted global option is stepped over like the bare one.
    ['git "-C" /x commit', 2],
    ['git "-c" a=b commit', 2],
    ['git "--no-pager" commit', 2],
    ['git "-C" "/x" push', 2],
    ['git "-p" commit', 2],
    // A valued option takes the next word as its value whatever it opens with.
    ['git -c "-C" commit', 2],
    ['git -C "-foo" commit', 2],
    ['git -C "-a b" commit', 2],
    ['git --git-dir "--x y" commit', 2],
    ['git -c "-x=1" commit', 2],
    ['git -C "-" commit', 2],
    ['git -C -foo commit', 2],
    ['git -C - commit', 2],
    ['git -C "-foo" log', 0],
    ['git -c -C log', 0],
    ['git "-C" /x log', 0],
    ['git "--git-dir" /x status', 0],
  ]) {
    const r = fire(g.path, preToolUse({ agent_type: 'omelette-reviewer', tool_name: 'Bash', tool_input: { command } }));
    assert.equal(r.code, code, `${JSON.stringify(command)} should exit ${code}: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), code === 2 ? REFUSAL('omelette-reviewer') : '');
  }
});

test('PreToolUse: brackets that spend the scan budget are refused whole, fast, as too deep to read', () => {
  const g = guard();
  // `$[` unclosed, over and over (until the 1.8.0 release fix `a[`, when any word's `[` opened a scan).
  const spend = '$['.repeat(100000);
  for (const command of [
    spend, // no git word at all: the refusal is for the depth, not for git
    `${spend}; x=\${y:-1<<2}\ngit commit -m x\n`,
    `${'${'.repeat(100000)}; git commit -m x`,
    `${'(( '.repeat(60000)}; git commit -m x`,
  ]) {
    const started = Date.now();
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    const ms = Date.now() - started;
    const name = `${command.slice(0, 6)}…${command.slice(-30)}`;
    assert.equal(r.code, 2, `${name} should be blocked: ${r.out}${r.err}`);
    assert.match(r.err, /^omelette-coder: command too deep to read/, name);
    assert.ok(ms < 2000, `${name} took ${ms} ms`);
  }
  // Closed regions scan only to their close: hundreds of them never spend it.
  const command = `echo ${'${x:-a} b[1] '.repeat(300)}`;
  const r = fire(g.path, preToolUse({ tool_input: { command } }));
  assert.equal(r.code, 0, `closed regions should pass: ${r.out}${r.err}`);
  assert.equal(r.err, '');
});

/**
 * A project holding every kind of curated file: a ledger of about 3 KB, the
 * backlog, and a register redirected by its first line to docs/DECISIONS.md.
 */
function curatedProject() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-curated-'));
  mkdirSync(join(dir, '.omelette'));
  mkdirSync(join(dir, 'docs'));
  const ledger = `# ledger x\n${'- 2026-11-03 one line of the ledger\n'.repeat(85)}`;
  writeFileSync(join(dir, '.omelette', 'ledger-x.md'), ledger);
  writeFileSync(join(dir, '.omelette', 'backlog.md'), '# backlog\n');
  writeFileSync(join(dir, '.omelette', 'decisions.md'), 'register: docs/DECISIONS.md\n');
  writeFileSync(join(dir, 'docs', 'DECISIONS.md'), '# decisions\n');
  return { dir, ledger };
}

const BASH_CURATED = (file) => `${file} is appended to, never rewritten; to replace it on purpose, move it first`;
const WRITE_CURATED = (file) => `${file} is appended to, never rewritten: Edit for an in-place change (the harness checks it has not moved since your read), append otherwise; to replace it on purpose, move it first`;

/** The main thread (no agent_type), a guarded role and a role nobody guards: the curated rule holds for all three. */
const EVERY_AGENT = [undefined, 'omelette-coder', 'general-purpose'];

test('curated: a truncating Bash write to a curated file is refused for every agent, the main thread included; appends and reads pass', () => {
  const g = guard();
  const { dir } = curatedProject();
  for (const [command, code, file] of [
    ['cat > .omelette/ledger-x.md', 2, '.omelette/ledger-x.md'],
    ['echo x >> .omelette/ledger-x.md', 0],
    ['tee .omelette/backlog.md', 2, '.omelette/backlog.md'],
    ['tee -a .omelette/backlog.md', 0],
    ["sed -i '' s/a/b/ docs/DECISIONS.md", 2, 'docs/DECISIONS.md'],
    ['sed -i.bak s/a/b/ docs/DECISIONS.md', 2, 'docs/DECISIONS.md'], // GNU: the suffix attached
    ['sed --in-place s/a/b/ docs/DECISIONS.md', 2, 'docs/DECISIONS.md'],
    ['perl -pi -e s/a/b/ docs/DECISIONS.md', 2, 'docs/DECISIONS.md'], // a cluster holding `i`
    ['perl -ne print docs/DECISIONS.md', 0],
    ['sort -o .omelette/backlog.md .omelette/backlog.md', 2, '.omelette/backlog.md'],
    ['mv x .omelette/backlog.md', 2, '.omelette/backlog.md'],
    ['cp x docs/DECISIONS.md', 2, 'docs/DECISIONS.md'],
    ['git mv .omelette/backlog.md y', 0],
    ['rm .omelette/decisions.md', 2, '.omelette/decisions.md'],
    [': > ./.omelette/ledger-x.md', 2, '.omelette/ledger-x.md'],
    // An expansion the guard does not perform is not a known path.
    ['cat > "$PWD/.omelette/ledger-x.md"', 0],
    [`cat > ${dir}/.omelette/ledger-x.md`, 2, '.omelette/ledger-x.md'],
    // After a `cd` the file is named as written; since the 1.8.0 release fix (G9) the
    // path is resolved against where the `cd` went, the bare name only where it cannot be.
    ['cd .omelette && cat > ledger-x.md', 2, 'ledger-x.md'],
    ['cat > .omelette/notes.md', 0],
    ['cat > .omelette/ledger-x.md.bak', 0],
  ]) {
    for (const agent of EVERY_AGENT) {
      const r = fire(g.path, preToolUse({ agent_type: agent, cwd: dir, tool_input: { command } }), dir);
      assert.equal(r.code, code, `${command} (${agent || 'main thread'}) should exit ${code}: ${r.out}${r.err}`);
      assert.equal(r.err.trim(), code === 2 ? BASH_CURATED(file) : '', `${command} (${agent || 'main thread'})`);
    }
  }
});

test('curated: a Write to a curated file is an append or it is refused — a new file passes, a re-encoded one does not, a symlink never', () => {
  const g = guard();
  const { dir, ledger } = curatedProject();
  const outside = join(mkdtempSync(join(tmpdir(), 'omelette-outside-')), 'target.md');
  writeFileSync(outside, 'outside\n');
  symlinkSync(outside, join(dir, '.omelette', 'ledger-l.md'));
  const ledgerPath = join(dir, '.omelette', 'ledger-x.md');
  for (const [filePath, content, code, file] of [
    [ledgerPath, `${ledger}\n- new line`, 0],
    [ledgerPath, ledger.slice(0, ledger.length / 2), 2, '.omelette/ledger-x.md'],
    // Review Focus 3: the file re-encoded is not an append, whatever it adds.
    [ledgerPath, `${ledger.replace(/\n/g, '\r\n')}- new line\n`, 2, '.omelette/ledger-x.md'],
    [ledgerPath, `${ledger.slice(0, -1)} and more\n`, 2, '.omelette/ledger-x.md'],
    [join(dir, '.omelette', 'ledger-new.md'), '# a new ledger\n', 0],
    [join(dir, '.omelette', 'ledger-l.md'), 'outside\nmore\n', 2, '.omelette/ledger-l.md'],
  ]) {
    for (const agent of EVERY_AGENT) {
      const event = preToolUse({ agent_type: agent, cwd: dir, tool_name: 'Write', tool_input: { file_path: filePath, content } });
      const r = fire(g.path, event, dir);
      assert.equal(r.code, code, `Write ${filePath} (${agent || 'main thread'}) should exit ${code}: ${r.out}${r.err}`);
      assert.equal(r.err.trim(), code === 2 ? WRITE_CURATED(file) : '');
    }
  }
  assert.equal(readFileSync(outside, 'utf8'), 'outside\n', 'the guard only answers; it writes nothing');
});

test('curated: without core/ledger.mjs the register redirect is unknown — .omelette/decisions.md alone is curated, and one stderr line says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3', undefined, join(dir, 'no-package-here')));
  const { dir: proj } = curatedProject();
  const fallback = fire(path, preToolUse({ agent_type: undefined, cwd: proj, tool_input: { command: 'cp x docs/DECISIONS.md' } }), proj);
  assert.equal(fallback.code, 0, fallback.err);
  assert.equal(fallback.err.trim().split('\n').length, 1, fallback.err);
  assert.match(fallback.err, /cannot load .*ledger\.mjs/);
  const own = fire(path, preToolUse({ agent_type: undefined, cwd: proj, tool_input: { command: 'rm .omelette/decisions.md' } }), proj);
  assert.equal(own.code, 2, own.err);
  assert.ok(own.err.includes(BASH_CURATED('.omelette/decisions.md')), own.err);
});

/** One guard run with its own environment: HOME decides `~` and where the fleet home is. */
function fireIn(path, input, cwd, env) {
  const r = spawnSync(process.execPath, [path], { input: JSON.stringify(input), encoding: 'utf8', cwd, env, timeout: 20000 });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('curated (round 2): a `cd` counts at command position only, and only a project holding .omelette/ makes a bare name curated', () => {
  const g = guard();
  const { dir } = curatedProject();
  const bare = mkdtempSync(join(tmpdir(), 'omelette-no-ledger-'));
  for (const [cwd, command, code, file] of [
    [dir, 'echo cd; echo y > backlog.md', 0],
    [dir, 'grep -n cd notes.md > backlog.md', 0],
    // Review Focus 1's accepted false refusal until the 1.8.0 release fix (G9): `cd x` is followed, to x/backlog.md.
    [dir, 'cd x && make && echo y > backlog.md', 0],
    [dir, 'pushd .omelette && tee backlog.md', 2, 'backlog.md'],
    [bare, 'cd x && make && echo y > backlog.md', 0],
    [bare, 'cd docs && echo y > decisions.md', 0],
  ]) {
    for (const agent of EVERY_AGENT) {
      const r = fire(g.path, preToolUse({ agent_type: agent, cwd, tool_input: { command } }), cwd);
      assert.equal(r.code, code, `${command} in ${cwd === bare ? 'a project without .omelette' : 'the project'} (${agent || 'main thread'}): ${r.err}`);
      assert.equal(r.err.trim(), code === 2 ? BASH_CURATED(file) : '');
    }
  }
});

test('curated (round 2): from a subdirectory the project is the nearest directory holding .omelette/ — never the fleet home', () => {
  const g = guard();
  const { dir, ledger } = curatedProject();
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  for (const [command, code, file] of [
    ['cat > ../.omelette/backlog.md', 2, '.omelette/backlog.md'],
    ['cat > ../docs/DECISIONS.md', 2, 'docs/DECISIONS.md'],
    ['cat > .omelette/backlog.md', 0], // sub/.omelette is not the project's
  ]) {
    const r = fire(g.path, preToolUse({ agent_type: undefined, cwd: sub, tool_input: { command } }), sub);
    assert.equal(r.code, code, `${command} from sub/: ${r.err}`);
    assert.equal(r.err.trim(), code === 2 ? BASH_CURATED(file) : '');
  }
  const ledgerPath = join(dir, '.omelette', 'ledger-x.md');
  const write = (content) => fire(g.path, preToolUse({ agent_type: undefined, cwd: sub, tool_name: 'Write', tool_input: { file_path: ledgerPath, content } }), sub);
  assert.equal(write('x').code, 2);
  assert.equal(write('x').err.trim(), WRITE_CURATED('.omelette/ledger-x.md'));
  assert.equal(write(`${ledger}- more\n`).code, 0);

  // `~/.omelette` is the fleet home, not a project: a project under the home
  // directory without a .omelette of its own is rooted at itself.
  const home = mkdtempSync(join(tmpdir(), 'omelette-home-'));
  mkdirSync(join(home, '.omelette'));
  writeFileSync(join(home, '.omelette', 'backlog.md'), '# not a project\n');
  const proj = join(home, 'proj');
  mkdirSync(proj);
  const env = { PATH: process.env.PATH, HOME: home };
  for (const command of ['cd x && echo y > backlog.md', 'cat > ../.omelette/backlog.md']) {
    const r = fireIn(g.path, preToolUse({ agent_type: undefined, cwd: proj, tool_input: { command } }), proj, env);
    assert.equal(r.code, 0, `${command} under a home holding the fleet home: ${r.err}`);
  }
});

test('curated (round 2): a command too deep to read is refused for every agent, the main thread included — nothing past the budget is read', () => {
  const g = guard();
  const { dir } = curatedProject();
  const command = `${'$['.repeat(100000)}; cat > .omelette/backlog.md`; // `a[` until the 1.8.0 release fix
  for (const [agent, name] of [[undefined, 'main thread'], ['general-purpose', 'general-purpose'], ['omelette-coder', 'omelette-coder']]) {
    const r = fire(g.path, preToolUse({ agent_type: agent, cwd: dir, tool_input: { command } }), dir);
    assert.equal(r.code, 2, `${name}: ${r.err}`);
    assert.equal(r.err.trim(), `${name}: command too deep to read (over 1 MiB of bracket scanning) — split it, or write the file with Write`);
  }
});

test('curated (round 2): a wrapper\'s options and their values are stepped over on the way to the command', () => {
  const g = guard();
  const { dir } = curatedProject();
  for (const command of [
    'sudo -u root tee .omelette/backlog.md', 'sudo -E -u root -- tee .omelette/backlog.md', 'sudo --user root tee .omelette/backlog.md',
    'nice -n 10 tee .omelette/backlog.md', 'nice -10 tee .omelette/backlog.md', 'env -u FOO X=1 tee .omelette/backlog.md',
    'command -p tee .omelette/backlog.md', 'sudo -g staff nice -n 5 tee .omelette/backlog.md',
  ]) {
    for (const agent of EVERY_AGENT) {
      const r = fire(g.path, preToolUse({ agent_type: agent, cwd: dir, tool_input: { command } }), dir);
      assert.equal(r.code, 2, `${command} (${agent || 'main thread'}): ${r.err}`);
      assert.equal(r.err.trim(), BASH_CURATED('.omelette/backlog.md'));
    }
  }
});

test('curated (round 2): `~/` is the home directory, quoted or not; `~user/` is not a known path', () => {
  const g = guard();
  const home = mkdtempSync(join(tmpdir(), 'omelette-home-'));
  const proj = join(home, 'proj');
  mkdirSync(join(proj, '.omelette'), { recursive: true });
  writeFileSync(join(proj, '.omelette', 'backlog.md'), '# backlog\n');
  const env = { PATH: process.env.PATH, HOME: home };
  for (const [command, code] of [
    ['cat > ~/proj/.omelette/backlog.md', 2],
    ['cat > "~/proj/.omelette/backlog.md"', 2],
    ['tee ~/proj/.omelette/backlog.md', 2],
    ['cat > ~someone/proj/.omelette/backlog.md', 0],
  ]) {
    const r = fireIn(g.path, preToolUse({ agent_type: undefined, cwd: proj, tool_input: { command } }), proj, env);
    assert.equal(r.code, code, `${command}: ${r.err}`);
    assert.equal(r.err.trim(), code === 2 ? BASH_CURATED('.omelette/backlog.md') : '');
  }
});

test('curated (round 2): an absent target passes for Bash as it does for Write — nothing is truncated — and refuses once it exists', () => {
  const g = guard();
  const { dir } = curatedProject();
  const run = (command) => fire(g.path, preToolUse({ agent_type: undefined, cwd: dir, tool_input: { command } }), dir);
  const rows = [
    ['cat > .omelette/ledger-new.md', '.omelette/ledger-new.md'],
    ['cd .omelette && cat > ledger-new.md', 'ledger-new.md'],
    ['mv x .omelette/ledger-new.md', '.omelette/ledger-new.md'],
  ];
  for (const [command] of rows) assert.equal(run(command).code, 0, `${command} with no such file: ${run(command).err}`);
  writeFileSync(join(dir, '.omelette', 'ledger-new.md'), '# new\n');
  for (const [command, file] of rows) {
    const r = run(command);
    assert.equal(r.code, 2, `${command} once the file exists: ${r.err}`);
    assert.equal(r.err.trim(), BASH_CURATED(file));
  }
  // A symlink at a curated name is there, whatever it points to; a glob is never known to be absent.
  symlinkSync(join(dir, 'nowhere.md'), join(dir, '.omelette', 'ledger-d.md'));
  assert.equal(run('cat > .omelette/ledger-d.md').code, 2);
  assert.equal(run('rm .omelette/ledger-*.md').code, 2);
});

// bashWrites cannot be imported (the template opens on `{{marker}}`) and a file
// named `1` is never curated, so the touched record is where a redirection
// target shows: one SubagentStop over a transcript of the rows.
test('redirection targets (1.8.0 round 3): `>&1` before a `)` duplicates a descriptor and writes no file `1`; `>&file` still writes', () => {
  const g = guard();
  const root = mkdtempSync(join(tmpdir(), 'omelette-fd-dup-'));
  const proj = join(root, 'proj');
  mkdirSync(join(proj, '.omelette'), { recursive: true });
  const projects = join(root, 'home', '.claude', 'projects', '-p', 's');
  mkdirSync(projects, { recursive: true });
  const transcript = join(projects, 'agent-fd.jsonl');
  const bash = (id, command) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  writeFileSync(transcript, `${[
    bash('d1', 'ls 2>&1)'),
    bash('d2', '(ls > a 2>&1)'),
    bash('d3', '(time node --test x > ../full.tap 2>&1) 2>&1 | tail -3'),
    bash('d4', 'echo x >&-)'),
    bash('d5', 'echo x >&backlog.md'),
  ].join('\n')}\n`);
  const r = fireIn(g.path, { hook_event_name: 'SubagentStop', agent_type: 'omelette-coder', agent_id: 'fd000000', agent_transcript_path: transcript, cwd: proj }, proj, { PATH: process.env.PATH, HOME: join(root, 'home') });
  assert.equal(r.code, 0, r.err);
  const record = readFileSync(join(proj, '.omelette', 'reports', 'touched-omelette-coder-fd000000.md'), 'utf8');
  assert.deepEqual(record.split('\n').filter((l) => l.startsWith('- ')), [
    '- a (bash write)', `- ${join(root, 'full.tap')} (bash write)`, '- backlog.md (bash write)',
  ], record);
});

const FENCE ='omelette-reviewer writes nothing but .omelette/reports/<name>-review.md';

/** A project holding .omelette/reports/, and a directory outside it. */
function fenceProject() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fence-'));
  mkdirSync(join(dir, '.omelette', 'reports'), { recursive: true });
  const outside = mkdtempSync(join(tmpdir(), 'omelette-fence-outside-'));
  return { dir, outside };
}

/** One reviewer (or other agent) edit tool call, its path under the field the tool names it by. */
function fenceFire(g, cwd, { tool = 'Write', path, agent = 'omelette-reviewer' }) {
  const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  const tool_input = path === undefined ? { content: 'x' } : { [field]: path, content: 'x' };
  return fire(g.path, preToolUse({ agent_type: agent, cwd, tool_name: tool, tool_input }), cwd);
}

test('fence: the reviewer writes .omelette/reports/<name>-review.md and nothing else', () => {
  const g = guard();
  const { dir } = fenceProject();
  for (const [tool, rel, code] of [
    ['Write', '.omelette/reports/x-review.md', 0],
    ['Write', '.omelette/reports/x.md', 2],
    ['Write', '.omelette/reports/sub/x-review.md', 2], // one level only
    ['Write', '.omelette/x-review.md', 2],
    ['Write', '../other/.omelette/reports/x-review.md', 2],
    ['Edit', '.omelette/reports/x-review.md', 0],
    ['Edit', '.omelette/reports/x.md', 2],
    ['NotebookEdit', '.omelette/reports/x-review.md', 0],
    ['NotebookEdit', '.omelette/reports/x.ipynb', 2],
  ]) {
    const r = fenceFire(g, dir, { tool, path: `${dir}/${rel}` });
    assert.equal(r.code, code, `${tool} ${rel}: ${r.err}`);
    assert.equal(r.err.trim(), code === 2 ? FENCE : '');
  }
  const none = fenceFire(g, dir, { path: undefined });
  assert.equal(none.code, 2, 'a Write with no file_path is refused');
  assert.equal(none.err.trim(), FENCE);
  const coder = fenceFire(g, dir, { path: `${dir}/.omelette/reports/x.md`, agent: 'omelette-coder' });
  assert.equal(coder.code, 0, `the fence is the reviewer's alone: ${coder.err}`);
});

test('fence: a symlinked reports directory or report file out of the project is refused', () => {
  const g = guard();
  const { dir, outside } = fenceProject();
  const linkedDir = mkdtempSync(join(tmpdir(), 'omelette-fence-'));
  mkdirSync(join(linkedDir, '.omelette'));
  symlinkSync(outside, join(linkedDir, '.omelette', 'reports'));
  const viaDir = fenceFire(g, linkedDir, { path: `${linkedDir}/.omelette/reports/link-review.md` });
  assert.equal(viaDir.code, 2, viaDir.err);
  assert.equal(viaDir.err.trim(), FENCE);
  writeFileSync(join(outside, 'target.md'), 'outside\n');
  symlinkSync(join(outside, 'target.md'), join(dir, '.omelette', 'reports', 'x-review.md'));
  const viaFile = fenceFire(g, dir, { path: `${dir}/.omelette/reports/x-review.md` });
  assert.equal(viaFile.code, 2, viaFile.err);
  assert.equal(viaFile.err.trim(), FENCE);
  // A dangling link is there too: existsSync misses it, and the Write would follow it out.
  symlinkSync(join(outside, 'nowhere.md'), join(dir, '.omelette', 'reports', 'd-review.md'));
  const dangling = fenceFire(g, dir, { path: `${dir}/.omelette/reports/d-review.md` });
  assert.equal(dangling.code, 2, dangling.err);
  assert.equal(dangling.err.trim(), FENCE);
});

test('fence: a dangling reports/ link, or a .omelette/ linked out of the project, anchors nothing', () => {
  const g = guard();
  const { dir, outside } = fenceProject();
  // reports/ a dangling link: the Write would land wherever it points once that exists.
  const dangling = mkdtempSync(join(tmpdir(), 'omelette-fence-'));
  mkdirSync(join(dangling, '.omelette'));
  symlinkSync(join(outside, 'later'), join(dangling, '.omelette', 'reports'));
  const viaDangling = fenceFire(g, dangling, { path: `${dangling}/.omelette/reports/x-review.md` });
  assert.equal(viaDangling.code, 2, viaDangling.err);
  assert.equal(viaDangling.err.trim(), FENCE);
  // .omelette/ itself a link out: the fence is anchored on the project, not on where the link goes.
  const linked = mkdtempSync(join(tmpdir(), 'omelette-fence-'));
  mkdirSync(join(outside, 'reports'));
  symlinkSync(outside, join(linked, '.omelette'));
  for (const path of [`${linked}/.omelette/reports/x-review.md`, `${outside}/reports/x-review.md`]) {
    const r = fenceFire(g, linked, { path });
    assert.equal(r.code, 2, `${path}: ${r.err}`);
    assert.equal(r.err.trim(), FENCE);
  }
  const plain = fenceFire(g, dir, { path: `${dir}/.omelette/reports/x-review.md` });
  assert.equal(plain.code, 0, `a real .omelette/ is unchanged: ${plain.err}`);
});

test('fence: a case alias of .omelette passes only where the volume resolves it to the on-disk directory', () => {
  const g = guard();
  const { dir } = fenceProject();
  const caseInsensitive = existsSync(join(dir, '.OMELETTE'));
  const r = fenceFire(g, dir, { path: `${dir}/.OMELETTE/reports/x-review.md` });
  assert.equal(r.code, caseInsensitive ? 0 : 2, `case-${caseInsensitive ? 'insensitive' : 'sensitive'} volume: ${r.err}`);
});

test('fence: the first report, before reports/ exists, is allowed — the Write tool creates the directory', () => {
  const g = guard();
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fence-'));
  mkdirSync(join(dir, '.omelette'));
  const r = fenceFire(g, dir, { path: `${dir}/.omelette/reports/x-review.md` });
  assert.equal(r.code, 0, r.err);
});

test('fence: a project reached through a symlinked path writes its report, before and after reports/ exists', () => {
  const g = guard();
  const real = mkdtempSync(join(tmpdir(), 'omelette-fence-'));
  mkdirSync(join(real, '.omelette'));
  const via = join(mkdtempSync(join(tmpdir(), 'omelette-fence-via-')), 'proj');
  symlinkSync(real, via);
  const first = fenceFire(g, via, { path: `${via}/.omelette/reports/x-review.md` });
  assert.equal(first.code, 0, `no reports/ yet: ${first.err}`);
  mkdirSync(join(real, '.omelette', 'reports'));
  const later = fenceFire(g, via, { path: `${via}/.omelette/reports/x-review.md` });
  assert.equal(later.code, 0, `reports/ present: ${later.err}`);
});

test('PreToolUse: heredoc (1b) — a continued operator line, a `#` delimiter and `$\'…\'` delimiters end where bash ends them', () => {
  const g = guard();
  for (const [command, code] of [
    // A backslash-newline joins the operator's line: the body starts after the joined line.
    ['cat <<EOF \\\n; git commit -m x\nbody\nEOF\n', 2],
    ['echo a \\\nb', 0],
    ['cat <<\'EOF\' \\\n; git push\nbody\nEOF\n', 2],
    // An escaped backslash before the newline is no continuation.
    ['echo a\\\\\ngit commit -m x', 2],
    // Comments are read where the heredocs are known: a `#` terminator ends its body,
    // and an apostrophe in a body leaves a later comment a comment.
    ['cat <<\'#\'\nbody\n#\ngit commit -m x\n', 2],
    ['cat <<EOF\nit\'s\nEOF\necho x # git commit\n', 0],
    ['# git commit', 0],
    ['echo x #git commit', 0],
    ['echo "x#y" ; git commit', 2],
    // `$'EOF'` and `$"EOF"` are the quoted word `EOF`.
    ['cat <<$\'EOF\'\nbody\nEOF\ngit commit -m x\n', 2],
    ['cat <<$"EOF"\nbody\nEOF\ngit commit -m x\n', 2],
    ['cat <<$\'EOF\'\n$(git push)\nEOF\n', 0],
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, code, `${JSON.stringify(command)} should exit ${code}: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), code === 2 ? REFUSAL('omelette-coder') : '');
  }
});

// The 1b tester's two defects (session fix): a CRLF terminator is bash's word, and a
// continued body is joined once, not sliced per piece. Since the 1.8.0 release fix
// the CRLF rule is EXACT (guard review G4): the `\r` is part of the delimiter word
// and the terminator line is compared raw, as both shells do — the 3e89dda strip
// closed an LF operator's body at `EOF\r`, where a later `<<X` then hid the lines the
// shell runs. Each row's comment is what bash 3.2.57 and zsh 5.9 did with a
// logging fake `git` first on PATH.
test('PreToolUse: heredoc (1b) — a CRLF terminator ends its body exactly where the shells end it, and a long continued body is read in linear time', () => {
  const g = guard();
  for (const [command, code] of [
    ['cat <<EOF\r\nx\r\nEOF\r\ngit commit -m x\r\n', 2], //          both: the word is `EOF\r`, `EOF\r` ends the body, git runs
    ['cat <<EOF\r\ngit commit -m x\r\nEOF\r\n', 0], //               both: git is body
    ['cat <<-EOF\r\n\tx\r\n\tEOF\r\ngit commit -m x\r\n', 2], //     both: git runs
    ['cat <<EOF\na\\\nb\\\nc\nEOF\ngit commit -m x\n', 2], //        both: git runs
    ['cat <<EOF\nEOF\r\ngit commit -m x\n', 0], //                   both: `EOF\r` is body under an LF operator, nothing runs
    ['cat <<EOF\nEOF\r\ngit commit -m x\nEOF\n', 0], //              both: the body ends at `EOF`, git is body
    ['cat <<EOF\r\nEOF\ngit commit -m y\nEOF\r\n', 0], //            both: `EOF` is body under a CRLF operator
    ['cat <<EOF\nEOF\r\n: <<X\nEOF\ngit commit -m y\nX\n', 2], //    both: the body ends at `EOF`, git runs (the guard review's row)
    ['cat <<EOF\r\nEOF\n: <<X\nEOF\r\ngit commit -m y\nX\n', 2], //  both: the body ends at `EOF\r`, git runs (the guard review's row)
    ['cat <<EOF\\\r\nEOF\r\ngit commit -m y\nEOF\n', 2], //          both: `\` quotes the `\r`, the word is `EOF\r`, git runs
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, code, `${JSON.stringify(command)} should exit ${code}: ${r.out}${r.err}`);
  }
  const started = Date.now();
  const r = fire(g.path, preToolUse({ tool_input: { command: `cat <<EOF\n${'x\\\n'.repeat(600_000)}y\nEOF\ngit commit -m x\n` } }));
  assert.equal(r.code, 2);
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms for a 1.2 MB continued body (was 17.9 s)`);
});

/*
 * 1.8.0 release review fix round — the guard review's G1–G4, G8, G9 and the
 * branch review's F4, F6, F8. Every heredoc and quoting row was run through
 * /bin/bash 3.2.57 and /bin/zsh 5.9 with a fake `git` first on PATH that logs
 * its argv (and, for the main thread's rows, a project whose backlog was then
 * read back); each row's comment is what the two shells did. The rule for the
 * heredoc class: the guard skips a body only where both shells agree on where
 * it starts and ends, and from a `<<` it cannot place it skips nothing.
 */
function releaseRows(rows) {
  const g = guard();
  const { dir } = curatedProject();
  for (const [command, code, agent = 'omelette-coder'] of rows) {
    const r = fire(g.path, preToolUse({ agent_type: agent ?? undefined, cwd: dir, tool_input: { command } }), dir);
    assert.equal(r.code, code, `${JSON.stringify(command)} (${agent ?? 'main thread'}) should exit ${code}: ${r.out}${r.err}`);
    if (code === 0) assert.equal(r.err, '', JSON.stringify(command));
  }
}
const MAIN = null;

test('release review (1.8.0): a `<<` the shells do not read as a heredoc hides no line — an escape, `$[…]`, a comment after `)`, arithmetic, a subscript', () => {
  releaseRows([
    ['echo \\<<EOF\ngit commit -m x\n', 2], //                 both: `\<` is a literal, `<EOF` an input file; git runs
    ['cat \\<<EOF\ngit commit -m x\nEOF\n', 2], //             both: git runs
    ['echo \\<<EOF\nhello\n', 0], //                           both: nothing runs
    ['echo $[ 1 << 2 ]\ngit commit -m x\n', 2], //             both: `$[…]` is arithmetic; git runs
    ['(echo a)#c <<X\ngit commit -m x\nX\n', 2], //            both: `#c <<X` is a comment after `)`; git runs
    ['((1))#c <<X\ngit commit -m x\nX\n', 2], //               both: a comment after `((…))`; git runs
    ['x[ 1 << 2 ]=3\ngit commit -m y\n', 2], //                bash: a subscript, git runs; zsh: bad pattern, stops
    ['!((1<<2))\ngit commit -m y\n', 2], //                    bash: `!` then arithmetic, git runs; zsh: parse error, nothing runs
    ['(\\\n(1<<2))\ngit commit -m y\n', 2], //                 bash: the continuation joins `((`, git runs; zsh: git does not run
    ['a[<<EOF]\ngit commit -m x\nEOF]\n', 2], //               bash: `a[<<EOF]` is one word at command position, git runs; zsh: bad pattern `a[`, stops
    ['echo a[<<EOF]\ngit commit -m x\nEOF]\n', 0], //          bash: a heredoc whose word is `EOF]`, git is body; zsh: bad pattern, stops
    ['echo a[<<EOF]\n: <<X\nEOF]\ngit commit -m y\nX\n', 2], // bash: the body ends at `EOF]`, git runs; zsh: stops
    ['cat <\\\n<EOF\n: <<X\nEOF\ngit commit -m y\nX\n', 2], //  bash: the continuation joins `<<EOF`, git runs; zsh: parse error
    ['echo x # <<EOF\necho x > .omelette/backlog.md', 2, MAIN], // both: a comment, then the backlog truncated
    ['cat \\<<EOF\n: > .omelette/backlog.md\nEOF\n', 2, MAIN], //  both: the backlog left empty
  ]);
});

test('release review (1.8.0): a delimiter the guard cannot read as both shells do skips no body, from there on; `$\'…\'` decodes its simple escapes', () => {
  releaseRows([
    ['cat <<$(x)\ngit commit -m x\n', 2], //                   both: body to the end, nothing runs — refused, the guard cannot place it
    ['cat <<$(x)\n$(x)\ngit commit -m y\n$\n', 2], //          both: the body ends at `$(x)`, git runs
    ['cat <<$(x)\n: <<Y\n$(x)\ngit commit -m z\nY\n', 2], //   both: the body ends at `$(x)`, git runs — the later `<<Y` hides nothing
    ['cat <<${x:- }\n${x:- }\ngit commit -m y\n${x:-\n', 2], // bash: the body ends at `${x:- }`, git runs; zsh: no git
    ['cat <<`x`\n`x`\ngit commit -m y\n', 2], //               both: the body ends at `` `x` ``, git runs
    ['cat <<$"EOF"\n$EOF\ngit commit -m x\nEOF\n', 2], //      bash: body to `EOF`, no git; zsh: the body ends at `$EOF`, git runs
    ["cat <<$'E\\x4fF'\nEOF\ngit commit -m y\nE\\x4fF\n", 2], // both: `\x4f` is `O`, the body ends at `EOF`, git runs
    ["cat <<$'E\\tF'\nE\tF\ngit commit -m y\n", 2], //         both: git runs
    ["cat <<$'E\\'F'\nE'F\ngit commit -m y\n", 2], //          both: git runs
    ["cat <<$'E\\117F'\nEOF\ngit commit -m y\nE\\117F\n", 2], // both: octal `\117` is `O`, git runs — an escape outside the simple ones skips nothing
    ["cat <<$'EOF'\ngit commit -m x\nEOF\n", 0], //            both: git is body
    ['cat <<E\\"F\ngit commit -m y\nE"F\n', 0], //             both: the word is `E"F`, git is body
  ]);
});

test('release review (1.8.0): an escape, an ANSI-C quote and `\\"` inside double quotes end a word where the shells end it', () => {
  releaseRows([
    ["printf $'it\\'s' > .omelette/backlog.md", 2, MAIN], //  both: the backlog is `it's`
    ["echo $'a\\'b'; git commit -m x", 2], //                   both: git runs
    ["echo $'a\\nb'", 0], //                                    both: nothing runs
    ['echo \\> .omelette/backlog.md', 0, MAIN], //              both: `>` is a literal, the backlog untouched
    ['printf "\\"" > .omelette/backlog.md; echo "x"', 2, MAIN], // both: the backlog is `"`
    ["git $'commit' -m y", 2], //                               both: git commit
    ["git $'push'", 2], //                                      both: git push
    ["git $'tag' v9", 2], //                                    both: git tag v9
    ["git checkout $'-b' x", 2], //                             both: git checkout -b x
    ['git $"commit" -m y', 2], //                               bash: git commit; zsh: git `$commit`
    ["echo x > $'.omelette/backlog.md'", 2, MAIN], //           both: the backlog is `x`
    ["echo $'x'", 0],
  ]);
});

test('release review (1.8.0): the subcommand is the whole word — a file named after one is no commit', () => {
  releaseRows([
    ['grep -c "git" commit.mjs', 0],
    ['grep -c git commit.mjs', 0],
    ['grep -n "use git" commit.txt', 0],
    ['git commit.mjs', 0], //                 git: not a git command
    ['"git" commit -m x', 2],
    ['git "-C" /x commit', 2],
    ['env git commit', 2],
    ['x=1 git commit', 2],
    ['(git commit -m y)', 2], //              both: the subshell's `)` is no part of the subcommand
    ['git commit$x -m y', 2], //              both: an expansion may be empty — git commit runs
  ]);
});

test('release review (1.8.0): zsh\'s clobber `>!` and `&>!`, and `&>|`, truncate like `>|`', () => {
  releaseRows([
    ['echo x >! .omelette/backlog.md', 2, MAIN], //  zsh: the backlog is `x` (bash writes a file named `!`)
    ['echo x &>! .omelette/backlog.md', 2, MAIN], // zsh: the backlog is `x`
    ['echo x &>| .omelette/backlog.md', 2, MAIN], // zsh: the backlog is `x`
    ['echo x >> .omelette/backlog.md', 0, MAIN],
  ]);
});

test('release review (1.8.0): after a `cd` the guard can follow, a relative name is resolved — against the directory it went to and the one it left', () => {
  const g = guard();
  const { dir } = curatedProject();
  for (const [command, code, file] of [
    ['cd /tmp && echo x > backlog.md', 0],
    ['cd /tmp && echo x > ledger-x.md', 0],
    ['cd "$d" && echo x > backlog.md', 2, 'backlog.md'], //      a target it cannot follow: the bare name decides, as before
    ['cd - && echo x > backlog.md', 2, 'backlog.md'],
    ['cd .omelette && echo x > backlog.md', 2, 'backlog.md'], // resolved to the curated file
    ['cd docs && cd ../.omelette && tee ledger-x.md', 2, 'ledger-x.md'], // a chain, each step resolved
    ['(cd /tmp) && echo x > .omelette/backlog.md', 2, 'backlog.md'], // the cd ran in a subshell: the write is the project's
    ['cd /tmp; cat > docs/DECISIONS.md', 2, 'DECISIONS.md'], //  a cd that failed leaves the shell where it was
  ]) {
    const r = fire(g.path, preToolUse({ agent_type: undefined, cwd: dir, tool_input: { command } }), dir);
    assert.equal(r.code, code, `${command}: ${r.err}`);
    assert.equal(r.err.trim(), code === 2 ? BASH_CURATED(file) : '', command);
  }
});

test('release review (1.8.0): the reviewer\'s first report in a project with no .omelette/ yet is written; a .omelette that is a link still is not', { skip: process.platform === 'win32' && 'POSIX symlinks' }, () => {
  const g = guard();
  const bare = mkdtempSync(join(tmpdir(), 'omelette-fence-bare-'));
  const first = fenceFire(g, bare, { path: `${bare}/.omelette/reports/x-review.md` });
  assert.equal(first.code, 0, first.err);
  for (const path of [`${bare}/.omelette/x-review.md`, `${bare}/.omelette/reports/sub/x-review.md`, `${bare}/reports/x-review.md`, `${bare}/.omelette/reports/x.md`]) {
    const r = fenceFire(g, bare, { path });
    assert.equal(r.code, 2, `${path}: ${r.err}`);
    assert.equal(r.err.trim(), FENCE);
  }
  const linked = mkdtempSync(join(tmpdir(), 'omelette-fence-'));
  symlinkSync(mkdtempSync(join(tmpdir(), 'omelette-fence-outside-')), join(linked, '.omelette'));
  const viaLink = fenceFire(g, linked, { path: `${linked}/.omelette/reports/x-review.md` });
  assert.equal(viaLink.code, 2, viaLink.err);
  assert.equal(viaLink.err.trim(), FENCE);
});

/*
 * 1.8.0 release fix, round 2 — the three defects the tester found with the shell
 * oracle (test/hooks-heredoc-release.test.mjs). Each row's comment is what
 * /bin/bash 3.2.57 and /bin/zsh 5.9 did with the logging fake `git` first on PATH,
 * in an environment without LANG (bash 3.2 then keeps `\u` as written).
 */
test('release review (1.8.0, round 2): a subcommand written with a brace is read by prefix, its braces off; a plain word is still exact', () => {
  releaseRows([
    ['git commit{,} -m y', 2], //     both: git commit commit -m y
    ['git tag{,x} v1', 2], //         both: git tag tagx v1
    ['git push{,}', 2], //            both: git push push
    ['git reset{,} --hard', 2], //    both: git reset reset --hard
    ['git checkout{,} -b zzz', 2], // both: git checkout checkout -b zzz
    ['git {commit,} -m y', 2], //     both: git commit -m y
    ['git comm{it,} -m y', 2], //     both: git commit comm -m y
    ['git log{,}', 0], //             both: git log log
    ['git {log,show}', 0], //         both: git log show
    ['grep -c git commit.mjs', 0],
  ]);
});

test('release review (1.8.0, round 2): every ANSI-C escape is decoded in a word, the reading that can name something where the shells part', () => {
  releaseRows([
    ["git $'comm\\151t' -m y", 2], //          both: git commit (octal)
    ["git $'comm\\x69t' -m y", 2], //          both: git commit
    ["git $'comm\\u0069t' -m y", 2], //        zsh: git commit; bash 3.2 keeps \u0069
    ["git $'comm\\U00000069t' -m y", 2], //    zsh: git commit; bash keeps \U00000069
    ["git $'comm\\it' -m y", 2], //            zsh: git commit (drops the backslash); bash: comm\it
    ["git $'\\commit' -m y", 2], //            zsh: git commit; bash: \co is a control character
    ["git $'commit\\xg' -m y", 2], //          zsh: a NUL, git commit; bash: commit\xg
    ["git $'commit\\0' -m y", 2], //           both: git commit (the NUL ends the string)
    ["git $'commit'", 2], //                   both: git commit
    ["echo $'a\\tb'", 0],
    ["echo $'\\a\\b\\e\\E\\f\\r\\v\\?'", 0],
    ["echo x > $'\\056omelette/backlog.md'", 2, MAIN], //   both: the backlog is x
    ["echo x > $'.omelette/back\\log.md'", 2, MAIN], //     zsh: the backlog is x; bash writes back\log.md
  ]);
});

test('release review (1.8.0, round 2): a `$\'…\'` delimiter is read only where both shells make the same ASCII of it', () => {
  releaseRows([
    ["cat <<$'E\\117F'\nEOF\ngit commit -m y\nE\\117F\n", 2], // both: octal \117 is O, the body ends at EOF, git runs
    ["cat <<$'E\\117F'\ngit commit -m y\nEOF\n", 0], //           both: git is body
    ["cat <<$'A\\vB'\ngit commit -m y\nA\vB\n", 0], //           both: git is body
    ["cat <<$'E\\u004fF'\nEOF\ngit commit -m y\n", 2], //        zsh: the body ends at EOF, git runs; bash: no git
    ["cat <<$'E\\qF'\nEqF\ngit commit -m y\n", 2], //            zsh: the body ends at EqF, git runs; bash: no git
  ]);
});

test('release review (1.8.0, round 2): a long `a[a[a[…` word is read in linear time; the budget rows are unchanged', () => {
  const g = guard();
  const started = Date.now();
  // One scan, from the first `[` (a name at command position), and under the 1 MiB budget: no git word, exit 0.
  const r = fire(g.path, preToolUse({ tool_input: { command: 'a['.repeat(500000) } }));
  const ms = Date.now() - started;
  assert.equal(r.code, 0, r.err);
  assert.ok(ms < 2500, `1 MB of a[ took ${ms} ms`);
});

/*
 * 1.8.0 release fix, round 3 — the re-reviews' findings, each verified by firing.
 */
test('release review (1.8.0, round 3): a `#` glued to an array assignment\'s `)` opens no comment, and a heredoc after it skips nothing', () => {
  releaseRows([
    ['a=(1 2)#x; git commit -m y', 2], //            bash: `#x` is part of the word, git runs; zsh: a comment
    ['a+=(1 2)#x; git commit -m y', 2], //           bash: git runs; zsh: a comment
    ['a=("x)" 2)#x; git commit -m y', 2], //         bash: the quoted `)` closes nothing, git runs; zsh: a comment
    ['a=(1 2)#x <<X\ngit commit -m x\nX\n', 2], //   bash: a heredoc, git is body; zsh: a comment, git runs — unplaceable
    ['(echo a)#c <<X\ngit commit -m x\n', 2], //     both: a comment after the subshell's `)`, git runs
    ['a=(1 2) #x; git commit -m y', 0], //           both: a comment
  ]);
});

test('release review (1.8.0, round 3): a `cd` chain is followed in one linear pass — 256 KB of `cd a && ` in under 2.5 s', () => {
  const g = guard();
  const { dir } = curatedProject();
  const chain = 'cd a && '.repeat(32 * 1024);
  // Past CD_PATH_MAX the directory is unknown, so the bare name is compared: backlog.md is curated, out.txt is not.
  for (const [command, code] of [[`${chain}echo x > backlog.md`, 2], [`${chain}echo x > out.txt`, 0]]) {
    const started = Date.now();
    const r = fire(g.path, preToolUse({ agent_type: undefined, cwd: dir, tool_input: { command } }), dir);
    const ms = Date.now() - started;
    assert.equal(r.code, code, r.err);
    assert.equal(r.err.trim(), code === 2 ? BASH_CURATED('backlog.md') : '');
    assert.ok(ms < 2500, `256 KB of cd a && took ${ms} ms`);
  }
});
