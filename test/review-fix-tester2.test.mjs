// 1.9.0 whole-branch review fix round 2 — the second tester's file. What the first tester's file and the
// implementer's tests leave unpinned, checked through public entry points: the real kernel profile (repro.sb under
// /usr/bin/sandbox-exec), the repro tool with a fake `vibe`, the guard hook as a child process. Kernel rows skip
// without sandbox-exec. Every adapter run uses a temp HOME / OMELETTE_HOME and a fake VIBE_BIN; `vibe` is never run,
// and no row reads the operator's real HOME.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import unit from '../units/mistral/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';
import { ensureHome } from '../units/mistral/home.mjs';
import { NODEUP_NONE, clearRun, fixModes, nodeEnv, nodeReach, nodeUp, prepareClone, regexLiteral, removeRun, runsRoot } from '../units/mistral/repro.mjs';

const DARWIN = process.platform === 'darwin';
// sandbox-exec cannot nest: inside a sandbox even an allow-everything profile fails, and the kernel rows skip.
const KERNEL = DARWIN && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-rf2test-')));
// A HOME outside every root the profile lets a command write (/private/tmp on macOS, not /private/var/folders).
const HOMES = DARWIN ? '/private/tmp' : BASE;
const made = [BASE];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const GIT_ID = ['-c', 'user.name=omelette test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
const C = 'comm' + 'it';

function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(dir, 'README.md'), 'demo\n');
  git('add', '-A');
  git(...GIT_ID, 'commit', '-qm', 'one');
  return dir;
}
const tempHome = (tag) => { const d = realpathSync(mkdtempSync(join(HOMES, `omelette-rf2test-${tag}-`))); made.push(d); return d; };
const touch = (p, body = 'x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
/** `k=v` lines of a script's output as an object. */
const rowsOf = (stdout) => Object.fromEntries([...stdout.matchAll(/^(\w+)=(\d+)$/gm)].map((m) => [m[1], Number(m[2])]));

let seq = 0;
/** A real run of a fresh git repo and the repro wrapper's env for it, as reproOnce builds it; `node` is the NODE prefix. */
function sandboxedRun({ home, node }) {
  const d = gitRepo(join(BASE, `src${++seq}`));
  const run = prepareClone({ cwd: d });
  const fleet = join(BASE, `fleet${seq}`);
  const { dir } = ensureHome({ home: fleet, profile: 'repro' });
  const env = {
    PATH: '/usr/bin:/bin', HOME: home, OMELETTE_FLEET_HOME: realpathSync(fleet), OMELETTE_REPRO_CLONE: run.clone, OMELETTE_REPRO_TMP: run.tmp,
    OMELETTE_REPRO_OUT: run.out, OMELETTE_REPRO_RUNS: realpathSync(runsRoot()), OMELETTE_REPRO_RUN: run.runDir,
    OMELETTE_REPRO_TMPROOT: regexLiteral(realpathSync(tmpdir())), OMELETTE_REPRO_SRC: realpathSync(run.top),
    ...nodeEnv({ home, prefix: node, binary: join(node, 'bin', 'node') }), TMPDIR: run.tmp, T_HOME: home, NODE: process.execPath,
  };
  const wrapper = join(dir, 'shell.sh');
  const sh = (script, extra = {}) => spawnSync(wrapper, ['-c', script], { env: { ...env, ...extra }, cwd: run.clone, encoding: 'utf8', timeout: 120_000 });
  const cleanup = () => removeRun(run.runDir, { clear: () => clearRun({ wrapper, env, paths: [run.clone, run.tmp] }), fix: () => fixModes({ wrapper, env, paths: [run.clone, run.tmp] }) });
  return { run, env, sh, cleanup };
}

/* ── A. the profile, under the real kernel ─────────────────────────────────────────────────────────────────── */

test('profile: no process list and no process probe reaches a process outside the sandbox — pgrep -lf, pkill -0, ps, python3 os.kill, node process.kill — while git, node and python3 run', { skip: !KERNEL }, async () => {
  const arg = `8${process.pid}`;
  const outside = spawn('/bin/sleep', [arg], { stdio: 'ignore' });
  const s = sandboxedRun({ home: tempHome('proc'), node: realpathSync(dirname(dirname(process.execPath))) });
  try {
    await new Promise((res) => setTimeout(res, 150));
    // Controls: every one of these sees the sleeper from outside the sandbox.
    assert.equal(spawnSync('/usr/bin/pgrep', ['-lf', arg]).status, 0, 'control: pgrep -lf');
    assert.equal(spawnSync('/usr/bin/pkill', ['-0', '-f', arg]).status, 0, 'control: pkill -0');
    assert.equal(spawnSync('/bin/ps', ['-p', String(outside.pid)]).status, 0, 'control: ps');
    assert.equal(spawnSync('python3', ['-c', `import os; os.kill(${outside.pid}, 0)`]).status, 0, 'control: python3 os.kill');
    const r = s.sh([
      `pgrep -lf ${arg} >/dev/null 2>&1; echo pgrep_lf=$?`,
      `pgrep sleep >/dev/null 2>&1; echo pgrep_name=$?`,
      `pkill -0 -f ${arg} >/dev/null 2>&1; echo pkill0=$?`,
      `/bin/ps -p ${outside.pid} >/dev/null 2>&1; echo ps=$?`,
      `python3 -c 'import os; os.kill(${outside.pid}, 0)' >/dev/null 2>&1; echo pykill=$?`,
      `"$NODE" -e "process.kill(${outside.pid}, 0)" >/dev/null 2>&1; echo nodekill=$?`,
      // …yet the sandbox's own processes are its own, and the tools it needs run.
      'sleep 30 & c=$!; python3 -c "import os,sys; os.kill(int(sys.argv[1]), 0)" $c; echo pyown=$?; kill $c',
      'git --version >/dev/null 2>&1; echo git=$?',
      '"$NODE" --version >/dev/null 2>&1; echo node=$?',
      "python3 -c 'import ssl, sqlite3' >/dev/null 2>&1; echo python=$?",
    ].join('\n'));
    const rows = rowsOf(r.stdout);
    for (const refused of ['pgrep_lf', 'pgrep_name', 'pkill0', 'ps', 'pykill', 'nodekill']) assert.notEqual(rows[refused], 0, `${refused} reached a process outside the sandbox: ${r.stdout}${r.stderr}`);
    assert.deepEqual({ pyown: rows.pyown, git: rows.git, node: rows.node, python: rows.python }, { pyown: 0, git: 0, node: 0, python: 0 }, r.stdout + r.stderr);
  } finally {
    outside.kill('SIGKILL');
    s.cleanup();
  }
});

// A HOME holding an nvm-shaped install: the node prefix v20, a sibling version, a deeper non-chain dir, a directory whose
// name only starts like the chain's, and an unrelated one. Every path in the chain gets stat-able, none listable.
function nvmHome(tag, name = '.nvm') {
  const home = tempHome(tag);
  touch(join(home, name, 'versions', 'node', 'v20', 'bin', 'tool'));
  touch(join(home, name, 'versions', 'node', 'v18', 'bin', 'tool'));
  touch(join(home, name, 'alias', 'default'));
  touch(join(home, `${name}X`, 'note'));
  touch(join(home, 'other', 'note'));
  return home;
}

test('NODEUP: each directory from HOME down to the node prefix\'s parent is stat-able and none is listable; a name sharing the chain\'s prefix, a deeper dir and a sibling version are refused', { skip: !KERNEL }, () => {
  const home = nvmHome('chain');
  const node = join(home, '.nvm', 'versions', 'node', 'v20');
  const s = sandboxedRun({ home, node });
  try {
    const chain = ['', '.nvm', '.nvm/versions', '.nvm/versions/node'];
    const script = [
      ...chain.flatMap((p, k) => [`/usr/bin/stat -f %N "$T_HOME/${p}" >/dev/null 2>&1; echo stat${k}=$?`, `ls "$T_HOME/${p}" >/dev/null 2>&1; echo ls${k}=$?`]),
      '/usr/bin/stat -f %N "$T_HOME/.nvmX" >/dev/null 2>&1; echo shared_prefix=$?',
      'cat "$T_HOME/.nvmX/note" >/dev/null 2>&1; echo shared_prefix_file=$?',
      '/usr/bin/stat -f %N "$T_HOME/.nvm/alias" >/dev/null 2>&1; echo deeper=$?',
      'cat "$T_HOME/.nvm/alias/default" >/dev/null 2>&1; echo deeper_file=$?',
      '/usr/bin/stat -f %N "$T_HOME/.nvm/versions/node/v18" >/dev/null 2>&1; echo sibling_version=$?',
      '/usr/bin/stat -f %N "$T_HOME/other" >/dev/null 2>&1; echo other=$?',
      // The prefix itself is NODE's read allowance, not NODEUP's: its files read, its bin lists.
      'cat "$T_HOME/.nvm/versions/node/v20/bin/tool" >/dev/null 2>&1; echo prefix_file=$?',
      'ls "$T_HOME/.nvm/versions/node/v20/bin" >/dev/null 2>&1; echo prefix_ls=$?',
    ].join('\n');
    const r = s.sh(script);
    assert.deepEqual(rowsOf(r.stdout), {
      stat0: 0, ls0: 1, stat1: 0, ls1: 1, stat2: 0, ls2: 1, stat3: 0, ls3: 1,
      shared_prefix: 1, shared_prefix_file: 1, deeper: 1, deeper_file: 1, sibling_version: 1, other: 1, prefix_file: 0, prefix_ls: 0,
    }, r.stdout + r.stderr);
  } finally { s.cleanup(); }
});

test('NODEUP: a HOME and a node prefix whose names hold regex metacharacters (+ . ( ) [ ] $) are matched literally — the chain is stat-able, a lookalike the unescaped pattern would match is not', { skip: !KERNEL }, () => {
  const home = realpathSync(mkdtempSync(join(HOMES, 'omelette-rf2test-h+o.m(e)[x]$y-')));
  made.push(home);
  const node = join(home, 'n+v.(1)', 'v[2]$');
  touch(join(node, 'bin', 'tool'));
  touch(join(home, 'nnv.(1)', 'note')); // `n+v.(1)` unescaped reads as n+v then a group: this name is what it would match
  touch(join(home, 'n+vX(1)', 'note'));
  const s = sandboxedRun({ home, node });
  try {
    const r = s.sh([
      '/usr/bin/stat -f %N "$T_HOME" >/dev/null 2>&1; echo home=$?',
      '/usr/bin/stat -f %N "$T_HOME/n+v.(1)" >/dev/null 2>&1; echo parent=$?',
      'ls "$T_HOME/n+v.(1)" >/dev/null 2>&1; echo lsparent=$?',
      '/usr/bin/stat -f %N "$T_HOME/nnv.(1)" >/dev/null 2>&1; echo lookalike=$?',
      '/usr/bin/stat -f %N "$T_HOME/n+vX(1)" >/dev/null 2>&1; echo lookalike2=$?',
      'cat "$T_HOME/n+v.(1)/v[2]$/bin/tool" >/dev/null 2>&1; echo prefix_file=$?',
    ].join('\n'));
    assert.deepEqual(rowsOf(r.stdout), { home: 0, parent: 0, lsparent: 1, lookalike: 1, lookalike2: 1, prefix_file: 0 }, r.stdout + r.stderr);
  } finally { s.cleanup(); }
});

test('NODEUP: a node prefix outside HOME gives a pattern that matches nothing — HOME itself is not even stat-able, and git and python3 still run', { skip: !KERNEL }, () => {
  const home = nvmHome('outside');
  const node = realpathSync(mkdtempSync(join(BASE, 'node-outside-')));
  const s = sandboxedRun({ home, node });
  try {
    assert.equal(s.env.OMELETTE_REPRO_NODEUP, NODEUP_NONE);
    const r = s.sh([
      '/usr/bin/stat -f %N "$T_HOME" >/dev/null 2>&1; echo home=$?',
      '/usr/bin/stat -f %N "$T_HOME/.nvm" >/dev/null 2>&1; echo nvm=$?',
      'ls "$T_HOME" >/dev/null 2>&1; echo lshome=$?',
      'git status --porcelain >/dev/null 2>&1; echo git=$?',
      "python3 -c 'import ssl, sqlite3' >/dev/null 2>&1; echo python=$?",
    ].join('\n'));
    assert.deepEqual(rowsOf(r.stdout), { home: 1, nvm: 1, lshome: 1, git: 0, python: 0 }, r.stdout + r.stderr);
  } finally { s.cleanup(); }
});

test('nodeUp: regex metacharacters of the home and of the prefix are escaped, the chain is one anchored alternation, and the root as home does not double its separator', () => {
  assert.equal(
    nodeUp({ home: '/h+o.m(e)[x]$y', node: '/h+o.m(e)[x]$y/n+v/v{1}|2/bin/node' }),
    '^(/h\\+o\\.m\\(e\\)\\[x\\]\\$y|/h\\+o\\.m\\(e\\)\\[x\\]\\$y/n\\+v|/h\\+o\\.m\\(e\\)\\[x\\]\\$y/n\\+v/v\\{1\\}\\|2|/h\\+o\\.m\\(e\\)\\[x\\]\\$y/n\\+v/v\\{1\\}\\|2/bin)$',
  );
  assert.equal(nodeUp({ home: '/', node: '/usr/local/bin/node' }), '^(/|/usr|/usr/local|/usr/local/bin)$');
  // The prefix IS the home, or a sibling whose name starts like it, or a parent: nothing under the home is named.
  for (const node of ['/h', '/h.x/node', '/hh/node', '/']) assert.equal(nodeUp({ home: '/h', node }), NODEUP_NONE, node);
});

/* ── the adapter, with a fake vibe ───────────────────────────────────────────────────────────────────────── */

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
  'const ran = sc.shell ? spawnSync(shell, ["-c", sc.shell], { cwd: opt("--workdir"), env: process.env, encoding: "utf8" }) : null;',
  'appendFileSync(sc.record, JSON.stringify({ home: process.env.HOME, node: process.env.OMELETTE_REPRO_NODE, nodeup: process.env.OMELETTE_REPRO_NODEUP, ran: ran && { stdout: ran.stdout, stderr: ran.stderr } }) + "\\n");',
  'writeFileSync(join(opt("--output-dir"), "export.json"), JSON.stringify({ outcome: "finished", error: null, session_id: "s", usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: 0, steps: 1, exit_code: 0,',
  '  config: { active_model: opt("--model"), outside_workdir: "deny", enable_mcp: false, enable_connectors: false, tools: { bash: { shell } } } }));',
  'process.stdout.write("finding: x");',
].join('\n'));

