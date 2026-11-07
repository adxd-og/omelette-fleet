// 1.9.0 whole-branch review fix round — the tester's file. The rulings of the round (ledger, "Whole-branch review,
// Opus") checked through their public entry points: the real kernel profile (repro.sb under /usr/bin/sandbox-exec),
// the repro and review tools with a fake `vibe`, the guard hook as a child process, the CLI. Kernel rows skip
// without sandbox-exec. Every probe uses a temp HOME / OMELETTE_HOME and a fake VIBE_BIN; `vibe` is never run. The
// real HOME appears in one row only, and only to run git / node / python3 in a clone and to be refused a `ls`.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import unit from '../units/mistral/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';
import { ensureHome } from '../units/mistral/home.mjs';
import {
  LINKS_CAP, appendPatch, clearRun, fixModes, neutraliseModelText, nodeEnv, outsideLinks, prepareClone, regexLiteral, removeRun, runsRoot,
} from '../units/mistral/repro.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DARWIN = process.platform === 'darwin';
// sandbox-exec cannot nest: inside a sandbox even an allow-everything profile fails, and the kernel rows skip.
const KERNEL = DARWIN && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-rftest-')));
// A HOME outside every root the profile lets a command write (/private/tmp on macOS, not /private/var/folders).
const HOMES = DARWIN ? '/private/tmp' : BASE;
const made = [BASE];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const GIT_ID = ['-c', 'user.name=omelette test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];

/** A git work tree at `dir` with one commit of `files` (default README.md). */
function gitRepo(dir, files = { 'README.md': 'demo\n' }) {
  mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q');
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  git('add', '-A');
  git(...GIT_ID, 'commit', '-qm', 'one');
  return dir;
}

const tempHome = (tag) => { const d = realpathSync(mkdtempSync(join(HOMES, `omelette-rftest-${tag}-`))); made.push(d); return d; };

/**
 * A real run of a fresh git repo (prepareClone) and the repro wrapper's env for it, as reproOnce builds it. `home`
 * is the HOME the profile is given; `node` the NODE prefix (default: the one the tests run on); `src` the work tree.
 */
let seq = 0;
function sandboxedRun({ home, node, src, fleet: fleetDir } = {}) {
  const d = src || gitRepo(join(BASE, `src${++seq}`));
  const run = prepareClone({ cwd: d });
  const fleet = fleetDir || join(BASE, `fleet${seq}`);
  const { dir } = ensureHome({ home: fleet, profile: 'repro' });
  const env = {
    PATH: '/usr/bin:/bin', HOME: home, OMELETTE_FLEET_HOME: realpathSync(fleet), OMELETTE_REPRO_CLONE: run.clone, OMELETTE_REPRO_TMP: run.tmp,
    OMELETTE_REPRO_OUT: run.out, OMELETTE_REPRO_RUNS: realpathSync(runsRoot()), OMELETTE_REPRO_RUN: run.runDir,
    OMELETTE_REPRO_TMPROOT: regexLiteral(realpathSync(tmpdir())), OMELETTE_REPRO_SRC: realpathSync(run.top),
    ...(node ? nodeEnv({ home, prefix: node, binary: join(node, 'bin', 'node') }) : nodeEnv({ home })), TMPDIR: run.tmp, T_HOME: home,
  };
  const wrapper = join(dir, 'shell.sh');
  const sh = (script, extra = {}) => spawnSync(wrapper, ['-c', script], { env: { ...env, ...extra }, cwd: run.clone, encoding: 'utf8', timeout: 120_000 });
  const cleanup = () => removeRun(run.runDir, { clear: () => clearRun({ wrapper, env, paths: [run.clone, run.tmp] }), fix: () => fixModes({ wrapper, env, paths: [run.clone, run.tmp] }) });
  return { run, wrapper, env, sh, cleanup };
}
/** `k=v` lines of a script's output as an object. */
const rowsOf = (stdout) => Object.fromEntries([...stdout.matchAll(/^(\w+)=(\d+)$/gm)].map((m) => [m[1], Number(m[2])]));

/* ── A. the profile, under the real kernel ─────────────────────────────────────────────────────────────────── */

test('profile: the node prefix is re-allowed past the HOME deny, and nothing else under HOME — not a sibling install, not the dir that holds them', { skip: !KERNEL }, () => {
  const home = tempHome('node');
  for (const [d, f] of [['nvm/v20/bin', 'tool'], ['nvm/v18/bin', 'tool'], ['other', 'note']]) {
    mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, d, f), 'x\n');
  }
  const s = sandboxedRun({ home, node: join(home, 'nvm', 'v20') });
  try {
    const r = s.sh([
      'cat "$T_HOME/nvm/v20/bin/tool" >/dev/null 2>&1; echo prefix=$?',
      'cat "$T_HOME/nvm/v18/bin/tool" >/dev/null 2>&1; echo sibling=$?',
      'ls "$T_HOME/nvm" >/dev/null 2>&1; echo parent=$?',
      'cat "$T_HOME/other/note" >/dev/null 2>&1; echo other=$?',
    ].join('\n'));
    assert.deepEqual(rowsOf(r.stdout), { prefix: 0, sibling: 1, parent: 1, other: 1 }, r.stdout + r.stderr);
  } finally { s.cleanup(); }
});

