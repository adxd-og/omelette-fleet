/**
 * omelette-fleet :: test/tester-0.3.5-p2-review.test.mjs
 *
 * Independent tester coverage for the 0.3.5 diff actually present in the
 * WORKING TREE at invocation (uncommitted): spec §3 (Grok's built-in
 * outputCap 2 000 000 → 10 000 000) and §4 (gemini_deep_research files its
 * stage models through ctx.usedModel). §1, §2 and §5 are either already
 * committed (§1/§5, commit db91cf4) or not yet built (§2) and are out of
 * scope for this file.
 *
 * The implementer's own new tests (test/grok.test.mjs, test/gemini.test.mjs,
 * test/outputcap-tester.test.mjs, test/config.test.mjs) are thorough at the
 * unit level: they pin GROK_OUTPUT_CAP, parameterise every cap-message
 * assertion on it, and exercise deepResearchModel directly plus three
 * end-to-end deep-research spool cases (bare, configured, explicit) and two
 * failure-path cases (cancelled, capped). Three things are not covered
 * anywhere in that diff:
 *
 *   1. §4 says "gemini_research and the image tool keep reporting nothing" —
 *      the new tests check gemini_research's spooled model but never
 *      gemini_image's.
 *   2. §4 says the stage-model report happens "before the first stage
 *      runs" — every cancellation test in the diff aborts on the SECOND
 *      spawn (the first gather, after decompose already completed), which
 *      is consistent with "before the first stage runs" but does not
 *      distinguish it from "before the second stage runs". This file aborts
 *      on the FIRST spawn (decompose itself, before it ever completes) to
 *      pin the stronger claim.
 *   3. §3's whole point is a real 869 s grok_code_review that hit the OLD
 *      2 000 000 cap. Nothing in the diff runs a real stream through the
 *      full runtime (spawn → interpretGrok) at a size that would have
 *      tripped the old cap and checks it survives whole under the new one;
 *      the diff's own cap tests all call interpretGrok directly with
 *      GROK_OUTPUT_CAP substituted algebraically, which would pass just as
 *      well if the constant had stayed 2 000 000 with every assertion
 *      following it down. This file pins the actual number by running a
 *      ~3 MB stream — over the old cap, under the new one — through a fake
 *      grok binary and the real spawn + interpret pipeline, with no
 *      `outputCap` override in config.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import grokUnit, { GROK_OUTPUT_CAP } from '../units/grok/adapter.mjs';
import geminiUnit, { catalog, stageModels } from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import { parseResult } from '../core/results.mjs';

function home(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The one spooled result under a throwaway fleet home, as a parsed header. */
function onlySpooledHeader(dir, unitName) {
  const d = join(dir, 'results', unitName);
  const names = readdirSync(d).filter((n) => n.endsWith('.md'));
  assert.equal(names.length, 1, `expected exactly one spooled result in ${d}`);
  return parseResult(readFileSync(join(d, names[0]), 'utf8')).header;
}

// ─── §4 gap 1: gemini_image still reports nothing ────────────────────────────

test('gemini_image: the spooled result is still filed under (vendor default) — the model report is deep-research only', async () => {
  const dir = home('omelette-gemini-image-model-');
  const fake = join(dir, 'fake-agy.mjs');
  // The run SAVES its artifact: since 0.3.6 gemini_image answers with the path
  // it stat-ed and a run that wrote nothing is an error, so prose alone would
  // never reach the spool this test reads. What is under test here is the
  // spooled header's `model`, not the artifact contract.
  writeFileSync(fake, [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const saved = join(process.cwd(), "img.png");',
    'writeFileSync(saved, "PNG");',
    'process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "an image was made: " + saved }));',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const rt = createUnitRuntime(
    {
      ...geminiUnit,
      tools: geminiUnit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)),
    },
    { env: { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath } },
  );
  const r = await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.ok(!r.isError, r.text);
  assert.equal(onlySpooledHeader(dir, 'gemini').model, '(vendor default)');
});

// ─── §4 gap 2: the report predates the FIRST spawn, not just the second ──────

