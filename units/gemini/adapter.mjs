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
 * OUTPUT CAP — core/spawn.mjs keeps only the LAST `outputCap` characters of
 * stdout (config `outputCap`, fleet default 400 000). agy prints ONE JSON
 * envelope, so a cap that bites almost always leaves a front-truncated object
 * that parseAgyResult rejects — and the raw-stdout fail-open, which exists for a
 * CLI that printed plain text, would then hand back the middle of an envelope as
 * the answer. A capped run whose envelope no longer parses therefore THROWS and
 * names `gemini.outputCap`; isDeterministic skips the retry, because the same
 * run hits the same cap and is paid for twice. The one capped run that still
 * parses is the one whose dropped front was a preamble the envelope survived
 * intact: it comes back with the capped marker and partial: true. A hard kill is
 * answered first, as everywhere else, with both markers on the salvaged text.
 *
 * CANCELLATION — the same SIGKILL answers a cancelled request (`cancel: kill`),
 * and core/spawn.mjs tells the two apart with `cancelled: true`. The salvage is
 * identical; only the wording changes, because neither bound was reached and
 * "raise gemini.timeoutS" would send the operator after a limit that held.
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
 *   THE ANSWER IS THE BARE PATH, stat-ed, never agy's prose about it: a run
 *   that was capped, hard-killed or cancelled with the file already saved
 *   returns the path ALONE and carries its incompleteness as `partial: true`
 *   into the status feed and the spooled record, and a run with no file on
 *   disk is an error naming the bound that explains it (core/artifact.mjs).
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
 * A cancelled request (cancel: kill) stops the pipeline: the gathers that have
 * not started are skipped, and the synthesis is either never started or killed
 * inside it — either way what comes back is the raw findings under a
 * cancellation note, never an error that loses what was already paid for.
 * The stage ids are REPORTED through ctx.usedModel the moment stageModels
 * resolves and before the first stage spawns, so the spooled result names them
 * whether the run finished, was cancelled or died on the output cap:
 * `<id> (decompose, gather) + <id> (synth)`, collapsed to the single id when an
 * explicit model made every stage the same (deepResearchModel). gemini_research
 * and gemini_image report NOTHING on purpose — agy picks their model and never
 * says which — so those stay filed under `(vendor default)`.
 */
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { OUTPUT_CAP } from '../../core/spawn.mjs';
import { defineUnit } from '../../core/unit.mjs';
import { makeCatalog } from '../../core/catalog.mjs';
import { artifactMiss, extractImagePath } from '../../core/artifact.mjs';
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
 * fails the `{` check. Null therefore means one of two things, and only the
 * run's `capped` flag tells them apart: a CLI that printed plain text (fail
 * open to it) or an envelope the cap cut open (throw — see interpretAgy).
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
 * @param {{stdout:string, stderr:string, code:number|null, killed:boolean, capped?:boolean, cancelled?:boolean}} res
 * @param {{timeoutS:number, capped?:boolean, outputCap?:number}} o
 *   capped defaults to the run's own flag; outputCap is the tail cap the run was
 *   spawned under and is quoted in the messages, because raising it is the fix.
 * @returns {{text:string, structured:*, usage:*, status:string, partial?:boolean}}
 */
