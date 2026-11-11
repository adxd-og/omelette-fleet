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

/**
 * 1.9.0 whole-branch review fix round. Inside double quotes only the forms that stay one word in bash and zsh are a
 * value — everything else fails closed (C1); zsh's `$=x`, `$~x`, `$^x` and the split forms it reads in quotes (C2);
 * a brace expansion in the program word (C3) or the subcommand word (E1); a pathname expansion where the subcommand
 * goes (C4); a heredoc body a shell runs (E2); a git that xargs hands its subcommand (E3). Every DEFECT row exited 0
 * on the guard at 54aeee6.
 */
test('fix round (C1, C2): zsh\'s split and modifier forms are expansions; in double quotes only a one-word form is a value', () => {
  check([
    ...[
      'x=commit; git $=x -m y',
      'git $~x -m y',
      'git $^x -m y',
      'git -C "$a[@]" -m x',
      'git -C "${(@)a}" -m x',
      'git -C "${(f)y}" -m x',
      // zsh splits `${=x}` even inside double quotes.
      'git -C "${=x}" -m x',
      // A nested expansion in the word of `${x:-…}` fails closed.
      'git -C "${x:-$y}" status',
    ].map((command) => [command, 2, UNREAD('omelette-reviewer')]),
    // A simple `${name<op>word}` stays one word: a value.
    ['git -C "${x:-a}" status', 0, ''],
  ]);
});

test('fix round (C3, E1): a brace expansion in the program word is refused unread; in the subcommand word it is the subcommand the shell makes of it', () => {
  check([
    ['{git,--no-pager} commit -m x', 2, UNREAD('omelette-reviewer')],
    // bash runs `echo git commit -m x`: an over-refusal, accepted.
    ['{echo,git} commit -m x', 2, UNREAD('omelette-reviewer')],
    ['echo {a,b}', 0, ''],
    ['git {c,c}ommit -m x', 2, REFUSAL('omelette-reviewer')],
    ['git com{m..m}it -m x', 2, REFUSAL('omelette-reviewer')],
    ['git pu{s..s}h', 2, REFUSAL('omelette-reviewer')],
    ['git comm{it,it} -m x', 2, REFUSAL('omelette-reviewer')],
    // The alternatives behind the first word are its arguments: `git tag tagx` creates `tagx`.
    ['git tag{,x}', 2, REFUSAL('omelette-reviewer')],
    // An option the walk did not step over: `git -C . commit -m x`.
    ['git {-C,.} commit -m x', 2, UNREAD('omelette-reviewer')],
    ['git log --format={%H,%s}', 0, ''],
  ]);
});

test('fix round (C4): a glob where the subcommand goes is refused unread; one in an argument is not', () => {
  check([
    ...['git c?mmit -m x', 'git c[o]mmit -m x', 'git co*t -m x'].map((command) => [command, 2, UNREAD('omelette-reviewer')]),
    ['git log *.md', 0, ''],
    ['git add *.js', 0, ''],
  ]);
});

test('fix round (E2): a heredoc body on a line that runs a shell is read as a command of its own', () => {
  const body = '\ngit commit -m x\nEOF';
  check([
    ...['bash', 'sh', 'zsh', 'dash', 'ksh', '/bin/bash', 'env bash', 'bash -s'].map((sh) => [`${sh} <<'EOF'${body}`, 2, REFUSAL('omelette-reviewer')]),
    [`bash <<EOF${body}`, 2, REFUSAL('omelette-reviewer')],
    [`cat <<'EOF' | sh${body}`, 2, REFUSAL('omelette-reviewer')],
    [`cat <<'EOF'${body}`, 0, ''],
    // The heredoc rule fails closed (review of 5d01ec4): a body another interpreter reads is read as commands.
    [`python3 <<'EOF'\nimport os; os.system("git commit -m x")\nEOF`, 2, REFUSAL('omelette-reviewer')],
  ]);
});

