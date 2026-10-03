/**
 * omelette-fleet :: units/gemini/models.js — the Gemini catalog: model ids and
 * labels, the agy-spawn allowlist and the routing guide the unit appends to its
 * tool descriptions. Edited here; nothing syncs it.
 *
 * The ids are the display-name form agy lists under "Available models" when it
 * rejects an unknown --model, written verbatim as `agy --model "<id>"`. Spawn
 * uses an args ARRAY (no shell), so spaces/parens in an id are one safe argv
 * element. Note `agy models` prints both forms, slug then display name
 * (gemini-3.8-flash-high, Gemini 3.8 Flash (High)); --model accepts both, and the display names are kept here because they carry
 * the effort level readably.
 *
 * SYNCED TO agy (verified 2026-10-03, agy 1.2.14). If agy adds/renames/removes
 * a model, re-check and update GEMINI_MODELS below (and re-confirm the bench
 * notes in useFor/avoid). The (Low/Medium/High) suffix is the model's
 * reasoning/thinking-effort level (Low=fast/cheap, High=more deliberation).
 *
 * GENERATION SWEEP 2026-09-03: 3.8 Flash (GA, released 2026-09-02) replaced the
 * 3.7 Flash entries outright — operator decision, standing policy (the current
 * Flash generation is the default, the previous one leaves the catalog).
 * This sweep is NOT the same shape as the last one. 3.7 was a strict upgrade
 * over 3.6 — cheaper AND fewer output tokens. 3.8 is built ON 3.7 rather than a
 * new base model, costs exactly the same per token, and deliberately spends MORE
 * thinking tokens; Google's own launch guidance is that efficiency-first callers
 * "utilize lower effort levels to minimize token overhead or continue to rely on
 * Gemini 3.7 Flash". We keep the clean sweep because the first half of that
 * sentence is available to us — 3.8 Low/Medium ARE the efficiency exit — but the
 * cost is recorded in the High entry's `avoid` instead of being dropped.
 * Restoring a retired generation means re-adding its entry here by hand.
 *
 * COMPARABILITY (checked this sweep): the 3.7 figures in the comparison source
 * matched the ones already in this file verbatim (DeepSWE v1.1 65.3, HLE-Verified
 * 53.6, Terminal-Bench 2.1 85.8), so the 3.8 deltas below are same-harness. A
 * secondary blog quoted Terminal-Bench 90.8 vs 81.6 for the same pair — those do
 * NOT reconcile with our verified 3.7 number and are deliberately not used here.
 *
 * NOT PUBLISHED for 3.8 Flash as of this sweep: GPQA Diamond, ARC-AGI-2,
 * FrontierCode 1.1, MRCR v2 128K, WebDev Arena Elo. Claims about those axes
 * below are carried over from 3.7 and labelled as such — do not silently
 * upgrade them to 3.8 on the next sweep without a source.
 *
 * Gemini 3.8 Flash Cyber exists but is NOT available to us: it ships through the
 * Fairwind Program to government and critical-infrastructure defenders only, and
 * agy does not list it.
 *
 * SCOPE: Gemini family + GPT-OSS + Claude Opus 5.5 and Sonnet 5.5 via Antigravity.
 * The Claude family runs on Antigravity's OWN quota bucket, separate from the shared
 * Gemini pool (confirmed 2026-08-02 by two independent deep-research runs and operator
 * decision) — and that bucket is SMALL (operator, 2026-10-03), where the Gemini pool is
 * effectively unlimited for this fleet. So Claude-via-agy is a deliberate, named,
 * one-call route: never the default, never a sweep, never a deep-research stage (the
 * adapter refuses it). Sonnet joined on 2026-10-03, reversing the 2026-08-02 exclusion:
 * a Sonnet 5.5 call on the Antigravity bucket costs the Claude Code pool nothing, and
 * that pool is the expensive one. Neither is a fleet role — the coder, tester and
 * reviewer stay native (guard, diff, transcript).
 *
 * Zero deps. Plain ESM (.js), importable by both .js modules and the .mjs MCP.
 */

/**
 * The enriched catalog. Each entry adds bench-informed cheat-sheet fields on top
 * of the id/label/family the picker already used.
 * @typedef {Object} GeminiModel
 * @property {string} id      Exact agy model string (the --model value).
 * @property {string} label   Short human label for the picker.
 * @property {'gemini'|'gpt'|'claude'} family
 * @property {'Low'|'Medium'|'High'} effort  Reasoning/thinking-effort level.
 * @property {'fast'|'balanced'|'heavy'} tier
 * @property {string} useFor  When to pick it.
 * @property {string} avoid   When NOT to pick it.
 */

