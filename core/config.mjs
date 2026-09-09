/**
 * omelette-fleet :: core/config.mjs
 * The fleet configuration layer and the write-mode CEILING.
 *
 * FILE: <home>/fleet.config.json, home = $OMELETTE_HOME or ~/.omelette.
 *   { "version": 1,
 *     "updateCheck": true,
 *     "agents": { "coder": { model, effort }, "tester": { model, effort, maxTurns } },
 *     "handoff": { enabled, threshold, contextWindow },
 *     "defaults": { ...keys applied to every unit... },
 *     "units": { "<unit>": { enabled, mode, model, effort, timeoutS, maxTurns,
 *                            outputCap, webSearch, status, cancel, ... } } }
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
  // The tail cap core/spawn.mjs keeps on one run's stdout. A unit whose answer
  // shares that stream with everything else the CLI prints raises its own
  // built-in (grok: 10 000 000 — thinking deltas ride along with the answer).
  outputCap: { type: 'posint', default: 400000 },
  webSearch: { type: 'boolean', default: true },
  status: { type: 'boolean', default: true },
  // The result spool (core/results.mjs): every spawned answer is written to
  // <home>/results/<unit>/<resultId>.md before the response is sent, so a
  // client timeout cannot lose an answer that was already paid for.
  // `resultsKeep` and `resultsMaxBytes` bound the directory PER UNIT.
  results: { type: 'boolean', default: true },
  resultsKeep: { type: 'posint', default: 50 },
  resultsMaxBytes: { type: 'posint', default: 52428800 }, // 50 MB
  // What a client's `notifications/cancelled` does to the run it names.
  // `finish`: the vendor CLI is left to end and the result is recorded — a
  // cancel is usually a client-side timeout, and the run is already paid for.
  // `kill`: every process group the request owns is SIGKILLed at once.
  cancel: { type: 'enum', values: ['finish', 'kill'], default: 'finish' },
};

export function fleetHome(env = process.env) {
  const h = String(env.OMELETTE_HOME || '').trim();
  return h || join(homedir(), '.omelette');
}

export function configPath(env = process.env) {
  return join(fleetHome(env), CONFIG_FILE);
}

/** A plain object — the shape every nested block of this file has to have. */
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

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
    // A WHOLE number, and a fraction is REFUSED rather than floored: flooring
    // made `0.5` mean the 0 every posint key exists to forbid, and `1.9` mean a
    // 1 the operator never wrote. Both are typos. `posint` starts at 1 and
    // `nonneg` at 0 — the second exists for a key whose zero MEANS something
    // (`handoff.contextWindow: 0` = resolve the window at run time), where a
    // refusal would take the value away instead of validating it. `min`/`max`
    // on the spec bound either one: a `handoff.threshold` of 100 is a typo, not
    // a preference, and the schema is where that is said.
    case 'posint':
    case 'nonneg': {
      // `Number('')`, `Number(null)`, `Number(false)` and `Number([])` are all
      // 0 — which posint rejects for being below 1 and nonneg would otherwise
      // accept as a value nobody wrote. So the raw has to LOOK like a number
      // before it is read as one.
      if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return { ok: false };
      const n = Number(raw);
      if (!Number.isInteger(n) || n < (spec.type === 'posint' ? 1 : 0)) return { ok: false };
      if (spec.min !== undefined && n < spec.min) return { ok: false };
      if (spec.max !== undefined && n > spec.max) return { ok: false };
      return { ok: true, value: n };
    }
    case 'enum':
      return typeof raw === 'string' && spec.values.includes(raw) ? { ok: true, value: raw } : { ok: false };
    case 'string':
      return typeof raw === 'string' ? { ok: true, value: raw.trim() } : { ok: false };
    // A string that gets RENDERED into a managed file, so it has to be exactly
    // one printable line. A newline in an agent's `model` would close the
    // definition's frontmatter early and push the rest of it —
    // `disallowedTools: Agent` included — into the body, where the harness
    // enforces nothing, in a file whose marker still says it is ours. Blank is
    // out for the same reason: it would ship a `model:` with no value.
    // U+0085, U+2028 and U+2029 join the C0 controls in the class: a YAML
    // reader ends a line on each of them exactly as it does on a newline, and
    // not one of them is a control character, so nothing else here catches them.
    case 'line': {
      if (typeof raw !== 'string') return { ok: false };
      const value = raw.trim();
      return value && !/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(value) ? { ok: true, value } : { ok: false };
    }
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

/**
 * Fleet-wide keys that live at the TOP level of the config file, next to
 * `defaults` and `units` — they describe the fleet itself, not any one unit, so
 * they are resolved here instead of through `unitConfig`.
 */
export const SETTINGS_SCHEMA = {
  updateCheck: { type: 'boolean', default: true },
};

/** Claude Code's own effort ladder — what a sub-agent definition's `effort:` accepts. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The sub-agent definitions `omelette-fleet rules --agents` writes, as config:
 * a nested top-level `agents` block, one entry per shipped role, resolved and
 * rendered into the templates by core/rules.mjs (`agentSettings`,
 * `renderAgentFile`). The schema lives here, beside every other key's, because
 * these are ordinary `coerce` specs and validate exactly like the rest — an
 * invalid value is a warning and the default, never a throw and never a file
 * the harness cannot read.
 *
 * `model` is passed through verbatim (an alias like `opus`, or a full model
 * id, spaces and all), so it is only checked for being one printable line —
 * see the `line` case in `coerce` for why that check is not cosmetic.
 */
