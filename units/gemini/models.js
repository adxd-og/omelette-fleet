/**
 * omelette-fleet :: units/gemini/models.js — the Gemini catalog: model ids and
 * labels, the agy-spawn allowlist and the routing guide the unit appends to its
 * tool descriptions. Edited here; nothing syncs it.
 *
 * The ids are the display-name form agy lists under "Available models" when it
 * rejects an unknown --model, written verbatim as `agy --model "<id>"`. Spawn
 * uses an args ARRAY (no shell), so spaces/parens in an id are one safe argv
 * element. Note `agy models` prints both forms, slug then display name
 * (gemini-4-hydrogen-high, Gemini 4 Hydrogen (High)); --model accepts both, and the display names are kept here because they carry
 * the effort level readably.
 *
 * SYNCED TO agy (verified 2026-11-13, agy 1.5.8). This sync: Gemini 4 Hydrogen
 * (Low|Medium|High|XHigh) added — agy lists all four, and (Low) and (XHigh) ran
 * headless on 2026-11-13; Gemini 3.8 Flash removed by the sweep below — agy
 * 1.5.8 still lists it and Antigravity names no removal date for it; GPT-OSS
 * 120B's announced removal date moved to 2026-11-18 (Antigravity's models page).
 * Listed by agy and not in this catalog: Orchestrator (Argon) and the Claude Low
 * tiers. If agy adds/renames/removes a model, re-check and update GEMINI_MODELS
 * below (and re-confirm the bench notes in useFor/avoid). The (Low/Medium/High/
 * XHigh) suffix is the model's reasoning/thinking-effort level (Low=lightest,
 * XHigh=most deliberation; Antigravity's docs call XHigh "Extra"). How agy's
 * levels map to the API's thinking levels is not published.
 *
 * GENERATION SWEEP 2026-11-13: Gemini 4 Hydrogen (released by Google
 * 2026-11-12) replaced the three 3.8 Flash entries outright — operator decision,
 * the standing policy (the newer generation replaces the older), and Google's
 * launch post calls it "a major standalone upgrade for teams migrating from
 * Gemini 3.8 Flash". High stays the fleet default, as it is Google's; XHigh is
 * new, a named step up. The two generations' benchmark sets do not overlap:
 * Hydrogen's card publishes none of the rows the 3.8 Flash entries held, so
 * there is no same-harness delta beyond what Google's launch post states against
 * 3.8 Flash and the Artificial Analysis rows (Hydrogen at xhigh against 3.8 Flash
 * at high — not the same level). Restoring a retired generation means re-adding
 * its entry here by hand.
 *
 * HYDROGEN SOURCES (read 2026-11-13): the DeepMind model card (published
 * 2026-11-12) for the model's shape — adapted from Gemini 4 Carbon; 1M tokens
 * for input and output together, 64K synchronous output; knowledge cutoff March
 * 2026; text, image, audio and video in — and one table against Claude Sonnet
 * 5.5 and GPT-6.1 Terra that states no thinking level for any column; Google's
 * launch post for the levels and its sentences against 3.8 Flash; Artificial
 * Analysis, Intelligence Index v5.0.1 (third party), whose per-benchmark rows
 * are published as text for Hydrogen at xhigh only (against Argon and 3.8 Flash,
 * both at high). Hydrogen at high has four AA figures, and its per-benchmark rows
 * are not published as text: Index 51, $1.87 per task, 7.9 minutes per task,
 * 110M output tokens over the Index. The card's AutomationBench-AA 76.1 and
 * HLE-Diamond 58.8 equal AA's xhigh rows to the decimal, so the card's column is
 * probably xhigh on those rows — an inference, not a published fact. No card row
 * is filed under (High) as that level's measurement. AA's figures at Low and
 * Medium are not published: those entries
 * inherit High's profile, unmeasured. The card's Terminal-Bench 4.1
 * (cheating-adjusted, a term whose meaning is not confirmed) and AA's
 * Terminal-Bench 4.0 are different versions; do not compare the two. Each
 * comparison below stays inside one source.
 *
 * ARGON (rewritten 2026-11-13): Gemini 4 Argon replaced the two 3.1 Pro entries
 * on 2026-10-16 and is now the heavier Gemini 4 tier — the tie-breaker, the step
 * up from Hydrogen for terminal agents, terminal science and multi-step
 * automation (AA, Argon at high against Hydrogen at xhigh), and the model whose
 * card (published 2026-10-13) holds repository-level and long-input rows
 * (DeepSWE v1.1, FrontierSWE v2, GraphWalks 256k–1M) that Hydrogen's card does
 * not publish. Its figures are now that card's and AA Index v5.0.1's, Argon at
 * high only. Every Argon figure read 2026-10-14 left: it came from an earlier
 * Index (v5.0 dropped HLE, SciCode and AA-LCR; v5.0.1 regraded CritPt) and
 * compares with nothing above.
 *
 * SCOPE: Gemini family + GPT-OSS + Claude Opus 5.5 and Sonnet 5.5 via Antigravity.
 * The Claude family runs on Antigravity's OWN quota bucket, separate from the shared
 * Gemini pool (confirmed 2026-08-02 by two independent deep-research runs and operator
 * decision) — and that bucket is SMALL (operator, 2026-10-03), where the Gemini pool was
 * effectively unlimited for this fleet on 3.8 Flash. So Claude-via-agy is a deliberate, named,
 * one-call route: never the default, never a sweep, never a deep-research stage (the
 * adapter refuses it). Sonnet joined on 2026-10-03, reversing the 2026-08-02 exclusion:
 * a Sonnet 5.5 call on the Antigravity bucket costs the Claude Code pool nothing, and
 * that pool is the expensive one. Neither is a fleet role — the coder, tester and
 * reviewer stay native (guard, diff, transcript).
 * WEB ACCESS (measured 2026-11-13, agy 1.5.8, headless, with and without the unit's
 * flags): no Gemini model here — Hydrogen, Argon, 3.8 Flash — is given a URL-reading
 * tool; each names search_web as its only web tool, though agy's init event still
 * lists read_url_content. "Web research" on this unit is search-grounded: an answer
 * about one exact page is built from search summaries. Since which agy version is
 * not known.
 * Gemini 4 Hydrogen draws on the Gemini pool: Antigravity's usage on Google AI Pro
 * (read 2026-11-13) shows a Gemini pool with a 5-hour and a weekly window, a weekly
 * window of Argon's own and a Claude/GPT pool, and no Hydrogen window. One reading
 * at the 1.11.0 live gate (2026-11-13, the operator's usage snapshot before and after,
 * 24 minutes apart): two research calls (High, XHigh), one deep-research run and about
 * a dozen one-line probes on Hydrogen moved the Gemini weekly window by 0.24 points
 * and the 5-hour window by 1.8; two Argon (High) research calls in the same interval
 * moved Argon's weekly window by 2.0 points. One interval, rolling windows, an account
 * other sessions share: an order of magnitude, not a rate.
 * Gemini 4 Argon's quota is small too on a Google AI Pro subscription (operator,
 * 2026-10-16: half of it gone after a day of light use), and it has its own weekly
 * window there. There it is the same kind of named one-call route: never the default,
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
 * @property {'Low'|'Medium'|'High'|'XHigh'} effort  Reasoning/thinking-effort level.
 * @property {'fast'|'balanced'|'heavy'} tier
 * @property {string} useFor  When to pick it.
 * @property {string} avoid   When NOT to pick it.
 */

