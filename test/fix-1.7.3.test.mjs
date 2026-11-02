/**
 * omelette-fleet :: test/fix-1.7.3.test.mjs
 * The 1.7.3 release fix round: a pointer written before the binding marker,
 * the print's budget (the register and the backlog reserved first), `ledger
 * open` on a plan whose ledger is archived, the sweep's dedupe without the
 * date, a branch that shares its name with a tag, the standing branches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePointers } from '../core/check.mjs';
import { STANDING_BRANCHES, classifyLedger, openLedger, sweepLedgers } from '../core/ledger.mjs';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';
import { GIT_SKIP, ledger, project } from './fixtures/ledger-1.7.3.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
// The guard's HOME is a throwaway of its own: a project whose .omelette is $HOME/.omelette is the fleet home.
const HOME = mkdtempSync(join(tmpdir(), 'omelette-home-fix173-'));
const NO_GIT = { PATH: '/nonexistent-omelette-bin' };
const DAY_1 = new Date('2026-11-05T12:00:00.000Z');
const DAY_2 = new Date('2026-11-06T12:00:00.000Z');
const TRUNCATED = '[… truncated]';
const bytes = (s) => Buffer.byteLength(s, 'utf8');

function cli(p, args) {
  const home = mkdtempSync(join(tmpdir(), 'omelette-home-'));
  const gone = join(home, 'no-such-cli');
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: p.dir, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: home, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
/** doctor's rows from `ledgers` up to `contract`. */
const ledgerRows = (out) => out.slice(out.indexOf('\nledgers ') + 1, out.indexOf('\ncontract ')).split('\n');

function guard() {
  const path = join(mkdtempSync(join(tmpdir(), 'omelette-guard-fix173-')), HOOK_FILES[0]);
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.7.3', { enabled: true }, ROOT));
  return path;
}
function fire(path, event, cwd) {
  const r = spawnSync(process.execPath, [path], {
    input: JSON.stringify({ cwd, ...event }), encoding: 'utf8', cwd, timeout: 20000,
    env: { PATH: process.env.PATH, HOME },
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const compact = { hook_event_name: 'SessionStart', source: 'compact' };
const headings = (out) => out.split('\n').filter((l) => l.startsWith('--- '));
/** A handoff block at lastHandoffBlock's caps: 40 lines, 4,067 of its 4,096 bytes. */
const BIG_HANDOFF = ['## Handoff', ...Array.from({ length: 39 }, (_, i) => `${'h'.repeat(102)}${i % 10}`)].join('\n');
/** A register past 6 KB in 64-byte lines: it prints as its last 96 lines, 6,144 bytes, under the tail note. */
const BIG_REGISTER = `${Array.from({ length: 150 }, (_, i) => `- r ${String(i).padStart(3, '0')} ${'r'.repeat(55)}`).join('\n')}\n`;
const SMALL_TABLE = '| # | What |\n|---|---|\n| 1 | the next plan |\n';

test('a pointer written before the marker moves to the front as a trailing one does; a trailing one wins over it; one joined by em dashes stays prose', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-1.7.3.md', ledger('feat/1.7.3',
    "- 2026-11-02 hooks/omelette-guard.mjs:881 · `const LEDGER_MODULE = join(String(PACKAGE_ROOT), 'core', 'ledger.mjs')` · Ruling(binding): one logic — the guard imports it — cost: a stale hook skips the sweep",
    '- 2026-11-02 `core/ledger.mjs:205` · `export const REGISTER_DEFAULT` · Ruling(binding): backticked — the same pointer — cost: none',
    '- 2026-11-02 core/a.mjs:1 · `lead` · Ruling(binding): both — the trailing one wins — cost: none · core/b.mjs:2 · `trail`',
    '- 2026-11-02 core/a.mjs:3 — `const a = 1` — Ruling(binding): em dashes — prose — cost: none',
    'Ruling(binding): trailing — still moves — cost: none · core/c.mjs:4 · `trail`',
  ));
  sweepLedgers(p.dir, { now: DAY_1 });
  const lines = p.read('.omelette/decisions.md').split('\n').filter(Boolean);
  assert.deepEqual(lines, [
    "- hooks/omelette-guard.mjs:881 · `const LEDGER_MODULE = join(String(PACKAGE_ROOT), 'core', 'ledger.mjs')` · 2026-11-02 · 1.7.3 · Ruling(binding): one logic — the guard imports it — cost: a stale hook skips the sweep",
    '- core/ledger.mjs:205 · `export const REGISTER_DEFAULT` · 2026-11-02 · 1.7.3 · Ruling(binding): backticked — the same pointer — cost: none',
    '- core/b.mjs:2 · `trail` · 2026-11-02 · 1.7.3 · Ruling(binding): both — the trailing one wins — cost: none',
    '- 2026-11-02 · 1.7.3 · Ruling(binding): em dashes — prose — cost: none',
    '- core/c.mjs:4 · `trail` · 2026-11-05 · 1.7.3 · Ruling(binding): trailing — still moves — cost: none',
  ]);
  assert.deepEqual(parsePointers(lines[0]), [{ line: 1, path: 'hooks/omelette-guard.mjs', lineNo: 881, fragment: "const LEDGER_MODULE = join(String(PACKAGE_ROOT), 'core', 'ledger.mjs')" }]);
});

