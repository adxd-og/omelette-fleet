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
