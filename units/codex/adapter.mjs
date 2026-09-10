/**
 * omelette-fleet :: units/codex/adapter.mjs
 * OpenAI Codex CLI as a fleet unit — four tools: `codex_research`,
 * `codex_code_review`, `codex_image`, `codex_models`. Every call is one
 * headless `codex exec` run, billed to the operator's ChatGPT subscription.
 *
 * READ-ONLY POSTURE — one real layer, not six:
 *   `-s read-only` is Codex's own OS-level sandbox (Seatbelt on macOS, Landlock
 *   /seccomp on Linux). The model's shell commands physically cannot write.
 *   Verified live (codex-cli 0.146.0, 2026-09-02; re-checked on 0.153.0, 2026-09-03): the run header prints
 *   `approval: never` and `sandbox: read-only`; `codex exec` never prompts.
 *   Never passed: `--dangerously-bypass-approvals-and-sandbox`,
 *   `--dangerously-bypass-hook-trust`.
 *   `workspace-write` (the only wider mode this unit implements) is scoped by
 *   the kernel to the `-C <dir>` you pass — and this adapter grants it to
 *   `codex_code_review` with an explicit `cwd` (fleet ceiling required) and to
 *   `codex_image` in a throwaway temp directory (see IMAGE below); research
 *   runs are read-only regardless of the fleet config.
 *
 * OUTPUT — `--json` emits JSONL and it is honest: the answer is the LAST
 * `item.completed` of type `agent_message`; a failure is a `turn.failed`
 * event plus exit 1 (verified: an unknown model gives HTTP 400 in
 * `turn.failed`, exit 1). No stopReason guessing. `turn.completed` carries
 * real token usage (input / cached / output / reasoning); Gemini reports
 * input/output too, Grok reports none. It is surfaced in the status feed.
 * A NON-ZERO exit that still produced an answer keeps the answer under a
 * visible `[codex: CLI exited N — treat the answer as partial]` marker:
 * dropping it wastes the run, returning it clean would be a lie.
 *
 * OUTPUT CAP — core/spawn.mjs keeps only the LAST `outputCap` characters of
 * stdout, and this unit's built-in raises it to 4 000 000 (config `outputCap`,
 * fleet default 400 000) — see CODEX_OUTPUT_CAP below for why a JSONL of one
 * line per ITEM still outgrows the default on an agentic review.
 * A cap that bites drops the FRONT of the stream and the answer is the LAST
 * `agent_message`, so the two cases differ: whole lines still parse and the
 * answer is real with its narration gone (the capped marker, partial: true), or
 * the answer itself rode a line longer than the cap and NO agent_message
 * survived — where parseJsonl silently drops the fragment and this function
 * used to report "produced no answer", naming a cause that is not the cause.
 * It throws and names `codex.outputCap` instead, and isDeterministic skips the
 * retry: the same run would hit the same cap and be paid for twice. A hard kill
 * is answered FIRST either way — 0.3.1's salvage keeps its promise, both markers
 * ride on the salvaged answer, and the cap surfaces in the error only when the
 * killed run had nothing to salvage.
 *
 * CANCELLATION — the same SIGKILL answers a cancelled request (`cancel: kill`),
 * and core/spawn.mjs tells the two apart with `cancelled: true`. The salvage is
 * identical; only the wording changes, because neither bound was reached and
 * "raise codex.timeoutS" would send the operator after a limit that held.
 *
 * WEB SEARCH — `-c tools.web_search=true` (verified live: emits `web_search`
 * items and grounds the answer). Toggle per unit with `webSearch` in the
 * fleet config.
 *
 * PROMPT ON STDIN — `codex exec -` reads the instructions from stdin, so a
 * prompt beginning with `-` can never be mistaken for a flag and argv stays
 * short. Positional prompts also work but Codex then prints "Reading
 * additional input from stdin..." whenever stdin is not a TTY.
 *
 * ISOLATION — without `--ignore-user-config` a bridge run inherits the whole
 * of the operator's ~/.codex/config.toml: MCP servers, plugins, hooks, the
 * `notify` command. The `-s read-only` sandbox bounds the FILESYSTEM, not a
 * configured MCP tool, so an operator MCP server that mutates an external
 * system (a tracker, a deploy endpoint) would be reachable from a "read-only"
 * research call. Both `--ignore-user-config` and `--ignore-rules` (user /
 * project execpolicy `.rules` files) are therefore passed on every spawn.
 * Verified live with ChatGPT auth (codex-cli 0.153.0, 2026-09-03): auth still
 * resolves through CODEX_HOME and `codex exec --ignore-user-config
 * --ignore-rules -s read-only --skip-git-repo-check --json
 * -c tools.web_search=false "Reply OK"` answers normally.
 * `-c notify=[]` stays: harmless, and it keeps the desktop quiet if a future
 * CLI version reads notify from somewhere else.
 * CONSEQUENCE — "the vendor default model" no longer means the operator's
 * configured default, because that default lives in the ignored file. So when
 * nothing is configured (no `model` arg, no `codex.model` in the fleet
 * config) this adapter pins the FIRST catalog entry explicitly and logs it;
 * an unpinned run would silently be whatever the CLI hard-codes.
 *
 * BILLING — `OPENAI_API_KEY` / `CODEX_API_KEY` are deleted from the child env:
 * with an API key present Codex bills the metered API instead of the ChatGPT
 * plan. Real money. The `--oss` local-provider path is never used.
 *
 * IMAGE — `codex_image` drives the CLI's BUILT-IN image generation tool
 * (gpt-image-2). Verified live (codex-cli 0.153.0, ChatGPT plan, 2026-09-03):
 * the tool is present headless under `--ignore-user-config --ignore-rules`,
 * behind no feature flag; it saves its output under
 * `~/.codex/generated_images/<uuid>/…` and the model then uses shell (`cp`,
 * `sips`) to place a copy where it was asked to. That copy is what needs a
 * writable cwd.
 *   WHY THIS BYPASSES THE FLEET CEILING, deliberately: the run is spawned
 *   `-s workspace-write` with `-C <mkdtemp under os.tmpdir()>` regardless of
 *   the unit's configured mode and of OMELETTE_ALLOW_WRITE. The kernel sandbox
 *   scopes every write to that ONE throwaway directory the adapter just
 *   created — outside every project, outside $HOME's working trees — so the
 *   power being granted is not "codex may write your repo", it is "codex may
 *   write the scratch dir it was handed". The ceiling exists to keep a unit out
 *   of the operator's code; it is not what makes an artifact contract possible,
 *   and an image tool that cannot produce a file is not a tool. Same posture as
 *   `gemini_image`'s temp cwd; the operator copies the file out by hand.
 *   `tools.web_search=false` on image runs (nothing to search), no `effort`
 *   (the reasoning budget does not reach the image model), and NO retry — a
 *   re-issued generation bills image quota twice. The result is preferred from
 *   disk (`<tmpdir>/image.png`) and only then from the final message, via
 *   core/artifact.mjs's shared `extractImagePath`: a path the model asserts but
 *   never wrote is not an artifact.
 *   THE ANSWER IS THE BARE PATH: a run that was capped, hard-killed or
 *   cancelled with `image.png` already saved returns the path ALONE, marked
 *   `partial: true` for the status feed and the spool — including the run that
 *   saved it and was killed before it said anything, where extractResult
 *   refuses the run and the FILE outranks the refusal. No file and the tool
 *   fails, naming the bound that explains it (core/artifact.mjs).
 *
 * AUTH — `codex login status` prints "Logged in using ChatGPT" when fine; a
 * signed-out run fails with a login hint on stderr and nothing on stdout,
 * which the runtime turns into an actionable message (never a retry).
 */
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineUnit } from '../../core/unit.mjs';
import { makeCatalog } from '../../core/catalog.mjs';
import { artifactMiss, extractImagePath, unfinishedRun } from '../../core/artifact.mjs';
import { checkCwd } from '../../core/cwd.mjs';
import { CODEX_MODELS, EFFORTS, GUIDE } from './models.js';

