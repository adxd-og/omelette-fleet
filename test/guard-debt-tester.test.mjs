/**
 * omelette-fleet :: test/guard-debt-tester.test.mjs
 * 1.10.1 T1 (heredoc bodies, a body inside an open group), second set. Lines of the
 * spec test/guard-debt.test.mjs leaves unpinned, and two defects found by differential
 * runs against /bin/bash 3.2 and zsh. The rendered guard is fired as Claude Code fires it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-debt-tester-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3'));
  return path;
}

const fire = (path, command) => spawnSync(process.execPath, [path], {
  input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: 'omelette-coder', tool_input: { command } }),
  encoding: 'utf8', timeout: 20000,
});

/** Each row `[command, code]`: 2 is refused, 0 passes in silence. */
function rows(list) {
  const path = guard();
  for (const [command, code] of list) {
    const r = fire(path, command);
    assert.equal(r.signal, null, `the guard hung on ${JSON.stringify(command)}`);
    assert.equal(r.status, code, `${JSON.stringify(command)} → ${r.status} ${r.stderr}`);
  }
}

const WRITE = 'git commit -m x';
const doc = (head, tail = '', body = WRITE) => `${head} <<'EOF'\n${body}\nEOF\n${tail}`;
const piped = (open, close) => doc(`${open}\ncat`, `${close} | sh`);
const after = (line) => doc(`${line}\ncat > f`);

test('heredoc: `less`, `more`, `tar` and `cpio` stay in the set that runs nothing — a git-write body is text', () => {
  rows([
    [doc('less'), 0],
    [doc('more'), 0],
    [doc('tar -xf -'), 0],
    [doc('cpio -i'), 0],
    // the way round the set is a word of the line, which the guard reads
    [`tar -xf - --to-command='${WRITE}' <<'EOF'\nx\nEOF`, 2],
  ]);
});

test('heredoc: `while read …; done <<\'EOF\'` stays refused with a git-write body', () => {
  rows([
    [doc('while read l; do :; done'), 2],
  ]);
});

test('open group: a closer in a comment on the heredoc line closes nothing', () => {
  rows([
    [`( cat <<'EOF' # )\n${WRITE}\nEOF\n) | sh`, 2],
    [`{ cat <<'EOF' # }\n${WRITE}\nEOF\n} | sh`, 2],
    [`if true; then cat <<'EOF' # fi\n${WRITE}\nEOF\nfi | sh`, 2],
    [`( cat <<'EOF' ;# )\n${WRITE}\nEOF\n) | sh`, 2],
    [`( cat <<'EOF'\nhello\nEOF\n) | sh # )`, 0],
    // the comment is only a comment: a closed group beside it still lets a body be text
    [`( : ) # (\ncat > f <<'EOF'\n${WRITE}\nEOF`, 0],
  ]);
});

test('open group: groups nest — each closer closes the innermost, and a body stands in whatever is left open', () => {
  rows([
    [piped('( {', '} )'), 2],
    [piped('{ (', ') }'), 2],
    [piped('( ( (', ') ) )'), 2],
    [piped('if true; then (', ') fi'), 2],
    [piped('{ if true; then', 'fi; }'), 2],
    [piped('if true; then if true; then :; fi', 'fi'), 2],
    [piped('( true; ) ; (', ')'), 2], // the first group is closed, the second is open
    [piped('{ :; } ; {', '}'), 2],
    [after('( { :; } )'), 0],
    [after('{ ( : ) ; }'), 0],
    [after('if true; then if true; then :; fi; fi'), 0],
    [after('( true; ) ; ( true )'), 0],
  ]);
});

test('open group: a group that closes on the heredoc line itself, with the pipe on its own line, is still fed', () => {
  rows([
    [`( cat <<'EOF' ) |\n${WRITE}\nEOF\nsh`, 2],
    [`{ cat <<'EOF'; } |\n${WRITE}\nEOF\nsh`, 2],
    [`cat <<'EOF' | {\n${WRITE}\nEOF\nsh\n}`, 2], // opens a group at the line's end
    [`cat <<'EOF' | (\n${WRITE}\nEOF\nsh\n)`, 2],
    [`( cat <<'EOF' ) > f\n${WRITE}\nEOF`, 0],
  ]);
});

test('open group: zsh short forms open a group with a brace, and either shell may read a reserved word there', () => {
  rows([
    [piped('if true {', '}'), 2],
    [piped('for x (a) {', '}'), 2],
    [piped('while true {', '}'), 2],
    [piped('repeat 1 {', '}'), 2],
    [piped('function f {', '}\nf'), 2],
    [piped('function f()\n{', '}\nf'), 2],
    [after('function f { :; }'), 0],
  ]);
});

