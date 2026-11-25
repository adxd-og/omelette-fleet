// Tester rows for 1.13.0 T7/T8 (gemini_test's profile B runner and the test program's resolution / reach).
// Pins what test/gemini-test-kernel.test.mjs and test/gemini-test-run.test.mjs leave open: the boundary of the
// test command from the kernel's side (every root the profile names, not one), the live log as evidence, the
// pure functions' anchors and refusals. Kernel rows skip where sandbox-exec cannot nest; every other row runs
// everywhere. Fixtures live under a `neon-test-` base; the kernel rows' HOME is a temp dir under /private/tmp.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync, writeSync, fstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createUnitRuntime, defineUnit } from '../core/unit.mjs';
import { makeCatalog } from '../core/catalog.mjs';
import { nodeEnv, regexLiteral } from '../core/seatbelt.mjs';
import {
  PROFILE_B, assertDeps, checkTestCommand, discardRun, parsePrograms, prepareTestRun, profileBArgs, programNeeds, readTail,
  resolveProgram, runTestCommand, safeOutput, shebangOf, testPath, toolchainReach,
} from '../units/gemini/test-run.mjs';

const DARWIN = process.platform === 'darwin';
const KERNEL = DARWIN && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'neon-test-')));
const HOMES = DARWIN ? '/private/tmp' : BASE;
const made = [BASE];
const SAVED_TMPDIR = process.env.TMPDIR;
process.env.TMPDIR = BASE;
const spawned = [];
after(() => {
  if (SAVED_TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = SAVED_TMPDIR;
  for (const pid of spawned) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of made) { try { chmodTree(d); } catch { /* best effort */ } rmSync(d, { recursive: true, force: true }); }
});
function chmodTree(d) { spawnSync('/bin/chmod', ['-R', 'u+rwX', d], { timeout: 5_000 }); }

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...ID }, timeout: 5_000 }).toString();

const KROW = { timeout: 20_000, skip: !KERNEL };
let n = 0;

/** A work tree (README + `files`), its patch, a run, a home under HOMES with `.ssh/id` and `.gitconfig`, a runtime over a unit whose one tool runs runTestCommand. */
function world({ files = {}, round = 1 } = {}) {
  const home = realpathSync(mkdtempSync(join(HOMES, 'neon-test-home-')));
  made.push(home);
  const fleet = join(home, '.omelette');
  mkdirSync(fleet);
  writeFileSync(join(fleet, 'fleet-secret'), 'fleet\n');
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'id'), 'ssh-secret-bytes\n');
  writeFileSync(join(home, '.gitconfig'), 'gitconfig-secret\n');
  const work = join(BASE, `tw${++n}`);
  mkdirSync(work);
  gitIn(work, 'init', '-q');
  for (const [p, c] of Object.entries({ 'README.md': 'one\n', ...files })) {
    mkdirSync(dirname(join(work, p)), { recursive: true });
    writeFileSync(join(work, p), c);
  }
  gitIn(work, 'add', '-A');
  gitIn(work, 'commit', '-qm', 'one');
  writeFileSync(join(work, 'README.md'), 'two\n');
  const patch = join(BASE, `tp${n}.patch`);
  writeFileSync(patch, gitIn(work, 'diff', 'HEAD'));
  const run = prepareTestRun({ cwd: work, patch, home });
  const e = nodeEnv({ home });
  const reach = { node: e.OMELETTE_REPRO_NODE, up: e.OMELETTE_REPRO_NODEUP };
  let opts = null;
  let result = null;
  const unit = defineUnit({
    name: 'neontest',
    label: 'Neon test',
    bin: { env: 'AGY_BIN', default: 'agy' },
    catalog: makeCatalog({ models: [{ id: 'm' }] }),
    tools: [{
      name: 'neontest_run', kind: 'research', description: 'd', inputSchema: { type: 'object', properties: {} },
      async run(_a, ctx) {
        result = await runTestCommand(ctx, run, { round, timeoutMs: 10_000, reach, home, fleet, ...opts });
        return 'ran';
      },
    }],
  });
  const exec = async (o, env = process.env) => {
    opts = o;
    result = null;
    const rt = createUnitRuntime(unit, { env: { ...env, AGY_BIN: process.execPath, OMELETTE_HOME: fleet }, onResult: () => {} });
    const r = await rt.callTool('neontest_run', {});
    assert.equal(r.isError, undefined, r.text);
    return result;
  };
  return { home, fleet, work, run, reach, exec, patch, done: () => discardRun(run) };
}
const node = () => realpathSync(process.execPath);
const lines = (out) => Object.fromEntries(out.trim().split('\n').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1)]; }));

// ─── kernel: the boundary of the test command, root by root ──────────────────────────────────────────────

const BOUNDARY = `
import { connect, createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { promises as dns } from 'node:dns';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
const c = JSON.parse(process.argv[2]);
const out = [];
const tryIt = (name, f) => { try { f(); out.push(name + ':ok'); } catch (e) { out.push(name + ':' + e.code); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// reads the reach does not name
tryIt('read-gitconfig', () => readFileSync(c.home + '/.gitconfig'));
tryIt('read-ssh', () => readFileSync(c.home + '/.ssh/id'));
tryIt('stat-gitconfig', () => statSync(c.home + '/.gitconfig'));
tryIt('list-home', () => readdirSync(c.home));
tryIt('read-fleet', () => readFileSync(c.fleet + '/fleet-secret'));
tryIt('read-src', () => readFileSync(c.work + '/README.md'));
tryIt('list-src', () => readdirSync(c.work));
tryIt('list-out', () => readdirSync(c.out));
tryIt('read-sibling', () => readFileSync(c.siblingClone + '/README.md'));
tryIt('stat-sibling', () => statSync(c.siblingClone));
tryIt('list-runs', () => readdirSync(c.runs));
// writes outside the clone and the run's tmp
tryIt('write-src', () => writeFileSync(c.work + '/planted', 'x'));
tryIt('write-fleet', () => writeFileSync(c.fleet + '/planted', 'x'));
tryIt('write-out', () => writeFileSync(c.out + '/planted', 'x'));
tryIt('write-sibling', () => writeFileSync(c.siblingClone + '/planted', 'x'));
tryIt('write-runs', () => writeFileSync(c.runs + '/planted', 'x'));
tryIt('write-tmproot', () => writeFileSync(c.tmproot + '/neon-test-planted', 'x'));
tryIt('mkdir-omelette', () => mkdirSync(c.tmproot + '/omelette-neon-probe'));
tryIt('write-home', () => writeFileSync(c.home + '/planted', 'x'));
tryIt('write-runhome', () => writeFileSync(c.runHome + '/planted', 'x'));
tryIt('rename-clone', () => renameSync(c.clone, c.clone + '-moved'));
tryIt('rename-tmp', () => renameSync(c.tmp, c.tmp + '-moved'));
tryIt('rmdir-tmp', () => rmdirSync(c.tmp));
// the hand-offs
for (const bin of ['/usr/bin/osascript', '/usr/bin/open', '/usr/bin/security', '/usr/bin/pbcopy', '/bin/launchctl']) {
  const r = spawnSync(bin, [], { timeout: 3000, input: '' });
  out.push('exec-' + bin.split('/').pop() + ':' + (r.error ? r.error.code : 'ran' + r.status));
}
// signals and process info outside the sandbox
tryIt('kill-outside', () => process.kill(c.outsidePid, 'SIGTERM'));
tryIt('kill0-parent', () => process.kill(process.ppid, 0));
const ps = spawnSync('/bin/ps', ['-p', String(c.outsidePid), '-o', 'command='], { timeout: 3000 });
out.push('ps-outside:' + JSON.stringify(String(ps.stdout || '').trim()));
// the network: TCP, UDP, a UNIX socket, DNS
await new Promise((res) => {
  const s = connect(c.tcpPort, '127.0.0.1');
  const t = setTimeout(() => { out.push('tcp:timeout'); s.destroy(); res(); }, 1500);
  s.on('connect', () => { clearTimeout(t); out.push('tcp:ok'); s.destroy(); res(); });
  s.on('error', (e) => { clearTimeout(t); out.push('tcp:' + e.code); res(); });
});
await new Promise((res) => {
  const u = createSocket('udp4');
  u.on('error', (e) => { out.push('udp:' + e.code); try { u.close(); } catch {} res(); });
  u.send('x', c.udpPort, '127.0.0.1', (e) => { out.push('udp:' + (e ? e.code : 'ok')); try { u.close(); } catch {} res(); });
});
await new Promise((res) => {
  const s = connect(c.sock);
  const t = setTimeout(() => { out.push('unix:timeout'); s.destroy(); res(); }, 1500);
  s.on('connect', () => { clearTimeout(t); out.push('unix:ok'); s.destroy(); res(); });
  s.on('error', (e) => { clearTimeout(t); out.push('unix:' + e.code); res(); });
});
await new Promise((res) => {
  const srv = createServer();
  srv.on('error', (e) => { out.push('unix-listen:' + e.code); res(); });
  srv.listen(c.tmp + '/own.sock', () => { out.push('unix-listen:ok'); srv.close(); res(); });
});
const d = await Promise.race([dns.resolve4('neon-test.invalid').then(() => 'ok', (e) => e.code), wait(2500).then(() => 'timeout')]);
out.push('dns:' + d);
console.log(out.join('\\n'));
`;