export const catalog = makeCatalog({
  models: CODEX_MODELS,
  efforts: EFFORTS,
  guide: GUIDE,
  title: 'CODEX MODEL CATALOG',
  vendorDefaultNote: 'omit `model` for the fleet default, else the first id below — this unit ignores ~/.codex/config.toml',
});

/**
 * Codex's built-in `outputCap` — ten times the fleet default (400 000) and two
 * fifths of grok's 10 000 000.
 * The JSONL is one line per ITEM rather than one envelope per text delta, so
 * the stream is much closer to the answer's size than Grok's is — but an
 * agentic review is not one answer: `codex exec` prints a line for every
 * reasoning item, every read-only command it ran in the sandbox and every
 * file it read, and the answer is the LAST `agent_message`. A tail cap that
 * bites therefore takes the front, which costs narration; a cap small enough
 * to cut into that final line loses the answer outright and the whole paid
 * run with it (see extractResult). 400 000 was never a measurement of this
 * unit — it is the number every unit starts from — and the cost of a bigger
 * one is memory bounded by the cap itself, for a unit that runs one process
 * at a time.
 */
export const CODEX_OUTPUT_CAP = 4000000;

const READONLY_PREFIX =
  'You are a read-only research and code-analysis assistant running inside a ' +
  'read-only sandbox. Do NOT attempt to modify files, run git, deploy, or ' +
  'publish — you only read, search, and use web search. Answer in plain text.\n\n';

