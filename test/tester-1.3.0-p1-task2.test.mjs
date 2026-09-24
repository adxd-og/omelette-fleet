/**
 * omelette-fleet :: test/tester-1.3.0-p1-task2.test.mjs
 * Clean-context tester coverage for
 * docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md, P1 bullet "The
 * guard learns the names" (line 41) and the Guard bullet of "## Tests"
 * (line 73), against the working-tree diff on branch feat/1.3.0
 * (hooks/omelette-guard.mjs: GUARDED_AGENTS gains `omelette-reviewer`).
 *
 * Scope: `omelette-reviewer` only (the P2 name `omelette-coder-medium` is a
 * later package's task, not this one). Driven exactly as
 * test/hooks.test.mjs drives the hook — a child process, the event as JSON
 * on stdin, exit code + stderr read back — because that is the hook's whole
 * contract. Never edits the implementation or the implementer's own tests;
 * imports nothing from them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

/** The refusal names the agent it caught, so two guarded roles never read each other's line. */
const REFUSAL = (agent) => `${agent} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`;

/** The guard exactly as `rules --hooks` writes it, in a throwaway directory. */
function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-p1t2-'));
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
  hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: 'omelette-reviewer',
  tool_input: { command: 'git commit -m "x"' }, ...over,
});

test('PreToolUse: the reviewer is blocked with exit 2 on every named-refusal command, and the refusal names omelette-reviewer', () => {
  const g = guard();
  for (const command of [
    'git commit -m "x"',
    'git stash',
    'git checkout -b x',
    'git switch -c x',
    'git branch x',
    'git worktree add ../x',
    'git push',
    'git merge x',
    'git rebase x',
    'git tag x',
  ]) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, `${command} should be blocked for omelette-reviewer: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-reviewer'), `${command}: the refusal must name omelette-reviewer`);
    assert.equal(r.out, '', 'a block says nothing on stdout');
  }
});

test('PreToolUse: reads pass for the reviewer — status, diff, log, show', () => {
  const g = guard();
  for (const command of ['git status', 'git diff', 'git log -1', 'git show HEAD']) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command} should pass for omelette-reviewer: ${r.out}${r.err}`);
    assert.equal(r.err, '', `${command}: no refusal on a read`);
  }
});

test('PreToolUse: look-alike agent_type strings are not the reviewer, and pass git commit', () => {
  const g = guard();
  for (const agent_type of ['omelette-reviewer-2', 'my-omelette-reviewer', 'reviewer', 'omelette-reviewers']) {
    const r = fire(g.path, preToolUse({ agent_type, tool_input: { command: 'git commit -m "x"' } }));
    assert.equal(r.code, 0, `agent_type ${agent_type} should not be guarded: ${r.out}${r.err}`);
    assert.equal(r.err, '', `agent_type ${agent_type}: no refusal for a look-alike`);
  }
});

test('PreToolUse: a non-Bash tool call from the reviewer passes, even one whose payload reads like a forbidden command', () => {
  const g = guard();
  const r = fire(g.path, preToolUse({
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/x', content: 'git commit -m "x"' },
  }));
  assert.equal(r.code, 0, `a non-Bash tool must pass for the reviewer: ${r.out}${r.err}`);
  assert.equal(r.err, '');
});

test('PreToolUse: the reviewer refusal has the same shape as the coder refusal, modulo the role name', () => {
  const g = guard();
  const reviewer = fire(g.path, preToolUse({ agent_type: 'omelette-reviewer', tool_input: { command: 'git commit -m "x"' } }));
  const coder = fire(g.path, preToolUse({ agent_type: 'omelette-coder', tool_input: { command: 'git commit -m "x"' } }));
  assert.equal(reviewer.code, 2);
  assert.equal(coder.code, 2);
  const reviewerRest = reviewer.err.trim().slice('omelette-reviewer'.length);
  const coderRest = coder.err.trim().slice('omelette-coder'.length);
  assert.equal(reviewerRest, coderRest, 'the refusal sentence after the role name is identical for both roles');
  assert.equal(reviewer.err.trim(), REFUSAL('omelette-reviewer'));
  assert.equal(coder.err.trim(), REFUSAL('omelette-coder'));
});

test('PreToolUse: an unknown role still passes git commit', () => {
  const g = guard();
  const r = fire(g.path, preToolUse({ agent_type: 'omelette-nonexistent-role', tool_input: { command: 'git commit -m "x"' } }));
  assert.equal(r.code, 0, `an unrecognised role must pass: ${r.out}${r.err}`);
  assert.equal(r.err, '');
});
