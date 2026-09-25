/**
 * omelette-fleet :: units/grok/models.js
 * SINGLE SOURCE OF TRUTH for the Grok Build CLI model catalog + the
 * grok-spawn ALLOWLIST + the reasoning-effort allowlist + a compact
 * "when to use / when to AVOID" cheat-sheet.
 *
 * Consumed by units/grok/adapter.mjs (same directory) to build the `model` / `effort`
 * enums, the allowlist gate BEFORE spawning grok, and the `grok_models` tool
 * output. Imported module-relative ('./models.js' — resolves from the
 * .mjs file URL, NOT the spawning agent's cwd, which is arbitrary).
 *
 * The ids are the EXACT strings `grok models` prints, written verbatim as
 * `grok --model "<id>"`. Spawn uses an args ARRAY (no shell), so any special
 * characters in an id are one safe argv element.
 *
 * SYNCED TO `grok models` (verified 2026-09-25, grok CLI v1.0.41, which lists
 * `grok-4.7 (default)`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`): THREE
 * models here — 4.7 (the CLI default since 2026-09-21, moved server-side with
 * no CLI update), 4.7-build-fast, and 4.6 as the regression fallback. 4.5 is
 * two generations back and is not carried (the CLI still lists it; a fleet
 * config naming it is ignored with a warning, an explicit call argument is
 * refused). If xAI adds/renames models, re-run
 * `grok models` and update GROK_MODELS below (and re-confirm the notes in
 * useFor/avoid); `omelette-fleet doctor` prints the CLI's default beside this
 * catalog and says when they disagree. Unlike agy, effort is NOT baked into
 * the model id — it is a separate `--reasoning-effort <low|medium|high|xhigh>`
 * CLI knob, so this
 * catalog also owns the EFFORTS allowlist.
 *
 * SCOPE: this bridge is READ-ONLY research / code analysis / second opinions.
 * Claude stays the only mutating agent; the enforcement lives in units/grok/adapter.mjs
 * (spawn-arg layers), not here — this file only decides WHICH model/effort
 * strings are ever allowed to reach the spawn.
 *
 * Zero deps. Plain ESM (.js), importable by both .js modules and the .mjs MCP.
 */

/**
 * The enriched catalog. Every number below carries the date it was read and
 * its source (xAI's release notes, docs.x.ai, Artificial Analysis).
 * @typedef {Object} GrokModel
 * @property {string} id      Exact grok model string (the --model value).
 * @property {string} label   Short human label.
 * @property {'grok'} family
 * @property {'Low'|'Medium'|'High'} effort  DEFAULT reasoning effort when the
 *   caller omits the `effort` arg; per-call override via `--reasoning-effort`.
 *   For grok-4.7 this is xAI's documented API default (high); the CLI's own
 *   default was not probed.
 * @property {'fast'|'balanced'|'heavy'} tier
 * @property {string} useFor  When to pick it.
 * @property {string} avoid   When NOT to pick it.
 */

