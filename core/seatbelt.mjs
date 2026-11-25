/**
 * omelette-fleet :: core/seatbelt.mjs
 * What a unit needs to run a command under macOS Seatbelt (`sandbox-exec`):
 * whether the binary is there, a path made a literal inside a profile's regex,
 * and what a profile re-allows of the node the fleet runs on past its deny of
 * the operator's home.
 *
 * Used by Mistral's repro (units/mistral/repro.mjs re-exports it; the profile
 * is units/mistral/repro.sb, handed these values by the wrapper of
 * units/mistral/home.mjs). The profiles stay with their units: this module
 * renders none.
 *
 * Zero deps.
 */
import { accessSync, constants, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

/** The Seatbelt front end a unit runs a command under a profile with. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** macOS with an executable `sandbox-exec` at `sandboxExec`. */
export function sandboxExecFound({ platform = process.platform, sandboxExec = SANDBOX_EXEC } = {}) {
  if (platform !== 'darwin') return false;
  try {
    accessSync(sandboxExec, constants.X_OK);
    return true;
  } catch { return false; }
}

/**
 * `s` as a regex matching it literally: its metacharacters escaped. The repro
 * profile uses TMPROOT only inside a regex, so a `.` or a `+` in the OS temp
 * root must not widen or break the deny built from it.
 */
export const regexLiteral = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** NODEUP when the node's prefix is not under the home: a regex no path matches. */
export const NODEUP_NONE = '^$';

/**
 * The directories from `home` (itself included) down to the parent of `node` (the prefix the profile re-allows,
 * or the binary alone), as the one anchored regex the profile allows metadata on (NODEUP): node lstats every
 * component of its script's path, so npm under `~/.nvm` needs each of them stat-able. Never listable, and nothing
 * beside them. NODEUP_NONE when `node` is not under `home`. Both paths come resolved.
 */
export function nodeUp({ home, node }) {
  if (!node.startsWith(home === sep ? sep : home + sep)) return NODEUP_NONE;
  const chain = [];
  for (let d = dirname(node); ; d = dirname(d)) {
    chain.unshift(d);
    if (d === home || d === dirname(d)) break;
  }
  return `^(${chain.map(regexLiteral).join('|')})$`;
}

/**
 * What the repro profile re-allows of the node the adapter runs on, past its HOME deny, as two anchored regexes:
 * `node` (NODE: these paths and everything under them) and `up` (NODEUP: nodeUp's chain, metadata only).
 *   - A prefix outside the home: the whole prefix; nothing in the home.
 *   - A prefix under the home (`~/.nvm/versions/node/v20`): its `bin`, `lib/node_modules/npm` and
 *     `lib/node_modules/corepack` only, so the operator's other global packages stay unreadable, and the directories
 *     from the home down to `lib/node_modules` stat-able, which node walks to npm's script.
 *   - A prefix that is the home or an ancestor of it (a node in `~/bin`): the binary alone.
 * All three paths come resolved.
 */
export function nodeReach({ home, prefix, binary }) {
  const subpaths = (paths) => `^(${paths.map(regexLiteral).join('|')})(/|$)`;
  const covers = home === prefix || home.startsWith(prefix === sep ? sep : prefix + sep);
  if (covers) return { node: subpaths([binary]), up: nodeUp({ home, node: binary }) };
  if (!prefix.startsWith(home === sep ? sep : home + sep)) return { node: subpaths([prefix]), up: NODEUP_NONE };
  const modules = join(prefix, 'lib', 'node_modules');
  return { node: subpaths([join(prefix, 'bin'), join(modules, 'npm'), join(modules, 'corepack')]), up: nodeUp({ home, node: join(modules, 'npm') }) };
}

/**
 * The wrapper's OMELETTE_REPRO_NODE and OMELETTE_REPRO_NODEUP for the node at `prefix` (`binary` its executable,
 * both resolved; by default the node this process runs on), as Mistral's reproOnce hands them on (nodeReach).
 */
export function nodeEnv({ home, prefix = realpathSync(dirname(dirname(process.execPath))), binary = realpathSync(process.execPath) }) {
  const { node, up } = nodeReach({ home, prefix, binary });
  return { OMELETTE_REPRO_NODE: node, OMELETTE_REPRO_NODEUP: up };
}
