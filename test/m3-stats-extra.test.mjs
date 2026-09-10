/**
 * omelette-fleet :: test/m3-stats-extra.test.mjs
 * Tester coverage for 0.3.7 M3 (`results --stats`, the `usage:` header) beyond
 * what the implementer's own test/results.test.mjs and test/cli.test.mjs
 * already exercise: the exact `since` boundary, real-zero vs. no-usage,
 * case-insensitive `--since` windows, a per-unit `--stats` + `--since` combo,
 * and the plain `results <unit> <id>` command actually printing the new
 * `usage:` line end-to-end through the CLI (not just through renderResult
 * called directly).
 *
 * Written against the spec at
 * docs/superpowers/specs/2026-09-10-0.3.7-design.md (M3). Never edits the
 * implementation or the implementer's tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResultStore, parseResult, renderResult } from '../core/results.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

const home = () => mkdtempSync(join(tmpdir(), 'omelette-m3-'));
const store = (dir, o = {}) => createResultStore({ home: dir, unit: 'fake', ...o });

const REC = {
  resultId: '20260908T142501Z-19312-1',
  tool: 'codex_code_review',
  model: 'gpt-6-astra',
  effort: 'xhigh',
  startedAt: '2026-09-08T14:25:01.000Z',
  endedAt: '2026-09-08T14:43:02.000Z',
  durationMs: 1081000,
  status: 'ok',
  partial: false,
  detached: false,
  cwd: '/tmp/project',
  promptPreview: 'review the Movie app',
  text: 'the review',
};

function cli(args, { dir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function spoolResult(dir, unit, rec) {
  const d = join(dir, 'results', unit);
  mkdirSync(d, { recursive: true });
  const path = join(d, `${rec.resultId}.md`);
  writeFileSync(path, renderResult({ ...rec, unit }));
  return path;
}

// ─── stats(): exact boundary and real-zero vs. no-usage ─────────────────────

test('stats: a record whose startedAt equals the cutoff exactly is INSIDE the window', () => {
  const dir = home();
  const s = store(dir);
  const cutoff = Date.parse('2026-09-08T12:00:00.000Z');
  s.write({ ...REC, resultId: '20260908T120000Z-1-1', startedAt: '2026-09-08T12:00:00.000Z', endedAt: '2026-09-08T12:00:01.000Z', durationMs: 1000 });
  s.write({ ...REC, resultId: '20260908T115959Z-1-2', startedAt: '2026-09-08T11:59:59.000Z', endedAt: '2026-09-08T11:59:59.000Z', durationMs: 1000 });

  const r = s.stats({ since: cutoff });
  assert.equal(r.calls, 1, 'the record dated exactly at the cutoff is counted; the one a second earlier is not');
});

test('stats: a call that reported ZERO tokens is "reported", not folded into "no usage" like a call that reported nothing', () => {
  const dir = home();
  const s = store(dir);
  s.write({ ...REC, resultId: '20260908T142501Z-1-1', usage: { input: 0, output: 0 } });
  s.write({ ...REC, resultId: '20260908T142501Z-1-2', usage: null });

  const r = s.stats();
  assert.equal(r.calls, 2);
  assert.equal(r.reported, 1, 'exactly the call that reported a real (zero) pair, not the one that reported nothing');
  assert.equal(r.input, 0);
  assert.equal(r.output, 0);
});

// ─── core/results.mjs: parseUsage tolerates stray whitespace ────────────────

test('parseUsage: extra whitespace between key=value tokens does not break the pair', () => {
  const body = ['---', 'unit: fake', 'usage:  input=10    output=20  ', '---', 'x'].join('\n');
  assert.deepEqual(parseResult(body).header.usage, { input: 10, output: 20 });
});

// ─── CLI: --since is case-insensitive on its window suffix ──────────────────

test('results --stats --since: the window suffix is case-insensitive (24H, 7D)', () => {
  const dir = home();
  const now = Date.now();
  const at = (hoursAgo) => new Date(now - hoursAgo * 3600 * 1000).toISOString();
  spoolResult(dir, 'grok', {
    resultId: '20260908T150000Z-1-1', tool: 'grok_research', startedAt: at(1), endedAt: at(1), durationMs: 1000,
    status: 'ok', partial: false, detached: false, promptPreview: 'x', usage: { input: 1, output: 1 }, text: 'x',
  });

  const upperH = cli(['results', '--stats', '--since', '24H'], { dir });
  assert.equal(upperH.code, 0, upperH.err);
  assert.match(upperH.out, /^grok +1 /m);

  const upperD = cli(['results', '--stats', '--since', '7D'], { dir });
  assert.equal(upperD.code, 0, upperD.err);
  assert.match(upperD.out, /^grok +1 /m);
});

// ─── CLI: --stats <unit> --since <window> combined ───────────────────────────

test('results --stats <unit> --since <window>: the two filters compose, in-window and per-unit at once', () => {
  const dir = home();
  const now = Date.now();
  const at = (hoursAgo) => new Date(now - hoursAgo * 3600 * 1000).toISOString();
  const rec = (unit, id, hoursAgo) => spoolResult(dir, unit, {
    resultId: id, tool: `${unit}_research`, startedAt: at(hoursAgo), endedAt: at(hoursAgo), durationMs: 1000,
    status: 'ok', partial: false, detached: false, promptPreview: 'x', usage: { input: 2, output: 2 }, text: 'x',
  });
  rec('codex', '20260908T150000Z-1-1', 1);   // in window, codex
  rec('codex', '20260908T150000Z-1-2', 30);  // out of window, codex
  rec('grok', '20260908T150000Z-1-3', 1);    // in window, but a different unit

  const inWindow = cli(['results', '--stats', 'codex', '--since', '24h'], { dir });
  assert.equal(inWindow.code, 0, inWindow.err);
  const lines = inWindow.out.trim().split('\n');
  assert.equal(lines.length, 4, 'since line, header, codex row, total row — grok is filtered out by unit, the old codex call by the window');
  assert.match(lines[2], /^codex +1 +1\/0\/0 +0 +\d+s +\d+ [KM]?B +2 \/ 2$/);

  // The old codex call is outside the window, and no OTHER unit's calls leak
  // through the unit filter: codex with no matches in a window it has none for.
  const noneInWindow = cli(['results', '--stats', 'codex', '--since', '48h'], { dir });
  // 48h window includes both codex calls (1h and 30h ago), so this asserts the
  // opposite composition still works: unit filter narrows, window widens back.
  assert.equal(noneInWindow.code, 0, noneInWindow.err);
  assert.match(noneInWindow.out, /^codex +2 /m);

  const trulyEmpty = cli(['results', '--stats', 'grok', '--since', '2999-01-01'], { dir });
  assert.equal(trulyEmpty.code, 0, trulyEmpty.err);
  assert.match(trulyEmpty.out, /^no results$/m, 'a per-unit filter combined with a future window has nothing to report, same as an empty spool');
});

// ─── CLI: `results <unit> <id>` (no --stats) actually prints the usage: line ─

test('results <unit> <id>: the usage: line is printed end-to-end through the plain (non-stats) CLI read, and is absent when there is none', () => {
  const dir = home();
  spoolResult(dir, 'codex', {
    ...REC, resultId: '20260908T142501Z-1-1',
    usage: { input: 60835, cachedInput: 45312, output: 236, reasoning: 103 },
  });
  spoolResult(dir, 'codex', {
    ...REC, resultId: '20260908T142501Z-1-2', text: 'no tokens reported',
  });

  const withUsage = cli(['results', 'codex', '20260908T142501Z-1-1'], { dir });
  assert.equal(withUsage.code, 0, withUsage.err);
  assert.match(withUsage.out, /\nusage: input=60835 output=236 cachedInput=45312 reasoning=103\n/);

  const withoutUsage = cli(['results', 'codex', '20260908T142501Z-1-2'], { dir });
  assert.equal(withoutUsage.code, 0, withoutUsage.err);
  assert.ok(!withoutUsage.out.includes('usage:'), 'no usage: line for a record that never had one');
});
