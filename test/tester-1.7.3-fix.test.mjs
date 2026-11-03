/**
 * omelette-fleet :: test/tester-1.7.3-fix.test.mjs
 * Tester's probes of the 1.7.3 release fix round that test/fix-1.7.3.test.mjs
 * does not pin: where a leading pointer stops being one, what the sweep's
 * date-free dedupe must still keep apart, the print's byte budget across the
 * boundary where the marker needs room, and the edges of `ledger open`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyLedger, harvestBindings, openLedger, sweepLedgers } from '../core/ledger.mjs';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';
import { GIT_SKIP, PRINT_MARKER, ledger, printed, project } from './fixtures/ledger-1.7.3.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = mkdtempSync(join(tmpdir(), 'omelette-home-tfix173-'));
const NO_GIT = { PATH: '/nonexistent-omelette-bin' };
const DAY_1 = new Date('2026-11-05T12:00:00.000Z');
const DAY_2 = new Date('2026-11-06T12:00:00.000Z');
const TRUNCATED = '[… truncated]';
const bytes = (s) => Buffer.byteLength(s, 'utf8');

function guard() {
  const path = join(mkdtempSync(join(tmpdir(), 'omelette-guard-tfix173-')), HOOK_FILES[0]);
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.7.3', { enabled: true }, ROOT));
  return path;
}
function fire(path, cwd) {
  const r = spawnSync(process.execPath, [path], {
    input: JSON.stringify({ cwd, hook_event_name: 'SessionStart', source: 'compact' }), encoding: 'utf8', cwd, timeout: 20000,
    env: { PATH: process.env.PATH, HOME },
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
  return printed(r.stdout || '');
}
const headings = (out) => out.split('\n').filter((l) => l.startsWith('--- '));
const HANDOFF = ['## Handoff', ...Array.from({ length: 39 }, (_, i) => `${'h'.repeat(99)}${i % 10}`)].join('\n');

test('a pointer before the marker is one only when ` · ` joins it to the marker, right up to it, opening a word', () => {
  const cases = [
    ['core/a.mjs:3 · `x` Ruling(binding): no separator — cost: none', false],
    ['core/a.mjs:3 · `x` · note · Ruling(binding): text between — cost: none', false],
    ['core/a.mjs:3 · `x` —  Ruling(binding): em dash — cost: none', false],
    ['see:core/a.mjs:3 · `x` · Ruling(binding): glued to a word — cost: none', false],
    ['core/a.mjs:3 · `x` ·Ruling(binding): no space after — cost: none', false],
    ['core/a.mjs:3 · `x` · Ruling(binding): proper — cost: none', true],
    ['core/a.mjs:3 · `x`  ·  Ruling(binding): wide separators — cost: none', true],
  ];
  for (const [line, moves] of cases) {
    const [b] = harvestBindings(`${line}\n`);
    assert.equal('pointer' in b, moves, line);
    if (moves) assert.deepEqual(b.pointer, { path: 'core/a.mjs', line: '3', fragment: 'x' });
  }
  // No pointer, no key: the shape the older callers destructure.
  assert.deepEqual(harvestBindings('- 2026-11-02 Ruling(binding): plain — cost: none\n'), [{ ruling: 'Ruling(binding): plain — cost: none', date: '2026-11-02' }]);
});

test('a pointer-first ledger line with no date takes the sweep\'s day and is dedupe-held on a later day', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', '- core/a.mjs:1 · `frag` · Ruling(binding): lead only — cost: none'));
  sweepLedgers(p.dir, { now: DAY_1 });
  const line = '- core/a.mjs:1 · `frag` · 2026-11-05 · gone · Ruling(binding): lead only — cost: none';
  assert.equal(p.read('.omelette/decisions.md'), `${line}\n`);
  // A second ledger of the same plan name restating it on another day adds nothing.
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', 'Ruling(binding): lead only — cost: none · core/a.mjs:1 · `frag`'));
  sweepLedgers(p.dir, { now: DAY_2 });
  assert.equal(p.read('.omelette/decisions.md'), `${line}\n`);
});

test('the date-free dedupe still keeps apart another plan and another ruling — a moved pointer is the same ruling (session ruling on the re-review, N2)', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/decisions.md', '- 2026-10-01 · alpha · Ruling(binding): same — cost: none\n- core/a.mjs:1 · `f` · 2026-10-01 · alpha · Ruling(binding): pinned — cost: none\n');
  p.write('.omelette/ledger-alpha.md', ledger('feat/alpha',
    '- 2026-11-01 Ruling(binding): same — cost: none',          // held: same plan, older date
    '- 2026-11-01 Ruling(binding): pinned — cost: none · core/a.mjs:2 · `f`', // another line number: the same ruling, held
    '- 2026-11-01 Ruling(binding): other — cost: none'));         // new
  p.write('.omelette/ledger-beta.md', ledger('feat/beta', '- 2026-11-01 Ruling(binding): same — cost: none')); // another plan: new
  sweepLedgers(p.dir, { now: DAY_1 });
  assert.equal(p.read('.omelette/decisions.md'), [
    '- 2026-10-01 · alpha · Ruling(binding): same — cost: none',
    '- core/a.mjs:1 · `f` · 2026-10-01 · alpha · Ruling(binding): pinned — cost: none',
    '- 2026-11-01 · alpha · Ruling(binding): other — cost: none',
    '- 2026-11-01 · beta · Ruling(binding): same — cost: none',
    '',
  ].join('\n'));
});

test('the print never exceeds 12 KB at any register size across the boundary where the marker needs room, and the register always survives', () => {
  const g = guard();
  const p = project({ git: false });
  for (const n of ['a', 'b', 'c']) p.write(`.omelette/ledger-${n}.md`, HANDOFF);
  const setRegister = (pad) => p.write('.omelette/decisions.md', `- one ruling\nz${'z'.repeat(pad)}\n`);
  let sawPop = false;
  let sawFull = false;
  // a and b fit and c does not from pad 267 on; from about pad 4238 the 14-byte marker has no room after b, so b goes too.
  // Since 1.8.0 the print's first line (PRINT_MARKER) is counted inside the cap: every bound moves down by its bytes.
  const lead = bytes(PRINT_MARKER);
  for (let pad = 4225 - lead; pad <= 4262 - lead; pad += 1) {
    setRegister(pad);
    const out = fire(g, p.dir);
    const hs = headings(out);
    assert.ok(lead + bytes(out) <= 12288, `pad ${pad}: ${lead + bytes(out)} bytes`);
    assert.equal(hs[hs.length - 1], '--- .omelette/decisions.md · decisions register ---', `pad ${pad}: the register is printed`);
    assert.ok(out.endsWith(`z${'z'.repeat(pad)}\n`), `pad ${pad}: the register is whole`);
    const shown = hs.filter((h) => h.endsWith('· last handoff ---')).map((h) => /ledger-(.)\.md/.exec(h)[1]);
    assert.deepEqual(shown, ['a', 'b', 'c'].slice(0, shown.length), `pad ${pad}: handoffs are a prefix in name order`);
    const marks = out.split('\n').filter((l) => l === TRUNCATED).length;
    assert.equal(marks, shown.length < 3 ? 1 : 0, `pad ${pad}: one marker iff a handoff is missing`);
    if (shown.length === 2) sawFull = true;
    if (shown.length === 1) sawPop = true;
  }
  assert.ok(sawFull && sawPop, `the sweep must cross the boundary (two handoffs: ${sawFull}, popped to one: ${sawPop})`);
});

test('with no register and no backlog the handoffs fill 12 KB, the rest are dropped whole and the marker is the last line', () => {
  const p = project({ git: false });
  for (const n of ['a', 'b', 'c', 'd']) p.write(`.omelette/ledger-${n}.md`, HANDOFF);
  const out = fire(guard(), p.dir);
  assert.ok(bytes(out) <= 12288, `${bytes(out)}`);
  assert.deepEqual(headings(out), ['a', 'b', 'c'].map((n) => `--- ledger-${n}.md · last handoff ---`));
  assert.ok(out.endsWith(`${HANDOFF}\n${TRUNCATED}\n`), out.slice(-60));
  assert.equal(out.split('\n').filter((l) => l === TRUNCATED).length, 1);
});

test('ledger open: an archived neighbour with a similar name does not block, a directory in the archive does, and a branch named heads/x keeps its name', { skip: GIT_SKIP }, () => {
  const p = project();
  p.git(['checkout', '-q', '-b', 'feat/x']);
  p.write('.omelette/archive/ledger-x2.md', ledger('feat/old'));
  p.write('.omelette/archive/ledger-xx.md', ledger('feat/old'));
  assert.deepEqual(openLedger(p.dir, 'x'), { rel: '.omelette/ledger-x.md', branch: 'feat/x' });
  mkdirSync(join(p.dir, '.omelette', 'archive', 'ledger-d.md'));
  assert.deepEqual(openLedger(p.dir, 'd'), { error: '.omelette/ledger-d.md would collide with .omelette/archive/ledger-d.md once closed — pick another plan name' });
  assert.equal(existsSync(join(p.dir, '.omelette', 'ledger-d.md')), false);
  if (process.platform !== 'win32') {
    p.write('.omelette/real.md', 'x');
    symlinkSync('real.md', join(p.dir, '.omelette', 'archive', 'ledger-s.md'));
    assert.match(openLedger(p.dir, 's').error, /would collide with \.omelette\/archive\/ledger-s\.md/);
  }
  p.git(['checkout', '-q', '-b', 'heads/y']);
  assert.deepEqual(openLedger(p.dir, 'y'), { rel: '.omelette/ledger-y.md', branch: 'heads/y' });
  assert.equal(classifyLedger(p.dir, 'ledger-y.md').state, 'open');
});

test('only main, master and trunk are standing: a lookalike branch is asked of git', () => {
  const p = project({ git: false });
  for (const b of ['mainline', 'main2', 'Main', 'trunk-x', 'masters']) {
    p.write('.omelette/ledger-l.md', ledger(b));
    assert.equal(classifyLedger(p.dir, 'ledger-l.md', { env: NO_GIT }).state, 'unknown', b);
  }
});
