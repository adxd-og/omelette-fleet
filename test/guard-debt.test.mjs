/**
 * omelette-fleet :: test/guard-debt.test.mjs
 * 1.10.1, the guard debt. The rendered guard is fired as Claude Code fires it —
 * a child process, the event on stdin, exit 2 refuses — and every refused line
 * stands beside a neighbour that passes.
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
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-debt-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3'));
  return path;
}

/** One hook invocation: the event on stdin, the answer as code/stderr, and how long it took. */
function fire(path, input) {
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [path], { input: JSON.stringify(input), encoding: 'utf8', timeout: 20000 });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, err: r.stderr || '', ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

const preToolUse = (command) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: 'omelette-coder', tool_input: { command },
});

const REFUSAL = 'omelette-coder never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead';
const WRITE = 'git commit -m x';

/** Each row `[command, code]`: 2 is refused with the role's sentence, 0 passes in silence. */
function rows(list) {
  const path = guard();
  for (const [command, code] of list) {
    const r = fire(path, preToolUse(command));
    assert.equal(r.code, code, `${JSON.stringify(command)} → ${r.code} ${r.err}`);
    assert.equal(r.err.trim(), code === 2 ? REFUSAL : '', JSON.stringify(command));
  }
}

const CONFIG_REFUSAL = 'omelette-coder never writes git config (a git config write, or an alias or include set with -c or --config-env); report instead';
const UNREAD_REFUSAL = `${REFUSAL} — a command substitution where git or its subcommand goes is not read`;

/** Each row `[command, sentence]`: refused with that sentence, or passing in silence where it is ''. */
function said(list) {
  const path = guard();
  for (const [command, sentence] of list) {
    const r = fire(path, preToolUse(command));
    assert.equal(r.code, sentence ? 2 : 0, `${JSON.stringify(command)} → ${r.code} ${r.err}`);
    assert.equal(r.err.trim(), sentence, JSON.stringify(command));
  }
}

/** `head <<'EOF'`, the git write as its body, the terminator, then `tail`. */
const doc = (head, tail = '') => `${head} <<'EOF'\n${WRITE}\nEOF\n${tail}`;
/** The same heredoc piped to a shell by the group `open` leaves open and `close` closes two lines later. */
const piped = (open, close) => doc(`${open}\ncat`, `${close} | sh`);
/** A heredoc to a file on the line after `line`: its body is text unless `line` left a group open. */
const after = (line) => doc(`${line}\ncat > f`);

test('heredoc: a body handed to `awk -f /dev/stdin` or `awk -f -` is a command; one with no git write in it passes', () => {
  rows([
    [`awk -f /dev/stdin <<'EOF'\nBEGIN{system("${WRITE}")}\nEOF`, 2],
    [`awk -f - <<'EOF'\nBEGIN{system("${WRITE}")}\nEOF`, 2],
    ["awk '{print $1}' <<'EOF'\nhello\nEOF", 0],
  ]);
});

test('heredoc: a body handed to `sed -f -` or `sed -f /dev/stdin` is a command; one with no git write in it passes', () => {
  rows([
    [`sed -f - f.txt <<'EOF'\n1e ${WRITE}\nEOF`, 2],
    [`sed -f /dev/stdin f.txt <<'EOF'\n1e ${WRITE}\nEOF`, 2],
    ["sed s/a/b/ <<'EOF'\nhello\nEOF", 0],
  ]);
});

test('heredoc: awk runs its stdin with no `-f` on the line, so the program is out of the set — `grep` and `cat` stay in it', () => {
  rows([
    [`awk 'BEGIN{system("sh")}' <<'EOF'\n${WRITE}\nEOF`, 2],
    [`grep x <<'EOF'\n${WRITE}\nEOF`, 0],
    [`cat > f <<'EOF'\n${WRITE}\nEOF`, 0],
  ]);
});

test('open group: a heredoc inside a `(` still open at its line\'s end has its body read as a command', () => {
  rows([
    [`(cat <<'EOF'\n${WRITE}\nEOF\n) | sh`, 2],
    ["(cat <<'EOF'\nhello\nEOF\n) | sh", 0],
    [`(true); cat > f <<'EOF'\n${WRITE}\nEOF`, 0], // closed before the heredoc's line
  ]);
});

test('open group: a heredoc inside a `{` still open at its line\'s end has its body read as a command', () => {
  rows([
    [`{ cat <<'EOF'\n${WRITE}\nEOF\n} | sh`, 2],
    ["{ cat <<'EOF'\nhello\nEOF\n} | sh", 0],
    [after('{ true; }'), 0],
  ]);
});

test('open group: a heredoc inside an `if` still open at its line\'s end has its body read as a command', () => {
  rows([
    [`if true; then cat <<'EOF'\n${WRITE}\nEOF\nfi | sh`, 2],
    ["if true; then cat <<'EOF'\nhello\nEOF\nfi | sh", 0],
    [after('if true; then :; fi'), 0],
  ]);
});

test('open group: a loop, a `case` and a function body are groups, each until the word that closes it', () => {
  rows([
    [piped('while true; do', 'done'), 2],
    [after('while false; do :; done'), 0],
    [piped('until false; do', 'done'), 2],
    [after('until true; do :; done'), 0],
    [piped('for x in a; do', 'done'), 2],
    [after('for x in a; do :; done'), 0],
    [piped('select x in a; do', 'done'), 2],
    [after('select x in a; do :; done'), 0],
    [piped('case x in\nx)', ';;\nesac'), 2],
    [after('case x in x) : ;; esac'), 0],
    [doc('f() {\ncat', '}\nf | sh'), 2], // what the function prints is fed three lines after its body
    [after('f() { :; }'), 0],
  ]);
});

test('open group: what is no group opens none — and closes none of the one it stands in', () => {
  const alone = [
    '((1 + 2))', 'x=$(echo a)', 'x=`echo a`', 'diff <(echo a) <(echo b)', 'a=(1 2 3)', 'a[1]=x', 'case x in a) : ;; esac', 'case if in a) : ;; if) : ;; esac',
    'echo {a,b}',
    "echo '(' '{' 'if'", 'echo \\( \\{', 'echo if for while case',
  ];
  rows([
    ...alone.map((line) => [after(line), 0]),
    // Inside a `(`, none of them is its `)`: the body is still the open group's.
    ...alone.map((line) => [piped(`( ${line}`, ')'), 2]),
    // An array's words are no reserved words (bash 3.2 and zsh both keep `fi` as an element), in an `if` as anywhere.
    [piped('if true; then a=(1\nfi\n)', 'fi'), 2],
    [after('a=(1\nfi\n)'), 0],
  ]);
});