test('open group: a heredoc body that holds closers of its own closes none of the group the next heredoc stands in', () => {
  rows([
    [`( cat <<'EOF' >/dev/null\n)\nEOF\ncat <<'EOF'\n${WRITE}\nEOF\n) | sh`, 2],
    [`{ cat <<'EOF' >/dev/null\n}\nEOF\ncat <<'EOF'\n${WRITE}\nEOF\n} | sh`, 2],
    [`if true; then cat <<'EOF' >/dev/null\nfi\nEOF\ncat <<'EOF'\n${WRITE}\nEOF\nfi | sh`, 2],
    [`( cat <<'EOF' >/dev/null\n)\nEOF\n)\ncat > f <<'EOF'\n${WRITE}\nEOF`, 0],
  ]);
});

test('open group: a closer spelled with a quote or an escape is a word of its own to both shells, and closes nothing', () => {
  rows([
    [piped('if true; then :;\nf""i\n:', 'fi'), 2],
    [piped("for x in a; do :;\nd''one\n:", 'done'), 2],
    [piped('case x in x) :\ne""sac\n:', ';; esac'), 2],
    [piped('{ :;\n}""\n:', '}'), 2],
    [piped('if true; then :;\nf\\i\n:', 'fi'), 2],
    [after('if true; then :;\nfi'), 0],
  ]);
});

test('open group: a compound command glued to the `)` of a function header opens its group', () => {
  rows([
    [doc('f()if true; then\ncat', 'fi\nf | sh'), 2],
    [doc('f()for x in a; do\ncat', 'done\nf | sh'), 2],
    [doc('f()while false; do\ncat', 'done\nf | sh'), 2],
    [after('f()if true; then :; fi'), 0],
  ]);
});

// ---- 1.10.1 T2 (section 3, config), second set ------------------------------------------------------------
const HISTORY_SENTENCE = (agent = 'omelette-coder') => `${agent} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`;
const CONFIG_SENTENCE = (agent = 'omelette-coder') => `${agent} never writes git config (a git config write, or an alias or include set with -c or --config-env); report instead`;
const UNREAD_SENTENCE = `${HISTORY_SENTENCE()} — a command substitution where git or its subcommand goes is not read`;

/** Each row `[command, sentence]`: refused with exactly that sentence on stderr, or passing in silence where it is ''. */
function said(list, agent = 'omelette-coder') {
  const path = guard();
  for (const [command, sentence] of list) {
    const r = spawnSync(process.execPath, [path], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: agent, tool_input: { command } }),
      encoding: 'utf8', timeout: 20000,
    });
    assert.equal(r.signal, null, `the guard hung on ${JSON.stringify(command)}`);
    assert.equal(r.status, sentence ? 2 : 0, `${JSON.stringify(command)} → ${r.status} ${r.stderr}`);
    assert.equal((r.stderr || '').trim(), sentence, JSON.stringify(command));
  }
}

test('git config: a read stays a read behind the plumbing an ordinary command carries — a redirection, a pipe, a list, a comment', () => {
  said([
    ['git config user.name 2>/dev/null', ''],
    ['git config --get user.email 2>&1', ''],
    ['git config user.name >/dev/null', ''],
    ['git config --get remote.origin.url > out.txt', ''],
    ['git config user.name | cat', ''],
    ['git config user.name || echo none', ''],
    ['git config user.name && git log', ''],
    ['git config --get a.b # then set it', ''],
    ['echo "$(git config user.name)"', ''],
    ['x=$(git config --get user.email)', ''],
    ['git config -l 2>/dev/null | grep user', ''],
    // …and the same words with a second positional are a write whatever follows them
    ['git config user.name x 2>/dev/null', CONFIG_SENTENCE()],
    ['git config user.name x | cat', CONFIG_SENTENCE()],
  ]);
});

test('git config: a write is a write wherever the shell runs it — a wrapper, a substitution, a group, a quoted program, a pipeline', () => {
  const write = 'git config core.hooksPath /tmp/h';
  said([
    [`env A=1 ${write}`, CONFIG_SENTENCE()],
    [`command ${write}`, CONFIG_SENTENCE()],
    [`timeout 5 ${write}`, CONFIG_SENTENCE()],
    [`A=1 ${write}`, CONFIG_SENTENCE()],
    [`echo $(${write})`, CONFIG_SENTENCE()],
    [`echo \`${write}\``, CONFIG_SENTENCE()],
    [`cat <(${write})`, CONFIG_SENTENCE()],
    [`(${write})`, CONFIG_SENTENCE()],
    [`{ ${write}; }`, CONFIG_SENTENCE()],
    [`if true; then ${write}; fi`, CONFIG_SENTENCE()],
    [`sh -c '${write}'`, CONFIG_SENTENCE()],
    [`sh -c "sh -c 'git config --unset a.b'"`, CONFIG_SENTENCE()],
    [`${write} | cat`, CONFIG_SENTENCE()],
    [`true && ${write}`, CONFIG_SENTENCE()],
    [`git -C . ${write.slice(4)}`, CONFIG_SENTENCE()],
    [`git --no-pager ${write.slice(4)}`, CONFIG_SENTENCE()],
    [`git -c core.pager=cat ${write.slice(4)}`, CONFIG_SENTENCE()],
    // neighbours that read
    ['env A=1 git config --get core.hooksPath', ''],
    ['sh -c "git config --get core.hooksPath"', ''],
    ['echo $(git config --get core.hooksPath)', ''],
  ]);
});

