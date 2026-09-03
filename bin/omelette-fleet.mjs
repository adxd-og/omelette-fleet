#!/usr/bin/env node
/**
 * omelette-fleet :: bin/omelette-fleet.mjs
 * The operator's command line: wire the units into Claude Code, see what a
 * unit actually resolved to, and call a tool by hand.
 *
 * NEVER SHELLS OUT. Every child is spawn(bin, [args]) through core/spawn.mjs —
 * a prefix, a config value or a home directory with a space in it is data, not
 * shell syntax, and there is no quoting rule anyone has to remember.
 *
 * ABSOLUTE PATHS FROM import.meta.url, never from cwd: an MCP registration
 * outlives the shell that created it, so `-- node ./servers/codex.mjs` would
 * be a server that only starts when Claude happens to run from this checkout.
 *
 * INSTALL IS IDEMPOTENT: `claude mcp add` refuses a name that already exists,
 * so every unit gets a `remove` first. A failed remove is the NORMAL case on a
 * first install and is ignored — only the `add` decides success.
 *
 * --dry-run IS THE TESTED PATH. Everything that would change the machine
 * (claude commands, the config file) prints instead of running, so the whole
 * install flow can be exercised in CI with no vendor CLI and no `claude`.
 *
 * DOCTOR NEVER GUESSES. A probe whose output it cannot read is "unknown", not
 * "signed out" — a wrong diagnosis costs more than no diagnosis. And only the
 * combination enabled-in-config AND registered AND broken sets exit 1: a unit
 * you deliberately never wired up is not a fault.
 *
 * READ-ONLY ABOUT THE MACHINE: ~/.claude.json is parsed, never written — the
 * only writer of Claude Code's config is `claude` itself. The only file this
 * CLI writes is <home>/fleet.config.json.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../core/spawn.mjs';
import { callUnitServer } from '../core/client.mjs';
import { KEY_SCHEMA, coerce, configPath, fleetHome, unitConfig, writeFleetConfig } from '../core/config.mjs';
import { resolveBin } from '../core/unit.mjs';
import codexUnit, { buildArgs as buildCodexArgs, extractResult as extractCodexResult } from '../units/codex/adapter.mjs';
import geminiUnit from '../units/gemini/adapter.mjs';
import grokUnit from '../units/grok/adapter.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const UNITS = { gemini: geminiUnit, grok: grokUnit, codex: codexUnit };
const UNIT_ORDER = ['gemini', 'grok', 'codex'];
const DEFAULT_PREFIX = 'omelette';
const EXAMPLE_CONFIG = join(ROOT, 'examples', 'fleet.config.json');

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s = '') => process.stderr.write(s + '\n');
const serverPathFor = (name) => join(ROOT, 'servers', `${name}.mjs`);
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const schemaFor = (name) => ({ ...KEY_SCHEMA, ...(UNITS[name].extraSchema || {}) });
const firstLine = (s) => String(s || '').trim().split('\n')[0].trim();

/** Resolve one unit's config through the same layers the running server sees. */
const cfgFor = (name, env = process.env) => {
  const u = UNITS[name];
  return unitConfig({
    unit: u.name, envMap: u.envMap, builtin: u.builtin, extraSchema: u.extraSchema,
    supportedModes: u.supportedModes, env,
  });
};

