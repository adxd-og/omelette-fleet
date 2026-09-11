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
 *   instructions: 'This unit: Codex …',  // one line appended to the fleet contract in initialize.instructions
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
 * tool.kind: research | review | image | pipeline | catalog | local. `catalog`
 * tools never spawn and are answered by the runtime from the unit's catalog;
 * `local` tools never spawn either but DO get `run(args, ctx)` with a reduced
 * ctx (`cfg, mode, log, catalog, home`, plus a `usedModel` that does nothing —
 * there is no record for a report to reach — and no `spawn`, no `retry`), and like a
 * catalog read they are answered in-process, never tracked by the status feed
 * and never written to the result spool. The runtime appends one `local` tool
 * of its own to every unit — `<unit>_result`, which hands back an answer the
 * client dropped — unless the adapter already declares that name.
 * Every other kind gets `run(args, ctx)` with ctx = { cfg, mode, model, effort,
 * spawn, retry, log, catalog, home, signal, usedModel }
 * and returns a string or { text, usage?, isError?, partial? }.
 * `ctx.spawn({ args, cwd?, stdinText?, extraEnv?, hardKillMs?, outputCap? })`
 * resolves to core/spawn.mjs's result — `{ stdout, stderr, code, signal,
 * killed, capped }`. Both bounds come from the unit's config (`timeoutS`,
 * `outputCap`) unless the call passes its own. `capped: true` means the tail
 * cap dropped the BEGINNING of stdout: the adapter's parser is reading a
 * fragment and must say so rather than pass it off as a whole answer.
 * `partial: true` marks an answer whose run did not finish (a hard kill whose
 * captured text was kept): still a success, still `isError: false`, and the
 * flag travels to the status feed's `end()` extra next to `usage`. Both reach
 * the spooled record as well: `usage` is filed on it verbatim, and
 * core/results.mjs writes its `usage:` header line only for a reported
 * input/output pair — a vendor that said nothing leaves no line, not a zero.
 * `ctx.signal` is an AbortSignal when the unit's `cancel` is `kill` and the
 * request was cancelled-capable, and `undefined` otherwise: a pipeline checks
 * it between stages so a cancelled request stops spending spawns. Under
 * `cancel: finish` nothing is passed down and the run ends normally.
 * `isError: true` is how an adapter reports a REFUSAL it handled itself
 * (missing prompt, bad cwd, bad imagePath): the text is the error, MCP is told
 * so, and the status feed records "error" — a run that returns `Error: ...`
 * text without the flag would be reported to the caller as a success.
 * `ctx.usedModel(id)` is how an adapter says which model it ACTUALLY asked the
 * vendor for when the runtime named none — codex pins the catalog head because
 * `--ignore-user-config` means the operator's own default never applies. It is
 * a report, not a setting: `ctx.model` does not change, the status feed does
 * not change, and the only thing it reaches is the `model:` line of the
 * spooled result, which would otherwise be empty for exactly the runs whose
 * model nobody could name afterwards. The first non-empty string wins and
 * every later call is ignored, so a retried run cannot file two answers about
 * one call; anything that is not a non-empty string is not a report; and it is
 * never checked against the catalog, because what the CLI was told is the fact
 * worth filing. A `local` tool gets a no-op of the same name: it produces no
 * record, and an adapter helper shared with a spawn tool must not have to ask.
 */
import { resolve as resolvePath } from 'node:path';
import { serve } from './jsonrpc.mjs';
import { contractFor, unitInstructions } from './rules.mjs';
import { runProcess } from './spawn.mjs';
import { createStatus, previewText } from './status.mjs';
import { unitConfig } from './config.mjs';
import { createResultStore, formatEntry, isValidResultId, renderResult } from './results.mjs';
import { makeLog, makeOnceLog } from './log.mjs';
import { VERSION, announceUpdate } from './update.mjs';

export const TOOL_KINDS = new Set(['research', 'review', 'image', 'pipeline', 'catalog', 'local']);

/** How often a running call reports progress to a client that asked for it. */
export const PROGRESS_EVERY_MS = 30000;

/**
 * The id one spawn-tool call is filed under: sortable, unique within a process,
 * and INDEPENDENT of the status feed (which is off in plenty of installs). It
 * is what a caller quotes to fetch a result the client dropped.
 */
export function makeResultId(seq, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${process.pid}-${seq}`;
}

