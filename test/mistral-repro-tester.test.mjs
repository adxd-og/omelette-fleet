// 1.9.0 Task 3, tester's file (omelette-tester): input classes the plan's tests
// do not exercise — the clone on odd work trees, the diff on odd clones, what
// the ANSWER survives, the env the child gets, the kernel profile's other
// read-denies, and the sandbox's reach into a sibling run. Same fake `vibe` and
// temp-dir discipline as test/mistral-repro.test.mjs (copied: that file exports
// nothing). Never runs the real `vibe`; HOME, OMELETTE_HOME and VIBE_BIN are temp.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import unit from '../units/mistral/adapter.mjs';
import { ensureHome, renderWrapper } from '../units/mistral/home.mjs';
import { DIFF_CAP, appendPatch, cloneDiff, prepareClone, removeRun, reproAllowed, reproSupported } from '../units/mistral/repro.mjs';
import { PARTIAL_MARK_RE, partialMark } from '../core/partial.mjs';
import { ALLOWED_ENV } from '../core/spawn.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const DARWIN = process.platform === 'darwin';
// sandbox-exec cannot nest: inside a sandbox even an allow-everything profile fails, and the kernel rows skip.
const KERNEL = DARWIN && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-mistral-t3t-')));
const HOMES = DARWIN ? '/private/tmp' : BASE;
const made = [BASE];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const CLOSED = 'Error: mistral_security_repro is closed — set OMELETTE_ALLOW_REPRO=1 on the unit\'s registration to let the model execute code in a disposable clone (OMELETTE_ALLOW_WRITE does not open it)';
const RESOLVED_ENV = ['VIBE_HOME', 'TMPDIR', 'OMELETTE_FLEET_HOME', 'OMELETTE_REPRO_CLONE', 'OMELETTE_REPRO_TMP', 'OMELETTE_REPRO_OUT'];

const FAKE = join(BASE, 'fake-vibe.mjs');
writeFileSync(FAKE, [
  'import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";',
  'import { spawnSync } from "node:child_process";',
  'import { join } from "node:path";',
  'const [scenarioPath, ...argv] = process.argv.slice(2);',
  'const sc = JSON.parse(readFileSync(scenarioPath, "utf8"));',
  'const opt = (f) => argv[argv.indexOf(f) + 1];',
  'const outDir = opt("--output-dir");',
  'const workdir = opt("--workdir");',
  'const homeConfig = readFileSync(join(process.env.VIBE_HOME, "config.toml"), "utf8");',
  'const shell = JSON.parse(/^shell = (".*")$/m.exec(homeConfig)[1]);',
  'const ran = sc.shell ? spawnSync(shell, ["-c", sc.shell], { cwd: workdir, env: process.env, encoding: "utf8" }) : null;',
  'const resolved = {};',
  `for (const k of ${JSON.stringify(RESOLVED_ENV)}) resolved[k] = process.env[k] ? realpathSync(process.env[k]) : null;`,
  'const esc = (s) => JSON.stringify(s).slice(1, -1);',
  'const fill = (v) => JSON.parse(JSON.stringify(v).replaceAll("$MODEL", esc(opt("--model"))).replaceAll("$SHELL", esc(shell)));',
  'appendFileSync(sc.record, JSON.stringify({',
  '  argv, env: process.env, cwd: process.cwd(), workdir, outDir, resolved, homeConfig,',
  '  prompt: readFileSync(opt("--prompt-file"), "utf8"),',
  '  promptMode: statSync(opt("--prompt-file")).mode & 0o777,',
  '  vibeInWorkdir: existsSync(join(workdir, ".vibe")),',
  '  files: readdirSync(workdir),',
  '  ran: ran && { status: ran.status, stdout: ran.stdout, stderr: ran.stderr },',
  '}) + "\\n");',
  'if (sc.export) writeFileSync(join(outDir, "export.json"), JSON.stringify(fill(sc.export), null, 2));',
  'process.stdout.write(sc.answer);',
  'process.exitCode = sc.code;',
  // A run that outlives the hard kill: the runtime ends it.
  'if (sc.sleepMs) setTimeout(() => {}, sc.sleepMs);',
].join('\n'));

/** export.json as Vibe 3.1.0 writes it, cut to the keys the adapter reads; `$SHELL` is the home's wrapper. */
const defaultExport = () => ({
  outcome: 'finished',
  stop_reason: null,
  error: null,
  session_id: 'b7c1e2d0-0000-4000-8000-000000000003',
  usage: { input_tokens: 1200, output_tokens: 300, cached_input_tokens: 800, total_tokens: 1500 },
  cost_usd: 0,
  steps: 7,
  exit_code: 0,
  config: { active_model: '$MODEL', outside_workdir: 'deny', enable_mcp: false, enable_connectors: false, tools: { bash: { shell: '$SHELL' } } },
});

