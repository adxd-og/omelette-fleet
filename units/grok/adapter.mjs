/**
 * omelette-fleet :: units/grok/adapter.mjs
 * xAI Grok via the Grok Build CLI (`grok`) as a fleet unit — five tools:
 * `grok_research`, `grok_code_review`, `grok_models`, `grok_image`,
 * `grok_image_edit`. Each call spawns `grok -p` headless on the operator's
 * `grok login` subscription. The vendor knowledge below was moved verbatim
 * from the standalone grok-build bridge (2026-07 → 2026-09); the plumbing it
 * used to carry itself now lives in core/.
 *
 * READ-ONLY POSTURE — research / code analysis / second opinions ONLY.
 * Grok has no kernel sandbox and no scoped write mode this fleet trusts, so
 * `workspace-write` is DECLARED UNSUPPORTED (supportedModes) and refused
 * explicitly even with the fleet ceiling open. Enforced in LAYERS on the
 * spawn args (see buildArgs for exactly which layer guarantees what):
 *
 *   L1 `--tools read_file,grep,list_dir,web_search,web_fetch`
 *       THE GUARANTEE. Headless allowlist of builtin tools (ids verified
 *       against the v0.2.106 embedded docs' "Tool ID for --tools" table).
 *       With --tools set, default tool injection is DISABLED — bash
 *       (run_terminal_cmd), search_replace (edit), todo_write, task, image/
 *       video gen, deploy_app etc. simply do not exist in the toolset.
 *   L2 `--disallowed-tools search_tool,use_tool,Agent`
 *       Docs: "the final toolset retains requested tools plus always-on MCP
 *       meta-tools" — search_tool/use_tool could reach the operator's MCP
 *       servers (which DO mutate). --disallowed-tools runs AFTER --tools and
 *       wins, so this strips the meta-tools; `Agent` blocks ALL subagent
 *       spawning at the toolset level.
 *   L3 `--no-subagents` — belt-and-suspenders duplicate of the Agent entry.
 *   L4 `--deny Bash --deny Edit --deny Write`
 *       Permission-layer deny rules (deny > ask > allow, enforced in every
 *       mode). BEST-EFFORT redundancy: if a future CLI version ever injects a
 *       shell/edit tool past L1/L2, the permission engine still denies it.
 *   L5 `--max-turns <N>` — runaway-loop cap (config maxTurns, default 30).
 *   L6 Prompt level, two separate things. (a) The read-only preamble
 *       (NO_MUTATE_PREFIX) is on BOTH research and review prompts. (b) The
 *       fleet's MUTATE_RE intent GATE runs on grok_research prompts only — it
 *       is deliberately skipped for grok_code_review, where "review the last
 *       git commit" is a legitimate read-only ask. Weakest layer either way;
 *       L1/L2 are what actually guarantee read-only, and L1-L5 hold for
 *       review exactly as they do for research.
 *
 * Web search stays ENABLED on purpose (research bridge) unless the fleet
 * config sets `webSearch: false`, which drops web_search/web_fetch from L1 and
 * the allow rules with them. web_fetch is off by default in the CLI — opted
 * in via GROK_WEB_FETCH=1 in the child env.
 *
 * WEB APPROVAL + OUTPUT FORMAT (verified live, v0.2.111, 2026-07-23): a
 * headless tool call that would prompt — web_fetch's domain approval — does
 * NOT "fail closed": it CANCELS the entire run. Exit 0, stopReason
 * "Cancelled", empty final text; in plain mode only the model's pre-cancel
 * narration reaches stdout, so an earlier bridge logged those runs as "ok"
 * while returning narration with no answer. Two-part fix, research/review
 * spawns ONLY:
 *   1. `--allow WebFetch --allow WebSearch` — permission-layer allow rules
 *      (the only web-shaped names the rule engine recognizes). SAFE: L1
 *      already restricts the toolset to read/search/web, L2 strips MCP
 *      meta-tools + Agent, and deny > allow keeps the Bash/Edit/Write deny
 *      rules winning — these allows can only un-prompt the two web tools.
 *   2. `--output-format streaming-messages-json --include-partial-messages`
 *      (0.3.1; before that `--output-format json`) — the run's structured
 *      output, read by parseStream. WHY STREAMING: `json` writes NOTHING until
 *      the run ends (0 bytes at 20s on a probe that had text in plain mode by
 *      16s), so the hard-kill salvage below had nothing to salvage on exactly
 *      the runs it exists for. Streaming emits NDJSON as the answer is
 *      produced — 441 text deltas / 1513 chars survived a 30s kill on the
 *      2026-09-06 probe.
 *      SHAPE (verified live, grok 1.0.13, 2026-09-06 — the Anthropic Messages
 *      wire format, one JSON object per line): {"type":"system","subtype":
 *      "init",...}, then {"type":"stream_event","event":{...}} lines
 *      (message_start, content_block_start, content_block_delta whose
 *      delta.type is text_delta / thinking_delta / input_json_delta,
 *      content_block_stop, message_delta carrying stop_reason + usage,
 *      message_stop), then the whole {"type":"assistant","message":{content:
 *      [...]}} and finally {"type":"result","subtype":"success","result":"<the
 *      full answer>","stop_reason":...,"usage":{...}}.
 *      ONE PARSER for finished and killed runs: text_delta events assemble the
 *      running answer (thinking_delta and tool-argument input_json_delta are
 *      never part of it), and the final whole message — the `result` line's
 *      `result`, else the last assistant message's text blocks — wins when it
 *      is there, being the authoritative full text. Malformed lines (a kill
 *      truncates the last one) are skipped.
 *      interpretGrok then makes any "cancelled"/early stop VISIBLE instead of
 *      a silent truncation: text that arrived before the stop is returned with
 *      a marker line appended (`[grok: run ended early — stopReason=...]`,
 *      plus `[grok: CLI exited N — treat the answer as partial]` on a non-zero
 *      exit), and only a run with NO text at all throws. Partial work is kept,
 *      never passed off as a clean answer. stopReason spelling CHANGED across
 *      CLI generations (v0.2.x "EndTurn"/"Cancelled", v1.0.x "end_turn"/
 *      "cancelled") — it is compared case/underscore-insensitively (regression
 *      caught 2026-08-13).
 *      USAGE: input_tokens/output_tokens are MERGED across the lines that carry
 *      them (a message_delta reporting only output must not erase the input
 *      count message_start gave) and reach the fleet status feed as
 *      `usage: { input, output }` — Grok reported none before 0.3.1.
 *      CLI-level failures: v1.0.13 ends the stream with {"type":"result",
 *      "is_error":true,"subtype":"error_...","errors":[...]} (verified live:
 *      unknown --model, exit 1); older generations printed a bare
 *      {"type":"error","message":...} line, still accepted. A failure THROWS
 *      only when it took the answer with it — a run that failed after
 *      producing text (error_max_turns puts the paid partial answer in
 *      `result` with no errors[]) comes back as an early stop named by the
 *      failure's subtype, never as its error message.
 *      A SUCCESSFUL result line closes the run: its stop_reason is null after
 *      a tool-use turn, and null there means end_turn — not the last turn's
 *      "tool_use", which would stamp an early-stop marker on a complete answer.
 * Image runs keep plain mode and NO allow rules — image_gen/image_edit
 * auto-approve headless (see below), and their path-extraction contract is
 * built on plain stdout.
 *
 * AUTO-UPDATE: the CLI updates itself by operator policy — live on fresh
 * versions, fix breakage reactively. On any unexplained regression, suspect a
 * CLI version bump FIRST (precedent: v0.2.106 -> v0.2.111 changed web_fetch's
 * headless domain-approval from fail-closed to cancelling the whole run).
 *
 * IMAGE TOOLS: `grok_image` (text-to-image via the builtin image_gen tool)
 * and `grok_image_edit` (image-to-image via image_edit) over the xAI Imagine
 * API. Same layered posture with ONE swap: L1 becomes `--tools image_gen`
 * (resp. image_edit) — an image-ONLY toolset, no read/web/shell tools at all.
 * APPROVAL: `--always-approve` is NOT passed — verified live (v0.2.106,
 * 2026-07-23) that image tools auto-approve headless. If a future CLI starts
 * prompting for them, headless CANCELS the call and this adapter surfaces
 * the raw-output error — the fix then is to re-add `--always-approve` to
 * image spawns ONLY (safe purely because L1 restricts the toolset to the
 * single image tool and L2 strips MCP meta-tools + Agent). Generated files
 * land OUTSIDE any project under ~/.grok/sessions/<url-encoded-cwd>/
 * <session-uuid>/images/N.jpg; the tool returns that absolute path and the
 * operator imports it by hand — this unit never writes into any project.
 * NO retry on image runs: a re-issued generation bills image quota twice.
 * MUTATE_RE is NOT applied to image prompts ("commit"/"deploy" could be
 * literal scene text; the image-only toolset makes mutation impossible
 * anyway) — prompt hygiene is a tailored image preamble instead.
 *
 * AUTH: the CLI needs `grok login` (browser) or `grok login --device-code`.
 * An unauthenticated run exits 1 with "Not signed in" on stderr and EMPTY
 * stdout — the runtime turns that into a clean, actionable error (never a
 * retry). `grok models` prints "You are not authenticated" instead.
 *
 * BILLING: the grok docs state the API key "takes precedence over browser
 * credentials" — if XAI_API_KEY reaches the child, every call silently bills
 * metered API credits instead of the `grok login` subscription. Deleted from
 * every child env.
 *
 * TIMEOUT: unlike agy there is NO CLI-side print-timeout flag to hand down,
 * so the process-group SIGKILL is the only wall-clock bound (config timeoutS).
 */
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { defineUnit } from '../../core/unit.mjs';
import { makeCatalog } from '../../core/catalog.mjs';
import { extractImagePath } from '../../core/artifact.mjs';
import { GROK_MODELS, EFFORTS, GUIDE } from './models.js';

