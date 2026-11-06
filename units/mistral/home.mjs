/**
 * omelette-fleet :: units/mistral/home.mjs
 * The two Vibe homes the unit runs under — `<fleet home>/vibe/review/` and
 * `<fleet home>/vibe/repro/` — rendered from units/mistral/models.js. The
 * adapter points `VIBE_HOME` at one per run; the operator's `~/.vibe` is never
 * read or written.
 *
 * Each home holds:
 *   config.toml  the policy block (telemetry, update checks, auto-update,
 *                subagents, MCP, connectors off; `outside_workdir = "deny"`),
 *                `active_model` = the catalog head, the catalog as Vibe
 *                `models` entries, and `[tools.bash] shell` = this home's
 *                shell.sh. Without the `models` list Vibe silently runs its own
 *                default (spec, probe 5).
 *   shell.sh     the shell every `bash` command runs through. It answers Vibe's
 *                login-env probe (`<shell> -lc '…mistralai-vibe-login-env-<id>…;
 *                exec env -0'`) with the probe's marker, then its own
 *                environment through `env -0` — Vibe keeps what follows the
 *                last marker, so the capture succeeds — and no login shell
 *                runs: nothing the operator's .zprofile / .zshrc exports
 *                reaches the model's shell. Review then runs
 *                plain bash; repro runs bash under `sandbox-exec -f repro.sb`,
 *                the clone, the run's tmp and the fleet home read per run from
 *                OMELETTE_REPRO_CLONE / OMELETTE_REPRO_TMP / OMELETTE_FLEET_HOME
 *                (one wrapper serves every clone). An unset or empty HOME or
 *                OMELETTE_FLEET_HOME stops the wrapper before sandbox-exec
 *                (`${…:?}`): an empty HOME would turn every `$HOME/.ssh`-class
 *                read-deny into `/.ssh`, and fail open.
 *   repro.sb     repro only: units/mistral/repro.sb, byte for byte — the probe
 *                profile plus one last line read-denying the fleet home
 *                (FLEET), which OMELETTE_HOME may move out of `$HOME/.omelette`.
 *
 * Rendering is `ensureHome`: before every spawn, a file whose bytes differ (a
 * changed catalog, a new package version in the marker) is rewritten through
 * an O_EXCL temporary name and a rename; a symlink anywhere on the way is
 * refused, never followed.
 *
 * Zero deps.
 */

import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetHome } from '../../core/config.mjs';
import { VERSION } from '../../core/update.mjs';
import { MISTRAL_MODELS } from './models.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES = ['review', 'repro'];

/** The policy lines of the probe-6 home, verbatim. */
const POLICY = [
  'enable_telemetry = false',
  'enable_update_checks = false',
  'enable_auto_update = false',
  'enable_subagents = false',
  'enable_mcp = false',
  'enable_connectors = false',
  'outside_workdir = "deny"',
  'show_greeting = false',
];

/**
 * The alias of the same family at `effort`, else `modelId` unchanged (the
 * caller logs the miss).
 */
export function resolveAlias(modelId, effort) {
  const from = MISTRAL_MODELS.find((m) => m.id === modelId);
  if (!from || !effort) return modelId;
  const to = MISTRAL_MODELS.find((m) => m.family === from.family && m.effort === effort);
  return to ? to.id : modelId;
}

/** A TOML basic string. JSON's escapes are TOML's, except DEL, which TOML wants escaped. */
const tomlString = (s) => JSON.stringify(String(s)).replaceAll('\u007f', '\\u007F');
const tomlFloat = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
/** A single-quoted bash word. */
const shWord = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

const homeDir = (home, profile) => join(home, 'vibe', profile);

function checkProfile(profile) {
  if (!PROFILES.includes(profile)) throw new Error(`mistral: unknown Vibe home profile "${profile}" (${PROFILES.join(' | ')})`);
}

/** The home's config.toml. */
export function renderVibeConfig({ models, profile, home, version }) {
  checkProfile(profile);
  const entry = (m) => {
    const keys = [
      `name = ${tomlString(m.vendorName)}`,
      'provider = "mistral"',
      `alias = ${tomlString(m.id)}`,
      `display_name = ${tomlString(m.label)}`,
      `temperature = ${tomlFloat(m.temperature)}`,
    ];
    if (m.thinking !== 'off') keys.push(`thinking = ${tomlString(m.thinking)}`);
    keys.push(`input_price = ${tomlFloat(m.priceIn)}`, `output_price = ${tomlFloat(m.priceOut)}`);
    if (m.autoCompactThreshold) keys.push(`auto_compact_threshold = ${m.autoCompactThreshold}`);
    return `  { ${keys.join(', ')} },`;
  };
  return [
    `# omelette-fleet mistral/${profile} home v${version} — rendered from units/mistral/models.js; edits are overwritten`,
    `active_model = ${tomlString(models[0].id)}`,
    ...POLICY,
    'models = [',
    ...models.map(entry),
    ']',
    '',
    '[tools.bash]',
    `shell = ${tomlString(join(homeDir(home, profile), 'shell.sh'))}`,
    '',
  ].join('\n');
}

