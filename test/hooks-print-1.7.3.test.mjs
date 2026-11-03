/**
 * omelette-fleet :: test/hooks-print-1.7.3.test.mjs
 * 1.7.3 spec, "The print": on compact and clear, after the sweep, the open
 * ledgers' last handoff (then the untracked ones'), the register (6 KB from
 * its tail), the backlog's first table (2 KB), under the 12 KB cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';
import { GIT_SKIP, ledger, printed, project } from './fixtures/ledger-1.7.3.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// The guard's HOME is a throwaway of its own, never the project: a project
// whose `.omelette` is the fleet home ($HOME/.omelette) is not swept.
const HOME = mkdtempSync(join(tmpdir(), 'omelette-home-173-'));

function guard({ pkg = ROOT, handoff = { enabled: true } } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'omelette-guard-173-')), HOOK_FILES[0]);
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.7.3', handoff, pkg));
  return path;
}
function fire(path, event, cwd) {
  const r = spawnSync(process.execPath, [path], {
    input: JSON.stringify({ cwd, ...event }), encoding: 'utf8', cwd, timeout: 20000,
    env: { PATH: process.env.PATH, HOME },
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  const out = r.stdout || '';
  return { code: r.status, out: event.hook_event_name === 'SessionStart' ? printed(out) : out, err: r.stderr || '' };
}

const start = (source) => ({ hook_event_name: 'SessionStart', source });
const handoff = (who) => ['## Handoff', `${who}: next action`];

test('SessionStart prints on clear as on compact; startup, resume and fork print nothing', () => {
  const g = guard();
  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', '# x\n## Handoff\nnext: run npm test\n');
  const expected = '--- ledger-x.md · last handoff ---\n## Handoff\nnext: run npm test\n';
  for (const source of ['clear', 'compact']) assert.equal(fire(g, start(source), p.dir).out, expected, source);
  for (const source of ['startup', 'resume', 'fork', 'Clear', '']) assert.equal(fire(g, start(source), p.dir).out, '', source);
});

test('the print answers the three questions in order: open ledgers then untracked ones, the register, the backlog\'s first table', { skip: GIT_SKIP }, () => {
  const p = project();
  p.git(['branch', 'feat/b']);
  p.write('.omelette/ledger-b-open.md', ledger('feat/b', ...handoff('B')));
  p.write('.omelette/ledger-c-lane.md', ledger('main', ...handoff('C')));
  p.write('.omelette/ledger-a-old.md', ['# a', ...handoff('A'), ''].join('\n'));
  p.write('.omelette/decisions.md', 'register: docs/DECISIONS.md\n');
  p.write('docs/DECISIONS.md', '# Decisions\n\n- 2026-11-01 · 1.7.2 · Ruling(binding): one — two — three\n\n');
  p.write('.omelette/backlog.md', '# Backlog\n\nintro\n\n| # | What |\n|---|---|\n| 1 | next |\n\n| 2 | a second table |\n');
  const r = fire(guard(), start('clear'), p.dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  assert.equal(r.out, [
    '--- ledger-b-open.md · last handoff ---', '## Handoff', 'B: next action', '',
    '--- ledger-c-lane.md · last handoff ---', '## Handoff', 'C: next action', '',
    '--- ledger-a-old.md · last handoff ---', '## Handoff', 'A: next action', '',
    '--- docs/DECISIONS.md · decisions register ---', '# Decisions', '', '- 2026-11-01 · 1.7.2 · Ruling(binding): one — two — three', '',
    '--- .omelette/backlog.md · first table ---', '| # | What |', '|---|---|', '| 1 | next |', '',
  ].join('\n'));
});

test('the register prints whole up to 6 KB, and from its tail past that, under the tail note', () => {
  const g = guard();
  const p = project({ git: false });
  const lines = Array.from({ length: 100 }, (_, i) => `- 2026-11-01 · p · Ruling(binding): line ${String(i).padStart(3, '0')} ${'x'.repeat(70)}`);
  p.write('.omelette/decisions.md', `${lines.join('\n')}\n`);
  const out = fire(g, start('clear'), p.dir).out.split('\n');
  assert.equal(out[0], '--- .omelette/decisions.md · decisions register ---');
  assert.equal(out[1], '[… register larger than 6 KB — its last 6 KB]');
  assert.ok(lines.includes(out[2]), 'the tail opens on a whole line');
  assert.ok(out.includes(lines[99]));
  assert.ok(!out.includes(lines[0]));
  assert.ok(Buffer.byteLength(out.slice(2).join('\n'), 'utf8') <= 6 * 1024);
  p.write('.omelette/decisions.md', `${lines.slice(0, 10).join('\n')}\n`);
  assert.equal(fire(g, start('clear'), p.dir).out, `--- .omelette/decisions.md · decisions register ---\n${lines.slice(0, 10).join('\n')}\n`);
});

test('the backlog\'s first table is bounded at 2 KB by whole lines; no backlog, no section', () => {
  const g = guard();
  const p = project({ git: false });
  const rows = Array.from({ length: 60 }, (_, i) => `| ${i} | ${'y'.repeat(60)} |`);
  p.write('.omelette/backlog.md', ['# Backlog', '', '| # | What |', '|---|---|', ...rows, ''].join('\n'));
  const lines = fire(g, start('clear'), p.dir).out.split('\n');
  assert.equal(lines[0], '--- .omelette/backlog.md · first table ---');
  assert.equal(lines[lines.length - 2], '[… truncated]');
  assert.ok(Buffer.byteLength(lines.slice(1, -2).join('\n'), 'utf8') <= 2048);
  assert.ok(lines.slice(1, -2).every((l) => l.startsWith('|')), 'whole table lines only');
  rmSync(join(p.dir, '.omelette', 'backlog.md'));
  assert.equal(fire(g, start('clear'), p.dir).out, '', 'nothing to print is printed as nothing');
});

test('the 12 KB cap drops a whole handoff section, never half of one, and never the register or the backlog', () => {
  const p = project({ git: false });
  const big = ['## Handoff', ...Array.from({ length: 39 }, (_, i) => `${'h'.repeat(99)}${i % 10}`)].join('\n');
  p.write('.omelette/ledger-a.md', big);
  p.write('.omelette/ledger-b.md', big);
  p.write('.omelette/decisions.md', Array.from({ length: 80 }, (_, i) => `- 2026-11-01 · p · Ruling(binding): ${i} ${'r'.repeat(90)}`).join('\n'));
  p.write('.omelette/backlog.md', '| # | What |\n|---|---|\n| 1 | next |\n');
  const r = fire(guard(), start('compact'), p.dir);
  assert.ok(Buffer.byteLength(r.out, 'utf8') <= 12 * 1024, `${Buffer.byteLength(r.out, 'utf8')} bytes`);
  assert.ok(r.out.includes(`--- ledger-a.md · last handoff ---\n${big}\n[… truncated]\n\n--- .omelette/decisions.md · decisions register ---\n`), 'ledger-a whole, then the marker');
  assert.equal(r.out.includes('--- ledger-b.md · last handoff ---'), false, 'the handoff past what the register and the backlog leave is dropped whole');
  assert.ok(r.out.endsWith('--- .omelette/backlog.md · first table ---\n| # | What |\n|---|---|\n| 1 | next |\n'));
});

test('a register that cannot be printed says so in one heading: a refused register: line, a guard that cannot load the sweep', () => {
  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', '## Handoff\nnext: fix the register line\n');
  p.write('.omelette/decisions.md', 'register: ../outside.md\n');
  const block = '--- ledger-x.md · last handoff ---\n## Handoff\nnext: fix the register line\n';
  const refused = fire(guard(), start('clear'), p.dir);
  assert.equal(refused.out, `${block}\n--- decisions register not printed: register: ../outside.md refused (contains ..) ---\n`);
  assert.equal(refused.err, 'omelette-guard: register: ../outside.md refused (contains ..) — nothing swept\n');
  const missing = join(mkdtempSync(join(tmpdir(), 'omelette-gone-')), 'pkg');
  assert.equal(fire(guard({ pkg: missing }), start('clear'), p.dir).out,
    `${block}\n--- decisions register not printed: the guard could not load core/ledger.mjs — run omelette-fleet rules --hooks ---\n`);
});

test('after the sweep has emptied the root, a clear still hands over the register and the backlog', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-done.md', ledger('feat/done', '- 2026-11-01 Ruling(binding): kept — it binds — cost: none', '## Handoff', 'done: merged'));
  p.write('.omelette/backlog.md', '| # | What |\n|---|---|\n| 1 | the next plan |\n');
  const r = fire(guard(), start('clear'), p.dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, [
    '--- .omelette/decisions.md · decisions register ---',
    '- 2026-11-01 · done · Ruling(binding): kept — it binds — cost: none', '',
    '--- .omelette/backlog.md · first table ---', '| # | What |', '|---|---|', '| 1 | the next plan |', '',
  ].join('\n'));
});