/** The quota rule every Argon entry's `avoid` ends on (operator, 2026-10-16; the window, 2026-11-13; see SCOPE). */
const ARGON_QUOTA =
  'On a Google AI Pro subscription Argon\'s quota is small and has its own weekly window: there it is a named ' +
  'one-call route like Claude via agy — never a sweep, a deep-research stage, gemini.model or the default.';

/** @type {GeminiModel[]} */
export const GEMINI_MODELS = [
  {
    id: 'Gemini 4 Hydrogen (Low)',
    label: 'Gemini 4 Hydrogen · Low',
    family: 'gemini',
    effort: 'Low',
    tier: 'fast',
    useFor:
      'The cheap lookup: quick facts, fact-checks, short summaries and single-document skims. Unmeasured: AA\'s figures ' +
      'at Low are not published and the card states no level, so it inherits High\'s profile; how agy\'s (Low) maps to ' +
      'the API\'s thinking levels is not published.',
    avoid:
      'Multi-step reasoning, hard analysis and anything that leans on a measured figure — step up to Medium or High. ' +
      'Hydrogen (High)\'s caveats on exact-URL and image and PDF reads apply here too.',
  },
  {
    id: 'Gemini 4 Hydrogen (Medium)',
    label: 'Gemini 4 Hydrogen · Medium',
    family: 'gemini',
    effort: 'Medium',
    tier: 'balanced',
    useFor:
      'High\'s profile at a lighter level: synthesis, structured summaries and light analysis when High\'s latency or ' +
      'token spend is unwanted, and — when no gemini.model is configured — the decompose and gather stages of ' +
      'gemini_deep_research (a configured model runs every stage). The fleet default is High, so ' +
      'Medium is a deliberate exit, not a fallback. Unmeasured: AA\'s figures at Medium are not published and the card ' +
      'states no level, so it inherits High\'s profile; how agy\'s (Medium) maps to the API\'s thinking levels is not ' +
      'published.',
    avoid:
      'As Hydrogen (High). A question that leans on a measured figure wants High, the measured default.',
  },
  {
    id: 'Gemini 4 Hydrogen (High)',
    label: 'Gemini 4 Hydrogen · High',
    family: 'gemini',
    effort: 'High',
    tier: 'balanced',
    useFor:
      'The FLEET DEFAULT for delegated research and agentic work, and Google\'s own default level — a policy the config ' +
      'carries (gemini.model): with none set, agy\'s own default model runs. Artificial Analysis ' +
      '(Index v5.0.1, read 2026-11-13), Hydrogen at high: Intelligence Index 51 at $1.87 and 7.9 minutes per Index task, ' +
      'above Argon (high)\'s 50 at $4.97 and 30.0 minutes. Google\'s launch post, against 3.8 Flash: tasks finished 2.5 ' +
      'times faster at the high default, and more than 2.3x more resilient on the Gray Swan IPI (prompt-injection) ' +
      'benchmark — the one that matters most here, since every unit reads untrusted web pages. Its shape, from the ' +
      'DeepMind card: adapted from Gemini 4 Carbon; 1M tokens for input and output together, 64K synchronous output; ' +
      'knowledge cutoff March 2026; text, image, audio and video in. The card\'s table states no thinking level and is ' +
      'not this level\'s measurement (two of its rows equal AA\'s xhigh figures): on it Hydrogen leads Claude Sonnet 5.5 ' +
      'and GPT-6.1 Terra on SWE-sweep, Agents\' Last Exam v1.1, AutomationBench-AA, Vending-Bench 2, MKA, Chartography ' +
      'and HLE-Diamond. AA\'s per-benchmark rows at high are not published as text; the xhigh ones are in Hydrogen (XHigh).',
    avoid:
      'Reading one exact URL: on agy 1.5.8 no Gemini model is given a URL-reading tool headless, only search_web, so a ' +
      '"fetch this page" answer is built from search summaries (measured 2026-11-13: Hydrogen, Argon and 3.8 Flash ' +
      'alike) — send an exact-page read to Grok or Codex research. ' +
      'A caveat, not a reroute, for image and PDF reads: they stay on this unit and this default (no entry here has a ' +
      'measured lower refusal rate), but the card reports unjustified refusals up 5.57 percentage points against 3.8 ' +
      'Flash (lower is better), "particularly for multimodal prompts" — a refused read is the model\'s refusal, not a ' +
      'missing permission: reword it once before going elsewhere. The card\'s full safety report was not published as ' +
      'of 2026-11-13. Computer use and terminal science, where Claude Sonnet 5.5 leads it on the same card table (OSWorld-2.1 ' +
      '83.9 vs 77.6, Terminal-Bench-Science 0.1 59.9 vs 51.4; no level stated). Terminal agents and multi-step automation ' +
      'go up to Argon (High), one named call: on those AA rows Argon at high leads even Hydrogen at xhigh (see Argon).',
  },
  {
    id: 'Gemini 4 Hydrogen (XHigh)',
    label: 'Gemini 4 Hydrogen · XHigh',
    family: 'gemini',
    effort: 'XHigh',
    tier: 'heavy',
    useFor:
      'The named step up from High — one call when depth pays. The only Hydrogen level with per-benchmark rows published: ' +
      'Artificial Analysis (Index v5.0.1, read 2026-11-13), Hydrogen at xhigh against Argon at high: Intelligence Index ' +
      '54 vs 50, FrontierCode-AA 2.0 39.0 vs 25.7, GDP.pdf 27.6 vs 21.8, CritPt v2 (Hard Subset) 66.0 vs 52.5, ' +
      'HLE-Diamond 58.8 vs 56.7, AA-Omniscience v1.1 46 vs 46, at $3.16 and 13.7 minutes per Index task against $4.97 ' +
      'and 30.0 (3.8 Flash at high, same pages: Index 31). Against Hydrogen at high (AA): Index 54 vs 51, at $3.16 vs ' +
      '$1.87 and 13.7 vs 7.9 minutes per task.',
    avoid:
      'The default, a sweep, a deep-research stage or gemini.model: High is the default, and deep research takes Medium ' +
      'and High when no model is configured. It spends more output tokens than Argon (AA: 154k per Index task at xhigh ' +
      'against Argon at high\'s 116k) and than High (304M over the Index against 110M). ' +
      'Terminal agents, terminal science and multi-step automation go to Argon (High), which leads it there on the same ' +
      'AA pages (Terminal-Bench 4.0 57.1 vs 53.5, Terminal-Bench-Science 0.1 52.9 vs 49.5, AutomationBench-AA 77.5 vs ' +
      '76.1, about level). Hydrogen (High)\'s caveats on exact-URL and image and PDF reads apply here too.',
  },
  {
    id: 'Gemini 4 Argon (Low)',
    label: 'Gemini 4 Argon · Low',
    family: 'gemini',
    effort: 'Low',
    tier: 'heavy',
    useFor:
      'The lightest Argon read: a simpler question that still wants Argon rather than Hydrogen. How agy\'s (Low) maps to ' +
      'Google\'s API thinking levels is not published; no figures — the AA rows read 2026-11-13 are Argon at high — so it ' +
      'inherits High\'s profile, unmeasured.',
    avoid:
      'As Argon (High); a quick lookup or a short summary is Hydrogen Low\'s, not Argon\'s. ' + ARGON_QUOTA,
  },
  {
    id: 'Gemini 4 Argon (Medium)',
    label: 'Gemini 4 Argon · Medium',
    family: 'gemini',
    effort: 'Medium',
    tier: 'heavy',
    useFor:
      'Argon between Low and High, for coding and agent work that wants Argon\'s profile without High\'s depth. How ' +
      'agy\'s (Medium) maps to Google\'s API thinking levels is not published; no figures — the AA rows read 2026-11-13 ' +
      'are Argon at high — so it inherits High\'s profile, unmeasured.',
    avoid:
      'As Argon (High). Anything that leans on a measured figure, the tie-breaker included, wants High: it is the only ' +
      'Argon level with figures. ' + ARGON_QUOTA,
  },
  {
    id: 'Gemini 4 Argon (High)',
    label: 'Gemini 4 Argon · High',
    family: 'gemini',
    effort: 'High',
    tier: 'heavy',
    useFor:
      'The fleet\'s TIE-BREAKER when Grok and Hydrogen disagree — the heavier Gemini 4, a model that is neither — and ' +
      'the step up from Hydrogen for terminal agents, terminal science and multi-step automation. Artificial Analysis ' +
      '(Index v5.0.1, read 2026-11-13), Argon at high against Hydrogen at xhigh: Terminal-Bench 4.0 57.1 vs 53.5, ' +
      'Terminal-Bench-Science 0.1 52.9 vs 49.5, AutomationBench-AA 77.5 vs 76.1 (about level). Repository-level code and ' +
      'long inputs on its DeepMind card (published 2026-10-13): DeepSWE v1.1 77.9 against GPT-6 Astra 74.1 and Opus 5.5 ' +
      '74.2, GraphWalks 256k–1M 84.2 against Astra 71.8. Hydrogen\'s card publishes neither row, so how the two compare ' +
      'there is open.',
    avoid:
      'Anything Hydrogen (XHigh) does better for less — AA, Argon at high against Hydrogen at xhigh: FrontierCode-AA 2.0 ' +
      '25.7 vs 39.0, GDP.pdf 21.8 vs 27.6, CritPt v2 (Hard Subset) 52.5 vs 66.0, HLE-Diamond 56.7 vs 58.8, Intelligence ' +
      'Index 50 vs 54, at $4.97 and 30.0 minutes per Index task against $3.16 and 13.7. The hardest software engineering ' +
      '(FrontierSWE v2 55.0 against GPT-6 Astra 65.5, Argon\'s card — route to Codex). Quick lookups (Hydrogen Low). ' +
      ARGON_QUOTA,
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
      'Anything routine, any sweep, any loop, and every deep-research stage (gemini_deep_research refuses Claude ids) and never as the configured default (gemini_research and gemini_image refuse it): the Antigravity Claude bucket is small and shared by all four Claude entries, apart from the Gemini pool. Not a fleet role: the guard, the diff and the transcript live in Claude Code. Citation-heavy research goes to Gemini (web grounding via agy is unverified for the Claude family).',
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
      'Sweeps and loops all the same — the bucket is small and shared with Opus. Not a tester or a coder: those roles need the guard and the diff. Hydrogen (High) stays the default for research, Hydrogen (Low) for anything cheap.',
  },
  {
    id: 'Claude Sonnet 5.5 (Medium)',
    label: 'Claude Sonnet 5.5 · Medium',
    family: 'claude',
    effort: 'Medium',
    tier: 'heavy',
    useFor:
      'The lightest Claude read on the Antigravity bucket: a summary, a sanity check, a short classification — when a Gemini answer wants a Claude cross-check and the native pool should stay untouched.',
    avoid:
      'As Sonnet 5.5 (High); prefer Hydrogen Low or Medium for anything that does not need a Claude voice.',
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
      'Primary frontier work and long-context tasks — it trails the frontier Gemini models on overall reasoning/agentic depth and has no long-context retrieval advantage. Use as a corroborating voice, not the lead researcher. Antigravity announces its removal for 2026-11-18 (it was 2026-11-02; agy 1.5.8 still lists it); it leaves the catalog when agy stops listing it.',
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
 *   1. POLICY — it keeps every id agy lists but the catalog does not admit (the
 *      Claude Low tiers and Orchestrator (Argon) today, a next model tomorrow) out
 *      of the agy path until the catalog says so. agy itself would happily run them.
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
  'Gemini 4 Hydrogen (High)=the FLEET DEFAULT for research/agentic delegation (AA at high: Index 51, $1.87 and ' +
  '7.9 min per task; Argon (High) 50, $4.97, 30 min); per Google >2.3x more resilient than 3.8 Flash on Gray Swan ' +
  'prompt injection, which matters: every unit reads untrusted web content; ' +
  'Hydrogen (Low)=quick facts, lookups & short summaries; ' +
  'Hydrogen (Medium)=when High\'s latency or token spend is unwanted (Low and Medium are unmeasured); ' +
  'Hydrogen (XHigh)=the named step up, one call when depth pays (AA at xhigh: Index 54 at $3.16 and 13.7 min), ' +
  'never the default or a deep-research stage; ' +
  'Gemini 4 Argon (High)=the tie-breaker when Grok and Hydrogen disagree, and the step up for terminal agents ' +
  'and terminal science (AA: ahead of Hydrogen XHigh there, level on ' +
  'automation, behind on the Index); its card has repository rows Hydrogen\'s lacks (DeepSWE v1.1 77.9); Argon (Medium|Low)=the same profile at lighter levels, ' +
  'unmeasured; on a Google AI Pro subscription Argon\'s quota is small: there it is a named one-call route like ' +
  'Claude via agy — never a sweep, a deep-research stage, gemini.model or the default; ' +
  'Claude Opus 5.5 (High|Medium) and Claude Sonnet 5.5 (High|Medium)=Antigravity\'s SEPARATE Claude quota, and a ' +
  'SMALL one: one named call per question — an independent Opus read, a hard verification pass, a cheap Sonnet ' +
  'cross-check — when the Claude Code pool is the constraint; never the default, never a sweep, never a ' +
  'deep-research stage (gemini_deep_research refuses Claude ids), never configured as gemini.model (gemini_research and gemini_image refuse a Claude default); the same generation as the fleet\'s own roles, so ' +
  'an independent read, not a stronger one; prefer Gemini for citation-heavy research; ' +
  'GPT-OSS 120B (Medium)=non-Google open-weights second opinion / math cross-check (near o4-mini, ' +
  'MMLU ~90%), NOT a primary frontier researcher and no long-context edge. ' +
  'Omit the model param to keep agy\'s default.';