test('boundary: the test command reaches no network (TCP, UDP, UNIX socket, DNS), reads nothing the reach does not name, writes nowhere outside the clone and its tmp, hands off to nothing, signals nothing outside', KROW, async () => {
  const w = world({ files: { 'boundary.mjs': BOUNDARY } });
  const sibling = world();
  const tcp = { hits: 0 };
  const server = createServer((s) => { tcp.hits++; s.end(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const udp = createSocket('udp4');
  const udpHits = [];
  udp.on('message', (m) => udpHits.push(String(m)));
  udp.bind(0, '127.0.0.1');
  await once(udp, 'listening');
  const sock = join(realpathSync(mkdtempSync(join(HOMES, 'neon-test-sock-'))), 's.sock');
  made.push(dirname(sock));
  const unixHits = { n: 0 };
  const unixServer = createServer((s) => { unixHits.n++; s.end(); });
  unixServer.listen(sock);
  await once(unixServer, 'listening');
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });
  spawned.push(sleeper.pid);
  try {
    const cfg = {
      home: w.home, fleet: w.fleet, work: w.work, out: w.run.out, siblingClone: sibling.run.clone, runs: dirname(w.run.runDir),
      tmproot: BASE, runHome: w.run.home, clone: w.run.clone, tmp: w.run.tmp, outsidePid: sleeper.pid,
      tcpPort: server.address().port, udpPort: udp.address().port, sock,
    };
    const r = await w.exec({ args: [node(), 'boundary.mjs', JSON.stringify(cfg)] });
    const raw = readFileSync(r.log, 'utf8');
    assert.equal(r.code, 0, raw);
    const got = lines(raw);
    for (const k of ['read-gitconfig', 'read-ssh', 'stat-gitconfig', 'list-home', 'read-fleet', 'read-src', 'list-src', 'list-out', 'read-sibling', 'stat-sibling', 'list-runs',
      'write-src', 'write-fleet', 'write-out', 'write-sibling', 'write-runs', 'write-tmproot', 'mkdir-omelette', 'write-home', 'write-runhome', 'rename-clone', 'rename-tmp', 'rmdir-tmp',
      'kill-outside', 'kill0-parent']) assert.equal(got[k], 'EPERM', `${k}: ${got[k]}\n${raw}`);
    for (const k of ['exec-osascript', 'exec-open', 'exec-security', 'exec-pbcopy', 'exec-launchctl']) assert.match(got[k], /^(EPERM|EACCES)$/, `${k}: ${got[k]}`);
    assert.equal(got['ps-outside'], '""', 'the argv of a process outside the sandbox is not shown');
    assert.notEqual(got.tcp, 'ok');
    assert.notEqual(got.udp, 'ok');
    assert.notEqual(got.unix, 'ok');
    assert.notEqual(got['unix-listen'], 'ok');
    assert.notEqual(got.dns, 'ENOTFOUND', 'a resolver answered: the network was open');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(tcp.hits, 0, 'the TCP server saw a connection');
    assert.deepEqual(udpHits, [], 'the UDP socket saw a datagram');
    assert.equal(unixHits.n, 0, 'the UNIX socket server saw a connection');
    process.kill(sleeper.pid, 0); // still alive: not signalled
    for (const p of [join(w.work, 'planted'), join(w.fleet, 'planted'), join(w.home, 'planted'), join(BASE, 'neon-test-planted'), join(BASE, 'omelette-neon-probe'), join(w.run.out, 'planted'), join(sibling.run.clone, 'planted')]) {
      assert.equal(existsSync(p), false, p);
    }
    assert.equal(existsSync(w.run.clone), true);
    assert.equal(existsSync(w.run.tmp), true);
  } finally {
    server.close();
    udp.close();
    unixServer.close();
    try { process.kill(-sleeper.pid, 'SIGKILL'); } catch { /* gone */ }
    rmSync(join(BASE, 'omelette-neon-probe'), { recursive: true, force: true });
    w.done();
    sibling.done();
  }
});

test('the test command\'s env is the allowlist: no vendor or billing key of the server, HOME and TMPDIR the run\'s tmp, PATH the unit\'s own', KROW, async () => {
  const w = world({ files: { 'env.mjs': 'console.log(JSON.stringify(process.env));\n' } });
  try {
    const env = { ...process.env, GEMINI_API_KEY: 'k1', GOOGLE_API_KEY: 'k2', ANTHROPIC_API_KEY: 'k3', AWS_SECRET_ACCESS_KEY: 'k4', NODE_OPTIONS: '--no-warnings', OMELETTE_ALLOW_REPRO: '1', DYLD_INSERT_LIBRARIES: '/nowhere' };
    const r = await w.exec({ args: [node(), 'env.mjs'] }, env);
    const seen = JSON.parse(r.tail);
    for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'OMELETTE_ALLOW_REPRO', 'DYLD_INSERT_LIBRARIES', 'AGY_BIN', 'OMELETTE_HOME']) assert.equal(k in seen, false, k);
    assert.equal(seen.HOME, w.run.tmp);
    assert.equal(seen.TMPDIR, w.run.tmp);
    assert.equal(seen.PATH, testPath({ program: node(), home: w.home }));
  } finally { w.done(); }
});