const HELP = `omelette-fleet ${PKG.version} — plug Gemini, Grok and Codex into Claude Code as read-only units.

USAGE
  omelette-fleet install   [--prefix <name>] [--units <a,b,c>] [--dry-run] [--force]
  omelette-fleet uninstall [--prefix <name>] [--units <a,b,c>] [--dry-run]
  omelette-fleet doctor    [--prefix <name>] [--probe-models]
  omelette-fleet show      [<unit>]
  omelette-fleet set       <unit>.<key>=<value> [...]
  omelette-fleet call      <unit> <tool> [json-args] [--timeout <seconds>]
  omelette-fleet --help | --version

COMMANDS
  install    Register one MCP server per unit with \`claude mcp add -s user\`
             as <prefix>-<unit>, and create <home>/fleet.config.json from the
             shipped example if it does not exist yet (never overwritten).
             A unit whose vendor CLI is not in PATH is skipped unless --force.
             --dry-run prints every command and every write, and runs nothing.
  uninstall  Remove those servers again (\`claude mcp remove -s user\`). The
             fleet config and the status files are never touched.
  doctor     Per unit: the vendor binary, its --version, the login state, the
             resolved fleet config with sources, the MCP registration and
             whether the status feed is writable. Exits 1 when a unit that is
             enabled AND registered has a missing binary or is signed out.
             --probe-models spends real Codex calls to test every catalog id.
  show       Every config key for one unit or all of them: value, where it came
             from (default / file:defaults / file / env:NAME), and the ceiling.
  set        Change keys in <home>/fleet.config.json. Unknown units, unknown
             keys and invalid values are refused; the rest of the file is kept.
  call       Drive a unit's MCP server over real stdio (initialize →
             tools/list → tools/call) and print the result. Exit 2 = the tool
             answered with an error, 1 = the server never answered.

UNITS
  gemini  Google Gemini via the Antigravity CLI (agy)
  grok    xAI Grok via the grok CLI
  codex   OpenAI Codex via the codex CLI

ENVIRONMENT
  OMELETTE_HOME         fleet home (default ~/.omelette): config + status feed
  OMELETTE_ALLOW_WRITE  comma-separated units allowed past read-only (the ceiling)
  OMELETTE_STATUS       0/1 — status feed off/on for every unit
  AGY_BIN GROK_BIN CODEX_BIN
                        point a unit at a specific vendor binary

EXAMPLES
  omelette-fleet install --dry-run
  omelette-fleet install --units codex,gemini
  omelette-fleet doctor
  omelette-fleet set codex.timeoutS=900 gemini.model="Gemini 3.8 Flash (High)"
  omelette-fleet call codex codex_models '{}'`;

// ─── argv ────────────────────────────────────────────────────────────────────

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Booleans (`--flag`) and options (`--opt value` / `--opt=value`); everything else is positional. */
function parseArgv(argv, { booleans = [], options = [] } = {}) {
  const flags = {};
  const positional = [];
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    const inline = eq >= 0 ? a.slice(eq + 1) : null;
    if (booleans.includes(name)) { flags[camel(name)] = inline === null || !/^(0|false|no)$/i.test(inline); continue; }
    if (options.includes(name)) {
      const v = inline !== null ? inline : argv[++i];
      if (v === undefined) errors.push(`--${name} needs a value`);
      else flags[camel(name)] = v;
      continue;
    }
    errors.push(`unknown flag: ${a}`);
  }
  return { flags, positional, errors };
}

/** `--units a,b` → validated unit names, defaulting to all of them in a stable order. */
function selectUnits(raw, errors) {
  if (raw === undefined) return UNIT_ORDER.slice();
  const names = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length) { errors.push('--units needs at least one unit name'); return []; }
  const bad = names.filter((n) => !UNITS[n]);
  if (bad.length) errors.push(`unknown unit(s): ${bad.join(', ')} — known units: ${UNIT_ORDER.join(', ')}`);
  return UNIT_ORDER.filter((n) => names.includes(n));
}

/** The prefix becomes an MCP server name; keep it to what a name may contain. */
function selectPrefix(raw, errors) {
  const p = raw === undefined ? DEFAULT_PREFIX : String(raw).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)) errors.push(`--prefix "${p}" must be letters, digits, dot, dash or underscore`);
  return p;
}

// ─── machine probes ──────────────────────────────────────────────────────────

/** Resolve a command the way execvp does: an explicit path is checked as-is, a bare name walks PATH. */
function whichBin(bin, env = process.env) {
  if (!bin) return null;
  const isExec = (p) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
  if (bin.includes('/') || bin.includes('\\')) { const p = resolvePath(bin); return isExec(p) ? p : null; }
  const exts = process.platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) { const p = join(dir, bin + ext); if (isExec(p)) return p; }
  }
  return null;
}

/**
 * Every vendor probe runs in the SAME environment the MCP server would give
 * that CLI — core/spawn.mjs's allowlist plus the unit's own passthrough, minus
 * its billing-risk keys. Diagnosing a login against a richer environment than
 * the server actually uses is how doctor would say "OK" about a unit whose
 * tool calls then fail (and how a probe could quietly bill a metered API key).
 */
const probeEnv = (unit) => ({ envPassthrough: unit.envPassthrough, scrubEnv: unit.billingRiskEnv });

/** `<bin> --version`, hard-killed at 10s — a hung version probe must not hang doctor. */
async function probeVersion(unit, binPath) {
  let r;
  try { r = await runProcess({ bin: binPath, args: ['--version'], hardKillMs: 10000, ...probeEnv(unit) }); }
  catch (e) { return `unknown (${(e && e.message) || e})`; }
  if (r.killed) return 'timeout (no answer in 10s)';
  const line = firstLine(r.stdout) || firstLine(r.stderr);
  if (line) return line.slice(0, 120);
  return r.code === 0 ? 'unknown (no output)' : `unknown (exit ${r.code})`;
}

