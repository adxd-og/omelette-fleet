/**
 * omelette-fleet :: test/hooks-fence.test.mjs
 * The reviewer's write fence (guard rule 5), driven through the rendered guard
 * as a child process: exit code + stderr. Complements the `fence:` rows of
 * hooks.test.mjs with the paths and neighbours those rows leave open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

const FENCE = 'omelette-reviewer writes nothing but .omelette/reports/<name>-review.md';

const guardPath = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fence2-guard-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3'));
  return path;
})();

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fence2-'));
  mkdirSync(join(dir, '.omelette', 'reports'), { recursive: true });
  return dir;
};

/** One PreToolUse event for the guard; `cwd` is both the event's and the process's. */
function fire(cwd, { agent = 'omelette-reviewer', tool = 'Write', input }) {
  const event = { hook_event_name: 'PreToolUse', agent_type: agent, tool_name: tool, cwd, tool_input: input };
  if (agent === null) delete event.agent_type;
  const r = spawnSync(process.execPath, [guardPath], { input: JSON.stringify(event), encoding: 'utf8', cwd: tmpdir(), timeout: 20000 });
  assert.equal(r.signal, null, 'the guard hung');
  return { code: r.status, err: (r.stderr || '').trim() };
}
const write = (cwd, file_path, extra = {}) => fire(cwd, { input: { file_path, content: 'x' }, ...extra });

test('fence: a ".." in the path is resolved first — it is the report only when it lands in reports/', () => {
  const dir = project();
  for (const base of ['', `${dir}/`]) {
    const up = write(dir, `${base}.omelette/reports/../x-review.md`);
    assert.equal(up.code, 2, `leaves reports/: ${up.err}`);
    assert.equal(up.err, FENCE);
    const around = write(dir, `${base}.omelette/reports/sub/../x-review.md`);
    assert.equal(around.code, 0, `lands in reports/: ${around.err}`);
  }
});

test('fence: only <name>-review.md exactly — a bare suffix, a longer one, another case, the directory itself', () => {
  const dir = project();
  for (const name of ['-review.md', 'x-review.md.bak', 'x-review.MD', 'x-review.txt', 'x-review.md/.', 'x-review.md/..', '']) {
    const r = write(dir, `.omelette/reports/${name}`);
    assert.equal(r.code, 2, `${JSON.stringify(name)}: ${r.err}`);
    assert.equal(r.err, FENCE);
  }
  assert.equal(write(dir, '.omelette/reports').code, 2, 'the directory itself');
  assert.equal(write(dir, 'x-review.md').code, 2, 'a -review.md outside the folder');
  assert.equal(write(dir, join(dir, 'src', 'x-review.md')).code, 2, 'a -review.md beside the sources');
});

test("fence: another project's reports/ is not this project's", () => {
  const dir = project();
  const other = project();
  const r = write(dir, join(other, '.omelette', 'reports', 'x-review.md'));
  assert.equal(r.code, 2, r.err);
  assert.equal(r.err, FENCE);
  assert.equal(write(other, join(other, '.omelette', 'reports', 'x-review.md')).code, 0, 'the same path from its own cwd');
});

test('fence: it fails closed — a cwd that does not exist, a project with no .omelette/', () => {
  const dir = project();
  const gone = write(join(dir, 'nope'), join(dir, 'nope', '.omelette', 'reports', 'x-review.md'));
  assert.equal(gone.code, 2, gone.err);
  assert.equal(gone.err, FENCE);
  const bare = mkdtempSync(join(tmpdir(), 'omelette-fence2-bare-'));
  const none = write(bare, '.omelette/reports/x-review.md');
  assert.equal(none.code, 2, none.err);
  assert.equal(none.err, FENCE);
});

test('fence: the fence is the reviewer\'s alone — the main thread, the coder and the tester write where they like', () => {
  const dir = project();
  for (const agent of [null, 'omelette-coder', 'omelette-coder-medium', 'omelette-tester']) {
    for (const tool of ['Write', 'Edit']) {
      const r = fire(dir, { agent, tool, input: { file_path: join(dir, 'src', 'a.js'), content: 'x' } });
      assert.equal(r.code, 0, `${agent ?? 'main thread'} ${tool}: ${r.err}`);
    }
  }
  assert.equal(fire(dir, { agent: 'omelette-coder', tool: 'NotebookEdit', input: { notebook_path: join(dir, 'n.ipynb') } }).code, 0);
});

test('fence: NotebookEdit is read by notebook_path, Write and Edit by file_path — the other field is not a path', () => {
  const dir = project();
  const ok = '.omelette/reports/x-review.md';
  assert.equal(fire(dir, { tool: 'NotebookEdit', input: { notebook_path: ok } }).code, 0);
  const wrongField = fire(dir, { tool: 'NotebookEdit', input: { file_path: ok } });
  assert.equal(wrongField.code, 2, wrongField.err);
  assert.equal(wrongField.err, FENCE);
  for (const tool of ['Write', 'Edit']) {
    const r = fire(dir, { tool, input: { notebook_path: ok } });
    assert.equal(r.code, 2, `${tool} with notebook_path: ${r.err}`);
  }
  const split = fire(dir, { tool: 'NotebookEdit', input: { notebook_path: 'src/n.ipynb', file_path: ok } });
  assert.equal(split.code, 2, 'the notebook_path decides, not a file_path beside it');
});

