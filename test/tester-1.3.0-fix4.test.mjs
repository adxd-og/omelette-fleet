/**
 * omelette-fleet :: test/tester-1.3.0-fix4.test.mjs
 *
 * Acceptance tests for Task 4 of
 * docs/superpowers/plans/2026-09-24-1.3.0-P0-fixes.md (guard: G3, G4, G5, G7),
 * written BEFORE the fix lands, from the plan's "Behaviours to hold" (items
 * 1-6) and the plan's own verbatim command lists — not from any
 * implementation. This file never edits hooks/omelette-guard.mjs and drives
 * the guard exactly as test/hooks.test.mjs does: a real child process, the
 * PreToolUse event on stdin, the exit code and stderr as the answer, because
 * that is the hook's whole contract with Claude Code.
 *
 * Expected at the base commit (Step 4.2 of the plan): the G3, G4, G5 and G7
 * tests below are RED (the classifier reads a redirection target, a clustered
 * flag, --orphan/-t and a detached --column/--color value as harmless); the
 * no-regression and git-fact tests are GREEN already.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

/** The refusal names the agent it caught (hooks/omelette-guard.mjs, GUARDED_AGENTS). */
const REFUSAL = (agent) => `${agent} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`;

/** The guard exactly as `rules --hooks` writes it, in a throwaway directory — as test/hooks.test.mjs's guard() does. */
function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-fix4-'));
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
  hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: 'omelette-coder',
  tool_input: { command: 'git commit -m "x"' }, ...over,
});

const mustRefuse = (g, command) => {
  const r = fire(g.path, preToolUse({ tool_input: { command } }));
  assert.equal(r.code, 2, `${command} should be blocked: ${r.out}${r.err}`);
  assert.equal(r.err.trim(), REFUSAL('omelette-coder'), `${command}: wrong stderr`);
};
const mustPass = (g, command) => {
  const r = fire(g.path, preToolUse({ tool_input: { command } }));
  assert.equal(r.code, 0, `${command} should pass: ${r.out}${r.err}`);
  assert.equal(r.err, '', `${command}: unexpected stderr`);
};

// ---------------------------------------------------------------------------
// (1) G3 — a redirection is the shell's: its target is never a git argument.
// Behaviours to hold, item 1.
// ---------------------------------------------------------------------------
test('G3: a redirection is the shell\'s — the target is never read as a git argument', () => {
  const g = guard();
  for (const command of [
    'git rebase main > --abort',
    'git rebase main >--abort',
    'git rebase main 2> --abort',
    'git rebase main >> --abort',
    'git tag t > --list',
    'git tag t >--list',
    'git tag t 2> --list',
    'git tag t 2>> --list',
    'git tag t >| --list',
    'git tag t < --list',
    'git tag t &> --list',
    'git tag v1>out',
    'git tag v1 2>/dev/null',
    'git rebase main 2>/dev/null',
  ]) mustRefuse(g, command);
  for (const command of [
    'git tag > tags.txt',
    'git tag 2>/dev/null',
    'git tag 2>&1 | head -5',
    'git tag -l > tags.txt',
    'git tag -l 2>&1 | head -5',
    'git branch > branches.txt',
    'git branch 2>&1',
    'git rebase --abort > out.txt',
    'git rebase --abort 2>/dev/null',
    'git status > status.txt',
  ]) mustPass(g, command);
});

// ---------------------------------------------------------------------------
// (2) G4 — a branch is created however it is spelled: clusters, `--`,
// `--orphan`, `-t`/`--track`, quoted flags. Behaviours to hold, item 2.
// ---------------------------------------------------------------------------
test('G4: a branch is created however the flags are clustered, quoted, tracked or orphaned', () => {
  const g = guard();
  for (const command of [
    'git branch -q x',
    'git branch -qm a b',
    'git branch -- x',
    'git checkout -qb x',
    'git switch --orphan x',
    'git switch -qc x',
    'git branch --create-reflog x',
    'git branch -v x',
    'git branch --no-track x',
    'git branch --sort refname x',
    'git branch -t x origin/feat',
    'git checkout -t origin/feat',
    'git switch -t origin/feat',
    'git switch --track origin/feat',
    'git checkout "-b" x',
    "git switch '-c' x",
    'git branch -qc a b',
    'git branch -qu origin/x',
    'git checkout -qB x',
    'git switch -qC x',
    'git branch -q -- x',
  ]) mustRefuse(g, command);
  for (const command of [
    'git branch -l x',
    'git branch --contains HEAD x',
    'git branch --show-current',
    'git branch -d -- x',
    'git branch --column=always',
    'git checkout -',
    'git switch -',
    // The preserved allowance (Ruling 17): DWIM-created tracking branches for
    // an existing origin/<name> stay allowed — not a finding to "fix".
    'git checkout -q main',
    'git checkout main',
    'git switch main',
    'git checkout --detach',
    'git switch -d HEAD~1',
    'git switch --detach HEAD~1',
  ]) mustPass(g, command);
});