/** @type {GeminiModel[]} */
export const GEMINI_MODELS = [
  {
    id: 'Gemini 3.8 Flash (Low)',
    label: 'Gemini 3.8 Flash · Low',
    family: 'gemini',
    effort: 'Low',
    tier: 'fast',
    useFor:
      'Quick lookups, fact-checking, short summaries, single-doc skims, and fast routing — the cheapest/fastest pick in the fleet. Pricing is UNCHANGED from 3.7: $0.75/$3.75 per Mtok in/out through 2026-12-31, then $1.50/$7.50. This is also the FIRST of the two efficiency exits Google names for 3.8: since 3.8 spends more thinking tokens than 3.7 at equal effort, dropping the effort level is how you buy that back.',
    avoid:
      'Multi-step reasoning, expert analysis, and dense long-context retrieval — Low effort under-thinks hard problems; step up to Medium/High or Pro.',
  },
  {
    id: 'Gemini 3.8 Flash (Medium)',
    label: 'Gemini 3.8 Flash · Medium',
    family: 'gemini',
    effort: 'Medium',
    tier: 'balanced',
    useFor:
      'Explicit pick when High-effort latency or token overhead is unwanted — synthesis, structured summaries, light analysis, and multi-file/agentic tool work where speed outranks depth. The fleet default is High (operator policy), so Medium is a deliberate exit, not a fallback — and on 3.8 it is the one that matters most, because this generation trades tokens for depth at every effort level.',
    avoid:
      'Hardest novel reasoning and 1M+ context work — 3.1 Pro leads there (GPQA Diamond 94.3; 2M context window vs 3.8\'s 1M). Don\'t use it for long-horizon engineering where High\'s first-pass accuracy pays for itself in fewer retries.',
  },
  {
    id: 'Gemini 3.8 Flash (High)',
    label: 'Gemini 3.8 Flash · High',
    family: 'gemini',
    effort: 'High',
    tier: 'balanced',
    useFor:
      'The FLEET DEFAULT for all delegated research/agentic work (GA 2026-09-02). Same-harness gains over 3.7 Flash: DeepSWE v1.1 73.8 vs 65.3; Terminal-Bench 2.1 89.4 vs 85.8; OSWorld 2.0 (agentic) 59.0 vs 47.9; BioMysteryBench human-difficult 56.5 vs 43.5; LAB-Bench2 86.2 vs 82.1; CharXiv w/o tools 86.2 vs 84.5; LVBench 87.1 vs 85.4; HLE-Verified 54.9 vs 53.6. The reason that matters most for THIS fleet is not in that table: Gray Swan prompt-injection robustness took a significant leap over 3.7 (vendor blog), and every unit here ingests untrusted web content by design. Price per token is unchanged from 3.7.',
    avoid:
      'Routine work on a shared subscription quota. 3.8 is built ON 3.7 and deliberately spends MORE thinking tokens for its depth; Google\'s own guidance is that efficiency-first callers "utilize lower effort levels to minimize token overhead or continue to rely on Gemini 3.7 Flash" — the first half is our exit, so drop to Low/Medium rather than paying High for lookups. Frontier scientific/formal reasoning and 1M+ context still go to 3.1 Pro: GPQA Diamond 94.3 and ARC-AGI-2 77.1 are unpublished for 3.8 (3.7 scored 90.4 on GPQA), and Pro\'s 2M window still beats 3.8\'s 1M in / 64K out. FrontierCode 1.1, AutomationBench, MRCR v2 128K and WebDev Arena Elo are ALSO unpublished for 3.8 — the fleet\'s UI-prompt and 128K-retrieval routing rests on 3.7-generation evidence, so treat those two calls as inherited, not re-verified.',
  },
  {
    id: 'Gemini 3.1 Pro (Low)',
    label: 'Gemini 3.1 Pro · Low',
    family: 'gemini',
    effort: 'Low',
    tier: 'heavy',
    useFor:
      'The Pro-grade 2M window at balanced cost — the one capability no Flash generation has (3.8 Flash caps at 1M in / 64K out). ' +
      'Same two niches as Pro (High): inputs past 1M tokens, and formal / scientific reasoning where 3.8 Flash has no published ' +
      'numbers. NOT for code or agentic work.',
    avoid:
      'Code and agentic work (3.8 Flash leads 68.1 vs 46.2 coding and 67.6 vs 40.1 agentic at roughly a third of the price), ' +
      'quick/cheap lookups and routine loops (Flash is faster and cheaper), and the very hardest formal reasoning (use Pro High). ' +
      'Note 128K retrieval is not a reason to reach for Pro — the Flash line led MRCR v2 128K 97.0 vs 84.9.',
  },
  {
    id: 'Gemini 3.1 Pro (High)',
    label: 'Gemini 3.1 Pro · High',
    family: 'gemini',
    effort: 'High',
    tier: 'heavy',
    useFor:
      'Two niches only: inputs past 1M tokens (the 2M context window), and formal / scientific reasoning where 3.8 Flash has ' +
      'no published numbers (GPQA Diamond 94.3, ARC-AGI-2 77.1 — both unpublished for 3.8). Also the fleet\'s TIE-BREAKER when ' +
      'Grok and Flash disagree. Cards dated February 2026 — seven months older than Flash.',
    avoid:
      'Code and agentic work — 3.8 Flash beats 3.1 Pro on public coding (68.1 vs 46.2) and agentic (67.6 vs 40.1) lanes with ' +
      'non-overlapping intervals at roughly a third of the price, so Pro is NOT the heavy-reasoning upgrade any more. ' +
      'Latency-sensitive or routine work, lookups, summaries, and plain 128K retrieval (the Flash line led MRCR v2 128K 97.0 vs 84.9).',
  },
  {
    id: 'Claude Opus 5.5 (High)',
    label: 'Claude Opus 5.5 · High',
    family: 'claude',
    effort: 'High',
    tier: 'heavy',
    useFor:
      'An independent Opus-class second opinion or a hard verification pass on Antigravity\'s SEPARATE Claude quota — the same generation as the fleet\'s own coder and reviewer, so it adds an independent read, not a stronger one. One named call per question, when the Claude Code pool is the constraint or the question deserves two Opus reads. Opus 5.5 (Medium) and Sonnet 5.5 (High) ran headless via agy 1.2.14 on 2026-10-03; the other two ids are listed by agy models and share the id form, and did not run — the bucket answered RESOURCE_EXHAUSTED to both that afternoon, after three calls, which is the point.',
    avoid:
      'Anything routine, any sweep, any loop, and every deep-research stage (gemini_deep_research refuses Claude ids) and never as the configured default (gemini_research and gemini_image refuse it): the Antigravity Claude bucket is small and shared by all four Claude entries, where the Gemini pool is effectively unlimited for this fleet. Not a fleet role: the guard, the diff and the transcript live in Claude Code. Citation-heavy research goes to Gemini (web grounding via agy is unverified for the Claude family).',
  },
  {
    id: 'Claude Opus 5.5 (Medium)',
    label: 'Claude Opus 5.5 · Medium',
    family: 'claude',
    effort: 'Medium',
    tier: 'heavy',
    useFor:
      'Antigravity\'s picker default for Claude (2026-10-03): an Opus-class second opinion where High\'s latency is not worth it — a plan section, a design question, an arbitration read. Same quota rule as High: one named call, never a sweep.',
    avoid:
      'As Opus 5.5 (High). Step up to High for a verification pass that has to be thorough; step down to Sonnet 5.5 for a cheap read.',
  },
  {
    id: 'Claude Sonnet 5.5 (High)',
    label: 'Claude Sonnet 5.5 · High',
    family: 'claude',
    effort: 'High',
    tier: 'heavy',
    useFor:
      'A cheap second opinion or a volume read on the Antigravity Claude quota instead of the native Claude Code pool — reviewing a document, checking a set of claims, a second read of a tester report. Listed since 2026-10-03: the two pools are separate and the native one is the expensive one.',
    avoid:
      'Sweeps and loops all the same — the bucket is small and shared with Opus. Not a tester or a coder: those roles need the guard and the diff. Flash stays the default for research, Flash Low for anything cheap.',
  },
  {
    id: 'Claude Sonnet 5.5 (Medium)',
    label: 'Claude Sonnet 5.5 · Medium',
    family: 'claude',
    effort: 'Medium',
    tier: 'heavy',
    useFor:
      'The lightest Claude read on the Antigravity bucket: a summary, a sanity check, a short classification — when Flash\'s answer wants a Claude cross-check and the native pool should stay untouched.',
    avoid:
      'As Sonnet 5.5 (High); prefer Flash Low or Medium for anything that does not need a Claude voice.',
  },
  {
    id: 'GPT-OSS 120B (Medium)',
    label: 'GPT-OSS 120B · Medium',
    family: 'gpt',
    effort: 'Medium',
    tier: 'balanced',
    useFor:
      'Non-Google open-weights SECOND OPINION — cross-check a Gemini answer with a different model family, math-heavy reasoning (strong on AIME/competition math), and de-biasing when you suspect single-vendor blind spots. Apache-2.0 MoE (~5.1B active params); near-parity with o4-mini on core reasoning (MMLU ~90%).',
    avoid:
      'Primary frontier work and long-context tasks — it trails the frontier Gemini models on overall reasoning/agentic depth and has no long-context retrieval advantage. Use as a corroborating voice, not the lead researcher.',
  },
];

