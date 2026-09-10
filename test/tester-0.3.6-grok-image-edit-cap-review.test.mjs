/**
 * omelette-fleet :: test/tester-0.3.6-grok-image-edit-cap-review.test.mjs
 *
 * 0.3.6 review (spec: docs/superpowers/specs/2026-09-10-0.3.6-design.md, S5):
 * "Tests per unit with the fake binaries: capped + file → bare path,
 * `partial: true` in the status feed; capped + no file → error naming
 * `<unit>.outputCap`; killed + file → bare path" — for gemini_image,
 * grok_image, grok_image_edit and codex_image, EACH.
 *
 * The diff's own tests (test/grok.test.mjs) give `grok_image` all three
 * scenarios and give `grok_image_edit` only "killed + file". The two capped
 * scenarios are untested for `grok_image_edit` specifically — and it is not
 * simply a duplicate of `grok_image`'s coverage of the same lines: the edit
 * tool calls `extractImagePath(text, imagePath, since)` with the SOURCE path
 * as the excluded token (grok_image passes `''`), so a regression that let a
 * capped run's front-truncated text resolve to the untouched SOURCE file
 * would still pass every `grok_image` test while breaking `grok_image_edit`
 * silently — the reader would be handed back the file they asked to edit
 * as if it were the tool's own answer.
 *
 * No real vendor binary; no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit from '../units/grok/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

/** A runtime whose "grok" is `node <fake>`, with `dir` as its own fleet home. */
function wrapGrok(dir, fake, units = {}) {
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { grok: units } }));
  const env = { ...process.env, OMELETTE_HOME: dir, GROK_BIN: process.execPath };
  return createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
}

test('grok_image_edit: a capped run whose NEW file is on disk answers with the BARE path, and the feed says partial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grok-imgedit-cap-'));
  const source = join(dir, 'source.jpg');
  const saved = join(dir, 'edited.jpg');
  writeFileSync(source, 'JPEG');
  const fake = join(dir, 'fake-grok-imgedit-cap.mjs');
  // Plain stdout, like every grok image run: padding far past the cap, then
  // the NEW file's path at the end — where a tail cap keeps it.
  writeFileSync(fake, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(saved)}, "JPEG");`,
    `process.stdout.write("n".repeat(2000) + "\\nSaved to " + ${JSON.stringify(saved)});`,
  ].join('\n'));
  const rt = wrapGrok(dir, fake, { outputCap: 300, timeoutS: 30 });
  const r = await rt.callTool('grok_image_edit', { prompt: 'make it blue', imagePath: source });
  assert.equal(r.isError, undefined, r.text);
  // THE CONTRACT: the new file's path, alone — never the source path, never a
  // cap marker stapled onto it.
  assert.equal(r.text, saved);
  assert.notEqual(r.text, source);
  const snap = JSON.parse(readFileSync(join(dir, 'status-grok.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'ok');   // there IS an artifact
  assert.equal(snap.lastEvent.partial, true);  // …from a run that did not finish
  const spool = join(dir, 'results', 'grok');
  const body = readFileSync(join(spool, readdirSync(spool).find((f) => f.endsWith('.md'))), 'utf8');
  assert.match(body, /\npartial: true\n/);
  assert.ok(body.trim().endsWith(saved), body);
});

test('grok_image_edit: a capped run with NO new file on disk is an error naming grok.outputCap, not the untouched source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grok-imgedit-cap-nofile-'));
  const source = join(dir, 'source.jpg');
  writeFileSync(source, 'JPEG');
  const fake = join(dir, 'fake-grok-imgedit-cap-nofile.mjs');
  // Confident prose about a file that was never written: not an artifact, and
  // the source is never mistaken for the answer either.
  writeFileSync(fake, `process.stdout.write("n".repeat(2000) + "\\nSaved to " + ${JSON.stringify(join(dir, 'imagined-edit.jpg'))});`);
  const rt = wrapGrok(dir, fake, { outputCap: 300, timeoutS: 30 });
  const r = await rt.callTool('grok_image_edit', { prompt: 'make it blue', imagePath: source });
  assert.equal(r.isError, true);
  assert.match(r.text, /image run finished without a saved image path on disk \(the run's output exceeded the 300 char cap — raise grok\.outputCap or narrow the task\)/);
  assert.match(r.text, /Raw output: /);
  const snap = JSON.parse(readFileSync(join(dir, 'status-grok.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'error');
});
