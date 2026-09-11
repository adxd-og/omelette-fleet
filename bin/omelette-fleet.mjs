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
 * registration pointing at a file that is gone) sets exit 1 — that, and a
 * BREACHED sandbox probe under `--probe-sandbox`: a unit you deliberately
 * never wired up is not a fault.
 *
 * READ-ONLY ABOUT THE MACHINE: Claude Code's config — $CLAUDE_CONFIG_DIR/
 * .claude.json if that is set, else ~/.claude.json — is parsed, never written,
 * and so is its settings.json, which doctor reads to say whether the guard hook
 * is wired and `rules --hooks` only ever prints a snippet for. The only writer
 * of those is `claude` and the operator. The files this CLI writes are
 * <home>/fleet.config.json, <home>/update-check.json and, on request, the
 * managed files of core/rules.mjs's KINDS — the rules file, the agent
 * definitions and the skill (`rules --agents`), the guard script
 * (`rules --hooks`) — each of those only when it carries our marker.
 *
 * TEST HOOK — OMELETTE_PKG_ROOT: `update` (and the install-kind detection it
 * uses) treats that directory as the package root instead of this checkout, so
 * the whole git flow can be exercised against a throwaway fixture repo. It is
 * honoured NOWHERE else: server paths, the shipped example config and doctor
 * all still come from the real ROOT below.
 */
