/**
 * omelette-fleet :: mods/omelette-fleet/hooks/guard.mjs
 * Guard v2, the mod's delivery (1.8.0): the rendered guard script asked about
 * one tool call, as Claude Code's PreToolUse settings hook asks it. The script
 * decides, for every loop (the role gate is its own); this file finds it,
 * hands it the event on stdin and reads its exit code. Exit 2 is a refusal,
 * stderr its reason; anything else — another exit, a timeout, no rendered
 * script, no `node` — lets the call go on, so the mod never refuses for a
 * reason of its own. A missing script or `node` is said once per module load.
 *
 * Also the touched record's line for the pane: the file the script's
 * SubagentStop writes, named and counted, never written here; and the
 * handoff print (printHandoff): the script run as SessionStart on `clear`,
 * its text handed to the mod's SessionStart context entry.
 *
 * `$` is always spelled `$.noun.method(...)` literally: the engine scans the
 * source and refuses a call it did not see.
 */

/** One guard run's wall clock, the settings hook's git clock (GIT_TIMEOUT_MS). */
export const GUARD_TIMEOUT_MS = 2000;

export const NO_SCRIPT = 'guard v2: no rendered script — omelette-fleet rules --hooks';
export const NO_NODE = 'guard v2: node not found on PATH';

/** The rendered copy, never the package's template (`{{marker}}` on its line 1), under the project, then the user's home. */
const SCRIPT = '.claude/hooks/omelette-guard.mjs';

/** What the mod denies with when the script exits 2 and writes nothing: still the script's refusal. */
const UNSAID = 'omelette-guard refused this call (no reason on stderr)';

/** The deny text's bound in UTF-8 bytes, the CUT mark of a cut included: a reason, not a log. */
const DENY_MAX_BYTES = 2048;
const CUT = ' …';

/** ANSI escapes: CSI (ESC [ or C1 0x9b), OSC up to its BEL or ST, ESC and one more character; then any ESC left alone. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|\x1b/g;

/** What the escape pass can leave behind — a lone C1 introducer, a BEL, a CR, DEL — and a reason has no use for: every C0/C1 control but newline and tab. */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** The keys of `tool.call`'s input that are the engine's, not the tool's: left out of `tool_input`. */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent']);

/** A name the touched record's file name may carry: the script's AGENT_ID rule. */
const PLAIN = /^[\w-]{1,64}$/;

/** The notices said since this module loaded. */
const said = new Set();

/** Says `text` once per module load, in the transcript and the debug log; a notice that cannot be shown changes nothing. */
function sayOnce($, text) {
  if (said.has(text)) return;
  said.add(text);
  try {
    $.ui.log(text);
  } catch {
    // Nothing to fall back on: the call goes on either way.
  }
}

/** The UTF-8 bytes of one code point (a lone surrogate as the U+FFFD an encoder writes for it). */
function bytesOf(point) {
  const cp = point.codePointAt(0) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/**
 * The script's stderr as the reason the model reads: ANSI escapes stripped,
 * trimmed, and past DENY_MAX_BYTES cut on a code point with CUT after it, the
 * whole within the bound.
 * @param {string} stderr
 * @returns {string}
 */
export function denyText(stderr) {
  const text = String(stderr).replace(ANSI, '').replace(CONTROLS, '').trim();
  const room = DENY_MAX_BYTES - [...CUT].reduce((sum, point) => sum + bytesOf(point), 0);
  let bytes = 0;
  let end = 0;
  let cutAt = -1;
  for (const point of text) {
    bytes += bytesOf(point);
    if (cutAt < 0 && bytes > room) cutAt = end;
    if (bytes > DENY_MAX_BYTES) return `${text.slice(0, cutAt).trimEnd()}${CUT}`;
    end += point.length;
  }
  return text;
}

/** `dir` without its trailing slashes, so `${dir}/name` has one. */
const trimmed = (dir) => dir.replace(/\/+$/, '');

/**
 * A PATH with its absolute entries only, joined again; '' when none is. A
 * relative entry would look `node` up in whatever directory the child starts in.
 * @param {string | undefined} path
 * @returns {string}
 */
export function absolutePath(path) {
  return String(path ?? '').split(':').filter((dir) => dir.startsWith('/')).join(':');
}

/**
 * The rendered guard: `<cwd>/.claude/hooks/omelette-guard.mjs`, then
 * `<HOME>/.claude/hooks/omelette-guard.mjs`; none (said once) when neither exists.
 * @param {any} $ the engine interface
 * @param {string | undefined} cwd the loop's directory, absolute
 * @returns {Promise<string | undefined>}
 */
export async function findGuardScript($, cwd) {
  const home = await $.env.get('HOME');
  for (const dir of [cwd, home]) {
    if (typeof dir !== 'string' || !dir.startsWith('/')) continue;
    const path = `${trimmed(dir)}/${SCRIPT}`;
    if (await $.fs.exists(path).catch(() => false)) return path;
  }
  sayOnce($, NO_SCRIPT);
  return undefined;
}

/**
 * The PreToolUse event the script reads, from a `tool.call` input: the tool,
 * its own arguments as `tool_input`, the loop's role as `agent_type` when the
 * pane knows one (nothing on the main loop, as Claude Code sends it), the cwd.
 * @param {{ tool: unknown, [key: string]: unknown }} e `tool.call`'s input
 * @param {string | undefined} role
 * @param {string | undefined} cwd
 * @returns {{ hook_event_name: 'PreToolUse', tool_name: string, tool_input: Record<string, unknown>, agent_type?: string, cwd?: string }}
 */
export function toPreToolUse(e, role, cwd) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: String(e.tool),
    tool_input: Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED.has(key))),
    ...(typeof role === 'string' && role ? { agent_type: role } : {}),
    ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
  };
}