test('fix round (E3): a git that xargs hands its subcommand, or the placeholder as its subcommand, is refused unread', () => {
  check([
    ["printf '%s\\n' commit -m x | xargs git", 2, UNREAD('omelette-reviewer')],
    ["printf '%s\\n' commit | xargs -I {} git {} -m x", 2, UNREAD('omelette-reviewer')],
    ['git ls-files | xargs grep -n git', 0, ''],
    ['git ls-files | xargs git add', 0, ''],
    ['xargs git branch -D', 2, REFUSAL('omelette-reviewer')],
  ]);
});

/**
 * 1.9.0 whole-branch review fix round 2 (the tester's file, test/review-fix-tester.test.mjs, holds the defects): a
 * brace word is bounded before it is expanded (D3), a heredoc inside a substitution a shell runs is a command (D4),
 * and xargs' git behind a wrapper is unread (N5).
 */
const MB = 1 << 20;
const GROUPS_1MB = '{a,b}'.repeat(Math.ceil(MB / 5));
/** The fastest of three runs, in ms: node's start dominates a guard call, and one slow start is noise. */
function fastest(path, command) {
  let best = Infinity;
  let code = null;
  for (let k = 0; k < 3; k++) {
    const started = process.hrtime.bigint();
    code = run(path, command, 'omelette-reviewer').code;
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
  }
  return { code, ms: best };
}

test('fix round 2 (D3): a brace word past 256 words, 64 groups or 1 MiB of text is refused unread only where git, an option or the subcommand goes; elsewhere it is read as written', () => {
  check([
    // The commit is refused as the commit: the brace word beside it is an argument of echo.
    [`git commit -m x; echo ${'{a,b}'.repeat(3000)}`, 2, REFUSAL('omelette-reviewer')],
    ['echo {a..z}{a..z}{a..z}', 0, ''],
    [`echo ${'{a,b}'.repeat(9)}`, 0, ''],
    // Where the program goes, after an assignment, a keyword or a wrapper too.
    [`${'{a,b}'.repeat(9)} commit -m x`, 2, UNREAD('omelette-reviewer')],
    [`x=1 ${'{a,b}'.repeat(9)} commit -m x`, 2, UNREAD('omelette-reviewer')],
    [`sudo ${'{a,b}'.repeat(9)} commit -m x`, 2, UNREAD('omelette-reviewer')],
    // An option's value.
    [`git -C ${'{a,b}'.repeat(9)} status`, 2, UNREAD('omelette-reviewer')],
    // 65 groups of one word each: the product is 1, the count is past BRACE_GROUPS.
    [`git ${'{a..a}'.repeat(65)}`, 2, UNREAD('omelette-reviewer')],
    [`git ${'{a..a}'.repeat(64)}`, 0, ''],
  ]);
  const path = guardPath();
  const base = fastest(path, 'git commit -m x');
  const row = fastest(path, `git commit -m x; echo ${'{a,b}'.repeat(3000)}`);
  assert.equal(row.code, 2);
  assert.ok(row.ms - base.ms < 50, `3000 groups cost ${(row.ms - base.ms).toFixed(1)} ms over a bare commit`);
});

test('fix round 2 (D3): a 1 MB word of groups never crashes the guard: the rest of the line decides, under 2 s', () => {
  const path = guardPath();
  for (const [command, code] of [
    [`echo ${GROUPS_1MB}`, 0],
    [`git commit -m x; echo ${GROUPS_1MB}`, 2],
    [`${GROUPS_1MB} commit -m x`, 2],
    [`git ${GROUPS_1MB}`, 2],
    // Within the word and group caps, 256 words of 1 MB each: BRACE_TEXT stops it before anything is built.
    [`echo ${'x'.repeat(MB)}${'{a,b}'.repeat(8)}`, 0],
    [`echo ${'{a,'.repeat(MB / 4)}b${'}'.repeat(MB / 4)}`, 0],
  ]) {
    const r = fastest(path, command);
    assert.equal(r.code, code, command.slice(0, 40));
    assert.ok(r.ms < 2000, `${command.slice(0, 40)}… took ${r.ms.toFixed(0)} ms`);
  }
});

