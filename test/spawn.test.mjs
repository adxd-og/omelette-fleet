import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, buildChildEnv, ALLOWED_ENV } from '../core/spawn.mjs';

const node = process.execPath;

/** A parent env that carries the secrets a real MCP server's environment carries. */
const parentEnv = {
  PATH: '/usr/bin', HOME: '/home/x', LANG: 'en_US.UTF-8', TMPDIR: '/tmp',
  GH_TOKEN: 'ghp_secret', AWS_SECRET_ACCESS_KEY: 'aws_secret', OPENAI_API_KEY: 'sk-secret',
  CODEX_HOME: '/home/x/.codex', GROK_WEB_FETCH: '0', SOME_INTERNAL_URL: 'https://intranet',
};

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

test('buildChildEnv: the allowlist passes, everything else — secrets included — does not', () => {
  const e = buildChildEnv({ env: parentEnv });
  assert.equal(e.PATH, '/usr/bin');
  assert.equal(e.HOME, '/home/x');
  assert.equal(e.LANG, 'en_US.UTF-8');
  // The whole point: a model running read-only shell commands must not be able to read these.
  assert.equal(e.GH_TOKEN, undefined);
  assert.equal(e.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(e.SOME_INTERNAL_URL, undefined);
  assert.equal(e.CODEX_HOME, undefined); // no unit asked for it
  // Absent stays absent — "set but empty" means something else to some CLIs.
  assert.ok(!('TZ' in e));
  assert.ok(ALLOWED_ENV.includes('PATH') && !ALLOWED_ENV.some((n) => /TOKEN|SECRET|KEY/.test(n)));
});

test('buildChildEnv: per-unit passthrough patterns, then the billing scrub, then extra', () => {
  const codex = buildChildEnv({ env: parentEnv, passthrough: ['CODEX_*'], scrub: ['OPENAI_API_KEY', 'CODEX_API_KEY'] });
  assert.equal(codex.CODEX_HOME, '/home/x/.codex');
  assert.equal(codex.GH_TOKEN, undefined);
  assert.equal(codex.OPENAI_API_KEY, undefined);
  // A prefix pattern must not be able to re-admit the key the unit deletes on purpose.
  const grok = buildChildEnv({
    env: { ...parentEnv, XAI_API_KEY: 'xai-secret', GROK_BIN: '/bin/grok' },
    passthrough: ['GROK_*', 'XAI_*'], scrub: ['XAI_API_KEY'], extra: { GROK_WEB_FETCH: '1' },
  });
  assert.equal(grok.XAI_API_KEY, undefined);
  assert.equal(grok.GROK_BIN, '/bin/grok');
  assert.equal(grok.GROK_WEB_FETCH, '1'); // extra applies last and wins over the parent's '0'
  // Exact names work alongside patterns.
  assert.equal(buildChildEnv({ env: parentEnv, passthrough: ['SOME_INTERNAL_URL'] }).SOME_INTERNAL_URL, 'https://intranet');
});

test('buildChildEnv: OMELETTE_ENV_PASSTHROUGH is the operator escape hatch', () => {
  const env = { ...parentEnv, MY_CA_BUNDLE: '/etc/ca.pem', OMELETTE_ENV_PASSTHROUGH: ' MY_CA_BUNDLE , GH_* ' };
  const e = buildChildEnv({ env });
  assert.equal(e.MY_CA_BUNDLE, '/etc/ca.pem');
  assert.equal(e.GH_TOKEN, 'ghp_secret'); // the operator asked for it, explicitly
  assert.equal(e.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(e.OMELETTE_ENV_PASSTHROUGH, undefined); // the switch itself is not inherited
});

test('runProcess builds the child env from the allowlist and scrubs billing vars after it', async () => {
  const read = (n) => `String(process.env.${n})`;
  const r = await runProcess({
    bin: node,
    args: ['-e', `process.stdout.write([${read('OPENAI_API_KEY')}, ${read('GH_TOKEN')}, ${read('CODEX_HOME')}, ${read('PATH')} !== "undefined"].join("|"))`],
    env: { ...process.env, OPENAI_API_KEY: 'sk-secret', GH_TOKEN: 'ghp_secret', CODEX_HOME: '/home/x/.codex' },
    envPassthrough: ['CODEX_*'], scrubEnv: ['OPENAI_API_KEY'],
  });
  assert.equal(r.stdout, 'undefined|undefined|/home/x/.codex|true');
});

test('inheritEnv hands the parent env over untouched — operator tools only (`claude mcp add`)', async () => {
  const r = await runProcess({
    bin: node, args: ['-e', 'process.stdout.write(String(process.env.CLAUDE_CONFIG_DIR))'],
    env: { ...process.env, CLAUDE_CONFIG_DIR: '/home/x/.claude-alt' }, // deliberately NOT in ALLOWED_ENV
    inheritEnv: true,
  });
  assert.equal(r.stdout, '/home/x/.claude-alt');
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
