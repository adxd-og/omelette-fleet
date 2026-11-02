/**
 * omelette-fleet :: test/tester-1.7.3-sweep.test.mjs
 * Tester's probes of the 1.7.3 sweep (spec "The sweep", plan Task 4): what the
 * sweep does around a ledger it cannot move, a register it cannot write, and a
 * tree whose preconditions fail, observed through `sweepLedgers` and the files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepLedgers } from '../core/ledger.mjs';
import { GIT_SKIP, ledger, project } from './fixtures/ledger-1.7.3.mjs';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const POSIX = process.platform === 'win32' && 'POSIX links and modes';
const NOT_ROOT = (process.platform === 'win32' && 'POSIX modes') || (process.getuid && process.getuid() === 0 && 'root ignores directory modes');
const rule = (text) => `- 2026-10-02 Ruling(binding): ${text} — why — cost`;
const outsideDir = () => mkdtempSync(join(tmpdir(), 'omelette-tester-out-'));

test('one blocked ledger writes nothing for itself while the others still move: a collision, a dangling-symlink collision, and a hard-linked ledger', { skip: POSIX || GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-a-collides.md', ledger('feat/a', rule('from a')));
  p.write('.omelette/ledger-b-dangling.md', ledger('feat/b', rule('from b')));
  p.write('.omelette/hard-source.txt', ledger('feat/c', rule('from c')));
  linkSync(join(p.dir, '.omelette', 'hard-source.txt'), join(p.dir, '.omelette', 'ledger-c-hard.md'));
  p.write('.omelette/ledger-d-moves.md', ledger('feat/d', rule('from d')));
  p.write('.omelette/archive/ledger-a-collides.md', 'older\n');
  symlinkSync(join(p.dir, 'nowhere'), join(p.dir, '.omelette', 'archive', 'ledger-b-dangling.md'));
  const keep = ['ledger-a-collides.md', 'ledger-b-dangling.md', 'ledger-c-hard.md'].map((n) => [n, p.read(`.omelette/${n}`)]);
  const r = sweepLedgers(p.dir, { now: NOW });
  assert.deepEqual(r.lines, [
    'collision: ledger-a-collides.md — .omelette/archive/ledger-a-collides.md exists; left in place',
    'collision: ledger-b-dangling.md — .omelette/archive/ledger-b-dangling.md exists; left in place',
    'skipped: ledger-c-hard.md (closed, but not a single regular file — move it by hand)',
    'closed: ledger-d-moves.md (feat/d gone) — 1 binding ruling → .omelette/decisions.md, moved to .omelette/archive/',
  ]);
  for (const [n, text] of keep) assert.equal(p.read(`.omelette/${n}`), text, `${n} untouched, no closed line`);
  assert.match(p.read('.omelette/archive/ledger-d-moves.md'), /closed 2026-11-02T12:00:00\.000Z by sweep — 1 binding ruling → \.omelette\/decisions\.md\n$/);
  // The register holds the mover's ruling alone: a blocked ledger's rulings are not written for it.
  assert.equal(p.read('.omelette/decisions.md'), '- 2026-10-02 · d-moves · Ruling(binding): from d — why — cost\n');
  assert.deepEqual(r.ledgers.map((l) => l.name), ['ledger-a-collides.md', 'ledger-b-dangling.md', 'ledger-c-hard.md']);
  assert.equal(r.archived, 3);
});

test('every precondition stops before the first write: an archive that is a symlink to a directory, a symlinked .omelette, a symlinked default register', { skip: POSIX || GIT_SKIP }, () => {
  // archive/ a symlink to a real directory: refused, the target never gains a file.
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', rule('x')));
  const out = outsideDir();
  symlinkSync(out, join(p.dir, '.omelette', 'archive'));
  const before = p.snapshot();
  assert.deepEqual(sweepLedgers(p.dir, { now: NOW }).lines, ['sweep: .omelette/archive is not a directory — nothing swept']);
  assert.deepEqual(p.snapshot(), before);
  assert.deepEqual(readdirSync(out), []);

  // .omelette itself a symlink to a directory holding a closed ledger: nothing is read or moved.
  const q = project({ git: true });
  rmSync(join(q.dir, '.omelette'), { recursive: true });
  const real = outsideDir();
  writeFileSync(join(real, 'ledger-gone.md'), ledger('feat/gone', rule('y')));
  symlinkSync(real, join(q.dir, '.omelette'));
  const r = sweepLedgers(q.dir, { now: NOW });
  assert.deepEqual(r.lines, ['sweep: .omelette is not a directory of this project — nothing swept']);
  assert.deepEqual(readdirSync(real), ['ledger-gone.md']);

  // The default register a symlink: refused, the link's target is not followed or written.
  const s = project();
  s.write('.omelette/ledger-gone.md', ledger('feat/gone', rule('z')));
  const target = join(outsideDir(), 'victim.md');
  writeFileSync(target, 'victim\n');
  symlinkSync(target, join(s.dir, '.omelette', 'decisions.md'));
  const sBefore = s.snapshot();
  const sr = sweepLedgers(s.dir, { now: NOW });
  assert.equal(sr.lines.length, 1);
  assert.match(sr.lines[0], /^register: .*decisions\.md.* — nothing swept$/);
  assert.deepEqual(s.snapshot(), sBefore);
  assert.equal(readFileSync(target, 'utf8'), 'victim\n');
});

test('the register goes through tmp + rename: a hard-linked register keeps its other name intact, its mode survives, no tmp is left, a missing final newline is supplied', { skip: POSIX || GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', rule('one')));
  p.write('.omelette/decisions.md', 'register: docs/DECISIONS.md\n');
  p.write('docs/DECISIONS.md', '# head\n- old line without newline');
  chmodSync(join(p.dir, 'docs', 'DECISIONS.md'), 0o640);
  const other = join(p.dir, 'docs', 'other-name.md');
  linkSync(join(p.dir, 'docs', 'DECISIONS.md'), other);
  const inoBefore = statSync(join(p.dir, 'docs', 'DECISIONS.md')).ino;
  sweepLedgers(p.dir, { now: NOW });
  assert.equal(readFileSync(other, 'utf8'), '# head\n- old line without newline', 'the other name of the old inode is not rewritten in place');
  assert.equal(p.read('docs/DECISIONS.md'), '# head\n- old line without newline\n- 2026-10-02 · gone · Ruling(binding): one — why — cost\n');
  assert.notEqual(statSync(join(p.dir, 'docs', 'DECISIONS.md')).ino, inoBefore, 'a new inode: written beside, renamed over');
  assert.equal(statSync(join(p.dir, 'docs', 'DECISIONS.md')).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(join(p.dir, 'docs')).sort(), ['DECISIONS.md', 'other-name.md']);
  assert.deepEqual(readdirSync(join(p.dir, '.omelette')).filter((n) => n.endsWith('.tmp')), []);
});

test('the same ruling twice in one ledger is one register line; a second ledger is appended in name order whatever order they were written in', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-zeta.md', ledger('feat/zeta', rule('z one')));
  p.write('.omelette/ledger-alpha.md', ledger('feat/alpha', rule('twice'), rule('twice')));
  const r = sweepLedgers(p.dir, { now: NOW });
  assert.equal(r.lines.length, 2);
  assert.match(r.lines[0], /^closed: ledger-alpha\.md /);
  assert.match(r.lines[1], /^closed: ledger-zeta\.md /);
  assert.equal(p.read('.omelette/decisions.md'), [
    '- 2026-10-02 · alpha · Ruling(binding): twice — why — cost',
    '- 2026-10-02 · zeta · Ruling(binding): z one — why — cost',
    '',
  ].join('\n'));
});

test('a ledger without a final newline gets one before the closed line, and a closed ledger with no binding ruling moves without touching the register', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-gone.md', '# ledger\nbranch: feat/gone\n\nno newline at the end');
  const r = sweepLedgers(p.dir, { now: NOW });
  assert.deepEqual(r.lines, ['closed: ledger-gone.md (feat/gone gone) — 0 binding rulings → .omelette/decisions.md, moved to .omelette/archive/']);
  assert.equal(p.read('.omelette/archive/ledger-gone.md'), '# ledger\nbranch: feat/gone\n\nno newline at the end\nclosed 2026-11-02T12:00:00.000Z by sweep — 0 binding rulings → .omelette/decisions.md\n');
  assert.equal(existsSync(join(p.dir, '.omelette', 'decisions.md')), false, 'no register created for nothing');
});

test('an undated binding ruling is dated with the sweep day in UTC, not the machine\'s local day', { skip: GIT_SKIP }, () => {
  const was = process.env.TZ;
  process.env.TZ = 'Pacific/Auckland';
  try {
    const late = new Date('2026-11-02T23:30:00.000Z');
    if (late.getDate() !== 3) return; // this runtime ignores a TZ set at run time; nothing to tell apart
    const p = project();
    p.write('.omelette/ledger-gone.md', ledger('feat/gone', 'Ruling(binding): undated — why — cost'));
    sweepLedgers(p.dir, { now: late });
    assert.equal(p.read('.omelette/decisions.md'), '- 2026-11-02 · gone · Ruling(binding): undated — why — cost\n');
  } finally {
    if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
  }
});

test('--dry-run with a collision, a skipped ledger and an untracked one prints what a real run prints and leaves the tree byte-identical', { skip: POSIX || GIT_SKIP }, () => {
  const build = () => {
    const p = project();
    p.write('.omelette/ledger-a.md', ledger('feat/a', rule('a')));
    p.write('.omelette/ledger-b.md', ledger('feat/b', rule('b')));
    p.write('.omelette/ledger-c.md', ledger('feat/c', rule('c')));
    p.write('.omelette/ledger-u.md', '# no header\n');
    p.write('.omelette/archive/ledger-b.md', 'older\n');
    p.write('.omelette/hard.txt', ledger('feat/h', rule('h')));
    linkSync(join(p.dir, '.omelette', 'hard.txt'), join(p.dir, '.omelette', 'ledger-h.md'));
    return p;
  };
  const dry = build();
  const real = build();
  const before = dry.snapshot();
  const d = sweepLedgers(dry.dir, { now: NOW, dryRun: true });
  const r = sweepLedgers(real.dir, { now: NOW });
  assert.deepEqual(d.lines, r.lines);
  assert.equal(d.lines.length, 5);
  assert.deepEqual(dry.snapshot(), before);
  // The returned counts describe the tree after the run it would have been.
  assert.equal(d.archived, r.archived);
  assert.deepEqual(d.ledgers.map((l) => l.name), r.ledgers.map((l) => l.name));
});

test('a register already written but the moves not (retry) adds no register line, whatever ledger it was cut short on', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-a.md', ledger('feat/a', rule('a')));
  p.write('.omelette/ledger-b.md', ledger('feat/b', rule('b')));
  p.write('.omelette/decisions.md', '- 2026-10-02 · a · Ruling(binding): a — why — cost\n- 2026-10-02 · b · Ruling(binding): b — why — cost\n');
  const registerBefore = p.read('.omelette/decisions.md');
  const ino = statSync(join(p.dir, '.omelette', 'decisions.md')).ino;
  sweepLedgers(p.dir, { now: NOW });
  assert.equal(p.read('.omelette/decisions.md'), registerBefore);
  assert.equal(statSync(join(p.dir, '.omelette', 'decisions.md')).ino, ino, 'nothing fresh: the register is not even rewritten');
  assert.deepEqual(readdirSync(join(p.dir, '.omelette', 'archive')).sort(), ['ledger-a.md', 'ledger-b.md']);
});

test('a register too big to read stops the sweep before any ledger is touched', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', rule('x')));
  p.write('.omelette/decisions.md', `- ${'x'.repeat(4 * 1024 * 1024)}\n`);
  const before = p.snapshot();
  const r = sweepLedgers(p.dir, { now: NOW });
  assert.deepEqual(r.lines, ['register: cannot write .omelette/decisions.md (EFBIG) — nothing swept']);
  assert.equal(r.error, r.lines[0]);
  assert.deepEqual(p.snapshot(), before);
});

test('the register\'s directory unwritable: one "cannot write" line, no ledger touched', { skip: NOT_ROOT || GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', rule('x')));
  p.write('.omelette/ledger-other.md', ledger('feat/other', 'no binding here'));
  p.write('.omelette/decisions.md', 'register: docs/DECISIONS.md\n');
  p.write('docs/DECISIONS.md', '# head\n');
  const before = p.snapshot();
  chmodSync(join(p.dir, 'docs'), 0o555);
  try {
    const r = sweepLedgers(p.dir, { now: NOW });
    assert.deepEqual(r.lines, ['register: cannot write docs/DECISIONS.md (EACCES) — nothing swept']);
    assert.equal(r.error, r.lines[0]);
    assert.equal(r.archived, 0);
  } finally {
    chmodSync(join(p.dir, 'docs'), 0o755);
  }
  assert.deepEqual(p.snapshot(), before);
});

test('archive/ unwritable after the register write: "not moved (EACCES)", the ledger keeps its closed line, and the retry adds no register line', { skip: NOT_ROOT || GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', rule('x')));
  mkdirSync(join(p.dir, '.omelette', 'archive'));
  const original = p.read('.omelette/ledger-gone.md');
  chmodSync(join(p.dir, '.omelette', 'archive'), 0o555);
  let r;
  try {
    r = sweepLedgers(p.dir, { now: NOW });
    assert.deepEqual(r.lines, ['closed: ledger-gone.md (feat/gone gone) — 1 binding ruling → .omelette/decisions.md; not moved (EACCES)']);
    assert.equal(r.error, null);
    assert.deepEqual(r.ledgers.map((l) => `${l.name}:${l.state}`), ['ledger-gone.md:closed']);
    assert.equal(r.archived, 0);
    const registerText = '- 2026-10-02 · gone · Ruling(binding): x — why — cost\n';
    assert.equal(p.read('.omelette/decisions.md'), registerText);
    assert.equal(p.read('.omelette/ledger-gone.md'), `${original}closed 2026-11-02T12:00:00.000Z by sweep — 1 binding ruling → .omelette/decisions.md\n`);
    // The retry once archive/ is writable: the register gains nothing, the ledger moves.
    chmodSync(join(p.dir, '.omelette', 'archive'), 0o755);
    const again = sweepLedgers(p.dir, { now: new Date('2026-11-03T08:00:00.000Z') });
    assert.match(again.lines[0], /, moved to \.omelette\/archive\/$/);
    const archived = p.read('.omelette/archive/ledger-gone.md');
    assert.deepEqual(archived.split('\n').filter((l) => l.startsWith('closed ')), ['closed 2026-11-02T12:00:00.000Z by sweep — 1 binding ruling → .omelette/decisions.md'], 'one closed line, the first run\'s');
    assert.equal(archived, `${original}closed 2026-11-02T12:00:00.000Z by sweep — 1 binding ruling → .omelette/decisions.md\n`);
    assert.equal(p.read('.omelette/decisions.md'), registerText);
    assert.ok(existsSync(join(p.dir, '.omelette', 'archive', 'ledger-gone.md')));
    assert.equal(lstatSync(join(p.dir, '.omelette', 'archive', 'ledger-gone.md')).nlink, 1);
  } finally {
    chmodSync(join(p.dir, '.omelette', 'archive'), 0o755);
  }
});