/**
 * Login state per vendor, each with its own honest signal:
 *   codex  `codex login status` → stdout contains "Logged in"
 *   grok   `grok models`        → /not authenticated|not signed in/ = signed out
 *   agy    `agy models`         → exit 0 with at least one line = OK
 * Anything else is `unknown`. 20s ceiling: these are local calls or a cheap
 * API round-trip, never a model run.
 */
async function probeLogin(unit, binPath) {
  const name = unit.name;
  const argsFor = { codex: ['login', 'status'], grok: ['models'], gemini: ['models'] }[name];
  const cmd = `${name === 'gemini' ? 'agy' : name} ${argsFor.join(' ')}`;
  let r;
  try { r = await runProcess({ bin: binPath, args: argsFor, hardKillMs: 20000, ...probeEnv(unit) }); }
  catch (e) { return { state: 'unknown', detail: `${cmd}: ${(e && e.message) || e}` }; }
  if (r.killed) return { state: 'unknown', detail: `${cmd}: timeout (no answer in 20s)` };
  const both = `${r.stdout}\n${r.stderr}`;
  const lines = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (name === 'codex') {
    // `codex login status` writes its answer to stderr in some builds and to
    // stdout in others, so read BOTH streams — looking at only one is how this
    // reported "unknown — exit 0, Logged in using ChatGPT". The "not logged in"
    // guard earns its keep because that phrase contains "logged in" too.
    const loggedIn = both.split('\n').map((s) => s.trim())
      .find((s) => /logged in/i.test(s) && !/not logged in/i.test(s));
    if (r.code === 0 && loggedIn) return { state: 'in', detail: loggedIn };
    // A non-zero exit is codex's own way of saying "no session" — take it as one.
    if (r.code !== 0 || /not logged in|login required/i.test(both)) {
      return { state: 'out', detail: 'signed out — run `codex login`' };
    }
    return { state: 'unknown', detail: `${cmd}: exit ${r.code}, ${firstLine(both) || 'no output'}` };
  }
  if (name === 'grok') {
    if (/not authenticated|not signed in/i.test(both)) return { state: 'out', detail: 'signed out — run `grok login`' };
    if (r.code === 0 && lines.length) return { state: 'in', detail: `${cmd} listed ${lines.length} line(s)` };
    return { state: 'unknown', detail: `${cmd}: exit ${r.code}, ${firstLine(both) || 'no output'}` };
  }
  // agy: exit 0 with output is the only positive signal, and only an explicit
  // phrase is a negative one — "login" appearing in prose proves nothing.
  if (r.code === 0 && lines.length) return { state: 'in', detail: `${cmd} listed ${lines.length} line(s)` };
  if (/not authenticated|not signed in|not logged in/i.test(both)) return { state: 'out', detail: 'signed out — run `agy` once and sign in' };
  return { state: 'unknown', detail: `${cmd}: exit ${r.code}, ${firstLine(both) || 'no output'}` };
}

/** Claude Code's own config — parsed, never written. Absence is normal, not an error. */
function readClaudeConfig() {
  const path = join(homedir(), '.claude.json');
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { path, config: isObj(parsed) ? parsed : null, error: isObj(parsed) ? null : 'top-level is not an object' };
  } catch (e) {
    return { path, config: null, error: e && e.code === 'ENOENT' ? 'absent' : (e && e.message) || String(e) };
  }
}

/** Find <prefix>-<unit> in the user scope, then in any project scope. */
function findRegistration(config, serverName) {
  if (!isObj(config)) return null;
  const buckets = [];
  if (isObj(config.mcpServers)) buckets.push(['user', config.mcpServers]);
  if (isObj(config.projects)) {
    for (const [dir, p] of Object.entries(config.projects)) if (isObj(p) && isObj(p.mcpServers)) buckets.push([`project ${dir}`, p.mcpServers]);
  }
  for (const [scope, servers] of buckets) {
    const entry = servers[serverName];
    if (isObj(entry)) {
      const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
      const target = args.find((a) => a.endsWith('.mjs')) || args[args.length - 1] || '';
      return { scope, entry, target, exists: !!target && existsSync(target) };
    }
  }
  return null;
}

