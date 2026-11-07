// 1.9.0 Task 3 (plan docs/superpowers/plans/2026-11-06-1.9.0-mistral-unit.md
// Task 3; spec docs/superpowers/specs/2026-11-06-mistral-unit-design.md §3):
// mistral_security_repro — its own gate, the disposable clone, the Seatbelt
// under every command, the diff the adapter appends. A fake `vibe` (Task 2's
// pattern: VIBE_BIN=node, its path prepended to argv) runs one scripted command
// the way Vibe runs a model's command — `<the home's [tools.bash] shell> -c
// <command>` in the workdir, with its own env — so on macOS the real wrapper and
// the real kernel profile run; then it writes a scripted export.json. HOME is a
// temp dir outside every root the profile lets a command write (/private/tmp
// on macOS, not /private/var/folders), so a write there is a write outside;
// OMELETTE_HOME is <HOME>/.omelette.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import unit, { REPRO_PREFIX } from '../units/mistral/adapter.mjs';
import { PARTIAL_MARK_RE } from '../core/partial.mjs';
import { ensureHome } from '../units/mistral/home.mjs';
import {
  NODEUP_NONE, appendPatch, assertRun, clearRun, cloneDiff, fixModes, neutraliseModelText, nodeEnv, nodeReach, nodeUp, prepareClone, regexLiteral, removeRun, reproAllowed, reproSupported, runsRoot,
} from '../units/mistral/repro.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const DARWIN = process.platform === 'darwin';
// sandbox-exec cannot nest: inside a sandbox even an allow-everything profile fails, and the kernel rows skip.
const KERNEL = DARWIN && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-mistral-t3-')));
const HOMES = DARWIN ? '/private/tmp' : BASE;
const made = [BASE];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const CLOSED = 'Error: mistral_security_repro is closed — set OMELETTE_ALLOW_REPRO=1 on the unit\'s registration to let the model execute code in a disposable clone (OMELETTE_ALLOW_WRITE does not open it)';
const RESOLVED_ENV = ['VIBE_HOME', 'TMPDIR', 'OMELETTE_FLEET_HOME', 'OMELETTE_REPRO_CLONE', 'OMELETTE_REPRO_TMP', 'OMELETTE_REPRO_OUT', 'OMELETTE_REPRO_RUNS', 'OMELETTE_REPRO_RUN', 'OMELETTE_REPRO_SRC'];

const FAKE = join(BASE, 'fake-vibe.mjs');
writeFileSync(FAKE, [
  'import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";',
  'import { spawnSync } from "node:child_process";',
  'import { join } from "node:path";',
  'const [scenarioPath, ...argv] = process.argv.slice(2);',
  'const sc = JSON.parse(readFileSync(scenarioPath, "utf8"));',
  'const opt = (f) => argv[argv.indexOf(f) + 1];',
  'const outDir = opt("--output-dir");',
  'const workdir = opt("--workdir");',
  'const homeConfig = readFileSync(join(process.env.VIBE_HOME, "config.toml"), "utf8");',
  'const shell = JSON.parse(/^shell = (".*")$/m.exec(homeConfig)[1]);',
    // The wrapper hands bash the run's tmp as HOME (review fix round): a command names the operator's home as $T_HOME.
  'const ran = sc.shell ? spawnSync(shell, ["-c", sc.shell], { cwd: workdir, env: { ...process.env, T_HOME: process.env.HOME }, encoding: "utf8" }) : null;',
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
  '  remotes: spawnSync("git", ["-C", workdir, "remote"], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).stdout,',
  '  reflog: existsSync(join(workdir, ".git", "logs")),',
  '}) + "\\n");',
  // The clone swapped for a link from outside the sandbox: what the kernel refuses a command, the adapter must still catch.
  'if (sc.swap) { rmSync(workdir, { recursive: true, force: true }); symlinkSync(sc.swap, workdir); }',
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
function world({ config, edit = () => {}, files, uncommitted, homes = HOMES, hardKillMs } = {}) {
  const root = join(BASE, `w${++n}`);
  mkdirSync(root);
  const home = mkdtempSync(join(homes, 'omelette-mistral-t3-home-'));
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
  const env = { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: fleet, VIBE_BIN: process.execPath };
  const records = [];
  let retries = 0;
  const rt = createUnitRuntime({
    ...unit,
    tools: unit.tools.map((t) => (t.run ? {
      ...t,
      run: (a, ctx) => t.run(a, {
        ...ctx,
        retry: (fn, o) => { retries++; return ctx.retry(fn, o); },
        spawn: (o) => ctx.spawn({ ...o, ...(hardKillMs ? { hardKillMs } : {}), args: [FAKE, scenarioPath, ...o.args] }),
      }),
    } : t)),
  }, { env, onResult: (r) => records.push(r) });
  const spawns = () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const call = (args = {}) => rt.callTool('mistral_security_repro', { prompt: 'reproduce the auth bug', cwd: work, ...args });
  // The adapter takes HOME from its own process (resolved): the world's home is that HOME for the call.
  const repro = (args = {}) => withEnv({ OMELETTE_ALLOW_REPRO: '1', HOME: home }, () => call(args));
  const review = () => withEnv({ HOME: home }, () => rt.callTool('mistral_security_review', { prompt: 'find the auth bug', cwd: work }));
  return { root, home, fleet, work, head, records, spawns, retries: () => retries, call, repro, review };
}

/** The values passed after each `--enabled-tools`, in order. */
const enabledTools = (argv) => argv.flatMap((a, i) => (a === '--enabled-tools' ? [argv[i + 1]] : []));

/* ── everywhere ────────────────────────────────────────────────────────────── */

test('the gate: closed without OMELETTE_ALLOW_REPRO, and OMELETTE_ALLOW_WRITE=mistral does not open it', async () => {
  for (const v of ['1', 'true', 'on', 'yes', ' YES ']) assert.equal(reproAllowed({ OMELETTE_ALLOW_REPRO: v }), true, v);
  for (const v of [undefined, '', '0', 'no', 'mistral']) assert.equal(reproAllowed({ OMELETTE_ALLOW_REPRO: v }), false, String(v));
  assert.equal(reproAllowed({ OMELETTE_ALLOW_WRITE: 'mistral' }), false);
  const w = world();
  for (const vars of [{ OMELETTE_ALLOW_REPRO: undefined }, { OMELETTE_ALLOW_REPRO: undefined, OMELETTE_ALLOW_WRITE: 'mistral' }]) {
    // A cwd that does not exist: the gate answers before checkCwd.
    const r = await withEnv(vars, () => w.call({ cwd: join(w.root, 'missing') }));
    assert.deepEqual(r, { text: CLOSED, isError: true });
  }
  assert.equal(w.spawns().length, 0);
  assert.equal(existsSync(join(w.fleet, 'vibe')), false, 'refused before ensureHome');
});

test('repro refuses with the macOS-only reason; review still runs', async () => {
  assert.deepEqual(reproSupported({ platform: 'linux' }), { ok: false, reason: 'repro: macOS only (1.9.0) — sandbox-exec is not available on linux' });
  assert.equal(reproSupported({ platform: 'darwin', sandboxExec: join(BASE, 'no-sandbox-exec') }).ok, false);
  const w = world();
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, enumerable: true, writable: false });
  try {
    const r = await w.repro();
    assert.equal(r.isError, true);
    assert.equal(r.text, 'Error: repro: macOS only (1.9.0) — sandbox-exec is not available on linux');
    assert.equal(w.spawns().length, 0);
    const review = await w.review();
    assert.equal(review.isError, undefined, review.text);
    assert.equal(w.spawns().length, 1);
  } finally {
    Object.defineProperty(process, 'platform', saved);
  }
});

/* ── macOS: the tool through the fake ──────────────────────────────────────── */

