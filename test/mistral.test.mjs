// 1.9.0 Task 2 (plan docs/superpowers/plans/2026-11-06-1.9.0-mistral-unit.md;
// spec docs/superpowers/specs/2026-11-06-mistral-unit-design.md §1): the Mistral
// adapter's review profile — argv, export.json, the fallback and policy refusals,
// the deadline marker. A fake `vibe` (a Node script run by VIBE_BIN=node, its path
// prepended to argv as the codex tests do) records argv and env, writes a scripted
// export.json and session record into --output-dir, prints a scripted answer and
// exits with a scripted code. HOME and OMELETTE_HOME are temp dirs: the
// operator's ~/.vibe is never read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import unit, { REVIEW_PREFIX, buildArgs } from '../units/mistral/adapter.mjs';
import { MISTRAL_MODELS } from '../units/mistral/models.js';
import { createUnitRuntime } from '../core/unit.mjs';

const BASE = mkdtempSync(join(tmpdir(), 'omelette-mistral-t-'));
const FAKE = join(BASE, 'fake-vibe.mjs');
writeFileSync(FAKE, [
  'import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'const [scenarioPath, ...argv] = process.argv.slice(2);',
  'const sc = JSON.parse(readFileSync(scenarioPath, "utf8"));',
  'const opt = (f) => argv[argv.indexOf(f) + 1];',
  'const outDir = opt("--output-dir");',
  'const fill = (v) => JSON.parse(JSON.stringify(v).replaceAll("$MODEL", opt("--model")));',
  'const exportText = sc.export ? JSON.stringify(fill(sc.export), null, 2) : null;',
  'appendFileSync(sc.record, JSON.stringify({',
  '  argv, env: process.env, cwd: process.cwd(), outDir, exportText,',
  '  prompt: readFileSync(opt("--prompt-file"), "utf8"),',
  '  promptMode: statSync(opt("--prompt-file")).mode & 0o777,',
  '  homeConfig: readFileSync(join(process.env.VIBE_HOME, "config.toml"), "utf8"),',
  '}) + "\\n");',
  'if (exportText !== null) writeFileSync(join(outDir, "export.json"), exportText);',
  'if (sc.meta) {',
  '  mkdirSync(join(outDir, "session"), { recursive: true });',
  '  writeFileSync(join(outDir, "session", "meta.json"), JSON.stringify(fill(sc.meta)));',
  '}',
  'process.stdout.write(sc.answer);',
  'process.exitCode = sc.code;',
  // A run that outlives the unit's timeoutS: the runtime's hard kill ends it.
  'if (sc.sleepMs) setTimeout(() => {}, sc.sleepMs);',
].join('\n'));

const SESSION = '201e0f60-561c-2bcb-f3fd-c70a7cbe0997';

/**
 * The real export.json of 2026-11-06 (`large4-repro-export.json`, Vibe 3.1.0):
 * its top-level fields verbatim, `config` cut to the keys the adapter reads,
 * with the brief's defaults — the requested alias, the unit's policy, the
 * review home's wrapper — and paths under the test's temp dir.
 */
function realExport(fleet) {
  return {
    outcome: 'finished',
    stop_reason: null,
    error: null,
    session_id: SESSION,
    usage: { input_tokens: 5086518, output_tokens: 26705, cached_input_tokens: 4663296, total_tokens: 5113223 },
    cost_usd: 0,
    steps: 40,
    schema_version: 1,
    vibe_version: '3.1.0',
    journal_dir: 'session',
    started_at: '2026-11-06T15:20:08.456687Z',
    ended_at: '2026-11-06T15:33:17.993343Z',
    limits: { max_turns: 200, max_price: 3, max_tokens: null, time_limit_s: 2300 },
    exit_code: 0,
    config: {
      active_model: '$MODEL',
      outside_workdir: 'deny',
      enable_mcp: false,
      enable_connectors: false,
      tools: { bash: { shell: join(fleet, 'vibe', 'review', 'shell.sh') } },
      session_logging: { save_dir: join(fleet, 'vibe', 'review', 'logs', 'session'), session_prefix: 'session', enabled: true, generate_titles: true },
    },
  };
}

