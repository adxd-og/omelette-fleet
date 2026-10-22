// scripts/mutants.mjs, fix round 1 — what the runner promises about the world around
// it: where a scratch may be, what a child inherits, which reporter a child loads, what
// a signal leaves behind, which files are never measured, what --stragglers finds. Every fixture repository is
// built under a fresh tmp directory; neither this checkout nor the real catalogue is
// touched. (Named mutants*.test.mjs: the runner never measures its own tests.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main, prepareScratch } from '../scripts/mutants.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'mutants.mjs');
const ENTRIES = ['lib', 'test'];
const LIB = "import { spawn } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\nexport function hang() {\n  return 1;\n}\n";
// Started by the hanging mutant: it starts itself again in a process group of its own and exits, so
// the copy is nobody's descendant — init's child, its command line holding its scratch path (work/):
// only the scratch sweep reaches it. Once reparented, the copy adds `<pid> orphan` to MUT_PIDFILE.
const ORPHAN = [
  "import { spawn } from 'node:child_process';",
  "import { appendFileSync } from 'node:fs';",
  "import { fileURLToPath } from 'node:url';",
  "if (process.argv[2] !== 'copy') {",
  "  spawn(process.execPath, [fileURLToPath(import.meta.url), 'copy', String(process.pid)], { detached: true, stdio: 'ignore' }).unref();",
  '} else {',
  '  const watch = setInterval(() => {',
  '    if (process.ppid === Number(process.argv[3])) return;',
  '    clearInterval(watch);',
  '    appendFileSync(process.env.MUT_PIDFILE, `${process.pid} orphan\\n`);',
  '  }, 20);',
  '  setInterval(() => {}, 1000);',
  '}',
  '',
].join('\n');
// Records what the process around it looks like, leaves a marker in HOME, and (when asked) a pid trail
// and a straggler in its process group whose command line holds MUT_MARK.
const PROBE = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { execFileSync, spawn } from 'node:child_process';",
  "import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "import { hang } from '../lib/core.mjs';",
  'const e = process.env;',
  'if (e.MUT_ENVFILE) {',
  '  appendFileSync(e.MUT_ENVFILE, JSON.stringify({',
  '    home: e.HOME, omelette: e.OMELETTE_HOME, gitDir: e.GIT_DIR, gitWorkTree: e.GIT_WORK_TREE, gitIndex: e.GIT_INDEX_FILE,',
  '    allow: e.OMELETTE_ALLOW_WRITE, mutate: e.ORION_ALLOW_GEMINI_MUTATE, passthrough: e.OMELETTE_ENV_PASSTHROUGH, hasPath: !!e.PATH,',
  "    homeListing: readdirSync(e.HOME), parent: execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim(),",
  "  }) + '\\n');",
  "  writeFileSync(join(e.HOME, 'left-by-a-test'), 'x');",
  '}',
  'if (e.MUT_PIDFILE) {',
  '  appendFileSync(e.MUT_PIDFILE, `${process.pid}\\n`);',
  "  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', e.MUT_MARK || ''], { stdio: 'ignore' });",
  '  c.unref();',
  '  appendFileSync(e.MUT_PIDFILE, `${c.pid}\\n`);',
  '}',
  "test('probe', () => { assert.equal(hang(), 1); });",
  '',
].join('\n');
const MUTANT = { id: 'm-ret', file: 'lib/core.mjs', find: 'return 1;', replace: 'return 2;', breaks: 'x' };
// The hanging mutant first leaves a grandchild in a process group of its own, whose command line
// holds MUT_MARK and no scratch path: only a walk of the process tree reaches it. Once running it
// adds `<pid> detached` to MUT_PIDFILE. Then it starts ORPHAN, and spins.
const DETACHED = "spawn(process.execPath, ['-e', \"require('node:fs').appendFileSync(process.env.MUT_PIDFILE, process.pid + ' detached' + require('node:os').EOL); setInterval(() => {}, 1000);\", process.env.MUT_MARK], { detached: true, stdio: 'ignore' }).unref();";
const ORPHANING = "spawn(process.execPath, [fileURLToPath(new URL('../test/orphan.mjs', import.meta.url))], { detached: true, stdio: 'ignore' }).unref();";
const HANG = { id: 'm-hang', file: 'lib/core.mjs', find: 'return 1;', replace: `${DETACHED} ${ORPHANING} for (;;);`, breaks: 'x' };

