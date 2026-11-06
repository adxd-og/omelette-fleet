/**
 * omelette-fleet :: units/mistral/models.js
 * The Mistral (Vibe) model catalog, its effort allowlist and the cheat-sheet —
 * the single source the unit renders into both Vibe homes (units/mistral/home.mjs).
 *
 * Ids are Vibe ALIASES (ours) over vendor model names (`vendorName`, theirs).
 * Effort is Vibe's per-model `thinking`, so it is baked into the alias, as agy
 * bakes it into the id: one entry per (model, thinking level), grouped by
 * `family`, and `resolveAlias` (home.mjs) moves a call's `effort` within one.
 *
 * READ 2026-11-06 (Vibe 3.1.0, `export.json` → `config.models`, operator on
 * the plan, Keychain login): vendor names, display names, thinking levels and
 * the prices below are Vibe's own catalog entries — `priceIn` / `priceOut` are
 * what Vibe prices a run at ($/M tokens), 0 for the two rows the plan covers.
 * That catalog is server-pushed into a feature-flag cache, not a documented
 * file: a fresh `VIBE_HOME` does not have it, and Vibe then ran
 * `mistral-medium-3.5` in place of the requested Large 4 with one notice line
 * (probe 5). The homes therefore carry this list (probe 6), and Vibe's
 * ModelConfig defaults `input_price` / `output_price` to 0.0, so the rendered
 * entries carry the prices too — without them `--max-price` never trips on a
 * paid row. `cached_input_price` is not rendered: Vibe then bills cached
 * tokens at `input_price`, an overestimate on the paid rows that stops a run
 * at `--max-price` sooner, never later — the safe side. The same defaults
 * would run every entry at temperature 0.2 with no compaction threshold, so
 * each carries the server catalog's `temperature` (1.0) and, for Large 4 and
 * the two GLMs, its `auto_compact_threshold` (800000) — the configuration the
 * replay ran under (`mistral-medium-3.5` collides with Vibe's built-in
 * default, whose values win there).
 *
 * `onPlan`: true when the plan covers the row ($0 in Vibe's catalog), null when
 * unknown — the two paid rows reported `cost_usd` > 0 and the console's Usage
 * page was not read.
 *
 * Zero deps. Plain ESM (.js).
 */

/**
 * @typedef {Object} MistralModel
 * @property {string} id          Vibe alias, the `--model` value
 * @property {string} label       rendered as `display_name`
 * @property {'large'|'glm-flash'|'glm'|'medium'} family
 * @property {'low'|'medium'|'high'|'max'|'off'} effort
 * @property {string} vendorName  rendered as `name`
 * @property {'low'|'medium'|'high'|'max'|'off'} thinking  rendered as `thinking` (omitted for off)
 * @property {number} priceIn     $/M input tokens in Vibe's catalog
 * @property {number} priceOut    $/M output tokens in Vibe's catalog
 * @property {true|false|null} onPlan
 * @property {number} temperature  rendered as `temperature`
 * @property {number} [autoCompactThreshold]  rendered as `auto_compact_threshold` when set
 * @property {string} tier        'balanced' | 'cheap' | 'named'
 * @property {string} useFor
 * @property {string} avoid
 */

const LARGE = {
  family: 'large', vendorName: 'mistral-large-4-0', priceIn: 0, priceOut: 0, onPlan: true, tier: 'balanced',
  temperature: 1.0, autoCompactThreshold: 800000,
};
const LARGE_PRICE = '$0 / $0 per 1M tokens on the plan (Vibe catalog, read 2026-11-06; list $0.70 in / $2.10 out).';
const LARGE_UNMEASURED =
  'Not measured on our task — the replay numbers are thinking high. Never a source of record: the session rules every finding.';

const FLASH = {
  family: 'glm-flash', vendorName: 'zai-glm-5-3-flash', priceIn: 0, priceOut: 0, onPlan: true, tier: 'cheap',
  temperature: 1.0, autoCompactThreshold: 800000,
};
const FLASH_PRICE = '$0 / $0 per 1M tokens on the plan (Vibe catalog, read 2026-11-06).';
const FLASH_AVOID =
  'Pointers drift, verify: 2 of its 4 pointers on the replay were off. Never a sole source for a security finding.';

const GLM = {
  family: 'glm', vendorName: 'zai-glm-5-3', priceIn: 1.4, priceOut: 4.4, onPlan: null, tier: 'named',
  temperature: 1.0, autoCompactThreshold: 800000,
};
const GLM_PRICE =
  '$1.40 in / $4.40 out per 1M tokens (Vibe catalog, read 2026-11-06); `maxPrice` applies — Vibe stops the run at `--max-price`.';

const MEDIUM = {
  family: 'medium', vendorName: 'mistral-vibe-cli-latest', priceIn: 1.5, priceOut: 7.5, onPlan: null, tier: 'named',
  temperature: 1.0,
};
const MEDIUM_PRICE =
  '$1.50 in / $7.50 out per 1M tokens (Vibe catalog, read 2026-11-06); `maxPrice` applies — Vibe stops the run at `--max-price`.';

const NEVER_DEFAULT =
  'Never a default route: it is paid per token, and whether the plan covers it is unknown until the operator reads the console\'s Usage page.';

