/**
 * omelette-fleet :: test/tester-0.3.4-p2-review.test.mjs
 * Clean-context tester coverage for spec
 * docs/superpowers/specs/2026-09-08-0.3.4-design.md, package 2 ("Guard: the
 * tester is contained too; three classifier quirks"), written against the
 * uncommitted working-tree diff on branch feat/0.3.4 (base b6bf076, which
 * already carries package 1 — auto-handoff — committed). Package 3 (small
 * items) is not in this diff and is not covered here.
 *
 * The implementer's own tests (test/hooks.test.mjs, test/rules.test.mjs)
 * already cover, thoroughly:
 *   - 2a: both `omelette-coder` and `omelette-tester` blocked with the
 *     per-agent refusal, reads untouched, the guarded set matched whole
 *     (near-miss strings, case, non-string agent_type all pass);
 *   - 2b: the rebase option-value quirk (`--exec`/`-x`/`--onto`/`--strategy`/
 *     `-s`/`--strategy-option`/`-X`/`--gpg-sign`/`-S`, clusters, `--` and the
 *     attached `=` form), cross-checked against a real git binary;
 *   - 2c: `git tag --sort --list` pinned as passing, `--sort … v1` still
 *     refused;
 *   - 2d: `hookSettingsSnippet` quoting of a path holding `$1`, a space and a
 *     `'`, on both platforms, plus an end-to-end shell run.
 *
 * Left uncovered or only implicitly covered by shared code paths:
 *   - 2b/2c's classifier fixes are only ever fired through the test helper's
 *     DEFAULT `agent_type: 'omelette-coder'` — nothing in the diff's own
 *     tests drives the exact same rebase/tag commands through
 *     `omelette-tester` to confirm 2a and 2b/2c compose (below);
 *   - the forbidden-command list for `omelette-tester` is only exercised for
 *     a handful of commands (commit/stash/push/checkout -b/worktree/tag/
 *     rebase) — merge, cherry-pick, revert, am, pull and a branch MOVE are
 *     never fired at the tester specifically (below);
 *   - "the docs (rules, ORCHESTRATION, SECURITY) say both roles are guarded"
 *     (spec §2a) has no test at all: agents/omelette-tester.md is checked,
 *     but rules/omelette-fleet.md, docs/ORCHESTRATION.md and
 *     docs/SECURITY.md are not (below);
 *   - a role name near the shipped set but genuinely plausible as a THIRD
 *     future role (rather than a typo of an existing one) is not tried.
 *
 * Does not edit the implementation or the implementer's own test files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES, renderHookFile, renderRulesFile } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const REFUSAL = (agent) => `${agent} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`;

/** The guard exactly as `rules --hooks` writes it, in a throwaway directory. */
function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-p2-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3'));
  return path;
}

/** One hook invocation: the event on stdin, the answer as code/stdout/stderr. */
function fire(path, input) {
  const r = spawnSync(process.execPath, [path], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const preToolUse = (agent, command) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: agent, tool_input: { command },
});

// ─── 2b/2c compose with 2a: the same classifier fires for the tester too ────

test('PreToolUse: the rebase option-value quirk (2b) is refused for omelette-tester exactly as for omelette-coder', () => {
  const g = guard();
  for (const command of [
    'git rebase --exec --abort main',
    'git rebase -x --abort main',
    'git rebase -qx --abort main',
    'git rebase --exec=--abort main',
    'git rebase --onto --abort main',
    'git rebase -- --abort',
  ]) {
    const r = fire(g, preToolUse('omelette-tester', command));
    assert.equal(r.code, 2, `omelette-tester: ${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-tester'), 'the refusal names the tester, not the coder');
  }
  // …and the recovery forms still pass for the tester too.
  for (const command of ['git rebase --abort', 'git rebase --quit', 'git rebase --help', 'git rebase -q --abort']) {
    const r = fire(g, preToolUse('omelette-tester', command));
    assert.equal(r.code, 0, `omelette-tester: ${command} should pass: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

test('PreToolUse: `git tag --sort --list` (2c) passes for omelette-tester, and a name behind the swallowed flag still refuses', () => {
  const g = guard();
  for (const command of ['git tag --sort --list', 'git tag --list --sort v1']) {
    const r = fire(g, preToolUse('omelette-tester', command));
    assert.equal(r.code, 0, `omelette-tester: ${command} should pass: ${r.out}${r.err}`);
  }
  for (const command of ['git tag --sort --list v1', 'git tag --sort refname v1']) {
    const r = fire(g, preToolUse('omelette-tester', command));
    assert.equal(r.code, 2, `omelette-tester: ${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-tester'));
  }
});

// ─── the tester's forbidden set is the coder's full set, not a subset ──────

test('PreToolUse: merge, cherry-pick, revert, am, pull and a branch MOVE are refused for omelette-tester too', () => {
  const g = guard();
  for (const command of [
    'git merge main',
    'git cherry-pick abc123',
    'git revert abc123',
    'git am /tmp/p.patch',
    'git pull',
    'git branch -m old new',
    'git branch -f feat main',
  ]) {
    const r = fire(g, preToolUse('omelette-tester', command));
    assert.equal(r.code, 2, `omelette-tester: ${command} should be blocked: ${r.out}${r.err}`);
    assert.equal(r.err.trim(), REFUSAL('omelette-tester'));
    assert.equal(r.out, '');
  }
});

// ─── a plausible THIRD role, not a typo of either shipped one, is not guarded ─

test('PreToolUse: a genuinely different, plausible future role name is not in the guarded set', () => {
  const g = guard();
  for (const agent of ['omelette-reviewer', 'omelette-docwriter', 'coder', 'tester']) {
    const r = fire(g, preToolUse(agent, 'git commit -m "x"'));
    assert.equal(r.code, 0, `agent_type ${agent} should not be guarded: ${r.out}${r.err}`);
    assert.equal(r.err, '');
  }
});

// ─── the docs actually say both roles are guarded (spec §2a) ───────────────

test('rules/omelette-fleet.md (rendered): the tester step says the guard refuses it, and names the role it caught', () => {
  const text = renderRulesFile('1.2.3');
  assert.match(text, /guard hook refuses those for the tester/, 'the rules template must say the tester is enforced, not merely asked');
  assert.match(text, /omelette-tester/);
  assert.ok(!text.includes('{{'), 'no placeholder survives rendering');
});

test('docs/ORCHESTRATION.md: the guard section names omelette-tester as a guarded role', () => {
  const text = readFileSync(join(ROOT, 'docs', 'ORCHESTRATION.md'), 'utf8');
  assert.match(text, /`omelette-coder`\s+or\s+`omelette-tester`/, 'the PreToolUse description must list both roles');
  assert.match(text, /The refusal names the agent it caught/);
});

test('docs/SECURITY.md: the PreToolUse bullet names omelette-tester as a guarded role and explains why', () => {
  const text = readFileSync(join(ROOT, 'docs', 'SECURITY.md'), 'utf8');
  assert.match(text, /`omelette-coder`\s+or\s+`omelette-tester`/, 'the security doc must list both roles');
  assert.match(text, /neither loses a read/);
});
