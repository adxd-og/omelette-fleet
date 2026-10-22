// scripts/mutants.mjs, fix round 1 — what the runner promises about the world around
// it: where a scratch may be, what a child inherits, which reporter a child loads, what
// a signal leaves behind, which files are never measured. Every fixture repository is
// built under a fresh tmp directory; neither this checkout nor the real catalogue is
// touched. (Named mutants*.test.mjs: the runner never measures its own tests.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main, prepareScratch } from '../scripts/mutants.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'mutants.mjs');
const ENTRIES = ['lib', 'test'];
const LIB = "export function hang() {\n  return 1;\n}\n";
// Records what the process around it looks like, leaves a marker in HOME, and (when asked) a pid trail.
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
  "  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  '  c.unref();',
  '  appendFileSync(e.MUT_PIDFILE, `${c.pid}\\n`);',
  '}',
  "test('probe', () => { assert.equal(hang(), 1); });",
  '',
].join('\n');
const MUTANT = { id: 'm-ret', file: 'lib/core.mjs', find: 'return 1;', replace: 'return 2;', breaks: 'x' };
const HANG = { id: 'm-hang', file: 'lib/core.mjs', find: 'return 1;', replace: 'for (;;);', breaks: 'x' };

const sandbox = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-mutants-isolation-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'lib', 'core.mjs'), LIB);
  writeFileSync(join(root, 'test', 'a.test.mjs'), PROBE);
  return { dir, root };
};
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
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'NODE_TEST_CONTEXT'));

test('a suite child gets HOME and OMELETTE_HOME on <scratch>/home, emptied before every run, no GIT_* and no write gate, and loads the reporter copy from the scratch', async (t) => {
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
  test(`${signal} during a hanging mutant: the run ends by the signal, no suite process is left${ownScratch ? ', and a scratch the runner made is removed' : ', and a --scratch the operator named is kept'}`, async (t) => {
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
      cwd: sb.dir, env: { ...cleanEnv(), TMPDIR: tmp, MUT_PIDFILE: pidfile }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
    t.after(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      if (existsSync(pidfile)) for (const p of readFileSync(pidfile, 'utf8').split('\n').filter(Boolean)) { try { process.kill(Number(p), 'SIGKILL'); } catch { /* gone */ } }
    });
    // baseline: a probe process and its straggler; the hanging mutant: another pair.
    const deadline = Date.now() + 60_000;
    while (!(existsSync(pidfile) && readFileSync(pidfile, 'utf8').split('\n').filter(Boolean).length >= 4)) {
      assert.ok(Date.now() < deadline, `the mutant never started; stderr: ${stderr}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill(signal);
    const { sig } = await exited;
    assert.equal(sig, signal, `the exit reflects the signal; stderr: ${stderr}`);
    assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith('omelette-mutants')), [], 'no scratch left in the OS temp directory');
    assert.equal(existsSync(scratch), !ownScratch, ownScratch ? 'n/a' : 'the named scratch stays');
    await new Promise((r) => setTimeout(r, 300));
    for (const p of readFileSync(pidfile, 'utf8').split('\n').filter(Boolean).map(Number)) assert.equal(alive(p), false, `pid ${p} is still alive`);
    assert.equal(readFileSync(join(sb.root, 'lib', 'core.mjs'), 'utf8'), LIB);
  });
}
