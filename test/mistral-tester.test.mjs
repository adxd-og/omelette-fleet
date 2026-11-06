// 1.9.0 Task 2, tester pass (spec docs/superpowers/specs/2026-11-06-mistral-unit-design.md §1,
// plan docs/superpowers/plans/2026-11-06-1.9.0-mistral-unit.md Task 2). Only what test/mistral.test.mjs
// leaves unpinned: the keep-path refusals (a link at results/, results/mistral/ or exports/), pruning at
// keep=1, the cleanup after a refused run, the caller's text kept out of argv, an unusable export.json,
// a partial export (usage without a key, none at all), finished-with-exit-1, the cancelled path, the
// passthrough that must not re-admit MISTRAL_API_KEY, an unknown cwd / empty prompt (no spawn), the
// session record of another session, the effort a family lacks, and config keys reaching argv.
// Same fake as mistral.test.mjs, extended: stderr, a raw / linked export.json, a scripted sleep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit, { REVIEW_PREFIX, extractResult, writeExport } from '../units/mistral/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const BASE = mkdtempSync(join(tmpdir(), 'omelette-mistral-tt-'));
const FAKE = join(BASE, 'fake-vibe.mjs');
writeFileSync(FAKE, [
  'import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'const [scenarioPath, ...argv] = process.argv.slice(2);',
  'const sc = JSON.parse(readFileSync(scenarioPath, "utf8"));',
  'const opt = (f) => argv[argv.indexOf(f) + 1];',
  'const outDir = opt("--output-dir");',
  'const fill = (v) => JSON.parse(JSON.stringify(v).replaceAll("$MODEL", opt("--model")));',
  'appendFileSync(sc.record, JSON.stringify({ argv, env: process.env, outDir, prompt: readFileSync(opt("--prompt-file"), "utf8") }) + "\\n");',
  'if (sc.exportRaw != null) writeFileSync(join(outDir, "export.json"), sc.exportRaw);',
  'else if (sc.exportLink) symlinkSync(sc.exportLink, join(outDir, "export.json"));',
  'else if (sc.export) writeFileSync(join(outDir, "export.json"), JSON.stringify(fill(sc.export), null, 2));',
  'if (sc.meta) { mkdirSync(join(outDir, "session"), { recursive: true }); writeFileSync(join(outDir, "session", "meta.json"), JSON.stringify(fill(sc.meta))); }',
  'if (sc.stderr) process.stderr.write(sc.stderr);',
  'process.stdout.write(sc.answer);',
  'process.exitCode = sc.code;',
  'if (sc.sleepMs) setTimeout(() => {}, sc.sleepMs);',
].join('\n'));

const SESSION = '201e0f60-561c-2bcb-f3fd-c70a7cbe0997';
const realExport = (fleet) => ({
  outcome: 'finished', stop_reason: null, error: null, session_id: SESSION,
  usage: { input_tokens: 5086518, output_tokens: 26705, cached_input_tokens: 4663296, total_tokens: 5113223 },
  cost_usd: 0, steps: 40, exit_code: 0,
  config: {
    active_model: '$MODEL', outside_workdir: 'deny', enable_mcp: false, enable_connectors: false,
    tools: { bash: { shell: join(fleet, 'vibe', 'review', 'shell.sh') } },
  },
});
const realMeta = () => ({ session_id: SESSION, config: { active_model: '$MODEL', model_name: 'mistral-large-4-0' } });