test('profile: the work tree under review (SRC) and the fleet home are unreadable where no other rule shadows them — outside the HOME and the omelette-* temp dirs', { skip: !KERNEL }, () => {
  const home = tempHome('h2');
  const src = gitRepo(join(tempHome('src'), 'repo'));
  const fleet = tempHome('fleet');
  const s = sandboxedRun({ home, src, fleet });
  try {
    // Controls: both are readable from outside the sandbox.
    assert.equal(readFileSync(join(src, 'README.md'), 'utf8'), 'demo\n');
    const r = s.sh([
      'cat "$OMELETTE_REPRO_SRC/README.md" >/dev/null 2>&1; echo src=$?',
      'ls "$OMELETTE_REPRO_SRC" >/dev/null 2>&1; echo srcdir=$?',
      'ls "$OMELETTE_FLEET_HOME/vibe/repro" >/dev/null 2>&1; echo fleet=$?',
      'cat README.md >/dev/null 2>&1; echo clone=$?',
    ].join('\n'));
    assert.deepEqual(rowsOf(r.stdout), { src: 1, srcdir: 1, fleet: 1, clone: 0 }, r.stdout + r.stderr);
  } finally { s.cleanup(); }
});

test('profile: the operator\'s real HOME is unreadable and the work tree under review is not in the clone\'s reach — yet git, node, node --test and python3 run in a HEAD clone of this repo', { skip: !KERNEL || spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree']).status !== 0 }, () => {
  const home = realpathSync(homedir());
  const s = sandboxedRun({ home, src: ROOT });
  try {
    writeFileSync(join(s.run.clone, 'rf.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
    const r = s.sh([
      'git status --porcelain >/dev/null 2>&1; echo gitstatus=$?',
      'git log -1 --format=%h >/dev/null 2>&1; echo gitlog=$?',
      '"$NODE" --version >/dev/null 2>&1; echo nodeversion=$?',
      '"$NODE" --test rf.test.mjs >/dev/null 2>&1; echo nodetest=$?',
      "python3 -c 'import ssl, sqlite3' >/dev/null 2>&1; echo python=$?",
      // A refused ls (HOME exists, so a failure is the profile's); nothing of the home or the work tree is printed.
      'ls "$T_HOME" >/dev/null 2>&1; echo home=$?',
      'ls "$OMELETTE_REPRO_SRC" >/dev/null 2>&1; echo src=$?',
      'cat "$OMELETTE_REPRO_SRC/package.json" >/dev/null 2>&1; echo srcfile=$?',
    ].join('\n'), { NODE: process.execPath });
    assert.deepEqual(rowsOf(r.stdout), { gitstatus: 0, gitlog: 0, nodeversion: 0, nodetest: 0, python: 0, home: 1, src: 1, srcfile: 1 }, r.stdout + r.stderr);
  } finally { s.cleanup(); }
});

test('profile: no other process\'s argv is readable — not by sysctl kern.procargs, not by pgrep -f (which asks the sysmond service)', { skip: !KERNEL }, async () => {
  const arg = `7${process.pid}`;
  const outside = spawn('/bin/sleep', [arg], { stdio: 'ignore' });
  const home = tempHome('argv');
  const s = sandboxedRun({ home });
  try {
    await new Promise((res) => setTimeout(res, 150));
    // Control: outside the sandbox the sleeper is found by its argv.
    const control = spawnSync('/usr/bin/pgrep', ['-f', arg], { encoding: 'utf8' }).stdout.split('\n');
    assert.ok(control.includes(String(outside.pid)), 'control: pgrep -f finds the sleeper outside the sandbox');
    // Inside: the sleeper's pid must not come back for a pattern only its argv holds (the sandbox's own bash may match).
    const r = s.sh(`pgrep -f ${arg} 2>/dev/null | grep -c '^${outside.pid}$'; true`);
    assert.equal(r.stdout.trim(), '0', `pgrep -f read another process's argv from inside the sandbox: ${r.stdout}${r.stderr}`);
    const l = s.sh(`pgrep -lf ${arg} 2>/dev/null | grep -c '/bin/sleep ${arg}'; true`);
    assert.equal(l.stdout.trim().split('\n').pop(), '0', `pgrep -lf printed another process's command line: ${l.stdout}`);
  } finally {
    outside.kill('SIGKILL');
    s.cleanup();
  }
});

test('profile: no signal or descriptor listing of a process outside the sandbox (own allowed), no preference write, and a copied launchctl dies on submit', { skip: !KERNEL }, async () => {
  const outside = spawn('/bin/sleep', [`6${process.pid}`], { stdio: 'ignore' });
  const domain = `com.omelette.rftest.${process.pid}`;
  const home = tempHome('proc');
  const s = sandboxedRun({ home });
  try {
    await new Promise((res) => setTimeout(res, 150));
    const r = s.sh([
      `"$NODE" -e "try{process.kill(${outside.pid},0);process.exit(0)}catch(e){process.exit(e.code==='EPERM'?7:8)}"; echo killout=$?`,
      '/bin/sleep 30 & c=$!; "$NODE" -e "process.kill(+process.argv[1],0)" $c; echo killown=$?; kill $c',
      `/usr/sbin/lsof -p ${outside.pid} 2>/dev/null | wc -l | tr -d ' ' | sed 's/^/lsoflines=/'`,
      `defaults write ${domain} k v >/dev/null 2>&1; true`,
      'cp /bin/launchctl "$TMPDIR/l"; "$TMPDIR/l" submit -l com.omelette.rftest -- /usr/bin/true >/dev/null 2>&1; echo submit=$?',
    ].join('\n'), { NODE: process.execPath });
    const { submit, ...rows } = rowsOf(r.stdout);
    assert.deepEqual(rows, { killout: 7, killown: 0, lsoflines: 0 }, r.stdout + r.stderr);
    // job-creation is denied: macOS 27 kills the copied launchctl (137), macOS 26 (CI) lets it exit 1 — either way no job exists, seen from outside.
    assert.notEqual(submit, 0, `a copied launchctl submitted a job: ${r.stdout}`);
    assert.notEqual(spawnSync('/bin/launchctl', ['list', 'com.omelette.rftest']).status, 0, 'the job a copied launchctl submitted exists outside the sandbox');
    // The preference write landed nowhere: read from outside, the domain does not exist.
    assert.notEqual(spawnSync('/usr/bin/defaults', ['read', domain]).status, 0, 'a defaults write from inside the sandbox reached the operator\'s preferences');
  } finally {
    outside.kill('SIGKILL');
    spawnSync('/usr/bin/defaults', ['delete', domain]);
    spawnSync('/bin/launchctl', ['remove', 'com.omelette.rftest']);
    s.cleanup();
  }
});

test('profile: another terminal is neither read nor written (the operator\'s ptys); /dev/null and the fd devices still are', { skip: !KERNEL }, () => {
  const uid = process.getuid();
  const tty = readdirSync('/dev').filter((d) => /^ttys\d+$/.test(d)).find((d) => { try { return lstatSync(join('/dev', d)).uid === uid; } catch { return false; } });
  if (!tty) return; // no pty of this user to refuse
  const probe = `(exec 3<>/dev/${tty}) 2>/dev/null; echo both=$?; (exec 3</dev/${tty}) 2>/dev/null; echo read=$?; (exec 3>/dev/${tty}) 2>/dev/null; echo write=$?`;
  const control = rowsOf(spawnSync('/bin/bash', ['-c', probe], { encoding: 'utf8', timeout: 10_000 }).stdout);
  if (control.read !== 0 || control.write !== 0) return; // the pty cannot be opened even outside: nothing to compare
  const home = tempHome('tty');
  const s = sandboxedRun({ home });
  try {
    const r = s.sh(`${probe}\necho x >/dev/null; echo null=$?; echo x >/dev/fd/2; echo fd=$?`);
    assert.deepEqual(rowsOf(r.stdout), { both: 1, read: 1, write: 1, null: 0, fd: 0 }, r.stdout + r.stderr);
  } finally { s.cleanup(); }
});

test('profile: nothing is created, moved over or linked at <clone>/.vibe; its neighbours are writable', { skip: !KERNEL }, () => {
  const home = tempHome('vibe');
  const s = sandboxedRun({ home });
  try {
    const r = s.sh([
      'mkdir .vibe 2>/dev/null; echo mkdir=$?',
      'touch .vibe 2>/dev/null; echo touch=$?',
      'ln -s /private/tmp .vibe 2>/dev/null; echo symlink=$?',
      'mkdir -p sub/x; mv sub .vibe 2>/dev/null; echo rename=$?',
      'mkdir -p .vibe/inner 2>/dev/null; echo nested=$?',
      'echo b > .vibex; echo neighbour=$?',
      'test -e .vibe; echo exists=$?',
    ].join('\n'));
    assert.deepEqual(rowsOf(r.stdout), { mkdir: 1, touch: 1, symlink: 1, rename: 1, nested: 1, neighbour: 0, exists: 1 }, r.stdout + r.stderr);
  } finally { s.cleanup(); }
});

/* ── B. the clone, the run, the links ─────────────────────────────────────────────────────────────────────── */

test('removeRun: a 000 directory and a deny-delete ACL file in the clone — the run dir stays, one log line names it, OUT is gone, the operator\'s file is untouched', { skip: !KERNEL }, () => {
  const home = tempHome('acl');
  writeFileSync(join(home, 'keep'), 'operator file\n');
  const s = sandboxedRun({ home });
  const { clone } = s.run;
  try {
    mkdirSync(join(clone, 'locked'));
    writeFileSync(join(clone, 'locked', 'f'), 'x\n');
    chmodSync(join(clone, 'locked'), 0o000);
    writeFileSync(join(clone, 'pinned'), 'y\n');
    const who = spawnSync('/usr/bin/id', ['-un'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(spawnSync('/bin/chmod', ['+a', `user:${who} deny delete`, join(clone, 'pinned')]).status, 0);
    const logs = [];
    const done = removeRun(s.run.runDir, {
      log: (l) => logs.push(l),
      clear: () => clearRun({ wrapper: s.wrapper, env: s.env, paths: [clone, s.run.tmp] }),
      fix: () => fixModes({ wrapper: s.wrapper, env: s.env, paths: [clone, s.run.tmp] }),
    });
    assert.equal(done, false);
    assert.equal(logs.length, 1, logs.join('\n'));
    assert.match(logs[0], new RegExp(`^repro run dir not removed: ${regexLiteral(s.run.runDir)} — `));
    assert.equal(existsSync(join(clone, 'pinned')), true, 'what the profile could not remove stays');
    assert.equal(existsSync(join(clone, 'locked')), false, 'the 000 directory was given back and removed');
    assert.equal(existsSync(s.run.out), false, 'OUT, which no command can write, goes');
    assert.equal(readFileSync(join(home, 'keep'), 'utf8'), 'operator file\n');
  } finally {
    spawnSync('/bin/chmod', ['-N', join(clone, 'pinned')]);
    rmSync(s.run.runDir, { recursive: true, force: true });
  }
});

test('outsideLinks: a link out of the tree is found whatever it points at — file, directory, dangling, a sibling that shares the prefix, a git-ignored one; links that stay inside are not', () => {
  const root = realpathSync(mkdtempSync(join(BASE, 'links-')));
  const work = join(root, 'work');
  gitRepo(work, { 'a/f.txt': 'f\n', '.gitignore': 'ignored-link\n' });
  mkdirSync(join(root, 'work-evil'));
  writeFileSync(join(root, 'work-evil', 'f'), 'x\n');
  mkdirSync(join(root, 'elsewhere'));
  // Inside: a file, the tree itself, a dangling one, and `..` that comes back in.
  symlinkSync('a/f.txt', join(work, 'in-file'));
  symlinkSync('.', join(work, 'in-self'));
  symlinkSync('no-such-file-inside', join(work, 'in-dangling'));
  mkdirSync(join(work, 'b'));
  symlinkSync('../a/f.txt', join(work, 'b', 'in-up'));
  assert.equal(outsideLinks(work), null, 'every link stays inside');
  const cases = [
    ['out-dir', join(root, 'elsewhere')],
    ['out-dangling', join(root, 'does-not-exist')],
    ['out-prefix-sibling', join('..', 'work-evil', 'f')],
    ['ignored-link', join(root, 'elsewhere')],
  ];
  for (const [name, target] of cases) {
    symlinkSync(target, join(work, name));
    const found = outsideLinks(work);
    assert.deepEqual(found, { path: join(work, name), target }, name);
    rmSync(join(work, name));
  }
  // A path with a line feed is reported on one line.
  symlinkSync(join(root, 'elsewhere'), join(work, 'bad\nname'));
  assert.deepEqual(outsideLinks(work), { path: JSON.stringify(join(work, 'bad\nname')), target: join(root, 'elsewhere') });
});

test('outsideLinks: LINKS_CAP links are checked, one more is refused as unchecked', () => {
  const dir = realpathSync(mkdtempSync(join(BASE, 'cap-')));
  for (let i = 0; i < LINKS_CAP; i++) symlinkSync('x', join(dir, `l${i}`));
  assert.equal(outsideLinks(dir), null, `${LINKS_CAP} links, all inside`);
  symlinkSync('x', join(dir, 'one-more'));
  const found = outsideLinks(dir);
  assert.equal(typeof found.unchecked, 'string', JSON.stringify(found));
  assert.match(found.unchecked, new RegExp(`more than ${LINKS_CAP} symlinks`));
});

test('appendPatch: the adapter\'s fence outruns a backtick run that only the diff holds', () => {
  const r = appendPatch('plain answer', 'diff --git a/x b/x\n+````````\n');
  assert.ok(r.includes('\n`````````diff\ndiff --git a/x b/x\n+````````\n`````````'), r);
  // …and one only the model's text holds, closed one longer by neutraliseModelText when left open.
  assert.equal(neutraliseModelText('a\n~~~\n```\nx'), 'a\n~~~\n```\nx\n~~~~');
});

/* ── B2. nodePrefix: the re-allowed prefix never covers the operator's home ──────────────────────────────── */

const FAKE = join(BASE, 'fake-vibe.mjs');
writeFileSync(FAKE, [
  'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
  'import { spawnSync } from "node:child_process";',
  'import { join } from "node:path";',
  'const [scenarioPath, ...argv] = process.argv.slice(2);',
  'const sc = JSON.parse(readFileSync(scenarioPath, "utf8"));',
  'const opt = (f) => argv[argv.indexOf(f) + 1];',
  'const cfg = readFileSync(join(process.env.VIBE_HOME, "config.toml"), "utf8");',
  'const shell = JSON.parse(/^shell = (".*")$/m.exec(cfg)[1]);',
  // The way Vibe runs a model's command: the home's shell, -c, in the workdir, with Vibe's own env.
  'const ran = sc.shell ? spawnSync(shell, ["-c", sc.shell], { cwd: opt("--workdir"), env: process.env, encoding: "utf8" }) : null;',
  'appendFileSync(sc.record, JSON.stringify({ node: process.env.OMELETTE_REPRO_NODE, ran: ran && { stdout: ran.stdout, stderr: ran.stderr } }) + "\\n");',
  'writeFileSync(join(opt("--output-dir"), "export.json"), JSON.stringify({ outcome: "finished", error: null, session_id: "s", usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: 0, steps: 1, exit_code: 0,',
  '  config: { active_model: opt("--model"), outside_workdir: "deny", enable_mcp: false, enable_connectors: false, tools: { bash: { shell } } } }));',
  'process.stdout.write("finding: x");',
].join('\n'));

/**
 * One repro call through the adapter with the fake vibe: the adapter's process runs with `home` as HOME and
 * `execPath` as its node (restored after); the fake runs `shell` through the unit's wrapper. Returns what the fake saw.
 */
async function reproCall({ execPath = process.execPath, home, shell = '' }) {
  const work = gitRepo(join(BASE, `np-repo${++seq}`));
  const fleet = join(BASE, `np-fleet${seq}`);
  mkdirSync(fleet);
  const record = join(BASE, `np-record${seq}`);
  const scenario = join(BASE, `np-scenario${seq}.json`);
  writeFileSync(scenario, JSON.stringify({ record, shell }));
  const real = process.execPath;
  const env = { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: fleet, VIBE_BIN: real };
  const rt = createUnitRuntime({
    ...unit,
    tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [FAKE, scenario, ...o.args] }) }) } : t)),
  }, { env });
  const saved = { HOME: process.env.HOME, ALLOW: process.env.OMELETTE_ALLOW_REPRO };
  process.env.HOME = home;
  process.env.OMELETTE_ALLOW_REPRO = '1';
  Object.defineProperty(process, 'execPath', { value: execPath, writable: true, configurable: true });
  try {
    const r = await rt.callTool('mistral_security_repro', { prompt: 'p', cwd: work });
    assert.equal(r.isError, undefined, r.text);
  } finally {
    Object.defineProperty(process, 'execPath', { value: real, writable: true, configurable: true });
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (saved.ALLOW === undefined) delete process.env.OMELETTE_ALLOW_REPRO; else process.env.OMELETTE_ALLOW_REPRO = saved.ALLOW;
  }
  return JSON.parse(readFileSync(record, 'utf8').trim().split('\n')[0]);
}
const nodeParamFor = async (o) => (await reproCall(o)).node;

