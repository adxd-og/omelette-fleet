import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEMINI_MODELS, ALLOWLIST, EXCLUDED_CLAUDE_MODELS, GUIDE } from '../units/gemini/models.js';
import unit, { interpretAgy, stageModels, catalog } from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

const CLAUDE = [
  ['Claude Opus 5.5 (High)', 'High'],
  ['Claude Opus 5.5 (Medium)', 'Medium'],
  ['Claude Sonnet 5.5 (High)', 'High'],
  ['Claude Sonnet 5.5 (Medium)', 'Medium'],
];

test('the four Claude 5.5 entries follow Gemini 3.1 Pro (High), in order, heavy, with their efforts', () => {
  const ids = GEMINI_MODELS.map((m) => m.id);
  const at = ids.indexOf('Gemini 3.1 Pro (High)');
  assert.ok(at >= 0);
  assert.deepEqual(ids.slice(at + 1, at + 5), CLAUDE.map(([id]) => id));
  for (const [id, effort] of CLAUDE) {
    const m = GEMINI_MODELS.find((x) => x.id === id);
    assert.equal(m.family, 'claude', id);
    assert.equal(m.tier, 'heavy', id);
    assert.equal(m.effort, effort, id);
    assert.ok(ALLOWLIST.includes(id), id);
  }
});

test('no 4.6 id and no Claude Low tier in the catalog; the exclusion list is an exported empty array', () => {
  for (const m of GEMINI_MODELS) {
    assert.ok(!m.id.includes('4.6'), m.id);
    if (m.family === 'claude') assert.ok(!m.id.endsWith('(Low)'), m.id);
  }
  assert.ok(Array.isArray(EXCLUDED_CLAUDE_MODELS));
  assert.equal(EXCLUDED_CLAUDE_MODELS.length, 0);
});

test('the guide and gemini_models name the small separate Claude quota and the deep-research refusal', () => {
  assert.ok(GUIDE.includes("Antigravity's SEPARATE Claude quota, and a SMALL one"));
  assert.ok(GUIDE.includes('gemini_deep_research refuses Claude ids'));
  assert.ok(!GUIDE.includes('Opus 4.6'));
  assert.ok(!GUIDE.includes('intentionally NOT exposed'));
  assert.ok(GUIDE.endsWith("Omit the model param to keep agy's default."));
  const models = unit.tools.find((t) => t.name === 'gemini_models');
  assert.ok(models.description.includes('Gemini/GPT-OSS/Claude'));
  assert.ok(models.description.includes('refused by gemini_deep_research'));
  const deep = unit.tools.find((t) => t.name === 'gemini_deep_research');
  assert.ok(deep.description.includes('Claude ids are refused here — small separate quota, about five runs per call; use gemini_research for a single Claude read.'));
});

test('stageModels still picks Flash for every stage: the Claude entries are heavy, not balanced', () => {
  const s = stageModels(catalog);
  for (const id of [s.decompose, s.gather, s.synth]) {
    assert.match(id, /^Gemini 3\.8 Flash \(/);
  }
});

/** A runtime whose spawn and usedModel are recorded; every spawn answers a canned deep-research stage. */
function deepRuntime(config, answer) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-162-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30, ...config } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const calls = { spawn: [], usedModel: [], log: [] };
  const stub = (o) => {
    calls.spawn.push(o.args);
    if (answer) return Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, killed: false, capped: false, ...answer });
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) {
      return Promise.resolve({ stdout: JSON.stringify({ status: 'SUCCESS', response: '{"subquestions":["alpha"]}', structured_output: { subquestions: ['alpha'] } }), stderr: '', code: 0, signal: null, killed: false, capped: false });
    }
    return Promise.resolve({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nthe report' }), stderr: '', code: 0, signal: null, killed: false, capped: false });
  };
  const rt = createUnitRuntime(
    {
      ...unit,
      tools: unit.tools.map((t) => (t.run
        ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub, log: (m) => { calls.log.push(m); return ctx.log(m); }, usedModel: (id) => { calls.usedModel.push(id); return ctx.usedModel(id); } }) }
        : t)),
    },
    { env },
  );
  return { rt, calls };
}