export const catalog = makeCatalog({
  models: GROK_MODELS,
  efforts: EFFORTS,
  guide: GUIDE,
  title: 'GROK MODEL CATALOG',
  vendorDefaultNote: 'omit `model` for the fleet default, else grok\'s own default',
});

const BILLING_RISK_ENV = ['XAI_API_KEY'];
const AUTH_RE = /not signed in|not authenticated/i;
const AUTH_HELP =
  'Grok CLI is not authenticated — operator action needed: run `grok login` ' +
  '(or `grok login --device-code` without a browser), then retry this call.';

/** L6b: read-only preamble on every research/review prompt (weakest layer; see header). */
const NO_MUTATE_PREFIX =
  'You are a read-only research and code-analysis assistant. Do NOT modify ' +
  'files, run shell commands, run git, deploy, or publish — you only read, ' +
  'search, and use web search. Answer in plain text.\n\n';

/** L1 toolsets (ids from the CLI's own docs table). */
export const READONLY_TOOLS = 'read_file,grep,list_dir,web_search,web_fetch';
export const READONLY_TOOLS_NOWEB = 'read_file,grep,list_dir';
export const IMAGE_GEN_TOOLS = 'image_gen';
export const IMAGE_EDIT_TOOLS = 'image_edit';
/** L2: strip the always-on MCP meta-tools + all subagent spawning. */
const DENY_TOOLS = 'search_tool,use_tool,Agent';
/** L4: permission-layer deny rules (Claude-compat rule names; repeatable flag). */
const DENY_RULES = ['Bash', 'Edit', 'Write'];
/** Permission-layer ALLOW rules for research/review runs WITH web — see "WEB APPROVAL" in the header. */
const ALLOW_RULES = ['WebFetch', 'WebSearch'];