test('config and history together: a history write, or an unread invocation, anywhere in the command keeps the sentence 1.10.0 printed', () => {
  const config = 'git config --unset a.b';
  said([
    [`${config}; git commit -m x`, HISTORY_SENTENCE()],
    [`git commit -m x; ${config}`, HISTORY_SENTENCE()],
    [`sh -c '${config}; git commit -m x'`, HISTORY_SENTENCE()],
    [`sh -c '${config}'; sh -c 'git commit -m x'`, HISTORY_SENTENCE()],
    [`sh -c 'git commit -m x'; sh -c '${config}'`, HISTORY_SENTENCE()],
    [`echo $(${config}) $(git commit -m x)`, HISTORY_SENTENCE()],
    [`echo $(git commit -m x) $(${config})`, HISTORY_SENTENCE()],
    [`git -c alias.x=y status; git commit -m x`, HISTORY_SENTENCE()],
    [`${config}; sh -c 'sh -c "git commit"'`, HISTORY_SENTENCE()],
    [`sh -c '${config}; git -C $(pwd) status'`, UNREAD_SENTENCE],
    [`${config}; echo $(git -C $(pwd) status)`, UNREAD_SENTENCE],
    [`git -c alias.x=y status; git -C $(pwd) status`, UNREAD_SENTENCE],
    // the config class alone keeps its own sentence, however many invocations of it and wherever they sit
    [`${config}; ${config}`, CONFIG_SENTENCE()],
    [`git -c alias.x=y status; ${config}`, CONFIG_SENTENCE()],
    [`echo $(${config}); echo $(git status)`, CONFIG_SENTENCE()],
    // a write nested past the depth the guard reads is refused as it always was: with the history sentence
    ['echo $(echo $(echo $(echo $(echo $(echo $(git config --unset a))))))', HISTORY_SENTENCE()],
  ]);
});

test('git -c / --config-env: an alias or include key is read after other global options, among several -c, and behind xargs', () => {
  said([
    ['git -C . -c alias.ci=commit ci', CONFIG_SENTENCE()],
    ['git --no-pager -c alias.ci=commit ci', CONFIG_SENTENCE()],
    ['git -c user.name=a -c core.pager=cat -c alias.ci=commit ci', CONFIG_SENTENCE()],
    ['git --config-env user.name=N -c alias.x=y status', CONFIG_SENTENCE()],
    ['git -c alias.x=y --version', CONFIG_SENTENCE()],
    ['git -c "alias".x=y status', CONFIG_SENTENCE()],
    ["git -c 'alias'.x=y status", CONFIG_SENTENCE()],
    ['git -c $\'\\x61lias.x=y\' status', CONFIG_SENTENCE()],
    ['xargs git -c alias.x=y status', CONFIG_SENTENCE()],
    ['env A=1 git -c include.path=f status', CONFIG_SENTENCE()],
    ['sh -c "git -c alias.x=y status"', CONFIG_SENTENCE()],
    ['echo $(git -c alias.x=y status)', CONFIG_SENTENCE()],
    // an option of the subcommand that is spelled `-c` is no global option
    ['git log -c alias.x=y', ''],
    ['git diff -c alias.x=y', ''],
    ['git -C alias.x=y status', ''],
    ['git -c core.pager=cat log -c', ''],
  ]);
});

test('the config sentence names whichever role was caught, for all six guarded roles', () => {
  for (const agent of ['omelette-coder', 'omelette-coder-medium', 'omelette-coder-hard', 'omelette-coder-xhard', 'omelette-tester', 'omelette-reviewer']) {
    said([
      ['git config --unset a.b', CONFIG_SENTENCE(agent)],
      ['git -c alias.x=y status', CONFIG_SENTENCE(agent)],
      ['git commit -m x', HISTORY_SENTENCE(agent)],
      ['git config --get a.b', ''],
    ], agent);
  }
});

