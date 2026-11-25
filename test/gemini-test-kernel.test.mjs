// 1.13.0 T7 (plan docs/superpowers/plans/2026-11-24-1.13.0-neon-tester.md, T7; spec
// docs/superpowers/specs/2026-11-23-neon-tester-design.md, «The boundary», Profile B):
// gemini_test's test command run once under Mistral's repro profile (profile B) — no network, no
// home, the run's tmp as HOME, its own PATH, both streams to out/round-<n>.log, a 16 KB safe tail,
// a time limit, the group killed at the end. The kernel rows run a runtime over a minimal unit whose
// CLI is node (AGY_BIN=process.execPath, as the gemini unit's bin is): its tool calls runTestCommand.
// HOME is a temp dir under /private/tmp (outside every root the profile lets a command write) holding
// `.ssh/id`; OMELETTE_HOME is <HOME>/.omelette. TMPDIR is this file's own `neon-test-` base, so the
// runs root lives there; no fixture has an `omelette-*` name.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createUnitRuntime, defineUnit, locateBin } from '../core/unit.mjs';
import { makeCatalog } from '../core/catalog.mjs';
import { nodeEnv } from '../core/seatbelt.mjs';
import { checkDeps, copyDeps, discardRun, prepareTestRun, runTestCommand, safeOutput, testPath, testRunsRoot } from '../units/gemini/test-run.mjs';

const DARWIN = process.platform === 'darwin';
// sandbox-exec cannot nest: inside a sandbox even an allow-everything profile fails, and the kernel rows skip.
const KERNEL = DARWIN && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'neon-test-')));
const HOMES = DARWIN ? '/private/tmp' : BASE;
const made = [BASE];
const SAVED_TMPDIR = process.env.TMPDIR;
process.env.TMPDIR = BASE;
after(() => {
  if (SAVED_TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = SAVED_TMPDIR;
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...ID }, timeout: 5_000 }).toString();

// Each kernel row's budget: ten times its local time (a run made, one sandboxed node or npm: ≤ 1.5 s).
const KROW = { timeout: 15_000, skip: !KERNEL };
const NPM = KERNEL && locateBin('npm');

let n = 0;
/**
 * One row's world: HOME under HOMES with `.ssh/id`, the fleet home at <HOME>/.omelette, a work tree whose HEAD
 * holds `files` (and a `.gitignore` of `ignored`), a patch that changes its README, the run, and a runtime whose
 * one tool runs runTestCommand with the row's options. `deps` are copied into the clone before the run.
 */
function world({ files = {}, ignored = [], untracked = {}, deps = [] } = {}) {
  const home = realpathSync(mkdtempSync(join(HOMES, 'neon-test-home-')));
  made.push(home);
  const fleet = join(home, '.omelette');
  mkdirSync(fleet);
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'id'), 'ssh-secret-bytes\n');
  const work = join(BASE, `w${++n}`);
  mkdirSync(work);
  gitIn(work, 'init', '-q');
  const write = (tree) => {
    for (const [p, c] of Object.entries(tree)) {
      mkdirSync(dirname(join(work, p)), { recursive: true });
      writeFileSync(join(work, p), c);
    }
  };
  write({ 'README.md': 'one\n', ...(ignored.length ? { '.gitignore': ignored.map((d) => `/${d}/\n`).join('') } : {}), ...files });
  gitIn(work, 'add', '-A');
  gitIn(work, 'commit', '-qm', 'one');
  write(untracked);
  writeFileSync(join(work, 'README.md'), 'two\n');
  const patch = join(BASE, `p${n}.patch`);
  writeFileSync(patch, gitIn(work, 'diff', 'HEAD'));
  const run = prepareTestRun({ cwd: work, patch, home });
  if (deps.length) copyDeps(run, checkDeps({ top: run.top, deps, root: testRunsRoot() }));
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
        result = await runTestCommand(ctx, run, { round: 1, timeoutMs: 10_000, reach, home, fleet, ...opts });
        return 'ran';
      },
    }],
  });
  /** The tool called once with `o`: the runtime's answer (an error included) and runTestCommand's result. */
  const call = async (o, env = process.env) => {
    opts = o;
    result = null;
    const rt = createUnitRuntime(unit, { env: { ...env, AGY_BIN: process.execPath, OMELETTE_HOME: fleet }, onResult: () => {} });
    return { r: await rt.callTool('neontest_run', {}), result };
  };
  /** Runs `args` (args[0] absolute) once; `env` is the server's env the spawn selects from. */
  const exec = async (o, env = process.env) => {
    const { r, result: got } = await call(o, env);
    assert.equal(r.isError, undefined, r.text);
    return got;
  };
  return { home, fleet, work, run, reach, exec, call, done: () => discardRun(run) };
}

const node = () => realpathSync(process.execPath);