/** The home's shell.sh. */
export function renderWrapper({ profile, home }) {
  checkProfile(profile);
  const run = profile === 'repro'
    ? 'exec /usr/bin/sandbox-exec -D CLONE="$OMELETTE_REPRO_CLONE" -D TMP="$OMELETTE_REPRO_TMP" -D HOME="${HOME:?}" '
      + `-D FLEET="\${OMELETTE_FLEET_HOME:?}" -f ${shWord(join(homeDir(home, 'repro'), 'repro.sb'))} /bin/bash "$@"`
    // Review has no shell tool by policy (`--enabled-tools read_file grep`): a
    // command reaching this wrapper is an anomaly, refused, never run unsandboxed.
    : 'echo "omelette-fleet mistral/review: the review profile has no shell — command refused" >&2; exit 126';
  return [
    '#!/bin/bash',
    `# omelette-fleet mistral/${profile} shell — rendered by units/mistral/home.mjs; edits are overwritten.`,
    '# Vibe\'s login-env probe gets its marker, then this process\'s own environment: no login shell, no .zshrc exports.',
    'if [ "$1" = "-lc" ] && [[ "$2" == *mistralai-vibe-login-env* ]]; then',
    '  [[ "$2" =~ (mistralai-vibe-login-env-[A-Za-z0-9_-]+) ]] && printf \'%s\' "${BASH_REMATCH[1]}"',
    '  exec /usr/bin/env -0',
    'fi',
    run,
    '',
  ].join('\n');
}

/** A directory of ours: created 0700 when absent, refused when it is a symlink or not a directory. */
function ownDir(path) {
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`mistral: ${path} is a symlink — refusing to render the Vibe home through it`);
  if (!st.isDirectory()) throw new Error(`mistral: ${path} is not a directory — refusing to render the Vibe home there`);
}

/** The bytes and permission bits at `path`, null when absent; a symlink or anything but a regular file is refused. */
function current(path) {
  let st;
  try { st = lstatSync(path); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
  if (st.isSymbolicLink()) throw new Error(`mistral: ${path} is a symlink — refusing to follow it`);
  if (!st.isFile()) throw new Error(`mistral: ${path} is not a regular file — refusing to replace it`);
  return { bytes: readFileSync(path), mode: st.mode & 0o777 };
}

/** O_EXCL open of `tmp`: `{ fd }`, or `{ exists: true }` when something is already there. */
function openTmp(tmp, mode) {
  try { return { fd: openSync(tmp, 'wx', mode) }; }
  catch (e) { if (e && e.code === 'EEXIST') return { exists: true }; throw e; }
}

/**
 * `<path>.tmp-<pid>` opened O_EXCL at `mode`, then renamed over `path`. A
 * regular file already at the tmp name is a leftover of a run that died between
 * the open and the rename (a pid comes round again): it is removed and the open
 * retried once. A symlink or anything else there is refused, never followed.
 */
function writeThroughTmp(path, bytes, mode) {
  const tmp = `${path}.tmp-${process.pid}`;
  const refuse = () => new Error(`mistral: cannot write ${path}: temporary file ${tmp} already exists`);
  let opened = openTmp(tmp, mode);
  if (opened.exists) {
    let st;
    try { st = lstatSync(tmp); } catch { throw refuse(); }
    if (!st.isFile()) throw refuse();
    unlinkSync(tmp);
    opened = openTmp(tmp, mode);
    if (opened.exists) throw refuse();
  }
  const { fd } = opened;
  try {
    try { for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off); }
    finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/**
 * Render one profile's home under `<home>/vibe/<profile>/`, rewriting only the
 * files whose bytes differ; a file with the right bytes and a looser mode gets
 * its mode back (logged, not counted as rendered). Throws, naming the path, on
 * a symlink.
 * @returns {{ dir: string, rendered: boolean }} rendered: some file was written
 */
export function ensureHome({ home = fleetHome(), profile, models = MISTRAL_MODELS, version = VERSION, log } = {}) {
  checkProfile(profile);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const dir = homeDir(home, profile);
  ownDir(join(home, 'vibe'));
  ownDir(dir);
  const files = [
    ['config.toml', Buffer.from(renderVibeConfig({ models, profile, home, version })), 0o600],
    ['shell.sh', Buffer.from(renderWrapper({ profile, home })), 0o700],
  ];
  if (profile === 'repro') files.push(['repro.sb', readFileSync(join(HERE, 'repro.sb')), 0o600]);
  let rendered = false;
  for (const [name, bytes, mode] of files) {
    const path = join(dir, name);
    const have = current(path);
    if (have && have.bytes.equals(bytes)) {
      if (have.mode !== mode) {
        chmodSync(path, mode);
        if (typeof log === 'function') log(`mistral: mode ${mode.toString(8)} restored on ${path}`);
      }
      continue;
    }
    writeThroughTmp(path, bytes, mode);
    rendered = true;
    if (typeof log === 'function') log(`mistral: rendered ${path}`);
  }
  return { dir, rendered };
}
