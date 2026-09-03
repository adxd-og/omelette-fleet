/**
 * omelette-fleet :: units/gemini/adapter.mjs
 * Google Gemini via the Antigravity CLI (`agy`) as a fleet unit — four tools:
 * `gemini_research`, `gemini_image`, `gemini_models`, `gemini_deep_research`.
 * Each call spawns `agy -p` headless on the operator's Antigravity (OAuth)
 * subscription. The vendor-specific knowledge below was moved verbatim from
 * the standalone gemini-agy bridge (2026-06 → 2026-09); the plumbing it used
 * to carry itself now lives in core/.
 *
 * OUTPUT — every spawn runs with `--output-format json`, so a turn's outcome is
 * read from an explicit `status` field instead of guessed from how much text
 * came back. Guessing is what let the sibling grok bridge return narration as
 * if it were an answer. Non-JSON stdout falls open to the raw text (runAgy).
 * A non-zero exit or a non-SUCCESS status that STILL produced text keeps the
 * text under a visible marker (`[gemini: CLI exited N — treat the answer as
 * partial]`); only a text-less failure throws.
 *
 * READ-ONLY POSTURE — agy has no kernel sandbox; its `--mode` is a permission
 * policy. Research runs in agy's STANDARD mode: any tool that would prompt is
 * auto-denied headless (and the reason lands on stderr — surfaced here as a
 * loud error, see the "produced no output" branch). The operator's
 * ~/.gemini/antigravity-cli/settings.json `permissions.allow` decides what
 * needs no prompt (read_file, read_url for web research). Git/deploy intent is
 * rejected before spawn (mutateGate) and every prompt carries NO_GIT_PREFIX.
 *   DOCUMENTED LIMITATION: this posture RESTS ON THE OPERATOR'S settings.json.
 *   The CLI has no allow/deny flags to pin it from here — the only
 *   permission-shaped flags it accepts are `--mode accept-edits|plan`,
 *   `--dangerously-skip-permissions` (never passed) and
 *   `--disable-slash-commands` (checked against agy 1.1.25's own --help,
 *   2026-09-03). There is no equivalent of Codex's kernel sandbox.
 *   `--disable-slash-commands` IS passed on every spawn: without it, prompt
 *   text containing `/something` gets slash-command and skill expansion in
 *   print mode — a prompt-injection path into agy's own command surface, for
 *   a feature no headless run needs.
 *   `--mode plan` (agy's read-only planning mode) was evaluated live on
 *   2026-09-03 and NOT adopted: it adds nothing demonstrable over headless
 *   auto-deny — the model reached for the shell `command` tool and was denied
 *   either way. The hook where a research-mode flag would go is marked in
 *   runAgy.
 *   workspace-write (fleet ceiling open + mode set) maps to `--mode
 *   accept-edits` for research: file edits are auto-approved by agy's OWN
 *   permission layer inside the process cwd. That is WEAKER than Codex's
 *   kernel sandbox and is documented as such. agy's `skip` / `sandbox` modes
 *   are never used by this unit.
 *   gemini_image always runs with `--mode accept-edits` regardless of mode —
 *   the image tool must save its artifact — and it runs in a TEMP CWD so even
 *   a cwd-relative save lands outside every project; the operator imports the
 *   file by hand. Its prompt carries the same "no terminal commands" hardening
 *   as the research preamble (IMAGE_PREFIX): the first live image call was lost
 *   to the model reaching for the shell `command` tool, which headless agy
 *   auto-denies.
 *
 * QUOTA — Antigravity exhaustion is detected ONLY on failed turns (non-zero
 * exit / empty output / hard-kill): a successful answer can legitimately
 * DISCUSS quotas and must never be misread as an empty bucket — that exact
 * false positive happened once.
 *
 * MULTIMODAL — agy can read local files INCLUDING IMAGES and PDFs (verified
 * 2026-08-02). Give the ABSOLUTE path in the prompt and say "view the file
 * directly, no terminal commands", because `command` is auto-denied headless.
 *
 * TIMEOUTS — `--print-timeout <timeoutS>s` is handed to agy; the process-group
 * hard kill sits 60 s above it so agy gets to report its own timeout first.
 *
 * BILLING — the OAuth subscription is the only billing path this unit accepts;
 * every API-key env var that could flip agy to metered billing is deleted from
 * the child env.
 *
 * DEEP RESEARCH — reimplemented in-process as DECOMPOSE → parallel GATHER →
 * SYNTHESIZE over agy one-shots, with the decompose stage shape-locked by
 * --json-schema and a visible banner when it degrades to a single pass.
 * Stage models are picked from the catalog by tier/effort so a generation
 * sweep never leaves a stale id behind (the old bridge hard-coded one and
 * silently ran on agy's default after 3.5 Flash was retired).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineUnit } from '../../core/unit.mjs';
import { makeCatalog } from '../../core/catalog.mjs';
import { GEMINI_MODELS, GUIDE } from './models.js';

export const catalog = makeCatalog({
  models: GEMINI_MODELS,
  guide: GUIDE,
  title: 'AGY MODEL CATALOG',
  vendorDefaultNote: 'omit `model` for the fleet default, else agy\'s own default',
});

/** Billing-risk env vars — any of these reaching agy can flip it to metered API-key billing. */
const BILLING_RISK_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
];