export function interpretAgy(res, { timeoutS, capped = res.capped, outputCap = OUTPUT_CAP }) {
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
  // THE TAIL CAP DROPS THE BEGINNING of stdout, so a capped run is never a whole
  // answer: every path out of here that returns text marks it and flags it partial.
  const capMark = (text) => (capped && text
    ? `${text}\n\n[gemini: output capped at ${outputCap} chars — the beginning of the stream was dropped; treat the answer as partial]`
    : text);
  // agy prints ONE envelope. Capped and it no longer parses means the answer was
  // cut open and `answer` is the raw fail-open fragment — never an answer.
  const fragmentOnly = !!capped && !parsed;
  // Success path first: exit 0 + a non-empty answer + not hard-killed + agy
  // itself reporting success — a SUCCESSFUL answer is never scanned for
  // exhaustion (answers ABOUT quotas must not be misread as an empty bucket).
  if (code === 0 && answer && !killed && !fragmentOnly && (!status || status === 'SUCCESS')) {
    return capped ? { ...result, text: capMark(answer), partial: true } : result;
  }
  // Failed turn — now the exhaustion patterns disambiguate the CAUSE.
  if (EXHAUSTED_PATTERNS.some((re) => re.test(`${errBuf}\n${out}`))) {
    throw new Error('Gemini quota exhausted — the Antigravity bucket is empty; try after the window resets.');
  }
  // A hard kill discards nothing it had already produced: `answer` came out of
  // the same envelope reading the clean path uses, so it is returned marked.
  // The kill is answered FIRST, cap or no cap — the salvage is the older promise
  // — and a fragment is the one thing never salvaged here.
  if (killed) {
    const after = timeoutS + HARD_KILL_GRACE_MS / 1000;
    // The same SIGKILL ends a cancelled request; `cancelled` says which it was,
    // and a client that stopped the run is not a timeoutS to raise.
    const killMark = res.cancelled
      ? '[gemini: cancelled by the client — treat the answer as partial]'
      : `[gemini: hard-killed after ${after}s — treat the answer as partial; raise gemini.timeoutS in the fleet config]`;
    if (answer && !fragmentOnly) {
      return {
        ...result,
        text: capMark(`${answer}\n\n${killMark}`),
        partial: true,
      };
    }
    // A cancelled run has no answer because the caller asked for none: neither
    // bound was reached, so neither is named.
    if (res.cancelled) throw new Error('agy cancelled by the client');
    if (capped) throw new Error(`agy hard-killed after ${after}s and output exceeded the ${outputCap} char cap — raise gemini.timeoutS or gemini.outputCap in the fleet config`);
    throw new Error(`agy hard-killed after ${after}s (raise gemini.timeoutS in the fleet config)`);
  }
  if (fragmentOnly) {
    throw new Error(`agy output exceeded the ${outputCap} char cap and the answer envelope was lost — raise gemini.outputCap or narrow the task`);
  }
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
  if (notes.length) {
    return { ...result, text: capMark([answer, ...notes].join('\n\n')), ...(capped ? { partial: true } : {}) };
  }
  // Exit 0 with NO output but a talkative stderr: agy "succeeded" without
  // producing anything, and the cause (typically a headless permission
  // auto-deny: 'a tool required the "read_url" permission...') is sitting on
  // stderr. Surface it — a blank that reads as a model shrug cost a real
  // debugging session (2026-08-02).
  if (!answer && errBuf.trim()) throw new Error(`agy produced no output: ${errBuf.trim().slice(-500)}`);
  // Pre-existing tolerance kept: non-zero exit with SOME output resolves the
  // partial answer; exit 0 with silent empty output resolves '' (retry handles
  // it) — there is no text for a marker to attach to on that last path.
  return result;
}

/**
 * Deterministic failures a retry cannot fix — including the cap (the same run
 * hits the same cap) and a run the client cancelled (nobody is waiting for it).
 */
const isDeterministic = (e) => /quota exhausted|permission|hard-killed|not found in PATH|output exceeded|cancelled by the client/i.test((e && e.message) || '');

/**
 * One agy one-shot through the runtime.
 * @param {{prompt:string, model?:string, acceptEdits?:boolean, schema?:object, cwd?:string}} a
 */
async function runAgyRaw(ctx, { prompt, model, acceptEdits = false, schema, cwd }) {
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
  const r = interpretAgy(res, { timeoutS, outputCap: ctx.cfg.outputCap });
  if (r.usage) ctx.log(`agy done · status=${r.status} · tokens in=${r.usage.input ?? '?'} out=${r.usage.output ?? '?'}`);
  return { out: r, res };
}

/** The answer alone — what research and every deep-research stage needs. */
const runAgy = async (ctx, a) => (await runAgyRaw(ctx, a)).out;

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