test('fix round 2 (D4): the heredoc body of a command inside a substitution on a line that feeds a shell is read as a command', () => {
  check([
    ...[
      "eval \"$(cat <<'EOF'\ngit commit -m x\nEOF\n)\"",
      "bash -c \"$(cat <<'EOF'\ngit commit -m x\nEOF\n)\"",
      "eval \"`cat <<'EOF'\ngit commit -m x\nEOF\n`\"",
      "x=$(cat <<'EOF'\ngit commit -m x\nEOF\n); eval \"$x\"",
    ].map((command) => [command, 2, REFUSAL('omelette-reviewer')]),
    // No shell on the line: echo prints the body.
    ["echo \"$(cat <<'EOF'\ngit commit\nEOF\n)\"", 0, ''],
    // A quoted word's own heredoc is text: `bash -c` runs cat, which prints its body.
    ["bash -c 'cat <<EOF\ngit commit -m x\nEOF'", 0, ''],
  ]);
});

test('fix round 2 (N5): xargs\' git behind env, command, nice, sudo, exec, time or timeout is refused unread', () => {
  check([
    ...[
      'xargs env git',
      'xargs command git',
      'xargs nice git',
      'xargs -n1 command git',
      'xargs env A=1 B=2 nice -n 5 timeout 9 sudo exec time git',
    ].map((command) => [command, 2, UNREAD('omelette-reviewer')]),
    ['xargs env git status', 0, ''],
    ['xargs nice echo git', 0, ''],
  ]);
});

const TOO_WIDE = (agent) => `${agent}: command too wide to read (over 4096 brace groups or 65536 brace words) — split it, or write the file with Write`;
const words = (word, n) => Array(n).fill(word).join(' ');

test('fix round 2 (budget): past 4096 brace groups or 65536 brace words in one command, its spans included, the command is refused whole as too wide', () => {
  check([
    [`echo ${words('{a,b}', 4096)}`, 0, ''],
    [`echo ${words('{a,b}', 4097)}`, 2, TOO_WIDE('omelette-reviewer')],
    // 256 words of 256 each is the budget; one more word of them is past it, at 2056 groups.
    [`echo ${words('{a,b}'.repeat(8), 256)}`, 0, ''],
    [`echo ${words('{a,b}'.repeat(8), 257)}`, 2, TOO_WIDE('omelette-reviewer')],
    // A substitution's words count with the command's: 2049 inside, 2048 outside.
    [`echo $(echo ${words('{a,b}', 2049)}) ${words('{a,b}', 2048)}`, 2, TOO_WIDE('omelette-reviewer')],
  ]);
  // The refusal names the role it caught; the main thread is not guarded.
  check([[`echo ${words('{a,b}', 4097)}`, 2, TOO_WIDE('omelette-coder')]], 'omelette-coder');
  check([[`echo ${words('{a,b}', 4097)}`, 0, '']], null);
});

test('fix round 2 (budget): 8 MiB of {a,b} words is refused in under 5 s; 1 MB of plain words is read as before', () => {
  const path = guardPath();
  // Under the hook's 8 MiB stdin cap, the event's JSON around it included.
  const big = fastest(path, `echo ${words('{a,b}', Math.floor((8 * MB - 4096) / 6))}`);
  assert.equal(big.code, 2);
  assert.ok(big.ms < 5000, `8 MiB of {a,b} took ${big.ms.toFixed(0)} ms`);
  const plain = fastest(path, `echo ${words('x'.repeat(40), Math.floor(MB / 41))}`);
  assert.equal(plain.code, 0);
  assert.ok(plain.ms < 5000, `1 MB of plain words took ${plain.ms.toFixed(0)} ms`);
});

/** A PreToolUse event of exactly `bytes` bytes, a padding field after the command; `agent` null is the main thread. */
function eventOf(command, bytes, agent) {
  const event = (padding) => JSON.stringify({ hook_event_name: 'PreToolUse', ...(agent ? { agent_type: agent } : {}), tool_name: 'Bash', tool_input: { command }, padding });
  const text = event('x'.repeat(bytes - event('').length));
  assert.equal(Buffer.byteLength(text), bytes);
  return text;
}