/** @type {MistralModel[]} */
export const MISTRAL_MODELS = [
  {
    id: 'mistral-large-4-0-3',
    label: 'Mistral Large 4',
    ...LARGE,
    effort: 'high',
    thinking: 'high',
    useFor:
      'THE UNIT DEFAULT, thinking high: security review (`mistral_security_review`) and repro (`mistral_security_repro`). ' + LARGE_PRICE + ' ' +
      'Measured on our task (the 2026-10-20 audit replayed on the 1.7.1 snapshot, read-only tools, one run): 9 findings, 3 of the 6 keys, ' +
      '0 wrong claims, 0 drifted pointers, 12.6 min, 4.65 M tokens at $0 on the plan; with a sandboxed shell (probe 7) it confirmed key #6 by ' +
      'running it, which no read-only arm found.',
    avoid:
      'Taking a finding as ruled: on the replay 3 of its 9 findings were documented behaviour. Never a source of record — the session rules every finding.',
  },
  {
    id: 'mistral-large-4-0-3-medium',
    label: 'Mistral Large 4 (thinking medium)',
    ...LARGE,
    effort: 'medium',
    thinking: 'medium',
    useFor: 'Large 4 at thinking medium: a faster pass of the same review. ' + LARGE_PRICE,
    avoid: LARGE_UNMEASURED,
  },
  {
    id: 'mistral-large-4-0-3-low',
    label: 'Mistral Large 4 (thinking low)',
    ...LARGE,
    effort: 'low',
    thinking: 'low',
    useFor: 'Large 4 at thinking low: a quick sweep of one area. ' + LARGE_PRICE,
    avoid: LARGE_UNMEASURED,
  },
  {
    id: 'zai-glm-5-3-flash',
    label: 'GLM-5.3 Flash',
    ...FLASH,
    effort: 'high',
    thinking: 'high',
    useFor:
      'The cheap sweep and second opinion, thinking high. ' + FLASH_PRICE + ' Measured on our task (same replay): 4 findings, 2 of the 6 keys, ' +
      '0 wrong claims, 18.6 min.',
    avoid: FLASH_AVOID,
  },
  {
    id: 'zai-glm-5-3-flash-low',
    label: 'GLM-5.3 Flash (thinking low)',
    ...FLASH,
    effort: 'low',
    thinking: 'low',
    useFor: 'GLM-5.3 Flash at thinking low: the cheapest sweep. ' + FLASH_PRICE,
    avoid: FLASH_AVOID,
  },
  {
    id: 'zai-glm-5-3-flash-max',
    label: 'GLM-5.3 Flash (thinking max)',
    ...FLASH,
    effort: 'max',
    thinking: 'max',
    useFor: 'GLM-5.3 Flash at thinking max: a deeper free second opinion. ' + FLASH_PRICE,
    avoid: FLASH_AVOID,
  },
  {
    id: 'glm-5-3',
    label: 'GLM-5.3',
    ...GLM,
    effort: 'high',
    thinking: 'high',
    useFor:
      'Named route only: a paid second opinion, thinking high. ' + GLM_PRICE + ' Measured on our task (same replay): 6 findings, 3 of the 6 keys, ' +
      '0 wrong claims, 16.7 min, Vibe est. $2.84 (the console was not read).',
    avoid: NEVER_DEFAULT,
  },
  {
    id: 'glm-5-3-low',
    label: 'GLM-5.3 (thinking low)',
    ...GLM,
    effort: 'low',
    thinking: 'low',
    useFor: 'Named route only: GLM-5.3 at thinking low. ' + GLM_PRICE,
    avoid: NEVER_DEFAULT,
  },
  {
    id: 'glm-5-3-max',
    label: 'GLM-5.3 (thinking max)',
    ...GLM,
    effort: 'max',
    thinking: 'max',
    useFor: 'Named route only: GLM-5.3 at thinking max. ' + GLM_PRICE,
    avoid: NEVER_DEFAULT,
  },
  {
    id: 'mistral-medium-3.5',
    label: 'Mistral Medium 3.5',
    ...MEDIUM,
    effort: 'high',
    thinking: 'high',
    useFor:
      'Named route only, thinking high. ' + MEDIUM_PRICE + ' Vibe\'s own default and its SILENT FALLBACK TARGET: a home without the plan\'s ' +
      'catalog ran it in place of the requested Large 4 (probe 5).',
    avoid:
      NEVER_DEFAULT + ' An answer that reports this model when another was requested is the fallback, not an answer.',
  },
  {
    id: 'mistral-medium-3.5-off',
    label: 'Mistral Medium 3.5 (thinking off)',
    ...MEDIUM,
    effort: 'off',
    thinking: 'off',
    useFor: 'Named route only: Mistral Medium 3.5 without thinking. ' + MEDIUM_PRICE,
    avoid: NEVER_DEFAULT,
  },
];

/**
 * The `effort` arg's allowlist: the thinking levels a call may ask for. `off`
 * is not one — it exists only as the named `mistral-medium-3.5-off` alias.
 */
export const EFFORTS = ['low', 'medium', 'high', 'max'];

export const GUIDE =
  'Pick by task, not by name. mistral-large-4-0-3 (thinking high) = THE UNIT DEFAULT for security review and repro. ' +
  'Measured on our task (the 2026-10-20 audit replayed on the 1.7.1 snapshot, read-only tools, one run): 9 findings, 3 of 6 keys, ' +
  '0 wrong claims, 0 drifted pointers, 12.6 min, $0 on the plan. zai-glm-5-3-flash = a free sweep and second opinion whose pointers ' +
  'drift — verify them. glm-5-3 and mistral-medium-3.5 are named routes only, paid per token, `maxPrice` applies; mistral-medium-3.5 ' +
  'is Vibe\'s silent fallback target. Billing: the plan covers the two $0 rows (Large 4 and GLM-5.3 Flash); the console\'s Usage page, ' +
  'not `cost_usd` (Vibe\'s estimate from catalog prices), is the bill; whether the plan also covers the two paid rows is unknown until ' +
  'the operator reads the console. Effort is baked into the alias: `effort` moves within the model\'s family to the levels it offers ' +
  '(Large 4 low | medium | high; the GLMs low | high | max); a level the family lacks keeps the alias. Omit `model` to keep the unit default.';
