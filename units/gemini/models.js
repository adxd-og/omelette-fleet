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
 * SYNCED TO agy (verified 2026-11-26, agy 1.5.18, auto-updated from 1.5.12 across
 * the releases between). This sync: Gemini 4 Carbon (Medium) and (High) added. On
 * agy 1.5.17 `agy models` listed Carbon at Low, Medium and High, no XHigh (slugs
 * gemini-4-carbon-low|-medium|-high), and Orchestrator (Carbon); (High) and
 * (Medium) each answered a one-word prompt headless on the operator's Google AI
 * Pro sign-in, with the unit's own flags, in 6 s — both runs on 1.5.17. agy updated
 * itself to 1.5.18 the same day, and `agy models` prints the same 27 lines.
 * Listed by agy 1.5.18 and not in this catalog: Gemini 4 Carbon (Low) — on
 * Artificial Analysis (Index v5.0.2, read 2026-11-26) it costs more per Index task
 * than Carbon at medium and takes longer, for four Index points less ($7.19 vs
 * $6.59, 29.9 vs 28.1 minutes, Index 54 vs 58), and Neon at medium scores one point
 * above it (55) at about a quarter of the dollars ($1.90), so it stays out
 * (operator, 2026-11-26); the three Orchestrator rows, (Neon), (Carbon) and
 * (Argon) — Antigravity: a planner, Neon by default or Carbon or Argon, paired
 * with Hydrogen, whose effort cannot be set; a read-only unit has no use for a
 * planner–executor pair; the swept Gemini 4 Argon (Low|Medium|High), Gemini 4
 * Hydrogen (XHigh) and Gemini 3.8 Flash (Low|Medium|High); and the Claude Low
 * tiers. Antigravity's models page (read 2026-11-26): "Gemini 4 Argon, Gemini 3.8
 * Flash, GPT-OSS-120b, and Claude 4.6 models are leaving on November 30, 2026" —
 * of those only GPT-OSS 120B (Medium) is in this catalog, and agy 1.5.18 still
 * lists it on 2026-11-26: the entry stays until agy stops listing it. If agy
 * adds/renames/removes a model, re-check and update GEMINI_MODELS below (and
 * re-confirm the bench notes in useFor/avoid). The (Low/Medium/High/XHigh) suffix
 * is the model's reasoning/thinking-effort level (Low=lightest, XHigh=most
 * deliberation; Antigravity's docs call XHigh "Extra"). How agy's levels map to
 * the API's thinking levels is not published.
 *
 * SWEEP 2026-11-19 (agy 1.5.12), on the operator's word: Gemini 4 Argon (all three
 * entries) and Gemini 4 Hydrogen (XHigh) left the catalog, and Argon's quota rule
 * with them; Gemini 4 Neon (released by Google 2026-11-18) entered at four levels —
 * `agy models` listed all four (slugs gemini-4-neon-low|-medium|-high|-xhigh), and
 * (High) answered headless on the operator's Google AI Pro sign-in with no API key
 * (5.7 s). Why, from Artificial Analysis (Index v5.0.1, read 2026-11-19), each
 * comparison on the same pages: Neon at high leads Argon at high on the Intelligence Index (60 vs 50),
 * Terminal-Bench 4.0 (61.6 vs 57.1), Terminal-Bench-Science 0.1 (65.7 vs 52.9) and
 * AutomationBench-AA (79.2 vs 77.5), at $3.74 vs $4.97 and 14.8 vs 29.5 minutes per
 * Index task; Neon at medium scores 55 to Hydrogen at xhigh's 54, at $1.90 vs $3.16
 * and 8.3 vs 15.2 minutes. The step up from Hydrogen is now Neon, and the
 * tie-breaker Neon (High). AA has re-measured since 2026-11-13 (Hydrogen at high
 * from 7.9 to 8.6 minutes per task, at xhigh from 13.7 to 15.2; Argon at high from
 * 30.0 to 29.5).
 * agy 1.5.12 still listed the four swept ids, and 1.5.18 still does; Antigravity's
 * models page (read 2026-11-26) has Argon leaving on 2026-11-30. Restoring one
 * means re-adding its entry here by hand, with today's figures rather than the
 * ones it left with; until then the allowlist refuses its id before any spawn.
 *
 * GENERATION SWEEP 2026-11-13: Gemini 4 Hydrogen (released by Google
 * 2026-11-12) replaced the three 3.8 Flash entries outright — operator decision,
 * the standing policy (the newer generation replaces the older), and Google's
 * launch post calls it "a major standalone upgrade for teams migrating from
 * Gemini 3.8 Flash". High stays the fleet default, as it is Google's. The two
 * generations' benchmark sets do not overlap: Hydrogen's card publishes none of
 * the rows the 3.8 Flash entries held, so there is no same-harness delta beyond
 * what Google's launch post states against 3.8 Flash. Restoring a retired
 * generation means re-adding its entry here by hand.
 *
 * CARBON SOURCES (read 2026-11-26): Google's launch post (2026-10-28, when Carbon
 * opened to a closed group) for the Gray Swan indirect prompt injection figure —
 * 0.0% attack success against Argon's 0.7%, no level stated — for its external
 * benchmarks being "evaluated without guardrails", and for API prices of $2 / $10
 * per Mtok introductory, $4 / $20 after; the DeepMind model card (published
 * 2026-11-10) for the model's shape — "based on Gemini 4 Argon", "using more
 * thinking tokens than Gemini 4 Argon"; 1M tokens for input and output together;
 * knowledge cutoff March 2026; text, image, audio and video in — and for one table
 * against Argon, GPT-6 Astra, Claude Opus 5.5 and Claude Fable 5.1 that states no
 * thinking level for any row or column: no card row is filed under any level, and
 * its three security rows (CWE-bench, ExploitGym, SEC-bench Pro) hold "when
 * accessed through the Fairwind Program" — not what a sign-in outside that
 * program gets. The card's Terminal-Bench-Science 0.1 64.8 equals AA's figure for
 * Carbon at high, so that row is probably at high — an inference, not a published
 * fact; no card row is filed under any level;
 * Artificial Analysis, Intelligence Index v5.0.2 (third party), its Neon-vs-Carbon
 * comparison page, for the Index, the dollars and minutes per Index task and the
 * per-benchmark rows of Neon and Carbon at all seven levels, and its Gemini 4
 * Carbon model page for its own words on Carbon at high and the two medians beside
 * them; Antigravity's models and plans pages for the plans, the levels (Low, Medium,
 * High), the shared Gemini quota and the 2026-11-30 removals. Not confirmed, and not
 * written below as a fact: what a Carbon call costs the Gemini pool against a Neon
 * or Hydrogen call; the level behind the card's table and the post's figures; when
 * Carbon reached paid Pro; its context window inside Antigravity (the card says 1M
 * of the model, the models page gives none for Carbon); what the security rows are
 * outside the Fairwind Program; a hallucination rate by level. AA's dollars are API
 * prices per Index task, not what a call costs the Antigravity pool.
 *
 * NEON SOURCES (read 2026-11-19): the DeepMind model card (published 2026-11-18)
 * for the model's shape — adapted from Gemini 4 Carbon, as Hydrogen is; 1M tokens
 * for input and output together, 64K synchronous output; knowledge cutoff March
 * 2026; text, image, audio and video in — for one table against Claude Opus 5.5
 * and GPT-6.2 Sol that states no thinking level for any column, and for a safety
 * section against Hydrogen (the full safety report "available in the coming
 * days"); Google's launch post for the four levels (default high) and three figures
 * with their level — FrontierCode 2.0 46.2% "at its default high setting",
 * Intelligence Index 61 "at its xhigh thinking level", Gray Swan IPI "0.0% attack
 * success rate" at "its highest thinking level" — and no number against Argon or
 * Hydrogen; Artificial Analysis, Intelligence Index v5.0.1 (third party), for four
 * figures and eight per-benchmark rows at each level, re-read on v5.0.2 (2026-11-26,
 * the Neon-vs-Carbon comparison page): where a Neon figure moved, the entry carries
 * the v5.0.2 one and says so; Antigravity's models page for the plans (Google AI
 * Pro, Ultra and Enterprise) and "default for new
 * conversations" — Antigravity's own default, not this fleet's: Hydrogen (High)
 * stays the fleet default until an eval says otherwise. Neon's context window
 * inside Antigravity is not confirmed: the models page says "Up to 512K tokens",
 * the card 1M. The card's Index 61 and HLE-Diamond 71.3 equal AA's v5.0.1 xhigh
 * figures while the post gives its FrontierCode 46.2 at high, so the card's column
 * probably mixes levels — an inference, not a published fact; no card row is filed under
 * any level. AA's dollars are API prices per Index task: what a Neon call costs
 * the Antigravity pool against a Hydrogen call is not measured.
 *
 * HYDROGEN SOURCES (read 2026-11-13; AA re-read 2026-11-19): the DeepMind model
 * card (published 2026-11-12) for the model's shape — adapted from Gemini 4
 * Carbon; 1M tokens for input and output together, 64K synchronous output;
 * knowledge cutoff March 2026; text, image, audio and video in — and one table
 * against Claude Sonnet 5.5 and GPT-6.1 Terra that states no thinking level for
 * any column; Google's launch post for the levels and its sentences against 3.8
 * Flash; Artificial Analysis, Intelligence Index v5.0.1 (third party), for four
 * figures at each of Low, Medium and High (Low and Medium were unpublished on
 * 2026-11-13). AA's per-benchmark rows for Hydrogen at high were not published as
 * text on 2026-11-13. The card's AutomationBench-AA 76.1 and HLE-Diamond 58.8
 * equal AA's xhigh rows as read 2026-11-13, so the card's column is probably xhigh
 * on those rows — an inference, not a published fact. No card row is filed under
 * any level as that level's measurement.
 *
 * The Terminal-Bench rows are different measurements: Neon's and Hydrogen's cards
 * give Terminal-Bench 4.1 (cheating-adjusted, a term whose meaning is not
 * confirmed), Carbon's card Terminal-Bench 4.0, AA's v5.0.1 pages Terminal-Bench
 * 4.0 and AA's v5.0.2 comparison page Terminal-Bench 4.1; do not compare across
 * them. Each comparison below stays inside one source.
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
 * flags): every Gemini level run — Hydrogen (Low), (Medium) and (High), Argon (High),
 * 3.8 Flash (High) — reported search_web as its only web tool and fetched nothing when
 * asked for one exact page, though agy's init event still lists read_url_content.
 * This is the models' own report plus the absence of a fetch, not agy's
 * documentation. On agy 1.5.12 (2026-11-19, two direct runs with the unit's flags,
 * one exact-page prompt) Neon (High) and Hydrogen (High) each reached for
 * run_command with curl instead; agy auto-denied it (permission_mode:
 * request-review — the 1.10.2 pin holds) and the run ended with an empty response,
 * which the unit reports as "agy produced no output". On 1.5.8 the same kind of
 * prompt came back as a search answer. How often an exact-page prompt ends empty
 * is not known: one prompt, one run per model. "Web research" on this unit is
 * search-grounded as far as measured. Since which agy version is not known.
 * Gemini 4 Hydrogen draws on the Gemini pool: Antigravity's usage on Google AI Pro
 * (read 2026-11-13) shows a Gemini pool with a 5-hour and a weekly window, a weekly
 * window of Argon's own and a Claude/GPT pool, and no Hydrogen window. One reading
 * at the 1.11.0 live gate (2026-11-13, the operator's usage snapshot before and after,
 * 24 minutes apart): two research calls (High, XHigh), one deep-research run and about
 * a dozen one-line probes on Hydrogen moved the Gemini weekly window by 0.24 points
 * and the 5-hour window by 1.8; two Argon (High) research calls in the same interval
 * moved Argon's weekly window by 2.0 points. One interval, rolling windows, an account
 * other sessions share: an order of magnitude, not a rate.
 * Gemini 4 Neon draws on the shared Gemini pool and has no window of its own, unlike
 * Argon (the operator, 2026-11-19): it is not a one-call route by quota, and no rule
 * like Argon's applies. What a Neon call costs that pool against a Hydrogen call is
 * not measured yet (the eval reads it).
 * Gemini 4 Carbon is, in Antigravity's words (models page, read 2026-11-26),
 * "included on paid Google AI Pro plans …, Google AI Ultra, and Gemini Enterprise
 * within the shared Gemini quota": which pool, not how much. What a Carbon call
 * costs that pool against a Neon or Hydrogen call is not measured (the eval reads
 * it at its first call). Carbon is a named one-call route by its wait and its AA
 * price, not by a quota rule: never the default, never a sweep, never a
 * deep-research stage (no stage picks a heavy entry; unlike a Claude id, a named
 * Carbon id is not refused there), and the tie-breaker stays Neon (High).
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

