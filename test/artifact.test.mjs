import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactMiss, extractImagePath } from '../core/artifact.mjs';

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
