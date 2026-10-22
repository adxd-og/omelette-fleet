/**
 * omelette-fleet :: test/tester-1.5.0-t3.test.mjs
 * Independent tester coverage for 1.5.0 Task T3 (explicit environment
 * allowlists), against docs/superpowers/specs/2026-09-25-1.5.0-process-layer-
 * design.md "P3 — explicit environment allowlists" and the plan's Task T3.
 *
 * The coder's own test/env-allowlist-1.5.0.test.mjs covers buildChildEnv and
 * defineUnit directly (the per-unit A/B/C/D table, the exact lists, the
 * escape hatch, the pattern refusal, the billingRiskEnv throw). This file
 * keeps what that file does not reach:
 *   - a REAL spawn of a fake CLI (not just buildChildEnv in isolation) proving
 *     createUnitRuntime wires unit.envPassthrough/unit.riskEnv end to end;
 *   - defineUnit's non-array refusal, and riskEnv taken as is with no
 *     billingRiskEnv key on the result;
 *   - doctor --probe-sandbox using the SAME env-building path (unit.envPassthrough
 *     / unit.riskEnv) as an ordinary call, through a real CLI invocation.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineUnit } from '../core/unit.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import grok from '../units/grok/adapter.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

// ─── 1. a REAL spawn of a fake CLI, end to end through createUnitRuntime ─────

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

// ─── 2. defineUnit: non-array / riskEnv edge cases ───────────────────────────

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

test('defineUnit: riskEnv alone is used as is, with no warning and no billingRiskEnv key on the result', () => {
  const warn = mock.method(console, 'error', () => {});
  try {
    const u = defineUnit(baseSpec({ riskEnv: ['ACME_API_KEY'] }));
    assert.deepEqual(u.riskEnv, ['ACME_API_KEY']);
    assert.equal(warn.mock.calls.length, 0);
    assert.equal('billingRiskEnv' in u, false);
  } finally { warn.mock.restore(); }
});

// ─── 3. doctor --probe-sandbox uses the SAME env-building path as an ordinary call ─

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
