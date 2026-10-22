// 1.6.1 Task 2, clean-context tester (plan docs/superpowers/plans/2026-09-30-1.6.1-catalogs-effort-docs.md,
// "Task 2", ruling B: the shipped example config). One behaviour no other test holds: a second `install`
// never overwrites the fleet.config.json the first one copied from the example and the operator then edited.
// Every home is a temp directory; nothing on PATH, so no vendor CLI is reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** A throwaway directory that can be a fleet home, a project and a HOME at once. */
const tmp = (label) => mkdtempSync(join(tmpdir(), `omelette-t2x-${label}-`));

/** The CLI in a throwaway home; PATH holds nothing, so no vendor CLI or `claude` can be reached. */
function cli(dir, args, cwd = dir) {
  const empty = join(dir, '.empty-path');
  mkdirSync(empty, { recursive: true });
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8',
    env: { PATH: empty, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const writeConfig = (dir, cfg) => writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(cfg));
const readConfig = (dir) => JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8'));

test('install twice from the example: the second run never overwrites the operator\'s edits', () => {
  const dir = tmp('install-twice');
  const first = cli(dir, ['install', '--units', 'codex']);
  assert.equal(first.code, 0, first.out + first.err);
  const cfg = readConfig(dir);
  cfg.units.codex.timeoutS = 123;
  writeConfig(dir, cfg);
  const second = cli(dir, ['install', '--units', 'codex']);
  assert.equal(second.code, 0, second.out + second.err);
  assert.equal(readConfig(dir).units.codex.timeoutS, 123, 'an existing file is never overwritten');
});
