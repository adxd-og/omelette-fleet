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