test('open group: an opener is counted where either shell reads one', () => {
  rows([
    [piped('>/dev/null if true; then', 'fi'), 2], //  zsh reads a reserved word past a redirection, bash does not
    [piped('time -p if true; then', 'fi'), 2], //    bash reads one past `time -p`, zsh does not
    [piped('f() if true; then', 'fi\nf'), 2], //     both: a function's body is any compound command
    [piped('if(true); then', 'fi'), 2], //           bash reads `if` glued to a `(`
    [piped('if true; then if true; then :; fi', 'fi'), 2], // the inner `fi` closes the `if` that follows `then`
    [piped('coproc if true; then', 'fi'), 2], //     zsh reads a reserved word past `coproc`
    [piped('{echo a', '}'), 2], //                   zsh opens a group at a glued `{`, bash runs `{echo`
    [piped('{[[\n} ]] && :', '}'), 2], //             …and a `[[` with it, whose line `}` is a word
    [piped('{ :; } always {', '}'), 2], //           zsh's `always` block
    [piped('repeat 2; do', 'done'), 2], //           zsh's loops
    [piped('foreach x (a)', 'end'), 2],
    [after('echo if; echo for'), 0], //              an argument is no reserved word
    [after('time -p true'), 0],
  ]);
});

test('open group: an opener is counted after `function NAME` and `coproc NAME`, where bash 4 and later read a reserved word', () => {
  // bash 3.2 and zsh reject every refused form here (a syntax error); to bash 4 and later the compound command is
  // the function's or the coprocess's body, and the line under the heredoc feeds what it prints to a shell.
  const body = (open, close, feed = 'f | sh') => `${open} cat <<'EOF'\n${WRITE}\nEOF\n${close}\n${feed}`;
  const fromCoproc = 'sh <&"${C[0]}"';
  said([
    [body('function f while true\ndo', 'break; done'), REFUSAL],
    [body('function f if true\nthen', 'fi'), REFUSAL],
    [body('function f until false\ndo', 'break; done'), REFUSAL],
    [body('function f for i in 1\ndo', 'done'), REFUSAL],
    [body('coproc C while true\ndo', 'break; done', fromCoproc), REFUSAL],
    [body('function f select i in 1\ndo', 'break; done'), REFUSAL],
    [body('coproc C if true\nthen', 'fi', fromCoproc), REFUSAL],
    [body('coproc C for i in 1\ndo', 'done', fromCoproc), REFUSAL],
    // The NAME is one word whatever it spells, and the word after it the opener.
    [body('function if if true\nthen', 'fi', 'if | sh'), REFUSAL],
    [body('function -x while true\ndo', 'break; done', '-x | sh'), REFUSAL],
    [body('coproc function f while true\ndo', 'break; done'), REFUSAL], // `function` past `coproc` is the keyword, not its NAME
    // To bash a no-break space or a `\r` ends no word, nor does extglob's parenthesis: the NAME goes on past each.
    [body('function f\u00a0g while true\ndo', 'break; done'), REFUSAL],
    [body('function f\rg while true\ndo', 'break; done'), REFUSAL],
    [body('function +(x)c while true\ndo', 'break; done'), REFUSAL],
    // Refused before this rule: the heredoc's own line runs a program outside NON_EXEC — `function` or `coproc` when
    // the header stands on it, a pattern's `x)`.
    [body('function f while true; do', 'break; done'), REFUSAL],
    [body('function f case x in\nx)', ';; esac'), REFUSAL],
    [body('function f () if true; then', 'fi'), REFUSAL],
    [body('coproc C until false; do', 'break; done', fromCoproc), REFUSAL],
    // In argument position the two are plain words, and so is what follows them: the body is text.
    [doc('echo function while\ncat'), ''],
    [after('echo function f while true'), ''],
    [after('echo coproc C while true'), ''],
    // A NAME stands on its keyword's line, opens nothing by itself, and the group it leads closes where it did.
    [after('function\nf while'), ''],
    ['coproc cat', ''],
    ['coproc C { cat; }', ''],
    [after('coproc cat'), ''],
    [after('coproc C { cat; }'), ''],
    [after('coproc (grep {a,b} f)'), ''], //               a `(` that starts a word is no NAME, and none follows it
    [after('function cleanup { rm -f /tmp/{a,b}; }'), ''], // one word after the NAME, no more
    [after('function f g { :; }'), ''],
    [after('function f while false; do :; done'), ''],
    [after('coproc C while false; do :; done'), ''],
  ]);
});

test('open group: a closer is counted only where both shells read one', () => {
  const NBSP = '\u00a0';
  rows([
    [piped('if [[\nfi ]]; then', 'fi'), 2], //            both shells take a line of `[[ … ]]` as a word
    [after('if [[ -f x ]]; then :; fi'), 0],
    [piped(`if true; then :;\nfi${NBSP}`, 'fi'), 2], //   a word followed by a no-break space is `fi` to neither
    [after('if true; then :;\nfi\t'), 0], //              a tab is a blank
    [piped(`if true; then :;${NBSP}fi`, 'fi'), 2], //     …nor is a word that follows one
    [piped('if true; then :; >/dev/null fi', 'fi'), 2], // past a redirection bash runs a command named `fi`
    [piped('if true; then :; >fi', 'fi'), 2], //           …and a target named `fi` is a file
    [after('if true; then sleep 0 & fi'), 0], //          an `&` ends a command as `;` does
    [piped(`if [[ ]]${NBSP}x ==\nfi ]]; then :; else`, 'fi'), 2], // zsh: `]]` + no-break space is a word of the `[[`, not its end
    [piped('case esac in a|esac)', ';; esac'), 2], //     after `|` a pattern stands, in both shells
    [piped('if true; then case fi in\nfi) : ;;\nesac', 'fi'), 2], // a pattern on its own line is no `fi`
    [piped('{ echo a }', '}'), 2], //                     zsh closes at a `}` in argument position, bash does not
    [piped('( case x in a) : ;; esac', ')'), 2], //       a pattern's `)` is not the subshell's
    [piped('( case x in a) case y in b) : ;; esac ;; c) : ;; esac', ')'), 2], // …nor is one after a `case` inside a pattern's list
    [after('( case x in a) : ;; esac )'), 0],
    [after('if true; then :; f\\\ni'), 0], //             a backslash-newline inside the word joins it, in both shells
  ]);
});

