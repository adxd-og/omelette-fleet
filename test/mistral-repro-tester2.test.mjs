// 1.9.0 Task 3, the re-review tester's file (round 2): what the first two test
// files leave open after the RUNS / fixModes / neutralise / killGroupOnExit round
// — the profile's lines one at a time, a temp root holding regex metacharacters,
// removal that cannot succeed, the isolated git on a hostile work tree, and the
// wiring of killGroupOnExit. Same fake `vibe` and temp-dir discipline as
// test/mistral-repro.test.mjs (copied: that file exports nothing). Never runs
// the real `vibe`; HOME, OMELETTE_HOME and VIBE_BIN are temp, the operator's
// ~/.vibe is never touched.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import unit from '../units/mistral/adapter.mjs';
import { ensureHome } from '../units/mistral/home.mjs';
import { cloneDiff, fixModes, neutraliseModelText, nodeEnv, prepareClone, regexLiteral, removeRun, runsRoot } from '../units/mistral/repro.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const DARWIN = process.platform === 'darwin';
// sandbox-exec cannot nest: inside a sandbox even an allow-everything profile fails, and the kernel rows skip.
const KERNEL = DARWIN && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-mistral-t3t-')));
const HOMES = DARWIN ? '/private/tmp' : BASE;
const made = [BASE];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });


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
  'const ran = sc.shell ? spawnSync(shell, ["-c", sc.shell], { cwd: workdir, env: { ...process.env, T_HOME: process.env.HOME }, encoding: "utf8" }) : null;',
    'const esc = (s) => JSON.stringify(s).slice(1, -1);',
  'const fill = (v) => JSON.parse(JSON.stringify(v).replaceAll("$MODEL", esc(opt("--model"))).replaceAll("$SHELL", esc(shell)));',
  'appendFileSync(sc.record, JSON.stringify({',
  '  argv, env: process.env, cwd: process.cwd(), workdir, outDir, homeConfig,',
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
  // The adapter takes HOME from its own process (resolved): the world's home is that HOME for the call.
  const repro = (args = {}) => withEnv({ OMELETTE_ALLOW_REPRO: '1', HOME: home }, () => call(args));
  const review = () => withEnv({ HOME: home }, () => rt.callTool('mistral_security_review', { prompt: 'find the auth bug', cwd: work }));
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


/* ── the profile, one deny at a time ────────────────────────────────────────── */

/**
 * The repro wrapper run directly (no adapter): two run dirs under a `omelette-mistral-repro` of a
 * private temp root, run A the sandbox's own. `over` replaces any of the wrapper's env names.
 */
function profileWorld(over = {}) {
  const base = realpathSync(mkdtempSync(join(BASE, 'pw-')));
  const fleet = join(base, 'fleet');
  mkdirSync(fleet);
  const { dir } = ensureHome({ home: fleet, profile: 'repro' });
  const home = join(base, 'home');
  mkdirSync(home);
  const root = join(base, 'omelette-mistral-repro');
  mkdirSync(root);
  const runs = ['run-AAA', 'run-BBB'].map((n) => {
    const r = join(root, n);
    for (const d of ['', 'clone', 'tmp', 'out']) mkdirSync(join(r, d));
    writeFileSync(join(r, 'clone', 'f'), `clone-of-${n}\n`);
    writeFileSync(join(r, 'out', 'o'), `out-of-${n}\n`);
    return r;
  });
  const other = join(base, 'omelette-codex-X');
  mkdirSync(other);
  writeFileSync(join(other, 'f'), 'other-unit-spool\n');
  const [a, b] = runs;
  const env = {
    PATH: '/usr/bin:/bin', HOME: home, OMELETTE_REPRO_CLONE: join(a, 'clone'), OMELETTE_REPRO_TMP: join(a, 'tmp'), OMELETTE_FLEET_HOME: fleet,
    OMELETTE_REPRO_OUT: join(a, 'out'), OMELETTE_REPRO_RUNS: root, OMELETTE_REPRO_RUN: a, OMELETTE_REPRO_TMPROOT: regexLiteral(base), OMELETTE_REPRO_SRC: join(base, 'src'), ...nodeEnv({ home }), T_HOME: home, ...over,
  };
  const run = (cmd) => spawnSync(join(dir, 'shell.sh'), ['-c', cmd], { env, encoding: 'utf8', cwd: join(a, 'clone') });
  return { base, home, root, a, b, other, run, env, wrapper: join(dir, 'shell.sh') };
}
const denied = (r) => /Operation not permitted/.test(r.stderr);

