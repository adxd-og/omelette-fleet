/**
 * omelette-fleet :: test/ledger-sweep-1.7.3.test.mjs
 * 1.7.3 spec, "The sweep": deterministic, idempotent, no judgement; nothing is
 * written when a precondition fails; 1.7.2's write rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { sweepLedgers } from '../core/ledger.mjs';
import { GIT_SKIP, ledger, project } from './fixtures/ledger-1.7.3.mjs';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const FENCE = '`'.repeat(3);
const REGISTER_HEAD = '# Decisions\n\nWhat a line is: …\nHow a line dies: …\n\n';
const EXPECTED = [
  '- hooks/omelette-guard.mjs:1 · `managed by` · 2026-10-02 · gone · Ruling(binding): the guard is containment — a hostile agent has other ways — cost: false safety',
  '- 2026-11-02 · gone · Ruling(binding): undated — the sweep dates it — cost: a wrong day',
];
const CLOSED = 'closed: ledger-gone.md (feat/gone gone) — 2 binding rulings → docs/DECISIONS.md, moved to .omelette/archive/';
const UNTRACKED = 'untracked: ledger-old.md (no branch: header — add one, or move it to archive/ by hand)';

/** Four root ledgers — open, standing, untracked, closed — and a redirected register. */
function closedProject() {
  const p = project();
  p.git(['branch', 'feat/open']);
  p.write('.omelette/ledger-open.md', ledger('feat/open', '- 2026-10-01 Ruling(binding): still open — not swept — cost: none'));
  p.write('.omelette/ledger-lane.md', ledger('main', '- 2026-10-01 Ruling(binding): standing — never closes — cost: none'));
  p.write('.omelette/ledger-old.md', '# ledger old\n- 2026-09-01 Ruling(binding): untracked — left alone — cost: none\n');
  p.write('.omelette/ledger-gone.md', ledger('feat/gone',
    '- 2026-10-02 Ruling(binding): the guard is containment — a hostile agent has other ways — cost: false safety · hooks/omelette-guard.mjs:1 · `managed by`',
    FENCE, 'Ruling(binding): an example in a fence — not a ruling — cost: none', FENCE,
    'Ruling(binding): undated — the sweep dates it — cost: a wrong day'));
  p.write('.omelette/decisions.md', 'register: docs/DECISIONS.md\n');
  p.write('docs/DECISIONS.md', REGISTER_HEAD);
  return p;
}

test('the sweep moves exactly the closed ledger: its binding rulings to the register with date and plan, a closed line, then archive/', { skip: GIT_SKIP }, () => {
  const p = closedProject();
  const untouched = ['ledger-open.md', 'ledger-lane.md', 'ledger-old.md'].map((n) => [n, p.read(`.omelette/${n}`)]);
  const gone = p.read('.omelette/ledger-gone.md');
  const r = sweepLedgers(p.dir, { now: NOW });
  assert.deepEqual(r.lines, [CLOSED, UNTRACKED]);
  assert.equal(r.error, null);
  assert.equal(r.archived, 1);
  assert.deepEqual(r.ledgers.map((l) => `${l.name}:${l.state}`), ['ledger-lane.md:standing', 'ledger-old.md:untracked', 'ledger-open.md:open']);
  assert.deepEqual(r.register, { path: join(p.dir, 'docs', 'DECISIONS.md'), rel: 'docs/DECISIONS.md', via: '.omelette/decisions.md' });
  assert.equal(existsSync(join(p.dir, '.omelette', 'ledger-gone.md')), false);
  assert.equal(p.read('.omelette/archive/ledger-gone.md'), `${gone}closed 2026-11-02T12:00:00.000Z by sweep — 2 binding rulings → docs/DECISIONS.md\n`);
  assert.equal(p.read('docs/DECISIONS.md'), `${REGISTER_HEAD}${EXPECTED.join('\n')}\n`);
  for (const [n, text] of untouched) assert.equal(p.read(`.omelette/${n}`), text, `${n} untouched`);
});

test('the sweep is idempotent: a second run has nothing to move, and a register that already holds the lines gains none', { skip: GIT_SKIP }, () => {
  const p = closedProject();
  sweepLedgers(p.dir, { now: NOW });
  const after = p.snapshot();
  assert.deepEqual(sweepLedgers(p.dir, { now: NOW }).lines, [UNTRACKED]);
  assert.deepEqual(p.snapshot(), after);
  // A run cut short after the register write: the lines are there, the ledger is still in the root.
  const q = closedProject();
  q.write('docs/DECISIONS.md', `${REGISTER_HEAD}${EXPECTED.join('\n')}\n`);
  assert.deepEqual(sweepLedgers(q.dir, { now: NOW }).lines, [CLOSED, UNTRACKED]);
  assert.equal(q.read('docs/DECISIONS.md'), `${REGISTER_HEAD}${EXPECTED.join('\n')}\n`);
  assert.equal(existsSync(join(q.dir, '.omelette', 'ledger-gone.md')), false);
});

test('with no register yet, the sweep starts .omelette/decisions.md with the lines alone', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', '- 2026-10-02 Ruling(binding): first — it binds — none'));
  assert.deepEqual(sweepLedgers(p.dir, { now: NOW }).lines, ['closed: ledger-gone.md (feat/gone gone) — 1 binding ruling → .omelette/decisions.md, moved to .omelette/archive/']);
  assert.equal(p.read('.omelette/decisions.md'), '- 2026-10-02 · gone · Ruling(binding): first — it binds — none\n');
});