const IMAGE_GEN_PREFIX =
  'Generate exactly ONE image with the image_gen tool from the description ' +
  'below. When the tool reports the saved file, reply with ONLY the absolute ' +
  'path of the saved image file — no markdown, no quotes, no other text.\n\n' +
  'Image description: ';

/**
 * image_edit takes its reference via the tool's own required `image` input
 * (filesystem path or data: URL — v0.2.106 embedded imagine docs), so the
 * child needs NO read_file tool; we just name the exact path to pass.
 * `imagePath` is pre-validated (absolute + existing regular file).
 */
function imageEditPrompt(imagePath, prompt) {
  return (
    'Edit an existing image with the image_edit tool. Pass this exact ' +
    'absolute path as the tool\'s `image` input: ' + imagePath + '\n' +
    'Apply the transformation described below, keeping everything not ' +
    'mentioned unchanged. When the tool reports the saved file, reply with ' +
    'ONLY the absolute path of the NEW saved image file (never the source ' +
    'path) — no markdown, no quotes, no other text.\n\n' +
    'Transformation: ' + prompt
  );
}

const isResearchToolset = (tools) => tools === READONLY_TOOLS || tools === READONLY_TOOLS_NOWEB;

/** Build the `grok -p` argv for one run. Exported for tests. */
export function buildArgs({ prompt, model, effort, cwd, tools, maxTurns }) {
  // Research/review runs stream NDJSON so a hard kill still has text to
  // salvage; image runs keep plain stdout — their path-extraction contract is
  // built on it (see the file header).
  const streaming = isResearchToolset(tools);
  const args = [
    '-p', prompt,
    ...(streaming
      ? ['--output-format', 'streaming-messages-json', '--include-partial-messages']
      : ['--output-format', 'plain']),
    // Layers L1-L5 (see file header for who guarantees what):
    '--tools', tools,
    '--disallowed-tools', DENY_TOOLS,
    '--no-subagents',
    '--max-turns', String(maxTurns),
  ];
  for (const rule of DENY_RULES) args.push('--deny', rule);
  if (tools === READONLY_TOOLS) for (const rule of ALLOW_RULES) args.push('--allow', rule);
  if (typeof model === 'string' && model.trim()) args.push('--model', model.trim());
  if (typeof effort === 'string' && effort.trim()) args.push('--reasoning-effort', effort.trim().toLowerCase());
  if (typeof cwd === 'string' && cwd) args.push('--cwd', cwd);
  return args;
}

