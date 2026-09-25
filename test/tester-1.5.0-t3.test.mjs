/**
 * omelette-fleet :: test/tester-1.5.0-t3.test.mjs
 * Independent tester coverage for 1.5.0 Task T3 (explicit environment
 * allowlists), against docs/superpowers/specs/2026-09-25-1.5.0-process-layer-
 * design.md "P3 — explicit environment allowlists" and the plan's Task T3.
 *
 * The coder's own test/env-allowlist-1.5.0.test.mjs already covers: the
 * table-driven per-unit A/B/C/D class test, the exact-list/no-duplicate-
 * pattern assertion (with the corrected 58 grok names), OMELETTE_ENV_PASSTHROUGH
 * still admitting a pattern, defineUnit's pattern refusal, and the
 * billingRiskEnv alias/warning/both-keys-throws behaviour. This file targets
 * what is uncovered or only implicitly covered:
 *   - the exact names called out in the tester brief (GROK_MODELS_BASE_URL,
 *     GROK_CODE_XAI_API_KEY, XAI_API_KEY, AGY_ADC_AUTH,
 *     GOOGLE_APPLICATION_CREDENTIALS, CODEX_HOME, CODEX_API_KEY);
 *   - a REAL spawn of a fake CLI (not just buildChildEnv in isolation) proving
 *     createUnitRuntime wires unit.envPassthrough/unit.riskEnv end to end;
 *   - the scrub beating a matching OMELETTE_ENV_PASSTHROUGH pattern
 *     (XAI_* does not re-admit XAI_API_KEY);
 *   - no-duplicate-names and "returned unit carries no billingRiskEnv key" in
 *     one place, which the coder's file does not assert directly;
 *   - doctor --probe-sandbox using the SAME env-building path (unit.envPassthrough
 *     / unit.riskEnv) as an ordinary call, through a real CLI invocation;
 *   - the SECURITY.md prose the plan specifies word for word (step 2 naming no
 *     PREFIX_* for a unit and defineUnit's refusal, step 4 saying riskEnv, and
 *     the "Configuration the fleet did not choose" paragraph's new sentences).
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChildEnv } from '../core/spawn.mjs';
import { defineUnit } from '../core/unit.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import grok from '../units/grok/adapter.mjs';
import codex from '../units/codex/adapter.mjs';
import gemini from '../units/gemini/adapter.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

// ─── 1. the exact names named in the tester brief ────────────────────────────

test('grok: GROK_MODELS_BASE_URL, GROK_CODE_XAI_API_KEY and XAI_API_KEY never reach the child; GROK_HOME does', () => {
  const child = buildChildEnv({
    env: {
      PATH: '/usr/bin', HOME: '/h',
      GROK_HOME: '/gh', GROK_MODELS_BASE_URL: 'https://evil.example/v1',
      GROK_CODE_XAI_API_KEY: 'sk-alias', XAI_API_KEY: 'sk-real',
    },
    passthrough: grok.envPassthrough, scrub: grok.riskEnv,
  });
  assert.equal(child.GROK_HOME, '/gh');
  assert.equal(child.GROK_MODELS_BASE_URL, undefined);
  assert.equal(child.GROK_CODE_XAI_API_KEY, undefined);
  assert.equal(child.XAI_API_KEY, undefined);
});

test('gemini: AGY_ADC_AUTH passes, GOOGLE_APPLICATION_CREDENTIALS never reaches the child', () => {
  const child = buildChildEnv({
    env: { PATH: '/usr/bin', HOME: '/h', AGY_ADC_AUTH: '1', GOOGLE_APPLICATION_CREDENTIALS: '/fake/sa.json' },
    passthrough: gemini.envPassthrough, scrub: gemini.riskEnv,
  });
  assert.equal(child.AGY_ADC_AUTH, '1');
  assert.equal(child.GOOGLE_APPLICATION_CREDENTIALS, undefined);
});

test('codex: CODEX_HOME passes, CODEX_API_KEY never reaches the child', () => {
  const child = buildChildEnv({
    env: { PATH: '/usr/bin', HOME: '/h', CODEX_HOME: '/ch', CODEX_API_KEY: 'sk-leak' },
    passthrough: codex.envPassthrough, scrub: codex.riskEnv,
  });
  assert.equal(child.CODEX_HOME, '/ch');
  assert.equal(child.CODEX_API_KEY, undefined);
});

// ─── 2. a REAL spawn of a fake CLI, end to end through createUnitRuntime ─────

test('grok end to end: a real spawned fake CLI sees only the exact-list passthrough and the scrub still wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t3-grok-'));
  const fake = join(dir, 'fake-grok.cjs');
  const REPORT = 'JSON.stringify(process.env)';
  writeFileSync(
    fake,
    `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: ${REPORT}, stop_reason: "end_turn" }) + "\\n");`,
  );
  const env = {
    ...process.env,
    OMELETTE_HOME: dir,
    GROK_BIN: process.execPath,
    GROK_HOME: join(dir, 'grok-home'),
    GROK_THEME: 'dark',
    GROK_MODELS_BASE_URL: 'https://evil.example/v1', // class C: must not reach the child
    GROK_CONFIG_PATH: '/etc/evil', // class C: must not reach the child
    XAI_API_KEY: 'sk-should-be-scrubbed',
    GROK_CODE_XAI_API_KEY: 'sk-alias-should-be-scrubbed',
    GH_TOKEN: 'leak', // not on any list at all
  };
  const rt = createUnitRuntime(
    { ...grok, tools: grok.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
  const r = await rt.callTool('grok_research', { prompt: 'who am i' });
  assert.equal(r.isError, undefined, r.text);
  const seen = JSON.parse(r.text);
  assert.equal(seen.GROK_HOME, join(dir, 'grok-home'));
  assert.equal(seen.GROK_THEME, 'dark');
  assert.equal(seen.GROK_MODELS_BASE_URL, undefined);
  assert.equal(seen.GROK_CONFIG_PATH, undefined);
  assert.equal(seen.XAI_API_KEY, undefined);
  assert.equal(seen.GROK_CODE_XAI_API_KEY, undefined);
  assert.equal(seen.GH_TOKEN, undefined);
});

// ─── 3. OMELETTE_ENV_PASSTHROUGH admits a PREFIX_* pattern; the scrub still wins ─

test('OMELETTE_ENV_PASSTHROUGH=PREFIX_* admits a name for every unit, and the scrub beats a matching pattern', () => {
  for (const u of [grok, codex, gemini]) {
    const child = buildChildEnv({
      env: { PATH: '/usr/bin', OMELETTE_ENV_PASSTHROUGH: 'ACME_*', ACME_EXTRA_KNOB: 'v' },
      passthrough: u.envPassthrough, scrub: u.riskEnv,
    });
    assert.equal(child.ACME_EXTRA_KNOB, 'v', u.name);
  }
  // The specific case named in the brief: XAI_* in the escape hatch does not
  // re-admit XAI_API_KEY, because the scrub runs after every passthrough path.
  const child = buildChildEnv({
    env: { PATH: '/usr/bin', OMELETTE_ENV_PASSTHROUGH: 'XAI_*', XAI_API_KEY: 'sk-leak', XAI_SOMETHING_ELSE: 'v' },
    passthrough: grok.envPassthrough, scrub: grok.riskEnv,
  });
  assert.equal(child.XAI_API_KEY, undefined);
  assert.equal(child.XAI_SOMETHING_ELSE, 'v');
});

// ─── 4. defineUnit: pattern / non-array / riskEnv-alias edge cases ───────────

const baseSpec = (extra) => ({
  name: 'acme', bin: 'acme', catalog: { isAllowedModel: () => true },
  tools: [{ name: 'acme_models', description: 'd', inputSchema: {}, kind: 'catalog' }],
  ...extra,
});

test('defineUnit: envPassthrough must be an array', () => {
  assert.throws(
    () => defineUnit(baseSpec({ envPassthrough: 'ACME_HOME' })),
    /defineUnit\(acme\): envPassthrough must be an array/,
  );
});

test('defineUnit: neither riskEnv nor billingRiskEnv given yields riskEnv: []', () => {
  const u = defineUnit(baseSpec({}));
  assert.deepEqual(u.riskEnv, []);
  assert.equal('billingRiskEnv' in u, false);
});

test('defineUnit: riskEnv alone is used as is, with no warning and no billingRiskEnv key on the result', () => {
  const warn = mock.method(console, 'error', () => {});
  try {
    const u = defineUnit(baseSpec({ riskEnv: ['ACME_API_KEY'] }));
    assert.deepEqual(u.riskEnv, ['ACME_API_KEY']);
    assert.equal(warn.mock.calls.length, 0);
    assert.equal('billingRiskEnv' in u, false);
  } finally { warn.mock.restore(); }
});

test('defineUnit: billingRiskEnv alone logs exactly one console.error and the returned unit carries no billingRiskEnv key', () => {
  const warn = mock.method(console, 'error', () => {});
  try {
    const u = defineUnit(baseSpec({ billingRiskEnv: ['ACME_API_KEY', 'ACME_OTHER'] }));
    assert.deepEqual(u.riskEnv, ['ACME_API_KEY', 'ACME_OTHER']);
    assert.equal(warn.mock.calls.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(u, 'billingRiskEnv'), false);
  } finally { warn.mock.restore(); }
});

test('defineUnit: both riskEnv and billingRiskEnv throws, naming both keys', () => {
  assert.throws(
    () => defineUnit(baseSpec({ riskEnv: ['A'], billingRiskEnv: ['B'] })),
    /defineUnit\(acme\): both riskEnv and billingRiskEnv — keep riskEnv/,
  );
});

// ─── 5. the three adapters' lists: exact names, no duplicates, spec-equal ────

test('grok/codex/gemini envPassthrough: no duplicate names, and codex/gemini equal the spec\'s lists exactly', () => {
  for (const u of [grok, codex, gemini]) {
    const set = new Set(u.envPassthrough);
    assert.equal(set.size, u.envPassthrough.length, `${u.name}: duplicate name in envPassthrough`);
  }
  assert.deepEqual(codex.envPassthrough, ['CODEX_HOME', 'CODEX_ACCESS_TOKEN', 'RUST_LOG', 'CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE']);
  assert.deepEqual(gemini.envPassthrough, [
    'AGY_ADC_AUTH',
    'AGY_CLI_DISABLE_AUTO_UPDATE', 'AGY_CLI_HIDE_LOGO', 'AGY_CLI_HIDE_ACCOUNT_INFO',
    'AGY_CLI_DISABLE_LATEX', 'AGY_CLI_DISABLE_ESCAPE_SEQUENCE_OPTIMIZATIONS', 'AGY_CLI_CMD_OUTPUT_PERCENTAGE',
  ]);
  assert.equal(grok.envPassthrough.length, 58, 'the session\'s correction to the plan\'s prose: 58, not 57');
  assert.ok(grok.envPassthrough.includes('GROK_HOME'));
});

// ─── 6. doctor --probe-sandbox uses the SAME env-building path as an ordinary call ─

const HOMES = [];
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t3-doctor-'));
  HOMES.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of HOMES) {
    try { chmodSync(dir, 0o700); } catch { /* already gone or not ours */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function cli(args, { dir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function registerOurs(dir, units) {
  const mcpServers = {};
  for (const u of units) mcpServers[`omelette-${u}`] = { command: 'node', args: [join(ROOT, 'servers', `${u}.mjs`)] };
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers }));
}

