/**
 * omelette-fleet :: units/codex/adapter.mjs
 * OpenAI Codex CLI as a fleet unit — three tools: `codex_research`,
 * `codex_code_review`, `codex_models`. Every call is one headless
 * `codex exec` run, billed to the operator's ChatGPT subscription.
 *
 * READ-ONLY POSTURE — one real layer, not six:
 *   `-s read-only` is Codex's own OS-level sandbox (Seatbelt on macOS, Landlock
 *   /seccomp on Linux). The model's shell commands physically cannot write.
 *   Verified live (codex-cli 0.146.0, 2026-09-02; re-checked on 0.153.0, 2026-09-03): the run header prints
 *   `approval: never` and `sandbox: read-only`; `codex exec` never prompts.
 *   Never passed: `--dangerously-bypass-approvals-and-sandbox`,
 *   `--dangerously-bypass-hook-trust`.
 *   `workspace-write` (the only wider mode this unit implements) is scoped by
 *   the kernel to the `-C <dir>` you pass — and this adapter grants it ONLY to
 *   `codex_code_review` with an explicit `cwd`; research runs are read-only
 *   regardless of the fleet config. The fleet ceiling (OMELETTE_ALLOW_WRITE)
 *   still has to be open for it to reach the spawn at all.
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
 * AUTH — `codex login status` prints "Logged in using ChatGPT" when fine; a
 * signed-out run fails with a login hint on stderr and nothing on stdout,
 * which the runtime turns into an actionable message (never a retry).
 */
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { defineUnit } from '../../core/unit.mjs';
import { makeCatalog } from '../../core/catalog.mjs';
import { CODEX_MODELS, EFFORTS, GUIDE } from './models.js';

export const catalog = makeCatalog({
  models: CODEX_MODELS,
  efforts: EFFORTS,
  guide: GUIDE,
  title: 'CODEX MODEL CATALOG',
  vendorDefaultNote: 'omit `model` for the fleet default, else the first id below — this unit ignores ~/.codex/config.toml',
});

const READONLY_PREFIX =
  'You are a read-only research and code-analysis assistant running inside a ' +
  'read-only sandbox. Do NOT attempt to modify files, run git, deploy, or ' +
  'publish — you only read, search, and use web search. Answer in plain text.\n\n';

const WORKSPACE_WRITE_PREFIX =
  'You are a code assistant working inside a sandbox that allows edits ONLY ' +
  'within the working directory. Never run git commands that change history or ' +
  'remotes (commit, push, merge, rebase, reset, tag), never deploy or publish. ' +
  'Explain every change you make. Answer in plain text.\n\n';

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
 * Turn a finished run into { text, usage } or throw a clear error. Exported for tests.
 * @param {{stdout:string, stderr:string, code:number|null, killed:boolean}} res
 * @param {{timeoutS?:number}} o
 */
export function extractResult(res, { timeoutS } = {}) {
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

  if (res.killed) {
    throw new Error(`codex hard-killed after ${timeoutS ?? '?'}s (raise codex.timeoutS in the fleet config)`);
  }
  if (failed) {
    const msg = errorText(failed.error && (failed.error.message || failed.error)) || errors.at(-1) || 'unknown';
    throw new Error(`codex turn failed: ${msg}`);
  }
  if (!messages.length) {
    const tail = errors.at(-1) || res.stderr.trim().slice(-500) || '(no stderr)';
    throw new Error(res.code === 0 ? `codex produced no answer: ${tail}` : `codex exited ${res.code}: ${tail}`);
  }
  // The final agent_message is the answer; earlier ones are narration.
  let text = messages.at(-1);
  if (!completed) text += '\n\n[codex: run ended before turn.completed — treat as partial]';
  // A non-zero exit WITH an answer: keep the answer (the run is paid for and
  // the text is usually the useful part) but never let it read as a clean one.
  if (res.code !== 0) text += `\n\n[codex: CLI exited ${res.code} — treat the answer as partial]`;
  return { text, usage, searches };
}

/** Pre-spawn validation of an optional review directory. */
function checkCwd(raw) {
  if (raw === undefined) return { cwd: '' };
  const cwd = typeof raw === 'string' ? raw.trim() : '';
  if (!cwd || !isAbsolute(cwd)) return { error: `Error: "cwd" must be an absolute path (got ${JSON.stringify(raw)}).` };
  let st;
  try { st = statSync(cwd); } catch { st = null; }
  if (!st || !st.isDirectory()) return { error: `Error: "cwd" is not an existing directory: ${cwd}` };
  return { cwd };
}

const isDeterministic = (e) => /not authenticated|turn failed|hard-killed|not found in PATH/i.test((e && e.message) || '');

async function runOnce(ctx, { prompt, cwd, mode }) {
  // --ignore-user-config removed the operator's configured default, so an
  // unpinned run would take whatever the CLI hard-codes. Pin the catalog head.
  const model = ctx.model || catalog.ids[0];
  if (!ctx.model) ctx.log(`no model configured — pinning the catalog default ${model} (--ignore-user-config means ~/.codex/config.toml is not consulted)`);
  const args = buildArgs({ model, effort: ctx.effort, cwd, mode, webSearch: ctx.cfg.webSearch });
  ctx.log(`codex exec · sandbox=${mode} · model=${model}${ctx.model ? '' : ' (catalog default)'} · effort=${ctx.effort || '(default)'} · web=${ctx.cfg.webSearch} · cwd=${cwd || '(process cwd)'}`);
  const res = await ctx.spawn({ args, cwd: cwd || undefined, stdinText: prompt });
  const out = extractResult(res, { timeoutS: ctx.cfg.timeoutS });
  if (out.usage) ctx.log(`codex done · tokens in=${out.usage.input} (cached ${out.usage.cachedInput}) out=${out.usage.output} reasoning=${out.usage.reasoning} · web_search=${out.searches}`);
  return out;
}

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
  bin: { env: 'CODEX_BIN', default: 'codex' },
  billingRiskEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  // CODEX_HOME (where auth lives, still read under --ignore-user-config) and the
  // CLI's other knobs; CODEX_API_KEY matches the pattern and the scrub deletes it after.
  envPassthrough: ['CODEX_*'],
  envMap: { model: 'CODEX_DEFAULT_MODEL', effort: 'CODEX_EFFORT', timeoutS: 'CODEX_TIMEOUT_S', webSearch: 'CODEX_WEB_SEARCH' },
  builtin: { timeoutS: 600, effort: 'high', webSearch: true },
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
        'regardless of fleet config. Returns the final answer as plain text and ' +
        'reports real token usage to the fleet status feed. ' + GUIDE,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The research question or task for Codex.' },
          effort: EFFORT_PROP,
          model: MODEL_PROP,
        },
        required: ['prompt'],
      },
      async run(args, ctx) {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return { text: 'Error: "prompt" is required.', isError: true };
        // Research is read-only no matter what the config says (no directory to scope a write to).
        return ctx.retry(() => runOnce(ctx, { prompt: READONLY_PREFIX + prompt, mode: 'read-only' }), { skipIf: isDeterministic });
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
      name: 'codex_models',
      kind: 'catalog',
      description:
        'List the Codex models you can pass as `model` to codex_research / ' +
        'codex_code_review, the allowed `effort` levels, and a "route to / route ' +
        'AWAY" cheat-sheet. No arguments, no spawn — local catalog read.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
});
