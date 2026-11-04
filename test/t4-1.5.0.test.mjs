/**
 * omelette-fleet :: test/t4-1.5.0.test.mjs
 * 1.5.0 T4: the Codex adapter header carries the measured sentence and the
 * Gemini catalog no longer claims a sync source (the docs half was removed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('the Codex adapter header carries the measured sentence; the Gemini catalog claims no sync source', () => {
  assert.match(read('units/codex/adapter.mjs'), /Measured 2026-09-25 on codex-cli 0\.156\.1/);
  const gemini = read('units/gemini/models.js');
  assert.match(gemini, /^\/\*\*\n \* omelette-fleet :: units\/gemini\/models\.js — the Gemini catalog/);
  assert.doesNotMatch(gemini, /sync:catalog|SINGLE SOURCE OF TRUTH|gemini-models\.js/);
});