/**
 * The `model:` one deep-research call is filed under, for core/unit.mjs's
 * `ctx.usedModel`. `stageModels` hands decompose and gather the SAME id by
 * construction, so the composite names that one and the synthesis id —
 * `<id> (decompose, gather) + <id> (synth)` — and collapses to the id alone
 * when the two are the same, which is every explicit `model` and any catalog
 * offering a single balanced entry. An id is a non-empty string and nothing
 * else: a catalog that offers no balanced Flash produces no report, and no
 * report leaves the result filed under `(vendor default)`, exactly as it was
 * before this existed. Exported for tests.
 */
export function deepResearchModel(stage) {
  const id = (v) => (typeof v === 'string' ? v.trim() : '');
  const gather = id(stage && stage.gather) || id(stage && stage.decompose);
  const synth = id(stage && stage.synth) || gather;
  if (!gather || synth === gather) return gather || synth;
  return `${gather} (decompose, gather) + ${synth} (synth)`;
}

/** The synthesis produced NOTHING: it was never started, or killed with an empty hand. */
const CANCELLED_NOTE =
  '> **Cancelled — the synthesis stage did not run.** What follows is the raw ' +
  'per-sub-question findings, unsynthesised.\n\n';

/**
 * …and the other one: the synthesis DID run and was cut open mid-report, so
 * saying it never ran would misdescribe the fragment printed under the findings.
 */
const CANCELLED_MID_SYNTH_NOTE =
  '> **Cancelled — the synthesis stage was cancelled before it finished.** What ' +
  'follows is the raw per-sub-question findings; the partial synthesis, as far as ' +
  'it got, is appended after them.\n\n';

/** Printed verbatim when decomposition failed and the "deep" run is one shallow pass. */
const DEGRADED_BANNER =
  '> **Degraded run — decomposition failed.** What follows is a SINGLE-PASS answer to '
  + 'the original question, not a multi-source deep-research report. Treat its coverage '
  + 'accordingly.';

/**
 * DECOMPOSE → parallel GATHER → SYNTHESIZE, each stage one agy one-shot — so
 * each stage can come back `partial` (a hard kill whose text was salvaged, an
 * output-capped envelope). A report synthesized out of partial stages is a
 * partial report: the count is stated under the title and the flag travels out
 * with it, because a reader who cannot see the stages cannot see the gap.
 * A gather that THREW is not a partial stage — it produced no text at all, and
 * its `_(gather failed: …)_` line already stands where the finding would be.
 * A cancelled run has no synthesis to speak of — the stage is never started,
 * killed with nothing printed, or killed after a fragment — so all three come
 * back as the FINDINGS, partial, with any fragment appended under a marker.
 * The findings are what was paid for; a half-written report is not a report.
 * @returns {Promise<{text:string, partial:boolean}>}
 */