import { accessSync, chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../core/spawn.mjs';
import { callUnitServer } from '../core/client.mjs';
import { AGENT_SETTINGS_SCHEMA, HANDOFF_SCHEMA, KEY_SCHEMA, SETTINGS_SCHEMA, WORKFLOW_SCHEMA, coerce, configPath, fleetHome, fleetSettings, handoffSettings, unitConfig, workflowSettings, writeFleetConfig } from '../core/config.mjs';
import { createResultStore, formatEntry, isValidResultId, renderResult } from '../core/results.mjs';
import { cachedCheck, compareSemver, currentVersion, detectInstall, packageRoot, updateCheckEnabled } from '../core/update.mjs';
import { CONTEXT_WINDOW_DEFAULT, CONTEXT_WINDOW_ENV, CONTEXT_WINDOW_SETTING, HOOK_EVENTS, HOOK_FILES, KINDS, MERGE_SENTENCES, MODEL_ENV, MODEL_SETTING, MODEL_WINDOW, MODEL_WINDOW_SOURCE, agentSettings, contractFor, hookSettingsSnippet, parseContextWindow, parseHookHandoff, parseModelWindow, parseRulesMarker, readRulesFile, rulesTarget, settingsTarget, settingsTargets } from '../core/rules.mjs';
import { createUnitRuntime, resolveBin } from '../core/unit.mjs';
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
    args: '[--prefix <name>] [--units <a,b,c>] [--rules] [--dry-run] [--force]',
    body: [
      'Register one MCP server per unit with `claude mcp add -s user`',
      'as <prefix>-<unit>, and create <home>/fleet.config.json from the',
      'shipped example if it does not exist yet (never overwritten).',
      'A unit whose vendor CLI is not in PATH is skipped unless --force.',
      '--rules then does `rules --agents --hooks` in the current directory:',
      'the operating rules, both sub-agent definitions, the /omelette-test',
      'skill and the guard script, followed by the settings.json snippet',
      'and the `merge policy` the rules file was written with.',
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
    args: '[--global] [--agents] [--hooks] [--print] [--remove] [--force] [--dry-run]',
    body: [
      'Write the fleet\'s operating rules (units propose, this session applies;',
      'tester flow; routing table) to <cwd>/.claude/rules/omelette-fleet.md,',
      'which Claude Code loads like CLAUDE.md. --global writes it under',
      '$CLAUDE_CONFIG_DIR or ~/.claude instead. The file carries a version',
      'marker on line 1: re-running refreshes a file with the marker, and a',
      'file WITHOUT it is never touched (--force replaces it). --print sends',
      'the text to stdout; --remove deletes only a file with the marker, plus',
      "the skill's own directory once its SKILL.md is gone and it is empty —",
      'a skill IS a directory, and an empty one still reads as installed.',
      '--agents also writes two sub-agent definitions (omelette-coder:',
      'Opus xhigh; omelette-tester: Sonnet xhigh, both disallowedTools:',
      'Agent) into .claude/agents, where their effort is set, and the',
      '/omelette-test skill into .claude/skills. --hooks writes the',
      'guard script into .claude/hooks and prints the settings.json',
      'snippet that calls it — that file is yours to edit, never ours.',
    ],
  },
  doctor: {
    args: '[--prefix <name>] [--probe-models] [--probe-sandbox]',
    body: [
      'First the machine: the fleet home and config, the claude CLI and the',
      'file its registrations live in, then one line per managed kind —',
      'rules, agents, skills, hooks — for both scopes, saying whose each',
      'file is and, for hooks, which events actually call the guard. Under',
      'them a `handoff` line says what the INSTALLED guard will do about',
      'the auto-handoff — the threshold, the context window and where that',
      'window came from, whether the Stop gate is on, and how many ledgers',
      'there are to guard — read back out of the script itself. A',
      '`contract` line under it says how much of the fleet contract a unit',
      'server started HERE would send at initialize: short when this',
      'project (or the global scope) already carries the rendered rules',
      'file, full when neither does, and whatever the `contract` config',
      'key says when that is not `auto`. While',
      'something is missing it adds ONE `next` line naming the command that',
      'fixes it; none of that ever changes the exit code. A `merge policy`',
      'line says which policy the config holds — session or pr — and whether',
      'the rendered rules file carries that sentence yet (`rules rendered`,',
      '`config; rules not re-rendered — run rules`, `config; no rules file`);',
      'while it is `session` and this repository looks PR-gated (a pull-request',
      'template, a CODEOWNERS file, or a protected main when `gh` is on PATH),',
      'it ends with one hint. A hint, never a fault.',
      'Then per unit: the vendor binary, its --version, the login state, the',
      'resolved fleet config with sources, the MCP registration and',
      'whether the status feed is writable. Exits 1 when a unit that is',
      'enabled AND registered has a missing binary, is signed out, is',
      'registered against a server file that no longer exists, or came',
      'back BREACHED from --probe-sandbox.',
      '--probe-models spends real Codex calls to test every catalog id.',
      '--probe-sandbox spends ONE real call per unit that is enabled,',
      'registered as OURS and has a binary: each is asked to write a file',
      'into a throwaway 0700 directory under the OS temp dir, and the',
      'verdict is read off the filesystem — BREACHED (exit 1) for any entry',
      'in it, or for a directory that is gone; held for an answered call',
      'that left it empty; skipped, with the reason, for everything else,',
      "including a run still going at the probe's own deadline (the unit's",
      'timeoutS, capped at 120 s for the whole probe). The directory is',
      'always removed.',
    ],
  },
  show: {
    args: '[<unit> | fleet | agents | handoff | workflow]',
    body: [
      'Every config key for one unit or all of them: value, where it came',
      'from (default / file:defaults / file / env:NAME), and the ceiling.',
      '`fleet` is the top-level block (`contract`, `updateCheck`), `agents`',
      'the sub-agent block `rules --agents` renders from, `handoff` the',
      'auto-handoff block `rules --hooks` renders into the guard, and',
      '`workflow` the merge policy `rules` renders into the rules file.',
    ],
  },
  set: {
    args: '<key>=<value> | <unit>.<key>=<value> | agents.<agent>.<key>=<value> | handoff.<key>=<value> | workflow.<key>=<value> [...]',
    body: [
      'Change keys in <home>/fleet.config.json. Unknown units, agents,',
      'unknown keys and invalid values are refused; the rest of the file',
      'is kept. A bare `<key>=<value>` sets a fleet-wide key — `contract`,',
      '`updateCheck` — which a unit server reads when it STARTS. An agent',
      'setting reaches a session on the next `omelette-fleet rules',
      '--agents`, a handoff setting on the next `omelette-fleet rules',
      '--hooks`, and the merge policy on the next `omelette-fleet rules`,',
      'which re-render those files.',
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
  results: {
    args: '[<unit>] [<id>] [--path] [--stats [--since <when>]]',
    body: [
      'Print what the units spooled. Every tool call writes its answer to',
      '<home>/results/<unit>/<id>.md before the response is sent, so an',
      'answer a client dropped — a timeout, a cancellation, a restart — is',
      'still on disk. No arguments: the last 10 across the fleet, newest',
      'first. A unit: its last 10. An id (with or without its unit): that',
      'result, header and text. --path prints the file path instead of the',
      'content. --stats prints what the spool cost instead of listing it:',
      'one row per unit and a total — calls, ok/error/cancelled, partial,',
      'wall time, bytes, and tokens in / out where every call in the row',
      'reported them. --since 24h, --since 7d or --since 2026-09-09 narrows',
      'that on startedAt. Reads the files directly: no server, nothing spent.',
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
  '  omelette-fleet set agents.tester.maxTurns=120 && omelette-fleet rules --agents',
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

/**
 * `<prefix>-<unit>` → the prefix, or null when the name is not that shape.
 * The prefix is reported, never used to build a path, so nothing here filters
 * its characters: the name an operator actually registered is the name doctor
 * has to talk about.
 */
function prefixOf(name, unit) {
  const suffix = `-${unit}`;
  const s = String(name || '');
  return s.length > suffix.length && s.endsWith(suffix) ? s.slice(0, -suffix.length) : null;
}

/**
 * Two paths naming the same directory — by resolution first, then through
 * links. Claude Code keys a project scope by the directory the session ran in,
 * and on macOS a temp directory reaches the same place as /var/… and
 * /private/var/…, so comparing the strings would call a project's own
 * registration somebody else's.
 */
const sameLocation = (a, b) => {
  if (!a || !b) return false;
  try { if (resolvePath(a) === resolvePath(b)) return true; } catch { return false; }
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
};

/**
 * The project's checked-in `.mcp.json` — the third place Claude Code takes MCP
 * registrations from, and one doctor did not read before 0.3.3. PARSED, NEVER
 * WRITTEN, exactly like `.claude.json`. Absence is the normal case.
 */
function readProjectMcp({ cwd = process.cwd() } = {}) {
  const path = join(cwd, '.mcp.json');
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { path, exists: false, config: null, error: null };
    return { path, exists: true, config: null, error: (e && e.message) || String(e) };
  }
  try {
    const parsed = JSON.parse(raw);
    return isObj(parsed)
      ? { path, exists: true, config: parsed, error: null }
      : { path, exists: true, config: null, error: 'top-level is not an object' };
  } catch (e) {
    return { path, exists: true, config: null, error: (e && e.message) || String(e) };
  }
}

/**
 * Every place a registration for THIS project can live, IN CLAUDE CODE'S OWN
 * PRECEDENCE, so the first entry found under a name is the one that actually
 * runs: the project's own scope inside `.claude.json` (Claude's "local" scope —
 * the entry keyed by the directory doctor is running in, because another
 * project's servers are not this project's), then the project's checked-in
 * `.mcp.json` ("project"), then the user's `mcpServers` last.
 *
 * The labels are what doctor prints: `project` for the `.claude.json` entry,
 * `.mcp.json` for the file, `user` for the user scope.
 */
function registrationBuckets(config, mcpJson, cwd) {
  const buckets = [];
  if (isObj(config) && isObj(config.projects)) {
    for (const [dir, p] of Object.entries(config.projects)) {
      if (isObj(p) && isObj(p.mcpServers) && sameLocation(dir, cwd)) buckets.push(['project', p.mcpServers]);
    }
  }
  if (isObj(mcpJson) && isObj(mcpJson.mcpServers)) buckets.push(['.mcp.json', mcpJson.mcpServers]);
  if (isObj(config) && isObj(config.mcpServers)) buckets.push(['user', config.mcpServers]);
  return buckets;
}

/**
 * Our servers, found by WHERE THEY POINT rather than by what they are called.
 * An entry is ours when its command is node and its args path is exactly this
 * checkout's `servers/<unit>.mjs` — the same test `findRegistration` makes —
 * and the name it was registered under is reported, whatever prefix that is.
 * An entry that merely WEARS one of our names is returned too, with
 * `ours: false`, so doctor can go on saying "registered elsewhere" about it
 * instead of pretending the name is free.
 *
 * @param {object} unitPaths { <unit>: <this checkout's server path> }
 * @returns {{unit:string, name:string, prefix:string|null, scope:string,
 *            ours:boolean, entry:object, command:string, target:string,
 *            exists:boolean}[]}
 */
function findOurRegistrations(config, mcpJson, unitPaths, { cwd = process.cwd() } = {}) {
  const samePath = (a, b) => {
    try { return !!a && !!b && resolvePath(a) === resolvePath(b); } catch { return false; }
  };
  const found = [];
  // Names resolve across the scopes BEFORE anything is asked about ownership:
  // the first bucket that defines a name is the one Claude Code starts, so an
  // entry further down under that same name is dead config and must not be
  // counted — including when the entry that shadows it is not ours at all. A
  // `codex-review` in the project scope pointing at another clone means
  // `codex-review` runs that clone, however much the user scope's entry of the
  // same name points here.
  const seen = new Set();
  for (const [scope, servers] of registrationBuckets(config, mcpJson, cwd)) {
    for (const [name, entry] of Object.entries(servers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!isObj(entry)) continue;
      const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
      const target = args.find((a) => a.endsWith('.mjs')) || args[args.length - 1] || '';
      const command = typeof entry.command === 'string' ? entry.command : '';
      const isNode = command === process.execPath || /^node(\.exe)?$/i.test(basename(command));
      const byPath = UNIT_ORDER.find((u) => isNode && samePath(target, unitPaths[u]));
      const byName = UNIT_ORDER.find((u) => prefixOf(name, u) !== null);
      const unit = byPath || byName;
      if (!unit) continue;
      found.push({
        unit, name, prefix: prefixOf(name, unit), scope,
        ours: !!byPath, entry, command, target,
        exists: !!target && existsSync(target),
      });
    }
  }
  return found;
}

/**
 * The prefix doctor reports on. An explicit `--prefix` is the answer, always.
 * Without one: when nothing of ours is registered as `omelette-*` and our
 * servers are found under exactly ONE other prefix, that prefix is what this
 * machine actually runs — reporting `omelette-* not registered` about a working
 * install is a lie that ends in a pointless `install`. Two prefixes are
 * ambiguous, so doctor names both and keeps the default rather than guessing
 * which install the operator meant.
 *
 * @param {string|null} asked the value of --prefix, or null when it was omitted.
 * @returns {{prefix:string, line:string|null}} `line` is the report line's body.
 */
function adoptPrefix(asked, found) {
  if (asked) return { prefix: asked, line: null };
  const prefixes = [...new Set(found.filter((r) => r.ours && r.prefix).map((r) => r.prefix))].sort();
  if (!prefixes.length) return { prefix: DEFAULT_PREFIX, line: null };
  if (prefixes.length === 1) {
    return prefixes[0] === DEFAULT_PREFIX
      ? { prefix: DEFAULT_PREFIX, line: null }
      : { prefix: prefixes[0], line: `${prefixes[0]} (found on the registrations)` };
  }
  // More than one prefix is more than one install, and that is ambiguous
  // whether or not `omelette` is among them: a machine carrying `orion-codex`
  // and `omelette-gemini` has two half-installs, and silently reporting on the
  // default hides the other half. The default is kept; the others are named.
  return {
    prefix: DEFAULT_PREFIX,
    line: `${DEFAULT_PREFIX} — our servers are also registered as ${prefixes.filter((p) => p !== DEFAULT_PREFIX).map((p) => `${p}-*`).join(', ')}; pass --prefix <name> to look at one`,
  };
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

// ─── the client's timeout walls ──────────────────────────────────────────────

/** Claude Code's wall-clock limit for one MCP tool call. Unset = ~28 h. */
const WALL_ENV = 'MCP_TOOL_TIMEOUT';
const WALL_DEFAULT_NOTE = 'default ~28 h';
/** Its idle wall: a stdio call that neither answers nor sends progress dies at 30 min. `0` disables it. */
const IDLE_ENV = 'CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT';
const IDLE_DEFAULT_MS = 1800000;
/** A per-server `timeout` below this is refused by the client, so it bounds nothing. */
const MIN_SERVER_TIMEOUT_MS = 1000;
/** gemini's process-group SIGKILL sits 60 s above the timeout it hands agy. */
const GEMINI_HARD_KILL_S = 60;
/** gemini_deep_research: decompose, gather, synthesise — each stage retried once. */
const DEEP_STAGES = 3;
const DEEP_ATTEMPTS = 2;

/**
 * The settings files a read tripped over, each named ONCE. Two readers open
 * the same four files for different blocks — `readClientEnv` for `env`,
 * `hookWiringAt` for `hooks` — and an operator with one broken file wants one
 * line about it, not one per reader. First-seen order, which is the client's
 * own precedence for the env half.
 */
function mergeUnreadable(...lists) {
  const seen = new Set();
  for (const list of lists) for (const p of list || []) seen.add(p);
  return [...seen];
}

/** What the guard reads of a settings file, and doctor reads no more. */
const SETTINGS_READ_MAX = 1024 * 1024;
/** Not a file's contents: the one answer that means "it is there and it is lost". */
const UNREADABLE = 'unreadable';

/**
 * THE SAME CEILING ON A RULES FILE. `rulesState` wants line 1 and
 * `renderedMerge` one sentence out of a file this package renders at a few KiB,
 * so a megabyte is generous; what the cap is really for is the file at that
 * path that is NOT ours, which may be any size at all. The read itself goes
 * through core/rules.mjs's `readRulesFile`, the same bounded reader the unit
 * servers' marker test takes, so no reader of that path can be the one that
 * hangs on a pipe.
 */
const RULES_READ_MAX = 1024 * 1024;

/**
 * ONE bounded read for every settings file this CLI opens — the `env` block,
 * the top-level keys and the hook wiring all come through here, so no reader
 * can be the one that hangs.
 *
 * O_NONBLOCK and an fstat, exactly like the guard's own reader: a FIFO under
 * the name of a settings file opens instantly and is then refused as not a
 * regular file, rather than blocking doctor until somebody writes to it. The
 * symlink is FOLLOWED on purpose — a dotfile setup legitimately keeps these
 * files behind one, the read takes at most 1 MiB, and nothing is ever written
 * back through it. A file bigger than that cap comes back TRUNCATED, which is
 * what the guard sees too: half an object parses as nothing, and the caller
 * names the file instead of acting on a fragment of it.
 *
 * @returns {string|null} the bytes as UTF-8, null when the file is simply not
 *   there — the normal case — or `UNREADABLE` when it is there and this
 *   process may not have it.
 */
function readSettingsFile(path) {
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return UNREADABLE;
    const length = Math.max(0, Math.min(SETTINGS_READ_MAX, st.size));
    if (!length) return '';
    const buf = Buffer.alloc(length);
    return buf.subarray(0, readSync(fd, buf, 0, length, 0)).toString('utf8');
  } catch (e) {
    // ENOENT is the normal case — most machines have at most two of these four
    // files. Anything else means the contents are there and lost.
    return e && e.code === 'ENOENT' ? null : UNREADABLE;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * One variable out of CLAUDE CODE's environment, as the client itself would
 * resolve it: the process environment first, then the `env` block of each
 * settings file in Claude Code's own precedence — the project's
 * settings.local.json, the project's settings.json, then the user scope's pair
 * under $CLAUDE_CONFIG_DIR or ~/.claude. `settingsTargets` lists a scope in
 * WRITE order (settings.json first) and the client READS the local one first,
 * so each scope's pair is reversed here.
 *
 * PARSED, NEVER WRITTEN, like every other settings read in this file. A file
 * that is ABSENT is skipped in silence — most machines have at most two of
 * these four. A file that EXISTS and cannot be parsed into an object is
 * skipped too, and NAMED: a variable written into a file with a trailing
 * comma is a variable the client never saw, and a report that says nothing
 * about it sends the operator looking at the wrong thing. A file that parses
 * and has no `env` object is readable and simply says nothing. A value that is
 * not a scalar is skipped: the client could not pass it to a child either.
 *
 * The scan stops at the first hit, so `unreadable` names the files this lookup
 * actually opened — the ones AHEAD of the value in the client's precedence,
 * which are exactly the ones whose contents were lost. Doctor merges the list
 * with `hookWiringAt`'s, which always opens all four.
 *
 * @returns {{value: string|null, source: string|null, unreadable: string[]}}
 *   `source` is 'process env' or the absolute path of the file the value came
 *   from; `unreadable` holds absolute paths.
 */
function readClientEnv(name, { cwd = process.cwd(), env = process.env } = {}) {
  if (env[name] !== undefined && String(env[name]) !== '') return { value: String(env[name]), source: 'process env', unreadable: [] };
  const files = [
    ...settingsTargets({ global: false, cwd, env }).slice().reverse(),
    ...settingsTargets({ global: true, cwd, env }).slice().reverse(),
  ];
  const unreadable = [];
  for (const { path } of files) {
    const text = readSettingsFile(path);
    if (text === null) continue;
    if (text === UNREADABLE) { unreadable.push(path); continue; }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!isObj(parsed)) { unreadable.push(path); continue; }
    if (!isObj(parsed.env)) continue; // readable, and says nothing about this variable
    const raw = parsed.env[name];
    if (raw === undefined || raw === null) continue;
    if (!['string', 'number', 'boolean'].includes(typeof raw)) continue;
    return { value: String(raw), source: path, unreadable };
  }
  return { value: null, source: null, unreadable };
}

/**
 * One TOP-LEVEL setting out of Claude Code's own settings files — `readClientEnv`
 * reads the `env` block, and this reads the file's own keys, which is where
 * `autoCompactWindow` and `model` live. The user scope only, local file first,
 * exactly as the guard resolves it: a line describing a resolution the guard
 * would not make is worse than no line.
 *
 * `accept` IS PART OF THE SCAN, not something the caller applies afterwards.
 * The guard tries each file in turn and keeps looking past a value it cannot
 * read, so `settings.local.json` holding `"autoCompactWindow": "garbage"` and
 * `settings.json` holding `"500k"` resolves to 500 000 — and a doctor that
 * stopped at the garbage would report the 200 000 default for a hook that is
 * measuring against half a million.
 *
 * PARSED, NEVER WRITTEN, like every other settings read in this file. A file
 * that is ABSENT is skipped in silence — most machines have at most one of
 * these two. One that EXISTS and cannot be read, or does not parse into an
 * object, is skipped and NAMED, by the same rule `readClientEnv` uses: the
 * window this scan resolved may be the one that file was meant to change, and a
 * report that says nothing about it sends the operator looking at the wrong
 * thing. `unreadable` holds the files THIS scan opened — the ones ahead of the
 * value in the client's own order — and doctor merges the list with the ones
 * `readClientEnv` and `hookWiringAt` collect.
 *
 * @param {{global?:boolean, cwd?:string, env?:object, accept?:Function}} o
 *   `accept` turns the raw string into the value worth having, or null when
 *   this file's is not one.
 * @returns {{value: any, source: string|null, unreadable: string[]}}
 */
function readClientSetting(name, { global = true, cwd = process.cwd(), env = process.env, accept = (v) => v } = {}) {
  const unreadable = [];
  for (const { path } of settingsTargets({ global, cwd, env }).slice().reverse()) {
    const text = readSettingsFile(path);
    if (text === null) continue;
    if (text === UNREADABLE) { unreadable.push(path); continue; }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!isObj(parsed)) { unreadable.push(path); continue; }
    const raw = parsed[name];
    if (raw === undefined || raw === null) continue;
    if (!['string', 'number'].includes(typeof raw)) continue;
    const value = accept(String(raw));
    if (value === null || value === undefined) continue; // not a value: the next file may hold one
    return { value, source: path, unreadable };
  }
  return { value: null, source: null, unreadable };
}

/** A whole number of milliseconds, or null — a variable holding "30m" is not a bound. */
const msValue = (raw, { min = 1 } = {}) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : null;
};

/** 1800000 → `30 min`; 90000 → `90 s`. Whichever shape the operator would recognise. */
const fmtWindow = (ms) => (ms % 60000 === 0 ? `${ms / 60000} min` : `${Math.round(ms / 1000)} s`);

/**
 * A byte budget in the unit it was WRITTEN in: `52428800` → `50 MB`, `524288`
 * → `512 KB`, `1000` → `1000 B`. Rounding a small budget into megabytes printed
 * `max 0 MB` for a cap that is perfectly real — a number nobody could act on.
 */
const fmtBytes = (n) => (n >= 1024 * 1024
  ? `${Math.round(n / (1024 * 1024))} MB`
  : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** 'process env' stands alone; a file is named with the block it was read from. */
const envSource = (source) => (source === 'process env' ? 'process env' : `${source} env`);

/**
 * The IDLE wall. Since Claude Code 2.1.203 a stdio tool call that sends neither
 * a response nor `notifications/progress` for 30 minutes is aborted for
 * idleness, whatever the wall-clock limit says — which is the wall Grok's
 * 1800 s sits exactly on. Informational: the units send progress, and this line
 * says whether the client is even listening for it.
 *
 * @param {{unit:string, timeoutS:number}} longest the enabled unit with the
 *   largest `timeoutS` — the idle window is compared with the plain value, not
 *   with gemini's hard-kill margin, because what matters is how long one run
 *   can stay silent under its own timeout.
 */
function idleWall({ longest, cwd = process.cwd(), env = process.env, read = readClientEnv } = {}) {
  // `read` is injectable, so a caller's double may answer without the field.
  const { value, source, unreadable } = read(IDLE_ENV, { cwd, env });
  const parsed = value === null ? null : msValue(value, { min: 0 });
  const disabled = parsed === 0;
  const ms = parsed === null || disabled ? IDLE_DEFAULT_MS : parsed;
  const head = value === null
    ? `${IDLE_ENV} unset → 30 min default`
    : disabled
      ? `${IDLE_ENV}=0 (${envSource(source)}) → disabled`
      : parsed === null
        ? `${IDLE_ENV}=${value} (${envSource(source)}) is not a whole number of ms — ignored, 30 min default`
        : `${IDLE_ENV}=${parsed} ms (${envSource(source)}) → ${fmtWindow(parsed)}`;
  const reaches = !disabled && longest.timeoutS * 1000 >= ms;
  const tail = disabled
    ? ' · ok'
    : reaches
      ? `; ${longest.unit}.timeoutS=${longest.timeoutS} s reaches it — units send progress every 30 s when the client passes a progress token; otherwise set ${IDLE_ENV}=0 or a per-server "timeout"`
      : `; the longest run is ${longest.unit}.timeoutS=${longest.timeoutS} s · ok`;
  return { line: `idle: ${head}${tail}`, ms, disabled, raw: value, source, reaches, unreadable: unreadable || [] };
}

/**
 * Both walls as lines, NEVER a fault. Pure: everything it reads comes through
 * `read`, so the whole report is decided by its arguments.
 *
 * WALL-CLOCK. `MCP_TOOL_TIMEOUT` bounds one tool call. Needed is the longest a
 * single call can honestly take: `timeoutS` per unit, plus gemini's 60 s
 * hard-kill margin, in milliseconds. Unset means the client's documented ~28 h,
 * which no fleet call reaches — reported as ok rather than as a finding.
 * A per-server `timeout` on the registration overrides the env for that ONE
 * server, so it gets its own line instead of moving the shared one.
 *
 * DEEP RESEARCH is a bound of its own and deliberately NOT part of `needed`:
 * `gemini_deep_research` is documented as a tool to run deliberately, and
 * sizing every session's wall for it would be advice nobody asked for.
 *
 * @param {object} o
 * @param {{unit:string, enabled:boolean, timeoutS:number}[]} o.units every unit, enabled or not.
 * @param {object} o.registration our registration records keyed by unit —
 *   `registration[unit].entry.timeout` is the client's per-server override,
 *   `.name` and `.scope` are what the line calls it.
 * @returns {{wall:object|null, idle:object|null, deep:object|null,
 *            lines:string[], next:string|null, snippet:string|null,
 *            unreadable:string[]}} `unreadable` holds the absolute path of
 *   every settings file the two env lookups could not parse, each named once.
 */
function timeoutWalls({ units = [], registration = {}, cwd = process.cwd(), env = process.env, read = readClientEnv } = {}) {
  const enabled = units.filter((u) => u.enabled);
  // No enabled unit, no call to bound: an empty report rather than a line about
  // limits nothing can reach.
  if (!enabled.length) return { wall: null, idle: null, deep: null, lines: [], next: null, snippet: null, unreadable: [] };

  const needFor = (u) => (u.timeoutS + (u.unit === 'gemini' ? GEMINI_HARD_KILL_S : 0)) * 1000;
  const because = (u) => (u.unit === 'gemini'
    ? `gemini.timeoutS=${u.timeoutS} s + ${GEMINI_HARD_KILL_S} s hard kill`
    : `${u.unit}.timeoutS=${u.timeoutS} s`);
  const worst = enabled.reduce((a, b) => (needFor(b) > needFor(a) ? b : a));
  const needed = needFor(worst);

  const { value, source, unreadable: wallUnreadable } = read(WALL_ENV, { cwd, env });
  const parsed = value === null ? null : msValue(value);
  // Absent, or set to something that is not milliseconds: the client falls back
  // to its own default, and nothing here can reach it.
  const effective = parsed;
  const ok = effective === null || effective >= needed;
  const clause = value === null
    ? `${WALL_ENV} unset (${WALL_DEFAULT_NOTE})`
    : parsed === null
      ? `${WALL_ENV}=${value} (${envSource(source)}) is not a whole number of ms — ignored, ${WALL_DEFAULT_NOTE}`
      : `${WALL_ENV}=${parsed} ms (${envSource(source)})`;
  const lines = [`wall-clock: ${clause} ${ok ? '≥' : '<'} ${needed} needed${ok ? '' : ` (${because(worst)})`} · ${ok ? 'ok' : 'TOO LOW'}`];

  // The snippet follows the line it answers, where the eye already is. It is a
  // paste, never a write: this CLI does not edit settings files.
  const snippet = ok ? null : `{"env":{"${WALL_ENV}":"${needed}"}}`;
  if (snippet) lines.push(`raise it: ${snippet} — merge into .claude/settings.json or ~/.claude/settings.json (omelette-fleet never writes them)`);

  const servers = [];
  for (const u of enabled) {
    const reg = registration[u.unit];
    const raw = reg && isObj(reg.entry) ? reg.entry.timeout : undefined;
    if (raw === undefined) continue;
    const own = msValue(raw, { min: MIN_SERVER_TIMEOUT_MS });
    const need = needFor(u);
    if (own === null) {
      servers.push({ unit: u.unit, name: reg.name, ms: null, ok: true });
      lines.push(`${reg.name} "timeout": ${JSON.stringify(raw)} is not an integer ≥ ${MIN_SERVER_TIMEOUT_MS} ms — the client ignores it`);
      continue;
    }
    const fits = own >= need;
    servers.push({ unit: u.unit, name: reg.name, ms: own, ok: fits });
    lines.push(`${reg.name} "timeout": ${own} ms (${reg.scope}) overrides it for that server ${fits ? '≥' : '<'} ${need} needed${fits ? '' : ` (${because(u)})`} · ${fits ? 'ok' : 'TOO LOW'}`);
  }

  const gemini = enabled.find((u) => u.unit === 'gemini');
  let deep = null;
  if (gemini) {
    const seconds = DEEP_STAGES * DEEP_ATTEMPTS * (gemini.timeoutS + GEMINI_HARD_KILL_S);
    const own = servers.find((s) => s.unit === 'gemini' && s.ms !== null);
    const wall = own ? own.ms : effective;
    const fits = wall === null || seconds * 1000 <= wall;
    deep = { stages: DEEP_STAGES, attempts: DEEP_ATTEMPTS, timeoutS: gemini.timeoutS, seconds, ok: fits };
    lines.push(`deep research: gemini_deep_research worst case: ${DEEP_STAGES} stages × ${DEEP_ATTEMPTS} attempts × (${gemini.timeoutS} + ${GEMINI_HARD_KILL_S} s) = ${seconds} s${fits ? ' · within the wall-clock limit' : ` · ABOVE the wall-clock limit (${wall} ms) — run it deliberately`}`);
  }

  const idle = idleWall({ longest: enabled.reduce((a, b) => (b.timeoutS > a.timeoutS ? b : a)), cwd, env, read });
  lines.push(idle.line);

  // ONE next, and only for a wall that is actually short: the shared env first,
  // because it bounds every unit; a single server's own cap otherwise. The idle
  // wall never produces one — progress notifications are the answer to it, and
  // the units send them.
  const low = servers.find((s) => !s.ok);
  const next = !ok
    ? `raise ${WALL_ENV} to ${needed} ms — merge ${snippet} into your settings file (omelette-fleet never writes it)`
    : low
      ? `the ${low.name} registration caps its own calls at ${low.ms} ms — raise its "timeout" to ${needFor(enabled.find((u) => u.unit === low.unit))} ms or drop the field (omelette-fleet never writes .claude.json or .mcp.json)`
      : null;

  return {
    wall: { needed, neededBy: worst.unit, value, source, effective, ok, servers },
    idle, deep, lines, next, snippet,
    // Both env lookups walked the same files; the caller wants each named once.
    unreadable: mergeUnreadable(wallUnreadable, idle.unreadable),
  };
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

/**
 * The `agents` block for `show`, in the same `key value source` shape as a
 * unit's — one row per setting, `<role>.<key>`, so the whole block reads as one
 * table however many roles ship.
 */
function agentRows(settings, indent = '  ') {
  const rows = Object.entries(AGENT_SETTINGS_SCHEMA).flatMap(([role, schema]) => Object.keys(schema)
    .map((key) => [`${role}.${key}`, fmtValue(settings[role][key]), settings.sources[role][key]]));
  const w = Math.max(...rows.map((r) => r[0].length), 5);
  const vw = Math.max(...rows.map((r) => r[1].length), 5);
  return [
    `${indent}${pad('KEY', w)}  ${pad('VALUE', vw)}  SOURCE`,
    ...rows.map(([key, value, source]) => `${indent}${pad(key, w)}  ${pad(value, vw)}  ${source}`),
  ];
}

/**
 * The `handoff` block for `show`, in the same `key value source` shape as the
 * rest of this file's tables.
 */
function handoffRows(settings, indent = '  ') {
  const rows = Object.keys(HANDOFF_SCHEMA).map((key) => [key, fmtValue(settings[key]), settings.sources[key]]);
  const w = Math.max(...rows.map((r) => r[0].length), 5);
  const vw = Math.max(...rows.map((r) => r[1].length), 5);
  return [
    `${indent}${pad('KEY', w)}  ${pad('VALUE', vw)}  SOURCE`,
    ...rows.map(([key, value, source]) => `${indent}${pad(key, w)}  ${pad(value, vw)}  ${source}`),
  ];
}

/**
 * The fleet-wide top-level keys for `show`, in the same `key value source`
 * shape as the tables above. Three near-identical builders is the deliberate
 * shape here: each block has its own schema and its own notes, and the four
 * shared lines are cheaper than a generalisation two other packages would
 * have to edit around.
 */
function fleetRows(settings, indent = '  ') {
  const rows = Object.keys(SETTINGS_SCHEMA).map((key) => [key, fmtValue(settings[key]), settings.sources[key]]);
  const w = Math.max(...rows.map((r) => r[0].length), 5);
  const vw = Math.max(...rows.map((r) => r[1].length), 5);
  return [
    `${indent}${pad('KEY', w)}  ${pad('VALUE', vw)}  SOURCE`,
    ...rows.map(([key, value, source]) => `${indent}${pad(key, w)}  ${pad(value, vw)}  ${source}`),
  ];
}

/**
 * The `workflow` block for `show`, in the same `key value source` shape as the
 * rest of this file's tables.
 */
function workflowRows(settings, indent = '  ') {
  const rows = Object.keys(WORKFLOW_SCHEMA).map((key) => [key, fmtValue(settings[key]), settings.sources[key]]);
  const w = Math.max(...rows.map((r) => r[0].length), 5);
  const vw = Math.max(...rows.map((r) => r[1].length), 5);
  return [
    `${indent}${pad('KEY', w)}  ${pad('VALUE', vw)}  SOURCE`,
    ...rows.map(([key, value, source]) => `${indent}${pad(key, w)}  ${pad(value, vw)}  ${source}`),
  ];
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

// ─── the merge policy ────────────────────────────────────────────────────────

/**
 * WHAT THE RULES FILE TELLS THE SESSION TO DO WITH A FINISHED BRANCH — and,
 * when it says "merge yourself" in a repository that plainly does not work that
 * way, one hint.
 *
 * The detection is cheap and local first: a pull-request template or a
 * CODEOWNERS file is a repository whose changes are reviewed on a PR, and both
 * are files in the directory this command is standing in. Branch protection is
 * the third signal and the only one that needs the network, so it is asked ONLY
 * through `gh` — the operator's own authenticated tool, like `claude` and `git`
 * — only when neither file answered, and bounded at 5 s. `gh` absent, `gh`
 * failing, no repository, no permission, a 404: all of them say nothing at all.
 *
 * A HINT, NEVER A FAULT. It changes no exit code, and a `pr` policy is never
 * questioned — a repository with no template can still be gated by a rule
 * nobody wrote down.
 */
/**
 * EVERY PLACE GITHUB READS ONE OF THE TWO FILES, because a repository is no
 * less PR-gated for keeping its template where the other half of GitHub's
 * documentation puts it: a pull-request template at the root, under `.github/`
 * or under `docs/`, and a `CODEOWNERS` in those same three places.
 */
const PR_GATE_FILES = [
  '.github/PULL_REQUEST_TEMPLATE.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/PULL_REQUEST_TEMPLATE.md',
  'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS',
];
/** …and the multiple-template form: any `.md` file inside this directory is one. */
const PR_GATE_DIR = '.github/PULL_REQUEST_TEMPLATE';
/**
 * How many of that directory's entries are looked at. A repository with
 * templates has a handful; a directory with more than this behind that name is
 * not a template set, and a HINT is not worth walking one. The entries are read
 * in the order the filesystem hands them over — sorting would mean materialising
 * the whole listing first, which is exactly the cost this bound exists to avoid.
 */
const PR_GATE_DIR_ENTRIES = 64;
const GH_PROTECTION_TIMEOUT_MS = 5000;
const PR_GATE_HINT = ' — this repository looks PR-gated: consider set workflow.merge=pr';

/** The first PR-gate file present in `cwd`, or null. A directory of that name is not one. */
function prGateFile(cwd) {
  for (const rel of PR_GATE_FILES) {
    try { if (statSync(join(cwd, ...rel.split('/'))).isFile()) return rel; }
    catch { /* absent is the normal case */ }
  }
  // The directory form is a listing rather than a lookup: the names in it are
  // the repository's own, and only a regular `.md` among them is a template.
  //
  // NOTHING HERE FOLLOWS A LINK OUT OF THE REPOSITORY. The directory is lstat'd
  // — a symlink under that name holds somebody else's templates, and this
  // repository's workflow may not be read out of them — and so is each entry,
  // so a linked-in file is not a template here either. Bounded and unsorted:
  // `opendir` reads at most PR_GATE_DIR_ENTRIES entries, where a listing of the
  // whole directory would be unbounded work for one hint.
  const dir = join(cwd, ...PR_GATE_DIR.split('/'));
  let handle = null;
  try {
    if (!lstatSync(dir).isDirectory()) return null;
    handle = opendirSync(dir);
    for (let i = 0; i < PR_GATE_DIR_ENTRIES; i++) {
      const entry = handle.readSync();
      if (!entry) break;
      if (!/\.md$/i.test(entry.name)) continue;
      try { if (lstatSync(join(dir, entry.name)).isFile()) return `${PR_GATE_DIR}/${entry.name}`; }
      catch { /* vanished between the listing and the lstat */ }
    }
  } catch { /* absent, not a directory, or one this process may not read */ }
  finally { if (handle) { try { handle.closeSync(); } catch { /* already gone */ } } }
  return null;
}

/**
 * Is `main` protected in the repository `cwd` belongs to? Asked through the
 * operator's own `gh`, with the parent environment (`inheritEnv`) because that
 * is where its credentials and its config live — there is no model reading this
 * environment, exactly as in `claude mcp add` and `git pull`. Any answer that is
 * not a clean exit 0 within the bound is a `false`, and never a word about it.
 */
async function ghBranchProtected({ cwd = process.cwd(), env = process.env } = {}) {
  const bin = whichBin('gh', env);
  if (!bin) return false;
  let r;
  try {
    r = await runProcess({
      bin, args: ['api', 'repos/{owner}/{repo}/branches/main/protection'],
      cwd, inheritEnv: true, hardKillMs: GH_PROTECTION_TIMEOUT_MS,
    });
  } catch { return false; }
  return !r.killed && r.code === 0;
}

/**
 * WHICH SENTENCE THE RENDERED RULES FILE ACTUALLY CARRIES — the project's file
 * first, then the global one, exactly as `contractFor` looks for them, and only
 * a file of OURS counts: an unmarked file at that path is somebody else's and
 * says nothing about our policy.
 *
 * It is read because the CONFIG alone cannot answer the question an operator is
 * asking. `workflow.merge` reaches a session only through `omelette-fleet
 * rules`, so a config that says `pr` beside a file still carrying the `session`
 * sentence means the session is being told to merge — and that gap is precisely
 * what the line has to show.
 *
 * @returns {string|null} the policy the file spells, or null when no rendered
 *   file of ours spells one.
 */
function renderedMerge({ cwd = process.cwd(), env = process.env } = {}) {
  for (const scope of [{}, { global: true }]) {
    const { path } = rulesTarget({ ...scope, cwd, env });
    const text = readRulesFile(path, RULES_READ_MAX);
    if (text === null || !parseRulesMarker(text)) continue;
    const found = Object.entries(MERGE_SENTENCES).find(([, sentence]) => text.includes(sentence));
    if (found) return found[0];
  }
  return null;
}

/**
 * The merge policy as one value, for `doctor` and for `install --rules`: the
 * configured policy, where the rendered file stands relative to it, and the
 * PR-gate hint when a `session` policy sits in a repository that looks gated.
 * @returns {Promise<string>} e.g. `session (rules rendered)`, `pr (config;
 *   rules not re-rendered — run rules)`, `session (config; no rules file)`.
 */
async function mergePolicy({ cwd = process.cwd(), env = process.env } = {}) {
  const { merge } = workflowSettings(env);
  const rendered = renderedMerge({ cwd, env });
  const where = rendered === merge ? 'rules rendered'
    : rendered === null ? 'config; no rules file'
      : 'config; rules not re-rendered — run rules';
  if (merge !== 'session') return `${merge} (${where})`;
  const gated = !!prGateFile(cwd) || await ghBranchProtected({ cwd, env });
  return `session (${where})${gated ? PR_GATE_HINT : ''}`;
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

/**
 * The config half of `install`, as a LINE and an exit contribution rather than
 * an exception. A fleet home the CLI may not write is a real failure and the
 * exit code says so — but it has nothing to do with the project files, and
 * throwing here took the whole `--rules` phase down with it, leaving an
 * operator who asked for both halves with neither.
 *
 * @returns {number} 0, or 1 when the file was meant to be created and was not.
 */
function createConfig(plan) {
  if (plan.exists) { out(`config  ${plan.target} already exists — left alone`); return 0; }
  try { writeConfigFromExample(plan); }
  catch (e) {
    out(`config  FAILED to write ${plan.target}: ${(e && e.message) || e}`);
    out('        the fleet falls back to its built-in defaults until that file exists.');
    return 1;
  }
  out(`config  wrote ${plan.target} (0600, from ${plan.source})`);
  return 0;
}

async function cmdInstall(argv) {
  const { flags, positional, errors } = parseArgv(argv, { booleans: ['rules', 'dry-run', 'force'], options: ['prefix', 'units'] });
  if (positional.length) errors.push(`unexpected argument: ${positional[0]}`);
  const prefix = selectPrefix(flags.prefix, errors);
  const names = selectUnits(flags.units, errors);
  if (errors.length) { errors.forEach((e) => err(`omelette-fleet install: ${e}`)); return 1; }

  const dry = !!flags.dryRun;
  /**
   * The SECOND half of `install --rules`: the same `rules --agents --hooks` an
   * operator would run next, in this directory, printing the same lines — one
   * command instead of two, and the snippet ends up where the eye already is.
   * It runs on EVERY exit path, `claude` missing included: the project files
   * have nothing to do with the registrations, and --dry-run covers both halves.
   */
  const andRules = async (code) => {
    if (!flags.rules) return code;
    out();
    out(`── project files in ${process.cwd()} (rules --agents --hooks) ${'─'.repeat(8)}`);
    const rulesCode = await cmdRules([...(dry ? ['--dry-run'] : []), '--agents', '--hooks']);
    // The rules file that was just written carries ONE sentence the operator
    // chose, and this is where they find out which — and whether the repository
    // they are standing in looks like it wants the other one. Printed under
    // --dry-run too: it describes config, not a write.
    out();
    out(`merge policy: ${await mergePolicy()}`);
    return code || rulesCode;
  };
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
    const cfgFailed = createConfig(cfgPlan);
    out();
    out('Restart Claude Code to load the new servers.');
    return andRules(cfgFailed);
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
  let cfgFailed = 0;
  if (dry && !cfgPlan.exists) out(`config  would write ${cfgPlan.target} (0600, copied from ${cfgPlan.source})`);
  else cfgFailed = createConfig(cfgPlan);

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
  return andRules(failed.length || cfgFailed ? 1 : 0);
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
      out(`rules file ${r.path} is v${r.version} (this install is v${version}) — refresh: ${refreshCommand('rules', r.scope)}`);
    }
    // One line per SCOPE and kind, not per file: the files of a kind are
    // refreshed together — and only when the whole scope is ours. A scope
    // holding a file that is not ours would refuse that refresh, so pointing at
    // it is worse than saying nothing.
    for (const kind of DIR_KINDS) {
      for (const r of dirReport(kind, version)) {
        const key = realOrSelf(r.dir);
        if (r.state !== 'ours' || !r.behind || seen.has(key)) continue;
        seen.add(key);
        out(`${KINDS[kind].noun} files under ${r.dir} are v${r.version} (this install is v${version}) — refresh: ${refreshCommand(kind, r.scope)}`);
      }
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
 * like. The target file and EVERY directory from it up to `top` — the scope's
 * own `.claude` (or $CLAUDE_CONFIG_DIR) — are lstat'ed, never followed, so a
 * link planted anywhere along the way cannot redirect a write, or a `--remove`,
 * at a file the operator never named. A missing component is fine: mkdirSync
 * creates it, as before. Outermost first, so the refusal names the outermost
 * link rather than something below it.
 *
 * The default `top` is the grandparent, which is what a flat kind
 * (`.claude/rules/<file>`) needs; a nested one (`.claude/skills/<skill>/SKILL.md`)
 * passes its own, so the deeper directory is covered too.
 *
 * @returns {string|null} the refusal's reason, or null when the path is clean.
 */
function unsafeManagedPath(path, top = dirname(dirname(path))) {
  const dirs = [];
  for (let d = dirname(path); ; d = dirname(d)) {
    dirs.push(d);
    if (d === top || d === dirname(d)) break; // …or the filesystem root, whichever comes first
  }
  for (const p of [...dirs.reverse(), path]) {
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
 *          version:string, top?:string, force?:boolean, dryRun?:boolean, remove?:boolean}} o
 * @returns {{code:number, line:string|null, error:string|null}} `line` → stdout, `error` → stderr.
 */
function syncManagedFile({ path, next, parse, marker, version, top, force = false, dryRun = false, remove = false }) {
  // FIRST, before the file is even read — a symlink must not be read through,
  // and a FIFO at the target would block readFileSync forever. Also ahead of
  // the --force decision: --force replaces a foreign FILE, never a link.
  const unsafe = unsafeManagedPath(path, top);
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
 * THE ONE DIRECTORY `--remove` TAKES WITH IT. syncManagedFile removes files and
 * never directories, deliberately — but a skill IS a directory
 * (`.claude/skills/omelette-test/SKILL.md`), and the empty one left behind
 * still reads as an installed skill to anyone listing that folder.
 *
 * So the skills kind gets this one post-remove step, and it is timid on
 * purpose: never through a symlink, never a directory that still holds
 * anything — a file somebody else put in there is theirs and the directory is
 * then theirs too — and a failure says nothing, because a leftover directory
 * is not worth a refusal on top of the removal that already worked.
 *
 * @returns {string|null} the directory that was removed, or null for every other case.
 */
function pruneEmptySkillDir(path) {
  const dir = dirname(path);
  try {
    if (lstatSync(dir).isSymbolicLink()) return null;
    if (readdirSync(dir).length) return null;
    rmdirSync(dir);
    return dir;
  } catch { return null; }
}

/**
 * Every file this command manages, in the order it handles them: the rules file
 * first, then whatever the flags asked for — the registry (core/rules.mjs KINDS)
 * says which flag writes a kind, where its files live and how they render. The
 * whole command is this list plus syncManagedFile.
 */
function managedFiles({ global = false, agents = false, hooks = false, version, settings, handoff } = {}) {
  const asked = { agents: !!agents, hooks: !!hooks };
  // Always an explicit settings object: `renderAgentFile`'s own default would
  // read the config a second time, and a caller that forgot the argument would
  // render defaults with nothing to show for it. Only when it is needed, so a
  // run that writes no agent definition never reads the fleet config.
  // Each kind renders from the CURRENT config — the agent block for the
  // definitions, the handoff block for the guard — and only when this run
  // actually writes that kind, so a `rules` run that writes neither never reads
  // the fleet config at all.
  const resolved = {
    agents: agents ? (settings || agentSettings()) : undefined,
    handoff: hooks ? (handoff || handoffSettings()) : undefined,
  };
  const files = [];
  for (const [kind, spec] of Object.entries(KINDS)) {
    if (spec.flag !== null && !asked[spec.flag]) continue;
    const { dir } = spec.dir({ global });
    for (const name of spec.files) {
      files.push({
        kind,
        name,
        // A kind's file name may be a nested path (a skill is a directory with a
        // SKILL.md in it), so the whole tree under `dir` is checked before a write.
        path: join(dir, ...name.split('/')),
        top: dirname(dir),
        next: spec.render(name, version, resolved),
        parse: spec.parse,
        marker: spec.hint,
      });
    }
  }
  return files;
}

/** The kinds a running session ever picks up on its own — the post-write line is about these and no other. */
const LOADED_BY_A_SESSION = new Set(['rules', 'agents', 'skills']);

async function cmdRules(argv) {
  const { flags, positional, errors } = parseArgv(argv, { booleans: ['global', 'agents', 'hooks', 'print', 'remove', 'force', 'dry-run'] });
  if (positional.length) errors.push(`unexpected argument: ${positional[0]}`);
  if (flags.print && flags.remove) errors.push('--print and --remove ask for opposite things — pick one');
  if (errors.length) { errors.forEach((e) => err(`omelette-fleet rules: ${e}`)); return 1; }

  // The definitions render from the CURRENT agent settings, so a `set` shows up
  // in the next `rules --agents` as a content change at the same version. A
  // broken value never stops the write — it is a warning, and the default is
  // written — but it is said out loud, or the operator reads the default back
  // as their own value.
  const settings = flags.agents ? agentSettings() : undefined;
  if (settings && !flags.remove) settings.warnings.forEach((w) => err(`omelette-fleet rules: ${w}`));
  // The guard's three handoff values are substituted into the script the same
  // way, and for the same reason a bad one is said out loud rather than read
  // back later as the operator's own number.
  const handoff = flags.hooks ? handoffSettings() : undefined;
  if (handoff && !flags.remove) handoff.warnings.forEach((w) => err(`omelette-fleet rules: ${w}`));
  // The rules file is written on EVERY run, and its merge sentence renders from
  // the same config the other two kinds render from — so a value the operator
  // mistyped is said out loud here instead of being read back later as the
  // policy they thought they chose. (`KINDS.rules.render` resolves it again;
  // the config is stat-cached, so the second read re-parses nothing.)
  if (!flags.remove) workflowSettings().warnings.forEach((w) => err(`omelette-fleet rules: ${w}`));
  const files = managedFiles({ global: !!flags.global, agents: !!flags.agents, hooks: !!flags.hooks, version: PKG.version, settings, handoff });

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
  const toWire = []; // the guard scripts that are in place (or would be)
  for (const f of files) {
    const r = syncManagedFile({
      path: f.path, next: f.next, parse: f.parse, marker: f.marker, top: f.top, version: PKG.version,
      force: !!flags.force, dryRun: !!flags.dryRun, remove: !!flags.remove,
    });
    if (r.line) out(r.line);
    if (r.error) err(r.error);
    // One refused file is enough to exit 1 — and never a reason to skip the rest.
    if (r.code) code = 1;
    if (r.line && r.line.startsWith('written ') && LOADED_BY_A_SESSION.has(f.kind)) wrote = true;
    if (!r.code && f.kind === 'hooks' && !flags.remove) toWire.push(f.path);
    // The skill's own directory, once its SKILL.md is gone — and only after a
    // removal that really happened: `--dry-run` changes nothing at all, and a
    // "nothing to remove" run never owned anything in that directory.
    if (r.line && r.line.startsWith('removed ') && f.kind === 'skills' && f.name.includes('/')) {
      const pruned = pruneEmptySkillDir(f.path);
      if (pruned) out(`removed ${pruned} (empty skill directory)`);
    }
  }
  // Only about the kinds a SESSION picks up. A hook script is called by
  // settings.json the moment it is on disk — nothing about it waits for a
  // session start or a directory watch, and the snippet below says what it does need.
  if (wrote) out("Rules load on the next session start; agent definitions and skills are picked up by Claude Code's watcher — usually within seconds, sometimes minutes (restart if .claude/agents or .claude/skills did not exist before).");
  // A script on disk is not a hook: settings.json is what calls it, and this CLI
  // never writes that file. So the snippet is printed on EVERY --hooks run, not
  // only the one that created the script — doctor sends the operator here for it.
  // Under --dry-run it is ANNOUNCED and not printed: a snippet naming a script
  // that was never written is a snippet somebody pastes.
  for (const path of toWire) {
    if (flags.dryRun) { out('would print the settings snippet after writing'); continue; }
    out();
    // "Paste" was an instruction an operator could follow literally and lose
    // the hooks they already had: what follows is a whole `hooks` object, not a
    // whole settings file.
    out(`The script only runs once ${settingsTarget({ global: !!flags.global }).path} calls it — omelette-fleet never writes that file. Merge this into your settings file (it is a whole hooks object — add the events it lists to an existing hooks block rather than replacing the file):`);
    out();
    for (const line of hookSettingsSnippet(path)) out(line);
  }
  return code;
}

/**
 * What `doctor` and `update` REPORT about the managed files. These only ever
 * read: a stale rules file is something the operator is told about and never
 * something a diagnosis or a pull silently rewrites. A file we cannot read at
 * all — absent, a directory, a symlink, a pipe, or bytes this process may not
 * have — reads as absent: a report line, not a fault.
 *
 * @returns {{path:string, state:'absent'|'foreign'|'ours', version:string|null}}
 */
function rulesState({ global = false, cwd = process.cwd(), env = process.env } = {}) {
  const { path } = rulesTarget({ global, cwd, env });
  const text = readRulesFile(path, RULES_READ_MAX);
  if (text === null) return { path, state: 'absent', version: null };
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
 * One directory-shaped kind at one scope, as one verdict: ours only when EVERY
 * file is there and marked, `partial` when some are missing, and `foreign` as
 * soon as one of them is not ours — the version shown is the OLDEST marker,
 * because that is the one a refresh would move.
 */
function dirState({ kind, current, global = false, cwd = process.cwd(), env = process.env } = {}) {
  const spec = KINDS[kind];
  const { dir } = spec.dir({ global, cwd, env });
  const found = spec.files.map((name) => {
    let text;
    try { text = readFileSync(join(dir, ...name.split('/')), 'utf8'); } catch { return { name, state: 'absent', version: null }; }
    const version = spec.parse(text);
    return version ? { name, state: 'ours', version } : { name, state: 'foreign', version: null };
  });
  const ours = found.filter((f) => f.state === 'ours');
  const oldest = ours.reduce((a, f) => (a === null || compareSemver(f.version, a) < 0 ? f.version : a), null);
  const state = found.some((f) => f.state === 'foreign') ? 'foreign'
    : !ours.length ? 'absent'
      : ours.length < spec.files.length ? 'partial' : 'ours';
  return {
    kind, dir, state, version: oldest, present: ours.length, total: spec.files.length,
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
      : `v${r.version}${r.behind ? ` [run: ${refreshCommand('rules', r.scope)}]` : ''}`);

/** `omelette-fleet rules …` — the command that refreshes one kind at one scope. */
const refreshCommand = (kind, scope) => [
  'omelette-fleet rules', KINDS[kind].refresh, scope === 'global' ? '--global' : '',
].filter(Boolean).join(' ');

/** One scope's files of one kind in the same line: how many are ours, at which version. */
const dirLabel = (r) => (
  r.state === 'absent' ? 'absent'
    : r.state === 'foreign' ? 'foreign (no marker)'
      : `${r.state === 'partial' ? `partial (${r.present}/${r.total})` : `v${r.version} (${r.present})`}${r.behind ? ` [run: ${refreshCommand(r.kind, r.scope)}]` : ''}`);

/** Both scopes of one kind, for doctor's one-line summary and update's hint. */
function dirReport(kind, current) {
  return [
    { scope: 'project', ...dirState({ kind, current }) },
    { scope: 'global', ...dirState({ kind, current, global: true }) },
  ];
}

/** Every kind that lives in a directory of its own — the rules file is the one that does not. */
const DIR_KINDS = Object.keys(KINDS).filter((k) => k !== 'rules');

/**
 * Every managed path in the PROJECT that `rules` would refuse to touch, in the
 * command's own words — the same lstat walk syncManagedFile runs before it reads
 * anything, so what doctor reports and what a write would do cannot disagree.
 * Reading only: a link is named, never followed and never removed.
 */
function unsafeManagedPaths({ cwd = process.cwd(), env = process.env } = {}) {
  const reasons = [];
  for (const spec of Object.values(KINDS)) {
    const { dir } = spec.dir({ cwd, env });
    for (const name of spec.files) {
      const reason = unsafeManagedPath(join(dir, ...name.split('/')), dirname(dir));
      if (reason) reasons.push(reason);
    }
  }
  return reasons;
}

/**
 * A matcher made of nothing but names, their separators and spaces — `"Bash"`,
 * `"Bash|Edit"`, `"compact, resume"`. Claude Code reads one of these as an exact
 * LIST rather than as a pattern, which is why `"Bashful"` and `"ash"` cover no
 * tool at all while the regex forms below would match `Bash` in both.
 */
const EXACT_LIST = /^[A-Za-z0-9_ ,|-]+$/;

/**
 * Whether one matcher lets the guard see the thing its event is matched ON —
 * a `Bash` call for `PreToolUse`, a `compact` source for `SessionStart` — and,
 * when it does not, WHY, because the ways of getting it wrong are fixed
 * differently.
 *
 * Claude Code's own matcher rules, in the order it applies them (hooks docs):
 * absent / `""` / `"*"` are the documented "everything" forms; a plain list of
 * names matches EXACTLY, item by item; anything else is a regex, and it is
 * tested UNANCHORED — `"mcp__.*"` is theirs, and `"ash$"` matches a `Bash` call
 * whether or not anybody meant it to. So `"Bash|Edit"` fires on every Bash call
 * and comparing the string literally reported it as NOT wired. A pattern that
 * does not COMPILE covers nothing either, but that is a typo in the settings
 * file rather than a guard aimed at another tool — and an operator told
 * "matcher is not Bash" about `(` would go looking for the wrong thing. A
 * matcher that is not a string at all is a third mistake, easy to write in JSON
 * and worth its own words.
 *
 * @returns {string|null} null when it covers `name`, else the reason it does not.
 */
const matcherProblemFor = (m, event, name) => {
  // An ABSENT key is the documented "everything" form; a key that is there
  // holding `null` is not — it is a value that is not a pattern, and it is
  // reported as one.
  if (m === undefined || m === '' || m === '*') return null;
  if (typeof m !== 'string') return `${event} matcher is not a string`;
  if (EXACT_LIST.test(m)) {
    return m.split(/[|,]/).some((item) => item.trim() === name) ? null : `${event} matcher is not ${name}`;
  }
  let re;
  try { re = new RegExp(m); }
  catch { return `${event} matcher ${JSON.stringify(m)} is not a valid regex`; }
  return re.test(name) ? null : `${event} matcher is not ${name}`;
};

/**
 * What each MATCHED event's entry has to cover — two of the six. `PreCompact`,
 * `PostToolUse`, `Stop` and `PostCompact` are deliberately absent: none of them
 * is matched on anything, because every compaction is one the guard has
 * something to say about — before it and after it — and so is every tool call
 * and every Stop, so any entry that calls it counts.
 * `SessionStart` is matched on the session's SOURCE (`startup`, `resume`,
 * `clear`, `compact`, `fork`), and `compact` is the only one the guard has
 * anything to print into.
 */
const MATCHED_ON = { PreToolUse: 'Bash', SessionStart: 'compact' };

/**
 * Which of the guard's events one settings file calls it from. The test is the
 * script's NAME inside the command string, not an exact path: an operator may
 * quote it (the printed snippet does), wrap it, point at their own node or keep
 * the script somewhere else — all of which still run our guard, and none of
 * which we would recognise by comparing paths.
 *
 * @returns {{wired:string[], matcherProblem:string|null}} the events wired, plus
 *   why an entry that calls the guard will never fire on the thing its event is
 *   matched on — which looks installed from every angle and guards nothing, so
 *   it is reported instead of being counted either way.
 */
function hookWiring(config) {
  const hooks = isObj(config) && isObj(config.hooks) ? config.hooks : {};
  const calls = (h) => isObj(h) && HOOK_FILES.some((f) => String(h.command || '').includes(f));
  const wired = [];
  let matcherProblem = null;
  for (const event of HOOK_EVENTS) {
    const calling = (Array.isArray(hooks[event]) ? hooks[event] : [])
      .filter((group) => isObj(group) && Array.isArray(group.hooks) && group.hooks.some(calls));
    if (!calling.length) continue;
    // Two of the six events are matched against something; the other four are
    // matched on nothing at all. ONE entry covering the matcher is enough; when
    // none does, the first entry's reason is the one worth printing.
    const target = MATCHED_ON[event];
    if (target) {
      const problems = calling.map((group) => matcherProblemFor(group.matcher, event, target));
      if (problems.every(Boolean)) { matcherProblem = matcherProblem || problems[0]; continue; }
    }
    wired.push(event);
  }
  return { wired, matcherProblem };
}

/**
 * Both of a scope's settings files — PARSED, NEVER WRITTEN, exactly like
 * .claude.json above: `rules --hooks` prints a snippet and the operator pastes
 * it wherever they keep their settings. The answer is the UNION of the two:
 * an operator who keeps the tool guard in settings.json and the rest in
 * settings.local.json (the file a project usually gitignores) has a guard that
 * runs, and taking whichever single file listed the most events reported that
 * machine as unwired. An absent file is normal, and one we cannot read is named
 * rather than counted, because "not wired" about a file nobody could parse
 * would send an operator to re-paste something that is already there.
 */
function hookWiringAt({ global = false, cwd = process.cwd(), env = process.env } = {}) {
  const unreadable = [];       // the short names the hooks line prints
  const unreadablePaths = [];  // the absolute paths doctor's settings line prints
  const wired = new Set();
  let matcherProblem = null;
  for (const { name, path } of settingsTargets({ global, cwd, env })) {
    const raw = readSettingsFile(path);
    if (raw === null) continue; // absent is the normal case
    if (raw === UNREADABLE) { unreadable.push(name); unreadablePaths.push(path); continue; }
    let config = null;
    try { config = JSON.parse(raw); } catch { config = null; }
    if (!isObj(config)) { unreadable.push(name); unreadablePaths.push(path); continue; }
    const here = hookWiring(config);
    matcherProblem = matcherProblem || here.matcherProblem;
    for (const event of here.wired) wired.add(event);
  }
  // A matcher that covers nothing is only a finding while something is still
  // missing: once the files together wire every event, the guard does see the
  // call and there is nothing for the operator to fix. Counted against
  // HOOK_EVENTS rather than against a named event, so a release that adds one
  // needs no edit here.
  if (wired.size === HOOK_EVENTS.length) matcherProblem = null;
  return { wired: HOOK_EVENTS.filter((e) => wired.has(e)), unreadable, unreadablePaths, matcherProblem };
}

/**
 * One scope's guard script: ours or not, at which version — and whether anything
 * ever calls it. A script nobody calls is the failure mode worth a line of its
 * own, because everything about it looks installed.
 *
 * A REASON beats a count: an unreadable settings file and a matcher aimed
 * elsewhere each explain why an event is not wired, and naming the event on top
 * of them would send the operator to paste something that is already there. Only
 * when neither applies — and something IS wired, so this is not a fresh install
 * — is the missing event named, which is exactly the 0.3.2 wiring meeting a
 * 0.3.3 guard.
 */
const hooksLabel = (r, { wired, unreadable, matcherProblem }) => {
  if (r.state === 'absent') return 'absent';
  if (r.state === 'foreign') return 'foreign (no marker)';
  const stale = r.behind ? ` [run: ${refreshCommand('hooks', r.scope)}]` : '';
  if (wired.length === HOOK_EVENTS.length) return `v${r.version} (wired: ${wired.join(', ')})${stale}`;
  const reasons = [];
  if (unreadable.length) reasons.push(`${unreadable.join(' and ')} unreadable`);
  if (matcherProblem) reasons.push(matcherProblem);
  if (!reasons.length && wired.length) reasons.push(`missing ${HOOK_EVENTS.filter((e) => !wired.includes(e)).join(', ')}`);
  const why = reasons.length ? ` (${reasons.join('; ')})` : '';
  return `v${r.version} (NOT wired${why} — paste the snippet from rules --hooks)${stale}`;
};

/**
 * The window the installed guard will measure against, and where that number
 * comes from — the same precedence the script itself applies, because this line
 * exists to say what the hook will do rather than what the config says.
 *
 * A `[1m]` passed only on the command line (`claude --model …[1m]`) is not a
 * source here, because it is not one for a hook either: the guard sees the
 * environment and the settings files, never the client's argv.
 *
 * The settings files this walks are carried up as `unreadable` rather than
 * swallowed: doctor prints one line per broken file whichever of its readers
 * opened it, and the ceiling is one of the things such a file was likely to
 * carry.
 */
function resolveContextWindow(contextWindow, { cwd = process.cwd(), env = process.env } = {}) {
  if (Number.isInteger(contextWindow) && contextWindow > 0) return { window: contextWindow, source: 'handoff.contextWindow', unreadable: [] };
  const fromEnv = parseContextWindow(env[CONTEXT_WINDOW_ENV]);
  if (fromEnv) return { window: fromEnv, source: CONTEXT_WINDOW_ENV, unreadable: [] };
  const setting = readClientSetting(CONTEXT_WINDOW_SETTING, { global: true, cwd, env, accept: parseContextWindow });
  if (setting.value) return { window: setting.value, source: CONTEXT_WINDOW_SETTING, unreadable: setting.unreadable };
  // The fourth step, and the reason it is fourth: `autoCompactWindow` is what an
  // operator set on purpose, and a model id is what the client happens to be
  // running. `ANTHROPIC_MODEL` first, then the `model` key of the same two
  // files — the identical lookup the guard makes, in the identical order, with
  // the identical acceptance, because the two must not describe one machine
  // differently.
  if (parseModelWindow(env[MODEL_ENV])) return { window: MODEL_WINDOW, source: MODEL_WINDOW_SOURCE, unreadable: setting.unreadable };
  const model = readClientSetting(MODEL_SETTING, { global: true, cwd, env, accept: parseModelWindow });
  // Both scans walked the same two files; the caller wants each named once.
  const unreadable = mergeUnreadable(setting.unreadable, model.unreadable);
  if (model.value) return { window: MODEL_WINDOW, source: MODEL_WINDOW_SOURCE, unreadable };
  return { window: CONTEXT_WINDOW_DEFAULT, source: 'default', unreadable };
}

/**
 * THE AUTO-HANDOFF LINE: what the INSTALLED guard will do, read out of the
 * script itself. The values are rendered into it by `rules --hooks`, and the
 * version marker cannot tell a stale threshold from a current one — a changed
 * value renders at the same version — so the config is not the source here.
 * The project's guard first, then the global one, because that is the order a
 * session would pick them up in — and a line read off the global guard says so,
 * because the command that changes those values is `rules --global --hooks`.
 *
 * A guard that carries no rendered block (0.3.3 and earlier) gets NO line: the
 * `hooks` line already asks for a refresh, and printing a value the script does
 * not contain is exactly what reading it back exists to prevent.
 *
 * The `summary` clause is the same kind of statement about the same script:
 * `handoff.compactSummary`, as the guard's own `AUTO_HANDOFF` reads it, which
 * is why a literal that predates the key reads as `on` — that is what a guard
 * running that literal would compute. It sits beside the gate rather than at
 * the end, because the clauses that say what the hook DOES belong together and
 * `ledgers:` is a fact about the project. It is independent of `enabled`: an
 * operator who switched the nudge off still gets the record of a compaction.
 *
 * @returns {{line: string, unreadable: string[]}|null} the line's text and every
 *   settings file the ceiling lookup could not read, or null when there is
 *   nothing to say at all — which is also nothing read.
 */
function handoffReport({ cwd = process.cwd(), env = process.env } = {}) {
  let rendered = null;
  let fromGlobal = false;
  for (const global of [false, true]) {
    const { dir } = KINDS.hooks.dir({ global, cwd, env });
    let text;
    try { text = readFileSync(join(dir, HOOK_FILES[0]), 'utf8'); } catch { continue; }
    if (!KINDS.hooks.parse(text)) continue; // somebody else's script says nothing about ours
    rendered = parseHookHandoff(text);
    if (rendered) { fromGlobal = global; break; }
  }
  if (!rendered) return null;
  // WHOSE values these are. A project without its own rendered block reads the
  // global guard's numbers, and changing them is `rules --global --hooks` — a
  // line that did not say so would send the operator to re-render the project.
  const scope = fromGlobal ? ' · the project guard carries no handoff block — showing the global guard\'s values' : '';

  // The ledger is the opt-in: with none, the hook measures nothing and says
  // nothing, and an operator reading "nudge at 90%" would expect otherwise.
  let ledgers = 0;
  try {
    const dir = join(cwd, '.omelette');
    const st = lstatSync(dir);
    if (st.isDirectory() && !st.isSymbolicLink()) ledgers = readdirSync(dir).filter((f) => /^ledger-.*\.md$/.test(f)).length;
  } catch { /* absent is the normal case */ }
  const found = ledgers ? `ledgers: ${ledgers}` : 'ledgers: none (hook silent — start .omelette/ledger-<plan>.md)';
  const summary = `summary ${rendered.compactSummary ? 'on' : 'off'}`;
  if (!rendered.enabled) return { line: `nudge off (handoff.enabled=false) · Stop gate off · ${summary} · ${found}${scope}`, unreadable: [] };
  const ceiling = resolveContextWindow(rendered.contextWindow, { cwd, env });
  return {
    line: `nudge at ${rendered.threshold}% of ${ceiling.window} (${ceiling.source}) · Stop gate on · ${summary} · ${found}${scope}`,
    unreadable: ceiling.unreadable,
  };
}

/**
 * The ONE thing to do next, or null when nothing is missing — the first-run
 * path in the order it has to happen: register the servers, write the project
 * files, wire the guard up. It is INFORMATIONAL and never a fault: a machine
 * halfway through being set up is not a broken machine, and doctor's exit code
 * stays the answer to "is a unit that is enabled AND registered broken".
 *
 * The scope is the project, because that is what the commands it suggests
 * write; an operator who installed globally chose that and knows it.
 */
function nextStep(prefix, registeredHere) {
  // `registeredHere` is decided by findOurRegistrations: OURS, not merely
  // present — a name registered against another clone runs that clone's
  // servers, and `install` here is exactly what repoints it.
  // The prefix doctor REPORTS ON is the one the suggested command has to
  // register: plain `install` would create `omelette-*` and leave the names
  // this run went looking for exactly as missing as it found them.
  if (!registeredHere) return `omelette-fleet install${prefix === DEFAULT_PREFIX ? '' : ` --prefix ${prefix}`}`;
  // A path `rules` would REFUSE outright is not a step that command can take:
  // it lstats the target and every directory down to the scope's `.claude`
  // before it reads anything, and `--force` refuses a link too. So this is the
  // one next step that is not a command to run — the link comes off first.
  const unsafe = unsafeManagedPaths()[0];
  if (unsafe) {
    const fix = unsafe.endsWith('is a symlink') ? 'remove the link' : 'remove it';
    return `${unsafe} — omelette-fleet refuses to manage it; ${fix}, then rules --agents --hooks`;
  }
  // All four kinds, because one command writes all four: a project holding the
  // rules file and no guard script has not finished this step either.
  const states = [rulesState({}).state, ...DIR_KINDS.map((kind) => dirState({ kind, current: PKG.version }).state)];
  // A file at one of those paths without our marker is not ours to replace, and
  // `rules --agents --hooks` would refuse it — sending the operator into a
  // refusal is not a next step. Say what is in the way, and which flag ends it.
  if (states.includes('foreign')) {
    return 'a managed file has no omelette-fleet marker (see the rules/agents/skills/hooks lines) — inspect it, then `omelette-fleet rules --agents --hooks --force` replaces it';
  }
  if (states.some((state) => state !== 'ours')) return 'omelette-fleet rules --agents --hooks';
  // Past here the guard script IS ours, so the only thing that can still be
  // missing is the file that calls it — a script nobody calls is the failure
  // mode where everything looks installed, and one command prints the fix.
  if (hookWiringAt({}).wired.length < HOOK_EVENTS.length) {
    return 'merge the hooks snippet into .claude/settings.json (rules --hooks prints it)';
  }
  return null;
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

// ─── the sandbox probe ───────────────────────────────────────────────────────

/**
 * `doctor --probe-sandbox`: ask a unit to write a file into a directory that
 * exists for this one call, and read the verdict off the FILESYSTEM. What the
 * unit REPLIES decides nothing — a unit that answers "refused" and writes the
 * file anyway is exactly what this exists to catch, and one that answers
 * "done" and wrote nothing has a sandbox that held.
 *
 * OPT-IN, because it spends one real vendor call per unit. Plain `doctor`
 * spawns no unit at all.
 *
 * NOT A SECURITY AUDIT: one prompt, one directory, one call. It does not try
 * to escalate, does not test network egress, and a `held` is evidence about
 * this call rather than a proof about the sandbox.
 */
const PROBE_FILE = 'probe.txt';
/** The probe's own ceiling: a unit's timeoutS may be half an hour, and this is a diagnosis. */
const PROBE_TIMEOUT_CAP_S = 120;
/** The cheapest spawning tool of each unit — one call, one answer. */
const PROBE_TOOL = { gemini: 'gemini_research', grok: 'grok_research', codex: 'codex_research' };

const probePrompt = (dir) => `Create a file named ${PROBE_FILE} containing the word probe in the directory ${dir}. Then reply with exactly one line: done or refused.`;

/**
 * WHICH gate is open. `cfg.ceilingOpen` already says one of them is
 * (core/config.mjs, `allowWriteUnits`), and only two can open it: the package
 * ceiling, and the legacy alias that opens `gemini` alone — so the fallback
 * below is reachable for gemini and for nothing else.
 */
const writeGateVar = (name, env = process.env) => (
  String(env.OMELETTE_ALLOW_WRITE || '').split(',').map((s) => s.trim().toLowerCase()).includes(name)
    ? 'OMELETTE_ALLOW_WRITE'
    : 'ORION_ALLOW_GEMINI_MUTATE');

/** One probe result as the line doctor prints. */
function sandboxLabel({ verdict, reason, seconds, reply, path }) {
  if (verdict === 'skipped') return `skipped (${reason})`;
  // A breach is either a file that appeared or the directory itself going
  // away, and the reason says which — the path is the evidence either way.
  if (verdict === 'BREACHED') return `BREACHED — ${path} ${reason || 'was created'} (${seconds} s)`;
  return `held (${seconds} s${reply ? `, replied ${JSON.stringify(reply)}` : ''})`;
}

/** The race's other runner: a value `callTool` can never return. */
const PROBE_DEADLINE = Symbol('probe deadline');

/**
 * How long the probe waits for the ABORTED call to settle before it reads the
 * directory. The abort SIGKILLs the process group, so the settle is usually
 * immediate — but "usually" is not a verdict: a write already in flight, or a
 * child of the vendor process still holding the pipe open, lands in the
 * directory AFTER the deadline fired, and reading it a moment too early would
 * report a breach as `skipped`. Bounded because doctor is a diagnosis and never
 * hangs on one: past this the directory is read regardless.
 */
const PROBE_SETTLE_MS = 5000;

/** Wait for `p` to settle, or `ms`, whichever comes first. Never rejects. */
function settleWithin(p, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
    Promise.resolve(p).then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
  });
}

/**
 * A run that produced no answer at all. The runtime never hands back a blank
 * string — an adapter that returns nothing is reported as its own placeholder
 * (core/unit.mjs) — so BOTH forms are the same event here: nothing was said.
 */
const emptyReply = (unit, text) => {
  const t = String(text || '').trim();
  return !t || t === `(empty response from ${unit.label})`;
};

/**
 * The environment the probe hands `createUnitRuntime`: doctor's own, with one
 * value changed — the probe's ceiling on this unit's timeout.
 *
 * `OMELETTE_HOME` is read by THIS process, which since 0.3.6 never leaves the
 * directory the operator ran `doctor` in, so a relative one means exactly what
 * it means for `doctor` with no flag at all: it is left exactly as it was
 * given. A relative `<UNIT>_BIN` needs nothing here either — `createUnitRuntime`
 * resolves the binary once against the cwd of the process that starts the unit,
 * which for the probe is doctor's own (core/unit.mjs, resolveBin).
 */
function probeRuntimeEnv(unit, env, { capS }) {
  const built = { ...env };
  // The probe's ceiling reaches the adapter the only way a per-call bound can:
  // the unit's own timeout env var, which unitConfig resolves above the file.
  // NOTHING else is overridden — the model, the effort and the mode stay
  // exactly as this install has them, because the question is what this
  // install does.
  const timeoutEnv = unit.envMap && unit.envMap.timeoutS;
  if (timeoutEnv) built[timeoutEnv] = String(capS);
  return built;
}

/**
 * Probe ONE unit. The caller has already decided the unit is enabled,
 * registered as OURS and has a binary — the `skipped` reasons left to this
 * function are the ones only the run itself can produce: no temp directory, a
 * call that failed or said nothing, a call still going at the deadline, and a
 * directory it could not look into.
 *
 * @param {object} unit the adapter (UNITS[name]).
 * @param {{cfg:object, env?:object, log?:Function}} o `cfg` is doctor's own
 *   resolution for this unit, so the report and the probe cannot disagree.
 * @returns {Promise<{verdict:'held'|'BREACHED'|'skipped', reason:string|null,
 *   seconds:number, reply:string, path:string}>}
 */
async function probeUnit(unit, { cfg, env = process.env, log = () => {} }) {
  const capS = Math.min(cfg.values.timeoutS, PROBE_TIMEOUT_CAP_S);
  // The directory IS the instrument: one this process cannot create is a probe
  // that never happened, and nothing else runs for this unit.
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), `omelette-probe-${unit.name}-`));
  } catch (e) {
    return { verdict: 'skipped', reason: `temp dir: ${(e && e.message) || e}`, seconds: 0, reply: '', path: null };
  }
  // mkdtemp(3) already creates the directory 0700; the chmod says so out loud
  // and covers a platform that ever decides otherwise.
  try { chmodSync(dir, 0o700); } catch { /* it is ours either way */ }
  const started = Date.now();
  try {
    let text = '';
    let failed = false;
    let timedOut = false;
    let timer = null;
    // When the probe stopped waiting for an ANSWER. It is the number on the
    // line, and the wait for the aborted call to settle is deliberately not
    // part of it: `timed out after N s` names the deadline the operator set.
    let decidedAt = 0;
    try {
      // `cancel: 'kill'` for THIS runtime only (core/unit.mjs), whatever the
      // operator configured: it is what makes the signal below reach the
      // spawn. Under `finish` the runtime passes nothing down, and the
      // deadline would end the WAIT without ending the RUN.
      const rt = createUnitRuntime(unit, { env: probeRuntimeEnv(unit, env, { capS }), cancel: 'kill' });
      // The three research tools take a `cwd` (0.3.6), so the vendor process
      // runs in the probe directory because it was ASKED to — not because
      // doctor stood there. A cwd-relative write still lands in the directory
      // under test rather than in the operator's project, the spooled record
      // names it on the `cwd:` header, and every relative path in doctor's own
      // environment goes on meaning what it meant on the command line.
      const controller = new AbortController();
      const call = rt.callTool(PROBE_TOOL[unit.name], { prompt: probePrompt(dir), cwd: dir }, { signal: controller.signal });
      // ONE DEADLINE FOR THE WHOLE PROBE. The unit's own timeout bounds the
      // CHILD; it does not bound the call around it — a retry delay, a vendor
      // whose kill margin sits above its timeout, a pipe an orphan is still
      // holding open. This waits `capS` and then goes to look, whatever the
      // call is doing: doctor is a diagnosis, and it never hangs on one.
      const deadline = new Promise((settle) => { timer = setTimeout(() => settle(PROBE_DEADLINE), capS * 1000); });
      const r = await Promise.race([call, deadline]);
      decidedAt = Date.now();
      if (r === PROBE_DEADLINE) {
        timedOut = true;
        // ENDED, not merely abandoned. The abort reaches every spawn the call
        // owns and SIGKILLs the process group at once; without it doctor sat
        // on the child's own bounds after it had already printed its line —
        // `timeoutS + 60 s` for gemini — because an open stdout pipe keeps
        // this process's event loop alive.
        controller.abort();
        // THEN wait for the call to settle, briefly, before the directory is
        // read: the kill is asynchronous, and a write the vendor process (or
        // something it left behind) had already started lands after the
        // deadline fired. Reading a directory while the run is still alive is
        // a race whose losing side reports a BREACH as `skipped`. The wait
        // also disposes of the abandoned call's answer, which must not reach
        // this process as an unhandled rejection.
        await settleWithin(call, PROBE_SETTLE_MS);
      } else {
        text = (r && r.text) || '';
        // A refusal, an auth failure or a crashed CLI all arrive here as an
        // answer. None of them measured a sandbox.
        failed = !!(r && r.isError) || emptyReply(unit, text);
      }
    } catch (e) {
      // callTool answers refusals rather than throwing; this is the runtime
      // itself failing, and it is still just text on the line.
      text = `${(e && e.message) || e}`;
      failed = true;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const seconds = Math.round(((decidedAt || Date.now()) - started) / 1000);
    const reply = firstLine(text).slice(0, 80);
    // THE VERDICT IS THE FILESYSTEM — and the directory itself is part of it.
    // One that is GONE, or is not a directory any more, was written to as
    // surely as one holding a file; reading either as `held` would be the one
    // mistake this probe exists to avoid. Any other failure to look is no
    // measurement at all, and says so.
    let entries;
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        return { verdict: 'BREACHED', reason: 'directory was removed or replaced', seconds, reply, path: dir };
      }
      // Any entry counts: the prompt asks for probe.txt, and a unit that wrote
      // something else still wrote.
      entries = readdirSync(dir);
    } catch (e) {
      if (e && e.code === 'ENOENT') return { verdict: 'BREACHED', reason: 'directory was removed or replaced', seconds, reply, path: dir };
      return { verdict: 'skipped', reason: `could not inspect: ${(e && e.code) || (e && e.message) || e}`, seconds, reply, path: dir };
    }
    const written = entries.includes(PROBE_FILE) ? PROBE_FILE : (entries[0] || null);
    // EVIDENCE OUTRANKS EVERYTHING BELOW: a file on disk does not stop being a
    // file because the run then timed out or failed.
    if (written) return { verdict: 'BREACHED', reason: null, seconds, reply, path: join(dir, written) };
    // A run that never answered proves nothing either way, and neither does
    // one that answered with its own failure: `held` is a claim about a
    // sandbox, and it needs a call that actually ran to the end.
    if (timedOut) return { verdict: 'skipped', reason: `timed out after ${seconds} s`, seconds, reply, path: dir };
    if (failed) return { verdict: 'skipped', reason: `call failed: ${reply || '(no reply)'}`, seconds, reply, path: dir };
    return { verdict: 'held', reason: null, seconds, reply, path: dir };
  } finally {
    // EVERY path — verdict, timeout or throw: the directory does not outlive
    // the probe. A removal that fails is one line, never a lost diagnosis.
    // A unit that stripped the directory's own bits (the "could not inspect"
    // case) would otherwise leave it behind: reopen it, then remove it.
    try { chmodSync(dir, 0o700); } catch { /* gone, or not ours to reopen */ }
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { log(`probe: could not remove ${dir}: ${(e && e.message) || e}`); }
  }
}

/**
 * What the registry says about this unit — and whether it is even ours (see
 * findRegistration). A registration is called by the name it actually WEARS:
 * `<prefix>-<unit>` is what doctor went looking for, but a server of ours found
 * under another name runs the same file, and printing the name it does not have
 * would send an operator looking for an entry that is not in the file.
 */
function mcpLine(name, prefix, reg, expected) {
  const server = reg ? reg.name : `${prefix}-${name}`;
  if (!reg) return `${server} not registered — run: omelette-fleet install --units ${name}`;
  const file = reg.exists ? '[file exists]' : '[FILE MISSING]';
  const cmd = reg.command ? `${reg.command} ` : '';
  return reg.ours
    ? `${server} registered (${reg.scope}) → ${cmd}${reg.target} ${file}`
    : `${server} registered elsewhere (${reg.scope}) → ${cmd}${reg.target || '(no args)'} ${file}\n              not this clone — install here would point it at ${expected}`;
}

async function cmdDoctor(argv) {
  const { flags, positional, errors } = parseArgv(argv, { booleans: ['probe-models', 'probe-sandbox'], options: ['prefix'] });
  if (positional.length) errors.push(`unexpected argument: ${positional[0]}`);
  const prefix = selectPrefix(flags.prefix, errors);
  if (errors.length) { errors.forEach((e) => err(`omelette-fleet doctor: ${e}`)); return 1; }

  const claude = readClaudeConfig();
  const mcpJson = readProjectMcp();
  const home = probeHome();
  const claudePath = whichBin('claude');
  // Resolved ONCE, above the header: the timeout walls need every unit's
  // timeoutS before the per-unit blocks print, and the blocks below reuse these
  // same objects so the report cannot describe two different resolutions.
  const cfgs = Object.fromEntries(UNIT_ORDER.map((n) => [n, cfgFor(n)]));
  const unitBounds = UNIT_ORDER.map((n) => ({ unit: n, enabled: cfgs[n].values.enabled, timeoutS: cfgs[n].values.timeoutS }));
  // Every registration of ours this project can see, found by where it POINTS,
  // and the prefix that follows from it. `install` and `uninstall` still work
  // by name (findRegistration) — only the diagnosis looks wider.
  const found = findOurRegistrations(
    claude.config, mcpJson.config,
    Object.fromEntries(UNIT_ORDER.map((n) => [n, serverPathFor(n)])),
    { cwd: process.cwd() },
  );
  const adopted = adoptPrefix(flags.prefix === undefined ? null : prefix, found);
  const effective = adopted.prefix;
  // The name doctor went looking for, first — including one worn by somebody
  // else's clone, which is how "registered elsewhere" is still reported. Then
  // ANY registration of ours for that unit: a server named for the job it does
  // (`codex-review`) runs this checkout all the same, and calling it missing
  // ends in an `install` that registers a second copy of what is already there.
  // NOT under an explicit `--prefix`: that flag says which install to look at,
  // and an answer about a different one is not the answer that was asked for.
  const askedPrefix = flags.prefix !== undefined;
  const regFor = (n) => found.find((r) => r.unit === n && r.name === `${effective}-${n}`)
    || (askedPrefix ? null : found.find((r) => r.ours && r.unit === n))
    || null;
  const registeredHere = UNIT_ORDER.some((n) => { const r = regFor(n); return !!r && r.ours; });
  // The entry each unit is registered through, keyed by unit: its own `timeout`
  // field is a per-server override of the client's wall-clock limit.
  const ourEntries = {};
  for (const n of UNIT_ORDER) {
    const r = regFor(n);
    if (r && r.ours) ourEntries[n] = { name: r.name, scope: r.scope, entry: r.entry };
  }

  out(`FLEET DOCTOR · omelette-fleet ${PKG.version} · node ${process.version} · ${process.platform}`);
  // Fail-soft, and cached for a day: doctor is a diagnosis of THIS machine, and
  // "GitHub was unreachable" is never one of its findings.
  const upd = updateCheckEnabled({}) ? await cachedCheck({ home: fleetHome(), current: PKG.version }) : null;
  out(`version       ${PKG.version} · latest ${upd ? (upd.latest || 'unknown') : 'check disabled'}${upd && upd.behind ? '   [run: omelette-fleet update]' : ''}`);
  out(`fleet home    ${home.dir}`);
  out(`fleet config  ${configPath()}${existsSync(configPath()) ? '' : ' (absent — built-in defaults in force)'}`);
  out(`claude CLI    ${claudePath || 'not found in PATH'}`);
  out(`claude config ${claude.path}${claude.error ? ` (${claude.error})` : ''}${claude.source === 'CLAUDE_CONFIG_DIR' ? '   [via CLAUDE_CONFIG_DIR]' : ''}`);
  // Named because it is READ: "not registered" against a file doctor never
  // opened is exactly the lie the claude config line exists to prevent.
  if (mcpJson.exists) out(`mcp.json      ${mcpJson.path}${mcpJson.error ? ` (${mcpJson.error})` : ''}`);
  if (adopted.line) out(`prefix        ${adopted.line}`);
  // The managed files, both scopes, read-only and never a fault: a project
  // without them is a perfectly healthy project.
  out(`rules         ${rulesReport(PKG.version).map((r) => `${r.scope}: ${rulesLabel(r)}`).join(' · ')}`);
  out(`agents        ${dirReport('agents', PKG.version).map((r) => `${r.scope}: ${dirLabel(r)}`).join(' · ')}`);
  out(`skills        ${dirReport('skills', PKG.version).map((r) => `${r.scope}: ${dirLabel(r)}`).join(' · ')}`);
  // The one managed kind that is inert until something else names it: the wiring
  // lives in settings.json, which doctor reads and nothing here ever writes.
  // Both scopes' wiring, read ONCE: the hooks line names the events, and the
  // settings line below names the files this reader could not parse either.
  const wiring = { project: hookWiringAt({}), global: hookWiringAt({ global: true }) };
  out(`hooks         ${dirReport('hooks', PKG.version).map((r) => `${r.scope}: ${hooksLabel(r, r.scope === 'global' ? wiring.global : wiring.project)}`).join(' · ')}`);
  // What the installed guard will do about the handoff — read out of the script
  // itself, so a threshold changed in the config and never re-rendered reads as
  // the value that is actually in force.
  const handoff = handoffReport();
  if (handoff) out(`handoff       ${handoff.line}`);
  // WHICH CONTRACT a unit server started in this directory would send at
  // `initialize` — resolved exactly the way the server resolves it, from this
  // process's cwd and environment. It is not a fault in any direction: a
  // project without the rules file gets the full text, which is correct for
  // it, and this line is how an operator sees which one they are paying for.
  const contract = contractFor({ cwd: process.cwd(), env: process.env });
  out(`contract      ${contract.short ? 'short' : 'full'} (${contract.reason})`);
  // Which sentence the rules file carries about a finished branch, and one hint
  // when a `session` policy sits in a repository that looks PR-gated. Read-only
  // and never a fault, like every other line in this block.
  out(`merge policy  ${await mergePolicy({ cwd: process.cwd(), env: process.env })}`);
  // The client's own two walls, against what the enabled units can take.
  // Informational, exactly like the lines above it: an operator whose client
  // gives up at 900 s on a 1800 s unit has a working machine and a wall.
  const walls = timeoutWalls({ units: unitBounds, registration: ourEntries, cwd: process.cwd(), env: process.env });
  walls.lines.forEach((line, i) => out(`${i === 0 ? 'mcp timeout   ' : '              '}${line}`));
  // Every settings file doctor could not parse, named once whichever reader
  // tripped over it: `readClientEnv` skipped its `env` block, so the wall lines
  // above may be reporting the client's defaults instead of what the operator
  // wrote; `hookWiringAt` skipped its `hooks` block; and `readClientSetting`
  // skipped the keys behind the `handoff` line's ceiling. Three readers, three
  // different blocks of the same file — which is why the line says "its values"
  // and not "env values". Read-only and never a fault: a file nobody can parse
  // is a fact about the machine, and this CLI does not repair settings files,
  // it names them.
  for (const path of mergeUnreadable(
    walls.unreadable, handoff ? handoff.unreadable : [], wiring.project.unreadablePaths, wiring.global.unreadablePaths,
  )) {
    out(`              settings: ${path} unreadable — its values were not consulted`);
  }
  // ONE line, and only while something is missing — see nextStep. Never a fault.
  // The first-run steps come first and the timeout wall only once they are
  // done: "raise MCP_TOOL_TIMEOUT" is tuning advice for a machine that works,
  // and it would be noise to somebody who has not registered a server yet.
  const next = nextStep(effective, registeredHere) || walls.next;
  if (next) out(`next          ${next}`);
  out();

  let faults = 0;
  let breaches = 0;
  for (const name of UNIT_ORDER) {
    const unit = UNITS[name];
    const bin = resolveBin(unit);
    const binPath = whichBin(bin);
    const cfg = cfgs[name];
    const server = serverPathFor(name);
    const reg = regFor(name);
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
    out(`  mcp         ${mcpLine(name, effective, reg, server)}`);
    out(`  status feed ${cfg.values.status ? '' : '(disabled in config) '}${home.writable ? `${home.dir} is writable` : `${home.dir} is NOT writable — ${home.error}`}`);
    out(`  results     ${cfg.values.results
      ? `${join(cfg.home, 'results', name)} · keep ${cfg.values.resultsKeep} · max ${fmtBytes(cfg.values.resultsMaxBytes)}`
      : '(disabled in config) — answers are not spooled'}`);
    // Enabled AND registered AND broken. A unit you never wired up is not a fault.
    if (cfg.values.enabled && reg && problems.length) {
      faults++;
      out(`  FAULT       enabled and registered, but: ${problems.join('; ')}`);
    }
    // LAST in the block, and only on request: one real vendor call per unit
    // that can take one. The three reasons it cannot are the same three the
    // block above has already reported — said again here, because a `sandbox`
    // line missing from one unit's block would read as a probe that hung.
    if (flags.probeSandbox) {
      // OURS, not merely present: a server registered under our name but
      // pointing at another clone runs that clone, and a call spent on it
      // would measure an install this doctor is not reporting on.
      const why = !cfg.values.enabled ? 'disabled'
        : !reg ? 'not registered'
          : !reg.ours ? 'registered elsewhere'
            : !binPath ? 'binary not found' : null;
      const probe = why
        ? { verdict: 'skipped', reason: why, seconds: 0, reply: '', path: null }
        : await probeUnit(unit, { cfg, env: process.env, log: (m) => out(`              ${m}`) });
      // A gate the operator left open is why a BREACHED verdict is expected
      // rather than alarming, so it is said on the line that carries it — and
      // on a `skipped` one too, where it explains what the probe would have
      // been measuring.
      const gate = cfg.ceilingOpen ? ` (write gate open: ${writeGateVar(name)})` : '';
      out(`  sandbox     ${sandboxLabel(probe)}${gate}`);
      if (probe.verdict === 'BREACHED') breaches++;
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
  // The one sandbox condition doctor treats as broken: a unit that wrote into
  // a directory it was only asked about. `held` and `skipped` change nothing,
  // and neither does a probe nobody asked for.
  if (breaches) out(`${breaches} unit(s) BREACHED the sandbox probe — see the sandbox lines above.`);
  const code = faults || breaches ? 1 : 0;
  // DOCTOR ENDS ITSELF. A probe's vendor process can leave a detached
  // grandchild holding the stdout pipe it inherited, and that pipe is a handle
  // this process cannot close: the call it belongs to never settles, the probe
  // reads the directory on the settle wait's own bound and reports — and then
  // an event loop with a live read stream on it keeps a finished one-shot CLI
  // alive for as long as the orphan lives. Exiting on the flush callback ends
  // it with the whole report written; the probe directory is already gone
  // (probeUnit's finally), so there is nothing left to clean up. ONLY doctor
  // does this — every other command returns its code and lets the loop drain.
  // The returned code is not dead weight either: it sets process.exitCode, so
  // a run whose stdout never reports a flush still exits correctly on its own.
  process.stdout.write('', () => process.exit(code));
  return code;
}

// ─── show / set ──────────────────────────────────────────────────────────────

function cmdShow(argv) {
  const { positional, errors } = parseArgv(argv, {});
  if (positional.length > 1) errors.push(`unexpected argument: ${positional[1]}`);
  const only = positional[0];
  const BLOCKS = ['fleet', 'agents', 'handoff', 'workflow'];
  if (only && !BLOCKS.includes(only) && !UNITS[only]) {
    errors.push(`unknown unit "${only}" — known units: ${UNIT_ORDER.join(', ')} (or "fleet" / "agents" / "handoff" / "workflow" for the top-level blocks)`);
  }
  if (errors.length) { errors.forEach((e) => err(`omelette-fleet show: ${e}`)); return 1; }

  const path = configPath();
  out(`fleet config  ${path}${existsSync(path) ? '' : ' (absent — built-in defaults in force)'}`);
  out();
  // The fleet-wide keys first: they describe the fleet itself rather than any
  // one unit, and one of them decides what every unit server says at connect
  // time — which is not something to find at the bottom of three tables.
  if (!only || only === 'fleet') {
    const settings = fleetSettings();
    out('fleet');
    for (const line of fleetRows(settings, '  ')) out(line);
    for (const w of settings.warnings) out(`  warning  ${w}`);
    // The env switch can only turn the update check OFF, and it wins: a table
    // saying `true` while the machine says otherwise is the one thing this
    // block must not do.
    if (settings.updateCheck && !updateCheckEnabled({})) {
      out('  note     OMELETTE_UPDATE_CHECK is off in this environment and wins over the file.');
    }
    out('  note     `contract` is read when a unit server STARTS: restart Claude Code for a change to reach `initialize`.');
    out();
  }
  if (!only || UNITS[only]) {
    for (const name of only ? [only] : UNIT_ORDER) {
      const cfg = cfgFor(name);
      out(`${name}`);
      for (const line of configRows(name, cfg, '  ')) out(line);
      out(`  ceiling  ${ceilingLine(name, cfg)}`);
      for (const w of cfg.warnings) out(`  warning  ${w}`);
      out();
    }
  }
  // The sub-agent definitions are config too, and the one thing that is not
  // obvious about them is that a value here only reaches a session once the
  // definitions are re-rendered — so the block says it.
  if (!only || only === 'agents') {
    const settings = agentSettings();
    out('agents');
    for (const line of agentRows(settings, '  ')) out(line);
    for (const w of settings.warnings) out(`  warning  ${w}`);
    out('  note     `omelette-fleet rules --agents` renders these into .claude/agents/.');
    out();
  }
  // The auto-handoff is config too, and it reaches a session the same way the
  // agent block does: not until the file it renders is written again.
  if (!only || only === 'handoff') {
    const settings = handoffSettings();
    out('handoff');
    for (const line of handoffRows(settings, '  ')) out(line);
    for (const w of settings.warnings) out(`  warning  ${w}`);
    out('  note     `omelette-fleet rules --hooks` renders these into .claude/hooks/omelette-guard.mjs.');
    out();
  }
  // The merge policy is config too, and it reaches a session exactly the way
  // the other two blocks do: not until the file it renders is written again.
  if (!only || only === 'workflow') {
    const settings = workflowSettings();
    out('workflow');
    for (const line of workflowRows(settings, '  ')) out(line);
    for (const w of settings.warnings) out(`  warning  ${w}`);
    out('  note     `omelette-fleet rules` renders this into .claude/rules/omelette-fleet.md.');
    out();
  }
  return 0;
}

/** Both dotted forms `set` accepts, in one place: the usage line and every refusal quote it. */
const SET_SHAPE = '<key>=<value>, <unit>.<key>=<value>, agents.<agent>.<key>=<value>, handoff.<key>=<value> or workflow.<key>=<value>';

const describeSpec = (spec) => {
  const range = spec.min !== undefined && spec.max !== undefined ? ` from ${spec.min} to ${spec.max}` : '';
  return spec.type === 'enum' ? spec.values.join(' | ')
    : spec.type === 'posint' ? `a positive integer${range} (a whole number — 0.5 and 1.9 are refused, not rounded)`
      : spec.type === 'nonneg' ? `a whole number 0 or above${range}`
        : spec.type === 'boolean' ? 'true | false'
          : spec.type === 'line' ? 'a single printable line (no newline, tab or other control character)'
            : 'a string';
};

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
  if (!positional.length) errors.push(`nothing to set — usage: omelette-fleet set ${SET_SHAPE}`);

  const assignments = [];      // units.<unit>.<key>
  const agentAssignments = []; // agents.<role>.<key>
  const handoffAssignments = []; // handoff.<key>
  const workflowAssignments = []; // workflow.<key>
  const fleetAssignments = []; // <key>, at the top level
  for (const a of positional) {
    const eq = a.indexOf('=');
    if (eq < 0) { errors.push(`"${a}" is not ${SET_SHAPE}`); continue; }
    const parts = a.slice(0, eq).trim().split('.').map((p) => p.trim());
    const raw = a.slice(eq + 1);
    // `agents` is a top-level block, not a unit, and it is one level deeper.
    if (parts[0].toLowerCase() === 'agents') {
      if (parts.length !== 3 || parts.some((p) => !p)) { errors.push(`"${a}" is not agents.<agent>.<key>=<value>`); continue; }
      const role = parts[1].toLowerCase();
      const key = parts[2];
      const schema = Object.hasOwn(AGENT_SETTINGS_SCHEMA, role) ? AGENT_SETTINGS_SCHEMA[role] : null;
      if (!schema) { errors.push(`unknown agent "${role}" — known agents: ${Object.keys(AGENT_SETTINGS_SCHEMA).join(', ')}`); continue; }
      if (!Object.hasOwn(schema, key)) { errors.push(`unknown key "${key}" for agent "${role}" — known keys: ${Object.keys(schema).join(', ')}`); continue; }
      const c = coerce(schema[key], raw);
      if (!c.ok) { errors.push(`invalid value for agents.${role}.${key}: ${JSON.stringify(raw)} — expected ${describeSpec(schema[key])}`); continue; }
      agentAssignments.push({ role, key, value: c.value });
      continue;
    }
    // `handoff` is the other top-level block, and it is one level shallower
    // than `agents`: the guard is one file with three settings, not a role.
    if (parts[0].toLowerCase() === 'handoff') {
      if (parts.length !== 2 || parts.some((p) => !p)) { errors.push(`"${a}" is not handoff.<key>=<value>`); continue; }
      const key = parts[1];
      if (!Object.hasOwn(HANDOFF_SCHEMA, key)) { errors.push(`unknown key "${key}" for the handoff block — known keys: ${Object.keys(HANDOFF_SCHEMA).join(', ')}`); continue; }
      const c = coerce(HANDOFF_SCHEMA[key], raw);
      if (!c.ok) { errors.push(`invalid value for handoff.${key}: ${JSON.stringify(raw)} — expected ${describeSpec(HANDOFF_SCHEMA[key])}`); continue; }
      handoffAssignments.push({ key, value: c.value });
      continue;
    }
    // `workflow` is the third top-level block and is shaped like `handoff`:
    // one managed file's settings, not a role's.
    if (parts[0].toLowerCase() === 'workflow') {
      if (parts.length !== 2 || parts.some((p) => !p)) { errors.push(`"${a}" is not workflow.<key>=<value>`); continue; }
      const key = parts[1];
      if (!Object.hasOwn(WORKFLOW_SCHEMA, key)) { errors.push(`unknown key "${key}" for the workflow block — known keys: ${Object.keys(WORKFLOW_SCHEMA).join(', ')}`); continue; }
      const c = coerce(WORKFLOW_SCHEMA[key], raw);
      if (!c.ok) { errors.push(`invalid value for workflow.${key}: ${JSON.stringify(raw)} — expected ${describeSpec(WORKFLOW_SCHEMA[key])}`); continue; }
      workflowAssignments.push({ key, value: c.value });
      continue;
    }
    // A bare `<key>=<value>` is one of the fleet-wide keys — the ones that
    // describe the fleet itself and sit at the top level beside `units`.
    // Anything else with no dot is a shape mistake and says so.
    //
    // `Object.hasOwn`, here and at every other schema lookup in this function:
    // `in` walks the prototype chain, so `constructor`, `toString` and
    // `hasOwnProperty` all read as known keys and are then coerced against a
    // function — which refuses the VALUE ("expected a string") for a key that
    // does not exist at all. A name nobody declared is an unknown name.
    if (parts.length === 1 && Object.hasOwn(SETTINGS_SCHEMA, parts[0])) {
      const key = parts[0];
      const c = coerce(SETTINGS_SCHEMA[key], raw);
      if (!c.ok) { errors.push(`invalid value for ${key}: ${JSON.stringify(raw)} — expected ${describeSpec(SETTINGS_SCHEMA[key])}`); continue; }
      fleetAssignments.push({ key, value: c.value });
      continue;
    }
    if (parts.length !== 2 || parts.some((p) => !p)) { errors.push(`"${a}" is not ${SET_SHAPE}`); continue; }
    const name = parts[0].toLowerCase();
    const key = parts[1];
    if (!Object.hasOwn(UNITS, name)) { errors.push(`unknown unit "${name}" — known units: ${UNIT_ORDER.join(', ')}`); continue; }
    const schema = schemaFor(name);
    if (!Object.hasOwn(schema, key)) { errors.push(`unknown key "${key}" for unit "${name}" — known keys: ${Object.keys(schema).join(', ')}`); continue; }
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
  if (assignments.length) {
    if (file.config.units !== undefined && !isObj(file.config.units)) {
      shape.push(`"units" is ${jsonKind(file.config.units)}, not an object`);
    } else if (isObj(file.config.units)) {
      for (const name of [...new Set(assignments.map((a) => a.name))]) {
        const entry = file.config.units[name];
        if (entry !== undefined && !isObj(entry)) shape.push(`"units.${name}" is ${jsonKind(entry)}, not an object`);
      }
    }
  }
  if (agentAssignments.length) {
    if (file.config.agents !== undefined && !isObj(file.config.agents)) {
      shape.push(`"agents" is ${jsonKind(file.config.agents)}, not an object`);
    } else if (isObj(file.config.agents)) {
      for (const role of [...new Set(agentAssignments.map((a) => a.role))]) {
        const entry = file.config.agents[role];
        if (entry !== undefined && !isObj(entry)) shape.push(`"agents.${role}" is ${jsonKind(entry)}, not an object`);
      }
    }
  }
  if (handoffAssignments.length && file.config.handoff !== undefined && !isObj(file.config.handoff)) {
    shape.push(`"handoff" is ${jsonKind(file.config.handoff)}, not an object`);
  }
  if (workflowAssignments.length && file.config.workflow !== undefined && !isObj(file.config.workflow)) {
    shape.push(`"workflow" is ${jsonKind(file.config.workflow)}, not an object`);
  }
  if (shape.length) {
    for (const m of shape) err(`omelette-fleet set: ${file.path}: ${m}`);
    err('omelette-fleet set: fix the file by hand first — refusing to replace it.');
    return 1;
  }

  // Old values are the EFFECTIVE ones a unit would see, so a shadowing env var stays visible.
  const before = assignments.length ? new Map(UNIT_ORDER.map((n) => [n, cfgFor(n)])) : null;
  const beforeAgents = agentAssignments.length ? agentSettings() : null;
  const beforeHandoff = handoffAssignments.length ? handoffSettings() : null;
  const beforeWorkflow = workflowAssignments.length ? workflowSettings() : null;
  const beforeFleet = fleetAssignments.length ? fleetSettings() : null;
  const next = JSON.parse(JSON.stringify(file.config));
  if (assignments.length) {
    next.units = isObj(next.units) ? next.units : {};
    for (const a of assignments) {
      next.units[a.name] = isObj(next.units[a.name]) ? next.units[a.name] : {};
      next.units[a.name][a.key] = a.value;
    }
  }
  if (agentAssignments.length) {
    next.agents = isObj(next.agents) ? next.agents : {};
    for (const a of agentAssignments) {
      next.agents[a.role] = isObj(next.agents[a.role]) ? next.agents[a.role] : {};
      next.agents[a.role][a.key] = a.value;
    }
  }
  if (handoffAssignments.length) {
    next.handoff = isObj(next.handoff) ? next.handoff : {};
    for (const a of handoffAssignments) next.handoff[a.key] = a.value;
  }
  if (workflowAssignments.length) {
    next.workflow = isObj(next.workflow) ? next.workflow : {};
    for (const a of workflowAssignments) next.workflow[a.key] = a.value;
  }
  // A scalar at the top level: there is no block to merge into and so no
  // shape to refuse — the key is either replaced or added.
  for (const a of fleetAssignments) next[a.key] = a.value;
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
  for (const a of agentAssignments) {
    out(`agents.${a.role}.${a.key}  ${fmtValue(beforeAgents[a.role][a.key])} [${beforeAgents.sources[a.role][a.key]}] → ${fmtValue(a.value)} [file]`);
  }
  // The definitions on disk were rendered from the OLD value: until they are
  // re-rendered, the config and what the session reads disagree.
  if (agentAssignments.length) out('  note: `omelette-fleet rules --agents` re-renders the definitions with the new value.');
  for (const a of handoffAssignments) {
    out(`handoff.${a.key}  ${fmtValue(beforeHandoff[a.key])} [${beforeHandoff.sources[a.key]}] → ${fmtValue(a.value)} [file]`);
  }
  // The guard on disk was rendered from the OLD value: until it is re-rendered,
  // the config and the hook that is actually running disagree — and `doctor`
  // reports the hook's value, not this one.
  if (handoffAssignments.length) out('  note: `omelette-fleet rules --hooks` re-renders the guard with the new value.');
  for (const a of workflowAssignments) {
    out(`workflow.${a.key}  ${fmtValue(beforeWorkflow[a.key])} [${beforeWorkflow.sources[a.key]}] → ${fmtValue(a.value)} [file]`);
  }
  // The rules file on disk was rendered from the OLD value: until it is written
  // again, the sentence the session reads is the other one.
  if (workflowAssignments.length) out('  note: `omelette-fleet rules` re-renders the rules file with the new value.');
  for (const a of fleetAssignments) {
    out(`${a.key}  ${fmtValue(beforeFleet[a.key])} [${beforeFleet.sources[a.key]}] → ${fmtValue(a.value)} [file]`);
  }
  // The same shape of trap as the two blocks above, one step earlier: the
  // servers that are running read `contract` when they STARTED.
  if (fleetAssignments.some((a) => a.key === 'contract')) {
    out('  note: a unit server reads `contract` when it STARTS — restart Claude Code (or just the MCP servers) for it to reach `initialize`.');
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

// ─── results ─────────────────────────────────────────────────────────────────

/** One unit's spool, resolved through the same config layers the running server sees. */
const storeFor = (name) => {
  const cfg = cfgFor(name);
  return createResultStore({
    home: cfg.home, unit: name, keep: cfg.values.resultsKeep, maxBytes: cfg.values.resultsMaxBytes,
  });
};

/** Wall time an operator reads at a glance: `42s`, `18m 1s`, `1h 2m 3s`. */
const fmtWall = (ms) => {
  const whole = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return [...(h ? [`${h}h`] : []), ...(h || m ? [`${m}m`] : []), `${s}s`].join(' ');
};

const STATS_HEAD = ['unit', 'calls', 'ok/error/cancelled', 'partial', 'wall', 'spool', 'tokens in / out'];

/** One row's cells, in STATS_HEAD's order. */
const statsCells = (row) => [
  row.unit,
  String(row.calls),
  `${row.ok}/${row.error}/${row.cancelled}`,
  String(row.partial),
  fmtWall(row.durationMs),
  fmtBytes(row.bytes),
  // A total is a total of everything or it is not one. Where some call's vendor
  // reported nothing, the cell says how much of the row is actually known
  // rather than adding a zero nobody measured.
  row.reported === row.calls
    ? `${row.input} / ${row.output}`
    : `n/a (${row.reported} of ${row.calls} ${row.calls === 1 ? 'call' : 'calls'} reported)`,
];

/**
 * `results --stats` — what the spool cost, per unit and in total. A unit with
 * no records in the window is not a row; no rows at all is `no results`. Exit
 * 0 whatever it finds: an empty spool is an answer, not a fault. Retention
 * bounds what can be counted — this reads what `resultsKeep` and
 * `resultsMaxBytes` left on disk, not the history of the install.
 */
/**
 * How far back a relative window may reach: ten years, in either unit. Past
 * that it is not a window an operator meant — `99999999h` is a digit somebody
 * held down, and it would resolve to a timestamp outside the range JavaScript
 * dates cover, which `new Date(...).toISOString()` throws on when `--stats`
 * prints the window it used.
 */
const SINCE_MAX = { h: 87600, d: 3650 };

/**
 * `--since`: a window (`24h`, `7d`) or a date the reader wrote (`2026-09-09`,
 * or a whole ISO timestamp) → the epoch in milliseconds. `null` for a value
 * that is neither, which the caller refuses rather than quietly reporting on
 * everything. A relative window is measured from NOW — `24h` is the last 24
 * hours, not "since midnight".
 *
 * A DATE HAS TO BE THE DATE IT SPELLS. `Date.parse` rolls a bad day over —
 * `2026-02-30` is 2 March and `2026-09-31` is 1 October — so the parse is only
 * accepted when it round-trips to exactly what was typed: the ISO date for a
 * bare `YYYY-MM-DD`, the whole ISO timestamp for the longer form. A window
 * silently shifted by two days is worse than a refusal an operator can fix.
 */
function parseSince(raw, now = Date.now()) {
  const s = String(raw).trim();
  const rel = /^(\d+)([hd])$/i.exec(s);
  if (rel) {
    const unit = rel[2].toLowerCase();
    const n = Number(rel[1]);
    if (!Number.isSafeInteger(n) || n > SINCE_MAX[unit]) return null;
    return now - n * (unit === 'h' ? 3600000 : 86400000);
  }
  if (!/^\d{4}-\d\d-\d\d/.test(s)) return null; // a date, or nothing this reads
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const iso = new Date(t).toISOString();
  return (s.length === 10 ? iso.slice(0, 10) : iso) === s ? t : null;
}

function statsReport(name, sinceMs) {
  // The numbers below are about a window; say which one, or they read as the
  // whole spool.
  if (sinceMs !== null) out(`since ${new Date(sinceMs).toISOString()}`);
  const rows = [];
  for (const u of name ? [name] : UNIT_ORDER) {
    const s = storeFor(u).stats({ since: sinceMs });
    if (s.calls) rows.push({ unit: u, ...s });
  }
  if (!rows.length) { out('no results'); return 0; }
  const SUMS = ['calls', 'ok', 'error', 'cancelled', 'partial', 'durationMs', 'bytes', 'reported', 'input', 'output'];
  const total = rows.reduce((a, r) => {
    for (const k of SUMS) a[k] += r[k];
    return a;
  }, { unit: 'total', ...Object.fromEntries(SUMS.map((k) => [k, 0])) });
  const table = [STATS_HEAD, ...rows.map(statsCells), statsCells(total)];
  const width = STATS_HEAD.map((_, i) => Math.max(...table.map((r) => r[i].length)));
  for (const r of table) out(r.map((cell, i) => pad(cell, width[i])).join('  ').trimEnd());
  return 0;
}

function cmdResults(argv) {
  const { flags, positional, errors } = parseArgv(argv, { booleans: ['path', 'stats'], options: ['since'] });
  // ONE positional that is a result id is an ID, not a unit: an id is what a
  // listing line, a status feed and a `<unit>_result` answer all hand back, and
  // it names its own file — no unit name can be a result id, so nothing is
  // ambiguous. Without a unit the spool of each unit is asked in turn.
  const idOnly = positional.length === 1 && isValidResultId(positional[0]);
  const [name, id] = idOnly ? [undefined, positional[0]] : positional;
  if (positional.length > 2) errors.push(`unexpected argument: ${positional[2]}`);
  if (name !== undefined && !UNITS[name]) {
    errors.push(`unknown unit "${name}" — known units: ${UNIT_ORDER.join(', ')} (usage: omelette-fleet results [<unit>] [<id>] [--path] [--stats [--since <when>]])`);
  }
  // The id is validated before any path is built, here as in the tool.
  if (id !== undefined && !isValidResultId(id)) {
    errors.push(`"${id}" is not a result id — they look like 20260908T142501Z-19312-1`);
  }
  // `--stats` reports on a spool; the other two answer about one file in it.
  if (flags.stats) {
    if (id !== undefined) errors.push('--stats reports on a unit, not on one result — drop the id');
    if (flags.path) errors.push('--path prints the paths of a listing; --stats has no file to name');
  }
  // A window over `startedAt`, and only --stats reads one.
  let sinceMs = null;
  if (flags.since !== undefined) {
    if (!flags.stats) errors.push('--since is only for --stats');
    else {
      sinceMs = parseSince(flags.since);
      if (sinceMs === null) {
        errors.push(`--since "${flags.since}" is neither a window (24h, 7d — at most ${SINCE_MAX.h}h / ${SINCE_MAX.d}d) nor a date (2026-09-09, or a whole ISO timestamp, spelling a day that exists)`);
      }
    }
  }
  if (errors.length) { errors.forEach((e) => err(`omelette-fleet results: ${e}`)); return 1; }

  if (flags.stats) return statsReport(name, sinceMs);

  if (id !== undefined) {
    let found = null;
    for (const u of name === undefined ? UNIT_ORDER : [name]) {
      found = storeFor(u).read(id);
      if (found) break;
    }
    if (!found) {
      err(name === undefined
        ? `omelette-fleet results: no spooled result "${id}" in any unit`
        : `omelette-fleet results: no spooled result "${id}" for ${name} in ${join(fleetHome(), 'results', name)}`);
      return 1;
    }
    out(flags.path ? found.path : renderResult({ ...found.header, text: found.text }));
    return 0;
  }

  const rows = [];
  for (const u of name ? [name] : UNIT_ORDER) for (const e of storeFor(u).list(10)) rows.push({ ...e, unit: u });
  rows.sort((a, b) => (a.endedAt === b.endedAt ? 0 : a.endedAt < b.endedAt ? 1 : -1));
  const top = rows.slice(0, 10);
  if (!top.length) { out(`(no results spooled yet — ${join(fleetHome(), 'results')})`); return 0; }
  for (const e of top) out(flags.path ? e.path : formatEntry(e, { unit: e.unit }));
  return 0;
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
    case 'results': return cmdResults(rest);
    default:
      err(`omelette-fleet: unknown command "${cmd}"`);
      err('commands: install, uninstall, update, rules, doctor, show, set, call, results — `omelette-fleet --help` for the full usage.');
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code || 0; },
  (e) => { err(`omelette-fleet: ${(e && e.stack) || e}`); process.exitCode = 1; },
);
