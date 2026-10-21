/**
 * omelette-fleet :: test/grok-image-at-1.7.2.test.mjs
 *
 * 1.7.2 T3: the grok CLI attaches any existing file a prompt names as `@<path>`
 * whatever the toolset, so the two image tools neutralise `@` in the prompt
 * text (to `＠`, U+FF20) as research does. grok_image_edit refuses an image
 * path holding `@` and passes an `@`-free one verbatim: the CLI must see it.
 *
 * The fake grok records the `-p` value it was handed, then saves an image.
 * No real vendor binary; no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit from '../units/grok/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

/** A runtime whose "grok" is `node <fake>`, with `dir` as its own fleet home. */
function wrapGrok(dir, fake) {
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { grok: { timeoutS: 30 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, GROK_BIN: process.execPath };
  return createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
}

/** A fake grok that writes its `-p` prompt to `promptFile` and saves `saved`. */
function recordingFake(dir, promptFile, saved) {
  const fake = join(dir, 'fake-grok-record.mjs');
  writeFileSync(fake, [
    'import { writeFileSync } from "node:fs";',
    'const argv = process.argv.slice(2);',
    `writeFileSync(${JSON.stringify(promptFile)}, argv[argv.indexOf("-p") + 1]);`,
    `writeFileSync(${JSON.stringify(saved)}, "JPEG");`,
    `process.stdout.write("Saved to " + ${JSON.stringify(saved)});`,
  ].join('\n'));
  return fake;
}

test('grok_image: an @path in the prompt reaches the CLI as ＠path, with no @ left', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grok-img-at-'));
  const promptFile = join(dir, 'prompt.txt');
  const saved = join(dir, 'generated.jpg');
  const rt = wrapGrok(dir, recordingFake(dir, promptFile, saved));
  const r = await rt.callTool('grok_image', { prompt: 'draw @/etc/passwd please' });
  assert.equal(r.isError, undefined, r.text);
  const sent = readFileSync(promptFile, 'utf8');
  assert.ok(sent.includes('＠/etc/passwd'), sent);
  assert.ok(!sent.includes('@'), sent);
});

test('grok_image_edit: the transformation is neutralised, the image path stays verbatim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grok-imgedit-at-'));
  const promptFile = join(dir, 'prompt.txt');
  const source = join(dir, 'source.jpg');
  const saved = join(dir, 'edited.jpg');
  writeFileSync(source, 'JPEG');
  assert.ok(!source.includes('@'));
  const rt = wrapGrok(dir, recordingFake(dir, promptFile, saved));
  const r = await rt.callTool('grok_image_edit', { prompt: 'add @/etc/passwd as a caption', imagePath: source });
  assert.equal(r.isError, undefined, r.text);
  const sent = readFileSync(promptFile, 'utf8');
  assert.ok(sent.includes('Transformation: add ＠/etc/passwd as a caption'), sent);
  assert.ok(sent.includes(source), sent);
  assert.ok(!sent.includes('@'), sent);
});

test('grok_image_edit: an existing image at a path holding "@" is refused before the CLI is spawned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grok-imgedit-atpath-'));
  const promptFile = join(dir, 'prompt.txt');
  const saved = join(dir, 'edited.jpg');
  const sub = join(dir, ' @');
  mkdirSync(sub);
  const source = join(sub, 'source.jpg');
  writeFileSync(source, 'JPEG');
  const rt = wrapGrok(dir, recordingFake(dir, promptFile, saved));
  const r = await rt.callTool('grok_image_edit', { prompt: 'make it blue', imagePath: source });
  assert.equal(r.isError, true, r.text);
  assert.equal(r.text, 'Error: "imagePath" must not contain "@" — the grok CLI reads "@<path>" in a prompt as a file to attach; rename or copy the image to a path without it.');
  assert.ok(!existsSync(promptFile), 'the fake grok recorded a prompt: it was spawned');
});