/** Token counts worth reporting — message_start's all-zero placeholder is not one. */
function readUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const input = Number.isFinite(u.input_tokens) ? u.input_tokens : null;
  const output = Number.isFinite(u.output_tokens) ? u.output_tokens : null;
  return input || output ? { input, output } : null;
}

/** The text blocks of one whole message, in order — tool_use and thinking blocks are not the answer. */
function messageText(msg) {
  if (!msg || !Array.isArray(msg.content)) return '';
  return msg.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Read one run's NDJSON stdout — THE single parser, used by the clean path and
 * by the hard-kill salvage alike, so a killed run's text is extracted exactly
 * the way a finished one's is. Line shapes in the file header.
 * `text` is what the deltas assembled; `finalText` is the authoritative whole
 * message when the run got that far; `parsed` says at least one line was a
 * shape we know (an understood stream with no text is a run that produced no
 * answer, not a reason to hand back raw stdout). Exported for tests.
 * @returns {{text:string, finalText:string, stopReason:string, usage:{input:number|null,output:number|null}|null, parsed:boolean, error:string|null}}
 */
export function parseStream(stdout) {
  let text = '';
  let finalText = '';
  let stopReason = '';
  let usage = null;
  let error = null;
  let parsed = false;
  const takeStop = (s) => { if (typeof s === 'string' && s) stopReason = s; };
  // MERGE, never replace: a line that reports only output_tokens must not erase
  // the input count an earlier line already gave.
  const takeUsage = (u) => {
    const v = readUsage(u);
    if (!v) return;
    usage = { input: v.input || (usage && usage.input) || null, output: v.output || (usage && usage.output) || null };
  };
  const takeFinal = (t) => { if (t && t.trim()) finalText = t; };

  for (const line of String(stdout || '').split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; } // a kill truncates the last line
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'stream_event' && o.event && typeof o.event === 'object') {
      parsed = true;
      const e = o.event;
      if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && typeof e.delta.text === 'string') text += e.delta.text;
      else if (e.type === 'message_delta') { takeStop(e.delta && e.delta.stop_reason); takeUsage(e.usage); }
      else if (e.type === 'message_start' && e.message) takeUsage(e.message.usage);
      continue;
    }
    // The whole assistant message. `assistant` is what the 1.0.13 probe emits;
    // a top-level `message` line is accepted because that spelling is the one
    // part of the shape the probe left uncertain.
    if (o.type === 'assistant' || o.type === 'message') {
      parsed = true;
      const msg = o.type === 'assistant' ? o.message : o;
      takeFinal(messageText(msg));
      if (msg) { takeStop(msg.stop_reason); takeUsage(msg.usage); }
      continue;
    }
    if (o.type === 'result') {
      parsed = true;
      takeUsage(o.usage);
      // The `result` string is the run's answer whether the run succeeded or
      // not — a maxTurns-capped run puts its PAID partial answer there.
      if (typeof o.result === 'string') takeFinal(o.result);
      if (o.is_error) {
        error = (Array.isArray(o.errors) && o.errors.filter(Boolean).join('; ')) || String(o.result || o.subtype || 'run failed').slice(0, 300);
        takeStop(o.subtype); // a failed result carries stop_reason null; the subtype is what names the stop
      } else {
        // A successful result closes the run, so a null stop_reason here means
        // end_turn — never the last turn's "tool_use", which would stamp an
        // early-stop marker on a complete answer.
        takeStop(typeof o.stop_reason === 'string' && o.stop_reason ? o.stop_reason : 'end_turn');
      }
      continue;
    }
    if (o.type === 'error') { parsed = true; error = o.message || JSON.stringify(o).slice(0, 300); continue; }
    if (o.type === 'system') parsed = true; // init line — nothing to take from it
    // Anything else: a line shape from a future CLI. Skipped, never fatal.
  }
  return { text, finalText, stopReason, usage, parsed, error };
}