test('the live log replaced, unlinked or linked elsewhere by the command: the unit\'s copy holds what the command wrote, read through the unit\'s own descriptor', KROW, async () => {
  const script = `
import { readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
console.log('evidence');
const live = readdirSync(process.env.TMPDIR).find((n) => /^round-1-[0-9a-f]{12}\\.log$/.test(n));
const at = process.env.TMPDIR + '/' + live;
renameSync(at, at + '.moved');
symlinkSync('/etc/hosts', at);
writeFileSync(at + '.moved2', 'forged\\n');
try { unlinkSync(at); } catch {}
symlinkSync(process.argv[2], at);
`;
  const w = world({ files: { 'swap.mjs': script } });
  try {
    const decoy = join(BASE, 'decoy.txt');
    writeFileSync(decoy, 'decoy-bytes-the-unit-must-not-follow\n');
    const r = await w.exec({ args: [node(), 'swap.mjs', decoy] });
    assert.equal(r.code, 0, r.tail);
    assert.equal(r.tail, 'evidence\n');
    assert.equal(readFileSync(r.log, 'utf8'), 'evidence\n');
    assert.equal(readFileSync(decoy, 'utf8'), 'decoy-bytes-the-unit-must-not-follow\n');
  } finally { w.done(); }
});

test('a log past 1 MiB keeps its last MiB, contiguous, under a header naming the cut; exactly 1 MiB is kept whole with no header', KROW, async () => {
  const lines3 = `
const total = 3 * 1024 * 1024;
let written = 0;
let i = 0;
while (written < total) {
  const line = String(i++).padStart(7, '0') + ' ' + 'z'.repeat(119) + '\\n';
  const take = Math.min(line.length, total - written);
  process.stdout.write(line.slice(0, take));
  written += take;
}
`;
  const exact = `process.stdout.write('q'.repeat(1024 * 1024 - 1) + '\\n');`;
  // Two runs: a run's test command is pinned at its first test run.
  const w = world({ files: { 'big.mjs': lines3 } });
  const w2 = world({ files: { 'exact.mjs': exact } });
  try {
    const r = await w.exec({ args: [node(), 'big.mjs'] });
    assert.equal(r.code, 0);
    const kept = readFileSync(r.log, 'latin1');
    const [header, ...rest] = kept.split('\n');
    assert.equal(header, '[omelette-fleet: the first 2097152 bytes of this output cut; the last 1048576 kept]');
    assert.equal(kept.length, header.length + 1 + 1048576);
    const body = rest.join('\n');
    // 3 MiB of 128-byte lines is a multiple of 128: the last line is whole and numbered 24575, and the kept MiB is the 8192 lines before it end.
    assert.ok(body.endsWith(`${String(3 * 1024 * 1024 / 128 - 1).padStart(7, '0')} ${'z'.repeat(119)}\n`), 'the last bytes written are the last bytes kept');
    const nums = body.split('\n').filter(Boolean).map((l) => Number(l.slice(0, 7)));
    assert.equal(nums.length, 8192);
    assert.equal(nums[0], 24576 - 8192);
    assert.ok(r.tail.endsWith(`${String(24575).padStart(7, '0')} ${'z'.repeat(119)}\n`));
    const e = await w2.exec({ args: [node(), 'exact.mjs'] });
    assert.equal(statSync(e.log).size, 1024 * 1024);
    assert.equal(readFileSync(e.log, 'latin1').startsWith('qqqq'), true, 'no header on a log that is not cut');
  } finally {
    w.done();
    w2.done();
  }
});

test('the home and the fleet home given through a link (/tmp) are resolved: the real path of a secret stays unreadable', KROW, async () => {
  // Two runs, one per command: a run's test command is pinned at its first test run.
  const files = { 'readhome.mjs': 'import { readFileSync } from "node:fs";\ntry { readFileSync(process.argv[2]); console.log("read:ok"); } catch (e) { console.log("read:" + e.code); }\n' };
  const w = world({ files });
  const w2 = world({ files });
  try {
    const spelled = `/tmp/${w.home.split('/').pop()}`;
    assert.equal(realpathSync(spelled), w.home, 'the fixture needs /tmp to be a link to /private/tmp');
    const r = await w.exec({ args: [node(), 'readhome.mjs', join(w.home, '.ssh', 'id')], home: spelled, fleet: `${spelled}/.omelette` });
    assert.equal(r.tail, 'read:EPERM\n');
    const spelled2 = `/tmp/${w2.home.split('/').pop()}`;
    const f = await w2.exec({ args: [node(), 'readhome.mjs', join(w2.fleet, 'fleet-secret')], home: spelled2, fleet: `${spelled2}/.omelette` });
    assert.equal(f.tail, 'read:EPERM\n');
  } finally {
    w.done();
    w2.done();
  }
});