async function runDeepResearch(ctx, { question, maxSubquestions, model }) {
  const cap = Math.min(5, Math.max(1, Number(maxSubquestions) || 3));
  const stage = stageModels(ctx.catalog, model);
  // Filed BEFORE the first stage spawns, so a run that is cancelled or capped
  // on its way through is still recorded under the models it ASKED for — the
  // only models anyone could name afterwards. An explicit or configured id
  // outranks this report in core/unit.mjs's finish(), and an empty one is not
  // a report at all.
  ctx.usedModel(deepResearchModel(stage));
  // `ctx.signal` exists only under `cancel: kill` (core/unit.mjs). A cancelled
  // request buys nothing by starting another stage: the spawn would be
  // SIGKILLed the moment it started, on quota the operator already spent.
  const cancelled = () => !!(ctx.signal && ctx.signal.aborted);

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
    if (cancelled()) return { text: `### Sub-question ${i + 1}: ${sq}\n\n_(cancelled before this sub-question ran)_`, partial: false };
    try {
      const r = await runAgyWithRetry(ctx, {
        prompt:
          NO_GIT_PREFIX +
          'Research this question using web search grounding. Cite sources with ' +
          `URLs. Be thorough but concise.\n\nQuestion: ${sq}`,
        model: stage.gather,
      });
      return { text: `### Sub-question ${i + 1}: ${sq}\n\n${r.text}`, partial: !!r.partial };
    } catch (e) {
      return { text: `### Sub-question ${i + 1}: ${sq}\n\n_(gather failed: ${(e && e.message) || e})_`, partial: false };
    }
  }));

  if (cancelled()) {
    ctx.log('deep research · cancelled — the synthesis stage was not started');
    // A report that never reached synthesis is partial whatever its stages did.
    return { text: CANCELLED_NOTE + findings.map((f) => f.text).join('\n\n---\n\n'), partial: true };
  }

  let synth;
  try {
    synth = await runAgyWithRetry(ctx, {
      prompt:
        NO_GIT_PREFIX +
        'Synthesize the research findings below into a markdown report with the ' +
        'sections: Summary, Findings, Sources, Gaps & Confidence. Merge duplicate ' +
        'sources, flag contradictions, and be explicit about uncertainty.\n\n' +
        `Original question: ${question}\n\n${findings.map((f) => f.text).join('\n\n---\n\n')}`,
      model: stage.synth,
    });
  } catch (e) {
    // The cancel can land INSIDE the synthesis: the SIGKILL leaves that stage
    // with no text of its own, and letting the error out would throw away every
    // gather the operator already paid for. Same salvage as the pre-synthesis
    // return above — the findings, unsynthesised, under the same note.
    if (!cancelled() && !/cancelled by the client|^cancelled$/i.test((e && e.message) || '')) throw e;
    ctx.log('deep research · cancelled during synthesis — the findings are returned unsynthesised');
    return { text: CANCELLED_NOTE + findings.map((f) => f.text).join('\n\n---\n\n'), partial: true };
  }

  // A cancel that lands MID-SYNTHESIS while agy had already printed something
  // never reaches the catch above: interpretAgy salvages that fragment as a
  // partial answer and returns normally. Returning it alone would hand back
  // half a report and silently drop every finding behind it — so the findings
  // come back the same way they do on the other two cancellation paths, with
  // the fragment kept under a marker saying what it is.
  if (cancelled()) {
    ctx.log('deep research · cancelled mid-synthesis — the findings are returned with the partial synthesis');
    // The note follows the FRAGMENT, not the path: a salvage that came back
    // empty-handed is a run whose synthesis produced nothing, and that is what
    // CANCELLED_NOTE says.
    const fragment = synth.text ? `\n\n---\n\n[gemini: partial synthesis, cancelled]\n\n${synth.text}` : '';
    return {
      text: (fragment ? CANCELLED_MID_SYNTH_NOTE : CANCELLED_NOTE)
        + findings.map((f) => f.text).join('\n\n---\n\n') + fragment,
      partial: true,
    };
  }

  // The stages that RAN: decompose, one per sub-question, synthesis. A gather
  // that threw is counted here (it ran, it was paid for) and never in the
  // partial count above.
  const stages = [!!decompose.partial, ...findings.map((f) => f.partial), !!synth.partial];
  const partialCount = stages.filter(Boolean).length;
  const head = [];
  if (degraded) head.push(DEGRADED_BANNER);
  if (partialCount) head.push(`[gemini: ${partialCount} of ${stages.length} stages returned partial answers]`);
  return { text: [...head, synth.text].join('\n\n'), partial: partialCount > 0 };
}

// --- tool table ---------------------------------------------------------------

/**
 * Pre-spawn validation of an optional run directory — the same three checks,
 * and the same wording, the grok and codex review tools use. agy has no cwd
 * flag of its own, so this value reaches the run as the SPAWN cwd alone.
 */