/** A fake CLI that records the two named env vars it saw, then answers 'refused' without writing anything (verdict: held). */
function probeEnvFake(dir, { recordTo, aName, cName }) {
  const path = join(dir, 'probe-env-cli');
  const lines = [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    "if (a[0] === 'models') { console.log('model-a'); process.exit(0); }",
    "if (a[0] === 'login' && a[1] === 'status') { process.stderr.write('Logged in\\n'); process.exit(0); }",
    `fs.appendFileSync(${JSON.stringify(recordTo)}, JSON.stringify({ a: process.env[${JSON.stringify(aName)}] ?? null, c: process.env[${JSON.stringify(cName)}] ?? null }) + '\\n');`,
    "console.log('refused');",
    'process.exit(0);',
  ];
  writeFileSync(path, lines.join('\n'));
  chmodSync(path, 0o755);
  return path;
}

test('doctor --probe-sandbox: the probe env admits GROK_HOME (listed) and withholds GROK_MODELS_BASE_URL (unlisted), same as an ordinary call', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const marker = join(dir, 'env-seen.log');
  const fake = probeEnvFake(dir, { recordTo: marker, aName: 'GROK_HOME', cName: 'GROK_MODELS_BASE_URL' });
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], {
    dir,
    env: {
      AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone,
      GROK_HOME: join(dir, 'grok-home'), GROK_MODELS_BASE_URL: 'https://evil.example/v1',
    },
  });
  assert.match(r.out, /sandbox\s+held/, r.out + r.err);
  const seen = readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(seen.length, 1, JSON.stringify(seen));
  assert.equal(seen[0].a, join(dir, 'grok-home'));
  assert.equal(seen[0].c, null);
});

