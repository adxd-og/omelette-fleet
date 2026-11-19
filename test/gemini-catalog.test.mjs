// 1.11.0 (spec docs/superpowers/specs/2026-11-13-gemini-hydrogen-design.md,
// "Catalog" and "Tests"): Gemini 4 Hydrogen replaces Gemini 3.8 Flash in the agy
// catalog, after Gemini 4 Argon replaced Gemini 3.1 Pro in 1.7.1.
// 1.12.0 (spec docs/superpowers/specs/2026-11-19-gemini-neon-design.md, "Catalog"
// and "Tests"): Gemini 4 Neon enters at four levels; Argon and Hydrogen (XHigh)
// leave. These tests pin what the catalog does, not how it reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEMINI_MODELS, ALLOWLIST, isAllowedModel } from '../units/gemini/models.js';
import unit, { stageModels, catalog } from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

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

test('every served tool that takes `model` offers the three Hydrogen and four Neon ids in its enum, and no retired id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-1110-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: {} } }));
  const rt = createUnitRuntime(unit, { env: { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath } });
  const takers = rt.tools.filter((t) => t.inputSchema && t.inputSchema.properties && t.inputSchema.properties.model);
  assert.deepEqual(takers.map((t) => t.name).sort(), ['gemini_deep_research', 'gemini_image', 'gemini_research']);
  for (const t of takers) {
    const served = t.inputSchema.properties.model.enum;
    for (const [id] of [...HYDROGEN, ...NEON]) assert.ok(served.includes(id), t.name + ' / ' + id);
    for (const gen of RETIRED) assert.ok(!served.some((id) => id.includes(gen)), t.name + ' / ' + gen);
  }
});