/** One repro call through the adapter with the fake vibe: process HOME is `home`, the adapter\'s node is `execPath` (restored after). */
async function reproCall({ execPath, home, shell }) {
  const work = gitRepo(join(BASE, `ad-repo${++seq}`));
  const fleet = join(BASE, `ad-fleet${seq}`);
  mkdirSync(fleet);
  const record = join(BASE, `ad-record${seq}`);
  const scenario = join(BASE, `ad-scenario${seq}.json`);
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

test('adapter: NODEUP is built from the resolved HOME — a HOME spelled through a symlink still gets its node chain stat-able in the sandbox', { skip: !KERNEL }, async () => {
  const real = nvmHome('linkchain');
  const link = `${real}-link`;
  symlinkSync(real, link);
  made.push(link);
  const prefix = join(real, '.nvm', 'versions', 'node', 'v20');
  const fakeNode = join(prefix, 'bin', 'node');
  writeFileSync(fakeNode, '#!/bin/sh\n');
  chmodSync(fakeNode, 0o755);
  const seen = await reproCall({
    execPath: fakeNode,
    home: link,
    shell: [
      `/usr/bin/stat -f %N ${sq(real)} >/dev/null 2>&1; echo home=$?`,
      `/usr/bin/stat -f %N ${sq(join(real, '.nvm'))} >/dev/null 2>&1; echo nvm=$?`,
      `/usr/bin/stat -f %N ${sq(join(real, '.nvm', 'versions', 'node'))} >/dev/null 2>&1; echo nodes=$?`,
      `ls ${sq(real)} >/dev/null 2>&1; echo lshome=$?`,
      `/usr/bin/stat -f %N ${sq(join(real, '.nvmX'))} >/dev/null 2>&1; echo shared_prefix=$?`,
    ].join('\n'),
  });
  // A prefix under the home: its bin, npm and corepack, and the chain down to lib/node_modules (nodeReach).
  assert.deepEqual({ node: seen.node, up: seen.nodeup }, nodeReach({ home: real, prefix, binary: fakeNode }));
  assert.deepEqual(rowsOf(seen.ran.stdout), { home: 0, nvm: 0, nodes: 0, lshome: 1, shared_prefix: 1 }, seen.ran.stdout + seen.ran.stderr);
});

/* ── B. the guard (rendered as renderHookFile does) ──────────────────────────────────────────────────────── */

const REFUSED = 2;
const ALLOWED = 0;
const MiB = 1024 * 1024;
const TOO_WIDE_LINE = /command too wide to read \(over 4096 brace groups or 65536 brace words\)/;
const OVERSIZED_LINE = 'omelette-guard: event over 8 MiB — refused unread';

const guardFile = (() => {
  const dir = mkdtempSync(join(BASE, 'guard-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.9.0'));
  return path;
})();

/** The guard on `input` (the event's JSON text): `{ status, stderr, ms }`. */
function fire(input) {
  const t = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [guardFile], { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 24 });
  if (r.error && r.error.code !== 'EPIPE') throw r.error; // an early exit on an oversized stdin closes the pipe under the writer
  assert.equal(r.signal, null, 'the guard hung');
  return { status: r.status, stderr: r.stderr, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}
const bashEvent = (command, agent = 'omelette-reviewer') => {
  const e = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
  if (agent) e.agent_type = agent;
  return JSON.stringify(e);
};
const exitOf = (command, agent) => fire(bashEvent(command, agent)).status;
function guardRows(rows, agent) {
  const wrong = [];
  for (const [command, want] of rows) {
    const got = exitOf(command, agent);
    if (got !== want) wrong.push(`${JSON.stringify(command.slice(0, 80))}: want ${want}, got ${got}`);
  }
  assert.deepEqual(wrong, []);
}
const words = (word, n) => Array(n).fill(word).join(' ');

test('guard budget: a group is counted once however many levels re-read it — 1300 groups at the top, in a $(…) and in a bash -c word make 3900 and are read; 1367 of each are 4101 and are refused whole', () => {
  const three = (n) => `echo ${words('{a,b}', n)} $(echo ${words('{a,b}', n)}) && bash -c '${words('{a,b}', n)}'`;
  guardRows([[three(1300), ALLOWED]]);
  const wide = fire(bashEvent(three(1367)));
  assert.equal(wide.status, REFUSED);
  assert.match(wide.stderr, TOO_WIDE_LINE);
  // A second level, too: quoted inside the substitution it is the same groups, read once more at the next depth.
  guardRows([[`echo "$(echo "$(echo ${words('{a,b}', 4000)})")"`, ALLOWED]]);
});

test('guard budget: the groups of a heredoc body a shell runs count with the command\'s; those of a body that is text do not', () => {
  const body = (n) => `bash <<'EOF'\necho ${words('{a,b}', n)}\nEOF\n`;
  guardRows([
    [`${body(2500)}echo ${words('{a,b}', 1500)}`, ALLOWED],
    [`cat <<'EOF'\necho ${words('{a,b}', 5000)}\nEOF`, ALLOWED],
    [`cat <<EOF\n${words('{a,b}', 5000)}\nEOF`, ALLOWED],
  ]);
  const wide = fire(bashEvent(`${body(2500)}echo ${words('{a,b}', 2500)}`));
  assert.equal(wide.status, REFUSED);
  assert.match(wide.stderr, TOO_WIDE_LINE);
});

test('guard budget: past it a command is refused whole as too wide — a commit beside it included — and at the budget the commit is refused as a commit; 65536 words are read, one word of 17 groups counts as 257', () => {
  const wide = fire(bashEvent(`echo ${words('{a,b}', 4097)}; git ${C} -m x`));
  assert.equal(wide.status, REFUSED);
  assert.match(wide.stderr, TOO_WIDE_LINE);
  const plain = fire(bashEvent(`git ${C} -m x; echo ${words('{a,b}', 4096)}`));
  assert.equal(plain.status, REFUSED);
  assert.doesNotMatch(plain.stderr, /too wide/);
  assert.match(plain.stderr, /never commits/);
  guardRows([
    // 17 groups is 131072 words in one word: it counts as 257 (one past the cap), so 240 of them are read (4080 groups, 61680 words) …
    [`echo ${words('{a,b}'.repeat(17), 240)}`, ALLOWED],
    // … 256 words of 8 groups are exactly 65536 words, and a 257th is past the budget.
    [`echo ${words('{a,b}'.repeat(8), 256)}`, ALLOWED],
    [`echo ${words('{a,b}'.repeat(8), 257)}`, REFUSED],
    // The walk asks a git command's first braced word twice (a git word? the subcommand?): the budget still counts it once, so
    // exactly 4096 groups after `git` are read.
    [`git ${words('{a,b}', 4096)}`, ALLOWED],
    [`git ${words('{log,x}', 4096)}`, ALLOWED],
  ]);
});

test('guard stdin cap: exactly 8 MiB is read whole; one byte more is refused unread for every caller and every event, in well under 2 s, however far past the cap it goes', () => {
  const sized = (command, total, agent = 'omelette-reviewer') => {
    const e = JSON.parse(bashEvent(command, agent));
    e.pad = '';
    e.pad = 'x'.repeat(total - Buffer.byteLength(JSON.stringify(e)));
    const text = JSON.stringify(e);
    assert.equal(Buffer.byteLength(text), total);
    return text;
  };
  // At the cap: read, and answered by its command.
  assert.equal(fire(sized('git status', 8 * MiB)).status, ALLOWED);
  const commit = fire(sized(`git ${C} -m x`, 8 * MiB));
  assert.equal(commit.status, REFUSED);
  assert.match(commit.stderr, /never commits/);
  // One byte past it, a commit, the main thread, a non-guarded agent, another tool: all the same line.
  for (const [what, text] of [
    ['reviewer commit', sized(`git ${C} -m x`, 8 * MiB + 1)],
    ['reviewer status', sized('git status', 8 * MiB + 1)],
    ['main thread status', sized('git status', 8 * MiB + 1, null)],
    ['unnamed agent status', sized('git status', 8 * MiB + 1, 'someone-else')],
    ['16 MiB', sized('git status', 16 * MiB, null)],
    ['Write tool', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(BASE, 'w'), content: 'x'.repeat(8 * MiB + 1) } })],
    ['SessionStart', JSON.stringify({ hook_event_name: 'SessionStart', pad: 'x'.repeat(8 * MiB + 1) })],
    ['not JSON at all', 'x'.repeat(9 * MiB)],
  ]) {
    const r = fire(text);
    assert.equal(r.status, REFUSED, what);
    assert.equal(r.stderr.trim(), OVERSIZED_LINE, what);
    assert.ok(r.ms < 2000, `${what} took ${r.ms.toFixed(0)} ms`);
  }
  // Under the cap, anything that is not an event is still no business of the guard: silent exit 0.
  for (const junk of ['{not json', '', '[1,2]', 'null']) {
    const r = fire(junk);
    assert.deepEqual([r.status, r.stderr], [0, ''], JSON.stringify(junk));
  }
});