test('the config scan is linear — 128 000 options, positionals or -c keys, and 256 000 invocations, each in three times the local time', () => {
  // Budgets at three times the local time (in the comments), the fastest of up to three runs (1.10.1 release fix). One
  // `lastIndexOf` per item of the loop a row reads — configWrites' arguments, the global-option walk's words, the
  // invocations answered — took 13.8-28 s on the 128 000 rows and over 55 s on the 256 000 ones, where tokenizing the
  // command is most of the guard's time. The row of a `-c` value of 64 000 `$` is gone: a rescan of the rest of that
  // word per character cost at most 7 times the guard's own time, short of the 15 a budget at three times needs.
  const path = guard();
  const N = 128000;
  for (const [command, code, budget] of [
    [`git ${'-c user.x=y '.repeat(N)}-c alias.x=y status`, 2, 1400], // 454 ms
    [`${'git -calias.x=y '.repeat(2 * N)}status`, 2, 3400], //          1101 ms
    [`git config ${'--get '.repeat(N)}a.b`, 0, 800], //                  240 ms
    [`git config ${'a.b '.repeat(N)}`, 2, 700], //                       204 ms
    [`${'git config --get a.b; '.repeat(2 * N)}`, 0, 5500], //           1804 ms
  ]) {
    let fastest = Infinity;
    for (let k = 0; k < 3 && fastest >= budget; k++) {
      const started = process.hrtime.bigint();
      const r = fire(path, command);
      fastest = Math.min(fastest, Number(process.hrtime.bigint() - started) / 1e6);
      assert.equal(r.signal, null, `${command.slice(0, 40)}… hung`);
      assert.equal(r.status, code, `${command.slice(0, 40)}… → ${r.status} ${r.stderr}`);
    }
    assert.ok(fastest < budget, `${command.slice(0, 40)}… took ${fastest.toFixed(0)} ms`);
  }
});

// ---- 1.10.1 T2, second pass: lines a mutation of the guard left alive -------------------------------------------

test('git config: a word behind a bare `--` is a name even when it opens with a dash — `git config -- -x.y v` sets the key `-x.y`', () => {
  said([
    ['git config -- -x.y v', CONFIG_SENTENCE()], // git 2.38.1: writes [-x] y = v
    ['git config -- --get a.b c', CONFIG_SENTENCE()],
    ['git config -- -x.y', ''],
    ['git config -- a.b', ''],
  ]);
});

test('git config: a short cluster ends at `f`, whose value is the rest of the word — `-fx` names a file, and the names behind it still count', () => {
  said([
    ['git config -fx a.b c', CONFIG_SENTENCE()], // git 2.38.1: writes the key into the file `x`
    ['git config -zfx a.b c', CONFIG_SENTENCE()],
    ['git config -fx --list', ''],
    ['git config -fx a.b', ''],
    ['git config -zf x a.b c', CONFIG_SENTENCE()],
    ['git config -zf x a.b', ''],
  ]);
});

test('git -c: one refused key among several -c / --config-env refuses the command wherever it sits, whichever kind the others are', () => {
  said([
    ['git -c alias.x=y -c user.name=a status', CONFIG_SENTENCE()],
    ['git -c include.path=f -c core.pager=cat -c user.name=a log', CONFIG_SENTENCE()],
    ['git --config-env=alias.x=V --config-env=user.name=N status', CONFIG_SENTENCE()],
    ['git --config-env alias.x=V -c user.name=a status', CONFIG_SENTENCE()],
    ['git -c alias.x=y --config-env=user.name=N status', CONFIG_SENTENCE()],
    ['git -c user.name=a --config-env=user.email=N -c core.pager=cat log', ''],
  ]);
});

test('git -c: a key spelled `$"…"`, or a glued --config-env whose value ends in `git`, is read like any other', () => {
  said([
    ['git -c $"alias.x=y" status', CONFIG_SENTENCE()],
    ['git -c $"user.name=a" log', ''],
    ['git --config-env=alias.x=git status', CONFIG_SENTENCE()], // the walk stops at a word that ends in `git`
    ['git --config-env=alias.x=/usr/bin/git status', CONFIG_SENTENCE()],
    ['git --config-env=user.name=git log', ''],
  ]);
});

test('git -c / --config-env at the very end of a command is read to its end, and the command before it is still read', () => {
  said([
    ['git -c', ''],
    ['git --config-env', ''],
    ['git commit -m x; git -c', HISTORY_SENTENCE()],
    ['echo hi && git commit -m x && git -c', HISTORY_SENTENCE()],
    ['git commit -m x; git --config-env', HISTORY_SENTENCE()],
    ['git -c alias.x=y; git --config-env', CONFIG_SENTENCE()],
  ]);
});

