/**
 * omelette-fleet :: test/tester-1.6.2-t1.test.mjs
 * Independent tests for 1.6.2 T1 (the Gemini catalog's Claude 5.5 entries and
 * gemini_deep_research's refusal of a Claude id). Written from the task's plan
 * section, not from the implementer's tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEMINI_MODELS, ALLOWLIST, EXCLUDED_CLAUDE_MODELS, GUIDE } from '../units/gemini/models.js';
import unit, { stageModels, catalog, interpretAgy } from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

const CLAUDE_IDS = [
  'Claude Opus 5.5 (High)',
  'Claude Opus 5.5 (Medium)',
  'Claude Sonnet 5.5 (High)',
  'Claude Sonnet 5.5 (Medium)',
];

const REFUSAL = (id) => 'Error: gemini_deep_research does not run on a Claude model ("' + id + '"): a deep-research call is about five agy runs, and Antigravity\'s Claude quota is small and separate. Ask gemini_research with that model for one question, or name a Flash id — a configured Claude `gemini.model` applies whenever `model` is omitted.';

const res = (over) => Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, killed: false, capped: false, ...over });

/** A runtime with an in-process spawn stub; records every spawn's argv and every usedModel call. */
function rig(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t162-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30, ...config } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const calls = { spawn: [], usedModel: [] };
  const stub = (o) => {
    calls.spawn.push(o.args);
    const prompt = o.args[o.args.indexOf('-p') + 1] || '';
    if (/Decompose the following research question/.test(prompt)) {
      return res({ stdout: JSON.stringify({ status: 'SUCCESS', response: '{"subquestions":["alpha"]}', structured_output: { subquestions: ['alpha'] } }) });
    }
    return res({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nthe answer' }) });
  };
  const rt = createUnitRuntime(
    {
      ...unit,
      tools: unit.tools.map((t) => (t.run
        ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub, usedModel: (id) => { calls.usedModel.push(id); return ctx.usedModel(id); } }) }
        : t)),
    },
    { env },
  );
  return { rt, calls, dir };
}

const modelArg = (argv) => argv[argv.indexOf('--model') + 1];

// --- catalog shape ------------------------------------------------------------

test('exactly four Claude entries exist, all heavy, none balanced, each with non-empty useFor/avoid/label', () => {
  const claude = GEMINI_MODELS.filter((m) => m.family === 'claude');
  assert.deepEqual(claude.map((m) => m.id), CLAUDE_IDS);
  for (const m of claude) {
    assert.equal(m.tier, 'heavy', m.id);
    assert.ok(m.label && m.label.includes('5.5'), m.id);
    assert.ok(typeof m.useFor === 'string' && m.useFor.length > 40, m.id);
    assert.ok(typeof m.avoid === 'string' && m.avoid.length > 20, m.id);
  }
  // labels use the middle dot form of the plan
  assert.deepEqual(claude.map((m) => m.label), [
    'Claude Opus 5.5 · High', 'Claude Opus 5.5 · Medium', 'Claude Sonnet 5.5 · High', 'Claude Sonnet 5.5 · Medium',
  ]);
});

test('ids are unique across the catalog and the ALLOWLIST is exactly the catalog ids', () => {
  const ids = GEMINI_MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ALLOWLIST].sort(), [...ids].sort());
  assert.deepEqual(catalog.modelEnum().sort(), [...ids].sort());
  for (const id of ids) assert.ok(!/Claude.*\(Low\)/.test(id), id);
});

test('the Claude entries sit between Gemini 3.1 Pro (High) and GPT-OSS 120B (Medium)', () => {
  const ids = GEMINI_MODELS.map((m) => m.id);
  const pro = ids.indexOf('Gemini 3.1 Pro (High)');
  const oss = ids.indexOf('GPT-OSS 120B (Medium)');
  assert.ok(pro >= 0 && oss >= 0);
  assert.equal(oss, pro + 5);
});

