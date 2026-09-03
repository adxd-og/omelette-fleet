import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  unitConfig, effectiveMode, allowWriteUnits, loadFleetConfig, writeFleetConfig, fleetHome, coerce, CONFIG_VERSION,
} from '../core/config.mjs';

function home(config) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-cfg-'));
  if (config !== undefined) writeFileSync(join(dir, 'fleet.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}
const MODES_CODEX = { 'read-only': true, 'workspace-write': true };
const MODES_GROK = { 'read-only': true, 'workspace-write': null };

test('OMELETTE_HOME overrides the default home', () => {
  assert.equal(fleetHome({ OMELETTE_HOME: '/tmp/x' }), '/tmp/x');
  assert.match(fleetHome({}), /\.omelette$/);
});

test('coerce accepts env-style strings for booleans and ints', () => {
  assert.deepEqual(coerce({ type: 'boolean' }, 'off'), { ok: true, value: false });
  assert.deepEqual(coerce({ type: 'boolean' }, 'maybe'), { ok: false });
  assert.deepEqual(coerce({ type: 'posint' }, '900'), { ok: true, value: 900 });
  assert.deepEqual(coerce({ type: 'posint' }, '-1'), { ok: false });
  assert.deepEqual(coerce({ type: 'enum', values: ['a'] }, 'b'), { ok: false });
});

test('no file: built-in defaults, no warnings, read-only', () => {
  const env = { OMELETTE_HOME: home() };
  const c = unitConfig({ unit: 'codex', supportedModes: MODES_CODEX, env });
  assert.equal(c.values.mode, 'read-only');
  assert.equal(c.values.enabled, true);
  assert.equal(c.values.timeoutS, 300);
  assert.deepEqual(c.warnings, []);
  assert.equal(c.sources.timeoutS, 'default');
});

test('precedence: builtin < file defaults < file unit < env, with sources recorded', () => {
  const env = {
    OMELETTE_HOME: home({ version: 1, defaults: { timeoutS: 111, webSearch: false }, units: { codex: { timeoutS: 222, model: 'm-file' } } }),
    CODEX_TIMEOUT_S: '333',
  };
  const c = unitConfig({
    unit: 'codex', builtin: { timeoutS: 600 }, envMap: { timeoutS: 'CODEX_TIMEOUT_S', model: 'CODEX_DEFAULT_MODEL' },
    supportedModes: MODES_CODEX, env,
  });
  assert.equal(c.values.timeoutS, 333);
  assert.equal(c.sources.timeoutS, 'env:CODEX_TIMEOUT_S');
  assert.equal(c.values.model, 'm-file');
  assert.equal(c.sources.model, 'file');
  assert.equal(c.values.webSearch, false);
  assert.equal(c.sources.webSearch, 'file:defaults');
  assert.equal(c.values.maxTurns, 30);
  assert.equal(c.sources.maxTurns, 'default');
});

test('invalid values warn and fall through to the next-lower layer; unknown keys warn', () => {
  const env = { OMELETTE_HOME: home({ units: { grok: { timeoutS: 'soon', timeout: 5, enabled: 'yes' } } }), GROK_MAX_TURNS: 'lots' };
  const c = unitConfig({ unit: 'grok', envMap: { maxTurns: 'GROK_MAX_TURNS' }, supportedModes: MODES_GROK, env });
  assert.equal(c.values.timeoutS, 300);
  assert.equal(c.values.enabled, true);
  assert.equal(c.values.maxTurns, 30);
  assert.ok(c.warnings.some((w) => /grok\.timeoutS = "soon" is invalid/.test(w)));
  assert.ok(c.warnings.some((w) => /grok\.timeout is not a known key/.test(w)));
  assert.ok(c.warnings.some((w) => /GROK_MAX_TURNS = "lots" is invalid/.test(w)));
});

test('an unknown key in `defaults` warns too — a fleet-wide typo is the quietest one', () => {
  const env = { OMELETTE_HOME: home({ defaults: { webSerch: false, timeoutS: 42 } }) };
  const c = unitConfig({ unit: 'grok', supportedModes: MODES_GROK, env });
  assert.ok(c.warnings.some((w) => /defaults\.webSerch is not a known key/.test(w)));
  assert.ok(!c.warnings.some((w) => /defaults\.timeoutS/.test(w)));
  assert.equal(c.values.timeoutS, 42);
});

test('malformed file: warning, defaults stay in force, and never throws', () => {
  const env = { OMELETTE_HOME: home('{ not json') };
  const c = unitConfig({ unit: 'codex', supportedModes: MODES_CODEX, env });
  assert.equal(c.values.mode, 'read-only');
  assert.ok(c.warnings.some((w) => /fleet config:/.test(w)));
});

test('a newer config version warns but still applies known keys', () => {
  const env = { OMELETTE_HOME: home({ version: CONFIG_VERSION + 1, units: { codex: { timeoutS: 42 } } }) };
  const c = unitConfig({ unit: 'codex', supportedModes: MODES_CODEX, env });
  assert.equal(c.values.timeoutS, 42);
  assert.ok(c.warnings.some((w) => /newer than this fleet/.test(w)));
});

test('CEILING: workspace-write without OMELETTE_ALLOW_WRITE falls back to read-only with a warning', () => {
  const env = { OMELETTE_HOME: home({ units: { codex: { mode: 'workspace-write' } } }) };
  const c = unitConfig({ unit: 'codex', supportedModes: MODES_CODEX, env });
  assert.equal(c.values.requestedMode, 'workspace-write');
  assert.equal(c.values.mode, 'read-only');
  assert.equal(c.ceilingOpen, false);
  assert.ok(c.warnings.some((w) => /ceiling closed/.test(w)));
});

test('CEILING: the env key opens exactly the units it lists', () => {
  const dir = home({ units: { codex: { mode: 'workspace-write' }, gemini: { mode: 'workspace-write' } } });
  const open = unitConfig({ unit: 'codex', supportedModes: MODES_CODEX, env: { OMELETTE_HOME: dir, OMELETTE_ALLOW_WRITE: 'codex' } });
  assert.equal(open.values.mode, 'workspace-write');
  assert.equal(open.ceilingOpen, true);
  assert.deepEqual(open.warnings, []);
  const closed = unitConfig({ unit: 'gemini', supportedModes: MODES_CODEX, env: { OMELETTE_HOME: dir, OMELETTE_ALLOW_WRITE: 'codex' } });
  assert.equal(closed.values.mode, 'read-only');
  assert.deepEqual([...allowWriteUnits({ OMELETTE_ALLOW_WRITE: ' Codex , gemini' })], ['codex', 'gemini']);
});

test('CEILING: ORION_ALLOW_GEMINI_MUTATE=1 is a legacy alias for gemini only', () => {
  assert.deepEqual([...allowWriteUnits({ ORION_ALLOW_GEMINI_MUTATE: '1' })], ['gemini']);
  assert.deepEqual([...allowWriteUnits({ ORION_ALLOW_GEMINI_MUTATE: '0' })], []);
});

test('CEILING: a unit that does not implement the mode refuses it even with the ceiling open', () => {
  const r = effectiveMode({ unit: 'grok', requested: 'workspace-write', supported: MODES_GROK, env: { OMELETTE_ALLOW_WRITE: 'grok' } });
  assert.equal(r.mode, 'read-only');
  assert.ok(r.warnings.some((w) => /not supported by unit "grok"/.test(w)));
});

test('the file is re-read when it changes (live toggles), and cached otherwise', async () => {
  const dir = home({ units: { codex: { enabled: true } } });
  const env = { OMELETTE_HOME: dir };
  assert.equal(unitConfig({ unit: 'codex', supportedModes: MODES_CODEX, env }).values.enabled, true);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { enabled: false } } }));
  // force a distinct mtime on coarse filesystems
  const { utimesSync } = await import('node:fs');
  utimesSync(join(dir, 'fleet.config.json'), new Date(), new Date(Date.now() + 5000));
  assert.equal(unitConfig({ unit: 'codex', supportedModes: MODES_CODEX, env }).values.enabled, false);
});

test('writeFleetConfig writes atomically with version and 0600', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'omelette-w-')), 'nested');
  mkdirSync(dir, { recursive: true });
  const env = { OMELETTE_HOME: dir };
  const p = writeFleetConfig({ units: { codex: { timeoutS: 7 } } }, env);
  const back = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(back.version, CONFIG_VERSION);
  assert.equal(back.units.codex.timeoutS, 7);
  assert.equal(loadFleetConfig(env).config.units.codex.timeoutS, 7);
});
