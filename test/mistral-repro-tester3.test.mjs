// 1.9.0 Task 3c, tester pass: the clone and tmp directories cannot be unlinked or replaced.
// Kernel layer (repro.sb) measured on the parents and on the rename(2) shapes `mv` cannot make;
// adapter layer (assertRun) on a dev/ino drift and on the one swap route the kernel line leaves open
// (an ancestor of the run directory renamed). A fake `vibe` runs one scripted command through the home's
// real wrapper, as test/mistral-repro.test.mjs does.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import unit from '../units/mistral/adapter.mjs';
import { assertRun, prepareClone, regexLiteral, removeRun, runsRoot } from '../units/mistral/repro.mjs';
import { ensureHome } from '../units/mistral/home.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const DARWIN = process.platform === 'darwin';
const KERNEL = DARWIN && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-mistral-t3c-')));
const HOMES = DARWIN ? '/private/tmp' : BASE;
const made = [BASE];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const REFUSAL = /mistral: the clone or its tmp directory was replaced during the run — the answer is withheld/;

const FAKE = join(BASE, 'fake-vibe.mjs');
writeFileSync(FAKE, [
  'import { appendFileSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";',
  'import { spawnSync } from "node:child_process";',
  'import { join } from "node:path";',
  'const [scenarioPath, ...argv] = process.argv.slice(2);',
  'const sc = JSON.parse(readFileSync(scenarioPath, "utf8"));',
  'const opt = (f) => argv[argv.indexOf(f) + 1];',
  'const outDir = opt("--output-dir");',
  'const workdir = opt("--workdir");',
  'const shell = JSON.parse(/^shell = (".*")$/m.exec(readFileSync(join(process.env.VIBE_HOME, "config.toml"), "utf8"))[1]);',
  'process.env.FAKE_VIBE_DONE = sc.done || "";',
  'const ran = sc.shell ? spawnSync(shell, ["-c", sc.shell], { cwd: workdir, env: { ...process.env, T_HOME: process.env.HOME }, encoding: "utf8" }) : null;',
  'appendFileSync(sc.record, JSON.stringify({ workdir, ran: ran && { status: ran.status, stdout: ran.stdout, stderr: ran.stderr } }) + "\\n");',
  'writeFileSync(join(outDir, "export.json"), JSON.stringify({ outcome: "finished", stop_reason: null, error: null, session_id: "b7c1e2d0-0000-4000-8000-000000000003",',
  '  usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, total_tokens: 2 }, cost_usd: 0, steps: 1, exit_code: 0,',
  '  config: { active_model: opt("--model"), outside_workdir: "deny", enable_mcp: false, enable_connectors: false, tools: { bash: { shell } } } }));',
  'process.stdout.write("finding: x");',
  // The clone swapped for a link from outside the sandbox (what the kernel refuses a command): the adapter must still catch it.
  'if (sc.swap) { rmSync(workdir, { recursive: true, force: true }); symlinkSync(sc.swap, workdir); }',
].join('\n'));

const GIT_ID = ['-c', 'user.name=omelette test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
function gitRepo(dir) {
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString();
  mkdirSync(dir, { recursive: true });
  git('init', '-q');
  writeFileSync(join(dir, 'README.md'), 'demo\n');
  git('add', '-A');
  git(...GIT_ID, 'commit', '-qm', 'one');
}

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

let n = 0;
/** One world: HOME under /private/tmp, a git repo as cwd, the scenario (`shell`), a runtime whose tools spawn the fake. */
function world({ config, shell = () => '', swap } = {}) {
  const root = join(BASE, `w${++n}`);
  mkdirSync(root);
  const home = mkdtempSync(join(HOMES, 'omelette-mistral-t3c-home-'));
  made.push(home);
  const fleet = join(home, '.omelette');
  mkdirSync(fleet);
  if (config) writeFileSync(join(fleet, 'fleet.config.json'), JSON.stringify({ units: { mistral: config } }));
  const work = join(root, 'repo');
  gitRepo(work);
  const record = join(root, 'record.jsonl');
  const scenarioPath = join(root, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify({ record, swap, shell: shell({ root, work }) }));
  const env = { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: fleet, VIBE_BIN: process.execPath };
  const rt = createUnitRuntime({
    ...unit,
    tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [FAKE, scenarioPath, ...o.args] }) }) } : t)),
  }, { env });
  const spawns = () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  // The adapter takes HOME from its own process (resolved): the world's home is that HOME for the call.
  const repro = (extra = {}) => withEnv({ OMELETTE_ALLOW_REPRO: '1', HOME: home, ...extra }, () => rt.callTool('mistral_security_repro', { prompt: 'reproduce', cwd: work }));
  const exportsKept = () => { try { return readdirSync(join(fleet, 'results', 'mistral', 'exports')); } catch { return []; } };
  return { root, work, spawns, repro, exportsKept };
}