/** The status feed is only real if the home directory takes a write — prove it, do not assume it. */
function probeHome(env = process.env) {
  const dir = fleetHome(env);
  const probe = join(dir, `.doctor-${process.pid}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, 'ok', { mode: 0o600 });
    unlinkSync(probe);
    return { dir, writable: true, error: null };
  } catch (e) {
    return { dir, writable: false, error: (e && e.message) || String(e) };
  }
}

// ─── shared rendering ────────────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);
const fmtValue = (v) => (v === '' ? '(unset)' : String(v));

/**
 * One aligned `key value source` block, shared by `show` and `doctor`.
 * `mode` shows what the config ASKED for — `sources.mode` describes that value,
 * not the ceiling-clamped one — with the clamp spelled out inline so nobody
 * reads "workspace-write" off the table and believes it.
 */
function configRows(name, cfg, indent = '  ') {
  const keys = Object.keys(schemaFor(name));
  const shown = (k) => (k !== 'mode' || cfg.values.requestedMode === cfg.values.mode
    ? fmtValue(cfg.values[k])
    : `${cfg.values.requestedMode} (clamped to ${cfg.values.mode})`);
  const w = Math.max(...keys.map((k) => k.length), 5);
  const vw = Math.max(...keys.map((k) => shown(k).length), 5);
  const lines = [`${indent}${pad('KEY', w)}  ${pad('VALUE', vw)}  SOURCE`];
  for (const k of keys) lines.push(`${indent}${pad(k, w)}  ${pad(shown(k), vw)}  ${cfg.sources[k]}`);
  return lines;
}

function ceilingLine(name, cfg) {
  const supportsWrite = !!(UNITS[name].supportedModes && UNITS[name].supportedModes['workspace-write']);
  const parts = [cfg.ceilingOpen
    ? `OPEN — OMELETTE_ALLOW_WRITE lists "${name}"`
    : `closed — OMELETTE_ALLOW_WRITE does not list "${name}"`];
  if (!supportsWrite) parts.push('and this unit refuses workspace-write anyway');
  parts.push(`effective mode: ${cfg.values.mode}`);
  if (cfg.values.requestedMode !== cfg.values.mode) parts.push(`requested: ${cfg.values.requestedMode}`);
  return parts.join(' · ');
}

// ─── install / uninstall ─────────────────────────────────────────────────────

/**
 * `claude` is the OPERATOR's own tool, not a sandboxed model, so it is the one
 * child in this package that runs with `inheritEnv` (core/spawn.mjs): the whole
 * parent environment, because CLAUDE_CONFIG_DIR alone decides WHERE the
 * registration lands and a version manager's variables decide which node runs
 * it. The allowlist exists to keep secrets away from a model, and there is no
 * model in `claude mcp add`.
 */
const runClaude = (bin, argv) => runProcess({ bin, args: argv.slice(1), inheritEnv: true, hardKillMs: 60000 })
  .catch((e) => ({ code: -1, stdout: '', stderr: (e && e.message) || String(e) }));

/** What `install` would do to <home>/fleet.config.json — an existing file is never touched. */
function planConfig(env = process.env) {
  const target = configPath(env);
  return { target, exists: existsSync(target), source: EXAMPLE_CONFIG };
}

function writeConfigFromExample(plan) {
  mkdirSync(dirname(plan.target), { recursive: true });
  writeFileSync(plan.target, readFileSync(plan.source, 'utf8'), { mode: 0o600 });
}

async function cmdInstall(argv) {
  const { flags, positional, errors } = parseArgv(argv, { booleans: ['dry-run', 'force'], options: ['prefix', 'units'] });
  if (positional.length) errors.push(`unexpected argument: ${positional[0]}`);
  const prefix = selectPrefix(flags.prefix, errors);
  const names = selectUnits(flags.units, errors);
  if (errors.length) { errors.forEach((e) => err(`omelette-fleet install: ${e}`)); return 1; }

  const dry = !!flags.dryRun;
  const claudePath = whichBin('claude');
  const cfgPlan = planConfig();
  const plans = names.map((name) => {
    const bin = resolveBin(UNITS[name]);
    const binPath = whichBin(bin);
    const server = serverPathFor(name);
    return {
      name, bin, binPath, server,
      skip: binPath || flags.force ? null : `${bin} not found in PATH`,
      remove: ['claude', 'mcp', 'remove', '-s', 'user', `${prefix}-${name}`],
      add: ['claude', 'mcp', 'add', '-s', 'user', `${prefix}-${name}`, '--', 'node', server],
    };
  });

  out(`FLEET INSTALL · prefix "${prefix}" · servers from ${join(ROOT, 'servers')}`);
  out();

  // `claude` missing is not a failure: print the exact commands and let the
  // operator run them after installing Claude Code.
  if (!claudePath && !dry) {
    out('claude not found in PATH — nothing was registered.');
    out('Install Claude Code, then run these commands yourself:');
    out();
    for (const p of plans) {
      if (p.skip) { out(`  # ${p.name}: ${p.skip} — skipped (re-run with --force to register anyway)`); continue; }
      out(`  ${p.remove.join(' ')}`);
      out(`  ${p.add.join(' ')}`);
    }
    out();
    if (cfgPlan.exists) out(`config  ${cfgPlan.target} already exists — left alone`);
    else { writeConfigFromExample(cfgPlan); out(`config  wrote ${cfgPlan.target} (0600, from ${cfgPlan.source})`); }
    out();
    out('Restart Claude Code to load the new servers.');
    return 0;
  }

  const registered = [];
  const skipped = [];
  const failed = [];
  for (const p of plans) {
    if (p.skip) {
      skipped.push(p.name);
      const hint = UNITS[p.name].bin.env ? ` (install it, or point ${UNITS[p.name].bin.env} at it)` : '';
      out(`${pad(p.name, 7)} ${p.skip}${hint} — SKIPPED, use --force to register anyway`);
      continue;
    }
    out(`${pad(p.name, 7)} ${p.bin} → ${p.binPath || '(not found, --force)'}`);
    if (dry) {
      out(`        would run: ${p.remove.join(' ')}`);
      out(`        would run: ${p.add.join(' ')}`);
      registered.push(p.name);
      continue;
    }
    // A first install has nothing to remove — that failure is expected and ignored.
    await runClaude(claudePath, p.remove);
    const res = await runClaude(claudePath, p.add);
    if (res.code === 0) { registered.push(p.name); out(`        registered ${prefix}-${p.name} → node ${p.server}`); }
    else { failed.push(p.name); out(`        FAILED (exit ${res.code}): ${firstLine(res.stderr) || firstLine(res.stdout) || 'no output'}`); }
  }

  out();
  if (cfgPlan.exists) out(`config  ${cfgPlan.target} already exists — left alone`);
  else if (dry) out(`config  would write ${cfgPlan.target} (0600, copied from ${cfgPlan.source})`);
  else { writeConfigFromExample(cfgPlan); out(`config  wrote ${cfgPlan.target} (0600, from ${cfgPlan.source})`); }

  out();
  const list = registered.map((n) => `${prefix}-${n}`).join(', ') || '(none)';
  if (dry) {
    out(`Nothing was changed (--dry-run). Would register: ${list}.`);
    if (!claudePath) out('Note: claude is not in PATH here — install Claude Code before the real run.');
  } else {
    out(`Registered: ${list}.`);
  }
  if (skipped.length) out(`Skipped (vendor CLI missing): ${skipped.join(', ')}.`);
  if (failed.length) out(`Failed: ${failed.join(', ')}.`);
  out('Restart Claude Code to load the new servers.');
  return failed.length ? 1 : 0;
}

