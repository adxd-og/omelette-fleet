import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  unitConfig, effectiveMode, allowWriteUnits, loadFleetConfig, writeFleetConfig, fleetHome, fleetSettings,
  coerce, AGENT_SETTINGS_SCHEMA, CONFIG_VERSION, KEY_SCHEMA,
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

test('coerce: a posint is a WHOLE number — a fraction is refused, never floored', () => {
  // Flooring made `0.5` mean `0`, which every posint key exists to forbid, and
  // `1.9` mean `1`, a value the operator never wrote. Both are typos: refuse.
  for (const raw of [0.5, '0.5', 1.9, '1.9', '1e-3', 0.999]) {
    assert.deepEqual(coerce({ type: 'posint' }, raw), { ok: false }, JSON.stringify(raw));
  }
  assert.deepEqual(coerce({ type: 'posint' }, 1), { ok: true, value: 1 });
  assert.deepEqual(coerce({ type: 'posint' }, '1'), { ok: true, value: 1 });
  assert.deepEqual(coerce({ type: 'posint' }, ' 900 '), { ok: true, value: 900 });
  assert.deepEqual(coerce({ type: 'posint' }, 0), { ok: false });
  assert.deepEqual(coerce({ type: 'posint' }, Infinity), { ok: false });
  assert.deepEqual(coerce({ type: 'posint' }, 'abc'), { ok: false });
});

