/**
 * omelette-fleet :: test/tester-1.4.0-e.test.mjs
 * 1.4.0 fix round E: Grok memory off on research/review, the reach knobs the
 * GROK_* / CODEX_* / GOOGLE_* wildcards admit are scrubbed, and research runs
 * with no `cwd` start in a fresh empty directory that is gone afterwards.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createUnitRuntime } from '../core/unit.mjs';
import grok, { buildArgs, RESEARCH_TOOLS, REVIEW_TOOLS, IMAGE_GEN_TOOLS, IMAGE_EDIT_TOOLS } from '../units/grok/adapter.mjs';
import codex from '../units/codex/adapter.mjs';
import gemini, { catalog as geminiCatalog } from '../units/gemini/adapter.mjs';

/** A runtime whose vendor binary is `node <fake>`. */
const wrap = (unit, env, fake) => createUnitRuntime(
  { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
  { env },
);

// What every fake reports: its cwd, whether that directory was empty, its argv
// and the env names under test.
const REPORT = 'JSON.stringify({ cwd: process.cwd(), entries: require("node:fs").readdirSync(process.cwd()), argv: process.argv.slice(2), env: process.env })';

function fakeGrok(dir) {
  const fake = join(dir, 'fake-grok.cjs');
  writeFileSync(fake, `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: ${REPORT}, stop_reason: "end_turn" }) + "\\n");`);
  return fake;
}
function fakeCodex(dir) {
  const fake = join(dir, 'fake-codex.cjs');
  writeFileSync(fake, [
    'let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {',
    `  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${REPORT} } }) + "\\n");`,
    '  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");',
    '});',
  ].join('\n'));
  return fake;
}
function fakeAgy(dir) {
  const fake = join(dir, 'fake-agy.cjs');
  writeFileSync(fake, `process.stdout.write(JSON.stringify({ status: "SUCCESS", response: ${REPORT} }));`);
  return fake;
}

// --- (1) Grok memory off ------------------------------------------------------

test('grok buildArgs: research and review carry --no-memory; image runs do not', () => {
  for (const tools of [RESEARCH_TOOLS, REVIEW_TOOLS]) {
    assert.ok(buildArgs({ prompt: 'p', tools, maxTurns: 30 }).includes('--no-memory'), tools);
  }
  for (const tools of [IMAGE_GEN_TOOLS, IMAGE_EDIT_TOOLS]) {
    assert.ok(!buildArgs({ prompt: 'p', tools, maxTurns: 8 }).includes('--no-memory'), tools);
  }
});

// --- (2) the reach knobs ------------------------------------------------------

test('scrub lists hold the reach knobs, and leave the operator\'s choices alone', () => {
  for (const name of [
    'GROK_MEMORY', 'GROK_FOLDER_TRUST', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_WEB_FETCH_PROXY',
    'GROK_TRACE_UPLOAD_URL', 'GROK_TRACE_UPLOAD_BUCKET', 'GROK_TRACE_UPLOAD_ENDPOINT_URL',
    'GROK_TRACE_UPLOAD_CREDENTIALS_FILE', 'GROK_CLAUDE_HOOKS_ENABLED', 'GROK_CURSOR_HOOKS_ENABLED',
  ]) assert.ok(grok.billingRiskEnv.includes(name), name);
  assert.ok(codex.billingRiskEnv.includes('CODEX_EXEC_SERVER_URL'));
  assert.ok(gemini.billingRiskEnv.includes('GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES'));
  for (const name of ['GROK_HOME', 'GROK_MODELS_BASE_URL']) assert.ok(!grok.billingRiskEnv.includes(name), name);
  assert.ok(!gemini.billingRiskEnv.includes('AGY_ADC_AUTH'));
});

test('grok child env: GROK_MEMORY and GROK_AUTH_PROVIDER_COMMAND never arrive; GROK_HOME does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-e-grok-env-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { grok: { webSearch: true } } }));
  const env = {
    ...process.env, OMELETTE_HOME: dir, GROK_BIN: process.execPath,
    GROK_MEMORY: '1', GROK_AUTH_PROVIDER_COMMAND: '/bin/true', GROK_HOME: join(dir, 'grok-home'),
  };
  const rt = wrap(grok, env, fakeGrok(dir));
  for (const tool of ['grok_research', 'grok_code_review']) {
    const r = await rt.callTool(tool, { prompt: 'q' });
    assert.equal(r.isError, undefined, r.text);
    const seen = JSON.parse(r.text).env;
    assert.equal(seen.GROK_MEMORY, undefined, tool);
    assert.equal(seen.GROK_AUTH_PROVIDER_COMMAND, undefined, tool);
    assert.equal(seen.GROK_HOME, join(dir, 'grok-home'), tool);
  }
});