async function cmdUninstall(argv) {
  const { flags, positional, errors } = parseArgv(argv, { booleans: ['dry-run'], options: ['prefix', 'units'] });
  if (positional.length) errors.push(`unexpected argument: ${positional[0]}`);
  const prefix = selectPrefix(flags.prefix, errors);
  const names = selectUnits(flags.units, errors);
  if (errors.length) { errors.forEach((e) => err(`omelette-fleet uninstall: ${e}`)); return 1; }

  const dry = !!flags.dryRun;
  const claudePath = whichBin('claude');
  out(`FLEET UNINSTALL · prefix "${prefix}"`);
  out();
  if (!claudePath && !dry) {
    out('claude not found in PATH — nothing was removed. Run these yourself:');
    out();
    for (const n of names) out(`  claude mcp remove -s user ${prefix}-${n}`);
    out();
    out('The fleet config and the status files were not touched.');
    return 0;
  }
  for (const n of names) {
    const cmd = ['claude', 'mcp', 'remove', '-s', 'user', `${prefix}-${n}`];
    if (dry) { out(`${pad(n, 7)} would run: ${cmd.join(' ')}`); continue; }
    const res = await runClaude(claudePath, cmd);
    out(`${pad(n, 7)} ${res.code === 0 ? `removed ${prefix}-${n}` : `not removed (exit ${res.code}): ${firstLine(res.stderr) || firstLine(res.stdout) || 'no output'}`}`);
  }
  out();
  out(`${dry ? 'Nothing was changed (--dry-run). ' : ''}The fleet config and the status files were not touched.`);
  return 0;
}