const WORKSPACE_WRITE_PREFIX =
  'You are a code assistant working inside a sandbox that allows edits ONLY ' +
  'within the working directory. Never run git commands that change history or ' +
  'remotes (commit, push, merge, rebase, reset, tag), never deploy or publish. ' +
  'Explain every change you make. Answer in plain text.\n\n';

/**
 * The image tool saves where IT wants (~/.codex/generated_images/<uuid>/…), so
 * the run is told to land a copy at a fixed name in its own temp cwd: that is
 * the path the adapter can check on disk instead of trusting the prose.
 */
const IMAGE_PREFIX =
  'Generate exactly ONE image with your image generation tool from the ' +
  'description below and save it as image.png in the current working ' +
  'directory (use a shell copy if the tool saves elsewhere). Then reply with ' +
  'ONLY the absolute path of the saved file — no markdown, no other text.\n\n' +
  'Image description: ';

const AUTH_RE = /not (?:logged|signed) in|run ['`]?codex login|login required|unauthorized|\b401\b/i;
const AUTH_HELP =
  'Codex CLI is not authenticated — operator action needed: run `codex login` ' +
  '(ChatGPT account), then retry this call.';

/** Build the `codex exec` argv. Exported for tests. */
export function buildArgs({ model, effort, cwd, mode, webSearch }) {
  const args = [
    'exec', '--json', '--skip-git-repo-check',
    // ISOLATION (see header): no ~/.codex/config.toml (MCP servers, plugins,
    // hooks, notify), no user/project execpolicy .rules files.
    '--ignore-user-config', '--ignore-rules',
    '-s', mode === 'workspace-write' ? 'workspace-write' : 'read-only',
    '-c', 'notify=[]',
    '-c', `tools.web_search=${webSearch ? 'true' : 'false'}`,
  ];
  if (cwd) args.push('-C', cwd);
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
  args.push('-'); // prompt on stdin
  return args;
}

function parseJsonl(stdout) {
  const events = [];
  for (const line of String(stdout || '').split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    try { events.push(JSON.parse(s)); } catch { /* foreign line */ }
  }
  return events;
}

/** Unwrap Codex's error payloads, which arrive as JSON-in-a-string. */
function errorText(raw) {
  if (!raw) return '';
  let s = String(raw);
  for (let i = 0; i < 3; i++) {
    try {
      const o = JSON.parse(s);
      const inner = (o && o.error && (o.error.message || o.error)) || o.message || o;
      if (typeof inner === 'string') { s = inner; continue; }
      s = JSON.stringify(inner);
    } catch { break; }
  }
  return s.slice(0, 500);
}

/**
 * Turn a finished run into { text, usage, searches } — `partial: true` when the
 * answer is there but incomplete (a hard kill whose captured text we kept, a run
 * whose stdout hit the tail cap) — or throw a clear error. Exported for tests.
 * @param {{stdout:string, stderr:string, code:number|null, killed:boolean, capped?:boolean, cancelled?:boolean}} res
 * @param {{timeoutS?:number, capped?:boolean, outputCap?:number}} o
 *   capped defaults to the run's own flag; outputCap is the tail cap the run was
 *   spawned under and is quoted in the messages, because raising it is the fix.
 */
export function extractResult(res, { timeoutS, capped = res.capped, outputCap = CODEX_OUTPUT_CAP } = {}) {
  const ev = parseJsonl(res.stdout);
  const messages = ev
    .filter((e) => e.type === 'item.completed' && e.item && e.item.type === 'agent_message' && typeof e.item.text === 'string')
    .map((e) => e.item.text.trim())
    .filter(Boolean);
  const failed = ev.find((e) => e.type === 'turn.failed');
  const errors = ev.filter((e) => e.type === 'error').map((e) => errorText(e.message));
  const completed = ev.find((e) => e.type === 'turn.completed');
  const searches = ev.filter((e) => e.type === 'item.completed' && e.item && e.item.type === 'web_search').length;
  const u = completed && completed.usage;
  const usage = u ? {
    input: u.input_tokens ?? null,
    cachedInput: u.cached_input_tokens ?? null,
    output: u.output_tokens ?? null,
    reasoning: u.reasoning_output_tokens ?? null,
  } : null;

  // THE TAIL CAP DROPS THE BEGINNING of the JSONL, so a capped run is never a
  // whole answer: every path out of here marks it and flags it partial.
  const capMark = (text) => (capped && text
    ? `${text}\n\n[codex: output capped at ${outputCap} chars — the beginning of the stream was dropped; treat the answer as partial]`
    : text);
  const capExtra = capped ? { partial: true } : undefined;

  // A hard kill at timeoutS used to discard every item the run had already
  // completed. The messages above were parsed from what WAS captured, so if the
  // answer is among them it comes back marked instead of being thrown away.
  // The kill is answered FIRST, cap or no cap: the salvage is the older promise.
  if (res.killed) {
    // The same SIGKILL ends a cancelled request; `cancelled` says which it was,
    // and a client that stopped the run is not a timeoutS to raise.
    const killMark = res.cancelled
      ? '[codex: cancelled by the client — treat the answer as partial]'
      : `[codex: hard-killed after ${timeoutS ?? '?'}s — treat the answer as partial; raise codex.timeoutS in the fleet config]`;
    if (messages.length) {
      return {
        text: capMark(`${messages.at(-1)}\n\n${killMark}`),
        usage,
        searches,
        partial: true,
      };
    }
    // A cancelled run has no answer because the caller asked for none: neither
    // bound was reached, so neither is named.
    if (res.cancelled) throw new Error('codex cancelled by the client');
    if (capped) throw new Error(`codex hard-killed after ${timeoutS ?? '?'}s and output exceeded the ${outputCap} char cap — raise codex.timeoutS or codex.outputCap in the fleet config`);
    throw new Error(`codex hard-killed after ${timeoutS ?? '?'}s (raise codex.timeoutS in the fleet config)`);
  }
  // A turn the CLI reported as failed is answered by that failure even when the
  // run was capped: it survived in the tail, it names the real cause (a rejected
  // model, an HTTP 400), and raising the cap would not produce an answer.
  if (failed) {
    const msg = errorText(failed.error && (failed.error.message || failed.error)) || errors.at(-1) || 'unknown';
    throw new Error(`codex turn failed: ${msg}`);
  }
  if (!messages.length) {
    // The cap ate the final message: parseJsonl dropped the fragment it left,
    // and "produced no answer" would send the operator after the wrong thing.
    if (capped) throw new Error(`codex output exceeded the ${outputCap} char cap and the final message was lost — raise codex.outputCap or narrow the task`);
    const tail = errors.at(-1) || res.stderr.trim().slice(-500) || '(no stderr)';
    throw new Error(res.code === 0 ? `codex produced no answer: ${tail}` : `codex exited ${res.code}: ${tail}`);
  }
  // The final agent_message is the answer; earlier ones are narration.
  let text = messages.at(-1);
  if (!completed) text += '\n\n[codex: run ended before turn.completed — treat as partial]';
  // A non-zero exit WITH an answer: keep the answer (the run is paid for and
  // the text is usually the useful part) but never let it read as a clean one.
  if (res.code !== 0) text += `\n\n[codex: CLI exited ${res.code} — treat the answer as partial]`;
  return { text: capMark(text), usage, searches, ...capExtra };
}

// `output exceeded`: an answer that outgrew the cap once will outgrow it again,
// so the retry is a second full paid run that cannot end differently. Same for
// a run the client cancelled — nobody is waiting for the second one.
const isDeterministic = (e) => /not authenticated|turn failed|hard-killed|not found in PATH|output exceeded|cancelled by the client/i.test((e && e.message) || '');

/**
 * One `codex exec` run, with the PROCESS RESULT kept beside the interpreted
 * answer: `codex_image` answers with a bare path, so when there is no artifact
 * it has to explain the RUN — and `killed` / `capped` / `cancelled` live on
 * the spawn result, never on the text. `webSearch` / `effort` default to the
 * resolved config and may be overridden per tool (image runs pass web=false
 * and no effort).
 * @returns {Promise<{out:object, res:object}>}
 */
async function runOnceRaw(ctx, { prompt, cwd, mode, webSearch, effort }) {
  // --ignore-user-config removed the operator's configured default, so an
  // unpinned run would take whatever the CLI hard-codes. Pin the catalog head.
  const model = ctx.model || catalog.ids[0];
  if (!ctx.model) ctx.log(`no model configured — pinning the catalog default ${model} (--ignore-user-config means ~/.codex/config.toml is not consulted)`);
  // The runtime named nothing, so this function is the only place that knows
  // which model the run used: report it, or the spooled answer is filed under
  // no model at all. Unconditional and idempotent — when ctx.model IS set the
  // runtime's own value wins, and the report changes nothing.
  ctx.usedModel(model);
  const web = webSearch === undefined ? ctx.cfg.webSearch : webSearch;
  const eff = effort === undefined ? ctx.effort : effort;
  const args = buildArgs({ model, effort: eff, cwd, mode, webSearch: web });
  ctx.log(`codex exec · sandbox=${mode} · model=${model}${ctx.model ? '' : ' (catalog default)'} · effort=${eff || '(default)'} · web=${web} · cwd=${cwd || '(process cwd)'}`);
  const res = await ctx.spawn({ args, cwd: cwd || undefined, stdinText: prompt });
  const out = extractResult(res, { timeoutS: ctx.cfg.timeoutS, outputCap: ctx.cfg.outputCap });
  if (out.usage) ctx.log(`codex done · tokens in=${out.usage.input} (cached ${out.usage.cachedInput}) out=${out.usage.output} reasoning=${out.usage.reasoning} · web_search=${out.searches}`);
  return { out, res };
}

/** The answer alone — what research and review runs need. */
const runOnce = async (ctx, o) => (await runOnceRaw(ctx, o)).out;

const MODEL_PROP = {
  type: 'string',
  enum: catalog.modelEnum(),
  description:
    'Optional. OMIT to use the fleet default (`codex.model` in the fleet config), ' +
    'else the first catalog entry — this unit runs with --ignore-user-config, so ' +
    'the operator\'s ~/.codex/config.toml default never applies. ' +
    'Must be an exact id — call codex_models for the guide. ' + GUIDE,
};
const EFFORT_PROP = {
  type: 'string',
  enum: catalog.effortEnum(),
  description:
    'Optional reasoning effort: none/low = fast sweeps, medium, high = deeper ' +
    'analysis (the fleet default), xhigh/max = hardest problems (slow, discouraged ' +
    'for routine work). OMIT for the fleet default.',
};

export default defineUnit({
  name: 'codex',
  label: 'Codex',
  instructions: 'This unit: Codex via the codex CLI, inside a kernel-enforced read-only sandbox. The fleet\'s strongest code review and agentic terminal analysis (codex_code_review needs an absolute cwd), research that depends on running things (codex_research), image generation (codex_image). Reports real token usage per call. Route the final pre-release security audit here on gpt-6-astra.',
  bin: { env: 'CODEX_BIN', default: 'codex' },
  billingRiskEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  // CODEX_HOME (where auth lives, still read under --ignore-user-config) and the
  // CLI's other knobs; CODEX_API_KEY matches the pattern and the scrub deletes it after.
  envPassthrough: ['CODEX_*'],
  envMap: { model: 'CODEX_DEFAULT_MODEL', effort: 'CODEX_EFFORT', timeoutS: 'CODEX_TIMEOUT_S', webSearch: 'CODEX_WEB_SEARCH' },
  builtin: { timeoutS: 600, effort: 'high', webSearch: true, outputCap: CODEX_OUTPUT_CAP },
  supportedModes: { 'read-only': true, 'workspace-write': true },
  auth: { detect: (stderr) => AUTH_RE.test(stderr), help: AUTH_HELP },
  catalog,
  tools: [
    {
      name: 'codex_research',
      kind: 'research',
      mutateGate: true,
      description:
        'Delegate a research / Q&A / summarization task to OpenAI Codex (local ' +
        'codex CLI, ChatGPT subscription) WITH live web search. READ-ONLY at the ' +
        'OS-sandbox level — Codex can read and search but physically cannot write, ' +
        'regardless of fleet config or of `cwd`. The run happens where `cwd` ' +
        'points when you give one, else in the MCP server\'s own process cwd. ' +
        'Returns the final answer as plain text and ' +
        'reports real token usage to the fleet status feed. ' + GUIDE,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The research question or task for Codex.' },
          cwd: {
            type: 'string',
            description:
              'Optional ABSOLUTE path to the directory the run happens in (must exist; ' +
              'passed as -C and used as the spawn cwd). The sandbox stays read-only ' +
              'either way. Defaults to the MCP server\'s process cwd.',
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
        // Research is read-only no matter what the config says, and a directory to
        // point at is not a reason to widen it: `-C` says WHERE the run happens,
        // `-s read-only` says what it may do there.
        return ctx.retry(() => runOnce(ctx, { prompt: READONLY_PREFIX + prompt, cwd: c.cwd, mode: 'read-only' }), { skipIf: isDeterministic });
      },
    },
    {
      name: 'codex_code_review',
      kind: 'review',
      description:
        'Ask OpenAI Codex (local codex CLI) for a code analysis / review / second ' +
        'opinion over a directory. Codex reads files, greps, runs read-only shell ' +
        'commands and web search inside an OS-level read-only sandbox; it cannot ' +
        'edit unless the operator has opened the fleet write ceiling for codex AND ' +
        'set mode=workspace-write, in which case writes are kernel-scoped to `cwd`. ' +
        'Strong at mechanical review and agentic terminal work (Terminal-Bench class); ' +
        'still verify factual claims. Mutations stay with Claude by default.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to analyze / review and what to look for.' },
          cwd: {
            type: 'string',
            description:
              'Optional ABSOLUTE path to the directory to review (must exist; passed ' +
              'as -C and used as the spawn cwd). Defaults to the MCP server\'s process cwd.',
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
        // workspace-write only with an explicit directory to scope it to.
        const mode = ctx.mode === 'workspace-write' && c.cwd ? 'workspace-write' : 'read-only';
        if (ctx.mode === 'workspace-write' && !c.cwd) ctx.log('workspace-write requested without cwd — running read-only');
        const prefix = mode === 'workspace-write' ? WORKSPACE_WRITE_PREFIX : READONLY_PREFIX;
        const run = () => runOnce(ctx, { prompt: prefix + prompt, cwd: c.cwd, mode });
        // Never re-issue a run that may have written something.
        return mode === 'workspace-write' ? run() : ctx.retry(run, { skipIf: isDeterministic });
      },
    },
    {
      name: 'codex_image',
      kind: 'image',
      description:
        'Generate an image from a text description with OpenAI Codex (local ' +
        'codex CLI) via its built-in gpt-image-2 tool. Returns the ABSOLUTE ' +
        'PATH of the saved PNG as plain text. The file lands under the OS temp ' +
        'directory, OUTSIDE every project — copy it where you need it, and do ' +
        'not treat it as durable storage (temp dirs may be cleaned by the OS). ' +
        'The answer is the bare path and nothing else: a run that was capped, ' +
        'killed or cancelled with the file already saved returns that path and is ' +
        'flagged partial in the status feed, and a run with no file on disk is an ' +
        'error. One image per call. Each call spends image quota and is NOT ' +
        'retried. To edit/restyle an EXISTING image use grok_image_edit instead.',
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
        // The sandbox is opened for exactly one directory, created here, empty,
        // and outside every project — see IMAGE in the header for why this is
        // deliberately not routed through the fleet write ceiling.
        const cwd = mkdtempSync(join(tmpdir(), 'omelette-codex-image-'));
        // The run's own start: an image file older than it is one the CLI
        // merely named, never one it saved (core/artifact.mjs).
        const since = Date.now();
        ctx.log(`codex_image · temp cwd=${cwd}`);
        // Disk first, by the fixed name the prompt asked for: the only claim
        // that needs no parsing, and the only one that survives a run ending
        // badly after it had already saved the file.
        const wanted = join(cwd, 'image.png');
        const onDisk = () => { try { return statSync(wanted).isFile() ? wanted : ''; } catch { return ''; } };
        let out;
        let res;
        try {
          // No retry: a re-issued generation bills image quota twice.
          ({ out, res } = await runOnceRaw(ctx, {
            prompt: IMAGE_PREFIX + prompt,
            cwd,
            mode: 'workspace-write',
            webSearch: false,
            effort: '',
          }));
        } catch (e) {
          // extractResult refused the run — a kill with nothing salvaged, a
          // final message the cap ate, a failed turn. THE FILE OUTRANKS THE
          // REFUSAL: an artifact already on disk is what this tool promises,
          // and it does not stop being one because the run that made it ended
          // badly. Partial, because the run did not finish.
          const saved = onDisk();
          if (!saved) throw e;
          ctx.log(`codex_image · artifact=${saved} (the run itself failed: ${(e && e.message) || e})`);
          return { text: saved, partial: true };
        }
        // Then the model's own answer, still stat-ed.
        const artifact = onDisk() || extractImagePath(out.text, '', since);
        if (!artifact) {
          const miss = artifactMiss('codex', res, { outputCap: ctx.cfg.outputCap, timeoutS: ctx.cfg.timeoutS });
          return {
            text: `Error: codex_image finished without a saved image on disk (temp dir ${cwd}${miss ? `; ${miss}` : ''}). Raw output: `
              + ((out.text || '(empty)').slice(-1000)),
            isError: true,
          };
        }
        ctx.log(`codex_image · artifact=${artifact}`);
        // THE BARE PATH IS THE CONTRACT: the cap/kill marker extractResult put
        // on the text stops here; `partial` carries the same fact to the feed —
        // for a non-zero exit too, whose marker the contract drops as well.
        const partial = !!out.partial || unfinishedRun(res);
        return { text: artifact, usage: out.usage, ...(partial ? { partial: true } : {}) };
      },
    },
    {
      name: 'codex_models',
      kind: 'catalog',
      description:
        'List the Codex models you can pass as `model` to codex_research / ' +
        'codex_code_review / codex_image, the allowed `effort` levels, and a ' +
        '"route to / route AWAY" cheat-sheet. No arguments, no spawn — local ' +
        'catalog read.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
});