test('codex child env: CODEX_EXEC_SERVER_URL never arrives; CODEX_HOME does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-e-codex-env-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { timeoutS: 30 } } }));
  const env = {
    ...process.env, OMELETTE_HOME: dir, CODEX_BIN: process.execPath,
    CODEX_EXEC_SERVER_URL: 'http://127.0.0.1:9', CODEX_HOME: join(dir, 'codex-home'),
  };
  const r = await wrap(codex, env, fakeCodex(dir)).callTool('codex_research', { prompt: 'q' });
  assert.equal(r.isError, undefined, r.text);
  const seen = JSON.parse(r.text).env;
  assert.equal(seen.CODEX_EXEC_SERVER_URL, undefined);
  assert.equal(seen.CODEX_HOME, join(dir, 'codex-home'));
});

test('gemini child env: GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES never arrives; AGY_DEFAULT_MODEL does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-e-gemini-env-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const model = geminiCatalog.ids[0];
  const env = {
    ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath,
    GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES: '1', AGY_DEFAULT_MODEL: model,
  };
  const r = await wrap(gemini, env, fakeAgy(dir)).callTool('gemini_research', { prompt: 'q' });
  assert.equal(r.isError, undefined, r.text);
  const seen = JSON.parse(r.text).env;
  assert.equal(seen.GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES, undefined);
  assert.equal(seen.AGY_DEFAULT_MODEL, model);
});

// --- (3) research starts in an empty directory -------------------------------

test('grok_research without cwd: a fresh empty temp dir, passed as --cwd, gone after the call; with cwd: that dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-e-grok-cwd-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { grok: { webSearch: true } } }));
  const rt = wrap(grok, { ...process.env, OMELETTE_HOME: dir, GROK_BIN: process.execPath }, fakeGrok(dir));
  const seen = JSON.parse((await rt.callTool('grok_research', { prompt: 'q' })).text);
  const flag = seen.argv[seen.argv.indexOf('--cwd') + 1];
  assert.ok(seen.argv.includes('--cwd'), seen.argv.join(' '));
  assert.match(flag, /omelette-grok-research-/);
  assert.equal(basename(seen.cwd), basename(flag), 'the spawn cwd is the --cwd dir');
  assert.ok(flag.startsWith(tmpdir()), flag);
  assert.deepEqual(seen.entries, []);
  assert.ok(!existsSync(flag), `${flag} was not removed`);
  const where = mkdtempSync(join(tmpdir(), 'omelette-e-grok-where-'));
  writeFileSync(join(where, 'kept.txt'), 'x');
  const given = JSON.parse((await rt.callTool('grok_research', { prompt: 'q', cwd: where })).text);
  assert.equal(given.argv[given.argv.indexOf('--cwd') + 1], where);
  assert.equal(given.cwd, realpathSync(where));
  assert.ok(existsSync(join(where, 'kept.txt')), 'a caller\'s directory is never removed');
});

test('grok_code_review without cwd is unchanged: no --cwd, the server\'s own cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-e-grok-review-'));
  const rt = wrap(grok, { ...process.env, OMELETTE_HOME: dir, GROK_BIN: process.execPath }, fakeGrok(dir));
  const seen = JSON.parse((await rt.callTool('grok_code_review', { prompt: 'q' })).text);
  assert.ok(!seen.argv.includes('--cwd'));
  assert.equal(seen.cwd, realpathSync(process.cwd()));
});