// ─── doctor ──────────────────────────────────────────────────────────────────

/**
 * Ask the PLAN itself whether each catalog id is usable — the CLI embeds more
 * names than a given account accepts, so only a real call can tell. Opt-in
 * because every id costs one billed turn.
 *
 * The argv comes from the adapter's own buildArgs rather than a hand-written
 * copy: a probe that drifts from what a real tool call sends (sandbox flags,
 * --ignore-user-config / --ignore-rules isolation, TOML quoting) answers a
 * question nobody asked. Web search off and effort `low` — this asks whether
 * the account accepts the id, nothing more — and `low` because the gpt-5.6 API
 * rejects `minimal` outright. The prompt rides stdin, which is what the `-`
 * that buildArgs appends means.
 */
const PROBE_PROMPT = 'Reply with exactly: OK';

async function probeCodexModels(binPath) {
  const lines = [];
  for (const id of codexUnit.catalog.modelEnum()) {
    const args = buildCodexArgs({ model: id, effort: 'low', mode: 'read-only', webSearch: false });
    let res;
    // Same env as a real codex tool call — including the billing scrub, because
    // an API key reaching this probe would bill the metered API for every id.
    try { res = await runProcess({ bin: binPath, args, stdinText: PROBE_PROMPT, hardKillMs: 90000, ...probeEnv(codexUnit) }); }
    catch (e) { lines.push(`${pad(id, 16)} ERROR — ${(e && e.message) || e}`); continue; }
    if (res.killed) { lines.push(`${pad(id, 16)} TIMEOUT (90s)`); continue; }
    try {
      const r = extractCodexResult(res, { timeoutS: 90 });
      lines.push(`${pad(id, 16)} ACCEPTED — ${firstLine(r.text).slice(0, 60)}`);
    } catch (e) {
      lines.push(`${pad(id, 16)} REJECTED — ${firstLine((e && e.message) || String(e)).slice(0, 160)}`);
    }
  }
  return lines;
}

async function cmdDoctor(argv) {
  const { flags, positional, errors } = parseArgv(argv, { booleans: ['probe-models'], options: ['prefix'] });
  if (positional.length) errors.push(`unexpected argument: ${positional[0]}`);
  const prefix = selectPrefix(flags.prefix, errors);
  if (errors.length) { errors.forEach((e) => err(`omelette-fleet doctor: ${e}`)); return 1; }

  const claude = readClaudeConfig();
  const home = probeHome();
  const claudePath = whichBin('claude');

  out(`FLEET DOCTOR · omelette-fleet ${PKG.version} · node ${process.version} · ${process.platform}`);
  out(`fleet home    ${home.dir}`);
  out(`fleet config  ${configPath()}${existsSync(configPath()) ? '' : ' (absent — built-in defaults in force)'}`);
  out(`claude CLI    ${claudePath || 'not found in PATH'}`);
  out(`claude config ${claude.path}${claude.error ? ` (${claude.error})` : ''}`);
  out();

  let faults = 0;
  for (const name of UNIT_ORDER) {
    const unit = UNITS[name];
    const bin = resolveBin(unit);
    const binPath = whichBin(bin);
    const cfg = cfgFor(name);
    const reg = findRegistration(claude.config, `${prefix}-${name}`);

    out(`── ${name} (${unit.label}) ${'─'.repeat(Math.max(0, 56 - name.length - String(unit.label).length))}`);
    const binEnv = unit.bin.env ? `${unit.bin.env}=${process.env[unit.bin.env] ? process.env[unit.bin.env] : '(unset)'}` : '(no env override)';
    out(`  bin         ${bin} → ${binPath || 'not found in PATH'}   [${binEnv}]`);
    if (binPath) {
      out(`  version     ${await probeVersion(unit, binPath)}`);
      const login = await probeLogin(unit, binPath);
      out(`  login       ${login.state === 'in' ? 'OK' : login.state === 'out' ? 'SIGNED OUT' : 'unknown'} — ${login.detail}`);
      if (login.state === 'out' && cfg.values.enabled && reg) faults++;
    } else {
      out('  version     — (no binary)');
      out('  login       unknown (no binary)');
      if (cfg.values.enabled && reg) faults++;
    }
    out(`  config      ${ceilingLine(name, cfg)}`);
    for (const line of configRows(name, cfg, '              ')) out(line);
    for (const w of cfg.warnings) out(`  warning     ${w}`);
    out(`  mcp         ${reg
      ? `${prefix}-${name} registered (${reg.scope}) → ${reg.target || '(no args)'} ${reg.exists ? '[file exists]' : '[FILE MISSING]'}`
      : `${prefix}-${name} not registered — run: omelette-fleet install --units ${name}`}`);
    out(`  status feed ${cfg.values.status ? '' : '(disabled in config) '}${home.writable ? `${home.dir} is writable` : `${home.dir} is NOT writable — ${home.error}`}`);
    out();
  }

  if (flags.probeModels) {
    const binPath = whichBin(resolveBin(codexUnit));
    out('── codex model probe (real billed calls) ─────────────────────');
    if (!binPath) out('  skipped — the codex binary was not found.');
    else for (const line of await probeCodexModels(binPath)) out(`  ${line}`);
    out();
  }

  out(faults
    ? `${faults} unit(s) enabled AND registered are broken (missing binary or signed out) — see above.`
    : 'No faults in units that are both enabled and registered.');
  return faults ? 1 : 0;
}

