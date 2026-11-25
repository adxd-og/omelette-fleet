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
  /** Runs `args` (args[0] absolute) once; `env` is the server's env the spawn selects from. */
  const exec = async (o, env = process.env) => {
    opts = o;
    result = null;
    const rt = createUnitRuntime(unit, { env: { ...env, AGY_BIN: process.execPath, OMELETTE_HOME: fleet }, onResult: () => {} });
    const r = await rt.callTool('neontest_run', {});
    assert.equal(r.isError, undefined, r.text);
    return result;
  };
  return { home, fleet, work, run, reach, exec, done: () => discardRun(run) };
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
  const w = world({ files: { 'grow.mjs': 'import { truncateSync } from "node:fs";\nconsole.log("before");\ntruncateSync(`${process.env.TMPDIR}/round-1.log`, 2 ** 30);\n' } });
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