const GIT_ID = ['-c', 'user.name=omelette test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];

/** A git work tree at `dir` with one commit of `files`, then `uncommitted` written over it. Returns the short HEAD. */
function gitRepo(dir, { files = {}, uncommitted = {} } = {}) {
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString();
  const write = (tree) => {
    for (const [p, c] of Object.entries(tree)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
  };
  mkdirSync(dir, { recursive: true });
  git('init', '-q');
  write({ 'README.md': 'demo\n', 't.test.mjs': "import test from 'node:test';\ntest('ok', () => {});\n", ...files });
  git('add', '-A');
  git(...GIT_ID, 'commit', '-qm', 'one');
  write(uncommitted);
  return git('rev-parse', '--short', 'HEAD').trim();
}

/** Run `fn` with `vars` set in process.env (undefined deletes), then restore them. */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

let n = 0;
/**
 * One test's world: HOME under `homes` with `.ssh/id` in it, OMELETTE_HOME at
 * <HOME>/.omelette, a git repo as the cwd, the scenario the fake reads, and a
 * runtime whose tools spawn the fake. `edit(scenario)` sets the command the
 * fake runs through the wrapper (`shell`), the answer, the exit code, the export.
 */
function world({ config, edit = () => {}, files, uncommitted, homes = HOMES, hardKillMs, parentEnv = {} } = {}) {
  const root = join(BASE, `w${++n}`);
  mkdirSync(root);
  const home = mkdtempSync(join(homes, 'omelette-mistral-t3t-home-'));
  made.push(home);
  const fleet = join(home, '.omelette');
  mkdirSync(fleet);
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'id'), 'ssh-secret-bytes\n');
  if (config) writeFileSync(join(fleet, 'fleet.config.json'), JSON.stringify({ units: { mistral: config } }));
  const work = join(root, 'repo');
  const head = gitRepo(work, { files, uncommitted });
  const record = join(root, 'record.jsonl');
  const scenario = { record, export: defaultExport(), answer: 'finding: README.md:1 · …', code: 0, shell: '' };
  edit(scenario);
  const scenarioPath = join(root, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const env = { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: fleet, VIBE_BIN: process.execPath, ...parentEnv };
  const records = [];
  const spawnOpts = [];
  let retries = 0;
  const rt = createUnitRuntime({
    ...unit,
    tools: unit.tools.map((t) => (t.run ? {
      ...t,
      run: (a, ctx) => t.run(a, {
        ...ctx,
        retry: (fn, o) => { retries++; return ctx.retry(fn, o); },
        spawn: (o) => { spawnOpts.push(o); return ctx.spawn({ ...o, ...(hardKillMs ? { hardKillMs } : {}), args: [FAKE, scenarioPath, ...o.args] }); },
      }),
    } : t)),
  }, { env, onResult: (r) => records.push(r) });
  const spawns = () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const call = (args = {}) => rt.callTool('mistral_security_repro', { prompt: 'reproduce the auth bug', cwd: work, ...args });
  const repro = (args = {}) => withEnv({ OMELETTE_ALLOW_REPRO: '1' }, () => call(args));
  const review = () => rt.callTool('mistral_security_review', { prompt: 'find the auth bug', cwd: work });
  return { root, home, fleet, work, head, records, spawnOpts, spawns, retries: () => retries, call, repro, review };
}


/** The values passed after each `--enabled-tools`, in order. */
const enabledTools = (argv) => argv.flatMap((a, i) => (a === '--enabled-tools' ? [argv[i + 1]] : []));
const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const mark = (name) => join(BASE, `marker-${name}`);

/** Run `fn` with TMPDIR at a fresh empty dir of ours, so what prepareClone leaves behind is countable. */
function withTmpRoot(fn) {
  const root = mkdtempSync(join(BASE, 'tmproot-'));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try { return { root, value: fn() }; } catch (e) { e.root = root; throw e; } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  }
}
const refused = (fn) => { try { fn(); } catch (e) { return e; } return null; };

/* ── prepareClone on work trees the plan's tests do not use ────────────────── */