let n = 0;
function world({ config, extraEnv = {}, cancel, hardKillMs, edit = () => {} } = {}) {
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
  edit(scenario, { fleet, root });
  const scenarioPath = join(root, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const env = { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: fleet, VIBE_BIN: process.execPath, MISTRAL_API_KEY: 'sk-mistral-leak', ...extraEnv };
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
  }, { env, onResult: (r) => records.push(r), ...(cancel ? { cancel } : {}) });
  const spawns = () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const review = (args = {}, call) => rt.callTool('mistral_security_review', { prompt: 'find the auth bug', cwd: work, ...args }, call);
  return { home, fleet, work, root, scenario, logs, used, records, spawns, review };
}
const exportsDir = (fleet) => join(fleet, 'results', 'mistral', 'exports');
const model = (s) => s.argv[s.argv.indexOf('--model') + 1];
const flag = (s, f) => s.argv[s.argv.indexOf(f) + 1];

/* ── the keep path ─────────────────────────────────────────────────────────── */

test('writeExport: a link at results/, results/mistral/ or exports/ is refused, nothing is written through it, and the answer says export=(not kept)', async () => {
  for (const level of ['results', 'mistral', 'exports']) {
    const w = world();
    const target = join(w.root, `elsewhere-${level}`);
    mkdirSync(target);
    const parent = level === 'results' ? w.fleet : level === 'mistral' ? join(w.fleet, 'results') : join(w.fleet, 'results', 'mistral');
    mkdirSync(parent, { recursive: true });
    symlinkSync(target, join(parent, level));
    assert.throws(() => writeExport({ home: w.fleet, exportJson: '{}' }), /symlink/, level);
    const r = await w.review();
    assert.equal(r.isError, undefined, `${level}: ${r.text}`);
    assert.match(r.text, /export=\(not kept\)\)_$/, level);
    assert.deepEqual(readdirSync(target), [], `${level}: nothing was written through the link`);
    assert.ok(w.logs.some((l) => /export\.json not kept/.test(l) && /symlink/.test(l)), `${level}: ${w.logs.join(' | ')}`);
    assert.equal(w.spawns().length, 1);
  }
});

test('writeExport: a file where a directory belongs is refused, not replaced', () => {
  const w = world();
  mkdirSync(join(w.fleet, 'results'), { recursive: true });
  writeFileSync(join(w.fleet, 'results', 'mistral'), 'a file');
  assert.throws(() => writeExport({ home: w.fleet, exportJson: '{}' }), /not a directory/);
  assert.equal(readFileSync(join(w.fleet, 'results', 'mistral'), 'utf8'), 'a file');
});

test('resultsKeep 1 keeps exactly the newest export; writeExport never prunes the file it just wrote, whatever keep says', async () => {
  const w = world({ config: { resultsKeep: 1 } });
  let last = '';
  for (let i = 0; i < 3; i++) last = /export=(.+)\)_$/.exec((await w.review()).text)[1];
  assert.deepEqual(readdirSync(exportsDir(w.fleet)).map((f) => join(exportsDir(w.fleet), f)), [last]);
  for (const keep of [0, -3]) {
    const p = writeExport({ home: w.fleet, exportJson: '{"k":1}', keep });
    assert.ok(existsSync(p), `keep=${keep}: the new file stays`);
    assert.equal(readdirSync(exportsDir(w.fleet)).length, 1);
  }
});

test('writeExport leaves a foreign file in exports/ alone while pruning', () => {
  const w = world();
  const dir = exportsDir(w.fleet);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notes.txt'), 'mine');
  for (let i = 0; i < 3; i++) writeExport({ home: w.fleet, exportJson: '{}', keep: 1 });
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'mine');
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.export.json')).length, 1);
});

/* ── the caller's text, the spool tmp ──────────────────────────────────────── */

test('the caller\'s prompt lands in the prompt file after the prefix, trimmed, and in no argv element', async () => {
  const w = world();
  const secret = 'ZZ-CALLER-TEXT-9f3 $(touch /tmp/pwn) `x` "q" \'s\'\nsecond line';
  const r = await w.review({ prompt: `  \n${secret}\n  ` });
  assert.equal(r.isError, undefined, r.text);
  const [s] = w.spawns();
  assert.equal(s.prompt, REVIEW_PREFIX + secret);
  assert.ok(!s.argv.some((a) => a.includes('ZZ-CALLER-TEXT')), 'nothing of the prompt in argv');
  assert.ok(!s.argv.some((a) => a.includes('security reviewer')), 'nor of the prefix');
});

