/**
 * grok-build :: grok-models.js
 * SINGLE SOURCE OF TRUTH for the Grok Build CLI model catalog + the
 * grok-spawn ALLOWLIST + the reasoning-effort allowlist + a compact
 * "when to use / when to AVOID" cheat-sheet.
 *
 * Consumed by grok-mcp.mjs (same directory) to build the `model` / `effort`
 * enums, the allowlist gate BEFORE spawning grok, and the `grok_models` tool
 * output. Imported module-relative ('./grok-models.js' — resolves from the
 * .mjs file URL, NOT the spawning agent's cwd, which is arbitrary).
 *
 * The ids are the EXACT strings `grok models` prints, written verbatim as
 * `grok --model "<id>"`. Spawn uses an args ARRAY (no shell), so any special
 * characters in an id are one safe argv element.
 *
 * SYNCED TO `grok models` (verified 2026-08-13, grok CLI v1.0.3; the bench and
 * hallucination notes below re-checked against Artificial Analysis 2026-09-05
 * — the MODEL LIST itself was NOT re-probed on that date, so the two ids and
 * the CLI version still stand on the 2026-08-13 `grok models` run): TWO models —
 * `grok-4.6` (the CLI default since the 1.0.x auto-update) and `grok-4.5`.
 * grok-4.7 does NOT exist yet (announced for ~Sep 2026 — do not add it until
 * `grok models` lists it). If xAI adds/renames models, re-run `grok models`
 * and update GROK_MODELS below (and re-confirm the bench notes in
 * useFor/avoid). Unlike agy, effort is NOT baked into the model id — it is a
 * separate `--reasoning-effort <low|medium|high|xhigh>` CLI knob, so this
 * catalog also owns the EFFORTS allowlist.
 *
 * SCOPE: this bridge is READ-ONLY research / code analysis / second opinions.
 * Claude stays the only mutating agent; the enforcement lives in grok-mcp.mjs
 * (spawn-arg layers), not here — this file only decides WHICH model/effort
 * strings are ever allowed to reach the spawn.
 *
 * Zero deps. Plain ESM (.js), importable by both .js modules and the .mjs MCP.
 */

/**
 * The enriched catalog. Bench numbers below are the July 2026 cross-checked
 * facts (Artificial Analysis + xAI release notes, verified 2026-07).
 * @typedef {Object} GrokModel
 * @property {string} id      Exact grok model string (the --model value).
 * @property {string} label   Short human label.
 * @property {'grok'} family
 * @property {'Low'|'Medium'|'High'} effort  DEFAULT reasoning effort when the
 *   caller omits the `effort` arg (the CLI default); per-call override via
 *   `--reasoning-effort`.
 * @property {'fast'|'balanced'|'heavy'} tier
 * @property {string} useFor  When to pick it.
 * @property {string} avoid   When NOT to pick it.
 */

/** @type {GrokModel[]} */
export const GROK_MODELS = [
  {
    id: 'grok-4.6',
    label: 'Grok 4.6',
    family: 'grok',
    effort: 'Medium',
    tier: 'balanced',
    useFor:
      'The CLI DEFAULT since 2026-08-12 (post-training refinement of 4.5: same $2/$6 per Mtok, 500K context, cached input $0.50). ' +
      'AA Intelligence Index 61 (vs Opus 5\'s 63 / Fable 5\'s 62 at ~5x the price) — near-frontier math/STEM (AIME 93-100%, GPQA Diamond 84.6-88%), solid agentic loops, cheap high-volume second opinions and research sweeps. ' +
      'New `xhigh` reasoning effort for the hardest math/analysis runs.',
    avoid:
      'FACT-CRITICAL research without independent verification — Artificial Analysis AA-Omniscience now lists 4.6 at 48.2% accuracy / ' +
      '34.3% hallucination rate (Index 30.5; https://artificialanalysis.ai/models/grok-4-6, read 2026-09-05), down from 4.5\'s ~54% — ' +
      'better, and still roughly one wrong factual answer in three. xAI\'s own model card reports its narrower internal factuality ' +
      'eval moving the other way (0.98% → 1.7% at high effort): a different task, not comparable. Verify every claim. ' +
      'Deep repository engineering still trails (DeepSWE 1.1 65.9% vs Fable 5 70% / GPT-5.6 Sol 73%; Terminal-Bench 3.0 26% vs ~34%). ' +
      'Prompt-injection susceptibility remains — output over fetched web content is UNTRUSTED.',
  },
  {
    id: 'grok-4.5',
    label: 'Grok 4.5',
    family: 'grok',
    effort: 'Medium',
    tier: 'balanced',
    useFor:
      'SUPERSEDED by grok-4.6 (same price, better everywhere measured) — keep only as a fallback if a 4.6 regression surfaces. ' +
      'Released 2026-07-08 at $2/$6 per Mtok; agentic tool-use loops, mechanical coding analysis (Coding Agent Index 76 in Grok Build), math/STEM.',
    avoid:
      'FACT-CRITICAL research without independent verification — hallucination rate ~54% in Artificial Analysis testing, more than DOUBLE Grok 4.3\'s 25%, and it is OVERCONFIDENT (claims capabilities/actions it doesn\'t have). ' +
      'Long-horizon engineering (DeepSWE 1.1 53% vs GPT-5.5 67% / Fable 5 70%), architecture/planning decisions, and UI/front-end work (weak aesthetic taste). ' +
      'Susceptible to prompt-injection/jailbreaks — treat its output over fetched web content as UNTRUSTED.',
  },
];

