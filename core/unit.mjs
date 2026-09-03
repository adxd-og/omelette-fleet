/**
 * omelette-fleet :: core/unit.mjs
 * The adapter contract and the generic tool runtime.
 *
 * A unit is ONE vendor CLI exposed as ONE MCP server. The adapter declares
 * what is vendor-specific; this module does everything that is not:
 *   config resolution + the write ceiling   (core/config.mjs)
 *   model / effort validation                (core/catalog.mjs)
 *   the git/deploy intent gate               (MUTATE_RE, per tool)
 *   status feed start/end                    (core/status.mjs)
 *   bounded spawn with the env allowlist + billing scrub + auth check (core/spawn.mjs)
 *   JSON-RPC                                 (core/jsonrpc.mjs)
 *
 * defineUnit({
 *   name: 'codex',                       // [a-z][a-z0-9-]*; also the config key and status unit
 *   label: 'Codex',                      // human name in error messages
 *   bin: { env: 'CODEX_BIN', default: 'codex' },
 *   billingRiskEnv: ['OPENAI_API_KEY'],  // deleted from every child env
 *   envPassthrough: ['CODEX_*'],         // added to core/spawn.mjs's ALLOWED_ENV for this unit's
 *                                        // children only (exact names or PREFIX_* patterns); the
 *                                        // billing scrub runs AFTER it, so a pattern cannot
 *                                        // re-admit an API key. Everything else is NOT inherited.
 *   envMap: { model: 'CODEX_DEFAULT_MODEL', timeoutS: 'CODEX_TIMEOUT_S' },   // legacy env overrides
 *   builtin: { timeoutS: 600 },          // unit defaults for config keys
 *   extraSchema: { imageMaxTurns: { type: 'posint', default: 8 } },        // unit-only config keys
 *   supportedModes: { 'read-only': true, 'workspace-write': true|null },   // null = refuse that level
 *   auth: { detect: (stderr) => bool, help: 'run `codex login`' },         // checked on empty-stdout runs only
 *   catalog: makeCatalog({...}),
 *   tools: [{ name, description, inputSchema, kind, mutateGate?, run(args, ctx) }],
 * })
 *
 * tool.kind: research | review | image | pipeline | catalog. `catalog` tools
 * never spawn and are answered by the runtime. Every other kind gets
 * `run(args, ctx)` with ctx = { cfg, mode, model, effort, spawn, retry, log,
 * catalog, home } and returns a string or { text, usage?, isError? }.
 * `isError: true` is how an adapter reports a REFUSAL it handled itself
 * (missing prompt, bad cwd, bad imagePath): the text is the error, MCP is told
 * so, and the status feed records "error" — a run that returns `Error: ...`
 * text without the flag would be reported to the caller as a success.
 */
import { serve } from './jsonrpc.mjs';
import { runProcess } from './spawn.mjs';
import { createStatus } from './status.mjs';
import { unitConfig } from './config.mjs';
import { makeLog, makeOnceLog } from './log.mjs';

export const TOOL_KINDS = new Set(['research', 'review', 'image', 'pipeline', 'catalog']);

/** Git/deploy/publish intent stays with the manager — units are research and review peers. */
export const MUTATE_RE = /\bgit (push|commit|merge|rebase|reset|tag)\b|\bnpm publish\b|\bdeploy\b/i;