test('guard time: an event just under the cap made of plain words or lines, or a 4 MiB plain word, is read in seconds, not minutes (the cost is linear: ~0.5 s per MiB of one word)', () => {
  const under = 8 * MiB - 8192;
  for (const command of [`echo ${'word '.repeat(Math.floor(under / 5))}`, `echo ${'x'.repeat(4 * MiB)}`, `echo ${'a\n'.repeat(Math.floor(under / 4))}`]) {
    const r = fire(bashEvent(command));
    assert.equal(r.status, ALLOWED);
    assert.ok(r.ms < 8000, `${command.slice(0, 20).replace(/\n/g, '\\n')}… took ${r.ms.toFixed(0)} ms`);
  }
});

test('guard D4: a heredoc inside a substitution inside a heredoc body that bash runs is read as a command when eval/bash -c runs what it prints, and is text when echo does', () => {
  const inner = `git ${C} -m x`;
  guardRows([
    [`bash <<'OUT'\neval "$(cat <<'IN'\n${inner}\nIN\n)"\nOUT`, REFUSED],
    [`bash <<'OUT'\necho "$(cat <<'IN'\n${inner}\nIN\n)"\nOUT`, ALLOWED],
    [`bash <<'OUT'\neval "$(cat <<'IN'\ngit status\nIN\n)"\nOUT`, ALLOWED],
    [`x=$(cat <<'EOF'\n${inner}\nEOF\n) && eval "$x"`, REFUSED],
    [`sh < <(cat <<'EOF'\n${inner}\nEOF\n)`, REFUSED],
    [`source <(cat <<'EOF'\n${inner}\nEOF\n)`, REFUSED],
  ]);
});