test('open group: where the shells may end a nested text elsewhere, the group stays open', () => {
  rows([
    // Each `)` below is the substitution's or the quote's to bash 3.2 and zsh — to zsh alone where noted — and the
    // subshell's to a count of parentheses.
    [piped('( echo $(echo \\))', ')'), 2],
    [piped('( : $(echo a # )\n)', ')'), 2],
    [piped('( echo "$(echo ")")"', ')'), 2],
    [piped('( echo ${x:-")"}', ')'), 2],
    [piped('( echo "${x:-")"}"', ')'), 2],
    [piped('( echo ${x:-$(echo a # )}\n)}', ')'), 2], //    zsh reads the comment to its line's end
    [piped('( echo $(echo ${x:-a)})', ')'), 2], //          zsh: the first `)` is the expansion's; bash 3.2 stops at it
    [piped('( echo x >>(cat \\) >/dev/null)', ')'), 2], // zsh's substitution as a target
    [piped('( echo "`echo ")"`"', ')'), 2],
    [piped('( x=$(case a in a) echo hi;; esac)', ')'), 2], // zsh reads the pattern; bash 3.2 stops at its `)`
    [piped('( echo $(cat <<X\n)\nX\n)', ')'), 2], //        zsh reads the body; bash 3.2 stops at its `)`
    // Read alike, the same shapes close their group.
    [after('( echo $(echo a) )'), 0],
    [after('( cd "$(dirname \'a b\')" && echo "${x:-a}" )'), 0],
  ]);
});

test('open group: the depth is kept per character — 1 MB of parentheses in one word, or of nested texts in a group, is read in linear time', () => {
  const path = guard();
  const fill = (unit) => unit.repeat(Math.ceil((1 << 20) / unit.length));
  // Budgets at three times the local time (630, 310 and 410 ms): the first row took over a minute while each
  // parenthesis read the growing word.
  for (const [command, budget] of [[fill('a)'), 2000], [`( ${fill('$(echo \\)) ')}`, 1000], [`( ${fill('"$(a "b")" ')}`, 1300]]) {
    let fastest = Infinity;
    for (let k = 0; k < 3; k++) {
      const r = fire(path, preToolUse(command));
      assert.equal(r.code, 0, r.err);
      fastest = Math.min(fastest, r.ms);
    }
    assert.ok(fastest < budget, `${command.slice(0, 24)}… took ${fastest.toFixed(0)} ms`);
  }
});

test('open group: what a line of an open group prints is taken as run — a heredoc in its substitution, a script in its quoted word', () => {
  rows([
    [`( echo "$(cat <<'EOF'\n${WRITE}\nEOF\n)"\n) | sh`, 2],
    [`echo "$(cat <<'EOF'\n${WRITE}\nEOF\n)"`, 0],
    [`( echo 'bash <<EOF\n${WRITE}\nEOF'\n) | sh`, 2],
    [`echo 'bash <<EOF\n${WRITE}\nEOF'`, 0],
    // A quoted word of a program that runs nothing is text, whatever group it spells.
    [`echo '( cat <<EOF\n${WRITE}\nEOF\n) | sh'`, 0],
    [`bash -c '( cat <<EOF\n${WRITE}\nEOF\n) | sh'`, 2],
  ]);
});

test('git config: a write word among the options, or a write subcommand first, writes — in either spelling, and over a read mode', () => {
  said([
    ['git config --add a.b c', CONFIG_REFUSAL],
    ['git config --replace-all a.b c', CONFIG_REFUSAL],
    ['git config --unset a.b', CONFIG_REFUSAL],
    ['git config unset a.b', CONFIG_REFUSAL],
    ['git config --unset-all a.b', CONFIG_REFUSAL],
    ['git config --rename-section a b', CONFIG_REFUSAL],
    ['git config rename-section a b', CONFIG_REFUSAL],
    ['git config --remove-section a', CONFIG_REFUSAL],
    ['git config remove-section a', CONFIG_REFUSAL],
    ['git config -e', CONFIG_REFUSAL],
    ['git config --edit', CONFIG_REFUSAL],
    ['git config edit', CONFIG_REFUSAL],
    ['git config -ze', CONFIG_REFUSAL],
    ['git config set a.b c', CONFIG_REFUSAL],
    ['git config --global set a.b c', CONFIG_REFUSAL],
    ['git config a.b --unset', CONFIG_REFUSAL],
    ['git config --get --unset a.b', CONFIG_REFUSAL],
    ['git config --list --edit', CONFIG_REFUSAL],
    ['git config "--unset" a.b', CONFIG_REFUSAL],
    ['git config --get a.b', ''],
    ['git config get a.b', ''],
  ]);
});

test('git config: a read mode reads, in either spelling, whatever positionals follow it', () => {
  said([
    ['git config --get a.b', ''],
    ['git config get a.b', ''],
    ['git config --get a.b pattern', ''],
    ['git config --get-all a.b', ''],
    ['git config --get-regexp a', ''],
    ['git config --get-urlmatch http https://x', ''],
    ['git config --get-color color.diff.new red', ''],
    ['git config --get-colorbool color.ui', ''],
    ['git config -l', ''],
    ['git config --list', ''],
    ['git config list', ''],
    ['git config --global --list --show-origin', ''],
    ['git config --get a.b --unset-all', ''], // git 2.38.1: a read of a.b with the value pattern `--unset-all`
  ]);
});

test('git config: options end at the first positional — a read mode or a write word behind it is a positional, and the count decides', () => {
  said([
    ['git config core.fsmonitor /tmp/x.sh --get', CONFIG_REFUSAL], // git 2.38.1: sets core.fsmonitor
    ['git config a.b --get', CONFIG_REFUSAL], // …sets a.b to `--get`
    ['git config a.b --unset', CONFIG_REFUSAL],
    ['git config a.b -e', CONFIG_REFUSAL],
    ['git config a.b --add z', CONFIG_REFUSAL],
    ['git config a.b --', CONFIG_REFUSAL], // …sets a.b to `--`
    ['git config --get a.b --unset', ''], // a read with a value pattern
    ['git config --get a.b', ''],
    ['git config get a.b --unset', ''],
    ['git config set a.b --get', CONFIG_REFUSAL],
  ]);
});

