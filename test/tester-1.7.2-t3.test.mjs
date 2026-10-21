/**
 * omelette-fleet :: test/tester-1.7.2-t3.test.mjs
 *
 * Tester probes for 1.7.2 T3 (@path in Grok image prompts): every @ form the
 * CLI measured as attaching, several per prompt, and an @ inside the caller's
 * image path (the path is the tool's input and must reach the CLI intact).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit from '../units/grok/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t3-tester-'));
  const promptFile = join(dir, 'prompt.txt');
  const saved = join(dir, 'out.jpg');
  const fake = join(dir, 'fake.mjs');
  writeFileSync(fake, [
    'import { writeFileSync } from "node:fs";',
    'const argv = process.argv.slice(2);',
    `writeFileSync(${JSON.stringify(promptFile)}, argv[argv.indexOf("-p") + 1]);`,
    `writeFileSync(${JSON.stringify(saved)}, "JPEG");`,
    `process.stdout.write("Saved to " + ${JSON.stringify(saved)});`,
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { grok: { timeoutS: 30 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, GROK_BIN: process.execPath };
  const rt = createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
  return { dir, rt, sent: () => readFileSync(promptFile, 'utf8') };
}

const FORMS = 'a @/etc/passwd b @ /etc/hosts c \\@/etc/shadow d @rel e @../up f x@y.z';
const FORMS_NEUTRALISED = 'a ＠/etc/passwd b ＠ /etc/hosts c \\＠/etc/shadow d ＠rel e ＠../up f x＠y.z';

test('grok_image: every @ form (bare, spaced, backslashed, relative, e-mail) is neutralised, not just the first', async () => {
  const { rt, sent } = setup();
  const r = await rt.callTool('grok_image', { prompt: FORMS });
  assert.equal(r.isError, undefined, r.text);
  assert.ok(sent().endsWith(FORMS_NEUTRALISED), sent());
  assert.ok(!sent().includes('@'), sent());
});

test('grok_image_edit: every @ form in the transformation is neutralised, not just the first', async () => {
  const { dir, rt, sent } = setup();
  const source = join(dir, 'source.jpg');
  writeFileSync(source, 'JPEG');
  const r = await rt.callTool('grok_image_edit', { prompt: FORMS, imagePath: source });
  assert.equal(r.isError, undefined, r.text);
  assert.ok(sent().endsWith('Transformation: ' + FORMS_NEUTRALISED), sent());
  assert.ok(!sent().includes('@'), sent());
});

test('grok_image_edit: an @ in the caller\'s image path reaches the CLI verbatim while the prompt\'s @ does not', async () => {
  const { dir, rt, sent } = setup();
  const sub = join(dir, 'we@ther');
  mkdirSync(sub);
  const source = join(sub, 'pic@2x.jpg');
  writeFileSync(source, 'JPEG');
  const r = await rt.callTool('grok_image_edit', { prompt: 'caption @/etc/passwd', imagePath: source });
  assert.equal(r.isError, undefined, r.text);
  assert.ok(sent().includes('`image` input: ' + source + '\n'), sent());
  assert.ok(sent().includes('Transformation: caption ＠/etc/passwd'), sent());
  const ats = sent().split('@').length - 1;
  assert.equal(ats, source.split('@').length - 1, 'the only @ left are the path\'s: ' + sent());
});