test('prepareClone: a path with a space, a committed link, a .vibe link, a subdirectory cwd; nothing is left behind by a refusal', () => {
  const victim = join(BASE, 'vibe-target');
  mkdirSync(victim);
  writeFileSync(join(victim, 'keep'), 'operator data\n');
  const spaced = join(BASE, 'my repo');
  const head = gitRepo(spaced, { files: { 'x/y.txt': 'y\n', 'a b.txt': 'ab\n' }, uncommitted: { 'wip.txt': 'wip\n' } });
  symlinkSync('a b.txt', join(spaced, 'link'));
  symlinkSync(victim, join(spaced, '.vibe'));
  execFileSync('git', ['-C', spaced, 'add', 'link', '.vibe']);
  execFileSync('git', ['-C', spaced, ...GIT_ID, 'commit', '-qm', 'links']);

  const logs = [];
  const { root, value: run } = withTmpRoot(() => prepareClone({ cwd: join(spaced, 'x'), log: (m) => logs.push(m) }));
  try {
    assert.equal(dirname(run.runDir), realpathSync(join(root, 'omelette-mistral-repro')));
    // The clone is of the work tree's top, whichever directory inside it was named.
    assert.deepEqual(readdirSync(run.clone).sort(), ['.git', 'README.md', 'a b.txt', 'link', 't.test.mjs', 'x']);
    assert.equal(run.dirty, true, 'the untracked file counts as uncommitted');
    assert.match(logs.join('\n'), /uncommitted changes, not in the clone/);
    assert.equal(lstatSync(join(run.clone, 'link')).isSymbolicLink(), true);
    // A committed .vibe link is dropped as a link: the directory it points at is untouched, the index has no .vibe.
    assert.throws(() => lstatSync(join(run.clone, '.vibe')));
    assert.equal(readFileSync(join(victim, 'keep'), 'utf8'), 'operator data\n');
    assert.equal(execFileSync('git', ['-C', run.clone, 'ls-files', '.vibe']).toString(), '');
    assert.equal((lstatSync(run.tmp).mode & 0o777), 0o700);
    assert.equal((lstatSync(run.out).mode & 0o777), 0o700);
  } finally {
    removeRun(run.runDir);
  }
  assert.deepEqual([readdirSync(root), readdirSync(join(root, 'omelette-mistral-repro'))], [['omelette-mistral-repro'], []]);

  // Refusals: no work tree, a bare repository, a repository with no commit — each leaves the temp root empty.
  const plain = join(BASE, 'plain');
  mkdirSync(plain);
  const bare = join(BASE, 'bare.git');
  execFileSync('git', ['init', '--bare', '-q', bare]);
  const empty = join(BASE, 'empty');
  mkdirSync(empty);
  execFileSync('git', ['-C', empty, 'init', '-q']);
  for (const cwd of [plain, bare, empty]) {
    const { root: r2, value } = (() => { let root2; const e = refused(() => withTmpRoot(() => prepareClone({ cwd }))); return { root: e && e.root, value: e }; })();
    assert.ok(value, `${cwd} is refused`);
    assert.deepEqual(readdirSync(r2).flatMap((d) => (d === 'omelette-mistral-repro' ? readdirSync(join(r2, d)) : [d])), [], `${cwd}: the run directory is removed on a refusal`);
  }
});

// A work tree whose path holds a percent sign: `file://<path>` is a URL to git, which decodes it.
test('prepareClone: a work tree whose path holds a %', () => {
  const d = join(BASE, 'rate-100%41-repo');
  gitRepo(d);
  const { root, value: run } = withTmpRoot(() => prepareClone({ cwd: d }));
  try {
    assert.ok(existsSync(join(run.clone, 'README.md')));
  } finally {
    removeRun(run.runDir);
  }
  assert.deepEqual([readdirSync(root), readdirSync(join(root, 'omelette-mistral-repro'))], [['omelette-mistral-repro'], []]);
});

/* ── cloneDiff on clones the model has dressed up ──────────────────────────── */

test('cloneDiff: a binary file, a rename, a delete, a link out of the clone and a wiped work tree each show as git shows them, none reads through a link', () => {
  const d = join(BASE, 'shapes');
  gitRepo(d, { files: { 'del.txt': 'gone\n', 'ren.txt': 'r1\nr2\nr3\nr4\nr5\n', 'dir/in.txt': 'in\n' } });
  const run = prepareClone({ cwd: d });
  try {
    const c = run.clone;
    writeFileSync(join(c, 'bin.dat'), Buffer.from([0, 1, 2, 255, 0, 3]));
    rmSync(join(c, 'del.txt'));
    execFileSync('mv', [join(c, 'ren.txt'), join(c, 'ren2.txt')]);
    symlinkSync('/etc/hosts', join(c, 'hosts-link'));
    const diff = cloneDiff(c);
    assert.match(diff, /^Binary files \/dev\/null and b\/bin\.dat differ$/m);
    assert.match(diff, /^deleted file mode 100644$/m);
    assert.match(diff, /^rename from ren\.txt$/m);
    assert.match(diff, /^rename to ren2\.txt$/m);
    assert.match(diff, /^\+\/etc\/hosts$/m, 'a link is its target path');
    assert.doesNotMatch(diff, /localhost/, 'the bytes behind the link are not read');

    // The model deletes the whole work tree: every tracked file is a deletion, the call still answers.
    for (const name of readdirSync(c)) if (name !== '.git') rmSync(join(c, name), { recursive: true, force: true });
    const wiped = cloneDiff(c);
    for (const f of ['README.md', 't.test.mjs', 'dir/in.txt', 'del.txt', 'ren.txt']) assert.match(wiped, new RegExp(`^--- a/${f.replace('.', '\\.')}$`, 'm'), f);
  } finally {
    removeRun(run.runDir);
  }
});

