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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, HOOK_MARKER, parseHookMarker, renderHookFile } from '../core/rules.mjs';

const REFUSAL = 'omelette-coder never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead';

/** The guard exactly as `rules --hooks` writes it, in a throwaway directory. */
function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3'));
  return { dir, path };
}

/** One hook invocation: the event on stdin, the answer as code/stdout/stderr. */
function fire(path, input, cwd) {
  const r = spawnSync(process.execPath, [path], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', cwd, timeout: 20000,
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
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
    assert.equal(r.err.trim(), REFUSAL);
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
    // the same command from anything that is not the coder
    preToolUse({ agent_type: 'omelette-tester' }),
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
    'git tag --column always',
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
    assert.equal(r.err.trim(), REFUSAL);
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
      /^\n## Compaction \d{4}-\d{2}-\d{2}T[\d:.]+Z \(trigger: manual\) — re-read this ledger before continuing\n$/,
    );
  }
  assert.equal(readFileSync(join(proj, '.omelette', 'notes.md'), 'utf8'), 'untouched\n');
  assert.equal(readFileSync(join(proj, '.omelette', 'ledger-old.txt'), 'utf8'), 'untouched\n');
});

test('PreCompact: no .omelette directory at all is still a clean exit with the handoff line', () => {
  const g = guard();
  const proj = join(g.dir, 'empty');
  mkdirSync(proj);
  const r = fire(g.path, { hook_event_name: 'PreCompact', trigger: 'auto', cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^HANDOFF: /);
  assert.deepEqual(readdirSync(proj), [], 'a missing ledger is not a reason to create one');
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

test('stdin over the 1 MiB cap is treated as malformed: the guard stops reading and exits 0', async () => {
  const g = guard();
  // The event WOULD block if it were read: the forbidden command is the first
  // thing in it, and the 2 MiB of padding comes after. Exit 0 is the cap.
  const oversized = JSON.stringify(preToolUse({
    tool_input: { command: 'git push origin main' }, padding: 'x'.repeat(2 * 1024 * 1024),
  }));
  const r = await fireOpenStdin(g.path, { write: oversized });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.equal(r.signal, null);
  assert.equal(r.err, '', 'a capped read is silent, not a refusal');
  assert.ok(r.ms < 15000, `the guard should give up at once, took ${r.ms}ms`);
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
    // the classifier each walk the command once and none of them re-reads it.
    `git tag${' --contains x'.repeat(800)}`,
    `echo ${'x'.repeat(5000)} # ${'a comment '.repeat(500)}`,
  ]) {
    const started = Date.now();
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    const ms = Date.now() - started;
    assert.equal(r.code, 0, `${command.slice(0, 40)}… should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
    assert.ok(ms < 2000, `the option run tiled instead of scanning: ${ms}ms for ${command.length} characters`);
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
    // after it are not level-2 headings at all.
    '### Handoff notes',
    '##Handoff',
    'nothing here is a handoff block',
  ].join('\n'));
  const r = fire(g.path, sessionStart({ cwd: proj }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '', 'nothing to print is printed as nothing — no header, no blank line');
  assert.equal(r.err, '');
});

test('SessionStart: only `compact` prints — a startup, a resume, a clear and a fork lost no context', () => {
  const g = guard();
  const proj = ledgerProject(g, 'sources');
  writeFileSync(join(proj, '.omelette', 'ledger-x.md'), '## Handoff\nnext action: run npm test\n');
  for (const source of ['startup', 'resume', 'clear', 'fork', '', 'Compact', 42, undefined]) {
    const r = fire(g.path, sessionStart({ source, cwd: proj }));
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, '', `source ${JSON.stringify(source)} must print nothing`);
    assert.equal(r.err, '');
  }
  const compacted = fire(g.path, sessionStart({ cwd: proj }));
  assert.equal(compacted.out, '--- ledger-x.md · last handoff ---\n## Handoff\nnext action: run npm test\n');
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
