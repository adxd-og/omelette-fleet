import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
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

test('keeps only the tail of runaway output, and says so with `capped`', async () => {
  const r = await runProcess({ bin: node, args: ['-e', 'process.stdout.write("a".repeat(5000) + "END")'], outputCap: 100 });
  assert.equal(r.stdout.length, 100);
  assert.ok(r.stdout.endsWith('END'));
  // The BEGINNING is what a tail cap drops, so a parser reading a stream from
  // the top has to be told it is looking at a fragment.
  assert.equal(r.capped, true);
});

test('`capped` is false when nothing was sliced — under the cap and exactly at it', async () => {
  const under = await runProcess({ bin: node, args: ['-e', 'process.stdout.write("short")'], outputCap: 100 });
  assert.equal(under.stdout, 'short');
  assert.equal(under.capped, false);
  // Exactly at the cap: every character is still there, so nothing was dropped.
  const exact = await runProcess({ bin: node, args: ['-e', 'process.stdout.write("a".repeat(100))'], outputCap: 100 });
  assert.equal(exact.stdout.length, 100);
  assert.equal(exact.capped, false);
  // Arriving in several chunks changes nothing: `capped` is about characters
  // dropped, not about how many writes it took to reach the cap.
  const chunked = await runProcess({
    bin: node,
    args: ['-e', 'process.stdout.write("a".repeat(50)); process.stdout.write("b".repeat(50))'],
    outputCap: 100,
  });
  assert.equal(chunked.stdout.length, 100);
  assert.equal(chunked.capped, false);
});

test('50 MB of 64 KiB chunks through a 4 MB cap: the last 4 MB exactly, without moving 3 GB to get there', {
  // The bound is about heap pressure, so a runner with little of it to spare
  // measures something else. The spec's own condition.
  skip: totalmem() < 2 * 1024 * 1024 * 1024 && 'needs at least 2 GiB of RAM to measure heap pressure',
}, async () => {
  const CAP = 4000000;
  const CHUNK = 64 * 1024;
  const CHUNKS = 800;               // 52.4 MB through a 4 MB cap
  const KEPT = Math.ceil(CAP / CHUNK) + 1;
  // Each chunk is one repeated digit, so the boundary between two of them is
  // visible in the answer and an off-by-one in the head slice cannot hide.
  const source = [
    `const chunk = (i) => String(i % 10).repeat(${CHUNK});`,
    'let i = 0;',
    'function pump() {',
    `  while (i < ${CHUNKS}) {`,
    '    const more = process.stdout.write(chunk(i));',
    '    i += 1;',
    '    if (!more) { process.stdout.once("drain", pump); return; }',
    '  }',
    '}',
    'pump();',
  ].join('\n');

  const before = process.memoryUsage().heapUsed;
  let peak = before;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 5);
  const r = await runProcess({ bin: node, args: ['-e', source], outputCap: CAP });
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  clearInterval(sampler);

  assert.equal(r.capped, true);
  assert.equal(r.stdout.length, CAP);
  // Built AFTER the sampler stops: this expectation is 4 MB of its own.
  const tail = Array.from({ length: KEPT }, (_, k) => String((CHUNKS - KEPT + k) % 10).repeat(CHUNK)).join('').slice(-CAP);
  assert.equal(r.stdout, tail);

  // WHAT THIS MEASURES: `heapUsed` includes young garbage that has not been
  // scavenged yet, which is exactly the pressure this change is about. The
  // queue holds the cap plus at most one chunk and joins once — measured 21
  // to 23 MiB here. The string it replaced flattened and re-copied the whole
  // 4 MB tail on every one of the 800 chunks, and each of those copies is a
  // large object that only a major GC reclaims — measured 67 to 72 MiB, and
  // 2.8 s against 0.1 s. The bound sits between the two with room on both
  // sides rather than at the theoretical minimum: this is a fence against the
  // pattern coming back, not a benchmark.
  const bound = CAP + 40 * 1024 * 1024;
  assert.ok(peak - before <= bound, `peak heap delta ${peak - before} > ${bound} — is the tail being copied per chunk again?`);
});