test('a time limit ends a command that ignores SIGTERM, and says so', KROW, async () => {
  const w = world({ files: { 'term.mjs': 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n' } });
  try {
    const t0 = Date.now();
    const r = await w.exec({ args: [node(), 'term.mjs'], timeoutMs: 500 });
    assert.equal(r.killed, true);
    assert.equal(r.cancelled, false);
    assert.ok(Date.now() - t0 < 5_000, String(Date.now() - t0));
  } finally { w.done(); }
});

const PROGRAM_TOOL = '#!/bin/sh\nfor f in "$@"; do if /bin/cat "$f" >/dev/null 2>&1; then echo "$f:ok"; else echo "$f:denied"; fi; done\n';

test('a prefix under the home with regex metacharacters in its name is re-allowed whole, and neither a sibling that differs at a metacharacter nor one that merely starts the same is', KROW, async () => {
  const w = world();
  const share = join(w.home, '.local', 'share');
  const prefix = join(share, 'to.ol+x(1)');
  const lookalike = join(share, 'toXol+x(1)');
  const longer = join(share, 'to.ol+x(1)-other');
  for (const d of [join(prefix, 'bin'), lookalike, longer]) mkdirSync(d, { recursive: true });
  writeFileSync(join(prefix, 'data'), 'in\n');
  writeFileSync(join(lookalike, 'data'), 'lookalike\n');
  writeFileSync(join(longer, 'data'), 'longer\n');
  const tool = join(prefix, 'bin', 'tool');
  writeFileSync(tool, PROGRAM_TOOL);
  chmodSync(tool, 0o755);
  try {
    const reach = toolchainReach({ home: w.home, binaries: [tool] });
    const r = await w.exec({ args: [tool, join(prefix, 'data'), join(lookalike, 'data'), join(longer, 'data'), join(w.home, '.ssh', 'id')], reach });
    assert.equal(r.code, 0, r.tail);
    assert.equal(r.tail, [`${join(prefix, 'data')}:ok`, `${join(lookalike, 'data')}:denied`, `${join(longer, 'data')}:denied`, `${join(w.home, '.ssh', 'id')}:denied`].join('\n') + '\n');
  } finally { w.done(); }
});

test('a program in a direct child of the home gets that child\'s bin and lib, not the child whole: a credentials file beside them stays closed', KROW, async () => {
  const w = world();
  const prefix = join(w.home, '.cargo');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  mkdirSync(join(prefix, 'lib'));
  writeFileSync(join(prefix, 'lib', 'x'), 'lib\n');
  writeFileSync(join(prefix, 'credentials.toml'), 'token\n');
  const tool = join(prefix, 'bin', 'tool');
  writeFileSync(tool, PROGRAM_TOOL);
  chmodSync(tool, 0o755);
  try {
    const reach = toolchainReach({ home: w.home, binaries: [tool] });
    const r = await w.exec({ args: [tool, join(prefix, 'lib', 'x'), join(prefix, 'credentials.toml')], reach });
    assert.equal(r.code, 0, r.tail);
    assert.equal(r.tail, `${join(prefix, 'lib', 'x')}:ok\n${join(prefix, 'credentials.toml')}:denied\n`);
  } finally { w.done(); }
});

// ─── runTestCommand through a fake ctx: what it hands to ctx.spawn, and what it does with the log ───────────────

/** A ctx whose spawn records its options and writes `out` through the outFd the unit gave it. */
function fakeCtx({ out = 'out\n', result = { code: 0, signal: null, killed: false, cancelled: false }, delayMs = 0, throws = null, during = () => {} } = {}) {
  const ctx = {
    seen: null,
    async spawn(o) {
      ctx.seen = o;
      during(o);
      if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
      if (throws) throw throws;
      writeSyncFd(o.outFd, out);
      return result;
    },
  };
  return ctx;
}
const writeSyncFd = (fd, s) => writeSync(fd, s);

function pureWorld() {
  const w = world();
  const e = nodeEnv({ home: w.home });
  return { ...w, reach: { node: e.OMELETTE_REPRO_NODE, up: e.OMELETTE_REPRO_NODEUP } };
}

test('runTestCommand hands ctx.spawn the run\'s clone as cwd, its tmp as HOME and TMPDIR, testPath as PATH, the time limit as hard kill, the group kill, a descriptor, and a wrap that puts sandbox-exec and profile B in front', async () => {
  const w = pureWorld();
  let sandboxedAtSpawn = null;
  const live = { names: null, mode: null };
  try {
    const args = [node(), 'x.mjs', '--flag'];
    const spawnCtx = fakeCtx({
      result: { code: 3, signal: 'SIGKILL', killed: true, cancelled: true },
      delayMs: 120,
      during: (o) => {
        sandboxedAtSpawn = w.run.sandboxed;
        live.names = readdirSync(w.run.tmp);
        live.mode = statSync(join(w.run.tmp, live.names[0])).mode & 0o777;
        assert.equal(typeof o.outFd, 'number');
      },
    });
    const r = await runTestCommand(spawnCtx, w.run, { args, round: 2, timeoutMs: 4321, reach: w.reach, home: w.home, fleet: w.fleet, pathDirs: ['/opt/extra'] });
    const o = spawnCtx.seen;
    assert.equal(sandboxedAtSpawn, true, 'run.sandboxed is set before the spawn');
    assert.equal(live.names.length, 1);
    assert.match(live.names[0], /^round-2-[0-9a-f]{12}\.log$/);
    assert.equal(live.mode, 0o600);
    assert.deepEqual(o.args, args);
    assert.equal(o.cwd, w.run.clone);
    assert.deepEqual(o.extraEnv, { HOME: w.run.tmp, TMPDIR: w.run.tmp, PATH: testPath({ program: args[0], home: w.home, extra: ['/opt/extra'] }) });
    assert.equal(o.hardKillMs, 4321);
    assert.equal(o.killGroupOnExit, true);
    const wrapped = o.wrap('/ignored', ['a', 'b']);
    assert.equal(wrapped.bin, '/usr/bin/sandbox-exec');
    assert.deepEqual(wrapped.args, [...profileBArgs(w.run, { home: w.home, fleet: w.fleet, reach: w.reach }), 'a', 'b']);
    assert.deepEqual({ code: r.code, signal: r.signal, killed: r.killed, cancelled: r.cancelled }, { code: 3, signal: 'SIGKILL', killed: true, cancelled: true });
    assert.ok(r.ms >= 100 && r.ms < 5000, String(r.ms));
    assert.equal(r.log, join(w.run.out, 'round-2.log'));
    assert.equal(readFileSync(r.log, 'utf8'), 'out\n');
    assert.equal(statSync(r.log).mode & 0o777, 0o600);
    assert.equal(r.tail, 'out\n');
    assert.throws(() => writeSyncFd(o.outFd, 'x'), /EBADF/, 'the descriptor is closed after the run');
  } finally { w.done(); }
});

test('profileBArgs: a -D for each parameter profile B reads, every path resolved, then -f the run\'s derived profile (repro.sb first)', () => {
  const w = pureWorld();
  try {
    const link = join(BASE, `home-link-${++n}`);
    symlinkSync(w.home, link);
    const a = profileBArgs(w.run, { home: link, fleet: join(link, '.omelette'), reach: { node: '^(/n)(/|$)', up: '^$' } });
    assert.equal(a.at(-2), '-f');
    // fix round ruling 1 (2026-11-25): -f names the run's own derived profile, out/b.sb, which opens with repro.sb's text unchanged
    assert.equal(a.at(-1), join(w.run.out, 'b.sb'));
    assert.equal(existsSync(PROFILE_B), true);
    assert.equal(readFileSync(a.at(-1), 'utf8').startsWith(readFileSync(PROFILE_B, 'utf8')), true);
    const params = a.slice(0, -2);
    const pairs = [];
    for (let i = 0; i < params.length; i += 2) { assert.equal(params[i], '-D'); pairs.push(params[i + 1]); }
    const map = Object.fromEntries(pairs.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
    assert.deepEqual(Object.keys(map).sort(), ['CLONE', 'FLEET', 'HOME', 'NODE', 'NODEUP', 'OUT', 'RUN', 'RUNS', 'SRC', 'TMP', 'TMPROOT']);
    assert.equal(map.CLONE, realpathSync(w.run.clone));
    assert.equal(map.TMP, realpathSync(w.run.tmp));
    assert.equal(map.OUT, realpathSync(w.run.out));
    assert.equal(map.RUN, realpathSync(w.run.runDir));
    assert.equal(map.RUNS, realpathSync(dirname(w.run.runDir)));
    assert.equal(map.SRC, realpathSync(w.run.top));
    assert.equal(map.SRC, realpathSync(w.work));
    assert.equal(map.HOME, w.home, 'a home spelled through a link is passed resolved');
    assert.equal(map.FLEET, join(w.home, '.omelette'));
    assert.equal(map.TMPROOT, regexLiteral(realpathSync(tmpdir())));
    assert.equal(map.NODE, '^(/n)(/|$)');
    assert.equal(map.NODEUP, '^$');
    // The OS temp dir spelled through a link (/var -> /private/var on macOS): the omelette-* deny must be written on the real path.
    const realTmp = realpathSync(mkdtempSync(join(BASE, 'tmp.real+(x)-')));
    const tmpLink = join(BASE, `tmplink-${++n}`);
    symlinkSync(realTmp, tmpLink);
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = tmpLink;
    try {
      const viaLink = profileBArgs(w.run, { home: w.home, fleet: w.fleet, reach: w.reach }).find((x) => x.startsWith('TMPROOT='));
      assert.notEqual(regexLiteral(realTmp), realTmp, 'the fixture path holds regex metacharacters');
      assert.equal(viaLink, `TMPROOT=${regexLiteral(realTmp)}`);
    } finally { process.env.TMPDIR = savedTmp; }
  } finally { w.done(); }
});

test('runTestCommand: a round whose out/round-<n>.log exists is refused before anything is opened, a spawn that throws leaves the run marked sandboxed with its descriptor closed, and neither leaves a round-* entry in tmp/', async () => {
  const w = pureWorld();
  const roundEntries = () => readdirSync(w.run.tmp).filter((x) => x.startsWith('round-'));
  try {
    writeFileSync(join(w.run.out, 'round-1.log'), 'planted\n');
    const ctx1 = fakeCtx();
    await assert.rejects(runTestCommand(ctx1, w.run, { args: [node()], round: 1, timeoutMs: 1000, reach: w.reach, home: w.home, fleet: w.fleet }), (e) => e.message === 'gemini: round 1 already ran in this run');
    assert.equal(ctx1.seen, null, 'nothing was spawned');
    assert.equal(w.run.sandboxed, undefined, 'the run is not marked sandboxed by a refusal');
    assert.deepEqual(roundEntries(), []);
    assert.equal(readFileSync(join(w.run.out, 'round-1.log'), 'utf8'), 'planted\n');
    // a link or a directory at the name counts as «already ran» too (lstat: nothing is followed)
    symlinkSync(join(BASE, 'nowhere'), join(w.run.out, 'round-3.log'));
    mkdirSync(join(w.run.out, 'round-4.log'));
    for (const r of [3, 4]) await assert.rejects(runTestCommand(fakeCtx(), w.run, { args: [node()], round: r, timeoutMs: 1000, reach: w.reach, home: w.home, fleet: w.fleet }), (e) => e.message === `gemini: round ${r} already ran in this run`);
    const boom = new Error('spawn blew up');
    const ctx = fakeCtx({ throws: boom });
    await assert.rejects(runTestCommand(ctx, w.run, { args: [node()], round: 2, timeoutMs: 1000, reach: w.reach, home: w.home, fleet: w.fleet }), (e) => e === boom);
    assert.equal(w.run.sandboxed, true, 'a model-written program may have started: the run is not discarded as clean');
    assert.throws(() => fstatSync(ctx.seen.outFd), /EBADF/);
    assert.equal(existsSync(join(w.run.out, 'round-2.log')), false);
    assert.deepEqual(roundEntries(), [], 'the live log is removed after a spawn that throws');
  } finally { w.done(); }
});

// ─── readTail, safeOutput, testPath ──────────────────────────────────────────────────────────────────────

test('readTail: the last bytes of the file, a cut UTF-8 character dropped whole whether it is 2, 3 or 4 bytes, an empty or short file read as it is', () => {
  const dir = mkdtempSync(join(BASE, 'tail-'));
  const put = (name, buf) => { const p = join(dir, name); writeFileSync(p, buf); return p; };
  assert.equal(readTail(put('empty', '')), '');
  assert.equal(readTail(put('short', 'héllo\n')), 'héllo\n');
  assert.equal(readTail(put('last10', 'abcdefghijklmnop'), 10), 'ghijklmnop');
  assert.equal(readTail(put('exact', 'a'.repeat(16384))), 'a'.repeat(16384));
  for (const [ch, width] of [['é', 2], ['€', 3], ['😀', 4]]) {
    const body = ch.repeat(Math.ceil(20000 / width));
    const total = Buffer.byteLength(body);
    for (let skew = 0; skew < width; skew++) {
      const buf = Buffer.concat([Buffer.from('a'.repeat(skew)), Buffer.from(body)]);
      const got = readTail(put(`cut-${width}-${skew}`, buf));
      assert.equal(got.includes('�'), false, `${ch} cut at skew ${skew}`);
      assert.equal(got, ch.repeat(got.length / ch.length), 'only whole characters');
      assert.ok(Buffer.byteLength(got) <= 16384);
      assert.ok(Buffer.byteLength(got) > 16384 - width, `${Buffer.byteLength(got)} bytes of ${ch}, skew ${skew}, total ${total}`);
    }
  }
});

test('safeOutput: no escape, carriage return, C1 or bidi character survives whatever the input is built from, and an escape sequence rebuilt by the removal of an inner one is not left whole', () => {
  const nasty = [
    '\u001b[\u001b[31mm', '\u001b]\u001b]0;x\u0007\u0007', '\u001b', 'x\u001b', '\u001b[', '\u001b[31', '\u001b]0;unterminated', '\u009b31m', '\u009d0;t\u0007',
    'a\rb\r\nc\n\rd', '\u202eevil\u202c', '\u2066x\u2069', '\u200b\u200d\u2060\ufeff', '\u0085\u2028\u2029', '\u{e0041}tag', '\u0000\u0007\u0008\u007f',
    'ok\tkeep\nkeep', 'a\u001b[1;31;4mred\u001b[0m\u001b[K\u001b[2J', '\u001b[?25l\u001b[?25h', '\u001b]8;;http://e\u0007link\u001b]8;;\u0007',
  ];
  for (const s of nasty) {
    const out = safeOutput(s);
    assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/u.test(out), false, JSON.stringify(s));
  }
  assert.equal(safeOutput('ok\tkeep\nkeep'), 'ok\tkeep\nkeep');
  assert.equal(safeOutput('a\rb\r\nc\n\rd'), 'a\nb\nc\n\nd');
  assert.equal(safeOutput('a\u001b[1;31;4mred\u001b[0m\u001b[K\u001b[2J'), 'ared');
  assert.equal(safeOutput('\u001b]8;;http://e\u0007link\u001b]8;;\u0007'), 'link');
  // CSI with a private-mode marker, an intermediate byte, or a `>` parameter prefix is one sequence too.
  assert.equal(safeOutput('x\u001b[?25ly\u001b[1 qz\u001b[>4;2mq'), 'xyzq');
});

test('testPath: the home itself and a spelling that merely starts like it are told apart, a link in the home that leaves it is dropped by its spelling, a home with a trailing slash counts, and the default inherited PATH is the process\'s', () => {
  const root = realpathSync(mkdtempSync(join(BASE, 'path-')));
  const home = join(root, 'home');
  for (const d of ['home/real', 'home-other/bin', 'sys/out', 'prog']) mkdirSync(join(root, d), { recursive: true });
  symlinkSync(join(root, 'sys', 'out'), join(home, 'leaves'));
  const program = join(root, 'prog', 'tool');
  const inherited = [home, join(home, 'leaves'), join(root, 'home-other', 'bin'), join(root, 'sys', 'out')].join(':');
  assert.equal(testPath({ program, home, inherited }), [join(root, 'prog'), join(root, 'home-other', 'bin'), join(root, 'sys', 'out'), '/usr/bin', '/bin'].join(':'));
  assert.equal(testPath({ program, home: `${home}/`, inherited }), [join(root, 'prog'), join(root, 'home-other', 'bin'), join(root, 'sys', 'out'), '/usr/bin', '/bin'].join(':'));
  const saved = process.env.PATH;
  process.env.PATH = [join(root, 'sys', 'out'), join(home, 'real')].join(':');
  try { assert.equal(testPath({ program, home }), [join(root, 'prog'), join(root, 'sys', 'out'), '/usr/bin', '/bin'].join(':')); } finally { process.env.PATH = saved; }
  // A relative entry that exists in the working directory is still not a PATH entry the command gets.
  const cwdDir = realpathSync(mkdtempSync(join(BASE, 'cwd-')));
  mkdirSync(join(cwdDir, 'rel'));
  const savedCwd = process.cwd();
  process.chdir(cwdDir);
  try { assert.equal(testPath({ program, home, inherited: `rel:./rel:${join(root, 'sys', 'out')}` }), [join(root, 'prog'), join(root, 'sys', 'out'), '/usr/bin', '/bin'].join(':')); } finally { process.chdir(savedCwd); }
  assert.equal(testPath({ program, home, inherited: '' }), [join(root, 'prog'), '/usr/bin', '/bin'].join(':'));
  assert.equal(testPath({ program, home, inherited, extra: [join(root, 'sys', 'out'), join(root, 'prog')] }), [join(root, 'prog'), join(root, 'sys', 'out'), join(root, 'home-other', 'bin'), '/usr/bin', '/bin'].join(':'), 'extra entries are not repeated');
});

// ─── resolveProgram, checkTestCommand, parsePrograms, shebangOf ───────────────────────────────────────────

/** A fixture tree: path → content (executable file), `{ link }` a symlink, `{ dir: true }` a directory. */
function tree(spec) {
  const dir = realpathSync(mkdtempSync(join(BASE, `t${++n}-`)));
  for (const [p, c] of Object.entries(spec)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    if (c && typeof c === 'object' && c.dir) mkdirSync(join(dir, p), { recursive: true });
    else if (c && typeof c === 'object' && c.link !== undefined) symlinkSync(c.link, join(dir, p));
    else { writeFileSync(join(dir, p), c); chmodSync(join(dir, p), 0o755); }
  }
  return dir;
}
const runOf = (spec) => { const runDir = tree(Object.fromEntries(Object.entries(spec).map(([p, c]) => [p.startsWith('/') ? p.slice(1) : `clone/${p}`, c]))); mkdirSync(join(runDir, 'clone'), { recursive: true }); return { runDir, clone: join(runDir, 'clone'), top: tree({}) }; };

test('resolveProgram: a deps entry is a directory, not a name prefix; a directory or a dangling link is not a program; a link into the run\'s tmp, out or home is refused as the clone is', () => {
  const run = runOf({
    'node_modules/.bin/y': '#!/bin/sh\n', 'node_modules/adir': { dir: true }, 'node_modules/.bin/dangling': { link: '../nowhere' },
    'node_modules_evil/x': '#!/bin/sh\n', 'ab/x': '#!/bin/sh\n',
    'node_modules/.bin/to-tmp': { link: '../../../tmp/x' }, 'node_modules/.bin/to-out': { link: '../../../out/x' }, 'node_modules/.bin/to-home': { link: '../../../home/x' },
    'node_modules/.bin/to-dir-root': { link: '../../../x' },
    '/tmp/x': '#!/bin/sh\n', '/out/x': '#!/bin/sh\n', '/home/x': '#!/bin/sh\n', '/x': '#!/bin/sh\n',
  });
  const resolve = (word, deps = ['node_modules']) => resolveProgram({ word, programs: [], deps, run });
  for (const w of ['node_modules_evil/x', 'Node_Modules/.bin/y', 'ab/x']) assert.throws(() => resolve(w, w === 'ab/x' ? ['a'] : ['node_modules']), (e) => /is not under a deps entry/.test(e.message), w);
  for (const w of ['node_modules/adir', 'node_modules/.bin/dangling']) assert.throws(() => resolve(w), (e) => e.message === `gemini: ${JSON.stringify(w)} is not a file in the copy`, w);
  for (const w of ['node_modules/.bin/to-tmp', 'node_modules/.bin/to-out', 'node_modules/.bin/to-home', 'node_modules/.bin/to-dir-root']) {
    assert.throws(() => resolve(w), (e) => e.message === `gemini: ${JSON.stringify(w)} resolves into the copy outside its dependency directory`, w);
  }
  assert.equal(resolve('node_modules/.bin/y'), join(run.clone, 'node_modules', '.bin', 'y'));
  assert.equal(resolve('node_modules/.bin/../.bin/y'.replace('/../.bin', '/./')), join(run.clone, 'node_modules', '.bin', 'y'));
});

test('resolveProgram: a link in a dep to a directory whose name merely starts like the dep is outside it (refused), one to a directory whose name merely starts like the run dir is outside the run (accepted)', () => {
  const run = runOf({ 'node_modules/.bin/y': '#!/bin/sh\n', 'node_modules-evil/x': '#!/bin/sh\n', 'node_modules/.bin/evil': { link: '../../node_modules-evil/x' } });
  const sibling = `${run.runDir}-sib`;
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'prog'), '#!/bin/sh\n');
  chmodSync(join(sibling, 'prog'), 0o755);
  symlinkSync(join(sibling, 'prog'), join(run.clone, 'node_modules', '.bin', 'sib'));
  const resolve = (word) => resolveProgram({ word, programs: [], deps: ['node_modules'], run });
  assert.throws(() => resolve('node_modules/.bin/evil'), (e) => e.message === 'gemini: "node_modules/.bin/evil" resolves into the copy outside its dependency directory');
  assert.equal(resolve('node_modules/.bin/sib'), join(run.clone, 'node_modules', '.bin', 'sib'));
});

test('resolveProgram: the work-tree refusal compares resolved paths on a directory boundary — a PATH entry that is a link into the tree is refused, a sibling directory that starts like the tree is not, a link inside the tree to a program outside it is not', () => {
  const root = tree({ 'proj/bin/tool': '#!/bin/sh\n', 'proj-tools/bin/tool': '#!/bin/sh\n', 'sys/real-tool': '#!/bin/sh\n' });
  const top = join(root, 'proj');
  symlinkSync(join(top, 'bin'), join(root, 'sys-link'));
  symlinkSync(join(root, 'sys', 'real-tool'), join(top, 'bin', 'outward'));
  const run = { ...runOf({}), top };
  const resolve = (word, dirs) => resolveProgram({ word, programs: ['tool', 'outward'], deps: [], run, env: { PATH: dirs.join(':') } });
  const refusal = (e) => /resolves into the work tree/.test(e.message);
  assert.throws(() => resolve('tool', [join(top, 'bin')]), refusal);
  assert.throws(() => resolve('tool', [join(root, 'sys-link')]), refusal, 'a spelling outside the tree whose real path is inside');
  assert.equal(resolve('tool', [join(root, 'proj-tools', 'bin')]), join(root, 'proj-tools', 'bin', 'tool'));
  assert.equal(resolve('outward', [join(top, 'bin')]), join(root, 'sys', 'real-tool'), 'a spelling inside the tree whose real path is outside');
});

test('checkTestCommand: every control character is refused (NUL, TAB, CR, ESC, DEL), a space is not, and an array with holes or a non-array is refused', () => {
  const refused = (e) => e.message === 'gemini: "testCommand" must be an argv array of 1 to 64 strings with no control characters';
  for (const c of ['\u0000', '\t', '\r', '\u001b', '\u001f', '\u007f']) assert.throws(() => checkTestCommand(['node', `a${c}b`]), refused, JSON.stringify(c));
  assert.deepEqual(checkTestCommand(['node', 'a b', ' ']), ['node', 'a b', ' ']);
  for (const bad of [null, undefined, {}, { length: 1, 0: 'node' }, 7, [undefined], [null], [['node']]]) assert.throws(() => checkTestCommand(bad), refused, String(bad));
});

test('checkTestCommand: an array with holes is not an argv array', () => {
  // A JSON request cannot carry holes; the contract is "an array of 1 to 64 strings", and Array.prototype.every skips a hole.
  assert.throws(() => checkTestCommand(new Array(2)), (e) => e.message === 'gemini: "testCommand" must be an argv array of 1 to 64 strings with no control characters');
  assert.throws(() => checkTestCommand(['node', , 'x']), (e) => e.message === 'gemini: "testCommand" must be an argv array of 1 to 64 strings with no control characters');
});

test('parsePrograms: a name is letters, digits and . _ + - and starts with a letter or a digit; a dot-name, a flag, a lookalike slash, a newline and a NUL are refused', () => {
  assert.deepEqual(parsePrograms('python3.12, g++,node-gyp,ts_node'), ['python3.12', 'g++', 'node-gyp', 'ts_node']);
  assert.deepEqual(parsePrograms(''), []);
  assert.deepEqual(parsePrograms(undefined), []);
  for (const bad of ['.hidden', '..', '-n', '+x', '_x', 'no∕de', 'a\nb', 'a\u0000b', 'nöde', 'a;b', 'a/b', 'a\\b']) {
    assert.throws(() => parsePrograms(`node,${bad}`), (e) => e.message === `gemini: gemini.testPrograms holds ${JSON.stringify(bad)}, not a program name`, JSON.stringify(bad));
  }
});

test('shebangOf: CRLF and a blank after #! are read, a relative interpreter, a bare env, a short file and an empty file give null, and a missing env target gives null', () => {
  const dir = tree({
    'bin/node': '#!/bin/sh\n', 'crlf.sh': '#!/bin/sh\r\necho\r\n', 'spaced.sh': '#! /bin/sh -e\n', 'tabs.js': '#!/usr/bin/env\tnode\n', 'rel.sh': '#!bin/sh\n', 'dot.sh': '#!./sh\n',
    'bare.js': '#!/usr/bin/env\n', 'one': '#', 'empty': '', 'nonl.sh': '#!/bin/sh', 'envs.js': '#!/usr/bin/env -S node --a --b\n',
  });
  const env = { PATH: join(dir, 'bin') };
  const at = (f) => shebangOf(join(dir, f), { env });
  assert.equal(at('crlf.sh'), '/bin/sh');
  assert.equal(at('spaced.sh'), '/bin/sh');
  assert.equal(at('nonl.sh'), '/bin/sh');
  assert.equal(at('tabs.js'), join(dir, 'bin', 'node'));
  assert.equal(at('envs.js'), join(dir, 'bin', 'node'));
  for (const f of ['rel.sh', 'dot.sh', 'bare.js', 'one', 'empty']) assert.equal(at(f), null, f);
  assert.equal(shebangOf(join(dir, 'tabs.js'), { env: { PATH: 'bin' } }), null, 'a relative PATH entry is not searched');
  // Only a first line that opens with #! is a shebang; the interpreter of a script is not followed; env takes a name, not a path.
  writeFileSync(join(dir, 'comment.sh'), '# /bin/sh\n');
  writeFileSync(join(dir, 'prefixed.sh'), 'xx/bin/sh\n');
  writeFileSync(join(dir, 'interp'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'direct.sh'), `#!${join(dir, 'interp')}\n`);
  writeFileSync(join(dir, 'envpath.sh'), '#!/usr/bin/env /bin/sh\n');
  writeFileSync(join(dir, 'envrel.sh'), '#!/usr/bin/env ./sh\n');
  assert.equal(at('comment.sh'), null);
  assert.equal(at('prefixed.sh'), null);
  assert.equal(at('direct.sh'), join(dir, 'interp'), 'one level: the interpreter\'s own #! is not read');
  assert.equal(at('envpath.sh'), null);
  assert.equal(at('envrel.sh'), null);
});

test('programNeeds: a bare name found through a link into another directory adds the directory it was found in, even when its interpreter is not there', () => {
  const dir = tree({ 'x/bin/foo': { link: '../lib/foo.sh' }, 'x/lib/foo.sh': '#!/bin/sh\n' });
  const program = realpathSync(join(dir, 'x/bin/foo'));
  assert.equal(program, join(dir, 'x/lib/foo.sh'));
  assert.deepEqual(programNeeds({ word: 'foo', program, env: { PATH: join(dir, 'x/bin') } }), { dirs: [join(dir, 'x/bin'), '/bin'], interpreter: '/bin/sh' });
});

test('programNeeds: a relative PATH entry is not searched for the program or its interpreter', () => {
  const dir = tree({ 'rel/node': '#!/bin/sh\n', 'prog/tool.js': '#!/usr/bin/env node\n', 'abs/node': '#!/bin/sh\n' });
  const saved = process.cwd();
  process.chdir(dir);
  try {
    const program = join(dir, 'prog', 'tool.js');
    assert.deepEqual(programNeeds({ word: 'tool.js', program, env: { PATH: `rel:${join(dir, 'abs')}` } }), { dirs: [join(dir, 'abs')], interpreter: join(dir, 'abs', 'node') });
    assert.deepEqual(programNeeds({ word: 'tool.js', program, env: { PATH: 'rel' } }), { dirs: [], interpreter: null });
  } finally { process.chdir(saved); }
});

// ─── toolchainReach and assertDeps ───────────────────────────────────────────────────────────────────────

const covers = (re, hits, misses) => {
  const r = new RegExp(re);
  for (const p of hits) assert.ok(r.test(p), `${re} should match ${p}`);
  for (const p of misses) assert.ok(!r.test(p), `${re} should miss ${p}`);
};

test('toolchainReach: a binary is resolved first (a link that leaves the home adds nothing, one from outside that lands in it adds its real prefix), a binary that does not exist or is null adds nothing, and a home given through a link works on real paths', () => {
  const root = realpathSync(mkdtempSync(join(BASE, 'reach-')));
  const home = join(root, 'home');
  const homeLink = join(root, 'home-link');
  for (const d of ['home/bin', 'home/.local/share/t/bin', 'outside']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(home, '.local/share/t/bin/tool'), '#!/bin/sh\n');
  writeFileSync(join(root, 'outside', 'plain'), '#!/bin/sh\n');
  symlinkSync('/bin/sh', join(home, 'bin', 'leaves'));
  symlinkSync(join(home, '.local/share/t/bin/tool'), join(root, 'outside', 'arrives'));
  symlinkSync(home, homeLink);
  const base = nodeEnv({ home, prefix: '/opt/fleet-node', binary: '/opt/fleet-node/bin/node' });
  const same = { node: base.OMELETTE_REPRO_NODE, up: base.OMELETTE_REPRO_NODEUP };
  assert.deepEqual(toolchainReach({ home, binaries: [join(home, 'bin', 'leaves'), join(root, 'outside', 'plain'), join(home, 'missing'), null, undefined], base }), same);
  const reach = toolchainReach({ home, binaries: [join(root, 'outside', 'arrives')], base });
  covers(reach.node, [join(home, '.local/share/t'), join(home, '.local/share/t/bin/tool')], [join(home, '.local/share/u'), join(home, 'bin/leaves'), home]);
  const viaLink = toolchainReach({ home: homeLink, binaries: [join(homeLink, '.local/share/t/bin/tool')], base });
  assert.deepEqual(viaLink, reach);
});

test('toolchainReach: a prefix that merely starts like another, and one that differs at a metacharacter of its name, are not covered; the up chain covers the parents and nothing beside them', () => {
  const home = tree({ '.local/share/py.v+1/bin/python3': 'p', '.local/share/py.v+1/lib/os.py': 'o', '.local/share/pyXv+1/lib/os.py': 'o', '.local/share/py.v+1-other/lib/os.py': 'o', '.local/share/pyXv+1/bin/node': 'n' });
  const base = nodeEnv({ home, prefix: '/opt/fleet-node', binary: '/opt/fleet-node/bin/node' });
  const prefix = join(home, '.local/share/py.v+1');
  const reach = toolchainReach({ home, binaries: [join(prefix, 'bin/python3')], base });
  covers(reach.node, [prefix, join(prefix, 'lib/os.py'), join(prefix, 'bin/python3')], [join(home, '.local/share/pyXv+1'), join(home, '.local/share/pyXv+1/lib/os.py'), `${prefix}-other`, `${prefix}-other/lib/os.py`, join(home, '.local/share'), home]);
  covers(reach.up, [home, join(home, '.local'), join(home, '.local/share')], [prefix, join(home, '.local/share/pyXv+1'), `${prefix}-other`, join(home, '.ssh'), `${home}x`]);
  // An nvm-shaped prefix sitting beside it brings its own three paths and the chain to lib/node_modules, nothing more.
  const nvm = tree({ '.nvm/versions/node/v1/bin/node': 'n', '.nvm/versions/node/v1/lib/node_modules/npm/x': 'x', '.nvm/versions/node/v1/lib/node_modules/corepack/x': 'x', '.nvm/versions/node/v1/lib/node_modules/other/x': 'x', '.nvm/versions/node/v10/bin/node': 'n' });
  const r2 = toolchainReach({ home: nvm, binaries: [join(nvm, '.nvm/versions/node/v1/bin/node')], base: nodeEnv({ home: nvm, prefix: '/opt/fleet-node', binary: '/opt/fleet-node/bin/node' }) });
  covers(r2.node, [join(nvm, '.nvm/versions/node/v1/bin/node'), join(nvm, '.nvm/versions/node/v1/lib/node_modules/npm/x'), join(nvm, '.nvm/versions/node/v1/lib/node_modules/corepack/x')],
    [join(nvm, '.nvm/versions/node/v1/lib/node_modules/other/x'), join(nvm, '.nvm/versions/node/v10/bin/node'), join(nvm, '.nvm/versions/node/v1')]);
});

test('assertDeps: the copy itself, a directory between, and a missing chain entry are each refused with the one message; a run with no deps and a run whose chain is untouched pass', () => {
  const MSG = 'gemini: a dependency directory of the copy was replaced during the run — the test command is not run';
  const clone = tree({ 'packages/a/node_modules/i.js': 'i' });
  const parts = ['packages', 'a', 'node_modules'];
  const chainOf = () => parts.map((_, i) => { const path = join(clone, ...parts.slice(0, i + 1)); const st = lstatSync(path); return { path, dev: st.dev, ino: st.ino }; });
  const run = { deps: [{ rel: 'packages/a/node_modules', copy: join(clone, 'packages/a/node_modules'), chain: chainOf() }] };
  assert.doesNotThrow(() => assertDeps({ deps: [] }));
  assert.doesNotThrow(() => assertDeps(run));
  // the copy itself replaced by another directory
  renameSync(join(clone, 'packages/a/node_modules'), join(clone, 'packages/a/nm.old'));
  mkdirSync(join(clone, 'packages/a/node_modules'));
  assert.throws(() => assertDeps(run), (e) => e.message === MSG);
  // a middle ancestor replaced
  rmSync(join(clone, 'packages/a/node_modules'), { recursive: true });
  renameSync(join(clone, 'packages/a/nm.old'), join(clone, 'packages/a/node_modules'));
  assert.doesNotThrow(() => assertDeps(run));
  renameSync(join(clone, 'packages/a'), join(clone, 'packages/a.old'));
  mkdirSync(join(clone, 'packages/a'));
  assert.throws(() => assertDeps(run), (e) => e.message === MSG);
  // an entry that is gone altogether
  rmSync(join(clone, 'packages/a'), { recursive: true });
  assert.throws(() => assertDeps(run), (e) => e.message === MSG);
  // the copy replaced by a link to the original
  renameSync(join(clone, 'packages/a.old'), join(clone, 'packages/a'));
  assert.doesNotThrow(() => assertDeps(run));
  const copy = join(clone, 'packages/a/node_modules');
  renameSync(copy, `${copy}.old`);
  symlinkSync(`${copy}.old`, copy);
  assert.throws(() => assertDeps(run), (e) => e.message === MSG);
});

test('programNeeds: the interpreter is looked for in the program\'s own directory first, then in the directory the name was found in, then in PATH', () => {
  const dir = tree({
    'own/tool': '#!/usr/bin/env interp\n', 'own/interp': '#!/bin/sh\n', 'later/interp': '#!/bin/sh\n',
    'early/interp': '#!/bin/sh\n', 'found/interp': '#!/bin/sh\n', 'found/lib/foo.sh': '#!/usr/bin/env interp\n', 'found/bin/foo': { link: '../lib/foo.sh' },
  });
  // a path under a deps entry (no `found` step): its own directory wins over PATH
  const own = programNeeds({ word: 'x/tool', program: join(dir, 'own/tool'), env: { PATH: join(dir, 'later') } });
  assert.deepEqual(own, { dirs: [], interpreter: join(dir, 'own/interp') });
  // a bare name found through a link: the directory it was found in wins over an earlier PATH entry
  fixtureWrite(join(dir, 'found/bin/interp'), '#!/bin/sh\n');
  const found = programNeeds({ word: 'foo', program: realpathSync(join(dir, 'found/bin/foo')), env: { PATH: `${join(dir, 'early')}:${join(dir, 'found/bin')}` } });
  assert.deepEqual(found, { dirs: [join(dir, 'found/bin')], interpreter: join(dir, 'found/bin/interp') });
});
function fixtureWrite(path, content) { writeFileSync(path, content); chmodSync(path, 0o755); }

test('toolchainReach: the adapter\'s own node under the home stays reachable beside a binary elsewhere, the home itself as a binary adds nothing, and a binary in no bin directory deep under the home gets its own directory, not its parent', () => {
  const home = tree({
    '.nvm/versions/node/v1/bin/node': 'n', '.nvm/versions/node/v1/lib/node_modules/npm/x': 'x',
    '.local/share/tool/script': 's', '.local/share/tool/lib/z': 'z', '.local/share/other/y': 'y',
  });
  const nvm = join(home, '.nvm/versions/node/v1');
  const base = nodeEnv({ home, prefix: nvm, binary: join(nvm, 'bin/node') });
  const same = { node: base.OMELETTE_REPRO_NODE, up: base.OMELETTE_REPRO_NODEUP };
  assert.notEqual(same.up, '^$');
  assert.deepEqual(toolchainReach({ home, binaries: [], base }), same);
  assert.deepEqual(toolchainReach({ home, binaries: [home], base }), same, 'the home itself as a binary opens nothing');
  const reach = toolchainReach({ home, binaries: [join(home, '.local/share/tool/script')], base });
  covers(reach.node, [join(nvm, 'bin/node'), join(nvm, 'lib/node_modules/npm/x'), join(home, '.local/share/tool/script'), join(home, '.local/share/tool/lib/z')],
    [join(home, '.local/share/other/y'), join(home, '.local/share'), home]);
  covers(reach.up, [join(nvm, 'lib'), join(nvm, 'lib/node_modules'), join(home, '.local/share'), home], [`/elsewhere${home}`, `/elsewhere${join(nvm, 'lib')}`, join(home, '.local/share/tool')]);
});

test('assertDeps: a recorded device number or inode that no longer matches, and an entry that is a file with matching numbers, are each a replaced directory', () => {
  const MSG = 'gemini: a dependency directory of the copy was replaced during the run — the test command is not run';
  const clone = tree({ 'a/node_modules/i.js': 'i', 'afile': 'f' });
  const stat = (p) => lstatSync(join(clone, p));
  const entry = (p, patch = {}) => ({ path: join(clone, p), dev: stat(p).dev, ino: stat(p).ino, ...patch });
  const runOf1 = (chain) => ({ deps: [{ rel: 'a/node_modules', copy: join(clone, 'a/node_modules'), chain }] });
  assert.doesNotThrow(() => assertDeps(runOf1([entry('a'), entry('a/node_modules')])));
  assert.throws(() => assertDeps(runOf1([entry('a'), entry('a/node_modules', { dev: stat('a').dev + 1 })])), (e) => e.message === MSG);
  assert.throws(() => assertDeps(runOf1([entry('a'), entry('a/node_modules', { ino: stat('a').ino + 1000 })])), (e) => e.message === MSG);
  assert.throws(() => assertDeps(runOf1([entry('afile')])), (e) => e.message === MSG, 'a regular file is not a directory, whatever its numbers');
});