// ─── 7. SECURITY.md prose, word for word against the plan ────────────────────

const readDoc = (p) => readFileSync(join(ROOT, p), 'utf8');

test('SECURITY step 2: no PREFIX_* pattern is named for a unit, and defineUnit\'s refusal is stated', () => {
  const md = readDoc('docs/SECURITY.md');
  const from = md.indexOf('2. **The unit\'s `envPassthrough`**');
  const to = md.indexOf('\n3. **`OMELETTE_ENV_PASSTHROUGH`**', from);
  assert.ok(from !== -1 && to !== -1, 'step 2 / step 3 headings not found');
  const step2 = md.slice(from, to);
  assert.doesNotMatch(step2, /`[A-Z]+_\*`/, 'step 2 must name no PREFIX_* pattern for a unit');
  assert.match(step2, /`defineUnit` refuses one/);
  assert.match(step2, /codex `CODEX_HOME`, `CODEX_ACCESS_TOKEN`, `RUST_LOG`, `CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE`/);
  assert.match(step2, /grok 58 names in `units\/grok\/adapter\.mjs`/);
});

test('SECURITY step 4: the billing scrub is named riskEnv, with billingRiskEnv called out as the one-release alias', () => {
  const md = readDoc('docs/SECURITY.md');
  const from = md.indexOf('4. **The billing scrub**');
  assert.ok(from !== -1, 'step 4 heading not found');
  const step4 = md.slice(from, from + 400);
  assert.match(step4, /the unit's `riskEnv` names \(`billingRiskEnv` is read as an alias for one release\)/);
});

test('SECURITY: "Configuration the fleet did not choose" names ~/.codex/hooks.json and the agy config/hooks/mcp files', () => {
  const md = readDoc('docs/SECURITY.md');
  const from = md.indexOf('**Configuration the fleet did not choose.**');
  assert.ok(from !== -1);
  const para = md.slice(from, from + 900);
  assert.match(para, /`~\/\.codex\/hooks\.json` under `--ignore-user-config`/);
  assert.match(para, /`~\/\.gemini\/antigravity-cli\/settings\.json`/);
  assert.match(para, /`~\/\.gemini\/config\/hooks\.json`/);
  assert.match(para, /`~\/\.gemini\/config\/mcp_config\.json`/);
  assert.match(para, /`\.agents\/hooks\.json`/);
  assert.match(para, /`\.agents\/mcp_config\.json`/);
});

test('SECURITY: the environment allowlist is stated as policy, not configuration isolation, and points at the config paragraph', () => {
  const md = readDoc('docs/SECURITY.md');
  assert.match(md, /This is an environment policy, not configuration isolation: the files a CLI reads on its own are under \[Configuration the fleet did not choose\]\(#configuration-the-fleet-did-not-choose\)\./);
});

test('ADAPTERS checklist: envPassthrough is exact names, and defineUnit refuses a PREFIX_* pattern', () => {
  const md = readDoc('docs/ADAPTERS.md');
  assert.match(md, /\*\*`envPassthrough` is exact names\.\*\*/);
  assert.match(md, /`defineUnit` refuses a `PREFIX_\*` pattern\./);
  assert.doesNotMatch(md, /envPassthrough: \['ACME_\*'\]/);
});