/** `<outDir>/session/meta.json` as Vibe 3.1.0 writes it, cut to the keys the adapter reads. */
const realMeta = (modelName = 'mistral-large-4-0') => ({ session_id: SESSION, config: { active_model: '$MODEL', model_name: modelName } });

let n = 0;
/**
 * One test's world: HOME and OMELETTE_HOME under a fresh temp dir, a workdir
 * with one file, the scenario file the fake reads, and a runtime whose tools
 * spawn the fake. `edit(scenario)` overrides one field of the default;
 * `hardKillMs` replaces the spawn's kill deadline (timeoutS must stay above 15).
 */
function world({ config, edit = () => {}, hardKillMs } = {}) {
  const root = join(BASE, `w${++n}`);
  const home = join(root, 'home');
  const fleet = join(home, '.omelette');
  const work = join(root, 'work');
  mkdirSync(fleet, { recursive: true });
  mkdirSync(work);
  writeFileSync(join(work, 'auth.js'), 'module.exports = 1;\n');
  if (config) writeFileSync(join(fleet, 'fleet.config.json'), JSON.stringify({ units: { mistral: config } }));
  const record = join(root, 'record.jsonl');
  const scenario = { record, export: realExport(fleet), meta: realMeta(), answer: 'finding: auth.js:1 · …', code: 0 };
  edit(scenario);
  const scenarioPath = join(root, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const env = {
    PATH: process.env.PATH, HOME: home, OMELETTE_HOME: fleet, VIBE_BIN: process.execPath,
    MISTRAL_API_KEY: 'sk-mistral-leak',
  };
  const logs = [];
  const used = [];
  const records = [];
  const rt = createUnitRuntime({
    ...unit,
    tools: unit.tools.map((t) => (t.run ? {
      ...t,
      run: (a, ctx) => t.run(a, {
        ...ctx,
        log: (m) => logs.push(m),
        usedModel: (id) => { used.push(id); ctx.usedModel(id); },
        spawn: (o) => ctx.spawn({ ...o, ...(hardKillMs ? { hardKillMs } : {}), args: [FAKE, scenarioPath, ...o.args] }),
      }),
    } : t)),
  }, { env, onResult: (r) => records.push(r) });
  const spawns = () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const review = (args = {}) => rt.callTool('mistral_security_review', { prompt: 'find the auth bug', cwd: work, ...args });
  return { home, fleet, work, scenario, env, logs, used, records, spawns, review };
}

const exportsDir = (fleet) => join(fleet, 'results', 'mistral', 'exports');

test('review argv: --prompt-file, no -p, read_file+grep only, --time-limit 1485, VIBE_HOME is the review home', async () => {
  const w = world();
  const r = await w.review();
  assert.equal(r.isError, undefined, r.text);
  const [s] = w.spawns();
  assert.deepEqual(s.argv, [
    '--workdir', w.work, '--trust', '--agent', 'auto-approve',
    '--enabled-tools', 'read_file', '--enabled-tools', 'grep',
    '--model', 'mistral-large-4-0-3', '--max-turns', '150', '--max-price', '1', '--time-limit', '1485',
    '--output', 'text', '--output-dir', s.outDir, '--prompt-file', join(s.outDir, 'prompt.md'),
  ]);
  assert.ok(!s.argv.includes('-p'));
  assert.equal(s.cwd, realpathSync(w.work));
  assert.equal(s.env.VIBE_HOME, realpathSync(join(w.fleet, 'vibe', 'review')));
  assert.equal(s.prompt, REVIEW_PREFIX + 'find the auth bug');
  assert.equal(s.promptMode, 0o600);
  assert.equal(existsSync(s.outDir), false, 'the spool tmp — prompt file and output dir — is gone after the call');
  assert.throws(() => buildArgs({ profile: 'review', workdir: '/w', model: 'm', tools: ['read_file', 'bash'], maxTurns: 1, maxPrice: 1, timeLimitS: 1, outDir: '/o', promptFile: '/o/p' }), /review profile/);
});

test('usage comes from export.json and the footer carries outcome, steps and est. cost', async () => {
  const w = world();
  const r = await w.review();
  const [kept] = readdirSync(exportsDir(w.fleet));
  assert.match(kept, /^\d{8}T\d{6}Z-\d+-\d+\.export\.json$/);
  const path = join(exportsDir(w.fleet), kept);
  assert.equal(r.text, `finding: auth.js:1 · …\n\n_(vibe: model=mistral-large-4-0-3 · outcome=finished · steps=40 · est. $0.00 · export=${path})_`);
  assert.equal(readFileSync(path, 'utf8'), w.spawns()[0].exportText, 'the export is kept byte for byte');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(w.records[0].usage, { input: 5086518, output: 26705, cachedInput: 4663296, reasoning: null });
  assert.equal(w.records[0].partial, false);
});

test('exports beyond resultsKeep are pruned oldest first', async () => {
  const w = world({ config: { resultsKeep: 2 } });
  const paths = [];
  for (let i = 0; i < 3; i++) paths.push(/export=(.+)\)_$/.exec((await w.review()).text)[1]);
  assert.deepEqual(readdirSync(exportsDir(w.fleet)).map((f) => join(exportsDir(w.fleet), f)).sort(), paths.slice(1).sort());
});

