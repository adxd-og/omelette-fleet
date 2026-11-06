/**
 * omelette-fleet :: units/mistral/adapter.mjs
 * Mistral's Vibe CLI as a fleet unit — `mistral_security_review` and
 * `mistral_models`. Every call is one headless `vibe` run on the operator's
 * plan, signed in through the browser (the login lives in the Keychain).
 *
 * READ-ONLY POSTURE (review) — policy, not a kernel, the same class as
 * Gemini's: `--enabled-tools read_file --enabled-tools grep` and nothing else
 * (no shell, no web, no write tool), and the home's `outside_workdir = "deny"`.
 * The model reads what the operator can read under `--workdir`; the answer is
 * the only way out. Never passed: `-p` (the brief goes through
 * `--prompt-file`, a file this unit owns, 0600, `wx` — no argv limit, nothing
 * of it in `ps`), any `--dangerously-*` flag, any flag Vibe documents as
 * bypassing its policy. `--trust` trusts the workdir for this one invocation,
 * which a headless run in an untrusted folder requires.
 *
 * HOMES — `VIBE_HOME` is `<fleet home>/vibe/review/`, rendered by
 * units/mistral/home.mjs before every spawn (the policy block, the catalog as
 * Vibe `models`, session logging off, `[tools.bash] shell` = that home's
 * shell.sh); the operator's `~/.vibe` is never read or written. THE HOME KEEPS
 * NO SESSION: with Vibe's session log on, one run left its whole session — the
 * caller's prompt and every file the model read — under
 * `<home>/logs/session/unified/` (2026-11-06, Vibe 3.1.0), a second copy of
 * the reviewed code outliving the call. `[session_logging] enabled = false`
 * stops it; what the home still gathers (vibe.log, the plugin store) is
 * trimmed by capVibeLogs. `VIBE_HOME`, `TMPDIR` and
 * `OMELETTE_FLEET_HOME` reach the child through `extraEnv`, each
 * `realpathSync`'d: Seatbelt (the repro wrapper) matches resolved paths, and
 * `/var/folders/…` is not `/private/var/folders/…`.
 *
 * LOGIN-ENV PROBE — at start Vibe runs `<shell> -lc '…mistralai-vibe-login-env…;
 * exec env -0'` and adopts that output as the environment of every later tool
 * command. A login shell would source the operator's .zprofile / .zshrc and
 * re-admit every key the allowlist and the billing scrub just removed, so the
 * home's shell.sh answers the probe with its own environment and never starts
 * one (home.mjs). Review hands Vibe no `bash` tool at all; its wrapper refuses
 * any command that reaches it.
 *
 * FALLBACK REFUSAL — a home without the plan's catalog makes Vibe run
 * `mistral-medium-3.5` (paid) in place of the requested alias with one notice
 * line (spec, probe 5). After the run the adapter checks `export.json`
 * `config.active_model` — probe 5's fallback left it `""`, which is refused —
 * and withholds the answer when it is not the requested alias; it then checks
 * that the run carried the unit's policy (`outside_workdir`, MCP, connectors),
 * the proof that `VIBE_HOME` was honoured. Both refusals are deterministic: no
 * retry. A session record (`<output dir>/session/meta.json`, whose
 * `config.model_name` is the vendor name Vibe sent) is a second source when
 * present — on Vibe 3.1.0 the journal's assistant entries carry no model — but
 * the homes turn session logging off, which also keeps `session/` out of the
 * output dir: in the unit's own runs the check rests on export.json alone.
 *
 * OUTPUT — `--output text`: stdout is the final assistant message, the answer.
 * `--output-dir` (the call's spool tmp) receives `export.json` — outcome,
 * stop reason, usage, `cost_usd`, steps, the effective config — and, with
 * session logging off in the home, nothing else: no `session/`, so neither
 * the spool tmp nor the home keeps the prompt or what the model read beyond
 * the call. `export.json` is the record of the run: missing or unparsable, the
 * call fails naming the output dir; otherwise it is kept, byte for byte, under
 * `<fleet home>/results/mistral/exports/` (the newest `resultsKeep`), and the
 * answer's footer names it and the alias that ran. The spool tmp is removed
 * after the call. A hard kill (the run outlived its own `--time-limit`) is
 * never re-run.
 * `--time-limit` sits 15 s inside `timeoutS`, so Vibe stops itself (exit 3,
 * `outcome: deadline`) and still writes its answer and export before the
 * fleet's hard kill: a partial answer marked `deadline`, never re-run. Exit 3
 * on `--max-price` / `--max-turns` is not a deadline: it is marked `exited`.
 *
 * BILLING — `MISTRAL_API_KEY` is deleted from the child env (riskEnv, and
 * core/spawn.mjs's BILLING_ENV for every unit): the unit runs on the plan
 * through the Keychain login, never on a per-token key, and
 * OMELETTE_ENV_PASSTHROUGH cannot re-admit it. `cost_usd` is Vibe's estimate
 * from catalog prices, printed as `est.`; the console's Usage page is the bill.
 * `--max-price` (config `maxPrice`, dollars) is Vibe-enforced on the paid rows.
 *
 * AUTH — a signed-out run prints nothing on stdout and a login hint on stderr;
 * the runtime turns that into the operator action below (never a retry).
 */
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineUnit } from '../../core/unit.mjs';
import { makeCatalog } from '../../core/catalog.mjs';
import { checkCwd } from '../../core/cwd.mjs';
import { partialMark, withPartial } from '../../core/partial.mjs';
import { readRegularFile } from '../../core/status.mjs';
import { ensureHome, resolveAlias } from './home.mjs';
import { EFFORTS, GUIDE, MISTRAL_MODELS } from './models.js';