test('--dry-run: the same lines, nothing written', { skip: GIT_SKIP }, () => {
  const real = closedProject();
  const dry = closedProject();
  const before = dry.snapshot();
  assert.deepEqual(sweepLedgers(dry.dir, { now: NOW, dryRun: true }).lines, sweepLedgers(real.dir, { now: NOW }).lines);
  assert.deepEqual(dry.snapshot(), before);
});

test('an archive collision leaves that ledger where it is and writes nothing for it; an archive that is not a directory stops the sweep', { skip: GIT_SKIP }, () => {
  const p = closedProject();
  p.write('.omelette/archive/ledger-gone.md', 'an older plan of the same name\n');
  const before = p.snapshot();
  const r = sweepLedgers(p.dir, { now: NOW });
  assert.deepEqual(r.lines, ['collision: ledger-gone.md — .omelette/archive/ledger-gone.md exists; left in place', UNTRACKED]);
  assert.deepEqual(p.snapshot(), before);
  assert.equal(r.ledgers.find((l) => l.name === 'ledger-gone.md').state, 'closed');
  const q = closedProject();
  q.write('.omelette/archive', 'a file where the archive should be\n');
  const qBefore = q.snapshot();
  assert.deepEqual(sweepLedgers(q.dir, { now: NOW }).lines, ['sweep: .omelette/archive is not a directory — nothing swept']);
  assert.deepEqual(q.snapshot(), qBefore);
});

test('without git on PATH, or outside a repository, the sweep says so once and writes nothing', () => {
  const p = project({ git: false });
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', '- 2026-10-02 Ruling(binding): a — b — c'));
  p.write('.omelette/ledger-old.md', '# old\n');
  const before = p.snapshot();
  const nogit = sweepLedgers(p.dir, { now: NOW, env: { PATH: mkdtempSync(join(tmpdir(), 'omelette-nopath-')) } });
  assert.deepEqual(nogit.lines, ['sweep: git not found on PATH — nothing swept']);
  assert.equal(nogit.error, 'sweep: git not found on PATH — nothing swept');
  assert.deepEqual(sweepLedgers(p.dir, { now: NOW }).lines, ['sweep: not inside a git repository — nothing swept']);
  assert.deepEqual(p.snapshot(), before);
});

test('a refused register: line stops the sweep before anything is written', { skip: GIT_SKIP }, () => {
  const p = closedProject();
  p.write('.omelette/decisions.md', 'register: ../x.md\n');
  const before = p.snapshot();
  const r = sweepLedgers(p.dir, { now: NOW });
  assert.deepEqual(r.lines, ['register: ../x.md refused (contains ..) — nothing swept']);
  assert.deepEqual(r.register, { error: 'register: ../x.md refused (contains ..)' });
  assert.deepEqual(p.snapshot(), before);
});

test('a ledger that is a symlink is never read or moved; a hard-linked one is named and left alone', { skip: (process.platform === 'win32' && 'POSIX links') || GIT_SKIP }, () => {
  const p = project();
  const outside = join(mkdtempSync(join(tmpdir(), 'omelette-outside-')), 'ledger.md');
  const theirs = ledger('feat/gone', '- 2026-10-02 Ruling(binding): outside — not ours — none');
  writeFileSync(outside, theirs);
  symlinkSync(outside, join(p.dir, '.omelette', 'ledger-link.md'));
  p.write('.omelette/hard-source.txt', ledger('feat/gone', '- 2026-10-02 Ruling(binding): hard — two names — none'));
  linkSync(join(p.dir, '.omelette', 'hard-source.txt'), join(p.dir, '.omelette', 'ledger-hard.md'));
  const before = p.snapshot();
  assert.deepEqual(sweepLedgers(p.dir, { now: NOW }).lines, ['skipped: ledger-hard.md (closed, but not a single regular file — move it by hand)']);
  assert.deepEqual(p.snapshot(), before);
  assert.equal(readFileSync(outside, 'utf8'), theirs);
});

test('the git child sees no relative PATH entry, and a git that hangs is killed at the wall clock', { skip: process.platform === 'win32' && 'POSIX shell stubs' }, () => {
  const p = project({ git: false });
  p.write('.omelette/ledger-gone.md', ledger('feat/gone'));
  const abs = mkdtempSync(join(tmpdir(), 'omelette-stub-'));
  const seen = join(abs, 'seen-path');
  writeFileSync(join(abs, 'git'), `#!/bin/sh\nprintf '%s' "$PATH" > '${seen}'\nexit 1\n`);
  chmodSync(join(abs, 'git'), 0o755);
  chmodSync(p.write('bin/git', `#!/bin/sh\n: > '${join(p.dir, 'RELATIVE-RAN')}'\nexit 1\n`), 0o755);
  const r = sweepLedgers(p.dir, { now: NOW, dryRun: true, env: { PATH: ['bin', abs].join(delimiter) } });
  assert.deepEqual(r.lines, ['closed: ledger-gone.md (feat/gone gone) — 0 binding rulings → .omelette/decisions.md, moved to .omelette/archive/']);
  assert.equal(readFileSync(seen, 'utf8'), abs);
  assert.equal(existsSync(join(p.dir, 'RELATIVE-RAN')), false);

  const slow = mkdtempSync(join(tmpdir(), 'omelette-stub-'));
  writeFileSync(join(slow, 'git'), '#!/bin/sh\nexec /bin/sleep 5\n');
  chmodSync(join(slow, 'git'), 0o755);
  const t0 = Date.now();
  assert.deepEqual(sweepLedgers(p.dir, { now: NOW, env: { PATH: slow }, timeoutMs: 300 }).lines, ['sweep: git show-ref did not answer within 0.3 s — nothing swept']);
  assert.ok(Date.now() - t0 < 4000, 'killed at the wall clock, not waited out');
});