export const AGENT_SETTINGS_SCHEMA = {
  coder: {
    model: { type: 'line', default: 'opus' },
    effort: { type: 'enum', values: EFFORT_LEVELS, default: 'xhigh' },
  },
  tester: {
    model: { type: 'line', default: 'sonnet' },
    effort: { type: 'enum', values: EFFORT_LEVELS, default: 'xhigh' },
    maxTurns: { type: 'posint', default: 80 },
  },
};

/**
 * THE AUTO-HANDOFF, as config: a third top-level block, beside `agents` and for
 * the same reason — it configures a managed FILE rather than a unit. Nothing
 * reads it at call time. `omelette-fleet rules --hooks` renders these three
 * values into the guard script as a JSON literal (core/rules.mjs,
 * `renderHookFile`), because that script imports nothing from this package, and
 * until it is re-rendered the config and the installed hook disagree — which is
 * why `doctor` reports the value it reads back OUT of the script.
 *
 * `threshold` is a percentage of the context window and is bounded 50–99: below
 * 50 the reminder arrives while there is nothing to hand off, and at 100 it
 * never arrives at all. `contextWindow` is the window to measure against, where
 * **0 means "resolve it at run time"** — the environment, then Claude Code's own
 * `autoCompactWindow`, then its documented 200 000 — so it is `nonneg` rather
 * than `posint`: the zero is the default and not a refusal. Its ceiling is the
 * safe integer range, because that is the arithmetic the guard does with it:
 * the script's own parser refuses a window it cannot hold exactly, and a config
 * value it would refuse has no business rendering into it.
 */
export const HANDOFF_SCHEMA = {
  enabled: { type: 'boolean', default: true },
  threshold: { type: 'posint', min: 50, max: 99, default: 90 },
  contextWindow: { type: 'nonneg', max: Number.MAX_SAFE_INTEGER, default: 0 },
};

/**
 * The config file's top-level settings, validated. Never throws: a malformed
 * file or an invalid value is a warning and the built-in default stays in
 * force, exactly as it does for a unit's keys.
 * @returns {{updateCheck:boolean, warnings:string[], configPath:string}}
 */
export function fleetSettings(env = process.env) {
  const { config, error, path } = loadFleetConfig(env);
  const warnings = [];
  if (error) warnings.push(`fleet config: ${error}`);
  const src = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const values = {};
  for (const [key, spec] of Object.entries(SETTINGS_SCHEMA)) {
    values[key] = spec.default;
    if (src[key] === undefined) continue;
    const c = coerce(spec, src[key]);
    if (c.ok) values[key] = c.value;
    else warnings.push(`fleet config: ${key} = ${JSON.stringify(src[key])} is invalid — ignored`);
  }
  return { ...values, warnings, configPath: path };
}

/**
 * The `handoff` block, validated, with where every value came from — the same
 * contract `agentSettings` has and for the same reason: an invalid value is a
 * WARNING and the built-in default, never a throw, because the alternative is
 * `rules --hooks` refusing to write the guard a session needs.
 *
 * @returns {{enabled:boolean, threshold:number, contextWindow:number,
 *            sources:object, warnings:string[], configPath:string}}
 */
export function handoffSettings(env = process.env) {
  const { config, error, path } = loadFleetConfig(env);
  const warnings = [];
  if (error) warnings.push(`fleet config: ${error}`);

  const raw = isObj(config) ? config.handoff : undefined;
  if (raw !== undefined && !isObj(raw)) warnings.push('fleet config: handoff is not an object — ignored');
  const block = isObj(raw) ? raw : {};

  const values = {};
  const sources = {};
  for (const [key, spec] of Object.entries(HANDOFF_SCHEMA)) {
    values[key] = spec.default;
    sources[key] = 'default';
    if (block[key] === undefined) continue;
    const c = coerce(spec, block[key]);
    if (c.ok) { values[key] = c.value; sources[key] = 'file'; }
    else warnings.push(`fleet config: handoff.${key} = ${JSON.stringify(block[key])} is invalid — ignored`);
  }
  for (const key of Object.keys(block)) {
    if (!(key in HANDOFF_SCHEMA)) warnings.push(`fleet config: handoff.${key} is not a known key — ignored`);
  }
  return { ...values, sources, warnings, configPath: path };
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

  const fileDefaults = config && isObj(config.defaults) ? config.defaults : {};
  const fileUnit = config && isObj(config.units) && isObj(config.units[unit]) ? config.units[unit] : {};

  // A typo in `defaults` is just as silent as one in `units.<unit>`, and it
  // disappoints harder: the operator expects it to apply to the WHOLE fleet.
  // (extraSchema is per unit, so a key valid for another unit warns here.)
  for (const key of Object.keys(fileDefaults)) {
    if (!(key in schema)) warnings.push(`fleet config: defaults.${key} is not a known key — ignored`);
  }
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