test('fix round 2 (stdin cap): an event over 8 MiB is refused unread, exit 2, for every caller; one at the cap or under it is read', () => {
  const path = guardPath();
  const raw = (input) => {
    const started = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [path], { input, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.signal, null);
    return { code: r.status, err: (r.stderr || '').trim(), ms: Number(process.hrtime.bigint() - started) / 1e6 };
  };
  const over = 'omelette-guard: event over 8 MiB — refused unread';
  const commit = raw(eventOf('git commit -m x', 8 * MB + 1, 'omelette-reviewer'));
  assert.deepEqual([commit.code, commit.err], [2, over]);
  assert.ok(commit.ms < 5000, `8 MiB + 1 took ${commit.ms.toFixed(0)} ms`);
  // The main thread too: nothing past the cap is read, so nothing says whose it is.
  const main = raw(eventOf('git status', 8 * MB + 1, null));
  assert.deepEqual([main.code, main.err], [2, over]);
  // At the cap the event is read whole: its command decides.
  assert.deepEqual(Object.values(raw(eventOf('git status', 8 * MB, 'omelette-reviewer'))).slice(0, 2), [0, '']);
  assert.deepEqual(Object.values(raw(eventOf('git status', 7 * MB, 'omelette-reviewer'))).slice(0, 2), [0, '']);
});

/** `echo $(…)` nested `n` deep around `leaf`: the leaf's span is read at depth n - 1. */
const nest = (n, leaf) => { let s = leaf; for (let k = 1; k < n; k++) s = `echo $(${s})`; return s; };

test('final round (1): `.`, source\'s POSIX spelling, feeds a shell its heredoc body', () => {
  check([
    [". /dev/stdin <<'EOF'\ngit commit -m x\nEOF", 2, REFUSAL('omelette-reviewer')],
    [". <(cat <<'EOF'\ngit commit -m x\nEOF\n)", 2, REFUSAL('omelette-reviewer')],
  ]);
});

test('final round (2): under xargs, a wrapper with options it does not parse runs the first git word after it', () => {
  check([
    ...[
      'echo commit | xargs sudo -u x git',
      'xargs env -i git',
      'xargs env -u X git',
      'xargs nice -5 git',
      'xargs nice -n5 git',
      'xargs timeout -s KILL 5 git',
      'xargs command -p git',
      'xargs time -p git',
      'xargs nohup git',
    ].map((command) => [command, 2, UNREAD('omelette-reviewer')]),
    ['xargs env git status', 0, ''],
    ['git ls-files | xargs grep -n git', 0, ''],
    ['xargs nice echo git', 0, ''],
  ]);
});

test('final round (3): past the re-read depth a span that could still make a git word is refused unread; plain words pass', () => {
  check([
    [nest(5, 'echo {g,x}it commit'), 2, UNREAD('omelette-reviewer')],
    // Six deep the brace word is past the last re-read: before 1.9.0 it passed.
    [nest(6, 'echo {g,x}it commit'), 2, UNREAD('omelette-reviewer')],
    [nest(6, 'echo $x commit'), 2, UNREAD('omelette-reviewer')],
    [nest(6, "echo 'g'it commit"), 2, UNREAD('omelette-reviewer')],
    [nest(6, 'echo g\\it commit'), 2, UNREAD('omelette-reviewer')],
    [nest(6, "echo 'hi'"), 0, ''],
    [nest(5, 'echo git commit'), 2, REFUSAL('omelette-reviewer')],
    [nest(6, 'echo git commit'), 2, REFUSAL('omelette-reviewer')],
    [nest(6, 'echo hi'), 0, ''],
  ]);
});

test('final round (escaped quote): `\'\\\'\'` re-reads as the quote it stands for; a backslash before anything else stays as written', () => {
  check([
    // Two and three `sh -c` levels with the standard `'\''` escape: bash reaches the inner command (measured).
    ["sh -c 'sh -c '\\''git commit'\\'''", 2, REFUSAL('omelette-reviewer')],
    ["bash -c 'bash -c '\\''bash -c '\\''\\'\\'''\\''git commit'\\''\\'\\'''\\'''\\'''", 2, REFUSAL('omelette-reviewer')],
    ["sh -c 'sh -c '\\''git status'\\'''", 0, ''],
    // Out of scope, unchanged: a backslash inside the word.
    ['g\\it commit -m x', 0, ''],
    // bash runs echo with the literal words `'git` and `commit'`: no quoted word holds a command. A quoted one is re-read.
    ["echo \\'git commit\\'", 0, ''],
    ["echo 'git commit'", 2, REFUSAL('omelette-reviewer')],
  ]);
});