test('cloneDiff reads nothing from the clone\'s own .git: a planted filter, textconv, external diff, attributes file or exclude does not run or hide anything', () => {
  const d = join(BASE, 'planted');
  gitRepo(d);
  const run = prepareClone({ cwd: d });
  try {
    const c = run.clone;
    const touch = (n) => `touch ${sq(mark(`planted-${n}`))}`;
    const cfg = [
      '[core]', `\tfsmonitor = ${touch('fsmonitor')}`, `\tattributesFile = ${join(c, '.git', 'attrs')}`, `\texcludesFile = ${join(c, '.git', 'excl')}`,
      '[filter "x"]', `\tclean = ${touch('clean')}`, `\tsmudge = ${touch('smudge')}`,
      '[diff]', `\texternal = ${touch('external')}`, '[diff "x"]', `\ttextconv = ${touch('textconv')}`, '',
    ].join('\n');
    writeFileSync(join(c, '.git', 'config'), `${readFileSync(join(c, '.git', 'config'), 'utf8')}${cfg}`);
    writeFileSync(join(c, '.git', 'attrs'), '* filter=x diff=x\n');
    writeFileSync(join(c, '.git', 'excl'), '*\n');
    mkdirSync(join(c, '.git', 'info'), { recursive: true });
    writeFileSync(join(c, '.git', 'info', 'attributes'), '* filter=x diff=x\n');
    writeFileSync(join(c, '.git', 'info', 'exclude'), '*\n');
    writeFileSync(join(c, 'README.md'), 'demo\nchanged\n');
    writeFileSync(join(c, 'new.txt'), 'new\n');
    const diff = cloneDiff(c);
    for (const n of ['fsmonitor', 'clean', 'smudge', 'external', 'textconv']) assert.equal(existsSync(mark(`planted-${n}`)), false, `${n} ran on the adapter's side`);
    assert.match(diff, /^\+changed$/m);
    assert.match(diff, /^\+\+\+ b\/new\.txt$/m, 'an exclude the model planted in its own .git hides nothing');
  } finally {
    removeRun(run.runDir);
  }
});