test('fence: the git rule still applies to the reviewer after the fence — status passes, commit is refused', () => {
  const dir = project();
  assert.equal(fire(dir, { tool: 'Bash', input: { command: 'git status' } }).code, 0);
  const commit = fire(dir, { tool: 'Bash', input: { command: 'git commit -m x' } });
  assert.equal(commit.code, 2);
  assert.match(commit.err, /^omelette-reviewer never commits/);
});

test('fence: the curated rules answer first — an existing curated file is refused with its own text, a new one by the fence', () => {
  const dir = project();
  const backlog = join(dir, '.omelette', 'backlog.md');
  const fresh = write(dir, backlog);
  assert.equal(fresh.code, 2);
  assert.equal(fresh.err, FENCE, 'absent: the curated rule lets a new file through, the fence does not');
  writeFileSync(backlog, 'old\n');
  const rewrite = write(dir, backlog);
  assert.equal(rewrite.code, 2);
  assert.match(rewrite.err, /is appended to, never rewritten/, 'the curated text, not the fence');
  assert.notEqual(rewrite.err, FENCE);
  const append = fire(dir, { input: { file_path: backlog, content: 'old\nmore\n' } });
  assert.equal(append.code, 2, 'an append the curated rule allows is still outside the reviewer\'s fence');
  assert.equal(append.err, FENCE);
});

test('fence: one level only — a report inside an existing subdirectory of reports/ is refused, written or not yet', () => {
  const dir = project();
  mkdirSync(join(dir, '.omelette', 'reports', 'sub'));
  writeFileSync(join(dir, '.omelette', 'reports', 'sub', 'old-review.md'), 'old\n');
  for (const name of ['sub/old-review.md', 'sub/new-review.md']) {
    for (const tool of ['Write', 'Edit']) {
      const r = fire(dir, { tool, input: { file_path: `.omelette/reports/${name}` } });
      assert.equal(r.code, 2, `${tool} ${name}: ${r.err}`);
      assert.equal(r.err, FENCE);
    }
  }
});

test('fence (round 3): a dangling reports/ link refuses, even though no directory is there yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fence2-'));
  mkdirSync(join(dir, '.omelette'));
  const outside = mkdtempSync(join(tmpdir(), 'omelette-fence2-out-'));
  symlinkSync(join(outside, 'later'), join(dir, '.omelette', 'reports'));
  const r = write(dir, '.omelette/reports/x-review.md');
  assert.equal(r.code, 2, r.err);
  assert.equal(r.err, FENCE);
});

test('fence (round 3): a .omelette linked out of the project anchors nothing — by the project path or the real one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fence2-'));
  const outside = mkdtempSync(join(tmpdir(), 'omelette-fence2-out-'));
  mkdirSync(join(outside, 'reports'));
  symlinkSync(outside, join(dir, '.omelette'));
  for (const path of ['.omelette/reports/x-review.md', join(dir, '.omelette', 'reports', 'x-review.md'), join(outside, 'reports', 'x-review.md'), join(outside, 'x-review.md')]) {
    const r = write(dir, path);
    assert.equal(r.code, 2, `${path}: ${r.err}`);
    assert.equal(r.err, FENCE);
  }
  // the other roles are not the reviewer: the main thread and the coder write through the same link
  for (const agent of [null, 'omelette-coder', 'omelette-tester']) {
    assert.equal(write(dir, join(outside, 'reports', 'x-review.md'), { agent }).code, 0, `${agent ?? 'main thread'}`);
  }
});

test('fence (round 3): a project reached through a symlinked cwd writes its report, before and after reports/ exists', () => {
  const real = mkdtempSync(join(tmpdir(), 'omelette-fence2-'));
  mkdirSync(join(real, '.omelette'));
  const via = join(mkdtempSync(join(tmpdir(), 'omelette-fence2-via-')), 'proj');
  symlinkSync(real, via);
  const first = write(via, `${via}/.omelette/reports/x-review.md`);
  assert.equal(first.code, 0, `no reports/ yet: ${first.err}`);
  assert.equal(write(via, '.omelette/reports/x-review.md').code, 0, 'relative, no reports/ yet');
  mkdirSync(join(real, '.omelette', 'reports'));
  assert.equal(write(via, `${via}/.omelette/reports/x-review.md`).code, 0, 'reports/ present');
  assert.equal(write(via, '.omelette/reports/x-review.md').code, 0, 'relative, reports/ present');
  assert.equal(write(via, `${real}/.omelette/reports/x-review.md`).code, 0, 'by the real path');
  assert.equal(write(via, '.omelette/x-review.md').code, 2, 'still only reports/');
});
