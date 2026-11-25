// Tester rows for the 1.13.0 plan's T1-T3 (runProcess outFd, ctx.spawn wrap/outFd, a tool's modelKey).
// Only what test/spawn.test.mjs and test/unit.test.mjs do not already pin. No real CLI, no network:
// every child is node -e, every child has a bound.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, liveGroupCount } from '../core/spawn.mjs';
import { defineUnit, createUnitRuntime } from '../core/unit.mjs';
import { makeCatalog } from '../core/catalog.mjs';

const node = process.execPath;
// Every temp dir a row makes is removed when the file ends: a full run left about 25 behind before this.
const made = [];
const tmp = (prefix = 'neon-t13-') => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function until(check, what, capMs = 5000) {
  const end = Date.now() + capMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
    await new Promise((res) => setTimeout(res, 10));
  }
}
const readOr = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

/** A child that backgrounds a sleeper in its own group, records its pid, and then either exits or lingers. */
const leaderScript = (pidFile, { exits }) =>
  `const { spawn } = require('node:child_process');
   const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
   g.unref();
   require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
   process.stdout.write('started\\n');
   ${exits ? '' : 'setTimeout(() => {}, 30000);'}`;

// ─── T1: runProcess({ outFd }) ───────────────────────────────────────────────

test('outFd: killGroupOnExit still kills what the child left in its group', async () => {
  const dir = tmp();
  const pidFile = join(dir, 'pid');
  const fd = openSync(join(dir, 'out.txt'), 'wx', 0o600);
  let pid;
  try {
    const r = await runProcess({ bin: node, args: ['-e', leaderScript(pidFile, { exits: true })], outFd: fd, killGroupOnExit: true, hardKillMs: 5000 });
    assert.equal(r.killed, false);
    assert.equal(r.code, 0);
    pid = Number(readFileSync(pidFile, 'utf8'));
    await until(() => !alive(pid), 'the backgrounded sleeper to die with the group');
  } finally {
    closeSync(fd);
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

test('outFd: without killGroupOnExit the sleeper outlives the call (control for the row above)', async () => {
  const dir = tmp();
  const pidFile = join(dir, 'pid');
  const fd = openSync(join(dir, 'out.txt'), 'wx', 0o600);
  let pid;
  try {
    await runProcess({ bin: node, args: ['-e', leaderScript(pidFile, { exits: true })], outFd: fd, hardKillMs: 5000 });
    pid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(alive(pid), true);
  } finally {
    closeSync(fd);
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

test('outFd: a cancel (signal) kills the group, says cancelled, and what was written stays in the file', async () => {
  const dir = tmp();
  const pidFile = join(dir, 'pid');
  const out = join(dir, 'out.txt');
  const fd = openSync(out, 'wx', 0o600);
  const ac = new AbortController();
  const watch = setInterval(() => { if (readOr(out).includes('started') && readOr(pidFile)) { clearInterval(watch); ac.abort(); } }, 10);
  let pid;
  try {
    const r = await runProcess({ bin: node, args: ['-e', leaderScript(pidFile, { exits: false })], outFd: fd, signal: ac.signal, hardKillMs: 5000 });
    assert.equal(r.cancelled, true);
    assert.equal(r.killed, true);
    assert.equal(r.signal, 'SIGKILL');
    assert.equal(r.stdout, '');
    pid = Number(readFileSync(pidFile, 'utf8'));
    await until(() => !alive(pid), 'the grandchild to die with the group');
  } finally {
    clearInterval(watch);
    closeSync(fd);
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  assert.equal(readFileSync(out, 'utf8'), 'started\n');
});

test('outFd: the child is tracked while it runs and forgotten after; stdinText still reaches it', async () => {
  const dir = tmp();
  const out = join(dir, 'out.txt');
  const fd = openSync(out, 'wx', 0o600);
  const before = liveGroupCount();
  try {
    const p = runProcess({
      bin: node, hardKillMs: 5000, outFd: fd, stdinText: 'from stdin',
      args: ['-e', "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write('got:'+s))"],
    });
    assert.equal(liveGroupCount(), before + 1, 'tracked while running');
    const r = await p;
    assert.equal(r.code, 0);
  } finally { closeSync(fd); }
  assert.equal(liveGroupCount(), before);
  assert.equal(readFileSync(out, 'utf8'), 'got:from stdin');
});

// ─── T2: ctx.spawn({ wrap, outFd }) ──────────────────────────────────────────

const catalog = makeCatalog({ models: [{ id: 'm1' }, { id: 'm2' }] });
const schema = { type: 'object', properties: {} };

/** A unit whose one tool hands `go(ctx)` the runtime's ctx and returns what it returns. */
const unitWith = (go, extra = {}) => defineUnit({
  name: 'fake', label: 'Fake', bin: { env: 'FAKE_BIN', default: node },
  riskEnv: ['FAKE_API_KEY'], envPassthrough: ['FAKE_API_KEY'],
  auth: { detect: (stderr) => /not signed in/i.test(stderr), help: 'run `fake login`' },
  catalog,
  tools: [{ name: 'fake_go', kind: 'research', description: 'd', inputSchema: schema, run: (_a, ctx) => go(ctx) }],
  ...extra,
});
const runtime = (unit, config, envExtra = {}, opts = {}) => {
  const dir = tmp('neon-t13-home-');
  if (config) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(config));
  return { dir, rt: createUnitRuntime(unit, { env: { ...process.env, OMELETTE_HOME: dir, ...envExtra }, ...opts }) };
};

test('wrap: the env allowlist and the billing scrub apply to the wrapped command, extraEnv still lands', async () => {
  const { rt } = runtime(unitWith(async (ctx) => {
    const r = await ctx.spawn({
      args: [], extraEnv: { WRAPPED_EXTRA: 'yes' }, hardKillMs: 5000,
      wrap: (exe) => ({ bin: exe, args: ['-e', 'process.stdout.write([process.env.FAKE_API_KEY, process.env.GH_TOKEN, process.env.WRAPPED_EXTRA].map(String).join("|"))'] }),
    });
    return r.stdout;
  }), null, { FAKE_API_KEY: 'sk-billing', GH_TOKEN: 'ghp_secret' });
  const r = await rt.callTool('fake_go', {});
  assert.equal(r.isError, undefined, r.text);
  assert.equal(r.text, 'undefined|undefined|yes');
});

test('wrap: the auth check still reads a wrapped command\'s silent failure', async () => {
  const { rt } = runtime(unitWith(async (ctx) => {
    await ctx.spawn({
      args: [], hardKillMs: 5000,
      wrap: (exe) => ({ bin: exe, args: ['-e', 'process.stderr.write("Not signed in"); process.exit(1)'] }),
    });
    return 'unreachable';
  }), null);
  const r = await rt.callTool('fake_go', {});
  assert.equal(r.isError, true);
  assert.match(r.text, /run `fake login`/);
});

test('wrap: the unit\'s own bounds apply to the wrapped command (config timeoutS, and a cancel under cancel: kill)', async () => {
  // timeoutS 1 comes from config; no hardKillMs on the call.
  const slow = (ctx) => ctx.spawn({
    args: [], wrap: (exe) => ({ bin: exe, args: ['-e', 'setTimeout(() => {}, 20000)'] }),
  }).then((r) => `killed=${r.killed};cancelled=${r.cancelled}`);
  const t0 = Date.now();
  const { rt } = runtime(unitWith(slow), { units: { fake: { timeoutS: 1 } } });
  assert.equal((await rt.callTool('fake_go', {})).text, 'killed=true;cancelled=false');
  assert.ok(Date.now() - t0 < 10000);

  const { rt: rt2 } = runtime(unitWith(slow), null, {}, { cancel: 'kill' });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const t1 = Date.now();
  const r = await rt2.callTool('fake_go', {}, { signal: ac.signal });
  assert.ok(Date.now() - t1 < 10000, 'the cancel reached the wrapped child');
  assert.equal(r.text, 'killed=true;cancelled=true');
});

test('wrap: a result that is not { bin: string, args: array } rejects, whichever half is wrong', async () => {
  for (const [label, ret] of [
    ['undefined', undefined], ['null', null], ['a string', 'node'], ['no args', { bin: node }],
    ['args a string', { bin: node, args: '-e' }], ['args an object', { bin: node, args: { 0: '-e' } }], ['bin missing', { args: [] }],
  ]) {
    const { rt } = runtime(unitWith((ctx) => ctx.spawn({ args: [], wrap: () => ret, hardKillMs: 5000 }).then(() => 'ran')), null);
    const r = await rt.callTool('fake_go', {});
    assert.equal(r.isError, true, `${label}: ${r.text}`);
    assert.match(r.text, /wrap must return \{ bin, args \}/, label);
  }
});

test('wrap: a wrap that throws ends the call as an error carrying its message; the runtime stays usable', async () => {
  let boom = true;
  const { rt } = runtime(unitWith((ctx) => ctx.spawn({
    args: ['-e', 'process.stdout.write("fine")'], hardKillMs: 5000,
    wrap: (exe, a) => { if (boom) throw new Error('wrap blew up'); return { bin: exe, args: a }; },
  }).then((r) => r.stdout)), null);
  const bad = await rt.callTool('fake_go', {});
  assert.equal(bad.isError, true);
  assert.match(bad.text, /wrap blew up/);
  boom = false;
  assert.equal((await rt.callTool('fake_go', {})).text, 'fine');
});

test('wrap: a wrapped bin that does not exist is an error, not a hang', async () => {
  const dir = tmp();
  const t0 = Date.now();
  const { rt } = runtime(unitWith((ctx) => ctx.spawn({
    args: [], hardKillMs: 5000, wrap: (_exe, a) => ({ bin: join(dir, 'no-such-wrapper'), args: a }),
  }).then(() => 'ran')), null);
  const r = await rt.callTool('fake_go', {});
  assert.equal(r.isError, true, r.text);
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(r.text.includes(join(dir, 'no-such-wrapper')), r.text);
  assert.ok(!r.text.includes('install the'), r.text);
});

test('wrap is not called when the CLI cannot be located (the not-found error comes first)', async () => {
  let called = false;
  const { rt } = runtime(unitWith((ctx) => ctx.spawn({
    args: [], hardKillMs: 5000, wrap: (exe, a) => { called = true; return { bin: exe, args: a }; },
  }).then(() => 'ran'), { bin: { default: 'no-such-cli-neon-t13' } }), null);
  const r = await rt.callTool('fake_go', {});
  assert.equal(r.isError, true);
  assert.equal(called, false);
});

test('wrap + outFd together: the wrapped command\'s streams land in the file, in order, and the call keeps its result empty', async () => {
  const dir = tmp();
  const out = join(dir, 'out.txt');
  const fd = openSync(out, 'wx', 0o600);
  const { rt } = runtime(unitWith(async (ctx) => {
    const r = await ctx.spawn({
      args: ['x'], hardKillMs: 5000, outFd: fd,
      wrap: (exe, a) => ({ bin: exe, args: ['-e', "process.stdout.write('1\\n');process.stderr.write('2\\n');process.stdout.write('3 '+process.argv[1]+'\\n')", ...a] }),
    });
    return `stdout=${JSON.stringify(r.stdout)};stderr=${JSON.stringify(r.stderr)}`;
  }), null);
  try {
    assert.equal((await rt.callTool('fake_go', {})).text, 'stdout="";stderr=""');
  } finally { closeSync(fd); }
  assert.equal(readFileSync(out, 'utf8'), '1\n2\n3 x\n');
});

// ─── T3: a tool's modelKey ───────────────────────────────────────────────────

const keyed = () => defineUnit({
  name: 'fake', label: 'Fake', bin: { env: 'FAKE_BIN', default: node }, catalog,
  extraSchema: { testModel: { type: 'string', default: 'm2' } },
  tools: [
    { name: 'fake_keyed', kind: 'research', modelKey: 'testModel', description: 'd', inputSchema: schema, run: (_a, ctx) => `model=${ctx.model}` },
    { name: 'fake_plain', kind: 'research', description: 'd', inputSchema: schema, run: (_a, ctx) => `model=${ctx.model}` },
  ],
});
const startEvent = (dir) => readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).find((l) => l.event === 'start');

test('modelKey: an explicit model is still validated hard on a keyed tool, and wins over a valid key', async () => {
  const { rt } = runtime(keyed(), { units: { fake: { model: 'm1' } } });
  const bad = await rt.callTool('fake_keyed', { model: 'm-nope' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /unknown model "m-nope"/);
  assert.equal((await rt.callTool('fake_keyed', { model: ' m1 ' })).text, 'model=m1');
});

test('modelKey: the status feed\'s start carries the key\'s model, and a plain tool\'s start carries model\'s', async () => {
  const { dir, rt } = runtime(keyed(), { units: { fake: { model: 'm1' } } });
  await rt.callTool('fake_keyed', {});
  assert.equal(startEvent(dir).model, 'm2');
  const plain = runtime(keyed(), { units: { fake: { model: 'm1' } } });
  await plain.rt.callTool('fake_plain', {});
  assert.equal(startEvent(plain.dir).model, 'm1');
});

test('modelKey: an empty configured value leaves the model unnamed — and `model` is not consulted', async () => {
  const empty = runtime(keyed(), { units: { fake: { model: 'm1', testModel: '' } } });
  assert.equal((await empty.rt.callTool('fake_keyed', {})).text, 'model=', 'an empty testModel is no model, not a fall-back to `model`');
});

test('modelKey: a bad `model` does not warn a keyed tool, and a bad key does not warn a plain one', async () => {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    const a = runtime(keyed(), { units: { fake: { model: 'm-gone-a', testModel: 'm2' } } });
    assert.equal((await a.rt.callTool('fake_keyed', {})).text, 'model=m2');
    const b = runtime(keyed(), { units: { fake: { model: 'm1', testModel: 'm-gone-b' } } });
    assert.equal((await b.rt.callTool('fake_plain', {})).text, 'model=m1');
  } finally { process.stderr.write = write; }
  const all = lines.join('');
  assert.ok(!/default [a-zA-Z]+ "m-gone-a" is not in the catalog/.test(all), all);
  assert.ok(!/default [a-zA-Z]+ "m-gone-b" is not in the catalog/.test(all), all);
});

test('modelKey: an unnamed model on a plain tool whose `model` is off the catalog keeps the original warning, byte for byte', async () => {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  let r;
  try {
    const { rt } = runtime(keyed(), { units: { fake: { model: 'm-gone-c' } } });
    r = await rt.callTool('fake_plain', {});
  } finally { process.stderr.write = write; }
  assert.equal(r.text, 'model=');
  assert.ok(lines.some((l) => l.includes('config: default model "m-gone-c" is not in the catalog — using the vendor default')), lines.join(''));
});

test('modelKey: it is absent from tools/list and from the runtime\'s own tool objects, and a tool without it is unchanged in shape', () => {
  const rt = createUnitRuntime(keyed(), { env: { ...process.env, OMELETTE_HOME: tmp() } });
  for (const t of rt.tools) {
    assert.equal(Object.hasOwn(t, 'modelKey'), false, t.name);
    assert.deepEqual(Object.keys(t).sort(), ['description', 'inputSchema', 'name'].sort(), `${t.name}: public shape`);
  }
});

// ─── second pass: rows for the mutants the first file let live ──────────────

test('wrap: the spawn log line names the wrapped command, not the CLI', async () => {
  const link = join(tmp(), 'wrapper-node');
  symlinkSync(node, link);
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    const { rt } = runtime(unitWith((ctx) => ctx.spawn({
      args: ['-e', '0'], hardKillMs: 5000,
      wrap: (_exe, a) => ({ bin: link, args: ['-e', '1', ...a] }),
    }).then(() => 'ok')), null);
    assert.equal((await rt.callTool('fake_go', {})).text, 'ok');
  } finally { process.stderr.write = write; }
  const spawnLine = lines.find((l) => l.includes('spawn · bin='));
  assert.ok(spawnLine, lines.join(''));
  assert.ok(spawnLine.includes(`bin=${link} `), spawnLine);
  assert.ok(spawnLine.includes('argc=4 '), spawnLine);
});

test('modelKey: defineUnit refuses every non-string value, not only the truthy ones', () => {
  for (const bad of [0, false, null, {}, ['testModel']]) {
    assert.throws(() => unitWith(() => '', { tools: [{ name: 't', kind: 'research', modelKey: bad, description: 'd', inputSchema: schema, run: () => '' }] }),
      /tool "t" has a modelKey that is not a string/, JSON.stringify(bad));
  }
});

test('modelKey: an empty configured value is silent — no catalog warning for a value that names nothing', async () => {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    const { rt } = runtime(keyed(), { units: { fake: { model: 'm1', testModel: '' } } });
    assert.equal((await rt.callTool('fake_keyed', {})).text, 'model=');
  } finally { process.stderr.write = write; }
  assert.ok(!lines.some((l) => l.includes('is not in the catalog')), lines.join(''));
});