/* ── the coder's third landing: `.` as source, xargs wrappers with options, the QUOTE_DEPTH cutoff failing closed ── */

test('guard: `.` is source — a heredoc body or process substitution it reads is a command; a plain `. ./file` and a body that only names status are not refused', () => {
  guardRows([
    [`. /dev/stdin <<'EOF'\ngit ${C} -m x\nEOF`, REFUSED],
    [`. <(cat <<'EOF'\ngit ${C} -m x\nEOF\n)`, REFUSED],
    [`. /dev/stdin <<'EOF'\ngit status\nEOF`, ALLOWED],
    ['. ./env.sh', ALLOWED],
    // The cost, accepted: any word of the line that is `.` (or ends in `/.`) makes the line a shell's, so a body that
    // names a git write is read as a command even though `find` runs none of it. A body naming no write passes.
    [`find . -name x <<'EOF'\ngit ${C} -m x\nEOF`, REFUSED],
    [`find . -name x <<'EOF'\ngit status\nEOF`, ALLOWED],
    // `./f` is a path, not the dot builtin.
    [`cat ./f <<'EOF'\ngit ${C} -m x\nEOF`, ALLOWED],
  ]);
});

test('guard: a git that xargs hands its subcommand is refused behind a wrapper with options too — env -i, sudo -u x, nice -5, timeout -s KILL 5, command -p, time -p, nohup — and one with a subcommand of its own is read as a git', () => {
  guardRows([
    [`echo ${C} | xargs sudo -u x git`, REFUSED],
    ['xargs env -i git', REFUSED],
    ['xargs env -u X git', REFUSED],
    ['xargs nice -5 git', REFUSED],
    ['xargs nice -n5 git', REFUSED],
    ['xargs timeout -s KILL 5 git', REFUSED],
    ['xargs timeout 5 git', REFUSED],
    ['xargs command -p git', REFUSED],
    ['xargs time -p git', REFUSED],
    ['xargs nohup git', REFUSED],
    ['xargs env git status', ALLOWED],
    ['xargs sudo -u x git status', ALLOWED],
    ['xargs sudo -u x git -C . log', ALLOWED],
    ['xargs nice echo git', ALLOWED],
    ['xargs echo git', ALLOWED],
    // No git word after the option: nothing to refuse. A git word that is only an argument of the wrapped program is
    // refused all the same (the fallback reads the first git word after xargs): the accepted over-refusal.
    ['xargs sudo -u x echo', ALLOWED],
    ['xargs sudo -u git echo', ALLOWED],
    ['xargs sudo -u x grep -n git', REFUSED],
  ]);
});

