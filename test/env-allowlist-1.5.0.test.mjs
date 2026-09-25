import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { buildChildEnv } from '../core/spawn.mjs';
import { defineUnit } from '../core/unit.mjs';
import grok from '../units/grok/adapter.mjs';
import codex from '../units/codex/adapter.mjs';
import gemini from '../units/gemini/adapter.mjs';

const childOf = (unit, parent) => buildChildEnv({ env: { PATH: '/usr/bin', HOME: '/h', ...parent }, passthrough: unit.envPassthrough, scrub: unit.riskEnv });

// One name per class from the 1.5.0 inventory: A passes, B passes, C is absent, D is absent.
const TABLE = [
  { unit: grok, A: 'GROK_HOME', B: 'GROK_THEME', C: ['GROK_CONFIG_PATH', 'GROK_MODELS_BASE_URL', 'GROK_CLI_CHAT_PROXY_BASE_URL'], D: ['XAI_API_KEY', 'GROK_CODE_XAI_API_KEY'] },
  { unit: codex, A: 'CODEX_HOME', B: 'RUST_LOG', C: ['CODEX_SQLITE_HOME', 'CODEX_CA_CERTIFICATE', 'CODEX_REFRESH_TOKEN_URL_OVERRIDE'], D: ['OPENAI_API_KEY', 'CODEX_API_KEY'] },
  { unit: gemini, A: 'AGY_ADC_AUTH', B: 'AGY_CLI_HIDE_LOGO', C: ['GOOGLE_GEMINI_BASE_URL', 'AGY_GATEWAY_URL'], D: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'] },
];

for (const row of TABLE) {
  test(`${row.unit.name}: the child env admits class A and B by name and holds no class C or D name`, () => {
    const parent = { [row.A]: 'a', [row.B]: 'b' };
    for (const n of [...row.C, ...row.D]) parent[n] = 'x';
    const child = childOf(row.unit, parent);
    assert.equal(child[row.A], 'a');
    assert.equal(child[row.B], 'b');
    for (const n of [...row.C, ...row.D]) assert.equal(child[n], undefined, n);
  });
}

test('every adapter declares exact names only, and the three lists are the inventory\'s', () => {
  const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const u of [grok, codex, gemini]) for (const n of u.envPassthrough) assert.match(n, NAME, `${u.name}: ${n}`);
  assert.equal(grok.envPassthrough.length, 58);
  assert.deepEqual(codex.envPassthrough, ['CODEX_HOME', 'CODEX_ACCESS_TOKEN', 'RUST_LOG', 'CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE']);
  assert.deepEqual(gemini.envPassthrough, ['AGY_ADC_AUTH', 'AGY_CLI_DISABLE_AUTO_UPDATE', 'AGY_CLI_HIDE_LOGO', 'AGY_CLI_HIDE_ACCOUNT_INFO', 'AGY_CLI_DISABLE_LATEX', 'AGY_CLI_DISABLE_ESCAPE_SEQUENCE_OPTIMIZATIONS', 'AGY_CLI_CMD_OUTPUT_PERCENTAGE']);
  assert.ok(grok.riskEnv.includes('GROK_CODE_XAI_API_KEY'));
  assert.ok(grok.riskEnv.includes('XAI_API_KEY'));
});

test('OMELETTE_ENV_PASSTHROUGH still admits a pattern, for every unit', () => {
  for (const u of [grok, codex, gemini]) {
    const child = buildChildEnv({ env: { PATH: '/usr/bin', OMELETTE_ENV_PASSTHROUGH: 'GROK_*', GROK_MODELS_BASE_URL: 'u' }, passthrough: u.envPassthrough, scrub: u.riskEnv });
    assert.equal(child.GROK_MODELS_BASE_URL, 'u', u.name);
  }
});

const spec = (extra) => ({ name: 'acme', bin: 'acme', catalog: { isAllowedModel: () => true }, tools: [{ name: 'acme_models', description: 'd', inputSchema: {}, kind: 'catalog' }], ...extra });

test('defineUnit refuses a pattern in envPassthrough', () => {
  assert.throws(() => defineUnit(spec({ envPassthrough: ['ACME_*'] })),
    /defineUnit\(acme\): envPassthrough holds a pattern "ACME_\*" — exact names only; a pattern belongs in OMELETTE_ENV_PASSTHROUGH/);
  assert.throws(() => defineUnit(spec({ envPassthrough: ['ACME HOME'] })), /holds a pattern "ACME HOME"/);
  assert.deepEqual(defineUnit(spec({ envPassthrough: ['ACME_HOME'] })).envPassthrough, ['ACME_HOME']);
});

test('billingRiskEnv is an alias for riskEnv with one warning; both at once is refused', () => {
  const warn = mock.method(console, 'error', () => {});
  try {
    const u = defineUnit(spec({ billingRiskEnv: ['ACME_API_KEY'] }));
    assert.deepEqual(u.riskEnv, ['ACME_API_KEY']);
    assert.equal(u.billingRiskEnv, undefined);
    assert.equal(warn.mock.calls.length, 1);
    assert.match(warn.mock.calls[0].arguments[0], /defineUnit\(acme\): billingRiskEnv is deprecated since 1\.5\.0 — rename it riskEnv \(the alias goes in 1\.6\.0\)/);
    assert.throws(() => defineUnit(spec({ riskEnv: ['A'], billingRiskEnv: ['B'] })), /both riskEnv and billingRiskEnv — keep riskEnv/);
    assert.deepEqual(defineUnit(spec({})).riskEnv, []);
  } finally { warn.mock.restore(); }
});