// Seatbelt matches resolved paths, and the adapter resolves every path the profile reads (SRC, FLEET, RUNS …) — HOME
// is the one the wrapper takes from the environment as it stands.
test('profile: a HOME spelled through a symlink is denied by its real path too', { skip: !KERNEL }, async () => {
  const real = tempHome('linkhome');
  writeFileSync(join(real, 'notes'), 'operator notes\n');
  const link = `${real}-link`;
  symlinkSync(real, link);
  made.push(link);
  const { ran } = await reproCall({ home: link, shell: `cat ${sq(join(real, 'notes'))} >/dev/null 2>&1; echo via_real=$?; cat ${sq(join(link, 'notes'))} >/dev/null 2>&1; echo via_link=$?` });
  assert.deepEqual(rowsOf(ran.stdout), { via_real: 1, via_link: 1 }, ran.stdout + ran.stderr);
});

test('NODE: the install prefix is re-allowed when it is outside the operator\'s home; under it only its bin, npm and corepack; when it IS the home or an ancestor of it, the binary alone', { skip: !DARWIN }, async () => {
  const fakeNode = (dir) => { mkdirSync(dir, { recursive: true }); const p = join(dir, 'node'); writeFileSync(p, '#!/bin/sh\n'); chmodSync(p, 0o755); return p; };
  const top = realpathSync(mkdtempSync(join(BASE, 'np-')));
  // NODE is an anchored regex of subpaths (nodeReach): these paths and everything under them.
  const subpaths = (...paths) => `^(${paths.map(regexLiteral).join('|')})(/|$)`;
  // A prefix elsewhere: the prefix.
  const elsewhere = join(top, 'elsewhere');
  const home = join(top, 'home');
  mkdirSync(home);
  assert.equal(await nodeParamFor({ execPath: fakeNode(join(elsewhere, 'bin')), home }), subpaths(elsewhere));
  // A prefix inside the home (an nvm install): its bin, npm and corepack — never its other global packages.
  const nvm = join(home, '.nvm', 'v1');
  assert.equal(await nodeParamFor({ execPath: fakeNode(join(nvm, 'bin')), home }), subpaths(join(nvm, 'bin'), join(nvm, 'lib', 'node_modules', 'npm'), join(nvm, 'lib', 'node_modules', 'corepack')));
  // The prefix IS the home (node in ~/bin): the binary alone.
  const bin = fakeNode(join(home, 'bin'));
  assert.equal(await nodeParamFor({ execPath: bin, home }), subpaths(bin));
  // The prefix is an ancestor of the home: the binary alone.
  const deep = join(top, 'deep');
  const ancestor = fakeNode(join(top, 'bin'));
  mkdirSync(deep);
  assert.equal(await nodeParamFor({ execPath: ancestor, home: deep }), subpaths(ancestor));
});