const sandbox = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-mutants-isolation-test-'));
  const cleanups = [];
  t.after(() => {
    for (const fn of cleanups.reverse()) { try { fn(); } catch { /* the next one still runs */ } }
    rmSync(dir, { recursive: true, force: true });
  });
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'lib', 'core.mjs'), LIB);
  writeFileSync(join(root, 'test', 'a.test.mjs'), PROBE);
  writeFileSync(join(root, 'test', 'orphan.mjs'), ORPHAN);
  return { dir, root, real: realpathSync(dir), onCleanup: (fn) => cleanups.push(fn) };
};
// Every live process whose command line holds the sandbox (as named or as its real path) — every
// scratch of these tests lives in it. A `ps` read of the test's own, not the runner's.
const survivors = (sb) => execFileSync('ps', ['-A', '-ww', '-o', 'pid=,stat=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').map((l) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean)
  .filter(([, pid, stat, command]) => Number(pid) !== process.pid && !stat.startsWith('Z') && (command.includes(sb.dir) || command.includes(sb.real)))
  .map(([, pid, , command]) => `${pid} ${command}`);
// The scan once nothing is left, or the last one after 5 s: a bound for a failed test, never a wait a pass needs.
const settle = async (sb) => {
  for (const deadline = Date.now() + 5000; ;) {
    const left = survivors(sb);
    if (!left.length || Date.now() >= deadline) return left;
    await new Promise((r) => setTimeout(r, 50));
  }
};
const killSurvivors = (sb) => { for (const line of survivors(sb)) { try { process.kill(Number(line.split(' ')[0]), 'SIGKILL'); } catch { /* gone */ } } };
const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) };
};
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'NODE_TEST_CONTEXT'));