/** `inner` inside `n` levels of `$(echo …)`, of `sh -c "…"`, of `sh -c '…'` (with the standard `'\''` escape). */
const subs = (inner, n) => { let s = inner; for (let i = 0; i < n; i++) s = `$(echo ${s})`; return s; };
const dq = (inner, n) => { let s = inner; for (let i = 0; i < n; i++) s = `sh -c ${JSON.stringify(s)}`; return s; };
const sqn = (inner, n) => { let s = inner; for (let i = 0; i < n; i++) s = `sh -c '${s.replaceAll("'", "'\\''")}'`; return s; };

test('guard: the QUOTE_DEPTH cutoff fails closed — a git word spelled with braces, quotes or an escape six levels down is refused; plain quoted words, however deep, are not', () => {
  guardRows([
    ['echo $(echo $(echo $(echo $(echo {g,x}it commit))))', REFUSED],
    [subs(`{g,x}it ${C}`, 5), REFUSED],
    [subs(`{g,x}it ${C}`, 6), REFUSED],
    [subs(`'g'it ${C}`, 6), REFUSED],
    [subs(`g\\it ${C}`, 6), REFUSED],
    [subs(`git ${C}`, 6), REFUSED],
    [subs('echo hi', 5), ALLOWED],
    [dq('echo hi', 6), ALLOWED],
    [dq('echo hi', 8), ALLOWED],
    [sqn('echo "a b" c', 6), ALLOWED],
    // …nor an expansion or a substitution that could spell one: `$(echo gi)t` and `${x}it` run git.
    [dq(`$(echo gi)t ${C}`, 6), REFUSED],
    [dq(`\${x}it ${C}`, 6), REFUSED],
    [dq('echo $(date)', 6), REFUSED],
    [sqn(`{g,x}it ${C}`, 6), REFUSED],
    [sqn(`'g'it ${C}`, 6), REFUSED],
  ]);
});