/* ── D. doctor ─────────────────────────────────────────────────────────────────────────────────────────── */

test('doctor: the login line names config.toml when both ~/.vibe/config.toml and ~/.vibe/.env are there', () => {
  const dir = realpathSync(mkdtempSync(join(BASE, 'doctor-')));
  mkdirSync(join(dir, '.vibe'));
  writeFileSync(join(dir, '.vibe', 'config.toml'), '');
  writeFileSync(join(dir, '.vibe', '.env'), '');
  const vibe = join(dir, 'vibe');
  writeFileSync(vibe, `#!${process.execPath}\nif (process.argv[2] === '--version') { console.log('vibe 3.1.0'); process.exit(0); }\nprocess.exit(1);\n`);
  chmodSync(vibe, 0o755);
  const gone = join(dir, 'no-such-cli');
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'omelette-fleet.mjs'), 'doctor'], {
    cwd: dir, encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone, VIBE_BIN: vibe },
  });
  assert.match(r.stdout, /^ {2}login {7}OK — present \(~\/\.vibe\/config\.toml\)$/m, r.stdout + r.stderr);
});

/* ── C. the guard (rendered as renderHookFile does) ───────────────────────────────────────────────────── */

const C = 'comm' + 'it';
const REFUSED = 2;
const ALLOWED = 0;

