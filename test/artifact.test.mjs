import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactMiss, extractImagePath, newestImage } from '../core/artifact.mjs';

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

test('extractImagePath: only an IMAGE file counts, and only one the run itself wrote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-artifact-'));
  // Prose naming a real file that is not an image: a run that read /etc/hosts
  // and said so has produced no artifact, however absolute the path is.
  assert.equal(extractImagePath('I looked at /etc/hosts first'), '');
  const notes = join(dir, 'notes.txt');
  writeFileSync(notes, 'x');
  assert.equal(extractImagePath(`saved the log to ${notes}`), '');

  // An image that predates the run is somebody else's file: the source image
  // of an edit, a leftover in a directory the CLI happened to name.
  const old = join(dir, 'old.png');
  writeFileSync(old, 'PNG');
  utimesSync(old, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const since = Date.now();
  assert.equal(extractImagePath(`Saved it to ${old}`, '', since), '');
  // …and without a `since` it is an artifact like it always was.
  assert.equal(extractImagePath(`Saved it to ${old}`), old);

  // The file this run wrote: right extension, written after it started.
  const fresh = join(dir, 'fresh.PNG');
  writeFileSync(fresh, 'PNG');
  assert.equal(extractImagePath(`Saved it to ${fresh}`, '', since), fresh);
  // Every extension the fleet's image tools produce, case-insensitively.
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'JPG']) {
    const p = join(dir, `art.${ext}`);
    writeFileSync(p, 'IMG');
    assert.equal(extractImagePath(`Saved it to ${p}`, '', since), p);
  }
});

test('newestImage: the scan is RECURSIVE — a file saved in a subdirectory of the run dir is the artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-newest-nested-'));
  // agy names the file itself and may put it under a directory of its own
  // choosing: `generated/image.png` in the run's cwd is the shape seen live.
  mkdirSync(join(dir, 'generated'));
  const nested = join(dir, 'generated', 'image.png');
  writeFileSync(nested, 'PNG');
  assert.equal(newestImage(dir), nested);

  // Newest by mtime ACROSS the tree, not per directory: a top-level file the
  // run wrote first does not outrank the nested one it wrote after.
  const shallow = join(dir, 'first.png');
  writeFileSync(shallow, 'PNG');
  utimesSync(shallow, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  assert.equal(newestImage(dir), nested);

  // …and `since` still keeps a file that predates the run out of it, wherever
  // in the tree it sits.
  utimesSync(nested, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  assert.equal(newestImage(dir, Date.now()), '');
});

test('newestImage: the walk stops at 3 directory levels below the run dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-newest-depth-'));
  // Deeper than the cap: a CLI that buried a file four levels down is not what
  // this scan is for, and an unbounded walk of somebody's cwd is not either.
  mkdirSync(join(dir, 'a', 'b', 'c', 'd'), { recursive: true });
  const tooDeep = join(dir, 'a', 'b', 'c', 'd', 'deep.png');
  writeFileSync(tooDeep, 'PNG');
  assert.equal(newestImage(dir), '');
  // At the cap it is found.
  const atLimit = join(dir, 'a', 'b', 'c', 'edge.png');
  writeFileSync(atLimit, 'PNG');
  assert.equal(newestImage(dir), atLimit);
});

test('newestImage: a symlinked directory is not followed, and a symlinked file is not an artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-newest-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'omelette-newest-outside-'));
  const elsewhere = join(outside, 'outside.png');
  writeFileSync(elsewhere, 'PNG');
  // A link OUT of the run directory: whatever it points at was not written by
  // this run, and the walk must not leave the tree it was given.
  symlinkSync(outside, join(dir, 'linked'), 'dir');
  assert.equal(newestImage(dir), '');
  symlinkSync(elsewhere, join(dir, 'link.png'));
  assert.equal(newestImage(dir), '');
  // A real file beside them is still the artifact.
  const real = join(dir, 'real.png');
  writeFileSync(real, 'PNG');
  assert.equal(newestImage(dir), real);
});

test('artifactMiss: the run explains the missing file, or says nothing at all', () => {
  const bounds = { outputCap: 4000, timeoutS: 300 };
  // A run that ended normally and saved nothing has no excuse to offer: the
  // caller's own "no image on disk" wording is the whole message.
  assert.equal(artifactMiss('grok', { killed: false, capped: false }, bounds), '');
  assert.equal(artifactMiss('grok', {}, bounds), '');
  assert.equal(artifactMiss('grok', undefined, undefined), '');
  // The kill is answered first, as everywhere else in the fleet…
  assert.equal(
    artifactMiss('grok', { killed: true }, bounds),
    'the run was hard-killed after 300s — raise grok.timeoutS in the fleet config',
  );
  // …and a cancel is a kill the client asked for, so neither bound is named.
  assert.equal(
    artifactMiss('codex', { killed: true, cancelled: true }, bounds),
    'the run was cancelled by the client before it saved one',
  );
  // The cap names the key that fixes it, per unit.
  assert.equal(
    artifactMiss('gemini', { capped: true }, bounds),
    "the run's output exceeded the 4000 char cap — raise gemini.outputCap or narrow the task",
  );
  // Killed AND capped: the kill wins, one clause, never two.
  assert.equal(
    artifactMiss('grok', { killed: true, capped: true }, bounds),
    'the run was hard-killed after 300s — raise grok.timeoutS in the fleet config',
  );
});
