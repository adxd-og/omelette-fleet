/**
 * omelette-fleet :: core/spawn.mjs
 * One headless vendor-CLI run, bounded in every direction:
 *   - own process group (`detached`) so a wall-clock timeout can SIGKILL the
 *     whole tree, not just the top process;
 *   - stdout kept to a tail cap (a runaway model cannot exhaust memory);
 *   - stderr kept to a short tail for error messages;
 *   - billing-risk env vars deleted from the child env (see units/*: an API
 *     key reaching a CLI silently switches it from subscription to metered API);
 *   - ENOENT surfaced as an actionable "install X" message, never a stack.
 *
 * Never rejects on a non-zero exit — the unit's own parser decides what an
 * exit code means for that CLI. Rejects only when the process could not run.
 */
import { spawn } from 'node:child_process';

export const OUTPUT_CAP = 400000;
export const STDERR_CAP = 8192;

/**
 * @param {{bin:string, args:string[], cwd?:string, env?:object, scrubEnv?:string[],
 *          hardKillMs?:number, outputCap?:number, stdinText?:string,
 *          notFoundHelp?:string, log?:(m:string)=>void}} o
 * @returns {Promise<{stdout:string, stderr:string, code:number|null, signal:string|null, killed:boolean}>}
 */
export function runProcess({
  bin, args, cwd, env = process.env, scrubEnv = [], hardKillMs = 0,
  outputCap = OUTPUT_CAP, stdinText, notFoundHelp, log = () => {},
}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...env };
    for (const k of scrubEnv) delete childEnv[k];

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
