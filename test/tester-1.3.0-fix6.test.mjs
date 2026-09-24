/**
 * omelette-fleet :: test/tester-1.3.0-fix6.test.mjs
 * Independent coverage for Task 6 of docs/superpowers/plans/2026-09-24-1.3.0-P0-fixes.md
 * (S18 — Google Cloud credentials / Vertex switch scrubbed from the gemini
 * child env; S19 — an accept-edits gemini_research run is never re-issued).
 * Written from the plan and the diff, without importing anything from
 * test/gemini.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import { buildChildEnv } from '../core/spawn.mjs';

/** A finished-run shape in exactly the form core/spawn.mjs resolves one. */
const spawnRes = (over) => Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, killed: false, capped: false, ...over });

/** A runtime whose spawn is answered in-process by `stub`, exactly as the unit's `ctx.spawn` would resolve. */
const deepRt = (env, stub) => createUnitRuntime(
  { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub }) } : t)) },
  { env },
);

// --- S18: GOOGLE_* passthrough vs. the billing scrub --------------------------

test('S18: GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION pass, GOOGLE_CREDENTIALS/GOOGLE_APPLICATION_CREDENTIALS/GOOGLE_GENAI_USE_VERTEXAI never reach the child, alongside a decoy legitimate var and a decoy unlisted GOOGLE_* var', () => {
  const parent = {
    PATH: '/usr/bin', HOME: '/nonexistent',
    GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_CLOUD_LOCATION: 'us-central1',
    GOOGLE_CREDENTIALS: 'SYNTHETIC_SA_SECRET',
    GOOGLE_APPLICATION_CREDENTIALS: '/fake/sa.json',
    GOOGLE_GENAI_USE_VERTEXAI: 'true',
    GOOGLE_SOMETHING_ELSE: 'decoy-unlisted-google-var',
  };
  const child = buildChildEnv({ env: parent, passthrough: unit.envPassthrough, scrub: unit.billingRiskEnv });

  // The three credential/switch vars from S18 are gone.
  assert.equal(child.GOOGLE_CREDENTIALS, undefined);
  assert.equal(child.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(child.GOOGLE_GENAI_USE_VERTEXAI, undefined);
  // agy still gets what it needs for project + region.
  assert.equal(child.GOOGLE_CLOUD_PROJECT, 'p');
  assert.equal(child.GOOGLE_CLOUD_LOCATION, 'us-central1');
  // CURRENT BEHAVIOUR (documented in the adapter's BILLING_RISK_ENV comment:
  // "a denylist under a wildcard is never complete"): an unnamed GOOGLE_* var
  // still passes through the wildcard untouched — the fix scrubs the three
  // named vars, not the whole namespace. Asserting the actual behaviour here;
  // see OPEN QUESTIONS on whether the spec would want this narrower.
  assert.equal(child.GOOGLE_SOMETHING_ELSE, 'decoy-unlisted-google-var');
});

test('S18: the operator escape hatch naming GOOGLE_CREDENTIALS explicitly does not re-admit it — the scrub runs after OMELETTE_ENV_PASSTHROUGH too', () => {
  const parent = {
    PATH: '/usr/bin',
    GOOGLE_CREDENTIALS: 'SYNTHETIC_SA_SECRET',
    GOOGLE_APPLICATION_CREDENTIALS: '/fake/sa.json',
    OMELETTE_ENV_PASSTHROUGH: 'GOOGLE_CREDENTIALS,GOOGLE_APPLICATION_CREDENTIALS',
  };
  const child = buildChildEnv({ env: parent, passthrough: unit.envPassthrough, scrub: unit.billingRiskEnv });
  // ACTUAL behaviour: still scrubbed. This is what the spec wants — S18's
  // "how to confirm" and the fix's own comment ("naming a credential there
  // does not re-admit it, exactly as it does not re-admit an API key")
  // describe exactly this case.
  assert.equal(child.GOOGLE_CREDENTIALS, undefined);
  assert.equal(child.GOOGLE_APPLICATION_CREDENTIALS, undefined);
});

test('S18: the other billing-risk API keys are still scrubbed alongside the new three (no regression)', () => {
  const parent = {
    PATH: '/usr/bin',
    GEMINI_API_KEY: 'k2', GOOGLE_API_KEY: 'k1', GOOGLE_GENERATIVE_AI_API_KEY: 'k3',
    ANTHROPIC_API_KEY: 'a1', ANTHROPIC_AUTH_TOKEN: 'a2',
    GH_TOKEN: 'gh',
  };
  const child = buildChildEnv({ env: parent, passthrough: unit.envPassthrough, scrub: unit.billingRiskEnv });
  assert.equal(child.GEMINI_API_KEY, undefined);
  assert.equal(child.GOOGLE_API_KEY, undefined);
  assert.equal(child.GOOGLE_GENERATIVE_AI_API_KEY, undefined);
  assert.equal(child.ANTHROPIC_API_KEY, undefined);
  assert.equal(child.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(child.GH_TOKEN, undefined); // not in envPassthrough at all
  assert.deepEqual(unit.billingRiskEnv, [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENERATIVE_AI_API_KEY',
  ]);
});

// --- S19: an accept-edits gemini_research run is never re-issued --------------

test('S19: gemini_research under accept-edits (workspace-write) — an empty first result spawns exactly once and is reported as empty, not retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-fix6-accept-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { mode: 'workspace-write' } } }));
  const calls = [];
  const stub = (o) => { calls.push(o.args); return spawnRes({ stdout: '' }); };

  const rt = deepRt({ ...process.env, OMELETTE_HOME: dir, OMELETTE_ALLOW_WRITE: 'gemini' }, stub);
  const r = await rt.callTool('gemini_research', { prompt: 'q' });

  assert.equal(calls.length, 1, 'an accept-edits run must not be re-issued on empty output');
  assert.ok(calls[0].includes('accept-edits'), calls[0].join(' '));
  assert.equal(r.text, '(empty response from Gemini)');
  assert.ok(!r.isError, r.text);
});

test('S19: gemini_research read-only — an empty first result still gets its one bounded retry (unchanged)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-fix6-readonly-'));
  const calls = [];
  const stub = (o) => { calls.push(o.args); return spawnRes({ stdout: '' }); };

  // No mode configured, no write gate open: read-only.
  const rt = deepRt({ ...process.env, OMELETTE_HOME: dir, OMELETTE_ALLOW_WRITE: '', ORION_ALLOW_GEMINI_MUTATE: '' }, stub);
  const r = await rt.callTool('gemini_research', { prompt: 'q' });

  assert.equal(calls.length, 2, 'a read-only run keeps its one bounded retry on empty output');
  assert.ok(!calls[0].includes('accept-edits'), calls[0].join(' '));
  assert.ok(!calls[1].includes('accept-edits'), calls[1].join(' '));
  assert.equal(r.text, '(empty response from Gemini)');
});

test('S19: gemini_research read-only — a deterministic failure (hard-killed) is still never retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-fix6-deterministic-'));
  const calls = [];
  const stub = (o) => { calls.push(o.args); return spawnRes({ stdout: '', killed: true }); };

  const rt = deepRt({ ...process.env, OMELETTE_HOME: dir, OMELETTE_ALLOW_WRITE: '', ORION_ALLOW_GEMINI_MUTATE: '' }, stub);
  const r = await rt.callTool('gemini_research', { prompt: 'q' });

  assert.equal(calls.length, 1, 'a deterministic failure (hard-killed) must not be retried, in read-only mode either');
  assert.equal(r.isError, true);
  assert.match(r.text, /hard-killed/);
});
