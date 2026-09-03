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
 * The CLI binary embeds more names than the plan accepts, so presence in the
 * binary is not enough. Re-verify when Codex auto-updates.
 *
 * WHAT IS IN / OUT: the catalog lists what EXISTS in the current generation,
 * not what one account happens to accept — a ChatGPT Pro subscriber gets
 * `gpt-5.6-sol`, a Plus subscriber gets the loud, exact rejection above and
 * knows why. `gpt-5.5` (Apr 2026) and `gpt-5.4` (Mar 2026) work on every plan
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
 *
 * Effort is NOT part of the id (unlike agy): it is `model_reasoning_effort`,
 * a separate config knob, so this catalog owns the EFFORTS allowlist. The
 * five values below are the ones the 0.146.0 binary names; `none`/`max` were
 * mentioned in research but are unverified for the CLI and are left out.
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
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    family: 'gpt',
    effort: 'high',
    tier: 'balanced',
    useFor:
      'The fleet default, OpenAI\'s recommended default for Codex CLI, and Codex\'s own default in ~/.codex/config.toml. ' +
      'Agentic terminal work, directory-scale code reading and review, grounded research with web search. ' +
      'Terminal-Bench 2.1 87.4 vs 88.8 for the Pro-only flagship sol at roughly half the compute; ' +
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
      'The efficiency tier — ~4-5x faster than sol and the cheapest 5.6 (API $0.20/$1.20 per Mtok vs terra\'s $2/$12; ' +
      'on the ChatGPT plan that shows up as lighter quota use). Routing, classification, single-file questions, quick ' +
      'lookups, short summaries, mechanical single-file review. Terminal-Bench 2.1 84.7.',
    avoid:
      'Anything spanning modules or files — sharp degradation on cross-module dependencies and multi-file diffs. ' +
      'Long inputs: retrieval collapses past ~200K tokens (~41% recall across the full window vs terra\'s ~91%). ' +
      'Higher hallucination on code-symbol resolution and drift on negative constraints ("do not touch X") in multi-turn ' +
      'sessions — never the unit for a review whose brief is mostly prohibitions. Step up to terra.',
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    family: 'gpt',
    effort: 'high',
    tier: 'heavy',
    useFor:
      'The 5.6 flagship — deepest reasoning, complex multi-step planning, high-stakes agentic work. Terminal-Bench 2.1 ' +
      '88.8 (vs terra 87.4); SWE-bench Pro 64.6 (vendor-reported). PLAN-GATED: available on ChatGPT Pro / Enterprise ' +
      '(or API billing, which this fleet deliberately never uses). On a Plus/Team plan the call fails before any work ' +
      'with "The \'gpt-5.6-sol\' model is not supported when using Codex with a ChatGPT account" — pick terra instead.',
    avoid:
      'Everything terra already handles — sol is baseline speed at roughly twice the compute for a ~1.4-point ' +
      'Terminal-Bench gain, so it earns its cost only on genuinely hard architecture, proof, or root-cause work. ' +
      'Not a reason to upgrade the plan: verify your account accepts it (`codex exec -m gpt-5.6-sol "Reply OK"`) ' +
      'before routing anything here.',
  },
];

/** Reasoning-effort allowlist (`model_reasoning_effort`), as the 0.146.0 binary names them. */
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

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
  'Pick by task, not by name. gpt-5.6-terra (high)=the fleet default for delegated review and research on ' +
  'Codex — agentic terminal work, directory-scale code reading and grounded web research in a kernel-enforced ' +
  'read-only sandbox (Terminal-Bench 2.1 87.4, ~91% recall across 1M context); gpt-5.6-luna (medium)=the fast ' +
  'cheap tier for single-file questions, lookups, routing and short summaries — NOT for multi-file work or long ' +
  'inputs (retrieval collapses past ~200K) and not for prohibition-heavy briefs (drifts on "do not"). Use `effort` ' +
  'to trade depth for speed on terra: minimal/low for sweeps, high (default) for review, xhigh only for ' +
  'architecture, proofs, or root-cause hunts; gpt-5.6-sol (high)=the flagship for the hardest of those, but it is ' +
  'PLAN-GATED to ChatGPT Pro/Enterprise — on Plus/Team it fails fast with an explicit "not supported" error, so ' +
  'confirm your plan accepts it before routing there. Codex is the fleet\'s strongest coder but never its source ' +
  'of record — verify facts. Omit `model` to keep the fleet default.';
