// 1.7.1 (spec docs/superpowers/specs/2026-10-14-1.7.1-gemini-argon-design.md,
// "Catalog" and "Tests"): Gemini 4 Argon replaces Gemini 3.1 Pro in the agy
// catalog. These tests pin what the catalog does, not how it reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEMINI_MODELS, ALLOWLIST, isAllowedModel } from '../units/gemini/models.js';
import unit, { stageModels, catalog } from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const ARGON = [
  ['Gemini 4 Argon (Low)', 'Low'],
  ['Gemini 4 Argon (Medium)', 'Medium'],
  ['Gemini 4 Argon (High)', 'High'],
];

const ids = () => GEMINI_MODELS.map((m) => m.id);

test('the three Argon ids follow 3.8 Flash (High) in order, Gemini family, heavy, with their efforts; stageModels with no model still picks Flash', () => {
  const at = ids().indexOf('Gemini 3.8 Flash (High)');
  assert.ok(at >= 0);
  assert.deepEqual(ids().slice(at + 1, at + 4), ARGON.map(([id]) => id));
  for (const [id, effort] of ARGON) {
    const m = GEMINI_MODELS.find((x) => x.id === id);
    assert.equal(m.family, 'gemini', id);
    assert.equal(m.tier, 'heavy', id);
    assert.equal(m.effort, effort, id);
  }
  const s = stageModels(catalog);
  assert.deepEqual(s, { decompose: 'Gemini 3.8 Flash (Medium)', gather: 'Gemini 3.8 Flash (Medium)', synth: 'Gemini 3.8 Flash (High)' });
});

test('no 3.1 Pro id survives: the allowlist and modelEnum are exactly the catalog ids, and the old ids are refused', () => {
  assert.deepEqual(ALLOWLIST, ids());
  assert.deepEqual(catalog.modelEnum(), ids());
  for (const id of ids()) assert.ok(!id.includes('3.1 Pro'), id);
  for (const old of ['Gemini 3.1 Pro (Low)', 'Gemini 3.1 Pro (High)']) assert.equal(isAllowedModel(old), false, old);
});

test('every served tool that takes `model` offers the three Argon ids in its enum and no 3.1 Pro', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-171-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: {} } }));
  const rt = createUnitRuntime(unit, { env: { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath } });
  const takers = rt.tools.filter((t) => t.inputSchema && t.inputSchema.properties && t.inputSchema.properties.model);
  assert.deepEqual(takers.map((t) => t.name).sort(), ['gemini_deep_research', 'gemini_image', 'gemini_research']);
  for (const t of takers) {
    const served = t.inputSchema.properties.model.enum;
    for (const [id] of ARGON) assert.ok(served.includes(id), t.name + ' / ' + id);
    assert.ok(!served.some((id) => id.includes('3.1 Pro')), t.name);
  }
});