// ─── show / set ──────────────────────────────────────────────────────────────

function cmdShow(argv) {
  const { positional, errors } = parseArgv(argv, {});
  if (positional.length > 1) errors.push(`unexpected argument: ${positional[1]}`);
  const only = positional[0];
  if (only && !UNITS[only]) errors.push(`unknown unit "${only}" — known units: ${UNIT_ORDER.join(', ')}`);
  if (errors.length) { errors.forEach((e) => err(`omelette-fleet show: ${e}`)); return 1; }

  const path = configPath();
  out(`fleet config  ${path}${existsSync(path) ? '' : ' (absent — built-in defaults in force)'}`);
  out();
  for (const name of only ? [only] : UNIT_ORDER) {
    const cfg = cfgFor(name);
    out(`${name}`);
    for (const line of configRows(name, cfg, '  ')) out(line);
    out(`  ceiling  ${ceilingLine(name, cfg)}`);
    for (const w of cfg.warnings) out(`  warning  ${w}`);
    out();
  }
  return 0;
}

const describeSpec = (spec) => (
  spec.type === 'enum' ? spec.values.join(' | ')
    : spec.type === 'posint' ? 'a positive integer'
      : spec.type === 'boolean' ? 'true | false'
        : 'a string');

/** Read the config file as bytes, not through the cache: `set` rewrites it and must not lose keys. */
function readConfigRaw(env = process.env) {
  const path = configPath(env);
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? { path, config: {}, existed: false } : { path, config: null, existed: true, error: (e && e.message) || String(e) }; }
  try {
    const parsed = JSON.parse(raw);
    if (!isObj(parsed)) return { path, config: null, existed: true, error: 'top-level must be an object' };
    return { path, config: parsed, existed: true };
  } catch (e) {
    return { path, config: null, existed: true, error: (e && e.message) || String(e) };
  }
}

