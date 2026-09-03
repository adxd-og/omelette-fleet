/**
 * omelette-fleet :: core/config.mjs
 * The fleet configuration layer and the write-mode CEILING.
 *
 * FILE: <home>/fleet.config.json, home = $OMELETTE_HOME or ~/.omelette.
 *   { "version": 1,
 *     "defaults": { ...keys applied to every unit... },
 *     "units": { "<unit>": { enabled, mode, model, effort, timeoutS, maxTurns, webSearch, status, ... } } }
 *
 * RESOLUTION, per key: built-in default → file `defaults` → file `units.<unit>`
 * → environment variable (the unit's legacy env names, e.g. GROK_TIMEOUT_S).
 * Env wins on purpose — it is the machine-local override and the escape
 * hatch — and `sources` records where every value came from so a shadowed
 * config value is visible instead of mysterious.
 *
 * READ PER CALL: the file is stat'ed on every resolution (parsed again only
 * when mtime changes), so a toggle takes effect on the next tool call without
 * restarting the session. A malformed file is a WARNING, never an exception:
 * the last good parse (or the built-in defaults) stays in force.
 *
 * THE CEILING — the one rule that keeps a config file from being a foot-gun:
 * the config can only NARROW what a unit may do. Any `mode` wider than
 * `read-only` takes effect ONLY if the machine's environment also lists the
 * unit in OMELETTE_ALLOW_WRITE (comma-separated), which lives in the MCP
 * server's env block — outside every project, unwritable by a read-only unit.
 * Otherwise the bridge warns on stderr and stays read-only. A unit that does
 * not implement a mode (supportedModes[mode] falsy) refuses it explicitly.
 * ORION_ALLOW_GEMINI_MUTATE=1 is honoured as a legacy alias for `gemini`.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_VERSION = 1;
export const CONFIG_FILE = 'fleet.config.json';
export const MODES = ['read-only', 'workspace-write'];

/** Keys every unit understands. Adapters may extend with `extraSchema`. */
export const KEY_SCHEMA = {
  enabled: { type: 'boolean', default: true },
  mode: { type: 'enum', values: MODES, default: 'read-only' },
  model: { type: 'string', default: '' },
  effort: { type: 'string', default: '' },
  timeoutS: { type: 'posint', default: 300 },
  maxTurns: { type: 'posint', default: 30 },
  webSearch: { type: 'boolean', default: true },
  status: { type: 'boolean', default: true },
};

export function fleetHome(env = process.env) {
  const h = String(env.OMELETTE_HOME || '').trim();
  return h || join(homedir(), '.omelette');
}

export function configPath(env = process.env) {
  return join(fleetHome(env), CONFIG_FILE);
}

const TRUE_WORDS = new Set(['1', 'true', 'on', 'yes']);
const FALSE_WORDS = new Set(['0', 'false', 'off', 'no']);

/** Coerce one raw value against a key spec. Strings are accepted for booleans/ints so env vars work. */
export function coerce(spec, raw) {
  switch (spec.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase();
        if (TRUE_WORDS.has(s)) return { ok: true, value: true };
        if (FALSE_WORDS.has(s)) return { ok: true, value: false };
      }
      return { ok: false };
    }
    case 'posint': {
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? { ok: true, value: Math.floor(n) } : { ok: false };
    }
    case 'enum':
      return typeof raw === 'string' && spec.values.includes(raw) ? { ok: true, value: raw } : { ok: false };
    case 'string':
      return typeof raw === 'string' ? { ok: true, value: raw.trim() } : { ok: false };
    default:
      return { ok: false };
  }
}

let cache = { path: null, mtimeMs: -1, data: null, error: null };

/** Read the fleet config (cached by mtime). Never throws. */
export function loadFleetConfig(env = process.env) {
  const path = configPath(env);
  let st = null;
  try { st = statSync(path); } catch { /* absent */ }
  if (!st) {
    cache = { path, mtimeMs: -1, data: null, error: null };
    return { config: null, path, error: null };
  }
  if (cache.path === path && cache.mtimeMs === st.mtimeMs) return { config: cache.data, path, error: cache.error };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('top-level must be an object');
    const error = typeof parsed.version === 'number' && parsed.version > CONFIG_VERSION
      ? `${path}: version ${parsed.version} is newer than this fleet understands (${CONFIG_VERSION}) — unknown keys will be ignored`
      : null;
    cache = { path, mtimeMs: st.mtimeMs, data: parsed, error };
    return { config: parsed, path, error };
  } catch (e) {
    const error = `${path}: ${(e && e.message) || e}`;
    // keep the last good parse of the SAME file; a different path starts clean
    cache = { path, mtimeMs: st.mtimeMs, data: cache.path === path ? cache.data : null, error };
    return { config: cache.data, path, error };
  }
}

