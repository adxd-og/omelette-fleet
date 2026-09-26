/**
 * omelette-fleet :: test/fix-round-b-1.6.0.test.mjs
 * 1.6.0 review fix round B: docs and the grok catalog say what the code does.
 * One test per pinned finding (B1-B19); each checks the new sentence is there
 * and the old one is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROK_MODELS, GUIDE } from '../units/grok/models.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const has = (p, s) => assert.ok(read(p).includes(s), `${p} should contain: ${s}`);
const lacks = (p, s) => assert.ok(!read(p).includes(s), `${p} should no longer contain: ${s}`);

test('B1 README scopes "read-only by design" to the default mode and links an anchor that exists', () => {
  has('README.md', 'says which is which) under the default read-only mode (`OMELETTE_ALLOW_WRITE` closed; [SECURITY, "The ceiling"](docs/SECURITY.md#the-ceiling)) — so approving each call one at a time buys you nothing');
  has('README.md', 'none of them able to write while `OMELETTE_ALLOW_WRITE` stays closed (the default).');
  assert.match(read('docs/SECURITY.md'), /^## The ceiling$/m);
});

test('B2 grok-4.5: a config naming it is ignored with a warning, an explicit call argument is refused', () => {
  has('CHANGELOG.md', '**grok-4.5 is dropped** (a fleet config naming it is ignored with a warning and the CLI default applies; an explicit `model: "grok-4.5"` in a call is refused — core/unit.mjs:412–416 and :543)');
  lacks('CHANGELOG.md', 'a config naming it is refused at call time');
  const models = read('units/grok/models.js').replace(/\n \* /g, ' ');
  assert.ok(models.includes('a fleet config naming it is ignored with a warning, an explicit call argument is refused'));
  assert.ok(!models.includes('refused at call time'));
});

test('B3 CHANGELOG names what counts as a failed gather, and a salvaged kill as a partial stage', () => {
  has('CHANGELOG.md', 'A gather that threw — a non-zero exit with no text, a kill with nothing salvaged, a quota refusal — is counted as failed');
  has('CHANGELOG.md', 'A killed gather whose text was salvaged is a partial stage and counts in the stages header, as before.');
  lacks('CHANGELOG.md', 'A gather that threw or was hard-killed');
});

test('B4 CONFIG: a hard kill with captured text is a partial ok answer, only an empty one is an error', () => {
  has('docs/CONFIG.md', 'A hard kill whose text was captured returns that text marked partial');
  has('docs/CONFIG.md', 'only a kill with nothing captured is an error naming the unit and the limit');
  lacks('docs/CONFIG.md', 'A hard kill is always reported as an error');
});

test('B5 ADAPTERS names the failures that throw', () => {
  has('docs/ADAPTERS.md', 'only a failure the parser cannot read an answer out of throws — no text, a vendor-reported failed turn (Codex `turn.failed`), a quota refusal.');
  lacks('docs/ADAPTERS.md', 'only a text-less failure throws');
});

test('B6 SECURITY: the group kill fires on a cancel only under cancel: kill', () => {
  has('docs/SECURITY.md', "It fires on the unit's own timeout, on a cancel under `cancel: kill` (under the default `cancel: finish` a cancel detaches the run and the SIGTERM below bounds it), and — since 1.6.0 —");
});

test('B7 SECURITY and CONFIG agree on output caps: marked tail, or an error', () => {
  has('docs/SECURITY.md', 'the adapters return the tail marked partial when it still parses as an answer; a cap that cut into the answer itself is an error, not a fragment passed off as an answer.');
  lacks('docs/SECURITY.md', 'fall open to raw text rather than dropping a real answer');
  has('docs/CONFIG.md', "a capped run whose answer the cap cut open is an error naming that unit's key rather than a fragment returned as prose");
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
  lacks('docs/ORCHESTRATION.md', '`medium` (the default) for ordinary work');
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

test('B11 STATUS-FEED: a disabled unit writes a start/end pair; an in-flight call still writes its end', () => {
  has('docs/STATUS-FEED.md', 'A unit disabled in the config is refused after the feed has started the call, so it too writes a `start`/`end` pair');
  lacks('docs/STATUS-FEED.md', 'A disabled unit and an unknown tool name are refused earlier');
  has('docs/STATUS-FEED.md', 'A call already in flight when the feed is switched off still writes its `end`');
});

test('B12 image usage: codex_image and gemini_image report it, the grok image tools do not', () => {
  const s = "`codex_image` and `gemini_image` report usage when the CLI prints it";
  has('docs/CONFIG.md', s);
  has('docs/STATUS-FEED.md', s);
  lacks('docs/CONFIG.md', 'an image run none');
  lacks('docs/STATUS-FEED.md', 'Image runs still report none');
});

test('B13 CONFIG: grok calls can overlap; the tail queue holds the cap plus one chunk', () => {
  has('docs/CONFIG.md', 'the tail queue holds the cap plus at most one chunk, measured in characters. Requests can overlap — one grok process per call in flight');
  lacks('docs/CONFIG.md', 'runs one process at a time');
});

test('B14 STATUS-FEED: trimmed at server start only; tail -F', () => {
  has('docs/STATUS-FEED.md', 'At each server start only');
  has('docs/STATUS-FEED.md', 'use `tail -F`, which reopens by name');
  lacks('docs/STATUS-FEED.md', 'so a `tail -f` is not disturbed');
});

test('B15 the initialize measurement is 299 records across the logs, dated 2026-08-12 to 2026-09-25', () => {
  const s = '299 initialize records across the mcp logs on the machine, files dated 2026-08-12 to 2026-09-25';
  has('docs/MEASUREMENTS.md', s);
  has('CHANGELOG.md', s);
  lacks('docs/MEASUREMENTS.md', 'since 2026-09-05 under');
  lacks('CHANGELOG.md', '299 of 299');
});

test('B16 CHANGELOG counts the touched test files', () => {
  has('CHANGELOG.md', 'seventeen existing test files touched');
  lacks('CHANGELOG.md', 'twenty-three re-pinned');
});

test('B17 the active-call recipe prints the unit name (real jq over a fabricated snapshot)', (t) => {
  const doc = read('docs/STATUS-FEED.md');
  const line = doc.split('\n').find((l) => l.endsWith('# what is running now'));
  assert.ok(line, 'recipe line present');
  const filter = /^jq -r '(.*)' ~\/\.omelette\/status-\*\.json/.exec(line)[1];
  assert.equal(filter, '.unit as $u | .active[] | "\\($u) \\(.tool) since \\(.startedAt)"');
  assert.ok(doc.includes('in one read per process'));
  const probe = spawnSync('jq', ['--version']);
  if (probe.error || probe.status !== 0) { t.skip('jq not installed'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'fixb-jq-'));
  const f = join(dir, 'status-codex-123.json');
  writeFileSync(f, JSON.stringify({ schema: 2, unit: 'codex', pid: 123, active: [{ id: '123-1', tool: 'codex_research', startedAt: '2026-09-26T10:00:00.000Z' }], lastEvent: null }));
  const r = spawnSync('jq', ['-r', filter, f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'codex codex_research since 2026-09-26T10:00:00.000Z\n');
});

test('B18 ARCHITECTURE: defineUnit defaults version to the package version', () => {
  has('docs/ARCHITECTURE.md', '`version`: the package version (`VERSION` from `core/update.mjs`)');
  lacks('docs/ARCHITECTURE.md', "`version: '0.1.0'`");
});

test('B19 STATUS-FEED partial row: the flag is what the adapter observed', () => {
  const row = read('docs/STATUS-FEED.md').split('\n').find((l) => l.startsWith('| `lastEvent.partial` |'));
  assert.ok(row.endsWith('The flag says what the adapter observed; a model that quotes one of these markers inside its own answer is not flagged. |'));
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
  has('CHANGELOG.md', 'AA-Omniscience lists 4.7 at 47.5% accuracy / 29.3% hallucination at xhigh, 47.8% / 32.4% at high (read 2026-09-26)');
  for (const text of [m47.avoid, GUIDE, read('CHANGELOG.md'), read('units/grok/models.js')]) {
    assert.doesNotMatch(text, /no AA-Omniscience figure for 4\.7/);
  }
});
