import { test } from 'node:test';
import assert from 'node:assert/strict';
import unit, { buildArgs, extractResult, catalog } from '../units/codex/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import { mkdtempSync } from 'node:fs';
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

test('argv: read-only sandbox, json, web search toggle, effort as TOML string, prompt on stdin', () => {
  const a = buildArgs({ model: 'gpt-5.6-terra', effort: 'high', cwd: '/tmp/x', mode: 'read-only', webSearch: true });
  assert.deepEqual(a, [
    'exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-c', 'notify=[]',
    '-c', 'tools.web_search=true', '-C', '/tmp/x', '-m', 'gpt-5.6-terra', '-c', 'model_reasoning_effort="high"', '-',
  ]);
  const b = buildArgs({ mode: 'workspace-write', webSearch: false });
  assert.ok(b.includes('workspace-write'));
  assert.ok(b.includes('tools.web_search=false'));
  assert.ok(!b.includes('-m'));
  assert.ok(!b.some((x) => /dangerously/.test(x)));
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

test('unit contract: three tools, catalog non-empty, efforts fixed, tools/list is clean', () => {
  assert.equal(unit.name, 'codex');
  assert.deepEqual(unit.tools.map((t) => t.name), ['codex_research', 'codex_code_review', 'codex_models']);
  assert.ok(catalog.models.length >= 1);
  assert.deepEqual(catalog.effortEnum(), ['minimal', 'low', 'medium', 'high', 'xhigh']);
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
});