test('the Claude entries carry the plan\'s load-bearing wording', () => {
  const byId = Object.fromEntries(GEMINI_MODELS.map((m) => [m.id, m]));
  assert.match(byId['Claude Opus 5.5 (High)'].useFor, /ran headless via agy 1\.2\.14 on 2026-10-03; the other two ids are listed by agy models and share the id form, and did not run — the bucket answered RESOURCE_EXHAUSTED to both that afternoon, after three calls, which is the point\.$/);
  assert.match(byId['Claude Opus 5.5 (High)'].avoid, /gemini_deep_research refuses Claude ids/);
  assert.match(byId['Claude Opus 5.5 (Medium)'].useFor, /^Antigravity's picker default for Claude \(2026-10-03\)/);
  assert.match(byId['Claude Sonnet 5.5 (High)'].avoid, /Not a tester or a coder/);
  assert.match(byId['Claude Sonnet 5.5 (Medium)'].useFor, /^The lightest Claude read/);
});

test('models.js header: synced to agy 1.2.14 on 2026-10-03, SCOPE rewritten, no 2026-08-02 "Sonnet stays excluded" prose, JSDoc updated', () => {
  const src = read('units/gemini/models.js');
  assert.match(src, /SYNCED TO agy \(verified 2026-10-03, agy 1\.2\.14\)/);
  assert.ok(!src.includes('agy 1.1.25'));
  assert.match(src, /SCOPE: Gemini family \+ GPT-OSS \+ Claude Opus 5\.5 and Sonnet 5\.5 via Antigravity\./);
  assert.ok(!/Claude SONNET stays excluded/.test(src));
  assert.ok(!/Sonnet sits outside/.test(src));
  assert.ok(!/keeps Claude Sonnet out/.test(src));
  assert.match(src, /Claude Opus 5\.5 and Sonnet 5\.5 at High and Medium\)/);
  assert.match(src, /Kept as an export so an importer does not break\./);
  assert.ok(!/4\.6/.test(src), 'no 4.6 left anywhere in models.js');
});

test('GUIDE: the four Claude ids are named once in one clause, GPT-OSS still follows, and the guide ends on the default sentence', () => {
  assert.ok(GUIDE.includes('Claude Opus 5.5 (High|Medium) and Claude Sonnet 5.5 (High|Medium)=Antigravity\'s SEPARATE Claude quota'));
  assert.ok(GUIDE.indexOf('Claude Opus 5.5') < GUIDE.indexOf('GPT-OSS 120B (Medium)='));
  assert.ok(GUIDE.endsWith('Omit the model param to keep agy\'s default.'));
  assert.ok(!/Sonnet is intentionally/.test(GUIDE));
  assert.ok(!/4\.6/.test(GUIDE));
  assert.ok(GUIDE.includes('never the default, never a sweep, never a deep-research stage'));
});

test('gemini_models renders all four Claude ids with their tags, the GUIDE, and no 4.6', async () => {
  const { rt } = rig();
  const r = await rt.callTool('gemini_models', {});
  assert.ok(!r.isError);
  for (const id of CLAUDE_IDS) assert.ok(r.text.includes('• ' + id + '  [claude · '), id);
  assert.ok(r.text.includes('Claude Opus 5.5 (High)  [claude · High effort · heavy]'));
  assert.ok(r.text.includes('Claude Sonnet 5.5 (Medium)  [claude · Medium effort · heavy]'));
  assert.ok(!r.text.includes('4.6'));
  assert.ok(r.text.includes('GUIDE: '));
});

test('every tool that takes `model` offers the four Claude ids in its enum', () => {
  for (const name of ['gemini_research', 'gemini_image', 'gemini_deep_research']) {
    const t = unit.tools.find((x) => x.name === name);
    for (const id of CLAUDE_IDS) assert.ok(t.inputSchema.properties.model.enum.includes(id), name + ' / ' + id);
    assert.ok(!t.inputSchema.properties.model.enum.some((i) => i.includes('4.6')), name);
  }
});

test('stageModels: no explicit model still picks the Flash pair; an explicit Claude id is passed through untouched (the refusal lives in the tool)', () => {
  const s = stageModels(catalog);
  assert.ok(s.decompose && s.gather && s.synth);
  for (const id of [s.decompose, s.gather, s.synth]) assert.ok(catalog.find(id).family === 'gemini' && catalog.find(id).tier === 'balanced', id);
  const e = stageModels(catalog, 'Claude Opus 5.5 (High)');
  assert.deepEqual(e, { decompose: 'Claude Opus 5.5 (High)', gather: 'Claude Opus 5.5 (High)', synth: 'Claude Opus 5.5 (High)' });
});

// --- the deep-research refusal ------------------------------------------------

for (const id of CLAUDE_IDS) {
  test(`gemini_deep_research refuses explicit ${id}: exact text, isError, no spawn, no usedModel`, async () => {
    const { rt, calls } = rig();
    const r = await rt.callTool('gemini_deep_research', { question: 'why', model: id });
    assert.equal(r.isError, true);
    assert.equal(r.text, REFUSAL(id));
    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.usedModel.length, 0);
  });

  test(`gemini_deep_research refuses a CONFIGURED ${id} with no model argument`, async () => {
    const { rt, calls } = rig({ model: id });
    const r = await rt.callTool('gemini_deep_research', { question: 'why' });
    assert.equal(r.isError, true);
    assert.equal(r.text, REFUSAL(id));
    assert.equal(calls.spawn.length, 0);
  });
}

