/**
 * omelette-fleet :: units/codex/models.js
 * The Codex model catalog + the `model` / `effort` allowlists + the cheat-sheet.
 *
 * Ids are the exact strings `codex exec -m <id>` accepts. Codex resolves an
 * unknown id to "fallback metadata" and then the API rejects it with HTTP 400
 * (`turn.failed`, exit 1) — loud, but only after a full spawn; the allowlist
 * catches it before any process starts.
 *
 * VERIFIED LIVE 2026-09-03 (codex-cli 0.146.0, ChatGPT-plan account, one
 * `codex exec -m <id> "Reply OK"` per id, success = reached turn.completed):
 *   ACCEPTED  gpt-5.6-terra · gpt-5.6-luna · gpt-5.5 · gpt-5.4
 *   REJECTED  gpt-5.6-sol · gpt-5.6 · gpt-5.6-pro · gpt-5.3-codex ·
 *             gpt-5.2-codex · gpt-5.1-codex-mini — every one with the same
 *             message: "The '<id>' model is not supported when using Codex
 *             with a ChatGPT account."
 * RE-CONFIRMED 2026-09-03 on codex-cli 0.153.0: terra and luna both still
 * reach the API (luna answered the effort probe below; terra answered every
 * bridge call). sol and the rejected ids were NOT re-tested on 0.153.0 —
 * the lines above stand on the 0.146.0 sweep.
 * VERIFIED LIVE 2026-09-05 (codex-cli 0.153.4, same ChatGPT-plan account):
 *   ACCEPTED  gpt-6-astra — at effort low, high, xhigh AND max (four
 *             one-shot probes, each answering "OK"), so `doctor
 *             --probe-models` (effort low) is verified for it too.
 *   REJECTED  gpt-6-astra-pro · gpt-6-pro · gpt-6 — same "not supported when
 *             using Codex with a ChatGPT account" message as sol.
 *   Also on 0.153.4: the CLI made gpt-6-astra its OWN bundled default when no
 *   model is configured (0.153.1 added it as configurable only). This fleet
 *   still pins explicitly — the catalog head, which was astra too until
 *   2026-09-30 (see below).
 * The CLI binary embeds more names than the plan accepts, so presence in the
 * binary is not enough. Re-verify when Codex auto-updates.
 * VERIFIED LIVE 2026-09-30 (codex-cli 0.157.1, then 0.159.2 after the
 * operator's update, same ChatGPT plan; one-shot `codex exec
 * --ignore-user-config -c model_reasoning_effort=low -m <id>` per id, plus
 * `omelette-fleet doctor --probe-models`):
 *   ACCEPTED  gpt-6-sol and gpt-6-luna (on 0.157.1 and 0.159.2); gpt-6-astra,
 *             gpt-5.6-terra, gpt-5.6-luna AND gpt-5.6-sol (`--probe-models`;
 *             sol's 2026-09-03 rejection above no longer holds);
 *             gpt-6.1-sol on 0.159.2, at effort low and at `ultra`.
 *   REJECTED  gpt-6.1-sol on 0.157.1 — "not supported when using Codex with a
 *             ChatGPT account" plus "Model metadata for gpt-6.1-sol not
 *             found": the CLI lacked its metadata, not the plan. 0.159.2
 *             accepts it on the same account.
 *   `codex debug models` on 0.159.2 (free, no model run): the `list` entries
 *   by priority 1–9 are gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna,
 *   gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna (gpt-5.5 further down, retiring
 *   2026-10-14 in favour of gpt-5.6-sol). Codex's own default reasoning per
 *   model, in the server-refreshed catalog (the binary's `--bundled` one says
 *   low for astra): gpt-6.1-sol low, gpt-6-astra, gpt-6-sol and gpt-6-luna medium —
 *   the fleet runs its own: each entry's `effort` is that model's pairing, and
 *   since 1.6.1 it is APPLIED — a run's effort is the call's, else the one the
 *   operator configured (file or CODEX_EFFORT), else the pairing of the model
 *   it resolved to, else the unit's built-in xhigh (the adapter's
 *   `pairedEffort: true`; core/unit.mjs, EFFORT). Effort levels
 *   low … max plus `ultra` on every model here except the two lunas, which
 *   stop at max. The context window inside Codex is 272000 for every model,
 *   against 1.05M on the API: the long-context figures below are API
 *   figures. The refreshed catalog marks no 5.6 tier deprecated; the one
 *   bundled with the binary shows migration prompts from the 5.6 tiers to
 *   gpt-6-sol / gpt-6-luna.
 *   THE LESSON: codex-cli 0.159.1 made gpt-6.1-sol its bundled default (release
 *   note: "Added GPT-6.1 Sol as the default model in the bundled catalog"), so
 *   the CLI's default moved from astra to 6.1-sol under the fleet without a
 *   fleet change. Nothing ran on it silently — this unit pins `-m` on every
 *   spawn — but the catalog no longer described the CLI. That is why
 *   `omelette-fleet doctor` prints the codex CLI's bundled default beside the
 *   model the fleet pins (`codex debug models --bundled`).
 *
 * WHAT IS IN / OUT: the catalog lists what EXISTS in the current generation,
 * not what one account happens to accept — an account that is refused an id
 * gets the loud, exact rejection above and knows why; `doctor --probe-models`
 * says which ids yours accepts. `gpt-5.5` (Apr 2026) and `gpt-5.4` (Mar 2026) work on every plan
 * but offer nothing 5.6-terra/luna don't — same 1M window, no Programmatic
 * Tool Calling — and exist for prompt-template backward compatibility
 * (research 2026-09-03); they are left out like a retired Gemini generation.
 * Re-add by hand if you need one. `gpt-5.6` is an alias of sol (not listed —
 * pick the explicit id). `gpt-5.6-pro` is not a model id at all.
 * `gpt-5.6-cyber` is API-only / restricted.
 *
 * NUMBERS below come from a web-grounded research pass (2026-09-03): Terminal-
 * Bench 2.1 figures are leaderboard-reported on one harness; long-context
 * recall figures are third-party (Vellum / Artificial Analysis class); SWE-
 * bench Pro for sol is vendor-reported. GPQA Diamond, HLE, ARC-AGI-2 and AIME
 * are NOT published per 5.6 sub-tier — do not invent them on the next sweep.
 * The GPT-6 figures (2026-09-30) each name their source class: `vendor` —
 * OpenAI's announcements of 2026-09-22 (gpt-6-sol, gpt-6-luna) and 2026-09-29
 * (gpt-6.1-sol); `AA` — Artificial Analysis, read 2026-09-30 (Intelligence
 * Index at max effort, price, cost per Index task, output speed); `probed` —
 * this machine, codex-cli 0.159.2. The 6.1-sol announcement gives DeepSWE,
 * Terminal-Bench 4.0, HLE and OSWorld as charts only, so no absolute figure is
 * written for it — relative vendor claims are quoted as claims.
 *
 * EFFORT is NOT part of the id (unlike agy): it is `model_reasoning_effort`,
 * a separate config knob, so this catalog owns the EFFORTS allowlist. The six
 * values below are the API's OWN list, quoted back by its rejection message:
 * "Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and
 * 'max'". VERIFIED LIVE 2026-09-03 (codex-cli 0.153.0, gpt-5.6-terra):
 * `none`, `max` and `xhigh` each answered normally.
 *   `minimal` is GONE — refused by every model in this catalog with an HTTP
 *   400 (`unsupported_value` on reasoning.effort), on terra and on luna, with
 *   or without --ignore-user-config. It was in this list because the previous
 *   sweep read the effort names out of the 0.146.0 BINARY's strings. THE
 *   LESSON FOR THE NEXT SWEEP: what the binary embeds is not what the API
 *   accepts — probe each value with a real one-shot, exactly as the model ids
 *   above are probed.
 * SUPERSEDED 2026-09-30 (codex-cli 0.159.2): the list is now `low`, `medium`,
 *   `high`, `xhigh`, `max`, `ultra`. `ultra` was probed live on gpt-6.1-sol
 *   (answered OK). `none` is removed: `codex debug models` lists it for no
 *   model in this catalog — no GPT-6 model and none of the 5.6 tiers — and the
 *   2026-09-03 probe above that answered at `none` was on gpt-5.6-terra.
 *
 * Zero deps. Plain ESM (.js).
 */

