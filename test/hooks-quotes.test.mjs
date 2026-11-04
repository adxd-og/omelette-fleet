/**
 * The guard hook, quoting (1.8.0 Task 2, audit finding 6): quotes hide neither
 * the git word nor the subcommand. Rows the main hooks file does not pin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

const REFUSAL = (agent) => `${agent} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`;

function guardPath() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-q-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3'));
  return path;
}

function run(path, command) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', agent_type: 'omelette-coder', tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(r.signal, null, `the guard hung on ${command.slice(0, 40)}`);
  return { code: r.status, err: r.stderr || '', ms: Date.now() - started };
}

function check(rows) {
  const path = guardPath();
  for (const [command, code] of rows) {
    const r = run(path, command);
    assert.equal(r.code, code, `${JSON.stringify(command)} should exit ${code}, exited ${r.code}: ${r.err}`);
    assert.equal(r.err.trim(), code === 2 ? REFUSAL('omelette-coder') : '');
  }
}

test('quotes: every quoting shape of the git word and the subcommand is the same invocation', () => {
  check([
    ["'git' 'commit' -m x", 2],
    ['/usr/bin/"git" commit -m x', 2],
    ['"g"i"t" commit -m x', 2],
    ['git ""commit -m x', 2],
    ['git "tag" "-d" v1', 2],
    ['git "tag" -d v1', 2],
    ['git "push" origin main', 2],
    ['git "stash"', 2],
  ]);
});

test('quotes: reading quotes off does not make read-only git refused', () => {
  check([
    ['git "log" --oneline', 0],
    ['"git" log', 0],
    ['git "status"', 0],
    // The subcommand regex still ends where a longer name begins.
    ['git "commit"-tree HEAD^{tree}', 0],
    ['git co"mm"it-tree HEAD^{tree}', 0],
    ['git "tag" -l', 0],
  ]);
});

// 1.8.0 release fix (branch review F6): the subcommand is the whole word, so the
// spaced value `commit x` names none and the false refusal ruled 2026-11-03 is gone.
test('quotes: a quoted spaced value is no subcommand — the subcommand is the whole word', () => {
  check([['git -c "commit x" log', 0]]);
});

test('quotes: a quoted global option does not hide the subcommand behind it', () => {
  check([
    ['git "-C" /x commit -m x', 2],
    ['git "-c" a=b commit -m x', 2],
    ['git "--no-pager" commit -m x', 2],
    ['git "-C" "/x" push', 2],
  ]);
});

test('quotes: git -c repeated 4 000 times is still read in one pass', () => {
  const path = guardPath();
  for (const [command, code] of [
    [`${'git -c '.repeat(4000)}log`, 0],
    [`${'git -c '.repeat(4000)}; git commit -m x`, 2],
    [`${'git -c "commit x" '.repeat(4000)}log`, 0], // 1.8.0 release fix F6: `commit x` is no subcommand
    [`${'git -c "commit" '.repeat(4000)}log`, 2],
  ]) {
    const r = run(path, command);
    assert.equal(r.code, code, `${command.slice(0, 30)}… exited ${r.code}: ${r.err}`);
    assert.ok(r.ms < 2000, `${command.slice(0, 30)}… took ${r.ms} ms`);
  }
});

test('quotes: a command with its quotes on exits as the same command with them off', () => {
  // Quoting changes nothing about what git is run with, so the answer is the
  // same either way: the walk over the options reads `"-C"` as `-C` and
  // `"--no-pager"` as the option that takes no value. Only the pair's AGREEMENT
  // is the point of a row; the code is what git would run.
  const path = guardPath();
  for (const [bare, quoted, code] of [
    // git takes `-C` as `-c`'s value, whatever it opens with, and runs `git log commit`: read-only.
    ['git -c -C log commit', 'git -c "-C" log commit', 0],
    // `--no-pager` takes no value, so `log` is the subcommand and `commit` is its argument.
    ['git --no-pager log commit', 'git "--no-pager" log commit', 0],
    ['git --work-tree=/x commit', 'git "--work-tree=/x" commit', 2],
  ]) {
    for (const command of [bare, quoted]) {
      const r = run(path, command);
      assert.equal(r.code, code, `${JSON.stringify(command)} should exit ${code}, exited ${r.code}: ${r.err}`);
    }
  }
});