test('cloneDiff never enters a repository the model nests as a gitfile, and says so', () => {
  const d = join(BASE, 'gitfile');
  gitRepo(d);
  const run = prepareClone({ cwd: d });
  try {
    const c = run.clone;
    // sub/.git is a FILE pointing at ../evil.git, a bare repository whose config carries a filter; sub/f is attributed to it.
    execFileSync('git', ['init', '--bare', '-q', join(c, 'evil.git')]);
    writeFileSync(join(c, 'evil.git', 'config'), `${readFileSync(join(c, 'evil.git', 'config'), 'utf8')}[filter "x"]\n\tclean = touch ${sq(mark('gitfile'))}\n`);
    mkdirSync(join(c, 'sub'));
    writeFileSync(join(c, 'sub', '.git'), 'gitdir: ../evil.git\n');
    writeFileSync(join(c, 'sub', '.gitattributes'), '* filter=x\n');
    writeFileSync(join(c, 'sub', 'f'), 'f\n');
    writeFileSync(join(c, 'README.md'), 'demo\npatched\n');
    const diff = cloneDiff(c);
    assert.equal(existsSync(mark('gitfile')), false, 'the nested repository\'s filter ran on the adapter\'s side');
    assert.match(diff, /^\(nested repository sub not diffed\)$/m);
    assert.match(diff, /^\+patched$/m);
    assert.doesNotMatch(diff, /^\+\+\+ b\/sub\//m);
  } finally {
    removeRun(run.runDir);
  }
});

test('cloneDiff: a diff of exactly DIFF_CAP bytes is whole; one byte more is cut at a line end with the truncation line', () => {
  const d = join(BASE, 'cap');
  gitRepo(d);
  const run = prepareClone({ cwd: d });
  try {
    const file = join(run.clone, 'big.txt');
    const body = (last) => `${('x'.repeat(99) + '\n').repeat(10000)}${'y'.repeat(last)}\n`;
    writeFileSync(file, body(50));
    let last = 50 + (DIFF_CAP - cloneDiff(run.clone).length);
    writeFileSync(file, body(last));
    const exact = cloneDiff(run.clone);
    assert.equal(exact.length, DIFF_CAP, 'the probe lands on the cap');
    assert.ok(!exact.includes('diff truncated'), 'exactly the cap is not truncated');
    assert.ok(exact.endsWith(`${'y'.repeat(last)}\n`));

    writeFileSync(file, body(last + 1));
    const over = cloneDiff(run.clone);
    assert.ok(over.endsWith('… diff truncated at 1 MB — set mistral.reproKeep=true to inspect the clone\n'), over.slice(-200));
    const kept = over.slice(0, over.lastIndexOf('… diff truncated'));
    assert.ok(kept.length <= DIFF_CAP && kept.endsWith('\n'));
    assert.ok(!kept.includes('y'.repeat(last + 1)), 'the last line is dropped whole, not cut mid-line');
  } finally {
    removeRun(run.runDir);
  }
});

test('removeRun removes a link the model left in the clone, not what it points at', () => {
  const d = join(BASE, 'rm-link');
  gitRepo(d);
  const victim = join(BASE, 'rm-victim');
  mkdirSync(join(victim, 'deep'), { recursive: true });
  writeFileSync(join(victim, 'deep', 'precious'), 'operator data\n');
  const run = prepareClone({ cwd: d });
  symlinkSync(victim, join(run.clone, 'to-home'));
  symlinkSync(join(victim, 'deep', 'precious'), join(run.tmp, 'to-file'));
  removeRun(run.runDir);
  assert.equal(existsSync(run.runDir), false);
  assert.equal(readFileSync(join(victim, 'deep', 'precious'), 'utf8'), 'operator data\n');
});

/* ── what the paid answer survives ─────────────────────────────────────────── */

test('an unreadable tracked file in the clone does not cost the answer: the diff is the part that fails, the report is returned', { skip: !KERNEL }, async () => {
  const w = world({ edit: (s) => { s.shell = 'chmod 000 README.md'; } });
  const r = await w.repro();
  assert.equal(w.spawns()[0].ran.status, 0, w.spawns()[0].ran.stderr);
  assert.equal(r.isError, undefined, r.text);
  assert.ok(r.text.includes('finding: README.md:1 · …'), 'the model\'s report is in the answer');
});

test('a directory the model made mode 000 does not cost the answer, and the run directory still goes', { skip: !KERNEL }, async () => {
  const w = world({ edit: (s) => { s.shell = 'mkdir locked && echo x > locked/f && chmod 000 locked'; } });
  let runDir;
  try {
    const r = await w.repro();
    runDir = dirname(w.spawns()[0].workdir);
    assert.equal(w.spawns()[0].ran.status, 0, w.spawns()[0].ran.stderr);
    assert.equal(r.isError, undefined, r.text);
    assert.ok(r.text.includes('finding: README.md:1 · …'), 'the model\'s report is in the answer');
    assert.equal(existsSync(runDir), false, 'the run directory is removed');
  } finally {
    if (!runDir) runDir = (w.spawns()[0] || {}).workdir && dirname(w.spawns()[0].workdir);
    if (runDir && existsSync(runDir)) {
      spawnSync('chmod', ['-R', 'u+rwx', runDir]);
      rmSync(runDir, { recursive: true, force: true });
    }
  }
});

test('reproKeep with a failed run keeps the clone and names it on the error; a refusal before any clone names nothing', { skip: !DARWIN }, async () => {
  const w = world({ config: { reproKeep: true }, edit: (s) => { s.export = null; s.code = 1; } });
  const r = await w.repro();
  const { workdir } = w.spawns()[0];
  made.push(dirname(workdir));
  assert.equal(r.isError, true);
  assert.match(r.text, /no export\.json/);
  assert.ok(r.text.endsWith(`\n\n_(clone kept: ${workdir})_`), r.text);
  assert.ok(existsSync(join(workdir, 'README.md')), 'the clone is kept');

  const k = world({ config: { reproKeep: true } });
  const plain = join(k.root, 'plain');
  mkdirSync(plain);
  const refusedRun = await k.repro({ cwd: plain });
  assert.equal(refusedRun.isError, true);
  assert.doesNotMatch(refusedRun.text, /clone kept/);
  assert.equal(k.spawns().length, 0);
});

/* ── the gate's order, the tool list, the env ──────────────────────────────── */

test('gate order: the platform answers before the prompt; the prompt before the cwd; the cwd before reproTimeoutS', async () => {
  const w = world({ config: { reproTimeoutS: 10 } });
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, enumerable: true, writable: false });
  try {
    const r = await w.repro({ prompt: '   ', cwd: join(w.root, 'missing') });
    assert.equal(r.text, 'Error: repro: macOS only (1.9.0) — sandbox-exec is not available on linux');
  } finally {
    Object.defineProperty(process, 'platform', saved);
  }
  if (!DARWIN) return;
  const empty = await w.repro({ prompt: '   ', cwd: join(w.root, 'missing') });
  assert.equal(empty.text, 'Error: "prompt" is required.');
  const nocwd = await w.repro({ cwd: join(w.root, 'missing') });
  assert.equal(nocwd.isError, true);
  assert.doesNotMatch(nocwd.text, /reproTimeoutS/);
  const slow = await w.repro();
  assert.match(slow.text, /mistral\.reproTimeoutS must be above 15/);
  assert.equal(w.spawns().length, 0);
});

