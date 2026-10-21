/**
 * omelette-fleet :: test/billing-scrub-1.7.2.test.mjs
 * 1.7.2 T4: the billing scrub is fleet-wide. OMELETTE_ENV_PASSTHROUGH applies
 * to every unit, so a `CODEX_*` pattern meant for Codex used to hand
 * CODEX_API_KEY to Grok and Gemini, whose own scrub lists do not name it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_ENV, buildChildEnv } from '../core/spawn.mjs';
import grok from '../units/grok/adapter.mjs';
import codex from '../units/codex/adapter.mjs';
import gemini from '../units/gemini/adapter.mjs';

test('buildChildEnv: a passthrough pattern never admits another vendor\'s billing key, even with an empty scrub', () => {
  const out = buildChildEnv({
    env: {
      PATH: '/usr/bin',
      CODEX_API_KEY: 'sk-codex',
      GOOGLE_API_KEY: 'g-key',
      GROK_CODE_XAI_API_KEY: 'xai-key',
      CODEX_TIMEOUT_S: '30',
      OMELETTE_ENV_PASSTHROUGH: 'CODEX_*,GOOGLE_*,GROK_*',
    },
    scrub: [],
  });
  for (const name of ['CODEX_API_KEY', 'GOOGLE_API_KEY', 'GROK_CODE_XAI_API_KEY']) assert.equal(out[name], undefined, name);
  assert.equal(out.CODEX_TIMEOUT_S, '30', 'a harmless name the pattern admits still passes');
});

test('BILLING_ENV holds every adapter\'s riskEnv — a key added to an adapter alone fails here', () => {
  for (const unit of [codex, grok, gemini]) {
    const missing = unit.riskEnv.filter((name) => !BILLING_ENV.includes(name));
    assert.deepEqual(missing, [], `${unit.name}: riskEnv names missing from BILLING_ENV`);
  }
});
