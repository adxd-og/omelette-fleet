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