// ---------------------------------------------------------------------------
// (3) G5 — `--column` / `--color` take a value only when attached with `=`.
// Behaviours to hold, item 3.
// ---------------------------------------------------------------------------
test('G5: `--column` and `--color` take a value only ATTACHED — the word behind them is a tag name', () => {
  const g = guard();
  for (const command of ['git tag --column x', 'git tag --color x', 'git tag --column always', 'git tag --color always']) {
    mustRefuse(g, command);
  }
  for (const command of ['git tag --column=always', 'git tag --color=always', 'git tag -l --column always', 'git tag --column=always -l v*']) {
    mustPass(g, command);
  }
});

// ---------------------------------------------------------------------------
// (4) G7 — the scan stays linear in the command's length however many `git`
// invocations it holds. Behaviours to hold, item 4. A bound against blow-up
// (5 s), not a benchmark: the base commit is expected to blow this bound, by
// timeout or by SIGABRT, on the very first case (fire() asserts r.signal is
// null, which is itself how a heap-exhaustion SIGABRT is caught).
// ---------------------------------------------------------------------------
test('G7: 32 000 invocations in one separator-free command are answered in linear time', () => {
  const g = guard();
  for (const [command, code, label] of [
    ['git tag -l '.repeat(32000), 0, 'git tag -l ×32000'],
    ['git branch -l '.repeat(32000), 0, 'git branch -l ×32000'],
    ['git checkout x '.repeat(32000), 0, 'git checkout x ×32000'],
    ['git rebase --abort '.repeat(32000), 0, 'git rebase --abort ×32000'],
    [`echo ${'git tag x '.repeat(32000)}; git tag v1`, 2, 'echo …git tag x×32000; git tag v1'],
    [`echo ${'git checkout x '.repeat(32000)}; git checkout -b v1`, 2, 'echo …git checkout x×32000; git checkout -b v1'],
    [`echo ${'git branch -l '.repeat(32000)}; git branch v1`, 2, 'echo …git branch -l×32000; git branch v1'],
  ]) {
    const started = Date.now();
    const r = fire(g.path, preToolUse({ tool_input: { command } }));
    const ms = Date.now() - started;
    assert.equal(r.code, code, `${label} (${command.length} chars): ${r.err.slice(0, 200)}`);
    assert.ok(ms < 5000, `${label}: ${ms} ms for ${command.length} characters — the scan is not linear`);
  }
});