test('cwd that is not a work tree is refused before any spawn', { skip: !DARWIN }, async () => {
  const w = world();
  const plain = join(w.root, 'plain');
  mkdirSync(plain);
  const r = await w.repro({ cwd: plain });
  assert.equal(r.isError, true);
  assert.match(r.text, /is not a git work tree \(git rev-parse --is-inside-work-tree/);
  assert.equal(w.spawns().length, 0);
});

test('argv: bash only, --max-price 3, --time-limit 2385, workdir is the clone, VIBE_HOME is the repro home', { skip: !DARWIN }, async () => {
  const w = world();
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  const [s] = w.spawns();
  const clone = s.workdir;
  assert.equal(basename(clone), 'clone');
  const out = join(dirname(clone), 'out');
  assert.deepEqual(s.argv, [
    '--workdir', clone, '--trust', '--agent', 'auto-approve',
    '--enabled-tools', 'bash',
    '--model', 'mistral-large-4-0-3', '--max-turns', '150', '--max-price', '3', '--time-limit', '2385',
    '--output', 'text', '--output-dir', out, '--prompt-file', join(out, 'prompt.md'),
  ]);
  assert.equal(s.cwd, clone);
  assert.equal(s.env.VIBE_HOME, realpathSync(join(w.fleet, 'vibe', 'repro')));
  assert.equal(s.prompt, REPRO_PREFIX + 'reproduce the auth bug');
  assert.equal(s.promptMode, 0o600);
});

test('the clone is HEAD only and the answer says the tree was dirty', { skip: !DARWIN }, async () => {
  const w = world({ uncommitted: { 'wip.txt': 'not committed\n' } });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  const [s] = w.spawns();
  assert.ok(s.files.includes('README.md'), s.files.join(' '));
  assert.ok(!s.files.includes('wip.txt'), 'the uncommitted file is not in the clone');
  const line = `_(the clone is HEAD ${w.head}; uncommitted changes in ${w.work} were not in it)_`;
  assert.equal(r.text.split('\n')[0], line);
  // Review fix round (B1): the model is told, without the work tree's path; the clone has no remote naming it.
  assert.ok(s.prompt.includes(`_(the clone is HEAD ${w.head}; the work tree had uncommitted changes, which are not in this clone)_`), s.prompt);
  assert.ok(!s.prompt.includes(w.work) && !s.prompt.includes(realpathSync(w.work)), 'the prompt names no work tree');
  assert.equal(s.remotes, '', 'the clone keeps no remote');
  assert.equal(s.reflog, false, 'the clone keeps no reflog, whose clone line names the work tree');
});

test('a committed .vibe/config.toml is gone from the clone before the spawn', { skip: !DARWIN }, async () => {
  const w = world({ files: { '.vibe/config.toml': '[tools.bash]\nshell = "/bin/bash"\n' } });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  assert.equal(w.spawns()[0].vibeInWorkdir, false);
  // Dropping it is the adapter's doing, not the model's: it is not proposed as a patch.
  assert.ok(r.text.endsWith('\n\n_(clone unchanged)_'), r.text);
});

test('the clone lives in a run-* under runsRoot(), not the fleet home', { skip: !DARWIN }, async () => {
  const w = world();
  assert.equal((await w.repro()).isError, undefined);
  const { workdir } = w.spawns()[0];
  assert.equal(dirname(dirname(workdir)), realpathSync(runsRoot()), workdir);
  assert.match(basename(dirname(workdir)), /^run-/);
  assert.ok(!workdir.startsWith(w.fleet) && !workdir.startsWith(realpathSync(w.fleet)), workdir);
});

test('every path in the child\'s env is resolved; TMPROOT is the resolved temp root, regex-escaped', { skip: !DARWIN }, async () => {
  // A symlinked temp root for the clone, and a fleet home reached through /tmp -> /private/tmp.
  const real = join(BASE, 'real.tmp');
  mkdirSync(real);
  const link = join(BASE, 'link-tmp');
  symlinkSync(real, link);
  const w = world({ homes: '/tmp' });
  const r = await withEnv({ TMPDIR: link }, () => w.repro());
  assert.equal(r.isError, undefined, r.text);
  const [s] = w.spawns();
  for (const k of RESOLVED_ENV) {
    assert.ok(s.env[k], `${k} is set`);
    assert.equal(s.env[k], s.resolved[k], `${k} is resolved`);
  }
  // HOME, which the wrapper hands the profile as it stands: the adapter's /tmp/… reaches Vibe as /private/tmp/….
  assert.ok(w.home.startsWith('/tmp/'), w.home);
  assert.equal(s.env.HOME, realpathSync(w.home));
  // NODE and NODEUP are built from the resolved HOME and the node this process runs on.
  assert.deepEqual({ node: s.env.OMELETTE_REPRO_NODE, up: s.env.OMELETTE_REPRO_NODEUP },
    nodeReach({ home: s.env.HOME, prefix: realpathSync(dirname(dirname(process.execPath))), binary: realpathSync(process.execPath) }));
  assert.ok(s.env.OMELETTE_REPRO_CLONE.startsWith(`${real}/`), 'the clone went under the symlinked temp root');
  assert.ok(s.env.OMELETTE_FLEET_HOME.startsWith('/private/tmp/'), s.env.OMELETTE_FLEET_HOME);
  // The profile reads TMPROOT inside a regex: the `.` of real.tmp reaches it escaped.
  assert.equal(s.env.OMELETTE_REPRO_TMPROOT, `${regexLiteral(BASE)}/real\\.tmp`);
});

test('the clone is removed after the call; reproKeep keeps it and the answer names the path', { skip: !DARWIN }, async () => {
  const w = world();
  assert.equal((await w.repro()).isError, undefined);
  assert.equal(existsSync(dirname(w.spawns()[0].workdir)), false);
  const k = world({ config: { reproKeep: true } });
  const r = await k.repro();
  assert.equal(r.isError, undefined, r.text);
  const { workdir } = k.spawns()[0];
  made.push(dirname(workdir));
  assert.ok(existsSync(join(workdir, 'README.md')));
  assert.equal(r.text.split('\n').at(-1), `_(clone kept: ${workdir})_`);
});

test('an unchanged clone says so', { skip: !DARWIN }, async () => {
  const w = world();
  const r = await w.repro();
  assert.match(r.text, /\n\n_\(vibe: [^\n]*\)_\n\n_\(clone unchanged\)_$/);
  assert.ok(!r.text.includes('proposed patch'));
});

// T3 round 2, item 11: Vibe's read_file follows a symlink out of the workdir, so repro hands it bash only.
test('repro hands Vibe bash only: one --enabled-tools bash, and a reproTools key left in the config opens nothing more', { skip: !DARWIN }, async () => {
  const w = world({ config: { reproTools: 'bash,read_file,grep,edit' } });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  const [s] = w.spawns();
  assert.deepEqual(enabledTools(s.argv), ['bash']);
  assert.deepEqual(s.argv.slice(0, 2), ['--workdir', s.workdir]);
  assert.equal(basename(s.workdir), 'clone');
  assert.ok(s.homeConfig.split('\n').includes('outside_workdir = "deny"'));
});

test('no retry on a failed repro run', { skip: !DARWIN }, async () => {
  const w = world({ edit: (s) => { s.export = null; s.code = 1; } });
  const r = await w.repro();
  assert.equal(r.isError, true);
  assert.match(r.text, /no export\.json in \S+\/out \(exit 1\)/);
  assert.equal(w.spawns().length, 1);
  assert.equal(w.retries(), 0, 'ctx.retry is never called');
});

// Review fix round (B4): a backend failure is retried by review only; a repro run is never re-run.
test('repro: an export naming a backend failure is one run and the refusal, never retried', { skip: !DARWIN }, async () => {
  const w = world({ edit: (s) => { Object.assign(s.export, { outcome: 'infrastructure_failure', error: { code: 'backend_error', message: 'upstream 503' } }); } });
  const r = await w.repro();
  assert.equal(r.isError, true);
  assert.match(r.text, /mistral: Vibe's backend failed \(upstream 503\) — not retried: a repro run is never re-run$/);
  assert.equal(w.spawns().length, 1);
  assert.equal(w.retries(), 0);
});

test('a repro deadline names 2385s and mistral.reproTimeoutS', { skip: !DARWIN }, async () => {
  const w = world({ edit: (s) => { s.export.outcome = 'deadline'; s.export.exit_code = 3; s.code = 3; } });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  assert.ok(r.text.includes('\n\n[mistral: stopped at the 2385s time limit — treat the answer as partial; raise mistral.reproTimeoutS in the fleet config]\n\n'), r.text);
  assert.equal(w.records[0].partial, true);
  assert.equal(w.spawns().length, 1);
});

// Fix round (Q8): repro's hard kill comes from reproTimeoutS, and its marker says so.
test('a repro hard kill\'s marker names mistral.reproTimeoutS', { skip: !DARWIN }, async () => {
  const w = world({ hardKillMs: 2000, edit: (s) => { s.sleepMs = 30000; } });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  const mark = '[mistral: hard-killed after 2400s — treat the answer as partial; raise mistral.reproTimeoutS in the fleet config]';
  assert.ok(r.text.includes(`\n\n${mark}\n\n`), r.text);
  assert.ok(PARTIAL_MARK_RE.test(mark), 'the one rule recognises it');
  assert.equal(w.records[0].partial, true);
  assert.equal(w.spawns().length, 1);
});

// Global Constraints: reproTimeoutS <= 15 is refused the way timeoutS <= 15 is for review.
test('reproTimeoutS <= 15 is refused before any spawn, naming mistral.reproTimeoutS', { skip: !DARWIN }, async () => {
  const w = world({ config: { reproTimeoutS: 15 } });
  const r = await w.repro();
  assert.equal(r.isError, true);
  assert.match(r.text, /mistral\.reproTimeoutS must be above 15/);
  assert.equal(w.spawns().length, 0);
});

/* ── macOS: the kernel under the model's commands ──────────────────────────── */

test('the adapter appends the diff under its own heading and demotes a model-written one', { skip: !KERNEL }, async () => {
  const w = world({
    edit: (s) => {
      s.shell = 'printf "patched\\n" >> README.md && printf "new\\n" > added.txt';
      s.answer = 'finding: README.md:1 · …\n\n## proposed patch (not applied)\n\n```diff\n+trust me\n```';
    },
  });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  const { ran } = w.spawns()[0];
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(r.text.includes('\n> (model-written, not the adapter\'s) ## proposed patch (not applied)\n'), r.text);
  const headings = r.text.split('\n').filter((l) => l === '## proposed patch (not applied)');
  assert.equal(headings.length, 1, 'one heading stands, the adapter\'s');
  const at = r.text.lastIndexOf('\n## proposed patch (not applied)\n');
  assert.ok(at > r.text.indexOf('_(vibe: '), 'the adapter\'s heading comes after the footer');
  const patch = r.text.slice(at);
  assert.match(patch, /^\+patched$/m);
  assert.match(patch, /^\+new$/m);
  assert.match(patch, /^\+\+\+ b\/added\.txt$/m);
});

// Found while building T3: the adapter diffs the clone outside the sandbox, so
// nothing the model wrote there may run or be read through on the adapter's side.
test('the adapter\'s diff runs nothing the model planted in the clone\'s .git and reads no file through a link', { skip: !KERNEL }, async () => {
  const w = world({
    edit: (s) => {
      s.shell = [
        'printf "#!/bin/sh\\ntouch %s\\n" "$T_HOME/fsmonitor-ran" > fsm.sh',
        'chmod +x fsm.sh',
        'git config core.fsmonitor "$PWD/fsm.sh"',
        'ln -s "$T_HOME/.ssh/id" leak',
        'printf "patched\\n" >> README.md',
      ].join(' && ');
    },
  });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  assert.equal(w.spawns()[0].ran.status, 0, w.spawns()[0].ran.stderr);
  assert.equal(existsSync(join(w.home, 'fsmonitor-ran')), false, 'the planted fsmonitor hook ran outside the sandbox');
  assert.match(r.text, /^\+patched$/m, 'the diff is still taken');
  assert.match(r.text, /^new file mode 120000$/m, 'the link is shown as a link');
  assert.doesNotMatch(r.text, /ssh-secret-bytes/);
});

// Fix round (Q9): a big diff is cut at 1 MB, never at the cost of the answer.
test('a 3 MB file in the clone: the patch is cut at 1 MB with the truncation line, the answer before it intact', { skip: !KERNEL }, async () => {
  const w = world({ edit: (s) => { s.shell = '/usr/bin/yes 0123456789abcdef0123456789abcdef | /usr/bin/head -c 3145728 > big.txt'; } });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text.slice(0, 2000));
  assert.ok(r.text.startsWith('finding: README.md:1 · …\n\n_(vibe: model=mistral-large-4-0-3 · outcome=finished · steps=7 · '), r.text.slice(0, 300));
  const at = r.text.indexOf('\n## proposed patch (not applied)\n');
  assert.ok(at > r.text.indexOf('_(vibe: '), 'the heading follows the footer');
  const patch = r.text.slice(at);
  assert.match(patch, /^\+\+\+ b\/big\.txt$/m);
  assert.ok(patch.endsWith('\n… diff truncated at 1 MB — set mistral.reproKeep=true to inspect the clone\n```'), patch.slice(-300));
  assert.ok(patch.length < 1024 * 1024 + 1024, `patch ${patch.length} bytes`);
});

// Fix round, item 4: a repository the model nests in the clone is never entered by the adapter's git.
test('a nested repository in the clone is named, not diffed, and its config never runs', { skip: !KERNEL }, async () => {
  const w = world({
    edit: (s) => {
      s.shell = [
        'git init -q nested',
        'printf x > nested/f',
        'git -C nested add f',
        'git -C nested -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false commit -qm n',
        'git -C nested config core.fsmonitor "touch $T_HOME/pwned"',
        'printf "patched\\n" >> README.md',
      ].join(' && ');
    },
  });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  assert.equal(w.spawns()[0].ran.status, 0, w.spawns()[0].ran.stderr);
  assert.equal(existsSync(join(w.home, 'pwned')), false, 'the nested repository\'s fsmonitor ran outside the sandbox');
  assert.match(r.text, /^\(nested repository nested not diffed\)$/m);
  assert.match(r.text, /^\+patched$/m, 'the tracked edit is in the patch');
});

test('the Seatbelt holds: a write to $HOME/x, a curl and a read of $HOME/.ssh are refused, a write in the clone and a read of the clone succeed', { skip: !KERNEL }, async () => {
  // A listener that answers, so a refused connect is the profile's doing and not a dead network.
  const server = createServer((req, res) => res.end('reachable')).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const w = world({
      edit: (s) => {
        s.shell = `echo a > "$T_HOME/x"; echo b > "$OMELETTE_REPRO_CLONE/y"; cat "$OMELETTE_REPRO_CLONE/y"; ls "$T_HOME/.ssh"; cat "$T_HOME/.ssh/id"; /usr/bin/curl -s --max-time 3 http://127.0.0.1:${port}/; echo curl=$?`;
      },
    });
    const r = await w.repro();
    assert.equal(r.isError, undefined, r.text);
    const { ran } = w.spawns()[0];
    assert.equal(existsSync(join(w.home, 'x')), false);
    assert.match(ran.stdout, /^b$/m);
    assert.doesNotMatch(ran.stdout, /ssh-secret-bytes|reachable/);
    assert.match(ran.stdout, /^curl=[1-9]\d*$/m);
    assert.match(ran.stderr, /Operation not permitted/);
    assert.match(r.text, /^\+\+\+ b\/y$/m, 'the write in the clone is in the patch');
    const control = await new Promise((resolve) => execFile('/usr/bin/curl', ['-s', '--max-time', '3', `http://127.0.0.1:${port}/`], (err, stdout) => resolve(err ? `ERR ${err.message}` : stdout)));
    assert.equal(control, 'reachable', 'outside the sandbox the listener answers');
  } finally {
    server.close();
  }
});