test('a suite child gets HOME and OMELETTE_HOME on <scratch>/home, emptied before every run, no GIT_* and no write gate, loads the reporter copy from the scratch, and has the cap as its --test-timeout', async (t) => {
  const sb = sandbox(t);
  const scratch = join(sb.dir, 'scratch');
  const envfile = join(sb.dir, 'env.ndjson');
  const cataloguePath = join(sb.dir, 'catalogue.json');
  writeFileSync(cataloguePath, JSON.stringify([MUTANT]));
  const io = capture();
  const code = await withEnv({
    MUT_ENVFILE: envfile, GIT_DIR: '/nonexistent/.git', GIT_WORK_TREE: '/nonexistent', GIT_INDEX_FILE: '/nonexistent/index',
    OMELETTE_ALLOW_WRITE: 'gemini,grok,codex', ORION_ALLOW_GEMINI_MUTATE: '1', OMELETTE_ENV_PASSTHROUGH: 'SOMETHING',
  }, () => main(['--scratch', scratch, '--out', join(sb.dir, 'report.json')], { root: sb.root, cataloguePath, entries: ENTRIES, out: io.out, err: io.err }));
  assert.equal(code, 0, io.lines.err.join('\n'));
  assert.equal(process.env.MUT_ENVFILE, undefined, 'the runner does not touch its own environment');
  const records = readFileSync(envfile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(records.length, 2, 'the baseline and the one mutant each ran the probe');
  const reporterUrl = pathToFileURL(join(scratch, 'reporter.mjs')).href;
  for (const r of records) {
    assert.equal(r.home, join(scratch, 'home'));
    assert.equal(r.omelette, join(scratch, 'home'));
    for (const k of ['gitDir', 'gitWorkTree', 'gitIndex', 'allow', 'mutate', 'passthrough']) assert.equal(r[k], undefined, k);
    assert.equal(r.hasPath, true);
    assert.deepEqual(r.homeListing, [], 'HOME starts empty, whatever the run before left in it');
    assert.ok(r.parent.includes(`--test-reporter=${reporterUrl}`), `the reporter is the scratch copy, saw: ${r.parent.slice(0, 300)}`);
    assert.ok(!r.parent.includes(pathToFileURL(SCRIPT).href), 'not the live scripts/mutants.mjs');
  }
  // node's own per-file cap is the runner's, so a suite whose runner died still ends a hung file.
  const { timeoutMs } = JSON.parse(readFileSync(join(sb.dir, 'report.json'), 'utf8'));
  assert.match(records[0].parent, /--test-timeout=\d+ /);
  assert.ok(records[1].parent.includes(`--test-timeout=${timeoutMs} `), `the mutant's suite has the cap, saw: ${records[1].parent.slice(0, 300)}`);
});

test('with GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE set, preparing a scratch leaves the operator repository, its origin and its staged index alone', async (t) => {
  const sb = sandbox(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=omelette test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: sb.root, env: cleanEnv(), encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  git('remote', 'add', 'origin', join(sb.dir, 'upstream'));
  writeFileSync(join(sb.root, 'staged.txt'), 'staged');
  git('add', 'staged.txt');
  const before = [git('remote', '-v'), git('diff', '--cached', '--name-only')];
  assert.match(before[0], /^origin\t/m);
  assert.equal(before[1].trim(), 'staged.txt');

  const scratch = join(sb.dir, 'scratch');
  const paths = await withEnv({ GIT_DIR: join(sb.root, '.git'), GIT_WORK_TREE: sb.root, GIT_INDEX_FILE: join(sb.root, '.git', 'index') },
    () => prepareScratch({ root: sb.root, scratch, entries: ENTRIES }));

  assert.deepEqual([git('remote', '-v'), git('diff', '--cached', '--name-only')], before, 'the operator repository is untouched');
  const inScratch = (...args) => execFileSync('git', ['-C', paths.work, ...args], { env: cleanEnv(), encoding: 'utf8' });
  assert.equal(inScratch('remote').trim(), '', 'the scratch has a repository of its own, with no origin');
  assert.match(inScratch('log', '--format=%s', '-1'), /one/);
});

test('--scratch is compared by real path: a symlink to the tree, a symlinked ancestor and a not-yet-existing tail are all refused and create nothing; a fresh outside path is accepted', async (t) => {
  const sb = sandbox(t);
  const snapshot = () => readdirSync(sb.root, { recursive: true }).sort();
  mkdirSync(join(sb.root, 'inner'));
  const before = snapshot();
  symlinkSync(join(sb.root, 'inner'), join(sb.dir, 'link-to-inner'));
  symlinkSync(sb.root, join(sb.dir, 'ancestor'));
  const refused = [
    join(sb.dir, 'link-to-inner'), // the scratch itself is a link into the tree
    join(sb.dir, 'ancestor', 'inner', 'new', 'deeper'), // an ancestor is a link, and the tail does not exist yet
    join(sb.dir, 'ancestor', 'not-yet'),
    sb.root,
    join(sb.root, 'lib', 'sub', 'dir'),
  ];
  for (const scratch of refused) {
    assert.throws(() => prepareScratch({ root: sb.root, scratch, entries: ENTRIES }), /inside the tree under test/, scratch);
    assert.deepEqual(snapshot(), before, `a refusal creates nothing (${scratch})`);
  }
  assert.equal(existsSync(join(sb.dir, 'ancestor', 'inner', 'new')), false);

  const fresh = join(sb.dir, 'outside', 'new');
  const ok = prepareScratch({ root: sb.root, scratch: fresh, entries: ENTRIES });
  assert.equal(readFileSync(join(ok.work, 'lib', 'core.mjs'), 'utf8'), LIB);
  const outsideDir = join(sb.dir, 'elsewhere');
  mkdirSync(outsideDir);
  symlinkSync(outsideDir, join(sb.dir, 'link-outside'));
  prepareScratch({ root: sb.root, scratch: join(sb.dir, 'link-outside'), entries: ENTRIES });
  assert.ok(existsSync(join(realpathSync(outsideDir), 'pristine')), 'a symlink that leads out of the tree is fine');
  assert.deepEqual(snapshot(), before);
});

test("the runner's own tests are never run: --files naming only them fails, naming more leaves them out and they never appear in caughtBy", async (t) => {
  const sb = sandbox(t);
  writeFileSync(join(sb.root, 'test', 'mutants-x.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('own', () => assert.fail('measured'));\n");
  const cataloguePath = join(sb.dir, 'catalogue.json');
  writeFileSync(cataloguePath, JSON.stringify([MUTANT]));
  const run = async (args) => {
    const io = capture();
    const code = await main(['--out', join(sb.dir, 'report.json'), ...args], { root: sb.root, cataloguePath, entries: ENTRIES, out: io.out, err: io.err });
    return { code, err: io.lines.err.join('\n') };
  };
  const only = await run(['--files', 'mutants-x.test.mjs', '--scratch', join(sb.dir, 'scratch-a')]);
  assert.equal(only.code, 1);
  assert.match(only.err, /never run/);
  assert.equal(existsSync(join(sb.dir, 'scratch-a')), false, 'nothing is copied for a run that cannot start');

  const more = await run(['--files', 'mutants-*.test.mjs,a.test.mjs']);
  assert.equal(more.code, 0, more.err);
  assert.match(more.err, /excluded: .*test\/mutants-x\.test\.mjs/);
  const report = JSON.parse(readFileSync(join(sb.dir, 'report.json'), 'utf8'));
  assert.equal(report.baseline.files, 1);
  assert.deepEqual(report.mutants[0].caughtBy, ['test/a.test.mjs']);
});

for (const [signal, ownScratch] of [['SIGTERM', true], ['SIGINT', false], ['SIGHUP', true]]) {
  test(`${signal} during a hanging mutant: the run ends by the signal, no process from the sandbox is left (one outside the suite's process group and one no longer under the suite included)${ownScratch ? ', and a scratch the runner made is removed' : ', and a --scratch the operator named is kept'}`, async (t) => {
    const sb = sandbox(t);
    const tmp = join(sb.dir, 'tmp');
    mkdirSync(tmp);
    const pidfile = join(sb.dir, 'pids.txt');
    const cataloguePath = join(sb.dir, 'catalogue.json');
    writeFileSync(cataloguePath, JSON.stringify([HANG]));
    const driver = join(sb.dir, 'driver.mjs');
    writeFileSync(driver, `import { main } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};\n`
      + `process.exitCode = await main(JSON.parse(process.argv[4]), { root: process.argv[2], cataloguePath: process.argv[3], entries: ['lib', 'test'] });\n`);
    const scratch = join(sb.dir, 'named-scratch');
    const args = ['--timeout', '120', '--out', join(sb.dir, 'report.json'), ...(ownScratch ? [] : ['--scratch', scratch])];
    const child = spawn(process.execPath, [driver, sb.root, cataloguePath, JSON.stringify(args)], {
      cwd: sb.dir, env: { ...cleanEnv(), TMPDIR: tmp, MUT_PIDFILE: pidfile, MUT_MARK: join(sb.dir, 'mark') }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
    sb.onCleanup(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      killSurvivors(sb);
      if (existsSync(pidfile)) for (const l of readFileSync(pidfile, 'utf8').split('\n').filter(Boolean)) { try { process.kill(Number(l.split(' ')[0]), 'SIGKILL'); } catch { /* gone */ } }
    });
    // baseline: a probe process and its straggler; the hanging mutant: another pair, its detached grandchild, the orphan.
    const deadline = Date.now() + 60_000;
    const trail = () => (existsSync(pidfile) ? readFileSync(pidfile, 'utf8') : '');
    while (!(trail().includes(' detached') && trail().includes(' orphan'))) {
      assert.ok(Date.now() < deadline, `the mutant never started; stderr: ${stderr}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill(signal);
    const { sig } = await exited;
    assert.equal(sig, signal, `the exit reflects the signal; stderr: ${stderr}`);
    assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith('omelette-mutants')), [], 'no scratch left in the OS temp directory');
    assert.equal(existsSync(scratch), !ownScratch, ownScratch ? 'n/a' : 'the named scratch stays');
    assert.equal(existsSync(join(scratch, 'owner.pid')), false, 'and no longer names an owner');
    assert.deepEqual(await settle(sb), [], 'no process whose command line holds the sandbox survives');
    assert.equal(readFileSync(join(sb.root, 'lib', 'core.mjs'), 'utf8'), LIB);
  });
}

test('--stragglers lists each process whose command line holds the mark as pid, age, command and exits 1; --kill ends them and exits 0; with none left it prints nothing', async (t) => {
  const sb = sandbox(t);
  const straggler = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(sb.dir, 'straggler')], { stdio: 'ignore' });
  t.after(() => { try { straggler.kill('SIGKILL'); } catch { /* gone */ } });
  const ended = new Promise((resolve) => straggler.on('exit', (code, sig) => resolve(sig)));
  await new Promise((resolve, reject) => { straggler.on('spawn', resolve); straggler.on('error', reject); });
  const scan = async (args, deps = { stragglerMark: sb.dir }) => {
    const io = capture();
    const code = await main(args, { ...deps, out: io.out, err: io.err });
    return { code, ...io.lines };
  };

  const listed = await scan(['--stragglers']);
  assert.equal(listed.code, 1, listed.err.join('\n'));
  assert.equal(listed.out.length, 1, listed.out.join('\n'));
  assert.match(listed.out[0], new RegExp(`^${straggler.pid}  [\\d:-]+  \\S`));
  assert.ok(listed.out[0].includes(join(sb.dir, 'straggler')), listed.out[0]);
  // The default mark is the one every runner scratch and test sandbox carries in its name.
  const byDefault = await scan(['--stragglers'], {});
  assert.equal(byDefault.code, 1);
  assert.ok(byDefault.out.some((l) => l.startsWith(`${straggler.pid}  `)), byDefault.out.join('\n'));

  const killed = await scan(['--stragglers', '--kill']);
  assert.equal(killed.code, 0, killed.err.join('\n'));
  assert.equal(await ended, 'SIGKILL');
  assert.deepEqual(await scan(['--stragglers']), { code: 0, out: [], err: [] });
  assert.equal((await scan(['--kill'])).code, 2, '--kill alone is a usage error');
});

test("--stragglers knows a live run by its scratch's owner and never kills it; once the runner is SIGKILLed, a detached grandchild with a neutral command line is a leftover, found by the scratch variable it inherited, and --kill ends it", async (t) => {
  const sb = sandbox(t);
  // The baseline's one file leaves that grandchild and a second one with no environment whose command line
  // names the scratch (known by that alone), records both pids, and holds the run open.
  writeFileSync(join(sb.root, 'test', 'a.test.mjs'), [
    "import test from 'node:test';",
    "import { spawn } from 'node:child_process';",
    "import { appendFileSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
    "const h = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', fileURLToPath(import.meta.url)], { detached: true, stdio: 'ignore', env: {} });",
    'g.unref();',
    'h.unref();',
    'appendFileSync(process.env.MUT_PIDFILE, `${g.pid}\\n${h.pid}\\n`);',
    "test('holds', () => new Promise(() => setInterval(() => {}, 1000)));",
    '',
  ].join('\n'));
  const pidfile = join(sb.dir, 'pids.txt');
  const cataloguePath = join(sb.dir, 'catalogue.json');
  writeFileSync(cataloguePath, JSON.stringify([MUTANT]));
  const driver = join(sb.dir, 'driver.mjs');
  writeFileSync(driver, `import { main } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};\n`
    + `process.exitCode = await main(JSON.parse(process.argv[4]), { root: process.argv[2], cataloguePath: process.argv[3], entries: ['lib', 'test'] });\n`);
  const args = ['--timeout', '600', '--scratch', join(sb.dir, 'scratch'), '--out', join(sb.dir, 'report.json')];
  const runner = spawn(process.execPath, [driver, sb.root, cataloguePath, JSON.stringify(args)], { cwd: sb.dir, env: { ...cleanEnv(), MUT_PIDFILE: pidfile }, stdio: 'ignore' });
  const runnerGone = new Promise((resolve) => runner.on('exit', resolve));
  const recorded = () => (existsSync(pidfile) ? readFileSync(pidfile, 'utf8').split('\n').filter(Boolean).map(Number) : []);
  sb.onCleanup(() => {
    try { runner.kill('SIGKILL'); } catch { /* gone */ }
    for (const p of recorded()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    killSurvivors(sb);
  });
  for (const deadline = Date.now() + 60_000; recorded().length < 2;) {
    assert.ok(Date.now() < deadline, 'the baseline never started');
    await new Promise((r) => setTimeout(r, 50));
  }
  const [g, h] = recorded();
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const scan = async (argv) => {
    const io = capture();
    const code = await main(argv, { stragglerMark: basename(sb.dir), out: io.out, err: io.err });
    return { code, ...io.lines };
  };

  const live = await scan(['--stragglers']);
  assert.equal(live.code, 0, live.out.join('\n'));
  assert.equal(live.out[0], 'live runs (never killed):', live.out.join('\n'));
  assert.ok(live.out.some((l) => l.startsWith(`  ${g}  `)), `the grandchild is the live run's: ${live.out.join('\n')}`);
  assert.ok(live.out.some((l) => l.startsWith(`  ${h}  `)), `so is the one known by its command line alone: ${live.out.join('\n')}`);
  assert.ok(live.out.some((l) => l.startsWith(`  ${runner.pid}  `)), `so is the runner, the scratch's owner: ${live.out.join('\n')}`);
  const spared = await scan(['--stragglers', '--kill']);
  assert.deepEqual([spared.code, spared.err], [0, []]);
  assert.ok(alive(g) && alive(h) && runner.exitCode === null, 'a live run is never killed');

  runner.kill('SIGKILL');
  await runnerGone;
  const left = await scan(['--stragglers']);
  assert.equal(left.code, 1, left.out.join('\n'));
  assert.ok(left.out.some((l) => l.startsWith(`${g}  `)) && left.out.some((l) => l.startsWith(`${h}  `)), `both are leftovers now: ${left.out.join('\n')}`);
  assert.ok(!left.out.includes('live runs (never killed):'), left.out.join('\n'));
  const killed = await scan(['--stragglers', '--kill']);
  assert.equal(killed.code, 0, killed.err.join('\n'));
  for (const deadline = Date.now() + 5000; (alive(g) || alive(h)) && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([g, h].filter(alive), [], 'nothing survives --kill');
  assert.deepEqual(await scan(['--stragglers']), { code: 0, out: [], err: [] });
});