/**
 * The answer inside one finished run's stdout, for both output formats.
 * @returns {{text:string, stop:string, parsed:boolean, error:string|null, usage:object|null}}
 */
function grokAnswer(out, jsonMode) {
  const raw = String(out || '');
  if (!jsonMode) return { text: raw.trim(), stop: '', parsed: false, error: null, usage: null };
  const s = parseStream(raw);
  const text = (s.finalText || s.text).trim();
  // A reported failure THROWS only when it took the answer with it. A run that
  // failed after producing text (maxTurns capped, a mid-run error) is paid for
  // and its text is usually the useful part: it comes back as an early stop,
  // named by the failure's own subtype, and interpretGrok marks it.
  if (s.error && !text) return { text: '', stop: '', parsed: true, error: s.error, usage: null };
  // Nothing recognized (output-cap truncation / future CLI format change):
  // fail open with the raw stdout rather than dropping a real answer.
  if (!s.parsed) return { text: raw.trim(), stop: '', parsed: false, error: null, usage: null };
  return { text, stop: s.error ? s.stopReason || 'error' : s.stopReason, parsed: true, error: null, usage: s.usage };
}

/** A bare string when the text is all there is to say; the object shape when usage or `partial` travel with it. */
const answer = (text, usage, extra) =>
  (usage || extra ? { text, ...(usage ? { usage } : {}), ...extra } : text);