test('the test command has no network and no home: a connect to a 127.0.0.1 server fails, a write to $HOME and a read of $HOME/.ssh are refused, writes in the clone and its tmp succeed, $HOME is the run\'s tmp', KROW, async () => {
  const server = createServer((s) => s.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const probe = [
    'import { connect } from "node:net";',
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const [home, port] = process.argv.slice(2);',
    'const tryIt = (name, f) => { try { f(); console.log(`${name}:ok`); } catch (e) { console.log(`${name}:${e.code}`); } };',
    'tryIt("homewrite", () => writeFileSync(join(home, "planted"), "x"));',
    'tryIt("ssh", () => readFileSync(join(home, ".ssh", "id")));',
    'tryIt("clonewrite", () => writeFileSync("written-in-clone", "x"));',
    'tryIt("tmpwrite", () => writeFileSync(join(process.env.TMPDIR, "written-in-tmp"), "x"));',
    'console.log(`HOME=${process.env.HOME}`);',
    'const s = connect(Number(port), "127.0.0.1");',
    'const t = setTimeout(() => { console.log("net:timeout"); s.destroy(); }, 2000);',
    's.on("connect", () => { clearTimeout(t); console.log("net:ok"); s.destroy(); });',
    's.on("error", (e) => { clearTimeout(t); console.log(`net:${e.code}`); });',
  ].join('\n');
  const w = world({ files: { 'probe.mjs': probe } });
  try {
    const r = await w.exec({ args: [node(), 'probe.mjs', w.home, String(port)] });
    const out = readFileSync(r.log, 'utf8');
    assert.equal(r.code, 0, out);
    const lines = Object.fromEntries(out.trim().split('\n').map((l) => [l.split(/[:=]/)[0], l.slice(l.split(/[:=]/)[0].length + 1)]));
    assert.notEqual(lines.net, 'ok', 'no connection reaches 127.0.0.1');
    assert.equal(lines.homewrite, 'EPERM');
    assert.equal(lines.ssh, 'EPERM');
    assert.equal(lines.clonewrite, 'ok');
    assert.equal(lines.tmpwrite, 'ok');
    assert.equal(lines.HOME, w.run.tmp);
    assert.equal(existsSync(join(w.home, 'planted')), false);
    assert.equal(existsSync(join(w.run.clone, 'written-in-clone')), true);
    assert.equal(w.run.sandboxed, true);
  } finally {
    server.close();
    w.done();
  }
});

test('stdout and stderr land in out/round-1.log in order and the tail is the last 16 KB, stripped of ESC and bidi characters', KROW, async () => {
  const script = [
    'process.stdout.write("a\\n"); process.stderr.write("b\\n"); process.stdout.write("c\\n");',
    'for (let i = 0; i < 200; i++) process.stdout.write(`${String(i).padStart(3, "0")} ${"y".repeat(95)}\\n`);',
    'process.stderr.write("\\u001b[31mred\\u001b[0m \\u202eevil\\u202c \\u001b]0;title\\u0007end\\r\\nlast\\n");',
  ].join('\n');
  const w = world({ files: { 'out.mjs': script } });
  try {
    const r = await w.exec({ args: [node(), 'out.mjs'] });
    assert.equal(r.code, 0);
    assert.equal(r.log, join(w.run.out, 'round-1.log'));
    assert.equal(statSync(r.log).mode & 0o777, 0o600);
    const raw = readFileSync(r.log, 'utf8');
    assert.ok(raw.startsWith('a\nb\nc\n'), 'the two streams interleave in the order written');
    assert.ok(raw.length > 16384);
    assert.ok(Buffer.byteLength(r.tail) <= 16384);
    assert.ok(r.tail.endsWith('red evil end\nlast\n'), JSON.stringify(r.tail.slice(-60)));
    assert.equal(/[\u001b‮‬\r\u0007]/.test(r.tail), false);
    assert.equal(r.tail.includes('a\nb\nc\n'), false, 'the head is cut');
    assert.equal(typeof r.ms, 'number');
  } finally { w.done(); }
});

test('a run past its time limit is killed and says so', KROW, async () => {
  const w = world({ files: { 'sleep.mjs': 'setTimeout(() => {}, 30_000);\n' } });
  try {
    const t0 = Date.now();
    const r = await w.exec({ args: [node(), 'sleep.mjs'], timeoutMs: 500 });
    assert.equal(r.killed, true);
    assert.ok(Date.now() - t0 < 5_000);
    assert.ok(r.ms < 5_000);
  } finally { w.done(); }
});

test('the live log the command can reach in tmp, grown sparse to 1 GB, leaves out/ at most its last 1 MB', KROW, async () => {
  // The live log's name is random, but the command lists tmp/ and finds it: round-1-<12 hex>.log.
  const grow = [
    'import { readdirSync, truncateSync } from "node:fs";',
    'console.log("before");',
    'const live = readdirSync(process.env.TMPDIR).filter((n) => /^round-1-[0-9a-f]{12}\\.log$/.test(n));',
    'if (live.length !== 1) process.exit(3);',
    'truncateSync(`${process.env.TMPDIR}/${live[0]}`, 2 ** 30);',
  ].join('\n');
  const w = world({ files: { 'grow.mjs': grow } });
  try {
    const r = await w.exec({ args: [node(), 'grow.mjs'] });
    assert.equal(r.code, 0, r.tail);
    const kept = statSync(r.log).size;
    assert.ok(kept > 1024 * 1024 && kept < 1024 * 1024 + 200, String(kept));
    assert.match(readFileSync(r.log, 'utf8').split('\n')[0], /^\[omelette-fleet: the first \d+ bytes of this output cut; the last 1048576 kept\]$/);
  } finally { w.done(); }
});

test('a child the command backgrounded in its group is gone after the run', KROW, async () => {
  const script = [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });',
    'c.unref();',
    'writeFileSync("child.pid", String(c.pid));',
  ].join('\n');
  const w = world({ files: { 'bg.mjs': script } });
  try {
    const r = await w.exec({ args: [node(), 'bg.mjs'] });
    assert.equal(r.code, 0, readFileSync(r.log, 'utf8'));
    const pid = Number(readFileSync(join(w.run.clone, 'child.pid'), 'utf8'));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    // Polled in JS, at most 2 s: the group is killed as the command exits, the child reaped by launchd soon after.
    for (let i = 0; i < 20 && alive(); i++) await new Promise((res) => setTimeout(res, 100));
    const outlived = alive();
    if (outlived) process.kill(pid, 'SIGKILL');
    assert.equal(outlived, false, `the backgrounded child ${pid} outlived the run`);
  } finally { w.done(); }
});

test('a cache written into the copied node_modules lands in the copy, the work tree\'s is unchanged', KROW, async () => {
  const w = world({
    ignored: ['node_modules'],
    files: { 'cache.mjs': 'import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("node_modules/.cache", { recursive: true });\nwriteFileSync("node_modules/.cache/x", "cached");\n' },
    untracked: { 'node_modules/pkg/index.js': 'module.exports = 1;\n' },
    deps: ['node_modules'],
  });
  try {
    const r = await w.exec({ args: [node(), 'cache.mjs'] });
    assert.equal(r.code, 0, readFileSync(r.log, 'utf8'));
    assert.equal(readFileSync(join(w.run.clone, 'node_modules', '.cache', 'x'), 'utf8'), 'cached');
    assert.equal(existsSync(join(w.work, 'node_modules', '.cache')), false);
  } finally { w.done(); }
});

const NPM_PROJECT = {
  'package.json': '{"scripts":{"test":"node --test"}}\n',
  't.test.mjs': "import test from 'node:test';\ntest('ok', () => {});\n",
};