test('the queue keeps every promise the string it replaced made', async () => {
  // A CHARACTERIZATION GUARD: every assertion here passes before the change
  // as well as after. It is here because "behaviour is unchanged for every
  // caller" is the whole risk of the change, and the boundaries are where it
  // would break.
  // Two chunks landing exactly on the cap: nothing dropped, nothing sliced.
  const exact = await runProcess({
    bin: node,
    args: ['-e', 'process.stdout.write("a".repeat(50)); process.stdout.write("b".repeat(50))'],
    outputCap: 100,
  });
  assert.equal(exact.stdout, `${'a'.repeat(50)}${'b'.repeat(50)}`);
  assert.equal(exact.capped, false);
  // A tail that starts inside a chunk: the head is sliced, not dropped whole.
  const inside = await runProcess({
    bin: node,
    args: ['-e', 'process.stdout.write("0123456789"); process.stdout.write("ABCDEFGHIJ")'],
    outputCap: 12,
  });
  assert.equal(inside.stdout, '89ABCDEFGHIJ');
  assert.equal(inside.capped, true);
  // No output at all still resolves with an empty string, not undefined.
  const silent = await runProcess({ bin: node, args: ['-e', ''], outputCap: 100 });
  assert.equal(silent.stdout, '');
  assert.equal(silent.capped, false);
  // `outputCap: 0` has always meant "keep everything, and say it was capped"
  // — `slice(-0)` is the whole string. No caller passes it (core/unit.mjs
  // clamps to 1) and nothing documents it as unsupported either, so the queue
  // must not quietly turn it into something else.
  const zero = await runProcess({ bin: node, args: ['-e', 'process.stdout.write("abc")'], outputCap: 0 });
  assert.equal(zero.stdout, 'abc');
  assert.equal(zero.capped, true);
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

// --- cancellation: the abort path is the hard-kill path ----------------------

/**
 * A child that spawns a GRANDCHILD in the same process group and then exits on
 * its own after 400 ms. The grandchild writes `marker` 1.5 s in — long after
 * both the cancel and the parent's own exit — so the marker answers exactly one
 * question: did the whole GROUP die, or only the process we hold a handle to?
 */
function groupFixture(marker) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-group-'));
  const script = join(dir, 'parent.mjs');
  const inner = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 1500)`;
  writeFileSync(script, [
    'import { spawn } from "node:child_process";',
    `spawn(process.execPath, ["-e", ${JSON.stringify(inner)}], { stdio: "ignore" });`,
    'setTimeout(() => process.exit(0), 400);',
  ].join('\n'));
  return script;
}

test('an aborted signal SIGKILLs the whole process group and the result says `cancelled`', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'omelette-marker-')), 'grandchild-ran');
  const script = groupFixture(marker);
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 150);
  if (abort.unref) abort.unref();
  const t0 = Date.now();
  const r = await runProcess({ bin: node, args: [script], signal: controller.signal });
  assert.equal(r.cancelled, true);
  assert.equal(r.killed, true);
  assert.ok(Date.now() - t0 < 3000, 'the run ended with the cancel, not on its own schedule');
  await new Promise((res) => setTimeout(res, 1800));
  assert.equal(existsSync(marker), false, 'the grandchild died with the group');
});

test('…and the same fixture left alone DOES write the marker — the guard above is not vacuous', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'omelette-marker-')), 'grandchild-ran');
  const script = groupFixture(marker);
  const r = await runProcess({ bin: node, args: [script] });
  assert.equal(r.cancelled, false);
  assert.equal(r.killed, false);
  await new Promise((res) => setTimeout(res, 1800));
  assert.equal(existsSync(marker), true, 'nothing killed the group, so the grandchild ran');
});

test('a signal that is already aborted kills at once; one that never fires changes nothing', async () => {
  const fired = new AbortController();
  fired.abort();
  const t0 = Date.now();
  const r = await runProcess({ bin: node, args: ['-e', 'setTimeout(() => {}, 20000)'], signal: fired.signal });
  assert.equal(r.cancelled, true);
  assert.equal(r.killed, true);
  assert.ok(Date.now() - t0 < 5000);
  const quiet = await runProcess({
    bin: node, args: ['-e', 'process.stdout.write("done")'], signal: new AbortController().signal,
  });
  assert.equal(quiet.stdout, 'done');
  assert.equal(quiet.cancelled, false);
  assert.equal(quiet.killed, false);
  // No signal at all: today's behaviour, with the flag reported as false.
  const plain = await runProcess({ bin: node, args: ['-e', 'process.stdout.write("x")'] });
  assert.equal(plain.cancelled, false);
});