/** Exhaustion strings => quota is empty. Checked ONLY on FAILED turns (see header). */
const EXHAUSTED_PATTERNS = [
  /RESOURCE_EXHAUSTED/i,
  /exhausted your (?:current )?quota/i,
  /\bquota\b.*\b(exceeded|exhausted|reached|limit)\b/i,
  /\b(exceeded|exhausted|reached)\b.*\bquota\b/i,
];

// "no terminal commands" is not decoration: headless agy auto-denies the shell
// `command` tool, and a model that reaches for curl instead of read_url ends
// the run with no output (seen live 2026-09-03 on a web-research prompt).
const NO_GIT_PREFIX =
  'You are a read-only research assistant. Use ONLY web search and page reading ' +
  '(read_url) — do NOT run terminal commands, they are unavailable. Do NOT run ' +
  'git, deploy, publish, or modify project files. Answer in plain text.\n\n';

// Same lesson as NO_GIT_PREFIX, learned on the image path (live, 2026-09-03):
// the first gemini_image call died with `a tool required the "command"
// permission that headless mode cannot prompt for` — the model reached for the
// shell instead of its own image tool — and only succeeded on the retry, whose
// prompt spelled out that the shell is not available. The instruction is part
// of the prompt now rather than a thing a retry gets lucky with.
const IMAGE_PREFIX =
  'Use ONLY your built-in image generation tool and save the image directly ' +
  'with it. Do NOT run terminal commands — they are unavailable. Generate an ' +
  'image from the description below and save it to a file, then print the ' +
  'absolute path to the saved file.\n\nDescription: ';

const HARD_KILL_GRACE_MS = 60000;

/**
 * Parse agy's `--output-format json` payload, or null when stdout is not that.
 * The output cap keeps the TAIL, so an over-cap run arrives front-truncated and
 * fails the `{` check — which lands on the intended fail-open path.
 */