test('gemini_research without cwd: a fresh empty temp dir as the spawn cwd, gone after the call; with cwd: that dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-e-gemini-cwd-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const rt = wrap(gemini, { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath }, fakeAgy(dir));
  const seen = JSON.parse((await rt.callTool('gemini_research', { prompt: 'q' })).text);
  assert.match(seen.cwd, /omelette-gemini-research-/);
  assert.ok(seen.cwd.startsWith(realpathSync(tmpdir())), seen.cwd);
  assert.notEqual(seen.cwd, realpathSync(process.cwd()));
  assert.deepEqual(seen.entries, []);
  assert.ok(!existsSync(seen.cwd), `${seen.cwd} was not removed`);
  const where = mkdtempSync(join(tmpdir(), 'omelette-e-gemini-where-'));
  writeFileSync(join(where, 'kept.txt'), 'x');
  const given = JSON.parse((await rt.callTool('gemini_research', { prompt: 'q', cwd: where })).text);
  assert.equal(given.cwd, realpathSync(where));
  assert.ok(existsSync(join(where, 'kept.txt')), 'a caller\'s directory is never removed');
});

test('the temp dir is removed when the run fails too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-e-grok-fail-'));
  const log = join(dir, 'cwd.txt');
  const fake = join(dir, 'fake-fail.cjs');
  writeFileSync(fake, `require("node:fs").writeFileSync(${JSON.stringify(log)}, process.cwd()); process.stderr.write("Not signed in"); process.exit(1);`);
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { grok: { webSearch: true } } }));
  const r = await wrap(grok, { ...process.env, OMELETTE_HOME: dir, GROK_BIN: process.execPath }, fake).callTool('grok_research', { prompt: 'q' });
  assert.equal(r.isError, true);
  const ran = readFileSync(log, 'utf8');
  assert.match(ran, /omelette-grok-research-/);
  assert.ok(!existsSync(ran), `${ran} was not removed`);
});

test('the research cwd descriptions say the default is a fresh empty directory', () => {
  const want = /Defaults to a fresh empty directory: pass a path only when the run should see a workspace/;
  assert.match(grok.tools.find((t) => t.name === 'grok_research').inputSchema.properties.cwd.description, want);
  assert.match(gemini.tools.find((t) => t.name === 'gemini_research').inputSchema.properties.cwd.description, want);
});

// --- (4) the codex review description ----------------------------------------

test('codex_code_review description: the sandbox bounds writes, not reads', () => {
  const d = codex.tools.find((t) => t.name === 'codex_code_review').description;
  assert.match(d, /runs read-only shell commands; no web search\. The sandbox bounds writes, not reads: the run can read what the operator's user can read, and nothing it reads can leave except in its answer\./);
  assert.doesNotMatch(d, /reaches nothing outside it/);
});

// --- round E2: the coordinator's rulings -------------------------------------

/** A runtime whose spawn is answered in-process and whose log lines are kept. */
const stubRt = (unit, env, stub, logs) => createUnitRuntime(
  { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub, log: (m) => { logs.push(m); ctx.log(m); } }) } : t)) },
  { env },
);
const agyOk = (text) => Promise.resolve({ stdout: JSON.stringify({ status: 'SUCCESS', response: text }), stderr: '', code: 0, signal: null, killed: false, capped: false });

test('gemini_research under workspace-write: accept-edits only with a cwd; without one it runs read-only in the empty dir and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-e-gemini-ww-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { mode: 'workspace-write', timeoutS: 30 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, OMELETTE_ALLOW_WRITE: 'gemini' };
  const calls = [];
  const logs = [];
  const rt = stubRt(gemini, env, (o) => { calls.push(o); return agyOk('fine'); }, logs);
  await rt.callTool('gemini_research', { prompt: 'q' });
  assert.ok(!calls[0].args.join(' ').includes('--mode accept-edits'), calls[0].args.join(' '));
  assert.match(calls[0].cwd, /omelette-gemini-research-/);
  assert.ok(logs.includes('workspace-write requested without cwd — running read-only'), logs.join('\n'));
  const where = mkdtempSync(join(tmpdir(), 'omelette-e-gemini-ww-where-'));
  calls.length = 0;
  logs.length = 0;
  await rt.callTool('gemini_research', { prompt: 'q', cwd: where });
  assert.ok(calls[0].args.join(' ').includes('--mode accept-edits'), calls[0].args.join(' '));
  assert.equal(calls[0].cwd, where);
  assert.ok(!logs.includes('workspace-write requested without cwd — running read-only'));
});

