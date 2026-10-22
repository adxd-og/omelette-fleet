/**
 * omelette-fleet :: test/tester-1.3.0-p1-task2.test.mjs
 * From the 1.3.0 P1 Task 2 tester (omelette-reviewer joins the guarded roles,
 * docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md). The clean-up gate
 * kept one test: the reviewer's reads pass, `git show HEAD` among them — the
 * one read no other test sends through the guard. Driven as test/hooks.test.mjs
 * drives the hook: a child process, the event as JSON on stdin, exit code and
 * stderr read back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

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

test('PreToolUse: reads pass for the reviewer — status, diff, log, show', () => {
  const g = guard();
  for (const command of ['git status', 'git diff', 'git log -1', 'git show HEAD']) {
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 0, `${command} should pass for omelette-reviewer: ${r.out}${r.err}`);
    assert.equal(r.err, '', `${command}: no refusal on a read`);
  }
});
