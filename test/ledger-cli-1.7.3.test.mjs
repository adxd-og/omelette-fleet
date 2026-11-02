/**
 * omelette-fleet :: test/ledger-cli-1.7.3.test.mjs
 * 1.7.3 spec, "The model" and "The sweep": the two commands' output and exit codes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_SKIP, ledger, project } from './fixtures/ledger-1.7.3.mjs';

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'omelette-fleet.mjs');
/** The CLI in the project, with a home of its own so nothing it keeps lands in the snapshot. */
function cli(p, args) {
  const home = mkdtempSync(join(tmpdir(), 'omelette-home-'));
  const r = spawnSync(process.execPath, [BIN, 'ledger', ...args], {
    cwd: p.dir, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: home, OMELETTE_UPDATE_CHECK: '0' },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('ledger open writes the header from the current branch; a second open and a detached HEAD exit 1', { skip: GIT_SKIP }, () => {
  const p = project();
  p.git(['checkout', '-q', '-b', 'feat/1.9.0']);
  assert.deepEqual(cli(p, ['open', '1.9.0']), { code: 0, out: 'opened .omelette/ledger-1.9.0.md (branch: feat/1.9.0)\n', err: '' });
  assert.deepEqual(cli(p, ['open', '1.9.0']), { code: 1, out: '', err: 'omelette-fleet ledger open: .omelette/ledger-1.9.0.md exists\n' });
  p.git(['checkout', '-q', '--detach']);
  assert.deepEqual(cli(p, ['open', '2.0.0']), { code: 1, out: '', err: "omelette-fleet ledger open: HEAD is detached — check out the plan's branch first\n" });
});

test('ledger sweep prints one line per action and exits 0; --dry-run prints the same lines, says so, and writes nothing', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', '- 2026-10-02 Ruling(binding): one — two — three'));
  p.write('.omelette/ledger-old.md', '# old\n');
  const lines = [
    'closed: ledger-gone.md (feat/gone gone) — 1 binding ruling → .omelette/decisions.md, moved to .omelette/archive/',
    'untracked: ledger-old.md (no branch: header — add one, or move it to archive/ by hand)',
  ].map((l) => `${l}\n`).join('');
  const before = p.snapshot();
  assert.deepEqual(cli(p, ['sweep', '--dry-run']), { code: 0, out: `${lines}dry run — nothing written\n`, err: '' });
  assert.deepEqual(p.snapshot(), before);
  assert.deepEqual(cli(p, ['sweep']), { code: 0, out: lines, err: '' });
  assert.equal(existsSync(join(p.dir, '.omelette', 'archive', 'ledger-gone.md')), true);
  rmSync(join(p.dir, '.omelette', 'ledger-old.md'));
  assert.deepEqual(cli(p, ['sweep']), { code: 0, out: 'sweep: nothing to do\n', err: '' });
});

test('ledger: no subcommand, an unknown one, a missing or unusable plan name, an extra argument or flag — exit 2, nothing written', () => {
  const p = project({ git: false });
  const before = p.snapshot();
  for (const args of [[], ['nope'], ['open'], ['open', '../x'], ['open', 'a', 'b'], ['sweep', 'extra'], ['sweep', '--force']]) {
    const r = cli(p, args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}${r.err}`);
    assert.equal(r.out, '');
    assert.match(r.err, /^omelette-fleet ledger/);
  }
  assert.deepEqual(p.snapshot(), before);
});