test('the fallback is refused naming both models', async () => {
  const w = world({ edit: (s) => { s.export.config.active_model = 'mistral-medium-3.5'; } });
  const r = await w.review();
  assert.equal(r.isError, true);
  assert.match(r.text, /mistral: Vibe ran mistral-medium-3\.5 instead of the requested mistral-large-4-0-3 — the home's models list is stale or the alias is unknown; the answer is withheld/);
  assert.ok(!r.text.includes('finding: auth.js'), 'the answer is withheld');
  assert.equal(w.spawns().length, 1, 'a refusal is not retried');
  // Probe 5's real fallback: export.json named no model at all, the session record named the one that ran.
  const empty = world({ edit: (s) => { s.export.config.active_model = ''; s.meta.config = { active_model: 'mistral-medium-3.5', model_name: 'mistral-vibe-cli-latest' }; } });
  assert.match((await empty.review()).text, /Vibe ran mistral-vibe-cli-latest instead of the requested mistral-large-4-0-3/);
});

test('a run without the policy is refused naming the key', async () => {
  for (const [key, value, shown] of [['outside_workdir', 'ask', 'ask'], ['enable_mcp', true, 'true'], ['enable_connectors', true, 'true']]) {
    const w = world({ edit: (s) => { s.export.config[key] = value; } });
    const r = await w.review();
    assert.equal(r.isError, true, key);
    assert.match(r.text, new RegExp(`mistral: the run did not carry the unit's policy \\(${key}=${shown}\\) — VIBE_HOME was not honoured`));
    assert.equal(w.spawns().length, 1, `${key}: not retried`);
  }
});

test('deadline: exit 3 + outcome deadline is a partial answer, not a failure', async () => {
  const w = world({ edit: (s) => { s.export.outcome = 'deadline'; s.export.exit_code = 3; s.code = 3; } });
  const r = await w.review();
  assert.equal(r.isError, undefined);
  const path = join(exportsDir(w.fleet), readdirSync(exportsDir(w.fleet))[0]);
  assert.equal(r.text, `finding: auth.js:1 · …\n\n_(vibe: model=mistral-large-4-0-3 · outcome=deadline · steps=40 · est. $0.00 · export=${path})_\n\n`
    + '[mistral: stopped at the 1485s time limit — treat the answer as partial; raise mistral.timeoutS in the fleet config]');
  assert.equal(w.records[0].partial, true);
  assert.equal(w.spawns().length, 1, 'never re-run');
});

test('max_price: exit 3 + outcome max_price is marked exited and not retried', async () => {
  const w = world({ edit: (s) => { s.export.outcome = 'max_price'; s.export.exit_code = 3; s.code = 3; } });
  const r = await w.review();
  assert.equal(r.isError, undefined);
  assert.ok(r.text.endsWith('\n\n[mistral: CLI exited 3 — treat the answer as partial]'), r.text);
  assert.equal(w.records[0].partial, true);
  assert.equal(w.spawns().length, 1);
  assert.ok(w.logs.some((l) => l.includes('outcome=max_price')), w.logs.join('\n'));
});

test('MISTRAL_API_KEY never reaches the child, VIBE_HOME and TMPDIR do', async () => {
  const w = world();
  await w.review();
  const [{ env, outDir }] = w.spawns();
  assert.equal(env.MISTRAL_API_KEY, undefined);
  assert.equal(env.VIBE_HOME, realpathSync(join(w.fleet, 'vibe', 'review')));
  // The spool tmp is gone after the call: its resolved path is its parent's, resolved, plus its name.
  assert.equal(env.TMPDIR, join(realpathSync(dirname(outDir)), basename(outDir)));
  assert.equal(env.OMELETTE_FLEET_HOME, realpathSync(w.fleet));
  assert.equal(env.HOME, w.home);
});

test('a stale home is re-rendered before the spawn', async () => {
  const w = world();
  mkdirSync(join(w.fleet, 'vibe', 'review'), { recursive: true, mode: 0o700 });
  writeFileSync(join(w.fleet, 'vibe', 'review', 'config.toml'), 'active_model = "mistral-large-4-0-3"\nmodels = [\n  { name = "mistral-large-4-0", provider = "mistral", alias = "mistral-large-4-0-3" },\n]\n', { mode: 0o600 });
  await w.review();
  const seen = w.spawns()[0].homeConfig;
  for (const m of MISTRAL_MODELS) assert.ok(seen.includes(`alias = "${m.id}"`), `${m.id} in the home the run saw`);
});

test('effort low on the head resolves to mistral-large-4-0-3-low in argv and usedModel', async () => {
  const w = world();
  const r = await w.review({ effort: 'low' });
  assert.equal(r.isError, undefined, r.text);
  const { argv } = w.spawns()[0];
  assert.equal(argv[argv.indexOf('--model') + 1], 'mistral-large-4-0-3-low');
  assert.deepEqual(w.used, ['mistral-large-4-0-3-low']);
  assert.match(r.text, /_\(vibe: model=mistral-large-4-0-3-low · /, 'the footer names the alias that ran; the spool record keeps the configured model');
});

// Coordinator's fix 1: only an effort the call or the operator asked for moves an alias.
test('the built-in effort never moves a named alias; a call\'s or the operator\'s effort does', async () => {
  const w = world({ edit: (s) => { s.meta = realMeta('zai-glm-5-3-flash'); } });
  const model = (i) => { const { argv } = w.spawns()[i]; return argv[argv.indexOf('--model') + 1]; };
  assert.equal((await w.review({ model: 'zai-glm-5-3-flash-low' })).isError, undefined);
  assert.equal(model(0), 'zai-glm-5-3-flash-low', 'no effort on the call, none configured: the built-in high does not move it');
  assert.equal((await w.review({ model: 'zai-glm-5-3-flash-low', effort: 'high' })).isError, undefined);
  assert.equal(model(1), 'zai-glm-5-3-flash', 'the call\'s effort moves it');
  const c = world({ config: { effort: 'low', model: 'mistral-large-4-0-3' } });
  assert.equal((await c.review()).isError, undefined);
  const { argv } = c.spawns()[0];
  assert.equal(argv[argv.indexOf('--model') + 1], 'mistral-large-4-0-3-low', 'the configured effort moves it');
});

test('the session record\'s model, when it is neither the requested alias nor its vendor name, is refused like a fallback', async () => {
  const w = world({ edit: (s) => { s.meta = realMeta('mistral-vibe-cli-latest'); } });
  const r = await w.review();
  assert.equal(r.isError, true);
  assert.match(r.text, /mistral: Vibe ran mistral-vibe-cli-latest instead of the requested mistral-large-4-0-3 — the home's models list is stale or the alias is unknown; the answer is withheld/);
  assert.equal(w.spawns().length, 1);
});

test('a missing journal is one log line and no refusal', async () => {
  const w = world({ edit: (s) => { s.meta = null; } });
  const r = await w.review();
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /^finding: auth\.js:1/);
  assert.equal(w.logs.filter((l) => /no session record/.test(l)).length, 1, w.logs.join('\n'));
});

// Ruling 5 (brief): one real run added logs/session/unified/<session>/ under the
// home (132 KB for one step; the replay's session was 16 MB), so the home grows.
const MB = 1024 * 1024;
const day = (d) => new Date(`2026-${d}T00:00:00Z`);
/** A session directory under `logs` holding `size` bytes; `when` dates its file and both directories (fresh when absent). */
function session(logs, id, size, when) {
  const dir = join(logs, 'unified', id);
  mkdirSync(join(dir, 'journal'), { recursive: true });
  writeFileSync(join(dir, 'journal', '0001.jsonl'), Buffer.alloc(size));
  if (when) for (const p of [join(dir, 'journal', '0001.jsonl'), join(dir, 'journal'), dir]) utimesSync(p, when, when);
}

test('the review home\'s session logs are trimmed to 8 MB, oldest session first, and the plugin store is left alone', async () => {
  const w = world();
  const logs = join(w.fleet, 'vibe', 'review', 'logs', 'session');
  for (const [id, size, when] of [['s-old', 5 * MB, day('01-01')], ['s-mid', 3 * MB, day('02-01')], ['s-new', 1 * MB, day('03-01')]]) session(logs, id, size, when);
  mkdirSync(join(logs, 'plugins', 'blobs'), { recursive: true });
  writeFileSync(join(logs, 'plugins', 'blobs', 'skill'), 'x');
  utimesSync(join(logs, 'plugins', 'blobs', 'skill'), day('01-01'), day('01-01'));
  const r = await w.review();
  assert.equal(r.isError, undefined, r.text);
  assert.deepEqual(readdirSync(join(logs, 'unified')).sort(), ['s-mid', 's-new'], '9 MB → the oldest session goes, and only it');
  assert.ok(existsSync(join(logs, 'plugins', 'blobs', 'skill')), 'the plugin store stays');
});

// Fix round 2, item 4: a session written within max(timeoutS, reproTimeoutS) + 60 s may be a run in flight.
test('a session in flight is never trimmed: 9 MB with a fresh mtime stays, the same aged past liveS goes', async () => {
  const fresh = world();
  const freshLogs = join(fresh.fleet, 'vibe', 'review', 'logs', 'session');
  session(freshLogs, 's-live', 9 * MB);
  // In flight, Vibe writes into journal/: the session directory's own mtime need not move, so the walk must find the file.
  for (const p of [join(freshLogs, 'unified', 's-live', 'journal'), join(freshLogs, 'unified', 's-live')]) utimesSync(p, day('01-01'), day('01-01'));
  assert.equal((await fresh.review()).isError, undefined);
  assert.ok(existsSync(join(freshLogs, 'unified', 's-live')), 'a live session stays, over the cap or not');
  assert.ok(fresh.logs.some((l) => /removed 0 old session log\(s\), kept 1 live/.test(l)), fresh.logs.join('\n'));
  const aged = world();
  const agedLogs = join(aged.fleet, 'vibe', 'review', 'logs', 'session');
  // Older than liveS = max(1500, 2400) + 60 s by one minute.
  const past = new Date(Date.now() - (2460 + 60) * 1000);
  session(agedLogs, 's-done', 9 * MB, past);
  assert.equal((await aged.review()).isError, undefined);
  assert.equal(existsSync(join(agedLogs, 'unified', 's-done')), false);
  assert.ok(aged.logs.some((l) => /removed 1 old session log\(s\), kept 0 live/.test(l)), aged.logs.join('\n'));
});

// Coordinator's fix 3: a hard kill is a run that outlived its own --time-limit; a second one would too.
test('a hard kill that left no export is an error naming the kill and the output dir, and is never re-run', async () => {
  const w = world({ hardKillMs: 2000, edit: (s) => { s.export = null; s.meta = null; s.sleepMs = 30000; } });
  const r = await w.review();
  assert.equal(r.isError, true);
  assert.match(r.text, /mistral: no export\.json in \S*omelette-mistral-\S+ \(hard-killed after 1500s\)/);
  assert.equal(w.spawns().length, 1);
});

test('a run killed after it wrote export.json returns its answer with the killed marker, once', async () => {
  const w = world({ hardKillMs: 2000, edit: (s) => { s.sleepMs = 30000; } });
  const r = await w.review();
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /^finding: auth\.js:1/);
  assert.ok(r.text.endsWith('\n\n[mistral: hard-killed after 1500s — treat the answer as partial; raise mistral.timeoutS in the fleet config]'), r.text);
  assert.equal(w.records[0].partial, true);
  assert.equal(w.spawns().length, 1);
});