/** `node -e rename(a, b)` inside the sandbox: the rename(2) a `mv` into a directory never makes. */
const renameJs = (a, b) => `${sq(process.execPath)} -e 'try{require("fs").renameSync(process.argv[1],process.argv[2]);console.log("renamed")}catch(e){console.log(e.code)}' ${a} ${b}`;

/* ── assertRun: dev and ino each count, for each of the two directories ─────────── */

test('assertRun refuses a clone or tmp whose recorded dev or ino differs, one field at a time', { skip: !DARWIN }, () => {
  const d = join(BASE, 'assert-ids');
  gitRepo(d);
  const run = prepareClone({ cwd: d });
  try {
    assertRun(run);
    for (const dir of ['clone', 'tmp']) {
      for (const field of ['dev', 'ino']) {
        const ids = { ...run.ids, [dir]: { ...run.ids[dir], [field]: run.ids[dir][field] + 1 } };
        assert.throws(() => assertRun({ ...run, ids }), REFUSAL, `${dir}.${field}`);
      }
    }
    assertRun(run);
  } finally {
    removeRun(run.runDir);
  }
});

/* ── the kernel line: the two directories and the parents above them ─────────────── */

test('the kernel: tmp is held like the clone, rename(2) over an emptied clone or tmp is refused, the run dir and the runs root cannot be moved, a /var spelling and a link do not get round it', { skip: !KERNEL }, async () => {
  const w = world({
    shell: () => [
      'C="$OMELETTE_REPRO_CLONE"; T="$OMELETTE_REPRO_TMP"; R="$OMELETTE_REPRO_RUN"; RS="$OMELETTE_REPRO_RUNS"',
      // The temp root and the directory above it: no file, no link, no directory (the default TMPDIR here is the real one).
      'TR="$(dirname "$RS")"; H="$(dirname "$TR")"',
      'touch "$TR/p-$$" 2>/dev/null; echo touch_tmproot=$?; ln -s /tmp "$TR/q-$$" 2>/dev/null; echo ln_tmproot=$?; mkdir "$TR/m-$$" 2>/dev/null; echo mkdir_tmproot=$?',
      'touch "$H/p-$$" 2>/dev/null; echo touch_above=$?; ln -s /tmp "$H/q-$$" 2>/dev/null; echo ln_above=$?',
      'rmdir "$T"; echo tmp_rmdir=$?',
      'mv "$T" "$C/x"; echo tmp_mv=$?',
      'rmdir "$R"; echo run_rmdir=$?',
      'mv "$R" "$R.x"; echo run_mv=$?',
      'touch "$R/f"; echo run_touch=$?',
      'mv "$RS" "$RS.x"; echo runs_mv=$?',
      'V="${C#/private}"; mv "$V" "$T/y"; echo var_mv=$?; rmdir "$V"; echo var_rmdir=$?',
      'ln -s "$C" "$T/lnk"; rmdir "$T/lnk/"; echo slash_rmdir=$?; mv "$T/lnk/" "$T/z"; echo slash_mv=$?',
      'ln -sfn "$T" "$C"; echo lnsfn=$?',
      // rename(2) of a directory onto an EMPTY directory replaces it; `mv a dir` would move into it instead.
      'mkdir "$T/sib"; find "$C" -mindepth 1 -delete',
      `echo over_clone=$(${renameJs('"$T/sib"', '"$C"')})`,
      'mkdir "$C/sib"; find "$T" -mindepth 1 -maxdepth 1 -not -name sib -exec rm -rf {} +',
      `echo over_tmp=$(${renameJs('"$C/sib"', '"$T"')})`,
      `echo clone_still_dir=$(${sq(process.execPath)} -e 'const s=require("fs").lstatSync(process.argv[1]);console.log(s.isDirectory()?0:1)' "$C")`,
    ].join('\n'),
  });
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  const { ran } = w.spawns()[0];
  const out = ran.stdout + ran.stderr;
  for (const [k, v] of [
    ['touch_tmproot', '1'], ['ln_tmproot', '1'], ['mkdir_tmproot', '1'], ['touch_above', '1'], ['ln_above', '1'],
    ['tmp_rmdir', '1'], ['tmp_mv', '1'], ['run_rmdir', '1'], ['run_mv', '1'], ['run_touch', '1'], ['runs_mv', '1'],
    ['var_mv', '1'], ['var_rmdir', '1'], ['slash_rmdir', '1'], ['slash_mv', '1'], ['lnsfn', '0'],
    ['over_clone', 'EPERM'], ['over_tmp', 'EPERM'], ['clone_still_dir', '0'],
  ]) {
    assert.match(ran.stdout, new RegExp(`^${k}=${v}$`, 'm'), out);
  }
  assert.doesNotMatch(r.text, REFUSAL);
  assert.equal(existsSync(dirname(w.spawns()[0].workdir)), false, 'the run directory is removed');
});