export function parseAgyResult(out) {
  const s = String(out || '').trim();
  if (!s || s[0] !== '{') return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/**
 * Interpret one finished agy run. Exported for tests.
 * @returns {{text:string, structured:*, usage:*, status:string}}
 */
export function interpretAgy(res, { timeoutS }) {
  const { stdout: out, stderr: errBuf, code, killed } = res;
  const parsed = parseAgyResult(out);
  // `response` is the answer with agy's own envelope stripped; raw stdout is
  // the fallback for a payload that was not JSON at all.
  const answer = parsed ? String(parsed.response ?? '').trim() : out.trim();
  const status = parsed && typeof parsed.status === 'string' ? parsed.status : '';
  const usage = parsed ? parsed.usage ?? null : null;
  const result = {
    text: answer,
    structured: parsed ? parsed.structured_output ?? null : null,
    usage: usage ? { input: usage.input_tokens ?? null, output: usage.output_tokens ?? null } : null,
    status: status || 'SUCCESS',
  };
  // Success path first: exit 0 + a non-empty answer + not hard-killed + agy
  // itself reporting success — a SUCCESSFUL answer is never scanned for
  // exhaustion (answers ABOUT quotas must not be misread as an empty bucket).
  if (code === 0 && answer && !killed && (!status || status === 'SUCCESS')) return result;
  // Failed turn — now the exhaustion patterns disambiguate the CAUSE.
  if (EXHAUSTED_PATTERNS.some((re) => re.test(`${errBuf}\n${out}`))) {
    throw new Error('Gemini quota exhausted — the Antigravity bucket is empty; try after the window resets.');
  }
  if (killed) throw new Error(`agy hard-killed after ${timeoutS + HARD_KILL_GRACE_MS / 1000}s (raise gemini.timeoutS in the fleet config)`);
  if (code !== 0 && !answer) throw new Error(`agy exited ${code}: ${errBuf.trim().slice(-500) || '(no stderr)'}`);
  // agy says the run did not finish cleanly. Partial text is often the useful
  // part, so keep it — but never let the caller read it as a whole answer.
  const notes = [];
  if (status && status !== 'SUCCESS') {
    if (!answer) throw new Error(`agy run ended with no answer (status=${status})`);
    notes.push(`[gemini: run ended early — status=${status}]`);
  }
  // A non-zero exit with text: same deal — annotated, never thrown away and
  // never passed off as a clean answer.
  if (code !== 0 && answer) notes.push(`[gemini: CLI exited ${code} — treat the answer as partial]`);
  if (notes.length) return { ...result, text: [answer, ...notes].join('\n\n') };
  // Exit 0 with NO output but a talkative stderr: agy "succeeded" without
  // producing anything, and the cause (typically a headless permission
  // auto-deny: 'a tool required the "read_url" permission...') is sitting on
  // stderr. Surface it — a blank that reads as a model shrug cost a real
  // debugging session (2026-08-02).
  if (!answer && errBuf.trim()) throw new Error(`agy produced no output: ${errBuf.trim().slice(-500)}`);
  // Pre-existing tolerance kept: non-zero exit with SOME output resolves the
  // partial answer; exit 0 with silent empty output resolves '' (retry handles it).
  return result;
}

/** Deterministic failures a retry cannot fix. */
const isDeterministic = (e) => /quota exhausted|permission|hard-killed|not found in PATH/i.test((e && e.message) || '');

/**
 * One agy one-shot through the runtime.
 * @param {{prompt:string, model?:string, acceptEdits?:boolean, schema?:object, cwd?:string}} a
 */
async function runAgy(ctx, { prompt, model, acceptEdits = false, schema, cwd }) {
  const timeoutS = ctx.cfg.timeoutS;
  const args = [
    '-p', prompt, '--output-format', 'json', '--print-timeout', `${timeoutS}s`,
    // No headless run needs slash-command / skill expansion of prompt text,
    // and leaving it on makes the prompt an injection path (see header).
    '--disable-slash-commands',
  ];
  // RESEARCH-MODE HOOK: a read-only research flag (`--mode plan`) would go here — evaluated 2026-09-03, not adopted; see header.
  if (typeof model === 'string' && model.trim()) args.push('--model', model.trim());
  if (acceptEdits) args.push('--mode', 'accept-edits');
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  ctx.log(`agy spawn · model=${model || '(agy default)'} · acceptEdits=${acceptEdits} · schema=${schema ? 'yes' : 'no'} · cwd=${cwd || '(process cwd)'}`);
  const res = await ctx.spawn({ args, cwd, hardKillMs: timeoutS * 1000 + HARD_KILL_GRACE_MS });
  const r = interpretAgy(res, { timeoutS });
  if (r.usage) ctx.log(`agy done · status=${r.status} · tokens in=${r.usage.input ?? '?'} out=${r.usage.output ?? '?'}`);
  return r;
}

const runAgyWithRetry = (ctx, a) => ctx.retry(() => runAgy(ctx, a), { skipIf: isDeterministic });

// --- deep research (decompose -> parallel gather -> synthesize) --------------

const SUBQUESTIONS_SCHEMA = {
  type: 'object',
  properties: { subquestions: { type: 'array', items: { type: 'string' } } },
  required: ['subquestions'],
};

/** Extract the first JSON array of strings from model output, fail-soft (fallback for an agy build that drops --json-schema). */
export function parseSubquestions(text, cap) {
  try {
    const m = /\[[\s\S]*?\]/.exec(text);
    if (!m) return null;
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return null;
    const qs = arr.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim());
    return qs.length ? qs.slice(0, cap) : null;
  } catch {
    return null;
  }
}