const refusal = (id) => 'Error: gemini_deep_research does not run on a Claude model ("' + id + '"): a deep-research call is about five agy runs, and Antigravity\'s Claude quota is small and separate. Ask gemini_research with that model for one question, or name a Flash id — a configured Claude `gemini.model` applies whenever `model` is omitted.';

test('gemini_deep_research refuses an explicit Claude model before any spawn', async () => {
  const { rt, calls } = deepRuntime({});
  const r = await rt.callTool('gemini_deep_research', { question: 'why', model: 'Claude Opus 5.5 (High)' });
  assert.equal(r.isError, true);
  assert.equal(r.text, refusal('Claude Opus 5.5 (High)'));
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.usedModel.length, 0);
});

test('gemini_deep_research refuses a configured Claude model before any spawn', async () => {
  const { rt, calls } = deepRuntime({ model: 'Claude Sonnet 5.5 (Medium)' });
  const r = await rt.callTool('gemini_deep_research', { question: 'why' });
  assert.equal(r.isError, true);
  assert.equal(r.text, refusal('Claude Sonnet 5.5 (Medium)'));
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.usedModel.length, 0);
});

test('gemini_deep_research with a Flash id or no model still reaches the stages', async () => {
  for (const args of [{ question: 'why', model: 'Gemini 3.8 Flash (Medium)' }, { question: 'why' }]) {
    const { rt, calls } = deepRuntime({});
    const r = await rt.callTool('gemini_deep_research', args);
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /## Summary/);
    assert.ok(calls.spawn.length >= 2, `spawned ${calls.spawn.length}`);
    assert.equal(calls.usedModel.length, 1);
  }
});

test('ORCHESTRATION, CHANGELOG and package.json carry 1.6.2', () => {
  const orch = read('docs/ORCHESTRATION.md');
  assert.ok(orch.includes("- `Claude Opus 5.5 (High|Medium)` and `Claude Sonnet 5.5 (High|Medium)` run on Antigravity's separate Claude quota — the same generation as the fleet's own coder and reviewer, so they buy an independent read, not a stronger one."));
  assert.ok(!orch.includes('Opus 4.6 (Thinking)'));
  const firstEntry = read('CHANGELOG.md').split('\n').find((l) => l.startsWith('## '));
  assert.equal(firstEntry, '## 1.6.2 — 2026-10-03');
  assert.equal(JSON.parse(read('package.json')).version, '1.6.2');
});

// --- Round 2: a configured Claude default is refused by gemini_research (R5) ---

const DEFAULT_REFUSAL = (id) => 'Error: a Claude id is named per call, not configured as `gemini.model` ("' + id + '" is the configured default): Antigravity\'s Claude quota is small and separate, and a default would spend it on every call. Name the model in this call to use it once, or clear the default: `omelette-fleet set gemini.model=`, or unset the legacy `AGY_DEFAULT_MODEL` env override if that is where it comes from.';
const modelArg = (argv) => (argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : undefined);

test('gemini_research refuses a Claude id that arrives only from the configured gemini.model, before any spawn', async () => {
  const { rt, calls } = deepRuntime({ model: 'Claude Opus 5.5 (Medium)' });
  const r = await rt.callTool('gemini_research', { prompt: 'a question' });
  assert.equal(r.isError, true);
  assert.equal(r.text, DEFAULT_REFUSAL('Claude Opus 5.5 (Medium)'));
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.usedModel.length, 0);
});

test('gemini_research runs a Claude id named in the call, even when the same id is configured', async () => {
  const { rt, calls } = deepRuntime({ model: 'Claude Opus 5.5 (Medium)' });
  const r = await rt.callTool('gemini_research', { prompt: 'a question', model: 'Claude Opus 5.5 (Medium)' });
  assert.ok(!r.isError, r.text);
  assert.equal(calls.spawn.length, 1);
  assert.equal(modelArg(calls.spawn[0]), 'Claude Opus 5.5 (Medium)');
});