test('npm test runs', { ...KROW, skip: !KERNEL || !NPM }, async () => {
  const w = world({ files: NPM_PROJECT });
  try {
    const r = await w.exec({ args: [realpathSync(NPM), 'test'] });
    assert.equal(r.code, 0, r.tail);
    assert.match(r.tail, /# pass 1/);
  } finally { w.done(); }
});

test('a PATH entry that is a link under the home does not stop npm from finding sh', { ...KROW, skip: !KERNEL || !NPM }, async () => {
  const w = world({ files: NPM_PROJECT });
  mkdirSync(join(w.home, 'real-bin'));
  mkdirSync(join(w.home, 'links'));
  symlinkSync('../real-bin', join(w.home, 'links', 'bin'));
  const saved = process.env.PATH;
  const linked = `${join(w.home, 'links', 'bin')}:${saved}`;
  process.env.PATH = linked;
  try {
    const r = await w.exec({ args: [realpathSync(NPM), 'test'] }, { ...process.env, PATH: linked });
    assert.equal(r.code, 0, r.tail);
  } finally {
    process.env.PATH = saved;
    w.done();
  }
});

test('safeOutput: CR and CRLF become LF, ANSI CSI and OSC sequences and invisible characters go, LF and TAB stay', () => {
  assert.equal(safeOutput('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.equal(safeOutput('\u001b[1;31mred\u001b[0m'), 'red');
  assert.equal(safeOutput('\u001b]0;title\u0007x\u001b]8;;http://e\u001b\\y'), 'xy');
  assert.equal(safeOutput('\tl‮o​k\u0000\u0008\n'), '\tlok\n');
  assert.equal(safeOutput('\u009b31m⁦z'), '31mz');
});

test('testPath puts the program\'s directory first, drops entries under the home by spelling or by real path and entries that do not resolve, keeps the rest in order without duplicates, and ends with /usr/bin and /bin', () => {
  const root = realpathSync(mkdtempSync(join(BASE, 'path-')));
  const home = join(root, 'home');
  const homeLink = join(root, 'home-link');
  for (const d of ['home/bin', 'home/real', 'sys/a', 'sys/b', 'prog/bin']) mkdirSync(join(root, d), { recursive: true });
  symlinkSync(home, homeLink);
  symlinkSync(join(home, 'real'), join(root, 'sys', 'into-home'));
  const program = join(root, 'prog', 'bin', 'tool');
  const inherited = [
    join(root, 'sys', 'a'),
    join(home, 'bin'), // under the home by spelling
    join(root, 'sys', 'into-home'), // outside by spelling, under the home by real path
    'relative/bin',
    join(root, 'missing'),
    join(root, 'sys', 'b'),
    join(root, 'sys', 'a'),
    '',
    '/bin',
  ].join(':');
  assert.equal(testPath({ program, home, inherited }), [join(root, 'prog', 'bin'), join(root, 'sys', 'a'), join(root, 'sys', 'b'), '/bin', '/usr/bin'].join(':'));
  // The home given through a link: its resolved form counts as well.
  assert.equal(testPath({ program, home: homeLink, inherited: `${join(home, 'bin')}:${join(homeLink, 'bin')}:${join(root, 'sys', 'a')}` }), [join(root, 'prog', 'bin'), join(root, 'sys', 'a'), '/usr/bin', '/bin'].join(':'));
  // The program's own directory is kept even under the home, once.
  assert.equal(testPath({ program: join(home, 'bin', 'node'), home, inherited: join(home, 'bin') }), [join(home, 'bin'), '/usr/bin', '/bin'].join(':'));
});

// 1.13.0 T8: what the kernel re-allows under the home for a program that lives there (toolchainReach).
import { chmodSync as chmodT8 } from 'node:fs';
import { toolchainReach } from '../units/gemini/test-run.mjs';

test('a program under the home runs under profile B with its reach and fails closed without it', KROW, async () => {
  // Two runs: a run's reach is pinned at its first test run.
  const w = world();
  const bare = world();
  /** The tool under `home`: a script, not a copy of /bin/echo — on macOS 27 a copied platform binary is killed at exec
   * (137), sandbox or not. /bin/sh opens the script by its path under the home, which only the reach makes readable. */
  const toolIn = (home) => {
    const tool = join(home, '.local', 'share', 'tool', 'bin', 'tool');
    mkdirSync(dirname(tool), { recursive: true });
    writeFileSync(tool, '#!/bin/sh\necho "$@"\n');
    chmodT8(tool, 0o755);
    return tool;
  };
  const tool = toolIn(w.home);
  const bareTool = toolIn(bare.home);
  try {
    const reached = await w.exec({ args: [tool, 'reached'], reach: toolchainReach({ home: w.home, binaries: [tool] }) });
    assert.equal(reached.code, 0, reached.tail);
    assert.equal(reached.tail, 'reached\n');
    const closed = await bare.exec({ args: [bareTool, 'reached'] });
    assert.notEqual(closed.code, 0, 'with nodeEnv alone the program under the home is not readable');
    assert.equal(closed.tail.includes('reached'), false);
  } finally {
    w.done();
    bare.done();
  }
});

// The session's rulings on T8 (2026-11-25): the PATH gets the program's directories; the live log's name is not guessable.
import { programDirs, programNeeds, resolveProgram } from '../units/gemini/test-run.mjs';

test('a program whose interpreter lives in another directory under the home runs with programDirs and exits 127 without', KROW, async () => {
  // Two runs: a run's PATH directories are pinned at its first test run.
  const w = world();
  const bare = world();
  /** Under `home`: `bin/prog`, a link to `lib/prog/prog.sh`, whose `#!/usr/bin/env interp` names `bin/interp`. */
  const toolIn = (home) => {
    const v1 = join(home, '.tool', 'versions', 'v1');
    mkdirSync(join(v1, 'bin'), { recursive: true });
    mkdirSync(join(v1, 'lib', 'prog'), { recursive: true });
    writeFileSync(join(v1, 'bin', 'interp'), '#!/bin/sh\nexec /bin/sh "$1"\n');
    writeFileSync(join(v1, 'lib', 'prog', 'prog.sh'), '#!/usr/bin/env interp\necho ran\n');
    chmodT8(join(v1, 'bin', 'interp'), 0o755);
    chmodT8(join(v1, 'lib', 'prog', 'prog.sh'), 0o755);
    symlinkSync('../lib/prog/prog.sh', join(v1, 'bin', 'prog'));
    return v1;
  };
  /** `prog` resolved in `x`'s run, run once with its reach and the PATH directories `pick` takes from programNeeds. */
  const runProg = async (x, pick) => {
    const v1 = toolIn(x.home);
    const env = { PATH: join(v1, 'bin') };
    const program = resolveProgram({ word: 'prog', programs: ['prog'], deps: [], run: x.run, env });
    const needs = programNeeds({ word: 'prog', program, env });
    assert.deepEqual(programDirs({ word: 'prog', program, env }), [join(v1, 'bin')]);
    const reach = toolchainReach({ home: x.home, binaries: [program, needs.interpreter] });
    return x.exec({ args: [program], reach, pathDirs: pick(needs) });
  };
  try {
    const ran = await runProg(w, (needs) => needs.dirs);
    assert.equal(ran.code, 0, ran.tail);
    assert.equal(ran.tail, 'ran\n');
    const without = await runProg(bare, () => []);
    assert.equal(without.code, 127, without.tail);
  } finally {
    w.done();
    bare.done();
  }
});

test('a file the model planted at tmp/round-1.log does not stop the run', KROW, async () => {
  const w = world({ files: { 'ok.mjs': 'console.log("ran");\n' } });
  writeFileSync(join(w.run.tmp, 'round-1.log'), 'planted\n');
  try {
    const r = await w.exec({ args: [node(), 'ok.mjs'] });
    assert.equal(r.code, 0, r.tail);
    assert.equal(r.tail, 'ran\n');
    assert.equal(r.log, join(w.run.out, 'round-1.log'));
    assert.equal(readFileSync(join(w.run.tmp, 'round-1.log'), 'utf8'), 'planted\n');
  } finally { w.done(); }
});

// The fix round after T7–T8's tester (2026-11-25): runTestCommand's own refusals, each before anything is opened
// or spawned, and the live log removed from tmp/ after the copy.
import { lstatSync as lstatFix, readdirSync as readdirFix, renameSync as renameFix } from 'node:fs';

// Each pure row's budget: ten times its time under a full `npm test` (a run made, then refused: ≤ 310 ms).
const PURE_RUN = { timeout: 3_100 };
/** A ctx whose spawn only counts: a refusal before the spawn leaves `spawned` at 0. */
const countingCtx = () => ({ spawned: 0, async spawn() { this.spawned++; return { code: 0, signal: null, killed: false, cancelled: false }; } });
/** What tmp/ and out/ hold, to compare before and after a refusal. */
const listing = (run) => ({ tmp: readdirFix(run.tmp).sort(), out: readdirFix(run.out).sort() });

test('runTestCommand refuses a missing, zero, negative and NaN time limit before anything is opened', PURE_RUN, async () => {
  const w = world();
  try {
    const before = listing(w.run);
    for (const timeoutMs of [undefined, 0, -1, NaN]) {
      const ctx = countingCtx();
      await assert.rejects(runTestCommand(ctx, w.run, { args: [node()], round: 1, timeoutMs, reach: w.reach, home: w.home, fleet: w.fleet }),
        (e) => e.message === `gemini: runTestCommand needs a positive timeoutMs (got ${String(timeoutMs)})`, String(timeoutMs));
      assert.equal(ctx.spawned, 0);
    }
    assert.deepEqual(listing(w.run), before);
    assert.equal(w.run.sandboxed, undefined);
  } finally { w.done(); }
});

test('a round number runs once: the second call is refused before the command runs', KROW, async () => {
  const w = world({ files: { 'mark.mjs': 'import { appendFileSync } from "node:fs";\nappendFileSync("marks", "ran\\n");\n' } });
  try {
    const first = await w.exec({ args: [node(), 'mark.mjs'] });
    assert.equal(first.code, 0, first.tail);
    const { r } = await w.call({ args: [node(), 'mark.mjs'] });
    assert.equal(r.isError, true);
    assert.equal(r.text, 'Neon test error: gemini: round 1 already ran in this run');
    assert.equal(readFileSync(join(w.run.clone, 'marks'), 'utf8'), 'ran\n', 'the refused call did not run the command');
  } finally { w.done(); }
});

test('a round that is not a positive whole number is refused', PURE_RUN, async () => {
  const w = world();
  try {
    const before = listing(w.run);
    for (const round of [0, -1, 1.5, NaN, '1', undefined]) {
      const ctx = countingCtx();
      await assert.rejects(runTestCommand(ctx, w.run, { args: [node()], round, timeoutMs: 1_000, reach: w.reach, home: w.home, fleet: w.fleet }),
        (e) => e.message === `gemini: runTestCommand needs a positive whole round number (got ${typeof round === 'string' ? JSON.stringify(round) : String(round)})`, String(round));
      assert.equal(ctx.spawned, 0);
    }
    assert.deepEqual(listing(w.run), before);
  } finally { w.done(); }
});

test('runTestCommand refuses a run whose dependency chain was replaced, before the command runs', PURE_RUN, async () => {
  const w = world();
  try {
    const copy = join(w.run.clone, 'packages', 'a', 'node_modules');
    mkdirSync(copy, { recursive: true });
    const parts = ['packages', 'a', 'node_modules'];
    const chain = parts.map((_, i) => { const path = join(w.run.clone, ...parts.slice(0, i + 1)); const st = lstatFix(path); return { path, dev: st.dev, ino: st.ino }; });
    w.run.deps = [{ rel: 'packages/a/node_modules', copy, chain }];
    renameFix(join(w.run.clone, 'packages'), join(w.run.clone, 'packages.old'));
    mkdirSync(copy, { recursive: true });
    const before = listing(w.run);
    const ctx = countingCtx();
    await assert.rejects(runTestCommand(ctx, w.run, { args: [node()], round: 1, timeoutMs: 1_000, reach: w.reach, home: w.home, fleet: w.fleet }),
      (e) => e.message === 'gemini: a dependency directory of the copy was replaced during the run — the test command is not run');
    assert.equal(ctx.spawned, 0);
    assert.deepEqual(listing(w.run), before);
    assert.equal(w.run.sandboxed, undefined);
  } finally { w.done(); }
});

test('a home that cannot be resolved leaves no live log and the run not marked sandboxed', PURE_RUN, async () => {
  const w = world();
  try {
    const missing = join(BASE, `no-home-${++n}`);
    const ctx = countingCtx();
    await assert.rejects(runTestCommand(ctx, w.run, { args: [node()], round: 1, timeoutMs: 1_000, reach: w.reach, home: missing, fleet: w.fleet }), (e) => e.code === 'ENOENT');
    assert.equal(ctx.spawned, 0);
    assert.deepEqual(readdirFix(w.run.tmp), []);
    assert.equal(w.run.sandboxed, undefined);
  } finally { w.done(); }
});

test('the live log is gone from tmp after the run, also when the command replaced it with a directory or a link', { ...KROW, timeout: 4_500 }, async () => {
  // One command, pinned at round 1, that counts its rounds in the clone and finds its live log by listing tmp/: the
  // first leaves it, the second puts a directory in its place, the third a link to a directory outside the run that
  // holds a file.
  const live = [
    'import { existsSync, mkdirSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";',
    'const at = process.env.TMPDIR + "/" + readdirSync(process.env.TMPDIR).find((x) => /^round-\\d+-[0-9a-f]{12}\\.log$/.test(x));',
    'const k = existsSync("seen-2") ? 3 : existsSync("seen-1") ? 2 : 1;',
    'writeFileSync(`seen-${k}`, "");',
    'console.log(["plain", "todir", "tolink"][k - 1]);',
    'if (k === 2) { unlinkSync(at); mkdirSync(at); writeFileSync(at + "/inside", "x"); }',
    'if (k === 3) { unlinkSync(at); symlinkSync(process.argv[2], at); }',
  ].join('\n');
  const w = world({ files: { 'live.mjs': live } });
  const outside = realpathSync(mkdtempSync(join(BASE, 'outside-')));
  writeFileSync(join(outside, 'keep'), 'kept\n');
  try {
    for (const [round, said] of [[1, 'plain'], [2, 'todir'], [3, 'tolink']]) {
      const r = await w.exec({ args: [node(), 'live.mjs', outside], round });
      assert.equal(r.code, 0, r.tail);
      assert.equal(r.tail, `${said}\n`);
      assert.deepEqual(readdirFix(w.run.tmp).filter((x) => x.startsWith('round-')), [], `round ${round}`);
    }
    assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'kept\n', 'the link\'s target and what it holds are untouched');
    assert.deepEqual(readdirFix(outside), ['keep']);
  } finally { w.done(); }
});

test('runTestCommand refuses a time limit past what a timer can hold, and names a round given as a string', PURE_RUN, async () => {
  const w = world();
  try {
    const before = listing(w.run);
    const ctx = countingCtx();
    // Node clamps a setTimeout past 2^31 - 1 ms to 1 ms: the command would be killed at once.
    await assert.rejects(runTestCommand(ctx, w.run, { args: [node()], round: 1, timeoutMs: 2 ** 31, reach: w.reach, home: w.home, fleet: w.fleet }),
      (e) => e.message === 'gemini: runTestCommand needs a positive timeoutMs of at most 2147483647 (got 2147483648)');
    await assert.rejects(runTestCommand(ctx, w.run, { args: [node()], round: '4', timeoutMs: 1000, reach: w.reach, home: w.home, fleet: w.fleet }),
      (e) => e.message === 'gemini: runTestCommand needs a positive whole round number (got "4")');
    assert.equal(ctx.spawned, 0);
    assert.deepEqual(listing(w.run), before);
  } finally { w.done(); }
});

// The fix round after the security review (2026-11-25): the test command, its PATH directories and its reach are
// pinned at a run's first test run, and a program in the copy by its real path and its bytes.
import { regexLiteral as regexLiteralPin } from '../core/seatbelt.mjs';

const PINNED = 'gemini: the test command, its PATH directories and its reach are fixed at a run\'s first test run';

test('the test command is pinned at the first run: other args, another PATH directory or a wider reach is refused before anything is opened', PURE_RUN, async () => {
  const w = world();
  try {
    const ctx = countingCtx();
    const first = { args: [node(), 'a.mjs'], timeoutMs: 1_000, reach: w.reach, home: w.home, fleet: w.fleet, pathDirs: ['/usr/local/bin'] };
    await runTestCommand(ctx, w.run, { ...first, round: 1 });
    assert.equal(ctx.spawned, 1);
    const before = listing(w.run);
    const others = [
      { args: [node(), 'b.mjs'] },
      { pathDirs: ['/opt/bin'] },
      { reach: { ...w.reach, node: `^(${regexLiteralPin(w.home)})(/|$)` } },
      { reach: { ...w.reach, up: `^(${regexLiteralPin(w.home)})$` } },
    ];
    for (const [i, other] of others.entries()) {
      await assert.rejects(runTestCommand(ctx, w.run, { ...first, ...other, round: 2 + i }), (e) => e.message === PINNED, JSON.stringify(other));
    }
    assert.equal(ctx.spawned, 1);
    assert.deepEqual(listing(w.run), before);
  } finally { w.done(); }
});

test('a test that rewrites the test program in a dependency copy cannot run it again', KROW, async () => {
  // Round 1's command, through the copied script, appends a line to the script itself: profile B lets it write there.
  const w = world({
    ignored: ['tools'],
    untracked: { 'tools/bin/tool.sh': '#!/bin/sh\necho ran >> marks\necho "# rewritten" >> "$0"\n' },
    deps: ['tools'],
  });
  const tool = join(w.run.clone, 'tools', 'bin', 'tool.sh');
  chmodT8(tool, 0o755);
  try {
    const first = await w.exec({ args: [tool] });
    assert.equal(first.code, 0, first.tail);
    assert.match(readFileSync(tool, 'utf8'), /# rewritten\n$/);
    const { r } = await w.call({ args: [tool], round: 2 });
    assert.equal(r.isError, true);
    assert.equal(r.text, 'Neon test error: gemini: the test program in the copy changed since the run\'s first test run — the test command is not run');
    assert.equal(readFileSync(join(w.run.clone, 'marks'), 'utf8'), 'ran\n', 'no second run');
  } finally { w.done(); }
});

test('a program outside the copy is pinned by its arguments only', KROW, async () => {
  const w = world({ files: { 'mark.mjs': 'import { appendFileSync } from "node:fs";\nappendFileSync("marks", "ran\\n");\n' } });
  try {
    for (const round of [1, 2]) {
      const r = await w.exec({ args: [node(), 'mark.mjs'], round });
      assert.equal(r.code, 0, r.tail);
    }
    assert.equal(readFileSync(join(w.run.clone, 'marks'), 'utf8'), 'ran\nran\n');
  } finally { w.done(); }
});

// 1.13.0 T9 (plan, «T9 — profile A, rendered per run»; spec «The boundary», Profile A): agy's own cage. The kernel
// rows run a probe node script directly under `sandbox-exec -f <out/a.sb>` — never agy — with cwd the clone, HOME the
// scratch home and TMPDIR the run's tmp; the node binary is the profile's agyExe unless a row says otherwise. The
// profile's `home` is the row's HOME under /private/tmp, the stand-in for the operator's home.
import { spawn as spawnT9 } from 'node:child_process';
import { linkSync as linkT9 } from 'node:fs';
import { renderProfileA, sbString, writeProfileA } from '../units/gemini/test-run.mjs';

/** The probe: argv[2] is a JSON list of ops, run in order; one JSON array of results ('ok', 'exit <n>' or an error code). */
const PROBE_A = [
  'import { appendFileSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";',
  'import { spawn, spawnSync } from "node:child_process";',
  'import { connect } from "node:net";',
  'const code = (e) => e.code || String(e.message);',
  'const sync = { read: (p) => readFileSync(p), write: (p) => writeFileSync(p, "x"), append: (p) => appendFileSync(p, "x"), stat: (p) => lstatSync(p), list: (p) => readdirSync(p), mkdir: (p) => mkdirSync(p), rename: (a, b) => renameSync(a, b), link: (a, b) => linkSync(a, b) };',
  'const results = [];',
  'for (const [op, ...a] of JSON.parse(process.argv[2])) {',
  '  if (sync[op]) { try { sync[op](...a); results.push("ok"); } catch (e) { results.push(code(e)); } continue; }',
  '  if (op === "exec") { const r = spawnSync(a[0], a.slice(1), { timeout: 5000, stdio: "ignore" }); results.push(r.error ? code(r.error) : `exit ${r.status}`); continue; }',
  // A program that must not run: killed the moment it starts, stdin still open (pbcopy writes the clipboard only at EOF).
  '  if (op === "spawnkill") { results.push(await new Promise((res) => { let c; try { c = spawn(a[0], [], { stdio: ["pipe", "ignore", "ignore"] }); } catch (e) { res(code(e)); return; } c.on("error", (e) => res(code(e))); c.on("spawn", () => { c.kill("SIGKILL"); res("ok"); }); })); continue; }',
  '  if (op === "connect") { results.push(await new Promise((res) => { const s = connect(Number(a[0]), "127.0.0.1"); const t = setTimeout(() => { s.destroy(); res("timeout"); }, 2000); s.on("connect", () => { clearTimeout(t); s.destroy(); res("ok"); }); s.on("error", (e) => { clearTimeout(t); res(code(e)); }); })); continue; }',
  '  results.push("unknown op");',
  '}',
  'console.log(JSON.stringify(results));',
].join('\n');

/**
 * `argv` under the run's profile A (written once per run by writeProfileA, with `exe` as agy's binary — node by
 * default), cwd the clone, HOME the scratch home: its own process group, killed whole after 5 s and again at exit.
 */
async function underA(w, argv, { exe = node() } = {}) {
  if (!w.profileA) {
    mkdirSync(join(w.home, 'Library', 'Keychains'), { recursive: true });
    writeFileSync(join(w.home, 'Library', 'Keychains', 'k'), 'keychain-bytes\n');
    w.profileA = writeProfileA(w.run, exe, { home: w.home, fleet: w.fleet }).profile;
  }
  const child = spawnT9('/usr/bin/sandbox-exec', ['-f', w.profileA, ...argv], {
    cwd: w.run.clone, env: { HOME: w.run.home, TMPDIR: w.run.tmp, PATH: '/usr/bin:/bin' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
  const timer = setTimeout(killGroup, 5_000);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const [code] = await once(child, 'close');
  clearTimeout(timer);
  killGroup();
  return { code, stdout, stderr };
}

/** The probe run under profile A with `ops`: its results, in order. */
async function probeA(w, ops, o) {
  const r = await underA(w, [node(), 'probe.mjs', JSON.stringify(ops)], o);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const probeWorld = (o = {}) => world({ ...o, files: { 'probe.mjs': PROBE_A, ...(o.files || {}) } });

test('sbString escapes a quote and a backslash, and refuses a newline', () => {
  assert.equal(sbString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
  assert.throws(() => sbString('/a\nb'), /control character/);
});

test('renderProfileA lists every dep copy after the clone\'s allow and every ancestor in the unlink deny', () => {
  const p = {
    clone: '/r/run-1/clone', tmp: '/r/run-1/tmp', shome: '/r/run-1/home', home: '/h', agyExe: '/opt/agy/bin/agy', src: '/w',
    fleet: '/h/.omelette', runs: '/r', run: '/r/run-1', tmproot: '/t', deps: ['/r/run-1/clone/packages/a/node_modules', '/r/run-1/clone/node_modules'],
  };
  const lines = renderProfileA(p).split('\n');
  const reAllow = lines.indexOf('(allow file-write* (subpath "/r/run-1/clone") (subpath "/r/run-1/tmp") (subpath "/r/run-1/home"))');
  const dep1 = lines.indexOf('(deny file-write* (subpath "/r/run-1/clone/packages/a/node_modules"))');
  const dep2 = lines.indexOf('(deny file-write* (subpath "/r/run-1/clone/node_modules"))');
  assert.ok(reAllow > 0 && dep1 > reAllow && dep2 > dep1, `${reAllow} ${dep1} ${dep2}`);
  assert.ok(lines.includes('(deny file-write-unlink (literal "/r/run-1/clone") (literal "/r/run-1/tmp") (literal "/r/run-1/home") (literal "/r/run-1/clone/packages") (literal "/r/run-1/clone/packages/a"))'));
  assert.throws(() => renderProfileA({ ...p, deps: ['/r/run-1/elsewhere'] }), /not under the clone/);
});

test('profile A parses', KROW, async () => {
  const w = probeWorld();
  try {
    const r = await underA(w, ['/usr/bin/true']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(w.profileA, join(w.run.out, 'a.sb'));
    assert.equal(statSync(w.profileA).mode & 0o777, 0o600);
    assert.equal(w.run.sandboxed, true);
    assert.equal(writeProfileA(w.run, node(), { home: w.home, fleet: w.fleet }), w.run.profileA, 'once per run');
  } finally { w.done(); }
});

test('writes land only in the copy, its tmp and the scratch home', KROW, async () => {
  const w = probeWorld();
  const sib = world();
  // Another unit's temp dir: an omelette-* dir under the OS temp root (this file's TMPDIR is BASE), outside the runs root.
  const other = join(BASE, 'omelette-other');
  mkdirSync(other, { recursive: true });
  const refused = [join(w.home, 'x'), join(w.work, 'planted'), join(w.fleet, 'planted'), join(sib.run.clone, 'planted'), join(w.run.out, 'planted'), join(BASE, 'planted'), join(other, 'planted')];
  const allowed = [join(w.run.clone, 'written'), join(w.run.tmp, 'written'), join(w.run.home, 'written')];
  try {
    const got = await probeA(w, [...refused, ...allowed].map((p) => ['write', p]));
    assert.deepEqual(got, [...refused.map(() => 'EPERM'), ...allowed.map(() => 'ok')]);
    for (const p of refused) assert.equal(existsSync(p), false, p);
    for (const p of allowed) assert.equal(existsSync(p), true, p);
  } finally {
    w.done();
    sib.done();
  }
});

test('reads of the home are refused but the Keychains link and agy\'s binary', KROW, async () => {
  const w = probeWorld();
  // agy's binary under the home, as a file the probe reads (node runs from outside the row's HOME).
  const bin = join(w.home, '.local', 'agy', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'agy'), 'agy-binary\n');
  writeFileSync(join(bin, 'other'), 'beside it\n');
  try {
    const got = await probeA(w, [
      ['read', join(w.home, '.ssh', 'id')],
      ['read', join(w.run.home, 'Library', 'Keychains', 'k')],
      ['read', join(bin, 'agy')],
      ['read', join(bin, 'other')],
      ['stat', bin],
      ['list', w.home],
      ['list', bin],
      ['write', join(w.run.home, 'Library', 'Keychains', 'new')],
    ], { exe: join(bin, 'agy') });
    assert.deepEqual(got, ['EPERM', 'ok', 'ok', 'EPERM', 'ok', 'EPERM', 'EPERM', 'EPERM']);
  } finally { w.done(); }
});

test('the work tree and a sibling run are unreadable, the sibling run not even stat-able', KROW, async () => {
  const w = probeWorld();
  const sib = world();
  const other = join(BASE, 'omelette-other');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'f'), 'another unit\'s\n');
  try {
    const got = await probeA(w, [
      ['read', join(other, 'f')],
      ['read', join(w.work, 'README.md')],
      ['stat', w.work],
      ['stat', sib.run.runDir],
      ['read', join(sib.run.clone, 'README.md')],
      ['list', dirname(w.run.runDir)],
      ['stat', w.run.runDir],
      ['read', join(w.run.clone, 'README.md')],
    ]);
    assert.deepEqual(got, ['EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'ok', 'ok']);
  } finally {
    w.done();
    sib.done();
  }
});

test('a copied dep is readable and not writable, and an ancestor of it cannot be renamed', KROW, async () => {
  const w = probeWorld({
    ignored: ['packages/a/node_modules'],
    files: { 'packages/a/index.mjs': 'export default 1;\n' },
    untracked: { 'packages/a/node_modules/pkg/index.js': 'module.exports = 1;\n' },
    deps: ['packages/a/node_modules'],
  });
  const c = w.run.clone;
  try {
    const got = await probeA(w, [
      ['read', join(c, 'packages', 'a', 'node_modules', 'pkg', 'index.js')],
      ['write', join(c, 'packages', 'a', 'node_modules', 'pkg', 'index.js')],
      ['write', join(c, 'packages', 'a', 'node_modules', 'new.js')],
      ['rename', join(c, 'packages', 'a'), join(c, 'packages', 'b')],
      ['rename', join(c, 'packages'), join(c, 'pk')],
      ['write', join(c, 'packages', 'a', 'beside.mjs')],
    ]);
    assert.deepEqual(got, ['ok', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'ok']);
    assert.equal(readFileSync(join(c, 'packages', 'a', 'node_modules', 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  } finally { w.done(); }
});

test('the network is open', KROW, async () => {
  const server = createServer((s) => s.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const w = probeWorld();
  try {
    assert.deepEqual(await probeA(w, [['connect', String(server.address().port)]]), ['ok']);
  } finally {
    server.close();
    w.done();
  }
});

test('/usr/bin/security runs (help exits) while osascript, open and pbcopy are refused', KROW, async () => {
  const w = probeWorld();
  try {
    const got = await probeA(w, [['exec', '/usr/bin/security', 'help'], ['spawnkill', '/usr/bin/osascript'], ['spawnkill', '/usr/bin/open'], ['spawnkill', '/usr/bin/pbcopy']]);
    assert.deepEqual(got, ['exit 0', 'EPERM', 'EPERM', 'EPERM']);
  } finally { w.done(); }
});

test('a hard link from the copy to a file in the home lets no write through', KROW, async () => {
  const w = probeWorld();
  try {
    const got = await probeA(w, [
      ['link', join(w.run.home, 'Library', 'Keychains', 'k'), join(w.run.clone, 'hl-k')],
      ['append', join(w.run.clone, 'hl-k')],
      ['link', join(w.home, '.ssh', 'id'), join(w.run.clone, 'hl-id')],
      ['append', join(w.run.clone, 'hl-id')],
    ]);
    assert.equal(got[0], 'EPERM');
    assert.equal(got[2], 'EPERM');
    assert.equal(readFileSync(join(w.home, 'Library', 'Keychains', 'k'), 'utf8'), 'keychain-bytes\n');
    assert.equal(readFileSync(join(w.home, '.ssh', 'id'), 'utf8'), 'ssh-secret-bytes\n');
    assert.equal(statSync(join(w.home, 'Library', 'Keychains', 'k')).nlink, 1);
    assert.equal(statSync(join(w.home, '.ssh', 'id')).nlink, 1);
  } finally { w.done(); }
});

test('the copy\'s .gemini, .agents and .antigravity cannot be created or written, and a committed file under one is still read', KROW, async () => {
  const w = probeWorld({ files: { '.gemini/committed.md': 'committed\n' } });
  const c = w.run.clone;
  try {
    const got = await probeA(w, [
      ['read', join(c, '.gemini', 'committed.md')],
      ['write', join(c, '.gemini', 'committed.md')],
      ['write', join(c, '.gemini', 'settings.json')],
      ['rename', join(c, '.gemini'), join(c, 'g2')],
      ['mkdir', join(c, '.agents')],
      ['mkdir', join(c, '.antigravity')],
    ]);
    assert.deepEqual(got, ['ok', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM']);
    assert.equal(readFileSync(join(c, '.gemini', 'committed.md'), 'utf8'), 'committed\n');
  } finally { w.done(); }
});

test('the OS temp root and /private/tmp are unreadable under profile A, the run\'s own directories still readable', KROW, async () => {
  const w = probeWorld();
  const elsewhere = join(BASE, 'another-programs-temp');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'f'), 'not agy\'s\n');
  const scratch = realpathSync(mkdtempSync(join(HOMES, 'neon-test-scratch-')));
  made.push(scratch);
  writeFileSync(join(scratch, 'f'), 'not agy\'s\n');
  try {
    const got = await probeA(w, [
      ['read', join(elsewhere, 'f')], ['list', elsewhere], ['read', join(scratch, 'f')], ['list', scratch],
      ['read', join(w.run.clone, 'README.md')], ['write', join(w.run.tmp, 'ok')], ['read', join(w.run.tmp, 'ok')],
    ]);
    assert.deepEqual(got, ['EPERM', 'EPERM', 'EPERM', 'EPERM', 'ok', 'ok', 'ok']);
  } finally { w.done(); }
});

// The fix round after T9–T10's tester (2026-11-25): the pin by the resolved path and recorded only past every refusal,
// profile A's temp denies, writeProfileA once per run with its resolved binary, and the run's changed names.
import { unlinkSync as unlinkFix } from 'node:fs';
import { testChangedPaths } from '../units/gemini/test-run.mjs';

const CHANGED_PROGRAM = 'gemini: the test program in the copy changed since the run\'s first test run — the test command is not run';

test('the pin hashes a program in the copy reached by another spelling', PURE_RUN, async () => {
  const w = world({ files: { 'tool.sh': '#!/bin/sh\necho hi\n' } });
  const alias = join(BASE, `alias-${++n}`);
  symlinkSync(w.run.runDir, alias);
  try {
    const ctx = countingCtx();
    const o = { args: [join(alias, 'clone', 'tool.sh')], timeoutMs: 1_000, reach: w.reach, home: w.home, fleet: w.fleet };
    await runTestCommand(ctx, w.run, { ...o, round: 1 });
    assert.equal(w.run.pin.program.real, join(w.run.clone, 'tool.sh'));
    writeFileSync(join(w.run.clone, 'tool.sh'), '#!/bin/sh\necho rewritten\n');
    await assert.rejects(runTestCommand(ctx, w.run, { ...o, round: 2 }), (e) => e.message === CHANGED_PROGRAM);
    assert.equal(ctx.spawned, 1);
  } finally { w.done(); }
});

test('a first call refused for another reason records no pin', PURE_RUN, async () => {
  const w = world();
  try {
    const ctx = countingCtx();
    const o = { timeoutMs: 1_000, reach: w.reach, fleet: w.fleet, round: 1 };
    await assert.rejects(runTestCommand(ctx, w.run, { ...o, args: [node(), 'a.mjs'], home: join(BASE, `no-home-${++n}`) }), (e) => e.code === 'ENOENT');
    assert.equal(w.run.pin, undefined);
    await runTestCommand(ctx, w.run, { ...o, args: [node(), 'b.mjs'], home: w.home });
    assert.equal(ctx.spawned, 1);
    assert.deepEqual(w.run.pin.args, [node(), 'b.mjs']);
  } finally { w.done(); }
});

test('a first call that cannot open its live log records no pin', PURE_RUN, async () => {
  const w = world();
  try {
    const ctx = countingCtx();
    const o = { timeoutMs: 1_000, reach: w.reach, home: w.home, fleet: w.fleet };
    chmodT8(w.run.tmp, 0o500);
    try {
      await assert.rejects(runTestCommand(ctx, w.run, { ...o, round: 1, args: [node(), 'a.mjs'] }), (e) => e.code === 'EACCES');
    } finally { chmodT8(w.run.tmp, 0o700); }
    assert.equal(w.run.pin, undefined);
    assert.equal(ctx.spawned, 0);
    await runTestCommand(ctx, w.run, { ...o, round: 1, args: [node(), 'b.mjs'] });
    assert.equal(ctx.spawned, 1);
    assert.deepEqual(w.run.pin.args, [node(), 'b.mjs']);
  } finally { w.done(); }
});

test('profile A denies the per-user temp parent for a macOS-shaped temp root and the temp root itself otherwise, with /private/tmp and /private/var/tmp', () => {
  const p = {
    clone: '/r/run-1/clone', tmp: '/r/run-1/tmp', shome: '/r/run-1/home', home: '/h', agyExe: '/opt/agy/bin/agy', src: '/w',
    fleet: '/h/.omelette', runs: '/r', run: '/r/run-1', tmproot: '/t', deps: [],
  };
  const at = (tmproot) => renderProfileA({ ...p, tmproot }).split('\n');
  const mac = at('/private/var/folders/ab/cd0/T');
  assert.ok(mac.includes('(deny file-read* (subpath "/private/var/folders/ab/cd0") (subpath "/private/tmp") (subpath "/private/var/tmp"))'), mac.join('\n'));
  assert.ok(mac.includes('(allow file-read-metadata (literal "/private/var/folders/ab/cd0") (literal "/private/var/folders/ab/cd0/T") (literal "/r") (literal "/r/run-1"))'));
  assert.ok(mac.includes('(deny file-read* (regex "^/private/var/folders/ab/cd0/T/omelette-"))'), 'the omelette-* deny stays on the temp root');
  for (const tmproot of ['/t', '/private/var/folders/ab/T', '/private/var/folders/ab/cd0/T/x', '/var/folders/ab/cd0/T']) {
    const lines = at(tmproot);
    assert.ok(lines.includes(`(deny file-read* (subpath "${tmproot}") (subpath "/private/tmp") (subpath "/private/var/tmp"))`), tmproot);
    assert.ok(lines.includes(`(allow file-read-metadata (literal "${tmproot}") (literal "/r") (literal "/r/run-1"))`), tmproot);
  }
});

test('/private/var/tmp is unreadable under profile A', { ...KROW, skip: !KERNEL }, async () => {
  const w = probeWorld();
  const vtmp = realpathSync(mkdtempSync(join('/private/var/tmp', 'neon-test-')));
  made.push(vtmp);
  writeFileSync(join(vtmp, 'f'), 'not agy\'s\n');
  try {
    assert.deepEqual(await probeA(w, [['read', join(vtmp, 'f')], ['list', vtmp]]), ['EPERM', 'EPERM']);
  } finally { w.done(); }
});

test('writeProfileA returns the resolved binary and is the same object on a second call; a binary that resolves elsewhere is refused', PURE_RUN, () => {
  const w = world();
  const link = join(BASE, `agy-link-${++n}`);
  symlinkSync(node(), link);
  try {
    const first = writeProfileA(w.run, link, { home: w.home, fleet: w.fleet });
    assert.deepEqual(first, { profile: join(w.run.out, 'a.sb'), exe: node() });
    assert.equal(w.run.profileA, first);
    assert.equal(w.run.sandboxed, true);
    assert.equal(writeProfileA(w.run, link, { home: w.home, fleet: w.fleet }), first);
    assert.equal(writeProfileA(w.run, node(), { home: w.home, fleet: w.fleet }), first, 'the binary itself resolves to the same path');
    const elsewhere = realpathSync('/usr/bin/true');
    unlinkFix(link);
    symlinkSync(elsewhere, link);
    assert.throws(() => writeProfileA(w.run, link, { home: w.home, fleet: w.fleet }),
      (e) => e.message === `gemini: agy's binary changed during the run (${JSON.stringify(node())} → ${JSON.stringify(elsewhere)}) — the profile allows the first only`);
    assert.equal(w.run.profileA, first);
  } finally { w.done(); }
});

test('testChangedPaths leaves a copied dependency out', { ...PURE_RUN, skip: !DARWIN }, () => {
  const w = world({ ignored: ['node_modules'], untracked: { 'node_modules/p/index.js': 'dep\n' }, deps: ['node_modules'] });
  try {
    assert.ok(existsSync(join(w.run.clone, 'node_modules', 'p', 'index.js')), 'the dep was copied');
    // The model's .gitignore no longer covers the copy: the exclude alone keeps it out.
    writeFileSync(join(w.run.clone, '.gitignore'), '');
    mkdirSync(join(w.run.clone, 'test'));
    writeFileSync(join(w.run.clone, 'test', 'a.test.mjs'), 'ok\n');
    assert.deepEqual(testChangedPaths(w.run).sort(), ['.gitignore', 'test/a.test.mjs']);
  } finally { w.done(); }
});
