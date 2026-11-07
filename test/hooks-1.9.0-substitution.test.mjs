/**
 * The guard hook, command substitution (1.9.0 Task 3b): a word holding `$(…)`
 * or backquotes where `git`, a global option, its value or the subcommand goes
 * is refused unread. Found by the Mistral unit's first live repro run
 * (2026-11-07): every DEFECT row exited 0 under 1.8.0 and commits in a shell.
 * After the subcommand a substitution stays one opaque word.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

const REFUSAL = (agent) => `${agent} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`;
const UNREAD = (agent) => `${REFUSAL(agent)} — a command substitution where git or its subcommand goes is not read`;

/** The ten commands of the defect report: unquoted the substitution vanishes, quoted it is the subcommand, inside the program word it expands to git. */
const DEFECT = [
  'git $(echo) commit -m x',
  'git "$(printf commit)" -m x',
  'git `echo` commit -m x',
  'git $() commit -m x',
  'git$(echo) commit -m x',
  'g$(echo)it commit -m x',
  'git comm$(echo)it -m x',
  'git -C . $(echo) commit -m x',
  'git --pag$(echo)e commit -m x',
  'git $(echo) push',
];

function guardPath() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-s-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.9.0'));
  return path;
}

/** One PreToolUse Bash call; `agent` null is the main thread, which carries no agent_type. */
function run(path, command, agent) {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
  if (agent) event.agent_type = agent;
  const r = spawnSync(process.execPath, [path], { input: JSON.stringify(event), encoding: 'utf8', timeout: 20000 });
  assert.equal(r.signal, null, `the guard hung on ${command}`);
  return { code: r.status, err: (r.stderr || '').trim() };
}

function check(rows, agent = 'omelette-reviewer') {
  const path = guardPath();
  for (const [command, code, err] of rows) {
    const r = run(path, command, agent);
    assert.equal(r.code, code, `${JSON.stringify(command)} should exit ${code}, exited ${r.code}: ${r.err}`);
    assert.equal(r.err, err, JSON.stringify(command));
  }
}

test('substitution: a word holding one where git, an option or the subcommand goes is refused unread', () => {
  check([
    ...DEFECT.map((command) => [command, 2, UNREAD('omelette-reviewer')]),
    // -C's value: empty, it vanishes, `.` becomes the value and `commit` the subcommand.
    ['git -C $(echo) . commit -m x', 2, UNREAD('omelette-reviewer')],
    // The program word's substitution prints the subcommand, which the shell splits off as a word of its own.
    ["git$(printf ' commit') -m x", 2, UNREAD('omelette-reviewer')],
    // A quoted word is read again as a command: `sh -c "git $(echo) commit -m x"` commits.
    ['echo "git $(echo) commit"', 2, UNREAD('omelette-reviewer')],
    // A write named behind a substituted value is refused as that write (test/hooks.test.mjs pins the text).
    ['git -C $(pwd) commit -m x', 2, REFUSAL('omelette-reviewer')],
    // The accepted over-refusal: a read-only subcommand behind a substituted option value.
    ['git -C $(pwd) status', 2, UNREAD('omelette-reviewer')],
    // The same, with a listing the guard names (tag) behind the substituted value.
    ['git -C $(pwd) tag -l', 2, UNREAD('omelette-reviewer')],
  ]);
});

test('substitution: the quoting rows of 1.8.0 are refused as before', () => {
  check([
    ['git commit -m x', 2, REFUSAL('omelette-reviewer')],
    ['"git" commit -m x', 2, REFUSAL('omelette-reviewer')],
    ["g'it' commit -m x", 2, REFUSAL('omelette-reviewer')],
  ]);
});

test('substitution: after the subcommand, in a process substitution, or with no git word, nothing changes', () => {
  check([
    ['git status $(echo)', 0, ''],
    ['git log --oneline', 0, ''],
    ['git tag -l $(git rev-parse HEAD)', 0, ''],
    ['diff <(git tag -l) <(git branch -l)', 0, ''],
    ['echo $(date) commit', 0, ''],
  ]);
});

test('substitution: the refusal names the coder and the tester, and the main thread is not guarded', () => {
  check([['git $(echo) commit -m x', 2, UNREAD('omelette-coder')]], 'omelette-coder');
  check([['git $(echo) commit -m x', 2, UNREAD('omelette-tester')]], 'omelette-tester');
  check([['git $(echo) commit -m x', 0, '']], null);
});

/**
 * Round 2: a variable expansion — `$name`, `${…}`, `$1`, `$@` and the other
 * specials — is read like a substitution; a value quoted whole is a value; a
 * value glued to its option is read like a detached one.
 */
const EXPANSION_UNREAD = [
  // Unquoted and empty, it vanishes: `git commit -m x`.
  'git $x commit -m x',
  'git ${x}commit -m y',
  // Quoted, it is one word: the subcommand is whatever `x` holds.
  'git "$x" -m y',
  'git $x -m y',
  // `commit` whatever `x` is.
  'git ${x:-commit} -m y',
  'g${x}it commit -m x',
  'git $1 commit',
  'git "${x}" status',
  // Where a global option goes, with a read-only subcommand behind it.
  'git $x status',
  // An unquoted value can vanish: `git -C $x . commit` commits.
  'git -C $DIR status',
  'git -C $(pwd) status',
];
const EXPANSION_PLAIN = [
  'git -C "$DIR" commit -m x',
  'git -C$(pwd) commit -m x',
  'git --git-dir=$(pwd)/.git push',
  'git -C $DIR commit -m x',
  // A single-quoted value is handed over literally: a value, and the commit behind it is refused as a commit.
  "git -C '$x' commit -m x",
];

test('expansion: a variable where git, an option or the subcommand goes, or in an unquoted value, is refused unread', () => {
  check(EXPANSION_UNREAD.map((command) => [command, 2, UNREAD('omelette-reviewer')]));
});

test('expansion: a write behind a quoted, glued or unquoted value keeps the plain refusal', () => {
  check(EXPANSION_PLAIN.map((command) => [command, 2, REFUSAL('omelette-reviewer')]));
});

test('expansion: a value quoted whole is a value, and an expansion after the subcommand or with no git word is an argument', () => {
  check([
    'git -C "$DIR" status',
    "git -C '$DIR' status",
    'git -C "$(git rev-parse --show-toplevel)" log --oneline',
    'git --git-dir="$D/.git" status',
    'git log -n$(echo 3)',
    // A program word that is only an expansion is no git word, as `$(which git)` is none.
    '$GIT commit -m x',
    'echo $x commit',
    'X=$(git rev-parse HEAD) && git log $X',
    'git log $X',
    'cd $(git rev-parse --show-toplevel) && git status',
    'git diff --stat $(git merge-base HEAD main)',
  ].map((command) => [command, 0, '']));
});

test('expansion: the main thread is not guarded', () => {
  check([...EXPANSION_UNREAD, ...EXPANSION_PLAIN].map((command) => [command, 0, '']), null);
});

test('expansion: `"$@"` and `"${a[@]}"` split inside double quotes and are no value; `"$*"` and `"${a[*]}"` join into one', () => {
  check([
    // `set -- . commit; git -C "$@" -m x` runs `git -C . commit -m x`.
    ['git -C "$@" -m x', 2, UNREAD('omelette-reviewer')],
    ['git -C "${a[@]}" status', 2, UNREAD('omelette-reviewer')],
    ['git "$@"', 2, UNREAD('omelette-reviewer')],
    ['git -C "$*" status', 0, ''],
    ['git -C "${a[*]}" status', 0, ''],
  ]);
});
