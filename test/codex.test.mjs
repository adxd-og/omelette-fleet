import { test } from 'node:test';
import assert from 'node:assert/strict';
import unit, { buildArgs, extractResult, catalog } from '../units/codex/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Event shapes captured live from codex-cli 0.146.0 (2026-09-02).
const OK_RUN = [
  '{"type":"thread.started","thread_id":"t1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll check the release page."}}',
  '{"type":"item.started","item":{"id":"e1","type":"web_search","query":"","action":{"type":"other"}}}',
  '{"type":"item.completed","item":{"id":"e1","type":"web_search","query":"node current","action":{"type":"search","query":"node current"}}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"v26.8.1"}}',
  '{"type":"turn.completed","usage":{"input_tokens":60835,"cached_input_tokens":45312,"cache_write_input_tokens":0,"output_tokens":236,"reasoning_output_tokens":103}}',
].join('\n') + '\n';

const FAILED_RUN = [
  '{"type":"thread.started","thread_id":"t2"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `no-such` not found."}}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'no-such\' model is not supported when using Codex with a ChatGPT account.\\"}}"}',
  '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'no-such\' model is not supported when using Codex with a ChatGPT account.\\"}}"}}',
].join('\n') + '\n';

test('argv: isolation flags, read-only sandbox, json, web search toggle, effort as TOML string, prompt on stdin', () => {
  const a = buildArgs({ model: 'gpt-5.6-terra', effort: 'high', cwd: '/tmp/x', mode: 'read-only', webSearch: true });
  assert.deepEqual(a, [
    'exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '-s', 'read-only', '-c', 'notify=[]',
    '-c', 'tools.web_search=true', '-C', '/tmp/x', '-m', 'gpt-5.6-terra', '-c', 'model_reasoning_effort="high"', '-',
  ]);
  const b = buildArgs({ mode: 'workspace-write', webSearch: false });
  assert.ok(b.includes('workspace-write'));
  assert.ok(b.includes('tools.web_search=false'));
  assert.ok(!b.includes('-m'));
  assert.ok(!b.some((x) => /dangerously/.test(x)));
  // The operator's ~/.codex/config.toml (MCP servers, plugins, hooks) and the
  // execpolicy .rules files are ignored on EVERY spawn, both modes.
  for (const argv of [a, b]) assert.ok(argv.includes('--ignore-user-config') && argv.includes('--ignore-rules'));
});

test('extractResult: the LAST agent_message is the answer, usage and search count are reported', () => {
  const r = extractResult({ stdout: OK_RUN, stderr: '', code: 0, killed: false });
  assert.equal(r.text, 'v26.8.1');
  assert.deepEqual(r.usage, { input: 60835, cachedInput: 45312, output: 236, reasoning: 103 });
  assert.equal(r.searches, 1);
});

test('extractResult: turn.failed becomes a clear error with the unwrapped API message', () => {
  assert.throws(
    () => extractResult({ stdout: FAILED_RUN, stderr: '', code: 1, killed: false }),
    /codex turn failed: The 'no-such' model is not supported/,
  );
});

test('extractResult: hard-kill, silent exit, and missing turn.completed are all loud', () => {
  assert.throws(() => extractResult({ stdout: OK_RUN, stderr: '', code: null, killed: true }, { timeoutS: 5 }), /hard-killed after 5s/);
  assert.throws(() => extractResult({ stdout: '', stderr: 'boom', code: 2, killed: false }), /codex exited 2: boom/);
  assert.throws(() => extractResult({ stdout: '', stderr: '', code: 0, killed: false }), /produced no answer/);
  const partial = extractResult({ stdout: OK_RUN.split('\n').slice(0, 6).join('\n'), stderr: '', code: 0, killed: false });
  assert.match(partial.text, /treat as partial/);
});

test('extractResult: a non-zero exit WITH an answer keeps the answer under a partial marker', () => {
  const r = extractResult({ stdout: OK_RUN, stderr: 'something went sideways', code: 1, killed: false });
  assert.match(r.text, /^v26\.8\.1/);
  assert.match(r.text, /\[codex: CLI exited 1 — treat the answer as partial\]/);
  assert.deepEqual(r.usage, { input: 60835, cachedInput: 45312, output: 236, reasoning: 103 });
});