// ---------------------------------------------------------------------------
// (6) No regression — every command in the plan's verbatim allowed-command
// list (Task 4, Behaviours to hold item 6, lines 158-181) still passes,
// EXCEPT `git tag --column always`, which the fix moves to refused (tested
// under G5 above, so it is left out of this list rather than asserted twice).
// This group is green both before and after the fix: none of these commands
// is touched by G3/G4/G5/G7.
// ---------------------------------------------------------------------------
test('no regression: every allowed command in the plan\'s verbatim list still passes', () => {
  const g = guard();
  for (const command of [
    // :145-168
    'git status', 'git log --oneline -3', 'git diff HEAD', 'npm test', 'git commit-tree $t -m x',
    'git checkout main', 'git switch main', 'git checkout -- file.txt', 'git merge-base main HEAD',
    'git branch', 'git branch --list', 'git branch -l', 'git branch -a', 'git branch -r', 'git branch -v',
    'git branch -av', 'git branch -d x', 'git branch -D x', 'git branch --list feature-c',
    // :190-235 (minus `git tag --column always`, which moved to refused — G5)
    'git tag', 'git tag -l', 'git tag --list', 'git tag -n', 'git tag -n5', 'git tag -l "v1.*"',
    "git tag --list 'v*'", 'git tag --sort=-v:refname', 'git tag --contains HEAD', 'git tag v1 --list',
    'git tag --list v1*', 'git tag --contains abc', 'git tag --no-contains abc', 'git tag --points-at HEAD',
    'git tag --merged main', 'git tag --no-merged main', 'git tag --with HEAD', 'git tag --without HEAD',
    "git tag -l --format='%(refname) -a %(objectname)'", "git tag -l --format='%(refname)'",
    'git tag --sort refname', 'git tag --format "%(refname)"',
    'echo hi # git tag v1', 'git tag -v v1', 'git tag --verify v1', 'git rebase --abort',
    'git -C /x rebase --abort', 'git rebase -q --abort', 'git rebase --quit', 'git rebase --help', 'git rebase -h',
    // :443-451
    `git${' -c'.repeat(60)} zzz`, `git${' --foo'.repeat(60)}`,
    `git tag${' --contains x'.repeat(60)}`, `git tag${' --contains x'.repeat(800)}`,
    `echo ${'x'.repeat(5000)} # ${'a comment '.repeat(500)}`,
    // :810-832
    'git rebase --abort', 'git rebase --quit', 'git rebase --help', 'git rebase -h', 'git -C /x rebase --abort',
    'git rebase -q --abort', "git rebase --exec 'echo --abort' --abort", 'git rebase -S -h',
    'git rebase -S --abort', 'git rebase --gpg-sign --abort',
    // :867-871
    'git rebase --verbose --abort', 'git rebase --no-verify --abort', "git rebase --exec 'echo --abort now' --quit",
    // :910-915
    'git rebase --abort', 'git rebase -q --abort', "git rebase --exec 'echo --abort' --abort",
    // :930-937
    'git rebase -SABC -h', 'git rebase -SABC --abort', 'git rebase -Sx --abort', 'git rebase -qS --abort',
    // :1047
    'git tag --sort --list', 'git tag --list --sort v1', 'git tag --sort=-v:refname',
  ]) mustPass(g, command);
});

// ---------------------------------------------------------------------------
// (5) The git facts behind G4 and G5, pinned against git itself in a
// disposable repository — the "measured, not assumed" style of
// test/hooks.test.mjs:985-1035. This never compares the tree against
// `git show HEAD:…` and pins no file size.
// ---------------------------------------------------------------------------
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function gitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'omelette-fix4-git-'));
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
  return { repo, run };
}

test('git itself (G4, G5): the forms the fix now refuses write — measured, not assumed',
  { skip: !gitAvailable && 'git is not installed' }, () => {
    const { run } = gitRepo();
    const exists = (ref) => run('rev-parse', '--verify', '-q', ref).status === 0;
    const head = () => run('symbolic-ref', 'HEAD').stdout.trim();

    for (const [args, ref] of [
      [['tag', '--column', 'always'], 'refs/tags/always'],
      [['tag', '--color', 'tc'], 'refs/tags/tc'],
      [['branch', '-q', 'b1'], 'refs/heads/b1'],
      [['branch', '-v', 'b2'], 'refs/heads/b2'],
      [['branch', '--', 'b3'], 'refs/heads/b3'],
      [['branch', '--create-reflog', 'b4'], 'refs/heads/b4'],
      [['branch', '--sort', 'refname', 'b5'], 'refs/heads/b5'],
    ]) {
      const r = run(...args);
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.ok(exists(ref), `git ${args.join(' ')} should have written ${ref}`);
    }

    // `-qm` renames b1 to b6: b1 stops existing, b6 starts.
    assert.equal(run('branch', '-qm', 'b1', 'b6').status, 0);
    assert.ok(!exists('refs/heads/b1'), 'git branch -qm b1 b6 should have renamed b1 away');
    assert.ok(exists('refs/heads/b6'), 'git branch -qm b1 b6 should have created b6');

    assert.equal(run('checkout', '-qb', 'c1').status, 0);
    assert.equal(head(), 'refs/heads/c1', 'git checkout -qb c1 should move HEAD to a new branch');
    assert.equal(run('checkout', '-q', 'main').status, 0);
    assert.equal(run('switch', '-qc', 'c2').status, 0);
    assert.equal(head(), 'refs/heads/c2', 'git switch -qc c2 should move HEAD to a new branch');
    assert.equal(run('checkout', '-q', 'main').status, 0);
    assert.equal(run('switch', '-q', '--orphan', 'c3').status, 0);
    assert.equal(head(), 'refs/heads/c3', 'git switch --orphan c3 should move HEAD to a new branch');
  });
