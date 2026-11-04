/**
 * omelette-fleet :: test/fix-round-b-1.6.0.test.mjs
 * 1.6.0 review fix round B: the grok catalog says what the code does.
 * One test per pinned finding (B2, B8-B10, B20-B22), the catalog half; the docs half was removed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROK_MODELS, GUIDE } from '../units/grok/models.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('B2 grok-4.5: a config naming it is ignored with a warning, an explicit call argument is refused', () => {
  const models = read('units/grok/models.js').replace(/\n \* /g, ' ');
  assert.ok(models.includes('a fleet config naming it is ignored with a warning, an explicit call argument is refused'));
  assert.ok(!models.includes('refused at call time'));
});

test('B8 grok-4.7-build-fast carries its published price', () => {
  const bf = GROK_MODELS.find((m) => m.id === 'grok-4.7-build-fast');
  assert.ok(bf.useFor.includes('Cursor and Grok Build only (not on the public xAI API); priced at $4 in / $1 cached / $12 out per Mtok under 200K prompt tokens, $6 / $1.50 / $18 above (docs.x.ai/developers/pricing, "Grok 4.7 Fast pricing", read 2026-09-26).'));
  assert.ok(!bf.useFor.includes('no per-token price is published'));
  assert.ok(GUIDE.includes('grok-4.7-build-fast is the same model at twice the speed and twice the price'));
});

test('B9 effort defaults: High for the 4.7 pair, Medium kept for 4.6; the GUIDE does not claim medium is the default', () => {
  const eff = Object.fromEntries(GROK_MODELS.map((m) => [m.id, m.effort]));
  assert.deepEqual(eff, { 'grok-4.7': 'High', 'grok-4.7-build-fast': 'High', 'grok-4.6': 'Medium' });
  assert.ok(GUIDE.includes("the CLI's own default when omitted (xAI documents high for 4.7 on the API; the CLI's default effort is not probed here)"));
  assert.ok(!GUIDE.includes('medium=default'));
});

test('B10 grok provenance phrases and real file names in the header', () => {
  const g46 = GROK_MODELS.find((m) => m.id === 'grok-4.6');
  assert.ok(g46.useFor.includes('AIME 93-100%, GPQA Diamond 84.6-88%; Artificial Analysis, read 2026-09-05'));
  assert.ok(GUIDE.includes('#2 on image arenas behind GPT-Image-2, arena ranking read 2026-08-13'));
  const src = read('units/grok/models.js');
  assert.ok(src.includes('omelette-fleet :: units/grok/models.js'));
  assert.ok(src.includes("Imported module-relative ('./models.js'"));
  assert.ok(src.includes('Consumed by units/grok/adapter.mjs'));
  for (const stale of ['grok-mcp.mjs', 'grok-models.js', 'grok-build ::']) assert.ok(!src.includes(stale), stale);
});

test('B20 GUIDE: DeepSWE 4.7 sits between Fable 5.1 Max and GPT-5.6 Sol Max on xAI\'s table', () => {
  assert.ok(GUIDE.includes("deep repository engineering: on xAI's own table DeepSWE v1.1 is 71.0% at high effort — ahead of Fable 5.1 Max's 70.0%, behind GPT-5.6 Sol Max's 72.7% (unreplicated; x.ai/news/grok-4-7)"));
  assert.ok(!GUIDE.includes('still trails the frontier'));
  assert.ok(!GUIDE.includes('Fable 5 70% is'));
});

test('B21 the 4.7 entry labels the effort of each column and the AA index entry', () => {
  const m47 = GROK_MODELS.find((m) => m.id === 'grok-4.7');
  assert.ok(m47.useFor.includes("xAI's own table against 4.6 (Grok 4.7 at xhigh against Grok 4.6 at high; DeepSWE's 71.0% is the one high-effort figure)"));
  assert.ok(m47.useFor.includes('AA Intelligence Index 46 (xhigh) on v4.3.2'));
  assert.ok(GUIDE.includes('AA Intelligence Index 46 (xhigh) on v4.3.2'));
  assert.ok(!m47.useFor.includes('(high effort)'));
});

test('B22 the 4.7 AA-Omniscience figures replace every "no figure verified" sentence', () => {
  const m47 = GROK_MODELS.find((m) => m.id === 'grok-4.7');
  assert.ok(m47.avoid.includes('AA-Omniscience lists 4.7 at 47.5% accuracy / 29.3% hallucination at xhigh (47.8% / 32.4% at high; index 32.0 / 30.9; artificialanalysis.ai/models/grok-4-7, read 2026-09-26)'));
  assert.ok(GUIDE.includes('ROUTE AWAY: AA-Omniscience (2026-09-26) measures 4.7 at 29-32% hallucination / ~47% accuracy, about one answer in three wrong when it answers'));
  for (const text of [m47.avoid, GUIDE, read('units/grok/models.js')]) {
    assert.doesNotMatch(text, /no AA-Omniscience figure for 4\.7/);
  }
});
