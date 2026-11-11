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

test('the config scan is linear — 32 000 options, positionals, -c keys or glued values answer in a few seconds, not minutes', () => {
  const path = guard();
  const shapes = [
    `git ${'-c user.x=y '.repeat(32000)}-c alias.x=y status`,
    `${'git -calias.x=y '.repeat(32000)}status`,
    `git config ${'--get '.repeat(32000)}a.b`,
    `git config ${'a.b '.repeat(32000)}`,
    `${'git config --get a.b; '.repeat(32000)}`,
    `git -c user.x=${'$'.repeat(64000)} status`,
  ];
  for (const command of shapes) {
    const started = Date.now();
    const r = fire(path, command);
    assert.equal(r.signal, null, 'the guard hung');
    assert.ok(Date.now() - started < 8000, `${command.slice(0, 40)}… took ${Date.now() - started} ms`);
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