// RUNS and TMPROOT each deny a sibling run on their own: with the other pointing at nothing, the sibling is still unreachable.
test('RUNS denies a sibling run when TMPROOT matches nothing, and TMPROOT denies another unit\'s temp dir when RUNS matches nothing', { skip: !KERNEL }, () => {
  const w = profileWorld({ OMELETTE_REPRO_TMPROOT: '/nonexistent-root' });
  const r = w.run(`cat ${sq(join(w.b, 'clone', 'f'))}; echo sibread=$?; echo x > ${sq(join(w.b, 'tmp', 'w'))}; echo sibwrite=$?; cat ${sq(join(w.b, 'out', 'o'))}; echo sibout=$?; cat ${sq(join(w.a, 'clone', 'f'))}; echo own=$?`);
  assert.doesNotMatch(r.stdout, /clone-of-run-BBB|out-of-run-BBB/, r.stdout + r.stderr);
  for (const k of ['sibread', 'sibwrite', 'sibout']) assert.match(r.stdout, new RegExp(`^${k}=1$`, 'm'), r.stdout + r.stderr);
  assert.match(r.stdout, /^clone-of-run-AAA\nown=0$/m, r.stdout + r.stderr);
  assert.equal(existsSync(join(w.b, 'tmp', 'w')), false);

  const v = profileWorld({ OMELETTE_REPRO_RUNS: '/nonexistent-runs' });
  const s = v.run(`cat ${sq(join(v.other, 'f'))}; echo read=$?; echo x > ${sq(join(v.other, 'g'))}; echo write=$?; cat ${sq(join(v.a, 'clone', 'f'))}; echo own=$?`);
  assert.doesNotMatch(s.stdout, /other-unit-spool/, s.stdout + s.stderr);
  assert.match(s.stdout, /^read=1$/m, s.stdout + s.stderr);
  assert.match(s.stdout, /^write=1$/m, s.stdout + s.stderr);
  assert.equal(existsSync(join(v.other, 'g')), false);
  assert.match(s.stdout, /^clone-of-run-AAA\nown=0$/m, 'the run\'s own clone is re-allowed even when the RUNS line matches nothing: TMPROOT alone covers it');
});

