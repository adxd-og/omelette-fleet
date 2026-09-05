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
 * "signed out" — a wrong diagnosis costs more than no diagnosis, and a
 * non-zero exit with nothing to read is exactly that. Only the combination
 * enabled-in-config AND registered AND broken (no binary, signed out, or a
 * registration pointing at a file that is gone) sets exit 1: a unit you
 * deliberately never wired up is not a fault.
 *
 * READ-ONLY ABOUT THE MACHINE: Claude Code's config — $CLAUDE_CONFIG_DIR/
 * .claude.json if that is set, else ~/.claude.json — is parsed, never written.
 * The only writer of it is `claude` itself. The files this CLI writes are
 * <home>/fleet.config.json, <home>/update-check.json and, on request,
 * .claude/rules/omelette-fleet.md (and .claude/agents/omelette-*.md with
 * `rules --agents`) — each of those only when it carries our marker.
 *
 * TEST HOOK — OMELETTE_PKG_ROOT: `update` (and the install-kind detection it
 * uses) treats that directory as the package root instead of this checkout, so
 * the whole git flow can be exercised against a throwaway fixture repo. It is
 * honoured NOWHERE else: server paths, the shipped example config and doctor
 * all still come from the real ROOT below.
 */
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../core/spawn.mjs';
import { callUnitServer } from '../core/client.mjs';
import { KEY_SCHEMA, coerce, configPath, fleetHome, unitConfig, writeFleetConfig } from '../core/config.mjs';
import { cachedCheck, compareSemver, currentVersion, detectInstall, packageRoot, updateCheckEnabled } from '../core/update.mjs';
import {
  AGENT_FILES, RULES_FILE_NAME, agentsTarget, parseAgentMarker, parseRulesMarker, renderAgentFile,
  renderRulesFile, rulesTarget,
} from '../core/rules.mjs';
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

const pad = (s, n) => String(s).padEnd(n);
const out = (s = '') => process.stdout.write(s + '\n');
const err = (s = '') => process.stderr.write(s + '\n');
const serverPathFor = (name) => join(ROOT, 'servers', `${name}.mjs`);
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const schemaFor = (name) => ({ ...KEY_SCHEMA, ...(UNITS[name].extraSchema || {}) });
const firstLine = (s) => String(s || '').trim().split('\n')[0].trim();
/** The most informative line of a finished probe: the tail, where CLIs put the reason. */
const lastLine = (r) => {
  const all = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').map((x) => x.trim()).filter(Boolean);
  return (all[all.length - 1] || '').slice(0, 160);
};

/** Resolve one unit's config through the same layers the running server sees. */
const cfgFor = (name, env = process.env) => {
  const u = UNITS[name];
  return unitConfig({
    unit: u.name, envMap: u.envMap, builtin: u.builtin, extraSchema: u.extraSchema,
    supportedModes: u.supportedModes, env,
  });
};

/**
 * Every command's help lives WITH the command, so `omelette-fleet --help` and
 * `omelette-fleet <cmd> --help` can never disagree — the global listing is
 * assembled from the same bodies the per-command pages print.
 */
const COMMANDS = {
  install: {
    args: '[--prefix <name>] [--units <a,b,c>] [--dry-run] [--force]',
    body: [
      'Register one MCP server per unit with `claude mcp add -s user`',
      'as <prefix>-<unit>, and create <home>/fleet.config.json from the',
      'shipped example if it does not exist yet (never overwritten).',
      'A unit whose vendor CLI is not in PATH is skipped unless --force.',
      '--dry-run prints every command and every write, and runs nothing.',
    ],
  },
  uninstall: {
    args: '[--prefix <name>] [--units <a,b,c>] [--dry-run]',
    body: [
      'Remove those servers again (`claude mcp remove -s user`). The',
      'fleet config and the status files are never touched. Removing a',
      'server that is not registered is a no-op; a removal that FAILS for',
      'one that IS registered exits 1.',
    ],
  },
  update: {
    args: '[--check]',
    body: [
      'Say what the latest released version is, then bring THIS install up',
      'to date. A git checkout is fast-forwarded (`git pull --ff-only`) —',
      'a dirty tree or a diverged branch is refused, never overwritten. An',
      'npm install is not touched: the exact `npm i -g` line is printed.',
      '--check pulls nothing and only reports — exit 3 when an update is',
      'available, 0 when there is none, so a script can branch on it.',
      'Registrations are never rewritten: server paths survive a pull.',
    ],
  },
  rules: {
    args: '[--global] [--agents] [--print] [--remove] [--force] [--dry-run]',
    body: [
      'Write the fleet\'s operating rules (units propose, this session applies;',
      'tester flow; routing table) to <cwd>/.claude/rules/omelette-fleet.md,',
      'which Claude Code loads like CLAUDE.md. --global writes it under',
      '$CLAUDE_CONFIG_DIR or ~/.claude instead. The file carries a version',
      'marker on line 1: re-running refreshes a file with the marker, and a',
      'file WITHOUT it is never touched (--force replaces it). --print sends',
      'the text to stdout; --remove deletes only a file with the marker.',
      '--agents also writes two sub-agent definitions (omelette-coder:',
      'Opus xhigh; omelette-tester: Sonnet xhigh, both disallowedTools:',
      'Agent) into .claude/agents, where their effort is set.',
    ],
  },
  doctor: {
    args: '[--prefix <name>] [--probe-models]',
    body: [
      'Per unit: the vendor binary, its --version, the login state, the',
      'resolved fleet config with sources, the MCP registration and',
      'whether the status feed is writable. Exits 1 when a unit that is',
      'enabled AND registered has a missing binary, is signed out, or is',
      'registered against a server file that no longer exists.',
      '--probe-models spends real Codex calls to test every catalog id.',
    ],
  },
  show: {
    args: '[<unit>]',
    body: [
      'Every config key for one unit or all of them: value, where it came',
      'from (default / file:defaults / file / env:NAME), and the ceiling.',
    ],
  },
  set: {
    args: '<unit>.<key>=<value> [...]',
    body: [
      'Change keys in <home>/fleet.config.json. Unknown units, unknown',
      'keys and invalid values are refused; the rest of the file is kept.',
    ],
  },
  call: {
    args: '<unit> <tool> [json-args] [--timeout <seconds>]',
    body: [
      "Drive a unit's MCP server over real stdio (initialize →",
      'tools/list → tools/call) and print the result. Exit 2 = the tool',
      'answered with an error, 1 = the server never answered.',
    ],
  },
};