/** @type {GeminiModel[]} */
export const GEMINI_MODELS = [
  {
    id: 'Gemini 4 Hydrogen (Low)',
    label: 'Gemini 4 Hydrogen · Low',
    family: 'gemini',
    effort: 'Low',
    tier: 'fast',
    useFor:
      'The cheap lookup: quick facts, fact-checks, short summaries and single-document skims. Artificial Analysis ' +
      '(Index v5.0.1, read 2026-11-19), Hydrogen at low: Intelligence Index 27 at $0.29 and 1.5 minutes per Index ' +
      'task, 20.3M output tokens over the Index. How agy\'s (Low) maps to the API\'s thinking levels is not published.',
    avoid:
      'Multi-step reasoning and hard analysis — step up to Medium or High (AA: Index 41 at medium and 51 at high, ' +
      'against 27 at low). Hydrogen (High)\'s caveats on exact-URL and image and PDF reads apply here too.',
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
      'Medium is a deliberate exit, not a fallback. Artificial Analysis (Index v5.0.1, read 2026-11-19), Hydrogen at ' +
      'medium against Hydrogen at high: Intelligence Index 41 vs 51, at $0.80 vs $1.87 and 4.2 vs 8.6 minutes per ' +
      'Index task, 54.4M vs 110M output tokens over the Index. How agy\'s (Medium) maps to the API\'s thinking levels ' +
      'is not published.',
    avoid:
      'As Hydrogen (High). A question that wants depth wants High, the default.',
  },
  {
    id: 'Gemini 4 Hydrogen (High)',
    label: 'Gemini 4 Hydrogen · High',
    family: 'gemini',
    effort: 'High',
    tier: 'balanced',
    useFor:
      'The FLEET DEFAULT for delegated research and agentic work, and Google\'s own default level for Hydrogen — a ' +
      'policy the config carries (gemini.model): with none set, agy\'s own default model runs. Artificial Analysis ' +
      '(Index v5.0.1, read 2026-11-19), Hydrogen at high: Intelligence Index 51 at $1.87 and 8.6 minutes per Index task, ' +
      '110M output tokens over the Index. Google\'s launch post, against 3.8 Flash: tasks finished 2.5 ' +
      'times faster at the high default, and more than 2.3x more resilient on the Gray Swan IPI (prompt-injection) ' +
      'benchmark — the one that matters most here, since every unit reads untrusted web pages. Its shape, from the ' +
      'DeepMind card: adapted from Gemini 4 Carbon; 1M tokens for input and output together, 64K synchronous output; ' +
      'knowledge cutoff March 2026; text, image, audio and video in. The card\'s table states no thinking level and is ' +
      'not this level\'s measurement (two of its rows equal AA\'s xhigh figures): on it Hydrogen leads Claude Sonnet 5.5 ' +
      'and GPT-6.1 Terra on SWE-sweep, Agents\' Last Exam v1.1, AutomationBench-AA, Vending-Bench 2, MKA, Chartography ' +
      'and HLE-Diamond. AA\'s per-benchmark rows at high were not published as text on 2026-11-13.',
    avoid:
      'Reading one exact URL: on agy 1.5.8, headless, this model reported search_web as its only web tool and fetched ' +
      'nothing when asked for one page — as did Hydrogen (Low) and (Medium), measured 2026-11-13 — so a "read this ' +
      'page" answer came from search; on agy 1.5.12 (2026-11-19, one run) it reached for curl instead, agy denied it ' +
      'and the run ended empty ("agy produced no output"). Send an exact-page read to Grok or Codex research. ' +
      'A caveat, not a reroute, for image and PDF reads: they stay on this unit and this default, but the card ' +
      'reports unjustified refusals up 5.57 percentage points against 3.8 ' +
      'Flash (lower is better), "particularly for multimodal prompts" — a refused read is the model\'s refusal, not a ' +
      'missing permission: reword it once before going elsewhere. The card\'s full safety report was not published as ' +
      'of 2026-11-13. Neon\'s card puts its unjustified refusals 3.00 points below Hydrogen\'s overall (no level ' +
      'stated; not a measurement of image or PDF reads) — a fact, not a reroute. ' +
      'Computer use and terminal science, where Claude Sonnet 5.5 leads it on the same card table (OSWorld-2.1 ' +
      '83.9 vs 77.6, Terminal-Bench-Science 0.1 59.9 vs 51.4; no level stated). The step up from Hydrogen, terminal ' +
      'agents and terminal science included, is Neon (High), named per call (AA at high: Index 60 vs 51).',
  },
  {
    id: 'Gemini 4 Neon (Low)',
    label: 'Gemini 4 Neon · Low',
    family: 'gemini',
    effort: 'Low',
    tier: 'heavy',
    useFor:
      'The lightest Neon level: a question that wants Neon at the least depth and spend. Artificial Analysis (Index ' +
      'v5.0.1, read 2026-11-19; the minutes from v5.0.2, read 2026-11-26), Neon at low: Intelligence Index 44 at ' +
      '$0.75 and 3.8 minutes per Index task, 28.3M ' +
      'output tokens over the Index; Terminal-Bench 4.0 32.8, Terminal-Bench-Science 0.1 27.1, AutomationBench-AA ' +
      '76.0, FrontierCode-AA 2.0 26.9, GDP.pdf 31.4, HLE-Diamond 54.2, CritPt v2 (Hard Subset) 62.0, AA-Omniscience ' +
      'v1.1 49 — automation and CritPt hold at low (79.2 and 59.0 at high). How agy\'s (Low) maps to the API\'s ' +
      'thinking levels is not published.',
    avoid:
      'As Neon (High). Terminal agents, terminal science and code: at low they fall away (AA: Terminal-Bench 4.0 ' +
      '32.8, Terminal-Bench-Science 0.1 27.1, FrontierCode-AA 2.0 26.9, against 61.6, 65.7 and 43.3 at high). A ' +
      'quick lookup or a short summary is Hydrogen (Low)\'s.',
  },
  {
    id: 'Gemini 4 Neon (Medium)',
    label: 'Gemini 4 Neon · Medium',
    family: 'gemini',
    effort: 'Medium',
    tier: 'heavy',
    useFor:
      'Neon between Low and High: about Hydrogen (High)\'s cost and time with four Index points more — Artificial Analysis ' +
      '(Index v5.0.1, read 2026-11-19), Neon at medium against Hydrogen at high: Intelligence Index 55 vs 51, at ' +
      '$1.90 vs $1.87 and 8.3 vs 8.6 minutes per Index task, 62.9M vs 110M output tokens over the Index; on v5.0.2 ' +
      '(read 2026-11-26) Neon at medium is 8.8 minutes, and Hydrogen was not re-read there. Its own rows at ' +
      'medium: Terminal-Bench 4.0 54.5, Terminal-Bench-Science 0.1 54.8, AutomationBench-AA 77.8, FrontierCode-AA 2.0 ' +
      '36.9, GDP.pdf 32.8, HLE-Diamond 63.6, CritPt v2 (Hard Subset) 61.5, AA-Omniscience v1.1 51. How agy\'s ' +
      '(Medium) maps to the API\'s thinking levels is not published.',
    avoid:
      'As Neon (High): the default stays Hydrogen (High) and deep research stays on Hydrogen, though AA prices this ' +
      'level like Hydrogen (High) — AA\'s dollars are API prices, and what a Neon call costs the Gemini pool is not ' +
      'measured. Terminal agents and terminal science want High ' +
      '(AA: Terminal-Bench 4.0 61.6 and Terminal-Bench-Science 0.1 65.7 at high, against 54.5 and 54.8 at medium).',
  },
  {
    id: 'Gemini 4 Neon (High)',
    label: 'Gemini 4 Neon · High',
    family: 'gemini',
    effort: 'High',
    tier: 'heavy',
    useFor:
      'The step up from Hydrogen, a named call when depth pays — terminal agents and terminal science included — and ' +
      'the fleet\'s TIE-BREAKER when Grok and Hydrogen disagree: a model that is neither. Not the fleet default, which ' +
      'stays Hydrogen (High); Antigravity makes Neon its own default for new conversations, this fleet does not. ' +
      'Artificial Analysis (Index v5.0.1, read 2026-11-19), Neon at high against Hydrogen at high: Intelligence Index ' +
      '60 vs 51, at $3.74 vs $1.87 and 14.8 vs 8.6 minutes per Index task, 123M vs 110M output tokens over the Index. ' +
      'Its own rows at high: Terminal-Bench 4.0 61.6, Terminal-Bench-Science 0.1 65.7, AutomationBench-AA 79.2, ' +
      'FrontierCode-AA 2.0 43.3, GDP.pdf 33.4 (its best level), HLE-Diamond 68.4, CritPt v2 (Hard Subset) 59.0, ' +
      'AA-Omniscience v1.1 54. Google\'s launch post: high is the default level, with 46.2% on FrontierCode 2.0 at it ' +
      '(its Gray Swan figure is for the highest level only — see XHigh). Its shape, from the DeepMind card: adapted ' +
      'from Gemini 4 Carbon, as Hydrogen is; 1M tokens for input and output together (Antigravity\'s models page says ' +
      'up to 512K; which holds inside agy is not confirmed), 64K synchronous output; knowledge cutoff March 2026; ' +
      'text, image, audio and video in. The card\'s table states no thinking level and is not this level\'s ' +
      'measurement: on it Neon leads Claude Opus 5.5 and GPT-6.2 Sol on the AA Index v5.0.1 (61 vs 59 and 57 — that 61 equals AA\'s v5.0.1 xhigh figure, not this level\'s 60), ' +
      'Agents\' Last Exam v1.1 (75.8 vs 71.6 and 73.0), Terminal-Bench-Science 0.1 (70.5 vs 63.3 and 68.0), ' +
      'HLE-Diamond (71.3 vs 67.9 and 64.0), GraphWalks 256k–1M (95.2 vs 66.8 and 80.1) and LVBench (89.0 vs 83.7 and ' +
      '87.6). Its safety section, against Hydrogen: unjustified refusals 3.00 percentage points lower (lower is better; no level stated).',
    avoid:
      'Sweeps and quick lookups: they are Hydrogen\'s — AA prices Neon at high at twice Hydrogen at high per Index ' +
      'task, and what a Neon call costs the shared Gemini pool is not measured. The card\'s rows it trails on (no ' +
      'level stated): Terminal-bench 4.1 (cheating-adjusted) 65.2 against Claude Opus 5.5\'s 65.8, FrontierCode 2.0 ' +
      '46.2 against Opus 5.5\'s 47.3, Chartography 73.5 against GPT-6.2 Sol\'s 75.1. Reading one exact URL: on agy ' +
      '1.5.12 (2026-11-19, one run) it reached for run_command with curl, agy denied it and the run ended empty ("agy ' +
      'produced no output") — send an exact-page read to Grok or Codex research. The card\'s full safety report was ' +
      '"available in the coming days" as of 2026-11-19.',
  },
  {
    id: 'Gemini 4 Neon (XHigh)',
    label: 'Gemini 4 Neon · XHigh',
    family: 'gemini',
    effort: 'XHigh',
    tier: 'heavy',
    useFor:
      'The deepest Neon level, one call when depth pays more than High gives. Artificial Analysis (Index v5.0.1, read ' +
      '2026-11-19; the Index and the minutes from v5.0.2, read 2026-11-26), Neon at xhigh: Intelligence Index 62 at ' +
      '$6.44 and 28.0 minutes per Index task, 283M output tokens ' +
      'over the Index; Terminal-Bench 4.0 63.6, Terminal-Bench-Science 0.1 70.0, AutomationBench-AA 79.3, ' +
      'FrontierCode-AA 2.0 44.4, GDP.pdf 28.0, HLE-Diamond 71.3, CritPt v2 (Hard Subset) 60.5, AA-Omniscience v1.1 55. ' +
      'Google\'s launch post: Index 61 "at its xhigh thinking level", and a "0.0% attack success rate" on Gray Swan IPI ' +
      '(prompt injection) at "its highest thinking level". How agy\'s (XHigh) maps to the API\'s thinking levels is ' +
      'not published.',
    avoid:
      'As Neon (High), and anything High already answers: over High it buys two Index points (62 vs 60) for 1.7 times ' +
      'the cost per Index task ($6.44 vs $3.74) and 2.3 times the output tokens (283M vs 123M), and GDP.pdf falls ' +
      '(28.0 vs 33.4) — AA, both levels (the Index on v5.0.2, the tokens on v5.0.1). The tie-breaker is High, not this ' +
      'level.',
  },
  {
    id: 'Gemini 4 Carbon (Medium)',
    label: 'Gemini 4 Carbon · Medium',
    family: 'gemini',
    effort: 'Medium',
    tier: 'heavy',
    useFor:
      'Carbon at a lighter level: two Index points under High at two thirds of the time. Not a step past Neon ' +
      '(High): on AA it sits under Neon at high on the Index and on Terminal-Bench 4.1 and leads it on CritPt v2 ' +
      'only (see avoid), so it is for a hard-reasoning question of that kind when Carbon (High)\'s wait is the ' +
      'obstacle. A named one-call route as High is: not the fleet default, not the tie-breaker, not for a sweep or a ' +
      'deep-research stage. Artificial Analysis (Index v5.0.2, read 2026-11-26), Carbon at ' +
      'medium against Carbon at high: Intelligence Index 58 vs 60, at $6.59 vs $7.76 and 28.1 vs 42.2 minutes per ' +
      'Index task; CritPt v2 69.0 at both, Terminal-Bench 4.1 61.6 vs 66.2, FrontierCode-AA 2.0 39.5 vs 40.6, GDP.pdf ' +
      '29.6 vs 28.4, and AA-Omniscience falls to 47 from 54. The card\'s table and the launch post state no level ' +
      '(see Carbon (High)). How agy\'s (Medium) maps to the API\'s thinking levels is not published.',
    avoid:
      'As Carbon (High), and a question Neon (High) answers: on AA, Neon at high scores above Carbon at medium on the ' +
      'Index (60 vs 58) at $3.74 vs $6.59 and 14.8 vs 28.1 minutes per Index task, and leads it on Terminal-Bench ' +
      '4.1 (63.6 vs 61.6), FrontierCode-AA 2.0 (43.3 vs 39.5), GDP.pdf (33.4 vs 29.6) and AA-Omniscience (54 vs 47); ' +
      'Carbon at medium leads on CritPt v2 (69.0 vs 59.0) — AA, Index v5.0.2.',
  },
  {
    id: 'Gemini 4 Carbon (High)',
    label: 'Gemini 4 Carbon · High',
    family: 'gemini',
    effort: 'High',
    tier: 'heavy',
    useFor:
      'A named one-call route past Neon (High): a terminal-agent or hard-reasoning question Neon (High) fell short ' +
      'on, at about three times its wait. Not the fleet default, which stays Hydrogen (High); not the tie-breaker, ' +
      'which stays Neon (High); not for a sweep or a deep-research stage (a named id is not refused there: see ' +
      'avoid). Artificial Analysis (Index v5.0.2, read ' +
      '2026-11-26, the Neon-vs-Carbon comparison page), Carbon at high against Neon at high: Intelligence Index 60 vs ' +
      '60 — level, at 2.1 times the dollars ($7.76 vs $3.74) and 2.9 times the minutes (42.2 vs 14.8) per Index ' +
      'task; it leads on Terminal-Bench 4.1 (66.2 vs 63.6) and CritPt v2 (69.0 vs 59.0), by less on HLE-Diamond ' +
      '(69.1 vs 68.4), and AA-Omniscience is 54 at both. AA\'s model page for Carbon, at high: "notably slow per task ' +
      'and very verbose" — 42.2 minutes per Index task against a median of 12.7 for comparable models, 205M output ' +
      'tokens over the Index against a median of 65.4M. Its shape, from the DeepMind card (published 2026-11-10): ' +
      '"based on Gemini 4 Argon", "using more thinking tokens than Gemini 4 Argon"; 1M tokens for input and output ' +
      'together (its window inside Antigravity is not confirmed: the models page gives none for Carbon); knowledge ' +
      'cutoff March 2026; text, image, audio and video in. The card\'s table states no thinking level for any row or ' +
      'column and is not this level\'s measurement (no level stated): AA Index v5.0 59, Terminal-Bench 4.0 65.2 ' +
      'against Claude Opus 5.5\'s 59.6, Agents\' Last Exam v1.1 77.4, GraphWalks 256k–1M 96.2, Terminal-Bench-Science ' +
      '0.1 64.8. Google\'s launch post (no level stated): a 0.0% attack success rate on Gray Swan indirect prompt ' +
      'injection, against Argon\'s 0.7%; the same post has its external benchmarks "evaluated without ' +
      'guardrails". How agy\'s (High) ' +
      'maps to the API\'s thinking levels is not published.',
    avoid:
      'Sweeps, lookups and anything Neon (High) answers: on AA (Index v5.0.2, both at high) Carbon is level with Neon ' +
      'on the Index and behind it on FrontierCode-AA 2.0 (40.6 vs 43.3), AA-Briefcase (1611 vs 1631), GDP.pdf (28.4 vs ' +
      '33.4), AutomationBench-AA (77.8 vs 79.2) and Terminal-Bench-Science (64.8 vs 65.7). The card\'s rows it trails ' +
      'on (no level stated): FrontierSWE 2 61.2 against GPT-6 Astra\'s 65.5, OSWorld-2.1 offline 81.5 against Claude ' +
      'Opus 5.5\'s 87.2. Deep research stays on Hydrogen: Carbon is heavy, so no stage picks it, and naming it there ' +
      'runs every stage — about five agy runs — on it. A long task can end at gemini.timeoutS (300 s built ' +
      'in; AA\'s 42.2 minutes is per Index task, not per call) — raising it is config. Its security ' +
      'rows on the card (CWE-bench 71.0, ExploitGym 54.8, SEC-bench Pro 88.2; no level stated) hold "when accessed ' +
      'through the Fairwind Program": they are not what a sign-in outside that program gets, and what the model ' +
      'scores behind the consumer guardrails is not published. What a Carbon call costs the shared Gemini pool against a Neon or Hydrogen call ' +
      'is not measured. Reading one exact URL is not measured on Carbon: send an exact-page read to Grok or Codex ' +
      'research.',
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
      'Primary frontier work and long-context tasks — it trails the frontier Gemini models on overall reasoning/agentic depth and has no long-context retrieval advantage. Use as a corroborating voice, not the lead researcher. Antigravity\'s models page has it leaving on 2026-11-30 (the dates announced before were 2026-11-02, then 2026-11-18); agy 1.5.18 still lists it on 2026-11-26, and it leaves the catalog when agy stops listing it.',
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
 *      Claude Low tiers, Gemini 4 Carbon (Low), the three Orchestrator rows and
 *      the swept Argon, Hydrogen (XHigh) and 3.8 Flash ids today, a next model
 *      tomorrow) out of the agy path until the catalog says so. agy itself would
 *      happily run them.
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
  '8.6 min per task); per Google >2.3x more resilient than 3.8 Flash on Gray Swan ' +
  'prompt injection, which matters: every unit reads untrusted web content; ' +
  'Hydrogen (Low)=quick facts, lookups & short summaries (AA at low: Index 27, $0.29); ' +
  'Hydrogen (Medium)=when High\'s latency or token spend is unwanted (AA at medium: Index 41, $0.80); ' +
  'Gemini 4 Neon (High)=the step up from Hydrogen, terminal agents and terminal science included, named per call ' +
  'when depth pays, and the tie-breaker when Grok and Hydrogen disagree (AA at high: Index 60 at $3.74 and 14.8 ' +
  'min); on the shared Gemini pool, but not the default and not for sweeps; ' +
  'Neon (XHigh)=two Index points over High (AA at xhigh: 62) for 1.7x its cost; ' +
  'Neon (Medium)=about Hydrogen (High)\'s AA cost and time, Index 55 to its 51; ' +
  'Neon (Low)=the lightest Neon (AA at low: Index 44, $0.75), weak on terminal work; ' +
  'Gemini 4 Carbon (High)=named call past Neon (High): terminal agents, hard reasoning (AA: Index tie, 2.1x $, ' +
  '2.9x time; Medium under Neon bar CritPt); ' +
  'Claude Opus 5.5 (High|Medium) and Claude Sonnet 5.5 (High|Medium)=Antigravity\'s SEPARATE Claude quota, and a ' +
  'SMALL one: one named call per question — an independent Opus read, a hard verification pass, a cheap Sonnet ' +
  'cross-check — when the Claude Code pool is the constraint; never the default, never a sweep, never a ' +
  'deep-research stage (gemini_deep_research refuses Claude ids), never configured as gemini.model (gemini_research and gemini_image refuse a Claude default); the same generation as the fleet\'s own roles, so ' +
  'an independent read, not a stronger one; prefer Gemini for citation-heavy research; ' +
  'GPT-OSS 120B (Medium)=non-Google open-weights second opinion / math cross-check (near o4-mini, ' +
  'MMLU ~90%), NOT a primary frontier researcher and no long-context edge. ' +
  'Omit the model param to keep agy\'s default.';