test('a history write read by a subcommand reader keeps the history sentence beside an unread invocation — in either order', () => {
  said([
    ['git tag v1; git -C $(pwd) status', HISTORY_SENTENCE()],
    ['git -C $(pwd) status; git tag v1', HISTORY_SENTENCE()],
    ['git checkout -b x; git -C $(pwd) status', HISTORY_SENTENCE()],
    ['git branch x; echo $(git -C $(pwd) status)', HISTORY_SENTENCE()],
    ['git reset --hard; git -C $(pwd) status', HISTORY_SENTENCE()],
    ['git rebase main; git -C $(pwd) status', HISTORY_SENTENCE()],
    ['git symbolic-ref HEAD refs/heads/x; git -C $(pwd) status', HISTORY_SENTENCE()],
    ['git -C $(pwd) status; git config --unset a.b', UNREAD_SENTENCE],
  ]);
});

test('xargs hands git a name: each subcommand it writes by keeps its own sentence, and `config` its own', () => {
  said([
    ['xargs git tag', HISTORY_SENTENCE()],
    ['xargs git branch', HISTORY_SENTENCE()],
    ['xargs git checkout', HISTORY_SENTENCE()],
    ['xargs git switch', HISTORY_SENTENCE()],
    ['xargs git symbolic-ref', HISTORY_SENTENCE()],
    ['xargs git config', CONFIG_SENTENCE()],
    ['xargs git reset', ''],
    ['xargs git log', ''],
  ]);
});

test('git config: a lone `-` is a name, as the value of a write', () => {
  said([
    ['git config user.name -', CONFIG_SENTENCE()], // git 2.38.1: writes user.name = "-"
    ['git config --get user.name -', ''],
  ]);
});

// git config stops reading options at its first positional (PARSE_OPT_STOP_AT_NON_OPTION): everything behind the name
// is a positional. Measured on git 2.38.1 in a throwaway repo: `git config core.fsmonitor /tmp/x.sh --get` exits 0 and
// writes [core] fsmonitor = /tmp/x.sh; so do `alias.ci commit -l` and `core.hooksPath /tmp/h --get-regexp`.
// The spec: "git config is read by its arguments, and only a read passes". This test FAILS on the T2 diff.
test('git config: a read flag BEHIND the first positional is a positional, not a read mode — the write still writes', () => {
  said([
    ['git config core.fsmonitor /tmp/x.sh --get', CONFIG_SENTENCE()],
    ['git config alias.ci commit -l', CONFIG_SENTENCE()],
    ['git config --global core.hooksPath /tmp/h --list', CONFIG_SENTENCE()],
    ['git config core.hooksPath /tmp/h --get-regexp', CONFIG_SENTENCE()],
    ['git config alias.ci commit --get-all', CONFIG_SENTENCE()],
    ['git config a.b --get', CONFIG_SENTENCE()],
    // the same flags in front of the name still read
    ['git config --get core.fsmonitor', ''],
    ['git config --global --get-regexp core', ''],
    ['git config --get a.b pattern', ''],
  ]);
});

// ---- 1.10.1 T2, after fix round 2 ---------------------------------------------------------------------------

test('git config: an option-shaped word the shell fills in, quoted or not, is refused unread — with X=unset it is `--unset`', () => {
  said([
    ['git config "--$X" a.b', UNREAD_SENTENCE],
    ['git config "-$X" a.b', UNREAD_SENTENCE],
    ['git config --$X a.b', UNREAD_SENTENCE],
    ['git config "--unset$X" a.b', UNREAD_SENTENCE],
    ['git config --"$X" a.b', UNREAD_SENTENCE],
    // a value held whole by its quotes, after the `=` or detached, is one word and is read
    ['git config --file="$F" --get a.b', ''],
    ['git config --file "$F" --get a.b', ''],
  ]);
});

// ---- 1.10.1 T3, work thrown away ----------------------------------------------------------------------------------
// Every git fact was measured on git 2.38.1 and 2.54.0 by argv in throwaway repositories (a modified tracked file
// overwritten, or an untracked one deleted).

const TREE_SENTENCE = (agent = 'omelette-coder') => `${agent} never discards work in the tree (a checkout of paths, a forced checkout or switch, a restore of the work tree, a clean); report instead`;

test('tree forms: a word the shell unquotes reaches git as the same option — quoted, escaped or $-quoted, the verdict holds', () => {
  said([
    ['git checkout "-f" main', TREE_SENTENCE()],
    ["git checkout '--force' main", TREE_SENTENCE()],
    ["git checkout '--' .", TREE_SENTENCE()],
    ["git checkout $'-f' main", TREE_SENTENCE()],
    ['git checkout \\-f main', TREE_SENTENCE()],
    ['git checkout --f"orce" main', TREE_SENTENCE()],
    ["git switch '-f' main", TREE_SENTENCE()],
    ['git restore "--worktree" f', TREE_SENTENCE()],
    ["git clean '-f' -d", TREE_SENTENCE()],
    ['git restore "--staged" f', ''],
    ["git restore '-S' f", ''],
    ["git clean '-n'", ''],
    ['git clean -"n"', ''],
    ['git checkout "main"', ''],
  ]);
});