test('coerce: a `line` spec is one printable line — no blank, no control character, no smuggled newline', () => {
  // The type exists for values that get RENDERED into a managed file: a newline
  // would close a definition's frontmatter early and push the rest of it,
  // `disallowedTools: Agent` included, into the body of a file still marked ours.
  assert.deepEqual(coerce({ type: 'line' }, '   '), { ok: false });
  assert.deepEqual(coerce({ type: 'line' }, ''), { ok: false });
  assert.deepEqual(coerce({ type: 'line' }, ' opus '), { ok: true, value: 'opus' });
  assert.deepEqual(coerce({ type: 'line' }, 'Gemini 3.8 Flash (High)'), { ok: true, value: 'Gemini 3.8 Flash (High)' });
  for (const bad of ['opus\n---\ninjected: 1', 'opus\r\nx', 'opus\tx', 'opus\u000bx', 'opus\fx', 'opus\u0000x', 'opus\u001b[0m']) {
    assert.deepEqual(coerce({ type: 'line' }, bad), { ok: false }, JSON.stringify(bad));
  }
  // The Unicode line breaks a YAML reader ends a line on as readily as on \n:
  // NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR. Built from a char code so this
  // source file never carries one — what a config file may contain is the point.
  for (const code of [0x0085, 0x2028, 0x2029]) {
    const bad = `opus${String.fromCharCode(code)}disallowedTools: `;
    assert.deepEqual(coerce({ type: 'line' }, bad), { ok: false }, `U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
  }
  // the unit keys are unaffected: '' is how a plain string key says "unset"
  assert.deepEqual(coerce({ type: 'string' }, ''), { ok: true, value: '' });
});

test('AGENT_SETTINGS_SCHEMA: the two shipped roles, their keys and the defaults the templates render', () => {
  assert.deepEqual(Object.keys(AGENT_SETTINGS_SCHEMA), ['coder', 'tester']);
  assert.deepEqual(Object.keys(AGENT_SETTINGS_SCHEMA.coder), ['model', 'effort']);
  assert.deepEqual(Object.keys(AGENT_SETTINGS_SCHEMA.tester), ['model', 'effort', 'maxTurns']);
  assert.equal(AGENT_SETTINGS_SCHEMA.coder.model.default, 'opus');
  assert.equal(AGENT_SETTINGS_SCHEMA.coder.effort.default, 'xhigh');
  assert.equal(AGENT_SETTINGS_SCHEMA.tester.model.default, 'sonnet');
  assert.equal(AGENT_SETTINGS_SCHEMA.tester.effort.default, 'xhigh');
  assert.equal(AGENT_SETTINGS_SCHEMA.tester.maxTurns.default, 80);
  assert.deepEqual(AGENT_SETTINGS_SCHEMA.tester.effort.values, ['low', 'medium', 'high', 'xhigh', 'max']);
  // and the specs are ordinary `coerce` specs, so a turn limit of 0 is not a value
  assert.deepEqual(coerce(AGENT_SETTINGS_SCHEMA.tester.maxTurns, '0'), { ok: false });
  assert.deepEqual(coerce(AGENT_SETTINGS_SCHEMA.coder.model, ''), { ok: false });
  assert.deepEqual(coerce(AGENT_SETTINGS_SCHEMA.coder.model, 'opus\n---'), { ok: false }, 'a rendered value can never carry a newline');
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

test('outputCap: a schema key like any other — 400 000 by default, raised by a unit builtin, tunable per unit', () => {
  const plain = unitConfig({ unit: 'gemini', supportedModes: MODES_CODEX, env: { OMELETTE_HOME: home() } });
  assert.equal(plain.values.outputCap, 400000);
  assert.equal(plain.sources.outputCap, 'default');
  // Grok's thinking deltas ride the same stream, so its adapter raises the built-in.
  const grok = unitConfig({ unit: 'grok', builtin: { outputCap: 2000000 }, supportedModes: MODES_GROK, env: { OMELETTE_HOME: home() } });
  assert.equal(grok.values.outputCap, 2000000);
  assert.equal(grok.sources.outputCap, 'default');
  // The operator narrows or widens it per unit or fleet-wide; a bad value warns
  // and falls through to the layer below, like every other key.
  const env = { OMELETTE_HOME: home({ defaults: { outputCap: 50000 }, units: { grok: { outputCap: 8000000 }, codex: { outputCap: 'lots' } } }) };
  const raised = unitConfig({ unit: 'grok', builtin: { outputCap: 2000000 }, supportedModes: MODES_GROK, env });
  assert.equal(raised.values.outputCap, 8000000);
  assert.equal(raised.sources.outputCap, 'file');
  const fleetWide = unitConfig({ unit: 'gemini', supportedModes: MODES_CODEX, env });
  assert.equal(fleetWide.values.outputCap, 50000);
  assert.equal(fleetWide.sources.outputCap, 'file:defaults');
  const bad = unitConfig({ unit: 'codex', builtin: { outputCap: 2000000 }, supportedModes: MODES_CODEX, env });
  assert.equal(bad.values.outputCap, 50000, 'the invalid unit value falls through to `defaults`');
  assert.ok(bad.warnings.some((w) => /codex\.outputCap = "lots" is invalid/.test(w)));
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

test('fleetSettings: top-level keys, validated, defaulted, and never fatal', () => {
  // absent file → the built-in default
  assert.equal(fleetSettings({ OMELETTE_HOME: home() }).updateCheck, true);
  // an explicit value, in either notation coerce understands
  assert.equal(fleetSettings({ OMELETTE_HOME: home({ version: 1, updateCheck: false }) }).updateCheck, false);
  assert.equal(fleetSettings({ OMELETTE_HOME: home({ updateCheck: 'off' }) }).updateCheck, false);
  // an invalid value warns and leaves the default in force — never throws
  const bad = fleetSettings({ OMELETTE_HOME: home({ updateCheck: 'maybe' }) });
  assert.equal(bad.updateCheck, true);
  assert.ok(bad.warnings.some((w) => /updateCheck = "maybe" is invalid/.test(w)));
  // a malformed file is a warning too, and the unit layer is untouched by any of this
  const broken = fleetSettings({ OMELETTE_HOME: home('{ not json') });
  assert.equal(broken.updateCheck, true);
  assert.ok(broken.warnings.some((w) => /fleet config:/.test(w)));
  assert.match(broken.configPath, /fleet\.config\.json$/);
  const dir = home({ updateCheck: false, units: { codex: { timeoutS: 7 } } });
  assert.equal(unitConfig({ unit: 'codex', supportedModes: MODES_CODEX, env: { OMELETTE_HOME: dir } }).values.timeoutS, 7);
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

test('cancel: an enum key like any other — `finish` by default, per unit or fleet-wide', () => {
  const plain = unitConfig({ unit: 'codex', supportedModes: MODES_CODEX, env: { OMELETTE_HOME: home() } });
  assert.equal(plain.values.cancel, 'finish');
  assert.equal(plain.sources.cancel, 'default');
  const env = { OMELETTE_HOME: home({ defaults: { cancel: 'kill' }, units: { grok: { cancel: 'finish' }, codex: { cancel: 'stop' } } }) };
  const fleetWide = unitConfig({ unit: 'gemini', supportedModes: MODES_CODEX, env });
  assert.equal(fleetWide.values.cancel, 'kill');
  assert.equal(fleetWide.sources.cancel, 'file:defaults');
  const perUnit = unitConfig({ unit: 'grok', supportedModes: MODES_GROK, env });
  assert.equal(perUnit.values.cancel, 'finish');
  assert.equal(perUnit.sources.cancel, 'file');
  const bad = unitConfig({ unit: 'codex', supportedModes: MODES_CODEX, env });
  assert.equal(bad.values.cancel, 'kill', 'the invalid unit value falls through to `defaults`');
  assert.ok(bad.warnings.some((w) => /codex\.cancel = "stop" is invalid/.test(w)));
  // The enum is exact: no case folding, no third value.
  assert.deepEqual(coerce(KEY_SCHEMA.cancel, 'kill'), { ok: true, value: 'kill' });
  assert.deepEqual(coerce(KEY_SCHEMA.cancel, 'KILL'), { ok: false });
  assert.deepEqual(KEY_SCHEMA.cancel.values, ['finish', 'kill']);
});