test('git config: a long option is read by its unambiguous prefix — an abbreviated valued option takes the next word', () => {
  said([
    ['git config --fil --get x.q v', CONFIG_REFUSAL], // git 2.38.1: `--file=--get`, and sets x.q in it
    ['git config --comm --get user.name x', CONFIG_REFUSAL], // git 2.54: `--comment=--get`, and sets user.name
    ['git config --fil f --get x.q', ''],
    ['git config --file=f --get x.q', ''],
    ['git config --fil=--get x.q', ''],
    ['git config --get-c x', CONFIG_REFUSAL], // two read modes start so: git's usage error, refused
    ['git config --u a.b', CONFIG_REFUSAL],
  ]);
});

test('git config: a negated read mode among the options is a write word — a negated valued option takes no value, as git reads it', () => {
  said([
    ['git config --get --no-get a.b two', CONFIG_REFUSAL], // git 2.38.1: clears --get and sets a.b
    ['git config -l --no-list a.b two', CONFIG_REFUSAL],
    ['git config --get --no-get-all a.b', CONFIG_REFUSAL],
    ['git config --get --no-li a.b', CONFIG_REFUSAL],
    ['git config --get --no-g a.b', CONFIG_REFUSAL], // git's usage error: ambiguous
    ['git config --get --no-includes a.b', ''],
    ['git config --no-show-origin --get a.b', ''],
    ['git config --no-file --get a.b', ''], // git 2.38.1 and 2.54: `--no-file` takes no value, and reads a.b
    ['git config --no-type a.b two', CONFIG_REFUSAL], // …and `--no-type` none: a.b is set
    ['git config --get a.b --no-get', ''], // behind the name it is a value pattern
  ]);
});

test('git config: an expansion among the options is refused unread — in an option word, or a value the shell may split or drop', () => {
  said([
    ['git config --file $F --get a.b', UNREAD_REFUSAL], // F='.git/config core.fsmonitor /tmp/x.sh' sets the key
    ['git config -f $F -l', UNREAD_REFUSAL],
    ['git config --type $T --get a.b', UNREAD_REFUSAL],
    ['git config --file $(pwd)/f --get a.b', UNREAD_REFUSAL],
    ['git config --$X a.b', UNREAD_REFUSAL],
    ['git config "-$X" a.b', UNREAD_REFUSAL],
    ['git config -$X --get a.b', UNREAD_REFUSAL],
    ['git config --file=$F --get a.b', UNREAD_REFUSAL],
    ['git config -f"$F" --get a.b', UNREAD_REFUSAL], // empty, it is a bare `-f` taking `--get`
    ['git config --file "$F" --get a.b', ''],
    ['git config --file="$F" --get a.b', ''],
    ['git config -f "$HOME/.gitconfig" -l', ''],
    ["git config --file '$F' --get a.b", ''],
    ['git config --get $KEY', ''],
    ['git config --get "remote.$r.url"', ''],
    ['git config $X', UNREAD_REFUSAL],
  ]);
});

test('git config: an argument holding a brace expansion is refused unread, read mode or not; a quoted brace is text', () => {
  said([
    ['git config user.name{,}', UNREAD_REFUSAL], // the shell makes it two positionals
    ['git config {--unset,a.b}', UNREAD_REFUSAL], // …or an option and a name
    ['git config --get user.{name,email}', UNREAD_REFUSAL],
    ["git config --get 'user.{name}'", ''],
    ["git config --get 'user.{name,email}'", ''],
    ['git config --get user.name', ''],
  ]);
});

test('git config: the bare form reads one key and sets one with a value; with nothing at all it prints usage', () => {
  said([
    ['git config user.name', ''],
    ['git config user.name x', CONFIG_REFUSAL],
    ['git config user.name x pattern', CONFIG_REFUSAL],
    ['git config --global user.name', ''],
    ['git config --global user.name x', CONFIG_REFUSAL],
    ['git config core.fsmonitor /tmp/x.sh', CONFIG_REFUSAL],
    ['git config --global core.hooksPath /tmp/h', CONFIG_REFUSAL],
    ['git config alias.ci commit', CONFIG_REFUSAL],
    ['git config', ''],
    ['git config -- a.b', ''],
    ['git config -- a.b c', CONFIG_REFUSAL],
  ]);
});

test('git config: a valued option takes its value attached or as the next word, and the value is no positional', () => {
  const valued = ['-f', '--file', '--blob', '--type', '--default', '--value', '--url', '--comment'];
  said([
    ...valued.map((option) => [`git config ${option} set user.name`, '']),
    ...valued.map((option) => [`git config ${option} v user.name x`, CONFIG_REFUSAL]),
    ...valued.filter((option) => option.startsWith('--')).map((option) => [`git config ${option}=set user.name`, '']),
    ...valued.filter((option) => option.startsWith('--')).map((option) => [`git config ${option}=v user.name x`, CONFIG_REFUSAL]),
    ['git config -fset user.name', ''],
    ['git config -zf set user.name', ''],
    ['git config --default --unset --get a.b', ''],
  ]);
});

test('git config: `-t` takes a value as `-f` does, the rest of its cluster or the next word; an unknown letter in a cluster is a write word', () => {
  // Measured on git 2.38.1 and 2.54.0: each refused row but the last two writes the repository's config; `git config`
  // knows the short letters e, f, h, l, t and z, and `-h` anywhere in a cluster prints usage and writes nothing.
  said([
    ['git config -tbool user.name true', CONFIG_REFUSAL], // `bool` is the type, not `-b -o -o -l`
    ['git config -tbool-or-str core.hooksPath /tmp/x.sh', CONFIG_REFUSAL],
    ['git config -tcolor color.ui blue', CONFIG_REFUSAL],
    ['git config -t bool a.b true', CONFIG_REFUSAL],
    ['git config -zt bool a.b true', CONFIG_REFUSAL],
    ['git config -t $T --get a.b', UNREAD_REFUSAL], // a value the shell may split, as `-f $F`
    ['git config -tbool --get a.b', ''],
    ['git config -t bool --get a.b', ''],
    ['git config -t "$T" --get a.b', ''],
    ['git config -lz', ''],
    ['git config -zl', ''],
    ['git config -l', ''],
    ['git config -fx --get a.b', ''],
    ['git config -h', ''],
    ['git config -xl a.b', CONFIG_REFUSAL], // an unknown letter may be a valued one that takes the mode behind it
    ['git config -lx', CONFIG_REFUSAL],
  ]);
});