test('the child\'s env is the allowlist plus the six names the run sets; no key survives, passthrough or not, and the model\'s own env shows none', { skip: !KERNEL }, async () => {
  const secrets = {
    MISTRAL_API_KEY: 'sk-mistral-secret', OPENAI_API_KEY: 'sk-openai-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret', GITHUB_TOKEN: 'gh-secret',
    OMELETTE_PROBE_SECRET: 'probe-secret', SSH_AUTH_SOCK: '/private/tmp/agent-secret', OMELETTE_ENV_PASSTHROUGH: 'MISTRAL_API_KEY,MISTRAL_*',
  };
  const w = world({ parentEnv: secrets, edit: (s) => { s.shell = 'env'; } });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  const [s] = w.spawns();
  const allowed = new Set([...ALLOWED_ENV, 'VIBE_HOME', 'TMPDIR', 'OMELETTE_FLEET_HOME', 'OMELETTE_REPRO_CLONE', 'OMELETTE_REPRO_TMP', 'OMELETTE_REPRO_OUT', 'OMELETTE_REPRO_RUNS', 'OMELETTE_REPRO_RUN', 'OMELETTE_REPRO_TMPROOT']);
  // __CF_USER_TEXT_ENCODING is put there by macOS for every process it starts, not by the fleet.
  assert.deepEqual(Object.keys(s.env).filter((k) => !allowed.has(k) && k !== '__CF_USER_TEXT_ENCODING'), []);
  for (const k of ['MISTRAL_API_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'OMELETTE_PROBE_SECRET', 'SSH_AUTH_SOCK']) assert.equal(s.env[k], undefined, k);
  assert.equal(s.ran.status, 0, s.ran.stderr);
  assert.doesNotMatch(s.ran.stdout, /-secret|MISTRAL_API_KEY|OMELETTE_PROBE/);
});

/* ── the wrapper and the kernel profile, past what the plan's rows reach ───── */

test('the repro wrapper stops before sandbox-exec when OMELETTE_FLEET_HOME or OMELETTE_REPRO_OUT is unset', () => {
  const dir = mkdtempSync(join(BASE, 'wrap-'));
  const [clone, tmpd, fleet, out, home] = ['clone', 'tmp', 'fleet', 'out', 'home'].map((n) => join(dir, n));
  for (const x of [clone, tmpd, fleet, out, home]) mkdirSync(x);
  const wrapper = join(dir, 'shell.sh');
  writeFileSync(wrapper, renderWrapper({ profile: 'repro', home: fleet }));
  chmodSync(wrapper, 0o700);
  const full = { PATH: '/usr/bin:/bin', HOME: home, OMELETTE_REPRO_CLONE: clone, OMELETTE_REPRO_TMP: tmpd, OMELETTE_FLEET_HOME: fleet, OMELETTE_REPRO_OUT: out, T_MARK: join(dir, 'ran') };
  for (const name of ['OMELETTE_FLEET_HOME', 'OMELETTE_REPRO_OUT', 'OMELETTE_REPRO_CLONE', 'OMELETTE_REPRO_TMP', 'HOME']) {
    const env = { ...full };
    delete env[name];
    const run = spawnSync(wrapper, ['-c', 'touch "$T_MARK"'], { env });
    assert.notEqual(run.status, 0, name);
    assert.match(run.stderr.toString(), new RegExp(name), name);
    assert.equal(existsSync(join(dir, 'ran')), false, `${name}: nothing executed`);
  }
});

test('the profile read-denies ~/.ssh, ~/.aws, ~/.config, ~/.vibe and the fleet home each on its own; the run\'s TMPDIR is writable; a push to a repository outside the clone and its temp is refused', { skip: !KERNEL }, async () => {
  const w = world({
    edit: (s) => {
      s.shell = [
        'for f in .ssh/id .aws/c .config/c .vibe/c .omelette/fleet.config.json; do cat "$HOME/$f"; echo "cat-$f=$?"; done',
        'echo ok > "$TMPDIR/t" && cat "$TMPDIR/t"',
        'git init -q --bare "$OMELETTE_REPRO_TMP/r.git"; git -C "$OMELETTE_REPRO_TMP/r.git" config receive.shallowUpdate true; git push -q "file://$OMELETTE_REPRO_TMP/r.git" HEAD:refs/heads/ok 2>&1; echo ctl=$?',
        'git push -q "file://$HOME/remote.git" HEAD:refs/heads/pwn 2>&1; echo push=$?',
      ].join('; ');
    },
  });
  for (const d of ['.aws', '.config', '.vibe']) mkdirSync(join(w.home, d));
  for (const f of ['.aws/c', '.config/c', '.vibe/c']) writeFileSync(join(w.home, f), `secret-in-${f}\n`);
  writeFileSync(join(w.fleet, 'fleet.config.json'), 'secret-in-fleet\n');
  execFileSync('git', ['init', '--bare', '-q', join(w.home, 'remote.git')]);
  execFileSync('git', ['-C', join(w.home, 'remote.git'), 'config', 'receive.shallowUpdate', 'true']);
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  const { ran } = w.spawns()[0];
  assert.doesNotMatch(ran.stdout, /secret-in-|ssh-secret/);
  assert.equal(ran.stdout.match(/^cat-\S+=1$/gm).length, 5, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /^ok$/m, 'TMPDIR is writable');
  assert.match(ran.stdout, /^ctl=0$/m, ran.stdout);
  assert.match(ran.stdout, /^push=[1-9]\d*$/m, ran.stdout);
  const refs = spawnSync('git', ['-C', join(w.home, 'remote.git'), 'for-each-ref']).stdout.toString();
  assert.equal(refs, '', 'nothing reached the repository outside');
});

// The adapter diffs a run's clone outside the sandbox, against a copy of the fresh .git in the run's OUT,
// "which no sandboxed command can read or write". The profile denies the run's OWN out; a sibling run's
// (another call in flight, here a second prepared run) sits under RUNS, which the profile denies; /private/var/folders is no longer writable.
test('a command in one run cannot plant a filter in a sibling run\'s out/git and have it run when that run\'s diff is taken', { skip: !KERNEL }, async () => {
  const control = prepareClone({ cwd: world().work });
  try {
    // Control: the channel is real — a filter in the git copy plus an attribute in the work tree runs under cloneDiff.
    const git = (run, ...a) => execFileSync('git', ['--git-dir', join(run.out, 'git'), ...a]);
    git(control, 'config', 'filter.x.clean', `touch ${sq(mark('control'))}`);
    writeFileSync(join(control.clone, '.gitattributes'), '* filter=x\n');
    writeFileSync(join(control.clone, 'README.md'), 'demo\nedited\n');
    cloneDiff(control.clone);
    assert.equal(existsSync(mark('control')), true, 'control: the filter runs when the git copy is writable');
  } finally {
    removeRun(control.runDir);
  }

  const sibling = prepareClone({ cwd: world().work });
  try {
    const w = world({
      edit: (s) => {
        s.shell = [
          `git --git-dir ${sq(join(sibling.out, 'git'))} config filter.x.clean ${sq(`touch ${mark('sibling')}`)}`,
          `printf '* filter=x\\n' > ${sq(join(sibling.clone, '.gitattributes'))}`,
          `printf 'edited\\n' >> ${sq(join(sibling.clone, 'README.md'))}`,
        ].join('; ');
      },
    });
    const r = await w.repro();
    assert.equal(r.isError, undefined, r.text);
    cloneDiff(sibling.clone); // what the sibling run's adapter does when its model has finished
    assert.equal(existsSync(mark('sibling')), false, 'another run\'s model wrote into this run\'s git copy and the adapter ran its filter, unsandboxed');
  } finally {
    removeRun(sibling.runDir);
  }
});

// Found while building this file: the runtime kills the child's process group only on a timeout or a cancel, so a
// command the model backgrounds (`nohup … &`) outlives the call — still under the profile, which once let it write
// anywhere under /private/var/folders (now only its clone and tmp). Together with the sibling-out/git test above, it turns that cross-run write
// from "needs two calls in flight" into "any later call": the leftover can wait for the next run's directory.
test('a process the model backgrounds does not outlive the call', { skip: !KERNEL }, async () => {
  const tag = String(4000000 + (process.pid % 100000)); // a sleep length no other process uses
  const w = world({ edit: (s) => { s.shell = `nohup /bin/sleep ${tag} >/dev/null 2>&1 & echo started`; } });
  try {
    const r = await w.repro();
    assert.equal(r.isError, undefined, r.text);
    await new Promise((res) => setTimeout(res, 300));
    const alive = spawnSync('pgrep', ['-f', `sleep ${tag}`]).stdout.toString().trim();
    assert.equal(alive, '', `still running after the call: pid ${alive}`);
  } finally {
    spawnSync('pkill', ['-f', `sleep ${tag}`]);
  }
});

/* ── second pass: mutants the first file and the plan's file let live ──────── */

const CLOSED_TEXT = 'Error: mistral_security_repro is closed — set OMELETTE_ALLOW_REPRO=1 on the unit\'s registration to let the model execute code in a disposable clone (OMELETTE_ALLOW_WRITE does not open it)';

test('OMELETTE_ALLOW_WRITE in any true word does not open repro; the closed gate answers before the platform does', async () => {
  for (const v of ['1', 'true', 'on', 'yes']) assert.equal(reproAllowed({ OMELETTE_ALLOW_WRITE: v }), false, v);
  const w = world();
  const r = await withEnv({ OMELETTE_ALLOW_REPRO: undefined, OMELETTE_ALLOW_WRITE: '1' }, () => w.call());
  assert.deepEqual(r, { text: CLOSED_TEXT, isError: true });
  // Closed AND unsupported: the gate is named, not the platform.
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, enumerable: true, writable: false });
  try {
    const both = await withEnv({ OMELETTE_ALLOW_REPRO: undefined }, () => w.call());
    assert.deepEqual(both, { text: CLOSED_TEXT, isError: true });
  } finally {
    Object.defineProperty(process, 'platform', saved);
  }
  assert.equal(w.spawns().length, 0);
});