/**
 * Empty since 2026-10-03: Sonnet 5.5 is in GEMINI_MODELS (the 2026-08-02 exclusion is lifted — see the header). Kept as an export so an importer does not break.
 * @type {{id:string,label:string,family:'claude',reason:string}[]}
 */
export const EXCLUDED_CLAUDE_MODELS = [];

/**
 * The agy default model is whatever is configured in agy's own settings.json. An
 * EMPTY default means "omit --model" so agy uses its own default (behavior
 * unchanged when the caller omits `model`). Do NOT hard-code a model here — that
 * would drift if agy retunes.
 * @type {string}
 */
export const DEFAULT_MODEL = '';

/**
 * The agy-spawn ALLOWLIST: exactly the ids in GEMINI_MODELS (Gemini + GPT-OSS +
 * Claude Opus 5.5 and Sonnet 5.5 at High and Medium). The route
 * validates against this BEFORE spawn, for two reasons — note
 * that "agy would silently fall back to its default" is NOT one of them any
 * more: as of 2026-07-29 an unknown --model makes agy exit 1 with an error on
 * stderr and an empty stdout, which callers surface loudly. What the allowlist
 * still buys:
 *   1. POLICY — it keeps every Claude id agy lists but the catalog does not admit
 *      (the Low tiers today, a next model tomorrow) out of the agy path until the
 *      catalog says so. agy itself would happily run them.
 *   2. A local rejection with the valid ids instead of paying a process spawn
 *      to be told the same thing.
 * If a future agy release goes back to silent fallback, this gate is also the
 * thing that keeps a typo from quietly running on the wrong model.
 * @type {string[]}
 */