test('git config: where the positionals decide, one the shell may split or drop is refused unread; a read mode still reads', () => {
  said([
    ['git config $X', UNREAD_REFUSAL],
    ['git config user.name $(whoami)', UNREAD_REFUSAL],
    ['git config user.name "$X"', CONFIG_REFUSAL],
    ['git config --get $X', ''],
    ['git config get $X', ''],
  ]);
});

test('git config: fed by xargs, it writes whatever the arguments xargs hands it', () => {
  said([
    ['xargs git config', CONFIG_REFUSAL],
    ['xargs git config --get', CONFIG_REFUSAL],
    ['xargs git log', ''],
  ]);
});

test('git config: an abbreviated write word is the write word — git 2.38.1 reads `--unset-a` as `--unset-all` and `--ad` as `--add`', () => {
  said([
    ['git config --unset-a a.b', CONFIG_REFUSAL],
    ['git config --ad a.b c', CONFIG_REFUSAL],
    ['git config --ed', CONFIG_REFUSAL],
    ['git config --rem a', CONFIG_REFUSAL],
    ['git config --get-a a.b', ''],
  ]);
});

test('git -c / --config-env: a key in alias, include or includeIf is refused wherever it sits — any other key passes as it did', () => {
  said([
    ['git -c alias.ci=commit ci -m x', CONFIG_REFUSAL],
    ['git -c Alias.CI=commit ci -m x', CONFIG_REFUSAL],
    ['git -c aliases.ci=commit ci -m x', ''],
    ['git -c alias.x=y status', CONFIG_REFUSAL],
    ['git -c user.x=y -c alias.x=y status', CONFIG_REFUSAL],
    ['git -calias.x=y status', CONFIG_REFUSAL],
    ['git -cuser.name=y status', ''],
    ['git -c "alias.x=y" status', CONFIG_REFUSAL],
    ["git -c 'ALIAS.x=y' status", CONFIG_REFUSAL],
    ['git -c "user.name=A B" log', ''],
    ['git -c alias.x status', CONFIG_REFUSAL],
    ['git -c core.bare status', ''],
    ['git -c include.path=f status', CONFIG_REFUSAL],
    ['git -c INCLUDE.Path=f status', CONFIG_REFUSAL],
    ['git -c includeIf."gitdir:x".path=f status', CONFIG_REFUSAL],
    ["git -c 'includeIf.gitdir:x.path=f' status", CONFIG_REFUSAL],
    ['git -c user.include=f status', ''],
    ['git --config-env=alias.ci=X ci', CONFIG_REFUSAL],
    ['git --config-env alias.ci=X ci', CONFIG_REFUSAL],
    ['git --config-env=user.name=N log', ''],
    ['git --config-env user.name=N log', ''],
    ['git -c user.name=a log', ''],
    ['git -c core.pager=cat log', ''],
    ['git -c core.hooksPath=/tmp/h status', ''],
    ['git -c core.fsmonitor=/tmp/x status', ''],
    ['git -c core.sshCommand=ssh status', ''],
    ['git -c core.quotepath=off diff', ''],
    ['git -c color.ui=never status', ''],
  ]);
});

test('git -c / --config-env: a key the shell may make anything of is refused unread — an expansion after the `=` is a value', () => {
  said([
    ['git -c "$X" status', UNREAD_REFUSAL],
    ['git -c $X status', UNREAD_REFUSAL],
    ['git -c "$K=v" status', UNREAD_REFUSAL],
    ['git -c "$(printf alias.x)=y" status', UNREAD_REFUSAL],
    ['git -c "user.$K=v" status', UNREAD_REFUSAL],
    ['git --config-env="$K=V" status', UNREAD_REFUSAL],
    ['git -c user.name="$N" log', ''],
    ['git -c "user.name=$N" log', ''],
    ["git -c 'core.pager=less $X' log", ''],
    ['git -C "$DIR" status', ''],
  ]);
});

test('git -c: the key is read as the shell hands it to git — past a value that ends in `git`, and with its escapes off', () => {
  said([
    ['git -c alias.x=!git x commit -m y', CONFIG_REFUSAL], // the alias runs `git commit -m y`
    ['git -c user.name=git log', ''],
    ['git -c al\\ias.x=y status', CONFIG_REFUSAL],
    ['git -c us\\er.name=y status', ''],
  ]);
});

test('the refusal names the role and the class; a command 1.10.0 refused prints what it printed', () => {
  for (const agent of ['omelette-tester', 'omelette-reviewer']) {
    const r = fire(guard(), { ...preToolUse('git config --unset a.b'), agent_type: agent });
    assert.equal(r.code, 2, r.err);
    assert.match(r.err.trim(), new RegExp(`^${agent} never writes git config\\b.*; report instead$`));
  }
  said([
    ['git commit -m x', REFUSAL],
    ['git -c alias.x=y commit -m x', REFUSAL],
    ["git config --unset a.b; sh -c 'git commit -m x'", REFUSAL],
    ["git -c 'alias.x=!git commit' x", REFUSAL], // the quoted value is read again, and runs `git commit`
    ['git config --unset a.b; git -C $(pwd) status', UNREAD_REFUSAL],
  ]);
});

// Work thrown away (spec section 4). Every git fact below was measured on git 2.38.1 and 2.54 by argv in a throwaway
// repository: a modified tracked file rewritten, or an untracked one deleted.
const TREE_REFUSAL = 'omelette-coder never discards work in the tree (a checkout of paths, a forced checkout or switch, a restore of the work tree, a clean); report instead';

test('checkout: any word behind a bare `--`, two positionals, or one that reads as a path discards work; a branch, `-` or a commit moves', () => {
  said([
    ['git checkout -- .', TREE_REFUSAL],
    ['git checkout -- f', TREE_REFUSAL],
    ['git checkout HEAD -- .', TREE_REFUSAL],
    ['git checkout main -- f', TREE_REFUSAL],
    ['git checkout --', ''], // nothing behind it: git prints the status
    ['git checkout main --', ''],
    ['git checkout HEAD f', TREE_REFUSAL],
    ['git checkout main other', TREE_REFUSAL],
    ['git checkout .', TREE_REFUSAL],
    ['git checkout ..', TREE_REFUSAL],
    ['git checkout ./f', TREE_REFUSAL],
    ['git checkout ../f', TREE_REFUSAL],
    ['git checkout /tmp/f', TREE_REFUSAL],
    ['git checkout ~/f', TREE_REFUSAL],
    ['git checkout :/', TREE_REFUSAL], // the top of the tree: every path
    ["git checkout ':(top)f'", TREE_REFUSAL],
    ["git checkout '*.md'", TREE_REFUSAL],
    ['git checkout f?', TREE_REFUSAL],
    ['git checkout \\.', TREE_REFUSAL], // the shell hands git `.`
    ['git checkout main', ''],
    ['git checkout feat/x', ''],
    ['git checkout v1.2.3', ''],
    ['git checkout HEAD~1', ''],
    ['git checkout @{-1}', ''],
    ['git checkout -', ''],
    ['git checkout --detach main', ''],
    ['git checkout --detach', ''],
    ['git checkout -q main', ''],
    ['git checkout', ''],
    ['git checkout docs', ''], // one plain word stays allowed: the guard reads no filesystem (D2)
  ]);
});