// The metadata allow: the path down to the clone is walkable (node and git lstat every component), never listable.
test('RUNS and the run directory can be stat\'ed but not listed, and the clone and tmp can; a sibling\'s contents cannot be stat\'ed', { skip: !KERNEL }, () => {
  const w = profileWorld();
  const r = w.run(`/usr/bin/stat -f %N ${sq(w.root)} >/dev/null; echo statroot=$?; /usr/bin/stat -f %N ${sq(w.a)} >/dev/null; echo statrun=$?; /bin/ls ${sq(w.root)} >/dev/null; echo lsroot=$?; /bin/ls ${sq(w.a)} >/dev/null; echo lsrun=$?; /bin/ls ${sq(join(w.a, 'clone'))} >/dev/null; echo lsclone=$?; /bin/ls ${sq(join(w.a, 'tmp'))} >/dev/null; echo lstmp=$?; /usr/bin/stat -f %N ${sq(join(w.b, 'clone'))} >/dev/null; echo statsib=$?`);
  const got = Object.fromEntries([...r.stdout.matchAll(/^(\w+)=(\d+)$/gm)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(got, { statroot: 0, statrun: 0, lsroot: 1, lsrun: 1, lsclone: 0, lstmp: 0, statsib: 1 }, r.stdout + r.stderr);
});

// Seatbelt takes the last matching rule: the re-allow of the clone and tmp, then the flag deny, are the last lines.
test('the run\'s own clone and tmp stay readable and writable under RUNS and TMPROOT, git works in the clone, and the new read-denies and exec-denies hold', { skip: !KERNEL }, () => {
  const w = profileWorld();
  const secrets = ['.gnupg/c', '.netrc', '.kube/c', '.docker/c', '.npmrc', '.git-credentials'];
  for (const d of ['.gnupg', '.kube', '.docker']) mkdirSync(join(w.home, d));
  for (const f of secrets) writeFileSync(join(w.home, f), `secret-in-${f}\n`);
  writeFileSync(join(w.home, '.ssh-control'), 'readable-control\n');
  execFileSync('git', ['init', '-q', join(w.a, 'clone')]);
  const r = w.run([
    'echo w > f2; cat f2; echo clonewrite=$?',
    'echo t > "$OMELETTE_REPRO_TMP/t"; cat "$OMELETTE_REPRO_TMP/t"; echo tmpwrite=$?',
    'git status --porcelain >/dev/null; echo git=$?',
    'cat "$T_HOME/.ssh-control"; echo control=$?',
    ...secrets.map((f) => `cat "$T_HOME/${f}"; echo "read-${f}=$?"`),
    ...['/usr/bin/security', '/usr/bin/pbpaste', '/usr/bin/pbcopy'].map((x) => `${x} -h >/dev/null 2>&1; echo "exec-${x.slice(9)}=$?"`),
  ].join('; '));
  assert.doesNotMatch(r.stdout, /secret-in-/, r.stdout + r.stderr);
  assert.match(r.stdout, /^w\nclonewrite=0$/m, r.stdout + r.stderr);
  assert.match(r.stdout, /^t\ntmpwrite=0$/m, r.stdout + r.stderr);
  assert.match(r.stdout, /^git=0$/m, r.stdout + r.stderr);
  // Review fix round (A1): the whole of $HOME is read-denied, a file outside the old per-directory list included.
  assert.match(r.stdout, /^control=1$/m, 'a $HOME file outside the old deny list is unreadable');
  assert.doesNotMatch(r.stdout, /readable-control/, r.stdout + r.stderr);
  for (const f of secrets) assert.match(r.stdout, new RegExp(`^read-${f.replace('.', '\\.')}=1$`, 'm'), `${f}\n${r.stdout}${r.stderr}`);
  for (const x of ['security', 'pbpaste', 'pbcopy']) assert.match(r.stdout, new RegExp(`^exec-${x}=126$`, 'm'), `${x}\n${r.stdout}${r.stderr}`);
});

/* ── a temp root holding regex metacharacters ───────────────────────────────── */

// The profile reads TMPROOT (escaped by the adapter) AND RUNS inside a regex; RUNS is also a subpath, so it is passed unescaped.
// The first test: the TMPROOT deny still holds for a root holding `+` (an unescaped `+` would quantify, and fail open).
test('a temp root holding a + : another unit\'s temp dir under it is still unreadable', { skip: !KERNEL }, async () => {
  const tm = join(BASE, 'tm+p');
  mkdirSync(tm);
  const codex = mkdtempSync(join(tm, 'omelette-codex-'));
  writeFileSync(join(codex, 'f'), 'codex-spool-bytes\n');
  const w = world({ edit: (s) => { s.shell = `cat ${sq(join(codex, 'f'))}; echo codexread=$?`; } });
  const r = await withEnv({ TMPDIR: tm }, () => w.repro());
  assert.equal(r.isError, undefined, r.text);
  const { ran } = w.spawns()[0];
  assert.doesNotMatch(ran.stdout, /codex-spool-bytes/, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /^codexread=1$/m, ran.stdout + ran.stderr);
});

// The second: the run's own path must stay usable. RUNS sits unescaped in `(regex … "/run-[^/]+$")`; a `+` there
// stops that line matching, the run directory cannot be stat'ed, and node (realpath lstats every component of its
// script) dies with EPERM. (Control: the same command passes under an ordinary temp root, test/mistral-repro.test.mjs.)
test('a temp root holding a + : node --test still runs in the run\'s own clone', { skip: !KERNEL }, async () => {
  const tm = join(BASE, 'tm+q');
  mkdirSync(tm);
  const w = world({
    edit: (s) => {
      s.shell = `git -C "$OMELETTE_REPRO_CLONE" status --porcelain; echo git=$?; ${sq(process.execPath)} --test t.test.mjs >"$OMELETTE_REPRO_TMP/node.out" 2>&1; echo node=$?; head -c 600 "$OMELETTE_REPRO_TMP/node.out"; echo y > f.txt; echo write=$?`;
    },
  });
  const r = await withEnv({ TMPDIR: tm }, () => w.repro());
  assert.equal(r.isError, undefined, r.text);
  const { ran } = w.spawns()[0];
  assert.match(ran.stdout, /^write=0$/m, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /^git=0$/m, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /^node=0$/m, ran.stdout + ran.stderr);
});

/* ── removal that cannot succeed ────────────────────────────────────────────── */

// An immutable file in the clone survives chmod and rm: removeRun must say so on the log and return false, not throw.
test('removeRun never throws: a run it cannot remove (an immutable file) is one log line and false; the same run is removable once the flag is gone', { skip: !DARWIN }, () => {
  const runDir = mkdtempSync(join(BASE, 'rm-uchg-'));
  mkdirSync(join(runDir, 'clone'));
  const f = join(runDir, 'clone', 'f');
  writeFileSync(f, 'x\n');
  assert.equal(spawnSync('/usr/bin/chflags', ['uchg', f]).status, 0);
  const logs = [];
  try {
    assert.doesNotThrow(() => assert.equal(removeRun(runDir, { log: (m) => logs.push(m) }), false));
    assert.equal(logs.length, 1, logs.join('\n'));
    assert.ok(logs[0].startsWith(`repro run dir not removed: ${runDir} — `), logs[0]);
    assert.equal(existsSync(f), true);
  } finally {
    spawnSync('/usr/bin/chflags', ['-R', 'nouchg', runDir]);
  }
  assert.equal(removeRun(runDir), true);
  assert.equal(existsSync(runDir), false);
});

/* ── killGroupOnExit reaches the runtime from repro, and from nothing else ──── */

test('repro asks for the group kill on exit; review does not', { skip: !DARWIN }, async () => {
  const w = world();
  assert.equal((await w.repro()).isError, undefined);
  assert.equal(w.spawnOpts.length, 1);
  assert.equal(w.spawnOpts[0].killGroupOnExit, true);
  const v = world();
  const r = await v.review();
  assert.equal(r.isError, undefined, r.text);
  assert.equal(v.spawnOpts.length, 1);
  assert.ok(!v.spawnOpts[0].killGroupOnExit, `review passed killGroupOnExit=${v.spawnOpts[0].killGroupOnExit}`);
});

/* ── the isolated git on a hostile work tree ────────────────────────────────── */

// Every git on the REAL tree runs with core.fsmonitor=false: the repository's own config is not the clone's.
test('the work tree\'s own core.fsmonitor does not run during prepareClone (status and rev-parse on the real tree)', () => {
  const d = join(BASE, 'fsm-real');
  gitRepo(d);
  const hook = join(BASE, 'fsm-real.sh');
  writeFileSync(hook, `#!/bin/sh\ntouch ${sq(mark('fsm-real'))}\n`);
  chmodSync(hook, 0o755);
  execFileSync('git', ['-C', d, 'config', 'core.fsmonitor', hook]);
  // Control: git status in that work tree, unprotected, runs the hook.
  execFileSync('git', ['-C', d, 'status', '--porcelain']);
  assert.equal(existsSync(mark('fsm-real')), true, 'control: the hook runs under a plain git status');
  rmSync(mark('fsm-real'));
  const { value: run } = withTmpRoot(() => prepareClone({ cwd: d }));
  try {
    assert.equal(existsSync(mark('fsm-real')), false, 'the work tree\'s fsmonitor ran as the operator');
  } finally {
    removeRun(run.runDir);
  }
});

// `git clone --depth 1` without --recurse-submodules: a committed gitlink and a .gitmodules whose url would run a command are never fetched.
test('a committed .gitmodules (an ext:: url that would run a command) and its gitlink: nothing runs, the clone and the diff succeed', () => {
  const d = join(BASE, 'gitmodules');
  gitRepo(d);
  const ran = mark('submodule-ext');
  writeFileSync(join(d, '.gitmodules'), `[submodule "sub"]\n\tpath = sub\n\turl = ext::sh -c "touch ${ran}"\n`);
  execFileSync('git', ['-C', d, 'update-index', '--add', '--cacheinfo', `160000,${execFileSync('git', ['-C', d, 'rev-parse', 'HEAD']).toString().trim()},sub`]);
  execFileSync('git', ['-C', d, 'add', '.gitmodules']);
  execFileSync('git', ['-C', d, ...GIT_ID, 'commit', '-qm', 'submodule']);
  const { value: run } = withTmpRoot(() => prepareClone({ cwd: d }));
  try {
    assert.equal(existsSync(ran), false, 'the submodule url ran during the clone');
    assert.ok(existsSync(join(run.clone, '.gitmodules')));
    // The model touches the gitlink's directory and fakes a submodule checkout there.
    mkdirSync(join(run.clone, 'sub'), { recursive: true });
    writeFileSync(join(run.clone, 'sub', 'x'), 'x\n');
    writeFileSync(join(run.clone, 'README.md'), 'demo\nedited\n');
    const diff = cloneDiff(run.clone);
    assert.equal(existsSync(ran), false, 'the submodule url ran during the diff');
    assert.match(diff, /^\+edited$/m);
  } finally {
    removeRun(run.runDir);
  }
});

/* ── neutraliseModelText ────────────────────────────────────────────────────── */

// A lone CR is a line end for a markdown renderer: a fence after one is a fence, and an open one must be closed.
// Review fix round (E4/B5): CRs are normalised to LF first, and the closing fence outruns the longest backtick run.
test('neutraliseModelText counts a fence that follows a lone CR, and one that follows CRLF', () => {
  assert.equal(neutraliseModelText('a\r```\rx'), 'a\n```\nx\n````');
  assert.equal(neutraliseModelText('a\r\n```\r\nx'), 'a\n```\nx\n````');
  assert.equal(neutraliseModelText('a\r\n```\r\nx\r\n```\r\n'), 'a\n```\nx\n```\n');
  assert.equal(neutraliseModelText('a\r\n_(clone unchanged)_\r\n'), 'a\n> (model-written, not the adapter\'s) _(clone unchanged)_\n');
});

/* ── the clone is HEAD only; the diff is whole when the model locked its own files ── */

test('the clone holds HEAD and no history: an earlier commit is not in it', () => {
  const d = join(BASE, 'depth');
  gitRepo(d, { files: { 'old-secret.txt': 'removed later\n' } });
  const first = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', d, 'rm', '-q', 'old-secret.txt']);
  execFileSync('git', ['-C', d, ...GIT_ID, 'commit', '-qm', 'two']);
  const { value: run } = withTmpRoot(() => prepareClone({ cwd: d }));
  try {
    assert.equal(execFileSync('git', ['-C', run.clone, 'rev-list', '--count', 'HEAD']).toString().trim(), '1');
    assert.throws(() => execFileSync('git', ['-C', run.clone, 'cat-file', '-e', first], { stdio: 'pipe' }), 'the first commit is not in the clone');
  } finally {
    removeRun(run.runDir);
  }
});

// fixModes runs before the diff: a file the model edited and then locked (mode 000), a new locked file, and a new file
// in a locked directory are in the patch; the adapter reports no "diff unavailable". Without it git cannot read them.
test('the patch carries what the model changed and then locked with chmod 000: an edited file, a new file, a file in a locked directory', { skip: !KERNEL }, async () => {
  const w = world({
    edit: (s) => {
      s.shell = 'echo edited >> README.md; chmod 000 README.md; echo n > new.txt; chmod 000 new.txt; mkdir d; echo deep > d/f; chmod 000 d';
    },
  });
  const r = await w.repro();
  const [s] = w.spawns();
  assert.equal(s.ran.status, 0, s.ran.stderr);
  assert.equal(r.isError, undefined, r.text);
  assert.doesNotMatch(r.text, /diff unavailable/);
  assert.match(r.text, /^\+edited$/m);
  assert.match(r.text, /^\+\+\+ b\/new\.txt$/m);
  assert.match(r.text, /^\+\+\+ b\/d\/f$/m);
  assert.doesNotMatch(r.text, /^(old|new) mode /m, 'giving the owner bits back shows no mode change');
  assert.equal(existsSync(dirname(s.workdir)), false, 'the run directory is removed');
});

/* ── the isolated git against the config reaches that the global-config test does not ── */

/** A work tree with a committed `.gitattributes` sending `*.dat` through filter `x`. */
function filterRepo(name) {
  const d = join(BASE, name);
  gitRepo(d, { files: { '.gitattributes': '*.dat filter=x\n', 'x.dat': 'data\n' } });
  return d;
}
const cloneTo = (d, env) => execFileSync('git', ['clone', '-q', `file://${d}`, join(BASE, `ctl-${n++}`)], { env: { ...process.env, ...env }, stdio: 'pipe' });

// GIT_CONFIG_NOSYSTEM: a system gitconfig the operator's machine carries (GIT_CONFIG_SYSTEM stands in for /etc/gitconfig).
test('the clone reads no system git config: a filter named there does not run', async () => {
  const d = filterRepo('sys-cfg');
  const sys = join(BASE, 'system.gitconfig');
  writeFileSync(sys, `[filter "x"]\n\tsmudge = touch ${sq(mark('sys-smudge'))} && cat\n`);
  cloneTo(d, { GIT_CONFIG_SYSTEM: sys });
  assert.equal(existsSync(mark('sys-smudge')), true, 'control: a plain clone runs the system filter');
  rmSync(mark('sys-smudge'));
  const run = await withEnv({ GIT_CONFIG_SYSTEM: sys }, () => prepareClone({ cwd: d }));
  try {
    assert.equal(existsSync(mark('sys-smudge')), false, 'the system config\'s smudge filter ran on the reviewed repo');
  } finally {
    removeRun(run.runDir);
  }
});

// core.hooksPath=/dev/null: a hook directory that arrives through the environment (a template dir) is not run by the clone.
test('the clone runs no hook, even one a git template dir in the environment would install', async () => {
  const d = join(BASE, 'tmpl-repo');
  gitRepo(d);
  const tmpl = join(BASE, 'tmpl');
  mkdirSync(join(tmpl, 'hooks'), { recursive: true });
  writeFileSync(join(tmpl, 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${sq(mark('tmpl-hook'))}\n`);
  chmodSync(join(tmpl, 'hooks', 'post-checkout'), 0o755);
  cloneTo(d, { GIT_TEMPLATE_DIR: tmpl });
  assert.equal(existsSync(mark('tmpl-hook')), true, 'control: a plain clone runs the template\'s post-checkout hook');
  rmSync(mark('tmpl-hook'));
  const run = await withEnv({ GIT_TEMPLATE_DIR: tmpl }, () => prepareClone({ cwd: d }));
  try {
    assert.equal(existsSync(mark('tmpl-hook')), false, 'a post-checkout hook ran during the clone');
  } finally {
    removeRun(run.runDir);
  }
});

// filter.lfs.*: an `lfs` filter defined through the environment is overridden to nothing, as git-lfs would be.
test('the clone smudges nothing through a filter named lfs, however it is configured', async () => {
  const d = join(BASE, 'lfs-repo');
  gitRepo(d, { files: { 'x.bin': 'pointer\n' } });
  // This machine's own gitconfig may name git-lfs: the repo is set up, and the control run, without it.
  const bare = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  writeFileSync(join(d, '.gitattributes'), '*.bin filter=lfs\n');
  execFileSync('git', ['-C', d, 'add', '.gitattributes'], { env: { ...process.env, ...bare } });
  execFileSync('git', ['-C', d, ...GIT_ID, 'commit', '-qm', 'attributes'], { env: { ...process.env, ...bare } });
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.lfs.smudge', GIT_CONFIG_VALUE_0: `touch ${sq(mark('lfs-smudge'))} && cat` };
  cloneTo(d, { ...bare, ...env });
  assert.equal(existsSync(mark('lfs-smudge')), true, 'control: a plain clone runs an lfs smudge filter');
  rmSync(mark('lfs-smudge'));
  const run = await withEnv(env, () => prepareClone({ cwd: d }));
  try {
    assert.equal(existsSync(mark('lfs-smudge')), false, 'an lfs smudge filter ran during the clone');
    assert.equal(readFileSync(join(run.clone, 'x.bin'), 'utf8'), 'pointer\n');
  } finally {
    removeRun(run.runDir);
  }
});

// --no-ext-diff / --no-textconv: the clone's .gitattributes is the model's; a driver defined outside the repository must not run on its files.
test('cloneDiff runs no external diff and no textconv, whatever the environment and a model-written .gitattributes name', async () => {
  const d = join(BASE, 'extdiff');
  gitRepo(d, { files: { 'x.dat': 'one\n' } });
  const script = join(BASE, 'extdiff.sh');
  writeFileSync(script, `#!/bin/sh\ntouch ${sq(mark('ext-diff'))}\n`);
  chmodSync(script, 0o755);
  const env = { GIT_EXTERNAL_DIFF: script, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.evil.textconv', GIT_CONFIG_VALUE_0: `${script} #` };
  const { value: run } = withTmpRoot(() => prepareClone({ cwd: d }));
  try {
    writeFileSync(join(run.clone, '.gitattributes'), '*.dat diff=evil\n');
    writeFileSync(join(run.clone, 'x.dat'), 'two\n');
    // Control: unprotected, the same clone runs the driver.
    execFileSync('git', ['-C', run.clone, '--git-dir', join(run.out, 'git'), 'diff'], { env: { ...process.env, ...env }, stdio: 'pipe' });
    assert.equal(existsSync(mark('ext-diff')), true, 'control: git diff runs the external diff / textconv');
    rmSync(mark('ext-diff'));
    const diff = await withEnv(env, () => cloneDiff(run.clone));
    assert.equal(existsSync(mark('ext-diff')), false, 'an external diff or a textconv driver ran on the adapter\'s side');
    assert.match(diff, /^\+two$/m);
  } finally {
    removeRun(run.runDir);
  }
});

// runsRoot's owner check: a directory of another user's at the path is refused (process.getuid is the seam; chown needs root).
test('runsRoot refuses a directory that belongs to another user', () => {
  const real = process.getuid;
  withTmpRoot(() => {
    assert.ok(runsRoot().endsWith('omelette-mistral-repro'));
    process.getuid = () => real.call(process) + 1;
    try {
      assert.throws(() => runsRoot(), /belongs to uid \d+, not this user — remove it/);
    } finally {
      process.getuid = real;
    }
  });
});

// runsRoot fails closed: a runsRoot whose mode has drifted and cannot be put back (an immutable flag stops chmod) is an error, not a silent 0755 parent.
test('runsRoot throws when it cannot restore 0700', { skip: !DARWIN }, () => {
  withTmpRoot(() => {
    const parent = runsRoot();
    chmodSync(parent, 0o755);
    assert.equal(spawnSync('/usr/bin/chflags', ['uchg', parent]).status, 0);
    try {
      assert.throws(() => runsRoot(), /chmod .*omelette-mistral-repro/);
    } finally {
      spawnSync('/usr/bin/chflags', ['nouchg', parent]);
    }
  });
});

/* ── round 3: modes fixed under the sandbox, nowhere else ───────────────────── */

// fixModes runs chmod THROUGH the wrapper, so a path outside the clone and tmp is refused by the kernel: the adapter's own chmod is no wider than the model's.
test('fixModes cannot change a mode outside the clone and tmp: a 444 file outside them keeps its mode and the call reports failure', { skip: !KERNEL }, () => {
  const w = profileWorld();
  // Outside every writable root of the profile (the clone and its tmp): under /private/tmp.
  const outDir = realpathSync(mkdtempSync(join(HOMES, 'omelette-mistral-t3t-fixout-')));
  made.push(outDir);
  const outside = join(outDir, 'outside');
  writeFileSync(outside, 'o\n');
  chmodSync(outside, 0o444);
  chmodSync(join(w.a, 'clone', 'f'), 0o000);
  const logs = [];
  assert.equal(fixModes({ wrapper: w.wrapper, env: w.env, paths: [outside], log: (m) => logs.push(m) }), false);
  assert.equal(statSync(outside).mode & 0o777, 0o444, 'the kernel refused the chmod');
  assert.equal(logs.length, 1, logs.join('\n'));
  assert.match(logs[0], /^repro: chmod -R under the sandbox exited [1-9]/);
  assert.equal(fixModes({ wrapper: w.wrapper, env: w.env, paths: [join(w.a, 'clone'), join(w.a, 'tmp')] }), true);
  assert.equal(statSync(join(w.a, 'clone', 'f')).mode & 0o777, 0o600, 'control: inside the clone the same call works');
});

// The tmp dir is the model's too: a locked directory there must not stop the run's removal.
test('a directory the model locked in its TMPDIR does not leave the run behind', { skip: !KERNEL }, async () => {
  const w = world({ edit: (s) => { s.shell = 'mkdir "$OMELETTE_REPRO_TMP/locked" && echo x > "$OMELETTE_REPRO_TMP/locked/f" && chmod 000 "$OMELETTE_REPRO_TMP/locked"'; } });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  const [s] = w.spawns();
  assert.equal(s.ran.status, 0, s.ran.stderr);
  assert.equal(existsSync(dirname(s.workdir)), false, 'the run directory is removed');
});

// A run that fails before the pre-diff fix (no export.json) still ends in removeRun: the fix it is handed must be the one that works.
test('a failed run (no export.json) after the model locked a directory still removes the run', { skip: !KERNEL }, async () => {
  const w = world({ edit: (s) => { s.shell = 'mkdir locked && echo x > locked/f && chmod 000 locked'; s.export = null; s.code = 1; } });
  const r = await w.repro();
  const [s] = w.spawns();
  assert.equal(s.ran.status, 0, s.ran.stderr);
  assert.equal(r.isError, true);
  assert.match(r.text, /no export\.json/);
  assert.equal(existsSync(dirname(s.workdir)), false, 'the run directory is removed');
});