test('an explicit Flash id overrides a configured Claude id: the call runs', async () => {
  const { rt, calls } = rig({ model: 'Claude Opus 5.5 (High)' });
  const r = await rt.callTool('gemini_deep_research', { question: 'why', model: 'Gemini 3.8 Flash (Medium)' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /## Summary/);
  assert.ok(calls.spawn.length >= 2);
  for (const argv of calls.spawn) assert.equal(modelArg(argv), 'Gemini 3.8 Flash (Medium)');
});

test('an explicit Claude id overrides a configured Flash id: the call is refused', async () => {
  const { rt, calls } = rig({ model: 'Gemini 3.8 Flash (Medium)' });
  const r = await rt.callTool('gemini_deep_research', { question: 'why', model: 'Claude Sonnet 5.5 (High)' });
  assert.equal(r.isError, true);
  assert.equal(r.text, REFUSAL('Claude Sonnet 5.5 (High)'));
  assert.equal(calls.spawn.length, 0);
});

test('a surrounding-whitespace Claude id is still refused, named without the whitespace', async () => {
  const { rt, calls } = rig();
  const r = await rt.callTool('gemini_deep_research', { question: 'why', model: '  Claude Opus 5.5 (Medium)  ' });
  assert.equal(r.isError, true);
  assert.equal(r.text, REFUSAL('Claude Opus 5.5 (Medium)'));
  assert.equal(calls.spawn.length, 0);
});

test('a Claude Low id (agy lists it, the catalog does not) is the runtime\'s "unknown model" error, not the refusal, and spawns nothing', async () => {
  const { rt, calls } = rig();
  const r = await rt.callTool('gemini_deep_research', { question: 'why', model: 'Claude Opus 5.5 (Low)' });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Error: unknown model "Claude Opus 5\.5 \(Low\)"\. Allowed: /);
  assert.ok(r.text.includes('Claude Sonnet 5.5 (Medium)'));
  assert.ok(!r.text.includes('Opus 4.6'));
  assert.equal(calls.spawn.length, 0);
  // and the removed 4.6 id is refused the same way
  const old = await rt.callTool('gemini_research', { prompt: 'hi', model: 'Claude Opus 4.6 (Thinking)' });
  assert.match(old.text, /^Error: unknown model "Claude Opus 4\.6 \(Thinking\)"/);
  assert.equal(calls.spawn.length, 0);
});

test('a configured Claude id the catalog does not admit is ignored (vendor default) and deep research proceeds on the Flash stages', async () => {
  const { rt, calls } = rig({ model: 'Claude Opus 5.5 (Low)' });
  const r = await rt.callTool('gemini_deep_research', { question: 'why' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /## Summary/);
  for (const argv of calls.spawn) assert.match(modelArg(argv), /^Gemini 3\.8 Flash \(/);
});

test('deep research with no model uses Flash for every spawn (no Claude id leaks into the stages)', async () => {
  const { rt, calls } = rig();
  const r = await rt.callTool('gemini_deep_research', { question: 'why' });
  assert.ok(!r.isError, r.text);
  assert.ok(calls.spawn.length >= 2);
  for (const argv of calls.spawn) assert.match(modelArg(argv), /^Gemini 3\.8 Flash \(/);
  assert.equal(calls.usedModel.length, 1);
});

test('an empty question is still the "question is required" error, not the refusal, even with a Claude id', async () => {
  const { rt, calls } = rig();
  const r = await rt.callTool('gemini_deep_research', { question: '   ', model: 'Claude Opus 5.5 (High)' });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'Error: "question" is required.');
  assert.equal(calls.spawn.length, 0);
});

test('the refusal is a finished call, not a hang: the status feed and the spool record it as an error and no stage ran', async () => {
  const { rt, dir, calls } = rig();
  await rt.callTool('gemini_deep_research', { question: 'why', model: 'Claude Opus 5.5 (High)' });
  const snap = JSON.parse(readFileSync(join(dir, `status-gemini-${process.pid}.json`), 'utf8'));
  assert.equal(snap.lastEvent.status, 'error');
  assert.equal(calls.spawn.length, 0);
});

// --- Claude through the single-question route still works ---------------------

test('gemini_research on a Claude id reaches agy with that exact --model (the named one-call route is open)', async () => {
  for (const id of CLAUDE_IDS) {
    const { rt, calls } = rig();
    const r = await rt.callTool('gemini_research', { prompt: 'a question', model: id });
    assert.ok(!r.isError, r.text);
    assert.equal(calls.spawn.length, 1, id);
    assert.equal(modelArg(calls.spawn[0]), id);
  }
});

test('a configured Claude gemini.model is refused by gemini_research when the call names no model (round 2, R5)', async () => {
  const { rt, calls } = rig({ model: 'Claude Sonnet 5.5 (Medium)' });
  const r = await rt.callTool('gemini_research', { prompt: 'a question' });
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith('Error: a Claude id is named per call, not configured as `gemini.model` ("Claude Sonnet 5.5 (Medium)" is the configured default)'), r.text);
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.usedModel.length, 0);
});

// --- descriptions -------------------------------------------------------------

test('gemini_models and gemini_deep_research descriptions: exact new sentences, the old ones gone', () => {
  const models = unit.tools.find((t) => t.name === 'gemini_models').description;
  assert.ok(models.startsWith('List the Gemini/GPT-OSS/Claude models you can pass as `model`'));
  assert.ok(models.endsWith("Claude Opus 5.5 and Sonnet 5.5 (High and Medium) are listed too: Antigravity's separate, small Claude quota — one named call per question, never a sweep, refused by gemini_deep_research."));
  assert.ok(!models.includes('intentionally NOT exposed'));
  assert.ok(!models.includes('4.6'));
  const deep = unit.tools.find((t) => t.name === 'gemini_deep_research').description;
  const a = deep.indexOf('Optionally choose a model with `model` (omit for the per-stage defaults). ');
  const b = deep.indexOf('Claude ids are refused here — small separate quota, about five runs per call; use gemini_research for a single Claude read. ');
  assert.ok(a >= 0 && b === a + 'Optionally choose a model with `model` (omit for the per-stage defaults). '.length, 'the refusal sentence follows the model sentence directly');
});

// --- docs, changelog, version, stale mentions ---------------------------------

test('no live doc, example or source names a 4.6 Claude model or says Sonnet is not exposed', () => {
  const files = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/ORCHESTRATION.md', 'docs/CONFIG.md', 'docs/SECURITY.md', 'docs/ARCHITECTURE.md', 'docs/ADAPTERS.md', 'docs/MEASUREMENTS.md', 'units/gemini/adapter.mjs', 'units/gemini/models.js'];
  for (const f of files) {
    let src;
    try { src = read(f); } catch { continue; }
    assert.ok(!/Opus 4\.6|Sonnet 4\.6|opus-4-6|sonnet-4-6/i.test(src), f + ' still names a 4.6 Claude model');
    assert.ok(!/NOT exposed|intentionally NOT/.test(src), f + ' still says Sonnet is not exposed');
  }
});

test('ORCHESTRATION: the new bullet is whole and replaced the old one in place (between the Flash-vs-Pro bullet and GPT-OSS)', () => {
  const orch = read('docs/ORCHESTRATION.md');
  const bullet = "- `Claude Opus 5.5 (High|Medium)` and `Claude Sonnet 5.5 (High|Medium)` run on Antigravity's separate Claude quota — the same generation as the fleet's own coder and reviewer, so they buy an independent read, not a stronger one. That quota is small (operator, 2026-10-03) where the Gemini pool is effectively unlimited: one named call per question, never a sweep, and `gemini_deep_research` refuses them (about five runs per call); `gemini_research` and `gemini_image` refuse a Claude id that is only the configured `gemini.model`. The refusals see only ids the fleet names: keep agy's own default model a Gemini one. Prefer Gemini for citation-heavy research (web grounding via agy is unverified for the Claude family). Sonnet's 2026-08-02 exclusion is lifted; neither is a fleet role.";
  assert.equal(orch.split(bullet).length - 1, 1);
  assert.ok(orch.indexOf(bullet) < orch.indexOf('- `GPT-OSS 120B (Medium)` is a corroborating voice'));
  assert.ok(orch.indexOf('Plain 128K retrieval is **not**') < orch.indexOf(bullet));
});

test('CHANGELOG: the 1.6.2 entry is dated, has its four bullets, and sits right above 1.6.1', () => {
  const cl = read('CHANGELOG.md');
  const heads = cl.split('\n').filter((l) => l.startsWith('## '));
  const i = heads.indexOf('## 1.6.2 — 2026-10-03');
  assert.ok(i >= 0);
  assert.match(heads[i + 1], /^## 1\.6\.1 — 2026-09-30/);
  const entry = cl.slice(cl.indexOf('## 1.6.2'), cl.indexOf('## 1.6.1'));
  assert.equal(entry.split('\n').filter((l) => l.startsWith('- ')).length, 4);
  assert.ok(entry.includes('**The Gemini catalog\'s Claude entries are the 5.5 generation.**'));
  assert.ok(entry.includes('**Sonnet is exposed, and the 2026-08-02 exclusion is lifted**'));
  assert.ok(entry.includes('**The Antigravity Claude quota is small, so Claude-via-agy is a named one-call route.**'));
  assert.ok(entry.includes('`EXCLUDED_CLAUDE_MODELS` is empty and stays exported.'));
  assert.ok(entry.includes('explicit or configured as `gemini.model`'));
});

// --- second pass: the pins the mutation check showed missing ------------------

test('2nd pass: EXCLUDED_CLAUDE_MODELS is an exported empty array (mutation: a non-empty list passed my first file)', () => {
  assert.ok(Array.isArray(EXCLUDED_CLAUDE_MODELS));
  assert.equal(EXCLUDED_CLAUDE_MODELS.length, 0);
});

test('2nd pass: the GUIDE clause for the four Claude ids is the plan\'s text, verbatim', () => {
  const clause =
    'Claude Opus 5.5 (High|Medium) and Claude Sonnet 5.5 (High|Medium)=Antigravity\'s SEPARATE Claude quota, and a ' +
    'SMALL one: one named call per question — an independent Opus read, a hard verification pass, a cheap Sonnet ' +
    'cross-check — when the Claude Code pool is the constraint; never the default, never a sweep, never a ' +
    'deep-research stage (gemini_deep_research refuses Claude ids), never configured as gemini.model (gemini_research and gemini_image refuse a Claude default); the same generation as the fleet\'s own roles, so ' +
    'an independent read, not a stronger one; prefer Gemini for citation-heavy research; ';
  assert.ok(GUIDE.includes(clause));
});

test('2nd pass: the eight useFor/avoid texts of the four entries are the plan\'s, verbatim', () => {
  const want = {
    'Claude Opus 5.5 (High)': [
      "An independent Opus-class second opinion or a hard verification pass on Antigravity's SEPARATE Claude quota — the same generation as the fleet's own coder and reviewer, so it adds an independent read, not a stronger one. One named call per question, when the Claude Code pool is the constraint or the question deserves two Opus reads. Opus 5.5 (Medium) and Sonnet 5.5 (High) ran headless via agy 1.2.14 on 2026-10-03; the other two ids are listed by agy models and share the id form, and did not run — the bucket answered RESOURCE_EXHAUSTED to both that afternoon, after three calls, which is the point.",
      "Anything routine, any sweep, any loop, and every deep-research stage (gemini_deep_research refuses Claude ids) and never as the configured default (gemini_research and gemini_image refuse it): the Antigravity Claude bucket is small and shared by all four Claude entries, where the Gemini pool is effectively unlimited for this fleet. Not a fleet role: the guard, the diff and the transcript live in Claude Code. Citation-heavy research goes to Gemini (web grounding via agy is unverified for the Claude family).",
    ],
    'Claude Opus 5.5 (Medium)': [
      "Antigravity's picker default for Claude (2026-10-03): an Opus-class second opinion where High's latency is not worth it — a plan section, a design question, an arbitration read. Same quota rule as High: one named call, never a sweep.",
      'As Opus 5.5 (High). Step up to High for a verification pass that has to be thorough; step down to Sonnet 5.5 for a cheap read.',
    ],
    'Claude Sonnet 5.5 (High)': [
      'A cheap second opinion or a volume read on the Antigravity Claude quota instead of the native Claude Code pool — reviewing a document, checking a set of claims, a second read of a tester report. Listed since 2026-10-03: the two pools are separate and the native one is the expensive one.',
      'Sweeps and loops all the same — the bucket is small and shared with Opus. Not a tester or a coder: those roles need the guard and the diff. Flash stays the default for research, Flash Low for anything cheap.',
    ],
    'Claude Sonnet 5.5 (Medium)': [
      "The lightest Claude read on the Antigravity bucket: a summary, a sanity check, a short classification — when Flash's answer wants a Claude cross-check and the native pool should stay untouched.",
      'As Sonnet 5.5 (High); prefer Flash Low or Medium for anything that does not need a Claude voice.',
    ],
  };
  for (const [id, [useFor, avoid]] of Object.entries(want)) {
    const m = GEMINI_MODELS.find((x) => x.id === id);
    assert.equal(m.useFor, useFor, id + ' useFor');
    assert.equal(m.avoid, avoid, id + ' avoid');
  }
});

test('2nd pass: the ALLOWLIST JSDoc states the new policy and the SCOPE paragraph is the plan\'s text', () => {
  const src = read('units/gemini/models.js');
  assert.ok(src.includes('POLICY — it keeps every Claude id agy lists but the catalog does not admit\n *      (the Low tiers today, a next model tomorrow) out of the agy path until the\n *      catalog says so. agy itself would happily run them.'));
  assert.ok(src.includes(' * SCOPE: Gemini family + GPT-OSS + Claude Opus 5.5 and Sonnet 5.5 via Antigravity.\n * The Claude family runs on Antigravity\'s OWN quota bucket, separate from the shared\n * Gemini pool (confirmed 2026-08-02 by two independent deep-research runs and operator\n * decision) — and that bucket is SMALL (operator, 2026-10-03), where the Gemini pool is\n * effectively unlimited for this fleet.'));
});

// --- third pass: R5 (gemini_research refuses a configured Claude default) and R7 (the Claude exhaustion message) ---

const CFG_REFUSAL_HEAD = 'Error: a Claude id is named per call, not configured as `gemini.model` ("';
const CLAUDE_EXHAUSTED_MSG = "Claude quota exhausted — Antigravity's Claude bucket is empty (separate from Gemini's, and small); try after it resets.";
const GEMINI_EXHAUSTED_MSG = 'Gemini quota exhausted — the Antigravity bucket is empty; try after the window resets.';

/** A rig whose every spawn fails as an exhausted bucket; counts spawns. */
function exhaustedRig(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t162-r7-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30, ...config } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const calls = { spawn: [] };
  const stub = (o) => { calls.spawn.push(o.args); return res({ stdout: '', stderr: 'error: Individual quota reached. AGY_ERROR RESOURCE_EXHAUSTED', code: 1 }); };
  const rt = createUnitRuntime({ ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub }) } : t)) }, { env });
  return { rt, calls };
}

