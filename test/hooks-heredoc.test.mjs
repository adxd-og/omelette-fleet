/**
 * omelette-fleet :: test/hooks-heredoc.test.mjs
 * Guard v2, rule 1 — "a heredoc body is not a command" — rows beyond the ones in
 * hooks.test.mjs: what ends a body (exactly the word, tabs only after `<<-`),
 * how two heredocs on one line take their terminators, what a body's
 * substitutions still run, and the `<<` that bash does not read as a heredoc.
 * Driven the way Claude Code drives the guard: a child process, event on stdin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

const REFUSAL = 'omelette-coder never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead';

const dir = mkdtempSync(join(tmpdir(), 'omelette-heredoc-'));
const script = join(dir, 'omelette-guard.mjs');
writeFileSync(script, renderHookFile(HOOK_FILES[0], '1.2.3'));

/** The exit code and stderr the guard gives a coder's Bash call. */
function run(command) {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', session_id: 's', cwd: dir,
      agent_type: 'omelette-coder', tool_name: 'Bash', tool_input: { command },
    }),
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.signal, null, 'the guard hung');
  return { code: r.status, err: (r.stderr || '').trim() };
}

function check(rows) {
  for (const [command, code] of rows) {
    const r = run(command);
    assert.equal(r.code, code, `${JSON.stringify(command)} should exit ${code}, got ${r.code}: ${r.err}`);
    assert.equal(r.err, code === 2 ? REFUSAL : '');
  }
}

test('heredoc: only the word alone ends a body — trailing spaces and spaces before it do not, tabs do only after `<<-`', () => {
  check([
    // `EOF ` (trailing space) is body; the line after it is body too.
    ['cat <<EOF\nEOF \ngit commit\n', 0],
    // `<<-` strips tabs, never spaces.
    ['cat <<-EOF\n  EOF\ngit commit\n', 0],
    ['cat <<-EOF\n\t  EOF\ngit commit\n', 0],
    // Plain `<<` strips nothing: a tab-indented word is body.
    ['cat <<EOF\n\tEOF\ngit commit\n', 0],
    // The real terminator ends it, and what follows is a command again.
    ['cat <<EOF\nx\nEOF\ngit commit\n', 2],
    ['cat <<-EOF\n\tx\n\tEOF\ngit push\n', 2],
  ]);
});

test('heredoc: two on one line take their terminators in order, a later word inside an earlier body is only text', () => {
  check([
    // `B` inside the first body does not end the first (its word is `A`).
    ['cat <<A <<B\nB\ngit commit\nA\nfoo\nB\n', 0],
    // After both terminators the command line is read again.
    ['cat <<A <<B\nx\nA\ny\nB\ngit commit\n', 2],
  ]);
});

test('heredoc: a body that expands runs its substitutions even in quotes and after other text; an escaped one or a quoted delimiter does not', () => {
  check([
    ['cat <<EOF\n\\$(git commit)\nEOF\n', 0],
    ['cat <<EOF\n\\`git commit\\`\nEOF\n', 0],
    // Quotes inside a heredoc body are plain characters: the substitution still runs.
    ['cat <<EOF\n"$(git commit)"\nEOF\n', 2],
    ['cat <<EOF\n\'$(git commit)\'\nEOF\n', 2],
    ['cat <<EOF\ntext $(echo a; git push) text\nEOF\n', 2],
    // Any quoting of the delimiter makes the body literal.
    ['cat <<"EOF"\n$(git commit)\nEOF\n', 0],
    ['cat <<\\EOF\n$(git commit)\nEOF\n', 0],
  ]);
});

test('heredoc: a redirection after the delimiter is a redirection, a command after it is a command', () => {
  check([
    ['cat <<EOF > out.txt\nbody\nEOF\n', 0],
    ['cat <<EOF > out.txt; git push\nbody\nEOF\n', 2],
    ['cat > out.txt <<EOF && git push\nbody\nEOF\n', 2],
    ['cat <<EOF | git push\nbody\nEOF\n', 2],
  ]);
});

// Bash reads `<<` inside `(( … ))` as the shift operator, not as a heredoc: the next
// line is a command and runs (checked on bash 3.2: `(( x = 1<<2 ))` then `echo` runs
// the echo). The guard swallows that line as the body of a heredoc whose word is `2`.
test('heredoc: `<<` inside (( … )) is arithmetic, the next line is still a command', () => {
  check([
    ['(( x = 1<<2 ))\ngit commit -m x\n', 2],
    ['(( x = 1 << 2 ))\ngit commit -m x\n', 2],
    ['((1<<2))\ngit push\n', 2],
    ['for ((i=0;i<1<<2;i++)); do :; done\ngit commit -m x\n', 2],
    ['if (( 1<<2 )); then\ngit commit -m x\nfi\n', 2],
  ]);
});

// The same differential through a word, not a `(( ))`: bash keeps `<<` inside an
// array subscript and a `${…}` as part of the word (checked on bash 3.2).
test('heredoc: `<<` inside a subscript or a ${…} is part of the word, the next line is still a command', () => {
  check([
    ['a[1<<2]=x\ngit commit -m x\n', 2],
    ['echo ${x:-1<<2}\ngit commit -m x\n', 2],
  ]);
});

// What the shell expands inside a region where `<<` is not an operator still runs:
// the substitutions are commands there too, quoted or not (a quoted one is re-read by
// the word check, not by the region's own copy loop — pinned here at the exit code).
test('heredoc: a substitution inside (( … )), a subscript or a ${…} is still a command', () => {
  const G = 'git ' + 'push';
  check([
    [`(( x = $(${G}) ))\n`, 2],
    [`(( x = \`${G}\` ))\n`, 2],
    [`echo \${x:-$(${G})}\n`, 2],
    [`a[$(${G})]=x\n`, 2],
    [`echo \${x:-"$(${G})"}\n`, 2],
    [`a["$(${G})"]=x\n`, 2],
  ]);
});

// A `}`, `)` or `]` inside quotes or a substitution closes nothing, so the `<<` after it
// is still inside the region and the next line is still a command (each checked on bash
// 3.2: the following line runs). A `<<` right after a closed `${…}` IS a heredoc.
test('heredoc: a quoted or substituted closer does not end the region early', () => {
  const G = 'git ' + 'commit';
  check([
    [`echo \${x:-"}"<<2}\n${G}\n`, 2],
    [`(( x = ")" + 1<<2 ))\n${G}\n`, 2],
    [`a["]"<<2]=x\n${G}\n`, 2],
    [`a[']'<<2]=x\n${G}\n`, 2],
    [`echo \${x:-\`echo }\`<<2}\n${G}\n`, 2],
    [`echo \${x:-"}"}<<EOF\n${G}\nEOF\n`, 0],
  ]);
});

// A backslash-newline inside a body joins the lines BEFORE the tabs of `<<-` are
// stripped (bash 3.2 and zsh, observed): `\tEO\` + `\tF` is `EO<tab>F`, body, while
// `\tEO\` + `F` is `\tEOF`, the terminator.
test('heredoc: under `<<-` the tabs are stripped from the joined line, not from each piece', () => {
  const G = 'git ' + 'commit';
  check([
    [`cat <<-EOF\n\tEO\\\n\tF\n${G}\n`, 0],
    [`cat <<-EOF\nEO\\\n\tF\n${G}\n`, 0],
    [`cat <<-EOF\n\tEO\\\nF\n${G}\n`, 2],
  ]);
});
