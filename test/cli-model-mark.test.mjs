/**
 * omelette-fleet :: test/cli-model-mark.test.mjs
 * The config table (`show`, `doctor`) marks a configured model the unit's
 * catalog does not list: a catalog sweep (1.11.0 retired the 3.8 Flash ids)
 * leaves an older config naming an id that no longer resolves. Run through
 * the CLI as a child process on a throwaway OMELETTE_HOME.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'omelette-fleet.mjs');
const MARK = " — not in the catalog's list: ignored at call time";

/** `show <unit>` on a fresh home holding `units` as its config; returns the `model` row. */
function modelRow(unit, units) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-model-mark-'));
  if (units) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units }));
  const r = spawnSync(process.execPath, [BIN, 'show', unit], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 5000,
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  const row = (r.stdout || '').split('\n').find((l) => /^\s+model\s/.test(l));
  assert.ok(row, r.stdout);
  return row;
}

test('show gemini: a retired 3.8 Flash id carries the mark', () => {
  const row = modelRow('gemini', { gemini: { model: 'Gemini 3.8 Flash (High)' } });
  assert.ok(row.endsWith(MARK), row);
});

test('show gemini: a catalog id carries no mark', () => {
  const row = modelRow('gemini', { gemini: { model: 'Gemini 4 Hydrogen (High)' } });
  assert.ok(!row.includes('not in the catalog'), row);
});

test('show gemini: no configured model carries no mark', () => {
  const row = modelRow('gemini');
  assert.ok(!row.includes('not in the catalog'), row);
});

test('show codex: a stale id carries the same unit-neutral mark', () => {
  const row = modelRow('codex', { codex: { model: 'gpt-0-nope' } });
  assert.ok(row.endsWith(MARK), row);
});