test('tree forms: a form read inside sh -c, a substitution or a wrapper keeps the tree sentence', () => {
  said([
    ['sh -c "git restore ."', TREE_SENTENCE()],
    ["bash -c 'git checkout -- .'", TREE_SENTENCE()],
    ['echo $(git clean -fd)', TREE_SENTENCE()],
    ['timeout 5 git clean -fd', TREE_SENTENCE()],
    ['env FOO=1 git restore .', TREE_SENTENCE()],
    ['FOO=1 git switch -f main', TREE_SENTENCE()],
    ['git -C /tmp/x checkout -- .', TREE_SENTENCE()],
    ['git -c core.pager=cat restore f', TREE_SENTENCE()],
    ['sh -c "git restore --staged f"', ''],
    ['timeout 5 git clean -n', ''],
  ]);
});

test('tree forms: the same sentence for every guarded role, and a word that only names a subcommand is not one', () => {
  for (const agent of ['omelette-coder-medium', 'omelette-coder-hard', 'omelette-coder-xhard']) {
    said([['git clean -fd', TREE_SENTENCE(agent)]], agent);
  }
  said([
    ['echo restore', ''],
    ['make clean', ''],
    ['npm run clean', ''],
    ['git log --grep=clean', ''],
    ['git log --grep=restore -- clean', ''],
    ['git show HEAD:restore', ''],
    ['git branch --list "clean*"', ''],
  ]);
});

test('tree forms: 128 000 repeated options and 256 000 chained invocations are answered in three times the local time', () => {
  // Budgets at three times the local time (in the comments), the fastest of up to three runs (1.10.1 release fix). One
  // `lastIndexOf` per argument in gitArguments, per letter of a cluster, or per invocation answered took 13.7-57 s on
  // the 128 000 rows and over 55 s on the 256 000 ones, where tokenizing the command is most of the guard's time.
  const path = guard();
  const N = 128000;
  for (const [command, code, budget] of [
    ['git checkout main' + ' -q'.repeat(N), 0, 900], //                  270 ms
    ['git checkout main' + ' --no-force'.repeat(N), 0, 1100], //         360 ms
    ['git switch main' + ' --no-force'.repeat(N), 0, 1100], //           355 ms
    ['git restore --staged' + ' --stag'.repeat(N) + ' f', 0, 1000], //   311 ms
    ['git restore --staged' + ' -sX'.repeat(N) + ' f', 0, 700], //       211 ms
    ['git clean -n' + ' -e x'.repeat(N), 0, 900], //                     290 ms
    ['git clean -' + 'n'.repeat(N), 0, 600], //                          171 ms
    ['git restore --staged f ; '.repeat(2 * N), 0, 5500], //             1806 ms
    ['git clean -n ; '.repeat(2 * N), 0, 4000], //                       1308 ms
    ['git checkout main -f' + ' -q'.repeat(N), 2, 600], //               191 ms
  ]) {
    let fastest = Infinity;
    for (let k = 0; k < 3 && fastest >= budget; k++) {
      const started = process.hrtime.bigint();
      const r = fire(path, command);
      fastest = Math.min(fastest, Number(process.hrtime.bigint() - started) / 1e6);
      assert.equal(r.signal, null, `${command.slice(0, 30)}… hung`);
      assert.equal(r.status, code, `${command.slice(0, 30)}… → ${r.status} ${r.stderr}`);
    }
    assert.ok(fastest < budget, `${command.slice(0, 30)}… took ${fastest.toFixed(0)} ms`);
  }
});

// ---- 1.10.1 T3, second pass: gaps the mutation sweep found --------------------------------------------------------
// Each refused form below was run against git 2.38.1 (and 2.54.0 unless noted) by argv in a throwaway repository and
// overwrote a modified tracked file or deleted an untracked one.

test('tree forms: a value is taken by the right option — a negated option, an attached value and a cluster that ends in its value take no next word', () => {
  said([
    ['git checkout --no-conflict HEAD f1', TREE_SENTENCE()], // `--no-conflict` has no value: `HEAD` is a tree-ish, `f1` a path
    ['git checkout --no-pathspec-from-file HEAD f1', TREE_SENTENCE()],
    ['git checkout --conflict=merge HEAD f1', TREE_SENTENCE()], // git 2.38.1; 2.54 refuses `--conflict` with paths itself
    ['git restore -SsHEAD --worktree f1', TREE_SENTENCE()], // `-sHEAD` is the value of `-s`: `--worktree` is an option again
    ['git checkout --no-conflict main', ''],
    ['git checkout --conflict=merge main', ''],
    ['git restore -SsHEAD f1', ''],
    ['git restore --staged --source=HEAD f1', ''],
  ]);
});

