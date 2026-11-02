/**
 * omelette-fleet :: test/doctor-ledgers-1.7.3.test.mjs
 * 1.7.3 spec, "doctor and check": doctor sweeps, then counts the ledgers and
 * reads the register; its warnings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_SKIP, ledger, project } from './fixtures/ledger-1.7.3.mjs';

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'omelette-fleet.mjs');
function doctor(p) {
  const home = mkdtempSync(join(tmpdir(), 'omelette-home-'));
  const gone = join(home, 'no-such-cli');
  const r = spawnSync(process.execPath, [BIN, 'doctor'], {
    cwd: p.dir, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: home, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone },
  });
  return r.stdout || '';
}
/** The rows from `ledgers` up to `contract`. */
const block = (out) => out.slice(out.indexOf('\nledgers ') + 1, out.indexOf('\ncontract ')).split('\n');

test('doctor sweeps, then counts: the open ledger with its branch, the untracked, the archived; the sweep\'s lines follow', { skip: GIT_SKIP }, () => {
  const p = project();
  p.git(['branch', 'feat/1.9.0']);
  p.write('.omelette/ledger-1.9.0.md', ledger('feat/1.9.0'));
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', '- 2026-10-02 Ruling(binding): one — two — three'));
  p.write('.omelette/ledger-old.md', '# old\n');
  p.write('.omelette/archive/ledger-0.1.md', '# old\n');
  p.write('.omelette/archive/ledger-0.2.md', '# old\n');
  assert.deepEqual(block(doctor(p)), [
    'ledgers       1 open (ledger-1.9.0.md → feat/1.9.0), 1 untracked, 3 archived',
    '              closed: ledger-gone.md (feat/gone gone) — 1 binding ruling → .omelette/decisions.md, moved to .omelette/archive/',
    '              untracked: ledger-old.md (no branch: header — add one, or move it to archive/ by hand)',
    'decisions     .omelette/decisions.md — 1 line, 0 struck, 0 stale pointers',
  ]);
  assert.deepEqual(block(doctor(p)), [
    'ledgers       1 open (ledger-1.9.0.md → feat/1.9.0), 1 untracked, 3 archived',
    '              untracked: ledger-old.md (no branch: header — add one, or move it to archive/ by hand)',
    'decisions     .omelette/decisions.md — 1 line, 0 struck, 0 stale pointers',
  ], 'the second run has nothing left to sweep');
});

test('doctor warns about a second open ledger and about more than 30 unstruck lines, and counts the stale pointers', { skip: GIT_SKIP }, () => {
  const p = project();
  p.git(['branch', 'feat/a']);
  p.git(['branch', 'feat/b']);
  p.write('.omelette/ledger-a.md', ledger('feat/a'));
  p.write('.omelette/ledger-b.md', ledger('feat/b'));
  p.write('.omelette/ledger-lane.md', ledger('main'));
  p.write('.omelette/decisions.md', 'register: docs/DECISIONS.md\n');
  p.write('src/x.mjs', 'export const answer = 42;\n');
  p.write('docs/DECISIONS.md', [
    '# Decisions', '', 'What a line is: …', 'How a line dies: …', '',
    '- src/x.mjs:1 · `export const answer = 42` · 2026-11-01 · p · Ruling(binding): pinned — ok — none',
    '- src/x.mjs:9 · `export const answer = 42` · 2026-11-01 · p · Ruling(binding): moved away — stale — none',
    '- 2026-10-01 · p · Ruling(binding): old — gone — none · Superseded by the line above',
    ...Array.from({ length: 30 }, (_, i) => `- 2026-11-01 · p · Ruling(binding): live ${i} — x — y`),
    '',
  ].join('\n'));
  assert.deepEqual(block(doctor(p)), [
    'ledgers       2 open (ledger-a.md → feat/a, ledger-b.md → feat/b), 1 standing (ledger-lane.md), 0 untracked, 0 archived',
    '              warning: 2 open ledgers — one plan, one open ledger: merge and delete the finished branch',
    'decisions     docs/DECISIONS.md (via .omelette/decisions.md) — 33 lines, 1 struck, 1 stale pointer',
    '              warning: 32 unstruck lines — over 30: strike what no longer binds (append "superseded by …")',
  ]);
});

test('doctor: no .omelette, no rows; a refused register: line is the sweep\'s line and the decisions row points at it', () => {
  const p = project({ git: false });
  rmSync(join(p.dir, '.omelette'), { recursive: true });
  assert.doesNotMatch(doctor(p), /^(ledgers|decisions) /m);
  p.write('.omelette/decisions.md', 'register: /etc/passwd\n');
  assert.deepEqual(block(doctor(p)), [
    'ledgers       0 open, 0 untracked, 0 archived',
    '              register: /etc/passwd refused (absolute path) — nothing swept',
    'decisions     register: /etc/passwd refused (absolute path)',
  ]);
});