/** Stage models by catalog shape, not by id — survives generation sweeps. */
export function stageModels(cat, explicit) {
  if (explicit) return { decompose: explicit, gather: explicit, synth: explicit };
  const flash = (effort) => cat.models.find((m) => m.family === 'gemini' && m.tier === 'balanced' && m.effort === effort);
  const medium = flash('Medium') || flash('High');
  const high = flash('High') || medium;
  return { decompose: medium && medium.id, gather: medium && medium.id, synth: high && high.id };
}

async function runDeepResearch(ctx, { question, maxSubquestions, model }) {
  const cap = Math.min(5, Math.max(1, Number(maxSubquestions) || 3));
  const stage = stageModels(ctx.catalog, model);

  const decompose = await runAgyWithRetry(ctx, {
    prompt:
      NO_GIT_PREFIX +
      `Decompose the following research question into at most ${cap} focused, ` +
      'independently-researchable sub-questions, as a JSON object ' +
      `{"subquestions": [...]}.\n\nQuestion: ${question}`,
    model: stage.decompose,
    schema: SUBQUESTIONS_SCHEMA,
  });

  const fromSchema = decompose.structured && Array.isArray(decompose.structured.subquestions)
    ? decompose.structured.subquestions.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim()).slice(0, cap)
    : null;
  let subs = fromSchema && fromSchema.length ? fromSchema : parseSubquestions(decompose.text, cap);

  // Falling back to the bare question turns "deep research" into ONE shallow
  // pass. That used to happen silently; it is now carried out to the caller.
  let degraded = false;
  if (!subs || !subs.length) { subs = [question]; degraded = true; }

  const findings = await Promise.all(subs.map(async (sq, i) => {
    try {
      const r = await runAgyWithRetry(ctx, {
        prompt:
          NO_GIT_PREFIX +
          'Research this question using web search grounding. Cite sources with ' +
          `URLs. Be thorough but concise.\n\nQuestion: ${sq}`,
        model: stage.gather,
      });
      return `### Sub-question ${i + 1}: ${sq}\n\n${r.text}`;
    } catch (e) {
      return `### Sub-question ${i + 1}: ${sq}\n\n_(gather failed: ${(e && e.message) || e})_`;
    }
  }));

  const report = (await runAgyWithRetry(ctx, {
    prompt:
      NO_GIT_PREFIX +
      'Synthesize the research findings below into a markdown report with the ' +
      'sections: Summary, Findings, Sources, Gaps & Confidence. Merge duplicate ' +
      'sources, flag contradictions, and be explicit about uncertainty.\n\n' +
      `Original question: ${question}\n\n${findings.join('\n\n---\n\n')}`,
    model: stage.synth,
  })).text;

  return degraded
    ? '> **Degraded run — decomposition failed.** What follows is a SINGLE-PASS answer to '
      + 'the original question, not a multi-source deep-research report. Treat its coverage '
      + 'accordingly.\n\n' + report
    : report;
}

// --- tool table ---------------------------------------------------------------

const MODEL_PROP = {
  type: 'string',
  enum: catalog.modelEnum(),
  description:
    'Optional. Pick a model per the cheat-sheet below; OMIT to use the fleet default ' +
    '(`gemini.model` in the fleet config, else agy\'s own default). ' +
    'Must be an exact id (call gemini_models for the full guide). ' + GUIDE,
};