export function defineUnit(spec) {
  const where = `defineUnit(${(spec && spec.name) || '?'})`;
  if (!spec || typeof spec !== 'object') throw new Error(`${where}: spec must be an object`);
  for (const k of ['name', 'bin', 'tools', 'catalog']) if (spec[k] === undefined) throw new Error(`${where}: missing "${k}"`);
  if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) throw new Error(`${where}: name must match [a-z][a-z0-9-]*`);
  if (!Array.isArray(spec.tools) || !spec.tools.length) throw new Error(`${where}: tools must be a non-empty array`);
  const names = new Set();
  for (const t of spec.tools) {
    if (!t || !t.name || !t.description || !t.inputSchema) throw new Error(`${where}: every tool needs name, description, inputSchema`);
    if (names.has(t.name)) throw new Error(`${where}: duplicate tool "${t.name}"`);
    names.add(t.name);
    if (!TOOL_KINDS.has(t.kind)) throw new Error(`${where}: tool "${t.name}" has unknown kind "${t.kind}"`);
    if (t.kind !== 'catalog' && typeof t.run !== 'function') throw new Error(`${where}: tool "${t.name}" needs run()`);
  }
  if (typeof spec.catalog.isAllowedModel !== 'function') throw new Error(`${where}: catalog must come from makeCatalog()`);
  return {
    version: '0.1.0',
    label: spec.name,
    serverName: `omelette-${spec.name}`,
    billingRiskEnv: [],
    envPassthrough: [],
    envMap: {},
    builtin: {},
    extraSchema: {},
    supportedModes: { 'read-only': true, 'workspace-write': null },
    auth: null,
    ...spec,
    bin: typeof spec.bin === 'string' ? { env: null, default: spec.bin } : spec.bin,
  };
}

export function resolveBin(unit, env = process.env) {
  return (unit.bin.env && env[unit.bin.env]) || unit.bin.default;
}

/**
 * One bounded retry on empty output — safe for read-only one-shots. `skipIf(err)`
 * names the deterministic failures a retry cannot fix (auth, quota, permission).
 */
export async function boundedRetry(fn, { skipIf = () => false, delayMs = 1500 } = {}) {
  try {
    const r = await fn();
    if (r && (typeof r === 'string' ? r.trim() : r.text)) return r;
  } catch (e) {
    if (skipIf(e)) throw e;
  }
  await new Promise((r) => setTimeout(r, delayMs));
  return fn();
}