function checkCwd(raw) {
  if (raw === undefined) return { cwd: '' };
  const cwd = typeof raw === 'string' ? raw.trim() : '';
  if (!cwd || !isAbsolute(cwd)) return { error: `Error: "cwd" must be an absolute path (got ${JSON.stringify(raw)}).` };
  let st;
  try { st = statSync(cwd); } catch { st = null; }
  if (!st || !st.isDirectory()) return { error: `Error: "cwd" is not an existing directory: ${cwd}` };
  return { cwd };
}

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
  instructions: 'This unit: Gemini via the Antigravity CLI (agy). Web-grounded research (gemini_research), multi-source deep research (gemini_deep_research — about 5 CLI runs and minutes per call, use deliberately), multimodal reads of local images and PDFs (absolute path, and say "view the file directly, no terminal commands" — shell tools are auto-denied), image generation. The weakest sandbox in the fleet: its read-only posture is a permission policy, not a kernel.',
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
        'The run happens where `cwd` points when you give one, else in the MCP ' +
        "server's own process cwd. " +
        'MULTIMODAL: Gemini can read local files INCLUDING IMAGES and PDFs — give the ' +
        'ABSOLUTE path in the prompt and say "view the file directly, no terminal ' +
        'commands" (verified 2026-08-02: screenshots, UI mocks, docs). ' +
        'Optionally choose a model with `model` (omit for the default). ' + GUIDE,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The research question or task for Gemini.' },
          cwd: {
            type: 'string',
            description:
              'Optional ABSOLUTE path to the directory the run happens in (must ' +
              'exist; used as the spawn cwd — agy takes no cwd flag). Defaults to ' +
              'the MCP server\'s process cwd.',
          },
          model: MODEL_PROP,
        },
        required: ['prompt'],
      },
      async run(args, ctx) {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return { text: 'Error: "prompt" is required.', isError: true };
        const c = checkCwd(args.cwd);
        if (c.error) return { text: c.error, isError: true };
        const acceptEdits = ctx.mode === 'workspace-write';
        const r = await runAgyWithRetry(ctx, { prompt: NO_GIT_PREFIX + prompt, model: ctx.model, acceptEdits, cwd: c.cwd || undefined });
        return { text: r.text, usage: r.usage, ...(r.partial ? { partial: true } : {}) };
      },
    },
    {
      name: 'gemini_image',
      kind: 'image',
      description:
        'Ask Gemini (via the local agy CLI) to generate an image from a text description. ' +
        'Returns the absolute path to the saved image file — the run happens in a ' +
        'throwaway temp directory, OUTSIDE every project, so copy the file where ' +
        'you need it. The answer is the bare path and nothing else: a run that was ' +
        'capped, killed or cancelled with the file already saved returns that path ' +
        'and is flagged partial in the status feed, and a run with no file on disk ' +
        'is an error. Use ONLY for image generation. Optionally choose a model ' +
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
        const { out, res } = await runAgyRaw(ctx, {
          prompt: IMAGE_PREFIX + prompt,
          model: ctx.model,
          acceptEdits: true,
          cwd,
        });
        // THE BARE PATH IS THE CONTRACT: the caller stats what comes back, so
        // agy's prose — and any marker interpretAgy appended to it — stops
        // here, and a path the model asserts but never wrote is not an
        // artifact, which is what extractImagePath's stat is for.
        const artifact = extractImagePath(out.text);
        if (!artifact) {
          const miss = artifactMiss('gemini', res, {
            outputCap: ctx.cfg.outputCap,
            // agy's process-group kill sits 60 s above the timeout it is
            // handed, and that sum is the number every other gemini message
            // quotes — an operator raising `timeoutS` moves both.
            timeoutS: ctx.cfg.timeoutS + HARD_KILL_GRACE_MS / 1000,
          });
          return {
            text: `Error: gemini_image finished without a saved image on disk (temp dir ${cwd}${miss ? `; ${miss}` : ''}). Raw output: `
              + ((out.text || '(empty)').slice(-1000)),
            isError: true,
          };
        }
        ctx.log(`gemini_image · artifact=${artifact}`);
        return { text: artifact, usage: out.usage, ...(out.partial ? { partial: true } : {}) };
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
        const r = await runDeepResearch(ctx, { question, maxSubquestions: args.maxSubquestions, model: ctx.model || undefined });
        // A report standing on a partial stage is partial: the flag reaches the
        // status feed next to the count line the text already carries.
        return { text: r.text || '(empty deep-research report)', ...(r.partial ? { partial: true } : {}) };
      },
    },
  ],
});
