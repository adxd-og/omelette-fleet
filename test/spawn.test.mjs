import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../core/spawn.mjs';

const node = process.execPath;

test('captures stdout, stderr and exit code without rejecting on non-zero', async () => {
  const r = await runProcess({ bin: node, args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'] });
  assert.equal(r.stdout, 'out');
  assert.equal(r.stderr, 'err');
  assert.equal(r.code, 3);
  assert.equal(r.killed, false);
});

test('hard-kills the whole process group on timeout', async () => {
  const t0 = Date.now();
  const r = await runProcess({ bin: node, args: ['-e', 'setTimeout(() => {}, 20000)'], hardKillMs: 300 });
  assert.equal(r.killed, true);
  assert.ok(Date.now() - t0 < 5000);
});

test('scrubs billing-risk env vars from the child only', async () => {
  const r = await runProcess({
    bin: node, args: ['-e', 'process.stdout.write(String(process.env.OPENAI_API_KEY) + "|" + String(process.env.KEEP))'],
    env: { ...process.env, OPENAI_API_KEY: 'sk-secret', KEEP: 'yes' }, scrubEnv: ['OPENAI_API_KEY'],
  });
  assert.equal(r.stdout, 'undefined|yes');
});

test('keeps only the tail of runaway output', async () => {
  const r = await runProcess({ bin: node, args: ['-e', 'process.stdout.write("a".repeat(5000) + "END")'], outputCap: 100 });
  assert.equal(r.stdout.length, 100);
  assert.ok(r.stdout.endsWith('END'));
});

test('feeds stdinText and closes stdin', async () => {
  const r = await runProcess({ bin: node, args: ['-e', 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write("got:"+s))'], stdinText: 'hello' });
  assert.equal(r.stdout, 'got:hello');
});

test('a missing binary rejects with the actionable help text', async () => {
  await assert.rejects(
    runProcess({ bin: 'omelette-definitely-missing-bin', args: [], notFoundHelp: 'install the thing' }),
    /install the thing/,
  );
});