export default defineUnit({
  name: 'gemini',
  label: 'Gemini',
  bin: { env: 'AGY_BIN', default: 'agy' },
  billingRiskEnv: BILLING_RISK_ENV,
  // agy's own knobs (AGY_BIN/AGY_*), plus the GEMINI_*/GOOGLE_* namespaces the
  // CLI reads for project + region; the billing scrub runs after this and
  // removes GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY.
  envPassthrough: ['AGY_*', 'GEMINI_*', 'GOOGLE_*'],
  envMap: { model: 'AGY_DEFAULT_MODEL', timeoutS: 'AGY_TIMEOUT_S' },
  builtin: { timeoutS: 300 },
  supportedModes: { 'read-only': true, 'workspace-write': true },
  catalog,
  tools: [
    {
      name: 'gemini_research',
      kind: 'research',
      mutateGate: true,
      description:
        'Delegate a research / Q&A / summarization task to Gemini (via the local agy CLI). ' +
        'READ-ONLY: Gemini must not edit files, run git, or mutate the repo. Returns ' +
        "Gemini's plain-text answer. Use for web-style research, fact synthesis, " +
        'reading & summarizing, or a second-opinion analysis — NOT for code changes. ' +
        'MULTIMODAL: Gemini can read local files INCLUDING IMAGES and PDFs — give the ' +
        'ABSOLUTE path in the prompt and say "view the file directly, no terminal ' +
        'commands" (verified 2026-08-02: screenshots, UI mocks, docs). ' +
        'Optionally choose a model with `model` (omit for the default). ' + GUIDE,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The research question or task for Gemini.' },
          model: MODEL_PROP,
        },
        required: ['prompt'],
      },
      async run(args, ctx) {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return { text: 'Error: "prompt" is required.', isError: true };
        const acceptEdits = ctx.mode === 'workspace-write';
        const r = await runAgyWithRetry(ctx, { prompt: NO_GIT_PREFIX + prompt, model: ctx.model, acceptEdits });
        return { text: r.text, usage: r.usage };
      },
    },
    {
      name: 'gemini_image',
      kind: 'image',
      description:
        'Ask Gemini (via the local agy CLI) to generate an image from a text description. ' +
        'Returns the absolute path to the saved image file — the run happens in a ' +
        'throwaway temp directory, OUTSIDE every project, so copy the file where ' +
        'you need it. Use ONLY for image generation. Optionally choose a model ' +
        'with `model` (omit for the default).',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The image description.' },
          model: MODEL_PROP,
        },
        required: ['prompt'],
      },
      async run(args, ctx) {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return { text: 'Error: "prompt" is required.', isError: true };
        // accept-edits + the MCP server's process cwd would mean a cwd-relative
        // save lands inside whatever project the server was started from. Give
        // the run its own temp directory instead, created before the spawn.
        const cwd = mkdtempSync(join(tmpdir(), 'omelette-gemini-image-'));
        ctx.log(`gemini_image · temp cwd=${cwd}`);
        const r = await runAgy(ctx, {
          prompt: IMAGE_PREFIX + prompt,
          model: ctx.model,
          acceptEdits: true,
          cwd,
        });
        return { text: r.text, usage: r.usage };
      },
    },
    {
      name: 'gemini_models',
      kind: 'catalog',
      description:
        'List the Gemini/GPT-OSS models you can pass as `model` to gemini_research / ' +
        'gemini_image, with a "which model for what" cheat-sheet (speed/cost/strengths ' +
        'and when to avoid each). No arguments. Call this first if unsure which model ' +
        'to pick. Claude Sonnet is intentionally NOT exposed (the manager is Claude natively); Opus 4.6 IS available — separate Antigravity quota.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'gemini_deep_research',
      kind: 'pipeline',
      description:
        'Run a MULTI-SOURCE deep-research pass on Gemini (via the local agy CLI) and ' +
        'return a synthesized markdown report. Pipeline: decompose the question into ' +
        'focused sub-questions, research them IN PARALLEL with grounded web search, ' +
        'then synthesize a report with Summary / Findings / Sources / Gaps-Confidence. ' +
        'HONEST scope: a single decompose->gather->synthesize pass, not iterative, and ' +
        'sources are ASSERTED BY THE MODEL — verify before relying on them. READ-ONLY. ' +
        'This is a LONG call (commonly 3-10 minutes). QUOTA COST: one run is ~5 agy ' +
        'one-shots (decompose + up to 3 gathers + synthesize) — a modest multiplier; ' +
        'use deliberately rather than as the default research mode. ' +
        'Optionally choose a model with `model` (omit for the per-stage defaults). ' + GUIDE,
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The research question to investigate in depth.' },
          maxSubquestions: { type: 'number', description: 'Optional cap on sub-questions (1-5; default 3).' },
          model: MODEL_PROP,
        },
        required: ['question'],
      },
      async run(args, ctx) {
        const question = String(args.question || '').trim();
        if (!question) return { text: 'Error: "question" is required.', isError: true };
        const report = await runDeepResearch(ctx, { question, maxSubquestions: args.maxSubquestions, model: ctx.model || undefined });
        return { text: report || '(empty deep-research report)' };
      },
    },
  ],
});