test('restore and clean: an unquoted expansion glued to a long option, or the value of `-e`/`--exclude`, may split into more words — refused', () => {
  said([
    ['git restore --staged --source=$R f1', TREE_SENTENCE()], // R='HEAD --worktree'
    ['git clean -n --exclude=$P', TREE_SENTENCE()], // P='x --no-dry-run -f'
    ['git clean -n -e $P', TREE_SENTENCE()],
    ['git clean -n --exclude $P', TREE_SENTENCE()],
    ['git clean -n -$X', TREE_SENTENCE()],
    ['git restore --staged --source="$R" f1', ''], // quoted whole: one word
    ['git clean -n -e "$P"', ''],
    ['git clean -n --exclude="$P"', ''],
  ]);
});

test('checkout: a bracket glob is a pathspec like `*` and `?`', () => {
  said([
    ["git checkout 'f[12]'", TREE_SENTENCE()],
    ["git checkout 'src/[a]'", TREE_SENTENCE()],
    ['git checkout feat/x', ''],
  ]);
});

// 1.10.1 fix round, second set (clean-context tester): forms the release-review fixes imply and the first set leaves unpinned.

test('checkout: a word with two slashes in a row is no ref name — git restores the path, so it is refused as one', () => {
  // Measured on git 2.38.1 and 2.54.0: `git checkout src//a.txt` rewrites the modified tracked src/a.txt ("Updated 1 path
  // from the index"), and `git check-ref-format --branch src//a.txt` refuses the name. The release fix reads a word "no
  // ref name can be" at the dot, `.lock`, blank, backslash and final-dot rules; this is the same class (check-ref-format
  // rule 6), unlisted. A defect found by this tester, not a line of the spec's list.
  said([
    ['git checkout src//a.txt', TREE_SENTENCE()],
    ['git checkout src///a.txt', TREE_SENTENCE()],
    ['git checkout a//b', TREE_SENTENCE()],
    ['git checkout -q src//a.txt', TREE_SENTENCE()],
    ['git checkout src/a.txt', ''], // a name a branch could have (D2)
    ['git checkout feat/x', ''],
  ]);
});

test('checkout: revision syntax is taken off before the path rules — what its braces hold is no component, what stands outside them still is', () => {
  // The braces of `@{…}` and `^{…}` may hold a dot, `..`, `.lock`, a final dot or a backslash (a date, a log message);
  // outside them every rule of the word still applies, whichever side the braces stand on.
  said([
    ["git checkout 'HEAD^{/a..b}'", ''],
    ["git checkout 'HEAD^{/.hidden}'", ''],
    ["git checkout 'HEAD^{/x.lock}'", ''],
    ["git checkout 'HEAD^{/end.}'", ''],
    ["git checkout 'HEAD^{/a....b}'", ''],
    ["git checkout 'HEAD^{/a\\b}'", ''],
    ['git checkout HEAD@{2.days.ago}', ''],
    ['git checkout main@{upstream}', ''],
    ["git checkout 'src/.env@{1}'", TREE_SENTENCE()],
    ["git checkout 'x.lock^{/a b}'", TREE_SENTENCE()],
    ["git checkout 'a..b^{/ok}'", TREE_SENTENCE()],
    ["git checkout 'a b^{/ok}'", TREE_SENTENCE()],
    ["git checkout 'HEAD^{/a b}.lock'", TREE_SENTENCE()],
    ["git checkout 'HEAD^{/a b}/.x'", TREE_SENTENCE()],
    ["git checkout 'HEAD^{/a b}..x'", TREE_SENTENCE()],
    ["git checkout 'HEAD^{/a b}.'", TREE_SENTENCE()],
  ]);
});

test('checkout: the path rules hold with options around the word, behind wrappers and in a quoted re-read; a name only like a lock or a version passes', () => {
  said([
    ['git checkout -q src/.env', TREE_SENTENCE()],
    ['git checkout --detach x.lock', TREE_SENTENCE()],
    ['git checkout -m yarn.lock', TREE_SENTENCE()],
    ['git checkout --conflict merge src/.env', TREE_SENTENCE()],
    ['git checkout --no-guess yarn.lock', TREE_SENTENCE()],
    ['git checkout --end-of-options src/.env', TREE_SENTENCE()],
    ['git -C sub checkout src/.env', TREE_SENTENCE()],
    ['env git checkout yarn.lock', TREE_SENTENCE()],
    ['time git checkout x.lock', TREE_SENTENCE()],
    ["sh -c 'git checkout src/.env'", TREE_SENTENCE()],
    ['bash -c "git checkout yarn.lock"', TREE_SENTENCE()],
    ['git checkout "yarn".lock', TREE_SENTENCE()], // the shell joins the pieces
    ['git checkout y\\arn.lock', TREE_SENTENCE()],
    ["git checkout $'src/.env'", TREE_SENTENCE()],
    ["git checkout $'a\\x20b'", TREE_SENTENCE()],
    ['git checkout x.lock; git status', TREE_SENTENCE()],
    ['git checkout x.lock.bak', ''], // ends with .bak: a legal branch name on both gits
    ['git checkout a.lockfile', ''],
    ['git checkout x.LOCK', ''], // git compares ".lock" in lower case
    ['git checkout my.lock.branch', ''],
    ['git checkout user/jane.doe/fix-1.2', ''],
    ['git checkout v1.2.3-rc.1+build.5', ''],
    ['git switch src/.env', ''], // switch restores no path
    ['git switch --detach x.lock', ''],
  ]);
});