test('gemini_research with a configured Flash default and no model runs on it', async () => {
  const { rt, calls } = deepRuntime({ model: 'Gemini 3.8 Flash (Medium)' });
  const r = await rt.callTool('gemini_research', { prompt: 'a question' });
  assert.ok(!r.isError, r.text);
  assert.equal(calls.spawn.length, 1);
  assert.equal(modelArg(calls.spawn[0]), 'Gemini 3.8 Flash (Medium)');
});

// --- Round 2: an exhausted Claude run names the Claude bucket (R7) ---

const CLAUDE_EXHAUSTED = "Claude quota exhausted — Antigravity's Claude bucket is empty (separate from Gemini's, and small); try after it resets.";
const GEMINI_EXHAUSTED = 'Gemini quota exhausted — the Antigravity bucket is empty; try after the window resets.';

test('interpretAgy names the Claude bucket for a Claude run and the Gemini bucket otherwise', () => {
  const failed = { stdout: '', stderr: 'AGY_ERROR RESOURCE_EXHAUSTED', code: 1, killed: false };
  assert.throws(() => interpretAgy(failed, { timeoutS: 30, claude: true }), (e) => e.message === CLAUDE_EXHAUSTED);
  assert.throws(() => interpretAgy(failed, { timeoutS: 30 }), (e) => e.message === GEMINI_EXHAUSTED);
});

test('an exhausted Claude run says so once, with no retry; a Flash run keeps the Gemini message', async () => {
  const exhausted = { stderr: 'error: Individual quota reached. AGY_ERROR RESOURCE_EXHAUSTED', code: 1 };
  const claude = deepRuntime({}, exhausted);
  const r = await claude.rt.callTool('gemini_research', { prompt: 'a question', model: 'Claude Sonnet 5.5 (High)' });
  assert.equal(r.isError, true);
  assert.ok(r.text.includes(CLAUDE_EXHAUSTED), r.text);
  assert.equal(claude.calls.spawn.length, 1);
  const flash = deepRuntime({}, exhausted);
  const f = await flash.rt.callTool('gemini_research', { prompt: 'a question', model: 'Gemini 3.8 Flash (High)' });
  assert.equal(f.isError, true);
  assert.ok(f.text.includes(GEMINI_EXHAUSTED), f.text);
  assert.ok(!f.text.includes('Claude'), f.text);
  assert.equal(flash.calls.spawn.length, 1);
});

// --- Round 2: texts (R2, R3, R4, R5, R6, R8) ---

test('round 2 texts: the verification sentence, the picker default, the upgrade note, the routing row', () => {
  const byId = Object.fromEntries(GEMINI_MODELS.map((m) => [m.id, m]));
  assert.ok(byId['Claude Opus 5.5 (High)'].useFor.endsWith('Opus 5.5 (Medium) and Sonnet 5.5 (High) ran headless via agy 1.2.14 on 2026-10-03; the other two ids are listed by agy models and share the id form, and did not run — the bucket answered RESOURCE_EXHAUSTED to both that afternoon, after three calls, which is the point.'));
  assert.ok(!byId['Claude Opus 5.5 (High)'].useFor.includes('Verified headless'));
  assert.ok(byId['Claude Opus 5.5 (High)'].avoid.includes('every deep-research stage (gemini_deep_research refuses Claude ids) and never as the configured default (gemini_research and gemini_image refuse it): the Antigravity'));
  assert.ok(byId['Claude Opus 5.5 (Medium)'].useFor.startsWith("Antigravity's picker default for Claude (2026-10-03): an Opus-class second opinion where High's latency is not worth it — "));
  assert.ok(GUIDE.includes('never a deep-research stage (gemini_deep_research refuses Claude ids), never configured as gemini.model (gemini_research and gemini_image refuse a Claude default); the same'));
  assert.ok(!read('units/gemini/models.js').includes('(non-Claude)'));
  const cl = read('CHANGELOG.md');
  const entry = cl.slice(cl.indexOf('## 1.6.2'), cl.indexOf('## 1.6.1'));
  assert.equal(entry.split('\n').filter((l) => l.startsWith('- ')).length, 4);
  assert.ok(!entry.includes('Both verified headless'));
  assert.ok(entry.includes("the other two were accepted by `agy models` and did not run — the Claude bucket answered `RESOURCE_EXHAUSTED` to both the same afternoon, after three calls, which is the quota rule in one line."));
  assert.ok(entry.includes('`gemini_research` and `gemini_image` refuse a Claude id that arrives only from the configured `gemini.model`, naming the per-call alternative: a Claude call is named where it is spent.'));
  assert.ok(entry.includes('- **Upgrading from 1.6.1 with `gemini.model` pinned to `Claude Opus 4.6 (Thinking)`:**'));
  const orch = read('docs/ORCHESTRATION.md');
  assert.ok(orch.includes("| An independent Claude read on Antigravity's quota | Gemini `gemini_research` with `Claude Opus 5.5 (High)` or `Claude Sonnet 5.5 (High)` named in the call | One named call per question; never deep research, never the configured default — the Claude bucket is small |"));
  assert.ok(orch.indexOf('| Multi-source deep research |') < orch.indexOf("| An independent Claude read on Antigravity's quota |"));
});