for (const id of CLAUDE_IDS) {
  test(`R5: gemini_research refuses a configured ${id} when the call names no model: before any spawn, no usedModel`, async () => {
    const { rt, calls } = rig({ model: id });
    const r = await rt.callTool('gemini_research', { prompt: 'a question' });
    assert.equal(r.isError, true);
    assert.ok(r.text.startsWith(CFG_REFUSAL_HEAD + id + '" is the configured default)'), r.text);
    assert.match(r.text, /omelette-fleet set gemini\.model=/);
    assert.equal(calls.spawn.length, 0);
    assert.equal(calls.usedModel.length, 0);
  });
}

test('R5: the refusal comes before the cwd check (a relative cwd does not mask it) and before any spawn', async () => {
  const { rt, calls } = rig({ model: 'Claude Opus 5.5 (High)' });
  const r = await rt.callTool('gemini_research', { prompt: 'a question', cwd: 'relative/dir' });
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith(CFG_REFUSAL_HEAD), r.text);
  assert.equal(calls.spawn.length, 0);
});

test('R5: a Claude id named in the call runs when it differs from the configured one, and with a Flash default', async () => {
  for (const config of [{ model: 'Claude Opus 5.5 (Medium)' }, { model: 'Gemini 3.8 Flash (High)' }, {}]) {
    const { rt, calls } = rig(config);
    const r = await rt.callTool('gemini_research', { prompt: 'a question', model: 'Claude Sonnet 5.5 (High)' });
    assert.ok(!r.isError, r.text);
    assert.equal(calls.spawn.length, 1);
    assert.equal(modelArg(calls.spawn[0]), 'Claude Sonnet 5.5 (High)');
  }
});