const HELP = [
  `omelette-fleet ${PKG.version} — plug Gemini, Grok and Codex into Claude Code as read-only units.`,
  '',
  'USAGE',
  ...Object.entries(COMMANDS).map(([n, c]) => `  omelette-fleet ${pad(n, 9)} ${c.args}`),
  '  omelette-fleet --help | --version',
  '',
  'COMMANDS',
  ...Object.entries(COMMANDS).flatMap(([n, c]) => c.body.map((l, i) => (i ? `             ${l}` : `  ${pad(n, 10)} ${l}`))),
  '',
  'UNITS',
  '  gemini  Google Gemini via the Antigravity CLI (agy)',
  '  grok    xAI Grok via the grok CLI',
  '  codex   OpenAI Codex via the codex CLI',
  '',
  'ENVIRONMENT',
  '  OMELETTE_HOME         fleet home (default ~/.omelette): config + status feed',
  '  OMELETTE_ALLOW_WRITE  comma-separated units allowed past read-only (the ceiling)',
  '  OMELETTE_STATUS       0/1 — status feed off/on for every unit',
  '  OMELETTE_UPDATE_CHECK 0 to switch the daily "newer release" check off entirely',
  '  CLAUDE_CONFIG_DIR     where doctor looks for .claude.json before ~/',
  '  AGY_BIN GROK_BIN CODEX_BIN',
  '                        point a unit at a specific vendor binary',
  '',
  'EXAMPLES',
  '  omelette-fleet install --dry-run',
  '  omelette-fleet install --units codex,gemini',
  '  omelette-fleet doctor',
  '  omelette-fleet rules            # this project',
  '  omelette-fleet rules --global',
  '  omelette-fleet set codex.timeoutS=900 gemini.model="Gemini 3.8 Flash (High)"',
  "  omelette-fleet call codex codex_models '{}'",
].join('\n');

const commandHelp = (name) => [
  `omelette-fleet ${name}`,
  '',
  'USAGE',
  `  omelette-fleet ${name} ${COMMANDS[name].args}`,
  '',
  ...COMMANDS[name].body.map((l) => `  ${l}`),
  '',
  '(`omelette-fleet --help` for every command, the units and the environment.)',
].join('\n');

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
  // A CLI that exits non-zero is not reporting its version — it is failing, and
  // its first line of complaint printed as `version` reads like one.
  if (r.code !== 0) return `unknown (exit ${r.code}${lastLine(r) ? `: ${lastLine(r)}` : ''})`;
  const line = firstLine(r.stdout) || firstLine(r.stderr);
  return line ? line.slice(0, 120) : 'unknown (no output)';
}

/**
 * Login state per vendor, each with its own honest signal:
 *   codex  `codex login status` → exit 0 + "Logged in" on EITHER stream
 *   grok   `grok models`        → /not authenticated|not signed in/ = signed out
 *   agy    `agy models`         → exit 0 with at least one line = OK
 * SIGNED OUT is only ever an EXPLICIT phrase. A non-zero exit on its own is
 * `unknown (exit N)` with the tail as the detail — a CLI can fail for a dozen
 * reasons that are not "no session", and telling an operator to run `codex
 * login` when the real problem is a broken install wastes their afternoon.
 * 20s ceiling: these are local calls or a cheap API round-trip, never a model run.
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
  const unknown = {
    state: 'unknown',
    label: `unknown (exit ${r.code})`,
    detail: lastLine(r) || `${cmd}: no output`,
  };
  if (name === 'codex') {
    // `codex login status` writes its answer to stderr in some builds and to
    // stdout in others, so read BOTH streams — looking at only one is how this
    // reported "unknown — exit 0, Logged in using ChatGPT". The "not logged in"
    // guard earns its keep because that phrase contains "logged in" too.
    const loggedIn = both.split('\n').map((x) => x.trim())
      .find((x) => /logged in/i.test(x) && !/not logged in/i.test(x));
    if (r.code === 0 && loggedIn) return { state: 'in', detail: loggedIn };
    if (/not logged in|login required|logged out/i.test(both)) return { state: 'out', detail: 'signed out — run `codex login`' };
    return unknown;
  }
  if (name === 'grok') {
    if (/not authenticated|not signed in/i.test(both)) return { state: 'out', detail: 'signed out — run `grok login`' };
    if (r.code === 0 && lines.length) return { state: 'in', detail: `${cmd} listed ${lines.length} line(s)` };
    return unknown;
  }
  // agy: exit 0 with output is the only positive signal, and only an explicit
  // phrase is a negative one — "login" appearing in prose proves nothing.
  if (r.code === 0 && lines.length) return { state: 'in', detail: `${cmd} listed ${lines.length} line(s)` };
  if (/not authenticated|not signed in|not logged in/i.test(both)) return { state: 'out', detail: 'signed out — run `agy` once and sign in' };
  return unknown;
}

/**
 * Claude Code's own config — parsed, NEVER written; the only thing that writes
 * it is `claude`. CLAUDE_CONFIG_DIR relocates the whole config, so look there
 * FIRST and fall back to ~/.claude.json; doctor prints which file it read,
 * because "not registered" against the wrong file is a lie. Absence is normal.
 */