test('a hard link into the clone does not reach the operator\'s file', { skip: !KERNEL }, async () => {
  const w = world({
    edit: (s) => {
      s.shell = 'printf x >> "$T_HOME/secret"; echo direct=$?; ln "$T_HOME/secret" "$OMELETTE_REPRO_CLONE/z" && printf x >> "$OMELETTE_REPRO_CLONE/z"; echo link=$?';
    },
  });
  writeFileSync(join(w.home, 'secret'), 'operator-secret\n');
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  assert.match(w.spawns()[0].ran.stdout, /^direct=1$/m, 'control: $HOME is outside the writable roots');
  assert.equal(readFileSync(join(w.home, 'secret'), 'utf8'), 'operator-secret\n');
  assert.doesNotMatch(r.text, /operator-secret/);
});

test('a command cannot hand work to a process outside the profile: open, osascript, launchctl refused; node --test and git run', { skip: !KERNEL }, async () => {
  const sh = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  const w = world({
    edit: (s) => {
      s.shell = [
        '/usr/bin/open /usr/bin/true; echo open=$?',
        '/usr/bin/osascript -e 1; echo osascript=$?',
        '/bin/launchctl list >/dev/null; echo launchctl=$?',
        `${sh(process.execPath)} --test t.test.mjs; echo node=$?`,
        'git status --porcelain; echo git=$?',
      ].join('; ');
    },
  });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  const { ran } = w.spawns()[0];
  for (const tool of ['open', 'osascript', 'launchctl']) assert.match(ran.stdout, new RegExp(`^${tool}=126$`, 'm'), ran.stdout + ran.stderr);
  assert.equal(ran.stderr.match(/Operation not permitted/g).length, 3, ran.stderr);
  assert.match(ran.stdout, /^node=0$/m, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /^git=0$/m, ran.stdout + ran.stderr);
});

