// 1.11.0 (spec docs/superpowers/specs/2026-11-13-gemini-hydrogen-design.md,
// "Catalog" and "Tests"): Gemini 4 Hydrogen replaces Gemini 3.8 Flash in the agy
// catalog, after Gemini 4 Argon replaced Gemini 3.1 Pro in 1.7.1.
// 1.12.0 (spec docs/superpowers/specs/2026-11-19-gemini-neon-design.md, "Catalog"
// and "Tests"): Gemini 4 Neon enters at four levels; Argon and Hydrogen (XHigh)
// leave.
// 1.14.0 (spec docs/superpowers/specs/2026-11-26-gemini-carbon-design.md, "Part
// one — the catalog" and "Tests"): Gemini 4 Carbon enters at Medium and High, heavy,
// between Neon and Claude; Carbon (Low) stays out. These tests pin what the catalog
// does, not how it reads.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEMINI_MODELS, ALLOWLIST, isAllowedModel } from '../units/gemini/models.js';
import unit, { stageModels, catalog } from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const HYDROGEN = [
  ['Gemini 4 Hydrogen (Low)', 'Low', 'fast'],
  ['Gemini 4 Hydrogen (Medium)', 'Medium', 'balanced'],
  ['Gemini 4 Hydrogen (High)', 'High', 'balanced'],
];

const NEON = [
  ['Gemini 4 Neon (Low)', 'Low'],
  ['Gemini 4 Neon (Medium)', 'Medium'],
  ['Gemini 4 Neon (High)', 'High'],
  ['Gemini 4 Neon (XHigh)', 'XHigh'],
];

const CARBON = [
  ['Gemini 4 Carbon (Medium)', 'Medium'],
  ['Gemini 4 Carbon (High)', 'High'],
];

// agy lists it; the catalog does not admit it (decision 1 of the 1.14.0 spec).
const CARBON_LOW = 'Gemini 4 Carbon (Low)';

// What left the catalog: 3.1 Pro (1.7.1), 3.8 Flash (1.11.0), Argon and Hydrogen (XHigh) (1.12.0).
const RETIRED = ['3.8 Flash', '3.1 Pro', 'Argon', 'Hydrogen (XHigh)'];

const ids = () => GEMINI_MODELS.map((m) => m.id);

test('the three Hydrogen ids head the catalog in order, Gemini family, with their efforts and tiers', () => {
  assert.deepEqual(ids().slice(0, 3), HYDROGEN.map(([id]) => id));
  for (const [id, effort, tier] of HYDROGEN) {
    const m = GEMINI_MODELS.find((x) => x.id === id);
    assert.equal(m.family, 'gemini', id);
    assert.equal(m.effort, effort, id);
    assert.equal(m.tier, tier, id);
  }
});

test('the four Neon ids follow Hydrogen (High) in order, Gemini family, heavy, with their efforts', () => {
  const at = ids().indexOf('Gemini 4 Hydrogen (High)');
  assert.ok(at >= 0);
  assert.deepEqual(ids().slice(at + 1, at + 5), NEON.map(([id]) => id));
  for (const [id, effort] of NEON) {
    const m = GEMINI_MODELS.find((x) => x.id === id);
    assert.equal(m.family, 'gemini', id);
    assert.equal(m.tier, 'heavy', id);
    assert.equal(m.effort, effort, id);
  }
});

test('the two Carbon ids follow Gemini 4 Neon (XHigh) in order, Gemini family, heavy, with their efforts', () => {
  const at = ids().indexOf('Gemini 4 Neon (XHigh)');
  assert.ok(at >= 0);
  assert.deepEqual(ids().slice(at + 1, at + 3), CARBON.map(([id]) => id));
  for (const [id, effort] of CARBON) {
    const m = GEMINI_MODELS.find((x) => x.id === id);
    assert.equal(m.family, 'gemini', id);
    assert.equal(m.tier, 'heavy', id);
    assert.equal(m.effort, effort, id);
  }
});

test('Gemini 4 Carbon (Low) is not in ALLOWLIST or modelEnum, and every tool that takes `model` refuses it before any spawn', async () => {
  assert.equal(isAllowedModel(CARBON_LOW), false);
  assert.ok(!ALLOWLIST.includes(CARBON_LOW));
  assert.ok(!catalog.modelEnum().includes(CARBON_LOW));
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-1140-'));
  made.push(dir);
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const spawns = [];
  const stub = (o) => { spawns.push(o.args); return Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, killed: false, capped: false }); };
  const rt = createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub }) } : t)) },
    { env: { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath } },
  );
  for (const [tool, args] of [
    ['gemini_research', { prompt: 'hi' }],
    ['gemini_image', { prompt: 'a cat' }],
    ['gemini_deep_research', { question: 'why' }],
    ['gemini_test', { prompt: 'test it', cwd: dir, patch: join(dir, 'p.patch'), testCommand: ['node', '--test'] }],
  ]) {
    const r = await rt.callTool(tool, { ...args, model: CARBON_LOW });
    assert.equal(r.isError, true, tool);
    assert.ok(r.text.startsWith(`Error: unknown model "${CARBON_LOW}". Allowed: `), tool + ': ' + r.text);
  }
  assert.equal(spawns.length, 0);
});

test('stageModels with no model picks Hydrogen Medium for decompose and gather, Hydrogen High for the synthesis', () => {
  assert.deepEqual(stageModels(catalog), {
    decompose: 'Gemini 4 Hydrogen (Medium)',
    gather: 'Gemini 4 Hydrogen (Medium)',
    synth: 'Gemini 4 Hydrogen (High)',
  });
});

test('no 3.8 Flash, 3.1 Pro, Argon or Hydrogen (XHigh) id survives: the allowlist and modelEnum are exactly the catalog ids, and the old ids are refused', () => {
  assert.deepEqual(ALLOWLIST, ids());
  assert.deepEqual(catalog.modelEnum(), ids());
  for (const gen of RETIRED) {
    assert.ok(!ALLOWLIST.some((id) => id.includes(gen)), gen);
    assert.ok(!catalog.modelEnum().some((id) => id.includes(gen)), gen);
  }
  for (const old of [
    'Gemini 3.8 Flash (Low)', 'Gemini 3.8 Flash (Medium)', 'Gemini 3.8 Flash (High)', 'Gemini 3.1 Pro (Low)', 'Gemini 3.1 Pro (High)',
    'Gemini 4 Argon (Low)', 'Gemini 4 Argon (Medium)', 'Gemini 4 Argon (High)', 'Gemini 4 Hydrogen (XHigh)',
  ]) {
    assert.equal(isAllowedModel(old), false, old);
  }
});

test('every served tool that takes `model` offers the three Hydrogen, four Neon and two Carbon ids in its enum, and no retired id or Carbon (Low)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-1110-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: {} } }));
  const rt = createUnitRuntime(unit, { env: { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath } });
  const takers = rt.tools.filter((t) => t.inputSchema && t.inputSchema.properties && t.inputSchema.properties.model);
  assert.deepEqual(takers.map((t) => t.name).sort(), ['gemini_deep_research', 'gemini_image', 'gemini_research', 'gemini_test']);
  for (const t of takers) {
    const served = t.inputSchema.properties.model.enum;
    for (const [id] of [...HYDROGEN, ...NEON, ...CARBON]) assert.ok(served.includes(id), t.name + ' / ' + id);
    for (const gen of RETIRED) assert.ok(!served.some((id) => id.includes(gen)), t.name + ' / ' + gen);
    assert.ok(!served.includes(CARBON_LOW), t.name + ' / ' + CARBON_LOW);
  }
});
