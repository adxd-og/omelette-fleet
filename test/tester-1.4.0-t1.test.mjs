/**
 * omelette-fleet :: test/tester-1.4.0-t1.test.mjs
 * Independent tester coverage for 1.4.0 P1 (Grok: two profiles, never both),
 * against docs/superpowers/specs/2026-09-25-1.4.0-perimeter-design.md and
 * Task 1 of docs/superpowers/plans/2026-09-25-1.4.0-perimeter.md, with the
 * orchestrator's amendment: the CLI has no empty allowlist, so NO_TOOLS is
 * null and grok_research under `webSearch: false` refuses BEFORE any spawn.
 *
 * Fixtures modelled on test/grok.test.mjs (a fake `grok` built from
 * process.execPath, spawn wrapped to prepend the fake script, OMELETTE_HOME
 * in a fresh tmpdir).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

/** A fake `grok -p` that touches `marker` (proof it ran) and echoes its argv back, in whichever output shape the argv asked for. */
function writeArgvEcho(fake, marker) {
  writeFileSync(fake, [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(marker)}, "x");`,
    'const argv = process.argv.slice(2);',
    'const text = "ARGS " + argv.join(" ");',
    'if (argv.includes("streaming-messages-json")) {',
    '  process.stdout.write([',
    '    JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),',
    '    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, stop_reason: "end_turn" }),',
    '  ].join("\\n") + "\\n");',
    '} else process.stdout.write(text);',
  ].join('\n'));
}

test('grok_research under webSearch:false refuses BEFORE any spawn — the fake binary is never invoked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t1-noweb-'));
  const fake = join(dir, 'fake-grok.mjs');
  const marker = join(dir, 'ran.marker');
  writeArgvEcho(fake, marker);
  const rt = wrapGrok(dir, fake, { webSearch: false, timeoutS: 30 });
  const r = await rt.callTool('grok_research', { prompt: 'what is the population of France' });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'Error: grok_research is web-only; set grok.webSearch=true, or use grok_code_review for local files.');
  // The decisive check: the CLI never ran. If it had, the fake would have
  // touched the marker and the answer would start with "ARGS ", not "Error:".
  assert.equal(existsSync(marker), false, 'the fake grok binary was spawned when it should not have been');
  // The refusal is still spooled like any other, and grok_result (unaffected
  // by this diff) still serves it back.
  const snap = JSON.parse(readFileSync(join(dir, `status-grok-${process.pid}.json`), 'utf8'));
  assert.equal(snap.lastEvent.status, 'error');
  assert.ok(!snap.lastEvent.usage, 'a refusal that never spawned must report no usage'); // nothing spawned, nothing to report
  const spooled = await rt.callTool('grok_result', {});
  assert.match(spooled.text, /grok_research is web-only/);
});

test('grok_code_review never gets web tools or --allow, under webSearch:true (default) and webSearch:false alike', async () => {
  for (const cfgOverride of [{}, { webSearch: false }, { webSearch: true }]) {
    const dir = mkdtempSync(join(tmpdir(), 'omelette-t1-review-'));
    const fake = join(dir, 'fake-grok.mjs');
    const marker = join(dir, 'ran.marker');
    writeArgvEcho(fake, marker);
    const rt = wrapGrok(dir, fake, cfgOverride);
    const rv = await rt.callTool('grok_code_review', { prompt: 'q' });
    assert.equal(rv.isError, undefined, JSON.stringify(cfgOverride));
    assert.match(rv.text, /--tools read_file,grep,list_dir\b/, JSON.stringify(cfgOverride));
    assert.doesNotMatch(rv.text, /--allow|web_search|web_fetch/, JSON.stringify(cfgOverride));
    assert.equal(existsSync(marker), true, 'review must still spawn'); // the gate is on research only
  }
});

test('grok_research under webSearch:true (default) spawns end-to-end with the web toolset and the two allow rules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t1-research-'));
  const fake = join(dir, 'fake-grok.mjs');
  const marker = join(dir, 'ran.marker');
  writeArgvEcho(fake, marker);
  const rt = wrapGrok(dir, fake, {}); // webSearch defaults to true
  const r = await rt.callTool('grok_research', { prompt: 'q' });
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /--tools web_search,web_fetch\b/);
  assert.match(r.text, /--allow WebFetch --allow WebSearch/);
  assert.doesNotMatch(r.text, /read_file|grep|list_dir/);
  assert.equal(existsSync(marker), true);
});

test('the MUTATE_RE intent gate refuses grok_research on git/deploy intent before any spawn, but never touches grok_code_review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t1-mutate-'));
  const fake = join(dir, 'fake-grok.mjs');
  const marker = join(dir, 'ran.marker');
  writeArgvEcho(fake, marker);
  const rt = wrapGrok(dir, fake, {});
  const prompt = 'please run git push to publish this branch';
  const research = await rt.callTool('grok_research', { prompt });
  assert.equal(research.isError, true);
  assert.match(research.text, /cannot run git \/ deploy \/ publish work \("git push"\)/);
  assert.equal(existsSync(marker), false, 'research must not spawn once the gate refuses it');
  // The identical prompt is a legitimate read-only ask on review — no gate there.
  const review = await rt.callTool('grok_code_review', { prompt });
  assert.equal(review.isError, undefined, review.text);
  assert.match(review.text, /--tools read_file,grep,list_dir\b/);
  assert.equal(existsSync(marker), true, 'review must still spawn on the same prompt');
});

test('a bad cwd is refused before the web-only check even under webSearch:false — the cwd contract holds regardless', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t1-cwd-order-'));
  const fake = join(dir, 'fake-grok.mjs');
  const marker = join(dir, 'ran.marker');
  writeArgvEcho(fake, marker);
  const rt = wrapGrok(dir, fake, { webSearch: false });
  const rel = await rt.callTool('grok_research', { prompt: 'q', cwd: 'relative/path' });
  assert.equal(rel.isError, true);
  assert.match(rel.text, /"cwd" must be an absolute path/);
  assert.doesNotMatch(rel.text, /web-only/); // the cwd mistake is reported, not masked by the web-only refusal
  assert.equal(existsSync(marker), false);
});

test('schema: grok_research and grok_code_review keep prompt/cwd/effort/model, required prompt only — description text is the only change', () => {
  const research = unit.tools.find((t) => t.name === 'grok_research');
  const review = unit.tools.find((t) => t.name === 'grok_code_review');
  for (const t of [research, review]) {
    assert.deepEqual(t.inputSchema.required, ['prompt']);
    assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ['cwd', 'effort', 'model', 'prompt']);
    assert.equal(t.inputSchema.properties.cwd.type, 'string');
  }
  // The public MCP shape (tools/list) hides run/kind/mutateGate but keeps the schema.
  const rt = createUnitRuntime(unit, { env: { ...process.env, OMELETTE_HOME: mkdtempSync(join(tmpdir(), 'omelette-t1-schema-')) } });
  const pub = rt.tools.find((t) => t.name === 'grok_research');
  assert.equal(pub.run, undefined);
  assert.equal(pub.mutateGate, undefined);
  assert.deepEqual(pub.inputSchema.required, ['prompt']);
});

test('grok_models and the effort catalog are unaffected: no spawn, xhigh is a valid effort, the guide text survives the P4 wording pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t1-catalog-'));
  const rt = createUnitRuntime(unit, { env: { ...process.env, OMELETTE_HOME: dir, GROK_BIN: '/nonexistent-should-never-run' } });
  const r = await rt.callTool('grok_models', {});
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /GROK MODEL CATALOG/);
  assert.match(r.text, /xhigh/);
  // The result-spool tool for grok is still there and named the usual way.
  assert.ok(rt.tools.some((t) => t.name === 'grok_result'));
});