test('the run\'s output dir is Vibe\'s: a command can neither read the prompt nor rewrite export.json', { skip: !KERNEL }, async () => {
  const w = world({ edit: (s) => { s.shell = 'cat "$OMELETTE_REPRO_OUT/prompt.md"; echo read=$?; echo x > "$OMELETTE_REPRO_OUT/export.json"; echo write=$?'; } });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  const { ran } = w.spawns()[0];
  assert.match(ran.stdout, /^read=1$/m);
  assert.match(ran.stdout, /^write=1$/m);
  assert.equal(ran.stderr.match(/Operation not permitted/g).length, 2, ran.stderr);
  assert.doesNotMatch(ran.stdout, /reproduce the auth bug/);
});

test('the profile parses: sandbox-exec -D … -f repro.sb /usr/bin/true exits 0', { skip: !KERNEL }, () => {
  const fleet = join(BASE, 'parse-fleet');
  const { dir } = ensureHome({ home: fleet, profile: 'repro' });
  const d = join(BASE, 'parse-dir');
  mkdirSync(d);
  const r = spawnSync('/usr/bin/sandbox-exec', [
    '-D', `CLONE=${d}`, '-D', `TMP=${d}`, '-D', `HOME=${d}`, '-D', `FLEET=${fleet}`, '-D', `OUT=${d}`,
    '-D', `RUNS=${d}`, '-D', `RUN=${d}`, '-D', `TMPROOT=${d}`, '-D', `SRC=${d}`, '-D', `NODE=${d}`, '-D', `NODEUP=${NODEUP_NONE}`,
    '-f', join(dir, 'repro.sb'), '/usr/bin/true',
  ]);
  assert.equal(r.status, 0, r.stderr.toString());
});

/* ── T3 round 2: RUNS, the clone made the adapter's own again, the model's text ── */

const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/** Run `fn` with TMPDIR at a fresh dir of ours, so runsRoot() lives under it. */
function withTmpRoot(fn) {
  const root = realpathSync(mkdtempSync(join(BASE, 'tmproot-')));
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try { return fn(root); } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  }
}

test('runsRoot is a 0700 directory of ours: a drifted mode is put back; a symlink or a file at its path is refused before any clone', () => {
  const d = join(BASE, 'runs-root-repo');
  gitRepo(d);
  withTmpRoot((root) => {
    const parent = join(root, 'omelette-mistral-repro');
    assert.equal(runsRoot(), parent);
    assert.equal(lstatSync(parent).mode & 0o777, 0o700);
    chmodSync(parent, 0o755);
    runsRoot();
    assert.equal(lstatSync(parent).mode & 0o777, 0o700, 'a drifted mode is restored');
    rmSync(parent, { recursive: true });
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, parent);
    assert.throws(() => prepareClone({ cwd: d }), { message: `mistral: ${parent} is not a directory — remove it` });
    assert.deepEqual(readdirSync(elsewhere), [], 'nothing was made through the link');
    unlinkSync(parent);
    writeFileSync(parent, 'x');
    assert.throws(() => runsRoot(), { message: `mistral: ${parent} is not a directory — remove it` });
  });
});

test('RUNS: a command reads and writes its own clone, never a sibling run\'s clone nor another unit\'s temp dir; a link in the clone to ~/.ssh stays unreadable', { skip: !KERNEL }, async () => {
  const sib = join(BASE, 'runs-sibling');
  gitRepo(sib);
  const sibling = prepareClone({ cwd: sib });
  // Another unit's spool, as its own adapter names it, under the same OS temp root.
  const codex = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-codex-')));
  writeFileSync(join(codex, 'f'), 'codex-spool-bytes\n');
  try {
    const w = world({
      edit: (s) => {
        s.shell = [
          'ln -s "$T_HOME/.ssh/id" leak; cat leak; echo link=$?',
          'echo plain > plain.txt; cat plain.txt; echo own=$?',
          `cat ${sq(join(sibling.clone, 'README.md'))}; echo sibread=$?`,
          `echo x >> ${sq(join(sibling.clone, 'README.md'))}; echo sibwrite=$?`,
          `cat ${sq(join(codex, 'f'))}; echo codexread=$?`,
          `echo x > ${sq(join(codex, 'g'))}; echo codexwrite=$?`,
        ].join('; ');
      },
    });
    const r = await w.repro();
    assert.equal(r.isError, undefined, r.text);
    const { ran } = w.spawns()[0];
    assert.doesNotMatch(ran.stdout, /ssh-secret-bytes|codex-spool-bytes|^demo$/m);
    for (const k of ['link', 'sibread', 'sibwrite', 'codexread', 'codexwrite']) assert.match(ran.stdout, new RegExp(`^${k}=1$`, 'm'), ran.stdout + ran.stderr);
    assert.match(ran.stdout, /^plain\nown=0$/m, ran.stdout + ran.stderr);
    assert.equal(readFileSync(join(sibling.clone, 'README.md'), 'utf8'), 'demo\n');
    assert.equal(existsSync(join(codex, 'g')), false);
  } finally {
    removeRun(sibling.runDir);
    rmSync(codex, { recursive: true, force: true });
  }
});

// The seam is a deny-read ACL the model sets in its clone: chmod -R u+rwX (fixModes) leaves ACL entries alone, so git cannot read the file.
test('a diff git cannot take is one line after the answer, never the answer\'s loss; the run directory still goes', { skip: !KERNEL }, async () => {
  const w = world({ edit: (s) => { s.shell = 'echo x > locked.txt && /bin/chmod +a "user:$(/usr/bin/id -un) deny read" locked.txt'; } });
  const r = await w.repro();
  const [s] = w.spawns();
  assert.equal(s.ran.status, 0, s.ran.stderr);
  assert.equal(r.isError, undefined, r.text);
  assert.ok(r.text.startsWith('finding: README.md:1 · …\n\n_(vibe: model=mistral-large-4-0-3 · outcome=finished · '), r.text);
  assert.match(r.text, /\)_\n\n_\(diff unavailable: [^\n]*locked\.txt[^\n]*; set mistral\.reproKeep=true to inspect the clone\)_$/);
  assert.doesNotMatch(r.text, /proposed patch/);
  assert.equal(existsSync(dirname(s.workdir)), false, 'the run directory is removed');
});