test('restore and clean: a glob glued to an option or in an earlier option is refused; a quoted or escaped one, and any behind `--`, is not', () => {
  said([
    ['git restore --staged --source=HEAD~* f', TREE_SENTENCE()],
    ['git restore --staged -sHEAD* f', TREE_SENTENCE()],
    ['git restore --stag* f', TREE_SENTENCE()],
    ['git restore --staged f* -- x', TREE_SENTENCE()],
    ['git restore --staged f*.md --end-of-options x', TREE_SENTENCE()],
    ['git clean -n --exclude=*.o', TREE_SENTENCE()],
    ['git clean -n -e*.o', TREE_SENTENCE()],
    ['git clean --dry-run [a-z]', TREE_SENTENCE()],
    ["git restore --staged --source=HEAD~'*' f", ''],
    ['git restore --staged --source="HEAD*" f', ''],
    ["git restore --staged $'f\\x2a'", ''], // ANSI-C quoting: a literal `*`
    ['git restore --staged f\\[a]', ''],
    ['git restore --staged f[a', ''], // no closing bracket: the shell keeps the word
    ['git restore --staged -- f* --worktree', ''], // behind `--` every word is a path
    ['git restore --staged --end-of-options f* --worktree', ''],
    ['git restore --staged f -- x*', ''],
    ["git clean -n --exclude='*.o'", ''],
    ["git clean -n -e'*.o'", ''],
    ['git clean -nd -- *', ''],
    ['git clean -n -- -f *', ''],
  ]);
});

test('open group: `function NAME` opens its group behind a prefix that leads a command, whatever the NAME is spelled with', () => {
  // bash 4 and later: the compound command behind `function NAME` is the function's body. Not run under such a bash here.
  const loop = (head) => `${head} while true\ndo cat <<'EOF'\n${WRITE}\nEOF\nbreak; done\nf | sh`;
  rows([
    [loop('time function f'), 2],
    [loop('! function f'), 2],
    [loop('true && function f'), 2],
    [loop('echo x; function f'), 2],
    [loop('if true; then function f'), 2],
    [loop('function f\u0009'), 2], // a tab between the NAME and the word
    [loop('function  f  '), 2],
    [loop('function f$(echo)'), 2], // a NAME that holds a substitution is still one word
    [loop('function ${f}'), 2],
    [loop('function "f g"'), 2],
    [loop('function f; function g'), 2],
    [`function f while true\ndo cat <<'EOF'\necho hello\nEOF\nbreak; done\nf | sh`, 0], // a harmless body stays text
  ]);
});

// 1.10.1 fix round, second pass (mutation check): rows for the mutants the first two sets let through.

test('restore and clean: a `]` that stands before every `[` closes nothing — the word is kept as written, no glob', () => {
  // The shell needs a `]` AFTER the `[` to read a bracket expression; "brackets without a closer" pass (requirement 2).
  said([
    ['git restore --staged ]x[', ''],
    ['git restore --staged ][', ''],
    ['git clean -n a]b[c', ''],
    ['git restore --staged [x]', TREE_SENTENCE()],
    ['git restore --staged ]x[y]', TREE_SENTENCE()], // a closer after the second `[`
    ['git clean -n []x', TREE_SENTENCE()],
  ]);
});

test('git config: every short letter but the six it knows (e f h l t z) is a write word in a cluster or alone — none is read as inert or valued', () => {
  // `git config -h` lists them on 2.38.1; a one-letter probe of a-z, A-Z on 2.38.1 and 2.54 finds exactly e, f, h, l, t, z.
  const known = new Set([...'efhltz']);
  const rows = [];
  for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (known.has(c)) continue;
    rows.push([`git config -${c} --get a.b`, CONFIG_SENTENCE()], [`git config -l${c} a.b`, CONFIG_SENTENCE()]);
  }
  said(rows);
});