export const catalog = makeCatalog({
  models: MISTRAL_MODELS,
  efforts: EFFORTS,
  guide: GUIDE,
  title: 'MISTRAL MODEL CATALOG',
  vendorDefaultNote: 'omit `model` for the fleet default, mistral-large-4-0-3 — the unit runs Vibe under its own home, never ~/.vibe; `effort` moves within the model\'s family',
});

/** The only tools a review run hands Vibe. */
const REVIEW_TOOLS = ['read_file', 'grep'];

export const REVIEW_PREFIX =
  'You are a read-only security reviewer. You read files with read_file and grep inside the directory you are ' +
  'pointed at; you have no shell, no web and no write tool. Do NOT try to modify files, run commands, deploy, or ' +
  'publish. For each finding say what an attacker gains, in four parts — location · scenario · consequence · how ' +
  'to confirm — with the location as a path:line pointer relative to the working directory. Answer in plain text, ' +
  'findings only, no praise, and end with a `total: <n> findings` line.\n\n';

const AUTH_RE = /not logged in|sign in|login required|\b401\b/i;
const AUTH_HELP = 'run `vibe` once in a terminal and sign in through the browser; the login lives in the Keychain';

/**
 * The `vibe` argv (spec §1), one `--enabled-tools` per tool in `tools` order.
 * The review profile refuses any tool but read_file and grep.
 */
export function buildArgs({ profile, workdir, model, tools, maxTurns, maxPrice, timeLimitS, outDir, promptFile }) {
  if (profile !== 'review' && profile !== 'repro') throw new Error(`mistral: unknown profile "${profile}" (review | repro)`);
  const extra = profile === 'review' ? tools.filter((t) => !REVIEW_TOOLS.includes(t)) : [];
  if (extra.length) throw new Error(`mistral: the review profile runs ${REVIEW_TOOLS.join(' and ')} only — refusing ${extra.join(', ')}`);
  return [
    '--workdir', workdir, '--trust', '--agent', 'auto-approve',
    ...tools.flatMap((t) => ['--enabled-tools', t]),
    '--model', model,
    '--max-turns', String(maxTurns), '--max-price', String(maxPrice), '--time-limit', String(timeLimitS),
    '--output', 'text', '--output-dir', outDir, '--prompt-file', promptFile,
  ];
}