// --- Round 3: gemini_image refuses a configured Claude default too (R9–R12) ---

test('gemini_image refuses a Claude id that arrives only from the configured gemini.model: no temp dir, no spawn', async () => {
  const { rt, calls } = deepRuntime({ model: 'Claude Sonnet 5.5 (High)' });
  const r = await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(r.isError, true);
  assert.equal(r.text, DEFAULT_REFUSAL('Claude Sonnet 5.5 (High)'));
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.usedModel.length, 0);
  // gemini_image logs its temp cwd the moment it makes it: no such line, no directory.
  assert.ok(!calls.log.some((m) => /temp cwd=/.test(m)), calls.log.join('\n'));
});

test('gemini_image with a configured Claude default and a Flash id named spawns on the Flash id', async () => {
  const { rt, calls } = deepRuntime({ model: 'Claude Sonnet 5.5 (High)' });
  await rt.callTool('gemini_image', { prompt: 'a cat', model: 'Gemini 3.8 Flash (High)' });
  assert.equal(calls.spawn.length >= 1, true);
  assert.equal(modelArg(calls.spawn[0]), 'Gemini 3.8 Flash (High)');
});

test('gemini_image with a Claude id named in the call spawns on that id (one image call is one call)', async () => {
  const { rt, calls } = deepRuntime({});
  await rt.callTool('gemini_image', { prompt: 'a cat', model: 'Claude Opus 5.5 (Medium)' });
  assert.equal(calls.spawn.length >= 1, true);
  assert.equal(modelArg(calls.spawn[0]), 'Claude Opus 5.5 (Medium)');
});

test('the served model schema of gemini_research, gemini_image and gemini_deep_research names the configured-Claude refusal', () => {
  const { rt } = deepRuntime({});
  for (const name of ['gemini_research', 'gemini_image', 'gemini_deep_research']) {
    const tool = rt.tools.find((t) => t.name === name);
    assert.ok(tool.inputSchema.properties.model.description.includes('(`gemini.model` in the fleet config, else the tool\'s own default: agy\'s for gemini_research and gemini_image, the Flash stages for gemini_deep_research — a configured Claude id is refused here; Claude is named per call, where the tool takes it). '), name);
  }
});

test('round 3 texts: the changelog alternative and the ORCHESTRATION bullet name gemini_image', () => {
  const cl = read('CHANGELOG.md');
  const entry = cl.slice(cl.indexOf('## 1.6.2'), cl.indexOf('## 1.6.1'));
  assert.ok(entry.includes('(`gemini_research` for one question, or a Flash id — omitting `model` helps only while no Claude id is the configured default)'));
  assert.ok(!entry.includes('or no `model` for the Flash stages'));
  assert.ok(read('docs/ORCHESTRATION.md').includes('and `gemini_deep_research` refuses them (about five runs per call); `gemini_research` and `gemini_image` refuse a Claude id that is only the configured `gemini.model`. The refusals see only ids the fleet names: keep agy\'s own default model a Gemini one.'));
});