test('checkout: one positional no ref name can be — opening with a dot or ending with a slash — is a path', () => {
  said([
    ['git checkout .gitignore', TREE_REFUSAL], // git 2.38.1 and 2.54: restores the tracked file
    ['git checkout .github', TREE_REFUSAL], //    …and the tracked directory
    ['git checkout .env', TREE_REFUSAL],
    ['git checkout d/', TREE_REFUSAL],
    ['git checkout src/app/', TREE_REFUSAL],
    ['git checkout feat/x', ''],
    ['git checkout origin/main', ''],
    ['git checkout v1.2.3', ''],
    ['git checkout HEAD~1', ''],
    ['git checkout @{-1}', ''],
    ['git checkout -', ''],
    ['git checkout main --', ''],
  ]);
});

test('checkout: a dot opening any component, a `.lock` component, two dots, a blank, a backslash or a final dot is a path — a revision that spells one is not', () => {
  // Measured on git 2.38.1 and 2.54.0: each refused word restores a modified tracked file of that name; each passing
  // revision moves HEAD (or stays) and keeps the change.
  said([
    ['git checkout src/.env', TREE_REFUSAL],
    ['git checkout packages/web/.eslintrc.js', TREE_REFUSAL],
    ['git checkout a/../b', TREE_REFUSAL], // the path `b`, with or without a directory `a`
    ['git checkout x.lock', TREE_REFUSAL],
    ['git checkout yarn.lock', TREE_REFUSAL],
    ['git checkout a.lock/b', TREE_REFUSAL],
    ["git checkout 'docs/My Notes.md'", TREE_REFUSAL],
    ['git checkout docs/My\\ Notes.md', TREE_REFUSAL], // the shell hands git one word with a blank
    ["git checkout $'a\\tb'", TREE_REFUSAL],
    ["git checkout $'a\\nb'", TREE_REFUSAL],
    ['git checkout notes.', TREE_REFUSAL],
    ['git checkout src/notes.', TREE_REFUSAL],
    ['git checkout other..', TREE_REFUSAL], // no revision: git answers a pathspec error
    ['git checkout foo..bar', TREE_REFUSAL],
    ['git checkout a..b/c', TREE_REFUSAL],
    ['git checkout main..other', TREE_REFUSAL], // a range checkout never takes: a pathspec error, nothing moves
    ['git checkout a....b', TREE_REFUSAL], // four dots or more: neither a range nor a merge base
    ['git checkout main....other', TREE_REFUSAL],
    ['git checkout x....', TREE_REFUSAL],
    ["git checkout 'a\\b'", TREE_REFUSAL],
    ['git checkout a\\\\b', TREE_REFUSAL], // the shell hands git `a\b`…
    ['git checkout a\\b', ''], //               …and here `ab`
    ['git checkout main', ''],
    ['git checkout feat/x', ''],
    ['git checkout origin/main', ''],
    ['git checkout v1.0.0-rc.1', ''],
    ['git checkout HEAD^', ''],
    ['git checkout HEAD~1^2', ''],
    ['git checkout @{u}', ''],
    ['git checkout main@{1}', ''],
    ['git checkout stash@{0}', ''],
    ['git checkout main...other', ''], // the merge base of the two
    ['git checkout other...', ''], //     …of `other` and HEAD
    ["git checkout 'HEAD@{1 minute ago}'", ''],
    ["git checkout 'HEAD^{/fix the bug}'", ''],
    ['git checkout 0123abc', ''],
    ['git checkout tags/v1', ''],
    ['git checkout Makefile', ''], // the residual kept: a file name a branch could have (D2)
    ['git checkout src/app.js', ''],
    ['git checkout dir./file', ''], // a component may end with a dot mid-name: `git branch dir./file` succeeds
  ]);
});

test('checkout: a forced one, a side of a conflict, a hunk or a path list discards work — `-m` keeps it, other options pass', () => {
  said([
    ['git checkout -f main', TREE_REFUSAL],
    ['git checkout --force main', TREE_REFUSAL],
    ['git checkout -f', TREE_REFUSAL],
    ['git checkout --ours f', TREE_REFUSAL],
    ['git checkout --theirs f', TREE_REFUSAL],
    ['git checkout -2 f', TREE_REFUSAL], // `-2` is `--ours`, `-3` is `--theirs`
    ['git checkout -3 f', TREE_REFUSAL],
    ['git checkout -p', TREE_REFUSAL],
    ['git checkout --patch main', TREE_REFUSAL],
    ['git checkout --pathspec-from-file=list', TREE_REFUSAL],
    ['git checkout --pathspec-from-file list', TREE_REFUSAL],
    ['git checkout -m main', ''],
    ['git checkout --merge main', ''],
    ['git checkout --conflict=diff3 main', ''],
    ['git checkout --conflict diff3 main', ''], // the style is the option's value, no second positional
    ['git checkout --recurse-submodules main', ''],
    ['git checkout --no-guess main', ''],
    ['git checkout -d main', ''],
  ]);
});

test('checkout: git reads an option behind a positional and in a cluster — `checkout main -f` forces', () => {
  said([
    ['git checkout main -f', TREE_REFUSAL],
    ['git checkout main --force', TREE_REFUSAL],
    ['git checkout f --ours', TREE_REFUSAL],
    ['git checkout -qf main', TREE_REFUSAL],
    ['git checkout -fq main', TREE_REFUSAL],
    ['git checkout -qd main', ''],
    ['git checkout main -q', ''],
  ]);
});