/** Units the machine environment allows past read-only. */
export function allowWriteUnits(env = process.env) {
  const set = new Set(
    String(env.OMELETTE_ALLOW_WRITE || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  if (TRUE_WORDS.has(String(env.ORION_ALLOW_GEMINI_MUTATE || '').trim().toLowerCase())) set.add('gemini');
  return set;
}

/**
 * Apply the ceiling to a requested mode.
 * @param {{unit:string, requested:string, supported:object, env?:object}} o
 *   supported: { 'read-only': true, 'workspace-write': true|null } — null/false = the unit refuses that level.
 */
export function effectiveMode({ unit, requested, supported, env = process.env }) {
  const warnings = [];
  let mode = requested || 'read-only';
  const ceilingOpen = allowWriteUnits(env).has(String(unit).toLowerCase());
  if (mode !== 'read-only') {
    if (!supported || !supported[mode]) {
      warnings.push(`mode "${mode}" is not supported by unit "${unit}" — staying read-only`);
      mode = 'read-only';
    } else if (!ceilingOpen) {
      warnings.push(`mode "${mode}" requested for "${unit}" but OMELETTE_ALLOW_WRITE does not list it — ceiling closed, staying read-only`);
      mode = 'read-only';
    }
  }
  return { mode, ceilingOpen, warnings };
}

/**
 * Resolve one unit's effective configuration.
 * @param {{unit:string, envMap?:object, builtin?:object, extraSchema?:object,
 *          supportedModes?:object, env?:object}} o
 *   envMap: { key: 'ENV_NAME' } — the unit's legacy env overrides.
 *   builtin: the unit's own defaults for schema keys (override KEY_SCHEMA defaults).
 * @returns {{unit, values, sources, warnings, ceilingOpen, configPath, home}}
 */
export function unitConfig({ unit, envMap = {}, builtin = {}, extraSchema = {}, supportedModes, env = process.env }) {
  const schema = { ...KEY_SCHEMA, ...extraSchema };
  const values = {};
  const sources = {};
  const warnings = [];
  const { config, error, path } = loadFleetConfig(env);
  if (error) warnings.push(`fleet config: ${error}`);

  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  const fileDefaults = config && isObj(config.defaults) ? config.defaults : {};
  const fileUnit = config && isObj(config.units) && isObj(config.units[unit]) ? config.units[unit] : {};

  for (const key of Object.keys(fileUnit)) {
    if (!(key in schema)) warnings.push(`fleet config: units.${unit}.${key} is not a known key — ignored`);
  }

  for (const [key, spec] of Object.entries(schema)) {
    values[key] = key in builtin ? builtin[key] : spec.default;
    sources[key] = 'default';
    for (const [layer, obj] of [['file:defaults', fileDefaults], ['file', fileUnit]]) {
      if (obj[key] === undefined) continue;
      const c = coerce(spec, obj[key]);
      if (c.ok) { values[key] = c.value; sources[key] = layer; }
      else warnings.push(`fleet config (${layer}): ${unit}.${key} = ${JSON.stringify(obj[key])} is invalid — ignored`);
    }
    const envName = envMap[key];
    if (envName && env[envName] !== undefined && String(env[envName]) !== '') {
      const c = coerce(spec, env[envName]);
      if (c.ok) { values[key] = c.value; sources[key] = `env:${envName}`; }
      else warnings.push(`env ${envName} = ${JSON.stringify(env[envName])} is invalid — ignored`);
    }
  }

  // Fleet-wide env switches (not per unit).
  if (env.OMELETTE_STATUS !== undefined && String(env.OMELETTE_STATUS) !== '') {
    const c = coerce(schema.status, env.OMELETTE_STATUS);
    if (c.ok) { values.status = c.value; sources.status = 'env:OMELETTE_STATUS'; }
  }

  const em = effectiveMode({ unit, requested: values.mode, supported: supportedModes, env });
  warnings.push(...em.warnings);
  return {
    unit,
    values: { ...values, requestedMode: values.mode, mode: em.mode },
    sources,
    warnings,
    ceilingOpen: em.ceilingOpen,
    configPath: path,
    home: fleetHome(env),
  };
}

/** Atomic write of the whole config (0600). Returns the path. */
export function writeFleetConfig(config, env = process.env) {
  const path = configPath(env);
  mkdirSync(fleetHome(env), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: CONFIG_VERSION, ...config }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  cache = { path: null, mtimeMs: -1, data: null, error: null };
  return path;
}