/**
 * `<outDir>/export.json`, parsed. Never follows a link at the leaf, and a
 * parse failure says only that — a JSON error quotes the bytes it choked on.
 * @returns {{ok:true, export:object, raw:string}|{ok:false, reason:string}}
 */
export function readExport(outDir) {
  const path = join(outDir, 'export.json');
  let raw;
  try {
    raw = readRegularFile(path);
  } catch (e) {
    return { ok: false, reason: e && e.code === 'ENOENT' ? `no export.json in ${outDir}` : `${path} could not be read (${(e && e.code) || e})` };
  }
  if (raw === null) return { ok: false, reason: `${path} is not a regular file` };
  let exp;
  try { exp = JSON.parse(raw); } catch { return { ok: false, reason: `${path} is not valid JSON` }; }
  if (!exp || typeof exp !== 'object' || Array.isArray(exp)) return { ok: false, reason: `${path} is not a JSON object` };
  return { ok: true, export: exp, raw };
}

/**
 * The model the session record names: `<outDir>/session/meta.json` (Vibe's
 * `journal_dir`) when its `session_id` is `sessionId` — `config.model_name`,
 * else `config.active_model`. Null when there is no such record.
 * @returns {{model:string}|null}
 */
export function readJournal({ outDir, sessionId }) {
  let meta;
  try {
    const text = readRegularFile(join(outDir, 'session', 'meta.json'));
    if (text === null) return null;
    meta = JSON.parse(text);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== 'object' || !sessionId || meta.session_id !== sessionId) return null;
  const config = (meta.config && typeof meta.config === 'object') ? meta.config : {};
  const model = [config.model_name, config.active_model].find((v) => typeof v === 'string' && v);
  return model ? { model } : null;
}

/** A directory of ours on the way to the exports: created 0700 when absent, refused when it is a symlink or not a directory. */
function exportDir(d) {
  try { mkdirSync(d, { mode: 0o700 }); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
  const st = lstatSync(d);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`mistral: ${d} is ${st.isSymbolicLink() ? 'a symlink' : 'not a directory'} — the export is not kept`);
  }
}

const EXPORT_NAME_RE = /^(\d{8}T\d{6}Z)-(\d+)-(\d+)\.export\.json$/;
let exportSeq = 0;

/**
 * Keep a run's raw `export.json` at
 * `<home>/results/mistral/exports/<ISO basic time>-<pid>-<seq>.export.json`
 * (`wx`, 0600; every directory on the way lstatted, as core/results.mjs does),
 * then unlink the oldest beyond `keep`. Throws, naming the path, on a link.
 * @returns {string} the kept file's path
 */
export function writeExport({ home, exportJson, keep = 50 }) {
  const dirs = [join(home, 'results'), join(home, 'results', 'mistral'), join(home, 'results', 'mistral', 'exports')];
  for (const d of dirs) exportDir(d);
  const dir = dirs[2];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const path = join(dir, `${stamp}-${process.pid}-${++exportSeq}.export.json`);
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, exportJson); } finally { closeSync(fd); }
  const rows = [];
  for (const name of readdirSync(dir)) {
    const m = EXPORT_NAME_RE.exec(name);
    if (!m) continue;
    try { if (!lstatSync(join(dir, name)).isFile()) continue; } catch { continue; }
    rows.push({ name, stamp: m[1], pid: Number(m[2]), seq: Number(m[3]) });
  }
  // Newest first: the time, then the pid and the per-process sequence.
  rows.sort((a, b) => (a.stamp === b.stamp ? (b.pid - a.pid) || (b.seq - a.seq) : (a.stamp < b.stamp ? 1 : -1)));
  for (const r of rows.slice(Math.max(1, keep))) {
    try { unlinkSync(join(dir, r.name)); } catch { /* another server got there first */ }
  }
  return path;
}

const show = (v) => (typeof v === 'string' ? v : String(JSON.stringify(v)));

