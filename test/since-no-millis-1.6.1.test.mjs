/**
 * omelette-fleet :: test/since-no-millis-1.6.1.test.mjs
 * 1.6.1 T4: `results --stats --since` accepts a whole ISO timestamp without
 * milliseconds (`2026-09-25T18:47:00Z`), which 1.6.0 refused — found at the
 * 1.6.0 live gate, where the units-per-release row is taken from a commit time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const run = (since) => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-since-'));
  return spawnSync(process.execPath, [BIN, 'results', '--stats', '--since', since], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir },
  });
};

test('--since reads a whole UTC timestamp with and without milliseconds as the same instant', () => {
  const a = run('2026-09-25T18:47:00Z');
  const b = run('2026-09-25T18:47:00.000Z');
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.match(a.stdout, /^since 2026-09-25T18:47:00\.000Z$/m);
  assert.equal(a.stdout, b.stdout);
});

// Release fix round C (C2): the offset form `git log --format=%cI` prints is read too.
test('--since reads a whole timestamp with an offset, with or without milliseconds, as the instant it names', () => {
  for (const [given, utc] of [
    ['2026-09-25T18:47:00+03:00', '2026-09-25T15:47:00.000Z'],
    ['2026-09-25T18:47:00.250+03:00', '2026-09-25T15:47:00.250Z'],
    ['2026-09-25T18:47:00-05:00', '2026-09-25T23:47:00.000Z'],
    ['2026-09-25T23:30:00-05:00', '2026-09-26T04:30:00.000Z'],
    ['2026-09-25T18:47:00+00:00', '2026-09-25T18:47:00.000Z'],
  ]) {
    const r = run(given);
    assert.equal(r.status, 0, `${given}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`^since ${utc.replaceAll('.', '\\.')}$`, 'm'), `${given} → ${utc}`);
  }
});

test('--since still refuses a day that does not exist, a truncated time and any other form', () => {
  for (const bad of ['2026-02-30T00:00:00Z', '2026-02-30', '2026-02-30T10:00:00+03:00', '2026-09-31T00:00:00-05:00', '2026-09-25T24:00:00+03:00',
    '2026-09-25T18:47Z', '2026-09-25T18:47:00.5Z', '2026-09-25T18:47:00', '2026-09-25T18:47+03:00', '2026-09-25T18:47:00.5+03:00',
    '2026-09-25T18:47:00+0300', '2026-09-25T18:47:00+03', '2026-09-25 18:47:00+03:00']) {
    const r = run(bad);
    assert.equal(r.status, 1, `${bad} should be refused`);
    assert.match(r.stderr, /is neither a window/);
  }
});
