// scripts/mutants.mjs — the clean-up gate's mutant runner (spec
// docs/superpowers/specs/2026-10-21-cleanup-gate-design.md, "T0 — the mutant catalogue").
// It runs here against a two-mutant fixture catalogue and a tiny fixture repository
// (test/fixtures/mutants/), never against this checkout; the real catalogue is only read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogue, main, validateCatalogue } from '../scripts/mutants.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(ROOT, 'test', 'fixtures', 'mutants');
const REPO = join(FIXTURE, 'repo');
const ENTRIES = ['lib', 'test'];

const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) };
};

test('one mutant caught, one not: the report names the catching file, the uncaught id and the unique catch', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-mutants-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outFile = join(dir, 'report.json');
  const scratch = join(dir, 'scratch');
  const before = readFileSync(join(REPO, 'lib', 'add.mjs'), 'utf8');
  const io = capture();

  const code = await main(['--out', outFile, '--scratch', scratch], {
    root: REPO, cataloguePath: join(FIXTURE, 'catalogue.json'), entries: ENTRIES, out: io.out, err: io.err,
  });
  assert.equal(code, 0, io.lines.err.join('\n'));

  const report = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.equal(report.baseline.files, 1);
  assert.ok(report.baseline.tests >= 1 && report.baseline.wallMs > 0);
  assert.ok(report.timeoutMs >= 120000, 'the cap has a 120 s floor');
  assert.deepEqual(report.mutants.map(({ id, file, caughtBy, caughtByTimeout, timedOut }) => ({ id, file, caughtBy, caughtByTimeout, timedOut })), [
    { id: 'add-minus', file: 'lib/add.mjs', caughtBy: ['test/add.test.mjs'], caughtByTimeout: [], timedOut: false },
    { id: 'label-upper', file: 'lib/add.mjs', caughtBy: [], caughtByTimeout: [], timedOut: false },
  ]);
  assert.deepEqual(report.uncaught, ['label-upper']);
  assert.deepEqual(report.uniqueCatches, { 'test/add.test.mjs': ['add-minus'] });

  assert.equal(readFileSync(join(REPO, 'lib', 'add.mjs'), 'utf8'), before, 'the tree under test is never mutated');
  assert.equal(readFileSync(join(scratch, 'work', 'lib', 'add.mjs'), 'utf8'), before, 'the scratch copy is restored after the last mutant');
  assert.match(io.lines.out.join('\n'), /2 run · 1 caught · 1 uncaught/);
  assert.match(io.lines.err.join('\n'), /excluded: the runner's own tests \(test\/mutants-x\.test\.mjs\)/);
});

test('--dry-run refuses a fragment that occurs twice, and passes a catalogue whose fragments occur once', async () => {
  const twice = capture();
  assert.equal(await main(['--dry-run'], { root: REPO, cataloguePath: join(FIXTURE, 'twice.json'), out: twice.out, err: twice.err }), 1);
  assert.match(twice.lines.err.join('\n'), /return-twice: the fragment occurs 2 times in lib\/add\.mjs/);

  const once = capture();
  assert.equal(await main(['--dry-run'], { root: REPO, cataloguePath: join(FIXTURE, 'catalogue.json'), out: once.out, err: once.err }), 0);
  assert.match(once.lines.out.join('\n'), /2 mutant\(s\) valid/);
});

// The coupling is wanted: an edit that moves or rewrites a catalogued fragment fails here,
// so the catalogue is updated in the same commit as the code it mutates.
test('the real catalogue is valid against this checkout: every fragment occurs exactly once in its file', () => {
  assert.deepEqual(validateCatalogue(ROOT, loadCatalogue()), []);
});