test('R5: a configured Claude default with a Flash id named in the call runs on the Flash id', async () => {
  const { rt, calls } = rig({ model: 'Claude Opus 5.5 (High)' });
  const r = await rt.callTool('gemini_research', { prompt: 'a question', model: 'Gemini 3.8 Flash (Medium)' });
  assert.ok(!r.isError, r.text);
  assert.equal(calls.spawn.length, 1);
  assert.equal(modelArg(calls.spawn[0]), 'Gemini 3.8 Flash (Medium)');
});

test('R5: a configured Flash default, no model in the call, runs on it; no config at all runs on agy\'s default (no --model)', async () => {
  const a = rig({ model: 'Gemini 3.8 Flash (High)' });
  const ra = await a.rt.callTool('gemini_research', { prompt: 'q' });
  assert.ok(!ra.isError, ra.text);
  assert.equal(modelArg(a.calls.spawn[0]), 'Gemini 3.8 Flash (High)');
  const b = rig({});
  const rb = await b.rt.callTool('gemini_research', { prompt: 'q' });
  assert.ok(!rb.isError, rb.text);
  assert.ok(!b.calls.spawn[0].includes('--model'));
});

test('R5: a whitespace-only model argument is "no model named": the configured Claude default is refused', async () => {
  const { rt, calls } = rig({ model: 'Claude Opus 5.5 (High)' });
  const r = await rt.callTool('gemini_research', { prompt: 'q', model: '   ' });
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith(CFG_REFUSAL_HEAD), r.text);
  assert.equal(calls.spawn.length, 0);
});

