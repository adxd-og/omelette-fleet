/**
 * omelette-fleet :: core/spawn.mjs
 * One headless vendor-CLI run, bounded in every direction:
 *   - own process group (`detached`) so a wall-clock timeout can SIGKILL the
 *     whole tree, not just the top process
 *     (the same kill answers a cancelled request when one is passed a `signal`);
 *   - stdout kept to a tail cap (a runaway model cannot exhaust memory), the
 *     result carrying `capped: true` when the cap actually dropped characters —
 *     a TAIL cap drops the BEGINNING, so a parser reading a stream from the top
 *     is looking at a fragment and has to be told rather than left to guess;
 *   - stderr kept to a short tail for error messages;
 *   - the child env built from an ALLOWLIST, not inherited (see below);
 *   - billing-risk env vars deleted from the child env (see units/*: an API
 *     key reaching a CLI silently switches it from subscription to metered API);
 *   - ENOENT surfaced as an actionable "install X" message, never a stack;
 *   - every live group listed in this process, so a server that is told to
 *     stop (SIGTERM/SIGHUP, see core/jsonrpc.mjs `serve`) can kill them all
 *     with `killLiveGroups()` instead of leaving them to run unbounded.
 *
 * Never rejects on a non-zero exit — the unit's own parser decides what an
 * exit code means for that CLI. Rejects only when the process could not run.
 *
 * THE ENV ALLOWLIST — a vendor CLI runs a model that can execute read-only
 * shell commands, so ANY variable the child can see is readable by the model.
 * Inheriting the MCP server's environment therefore hands a review run the
 * operator's GH_TOKEN, cloud credentials and every other secret that happens
 * to sit in the shell. The child env is built from scratch instead:
 *   1. ALLOWED_ENV — the exact names below: what a CLI needs to find its
 *      binary and home, speak the right language, resolve a proxy and trust
 *      the right CAs. None of them is meant to carry a credential — but a
 *      proxy URL can (`http://user:pass@proxy`), and it is passed AS IS,
 *      userinfo included, because the CLI needs that exact URL to reach its
 *      API (docs/SECURITY.md, "The environment allowlist").
 *   2. the unit's `envPassthrough` (adapter-declared exact names; `PREFIX_*`
 *      patterns are accepted from `OMELETTE_ENV_PASSTHROUGH` alone) — the vendor's own knobs.
 *   3. OMELETTE_ENV_PASSTHROUGH — comma-separated names/patterns, the
 *      operator's fleet-wide escape hatch when a CLI needs one more variable.
 *   4. THEN the billing scrub (a vendor prefix pattern can otherwise re-admit
 *      the API key the unit deletes on purpose) and the scrub of every other
 *      vendor's credential (VENDOR_CREDENTIALS), and only then `extra`, the
 *      adapter's own additions (e.g. GROK_WEB_FETCH=1), which always apply.
 * A variable that is absent from the parent env is absent from the child —
 * empty strings are NOT synthesized, because "set but empty" means something
 * different from "unset" to several CLIs.
 *
 * PATH GOES OVER WITH ITS ABSOLUTE ENTRIES ONLY, in their order. A vendor CLI
 * that is a script (`#!/usr/bin/env node`) has its interpreter looked up in the
 * CHILD's PATH, from the directory the call runs in — where an empty, `.` or
 * relative entry finds whatever a caller planted (the premise of S17, which
 * core/unit.mjs's locateBin answers for the CLI itself). With no absolute entry
 * left the child gets no PATH at all, never an empty one: an empty PATH is
 * itself a search of the current directory.
 *
 * `inheritEnv: true` OPTS OUT of all of the above: the child gets the parent
 * environment — no allowlist, no passthrough, no billing scrub (only
 * `extraEnv` still applies on top) — with ONE thing removed: PATH's relative
 * and empty entries, by the same rule as above. Those children (the `gh`
 * probe, `runGit` and `runClaude` in bin/omelette-fleet.mjs) run with a cwd
 * inside a repository, where a relative entry (`bin`) finds that repository's
 * own files. FOR THE OPERATOR'S OWN TOOLS ONLY — e.g.
 * `claude mcp add` from bin/omelette-fleet.mjs, which must see
 * CLAUDE_CONFIG_DIR and the version-manager variables that decide WHERE the
 * registration lands and which node runs it. NEVER for a vendor CLI: there is
 * no model reading the environment in `claude mcp add`, and there always is
 * one in `codex exec`.
 */
