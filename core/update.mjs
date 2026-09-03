/**
 * omelette-fleet :: core/update.mjs
 * "Is there a newer fleet?" — one unauthenticated GitHub call, cached on disk,
 * and never in the way of a tool call.
 *
 * THE RULES THIS FILE OBEYS, because an update check is the last thing that may
 * break a research run:
 *   - NEVER THROWS where a unit can see it. `cachedCheck` resolves with
 *     `{ latest: null, error }` on every failure — no network, DNS down, a rate
 *     limit, a proxy that answers HTML, a clock that went backwards. Only the
 *     lower-level `checkLatest` rejects, and only the CLI/`cachedCheck` call it.
 *   - NEVER BLOCKS. The startup hook (`announceUpdate`) is fire-and-forget: the
 *     MCP server is already serving before the request is even sent, and a
 *     2.5s AbortController deadline caps the whole exchange.
 *   - NEVER SPENDS THE NETWORK TWICE A DAY. `<home>/update-check.json` holds
 *     the last answer for 24h; a fresh cache means no request at all.
 *   - OPT-OUT IS ABSOLUTE. OMELETTE_UPDATE_CHECK=0 (or false/off/no) wins over
 *     the config file, so an offline or air-gapped machine can silence it from
 *     the MCP server's own env block — the one place a project cannot reach.
 *
 * WHAT IS COMPARED: the package.json version of THIS checkout against the
 * `tag_name` of the repository's latest GitHub release. Nothing is downloaded
 * and nothing is executed — the answer is a string and a boolean.
 *
 * OMELETTE_PKG_ROOT relocates "this checkout" for tests only (see
 * bin/omelette-fleet.mjs): it is honoured by `packageRoot`, and therefore by
 * `detectInstall` and the `update` command, and by nothing else.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetHome, fleetSettings } from './config.mjs';

export const RELEASES_URL = 'https://api.github.com/repos/adxd-og/omelette-fleet/releases/latest';
export const RELEASES_PAGE = 'https://github.com/adxd-og/omelette-fleet/releases/latest';
export const CHECK_FILE = 'update-check.json';
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 2500;

/** This file lives in <root>/core, so the package root is one level up. */
const OWN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The package root — OMELETTE_PKG_ROOT (a test hook) wins when it is set. */
export function packageRoot(env = process.env) {
  return String(env.OMELETTE_PKG_ROOT || '').trim() || OWN_ROOT;
}

/** The version in <root>/package.json, or '0.0.0' when it cannot be read. */
export function currentVersion(root = packageRoot()) {
  try {
    const v = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    return typeof v === 'string' && v.trim() ? v.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * THIS package's version, read once at load. Deliberately not `currentVersion()`:
 * the OMELETTE_PKG_ROOT test hook must never change what a running MCP server
 * reports about itself in `initialize`.
 */
export const VERSION = currentVersion(OWN_ROOT);

/**
 * -1 / 0 / 1 for "x.y.z" strings. A leading "v" is ignored and anything that is
 * not a number (a missing part, `1.2.3-rc1`, garbage) counts as 0 — a version
 * we cannot read must never be reported as NEWER than what is installed.
 */
export function compareSemver(a, b) {
  const parts = (v) => {
    const raw = String(v == null ? '' : v).trim().replace(/^v/i, '').split('.');
    return [0, 1, 2].map((i) => {
      const n = Number(raw[i]);
      return Number.isFinite(n) ? n : 0;
    });
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] < y[i]) return -1;
    if (x[i] > y[i]) return 1;
  }
  return 0;
}

/** Reject as soon as the deadline fires, even for a fetch that ignores the signal. */
function withDeadline(promise, signal, timeoutMs) {
  const aborted = () => new Error(`update check timed out after ${timeoutMs}ms`);
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      if (signal.aborted) { reject(aborted()); return; }
      signal.addEventListener('abort', () => reject(aborted()), { once: true });
    }),
  ]);
}

/**
 * One live call to the GitHub releases API. THROWS on anything unusable — a
 * network failure, a non-2xx answer, a body that is not JSON, a tag that is not
 * a version. Callers that must not fail use `cachedCheck` instead.
 *
 * @param {{current:string, fetchImpl?:Function, timeoutMs?:number, userAgent?:string}} o
 * @returns {Promise<{current:string, latest:string, behind:boolean, url:string}>}
 */