export const ALLOWLIST = GEMINI_MODELS.map((m) => m.id);

const _ALLOWED = new Set(ALLOWLIST);

/**
 * True iff `id` is an exact, allowed agy model string. Trims first.
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
 * Compact one-paragraph cheat-sheet for the calling agent: pick by TASK, not by
 * name. Kept short on purpose (it rides in every tools/list payload).
 * @type {string}
 */
export const GUIDE =
  'Pick by task, not by name. ' +
  'Gemini 3.8 Flash (High)=the FLEET DEFAULT for all research/agentic delegation ' +
  '(DeepSWE v1.1 73.8, Terminal-Bench 2.1 89.4, OSWorld 2.0 59.0, LAB-Bench2 86.2, ' +
  'HLE-Verified 54.9) with strong Gray Swan prompt-injection robustness, which matters here ' +
  'because every unit reads untrusted web content. It spends many thinking tokens at High, so ' +
  'drop the effort level for routine work: ' +
  '3.8 Flash (Low)=quick facts, lookups & short summaries (fastest, cheapest — ' +
  '$0.75/$3.75 per Mtok in/out through 2026-12-31, then $1.50/$7.50); ' +
  '3.8 Flash (Medium)=when High-effort latency or token overhead is unwanted (the fleet default ' +
  'is High); ' +
  'Gemini 3.1 Pro (Low)=the same two niches at balanced cost, on the 2M context window; ' +
  'Pro (High)=ONLY for >1M-token inputs, formal/scientific reasoning where Flash has no numbers ' +
  '(GPQA 94.3, ARC-AGI-2 77.1), and as the tie-breaker when Grok and Flash disagree — not a code ' +
  'or agentic model (3.8 Flash 68.1 vs 46.2 coding, 67.6 vs 40.1 agentic); ' +
  'Claude Opus 5.5 (High|Medium) and Claude Sonnet 5.5 (High|Medium)=Antigravity\'s SEPARATE Claude quota, and a ' +
  'SMALL one: one named call per question — an independent Opus read, a hard verification pass, a cheap Sonnet ' +
  'cross-check — when the Claude Code pool is the constraint; never the default, never a sweep, never a ' +
  'deep-research stage (gemini_deep_research refuses Claude ids), never configured as gemini.model (gemini_research and gemini_image refuse a Claude default); the same generation as the fleet\'s own roles, so ' +
  'an independent read, not a stronger one; prefer Gemini for citation-heavy research; ' +
  'GPT-OSS 120B (Medium)=non-Google open-weights second opinion / math cross-check (near o4-mini, ' +
  'MMLU ~90%), NOT a primary frontier researcher and no long-context edge. ' +
  'Omit the model param to keep agy\'s default.';