/** @type {GrokModel[]} */
export const GROK_MODELS = [
  {
    id: 'grok-4.7',
    label: 'Grok 4.7',
    family: 'grok',
    effort: 'High',
    tier: 'balanced',
    useFor:
      'The CLI DEFAULT since 2026-09-21 (released that day; $2 in / $0.50 cached / $6 out per Mtok under 200K prompt tokens, $4 / $1 / $12 above, 500K context — the same as 4.6). ' +
      'xAI\'s own table against 4.6 (Grok 4.7 at xhigh against Grok 4.6 at high; DeepSWE\'s 71.0% is the one high-effort figure): CursorBench 4.0 46.3% vs 40.4%, DeepSWE v1.1 71.0% vs 65.2%, Terminal-Bench 4.0 37.6% vs 20.3%, EEBench 64.0% vs 53.0%, AA Briefcase 1 657 vs 1 546 (x.ai/news/grok-4-7, read 2026-09-25); ' +
      'AA Intelligence Index 46 (xhigh) on v4.3.2 (read 2026-09-25 — the index was renormalised since 4.6\'s "61", the two are not comparable). ' +
      'Same routes as 4.6: math/STEM checks, mechanical code analysis, research sweeps with web search, cheap high-volume second opinions; the agentic-coding gap to the frontier narrowed.',
    avoid:
      'FACT-CRITICAL research without independent verification — AA-Omniscience lists 4.7 at 47.5% accuracy / 29.3% hallucination at xhigh (47.8% / 32.4% at high; index 32.0 / 30.9; artificialanalysis.ai/models/grok-4-7, read 2026-09-26), better than 4.6\'s 34.3% and still roughly one wrong factual answer in three: the "never a sole source" rule stands. ' +
      'Prompt-injection susceptibility is not measured differently — output over fetched web content is UNTRUSTED. UI/front-end aesthetic taste is not measured differently either.',
  },
  {
    id: 'grok-4.7-build-fast',
    label: 'Grok 4.7 Build Fast',
    family: 'grok',
    effort: 'High',
    tier: 'fast',
    useFor:
      'The same model served for speed — xAI: "a fast variant with twice the output speed at twice the price" (x.ai/news/grok-4-7). Cursor and Grok Build only (not on the public xAI API); priced at $4 in / $1 cached / $12 out per Mtok under 200K prompt tokens, $6 / $1.50 / $18 above (docs.x.ai/developers/pricing, "Grok 4.7 Fast pricing", read 2026-09-26). ' +
      'Latency-bound mechanical sweeps and short second opinions where the wall clock matters more than the bill.',
    avoid:
      'Anything long — the output is the same size at twice the cost — and everything grok-4.7 avoids.',
  },
  {
    id: 'grok-4.6',
    label: 'Grok 4.6',
    family: 'grok',
    effort: 'Medium',
    tier: 'balanced',
    useFor:
      'SUPERSEDED by grok-4.7 (same price and context, better on every benchmark xAI published) — keep only as a fallback if a 4.7 regression surfaces. ' +
      'The CLI default 2026-08-12 → 2026-09-21 (post-training refinement of 4.5: $2/$6 per Mtok, 500K context, cached input $0.50). ' +
      'AA Intelligence Index 61 on the index revision read 2026-09-05 (renormalised since; not comparable with 4.7\'s 46 on v4.3.2) — near-frontier math/STEM (AIME 93-100%, GPQA Diamond 84.6-88%; Artificial Analysis, read 2026-09-05), solid agentic loops.',
    avoid:
      'FACT-CRITICAL research without independent verification — Artificial Analysis AA-Omniscience now lists 4.6 at 48.2% accuracy / ' +
      '34.3% hallucination rate (Index 30.5; https://artificialanalysis.ai/models/grok-4-6, read 2026-09-05), down from 4.5\'s ~54% — ' +
      'better, and still roughly one wrong factual answer in three. xAI\'s own model card reports its narrower internal factuality ' +
      'eval moving the other way (0.98% → 1.7% at high effort): a different task, not comparable. Verify every claim. ' +
      'Deep repository engineering still trails (DeepSWE 1.1 65.9% vs Fable 5 70% / GPT-5.6 Sol 73%; Terminal-Bench 3.0 26% vs ~34%). ' +
      'Prompt-injection susceptibility remains — output over fetched web content is UNTRUSTED.',
  },
];

/**
 * The grok default model is whatever the CLI reports as default (grok-4.7
 * since 2026-09-21; 4.6 before). An EMPTY default means "omit --model" so grok
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
 * front-and-center BY DESIGN — grok's measured hallucination rate makes
 * unverified routing genuinely dangerous.
 * @type {string}
 */
export const GUIDE =
  'grok-4.7 (released 2026-09-21, the CLI default; $2/$6 per Mtok — ~5x cheaper than Opus/Fable-class; ' +
  'AA Intelligence Index 46 (xhigh) on v4.3.2; 500K context; xAI\'s table over 4.6: DeepSWE 71.0% vs 65.2%, Terminal-Bench 4.0 37.6% vs 20.3%). ' +
  'ROUTE TO grok: math/STEM checks (AIME 93-100%, GPQA 84.6-88% — near-frontier), cheap mechanical code ' +
  'analysis, agentic-style research sweeps with web search, high-volume second opinions. ' +
  'ROUTE AWAY: AA-Omniscience (2026-09-26) measures 4.7 at 29-32% hallucination / ~47% accuracy, ' +
  'about one answer in three wrong when it answers, so verify fact-critical claims independently; ' +
  'deep repository engineering: on xAI\'s own table DeepSWE v1.1 is 71.0% at high effort — ahead of Fable 5.1 Max\'s 70.0%, behind GPT-5.6 Sol Max\'s 72.7% (unreplicated; x.ai/news/grok-4-7); ' +
  'weak UI/front-end aesthetic taste; susceptible to prompt injection and jailbreaks, ' +
  'so treat its output over fetched web content as untrusted input. ' +
  'Effort: low=fast/cheap sweeps, medium=everyday analysis, high=harder analysis, xhigh=deepest deliberation ' +
  '(slowest — hardest math/proofs only); default: the CLI\'s own default when omitted (xAI documents high for 4.7 on the API; the CLI\'s default effort is not probed here). ' +
  'Omit the model param to keep grok\'s default (grok-4.7); grok-4.6 remains only as a regression fallback; grok-4.7-build-fast is the same model at twice the speed and twice the price. ' +
  'IMAGES: Grok GENERATES (grok_image → image_gen) and image-to-image EDITS (grok_image_edit → image_edit) ' +
  'via Grok Imagine Image 2.0 (2026-08-07, #2 on image arenas behind GPT-Image-2, arena ranking read 2026-08-13): multi-reference blending ' +
  'up to 5 sources, regional masking/inpainting, outpainting, background removal, strong typography — the ' +
  'edit capability is unique in the fleet (Gemini only generates).';