/**
 * Turn a finished run and its export into `{ text, usage, partial?, footer }`,
 * or throw a refusal: the fallback (export or session record names another
 * model), the policy echo (the run did not carry the home's policy), then an
 * empty answer. `text` is the answer, the footer after a blank line, then any
 * marker (core/partial.mjs). Pure; exported for tests and the repro profile.
 * @param {{stdout:string, code:number|null, killed:boolean, capped?:boolean, cancelled?:boolean}} res
 * @param {object} exp the parsed export.json
 * @param {{requested:string, profile?:'review'|'repro', timeoutS:number, wrapper?:string,
 *          journal?:{model:string}|null, exportPath?:string, outputCap?:number}} o
 */
export function extractResult(res, exp, { requested, profile = 'review', timeoutS, wrapper = '', journal = null, exportPath = '', outputCap } = {}) {
  const config = (exp.config && typeof exp.config === 'object') ? exp.config : {};
  const vendorName = (catalog.find(requested) || {}).vendorName;
  const active = config.active_model;
  const journalOff = !!journal && journal.model !== requested && journal.model !== vendorName;
  if (active !== requested || journalOff) {
    // Probe 5's export named no model at all; the session record then says which one ran.
    const ran = typeof active === 'string' && active && active !== requested ? active
      : journalOff ? journal.model : 'a model export.json does not name';
    throw new Error(`mistral: Vibe ran ${ran} instead of the requested ${requested} — the home's models list is stale or the alias is unknown; the answer is withheld`);
  }
  const shell = config.tools && config.tools.bash ? config.tools.bash.shell : undefined;
  const policy = [
    ['outside_workdir', config.outside_workdir, 'deny'],
    ['enable_mcp', config.enable_mcp, false],
    ['enable_connectors', config.enable_connectors, false],
    ...(profile === 'repro' ? [['tools.bash.shell', shell, wrapper]] : []),
  ];
  for (const [key, value, want] of policy) {
    if (value !== want) throw new Error(`mistral: the run did not carry the unit's policy (${key}=${show(value)}) — VIBE_HOME was not honoured`);
  }
  const answer = String(res.stdout || '').trim();
  if (!answer) throw new Error(`mistral: produced no answer (outcome=${exp.outcome}, exit=${res.code})`);

  const cost = exp.cost_usd; // Number(null) is 0: a missing estimate must not print as $0.00
  // The alias that ran: the spool record keeps the configured model, not an effort's move.
  const footer = `_(vibe: model=${requested} · outcome=${exp.outcome} · steps=${exp.steps} · est. $${Number.isFinite(cost) ? cost.toFixed(2) : '?'} · export=${exportPath || '(not kept)'})_`;
  const u = exp.usage && typeof exp.usage === 'object' ? exp.usage : null;
  const usage = u ? { input: u.input_tokens ?? null, output: u.output_tokens ?? null, cachedInput: u.cached_input_tokens ?? null, reasoning: null } : null;
  let r = { text: `${answer}\n\n${footer}`, usage, footer };
  if (res.cancelled) r = withPartial(r, partialMark('mistral', 'cancelled'));
  else if (res.killed) r = withPartial(r, partialMark('mistral', 'killed', { after: timeoutS ?? '?' }));
  else if (exp.outcome === 'deadline') {
    r = withPartial(r, partialMark('mistral', 'deadline', { limit: timeoutS - 15, ...(profile === 'repro' ? { key: 'reproTimeoutS' } : {}) }));
  } else if (res.code !== 0) r = withPartial(r, partialMark('mistral', 'exited', { code: res.code }));
  if (res.capped) r = withPartial(r, partialMark('mistral', 'capped', { outputCap }));
  return r;
}

/**
 * A finished spawn → the answer: the export read (missing or unparsable is an
 * error naming the output dir), kept (a refused keep is one log line), the
 * session record read (absent is one log line), then extractResult.
 */