test('reproSupported wants an EXECUTABLE sandbox-exec, not any file at the path', () => {
  const f = join(BASE, 'fake-sandbox-exec');
  writeFileSync(f, '#!/bin/sh\n');
  chmodSync(f, 0o644);
  assert.equal(reproSupported({ platform: 'darwin', sandboxExec: f }).ok, false);
  chmodSync(f, 0o755);
  assert.deepEqual(reproSupported({ platform: 'darwin', sandboxExec: f }), { ok: true });
});

test('without a cwd argument the clone is of the process\'s own directory', { skip: !DARWIN }, async () => {
  const w = world({ uncommitted: { 'wip.txt': 'x\n' } });
  const before = process.cwd();
  process.chdir(w.work);
  try {
    const r = await w.repro({ cwd: undefined });
    assert.equal(r.isError, undefined, r.text);
  } finally {
    process.chdir(before);
  }
  assert.equal(r_first(w.spawns()).files.includes('README.md'), true);
});
const r_first = (a) => a[0];

test('the hard kill handed to the runtime is reproTimeoutS, not timeoutS', { skip: !DARWIN }, async () => {
  const w = world();
  assert.equal((await w.repro()).isError, undefined);
  assert.equal(w.spawnOpts[0].hardKillMs, 2400 * 1000);
  const c = world({ config: { reproTimeoutS: 3000, timeoutS: 900 } });
  assert.equal((await c.repro()).isError, undefined);
  assert.equal(c.spawnOpts[0].hardKillMs, 3000 * 1000);
});

