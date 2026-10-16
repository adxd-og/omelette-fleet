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
 * SYNCED TO agy (verified 2026-10-16, agy 1.4.0). This sync: Gemini 4 Argon
 * (Low|Medium|High) added — agy lists all three, and (Low) ran headless on
 * 2026-10-16; Gemini 3.1 Pro removed — agy no longer lists it; GPT-OSS 120B's
 * removal date recorded (Antigravity's model page: 2026-11-02). If agy
 * adds/renames/removes a model, re-check and update GEMINI_MODELS below (and
 * re-confirm the bench notes in useFor/avoid). The (Low/Medium/High) suffix is
 * the model's reasoning/thinking-effort level (Low=fast/cheap, High=more
 * deliberation).
 *
 * GENERATION SWEEP 2026-10-16: Gemini 4 Argon (DeepMind model card, published
 * 2026-10-13) replaced the two 3.1 Pro entries outright — operator decision, the
 * same standing policy as for Flash (the newer generation replaces the older).
 * It is not a like-for-like swap. 3.1 Pro was kept for long inputs and formal
 * reasoning and was NOT a code or agentic model; Argon is one — DeepSWE v1.1 77.9
 * (card), AutomationBench-AA 78 (Artificial Analysis) — so the heavy Gemini tier
 * now means agentic depth, not a bigger window. On a Google AI Pro subscription
 * its quota is small (operator, 2026-10-16), which makes it a named one-call
 * route there; see SCOPE. The 2M window left with 3.1 Pro: Argon's 1M is shared
 * by input and output (card), and nothing in this catalog now takes inputs past
 * 1M tokens.
 *
 * ARGON SOURCES (checked this sweep): the DeepMind card for DeepSWE v1.1,
 * FrontierSWE v2, the window, the March 2026 knowledge cutoff and the modalities
 * (text, image, audio and video in; text out); Artificial Analysis, read
 * 2026-10-14, for every other figure — Argon at High only, Flash at High, GPT-6.1
 * Sol and Opus 5.5 at Max. Each comparison below stays inside one source. AA
 * measured neither Argon (Medium) nor (Low): those entries inherit High's
 * profile, unmeasured. AA's Terminal-Bench 4.0 (Flash High 20) is a different
 * version from the Terminal-Bench 2.1 in the Flash entries (89.4); do not compare
 * the two.
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
 * Gemini 4 Argon's quota is small too on a Google AI Pro subscription (operator,
 * 2026-10-16: half of it gone after a day of light use); "effectively unlimited"
 * above was observed on Flash, and whether Argon draws on its own bucket is not
 * known. There it is the same kind of named one-call route: never the default,
 * never a sweep, never a deep-research stage, never gemini.model. Unlike Claude,
 * no tool refuses it: the rule lives in the entries and the GUIDE.
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