test('checkout: a long option is read by its unambiguous prefix, an ambiguous one is refused, a negation never undoes a refusal', () => {
  said([
    ['git checkout --f main', TREE_REFUSAL], // git: `--force`
    ['git checkout --forc main', TREE_REFUSAL],
    ['git checkout --our f', TREE_REFUSAL],
    ['git checkout --th f', TREE_REFUSAL],
    ['git checkout --patc f', TREE_REFUSAL],
    ['git checkout --pathspec-from list', TREE_REFUSAL],
    ['git checkout --o f', TREE_REFUSAL], // `--ours` or `--overwrite-ignore`: git's usage error
    ['git checkout --pa f', TREE_REFUSAL],
    ['git checkout --det main', ''],
    ['git checkout --pr main', ''], // `--progress`
    ['git checkout --no-force main', ''],
    ['git checkout --no-force -f main', TREE_REFUSAL], // the last word wins: git forces
    ['git checkout -f --no-force main', TREE_REFUSAL], // fail-closed: git would not force
    ['git checkout -p --no-patch f', TREE_REFUSAL],
  ]);
});

test('checkout: behind `--end-of-options` every word is a positional, as git 2.54 reads it', () => {
  said([
    ['git checkout --end-of-options .', TREE_REFUSAL],
    ['git checkout --end-of-options -f main', TREE_REFUSAL],
    ['git checkout --end-of-options main', ''],
  ]);
});

test('checkout and switch: the branch question answers first — a tree form on the same line keeps the history sentence', () => {
  said([
    ['git checkout -b x', REFUSAL],
    ['git checkout -f -b x', REFUSAL],
    ['git checkout -qfb x', REFUSAL],
    ['git checkout -b x -- f', REFUSAL],
    ['git switch -c x --discard-changes', REFUSAL],
    ['git switch -fc x', REFUSAL],
    ['git checkout x', ''],
  ]);
});

test('switch: `-f`/`--force` and `--discard-changes` discard work, wherever they sit and however abbreviated; other forms pass', () => {
  said([
    ['git switch -f main', TREE_REFUSAL],
    ['git switch --force main', TREE_REFUSAL],
    ['git switch --discard-changes main', TREE_REFUSAL],
    ['git switch main --discard-changes', TREE_REFUSAL],
    ['git switch -qf main', TREE_REFUSAL],
    ['git switch --disc main', TREE_REFUSAL],
    ['git switch --di main', TREE_REFUSAL],
    ['git switch --d main', TREE_REFUSAL], // `--detach` or `--discard-changes`: git's usage error
    ['git switch --f main', TREE_REFUSAL], // `--force` or `--force-create`
    ['git switch --discard-changes --no-force main', TREE_REFUSAL], // git: still discards
    ['git switch -f --no-force main', TREE_REFUSAL], // fail-closed
    ['git switch main', ''],
    ['git switch -', ''],
    ['git switch -m main', ''],
    ['git switch --detach main', ''],
    ['git switch -d HEAD~1', ''],
    ['git switch --no-force main', ''],
    ['git switch --conflict merge main', ''],
    ['git switch --conflict -f main', ''], // `-f` is the style git refuses, no force
  ]);
});

test('restore: every form discards work but `--staged`/`-S` without `--worktree`/`-W` — the index moves, the file stays', () => {
  said([
    ['git restore .', TREE_REFUSAL],
    ['git restore f', TREE_REFUSAL],
    ['git restore --source=HEAD~1 -- .', TREE_REFUSAL],
    ['git restore -s HEAD f', TREE_REFUSAL],
    ['git restore --worktree f', TREE_REFUSAL],
    ['git restore --staged --worktree f', TREE_REFUSAL],
    ['git restore -S -W f', TREE_REFUSAL],
    ['git restore -SW f', TREE_REFUSAL],
    ['git restore -WS f', TREE_REFUSAL],
    ['git restore -p f', TREE_REFUSAL],
    ['git restore', TREE_REFUSAL],
    ['git restore --staged f', ''],
    ['git restore -S f', ''],
    ['git restore --staged .', ''],
    ['git restore --staged -- f', ''],
    ['git restore --staged -p f', ''],
    ['git restore --staged --source=HEAD~1 f', ''],
    ['git restore -Sq f', ''],
    ['git restore -qS f', ''],
  ]);
});

test('restore: options are read anywhere before `--`, by prefix, with their values — a value is never `--staged`', () => {
  said([
    ['git restore f --staged', ''], // git reads the option behind the path
    ['git restore --stag f', ''],
    ['git restore --st f', ''],
    ['git restore -Ss HEAD f', ''],
    ['git restore -SsHEAD f', ''],
    ['git restore --staged --sour HEAD f', ''],
    ['git restore --staged --end-of-options f', ''],
    ['git restore --staged --no-w f', ''], // a negated worktree: the index only
    ['git restore -sS f', TREE_REFUSAL], // `--source=S`: the work tree
    ['git restore -s --staged f', TREE_REFUSAL], // `--source=--staged`
    ['git restore --stag --work f', TREE_REFUSAL],
    ['git restore --s f', TREE_REFUSAL], // `--source` or `--staged`: git's usage error
    ['git restore -- --staged f', TREE_REFUSAL], // behind `--` it is a path
    ['git restore --end-of-options --staged f', TREE_REFUSAL],
    ['git restore --staged --no-staged f', TREE_REFUSAL],
    ['git restore --staged --no-st f', TREE_REFUSAL],
    ['git restore --staged --n f', TREE_REFUSAL], // every negation: ambiguous
    ['git restore --staged --worktree --no-worktree f', TREE_REFUSAL], // fail-closed: git restores the index only
  ]);
});

test('clean: every form deletes but `-n`/`--dry-run`, which wins over `-f` and `-i` — and no `-n` refuses whatever the config says', () => {
  said([
    ['git clean -fd', TREE_REFUSAL],
    ['git clean -f', TREE_REFUSAL],
    ['git clean -fdx', TREE_REFUSAL],
    ['git clean -ffdx', TREE_REFUSAL],
    ['git clean -X -f', TREE_REFUSAL],
    ['git clean -i', TREE_REFUSAL],
    ['git clean', TREE_REFUSAL],
    ['git -c clean.requireForce=false clean', TREE_REFUSAL], // deletes with no flag at all
    ['git clean -d', TREE_REFUSAL],
    ['git clean -n', ''],
    ['git clean --dry-run', ''],
    ['git clean -nd', ''],
    ['git clean -ndx', ''],
    ['git clean -nf', ''],
    ['git clean -fn', ''],
    ['git clean -f -n', ''],
    ['git clean -n -i', ''],
    ['git clean d -n', ''],
  ]);
});