test('gemini_deep_research: every stage runs in one per-call empty dir, gone after the call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-e-gemini-deep-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const cwds = [];
  const stub = (o) => {
    cwds.push(o.cwd);
    return /Decompose/.test(o.args[1]) ? agyOk('["a", "b"]') : agyOk('finding');
  };
  const r = await stubRt(gemini, { ...process.env, OMELETTE_HOME: dir }, stub, []).callTool('gemini_deep_research', { question: 'q' });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(cwds.length, 4, 'decompose, two gathers, synthesis');
  assert.equal(new Set(cwds).size, 1, cwds.join('\n'));
  assert.match(cwds[0], /omelette-gemini-research-/);
  assert.ok(!existsSync(cwds[0]), `${cwds[0]} was not removed`);
  assert.match(gemini.tools.find((t) => t.name === 'gemini_deep_research').description, /runs in a fresh empty directory; under the web-research agy rule set it reads no local files/);
});

test('codex_research without cwd: a fresh empty temp dir as -C and spawn cwd, gone after the call; with cwd: that dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-e-codex-cwd-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { timeoutS: 30 } } }));
  const rt = wrap(codex, { ...process.env, OMELETTE_HOME: dir, CODEX_BIN: process.execPath }, fakeCodex(dir));
  const seen = JSON.parse((await rt.callTool('codex_research', { prompt: 'q' })).text);
  const flag = seen.argv[seen.argv.indexOf('-C') + 1];
  assert.ok(seen.argv.includes('-C'), seen.argv.join(' '));
  assert.match(flag, /omelette-codex-research-/);
  assert.equal(basename(seen.cwd), basename(flag));
  assert.deepEqual(seen.entries, []);
  assert.ok(!existsSync(flag), `${flag} was not removed`);
  const where = mkdtempSync(join(tmpdir(), 'omelette-e-codex-where-'));
  const given = JSON.parse((await rt.callTool('codex_research', { prompt: 'q', cwd: where })).text);
  assert.equal(given.argv[given.argv.indexOf('-C') + 1], where);
  assert.equal(given.cwd, realpathSync(where));
  assert.ok(existsSync(where));
  assert.match(codex.tools.find((t) => t.name === 'codex_research').inputSchema.properties.cwd.description,
    /Defaults to a fresh empty directory: pass a path only when the run should see a workspace/);
});

test('codex header: the exec-server claim says where it comes from', () => {
  assert.match(readFileSync(new URL('../units/codex/adapter.mjs', import.meta.url), 'utf8'), /even under --ignore-user-config \(upstream source, not measured here\)/);
});

// r3: `set` refuses an agents.*.model with an invisible character and shows the operator what it saw, escaped.
import { spawnSync as spawnSyncR3 } from 'node:child_process';
import { mkdtempSync as mkdtempR3 } from 'node:fs';
import { tmpdir as tmpdirR3 } from 'node:os';
import { join as joinR3, dirname as dirnameR3 } from 'node:path';
import { fileURLToPath as fileURLToPathR3 } from 'node:url';
test('set: a refused agents.*.model with a C1 control is echoed as its escape, never the byte', () => {
  const root = dirnameR3(dirnameR3(fileURLToPathR3(import.meta.url)));
  const home = mkdtempR3(joinR3(tmpdirR3(), 'omelette-set-r3-'));
  const r = spawnSyncR3(process.execPath, [joinR3(root, 'bin', 'omelette-fleet.mjs'), 'set', 'agents.coder.model=op\u009bus'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: home, OMELETTE_UPDATE_CHECK: '0' },
  });
  const out = r.stdout + r.stderr;
  assert.notEqual(r.status, 0, out);
  assert.ok(!out.includes('\u009b'), `raw C1 in: ${JSON.stringify(out)}`);
  assert.match(out, /\\u009b/);
  assert.match(out, /zero-width or bidi format character/);
});