test('the clone runs nothing the operator\'s global git config names: no filter, no hook', async () => {
  const d = join(BASE, 'global-cfg');
  gitRepo(d, { files: { '.gitattributes': '*.dat filter=x\n', 'x.dat': 'data\n' } });
  const smudged = join(BASE, 'global-smudge-ran');
  const hooked = join(BASE, 'global-hook-ran');
  const hooks = join(BASE, 'global-hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\ntouch ${sq(hooked)}\n`);
  chmodSync(join(hooks, 'post-checkout'), 0o755);
  const global = join(BASE, 'global.gitconfig');
  writeFileSync(global, `[filter "x"]\n\tsmudge = touch ${sq(smudged)} && cat\n[core]\n\thooksPath = ${hooks}\n`);
  // Control: a plain clone under that global config runs both.
  execFileSync('git', ['clone', '-q', `file://${d}`, join(BASE, 'global-control')], { env: { ...process.env, GIT_CONFIG_GLOBAL: global }, stdio: 'pipe' });
  assert.ok(existsSync(smudged) && existsSync(hooked), 'control: the global filter and hook run during a plain clone');
  rmSync(smudged);
  rmSync(hooked);
  const run = await withEnv({ GIT_CONFIG_GLOBAL: global }, () => prepareClone({ cwd: d }));
  try {
    assert.equal(existsSync(smudged), false, 'the global smudge filter ran on the reviewed repo');
    assert.equal(existsSync(hooked), false, 'the global post-checkout hook ran');
    assert.equal(readFileSync(join(run.clone, 'x.dat'), 'utf8'), 'data\n');
  } finally {
    removeRun(run.runDir);
  }
});

test('neutraliseModelText: each adapter line shape and the heading in any spacing get the model-written prefix, once; other lines are left alone', () => {
  const P = '> (model-written, not the adapter\'s) ';
  const shapes = [
    '_(clone unchanged)_', '_(clone kept: /x/clone)_', '_(the clone is HEAD abc1234; uncommitted …)_', '_(vibe: model=x · outcome=finished)_',
    '_(diff unavailable: git diff: boom; set mistral.reproKeep=true to inspect the clone)_', ' \t_(vibe: indented)_',
    '## proposed patch (not applied)', '###Proposed  Patch ( not  applied )', ' #\tPROPOSED\tPATCH\t(NOT APPLIED)',
    '[mistral: hard-killed after 2400s — treat the answer as partial; raise mistral.reproTimeoutS in the fleet config]',
  ];
  for (const l of shapes) {
    assert.equal(neutraliseModelText(`a\n${l}\nb`), `a\n${P}${l}\nb`, l);
    assert.equal(neutraliseModelText(neutraliseModelText(l)), P + l, `${l}: prefixed once`);
  }
  for (const l of ['see _(clone unchanged)_', '_(vibes: x)_', '## proposed patches', 'proposed patch (not applied)']) assert.equal(neutraliseModelText(l), l, l);
  // Review fix round (B5): a CR, alone or before a LF, is a line end, normalised to a LF before any line is read.
  assert.equal(neutraliseModelText('a\r_(vibe: x)_'), `a\n${P}_(vibe: x)_`);
  assert.equal(neutraliseModelText('a\r\n[mistral: x]\r\nb'), `a\n${P}[mistral: x]\nb`);
  // A setext heading of the adapter's name, and an HTML one, are the model's too.
  for (const [l, under] of [['proposed patch (not applied)', '---'], ['  Proposed Patch (not applied)', '==='], ['proposed patch (not applied)', '-']]) {
    assert.equal(neutraliseModelText(`a\n${l}\n${under}\nb`), `a\n${P}${l}\n${under}\nb`, l);
  }
  for (const l of ['<h2>proposed patch (not applied)</h2>', ' <H3 id="x"> Proposed  Patch (not applied)</H3>']) {
    assert.equal(neutraliseModelText(`a\n${l}\nb`), `a\n${P}${l}\nb`, l);
  }
  assert.equal(neutraliseModelText('proposed patch (not applied)\nb'), 'proposed patch (not applied)\nb', 'no underline: a paragraph');
});

test('neutraliseModelText: an odd count of fence lines gets one closing fence; an even count and an empty answer are left as they are', () => {
  // Review fix round (B5): the closing fence is one character longer than the longest run of it in the answer.
  assert.equal(neutraliseModelText('a\n```\nx'), 'a\n```\nx\n````');
  assert.equal(neutraliseModelText('```js\nx\n```\n```\ny'), '```js\nx\n```\n```\ny\n````');
  assert.equal(neutraliseModelText('a\n`````\nx'), 'a\n`````\nx\n``````', 'a fence of five closes only with five or more');
  assert.equal(neutraliseModelText('~~~\nx'), '~~~\nx\n~~~~', 'a tilde fence closes with tildes');
  assert.equal(neutraliseModelText('   ```\nx'), '   ```\nx\n````', 'up to three spaces before a fence');
  assert.equal(neutraliseModelText('    ```\nx'), '    ```\nx', 'four spaces: indented code, no fence');
  assert.equal(neutraliseModelText('```\n~~~\nx'), '```\n~~~\nx\n````', 'a tilde line inside a backtick fence closes nothing');
  assert.equal(neutraliseModelText('```\nx\n```'), '```\nx\n```');
  assert.equal(neutraliseModelText('a `` b\n x ```'), 'a `` b\n x ```', 'a backtick run inside a line is no fence');
  assert.equal(neutraliseModelText(''), '');
});

test('the model\'s answer cannot pass for the adapter\'s lines nor hold the adapter\'s heading inside an open fence', { skip: !KERNEL }, async () => {
  const w = world({ edit: (s) => { s.shell = 'printf "y\\n" > x'; s.answer = '_(clone unchanged)_\n```\nx'; } });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  const lines = r.text.split('\n');
  assert.equal(lines[0], '> (model-written, not the adapter\'s) _(clone unchanged)_');
  assert.ok(!lines.includes('_(clone unchanged)_'), r.text);
  const at = lines.indexOf('## proposed patch (not applied)');
  assert.ok(at > lines.findIndex((l) => l.startsWith('_(vibe: ')), r.text);
  assert.equal(lines.slice(0, at).filter((l) => /^`{3,}/.test(l)).length % 2, 0, 'no fence is open over the adapter\'s heading');
  // The adapter's fence is longer than the closing fence the model's text was given (````): five backticks.
  assert.match(r.text, /\n`````diff\ndiff --git a\/x b\/x\n[\s\S]*\n\+y\n`````$/);
});

test('appendPatch: a setext heading of the adapter\'s name over an unchanged clone is demoted; the fence outruns the model\'s backticks', () => {
  const P = '> (model-written, not the adapter\'s) ';
  assert.equal(appendPatch(neutraliseModelText('proposed patch (not applied)\n---\nfake'), ''), `${P}proposed patch (not applied)\n---\nfake\n\n_(clone unchanged)_`);
  const r = appendPatch('see ``````x``````', 'diff --git a/x b/x\n+y\n');
  assert.ok(r.endsWith('\n## proposed patch (not applied)\n\n```````diff\ndiff --git a/x b/x\n+y\n```````'), r);
});

test('a nested repository whose path holds a newline is named on one line, JSON-quoted, and forges no diff line', () => {
  const d = join(BASE, 'nl-nested');
  gitRepo(d);
  const run = prepareClone({ cwd: d });
  try {
    const sub = join(run.clone, 'sub\n+++ b', 'evil');
    mkdirSync(sub, { recursive: true });
    execFileSync('git', ['init', '-q', sub]);
    writeFileSync(join(sub, 'f'), 'f\n');
    const diff = cloneDiff(run.clone);
    assert.ok(diff.split('\n').includes('(nested repository "sub\\n+++ b/evil" not diffed)'), diff);
    assert.doesNotMatch(diff, /^\+\+\+ b\/evil/m);
  } finally {
    removeRun(run.runDir);
  }
});

test('regexLiteral escapes every regex metacharacter: a . and a + in a path match only themselves', () => {
  assert.equal(regexLiteral('/private/var/x.y+z'), '/private/var/x\\.y\\+z');
  assert.equal(regexLiteral('a*b?c^d$e{f}g(h)i|j[k]l\\m'), 'a\\*b\\?c\\^d\\$e\\{f\\}g\\(h\\)i\\|j\\[k\\]l\\\\m');
  const deny = new RegExp(`^${regexLiteral('/t/x.y+z')}/omelette-`);
  assert.equal(deny.test('/t/x.y+z/omelette-a'), true);
  assert.equal(deny.test('/t/xAyyz/omelette-a'), false);
});

// T3 round 2, rulings 3 and 4c: no signal out of the sandbox; no file flag that would stop the run's removal.
test('a command signals only its own sandbox and sets no file flag in its clone; the run is still removed', { skip: !KERNEL }, async () => {
  const outside = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  let runDir;
  try {
    const w = world({
      edit: (s) => {
        s.shell = `kill -TERM ${outside.pid}; echo outside=$?; /bin/sleep 30 & c=$!; kill -TERM $c; echo own=$?; `
          + 'echo y > f.txt; /usr/bin/chflags uchg f.txt; echo flags=$?; touch f.txt; echo touch=$?';
      },
    });
    const r = await w.repro();
    assert.equal(r.isError, undefined, r.text);
    const [s] = w.spawns();
    runDir = dirname(s.workdir);
    for (const [k, v] of [['outside', 1], ['own', 0], ['flags', 1], ['touch', 0]]) {
      assert.match(s.ran.stdout, new RegExp(`^${k}=${v}$`, 'm'), s.ran.stdout + s.ran.stderr);
    }
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(outside.signalCode, null, 'the sleep started outside the sandbox was signalled from inside it');
    assert.equal(existsSync(runDir), false, 'the run directory is removed');
  } finally {
    outside.kill('SIGKILL');
    if (runDir && existsSync(runDir)) {
      spawnSync('/usr/bin/chflags', ['-R', 'nouchg', runDir]);
      rmSync(runDir, { recursive: true, force: true });
    }
  }
});

// T3 round 3 (F1): RUN is a literal param, not a regex built from RUNS, so a metacharacter in the temp root cannot
// stop the walk down to the clone; the metadata allow covers this run's dir only, never a sibling's.
test('a temp root holding a + : node --test and git run in the clone; the own run dir can be stat\'ed, a sibling run dir cannot', { skip: !KERNEL }, async () => {
  const tm = join(BASE, 'tm+run');
  mkdirSync(tm);
  const sib = join(BASE, 'plus-sibling');
  gitRepo(sib);
  const sibling = await withEnv({ TMPDIR: tm }, () => prepareClone({ cwd: sib }));
  try {
    const w = world({
      edit: (s) => {
        s.shell = [
          `git -C "$OMELETTE_REPRO_CLONE" status --porcelain; echo git=$?`,
          `${sq(process.execPath)} --test t.test.mjs >"$OMELETTE_REPRO_TMP/node.out" 2>&1; echo node=$?`,
          '/usr/bin/stat -f %N "$OMELETTE_REPRO_RUN" >/dev/null; echo statown=$?',
          `/usr/bin/stat -f %N ${sq(sibling.runDir)} >/dev/null; echo statsib=$?`,
        ].join('; ');
      },
    });
    const r = await withEnv({ TMPDIR: tm }, () => w.repro());
    assert.equal(r.isError, undefined, r.text);
    const { ran, env } = w.spawns()[0];
    assert.ok(env.OMELETTE_REPRO_RUN.startsWith(`${tm}/omelette-mistral-repro/run-`), env.OMELETTE_REPRO_RUN);
    for (const [k, v] of [['git', 0], ['node', 0], ['statown', 0], ['statsib', 1]]) {
      assert.match(ran.stdout, new RegExp(`^${k}=${v}$`, 'm'), ran.stdout + ran.stderr);
    }
  } finally {
    removeRun(sibling.runDir);
  }
});

/* ── T3 round 3 (F2): modes fixed under the sandbox, no walk in the adapter ── */

/** A real run of `d` (prepareClone) and the repro wrapper's env for it, as reproOnce builds it; `home` is the HOME the profile sees. */
function sandboxedRun(name, home) {
  const d = join(BASE, name);
  gitRepo(d);
  const run = prepareClone({ cwd: d });
  const fleet = join(BASE, `${name}-fleet`);
  const { dir } = ensureHome({ home: fleet, profile: 'repro' });
  const env = {
    PATH: '/usr/bin:/bin', HOME: home, OMELETTE_FLEET_HOME: realpathSync(fleet), OMELETTE_REPRO_CLONE: run.clone, OMELETTE_REPRO_TMP: run.tmp,
    OMELETTE_REPRO_OUT: run.out, OMELETTE_REPRO_RUNS: realpathSync(runsRoot()), OMELETTE_REPRO_RUN: run.runDir,
    OMELETTE_REPRO_TMPROOT: regexLiteral(realpathSync(tmpdir())), OMELETTE_REPRO_SRC: realpathSync(run.top),
    ...nodeEnv({ home }),
  };
  return { run, wrapper: join(dir, 'shell.sh'), env };
}
const modeOf = (p) => lstatSync(p).mode & 0o777;

test('nodeUp: the directories from HOME down to the node prefix\'s parent, regex-escaped; none when the prefix is not under HOME', () => {
  assert.equal(nodeUp({ home: '/h', node: '/h/.nvm/versions/node/v20' }), '^(/h|/h/\\.nvm|/h/\\.nvm/versions|/h/\\.nvm/versions/node)$');
  // The binary alone, when the prefix would cover the home (nodePrefix): ~/bin/node.
  assert.equal(nodeUp({ home: '/h', node: '/h/bin/node' }), '^(/h|/h/bin)$');
  for (const node of ['/opt/node', '/hx/node', '/h']) assert.equal(nodeUp({ home: '/h', node }), NODEUP_NONE, node);
});

test('nodeReach: outside the home the whole prefix; under it its bin, npm and corepack and the chain to lib/node_modules; at or above it the binary alone', () => {
  assert.deepEqual(nodeReach({ home: '/h', prefix: '/opt/node', binary: '/opt/node/bin/node' }), { node: '^(/opt/node)(/|$)', up: NODEUP_NONE });
  assert.deepEqual(nodeReach({ home: '/h', prefix: '/h/.nvm/v20', binary: '/h/.nvm/v20/bin/node' }), {
    node: '^(/h/\\.nvm/v20/bin|/h/\\.nvm/v20/lib/node_modules/npm|/h/\\.nvm/v20/lib/node_modules/corepack)(/|$)',
    up: '^(/h|/h/\\.nvm|/h/\\.nvm/v20|/h/\\.nvm/v20/lib|/h/\\.nvm/v20/lib/node_modules)$',
  });
  assert.deepEqual(nodeReach({ home: '/h', prefix: '/h', binary: '/h/bin/node' }), { node: '^(/h/bin/node)(/|$)', up: '^(/h|/h/bin)$' });
  assert.deepEqual(nodeReach({ home: '/h/deep', prefix: '/h', binary: '/h/bin/node' }), { node: '^(/h/bin/node)(/|$)', up: NODEUP_NONE });
});

test('NODE and NODEUP under the home: bin, npm and corepack readable, the other global packages and the rest of the prefix not; the directories down to lib/node_modules stat-able, none listable', { skip: !KERNEL }, () => {
  const home = realpathSync(mkdtempSync(join(HOMES, 'omelette-mistral-t3-nodeup-')));
  made.push(home);
  const node = join(home, 'nvm', 'versions', 'node', 'v20');
  const modules = join(node, 'lib', 'node_modules');
  for (const d of [join(node, 'bin'), join(node, 'include'), join(modules, 'npm'), join(modules, 'corepack'), join(modules, 'other'), join(home, 'nvm', 'versions', 'node', 'v18'), join(home, 'other')]) mkdirSync(d, { recursive: true });
  for (const f of [join(node, 'bin', 'tool'), join(node, 'include', 'h'), join(modules, 'npm', 'package.json'), join(modules, 'corepack', 'package.json'), join(modules, 'other', 'package.json'), join(home, 'other', 'note')]) writeFileSync(f, 'x\n');
  writeFileSync(join(home, '.zsh_history'), 'operator history\n');
  const { run, wrapper, env } = sandboxedRun('nodeup', home);
  try {
    const P = 'nvm/versions/node/v20';
    const stat = (name, p) => `/usr/bin/stat -f %N "$T_HOME/${p}" >/dev/null 2>&1; echo ${name}=$?`;
    const cat = (name, p) => `cat "$T_HOME/${p}" >/dev/null 2>&1; echo ${name}=$?`;
    const r = spawnSync(wrapper, ['-c', [
      stat('home', '.'), stat('nvm', 'nvm'), stat('nodes', 'nvm/versions/node'), stat('prefix', P), stat('lib', `${P}/lib`), stat('modules', `${P}/lib/node_modules`),
      stat('sibling', 'nvm/versions/node/v18'), stat('other', 'other'), stat('history', '.zsh_history'),
      cat('bin', `${P}/bin/tool`), cat('npm', `${P}/lib/node_modules/npm/package.json`), cat('corepack', `${P}/lib/node_modules/corepack/package.json`),
      cat('globalpkg', `${P}/lib/node_modules/other/package.json`), cat('include', `${P}/include/h`), cat('cathistory', '.zsh_history'),
      'ls "$T_HOME" >/dev/null 2>&1; echo lshome=$?',
      `ls "$T_HOME/${P}/lib/node_modules" >/dev/null 2>&1; echo lsmodules=$?`,
    ].join('\n')], { env: { ...env, ...nodeEnv({ home, prefix: node, binary: join(node, 'bin', 'node') }), T_HOME: home }, cwd: run.clone, encoding: 'utf8' });
    const rows = Object.fromEntries([...r.stdout.matchAll(/^(\w+)=(\d+)$/gm)].map((m) => [m[1], Number(m[2])]));
    assert.deepEqual(rows, {
      home: 0, nvm: 0, nodes: 0, prefix: 0, lib: 0, modules: 0, sibling: 1, other: 1, history: 1,
      bin: 0, npm: 0, corepack: 0, globalpkg: 1, include: 1, cathistory: 1, lshome: 1, lsmodules: 1,
    }, r.stdout + r.stderr);
  } finally {
    removeRun(run.runDir);
  }
});

// The operator's real HOME, only for npm to run and `ls` of it to be refused; skipped where npm is not beside the node.
test('npm runs in the clone under the real HOME, a node under it included (NODE, NODEUP); the home stays unlistable', { skip: !KERNEL || !existsSync(join(dirname(process.execPath), 'npm')) }, () => {
  const home = realpathSync(homedir());
  const { run, wrapper, env } = sandboxedRun('nodeup-npm', home);
  try {
    mkdirSync(join(run.clone, 'pkg'));
    writeFileSync(join(run.clone, 'pkg', 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node --test' } }));
    writeFileSync(join(run.clone, 'pkg', 'ok.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
    const r = spawnSync(wrapper, ['-c', [
      'cd pkg',
      'npm --version >/dev/null 2>&1; echo npmversion=$?',
      'npm test >/dev/null 2>&1; echo npmtest=$?',
      'ls "$T_HOME" >/dev/null 2>&1; echo lshome=$?',
    ].join('\n')], { env: { ...env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, T_HOME: home }, cwd: run.clone, encoding: 'utf8', timeout: 120_000 });
    const rows = Object.fromEntries([...r.stdout.matchAll(/^(\w+)=(\d+)$/gm)].map((m) => [m[1], Number(m[2])]));
    assert.deepEqual(rows, { npmversion: 0, npmtest: 0, lshome: 1 }, r.stdout + r.stderr);
  } finally {
    removeRun(run.runDir);
  }
});

test('fixModes gives the owner back a 000 directory and a 000 file, and leaves a 755 file\'s exec bit', { skip: !KERNEL }, () => {
  const { run, wrapper, env } = sandboxedRun('fix-000', BASE);
  try {
    const locked = join(run.clone, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'f'), 'f\n');
    writeFileSync(join(locked, 'tool'), '#!/bin/sh\n');
    chmodSync(join(locked, 'f'), 0o000);
    chmodSync(join(locked, 'tool'), 0o755);
    chmodSync(locked, 0o000);
    const logs = [];
    assert.equal(fixModes({ wrapper, env, paths: [run.clone, run.tmp], log: (m) => logs.push(m) }), true, logs.join('\n'));
    assert.equal(modeOf(locked), 0o700);
    assert.equal(modeOf(join(locked, 'f')), 0o600);
    assert.equal(modeOf(join(locked, 'tool')), 0o755);
    assert.deepEqual(logs, []);
  } finally {
    removeRun(run.runDir);
  }
});

test('fixModes does not follow a link in the clone: a 444 file outside it, under HOME, keeps its mode', { skip: !KERNEL }, () => {
  const home = realpathSync(mkdtempSync(join(HOMES, 'omelette-mistral-t3-fixhome-')));
  made.push(home);
  const outside = join(home, 'outside');
  writeFileSync(outside, 'o\n');
  chmodSync(outside, 0o444);
  const { run, wrapper, env } = sandboxedRun('fix-link', home);
  try {
    symlinkSync(outside, join(run.clone, 'link'));
    fixModes({ wrapper, env, paths: [run.clone, run.tmp] });
    assert.equal(modeOf(outside), 0o444, 'the link\'s target is untouched');
    assert.equal(lstatSync(join(run.clone, 'link')).isSymbolicLink(), true);
  } finally {
    removeRun(run.runDir);
  }
});

test('removeRun with fix removes a run whose clone holds a 000 directory', { skip: !KERNEL }, () => {
  const { run, wrapper, env } = sandboxedRun('fix-rm', BASE);
  const locked = join(run.clone, 'locked');
  mkdirSync(locked);
  writeFileSync(join(locked, 'f'), 'x\n');
  chmodSync(locked, 0o000);
  const logs = [];
  const fix = () => fixModes({ wrapper, env, paths: [run.clone, run.tmp], log: (m) => logs.push(m) });
  const clear = () => clearRun({ wrapper, env, paths: [run.clone, run.tmp] });
  assert.equal(removeRun(run.runDir, { log: (m) => logs.push(m), fix, clear }), true, logs.join('\n'));
  assert.equal(existsSync(run.runDir), false);
  assert.deepEqual(logs, []);
});

// Review fix round (B2): the clone's contents go through rm -rf under the profile; a directory swapped for a link
// to the operator's files is unlinked, never walked.
test('removeRun clears the clone through the wrapper: a directory replaced by a link to one under HOME leaves that directory\'s file in place', { skip: !KERNEL }, () => {
  const home = realpathSync(mkdtempSync(join(HOMES, 'omelette-mistral-t3-rmhome-')));
  made.push(home);
  mkdirSync(join(home, 'victim'));
  writeFileSync(join(home, 'victim', 'keep'), 'operator file\n');
  const { run, wrapper, env } = sandboxedRun('rm-link', home);
  mkdirSync(join(run.clone, 'd'));
  writeFileSync(join(run.clone, 'd', 'f'), 'x\n');
  rmSync(join(run.clone, 'd'), { recursive: true });
  symlinkSync(join(home, 'victim'), join(run.clone, 'd'));
  const logs = [];
  const clear = () => clearRun({ wrapper, env, paths: [run.clone, run.tmp] });
  assert.equal(removeRun(run.runDir, { log: (m) => logs.push(m), clear }), true, logs.join('\n'));
  assert.equal(existsSync(run.runDir), false);
  assert.equal(readFileSync(join(home, 'victim', 'keep'), 'utf8'), 'operator file\n');
});

// …and the adapter never walks the clone itself: what the sandboxed clear left there stays, named in one log line.
test('removeRun with clear removes the clone only once empty: a clear that left a file leaves the run dir, logged', () => {
  const d = join(BASE, 'rm-noclear');
  gitRepo(d);
  const run = prepareClone({ cwd: d });
  const logs = [];
  try {
    assert.equal(removeRun(run.runDir, { log: (m) => logs.push(m), clear: () => {} }), false);
    assert.ok(existsSync(join(run.clone, 'README.md')), 'the adapter walked the clone');
    assert.equal(existsSync(run.out), false, 'OUT, which no command can write, is removed');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^repro run dir not removed: /);
  } finally {
    removeRun(run.runDir);
  }
});

/* ── T3c: the clone and tmp directories themselves cannot be unlinked or replaced ── */

test('a clone swapped for a link during the run: the answer is withheld, no byte behind the link reaches the patch, the run dir goes and the link\'s target stays', { skip: !DARWIN }, async () => {
  const target = join(BASE, 'swap-target');
  mkdirSync(target);
  writeFileSync(join(target, 'SECRET'), 'operator-secret-bytes\n');
  const w = world({ edit: (s) => { s.swap = target; s.answer = 'finding: x'; } });
  const r = await w.repro();
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /mistral: the clone or its tmp directory was replaced during the run — the answer is withheld/);
  assert.doesNotMatch(r.text, /SECRET|operator-secret-bytes|finding: x/);
  assert.equal(w.retries(), 0);
  assert.equal(existsSync(dirname(w.spawns()[0].workdir)), false, 'the run directory is removed');
  assert.equal(readFileSync(join(target, 'SECRET'), 'utf8'), 'operator-secret-bytes\n', 'the removal did not follow the link');
});

test('assertRun passes an untouched run and throws on a clone replaced by a fresh directory or a tmp replaced by a link', { skip: !DARWIN }, () => {
  const d = join(BASE, 'assert-run');
  gitRepo(d);
  const run = prepareClone({ cwd: d });
  const refused = { message: 'mistral: the clone or its tmp directory was replaced during the run — the answer is withheld' };
  try {
    assertRun(run);
    rmSync(run.tmp, { recursive: true });
    symlinkSync(run.clone, run.tmp);
    assert.throws(() => assertRun(run), refused);
    unlinkSync(run.tmp);
    mkdirSync(run.tmp);
    const { dev, ino } = lstatSync(run.tmp);
    const fresh = { ...run, ids: { ...run.ids, tmp: { dev, ino } } };
    assertRun(fresh);
    rmSync(run.clone, { recursive: true });
    mkdirSync(run.clone);
    assert.throws(() => assertRun(fresh), refused);
  } finally {
    removeRun(run.runDir);
  }
});

test('the kernel keeps the clone dir: rmdir, rm -rf and mv of it are refused; files, subdirs, chmod of a subdir, git and node --test still work', { skip: !KERNEL }, async () => {
  const w = world({
    edit: (s) => {
      s.shell = [
        'touch "$OMELETTE_REPRO_CLONE/f"; echo touch=$?',
        'mkdir sub; echo mkdir=$?', '/bin/chmod 000 sub; echo chmod=$?', '/bin/chmod 700 sub; rmdir sub; echo rmdirsub=$?',
        'git init -q; echo gitinit=$?', 'git add f; echo gitadd=$?', 'git status --porcelain >/dev/null; echo gitstatus=$?',
        `${sq(process.execPath)} --test t.test.mjs >/dev/null 2>&1; echo node=$?`,
        'cd "$OMELETTE_REPRO_TMP"',
        'rm -rf "$OMELETTE_REPRO_CLONE"; echo rmrf=$?',
        'rmdir "$OMELETTE_REPRO_CLONE"; echo rmdir=$?',
        'mv "$OMELETTE_REPRO_CLONE" "$OMELETTE_REPRO_TMP/x"; echo mv=$?',
        'test -d "$OMELETTE_REPRO_CLONE" && test ! -L "$OMELETTE_REPRO_CLONE"; echo still=$?',
      ].join('; ');
    },
  });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  const { ran } = w.spawns()[0];
  for (const [k, v] of [['touch', 0], ['mkdir', 0], ['chmod', 0], ['rmdirsub', 0], ['gitinit', 0], ['gitadd', 0], ['gitstatus', 0], ['node', 0], ['rmrf', 1], ['rmdir', 1], ['mv', 1], ['still', 0]]) {
    assert.match(ran.stdout, new RegExp(`^${k}=${v}$`, 'm'), ran.stdout + ran.stderr);
  }
});

/* ── 1.9.0 review fix round: the profile (A1–A4, E4) ── */

const PROCARGS = "import ctypes,sys; l=ctypes.CDLL(None,use_errno=True); m=(ctypes.c_int*3)(1,49,int(sys.argv[1])); n=ctypes.c_size_t(0); sys.exit(0 if l.sysctl(m,3,None,ctypes.byref(n),None,0)==0 and n.value>0 else 1)";
test('the fix round\'s profile: no read of HOME or the work tree, no other process\'s argv, no launchd job, no other terminal, no write under the clone\'s .vibe; git, node and python3 run', { skip: !KERNEL }, async () => {
  const uid = process.getuid();
  const tty = readdirSync('/dev').filter((d) => /^ttys\d+$/.test(d)).find((d) => { try { return lstatSync(join('/dev', d)).uid === uid; } catch { return false; } });
  const label = `com.omelette.test.${process.pid}`;
  const w = world({
    edit: (s) => {
      s.shell = [
        'cat "$T_HOME/notes"; echo home=$?',
        // Ruling 1: bash's HOME is the run's tmp, so git reads no ~/.gitconfig it may not open.
        'test "$HOME" = "$OMELETTE_REPRO_TMP"; echo hometmp=$?',
        'echo "global=[$(git config --global user.name)]"',
        'cat "$OMELETTE_REPRO_SRC/README.md"; echo src=$?',
        'git status --porcelain >/dev/null; echo git=$?',
        `${sq(process.execPath)} --test t.test.mjs >/dev/null 2>&1; echo node=$?`,
        "python3 -c 'import ssl, sqlite3'; echo py=$?",
        `python3 -c ${sq(PROCARGS)} $PPID; echo procout=$?`,
        `python3 -c ${sq(PROCARGS)} $$; echo procown=$?`,
        `cp /bin/launchctl "$TMPDIR/l"; "$TMPDIR/l" submit -l ${label} -- /usr/bin/true; echo submit=$?`,
        ...(tty ? [`(exec 3>/dev/${tty}); echo tty=$?`] : []),
        'echo x >/dev/null; echo null=$?; echo x >/dev/fd/2; echo fd=$?',
        'mkdir .vibe; echo mkvibe=$?; echo b > beside; echo beside=$?',
      ].join('; ');
    },
  });
  writeFileSync(join(w.home, 'notes'), 'operator-notes\n');
  writeFileSync(join(w.home, '.gitconfig'), '[user]\n\tname = operator-name\n');
  try {
    const r = await w.repro();
    assert.equal(r.isError, undefined, r.text);
    const { ran } = w.spawns()[0];
    assert.match(ran.stdout, /^global=\[\]$/m, ran.stdout + ran.stderr);
    const rows = [['home', 1], ['hometmp', 0], ['src', 1], ['git', 0], ['node', 0], ['py', 0], ['procout', 1], ['procown', 0], ['null', 0], ['fd', 0], ['mkvibe', 1], ['beside', 0], ...(tty ? [['tty', 1]] : [])];
    for (const [k, v] of rows) assert.match(ran.stdout, new RegExp(`^${k}=${v}$`, 'm'), `${k}\n${ran.stdout}${ran.stderr}`);
    assert.doesNotMatch(ran.stdout, /^submit=0$/m, 'a copied launchctl submitted a job');
    assert.doesNotMatch(ran.stdout, /operator-notes|^demo$/m);
    assert.match(r.text, /^\+\+\+ b\/beside$/m, 'the file beside .vibe is in the patch');
  } finally {
    if (spawnSync('/bin/launchctl', ['list', label]).status === 0) spawnSync('/bin/launchctl', ['remove', label]);
  }
});

/* ── T3c round 2: no blanket write under /private/var/folders — the clone and its tmp only ── */

const REAL_T = realpathSync(tmpdir());
test('the PROBE: the temp root cannot be renamed, replaced or written; the run\'s tmp can; node, git and python3 run with the run\'s tmp as theirs', { skip: !KERNEL || !/^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(REAL_T) }, () => {
  const { run, wrapper, env } = sandboxedRun('probe-tmproot', BASE);
  const T = REAL_T;
  // reproOnce sets TMPDIR to the run's tmp; the probe does the same.
  const probeEnv = { ...env, TMPDIR: run.tmp, T, NODE: process.execPath };
  const script = [
    'mv "$T" "$T.x"; echo mv=$?', 'test -d "$T" && test ! -L "$T"; echo still=$?',
    'touch "$T/x-probe-$$"; echo touchT=$?', 'ln -s /tmp "$T.y"; echo ln=$?',
    'touch "$OMELETTE_REPRO_TMP/x"; echo tmp=$?',
    '"$NODE" --test t.test.mjs >/dev/null 2>&1; echo node=$?',
    'git init -q p; echo gitinit=$?', 'echo a > p/a; git -C p add a; echo gitadd=$?', 'git -C p status --porcelain >/dev/null; echo gitstatus=$?',
    'git clone -q "file://$OMELETTE_REPRO_CLONE" "$OMELETTE_REPRO_CLONE/copy"; echo gitclone=$?',
    "echo py=$(python3 -c 'import tempfile; print(tempfile.mkstemp()[1])')",
    'echo nodetmp=$("$NODE" -e "console.log(require(\'os\').tmpdir())")',
  ].join('\n');
  try {
    const r = spawnSync(wrapper, ['-c', script], { env: probeEnv, cwd: run.clone, encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    for (const [k, v] of [['mv', 1], ['still', 0], ['touchT', 1], ['ln', 1], ['tmp', 0], ['node', 0], ['gitinit', 0], ['gitadd', 0], ['gitstatus', 0], ['gitclone', 0]]) {
      assert.match(r.stdout, new RegExp(`^${k}=${v}$`, 'm'), out);
    }
    assert.match(r.stdout, new RegExp(`^py=${regexLiteral(run.tmp)}/tmp`, 'm'), out);
    assert.match(r.stdout, new RegExp(`^nodetmp=${regexLiteral(run.tmp)}$`, 'm'), out);
    assert.ok(existsSync(join(run.clone, 'copy', 't.test.mjs')), out);
    // The wrapper puts the developer dir ahead of the /usr/bin shims, whose xcrun cache the profile does not let them write: no noise.
    for (const cmd of ['git status --porcelain', 'python3 -c pass']) {
      const q = spawnSync(wrapper, ['-c', cmd], { env: probeEnv, cwd: run.clone, encoding: 'utf8' });
      assert.equal(q.status, 0, cmd + q.stderr);
      assert.equal(q.stderr, '', cmd);
    }
    const dev = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }).stdout.trim();
    if (dev && existsSync(join(dev, 'usr/bin/git'))) {
      const where = spawnSync(wrapper, ['-c', 'command -v git'], { env: probeEnv, encoding: 'utf8' });
      assert.equal(where.stdout.trim(), join(dev, 'usr/bin/git'));
      // The residual: the shim called by its path still finds its cache unwritable, and still runs.
      const shim = spawnSync(wrapper, ['-c', '/usr/bin/git status --porcelain >/dev/null'], { env: probeEnv, cwd: run.clone, encoding: 'utf8' });
      assert.equal(shim.status, 0, shim.stderr);
      assert.match(shim.stderr, /xcrun_db/);
    }
  } finally {
    // Only ever reached if the kernel let the probe through: put the operator's temp root back.
    if (!existsSync(T) && existsSync(`${T}.x`)) renameSync(`${T}.x`, T);
    try { lstatSync(`${T}.y`); unlinkSync(`${T}.y`); } catch { /* not made: the kernel refused it */ }
    removeRun(run.runDir);
  }
});