/** Whether an entry of `path` (absolute entries, joined) holds a `node`. */
async function hasNode($, path) {
  for (const dir of path.split(':')) {
    if (await $.fs.exists(`${trimmed(dir)}/node`).catch(() => false)) return true;
  }
  return false;
}

/**
 * Runs `node <script>` with `event` on stdin, `node` looked up in PATH's
 * absolute entries, under GUARD_TIMEOUT_MS: `{ deny }` with the script's
 * stderr on exit 2 (denyText: no ANSI, 2 KB at most), `{}` on any other exit, on a run that does not start or
 * outlasts the clock, and with no absolute PATH entry. A run that fails with
 * no `node` in PATH says so, once.
 * @param {any} $ the engine interface
 * @param {string} script the rendered guard's path
 * @param {object} event the PreToolUse event (toPreToolUse)
 * @returns {Promise<{ deny?: string }>}
 */
export async function askGuard($, script, event) {
  const path = absolutePath(await $.env.get('PATH'));
  if (!path) {
    sayOnce($, NO_NODE);
    return {};
  }
  let ran;
  try {
    ran = await $.process.run(['node', script], { stdin: JSON.stringify(event), timeoutMs: GUARD_TIMEOUT_MS, env: { PATH: path } });
  } catch {
    // It did not start, or ran past the clock: which one, only PATH says.
    if (!(await hasNode($, path))) sayOnce($, NO_NODE);
    return {};
  }
  return ran.exitCode === 2 ? { deny: denyText(ran.stderr ?? '') || UNSAID } : {};
}

/** The handoff print's wall clock: the guard sweeps before it prints. */
export const HANDOFF_TIMEOUT_MS = 5000;

/**
 * The text of the rendered guard's SessionStart print: `hookSpecificOutput.
 * additionalContext` when stdout is one JSON document carrying it as a string;
 * else stdout trimmed as it is (a script rendered before 1.8.0 prints plain text).
 * @param {string} stdout
 * @returns {string}
 */
function printedText(stdout) {
  const text = String(stdout ?? '');
  try {
    const context = JSON.parse(text)?.hookSpecificOutput?.additionalContext;
    if (typeof context === 'string') return context;
  } catch {
    // Not JSON: a pre-1.8.0 script's plain print.
  }
  return text.trim();
}

/**
 * Runs `node <script>` as Claude Code's SessionStart hook on `clear`, `node`
 * looked up in PATH's absolute entries, under HANDOFF_TIMEOUT_MS: the text it
 * prints (printedText); '' with no absolute PATH entry, on an exit other than
 * 0, and on a run that does not start or outlasts the clock. Never throws.
 * @param {any} $ the engine interface
 * @param {string} script the rendered guard's path
 * @param {string | undefined} cwd the session's directory, absolute
 * @returns {Promise<string>}
 */
export async function printHandoff($, script, cwd) {
  try {
    const path = absolutePath(await $.env.get('PATH'));
    if (!path) return '';
    const ran = await $.process.run(['node', script], {
      stdin: JSON.stringify({ hook_event_name: 'SessionStart', source: 'clear', cwd }),
      timeoutMs: HANDOFF_TIMEOUT_MS,
      env: { PATH: path },
    });
    return ran.exitCode === 0 ? printedText(ran.stdout) : '';
  } catch {
    return '';
  }
}

/**
 * The touched record the script's SubagentStop writes for a stopped agent,
 * relative to the agent's cwd: `.omelette/reports/touched-<role>-<id first 8>.md`;
 * none when the role or the id could not be part of a file name.
 * @param {unknown} agentType
 * @param {unknown} agentId
 * @returns {string | undefined}
 */
export function touchedPath(agentType, agentId) {
  if (typeof agentType !== 'string' || !PLAIN.test(agentType) || typeof agentId !== 'string' || !PLAIN.test(agentId)) return undefined;
  return `.omelette/reports/touched-${agentType}-${agentId.slice(0, 8)}.md`;
}

/**
 * The pane's line for a touched record: `touched: <path> — <n> files`, `n`
 * the record's `- ` lines (one per path the agent wrote).
 * @param {string} path
 * @param {string} record the record's text
 * @returns {string}
 */
export function touchedLine(path, record) {
  const files = String(record).split('\n').filter((line) => line.startsWith('- ')).length;
  return `touched: ${path} — ${files} ${files === 1 ? 'file' : 'files'}`;
}