test('the print reserves the register and the backlog first: a 4 KB handoff, a 6 KB+ register and a backlog table print all three under 12 KB; past the cap the handoff is what goes', () => {
  const g = guard();
  const p = project({ git: false });
  p.write('.omelette/ledger-a.md', BIG_HANDOFF);
  p.write('.omelette/decisions.md', BIG_REGISTER);
  p.write('.omelette/backlog.md', SMALL_TABLE);
  const fits = fire(g, compact, p.dir);
  assert.equal(fits.code, 0, fits.err);
  assert.deepEqual(headings(fits.out), [
    '--- ledger-a.md · last handoff ---', '--- .omelette/decisions.md · decisions register ---', '--- .omelette/backlog.md · first table ---',
  ]);
  assert.ok(bytes(fits.out) <= 12 * 1024, `${bytes(fits.out)} bytes`);
  assert.equal(fits.out.includes(TRUNCATED), false);

  // The backlog at its 2 KB cap: the three no longer fit, and the handoff — not the backlog — is dropped.
  p.write('.omelette/backlog.md', ['| # | What |', '|---|---|', ...Array.from({ length: 60 }, (_, i) => `| ${i} | ${'y'.repeat(60)} |`), ''].join('\n'));
  const over = fire(g, compact, p.dir);
  assert.deepEqual(headings(over.out), ['--- .omelette/decisions.md · decisions register ---', '--- .omelette/backlog.md · first table ---']);
  assert.ok(over.out.startsWith(`${TRUNCATED}\n\n--- .omelette/decisions.md · decisions register ---\n`), over.out.slice(0, 120));
  assert.ok(bytes(over.out) <= 12 * 1024, `${bytes(over.out)} bytes`);
});

test('five untracked 4 KB handoffs never crowd out the register and the backlog: the handoffs that do not fit are dropped whole, in name order, with one marker', () => {
  const p = project({ git: false });
  for (const n of ['a', 'b', 'c', 'd', 'e']) p.write(`.omelette/ledger-${n}.md`, BIG_HANDOFF);
  p.write('.omelette/decisions.md', BIG_REGISTER);
  p.write('.omelette/backlog.md', SMALL_TABLE);
  const r = fire(guard(), compact, p.dir);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(headings(r.out), [
    '--- ledger-a.md · last handoff ---', '--- .omelette/decisions.md · decisions register ---', '--- .omelette/backlog.md · first table ---',
  ]);
  assert.ok(r.out.includes(`${BIG_HANDOFF}\n${TRUNCATED}\n\n--- .omelette/decisions.md · decisions register ---\n`), 'the marker stands where the handoffs stop');
  assert.equal(r.out.split('\n').filter((l) => l === TRUNCATED).length, 1);
  assert.ok(r.out.endsWith(`--- .omelette/backlog.md · first table ---\n${SMALL_TABLE}`));
  assert.ok(bytes(r.out) <= 12 * 1024, `${bytes(r.out)} bytes`);
});

test('ledger open refuses a plan whose ledger is already archived — a file or a dangling symlink there — and creates nothing', { skip: GIT_SKIP }, () => {
  const p = project();
  p.git(['checkout', '-q', '-b', 'feat/x']);
  p.write('.omelette/archive/ledger-x.md', ledger('feat/old-x'));
  const before = p.snapshot();
  assert.deepEqual(cli(p, ['ledger', 'open', 'x']), {
    code: 1, out: '',
    err: 'omelette-fleet ledger open: .omelette/ledger-x.md would collide with .omelette/archive/ledger-x.md once closed — pick another plan name\n',
  });
  assert.deepEqual(p.snapshot(), before);
  if (process.platform !== 'win32') {
    symlinkSync('nowhere', join(p.dir, '.omelette', 'archive', 'ledger-y.md'));
    assert.deepEqual(openLedger(p.dir, 'y'), {
      error: '.omelette/ledger-y.md would collide with .omelette/archive/ledger-y.md once closed — pick another plan name',
    });
    assert.equal(existsSync(join(p.dir, '.omelette', 'ledger-y.md')), false);
  }
});