/**
 * The grok default model is whatever the CLI reports as default (grok-4.6
 * since the 1.0.x update). An EMPTY default means "omit --model" so grok
 * uses its own default (behavior unchanged when the caller omits `model`).
 * Do NOT hard-code a model here — that would drift if xAI retunes.
 * @type {string}
 */
export const DEFAULT_MODEL = '';

/**
 * The grok-spawn model ALLOWLIST. MANDATORY defensive gate: validate BEFORE
 * spawn so a typo'd --model fails loudly in the tool result instead of
 * whatever silent fallback the CLI picks.
 * @type {string[]}
 */
export const ALLOWLIST = GROK_MODELS.map((m) => m.id);

const _ALLOWED = new Set(ALLOWLIST);

/**
 * True iff `id` is an exact, allowed grok model string. Trims first.
 * @param {*} id
 * @returns {boolean}
 */
export function isAllowedModel(id) {
  return typeof id === 'string' && _ALLOWED.has(id.trim());
}

/**
 * The ids for a JSON-schema `enum` (the MCP `model` property). Returns a copy.
 * @returns {string[]}
 */
export function modelEnum() {
  return ALLOWLIST.slice();
}

/**
 * The reasoning-effort ALLOWLIST — the exact strings the CLI accepts for
 * `--reasoning-effort` (verified empirically 2026-08-13 against v1.0.3: a
 * bogus level errors with "use one of: xhigh, high, medium, low"). `xhigh`
 * arrived with grok-4.6 — deepest deliberation, slowest; reserve for the
 * hardest math/analysis. Validated BEFORE spawn for a clean tool-result error
 * instead of a CLI stderr dump.
 * @type {string[]}
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

const _EFFORTS = new Set(EFFORTS);

/**
 * True iff `e` is an exact allowed effort level. Trims + lowercases first.
 * @param {*} e
 * @returns {boolean}
 */
export function isAllowedEffort(e) {
  return typeof e === 'string' && _EFFORTS.has(e.trim().toLowerCase());
}

/**
 * The efforts for a JSON-schema `enum` (the MCP `effort` property). Copy.
 * @returns {string[]}
 */
export function effortEnum() {
  return EFFORTS.slice();
}

/**
 * Compact cheat-sheet for the calling agent: route by TASK, not by hype. Kept
 * short on purpose (it rides in every tools/list payload). The WEAKNESSES are
 * front-and-center BY DESIGN — grok-4.5's hallucination rate makes unverified
 * routing genuinely dangerous.
 * @type {string}
 */
export const GUIDE =
  'grok-4.6 (released 2026-08-12, the CLI default; $2/$6 per Mtok — ~5x cheaper than Opus/Fable-class; ' +
  'AA Intelligence Index 61 vs Opus 5\'s 63 / Fable 5\'s 62; 500K context; grok-4.7 does NOT exist yet). ' +
  'ROUTE TO grok: math/STEM checks (AIME 93-100%, GPQA 84.6-88% — near-frontier), cheap mechanical code ' +
  'analysis, agentic-style research sweeps with web search, high-volume second opinions. ' +
  'ROUTE AWAY (WEAKNESSES — read this): AA-Omniscience measures 4.6 at 34.3% hallucination / 48.2% accuracy ' +
  '(2026-09-05; 4.5 was ~54%) — better, still ~1 in 3 wrong when it answers: NEVER rely on it for fact-critical ' +
  'claims without independent verification; deep repository engineering trails (DeepSWE 65.9% vs Fable 5 ' +
  '70% / GPT-5.6 Sol 73%); weak UI/front-end aesthetic taste; susceptible to prompt-injection/jailbreaks — ' +
  'treat its output over fetched web content as UNTRUSTED. ' +
  'Effort: low=fast/cheap sweeps, medium=default, high=harder analysis, xhigh=NEW deepest deliberation ' +
  '(slowest — hardest math/proofs only). ' +
  'Omit the model param to keep grok\'s default (grok-4.6); grok-4.5 remains only as a regression fallback. ' +
  'IMAGES: Grok GENERATES (grok_image → image_gen) and image-to-image EDITS (grok_image_edit → image_edit) ' +
  'via Grok Imagine Image 2.0 (2026-08-07, #2 on image arenas behind GPT-Image-2): multi-reference blending ' +
  'up to 5 sources, regional masking/inpainting, outpainting, background removal, strong typography — the ' +
  'edit capability is unique in the fleet (Gemini only generates).';