test('R5: an empty prompt is still the "prompt is required" error even with a configured Claude default', async () => {
  const { rt } = rig({ model: 'Claude Opus 5.5 (High)' });
  const r = await rt.callTool('gemini_research', { prompt: '  ' });
  assert.equal(r.text, 'Error: "prompt" is required.');
});

test('R7: a Claude run that exhausts the bucket says so, and is not retried (one spawn)', async () => {
  const { rt, calls } = exhaustedRig();
  const r = await rt.callTool('gemini_research', { prompt: 'q', model: 'Claude Opus 5.5 (Medium)' });
  assert.equal(r.isError, true);
  assert.ok(r.text.includes(CLAUDE_EXHAUSTED_MSG), r.text);
  assert.ok(!r.text.includes(GEMINI_EXHAUSTED_MSG));
  assert.equal(calls.spawn.length, 1);
});

test('R7: the Claude message itself carries "quota exhausted" (the retry skip depends on it)', () => {
  assert.match(CLAUDE_EXHAUSTED_MSG, /quota exhausted/);
  assert.throws(
    () => interpretAgy({ stdout: '', stderr: 'RESOURCE_EXHAUSTED', code: 1, killed: false }, { timeoutS: 30, claude: true }),
    (e) => e.message === CLAUDE_EXHAUSTED_MSG && /quota exhausted/.test(e.message),
  );
});

