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
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, HOOK_MARKER, parseHookMarker, renderHookFile } from '../core/rules.mjs';

const REFUSAL = 'omelette-coder never commits, pushes, stashes, branches or opens worktrees; report instead';

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