function answerFrom(ctx, res, { outDir, requested, profile, timeoutS, wrapper }) {
  const got = readExport(outDir);
  if (!got.ok) {
    if (res.cancelled) throw new Error('mistral cancelled by the client');
    const how = res.killed ? `hard-killed after ${timeoutS}s` : `exit ${res.code}`;
    const tail = String(res.stderr || '').trim().slice(-300);
    throw new Error(`mistral: ${got.reason} (${how}) — the run left no record, so no answer is returned${tail ? `; stderr: ${tail}` : ''}`);
  }
  const exp = got.export;
  let exportPath = '';
  try { exportPath = writeExport({ home: ctx.home, exportJson: got.raw, keep: ctx.cfg.resultsKeep }); }
  catch (e) { ctx.log(`export.json not kept: ${(e && e.message) || e}`); }
  const journal = readJournal({ outDir, sessionId: exp.session_id });
  if (!journal) ctx.log(`no session record under ${join(outDir, 'session')} (session logging is off in the unit's home) — the fallback check rests on export.json alone`);
  const u = exp.usage || {};
  ctx.log(`vibe done · outcome=${exp.outcome} · exit=${res.code} · steps=${exp.steps} · est. $${exp.cost_usd} · tokens in=${u.input_tokens} (cached ${u.cached_input_tokens}) out=${u.output_tokens}`);
  return extractResult(res, exp, { requested, profile, timeoutS, wrapper, journal, exportPath, outputCap: ctx.cfg.outputCap });
}

// The three refusals, a run that left no usable export.json, auth, a missing
// binary, the cap, a hard kill and a cancel: a second run cannot end differently,
// and every one is paid for — a hard kill is a run that outlived its own
// --time-limit, and would again (codex skips it too); a crash that left no
// record is for the operator to read, not a second 25-minute run.
const isDeterministic = (e) => /instead of the requested|did not carry the unit's policy|produced no answer|left no record|sign in through the browser|not found in PATH|output (?:capped|exceeded)|hard-killed|cancelled by the client/i.test((e && e.message) || '');

/**
 * The alias the run asks for: the named (or configured) model, moved within its
 * family to an effort the call or the operator asked for (`effortFrom` 'call' |
 * 'config'); the built-in effort never moves a named alias. A level the family
 * lacks keeps the model, logged. Reported through `usedModel`.
 */
function pickAlias(ctx) {
  const model = ctx.model || catalog.ids[0];
  const asked = ctx.effortFrom === 'call' || ctx.effortFrom === 'config' ? ctx.effort : '';
  const alias = asked ? resolveAlias(model, asked) : model;
  const own = (catalog.find(model) || {}).effort;
  if (asked && alias === model && own !== asked) ctx.log(`effort ${asked} is not offered by ${model}'s family — running ${model}`);
  ctx.usedModel(alias);
  return alias;
}

/**
 * The bytes of the regular files under `dir` and the newest mtime of anything
 * in it, `dir` itself included (a session Vibe has just created may hold no
 * file yet); links are not followed.
 */
function scanTree(dir) {
  let newest = 0;
  try { newest = lstatSync(dir).mtimeMs; } catch { return { bytes: 0, newest }; }
  let names = [];
  try { names = readdirSync(dir); } catch { return { bytes: 0, newest }; }
  let bytes = 0;
  for (const name of names) {
    let st;
    try { st = lstatSync(join(dir, name)); } catch { continue; }
    if (st.isDirectory()) {
      const sub = scanTree(join(dir, name));
      bytes += sub.bytes;
      newest = Math.max(newest, sub.newest);
    } else {
      if (st.isFile()) bytes += st.size;
      newest = Math.max(newest, st.mtimeMs);
    }
  }
  return { bytes, newest };
}

/** What `<VIBE_HOME>/logs` may hold before the next spawn. */
export const VIBE_LOGS_CAP = 8 * 1024 * 1024;

/**
 * With session logging on, Vibe copies every session into
 * `<VIBE_HOME>/logs/session/unified/<session id>/` (measured 2026-11-06 on
 * 3.1.0: 132 KB for a one-step run, 16 MB for the 34-step replay). The homes
 * render it off; this stays as the bound on what still lands under `logs/`
 * (vibe.log, the plugin store, a home whose switch did not hold). While `logs/` holds more than
 * `maxBytes`, the oldest session directory goes, whole. Only sessions:
 * `logs/session/plugins/` is Vibe's store of its bundled skills, written once
 * and so the oldest files there — trimming by file age would take it first.
 * A session whose newest entry is younger than `liveS` seconds may belong to a
 * run in flight (another call, the other profile) and is never removed: the
 * caller passes the longest a run can last plus a margin. A link anywhere on
 * the way stops the trim, logged.
 */