test('R7: a Flash run, the default run and a deep-research Flash stage all keep the unchanged Gemini message', async () => {
  for (const [tool, args] of [
    ['gemini_research', { prompt: 'q', model: 'Gemini 3.8 Flash (High)' }],
    ['gemini_research', { prompt: 'q' }],
    ['gemini_deep_research', { question: 'q' }],
  ]) {
    const { rt, calls } = exhaustedRig();
    const r = await rt.callTool(tool, args);
    assert.equal(r.isError, true, tool);
    assert.ok(r.text.includes(GEMINI_EXHAUSTED_MSG), tool + ': ' + r.text);
    assert.ok(!/Claude/.test(r.text), tool + ': ' + r.text);
    assert.equal(calls.spawn.length, 1, tool);
  }
});

test('R7: the Gemini exhaustion message is byte-identical to the one the interpreter threw before round 2', () => {
  assert.throws(
    () => interpretAgy({ stdout: '', stderr: 'RESOURCE_EXHAUSTED', code: 1, killed: false }, { timeoutS: 30 }),
    (e) => e.message === GEMINI_EXHAUSTED_MSG,
  );
});

test('R4: the CHANGELOG upgrade bullet names the 4.6 pin, the one stderr line, the vendor default, doctor, and both ways out', () => {
  const cl = read('CHANGELOG.md');
  const entry = cl.slice(cl.indexOf('## 1.6.2'), cl.indexOf('## 1.6.1'));
  const bullet = entry.split('\n').find((l) => l.startsWith('- **Upgrading from 1.6.1'));
  assert.ok(bullet, 'an upgrade bullet exists');
  assert.ok(bullet.includes('`gemini.model` pinned to `Claude Opus 4.6 (Thinking)`'));
  assert.ok(bullet.includes('one `config: default model … is not in the catalog — using the vendor default` line'));
  assert.ok(bullet.includes('`doctor` does not say so yet'));
  assert.ok(bullet.includes('`omelette-fleet set gemini.model=`'));
});

test('R6: the ORCHESTRATION routing table has the Claude-via-agy row, right after the deep-research row, with three cells', () => {
  const lines = read('docs/ORCHESTRATION.md').split('\n');
  const deep = lines.findIndex((l) => l.startsWith('| Multi-source deep research |'));
  assert.ok(deep >= 0);
  const row = lines[deep + 1];
  assert.ok(row.startsWith("| An independent Claude read on Antigravity's quota |"), row);
  assert.equal(row.split(/(?<!\\)\|/).length - 2, 3);
  assert.ok(row.includes('never the configured default'));
});

test('R8: the isAllowedModel JSDoc no longer says "(non-Claude)"', () => {
  assert.ok(!read('units/gemini/models.js').includes('(non-Claude)'));
});

// --- fourth pass: R9 (gemini_image), R10, R11, R12 ---------------------------