/**
 * @typedef {Object} CodexModel
 * @property {string} id       exact `-m` value
 * @property {string} label
 * @property {string} family   'gpt'
 * @property {string} effort   default reasoning effort the fleet pairs it with
 * @property {string} tier     'fast' | 'balanced' | 'heavy'
 * @property {string} useFor
 * @property {string} avoid
 */

/** @type {CodexModel[]} */
export const CODEX_MODELS = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    family: 'gpt',
    effort: 'xhigh',
    tier: 'balanced',
    useFor:
      'THE FLEET DEFAULT (operator decision 2026-09-30), at effort xhigh: delegated code review, agentic terminal analysis and grounded research. ' +
      'Released 2026-09-29 (vendor). API $2 input / $0.10 cached / $10 output per 1M tokens (vendor; AA agrees on $2/$10). ' +
      'AA Intelligence Index 52 at max — gpt-6-astra 53, gpt-6-sol 48, gpt-6-luna 37 — at $0.72 per Index task against astra\'s $3.26, 68 tok/s (AA, read 2026-09-30). ' +
      'Vendor claims, relative only: DeepSWE v1.1 "matches GPT-6 Astra at roughly one-fifth of the cost, eclipsing GPT-6 Sol\'s best by 6.4 pp at a lower effort"; ' +
      'OSWorld 2.0 offline +7 pp over GPT-6 Sol at max, within 2.1 pp of Astra; Terminal-Bench Science 0.1 more than double GPT-6 Sol\'s at max, ' +
      '$5.47 per task vs $23.80 for Astra; factual-error share at low effort 11.4 % → 7.7 % vs GPT-6 Sol. ' +
      'Available to Plus, Pro, Business, Enterprise and Edu in Codex (vendor). ' +
      'PROBED 2026-09-30 on codex-cli 0.159.2, ChatGPT plan: ACCEPTED at effort low and at ultra. Since codex-cli 0.159.1 (release note) it is also the CLI\'s ' +
      'own bundled default — `codex exec` with no `-m` prints `model: gpt-6.1-sol`.',
    avoid:
      'Heavy reviews — the pre-release security audit, root-cause hunts, the reviews the session names — go to gpt-6-astra; if 6.1-sol regresses on a task, ' +
      'gpt-6-sol is the fallback. No absolute DeepSWE, Terminal-Bench 4.0, HLE or OSWorld figure is written for it — the announcement gives them as ' +
      'charts only; do not invent one. An older CLI refuses it: codex-cli 0.157.1 REJECTED it ("not supported when using Codex with a ChatGPT account") ' +
      'because it lacked the model\'s metadata, not because of the plan — update Codex. Codex\'s own default reasoning for it is low; the fleet pins the ' +
      'model explicitly and runs it at xhigh. Do not raise above xhigh by default: max and ultra are manual escalation. The "Ultrafast" speed tier is ' +
      'announced, not probed.',
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    family: 'gpt',
    effort: 'xhigh',
    tier: 'heavy',
    useFor:
      'HEAVY REVIEWS ONLY (operator decision 2026-09-30): the pre-release security audit, root-cause hunts, and the reviews the session names. ' +
      'GPT-6 generation, released 2026-09-03 (vendor). It was the fleet default from 2026-09-05 to 2026-09-30 and the CLI\'s bundled default from ' +
      'codex-cli 0.153.4 to 0.159.1; it is neither now. AA Intelligence Index 53 at max, the top of the GPT-6 line (gpt-6.1-sol 52; AA, read 2026-09-30) — ' +
      'the "55 vs sol 51 / terra 47" this entry carried until then was read on an older index version and is not comparable. ' +
      'Leads where a heavy review needs it: security and exploit research (ExploitBench 100.0 vs gpt-5.6-sol\'s 78.5, ExploitGym 42.4 vs 30.3, ' +
      'vendor-reported) and long-context recall (MRCR v2 8-needle 512K–1M 96.3 vs 73.8, vendor-reported — an API figure: inside Codex every model\'s ' +
      'window is 272000); DeepSWE v1.1 74.1 (vendor). ACCEPTED on the ChatGPT plan — probed 2026-09-05 on codex-cli 0.153.4 at effort low, high, xhigh ' +
      'and max, and again 2026-09-30 (`doctor --probe-models`).',
    avoid:
      'Everything short of a heavy review: API $10 / $1 cached / $50 per 1M tokens (vendor and AA), five times gpt-6.1-sol\'s input and output price, $3.26 per AA Index ' +
      'task against its $0.72, and slower — 51 tok/s against its 68 (AA, read 2026-09-30); time-to-first-token 384 s vs gpt-5.6-sol\'s 140 s at max ' +
      'effort (AA, 2026-09-05). Do not raise above xhigh by default: max and ultra are manual escalation. No SWE-bench Pro or comparable ' +
      'Terminal-Bench figure is published for it — do not invent one. OpenAI rates it "Critical" for cyber under its Preparedness Framework and ' +
      'reports reduced chain-of-thought monitorability: keep it read-only and supervised, as this fleet does. `gpt-6-astra-pro`, `gpt-6-pro` and ' +
      '`gpt-6` are REJECTED on a ChatGPT plan with the "not supported when using Codex with a ChatGPT account" message (probed 2026-09-05). ' +
      'Re-verify when Codex auto-updates.',
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    family: 'gpt',
    effort: 'high',
    tier: 'balanced',
    useFor:
      'The previous Sol and the REGRESSION FALLBACK for gpt-6.1-sol: route here when 6.1-sol regresses on a task. Released 2026-09-22 (vendor) at half ' +
      'the 5.6 price: API $2 / $0.20 cached / $10 per 1M tokens (vendor). AA Intelligence Index 48 at max, $1.05 per Index task, 76 tok/s ' +
      '(AA, read 2026-09-30). Vendor: DeepSWE v1.1 68.8 at max; OSWorld 2.0 offline 60.5 at xhigh; AutomationBench 33.2 at xhigh, $0.27 per task. ' +
      'ACCEPTED on the ChatGPT plan — probed 2026-09-30 on codex-cli 0.157.1 and 0.159.2.',
    avoid:
      'Default routing: gpt-6.1-sol has the same $2/$10 price, scores 52 against its 48 on the AA Index and costs $0.72 per Index task against its ' +
      '$1.05 (AA, read 2026-09-30). The context window is disputed — AA lists 872k, OpenAI says 1.05M; inside Codex it is 272000 either way.',
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    family: 'gpt',
    effort: 'medium',
    tier: 'fast',
    useFor:
      'The cheap fast tier: single-file questions, lookups, routing, short summaries. Released 2026-09-22 (vendor). API $0.10 / $0.01 cached / ' +
      '$0.50 per 1M tokens (vendor). AA Intelligence Index 37 at max, $0.07 per Index task, 142 tok/s (AA, read 2026-09-30). Vendor: DeepSWE v1.1 ' +
      '66.6 at max. ACCEPTED on the ChatGPT plan — probed 2026-09-30.',
    avoid:
      'INHERITED from gpt-5.6-luna until measured otherwise: anything spanning modules or files, long inputs, and prohibition-heavy briefs ' +
      '("do not touch X") — gpt-5.6-luna degraded on all three, and no GPT-6 Luna measurement says otherwise yet. No `ultra` effort ' +
      '(`codex debug models`, codex-cli 0.159.2): its ceiling is max. Step up to gpt-6.1-sol.',
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    family: 'gpt',
    effort: 'high',
    tier: 'balanced',
    useFor:
      'SUPERSEDED by gpt-6-sol (Codex\'s own catalog shows a migration prompt to it); NOT deprecated on OpenAI\'s schedule as of 2026-09-30, where ' +
      'it appears only as a substitute. ' +
      'Was the balanced tier and the step-down from gpt-6-astra (API $2/$12 vs Astra\'s $10/$50; AA Intelligence Index 47 vs 55 on ' +
      'the older index version of 2026-09-05, not comparable with the 2026-09-30 figures above) and the fleet default until 2026-09-05; ' +
      'the step-down is gpt-6-sol now. ' +
      'Agentic terminal work, directory-scale code reading and review, grounded research with web search. ' +
      'Terminal-Bench 2.1 87.4 vs 88.8 for the flagship sol at roughly half the compute; ' +
      'long-context recall ~91.5% across the 1.05M window (third-party). Verified live 2026-09-03: read-only sandbox ' +
      'honoured, web_search items emitted, real token usage in turn.completed.',
    avoid:
      'Long-horizon multi-file engineering that must MUTATE the tree — this fleet runs Codex read-only by default. ' +
      'Fact-critical claims without verification: a strong second opinion, not a source of record. Occasional latency ' +
      'spikes when its verification loops trigger on ambiguous asks — give it precise instructions. Do not reach for ' +
      'effort=xhigh on routine work: adaptive reasoning treats effort as a ceiling and OpenAI discourages xhigh outside ' +
      'architecture, proofs, and root-cause hunts in obfuscated code.',
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    family: 'gpt',
    effort: 'medium',
    tier: 'fast',
    useFor:
      'SUPERSEDED by gpt-6-luna (Codex\'s own catalog shows a migration prompt to it); NOT deprecated on OpenAI\'s schedule as of 2026-09-30, where ' +
      'it appears only as a substitute. ' +
      'The efficiency tier — ~4-5x faster than sol and the cheapest 5.6 (API $0.20/$1.20 per Mtok vs terra\'s $2/$12; ' +
      'on the ChatGPT plan that shows up as lighter quota use). Routing, classification, single-file questions, quick ' +
      'lookups, short summaries, mechanical single-file review. Terminal-Bench 2.1 84.7.',
    avoid:
      'Anything spanning modules or files — sharp degradation on cross-module dependencies and multi-file diffs. ' +
      'Long inputs: retrieval collapses past ~200K tokens (~41% recall across the full window vs terra\'s ~91%). ' +
      'Higher hallucination on code-symbol resolution and drift on negative constraints ("do not touch X") in multi-turn ' +
      'sessions — never the unit for a review whose brief is mostly prohibitions. Step up to gpt-6-sol, which supersedes terra.',
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    family: 'gpt',
    effort: 'high',
    tier: 'heavy',
    useFor:
      'SUPERSEDED by gpt-6-sol (Codex\'s own catalog shows a migration prompt to it); NOT deprecated on OpenAI\'s schedule as of 2026-09-30, where ' +
      'it appears only as a substitute. ACCEPTED on the ChatGPT plan since at least 2026-09-30 (`doctor --probe-models`). ' +
      'The 5.6 flagship — deepest reasoning, complex multi-step planning, high-stakes agentic work. Terminal-Bench 2.1 ' +
      '88.8 (vs terra 87.4); SWE-bench Pro 64.6 (vendor-reported).',
    avoid:
      'Everything terra already handles — sol is baseline speed at roughly twice the compute for a ~1.4-point ' +
      'Terminal-Bench gain, so it earns its cost only on genuinely hard architecture, proof, or root-cause work.',
  },
];