/** The quota rule every Argon entry's `avoid` ends on (operator, 2026-10-16; see SCOPE). */
const ARGON_QUOTA =
  'On a Google AI Pro subscription Argon\'s quota is small: there it is a named one-call route like Claude via agy — ' +
  'never a sweep, a deep-research stage, gemini.model or the default.';

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
      'Multi-step reasoning, expert analysis, and dense long-context retrieval — Low effort under-thinks hard problems; step up to Medium/High.',
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
      'Hard knowledge and science questions — Argon (High) leads Flash High there (HLE 57 vs 48, SciCode 62 vs 57; AA, read 2026-10-14; on a Pro subscription one named call, see Argon). Don\'t use it for long-horizon engineering where High\'s first-pass accuracy pays for itself in fewer retries.',
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
      'Routine work on a shared subscription quota. 3.8 is built ON 3.7 and deliberately spends MORE thinking tokens for its depth; Google\'s own guidance is that efficiency-first callers "utilize lower effort levels to minimize token overhead or continue to rely on Gemini 3.7 Flash" — the first half is our exit, so drop to Low/Medium rather than paying High for lookups. Hard knowledge and science research, terminal agents and multi-step automation go up to Argon (High): HLE 57 vs 48, SciCode 62 vs 57, Terminal-Bench 4.0 57 vs 20, AutomationBench-AA 78 vs 60 (AA, read 2026-10-14, both at High); on a Pro subscription that is one named call (see Argon). Long-context retrieval stays here: AA-LCR 81 against Argon\'s 80 (AA). FrontierCode 1.1, AutomationBench, MRCR v2 128K and WebDev Arena Elo are ALSO unpublished for 3.8 (AA\'s own AutomationBench-AA is the 60 above) — the fleet\'s UI-prompt routing rests on 3.7-generation evidence, so treat that call as inherited, not re-verified.',
  },
  {
    id: 'Gemini 4 Argon (Low)',
    label: 'Gemini 4 Argon · Low',
    family: 'gemini',
    effort: 'Low',
    tier: 'heavy',
    useFor:
      'The lightest Argon read: a simpler question that still wants Argon rather than Flash. How agy\'s (Low) maps to ' +
      'Google\'s API thinking levels is not published; no figures — AA measured only High — so it inherits High\'s ' +
      'profile, unmeasured.',
    avoid:
      'As Argon (High); a quick lookup or a short summary is Flash Low\'s, not Argon\'s. ' + ARGON_QUOTA,
  },
  {
    id: 'Gemini 4 Argon (Medium)',
    label: 'Gemini 4 Argon · Medium',
    family: 'gemini',
    effort: 'Medium',
    tier: 'heavy',
    useFor:
      'Argon between Low and High, for coding and agent work that wants Argon\'s profile without High\'s depth. How ' +
      'agy\'s (Medium) maps to Google\'s API thinking levels is not published; no figures — AA measured only High — so it ' +
      'inherits High\'s profile, unmeasured.',
    avoid:
      'As Argon (High). Anything that leans on a measured figure, the tie-breaker included, wants High: it is the only level ' +
      'measured. ' + ARGON_QUOTA,
  },
  {
    id: 'Gemini 4 Argon (High)',
    label: 'Gemini 4 Argon · High',
    family: 'gemini',
    effort: 'High',
    tier: 'heavy',
    useFor:
      'The fleet\'s TIE-BREAKER when Grok and Flash disagree, and the step up from Flash where depth pays: multi-step ' +
      'automation and agent workflows (AutomationBench-AA 78, the best of the four AA compared — Opus 5.5 Max 70, GPT-6.1 Sol ' +
      'Max 65, Flash High 60); hard knowledge and science research where Flash falls short (HLE 57 vs 48, SciCode 62 vs 57, ' +
      'AA-Omniscience 42 vs 30 — fewer confident errors); terminal agents, where Flash collapses (Terminal-Bench 4.0 57 vs 20); ' +
      'repository-level code (DeepSWE v1.1 77.9 against GPT-6 Astra 74.1 and Opus 5.5 74.2, DeepMind card). AA, read ' +
      '2026-10-14, Argon at High: Intelligence Index 53 at $1.99 per Index task (GPT-6.1 Sol Max 52 at $0.72). The depth ' +
      'does not cost more output tokens: Flash High spends 71k per AA task against Argon\'s 62k. 1M tokens for input and ' +
      'output together, knowledge cutoff March 2026, text/image/audio/video in, text out (card).',
    avoid:
      'PDF and document-heavy knowledge work (GDP.pdf 22, against GPT-6.1 Sol 31 and Opus 5.5 26 — route to Codex); ' +
      'long-context retrieval (AA-LCR 80, level with Flash High\'s 81 — no reason to go up); the hardest software engineering ' +
      '(FrontierSWE v2 55.0 against GPT-6 Astra 65.5, card — route to Codex); frontier physics (CritPt 27 vs GPT-6.1 Sol 32); ' +
      'quick lookups (Flash Low). Opus 5.5 (Max) leads it on almost every AA row but AutomationBench, at three times the cost ' +
      'per task. ' + ARGON_QUOTA,
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
      'Primary frontier work and long-context tasks — it trails the frontier Gemini models on overall reasoning/agentic depth and has no long-context retrieval advantage. Use as a corroborating voice, not the lead researcher. Antigravity removes it on 2026-11-02; the release after that date takes it out of the catalog.',
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
  'Gemini 4 Argon (High)=the tie-breaker when Grok and Flash disagree, and the step up from Flash for agentic, ' +
  'terminal and repository-code work and hard science (DeepSWE v1.1 77.9, Google; AA Index 53 at $1.99 per task ' +
  'vs GPT-6.1 Sol\'s 52 at $0.72); Argon (Medium|Low)=the same profile at lighter levels, unmeasured; on a Google AI ' +
  'Pro subscription Argon\'s quota is small: there it is a named one-call route like Claude via agy — never a sweep, ' +
  'a deep-research stage, gemini.model or the default; ' +
  'Claude Opus 5.5 (High|Medium) and Claude Sonnet 5.5 (High|Medium)=Antigravity\'s SEPARATE Claude quota, and a ' +
  'SMALL one: one named call per question — an independent Opus read, a hard verification pass, a cheap Sonnet ' +
  'cross-check — when the Claude Code pool is the constraint; never the default, never a sweep, never a ' +
  'deep-research stage (gemini_deep_research refuses Claude ids), never configured as gemini.model (gemini_research and gemini_image refuse a Claude default); the same generation as the fleet\'s own roles, so ' +
  'an independent read, not a stronger one; prefer Gemini for citation-heavy research; ' +
  'GPT-OSS 120B (Medium)=non-Google open-weights second opinion / math cross-check (near o4-mini, ' +
  'MMLU ~90%), NOT a primary frontier researcher and no long-context edge. ' +
  'Omit the model param to keep agy\'s default.';