export async function checkLatest({
  current, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, userAgent,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('update check: no fetch implementation available');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  // An update check must never hold the process open by itself.
  if (timer.unref) timer.unref();
  try {
    const res = await withDeadline(fetchImpl(RELEASES_URL, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': userAgent || `omelette-fleet/${current || '0.0.0'}`,
      },
    }), controller.signal, timeoutMs);
    if (!res || typeof res !== 'object') throw new Error('update check: empty response');
    if (res.ok === false) throw new Error(`update check: GitHub answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    const body = await withDeadline(res.json(), controller.signal, timeoutMs);
    const tag = body && typeof body === 'object' ? (body.tag_name || body.name) : null;
    const latest = String(tag == null ? '' : tag).trim().replace(/^v/i, '');
    if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error(`update check: unusable release tag ${JSON.stringify(tag == null ? null : String(tag))}`);
    const url = body && typeof body.html_url === 'string' && body.html_url ? body.html_url : RELEASES_PAGE;
    return { current, latest, behind: compareSemver(current, latest) < 0, url };
  } finally {
    clearTimeout(timer);
  }
}

function readCache(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const checkedAt = Number(raw.checkedAt);
    const latest = typeof raw.latest === 'string' ? raw.latest.trim() : '';
    if (!Number.isFinite(checkedAt) || !latest) return null;
    return { checkedAt, latest, url: typeof raw.url === 'string' && raw.url ? raw.url : RELEASES_PAGE };
  } catch {
    return null; // absent, unreadable or garbage — all mean "no cache"
  }
}

/** tmp + rename, 0600: a half-written cache would be read as garbage on the next start. */
function writeCache(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    return false; // a cache we cannot write is a slower check, not a failure
  }
}

/**
 * The check every caller should use. NEVER THROWS and never fetches more often
 * than the TTL. A failed fetch leaves the previous cache file alone — a rate
 * limit at 09:00 must not cost the answer that was already good at 08:00.
 *
 * @param {{home?:string, current:string, ttlMs?:number, fetchImpl?:Function,
 *          now?:(()=>number)|number, timeoutMs?:number, userAgent?:string}} o
 * @returns {Promise<{current:string, latest:string|null, behind:boolean, url?:string,
 *                    cached?:boolean, error?:string}>}
 */
export async function cachedCheck({
  home, current, ttlMs = DEFAULT_TTL_MS, fetchImpl, now, timeoutMs, userAgent,
} = {}) {
  try {
    const dir = home || fleetHome();
    const file = join(dir, CHECK_FILE);
    const at = typeof now === 'function' ? Number(now()) : (Number.isFinite(now) ? Number(now) : Date.now());
    const stamp = Number.isFinite(at) ? at : Date.now();
    const ttl = Number.isFinite(Number(ttlMs)) ? Number(ttlMs) : DEFAULT_TTL_MS;

    const cached = readCache(file);
    // A cache stamped in the future (a clock that moved) is stale, not eternal.
    const age = cached ? stamp - cached.checkedAt : Infinity;
    if (cached && ttl > 0 && age >= 0 && age < ttl) {
      return {
        current,
        latest: cached.latest,
        behind: compareSemver(current, cached.latest) < 0,
        url: cached.url,
        cached: true,
      };
    }

    const fresh = await checkLatest({ current, fetchImpl, timeoutMs, userAgent });
    writeCache(file, { checkedAt: stamp, latest: fresh.latest, url: fresh.url });
    return { ...fresh, cached: false };
  } catch (e) {
    return { current, latest: null, behind: false, error: (e && e.message) || String(e) };
  }
}

const OFF_WORDS = new Set(['0', 'false', 'off', 'no']);

/**
 * Is the check allowed to run at all? The env switch is the hard one — it is
 * set on the machine, outside every project — and the config key is the soft
 * one. Anything else (unset, "1", nonsense) leaves the default in force.
 *
 * @param {{env?:object, config?:{updateCheck?:boolean}}} o
 *   config: a `fleetSettings()` result (or anything with `updateCheck`); read
 *   from the fleet config file when omitted.
 */
export function updateCheckEnabled({ env = process.env, config } = {}) {
  const raw = String(env.OMELETTE_UPDATE_CHECK == null ? '' : env.OMELETTE_UPDATE_CHECK).trim().toLowerCase();
  if (raw && OFF_WORDS.has(raw)) return false;
  const settings = config && typeof config === 'object' ? config : fleetSettings(env);
  return settings.updateCheck !== false;
}

/** 'git' for a checkout that can be pulled, 'npm' for an installed package. */
export function detectInstall(pkgRoot = packageRoot()) {
  return existsSync(join(pkgRoot, '.git')) ? 'git' : 'npm';
}

/**
 * The startup hook, extracted so it can be tested without stdin/stdout. Logs at
 * most ONE line, and only when there really is something newer. RESOLVES ON
 * EVERY PATH — `startUnit` attaches `.then` only, so a rejection here would
 * become an unhandled rejection in a live MCP server.
 */
export async function announceUpdate({ home, current, env = process.env, log = () => {}, fetchImpl, now, ttlMs } = {}) {
  try {
    if (!updateCheckEnabled({ env })) return null;
    const r = await cachedCheck({ home, current, fetchImpl, now, ttlMs });
    if (r && r.behind && r.latest) {
      log(`update: omelette-fleet ${r.latest} is available (you run ${current}) — run \`omelette-fleet update\``);
    }
    return r;
  } catch {
    return null; // an update check is never a reason for a unit to misbehave
  }
}