export function capVibeLogs(vibeHome, { maxBytes = VIBE_LOGS_CAP, liveS, log = () => {} } = {}) {
  if (!Number.isFinite(liveS)) throw new Error('capVibeLogs: liveS (seconds) is required — a session younger than it may be in flight');
  const logs = join(vibeHome, 'logs');
  const unified = join(logs, 'session', 'unified');
  for (const d of [logs, join(logs, 'session'), unified]) {
    let st;
    try { st = lstatSync(d); } catch { return; } // nothing written there yet
    if (st.isSymbolicLink() || !st.isDirectory()) { log(`${d} is not a plain directory — Vibe's logs not trimmed`); return; }
  }
  let total = scanTree(logs).bytes;
  if (total <= maxBytes) return;
  const sessions = [];
  for (const name of readdirSync(unified)) {
    try {
      if (lstatSync(join(unified, name)).isDirectory()) sessions.push({ path: join(unified, name), ...scanTree(join(unified, name)) });
    } catch { /* gone */ }
  }
  const liveSince = Date.now() - liveS * 1000;
  const live = sessions.filter((s) => s.newest >= liveSince).length;
  let removed = 0;
  for (const s of sessions.filter((x) => x.newest < liveSince).sort((a, b) => a.newest - b.newest)) {
    if (total <= maxBytes) break;
    rmSync(s.path, { recursive: true, force: true });
    total -= s.bytes;
    removed++;
  }
  log(`removed ${removed} old session log(s), kept ${live} live, under ${unified} — logs/ now ${total} bytes (cap ${maxBytes})`);
}