import { spawn } from 'node:child_process';
import { delimiter, isAbsolute } from 'node:path';

export const OUTPUT_CAP = 400000;
export const STDERR_CAP = 8192;

/** Exact env names every child may see. Extend per unit with `envPassthrough`, not here. */
export const ALLOWED_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
];

/**
 * The group leaders this process started, as ChildProcess objects. Each run's
 * child is a group leader (`detached: true` below), so the leader's pid names
 * the whole group, and the group id outlives the leader for as long as the
 * group has members — a grandchild of the same group is still reached by
 * `-pid` after the leader has exited. An entry goes on `close` or `error`,
 * and at the leader's `exit` when its group is already empty.
 *
 * WHAT THE PROBE KNOWS. `kill(-pid, 0)` tells "group exists" from "group
 * gone", not ours from a stranger's. The exit-time deletion closes the
 * empty-group case: a group that is empty when its leader exits is forgotten
 * before its id can be handed out again. The window left is accepted: a
 * same-group member dies after the leader while a process of ANOTHER group
 * still holds our pipes (so `close` has not come), and a stranger takes the
 * id in between. docs/MEASUREMENTS.md ("Unit processes after the server is
 * gone") found nothing left in a group after a normal run.
 */
const LIVE = new Set();

/** Does process group `pgid` still have a member? Any error counts as no. */
const groupExists = (pgid) => {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
};

/**
 * SIGKILL every listed group that still has a member — whether or not its
 * leader has exited — and forget them all. For a process that is going away:
 * a server told to stop kills what it started, since its own hard-kill timers
 * die with it. Never throws; returns how many groups the signal reached.
 */
export function killLiveGroups() {
  let n = 0;
  for (const child of LIVE) {
    if (!groupExists(child.pid)) continue; // gone: forgotten below, never signalled
    try { process.kill(-child.pid, 'SIGKILL'); n++; } catch { /* gone in between */ }
  }
  LIVE.clear();
  return n;
}

/** How many groups are listed as live (tests). */
export const liveGroupCount = () => LIVE.size;

/** Fleet-wide operator extension of the allowlist. */
export const ENV_PASSTHROUGH_VAR = 'OMELETTE_ENV_PASSTHROUGH';

/**
 * Every vendor's riskEnv, scrubbed from EVERY unit's child. OMELETTE_ENV_PASSTHROUGH
 * applies fleet-wide, so a `CODEX_*` pattern meant for Codex would otherwise hand
 * CODEX_API_KEY to Grok and Gemini, whose own lists do not name it. A copy, not an
 * import (core never depends on units): a vendor adds a key, its adapter names it,
 * and this union is updated at the next release — test/billing-scrub-1.7.2.test.mjs
 * fails the suite until it is.
 */
export const BILLING_ENV = [
  // units/codex/adapter.mjs `riskEnv`
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_EXEC_SERVER_URL',
  // units/grok/adapter.mjs `RISK_ENV`
  'XAI_API_KEY', 'GROK_CODE_XAI_API_KEY', 'GROK_WEB_FETCH_ALLOW_LOCAL', 'GROK_MEMORY',
  'GROK_FOLDER_TRUST', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_WEB_FETCH_PROXY',
  'GROK_TRACE_UPLOAD_URL', 'GROK_TRACE_UPLOAD_BUCKET', 'GROK_TRACE_UPLOAD_ENDPOINT_URL',
  'GROK_TRACE_UPLOAD_CREDENTIALS_FILE', 'GROK_CLAUDE_HOOKS_ENABLED', 'GROK_CURSOR_HOOKS_ENABLED',
  // units/gemini/adapter.mjs `RISK_ENV`
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES',
];

/**
 * Every vendor's own login credential that its adapter ADMITS by name (its
 * `envPassthrough`), so no scrub list can hold it: through the fleet-wide
 * OMELETTE_ENV_PASSTHROUGH a `CODEX_*` pattern would hand Codex's token to Grok
 * and Gemini. buildChildEnv scrubs each of these from every child whose own
 * `passthrough` does not name it — the unit keeps its own vendor's credential.
 * A copy, not an import, as BILLING_ENV; test/billing-scrub-1.7.2.test.mjs fails
 * the suite when a credential-looking passthrough name is neither here nor a
 * named exception there. Left out: AGY_ADC_AUTH (a boolean switch, `=true`,
 * selecting the ADC login, not a secret), CODEX_HOME and GROK_HOME (state
 * directories: a path, not a secret) and grok's GROK_AUTH_* label and timing
 * preferences (class B).
 */