test('clean: `-e` takes a value — `-e -n` is a pattern; a prefix of `--dry-run` is one; a negation of it after `-n` deletes', () => {
  said([
    ['git clean -e -n -f', TREE_REFUSAL], // git: excludes `-n`, deletes
    ['git clean -en -f', TREE_REFUSAL],
    ['git clean -fen', TREE_REFUSAL],
    ['git clean --exclude -n -f', TREE_REFUSAL],
    ['git clean --ex -n -f', TREE_REFUSAL],
    ['git clean --exclude=-n -f', TREE_REFUSAL],
    ['git clean -f -- -n', TREE_REFUSAL],
    ['git clean -f --end-of-options -n', TREE_REFUSAL],
    ['git clean -n --no-dry-run -f', TREE_REFUSAL],
    ['git clean -n --no-d -f', TREE_REFUSAL],
    ['git clean -n --n -f', TREE_REFUSAL],
    ['git clean -e pat -n', ''],
    ['git clean -ne x', ''],
    ['git clean -n -e -f', ''], // `-f` is the pattern
    ['git clean --dry -f', ''],
    ['git clean --d -f', ''], // git: `--dry-run`
    ['git clean -n --no-quiet', ''],
  ]);
});

test('restore and clean: the one passing form is read from plain words only — an expansion or a brace before `--` refuses', () => {
  said([
    ['git restore --staged $F', TREE_REFUSAL], // F='--worktree f'
    ['git restore --staged "$F"', TREE_REFUSAL], // F='--worktree'
    ['git restore --staged {f,g}', TREE_REFUSAL],
    ['git restore --staged -s $R f', TREE_REFUSAL],
    ['git restore -$X f', TREE_REFUSAL],
    ['git restore --staged -- "$F"', ''],
    ['git restore --staged -s "$R" f', ''],
    ['git restore --staged --source="$R" f', ''],
    ['git clean -n $D', TREE_REFUSAL],
    ['git clean -n {a,b}', TREE_REFUSAL],
    ['git clean -n -- "$D"', ''],
  ]);
});

test('restore and clean: an unquoted glob before `--` or `--end-of-options` may expand to an option — refused; behind either it is a pathspec', () => {
  // Measured on git 2.38.1 and 2.54.0: `restore --staged --worktree f` overwrites f and `clean -n --no-dry-run -f`
  // deletes, while behind `--end-of-options` both words are pathspecs and nothing is lost.
  said([
    ['git restore --staged *', TREE_REFUSAL], // a file `--worktree` planted
    ['git restore --staged f?', TREE_REFUSAL],
    ['git restore --staged f[12]', TREE_REFUSAL],
    ['git restore --staged --wor*', TREE_REFUSAL],
    ['git restore --staged -s HEAD* f', TREE_REFUSAL], // a value the shell may make several words
    ['git restore --staged -- *', ''],
    ['git restore --staged -- *.md', ''],
    ['git restore --staged --end-of-options *', ''],
    ["git restore --staged '*.md'", ''], // git reads the pathspec itself
    ['git restore --staged \\*', ''],
    ['git restore --staged f[', ''], // no closing bracket: the shell keeps the word
    ['git clean -n *', TREE_REFUSAL], // a file `--no-dry-run` planted
    ['git clean -n -e *', TREE_REFUSAL],
    ['git clean -n d?', TREE_REFUSAL],
    ['git clean -n -- *', ''],
    ['git clean -n --end-of-options *', ''],
    ["git clean -n -e '*.log'", ''],
  ]);
});

test('restore and clean: an argument of 1 MiB of `[` with no `]` is read for a glob in linear time', () => {
  // Budget at three times the local time (532 ms), the fastest of up to three runs: looking for a `]` behind each `[`
  // took 13.3 s.
  const path = guard();
  let fastest = Infinity;
  for (let k = 0; k < 3 && fastest >= 1600; k++) {
    const r = fire(path, preToolUse(`git restore --staged ${'['.repeat(1 << 20)}`));
    assert.equal(r.code, 0, r.err);
    fastest = Math.min(fastest, r.ms);
  }
  assert.ok(fastest < 1600, `1 MiB of [ took ${fastest.toFixed(0)} ms`);
});

test('checkout and switch: a brace, or an expansion in an option word or a value the shell may split, is refused unread', () => {
  said([
    ['git checkout -{f,q} main', UNREAD_REFUSAL],
    ['git checkout {main,.}', UNREAD_REFUSAL],
    ['git checkout -$X main', UNREAD_REFUSAL],
    ['git checkout "-$X" main', UNREAD_REFUSAL],
    ['git checkout --conflict $S main', UNREAD_REFUSAL], // S='merge .'
    ['git switch --$X main', UNREAD_REFUSAL],
    ['git switch -{f,q} main', UNREAD_REFUSAL],
    ['git checkout $REF', ''], // what an expansion prints is not read as a flag: the residual kept
    ['git checkout "$REF"', ''],
    ['git checkout $A $B', TREE_REFUSAL],
    ['git checkout ./$X', TREE_REFUSAL],
    ['git switch "$B"', ''],
  ]);
});

test('restore and clean fed by xargs discard work; checkout and switch fed so keep the history sentence', () => {
  said([
    ['xargs git restore', TREE_REFUSAL],
    ['xargs git restore --staged', TREE_REFUSAL],
    ['xargs git clean', TREE_REFUSAL],
    ['xargs git clean -n', TREE_REFUSAL],
    ['xargs git checkout', REFUSAL],
    ['xargs git log', ''],
  ]);
});

test('the tree refusal names the role and the class; reset and every history write print the sentence they printed', () => {
  for (const agent of ['omelette-tester', 'omelette-reviewer']) {
    const r = fire(guard(), { ...preToolUse('git restore .'), agent_type: agent });
    assert.equal(r.code, 2, r.err);
    assert.match(r.err.trim(), new RegExp(`^${agent} never discards work in the tree\\b.*; report instead$`));
  }
  said([
    ['git reset --hard', REFUSAL],
    ['git reset --merge', REFUSAL],
    ['git reset --keep', REFUSAL],
    ['git commit -m x', REFUSAL],
    ['git checkout -b x', REFUSAL],
    ["git restore .; sh -c 'git commit -m x'", REFUSAL], // a history write anywhere prints first
    ['git clean -fd; git -C $(pwd) status', UNREAD_REFUSAL],
    ['git reset --soft HEAD~1', ''],
  ]);
});