test('the prompt file and the spool tmp are gone after a refused run, a run with no export and a hard kill', async () => {
  const cases = [
    ['fallback refused', {}, (s) => { s.export.config.active_model = 'mistral-medium-3.5'; }],
    ['no export', {}, (s) => { s.export = null; s.meta = null; }],
    ['hard kill', { hardKillMs: 2000 }, (s) => { s.sleepMs = 30000; s.export = null; s.meta = null; }],
  ];
  for (const [label, config, edit] of cases) {
    const w = world({ ...config, edit });
    const r = await w.review();
    assert.equal(r.isError, true, label);
    const [s] = w.spawns();
    assert.equal(existsSync(s.outDir), false, `${label}: ${s.outDir} removed`);
    assert.equal(existsSync(join(s.outDir, 'prompt.md')), false, label);
  }
});

/* ── before any spawn ──────────────────────────────────────────────────────── */

test('a cwd that does not exist, and an empty or blank prompt, are refused before any spawn', async () => {
  const w = world();
  const missing = await w.review({ cwd: join(w.root, 'no-such-dir') });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /no-such-dir|exist/i);
  const relative = await w.review({ cwd: 'work' });
  assert.equal(relative.isError, true, 'a relative cwd is refused');
  for (const prompt of ['', '   \n\t']) {
    const r = await w.review({ prompt });
    assert.equal(r.isError, true);
    assert.match(r.text, /"prompt" is required/);
  }
  assert.equal(w.spawns().length, 0);
  assert.equal(existsSync(join(w.fleet, 'vibe')), false, 'no home rendered for a call that never spawns');
});

/* ── export.json that cannot be trusted ────────────────────────────────────── */

test('an export.json that is not JSON, not an object, or a link is an error naming the problem; its bytes never reach the caller', async () => {
  const cases = [
    ['bad json', (s) => { s.exportRaw = '{"outcome": "SECRETBYTES-1" oops'; }, /not valid JSON/],
    ['array', (s) => { s.exportRaw = '["SECRETBYTES-2"]'; }, /not a JSON object/],
    ['null', (s) => { s.exportRaw = 'null'; }, /not a JSON object/],
    ['link', (s, { root }) => { writeFileSync(join(root, 'real.json'), '{"outcome":"SECRETBYTES-3"}'); s.exportLink = join(root, 'real.json'); }, /could not be read/],
  ];
  for (const [label, edit, re] of cases) {
    const w = world({ edit });
    const r = await w.review();
    assert.equal(r.isError, true, label);
    assert.match(r.text, re, label);
    assert.match(r.text, /no answer is returned/, label);
    assert.ok(!r.text.includes('SECRETBYTES'), `${label}: ${r.text}`);
    assert.ok(!r.text.includes('finding: auth.js'), `${label}: the answer is withheld without a record`);
    assert.equal(existsSync(exportsDir(w.fleet)), false, `${label}: an unusable export is not kept`);
  }
});

