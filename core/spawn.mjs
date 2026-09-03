/**
 * omelette-fleet :: core/spawn.mjs
 * One headless vendor-CLI run, bounded in every direction:
 *   - own process group (`detached`) so a wall-clock timeout can SIGKILL the
 *     whole tree, not just the top process;
 *   - stdout kept to a tail cap (a runaway model cannot exhaust memory);
 *   - stderr kept to a short tail for error messages;
 *   - the child env built from an ALLOWLIST, not inherited (see below);
 *   - billing-risk env vars deleted from the child env (see units/*: an API
 *     key reaching a CLI silently switches it from subscription to metered API);
 *   - ENOENT surfaced as an actionable "install X" message, never a stack.
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
 *      the right CAs. Nothing here is a credential.
 *   2. the unit's `envPassthrough` (adapter-declared exact names or `PREFIX_*`
 *      patterns, e.g. 'CODEX_*') — the vendor's own knobs.
 *   3. OMELETTE_ENV_PASSTHROUGH — comma-separated names/patterns, the
 *      operator's fleet-wide escape hatch when a CLI needs one more variable.
 *   4. THEN the billing scrub (a vendor prefix pattern can otherwise re-admit
 *      the API key the unit deletes on purpose), and only then `extra`, the
 *      adapter's own additions (e.g. GROK_WEB_FETCH=1), which always apply.
 * A variable that is absent from the parent env is absent from the child —
 * empty strings are NOT synthesized, because "set but empty" means something
 * different from "unset" to several CLIs.
 *
 * `inheritEnv: true` OPTS OUT of all of the above: the child gets the parent
 * environment untouched — no allowlist, no passthrough, no billing scrub (only
 * `extraEnv` still applies on top). FOR THE OPERATOR'S OWN TOOLS ONLY — that
 * is `claude mcp add` from bin/omelette-fleet.mjs, which must see
 * CLAUDE_CONFIG_DIR and the version-manager variables that decide WHERE the
 * registration lands and which node runs it. NEVER for a vendor CLI: there is
 * no model reading the environment in `claude mcp add`, and there always is
 * one in `codex exec`.
 */
import { spawn } from 'node:child_process';

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

/** Fleet-wide operator extension of the allowlist. */
export const ENV_PASSTHROUGH_VAR = 'OMELETTE_ENV_PASSTHROUGH';

const matches = (pattern, name) => (pattern.endsWith('*')
  ? name.startsWith(pattern.slice(0, -1))
  : name === pattern);

/**
 * Build a child environment from the allowlist. Pure — exported for tests.
 * @param {{env?:object, allow?:string[], passthrough?:string[], scrub?:string[], extra?:object}} o
 *   passthrough: exact names or `PREFIX_*` patterns, added to `allow`.
 *   scrub: names deleted AFTER the allowlist (billing keys).
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
  for (const name of scrub) delete out[name];
  return extra ? { ...out, ...extra } : out;
}

/**
 * @param {{bin:string, args:string[], cwd?:string, env?:object, envPassthrough?:string[],
 *          extraEnv?:object, scrubEnv?:string[], inheritEnv?:boolean, hardKillMs?:number,
 *          outputCap?:number, stdinText?:string, notFoundHelp?:string, log?:(m:string)=>void}} o
 *   env is the PARENT environment to select from — never the child env itself.
 *   inheritEnv: hand the parent env over untouched (operator tools only, see header).
 * @returns {Promise<{stdout:string, stderr:string, code:number|null, signal:string|null, killed:boolean}>}
 */
export function runProcess({
  bin, args, cwd, env = process.env, envPassthrough = [], extraEnv, scrubEnv = [], inheritEnv = false,
  hardKillMs = 0, outputCap = OUTPUT_CAP, stdinText, notFoundHelp, log = () => {},
}) {
  return new Promise((resolve, reject) => {
    const childEnv = inheritEnv
      ? { ...env, ...(extraEnv || {}) }
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

    let out = '';
    let errBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out = (out + c).slice(-outputCap); });
    child.stdout.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { errBuf = (errBuf + c).slice(-STDERR_CAP); });
    child.stderr.on('error', () => {});
    if (stdinText != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdinText);
    }

    let killed = false;
    let settled = false;
    const timer = hardKillMs > 0
      ? setTimeout(() => {
        killed = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      }, hardKillMs)
      : null;
    if (timer && timer.unref) timer.unref();

    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (e && e.code === 'ENOENT') {
        reject(new Error(notFoundHelp || `${bin} not found in PATH`));
        return;
      }
      reject(new Error(`${bin} process error: ${(e && e.message) || e}`));
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      log(`exit ${bin} · code=${code} · signal=${signal || '-'}${killed ? ' · HARD-KILLED' : ''}`);
      resolve({ stdout: out, stderr: errBuf, code, signal, killed });
    });
  });
}