test('unit contract: four tools, catalog non-empty, efforts fixed, tools/list is clean', () => {
  assert.equal(unit.name, 'codex');
  assert.deepEqual(unit.tools.map((t) => t.name), ['codex_research', 'codex_code_review', 'codex_image', 'codex_models']);
  // Image runs must never be retried (quota) and never carry the git intent gate.
  const image = unit.tools.find((t) => t.name === 'codex_image');
  assert.equal(image.kind, 'image');
  assert.ok(!image.mutateGate);
  assert.deepEqual(Object.keys(image.inputSchema.properties), ['prompt', 'model']);
  assert.ok(catalog.models.length >= 1);
  // The API's own list (its rejection message names them); 'minimal' was dropped 2026-09-03.
  assert.deepEqual(catalog.effortEnum(), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(!catalog.isAllowedEffort('minimal'));
  assert.deepEqual(unit.billingRiskEnv, ['OPENAI_API_KEY', 'CODEX_API_KEY']);
  assert.deepEqual(unit.supportedModes, { 'read-only': true, 'workspace-write': true });
});

test('runtime with a fake codex: research goes read-only even when the ceiling is open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-codex-'));
  // A fake `codex` that echoes its argv as JSONL so we can see the sandbox flag it received.
  const fake = join(dir, 'fake-codex.mjs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(fake, [
    'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{',
    '  const args=process.argv.slice(2);',
    '  const line=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");',
    '  line({type:"thread.started"});line({type:"turn.started"});',
    '  line({type:"item.completed",item:{type:"agent_message",text:"sandbox="+args[args.indexOf("-s")+1]+";stdin="+s.trim().slice(-11)}});',
    '  line({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}});',
    '});',
  ].join('\n'));
  const { writeFileSync: w2 } = await import('node:fs');
  w2(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { mode: 'workspace-write', timeoutS: 30 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, OMELETTE_ALLOW_WRITE: 'codex', CODEX_BIN: process.execPath };
  // CODEX_BIN=node, and we smuggle the script path in via a wrapper unit copy: simplest is to prepend it to args.
  const rt = createUnitRuntime({ ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) }, { env });
  const research = await rt.callTool('codex_research', { prompt: 'hello there' });
  assert.match(research.text, /sandbox=read-only;stdin=hello there/);
  const review = await rt.callTool('codex_code_review', { prompt: 'look', cwd: dir });
  assert.match(review.text, /sandbox=workspace-write/);
  const reviewNoCwd = await rt.callTool('codex_code_review', { prompt: 'look' });
  assert.match(reviewNoCwd.text, /sandbox=read-only/);
  const badCwd = await rt.callTool('codex_code_review', { prompt: 'look', cwd: 'relative/path' });
  assert.match(badCwd.text, /must be an absolute path/);
  assert.equal(badCwd.isError, true); // a refusal must never be reported to MCP as a success
  const noPrompt = await rt.callTool('codex_research', { prompt: '   ' });
  assert.equal(noPrompt.isError, true);
});

test('runtime: the child env is an allowlist — a secret in the parent env never reaches the CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-codex-env-'));
  const { writeFileSync } = await import('node:fs');
  // A "codex" that reports the secrets it can see, in codex's own JSONL shape.
  const fake = join(dir, 'fake-codex-env.mjs');
  writeFileSync(fake, [
    'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{',
    '  const line=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");',
    '  const a=process.argv.slice(2);',
    '  const seen="GH_TOKEN="+process.env.GH_TOKEN+";OPENAI_API_KEY="+process.env.OPENAI_API_KEY+";CODEX_HOME="+process.env.CODEX_HOME+";PATH="+(process.env.PATH?"set":"missing")+";model="+a[a.indexOf("-m")+1];',
    '  line({type:"item.completed",item:{type:"agent_message",text:seen}});',
    '  line({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}});',
    '});',
  ].join('\n'));
  const env = {
    ...process.env, OMELETTE_HOME: dir, CODEX_BIN: process.execPath,
    GH_TOKEN: 'leak', OPENAI_API_KEY: 'sk-leak', CODEX_HOME: join(dir, 'codex-home'),
  };
  const rt = createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
  const r = await rt.callTool('codex_research', { prompt: 'who am i' });
  assert.match(r.text, /GH_TOKEN=undefined/);        // not on the allowlist
  assert.match(r.text, /OPENAI_API_KEY=undefined/);  // never allowlisted, and on the billing scrub list
  assert.match(r.text, new RegExp(`CODEX_HOME=${join(dir, 'codex-home')}`)); // envPassthrough: ['CODEX_*']
  assert.match(r.text, /PATH=set/);
  // --ignore-user-config killed the operator's configured default, so an
  // unconfigured run pins the catalog head explicitly instead of drifting.
  assert.match(r.text, new RegExp(`model=${catalog.ids[0]}$`));
});

// --- codex_image ------------------------------------------------------------

/**
 * A fake `codex` for image runs: records the argv it received to `argvLog`,
 * optionally writes `image.png` into the -C directory, and answers with
 * `answer` (which may name a path). Same JSONL shape as the real CLI.
 */