/* ── no decoy tree can be built beside the run, and a swap from outside is still refused ── */

// The profile once let a command write anywhere under /private/var/folders: it could rename the temp root, put a link
// in its place and a decoy run behind it. Now it writes only to the clone and its tmp, so the decoy
// cannot even be built, and the temp root cannot be renamed.
test('a decoy run cannot be built beside the temp root and the temp root cannot be renamed: the run is an ordinary one', { skip: !KERNEL }, async () => {
  const tm = join(BASE, 'tm-swap');
  mkdirSync(tm);
  const w = world({
    shell: () => [
      `X=${sq(tm)}-evil; RN=$(basename "$OMELETTE_REPRO_RUN")`,
      'mkdir -p "$X/omelette-mistral-repro/$RN/out"; echo decoy=$?',
      `mv ${sq(tm)} ${sq(tm)}.x; echo mv=$?`,
      `ln -s "$X" ${sq(tm)}.y; echo ln=$?`,
    ].join('\n'),
  });
  made.push(`${tm}-evil`, `${tm}.x`, `${tm}.y`);
  const r = await withEnv({ TMPDIR: tm }, () => w.repro());
  const { ran } = w.spawns()[0];
  for (const k of ['decoy', 'mv', 'ln']) assert.match(ran.stdout, new RegExp(`^${k}=1$`, 'm'), ran.stdout + ran.stderr);
  assert.equal(r.isError, undefined, r.text);
  assert.equal(existsSync(`${tm}-evil`), false);
});

// assertRun still stands behind the kernel: a swap made from outside the sandbox, with reproKeep.
test('reproKeep and a clone swapped for a link from outside: withheld, the kept line is there, no byte behind the link reaches the text', { skip: !DARWIN }, async () => {
  const secret = join(BASE, 'secret-keep');
  mkdirSync(secret);
  writeFileSync(join(secret, 'SECRET'), 'operator-secret-bytes\n');
  const w = world({ config: { reproKeep: true }, swap: secret });
  const r = await w.repro();
  const runDir = dirname(w.spawns()[0].workdir);
  try {
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, REFUSAL);
    assert.match(r.text, /_\(clone kept: /);
    assert.doesNotMatch(r.text, /SECRET|operator-secret-bytes/);
    assert.equal(w.exportsKept().length, 0, 'nothing is read before the check');
    assert.equal(existsSync(runDir), true, 'the run directory is kept');
  } finally {
    removeRun(runDir);
  }
});

test('an ordinary run keeps its export.json in the spool (the premise of the check above)', { skip: !KERNEL }, async () => {
  const w = world();
  const r = await w.repro();
  assert.equal(r.isError, undefined, r.text);
  assert.equal(w.exportsKept().length, 1);
});
