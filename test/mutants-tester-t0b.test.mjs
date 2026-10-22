// scripts/mutants.mjs, clean-up T0b, tester pass — a defeat of the cap's tree walk that the
// coder's tests do not exercise: the cap landing while the suite's file is just starting.
// killTree reads the process table (one `ps`, tens of milliseconds) and kills what it saw;
// a file that spawns a grandchild of its own (`detached`, no scratch path in its command
// line) between that read and the kill leaves the grandchild behind: init's child, in a
// group of its own. The brief: the runner never leaves a process behind, "the cap fired
// while the child was still starting" named as a hypothesis to defend against.
// The sweep over caps is not a clock for a pass to wait on: each run ends at its own cap
// (at most 150 ms), and the sweep only moves the cap across the file's start-up time,
// which differs per machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSuite } from '../scripts/mutants.mjs';

const survivors = (dir) => {
  const real = realpathSync(dir);
  return execFileSync('ps', ['-A', '-ww', '-o', 'pid=,stat=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').map((l) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean)
    .filter(([, pid, stat, command]) => Number(pid) !== process.pid && !stat.startsWith('Z') && (command.includes(dir) || command.includes(real)))
    .map(([, pid, , command]) => ({ pid: Number(pid), command }));
};

test('a cap that lands while the suite file is starting leaves no process behind, the file\'s own detached grandchild included', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-mutants-t0b-tester-'));
  const mark = join(dir, 'mark');
  t.after(() => {
    for (const p of survivors(dir)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, 'repo', 'test'), { recursive: true });
  // A grandchild in a group of its own, its command line holding the sandbox and no scratch path; then a spin.
  writeFileSync(join(dir, 'repo', 'test', 'a.test.mjs'), [
    "import { spawn } from 'node:child_process';",
    `spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ${JSON.stringify(mark)}], { detached: true, stdio: 'ignore' }).unref();`,
    'for (;;);',
    '',
  ].join('\n'));
  const leaks = [];
  for (const cap of [20, 30, 40, 50, 60, 70, 80, 100, 120, 150]) {
    for (let rep = 0; rep < 2; rep++) {
      const r = await runSuite({ cwd: join(dir, 'repo'), files: ['test/a.test.mjs'], timeoutMs: cap, home: join(dir, 'home') });
      assert.equal(r.timedOut, true, `cap ${cap} ms ends the run`);
      for (let i = 0; i < 20 && survivors(dir).length; i++) await new Promise((res) => setTimeout(res, 50));
      const left = survivors(dir);
      if (left.length) {
        leaks.push(`cap ${cap} ms: ${left.map((p) => `${p.pid} ${p.command.slice(-60)}`).join(' | ')}`);
        for (const p of left) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
  }
  assert.deepEqual(leaks, [], 'processes left behind by a cap that landed during start-up');
});
