/**
 * omelette-fleet :: test/tester-1.3.0-p2-task1.test.mjs
 *
 * Independent coverage for 1.3.0 P2 task 1 — "the guard learns the names":
 * `omelette-coder-medium` joins GUARDED_AGENTS and is contained exactly as
 * `omelette-coder` is, matched WHOLE, refused by name.
 *
 * Driven the same way the implementer's suite drives the guard — a CHILD
 * PROCESS with the PreToolUse event as JSON on stdin, because the contract is
 * stdin in, exit code + stderr out — but this file imports nothing from
 * test/hooks.test.mjs: it renders its own guard and defines its own harness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

/** The refusal the guard prints, for any role it caught. */
const REFUSAL = (agent) => `${agent} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`;

/** The guard exactly as `rules --hooks` writes it, in a throwaway directory. */
function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-p2t1-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3'));
  return { dir, path };
}

/** One hook invocation: the event on stdin, the answer as code/stdout/stderr. */
function fire(path, input) {
  const r = spawnSync(process.execPath, [path], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const preToolUse = (over = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: 'omelette-coder-medium',
  tool_input: { command: 'git commit -m "x"' }, ...over,
});

// One representative of each write class the spec names for the guard bullet:
// commit, stash, branch creation (three spellings), worktree, plus push and
// tag — the two the task brief calls out by name alongside the four the spec
// bullet enumerates.
const WRITE_COMMANDS = [
  'git commit -m "x"',
  'git stash',
  'git checkout -b x',
  'git switch -c x',
  'git branch x',
  'git worktree add ../x',
  'git push',
  'git tag x',
];

const READ_COMMANDS = ['git status', 'git diff', 'git log -1'];

test('PreToolUse: omelette-coder-medium is refused on every guarded git write, named in the refusal', () => {
  const g = guard();
  for (const command of WRITE_COMMANDS) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-coder-medium'), `the refusal for ${command} names omelette-coder-medium`);
    assert.equal(r.out, '', 'a block says nothing on stdout');
  }
});

test('PreToolUse: omelette-coder-medium keeps every read', () => {
  const g = guard();
  for (const command of READ_COMMANDS) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

test('PreToolUse: the refusal for omelette-coder-medium is the coder\'s refusal, modulo the role name', () => {
  const g = guard();
  const coder = fire(g.path, preToolUse({ agent_type: 'omelette-coder', tool_input: { command: 'git commit -m "x"' } }));
  const medium = fire(g.path, preToolUse({ agent_type: 'omelette-coder-medium', tool_input: { command: 'git commit -m "x"' } }));
  assert.equal(coder.code, 2);
  assert.equal(medium.code, 2);
  assert.equal(coder.err.trim(), REFUSAL('omelette-coder'));
  assert.equal(medium.err.trim(), REFUSAL('omelette-coder-medium'));
  // Same sentence beyond the leading role name.
  const coderTail = coder.err.trim().slice('omelette-coder'.length);
  const mediumTail = medium.err.trim().slice('omelette-coder-medium'.length);
  assert.equal(mediumTail, coderTail, 'the refusal text is identical once the role name is stripped');
});

test('PreToolUse: the name is matched WHOLE — a look-alike agent_type passes git commit', () => {
  const g = guard();
  for (const agent_type of [
    'omelette-coder-medium-2',   // a prefix match is somebody else's agent
    'omelette-coder-mediumx',    // no separator — a different, unguarded name
    'my-omelette-coder-medium',  // the name embedded, not matched at the start
    'omelette-coder-high',       // a sibling bucket, unguarded on its own
    'Omelette-Coder-Medium',     // case-sensitive, as Claude Code spells the name
    'omelette-coder-medium ',    // trailing space — not the exact string
  ]) {
    const r = fire(g.path, preToolUse({ agent_type, tool_input: { command: 'git commit -m "x"' } }));
    assert.equal(r.code, 0, `agent_type ${JSON.stringify(agent_type)} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '', `agent_type ${JSON.stringify(agent_type)} printed to stderr`);
  }
});

test('PreToolUse: an unknown role still passes — the main thread and an unrecognised agent_type both run git commit', () => {
  const g = guard();
  for (const agent_type of [undefined, 'not-a-real-agent', 'omelette']) {
    const r = fire(g.path, preToolUse({ agent_type, tool_input: { command: 'git commit -m "x"' } }));
    assert.equal(r.code, 0, `agent_type ${JSON.stringify(agent_type)} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '', `agent_type ${JSON.stringify(agent_type)} printed to stderr`);
  }
});

test('PreToolUse: the other three shipped roles are still refused on git commit — omelette-coder-medium is no regression', () => {
  const g = guard();
  for (const agent of ['omelette-coder', 'omelette-tester', 'omelette-reviewer']) {
    const r = fire(g.path, preToolUse({ agent_type: agent, tool_input: { command: 'git commit -m "x"' } }));
    assert.equal(r.code, 2, `${agent} should still be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL(agent), `the refusal still names ${agent}`);
  }
});