/**
 * Interpret one finished grok run → the answer text, `{ text, usage? }` once
 * the run reported tokens, `{ text, usage?, partial: true }` for a salvaged
 * hard kill, or throw. Exported for tests.
 * `jsonMode` selects the structured output format (since 0.3.1: the streaming
 * NDJSON of research/review runs); false is the plain stdout of image runs.
 */
export function interpretGrok(res, { jsonMode, timeoutS }) {
  const { stdout: out, stderr: errBuf, code, killed } = res;
  const a = grokAnswer(out, jsonMode);
  // A hard kill at timeoutS used to discard everything the CLI had printed —
  // on a long review that is a paid-for hour thrown away. Keep what was
  // captured, marked; only a kill with nothing to show is still an error.
  if (killed) {
    if (a.text) {
      return answer(
        `${a.text}\n\n[grok: hard-killed after ${timeoutS}s — treat the answer as partial; raise grok.timeoutS in the fleet config]`,
        a.usage,
        { partial: true },
      );
    }
    throw new Error(`grok hard-killed after ${timeoutS}s (raise grok.timeoutS in the fleet config)`);
  }
  if (code !== 0 && !out.trim()) throw new Error(`grok exited ${code}: ${errBuf.trim().slice(-500) || '(no stderr)'}`);
  // A non-zero exit that still produced text: keep the text — the run is paid
  // for and it is usually the useful part — but mark it, in every mode, so it
  // can never be read as a completed answer.
  const partial = (text) => (code !== 0 && text ? `${text}\n\n[grok: CLI exited ${code} — treat the answer as partial]` : text);
  if (a.error) throw new Error(`grok CLI error: ${a.error}`);
  if (!a.parsed) return partial(a.text);
  const stopNorm = a.stop.toLowerCase().replace(/[_\s]/g, '');
  if (a.text && (!a.stop || stopNorm === 'endturn')) return answer(partial(a.text), a.usage);
  if (a.text) return answer(partial(`${a.text}\n\n[grok: run ended early — stopReason=${a.stop}]`), a.usage);
  throw new Error(
    `grok run ended with no answer (stopReason=${a.stop || 'unknown'})` +
    (stopNorm === 'cancelled' ? ' — a tool call needed interactive approval and the headless run was cancelled' : ''),
  );
}

async function runGrok(ctx, { prompt, cwd, tools, maxTurns }) {
  const jsonMode = isResearchToolset(tools);
  const args = buildArgs({ prompt, model: ctx.model, effort: ctx.effort, cwd, tools, maxTurns });
  ctx.log(`grok spawn · tools=${tools} · model=${ctx.model || '(grok default)'} · effort=${ctx.effort || '(default)'} · cwd=${cwd || '(process cwd)'}`);
  const res = await ctx.spawn({ args, cwd: cwd || undefined, extraEnv: { GROK_WEB_FETCH: '1' } });
  const out = interpretGrok(res, { jsonMode, timeoutS: ctx.cfg.timeoutS });
  if (out && out.usage) {
    const n = (v) => (v === null || v === undefined ? '?' : v); // a count the run never reported
    ctx.log(`grok done · tokens in=${n(out.usage.input)} out=${n(out.usage.output)}`);
  }
  return out;
}

/** The text of a run, whether it came back plain or as a salvaged-kill result. */
const runText = (r) => (typeof r === 'string' ? r : (r && r.text) || '');

const isDeterministic = (e) => /not authenticated|hard-killed|CLI error|not found in PATH/i.test((e && e.message) || '');
const researchTools = (ctx) => (ctx.cfg.webSearch ? READONLY_TOOLS : READONLY_TOOLS_NOWEB);

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
    'Optional. OMIT to use the fleet default (`grok.model` in the fleet config, else ' +
    'grok\'s own default). Must be an exact id (call grok_models for the full guide). ' + GUIDE,
};
const EFFORT_PROP = {
  type: 'string',
  enum: catalog.effortEnum(),
  description:
    'Optional reasoning effort: low=fast/cheap sweeps, medium=grok\'s default, ' +
    'high=harder math/analysis (slower). OMIT for the CLI default.',
};