/* ── NODE under the home is an anchored list of subpaths (nodeReach) ───────────────────────────────────── */

test('NODE under the home: bin, npm and corepack are readable as paths and as directories, a name that only starts like one (binX, npmX, corepack-x, a prefix v20X) and the rest of the prefix are not', { skip: !KERNEL }, () => {
  const home = tempHome('reach');
  const P = '.nvm/versions/node/v20';
  const M = `${P}/lib/node_modules`;
  for (const f of [`${P}/bin/tool`, `${P}/binX/tool`, `${M}/npm/package.json`, `${M}/npmX/package.json`, `${M}/npm-extra/package.json`, `${M}/corepack-x/package.json`, `${M}/corepack/package.json`,
    `${P}/lib/loose`, `${P}/include/h`, `${P}X/bin/tool`, `${P}X/lib/node_modules/npm/package.json`]) touch(join(home, f));
  const s = sandboxedRun({ home, node: join(home, P) });
  try {
    const cat = (name, p) => `cat "$T_HOME/${p}" >/dev/null 2>&1; echo ${name}=$?`;
    const r = s.sh([
      cat('bin', `${P}/bin/tool`), cat('npm', `${M}/npm/package.json`), cat('corepack', `${M}/corepack/package.json`),
      `ls "$T_HOME/${P}/bin" >/dev/null 2>&1; echo ls_bin=$?`, `ls "$T_HOME/${M}/npm" >/dev/null 2>&1; echo ls_npm=$?`,
      cat('binX', `${P}/binX/tool`), cat('npmX', `${M}/npmX/package.json`), cat('npm_extra', `${M}/npm-extra/package.json`), cat('corepack_x', `${M}/corepack-x/package.json`),
      cat('loose', `${P}/lib/loose`), cat('include', `${P}/include/h`), cat('prefix_x', `${P}X/bin/tool`), cat('prefix_x_npm', `${P}X/lib/node_modules/npm/package.json`),
      `/usr/bin/stat -f %N "$T_HOME/${P}/binX" >/dev/null 2>&1; echo stat_binX=$?`,
      `ls "$T_HOME/${M}" >/dev/null 2>&1; echo ls_modules=$?`, `ls "$T_HOME/${P}" >/dev/null 2>&1; echo ls_prefix=$?`,
    ].join('\n'));
    assert.deepEqual(rowsOf(r.stdout), {
      bin: 0, npm: 0, corepack: 0, ls_bin: 0, ls_npm: 0,
      binX: 1, npmX: 1, npm_extra: 1, corepack_x: 1, loose: 1, include: 1, prefix_x: 1, prefix_x_npm: 1, stat_binX: 1, ls_modules: 1, ls_prefix: 1,
    }, r.stdout + r.stderr);
  } finally { s.cleanup(); }
});