test('the one rule recognises the repro deadline and hard-kill markers, and a unit-key mismatch is not a marker of another unit', () => {
  assert.ok(PARTIAL_MARK_RE.test(partialMark('mistral', 'deadline', { limit: 2385, key: 'reproTimeoutS' })));
  assert.ok(PARTIAL_MARK_RE.test(partialMark('mistral', 'killed', { after: 2400, key: 'reproTimeoutS' })));
  assert.ok(PARTIAL_MARK_RE.test(partialMark('mistral', 'deadline', { limit: 1485 })));
});

test('appendPatch: every model-written heading (repeated, any case, any level, indented) is demoted; the adapter\'s is the only one left; the fence outgrows the diff\'s backticks', () => {
  const text = ['intro', '## proposed patch (not applied)', 'mid', '### Proposed Patch (not applied)', '   # proposed patch (not applied)', 'end'].join('\n');
  const out = appendPatch(text, 'diff --git a/x b/x\n+```\n');
  const heads = out.split('\n').filter((l) => /^[ \t]*#+[ \t]*proposed patch \(not applied\)/i.test(l));
  assert.deepEqual(heads, ['## proposed patch (not applied)']);
  assert.equal(out.split('\n').filter((l) => l.startsWith('> (model-written, not the adapter\'s) ')).length, 3);
  assert.ok(out.endsWith('\n\n## proposed patch (not applied)\n\n````diff\ndiff --git a/x b/x\n+```\n````'), out.slice(-120));
  // A longer run in the diff still gets a longer fence; no run keeps the minimum of three.
  assert.ok(appendPatch('t', '+`````\n').endsWith('``````diff\n+`````\n``````'));
  assert.ok(appendPatch('t', '+x\n').endsWith('```diff\n+x\n```'));
});

test('cloneDiff names a file under a directory holding a .git entry however deep it sits, even when the entry is no repository git recognises', () => {
  const d = join(BASE, 'deep-gitfile');
  gitRepo(d);
  const run = prepareClone({ cwd: d });
  try {
    mkdirSync(join(run.clone, 'sub', 'a', 'b'), { recursive: true });
    writeFileSync(join(run.clone, 'sub', '.git'), 'gitdir: /nonexistent\n');
    writeFileSync(join(run.clone, 'sub', 'a', 'b', 'f'), 'f\n');
    const diff = cloneDiff(run.clone);
    assert.match(diff, /^\(nested repository sub\/a\/b\/f not diffed\)$/m);
    assert.doesNotMatch(diff, /^\+\+\+ b\/sub\//m);
  } finally {
    removeRun(run.runDir);
  }
});

test('the profile refuses /usr/bin/automator, and denies $HOME/.omelette on its own line when the fleet home lives elsewhere', { skip: !KERNEL }, () => {
  const base = realpathSync(mkdtempSync(join(BASE, 'sb-')));
  const fleet = join(base, 'elsewhere-fleet');
  const { dir } = ensureHome({ home: fleet, profile: 'repro' });
  const [clone, tmpd, home, out] = ['clone', 'tmp', 'home', 'out'].map((n) => join(base, n));
  for (const d of [clone, tmpd, home, out, join(home, '.omelette')]) mkdirSync(d);
  writeFileSync(join(home, '.omelette', 'fleet.config.json'), 'secret-in-home-omelette\n');
  const env = { PATH: '/usr/bin:/bin', HOME: home, OMELETTE_REPRO_CLONE: clone, OMELETTE_REPRO_TMP: tmpd, OMELETTE_FLEET_HOME: fleet, OMELETTE_REPRO_OUT: out, OMELETTE_REPRO_RUNS: join(base, 'runs'), OMELETTE_REPRO_RUN: base, OMELETTE_REPRO_TMPROOT: realpathSync(tmpdir()) };
  const run = (cmd) => spawnSync(join(dir, 'shell.sh'), ['-c', cmd], { env, encoding: 'utf8' });
  const cat = run('cat "$HOME/.omelette/fleet.config.json"');
  assert.notEqual(cat.status, 0);
  assert.doesNotMatch(cat.stdout, /secret-in-home-omelette/);
  assert.match(cat.stderr, /Operation not permitted/);
  const auto = run('/usr/bin/automator --version; echo auto=$?');
  assert.match(auto.stdout, /^auto=126$/m, auto.stdout + auto.stderr);
  assert.match(auto.stderr, /Operation not permitted/);
});