test('the sweep dedupes on the line without its date: a ruling restated undated in a handoff block is one register line', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone',
    '- 2026-10-02 Ruling(binding): same — restated — cost: none',
    '- 2026-10-02 Ruling(binding): pointed — restated — cost: none · core/a.mjs:1 · `frag`',
    '## Handoff',
    'Ruling(binding): same — restated — cost: none',
    'Ruling(binding): pointed — restated — cost: none · core/a.mjs:1 · `frag`',
  ));
  sweepLedgers(p.dir, { now: DAY_1 });
  assert.equal(p.read('.omelette/decisions.md'), [
    '- 2026-10-02 · gone · Ruling(binding): same — restated — cost: none',
    '- core/a.mjs:1 · `frag` · 2026-10-02 · gone · Ruling(binding): pointed — restated — cost: none',
    '',
  ].join('\n'));
});

test('the dedupe ignores the pointer too: a pointer-first log line restated without its pointer in a handoff block is one register line, the pointed one', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone',
    '- 2026-10-02 core/a.mjs:3 · `const a` · Ruling(binding): X — Y — cost: Z',
    '## Handoff',
    'Ruling(binding): X — Y — cost: Z',
  ));
  sweepLedgers(p.dir, { now: DAY_1 });
  assert.equal(p.read('.omelette/decisions.md'), '- core/a.mjs:3 · `const a` · 2026-10-02 · gone · Ruling(binding): X — Y — cost: Z\n');
});

test('a retry of the same ledger on a later day appends nothing: its undated rulings took the first sweep\'s day', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone',
    'Ruling(binding): undated — took the day — cost: none',
    'Ruling(binding): undated, pointed — took the day — cost: none · core/a.mjs:1 · `frag`',
  ));
  sweepLedgers(p.dir, { now: DAY_1 });
  const register = p.read('.omelette/decisions.md');
  assert.equal(register.split('\n').filter(Boolean).length, 2);
  // The move that failed: the ledger, its closed line appended, is still in the root on the next day.
  renameSync(join(p.dir, '.omelette', 'archive', 'ledger-gone.md'), join(p.dir, '.omelette', 'ledger-gone.md'));
  const r = sweepLedgers(p.dir, { now: DAY_2 });
  assert.deepEqual(r.lines, ['closed: ledger-gone.md (feat/gone gone) — 2 binding rulings → .omelette/decisions.md, moved to .omelette/archive/']);
  assert.equal(p.read('.omelette/decisions.md'), register);
});

test('ledger open names the branch, not heads/<branch>, when a tag has the same name; a HEAD outside refs/heads/ is refused', { skip: GIT_SKIP }, () => {
  const p = project();
  p.git(['tag', 'x']);
  p.git(['switch', '-q', '-c', 'x']);
  assert.deepEqual(openLedger(p.dir, 'x'), { rel: '.omelette/ledger-x.md', branch: 'x' });
  assert.equal(p.read('.omelette/ledger-x.md'), '# ledger x\nbranch: x\n\n');
  assert.equal(classifyLedger(p.dir, 'ledger-x.md').state, 'open');
  p.git(['symbolic-ref', 'HEAD', 'refs/tags/x']);
  assert.deepEqual(openLedger(p.dir, 'y'), { error: 'HEAD is not on a branch under refs/heads/' });
  assert.equal(existsSync(join(p.dir, '.omelette', 'ledger-y.md')), false);
});

test('master and trunk are standing as main is: never asked of git, never swept, and doctor counts them standing', { skip: GIT_SKIP }, () => {
  assert.deepEqual(STANDING_BRANCHES, ['main', 'master', 'trunk']);
  assert.equal(Object.isFrozen(STANDING_BRANCHES), true);
  const p = project(); // on main: neither master nor trunk exists as a branch
  p.write('.omelette/ledger-m.md', ledger('master', '- 2026-10-01 Ruling(binding): standing — never swept — cost: none'));
  p.write('.omelette/ledger-t.md', ledger('trunk'));
  assert.deepEqual(classifyLedger(p.dir, 'ledger-m.md', { env: NO_GIT }), { name: 'ledger-m.md', plan: 'm', state: 'standing', branch: 'master' });
  assert.deepEqual(classifyLedger(p.dir, 'ledger-t.md', { env: NO_GIT }), { name: 'ledger-t.md', plan: 't', state: 'standing', branch: 'trunk' });
  assert.deepEqual(ledgerRows(cli(p, ['doctor']).out), [
    'ledgers       0 open, 2 standing (ledger-m.md, ledger-t.md), 0 untracked, 0 archived',
    'decisions     .omelette/decisions.md — none yet',
  ]);
  assert.equal(existsSync(join(p.dir, '.omelette', 'ledger-m.md')), true, 'a standing ledger stays in the root');
});