test('gemini_deep_research: the model report survives a cancel landing on the decompose spawn itself — before any stage ever ran', async () => {
  const dir = home('omelette-gemini-deepcancel-first-');
  const fake = join(dir, 'fake-agy.mjs');
  // Whatever runs would answer at once; the point is that nothing gets the
  // chance to, because the abort lands before the FIRST spawn call.
  writeFileSync(fake, [
    'process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "unreachable" }));',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { cancel: 'kill', timeoutS: 60 } } }));
  const controller = new AbortController();
  const spawns = [];
  const rt = createUnitRuntime(
    {
      ...geminiUnit,
      tools: geminiUnit.tools.map((t) => (t.run ? {
        ...t,
        run: (a, ctx) => t.run(a, {
          ...ctx,
          spawn: (o) => {
            spawns.push(o.args.join(' '));
            // Abort as the FIRST spawn (decompose) is about to happen — before
            // ctx.spawn is even called, let alone before the fake process
            // answers. If the report happened any later than the top of
            // runDeepResearch, this run would have nothing to name.
            if (spawns.length === 1) controller.abort();
            return ctx.spawn({ ...o, args: [fake, ...o.args] });
          },
        }),
      } : t)),
    },
    { env: { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath } },
  );
  const r = await rt.callTool('gemini_deep_research', { question: 'why' }, { id: 1, signal: controller.signal });
  assert.equal(spawns.length, 1, 'only the decompose spawn should have been attempted');
  // Unlike a cancel landing on a later stage (gather/synth, both wrapped so the
  // findings survive), decompose has no such wrapper: the abort propagates as
  // a plain error here — the graceful CANCELLED_NOTE text is not part of
  // spec §4's promise, which is only that the STAGE MODELS are still filed.
  assert.equal(r.isError, true);
  assert.match(r.text, /cancelled/i);
  const s = stageModels(catalog);
  const COMPOSITE = `${s.gather} (decompose, gather) + ${s.synth} (synth)`;
  const header = onlySpooledHeader(dir, 'gemini');
  assert.equal(header.status, 'cancelled');
  assert.equal(header.model, COMPOSITE, 'the stage models must be filed even though decompose itself never completed');
});

// ─── §3 gap: the raised cap holds a real stream through the real pipeline ────

/**
 * A fake grok binary that streams a big `thinking_delta` (to inflate the raw
 * NDJSON well past the old 2 000 000 cap) followed by a short, ordinary
 * answer on the final `result` line. `size` is generated at RUN time
 * (`'y'.repeat(n)`) so the fixture script on disk stays small.
 */
function writeFakeBigGrok(dir, name, { size, answer }) {
  const fake = join(dir, name);
  writeFileSync(fake, [
    `const N = ${size};`,
    `const ANSWER = ${JSON.stringify(answer)};`,
    'const sys = JSON.stringify({ type: "system", subtype: "init", session_id: "s" });',
    'const thinking = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "y".repeat(N) } } });',
    'const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: ANSWER, stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } });',
    'process.stdout.write([sys, thinking, result].join("\\n") + "\\n");',
  ].join('\n'));
  return fake;
}

test('runtime with a fake grok: a ~3 MB stream (over the old 2 000 000 cap, under the raised built-in) comes back whole, uncapped, through the real spawn + interpret pipeline', async () => {
  const dir = home('omelette-grok-bigcap-');
  const OLD_CAP = 2000000;
  const size = OLD_CAP + 1000000; // ~3,000,000 total stream chars — past the old cap, well under GROK_OUTPUT_CAP (10,000,000)
  assert.ok(size < GROK_OUTPUT_CAP, 'the fixture must stay under the built-in or this test proves nothing');
  const fake = writeFakeBigGrok(dir, 'fake-grok-big.mjs', { size, answer: 'the whole answer survived' });
  // No outputCap override at all — the built-in (GROK_OUTPUT_CAP) is what is
  // under test, exactly as an operator who never touched the config would hit.
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: {} }));
  const env = { ...process.env, OMELETTE_HOME: dir, GROK_BIN: process.execPath };
  const rt = createUnitRuntime(
    { ...grokUnit, tools: grokUnit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
  const r = await rt.callTool('grok_research', { prompt: 'q' });
  assert.ok(!r.isError, r.text);
  assert.equal(r.text, 'the whole answer survived', 'the answer must come back exactly, with no cap marker appended');
  assert.doesNotMatch(r.text, /output capped/);
  assert.equal(r.partial, undefined);
});