test('an export without a usage key reports null for that key; one without usage reports no usage; the footer survives both', async () => {
  const half = world({ edit: (s) => { s.export.usage = { input_tokens: 7 }; } });
  const r1 = await half.review();
  assert.equal(r1.isError, undefined, r1.text);
  assert.deepEqual(half.records[0].usage, { input: 7, output: null, cachedInput: null, reasoning: null });
  const none = world({ edit: (s) => { delete s.export.usage; } });
  const r2 = await none.review();
  assert.equal(r2.isError, undefined, r2.text);
  assert.ok(!none.records[0].usage, 'no usage object → no usage claim');
  assert.match(r2.text, /_\(vibe: model=mistral-large-4-0-3 · outcome=finished · steps=40 · est\. \$0\.00 · export=/);
});

test('an export with cost_usd absent prints est. $? rather than a number', async () => {
  const w = world({ edit: (s) => { delete s.export.cost_usd; } });
  const r = await w.review();
  assert.match(r.text, /· est\. \$\? · export=/);
});

test('outcome finished with a non-zero exit is marked exited, once, with the answer kept', async () => {
  const w = world({ edit: (s) => { s.code = 1; s.export.exit_code = 1; } });
  const r = await w.review();
  assert.equal(r.isError, undefined, r.text);
  assert.ok(r.text.endsWith('\n\n[mistral: CLI exited 1 — treat the answer as partial]'), r.text);
  assert.equal(w.records[0].partial, true);
  assert.equal(w.spawns().length, 1);
});

test('a session record of ANOTHER session is ignored (one log line), even when it names a different model', async () => {
  const w = world({ edit: (s) => { s.meta = { session_id: 'someone-else', config: { active_model: 'mistral-medium-3.5', model_name: 'mistral-vibe-cli-latest' } }; } });
  const r = await w.review();
  assert.equal(r.isError, undefined, r.text);
  assert.equal(w.logs.filter((l) => /no session record/.test(l)).length, 1, w.logs.join('\n'));
});

test('a session record naming the catalog\'s vendor name for the requested alias is accepted; naming a sibling effort alias is not', async () => {
  const ok = world({ edit: (s) => { s.meta.config = { model_name: 'mistral-large-4-0' }; } });
  assert.equal((await ok.review()).isError, undefined);
  // The effort alias is Vibe's alias (ours); the record's model_name is the vendor's name, never an alias of the family.
  const wrong = world({ edit: (s) => { s.meta.config = { model_name: 'zai-glm-5-3-flash' }; } });
  const r = await wrong.review();
  assert.equal(r.isError, true);
  assert.match(r.text, /Vibe ran zai-glm-5-3-flash instead of the requested mistral-large-4-0-3/);
});

/* ── extractResult, direct ─────────────────────────────────────────────────── */

test('extractResult: cancelled wins over killed, carries no hard-kill marker, and the repro deadline names reproTimeoutS', () => {
  const exp = realExport('/f');
  exp.config.active_model = 'mistral-large-4-0-3';
  const base = { stdout: 'answer', stderr: '', code: null };
  const c = extractResult({ ...base, killed: true, cancelled: true }, exp, { requested: 'mistral-large-4-0-3', timeoutS: 1500 });
  assert.ok(c.partial);
  assert.match(c.text, /\[mistral: cancelled by the client — treat the answer as partial\]$/);
  assert.doesNotMatch(c.text, /hard-killed/);
  const dl = { ...exp, outcome: 'deadline' };
  const d = extractResult({ ...base, code: 3, killed: false }, dl, { requested: 'mistral-large-4-0-3', timeoutS: 2400, profile: 'repro', wrapper: exp.config.tools.bash.shell });
  assert.ok(d.text.endsWith('[mistral: stopped at the 2385s time limit — treat the answer as partial; raise mistral.reproTimeoutS in the fleet config]'), d.text);
  // a capped deadline run carries both marks, the cap last
  const both = extractResult({ ...base, code: 3, killed: false, capped: true }, dl, { requested: 'mistral-large-4-0-3', timeoutS: 1500, outputCap: 1000 });
  assert.match(both.text, /time limit[^\n]*\]\n\n\[mistral: output capped at 1000 chars/);
});

test('extractResult: the repro profile refuses a run whose bash shell is not the wrapper, the review profile does not look', () => {
  const exp = realExport('/f');
  exp.config.active_model = 'mistral-large-4-0-3';
  const res = { stdout: 'a', stderr: '', code: 0, killed: false };
  assert.doesNotThrow(() => extractResult(res, exp, { requested: 'mistral-large-4-0-3', timeoutS: 1500, profile: 'review', wrapper: '/other' }));
  assert.throws(() => extractResult(res, exp, { requested: 'mistral-large-4-0-3', timeoutS: 1500, profile: 'repro', wrapper: '/other' }), /policy \(tools\.bash\.shell=/);
  assert.throws(() => extractResult(res, { ...exp, config: { ...exp.config, tools: {} } }, { requested: 'mistral-large-4-0-3', timeoutS: 1500, profile: 'repro', wrapper: '/other' }), /tools\.bash\.shell=undefined/);
});

/* ── the cancelled path, through the runtime ───────────────────────────────── */

test('a request cancelled while Vibe runs: with a record it is a partial answer marked cancelled, without one an error; neither is re-run', async () => {
  const kept = world({ cancel: 'kill', edit: (s) => { s.sleepMs = 30000; } });
  const ac = new AbortController();
  const p = kept.review({}, { signal: ac.signal });
  for (let i = 0; i < 100 && kept.spawns().length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  ac.abort();
  const r = await p;
  assert.equal(kept.spawns().length, 1, 'a cancel is not retried');
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /^finding: auth\.js:1/);
  assert.match(r.text, /\[mistral: cancelled by the client — treat the answer as partial\]$/);
  assert.doesNotMatch(r.text, /hard-killed/);
  assert.equal(kept.records[0].partial, true);
  const bare = world({ cancel: 'kill', edit: (s) => { s.sleepMs = 30000; s.export = null; s.meta = null; } });
  const ac2 = new AbortController();
  const p2 = bare.review({}, { signal: ac2.signal });
  for (let i = 0; i < 100 && bare.spawns().length === 0; i++) await new Promise((r2) => setTimeout(r2, 50));
  await new Promise((r2) => setTimeout(r2, 300));
  ac2.abort();
  const r2 = await p2;
  assert.equal(r2.isError, true);
  assert.match(r2.text, /cancelled/i);
  assert.doesNotMatch(r2.text, /no export\.json/, 'a cancel is not reported as a missing record');
  assert.equal(bare.spawns().length, 1);
});

/* ── environment, effort, config keys ──────────────────────────────────────── */

test('MISTRAL_API_KEY stays out of the child even when OMELETTE_ENV_PASSTHROUGH names it', async () => {
  for (const passthrough of ['MISTRAL_API_KEY', 'MISTRAL_*', '*']) {
    const w = world({ extraEnv: { OMELETTE_ENV_PASSTHROUGH: passthrough, OMELETTE_SIBLING: 'kept?' } });
    const r = await w.review();
    assert.equal(r.isError, undefined, `${passthrough}: ${r.text}`);
    assert.equal(w.spawns()[0].env.MISTRAL_API_KEY, undefined, `passthrough ${passthrough}`);
  }
});

test('an effort the family lacks keeps the model and says so in the log', async () => {
  const w = world({ edit: (s) => { s.export.config.active_model = '$MODEL'; s.meta.config.model_name = 'zai-glm-5-3'; } });
  const r = await w.review({ model: 'glm-5-3', effort: 'medium' });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(model(w.spawns()[0]), 'glm-5-3');
  assert.deepEqual(w.used, ['glm-5-3']);
  assert.ok(w.logs.some((l) => /effort medium is not offered by glm-5-3/.test(l)), w.logs.join(' | '));
});

test('config keys reach argv: maxTurns, maxPrice, and --time-limit = timeoutS − 15', async () => {
  const w = world({ config: { maxTurns: 9, maxPrice: 7, timeoutS: 300 } });
  const r = await w.review();
  assert.equal(r.isError, undefined, r.text);
  const [s] = w.spawns();
  assert.equal(flag(s, '--max-turns'), '9');
  assert.equal(flag(s, '--max-price'), '7');
  assert.equal(flag(s, '--time-limit'), '285');
});

test('the environment variable MISTRAL_TIMEOUT_S moves --time-limit the same way', async () => {
  const w = world({ extraEnv: { MISTRAL_TIMEOUT_S: '600' } });
  await w.review();
  assert.equal(flag(w.spawns()[0], '--time-limit'), '585');
});

/* ── auth ──────────────────────────────────────────────────────────────────── */

test('a signed-out run (empty stdout, a login hint on stderr) is the operator action, not retried', async () => {
  const w = world({ edit: (s) => { s.answer = ''; s.code = 1; s.export = null; s.meta = null; s.stderr = 'Error: not logged in — sign in\n'; } });
  const r = await w.review();
  assert.equal(r.isError, true);
  assert.match(r.text, /sign in through the browser/);
  assert.equal(w.spawns().length, 1);
});

/* ── second pass: survivors of the mutation check ──────────────────────────── */

test('writeExport opens its file exclusively: a link planted at the name it picks is refused, the target is untouched', () => {
  const w = world();
  const target = join(w.root, 'victim.txt');
  writeFileSync(target, 'orig');
  const dir = exportsDir(w.fleet);
  mkdirSync(dir, { recursive: true });
  // The name is <UTC second>-<pid>-<per-process seq>; plant every seq the next call can draw, for the seconds around now.
  const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const now = Date.now();
  for (const t of [now - 1000, now, now + 1000, now + 2000]) {
    for (let seq = 1; seq <= 400; seq++) symlinkSync(target, join(dir, `${stamp(t)}-${process.pid}-${seq}.export.json`));
  }
  assert.throws(() => writeExport({ home: w.fleet, exportJson: 'PLANTED-THROUGH-LINK' }), /EEXIST/);
  assert.equal(readFileSync(target, 'utf8'), 'orig');
});

test('the directories the export is kept in are 0700 and the file 0600', async () => {
  const w = world();
  const r = await w.review();
  const path = /export=(.+)\)_$/.exec(r.text)[1];
  for (const d of [join(w.fleet, 'results'), join(w.fleet, 'results', 'mistral'), exportsDir(w.fleet)]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('a finished run with an empty stdout is refused as no answer, and not retried', async () => {
  const w = world({ edit: (s) => { s.answer = ''; } });
  const r = await w.review();
  assert.equal(r.isError, true);
  assert.match(r.text, /mistral: produced no answer \(outcome=finished, exit=0\)/);
  assert.equal(w.spawns().length, 1);
});

/* ── pins for the coordinator's three rulings (fix round): todo until the coder lands them ─────────── */

test('timeoutS <= 15 is refused before any spawn, naming mistral.timeoutS and the 15 s margin', async () => {
  for (const timeoutS of [1, 10, 15]) {
    const w = world({ config: { timeoutS } });
    const r = await w.review();
    assert.equal(r.isError, true, `timeoutS ${timeoutS}`);
    assert.match(r.text, /mistral\.timeoutS/);
    assert.match(r.text, /15/);
    assert.equal(w.spawns().length, 0, `timeoutS ${timeoutS}: no spawn`);
  }
  const ok = world({ config: { timeoutS: 16 } });
  assert.equal((await ok.review()).isError, undefined);
  assert.equal(flag(ok.spawns()[0], '--time-limit'), '1');
});

test('a null cost_usd prints est. $? and not $0.00', async () => {
  const w = world({ edit: (s) => { s.export.cost_usd = null; } });
  const r = await w.review();
  assert.match(r.text, /· est\. \$\? · export=/);
});

test('a finished run whose export.json is missing or unparsable is deterministic: one spawn', async () => {
  for (const edit of [(s) => { s.export = null; s.meta = null; }, (s) => { s.exportRaw = '{nope'; }]) {
    const w = world({ edit });
    const r = await w.review();
    assert.equal(r.isError, true);
    assert.equal(w.spawns().length, 1);
  }
});