export default defineUnit({
  name: 'grok',
  label: 'Grok',
  instructions: 'This unit: Grok via the grok CLI. Inexpensive per token — volume sweeps, mechanical review, second opinions, math/STEM cross-checks, image generation and the fleet\'s only image editing (grok_image_edit). It is overconfident and measured roughly one factual answer in three wrong on independent testing: never a sole source, verify every claim. Write mode is unsupported by design.',
  bin: { env: 'GROK_BIN', default: 'grok' },
  billingRiskEnv: BILLING_RISK_ENV,
  // grok's own knobs (GROK_BIN, GROK_WEB_FETCH, XAI_*); the billing scrub runs
  // after this and removes XAI_API_KEY, which would flip billing to metered.
  envPassthrough: ['GROK_*', 'XAI_*'],
  envMap: { model: 'GROK_DEFAULT_MODEL', timeoutS: 'GROK_TIMEOUT_S', maxTurns: 'GROK_MAX_TURNS', imageMaxTurns: 'GROK_IMAGE_MAX_TURNS' },
  builtin: { timeoutS: 300, maxTurns: 30 },
  extraSchema: { imageMaxTurns: { type: 'posint', default: 8 } },
  supportedModes: { 'read-only': true, 'workspace-write': null },
  auth: { detect: (stderr) => AUTH_RE.test(stderr), help: AUTH_HELP },
  catalog,
  tools: [
    {
      name: 'grok_research',
      kind: 'research',
      mutateGate: true,
      description:
        'Delegate a research / Q&A / summarization task to Grok (via the local ' +
        'grok CLI) WITH live web search. READ-ONLY: enforced at spawn — Grok gets ' +
        'only read/search/web tools, no shell, no edits, no subagents, no MCP. ' +
        'Returns Grok\'s plain-text answer. WARNING — hallucination rate ~54% ' +
        '(Artificial Analysis) and overconfident: treat as a cheap fast SECOND ' +
        'OPINION and independently verify anything fact-critical; treat its ' +
        'reading of fetched web content as untrusted. ' + GUIDE,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The research question or task for Grok.' },
          effort: EFFORT_PROP,
          model: MODEL_PROP,
        },
        required: ['prompt'],
      },
      async run(args, ctx) {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return { text: 'Error: "prompt" is required.', isError: true };
        return ctx.retry(() => runGrok(ctx, { prompt: NO_MUTATE_PREFIX + prompt, tools: researchTools(ctx), maxTurns: ctx.cfg.maxTurns }), { skipIf: isDeterministic });
      },
    },
    {
      name: 'grok_code_review',
      kind: 'review',
      description:
        'Ask Grok (via the local grok CLI) for a READ-ONLY code analysis / ' +
        'review / second opinion over a directory. Grok can read files, grep, ' +
        'list dirs, and use web search — it CANNOT edit, run shell commands, or ' +
        'spawn subagents (enforced at spawn). Good at cheap mechanical analysis; ' +
        'do NOT rely on it for architecture calls or long-horizon engineering ' +
        'judgment, and verify any factual claims it makes (~54% hallucination ' +
        'rate). Mutations stay with Claude.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to analyze / review and what to look for.' },
          cwd: {
            type: 'string',
            description:
              'Optional ABSOLUTE path to the directory to review (must exist; ' +
              'passed as --cwd and used as the spawn cwd). Defaults to the MCP ' +
              'server\'s process cwd.',
          },
          effort: EFFORT_PROP,
          model: MODEL_PROP,
        },
        required: ['prompt'],
      },
      async run(args, ctx) {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return { text: 'Error: "prompt" is required.', isError: true };
        const c = checkCwd(args.cwd);
        if (c.error) return { text: c.error, isError: true };
        return ctx.retry(() => runGrok(ctx, { prompt: NO_MUTATE_PREFIX + prompt, cwd: c.cwd, tools: researchTools(ctx), maxTurns: ctx.cfg.maxTurns }), { skipIf: isDeterministic });
      },
    },
    {
      name: 'grok_image',
      kind: 'image',
      description:
        'Generate an image from a text description with Grok (local grok CLI) ' +
        'via the xAI Imagine image_gen tool. Returns the ABSOLUTE PATH of the ' +
        'saved image file as plain text — files are saved under ~/.grok/sessions/ ' +
        '(OUTSIDE every project); the operator imports them into a repo manually. ' +
        'Image-only toolset enforced at spawn: no read/web/shell tools, no ' +
        'subagents, no MCP. Each call spends image quota and is NOT retried. To ' +
        'edit/restyle an EXISTING image use grok_image_edit instead.',
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
        const text = runText(await runGrok(ctx, { prompt: IMAGE_GEN_PREFIX + prompt, tools: IMAGE_GEN_TOOLS, maxTurns: ctx.cfg.imageMaxTurns }));
        const artifact = extractImagePath(text);
        if (!artifact) throw new Error('image run finished without a saved image path on disk. Raw output: ' + ((text || '(empty)').slice(-1000)));
        return artifact;
      },
    },
    {
      name: 'grok_image_edit',
      kind: 'image',
      description:
        'Image-to-image EDIT of an existing image with Grok (local grok CLI) via ' +
        'the xAI Imagine image_edit tool: preserve likeness, transfer style, ' +
        'recolor, add/remove elements, remix. Returns the ABSOLUTE PATH of the ' +
        'NEW saved image file as plain text (the source file is never modified); ' +
        'files are saved under ~/.grok/sessions/ (OUTSIDE every project) and the ' +
        'operator imports them manually. Image-only toolset enforced at spawn: no ' +
        'read/web/shell tools, no subagents, no MCP. Each call spends image quota ' +
        'and is NOT retried.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to change and/or the target style. Everything not mentioned is kept as-is.' },
          imagePath: { type: 'string', description: 'ABSOLUTE path to the source/reference image file. Validated before spawn: must be absolute, exist, and be a regular file.' },
          model: MODEL_PROP,
        },
        required: ['prompt', 'imagePath'],
      },
      async run(args, ctx) {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return { text: 'Error: "prompt" is required.', isError: true };
        const imagePath = typeof args.imagePath === 'string' ? args.imagePath.trim() : '';
        if (!imagePath || !isAbsolute(imagePath)) return { text: `Error: "imagePath" must be an absolute path (got ${JSON.stringify(args.imagePath)}).`, isError: true };
        let st;
        try { st = statSync(imagePath); } catch { st = null; }
        if (!st || !st.isFile()) return { text: `Error: "imagePath" is not an existing file: ${imagePath}`, isError: true };
        const text = runText(await runGrok(ctx, { prompt: imageEditPrompt(imagePath, prompt), tools: IMAGE_EDIT_TOOLS, maxTurns: ctx.cfg.imageMaxTurns }));
        const artifact = extractImagePath(text, imagePath);
        if (!artifact) throw new Error('image run finished without a saved image path on disk. Raw output: ' + ((text || '(empty)').slice(-1000)));
        return artifact;
      },
    },
    {
      name: 'grok_models',
      kind: 'catalog',
      description:
        'List the Grok models you can pass as `model` to grok_research / ' +
        'grok_code_review / grok_image / grok_image_edit, the allowed `effort` ' +
        'levels, and a "route to / route AWAY" cheat-sheet with verified ' +
        'strengths AND weaknesses. No arguments, no spawn — local catalog read. ' +
        'Call this first if unsure whether a task belongs on Grok at all.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
});