function guardPath() {
  const dir = mkdtempSync(join(BASE, 'guard-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.9.0'));
  return path;
}
/** The guard's exit code for one Bash command; `agent` null is the main thread (no agent_type). */
function guardExit(path, command, agent = 'omelette-reviewer') {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
  if (agent) event.agent_type = agent;
  const r = spawnSync(process.execPath, [path], { input: JSON.stringify(event), encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.signal, null, `the guard hung on ${JSON.stringify(command)}`);
  return r.status;
}
function guardRows(rows, agent) {
  const path = guardPath();
  const wrong = [];
  for (const [command, want] of rows) {
    const got = guardExit(path, command, agent);
    if (got !== want) wrong.push(`${JSON.stringify(command)}: want ${want}, got ${got}`);
  }
  assert.deepEqual(wrong, []);
}

test('guard: inside double quotes a form that stays one word is a value (rulings: `"$*"`, `"${*}"`, `"${a[*]}"`, `"${!p*}"`, `${x:-.}`); every split, nested or zsh form is refused unread', () => {
  guardRows([
    ['git -C "$*" status', ALLOWED],
    ['git -C "${*}" status', ALLOWED],
    ['git -C "${a[*]}" status', ALLOWED],
    ['git -C "${!pre*}" status', ALLOWED],
    ['git -C "${x:-.}" status', ALLOWED],
    // …whatever its operator: `${name<op>word}` with a word of no `$`, `@` or `(` is one word.
    ['git -C "${x#a/}" status', ALLOWED],
    ['git -C "${x%/*}" status', ALLOWED],
    ['git -C "${x/a/b}" status', ALLOWED],
    ['git -C "${x:+y}" status', ALLOWED],
    ['git -C "$(pwd)" status', ALLOWED],
    ['git -C "$@" -m x', REFUSED],
    ['git -C "${a[@]}" -m x', REFUSED],
    ['git -C "${@:2}" -m x', REFUSED],
    ['git -C "${x:-@}" status', REFUSED],
    ['git -C "${x:-(a)}" status', REFUSED],
    [`git -C "\${x:+$@ y}" ${C} -m z`, REFUSED],
    ['git -C "${x:+$@ y}" status', REFUSED],
    ['git -C "$a[1]" status', REFUSED],
    ['git -C "${=x}" status', REFUSED],
    // zsh's `$=x` splits even inside double quotes.
    ['git -C "$=x" -m y', REFUSED],
    ['git status $=x', ALLOWED],
  ]);
});

test('guard: a brace expansion in the program word is refused unread when any alternative is git; elsewhere it is read as the shell expands it', () => {
  guardRows([
    ['{git,x} status', REFUSED],
    [`/usr/bin/{git,x} ${C} -m x`, REFUSED],
    ['{ls,cat} README.md', ALLOWED],
    [`git {,${C}} -m x`, REFUSED],
    [`git {c,{c,d}}ommit -m x`, REFUSED],
    ['git pu{s..s..1}h', REFUSED],
    [`git -C {.,${C}} -m x`, REFUSED],
    [`git {--no-pager,-p} ${C} -m x`, REFUSED],
    [`git {log,${C}}`, REFUSED],
    ['git {log,status}', ALLOWED],
    ['git {st,sta}tus', ALLOWED],
    // BRACE_CAP is 256 words: 2^8 are read, 2^9 are read as anything at all.
    [`git ${'{a,b}'.repeat(8)}`, ALLOWED],
    [`git ${'{a,b}'.repeat(9)}`, REFUSED],
  ]);
});

test('guard: a glob in the subcommand slot is refused unread after global options too; quoted, escaped or in an argument it is not', () => {
  guardRows([
    ['git -C . c?mmit', REFUSED],
    ['git --no-pager c?mmit', REFUSED],
    ['git -c user.name=x co*t', REFUSED],
    ["git 'c?mmit'", ALLOWED],
    ['git "co*t"', ALLOWED],
    ['git c\\?mmit', ALLOWED],
    ["git diff -- 'a*'", ALLOWED],
    ['git -C . log *.md', ALLOWED],
  ]);
});

test('guard: a heredoc body is read as a command when a shell, eval or source is anywhere on the line, or the line pipes on; any other body is text', () => {
  const body = `\ngit ${C} -m x\nEOF`;
  guardRows([
    [`eval <<'EOF'${body}`, REFUSED],
    [`source /dev/stdin <<'EOF'${body}`, REFUSED],
    [`bash<<'EOF'${body}`, REFUSED],
    [`(bash <<'EOF'${body}\n)`, REFUSED],
    [`{ bash <<'EOF'${body}\n}`, REFUSED],
    [`sudo bash <<'EOF'${body}`, REFUSED],
    [`bash <<'EOF' && echo done${body}`, REFUSED],
    // The line ends in a pipe: the shell that reads the body comes after the terminator line.
    [`cat <<'EOF' |\ngit ${C} -m x\nEOF\nsh`, REFUSED],
    [`cat <<'EOF' &&\ngit ${C} -m x\nEOF\nbash`, REFUSED],
    [`bash \\\n <<'EOF'${body}`, REFUSED],
    [`cat <<'EOF' | tee x | bash${body}`, REFUSED],
    [`sh <<-EOF\n\tgit ${C} -m x\n\tEOF`, REFUSED],
    // A second heredoc inside the body: its text is data until the shell's own body goes on.
    [`bash <<'EOF'\ncat <<'IN'\nhello\nIN\ngit ${C} -m x\nEOF`, REFUSED],
    [`bash <<'EOF'\ncat <<'IN'\ngit ${C} -m x\nIN\nEOF`, ALLOWED],
    [`cat <<'EOF' > s.sh${body}\nbash s.sh`, ALLOWED],
    [`bash <<'EOF'\ngit status\nEOF`, ALLOWED],
    // Only the heredoc's own line counts: a shell on an earlier line feeds nothing here, one on this line does.
    [`bash x\ncat <<'EOF'\ngit ${C} -m x\nEOF`, ALLOWED],
    [`echo hi\nbash <<'EOF'\ngit ${C} -m x\nEOF`, REFUSED],
  ]);
});

// The SECURITY paragraph says a heredoc body on a line that runs `eval` (or any shell) "anywhere on the line" is read as
// a command. The idiom `eval "$(cat <<'EOF' … EOF)"` runs the body and passes: the heredoc belongs to the `cat` inside
// the substitution, whose line holds no shell.
test('guard: the body of a heredoc inside a command substitution that eval or bash -c runs is read as a command', () => {
  guardRows([
    [`eval "$(cat <<'EOF'\ngit ${C} -m x\nEOF\n)"`, REFUSED],
    [`bash -c "$(cat <<'EOF'\ngit ${C} -m x\nEOF\n)"`, REFUSED],
  ]);
});

test('guard: a git that xargs hands its subcommand is refused unread whatever xargs\' own options are; one with a subcommand of its own is read as a git', () => {
  guardRows([
    ['xargs -0 git', REFUSED],
    ['xargs -0 -n 1 git', REFUSED],
    ['xargs -n 1 -- git', REFUSED],
    ['xargs -L1 git', REFUSED],
    ["xargs -E '' git", REFUSED],
    ['xargs -t git', REFUSED],
    ['xargs --max-args=1 git', REFUSED],
    ['xargs --max-args 1 git', REFUSED],
    ['xargs -a f git', REFUSED],
    ['xargs -s 100 git', REFUSED],
    ['xargs /usr/bin/git', REFUSED],
    [`find . | xargs -I{} git {} -m x`, REFUSED],
    [`xargs -i git {} -m x`, REFUSED],
    [`xargs --replace git {} -m x`, REFUSED],
    [`xargs --replace=@ git @ -m x`, REFUSED],
    ['xargs -J % git % x', REFUSED],
    ['xargs git stash', REFUSED],
    ['xargs git status', ALLOWED],
    ['xargs git log', ALLOWED],
    ['xargs git diff --', ALLOWED],
    ['xargs git -C . log', ALLOWED],
    ['xargs echo git', ALLOWED],
    ['xargs -I {} echo {}', ALLOWED],
  ]);
});

// braceWords recurses once per group before the BRACE_CAP check is reached, so a word of a few thousand groups
// overflows the stack; the guard's outer catch turns the throw into exit 0, and the whole line passes with it.
test('guard: a word of thousands of brace groups does not crash the guard open — a commit on the same line is still refused', () => {
  guardRows([
    [`git ${C} -m x; echo ${'{a,b}'.repeat(6000)}`, REFUSED],
    [`git ${C} -m x; echo ${'x{a..b}'.repeat(6000)}`, REFUSED],
    [`echo ${'{a,b}'.repeat(6000)}; git ${C} -m x`, REFUSED],
  ]);
});

test('guard: the main thread and an unnamed agent are never refused', () => {
  const path = guardPath();
  for (const command of [`git ${C} -m x`, `bash <<'EOF'\ngit ${C} -m x\nEOF`, `{git,x} ${C}`, `xargs -0 git`]) {
    assert.equal(guardExit(path, command, null), 0, command);
  }
});