function cmdSet(argv) {
  const { positional, errors } = parseArgv(argv, {});
  if (!positional.length) errors.push('nothing to set — usage: omelette-fleet set <unit>.<key>=<value> [...]');

  const assignments = [];
  for (const a of positional) {
    const eq = a.indexOf('=');
    if (eq < 0) { errors.push(`"${a}" is not <unit>.<key>=<value>`); continue; }
    const lhs = a.slice(0, eq).trim();
    const raw = a.slice(eq + 1);
    const dot = lhs.indexOf('.');
    if (dot < 0) { errors.push(`"${a}" is not <unit>.<key>=<value>`); continue; }
    const name = lhs.slice(0, dot).trim().toLowerCase();
    const key = lhs.slice(dot + 1).trim();
    if (!UNITS[name]) { errors.push(`unknown unit "${name}" — known units: ${UNIT_ORDER.join(', ')}`); continue; }
    const schema = schemaFor(name);
    if (!(key in schema)) { errors.push(`unknown key "${key}" for unit "${name}" — known keys: ${Object.keys(schema).join(', ')}`); continue; }
    const c = coerce(schema[key], raw);
    if (!c.ok) { errors.push(`invalid value for ${name}.${key}: ${JSON.stringify(raw)} — expected ${describeSpec(schema[key])}`); continue; }
    assignments.push({ name, key, value: c.value });
  }
  if (errors.length) { errors.forEach((e) => err(`omelette-fleet set: ${e}`)); return 1; }

  const file = readConfigRaw();
  if (file.config === null) {
    err(`omelette-fleet set: ${file.path} is not valid JSON (${file.error}) — fix or remove it first; refusing to overwrite it.`);
    return 1;
  }

  // Old values are the EFFECTIVE ones a unit would see, so a shadowing env var stays visible.
  const before = new Map(UNIT_ORDER.map((n) => [n, cfgFor(n)]));
  const next = JSON.parse(JSON.stringify(file.config));
  next.units = isObj(next.units) ? next.units : {};
  for (const a of assignments) {
    next.units[a.name] = isObj(next.units[a.name]) ? next.units[a.name] : {};
    next.units[a.name][a.key] = a.value;
  }
  const written = writeFleetConfig(next);

  for (const a of assignments) {
    const cfg = before.get(a.name);
    out(`${a.name}.${a.key}  ${fmtValue(cfg.values[a.key])} [${cfg.sources[a.key]}] → ${fmtValue(a.value)} [file]`);
    if (cfg.sources[a.key].startsWith('env:')) {
      out(`  note: ${cfg.sources[a.key].slice(4)} is set in this environment and still wins over the file.`);
    }
    if (a.key === 'mode' && a.value !== 'read-only') {
      out(`  note: mode=${a.value} takes effect ONLY when the MCP server's environment sets`);
      out(`        OMELETTE_ALLOW_WRITE=${a.name} (the fleet ceiling); until then the unit stays read-only.`);
      if (!(UNITS[a.name].supportedModes && UNITS[a.name].supportedModes[a.value])) {
        out(`        ${a.name} refuses ${a.value} entirely — it stays read-only whatever the ceiling says.`);
      }
    }
  }
  out();
  out(`wrote ${written}`);
  return 0;
}

// ─── call ────────────────────────────────────────────────────────────────────

async function cmdCall(argv) {
  const { flags, positional, errors } = parseArgv(argv, { options: ['timeout'] });
  const [name, tool, argsJson = '{}'] = positional;
  if (!name || !tool) errors.push('usage: omelette-fleet call <unit> <tool> [json-args] [--timeout S]');
  else if (!UNITS[name]) errors.push(`unknown unit "${name}" — known units: ${UNIT_ORDER.join(', ')}`);
  if (positional.length > 3) errors.push(`unexpected argument: ${positional[3]}`);
  const timeoutS = flags.timeout === undefined ? 900 : Number(flags.timeout);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) errors.push(`--timeout must be a positive number of seconds (got ${JSON.stringify(flags.timeout)})`);
  let args = {};
  try { args = JSON.parse(argsJson); } catch (e) { errors.push(`bad json args: ${(e && e.message) || e}`); }
  if (errors.length) { errors.forEach((e) => err(`omelette-fleet call: ${e}`)); return 1; }

  try {
    const res = await callUnitServer({
      serverPath: serverPathFor(name), tool, args, timeoutS,
      // Prefix real lines only: `^` also matches after a trailing newline, and
      // that phantom prefix would land in front of the next stdout line.
      onStderr: (c) => process.stderr.write(String(c).replace(/^(?!$)/gm, '  │ ')),
      onProgress: (line) => out(line),
    });
    out(`tools/call → ${res.isError ? 'ERROR' : 'ok'} in ${(res.durationMs / 1000).toFixed(1)}s`);
    out();
    out(res.text);
    return res.isError ? 2 : 0;
  } catch (e) {
    err(`omelette-fleet call: ${(e && e.message) || e}`);
    return 1;
  }
}

// ─── dispatch ────────────────────────────────────────────────────────────────

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { out(HELP); return 0; }
  if (cmd === '--version' || cmd === '-v') { out(PKG.version); return 0; }
  switch (cmd) {
    case 'install': return cmdInstall(rest);
    case 'uninstall': return cmdUninstall(rest);
    case 'doctor': return cmdDoctor(rest);
    case 'show': return cmdShow(rest);
    case 'set': return cmdSet(rest);
    case 'call': return cmdCall(rest);
    default:
      err(`omelette-fleet: unknown command "${cmd}"`);
      err('commands: install, uninstall, doctor, show, set, call — `omelette-fleet --help` for the full usage.');
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code || 0; },
  (e) => { err(`omelette-fleet: ${(e && e.stack) || e}`); process.exitCode = 1; },
);
