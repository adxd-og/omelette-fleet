import { test } from 'node:test';
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

// The grok list written out name by name, in the adapter's order. The count
// alone would pass a swapped name (one dropped, another added): this test is
// the pin, so a change to units/grok/adapter.mjs PASSTHROUGH changes it too.
const GROK_PASSTHROUGH = [
  'GROK_HOME',
  'GROK_AUTH_PROVIDER_LABEL', 'GROK_AUTH_TOKEN_TTL', 'GROK_AUTH_EARLY_INVALIDATION_SECS', 'GROK_OAUTH2_REFERRER',
  'GROK_DISABLE_AUTOUPDATER', 'GROK_MINIMUM_VERSION', 'GROK_MAXIMUM_VERSION', 'GROK_REQUIRED_MINIMUM_VERSION', 'GROK_REQUIRED_MAXIMUM_VERSION', 'GROK_CRASH_HANDLER',
  'GROK_ASK_USER_QUESTION', 'GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED', 'GROK_ASK_USER_QUESTION_TIMEOUT_SECS',
  'GROK_COMPACTION_DETAIL', 'GROK_COMPACTION_MODE', 'GROK_COMPACTION_VERBATIM_INPUT', 'GROK_TWO_PASS_COMPACTION',
  'GROK_FEEDBACK_TRACE_CARD', 'GROK_TURN_SUMMARY', 'GROK_LONG_REASONING_REMINDER', 'GROK_MARKETPLACE_REQUIRE_SHA',
  'GROK_SUBAGENT_SAMPLING_LIMIT', 'GROK_MAX_PARALLEL_IMAGE_GEN_CALLS', 'GROK_MAX_PARALLEL_VIDEO_GEN_CALLS',
  'GROK_TERMINAL_THEME', 'GROK_TITLE_REFRESH', 'GROK_COLLAPSED_EDIT_BLOCKS', 'GROK_DISPLAY_REFRESH_AUTO_CADENCE', 'GROK_GROUP_TOOL_VERBS',
  'GROK_INVERT_SCROLL', 'GROK_MOUSE_REPORTING_TOGGLE', 'GROK_PROMPT_SUGGESTIONS', 'GROK_SCROLL_LINES', 'GROK_SCROLL_MODE', 'GROK_SCROLL_SPEED',
  'GROK_SHOW_THINKING_BLOCKS', 'GROK_THEME', 'LC_GROK_THEME', 'GROK_APPEARANCE', 'LC_GROK_APPEARANCE', 'COLORFGBG', 'NO_COLOR',
  'GROK_SCREEN_MODE_SWITCH', 'GROK_CLIPBOARD_NO_DATA_CONTROL', 'GROK_CLIPBOARD_NO_OSC52',
  'RUST_LOG', 'GROK_EXIT_TIMEOUT_SECS', 'GROK_SESSION_END_HOOKS_TIMEOUT_MS', 'GROK_MCP_STARTUP_TIMEOUT_SECS', 'MCP_TIMEOUT', 'GROK_MAX_WAIT_BLOCK_MS',
  'OTEL_EXPORTER_OTLP_TIMEOUT', 'OTEL_METRIC_EXPORT_INTERVAL', 'OTEL_BLRP_SCHEDULE_DELAY', 'OTEL_LOGS_EXPORT_INTERVAL',
  'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE', 'OTEL_METRICS_INCLUDE_VERSION',
];

test('every adapter declares exact names only, and the three lists are the inventory\'s', () => {
  const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const u of [grok, codex, gemini]) for (const n of u.envPassthrough) assert.match(n, NAME, `${u.name}: ${n}`);
  assert.equal(GROK_PASSTHROUGH.length, 58);
  assert.deepEqual(grok.envPassthrough, GROK_PASSTHROUGH);
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

test('billingRiskEnv is refused since 1.6.0 (the 1.5.0 alias is gone); riskEnv defaults to []', () => {
  assert.throws(() => defineUnit(spec({ billingRiskEnv: ['ACME_API_KEY'] })), /defineUnit\(acme\): billingRiskEnv was renamed riskEnv in 1\.5\.0/);
  assert.throws(() => defineUnit(spec({ riskEnv: ['A'], billingRiskEnv: ['B'] })), /billingRiskEnv was renamed riskEnv in 1\.5\.0/);
  assert.deepEqual(defineUnit(spec({})).riskEnv, []);
});