test('review fix (shells): csh, tcsh, ash, yash, posh, fish and busybox feed a shell; so does a program word that holds an expansion or a substitution', () => {
  const body = "\ngit commit -m x\nEOF";
  check([
    ...['csh', 'tcsh', 'ash', 'yash', 'posh', 'fish', 'busybox sh', '$SHELL', '$(which bash)', '"$sh"', 'x=1 $SHELL', 'echo hi; $SHELL']
      .map((program) => [`${program} <<'EOF'${body}`, 2, REFUSAL('omelette-reviewer')]),
    // A substitution that prints the command is the program word: what it prints runs.
    [`$(cat <<'EOF'${body}\n)`, 2, REFUSAL('omelette-reviewer')],
    // …and so is a quoted word a shell runs; one echo prints is text.
    [`bash -c "$SHELL <<'EOF'${body}"`, 2, REFUSAL('omelette-reviewer')],
    [`echo "$($SHELL <<'EOF'${body}\n)"`, 2, REFUSAL('omelette-reviewer')],
    [`echo "$(cat <<'EOF'${body}\n)"`, 0, ''],
    [`cat <<'EOF'${body}`, 0, ''],
    [`$SHELL <<'EOF'\ngit status\nEOF`, 0, ''],
    // An argument's expansion feeds nothing: only a program word or a redirection target is read so.
    [`echo $HOME <<'EOF'${body}`, 0, ''],
    ['echo ${x:-"}"}<<EOF\ngit commit\nEOF\n', 0, ''],
    [`env $SH <<'EOF'${body}`, 2, REFUSAL('omelette-reviewer')],
  ]);
});

test('review fix (shells): a program word whose name only the shell\'s expansion settles — a brace group, a glob, a backslash — feeds a shell too', () => {
  const body = "\ngit commit -m x\nEOF";
  check([
    ...['ba{sh,x}', '{ba,x}sh', '/bin/ba?h', '/bin/ba*', 'ba[s]h', 'b\\ash']
      .map((program) => [`${program} <<'EOF'${body}`, 2, REFUSAL('omelette-reviewer')]),
    [`cat <<'EOF'${body}`, 0, ''],
    [`echo "$(cat <<'EOF'${body}\n)"`, 0, ''],
    // The test builtin's `[` is no glob, but it is no NON_EXEC program either: the line feeds (an over-refusal).
    [`[ -f x ] && cat <<'EOF'${body}`, 2, REFUSAL('omelette-reviewer')],
  ]);
});

test('review fix (heredoc fails closed): a body is data only when every program of its line is NON_EXEC and no word may name another', () => {
  const body = "\ngit commit -m x\nEOF";
  check([
    ...['rbash', 'pwsh', 'nu', 'xonsh', 'toybox sh', 'python3', 'perl', 'node', 'ssh host', 'su -c', 'docker run -i img']
      .map((program) => [`${program} <<'EOF'${body}`, 2, REFUSAL('omelette-reviewer')]),
    ...['cat', 'tee f', 'grep x', 'base64 -d', 'sudo cat', 'cat >f']
      .map((program) => [`${program} <<'EOF'${body}`, 0, '']),
    [`sudo -u x $SHELL <<'EOF'${body}`, 2, REFUSAL('omelette-reviewer')],
    // An expansion in a redirection target feeds the body too: an over-refusal, accepted.
    [`cat <<'EOF' > $OUT${body}`, 2, REFUSAL('omelette-reviewer')],
    // A process substitution may hand the body on.
    [`tee >(sh) <<'EOF'${body}`, 2, REFUSAL('omelette-reviewer')],
    // The heredoc's own word is no word of the line; an assignment's subscript is no glob.
    [`cat <<\\EOF${body}`, 0, ''],
    [`a[1]=x; cat <<'EOF'${body}`, 0, ''],
    // A quoted word of a NON_EXEC line feeds nothing: echo prints the body.
    [`echo "$(cat <<'EOF'${body}\n)"`, 0, ''],
  ]);
});