/** Runs fn with TMPDIR pointed at a private empty directory; returns what fn left in it. */
async function withPrivateTmp(fn) {
  const priv = mkdtempSync(join(realpathSync(tmpdir()), 'omelette-t162-tmp-'));
  const was = process.env.TMPDIR;
  process.env.TMPDIR = priv;
  try { await fn(); } finally { if (was === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = was; }
  return readdirSync(priv);
}

test('R9: gemini_image with a configured Claude default and no model is refused: no spawn, no usedModel, no temp directory', async () => {
  for (const id of CLAUDE_IDS) {
    const { rt, calls } = rig({ model: id });
    let r;
    const left = await withPrivateTmp(async () => { r = await rt.callTool('gemini_image', { prompt: 'a cat' }); });
    assert.equal(r.isError, true);
    assert.ok(r.text.startsWith(CFG_REFUSAL_HEAD + id + '" is the configured default)'), r.text);
    assert.equal(calls.spawn.length, 0, id);
    assert.equal(calls.usedModel.length, 0, id);
    assert.deepEqual(left, [], id + ': a temp directory was made');
  }
});

test('R9: gemini_image refusal text is the same as gemini_research\'s for the same configured id', async () => {
  const a = rig({ model: 'Claude Sonnet 5.5 (High)' });
  const ri = await a.rt.callTool('gemini_image', { prompt: 'a cat' });
  const rr = await a.rt.callTool('gemini_research', { prompt: 'a cat' });
  assert.equal(ri.text, rr.text);
});

test('R9: gemini_image with a configured Claude default and a Flash id named spawns on the Flash id; a Claude id named spawns on it', async () => {
  for (const named of ['Gemini 3.8 Flash (Medium)', 'Claude Opus 5.5 (Medium)']) {
    const { rt, calls } = rig({ model: 'Claude Opus 5.5 (High)' });
    await rt.callTool('gemini_image', { prompt: 'a cat', model: named });
    assert.equal(calls.spawn.length, 1, named);
    assert.equal(modelArg(calls.spawn[0]), named);
  }
});

test('R9: gemini_image with no config, and with a configured Flash default, still spawns (no regression)', async () => {
  const a = rig({});
  await a.rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(a.calls.spawn.length, 1);
  assert.ok(!a.calls.spawn[0].includes('--model'));
  const b = rig({ model: 'Gemini 3.8 Flash (High)' });
  await b.rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(modelArg(b.calls.spawn[0]), 'Gemini 3.8 Flash (High)');
});

test('R9: gemini_image with an empty prompt is still "prompt is required", even with a configured Claude default', async () => {
  const { rt } = rig({ model: 'Claude Opus 5.5 (High)' });
  const r = await rt.callTool('gemini_image', { prompt: ' ' });
  assert.equal(r.text, 'Error: "prompt" is required.');
});

test('R11: the served model property of gemini_research and gemini_image says a configured Claude id is refused here; the deep-research one is the same text', () => {
  for (const name of ['gemini_research', 'gemini_image', 'gemini_deep_research']) {
    const d = unit.tools.find((t) => t.name === name).inputSchema.properties.model.description;
    assert.ok(d.includes('a configured Claude id is refused here; Claude is named per call, where the tool takes it'), name);
    assert.ok(d.includes('else the tool\'s own default: agy\'s for gemini_research and gemini_image, the Flash stages for gemini_deep_research'), name);
  }
});

test('R10/R12: the CHANGELOG bullets carry the ruled sentences', () => {
  const cl = read('CHANGELOG.md');
  const entry = cl.slice(cl.indexOf('## 1.6.2'), cl.indexOf('## 1.6.1'));
  assert.ok(entry.includes('the other two were accepted by `agy models` and did not run — the Claude bucket answered `RESOURCE_EXHAUSTED` to both the same afternoon, after three calls, which is the quota rule in one line.'));
  assert.ok(entry.includes('(`gemini_research` for one question, or a Flash id — omitting `model` helps only while no Claude id is the configured default)'));
  assert.ok(entry.includes('`gemini_research` and `gemini_image` refuse a Claude id that arrives only from the configured `gemini.model`, naming the per-call alternative: a Claude call is named where it is spent.'));
  assert.ok(!entry.includes('and not run'));
  assert.ok(!entry.includes('or no `model` for the Flash stages'));
});

// --- session, after the whole-branch review (finding 4): the deep-research refusal makes no temp directory ---

test('review-4: gemini_deep_research refuses a Claude id before its temp directory is made', async () => {
  for (const [config, args] of [[{}, { question: 'q', model: 'Claude Opus 5.5 (High)' }], [{ model: 'Claude Sonnet 5.5 (Medium)' }, { question: 'q' }]]) {
    const { rt, calls } = rig(config);
    let r;
    const left = await withPrivateTmp(async () => { r = await rt.callTool('gemini_deep_research', args); });
    assert.equal(r.isError, true);
    assert.ok(r.text.startsWith('Error: gemini_deep_research does not run on a Claude model ("'), r.text);
    assert.equal(calls.spawn.length, 0);
    assert.deepEqual(left, [], JSON.stringify(config) + ': a temp directory was made');
  }
});