/** Git/deploy/publish intent stays with the manager — units are research and review peers. */
export const MUTATE_RE = /\bgit (push|commit|merge|rebase|reset|tag)\b|\bnpm publish\b|\bdeploy\b/i;

/**
 * The `model:` a result is filed under when nobody named one. Grok and gemini
 * hand the choice to their CLI and never learn the id it took, so an empty
 * header line was the honest-but-useless answer; this is the honest one.
 */
export const VENDOR_DEFAULT_MODEL = '(vendor default)';

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
    // The package's own version (core/update.mjs reads package.json once at
    // load): `initialize` must not keep reporting a number that was frozen into
    // this file at some earlier release. An adapter may still override it.
    version: VERSION,
    label: spec.name,
    instructions: '',
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

/**
 * The executable this unit spawns. A `<UNIT>_BIN` override that CONTAINS A
 * PATH SEPARATOR is a path, and a relative one means the directory the SERVER
 * was started in — so it is made absolute here, and `createUnitRuntime` does it
 * ONCE at unit start. Every tool then spawns the same executable whatever `cwd`
 * a caller asks the run to happen in: the OS resolves a relative command
 * against the CHILD's cwd, so an unresolved override would be a different
 * binary — or none — per call. A bare name is not a path and is left alone:
 * that one is for PATH to resolve.
 */
export function resolveBin(unit, env = process.env) {
  const bin = (unit.bin.env && env[unit.bin.env]) || unit.bin.default;
  return bin && (bin.includes('/') || bin.includes('\\')) ? resolvePath(bin) : bin;
}

/**
 * One bounded retry on empty output — safe for read-only one-shots. `skipIf(err)`
 * names the deterministic failures a retry cannot fix (auth, quota, permission).
 * `signal` (passed only under `cancel: kill`) ends the delay and cancels the
 * second attempt: a request nobody is waiting for buys nothing by trying again.
 */
