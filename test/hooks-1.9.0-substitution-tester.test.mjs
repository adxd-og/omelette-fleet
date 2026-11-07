/**
 * The guard hook, command substitution (1.9.0 Task 3b) — the tester's rows: what
 * test/hooks-1.9.0-substitution.test.mjs leaves unpinned. Wrappers and shell
 * shapes around the invocation, a value attached to its option, quoting and
 * nesting inside the substitution, text the tokenizer must keep out of the rule
 * (heredoc bodies, comments), commands with a substitution that must stay
 * allowed, `$(which git)` (out of scope by ruling), and the header's promise
 * that the scan stays linear on the new path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

const AGENT = 'omelette-reviewer';
const REFUSAL = `${AGENT} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`;
const UNREAD = `${REFUSAL} — a command substitution where git or its subcommand goes is not read`;

const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-st-'));
const guard = join(dir, 'omelette-guard.mjs');
writeFileSync(guard, renderHookFile(HOOK_FILES[0], '1.9.0'));

function run(command) {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: AGENT, tool_input: { command } };
  const started = Date.now();
  const r = spawnSync(process.execPath, [guard], { input: JSON.stringify(event), encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 26 });
  assert.equal(r.signal, null, 'the guard hung');
  return { code: r.status, err: (r.stderr || '').trim(), ms: Date.now() - started };
}

function check(rows) {
  for (const [command, code, err] of rows) {
    const r = run(command);
    assert.equal(r.code, code, `${JSON.stringify(command)} should exit ${code}, exited ${r.code}: ${r.err}`);
    assert.equal(r.err, err, JSON.stringify(command));
  }
}

test('substitution: the shapes a git invocation stands in (wrapper, pipeline, list, subshell, group) are refused', () => {
  check([
    'env git $(echo) commit -m x',
    'command git $(echo) commit -m x',
    'xargs git $(echo) commit',
    'time git $(echo) commit -m x',
    'true | git $(echo) commit -m x',
    'git $(echo) commit -m x || true',
    'git status && git $(echo) commit -m x',
    '{ git $(echo) commit -m x; }',
    '(git $(echo) commit -m x)',
    'echo hi\ngit $(echo) commit -m x',
    'echo hi\r\ngit $(echo) commit -m x',
    'bash -c \'git $(echo) commit -m x\'',
  ].map((c) => [c, 2, UNREAD]));
});

test('substitution: an unquoted value or one glued to its option is a substituted global option', () => {
  check([
    'git -c user.name=$(whoami) status',
    'git --git-dir=$(pwd)/.git status',
    'git -C$(pwd) status',
    'git --work-tree $(pwd) log',
  ].map((c) => [c, 2, UNREAD]));
});

test('substitution: a substituted value behind the last-value fallback (an unlisted long option) is still unread', () => {
  // `--foo` is read as valued, so `tag` is its value and the fallback subcommand; the second `--foo $(pwd)` is a substituted value
  check([['git --foo tag -l --foo $(pwd)', 2, UNREAD]]);
});

test('substitution: a write named behind a substituted value keeps the plain refusal', () => {
  check([
    ['git -c user.name=$(whoami) commit -m x', 2, REFUSAL],
    ['git -C $(pwd) -c k=v push', 2, REFUSAL],
    ['git -C $(pwd) status; git commit -m x', 2, REFUSAL],
    ['git $(echo) status; git commit -m x', 2, REFUSAL],
  ]);
});

test('substitution: a write behind a value glued to its option keeps the plain refusal too', () => {
  check([
    ['git -C$(pwd) commit -m x', 2, REFUSAL],
    ['git --git-dir=$(pwd)/.git push', 2, REFUSAL],
  ]);
});

test('expansion: the specials and the digits are read like a name, in the program and the subcommand slot', () => {
  check([
    'git $0 commit', 'git $1 commit', 'git $@ commit', 'git $* commit', 'git $# commit', 'git $? commit', 'git $$ commit', 'git $! commit', 'git $- commit',
    'git ${x#git} commit -m y', 'git ${!x} -m y', 'git ${x[0]} -m y', 'git $x$y -m y', 'git "$x"commit -m y',
  ].map((c) => [c, 2, UNREAD]));
});

test('expansion: a value that can still vanish or split is not a value (glued short option, unlisted option, escaped or ANSI-C quotes)', () => {
  check([
    // `-C"$x"` empty is a bare `-C`, which takes `.`: this commits.
    'git -C"$x" . commit -m y',
    'git -c"$x" . commit -m y',
    // an unlisted option may take no value at all, and then `"$x"` can be the subcommand
    'git --foo "$x" status',
    'git --namespace "$ns" status',
    // an escaped quote opens no quote: `$x` is unquoted and splits
    'git -C \\"$x\\" status',
    "git -C $'\\''$x status",
  ].map((c) => [c, 2, UNREAD]));
});

test('expansion: `"${@…}"` and `"${!prefix@}"` split inside double quotes as `"$@"` does; `"${!prefix*}"` joins into one', () => {
  check([
    'git -C "${@:2}" status',
    'git -C "${@}" status',
    'git -C "${!pre@}" status',
    'git --git-dir="$@" status',
  ].map((c) => [c, 2, UNREAD]));
  check([
    ['git -C "${!pre*}" status', 0, ''],
    ['git -C "${*}" status', 0, ''],
  ]);
});

test('substitution: quoting and nesting inside and around the substitution do not hide it', () => {
  check([
    'git \\\n$(echo) commit -m x',
    '"g"$(echo)"it" commit -m x',
    "'g'$(echo)'it' commit -m x",
    'git ""$(echo) commit -m x',
    'git $(echo $(echo)) commit -m x',
    'git $(echo `echo`) commit -m x',
    'git $(\necho\n) commit -m x',
    'git $(echo ")") commit -m x',
    "git $(echo ')') commit -m x",
    'git $(echo commit',
    // backquotes inside the program word or the subcommand word, not only as a word of their own
    'g`echo`it commit -m x',
    'git`echo` commit -m x',
    'git comm`echo`it -m x',
    'git `echo commit',
  ].map((c) => [c, 2, UNREAD]));
});

test('substitution: text the shell never runs as a command stays out of the rule', () => {
  check([
    "cat <<'EOF'\ngit $(echo) commit\nEOF",
    "cat <<'EOF'\n'$(echo)' git\nEOF\ngit status",
    'cat <<EOF\ngit $(echo) commit\nEOF',
    'echo hi # git $(echo) commit',
    'echo hi #git $(echo) commit\ngit status',
  ].map((c) => [c, 0, '']));
  // a substitution that IS executed inside an unquoted heredoc body is still read
  check([['cat <<EOF\n$(git $(echo) commit)\nEOF', 2, UNREAD]]);
});

test('substitution: commands that read with a substitution, and no git word where it stands, stay allowed', () => {
  check([
    'cd $(git rev-parse --show-toplevel) && git status',
    'git diff --stat $(git merge-base HEAD main)',
    'git show $(git rev-parse HEAD):file',
    'git log -n$(echo 3)',
    'git -C "$(pwd)" status',
    'git log --format="%H $(date)"',
    'git --no-pager log $(git rev-parse HEAD)',
    'echo "$(git log -1)" && git status',
    'X=$(git rev-parse HEAD) && git log $X',
    'git status > $(echo)',
    // `$(which git)` is out of scope by ruling: its output is the program, never spelled out
    '$(which git) commit -m x',
    'echo $(date) git status',
  ].map((c) => [c, 0, '']));
});

test('substitution: the scan stays linear on the new path (1 MB in well under a few seconds; the suite bounds the old rows at 2000 ms)', () => {
  const rep = (s) => s.repeat(Math.ceil((1 << 20) / s.length));
  const rows = [
    [rep('git $(echo) '), 2],
    [rep('git -C $(x) '), 2],
    [rep('git$(echo) '), 2],
    [`git ${rep('$(a)')}`, 2],
    [`echo ${rep('$(a)')}`, 0],
    [`git status ${rep('$(a) ')}`, 0],
  ];
  for (const [command, code] of rows) {
    const r = run(command);
    assert.equal(r.code, code, `${command.slice(0, 24)}…`);
    assert.ok(r.ms < 4000, `${command.slice(0, 24)}… took ${r.ms} ms`);
  }
});