/** Reasoning-effort allowlist (`model_reasoning_effort`) — `codex debug models`' own list since 2026-09-30; see the header. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export const DEFAULT_MODEL = '';

export const ALLOWLIST = CODEX_MODELS.map((m) => m.id);

export function isAllowedModel(id) {
  return typeof id === 'string' && ALLOWLIST.includes(id);
}

export function modelEnum() {
  return ALLOWLIST.slice();
}

export function isAllowedEffort(e) {
  return typeof e === 'string' && EFFORTS.includes(e);
}

export function effortEnum() {
  return EFFORTS.slice();
}

export const GUIDE =
  'Pick by task, not by name. gpt-6.1-sol (xhigh)=THE FLEET DEFAULT for delegated review and research on Codex — ' +
  'AA Intelligence Index 52 against astra\'s 53 at max effort, at $0.72 per Index task against astra\'s $3.26 ' +
  '(AA, read 2026-09-30), kernel-enforced ' +
  'read-only sandbox; gpt-6-astra (xhigh)=heavy reviews only — the pre-release security audit, root-cause hunts, ' +
  'the reviews the session names — strongest on security and exploit research; gpt-6-sol (high)=the regression ' +
  'fallback when 6.1-sol regresses on a task; gpt-6-luna (medium)=the cheap fast tier for single-file questions, ' +
  'lookups, routing and short summaries — NOT for multi-file work, long inputs or prohibition-heavy briefs (inherited ' +
  'from gpt-5.6-luna until measured). gpt-5.6-terra, gpt-5.6-luna and gpt-5.6-sol are superseded by the GPT-6 tiers ' +
  'and stay for regression comparison. Use `effort` to trade depth for speed: low or medium for sweeps, xhigh for ' +
  'review and research; omit it and the named model\'s pairing applies (gpt-6.1-sol and gpt-6-astra xhigh, ' +
  'gpt-6-sol high, the lunas medium) unless the operator configured an effort; do not raise above xhigh by default: ultra and max are manual escalation ' +
  'for architecture, proofs, or root-cause hunts in obfuscated code (the lunas stop at max). Codex is the fleet\'s ' +
  'strongest coder but never its source of record — verify facts. Omit `model` to keep the fleet default.';