export const VENDOR_CREDENTIALS = [
  // units/codex/adapter.mjs `PASSTHROUGH`: codex-cli 0.156.1's documented explicit access token
  'CODEX_ACCESS_TOKEN',
];

const matches = (pattern, name) => (pattern.endsWith('*')
  ? name.startsWith(pattern.slice(0, -1))
  : name === pattern);

/**
 * The absolute, non-empty entries of a PATH value, in order. An empty or
 * relative entry is searched in whatever directory the child (or the lookup)
 * happens to stand in — a foreign repository's `bin/` — so it is dropped.
 * @param {string|undefined} path
 * @returns {string[]}
 */
export function absolutePathEntries(path) {
  return String(path || '').split(delimiter).filter((dir) => dir && isAbsolute(dir));
}

/**
 * The parent env for an `inheritEnv` child: every variable, PATH reduced to its
 * absolute entries (see header). Exported for core/client.mjs, which starts a
 * unit server with it. Never mutates `env`.
 */
export function inheritedEnv(env) {
  const out = { ...env };
  if (out.PATH !== undefined) {
    const absolute = absolutePathEntries(out.PATH);
    if (absolute.length) out.PATH = absolute.join(delimiter);
    else delete out.PATH;
  }
  return out;
}

/**
 * Build a child environment from the allowlist. Pure — exported for tests.
 * @param {{env?:object, allow?:string[], passthrough?:string[], scrub?:string[], extra?:object}} o
 *   passthrough: exact names or `PREFIX_*` patterns, added to `allow`; a
 *     VENDOR_CREDENTIALS name survives only when this list names it exactly.
 *   scrub: names deleted AFTER the allowlist (billing keys), in addition to BILLING_ENV.
 *   extra: applied last and unconditionally.
 */
export function buildChildEnv({ env = process.env, allow = ALLOWED_ENV, passthrough = [], scrub = [], extra } = {}) {
  const patterns = [
    ...passthrough,
    ...String(env[ENV_PASSTHROUGH_VAR] || '').split(',').map((s) => s.trim()).filter(Boolean),
  ];
  const out = {};
  for (const name of allow) if (env[name] !== undefined) out[name] = env[name];
  if (patterns.length) {
    for (const name of Object.keys(env)) {
      if (out[name] !== undefined) continue;
      if (patterns.some((p) => matches(p, name))) out[name] = env[name];
    }
  }
  if (out.PATH !== undefined) {
    const absolute = absolutePathEntries(out.PATH);
    if (absolute.length) out.PATH = absolute.join(delimiter);
    else delete out.PATH;
  }
  for (const name of [...BILLING_ENV, ...scrub]) delete out[name];
  // Exact names only: an OMELETTE_ENV_PASSTHROUGH pattern or name never makes another vendor's credential "own".
  for (const name of VENDOR_CREDENTIALS) if (!passthrough.includes(name)) delete out[name];
  return extra ? { ...out, ...extra } : out;
}

/**
 * @param {{bin:string, args:string[], cwd?:string, env?:object, envPassthrough?:string[],
 *          extraEnv?:object, scrubEnv?:string[], inheritEnv?:boolean, hardKillMs?:number,
 *          outputCap?:number, stdinText?:string, notFoundHelp?:string, log?:(m:string)=>void,
 *          signal?:AbortSignal}} o
 *   env is the PARENT environment to select from — never the child env itself.
 *   inheritEnv: hand the parent env over, PATH's relative entries removed (operator tools only, see header).
 *   outputCap: tail-keeping cap on stdout — the unit's `outputCap` config value.
 *   signal: when it aborts, the process GROUP is SIGKILLed exactly as the
 *     hard-kill timeout does, and the result carries `cancelled: true`.
 * @returns {Promise<{stdout:string, stderr:string, code:number|null, signal:string|null,
 *                    killed:boolean, capped:boolean, cancelled:boolean}>}
 *   capped: the cap dropped characters, so `stdout` starts mid-stream.
 *   cancelled: the run was killed because the REQUEST was cancelled, not because it ran long.
 */
