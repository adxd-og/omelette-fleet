import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('the Gemini local-file route points at the opt-in agy rule set', async () => {
  const opt = /needs the opt-in agy rule set \(SECURITY, Recommended agy allow-rules\)/;
  assert.match(read('rules/omelette-fleet.md').split('\n').find((l) => l.startsWith('| Reading local images')), opt);
  assert.match(read('units/gemini/adapter.mjs'), /needs `read_file\(\*\)` in the operator's agy allow-rules — the opt-in set in SECURITY/);
  const pointer = /needs `read_file\(\*\)` in the agy allow-rules, the opt-in set in (SECURITY|\[SECURITY\]\(docs\/SECURITY\.md#recommended-agy-allow-rules\))/;
  const gemini = (await import('../units/gemini/adapter.mjs')).default;
  assert.match(gemini.instructions, pointer);
  const grok = (await import('../units/grok/adapter.mjs')).default;
  assert.match(grok.tools.find((t) => t.name === 'grok_research').description, /gemini_research for images and PDFs \(with the opt-in agy rule set\)/);
});