/** Build the runtime (config, status, callTool) for a unit without touching stdin/stdout. */
export function createUnitRuntime(unit, { env = process.env } = {}) {
  const log = makeLog(unit.name);
  const warnOnce = makeOnceLog(log);
  const spawnTools = new Set(unit.tools.filter((t) => t.kind !== 'catalog').map((t) => t.name));
  const cfgFor = () => unitConfig({
    unit: unit.name, envMap: unit.envMap, builtin: unit.builtin, extraSchema: unit.extraSchema,
    supportedModes: unit.supportedModes, env,
  });
  const status = createStatus({
    unit: unit.name,
    spawnTools,
    resolve: () => { const c = cfgFor(); return { dir: c.home, enabled: c.values.status }; },
  });
  status.boot();

  function spawnFor(cfg, { args, cwd, stdinText, extraEnv, hardKillMs, outputCap }) {
    const bin = resolveBin(unit, env);
    const timeoutMs = hardKillMs ?? cfg.values.timeoutS * 1000;
    log(`spawn · bin=${bin} · argc=${args.length} · cwd=${cwd || '(process cwd)'} · hard-kill=${Math.round(timeoutMs / 1000)}s`);
    return runProcess({
      // env is the PARENT env to select from: core/spawn.mjs builds the child
      // from the allowlist + this unit's passthrough, never by inheritance.
      bin, args, cwd, env, envPassthrough: unit.envPassthrough, extraEnv,
      scrubEnv: unit.billingRiskEnv,
      hardKillMs: timeoutMs, stdinText, outputCap, log,
      notFoundHelp: `${bin} not found in PATH — install the ${unit.label} CLI${unit.bin.env ? ` or point ${unit.bin.env} at it` : ''}`,
    }).then((res) => {
      // Auth check ONLY on empty-stdout runs: a real answer that merely mentions
      // signing in must never false-positive.
      if (unit.auth && !res.stdout.trim() && unit.auth.detect(res.stderr)) throw new Error(unit.auth.help);
      return res;
    });
  }

  async function callTool(name, args = {}) {
    const tool = unit.tools.find((t) => t.name === name);
    if (!tool) return { text: `Error: unknown tool "${name}".`, isError: true };
    if (tool.kind === 'catalog') return { text: unit.catalog.render() };

    const cfg = cfgFor();
    for (const w of cfg.warnings) warnOnce('config: ' + w);
    if (!cfg.values.enabled) {
      return { text: `Error: unit "${unit.name}" is disabled in the fleet config (${cfg.configPath}).`, isError: true };
    }

    // model: an explicit arg is validated hard; a configured default that is
    // not in the catalog is ignored with a warning (vendor default applies).
    let model = typeof args.model === 'string' ? args.model.trim() : '';
    if (!model && cfg.values.model) {
      if (unit.catalog.isAllowedModel(cfg.values.model)) model = cfg.values.model;
      else warnOnce(`config: default model "${cfg.values.model}" is not in the catalog — using the vendor default`);
    }
    let effort = typeof args.effort === 'string' ? args.effort.trim().toLowerCase() : '';
    if (!effort && unit.catalog.efforts.length && cfg.values.effort) {
      if (unit.catalog.isAllowedEffort(cfg.values.effort)) effort = cfg.values.effort;
      else warnOnce(`config: default effort "${cfg.values.effort}" is not allowed — using the vendor default`);
    }

    const promptText = typeof args.prompt === 'string' ? args.prompt : (typeof args.question === 'string' ? args.question : '');
    const token = status.start(name, promptText, model, effort);
    const finish = (text, isError = false, extra) => {
      status.end(token, isError ? 'error' : 'ok', isError ? text : null, extra);
      return isError ? { text, isError: true } : { text };
    };

    if (model && !unit.catalog.isAllowedModel(model)) {
      return finish(`Error: unknown model "${model}". Allowed: ${unit.catalog.modelEnum().join(', ')}. Call ${unit.name}_models for guidance.`, true);
    }
    if (effort && unit.catalog.efforts.length && !unit.catalog.isAllowedEffort(effort)) {
      return finish(`Error: unknown effort "${effort}". Allowed: ${unit.catalog.effortEnum().join(', ')}.`, true);
    }
    if (tool.mutateGate) {
      const m = MUTATE_RE.exec(typeof args.prompt === 'string' ? args.prompt : '');
      if (m) return finish(`${unit.label} cannot run git / deploy / publish work ("${m[0]}") — that goes to Claude.`, true);
    }

    const ctx = {
      cfg: cfg.values,
      mode: cfg.values.mode,
      model,
      effort,
      log,
      catalog: unit.catalog,
      home: cfg.home,
      spawn: (o) => spawnFor(cfg, o),
      retry: boundedRetry,
    };
    try {
      const r = await tool.run(args, ctx);
      const text = typeof r === 'string' ? r : (r && r.text) || '';
      const extra = r && typeof r === 'object' && r.usage ? { usage: r.usage } : undefined;
      // An adapter that refused the call itself says so with isError — otherwise
      // MCP would report "prompt is required" as a successful answer.
      const isError = !!(r && typeof r === 'object' && r.isError);
      return finish(text || `(empty response from ${unit.label})`, isError, extra);
    } catch (e) {
      return finish(`${unit.label} error: ${(e && e.message) || e}`, true);
    }
  }

  // tools/list must show only the public MCP shape.
  const tools = unit.tools.map(({ run, kind, mutateGate, ...pub }) => pub);
  return { log, status, callTool, cfgFor, tools };
}

/** Start the unit as an MCP stdio server on this process. */
export function startUnit(unit, opts = {}) {
  const rt = createUnitRuntime(unit, opts);
  const cfg = rt.cfgFor();
  for (const w of cfg.warnings) rt.log('config: ' + w);
  rt.log(
    `up · bin=${resolveBin(unit, opts.env)} · mode=${cfg.values.mode}` +
    `${cfg.values.requestedMode !== cfg.values.mode ? ` (requested ${cfg.values.requestedMode}, ceiling closed)` : ''}` +
    ` · hard-kill=${cfg.values.timeoutS}s · default-model=${cfg.values.model || '(vendor default)'}` +
    ` · status=${cfg.values.status ? cfg.home : 'off'} · config=${cfg.configPath}`,
  );
  serve({ serverInfo: { name: unit.serverName, version: unit.version }, tools: rt.tools, callTool: rt.callTool, log: rt.log });
  return rt;
}