export async function boundedRetry(fn, { skipIf = () => false, delayMs = 1500, signal } = {}) {
  try {
    const r = await fn();
    if (r && (typeof r === 'string' ? r.trim() : r.text)) return r;
  } catch (e) {
    if (skipIf(e)) throw e;
  }
  if (signal && signal.aborted) throw new Error('cancelled');
  await new Promise((resolve) => {
    function done() {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    const t = setTimeout(done, delayMs);
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
  if (signal && signal.aborted) throw new Error('cancelled');
  return fn();
}

/**
 * The `<unit>_result` answer. With an id: that result's file body. Without
 * one: the newest in full, then a directory of the last ten — which is what a
 * caller who lost an answer to a timeout actually needs, since it does not
 * know the id it never received.
 */
function answerResult(store, args, unitName) {
  const raw = args && args.id;
  const asked = typeof raw === 'string' ? raw.trim() : (raw === undefined || raw === null ? '' : raw);
  if (asked !== '') {
    // Validated BEFORE a path exists: no traversal reaches the filesystem.
    if (!isValidResultId(asked)) {
      return {
        text: `Error: ${JSON.stringify(String(asked).slice(0, 80))} is not a result id — they look like 20260908T142501Z-19312-1. Call ${unitName}_result with no id for the newest.`,
        isError: true,
      };
    }
    const one = store.read(asked);
    if (!one) {
      return { text: `Error: no spooled result "${asked}" for ${unitName} — it may have been pruned. Call ${unitName}_result with no id for the newest.`, isError: true };
    }
    return { text: renderResult({ ...one.header, text: one.text }) };
  }
  const recent = store.list(10);
  const newest = recent.length ? store.read(recent[0].resultId) : null;
  if (!newest) {
    return { text: `Error: the ${unitName} result spool is empty — nothing has been spooled yet, or ${unitName}.results is false in the fleet config.`, isError: true };
  }
  return {
    text: `${renderResult({ ...newest.header, text: newest.text })}\n\nRecent results:\n${recent.map((e) => formatEntry(e)).join('\n')}`,
  };
}

/**
 * Build the runtime (config, status, callTool) for a unit without touching stdin/stdout.
 * `progressEveryMs` and `onResult` are seams: the first lets a test drive the
 * progress ticker on a fast clock, the second REPLACES the result spool — the
 * default hook writes the record to core/results.mjs, and a caller that passes
 * its own is the only way to see the record a finished call produces.
 * `cancel` is the third and the narrowest: `'kill'` or `'finish'` overrides
 * `cfg.values.cancel` for THIS runtime instance only, and changes nothing for
 * anyone else — the operator's config is not read differently, not rewritten
 * and not reloaded. INTERNAL to `doctor --probe-sandbox`, which owns a
 * deadline of its own and needs the abort it raises to reach the vendor
 * process group: under `finish` the runtime passes no signal down, and the
 * probe would walk away from a child that keeps running on the operator's
 * subscription. Anything else — undefined included — means "whatever the
 * config says", which is what every unit server gets.
 */
export function createUnitRuntime(unit, { env = process.env, progressEveryMs = PROGRESS_EVERY_MS, onResult = null, cancel = null } = {}) {
  const log = makeLog(unit.name);
  const warnOnce = makeOnceLog(log);
  // ONCE, at unit start, in the SERVER's own cwd: a relative override is
  // resolved here or the executable would depend on where each call runs.
  const bin = resolveBin(unit, env);
  let resultSeq = 0;
  const cfgFor = () => unitConfig({
    unit: unit.name, envMap: unit.envMap, builtin: unit.builtin, extraSchema: unit.extraSchema,
    supportedModes: unit.supportedModes, env,
  });
  /** One store per resolution: `results*` are ordinary config keys and reload like the rest. */
  const storeFor = (cfg) => createResultStore({
    home: cfg.home,
    unit: unit.name,
    keep: cfg.values.resultsKeep,
    maxBytes: cfg.values.resultsMaxBytes,
    log,
  });
  // Every unit answers `<unit>_result`: a spool nobody can read back is a spool
  // that never repaid the call it saved. Appended here rather than declared per
  // adapter so no unit can forget it — and an adapter that declares its own
  // keeps it.
  const resultToolName = `${unit.name}_result`;
  const resultTool = {
    name: resultToolName,
    kind: 'local',
    description:
      `Fetch a spooled ${unit.label} result — the answer a dropped request, a cancellation or a client restart lost. `
      + 'No id: the newest answer in full, then the last 10, one line each. With an id: that answer. '
      + 'Reads a file this unit already wrote; spends nothing and starts no run.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'A result id like 20260908T142501Z-19312-1 (from a listing, or the status feed\'s resultId). Omit for the newest.',
        },
      },
    },
    run: (args) => answerResult(storeFor(cfgFor()), args, unit.name),
  };
  const allTools = unit.tools.some((t) => t.name === resultToolName) ? unit.tools : [...unit.tools, resultTool];
  // Neither a catalog read nor a `local` tool spawns anything, so neither is
  // tracked by the feed — and neither is spooled.
  const spawnTools = new Set(allTools.filter((t) => t.kind !== 'catalog' && t.kind !== 'local').map((t) => t.name));
  const status = createStatus({
    unit: unit.name,
    spawnTools,
    resolve: () => { const c = cfgFor(); return { dir: c.home, enabled: c.values.status }; },
  });
  status.boot();
  // Retention runs at boot as well as after every write: a `resultsKeep`
  // lowered while this server was down should not wait for the next call.
  const bootCfg = cfgFor();
  if (bootCfg.values.results) storeFor(bootCfg).prune();

  function spawnFor(cfg, { args, cwd, stdinText, extraEnv, hardKillMs, outputCap }, signal) {
    const timeoutMs = hardKillMs ?? cfg.values.timeoutS * 1000;
    // Both bounds come from the unit's config unless this call knows better.
    // The config value is a validated posint; a call's is not, and `slice(-0)`
    // keeps the WHOLE string — an adapter passing 0 would silently UNCAP stdout.
    const asked = Number(outputCap ?? cfg.values.outputCap);
    const cap = Number.isFinite(asked) ? Math.max(1, Math.floor(asked)) : cfg.values.outputCap;
    log(`spawn · bin=${bin} · argc=${args.length} · cwd=${cwd || '(process cwd)'} · hard-kill=${Math.round(timeoutMs / 1000)}s · output-cap=${cap}`);
    return runProcess({
      // env is the PARENT env to select from: core/spawn.mjs builds the child
      // from the allowlist + this unit's passthrough, never by inheritance.
      bin, args, cwd, env, envPassthrough: unit.envPassthrough, extraEnv,
      scrubEnv: unit.billingRiskEnv,
      hardKillMs: timeoutMs, signal, stdinText, outputCap: cap, log,
      notFoundHelp: `${bin} not found in PATH — install the ${unit.label} CLI${unit.bin.env ? ` or point ${unit.bin.env} at it` : ''}`,
    }).then((res) => {
      // Auth check ONLY on empty-stdout runs: a real answer that merely mentions
      // signing in must never false-positive.
      if (unit.auth && !res.stdout.trim() && unit.auth.detect(res.stderr)) throw new Error(unit.auth.help);
      return res;
    });
  }

  async function callTool(name, args = {}, call = {}) {
    const tool = allTools.find((t) => t.name === name);
    if (!tool) return { text: `Error: unknown tool "${name}".`, isError: true };
    if (tool.kind === 'catalog') return { text: unit.catalog.render() };

    const cfg = cfgFor();
    for (const w of cfg.warnings) warnOnce('config: ' + w);

    // A `local` tool is answered right here: no spawn, no status feed entry, no
    // spool. Like a catalog read it still answers while the unit is disabled —
    // what it serves was produced before someone switched the unit off.
    if (tool.kind === 'local') {
      try {
        const r = await tool.run(args, {
          cfg: cfg.values,
          mode: cfg.values.mode,
          log,
          catalog: unit.catalog,
          home: cfg.home,
          // A no-op: there is no record for a report to reach. Present so an
          // adapter helper shared with a spawn tool can call it unconditionally.
          usedModel: () => {},
          // No `signal` either: a tool that never spawns has nothing to cancel.
        });
        const text = typeof r === 'string' ? r : (r && r.text) || '';
        const isError = !!(r && typeof r === 'object' && r.isError);
        return isError
          ? { text, isError: true }
          : { text: text || `(empty response from ${unit.label})` };
      } catch (e) {
        return { text: `${unit.label} error: ${(e && e.message) || e}`, isError: true };
      }
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

    // What the adapter actually asked the vendor for, when the runtime named
    // nothing. Declared here so `finish()` below closes over it.
    let reportedModel = '';
    const usedModel = (id) => {
      if (reportedModel || typeof id !== 'string') return;
      const trimmed = id.trim();
      if (trimmed) reportedModel = trimmed;
    };

    const promptText = typeof args.prompt === 'string' ? args.prompt : (typeof args.question === 'string' ? args.question : '');
    const resultId = makeResultId(++resultSeq);
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const token = status.start(name, promptText, model, effort, resultId);
    // Progress exists for one reason: a stdio tool call that sends neither a
    // response nor a `notifications/progress` for 30 minutes is aborted for
    // idleness by the client, whatever the wall-clock timeout says. Only for a
    // client that supplied a token, only while the call runs, cleared in
    // finish() — nothing is ever sent after the response.
    let ticker = null;
    if (call.progressToken != null && typeof call.notify === 'function') {
      ticker = setInterval(() => {
        const elapsed = Math.round((Date.now() - t0) / 1000);
        call.notify('notifications/progress', {
          progressToken: call.progressToken,
          progress: elapsed,
          message: `${unit.name} ${name} running · ${elapsed}s`,
        });
      }, progressEveryMs);
      if (ticker.unref) ticker.unref();
    }
    // The ticker also stops on the cancellation, not only on the response:
    // under `cancel: finish` the run is deliberately left to end, and telling a
    // client that has gone away how its abandoned run is doing helps nobody.
    let detachTicker = () => {};
    const clearProgress = () => {
      if (ticker) { clearInterval(ticker); ticker = null; }
      detachTicker();
      detachTicker = () => {};
    };
    if (ticker && call.signal) {
      try {
        call.signal.addEventListener('abort', clearProgress, { once: true });
        detachTicker = () => {
          try { call.signal.removeEventListener('abort', clearProgress); } catch { /* not a real signal */ }
        };
      } catch { /* not a real signal: the ticker still stops in finish() */ }
    }

    // `cancel` decides what a client's cancellation does to this run:
    //   finish — the vendor CLI is left to end; the result is recorded and
    //            marked `detached` (no response is sent: the handler drops it);
    //   kill   — the signal goes down to every spawn and pending retry delay,
    //            and the call ends with the outcome `cancelled`.
    // A runtime built with an explicit `cancel` (doctor's probe, and nothing
    // else) overrides the config for that instance alone; a value that is
    // neither of the two is not an override.
    const cancelMode = cancel === 'kill' || cancel === 'finish' ? cancel : cfg.values.cancel;
    const killSignal = cancelMode === 'kill' && call.signal ? call.signal : undefined;

    // The result spool. `finish()` calls this synchronously, before it returns,
    // so the answer is on disk before serve() can send anything — and before a
    // client that has already timed out is told anything at all. The store is
    // built from the config live at THIS call, so `results*` reload like every
    // other key; an `onResult` handed to createUnitRuntime replaces the spool.
    const recordResult = onResult || ((record) => {
      if (cfg.values.results) storeFor(cfg).write(record);
    });

    const finish = (text, isError = false, extra) => {
      clearProgress();
      const aborted = !!(call.signal && call.signal.aborted);
      const cancelled = aborted && cancelMode === 'kill';
      const detached = aborted && !cancelled;
      const outcome = cancelled ? 'cancelled' : (isError ? 'error' : 'ok');
      status.end(token, outcome, isError ? text : null, {
        ...(extra || {}), resultId, ...(detached ? { detached: true } : {}),
      });
      // The record is built on EVERY finished spawn-tool call, feed on or off,
      // because the feed is not what keeps an answer: it keeps an event.
      try {
        recordResult({
          resultId,
          tool: name,
          // Never empty: what the caller or the config asked for, else what
          // the adapter says it pinned, else the vendor's own choice, named.
          model: model || reportedModel || VENDOR_DEFAULT_MODEL,
          effort,
          // The tokens the adapter reported — the SAME object the status feed's
          // `end` event carries — or null when the vendor said nothing about
          // them (every image run, a stream that carried no counts). The header
          // writes a line only for a reported pair, so "nothing" is never filed
          // as a zero, and a reader can tell the two apart afterwards.
          usage: (extra && extra.usage) || null,
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          status: outcome,
          partial: !!(extra && extra.partial),
          detached,
          cwd: typeof args.cwd === 'string' ? args.cwd : '',
          promptPreview: previewText(promptText),
          text,
        });
      } catch (e) { log('result hook: ' + ((e && e.message) || e)); }
      return isError ? { text, isError: true } : { text };
    };

    // Below finish() on purpose: a call refused because the unit is switched
    // off is still an answer the caller may have lost, so it is spooled like
    // every other refusal — and, like them, it is an `error` in the feed too.
    if (!cfg.values.enabled) {
      return finish(`Error: unit "${unit.name}" is disabled in the fleet config (${cfg.configPath}).`, true);
    }

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
      usedModel,
      catalog: unit.catalog,
      home: cfg.home,
      spawn: (o) => spawnFor(cfg, o, killSignal),
      retry: (fn, opts = {}) => boundedRetry(fn, { ...opts, signal: killSignal }),
      // Present under `cancel: kill` only: under `finish` there is nothing for
      // an adapter to observe, because the run is deliberately left to end.
      signal: killSignal,
    };
    try {
      const r = await tool.run(args, ctx);
      const text = typeof r === 'string' ? r : (r && r.text) || '';
      // `partial: true` — a hard-killed run whose captured answer we kept — is a
      // SUCCESS that says so: the status stays "ok" and the marker in the text
      // is what a reader acts on; the feed carries the flag for a supervisor.
      const extra = r && typeof r === 'object' && (r.usage || r.partial)
        ? { ...(r.usage ? { usage: r.usage } : {}), ...(r.partial ? { partial: true } : {}) }
        : undefined;
      // An adapter that refused the call itself says so with isError — otherwise
      // MCP would report "prompt is required" as a successful answer.
      const isError = !!(r && typeof r === 'object' && r.isError);
      return finish(text || `(empty response from ${unit.label})`, isError, extra);
    } catch (e) {
      return finish(`${unit.label} error: ${(e && e.message) || e}`, true);
    }
  }

  // tools/list must show only the public MCP shape.
  const tools = allTools.map(({ run, kind, mutateGate, ...pub }) => pub);
  return { log, status, callTool, cfgFor, tools, bin };
}

/** Start the unit as an MCP stdio server on this process. */
export function startUnit(unit, opts = {}) {
  const rt = createUnitRuntime(unit, opts);
  const cfg = rt.cfgFor();
  for (const w of cfg.warnings) rt.log('config: ' + w);
  // WHERE THIS SERVER STANDS decides how much contract it sends: Claude Code
  // starts an MCP server in the session's project directory, so a project
  // that carries the rendered rules file already has everything the full
  // contract says — and more — in the same context. Resolved ONCE, here, like
  // `bin`: a rules file written later reaches the next session, which is when
  // the rules file itself starts applying too. The RESOLVED answer goes to the
  // log line and to the instructions — one read of the file, so a rules file
  // that appears or vanishes between them cannot make the two disagree.
  const where = { cwd: process.cwd(), env: opts.env || process.env };
  const contract = contractFor(where);
  rt.log(
    `up · bin=${rt.bin} · mode=${cfg.values.mode}` +
    `${cfg.values.requestedMode !== cfg.values.mode ? ` (requested ${cfg.values.requestedMode}, ceiling closed)` : ''}` +
    ` · hard-kill=${cfg.values.timeoutS}s · default-model=${cfg.values.model || VENDOR_DEFAULT_MODEL}` +
    ` · contract=${contract.short ? 'short' : 'full'} (${contract.reason})` +
    ` · status=${cfg.values.status ? cfg.home : 'off'} · config=${cfg.configPath}`,
  );
  // "There is a newer fleet" is worth one stderr line and nothing more: the
  // check is fire-and-forget (the server is serving before it answers), capped
  // at 2.5s, cached for a day, and skipped entirely when it is switched off.
  // `.then` only — core/update.mjs guarantees this promise cannot reject, and a
  // rejection here would take down a live MCP server for a version string.
  announceUpdate({
    home: cfg.home,
    current: VERSION,
    env: opts.env || process.env,
    log: rt.log,
  }).then(() => {});
  serve({
    serverInfo: { name: unit.serverName, version: unit.version },
    // The contract resolved above, not a second read of the same file.
    instructions: unitInstructions(unit, { ...where, contract }),
    tools: rt.tools,
    callTool: rt.callTool,
    log: rt.log,
    env: opts.env || process.env,
  });
  return rt;
}
