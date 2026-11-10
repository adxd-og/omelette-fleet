/**
 * omelette-fleet :: mods/omelette-fleet/hooks/roles.mjs
 * The guarded roles' definitions (1.8.0; six since 1.10.0): the `model:` and `effort:`
 * lines of each role's frontmatter, read once per session, so the mod can pin
 * a spawn to the definition's model and flag a step whose effort is not the
 * definition's. The definition decides; this file only reads it, and a file
 * that cannot be read or parsed leaves its role without one (no pin, no flag).
 *
 * `$` is always spelled `$.noun.method(...)` literally: the engine scans the
 * source and refuses a call it did not see.
 */

/** The roles `rules --agents` installs and the guard covers, matched whole (GUARDED_AGENTS). */
export const ROLES = Object.freeze(['omelette-coder', 'omelette-coder-medium', 'omelette-coder-hard', 'omelette-coder-xhard', 'omelette-tester', 'omelette-reviewer']);

/**
 * The aliases the `Agent` tool takes, as the ids they stand for: kept by hand
 * beside the catalogs and bumped with them. An alias of the definition's
 * family is its model, not an override.
 */
export const ALIASES = Object.freeze({ opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-2' });

/** What a `model:` or `effort:` value may be: an id, an alias, a level — never a template's `{{model}}` or a sentence. */
const VALUE = /^[\w.:@/[\]-]{1,128}$/;

/** `name` as the id the alias map gives it, else as written. */
const resolved = (name) => (Object.hasOwn(ALIASES, name) ? ALIASES[name] : name);

/**
 * Whether the `Agent` call's `value` names the model `id`: the same string,
 * or both the same id once an alias is read through ALIASES. An alias off the
 * map, or any other id, does not.
 * @param {unknown} value
 * @param {unknown} id
 * @returns {boolean}
 */
export function namesModel(value, id) {
  return typeof value === 'string' && typeof id === 'string' && resolved(value) === resolved(id);
}

/** The longest trimmed value a regex reads: VALUE's bound and a pair of quotes; anything longer is no value. */
const VALUE_MAX = 130;

/**
 * A frontmatter value as written: a trailing ` # comment` and one pair of
 * quotes off, then held to VALUE. Linear in the line, which a cloned
 * project's definition makes as long as it likes: the comment is found by a
 * two-character search and sliced off, and nothing past VALUE_MAX reaches
 * another regex.
 */
function valueOf(raw) {
  const hash = raw.search(/\s#/);
  const bare = (hash < 0 ? raw : raw.slice(0, hash)).trim();
  if (bare.length > VALUE_MAX) return undefined;
  const text = bare.replace(/^(["'])(.*)\1$/, '$2').trim();
  return VALUE.test(text) ? text : undefined;
}

/**
 * The `model:` and `effort:` of a definition's frontmatter: the lines between
 * a first line `---` and the next `---`, each key at the start of its line
 * (the last one written wins). No frontmatter, or one never closed: neither.
 * @param {string} text the definition file's text
 * @returns {{ model?: string, effort?: string }}
 */
export function frontmatterOf(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  /** @type {{ model?: string, effort?: string }} */
  const out = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') return out;
    const match = /^(model|effort):(.*)$/.exec(line);
    if (match) {
      const value = valueOf(match[2]);
      if (value === undefined) delete out[match[1]];
      else out[match[1]] = value;
    }
  }
  return {};
}

/** `dir` without its trailing slashes, so `${dir}/name` has one. */
const trimmed = (dir) => dir.replace(/\/+$/, '');

/**
 * Each guarded role's definition: `<cwd>/.claude/agents/<role>.md`, else
 * `<HOME>/.claude/agents/<role>.md` (the project's wins a name clash, as
 * Claude Code reads them); a role with neither file readable is left out.
 * Never rejects.
 * @param {any} $ the engine interface
 * @param {string | undefined} cwd the session's directory, absolute
 * @returns {Promise<Map<string, { model?: string, effort?: string }>>}
 */
export async function readRoleDefinitions($, cwd) {
  let home;
  try {
    home = await $.env.get('HOME');
  } catch {
    // No HOME to read: the project's definitions alone.
  }
  const dirs = [cwd, home].filter((dir) => typeof dir === 'string' && dir.startsWith('/')).map((dir) => `${trimmed(dir)}/.claude/agents`);
  const roles = new Map();
  for (const role of ROLES) {
    for (const dir of dirs) {
      let text;
      try {
        text = await $.fs.read(`${dir}/${role}.md`);
      } catch {
        continue;
      }
      roles.set(role, frontmatterOf(text));
      break;
    }
  }
  return roles;
}
