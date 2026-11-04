/**
 * omelette-fleet :: test/hooks-heredoc-release.test.mjs
 * Tester rows for the 1.8.0 release fix of the guard (heredoc-boundary class and
 * the quoting findings), driven through the rendered guard as a child process.
 * Every row's verdict was taken from /bin/bash 3.2 and /bin/zsh with a fake `git`
 * on PATH that logs its argv (and a curated file that a truncation changes): the
 * guard may refuse where a shell does not, it must never pass where either shell
 * runs git or truncates a curated file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

const REFUSAL = 'omelette-coder never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead';
const G = 'git ' + 'commit -m y';
const BS = '\\';

const dir = mkdtempSync(join(tmpdir(), 'omelette-heredoc-rel-'));
const script = join(dir, 'omelette-guard.mjs');
writeFileSync(script, renderHookFile(HOOK_FILES[0], '1.2.3'));
const proj = join(dir, 'proj');
mkdirSync(join(proj, '.omelette'), { recursive: true });
writeFileSync(join(proj, '.omelette', 'backlog.md'), 'KEEP\n');

function fire(command, { agent = 'omelette-coder', cwd = dir } = {}) {
  const event = { hook_event_name: 'PreToolUse', session_id: 's', cwd, tool_name: 'Bash', tool_input: { command } };
  if (agent) event.agent_type = agent;
  const started = Date.now();
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(event), encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 26 });
  assert.equal(r.signal, null, 'the guard hung');
  return { code: r.status, err: (r.stderr || '').trim(), ms: Date.now() - started };
}

function check(rows) {
  for (const [command, code] of rows) {
    const r = fire(command);
    assert.equal(r.code, code, `${JSON.stringify(command)} should exit ${code}, got ${r.code}: ${r.err}`);
    assert.equal(r.err, code === 2 ? REFUSAL : '');
  }
}

// A delimiter written with a simple ANSI-C escape is the decoded word, and its body is text
// (both shells end it at the decoded word, nothing runs). Read as "unknown" instead, the
// guard would skip no body and refuse a command that runs nothing.
test('release (1b): a `$\'…\'` delimiter with a simple escape is the decoded word — its body is text', () => {
  check([
    [`cat <<$'E${BS}x4fF'\n${G}\nEOF\n`, 0], // \xHH
    [`cat <<$'${BS}x41'\n${G}\nA\n`, 0],
    [`cat <<$'A${BS}tB'\n${G}\nA\tB\n`, 0], // \t
    [`cat <<$'A${BS}${BS}B'\n${G}\nA${BS}B\n`, 0], // \\
    [`cat <<$'A${BS}'B'\n${G}\nA'B\n`, 0], // \'
    [`cat <<$'A${BS}"B'\n${G}\nA"B\n`, 0], // \"
    [`cat <<$'A${BS}nB'\n${G}\nA\nB\n`, 0], // \n
  ]);
});

// What stays opaque stays precise: a subscript that holds a `<<` leaves a LATER heredoc's body skipped
// (the shells run no git here), and a `git` that follows a blank in a quoted word is no program.
test('release (G4/F6): an opaque subscript leaves a later heredoc body skipped; "use git" is no git word', () => {
  check([
    [`a[1<<2]=x; cat <<EOF\n${G}\nEOF\n`, 0],
    [`a[1<<2]=x\ncat <<EOF\n${G}\nEOF\n`, 0],
    [`echo "use git" commit -m y`, 0],
    [`echo 'use git' commit -m y`, 0],
  ]);
});

// Round 2: bash reads `name[` as a subscript only for a plain name at command position; any other word
// (`a.b[`, `a-b[`, `1a[`) is a word followed by a real `<<EOF]` heredoc, whose body the shells swallow
// (neither runs git). A subscript flag that is never cleared, or that starts on a digit, reads them wrong.
test('release (round 2): only a plain name opens a subscript — `a.b[<<EOF]` is a heredoc, `a[<<EOF]` is not', () => {
  check([
    [`a.b[<<EOF]\n${G}\nEOF]\n`, 0],
    [`a-b[<<EOF]\n${G}\nEOF]\n`, 0],
    [`1a[<<EOF]\n${G}\nEOF]\n`, 0],
    [`a[<<EOF]\n${G}\nEOF]\n`, 2], // bash: one word, the git line runs; zsh: bad pattern
    [`_a1[<<EOF]\n${G}\nEOF]\n`, 2],
  ]);
});

// A braced subcommand is read by prefix, but only a name followed by no word character and no `-`:
// `commit-{a,b}` is `commit-a commit-b`, `commit2{,}` is `commit2 commit2`, neither runs a write.
test('release (round 2): the braced prefix reading stops at a word character or a dash', () => {
  check([
    [`git commit-{a,b}`, 0],
    [`git commit2{,}`, 0],
    [`git commit-tree{,} abc`, 0],
    [`git tag-{a,b}`, 0],
  ]);
});

// In a delimiter every escape the shells read differently skips nothing (the ruling): zsh decodes `E`
// to `E`, bash 3.2 keeps it as written, so the body is not skipped and the lines after it are read — an
// over-refusal here (neither shell runs the git line), never a hidden line.
test('release (round 2): a `\\u`/`\\U` escape in a delimiter skips no body, even when the terminator is its decoded word', () => {
  check([
    [`cat <<$'${BS}u0045OF'\n${G}\nEOF\n`, 2],
    [`cat <<$'${BS}U00000045OF'\n${G}\nEOF\n`, 2],
  ]);
});

// Bash and zsh expand `commit{,}` to `commit commit` before git sees it: git commits. The exact-word
// subcommand rule (F6) read `commit{,}` as another word, which HEAD (ebc1cc9) refused.
test('release (F6): a subcommand written with a brace expansion is the subcommand the shell makes of it', () => {
  check([
    [`git commit{,} -m y`, 2],
    [`git tag{,x} v1`, 2],
    [`git push{,}`, 2],
    [`git reset{,} --hard`, 2],
    [`git checkout{,} -b zzz`, 2],
  ]);
});

// An ANSI-C escape the guard does not decode is the character the shell makes of it: `$'comm\151t'` is
// `commit` in both shells, `$'i'` in zsh. Passing it is the one quoting form G3 left open.
test('release (G3): an ANSI-C escape the guard cannot decode, in a git word or a curated target, is refused', () => {
  check([
    [`git $'comm${BS}151t' -m y`, 2],
    [`git $'comm${BS}u0069t' -m y`, 2],
  ]);
  const t = fire(`echo x > $'${BS}056omelette/backlog.md'`, { agent: null, cwd: proj });
  assert.equal(t.code, 2, `the curated target written with an octal escape: ${t.err}`);
});

// 1b/F2 widened `[` to a name at command position; `text` is tested with a regexp on every `[`, and
// a long word of `a[a[a[…` was flattened and scanned once per `[`: 192 KB 1.8 s, 384 KB 8.6 s,
// 512 KB 15.3 s, and the 8 MiB stdin cap an hour. Linear it is a fraction of a second.
test('release (budget): a long `a[a[a[…` word is read in linear time', () => {
  const r = fire('a' + '[a'.repeat(160000));
  assert.equal(r.code, 0, r.err);
  assert.ok(r.ms < 4000, `320 KB of a[a[… took ${r.ms} ms`);
});

// Round 3: the array-assignment rule is the assignment's alone. A `#` glued to a SUBSHELL's or an
// arithmetic command's closing parenthesis is still a comment in both shells (neither runs the git
// line behind it): read as an array it would open a word and expose that line.
test('release (round 3): a `#` glued to a subshell\'s `)` is a comment — the array rule stops at `name=(`', () => {
  check([
    [`(echo a)#c; ${G}`, 0],
    [`((1))#x; ${G}`, 0],
    [`(a=(1))#x; ${G}`, 0],
    [`a=(1 2) #x; ${G}`, 0],
    [`a=(1 2)#x; ${G}`, 2],
    [`b+=(1)#y; git push`, 2],
  ]);
});