/** One review run, in a spool tmp of its own that holds the prompt and receives the output; removed after. */
async function reviewOnce(ctx, { prompt, workdir, requested }) {
  const { dir: vibeHome } = ensureHome({ home: ctx.home, profile: 'review', log: ctx.log });
  // A run of either profile lasts at most its timeout: a session younger than the longer one, plus a minute, may be live.
  capVibeLogs(vibeHome, { liveS: Math.max(ctx.cfg.timeoutS, ctx.cfg.reproTimeoutS) + 60, log: ctx.log });
  const outDir = mkdtempSync(join(tmpdir(), 'omelette-mistral-'));
  try {
    const promptFile = join(outDir, 'prompt.md');
    writeFileSync(promptFile, REVIEW_PREFIX + prompt, { flag: 'wx', mode: 0o600 });
    const timeLimitS = ctx.cfg.timeoutS - 15;
    const args = buildArgs({
      profile: 'review', workdir, model: requested, tools: REVIEW_TOOLS,
      maxTurns: ctx.cfg.maxTurns, maxPrice: ctx.cfg.maxPrice, timeLimitS, outDir, promptFile,
    });
    ctx.log(`vibe · profile=review · model=${requested} · tools=${REVIEW_TOOLS.join(',')} · max-turns=${ctx.cfg.maxTurns} · max-price=$${ctx.cfg.maxPrice} · time-limit=${timeLimitS}s · workdir=${workdir}`);
    const res = await ctx.spawn({
      args,
      cwd: workdir,
      extraEnv: { VIBE_HOME: realpathSync(vibeHome), TMPDIR: realpathSync(outDir), OMELETTE_FLEET_HOME: realpathSync(ctx.home) },
    });
    return answerFrom(ctx, res, { outDir, requested, profile: 'review', timeoutS: ctx.cfg.timeoutS, wrapper: join(vibeHome, 'shell.sh') });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

const MODEL_PROP = {
  type: 'string',
  enum: catalog.modelEnum(),
  description:
    'Optional. OMIT to use the fleet default (`mistral.model`, else mistral-large-4-0-3 — Large 4, thinking high). ' +
    'Must be an exact id — call mistral_models for the guide. ' + GUIDE,
};
const EFFORT_PROP = {
  type: 'string',
  enum: catalog.effortEnum(),
  description:
    'Optional thinking level. Effort is baked into the alias: it moves the model within its family ' +
    '(Large 4 low | medium | high; the GLMs low | high | max); a level the family lacks keeps the model. ' +
    'OMIT for the fleet default (`mistral.effort`, built-in high).',
};

export default defineUnit({
  name: 'mistral',
  label: 'Mistral',
  instructions: 'This unit: Mistral via the vibe CLI, Large 4 at thinking high by default. Security review that reads the tree with read_file and grep only (mistral_security_review, absolute cwd) and, behind its own gate OMELETTE_ALLOW_REPRO=1, the same brief executed in a disposable clone under a kernel sandbox (mistral_security_repro). Large 4 and GLM-5.3 Flash cost $0 on the operator\'s plan; the paid rows are named routes only, capped by maxPrice. Never a sole source: every finding is a candidate until the session has checked it.',
  bin: { env: 'VIBE_BIN', default: 'vibe' },
  riskEnv: ['MISTRAL_API_KEY'],
  envPassthrough: [],
  envMap: { model: 'MISTRAL_DEFAULT_MODEL', effort: 'MISTRAL_EFFORT', timeoutS: 'MISTRAL_TIMEOUT_S' },
  builtin: { model: 'mistral-large-4-0-3', effort: 'high', timeoutS: 1500, maxTurns: 150, outputCap: 400000 },
  extraSchema: {
    reproTimeoutS: { type: 'posint', default: 2400 },
    maxPrice: { type: 'posint', default: 1 },
    reproMaxPrice: { type: 'posint', default: 3 },
    reproKeep: { type: 'boolean', default: false },
    reproTools: { type: 'string', default: 'bash,read_file,grep' },
  },
  supportedModes: { 'read-only': true, 'workspace-write': null },
  auth: { detect: (stderr) => AUTH_RE.test(stderr), help: AUTH_HELP },
  catalog,
  tools: [
    {
      name: 'mistral_security_review',
      kind: 'review',
      description:
        'Ask Mistral Large 4 (local vibe CLI, the operator\'s plan) for a security review of a directory: what an ' +
        'attacker gains, findings in four parts with path:line pointers. READ-ONLY by policy, not by a kernel: Vibe ' +
        'gets read_file and grep only — no shell, no web, no write tool — and its home denies reads outside the ' +
        'workdir; the run can read what the operator\'s user can read under `cwd`, and nothing it reads can leave ' +
        'except in its answer. The answer ends with a footer naming the outcome, the steps, Vibe\'s est. cost (not ' +
        'the bill) and the kept export.json. A run Vibe answered with another model than the one asked is refused, ' +
        'not returned. A run that hit its time limit comes back marked partial. Verify every finding.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to review and what to look for.' },
          cwd: {
            type: 'string',
            description: 'Optional ABSOLUTE path to the directory to review (must exist; Vibe\'s --workdir and the spawn cwd). Defaults to the MCP server\'s process cwd.',
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
        // Vibe 3.1.0 refuses --time-limit <= 0 and writes no export: refused here, never clamped.
        if (ctx.cfg.timeoutS <= 15) return { text: `Error: mistral.timeoutS must be above 15 — Vibe's --time-limit is timeoutS − 15 s (configured: ${ctx.cfg.timeoutS})`, isError: true };
        const workdir = c.cwd || process.cwd();
        const requested = pickAlias(ctx);
        return ctx.retry(() => reviewOnce(ctx, { prompt, workdir, requested }), { skipIf: isDeterministic });
      },
    },
    {
      name: 'mistral_models',
      kind: 'catalog',
      description:
        'List the Mistral models (Vibe aliases) you can pass as `model` to mistral_security_review, the allowed ' +
        '`effort` levels, the prices, what the plan covers, and a "route to / route AWAY" cheat-sheet. No ' +
        'arguments, no spawn — local catalog read.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
});