function readClaudeConfig(env = process.env) {
  const dir = String(env.CLAUDE_CONFIG_DIR || '').trim();
  const candidates = [
    ...(dir ? [{ path: join(dir, '.claude.json'), source: 'CLAUDE_CONFIG_DIR' }] : []),
    { path: join(homedir(), '.claude.json'), source: 'home' },
  ];
  for (const c of candidates) {
    let raw;
    try { raw = readFileSync(c.path, 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') continue; // try the next candidate
      return { ...c, config: null, error: (e && e.message) || String(e) };
    }
    try {
      const parsed = JSON.parse(raw);
      return isObj(parsed)
        ? { ...c, config: parsed, error: null }
        : { ...c, config: null, error: 'top-level is not an object' };
    } catch (e) {
      return { ...c, config: null, error: (e && e.message) || String(e) };
    }
  }
  return { ...candidates[0], config: null, error: 'absent' };
}

/**
 * Find <prefix>-<unit> in the user scope, then in any project scope — and say
 * whether it is OURS. The name alone proves nothing: another clone of this
 * package, or something else entirely, can own it. `ours` means the command is
 * node AND the args path is exactly THIS checkout's servers/<unit>.mjs; short
 * of that doctor reports where it actually points instead of claiming it.
 */
function findRegistration(config, serverName, expected) {
  if (!isObj(config)) return null;
  const buckets = [];
  if (isObj(config.mcpServers)) buckets.push(['user', config.mcpServers]);
  if (isObj(config.projects)) {
    for (const [dir, p] of Object.entries(config.projects)) if (isObj(p) && isObj(p.mcpServers)) buckets.push([`project ${dir}`, p.mcpServers]);
  }
  const samePath = (a, b) => {
    try { return !!a && !!b && resolvePath(a) === resolvePath(b); } catch { return false; }
  };
  for (const [scope, servers] of buckets) {
    const entry = servers[serverName];
    if (!isObj(entry)) continue;
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    const target = args.find((a) => a.endsWith('.mjs')) || args[args.length - 1] || '';
    const command = typeof entry.command === 'string' ? entry.command : '';
    const isNode = command === process.execPath || /^node(\.exe)?$/i.test(basename(command));
    return {
      scope, entry, command, target,
      exists: !!target && existsSync(target),
      ours: isNode && samePath(target, expected),
    };
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
  // The registry decides what a failed remove MEANS: removing a name that was
  // never there is idempotence working, removing one that IS there and failing
  // is a real failure the operator has to hear about.
  const claude = readClaudeConfig();
  const registered = (n) => !!findRegistration(claude.config, `${prefix}-${n}`, serverPathFor(n));

  out(`FLEET UNINSTALL · prefix "${prefix}"`);
  out();
  if (!claudePath && !dry) {
    out('claude not found in PATH — NOTHING WAS CHANGED. Run these yourself:');
    out();
    for (const n of names) out(`  claude mcp remove -s user ${prefix}-${n}`);
    out();
    out('The fleet config and the status files were not touched.');
    return 0;
  }
  const failed = [];
  for (const n of names) {
    const cmd = ['claude', 'mcp', 'remove', '-s', 'user', `${prefix}-${n}`];
    const was = registered(n);
    if (dry) { out(`${pad(n, 7)} would run: ${cmd.join(' ')}${was ? '' : '   (not registered — a no-op)'}`); continue; }
    const res = await runClaude(claudePath, cmd);
    if (res.code === 0) { out(`${pad(n, 7)} removed ${prefix}-${n}`); continue; }
    const why = firstLine(res.stderr) || firstLine(res.stdout) || 'no output';
    if (!was) { out(`${pad(n, 7)} ${prefix}-${n} was not registered — nothing to remove`); continue; }
    failed.push(n);
    out(`${pad(n, 7)} FAILED to remove ${prefix}-${n} (exit ${res.code}): ${why}`);
  }
  out();
  if (failed.length) out(`Still registered: ${failed.map((n) => `${prefix}-${n}`).join(', ')}.`);
  out(`${dry ? 'Nothing was changed (--dry-run). ' : ''}The fleet config and the status files were not touched.`);
  return failed.length ? 1 : 0;
}

// ─── update ──────────────────────────────────────────────────────────────────

/**
 * `git` is the OPERATOR's own tool, exactly like `claude` above, so it is the
 * other child that runs with `inheritEnv` (core/spawn.mjs): a pull has to see
 * the ssh agent, the credential helper, the proxy and every GIT_* variable the
 * operator set. There is no model reading this environment either.
 *
 * WHAT THIS COMMAND WILL NOT DO: write the working tree over local changes
 * (a dirty tree is refused with the list), merge (--ff-only only), or touch the
 * MCP registrations — `install` writes absolute paths into ~/.claude.json and a
 * pull moves none of them. The one exception it will TELL you about is a
 * registered server file that is gone after the pull.
 *
 * --check DOES fetch. It cannot answer "is there an update" for a checkout
 * without asking the remote, and `git fetch` writes nothing but refs — no
 * working-tree file changes, no merge. It stops before the pull, which is the
 * step that changes what is installed.
 */
const runGit = (bin, root, args) => runProcess({ bin, args: ['-C', root, ...args], inheritEnv: true, hardKillMs: 120000 })
  .catch((e) => ({ code: -1, stdout: '', stderr: (e && e.message) || String(e) }));

/** origin's default branch, or `main` when the remote never told us which it is. */
async function originBranch(gitBin, root) {
  const r = await runGit(gitBin, root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  const m = /^refs\/remotes\/origin\/(.+)$/.exec(firstLine(r.stdout));
  return r.code === 0 && m ? m[1] : 'main';
}

async function cmdUpdate(argv) {
  const { flags, positional, errors } = parseArgv(argv, { booleans: ['check'] });
  if (positional.length) errors.push(`unexpected argument: ${positional[0]}`);
  if (errors.length) { errors.forEach((e) => err(`omelette-fleet update: ${e}`)); return 1; }

  const checkOnly = !!flags.check;
  const root = packageRoot();
  const current = currentVersion(root);
  const kind = detectInstall(root);

  out(`FLEET UPDATE · omelette-fleet ${current} · ${kind} install`);
  out(`install       ${root}`);
  // The release check is ADVISORY in both directions: it never decides whether
  // the pull happens (git does), and an unreachable GitHub is no reason to
  // refuse to fast-forward a checkout that is demonstrably behind its origin.
  let remote = null;
  if (!updateCheckEnabled({})) {
    out('latest        update check disabled (OMELETTE_UPDATE_CHECK / updateCheck in the fleet config)');
  } else {
    remote = await cachedCheck({ home: fleetHome(), current, ttlMs: 0 });
    out(remote.latest
      ? `latest        ${remote.latest} — ${remote.behind ? 'NEWER than this install' : 'this install is current'}`
      : `latest        unknown (${remote.error})`);
  }
  out();

  // A managed file older than the install it belongs to is worth one line and
  // NOTHING else: `update` never writes the rules file or an agent definition —
  // `omelette-fleet rules` does, when the operator asks. --check says it before
  // it stops at the pull.
  // The two scopes can be the SAME path (cwd is the home directory, no
  // CLAUDE_CONFIG_DIR), and one file deserves one hint — the project scope
  // comes first, so the plain command wins over `--global`. Identity is the
  // RESOLVED path: process.cwd() is already real, `~` from the environment may
  // still run through a symlink (/var → /private/var on macOS).
  const realOrSelf = (p) => { try { return realpathSync(p); } catch { return p; } };
  const rulesHints = (version) => {
    const seen = new Set();
    for (const r of rulesReport(version)) {
      const key = realOrSelf(r.path);
      if (r.state !== 'ours' || !r.behind || seen.has(key)) continue;
      seen.add(key);
      out(`rules file ${r.path} is v${r.version} (this install is v${version}) — refresh: omelette-fleet rules${r.scope === 'global' ? ' --global' : ''}`);
    }
    // One line per SCOPE, not per file: the two definitions are refreshed
    // together — and only when the whole scope is ours. A scope holding a file
    // that is not ours would refuse that refresh, so pointing at it is worse
    // than saying nothing.
    for (const r of agentsReport(version)) {
      const key = realOrSelf(r.dir);
      if (r.state !== 'ours' || !r.behind || seen.has(key)) continue;
      seen.add(key);
      out(`agent files under ${r.dir} are v${r.version} (this install is v${version}) — refresh: omelette-fleet rules --agents${r.scope === 'global' ? ' --global' : ''}`);
    }
  };
  if (checkOnly) rulesHints(current);

  if (kind === 'npm') {
    out('Installed from npm — there is no checkout to pull. Upgrade with:');
    out();
    out('  npm i -g omelette-fleet@latest');
    out();
    out('(Nothing to install if you run it through npx: `npx omelette-fleet@latest <command>`');
    out(' always fetches the latest release.)');
    if (!checkOnly) rulesHints(current);
    out('Restart Claude Code afterwards to load the new servers.');
    return checkOnly && remote && remote.behind ? 3 : 0;
  }

  const gitBin = whichBin('git');
  if (!gitBin) {
    err('omelette-fleet update: git not found in PATH — this is a git checkout and cannot be updated without it.');
    return 1;
  }

  const status = await runGit(gitBin, root, ['status', '--porcelain']);
  if (status.code !== 0) {
    err(`omelette-fleet update: git status failed (exit ${status.code}): ${lastLine(status) || 'no output'}`);
    return 1;
  }
  const dirty = status.stdout.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  if (dirty.length) {
    out(`The checkout has ${dirty.length} local change(s) — a pull would overwrite them:`);
    for (const l of dirty.slice(0, 20)) out(`  ${l}`);
    if (dirty.length > 20) out(`  … and ${dirty.length - 20} more`);
    out();
    out('Commit, stash or discard them first, then run `omelette-fleet update` again.');
    return 1;
  }

  const branch = await originBranch(gitBin, root);
  const fetched = await runGit(gitBin, root, ['fetch', '--quiet', 'origin']);
  if (fetched.code !== 0) {
    err(`omelette-fleet update: git fetch origin failed (exit ${fetched.code}): ${lastLine(fetched) || 'no output'}`);
    return 1;
  }
  const counted = await runGit(gitBin, root, ['rev-list', '--count', `HEAD..origin/${branch}`]);
  const behind = Number(firstLine(counted.stdout));
  if (counted.code !== 0 || !Number.isFinite(behind)) {
    err(`omelette-fleet update: git rev-list HEAD..origin/${branch} failed (exit ${counted.code}): ${lastLine(counted) || 'no output'}`);
    return 1;
  }
  if (behind === 0) {
    out(`already up to date — HEAD matches origin/${branch}.`);
    if (!checkOnly) rulesHints(current);
    return 0;
  }
  out(`behind        ${behind} commit(s) behind origin/${branch}`);
  if (checkOnly) {
    out('Run `omelette-fleet update` to fast-forward (--check changed nothing).');
    return 3;
  }

  const pull = await runGit(gitBin, root, ['pull', '--ff-only', 'origin', branch]);
  if (pull.code !== 0) {
    err(`omelette-fleet update: git pull --ff-only origin ${branch} failed (exit ${pull.code}): ${lastLine(pull) || 'no output'}`);
    err(`This checkout has diverged from origin/${branch} — a fast-forward is not possible, and`);
    err('nothing was changed. Inspect it and reconcile by hand:');
    err(`  git -C ${root} log --oneline HEAD...origin/${branch}`);
    err('or install the released package instead: npm i -g omelette-fleet@latest');
    return 1;
  }

  const after = currentVersion(root);
  out(`pulled        ${current} → ${after}${after === current ? ' (version unchanged)' : ''}`);
  // Registrations are absolute paths that a pull does not move — the only thing
  // worth saying is when one of them no longer points at a file that exists.
  const claude = readClaudeConfig();
  const missing = UNIT_ORDER.filter((n) => {
    const reg = findRegistration(claude.config, `${DEFAULT_PREFIX}-${n}`, join(root, 'servers', `${n}.mjs`));
    return reg && !reg.exists;
  });
  if (missing.length) out(`The registered server file is missing for: ${missing.join(', ')} — run \`omelette-fleet install\`.`);
  // The pull may have brought a newer rules text with it — compare against what
  // is installed NOW, not against the version this command started at.
  rulesHints(after);
  out('Restart Claude Code to load the new servers.');
  return 0;
}

// ─── rules ───────────────────────────────────────────────────────────────────

/**
 * Every path component this command touches has to be the real thing it looks
 * like. `<base>/.claude`, `<base>/.claude/{rules,agents}` and the target file
 * are lstat'ed — never followed — so a link planted anywhere along the way
 * cannot redirect a write, or a `--remove`, at a file the operator never named.
 * A missing component is fine: mkdirSync creates it, as before.
 *
 * @returns {string|null} the refusal's reason, or null when the path is clean.
 */
function unsafeManagedPath(path) {
  const fileDir = dirname(path); //        .claude/rules | .claude/agents
  const claudeDir = dirname(fileDir); //   .claude
  for (const p of [claudeDir, fileDir, path]) {
    let st;
    try { st = lstatSync(p); } catch { continue; } // absent — nothing to redirect through
    if (st.isSymbolicLink()) return `${p} is a symlink`;
    if (p !== path && !st.isDirectory()) return `${p} is not a directory`;
    // The target itself: a FIFO would park readFileSync forever waiting for a
    // writer, and a device or a directory is not something we own either.
    if (p === path && !st.isFile()) return `${p} is not a regular file`;
  }
  return null;
}

/**
 * ONE implementation for every file `rules` manages — the rules file and each
 * agent definition go through this and nothing else, so "refuse a file that is
 * not ours" cannot be true of one of them and false of another.
 *
 * THE MARKER IS THE ONLY PROOF OF OWNERSHIP. A file we cannot parse a marker
 * out of is someone's own work: it is never written over (only --force does
 * that, explicitly) and never removed. Absent is not foreign — an ENOENT is
 * "write it", any other read error is a refusal rather than a guess.
 *
 * The write is tmp + rename: a half-written rules file is a file Claude Code
 * would happily load on the next session start.
 *
 * @param {{path:string, next:string, parse:(t:string)=>string|null, marker:string,
 *          version:string, force?:boolean, dryRun?:boolean, remove?:boolean}} o
 * @returns {{code:number, line:string|null, error:string|null}} `line` → stdout, `error` → stderr.
 */
function syncManagedFile({ path, next, parse, marker, version, force = false, dryRun = false, remove = false }) {
  // FIRST, before the file is even read — a symlink must not be read through,
  // and a FIFO at the target would block readFileSync forever. Also ahead of
  // the --force decision: --force replaces a foreign FILE, never a link.
  const unsafe = unsafeManagedPath(path);
  if (unsafe) return { code: 1, line: null, error: `omelette-fleet rules: refusing ${path}: ${unsafe}` };

  let text = null;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) {
    if (!e || e.code !== 'ENOENT') return { code: 1, line: null, error: `omelette-fleet rules: cannot read ${path}: ${(e && e.message) || e}` };
  }
  const existing = text === null ? null : parse(text);
  const foreign = text !== null && existing === null;

  if (remove) {
    if (text === null) return { code: 0, line: `nothing to remove — ${path} does not exist`, error: null };
    if (foreign) return { code: 1, line: null, error: `omelette-fleet rules: ${path} exists but is not managed by omelette-fleet (${marker}) — not removed; delete it by hand if you mean it` };
    if (dryRun) return { code: 0, line: `would remove ${path} (v${existing})`, error: null };
    // A directory we may not write into, a vanished file: one refusal line like
    // every other one, and the caller still processes the remaining files.
    try { unlinkSync(path); }
    catch (e) { return { code: 1, line: null, error: `omelette-fleet rules: cannot remove ${path}: ${(e && e.message) || e}` }; }
    return { code: 0, line: `removed ${path} (v${existing})`, error: null };
  }

  if (foreign && !force) return { code: 1, line: null, error: `omelette-fleet rules: ${path} exists and is not managed by omelette-fleet (${marker}) — leaving it alone; use --force to replace it` };
  if (existing !== null && text === next) return { code: 0, line: `up to date — ${path} (v${existing})`, error: null };
  const was = text === null ? 'absent' : (foreign ? 'foreign' : existing);
  if (dryRun) return { code: 0, line: `would write ${path} (v${version}, was ${was})`, error: null };
  // A directory we may not write, a full disk: one refusal line like every other
  // one — never a stack trace, and never a stray .tmp left in the operator's
  // .claude directory.
  //
  // The tmp name is predictable (one process, one pid), so it is created with
  // O_EXCL: anything already sitting there — a leftover, or a link planted to
  // catch the write — makes the open fail instead of being followed and
  // truncated. And a file we did not create is a file we do not clean up.
  const tmp = `${path}.${process.pid}.tmp`;
  let ours = false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // The fd is OURS from the moment the exclusive open returns, so `ours` is
    // set there and not after the write: a failure in the write, the close or
    // the rename must still take the tmp file away with it.
    const fd = openSync(tmp, 'wx', 0o644);
    ours = true;
    try {
      const buf = Buffer.from(next, 'utf8');
      for (let off = 0; off < buf.length;) off += writeSync(fd, buf, off, buf.length - off);
    } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (e) {
    if (ours) { try { unlinkSync(tmp); } catch { /* already gone */ } }
    const why = e && e.code === 'EEXIST' ? 'temporary file already exists' : (e && e.message) || e;
    return { code: 1, line: null, error: `omelette-fleet rules: cannot write ${path}: ${why}` };
  }
  return { code: 0, line: `written ${path} (v${version}, was ${was})`, error: null };
}

/**
 * Every file this command manages, in the order it handles them: the rules file
 * first, then — with --agents — one entry per shipped sub-agent definition.
 * The whole command is this list plus syncManagedFile.
 */
function managedFiles({ global = false, agents = false, version } = {}) {
  const files = [{
    name: RULES_FILE_NAME,
    path: rulesTarget({ global }).path,
    next: renderRulesFile(version),
    parse: parseRulesMarker,
    marker: 'no marker on line 1',
  }];
  if (agents) {
    const { dir } = agentsTarget({ global });
    for (const name of AGENT_FILES) {
      files.push({
        name,
        path: join(dir, name),
        next: renderAgentFile(name, version),
        parse: parseAgentMarker,
        marker: 'no marker on line 2',
      });
    }
  }
  return files;
}

async function cmdRules(argv) {
  const { flags, positional, errors } = parseArgv(argv, { booleans: ['global', 'agents', 'print', 'remove', 'force', 'dry-run'] });
  if (positional.length) errors.push(`unexpected argument: ${positional[0]}`);
  if (flags.print && flags.remove) errors.push('--print and --remove ask for opposite things — pick one');
  if (errors.length) { errors.forEach((e) => err(`omelette-fleet rules: ${e}`)); return 1; }

  const files = managedFiles({ global: !!flags.global, agents: !!flags.agents, version: PKG.version });

  // --print touches nothing at all. Each rendered file already ends in a
  // newline, so out() must not add a second one.
  if (flags.print) {
    files.forEach((f, i) => {
      if (i) out(`\n===== ${f.name} =====\n`);
      out(f.next.replace(/\n$/, ''));
    });
    return 0;
  }

  let code = 0;
  let wrote = false;
  for (const f of files) {
    const r = syncManagedFile({
      path: f.path, next: f.next, parse: f.parse, marker: f.marker, version: PKG.version,
      force: !!flags.force, dryRun: !!flags.dryRun, remove: !!flags.remove,
    });
    if (r.line) out(r.line);
    if (r.error) err(r.error);
    // One refused file is enough to exit 1 — and never a reason to skip the rest.
    if (r.code) code = 1;
    if (r.line && r.line.startsWith('written ')) wrote = true;
  }
  if (wrote) out('Rules load on the next session start; agent definitions are picked up within seconds (restart if .claude/agents did not exist before).');
  return code;
}

/**
 * What `doctor` and `update` REPORT about the managed files. These only ever
 * read: a stale rules file is something the operator is told about and never
 * something a diagnosis or a pull silently rewrites. A file we cannot read at
 * all reads as absent — this is a report line, not a fault.
 *
 * @returns {{path:string, state:'absent'|'foreign'|'ours', version:string|null}}
 */
function rulesState({ global = false, cwd = process.cwd(), env = process.env } = {}) {
  const { path } = rulesTarget({ global, cwd, env });
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return { path, state: 'absent', version: null }; }
  const version = parseRulesMarker(text);
  return version ? { path, state: 'ours', version } : { path, state: 'foreign', version: null };
}

/**
 * Both scopes at once, with "this file is not the one this install ships"
 * already decided. The test is string inequality, not compareSemver: the
 * comparison ignores a prerelease tail, so a v0.3.0-rc.1 file next to a 0.3.0
 * install compares EQUAL and would otherwise be reported as current forever.
 */
function rulesReport(current) {
  return [
    { scope: 'project', ...rulesState({}) },
    { scope: 'global', ...rulesState({ global: true }) },
  ].map((r) => ({ ...r, behind: r.state === 'ours' && r.version !== current }));
}

/**
 * The agent definitions at one scope, as one verdict: ours only when EVERY file
 * is there and marked, `partial` when some are missing, and `foreign` as soon as
 * one of them is not ours — the version shown is the OLDEST marker, because that
 * is the one a refresh would move.
 */
function agentsState({ current, global = false, cwd = process.cwd(), env = process.env } = {}) {
  const { dir } = agentsTarget({ global, cwd, env });
  const found = AGENT_FILES.map((name) => {
    let text;
    try { text = readFileSync(join(dir, name), 'utf8'); } catch { return { name, state: 'absent', version: null }; }
    const version = parseAgentMarker(text);
    return version ? { name, state: 'ours', version } : { name, state: 'foreign', version: null };
  });
  const ours = found.filter((f) => f.state === 'ours');
  const oldest = ours.reduce((a, f) => (a === null || compareSemver(f.version, a) < 0 ? f.version : a), null);
  const state = found.some((f) => f.state === 'foreign') ? 'foreign'
    : !ours.length ? 'absent'
      : ours.length < AGENT_FILES.length ? 'partial' : 'ours';
  return {
    dir, state, version: oldest, present: ours.length, total: AGENT_FILES.length,
    // Any marked file that is not this install's own version is a scope worth
    // refreshing — string inequality, not compareSemver, so a prerelease marker
    // beside the matching release is reported rather than read as current.
    behind: ours.some((f) => f.version !== current),
  };
}

/** One scope's rules file in doctor's summary line, with the refresh hint when it is old. */
const rulesLabel = (r) => (
  r.state === 'absent' ? 'absent'
    : r.state === 'foreign' ? 'foreign (no marker)'
      : `v${r.version}${r.behind ? ` [run: omelette-fleet rules${r.scope === 'global' ? ' --global' : ''}]` : ''}`);

/** One scope's agent definitions in the same line: how many are ours, at which version. */
const agentsLabel = (r) => (
  r.state === 'absent' ? 'absent'
    : r.state === 'foreign' ? 'foreign (no marker)'
      : `${r.state === 'partial' ? `partial (${r.present}/${r.total})` : `v${r.version} (${r.present})`}${r.behind ? ` [run: omelette-fleet rules --agents${r.scope === 'global' ? ' --global' : ''}]` : ''}`);

/** Both scopes of agent definitions, for doctor's one-line summary and update's hint. */
function agentsReport(current) {
  return [
    { scope: 'project', ...agentsState({ current }) },
    { scope: 'global', ...agentsState({ current, global: true }) },
  ];
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

/** What the registry says about this unit — and whether it is even ours (see findRegistration). */
function mcpLine(name, prefix, reg, expected) {
  const server = `${prefix}-${name}`;
  if (!reg) return `${server} not registered — run: omelette-fleet install --units ${name}`;
  const file = reg.exists ? '[file exists]' : '[FILE MISSING]';
  const cmd = reg.command ? `${reg.command} ` : '';
  return reg.ours
    ? `${server} registered (${reg.scope}) → ${cmd}${reg.target} ${file}`
    : `${server} registered elsewhere (${reg.scope}) → ${cmd}${reg.target || '(no args)'} ${file}\n              not this clone — install here would point it at ${expected}`;
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
  // Fail-soft, and cached for a day: doctor is a diagnosis of THIS machine, and
  // "GitHub was unreachable" is never one of its findings.
  const upd = updateCheckEnabled({}) ? await cachedCheck({ home: fleetHome(), current: PKG.version }) : null;
  out(`version       ${PKG.version} · latest ${upd ? (upd.latest || 'unknown') : 'check disabled'}${upd && upd.behind ? '   [run: omelette-fleet update]' : ''}`);
  out(`fleet home    ${home.dir}`);
  out(`fleet config  ${configPath()}${existsSync(configPath()) ? '' : ' (absent — built-in defaults in force)'}`);
  out(`claude CLI    ${claudePath || 'not found in PATH'}`);
  out(`claude config ${claude.path}${claude.error ? ` (${claude.error})` : ''}${claude.source === 'CLAUDE_CONFIG_DIR' ? '   [via CLAUDE_CONFIG_DIR]' : ''}`);
  // The managed files, both scopes, read-only and never a fault: a project
  // without them is a perfectly healthy project.
  out(`rules         ${rulesReport(PKG.version).map((r) => `${r.scope}: ${rulesLabel(r)}`).join(' · ')}`);
  out(`agents        ${agentsReport(PKG.version).map((r) => `${r.scope}: ${agentsLabel(r)}`).join(' · ')}`);
  out();

  let faults = 0;
  for (const name of UNIT_ORDER) {
    const unit = UNITS[name];
    const bin = resolveBin(unit);
    const binPath = whichBin(bin);
    const cfg = cfgFor(name);
    const server = serverPathFor(name);
    const reg = findRegistration(claude.config, `${prefix}-${name}`, server);
    const problems = [];

    out(`── ${name} (${unit.label}) ${'─'.repeat(Math.max(0, 56 - name.length - String(unit.label).length))}`);
    const binEnv = unit.bin.env ? `${unit.bin.env}=${process.env[unit.bin.env] ? process.env[unit.bin.env] : '(unset)'}` : '(no env override)';
    out(`  bin         ${bin} → ${binPath || 'not found in PATH'}   [${binEnv}]`);
    if (binPath) {
      out(`  version     ${await probeVersion(unit, binPath)}`);
      const login = await probeLogin(unit, binPath);
      const label = login.label || (login.state === 'in' ? 'OK' : login.state === 'out' ? 'SIGNED OUT' : 'unknown');
      out(`  login       ${label} — ${login.detail}`);
      if (login.state === 'out') problems.push('signed out');
    } else {
      out('  version     — (no binary)');
      out('  login       unknown (no binary)');
      problems.push(`${bin} not found in PATH`);
    }
    out(`  config      ${ceilingLine(name, cfg)}`);
    for (const line of configRows(name, cfg, '              ')) out(line);
    for (const w of cfg.warnings) out(`  warning     ${w}`);
    // A registration whose server file is gone cannot start at all — that is a
    // fault in its own right, however healthy the vendor CLI looks.
    if (reg && !reg.exists) problems.push(`the registered server file is missing (${reg.target || 'no args'})`);
    out(`  mcp         ${mcpLine(name, prefix, reg, server)}`);
    out(`  status feed ${cfg.values.status ? '' : '(disabled in config) '}${home.writable ? `${home.dir} is writable` : `${home.dir} is NOT writable — ${home.error}`}`);
    // Enabled AND registered AND broken. A unit you never wired up is not a fault.
    if (cfg.values.enabled && reg && problems.length) {
      faults++;
      out(`  FAULT       enabled and registered, but: ${problems.join('; ')}`);
    }
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
    ? `${faults} unit(s) enabled AND registered are broken — see the FAULT lines above.`
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

/** What a JSON value IS, for a refusal message that tells the operator what to fix. */
const jsonKind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : `a ${typeof v}`);

/**
 * Write keys into <home>/fleet.config.json, merging into what is already there
 * so nothing else in the file is lost — and refusing outright when the shape it
 * would have to merge into is not an object, because silently replacing an
 * operator's data is worse than any error message.
 *
 * KNOWN LIMITATION: two concurrent `set` runs are a read-modify-write race —
 * the file itself is written atomically (tmp + rename), but the merge is not
 * serialized; this is an operator tool run by one person at a keyboard.
 */
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
  // The merge targets have to BE objects. Anything else and we would be
  // deleting whatever is there, not editing it.
  const shape = [];
  if (file.config.units !== undefined && !isObj(file.config.units)) {
    shape.push(`"units" is ${jsonKind(file.config.units)}, not an object`);
  } else if (isObj(file.config.units)) {
    for (const name of [...new Set(assignments.map((a) => a.name))]) {
      const entry = file.config.units[name];
      if (entry !== undefined && !isObj(entry)) shape.push(`"units.${name}" is ${jsonKind(entry)}, not an object`);
    }
  }
  if (shape.length) {
    for (const m of shape) err(`omelette-fleet set: ${file.path}: ${m}`);
    err('omelette-fleet set: fix the file by hand first — refusing to replace it.');
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
  let parsed = false;
  try { args = JSON.parse(argsJson); parsed = true; } catch (e) { errors.push(`bad json args: ${(e && e.message) || e}`); }
  // MCP tool arguments are an object. A bare scalar or an array would be sent
  // as-is and rejected by the server with a far less useful message.
  if (parsed && !isObj(args)) errors.push(`json args must be a JSON object like '{"prompt":"…"}' — got ${jsonKind(args)}`);
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
  if (cmd === 'help' && COMMANDS[rest[0]]) { out(commandHelp(rest[0])); return 0; }
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { out(HELP); return 0; }
  if (cmd === '--version' || cmd === '-v') { out(PKG.version); return 0; }
  // `install --help` asks a question; answering it with "unknown flag" is rude.
  if (COMMANDS[cmd] && (rest.includes('--help') || rest.includes('-h'))) { out(commandHelp(cmd)); return 0; }
  switch (cmd) {
    case 'install': return cmdInstall(rest);
    case 'uninstall': return cmdUninstall(rest);
    case 'update': return cmdUpdate(rest);
    case 'rules': return cmdRules(rest);
    case 'doctor': return cmdDoctor(rest);
    case 'show': return cmdShow(rest);
    case 'set': return cmdSet(rest);
    case 'call': return cmdCall(rest);
    default:
      err(`omelette-fleet: unknown command "${cmd}"`);
      err('commands: install, uninstall, update, rules, doctor, show, set, call — `omelette-fleet --help` for the full usage.');
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code || 0; },
  (e) => { err(`omelette-fleet: ${(e && e.stack) || e}`); process.exitCode = 1; },
);