export function runProcess({
  bin, args, cwd, env = process.env, envPassthrough = [], extraEnv, scrubEnv = [], inheritEnv = false,
  hardKillMs = 0, outputCap = OUTPUT_CAP, stdinText, notFoundHelp, log = () => {}, signal,
}) {
  return new Promise((resolve, reject) => {
    const childEnv = inheritEnv
      ? { ...inheritedEnv(env), ...(extraEnv || {}) }
      : buildChildEnv({ env, passthrough: envPassthrough, scrub: scrubEnv, extra: extraEnv });

    let child;
    try {
      child = spawn(bin, args, {
        cwd: cwd || process.cwd(),
        env: childEnv,
        detached: true,
        stdio: [stdinText != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`${bin} spawn failed: ${(err && err.message) || err}`));
      return;
    }
    // No pid means the spawn failed (ENOENT and friends arrive as 'error' below).
    // At the leader's exit the entry stays only while its group has a member
    // left: an empty group's id is free for the OS to reuse (see LIVE).
    if (child.pid) {
      LIVE.add(child);
      child.on('exit', () => { if (!groupExists(child.pid)) LIVE.delete(child); });
    }

    // THE TAIL, AS A QUEUE. Chunks go into an array with a running total, and
    // the HEAD is dropped while what remains still covers the cap — so what is
    // held is the shortest run of chunks containing the last `outputCap`
    // characters: the cap plus at most one chunk. Concatenating onto a string
    // instead cost a flatten and a full copy of the tail PER CHUNK; 50 MB of
    // 64 KiB chunks under a 4 MB cap moved about 3 GB of string through the
    // heap to keep 4 MB of it. One chunk above the cap is still held — a chunk
    // has to be held to be measured — and that transient is all that is left.
    const chunks = [];
    let total = 0;
    let dropped = false;
    // `slice(-0)` keeps the WHOLE string, so a cap of 0 has always meant "no
    // tail kept back, but say it was capped". Dropping under it would silently
    // change that for a caller nobody has audited, so the queue only drops
    // while there is a cap to drop against.
    const capping = outputCap > 0;
    let errBuf = '';
    let capped = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      chunks.push(c);
      total += c.length;
      while (capping && chunks.length > 1 && total - chunks[0].length >= outputCap) {
        total -= chunks.shift().length;
        dropped = true;
      }
    });
    child.stdout.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { errBuf = (errBuf + c).slice(-STDERR_CAP); });
    child.stderr.on('error', () => {});
    if (stdinText != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdinText);
    }

    let killed = false;
    let cancelled = false;
    let settled = false;
    // A process GROUP, not a process: `detached: true` above made this child a
    // group leader precisely so one signal reaches the tree it spawned.
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    const timer = hardKillMs > 0
      ? setTimeout(() => { killed = true; killGroup(); }, hardKillMs)
      : null;
    if (timer && timer.unref) timer.unref();
    // Cancellation is the same hard kill under another name: a request the
    // client abandoned must not leave a vendor CLI running on the operator's
    // subscription. (Only `cancel: kill` passes a signal down here — see
    // core/unit.mjs; `cancel: finish` deliberately lets the run end.)
    const onAbort = () => { killed = true; cancelled = true; killGroup(); };
    let detachAbort = () => {};
    if (signal) {
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        // One request can own many spawns (a deep-research pipeline): a listener
        // left behind per spawn would pile up on the same signal.
        detachAbort = () => { try { signal.removeEventListener('abort', onAbort); } catch { /* not a real signal */ } };
      }
    }

    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      detachAbort();
      LIVE.delete(child);
      if (settled) return;
      settled = true;
      if (e && e.code === 'ENOENT') {
        reject(new Error(notFoundHelp || `${bin} not found in PATH`));
        return;
      }
      reject(new Error(`${bin} process error: ${(e && e.message) || e}`));
    });
    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer);
      detachAbort();
      LIVE.delete(child);
      if (settled) return;
      settled = true;
      // `capped` counts characters DROPPED, not slices attempted: output that
      // lands exactly on the cap keeps every character and is not capped.
      capped = dropped || total > outputCap;
      // Joined ONCE, here. The leading excess sits entirely inside the head
      // chunk — the queue kept nothing more than that — so it comes off there
      // and the join produces exactly the tail, with no second copy of it.
      if (capping && total > outputCap) chunks[0] = chunks[0].slice(total - outputCap);
      const out = chunks.join('');
      log(`exit ${bin} · code=${code} · signal=${sig || '-'}${killed ? ' · HARD-KILLED' : ''}${cancelled ? ' · CANCELLED' : ''}${capped ? ` · OUTPUT-CAPPED at ${outputCap}` : ''}`);
      resolve({ stdout: out, stderr: errBuf, code, signal: sig, killed, capped, cancelled });
    });
  });
}
