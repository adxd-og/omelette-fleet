import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractImagePath } from '../core/artifact.mjs';

test('extractImagePath: last existing file wins, source path is excluded, prose yields nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-artifact-'));
  const src = join(dir, 'src.jpg'); const out = join(dir, 'out.jpg');
  writeFileSync(src, 'x'); writeFileSync(out, 'y');
  assert.equal(extractImagePath(`saved to ${src}, then ${out}.`), out);
  assert.equal(extractImagePath(`only ${src} here`, src), '');
  assert.equal(extractImagePath(`Saved ${out} and ${src}`, src), out);
  assert.equal(extractImagePath('no paths at all'), '');
});

test('extractImagePath: a path the model asserts but never wrote is not an artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-artifact-'));
  const real = join(dir, 'real.png');
  writeFileSync(real, 'z');
  // Confident prose naming a file that does not exist → nothing.
  assert.equal(extractImagePath(`I saved it to ${join(dir, 'imagined.png')}`), '');
  // A directory is not an artifact either, however absolute it looks.
  assert.equal(extractImagePath(`output dir: ${dir}`), '');
  // Markdown and trailing punctuation around a real path are stripped.
  assert.equal(extractImagePath(`Done: [image](${real}).`), real);
});
