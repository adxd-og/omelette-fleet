/**
 * omelette-fleet :: test/billing-scrub-1.7.2.test.mjs
 * 1.7.2 T4: the billing scrub is fleet-wide. OMELETTE_ENV_PASSTHROUGH applies
 * to every unit, so a `CODEX_*` pattern meant for Codex used to hand
 * CODEX_API_KEY to Grok and Gemini, whose own scrub lists do not name it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_ENV, VENDOR_CREDENTIALS, buildChildEnv } from '../core/spawn.mjs';
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

// A vendor's own credential is on its adapter's passthrough, so it is on no scrub
// list: OMELETTE_ENV_PASSTHROUGH (fleet-wide) used to hand it to the other units.
test('buildChildEnv: a unit keeps its own vendor\'s credential and loses every other vendor\'s, whatever OMELETTE_ENV_PASSTHROUGH admits', () => {
  for (const admits of ['CODEX_*,AGY_*,GROK_*', VENDOR_CREDENTIALS.join(',')]) {
    const env = { PATH: '/usr/bin', CODEX_TIMEOUT_S: '30', OMELETTE_ENV_PASSTHROUGH: `${admits},CODEX_TIMEOUT_S` };
    for (const name of VENDOR_CREDENTIALS) env[name] = `secret-${name}`;
    for (const unit of [codex, gemini, grok]) {
      const out = buildChildEnv({ env, passthrough: unit.envPassthrough });
      for (const name of VENDOR_CREDENTIALS) {
        const own = unit.envPassthrough.includes(name);
        assert.equal(out[name], own ? env[name] : undefined, `${unit.name} (${admits}): ${name} ${own ? 'kept' : 'scrubbed'}`);
      }
      assert.equal(out.CODEX_TIMEOUT_S, '30', `${unit.name}: the operator's passthrough is live, so the absence above is the scrub`);
    }
    assert.equal(buildChildEnv({ env, passthrough: codex.envPassthrough }).CODEX_ACCESS_TOKEN, 'secret-CODEX_ACCESS_TOKEN');
    for (const unit of [gemini, grok]) assert.equal(buildChildEnv({ env, passthrough: unit.envPassthrough }).CODEX_ACCESS_TOKEN, undefined, unit.name);
  }
});

// Passthrough names that look like a credential and are not one, each with why.
const NOT_CREDENTIALS = {
  // grok 1.0.41 26-config-reference: lifetime metadata for a helper's bare token, a number of seconds, not the token
  GROK_AUTH_TOKEN_TTL: 'grok',
};

test('VENDOR_CREDENTIALS holds every credential-looking name on the three adapters\' passthrough lists — a token added to an adapter alone fails here', () => {
  const looksLikeCredential = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/;
  for (const unit of [codex, gemini, grok]) {
    const missing = unit.envPassthrough.filter((name) => looksLikeCredential.test(name)
      && !VENDOR_CREDENTIALS.includes(name) && NOT_CREDENTIALS[name] !== unit.name);
    assert.deepEqual(missing, [], `${unit.name}: credential-looking passthrough names missing from VENDOR_CREDENTIALS`);
  }
});