function fakeImageCodex({ dir, name, argvLog, writeImage, answer }) {
  const fake = join(dir, name);
  writeFileSync(fake, [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{',
    '  const args=process.argv.slice(2);',
    `  writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args));`,
    '  const cwd=args[args.indexOf("-C")+1];',
    `  const answer=${JSON.stringify(answer)}.replace("<CWD>", cwd).replace("<STDIN>", s.trim().slice(-24));`,
    `  if (${writeImage ? 'true' : 'false'}) writeFileSync(join(cwd, "image.png"), "\x89PNG fake");`,
    '  const line=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");',
    '  line({type:"item.completed",item:{type:"agent_message",text:answer}});',
    '  line({type:"turn.completed",usage:{input_tokens:7,output_tokens:2}});',
    '});',
  ].join('\n'));
  return fake;
}

const wrapCodex = (env, fake) => createUnitRuntime(
  { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
  { env },
);

test('codex_image: workspace-write kernel-scoped to a fresh temp dir, web search off, artifact taken from disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-codex-img-'));
  const argvLog = join(dir, 'argv.json');
  const fake = fakeImageCodex({ dir, name: 'fake-img.mjs', argvLog, writeImage: true, answer: '<CWD>/image.png' });
  // The fleet ceiling is CLOSED and the unit is configured read-only: an image
  // run opens workspace-write anyway, because the only writable path is the
  // throwaway directory the adapter just created (see IMAGE in the adapter header).
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { mode: 'read-only', effort: 'high', webSearch: true, timeoutS: 30 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, CODEX_BIN: process.execPath };

  const r = await wrapCodex(env, fake).callTool('codex_image', { prompt: 'a small flat red circle' });
  assert.ok(!r.isError, r.text);

  const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
  assert.equal(argv[argv.indexOf('-s') + 1], 'workspace-write');
  assert.ok(argv.includes('-c') && argv.includes('tools.web_search=false'));
  assert.ok(!argv.includes('tools.web_search=true'));
  // No effort flag: the reasoning budget does not reach the image model, and a
  // configured `effort: high` must not ride along.
  assert.ok(!argv.some((x) => /model_reasoning_effort/.test(x)));
  assert.ok(argv.includes('--ignore-user-config') && argv.includes('--ignore-rules'));

  const cwd = argv[argv.indexOf('-C') + 1];
  const real = realpathSync(cwd); // macOS: /var/folders/… is a symlink to /private/var/folders/…
  assert.ok(real.startsWith(realpathSync(tmpdir())), `${real} is not under ${realpathSync(tmpdir())}`);
  assert.match(cwd, /omelette-codex-image-/);
  assert.notEqual(cwd, process.cwd());
  // The returned path is the file on disk, not merely what the model claimed.
  assert.equal(r.text, join(cwd, 'image.png'));
  assert.equal(readFileSync(r.text, 'utf8').slice(0, 4), '\x89PNG');
});

test('codex_image: falls back to the last existing path in the final message when image.png is absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-codex-img2-'));
  const elsewhere = join(dir, 'generated.png');
  writeFileSync(elsewhere, 'x');
  const fake = fakeImageCodex({
    dir, name: 'fake-img2.mjs', argvLog: join(dir, 'argv.json'), writeImage: false,
    answer: `The tool saved it here instead: ${elsewhere}`,
  });
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { timeoutS: 30 } } }));
  const r = await wrapCodex({ ...process.env, OMELETTE_HOME: dir, CODEX_BIN: process.execPath }, fake).callTool('codex_image', { prompt: 'x' });
  assert.ok(!r.isError, r.text);
  assert.equal(r.text, elsewhere);
});

test('codex_image: every call gets its OWN temp dir — a second run can never return the first run\'s artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-codex-img4-'));
  const argvLog = join(dir, 'argv.json');
  const fake = fakeImageCodex({ dir, name: 'fake-img4.mjs', argvLog, writeImage: true, answer: '<CWD>/image.png' });
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { timeoutS: 30 } } }));
  const rt = wrapCodex({ ...process.env, OMELETTE_HOME: dir, CODEX_BIN: process.execPath }, fake);
  const a = await rt.callTool('codex_image', { prompt: 'one' });
  const b = await rt.callTool('codex_image', { prompt: 'two' });
  assert.ok(!a.isError && !b.isError);
  assert.notEqual(a.text, b.text);
});

test('codex_image: prose with no file on disk is an error, not a success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-codex-img3-'));
  const fake = fakeImageCodex({
    dir, name: 'fake-img3.mjs', argvLog: join(dir, 'argv.json'), writeImage: false,
    answer: 'I was unable to generate the image, sorry about that.',
  });
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { timeoutS: 30 } } }));
  const rt = wrapCodex({ ...process.env, OMELETTE_HOME: dir, CODEX_BIN: process.execPath }, fake);
  const r = await rt.callTool('codex_image', { prompt: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /without a saved image on disk/);
  assert.match(r.text, /unable to generate the image/); // the raw tail is kept
  const noPrompt = await rt.callTool('codex_image', { prompt: '  ' });
  assert.equal(noPrompt.isError, true);
});
