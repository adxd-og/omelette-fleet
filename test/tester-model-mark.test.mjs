/**
 * omelette-fleet :: test/tester-model-mark.test.mjs
 * Cases test/cli-model-mark.test.mjs does not reach: a model that arrives from
 * the legacy env override, the `doctor` table, and the `gemini_models`
 * description naming every tool that takes `model`.
 * Child processes on a throwaway OMELETTE_HOME, PATH holding no vendor CLI.
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

function run(args, units, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-tester-mark-'));
  if (units) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units }));
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...extraEnv },
  });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  return (r.stdout || '').split('\n');
}
const rowOf = (lines, key) => lines.find((l) => new RegExp(`^\\s+${key}\\s`).test(l));

test('show gemini: a retired id from the AGY_DEFAULT_MODEL env override carries the mark', () => {
  const row = rowOf(run(['show', 'gemini'], null, { AGY_DEFAULT_MODEL: 'Gemini 3.8 Flash (High)' }), 'model');
  assert.ok(row.includes('env:AGY_DEFAULT_MODEL'), row);
  assert.ok(row.endsWith(MARK), row);
});

test('doctor prints the same mark on the model row (no vendor binary on PATH)', () => {
  const lines = run(['doctor'], { gemini: { model: 'Gemini 3.8 Flash (High)' }, grok: { model: 'grok-4.7' } });
  const rows = lines.filter((l) => /^\s+model\s/.test(l));
  assert.equal(rows.filter((l) => l.endsWith(MARK)).length, 1, rows.join('\n'));
  assert.ok(rows.find((l) => l.includes('Gemini 3.8 Flash (High)')).endsWith(MARK));
});

test('gemini_models names all three tools that take `model`, and nothing it does not have', async () => {
  const { default: unit } = await import('../units/gemini/adapter.mjs');
  const description = unit.tools.find((t) => t.name === 'gemini_models').description;
  assert.ok(description.includes('gemini_research / gemini_image / gemini_deep_research'), description);
  for (const t of unit.tools.filter((x) => x.name !== 'gemini_models')) {
    assert.ok(t.inputSchema.properties.model, `${t.name} takes no model`);
  }
});
