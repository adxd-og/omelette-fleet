/**
 * omelette-fleet :: test/cli.test.mjs
 * The CLI is exercised as a CHILD PROCESS — process.execPath + the bin path —
 * because that is the only way its exit codes, its stdout/stderr split and its
 * `#!` entry are real. Importing it would test a different program.
 *
 * NOTHING REAL IS TOUCHED: every run gets its own OMELETTE_HOME, and HOME is
 * pointed at that temp dir too so `~/.claude.json` and the default fleet home
 * resolve inside the sandbox. The vendor CLIs are a single fake node script
 * that answers `--version`, `models` and `login status`; `claude` itself is
 * never required — install is only ever tested with --dry-run.
 *
 * NO TEST REACHES THE NETWORK: OMELETTE_UPDATE_CHECK=0 is part of the default
 * environment below, so the release check never fires from here. The `update`
 * command is exercised against a real but throwaway git fixture (a bare
 * "origin" plus two clones) through OMELETTE_PKG_ROOT — everything git does
 * there is local file I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callUnitServer, MAX_TIMEOUT_S } from '../core/client.mjs';
import { renderResult } from '../core/results.mjs';
import { AGENT_MARKER, FLEET_CONTRACT, HOOK_EVENTS, HOOK_MARKER, RULES_MARKER, SHORT_CONTRACT, SKILL_MARKER } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** A fresh fleet home per test; HOME follows it so nothing leaks into the real one. */
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-cli-'));
  return dir;
}

/**
 * Run the CLI with a clean-ish env (PATH kept: `claude` may or may not exist —
 * no test depends on it). `timeout` is for the tests whose whole point is that
 * the CLI comes back at all: without it a blocking read would hang the suite
 * instead of failing it.
 */
function cli(args, { dir, env = {}, timeout } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    timeout,
    // cwd is the sandbox, never this checkout: `doctor` and `update` read the
    // PROJECT's .claude/rules and .claude/agents, and an operator who installed
    // ours here would otherwise change what these tests see.
    cwd: dir,
    encoding: 'utf8',
    // The update check is OFF for every run: a unit test that quietly calls
    // GitHub is a flaky test and a slow one. `env` can still switch it back on.
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/** Seed a spool by hand: `results` reads files, so no server and no vendor CLI are needed. */
function spoolResult(dir, unit, rec) {
  const d = join(dir, 'results', unit);
  mkdirSync(d, { recursive: true });
  const path = join(d, `${rec.resultId}.md`);
  writeFileSync(path, renderResult({ ...rec, unit }));
  return path;
}

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/** git inside a fixture: our own identity, no user/system config, no network. */
function git(cwd, args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: join(cwd, 'no-such-gitconfig'),
      GIT_CONFIG_SYSTEM: join(cwd, 'no-such-gitconfig'),
      GIT_AUTHOR_NAME: 'Fleet Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Fleet Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const writePkg = (root, version) => writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({ name: 'omelette-fleet', version }, null, 2) + '\n',
);

/**
 * A real git install to update: a bare `origin`, a `work` clone that publishes
 * commits to it, and `clone` — the "installed" checkout the CLI is pointed at
 * with OMELETTE_PKG_ROOT. Nothing here talks to a remote host.
 */
function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-git-'));
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const clone = join(dir, 'clone');
  git(dir, ['init', '--bare', '-b', 'main', origin]);
  git(dir, ['clone', origin, work]);
  writePkg(work, '0.1.0');
  mkdirSync(join(work, 'servers'), { recursive: true });
  writeFileSync(join(work, 'servers', 'codex.mjs'), '// fixture server\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'v0.1.0']);
  git(work, ['push', '-u', 'origin', 'main']);
  git(dir, ['clone', origin, clone]);
  return { dir, origin, work, clone };
}

/** One new released commit on origin, so the clone falls behind. */
function bump(work, version) {
  writePkg(work, version);
  git(work, ['commit', '-am', `v${version}`]);
  git(work, ['push', 'origin', 'main']);
}

const pkgVersion = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

/**
 * A stand-in vendor CLI: the shebang is this very node binary, so the script
 * runs even where `node` is not on PATH. `login status` answers on STDERR by
 * default because that is where the real codex CLI puts it — reading only
 * stdout is what once made doctor report a logged-in account as "unknown".
 */
function fakeBin(dir, { name = 'fake-cli', login = 'Logged in using ChatGPT', loginStream = 'stderr', loginCode = 0 } = {}) {
  const p = join(dir, name);
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    "if (a[0] === 'models') { console.log('model-a'); console.log('model-b'); process.exit(0); }",
    `if (a[0] === 'login' && a[1] === 'status') { process.${loginStream}.write(${JSON.stringify(login + '\n')}); process.exit(${loginCode}); }`,
    "console.error('unexpected argv: ' + a.join(' '));",
    'process.exit(1);',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/**
 * A fake `claude` on PATH — the real binary is never required by any test.
 * It records its argv and answers with the exit code we ask for.
 */
function fakeClaude(dir, { exitCode = 0, name = 'pathdir' } = {}) {
  const bindir = join(dir, name);
  mkdirSync(bindir, { recursive: true });
  const p = join(bindir, 'claude');
  writeFileSync(p, [
    `#!${process.execPath}`,
    `require('fs').appendFileSync(${JSON.stringify(join(dir, 'claude.log'))}, process.argv.slice(2).join(' ') + '\\n');`,
    `console.error('claude says ${exitCode === 0 ? 'ok' : 'no'}');`,
    `process.exit(${exitCode});`,
  ].join('\n'));
  chmodSync(p, 0o755);
  return bindir;
}

/** A scriptable MCP server: `handler` is the body that answers one parsed frame `m`. */
function fakeServer(dir, name, handler) {
  const p = join(dir, name);
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
    'const INIT = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } };',
    'const TOOLS = [{ name: "t", description: "d", inputSchema: { type: "object" } }];',
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => {',
    '  buf += c; let nl;',
    '  while ((nl = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);',
    '    if (!line) continue;',
    '    const m = JSON.parse(line);',
    '    if (m.id === undefined) continue;',
    handler,
    '  }',
    '});',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

test('--help (and no args) print the usage; --version prints the package version', () => {
  const pkg = JSON.parse(spawnSync(process.execPath, ['-p', "JSON.stringify(require('./package.json'))"], { cwd: ROOT, encoding: 'utf8' }).stdout);
  const dir = home();
  for (const args of [['--help'], []]) {
    const r = cli(args, { dir });
    assert.equal(r.code, 0);
    assert.match(r.out, /USAGE/);
    for (const cmd of ['install', 'uninstall', 'update', 'rules', 'doctor', 'show', 'set', 'call']) assert.match(r.out, new RegExp(`omelette-fleet ${cmd}`));
    assert.match(r.out, /OMELETTE_UPDATE_CHECK/);
  }
  const v = cli(['--version'], { dir });
  assert.equal(v.code, 0);
  assert.equal(v.out.trim(), pkg.version);
  const bogus = cli(['nope'], { dir });
  assert.equal(bogus.code, 1);
  assert.match(bogus.err, /unknown command "nope"/);
});

test('show on an empty home: every unit at its built-in defaults, read-only, nothing written', () => {
  const dir = home();
  const r = cli(['show'], { dir });
  assert.equal(r.code, 0);
  assert.match(r.out, /absent — built-in defaults in force/);
  for (const unit of ['gemini', 'grok', 'codex']) assert.match(r.out, new RegExp(`^${unit}$`, 'm'));
  assert.match(r.out, /^\s+mode\s+read-only\s+default$/m);
  assert.match(r.out, /ceiling\s+closed — OMELETTE_ALLOW_WRITE does not list "codex"/);
  assert.match(r.out, /grok[\s\S]*imageMaxTurns\s+8\s+default/); // the unit's extraSchema key is listed too
  assert.equal(existsSync(join(dir, 'fleet.config.json')), false); // show never writes
  assert.equal(cli(['show', 'codex'], { dir }).code, 0);
  const bad = cli(['show', 'nope'], { dir });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown unit "nope"/);
});

test('set writes one key and show reads it back with source "file"', () => {
  const dir = home();
  const s = cli(['set', 'codex.timeoutS=42'], { dir });
  assert.equal(s.code, 0);
  assert.match(s.out, /codex\.timeoutS\s+600 \[default\] → 42 \[file\]/);
  const written = JSON.parse(spawnSync(process.execPath, ['-p', `JSON.stringify(require(${JSON.stringify(join(dir, 'fleet.config.json'))}))`], { encoding: 'utf8' }).stdout);
  assert.equal(written.units.codex.timeoutS, 42);
  assert.equal(written.version, 1);
  const r = cli(['show', 'codex'], { dir });
  assert.match(r.out, /^\s+timeoutS\s+42\s+file$/m);
  // a second set merges instead of replacing
  assert.equal(cli(['set', 'gemini.enabled=false'], { dir }).code, 0);
  const both = cli(['show'], { dir });
  assert.match(both.out, /^\s+timeoutS\s+42\s+file$/m);
  assert.match(both.out, /^\s+enabled\s+false\s+file$/m);
});

test('set refuses an unknown key, an unknown unit and an invalid value — exit 1, nothing written', () => {
  const dir = home();
  const key = cli(['set', 'codex.timeout=1'], { dir });
  assert.equal(key.code, 1);
  assert.match(key.err, /unknown key "timeout" for unit "codex"/);
  const unit = cli(['set', 'nope.model=x'], { dir });
  assert.equal(unit.code, 1);
  assert.match(unit.err, /unknown unit "nope"/);
  const value = cli(['set', 'codex.timeoutS=-3'], { dir });
  assert.equal(value.code, 1);
  assert.match(value.err, /invalid value for codex\.timeoutS/);
  const shape = cli(['set', 'codexmode'], { dir });
  assert.equal(shape.code, 1);
  assert.equal(existsSync(join(dir, 'fleet.config.json')), false);
});

test('set mode=workspace-write prints the ceiling reminder (and grok says it refuses the mode outright)', () => {
  const dir = home();
  const c = cli(['set', 'codex.mode=workspace-write'], { dir });
  assert.equal(c.code, 0);
  assert.match(c.out, /OMELETTE_ALLOW_WRITE=codex/);
  assert.match(c.out, /stays read-only/);
  const g = cli(['set', 'grok.mode=workspace-write'], { dir });
  assert.equal(g.code, 0);
  assert.match(g.out, /grok refuses workspace-write entirely/);
  // the clamp is visible in show, never a bare "workspace-write"
  assert.match(cli(['show', 'codex'], { dir }).out, /mode\s+workspace-write \(clamped to read-only\)\s+file/);
});

test('install --dry-run prints the exact claude commands with absolute server paths and runs nothing', () => {
  const dir = home();
  const fake = fakeBin(dir);
  const env = { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: fake };
  const r = cli(['install', '--dry-run', '--prefix', 'test'], { dir, env });
  assert.equal(r.code, 0);
  for (const unit of ['gemini', 'grok', 'codex']) {
    const server = join(ROOT, 'servers', `${unit}.mjs`);
    assert.ok(r.out.includes(`claude mcp add -s user test-${unit} -- node ${server}`), `missing add line for ${unit}`);
    assert.ok(r.out.includes(`claude mcp remove -s user test-${unit}`), `missing remove line for ${unit}`);
    assert.ok(server.startsWith('/') || /^[A-Za-z]:/.test(server));
  }
  assert.match(r.out, /would write .*fleet\.config\.json \(0600/);
  assert.match(r.out, /Nothing was changed \(--dry-run\)/);
  assert.match(r.out, /Restart Claude Code to load the new servers\./);
  assert.equal(existsSync(join(dir, 'fleet.config.json')), false); // dry-run wrote nothing

  // --units narrows the plan; a unit whose CLI is missing is skipped unless --force
  const one = cli(['install', '--dry-run', '--units', 'codex'], { dir, env });
  assert.ok(one.out.includes('claude mcp add -s user omelette-codex'));
  assert.ok(!one.out.includes('omelette-gemini'));
  const missing = cli(['install', '--dry-run', '--units', 'codex'], { dir, env: { CODEX_BIN: join(dir, 'nope') } });
  assert.match(missing.out, /SKIPPED, use --force/);
  assert.ok(!missing.out.includes('claude mcp add'));
  const forced = cli(['install', '--dry-run', '--units', 'codex', '--force'], { dir, env: { CODEX_BIN: join(dir, 'nope') } });
  assert.ok(forced.out.includes('claude mcp add -s user omelette-codex'));
  assert.equal(cli(['install', '--units', 'nope', '--dry-run'], { dir, env }).code, 1);
});

/** The CLI inside a project directory that is NOT the fleet home — `install --rules` writes into the cwd. */
const cliIn = (proj, dir, args, env = {}) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: proj,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
};

/** Every file `rules --agents --hooks` writes, relative to the project's .claude. */
const MANAGED = [
  'rules/omelette-fleet.md',
  'agents/omelette-coder.md',
  'agents/omelette-tester.md',
  'skills/omelette-test/SKILL.md',
  'hooks/omelette-guard.mjs',
];

test('install --rules --dry-run prints BOTH halves — the registrations and the project files — and runs nothing', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const fake = fakeBin(dir);
  const r = cliIn(proj, dir, ['install', '--rules', '--dry-run'], { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: fake });
  assert.equal(r.code, 0, r.err);
  // half one, unchanged: the registrations
  assert.ok(r.out.includes(`claude mcp add -s user omelette-codex -- node ${join(ROOT, 'servers', 'codex.mjs')}`), r.out);
  assert.match(r.out, /Nothing was changed \(--dry-run\)/);
  // half two: everything `rules --agents --hooks` would write, in the CWD (which
  // reaches the CLI resolved — a macOS temp dir is /private/var/…)
  for (const f of MANAGED) {
    assert.ok(r.out.includes(`would write ${join(realpathSync(proj), '.claude', ...f.split('/'))}`), `no line for ${f}:\n${r.out}`);
  }
  // …announced, never printed: a snippet naming a script nobody wrote is one somebody pastes
  assert.match(r.out, /^would print the settings snippet after writing$/m);
  assert.doesNotMatch(r.out, /"PreToolUse"/);
  assert.equal(existsSync(join(proj, '.claude')), false, '--dry-run must touch nothing on disk');
  assert.equal(existsSync(join(dir, 'fleet.config.json')), false);
});

test('install --rules writes the project rules, agents, skill and guard, then prints the snippet to paste', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const fake = fakeBin(dir);
  // No `claude` in PATH: the registrations are printed for the operator to run,
  // and the project half — which needs no claude at all — still happens.
  const r = cliIn(proj, dir, ['install', '--rules', '--units', 'codex'], { PATH: join(dir, 'empty'), CODEX_BIN: fake });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /claude mcp add -s user omelette-codex/);
  for (const f of MANAGED) assert.ok(existsSync(join(proj, '.claude', ...f.split('/'))), `${f} was not written`);
  const guard = join(realpathSync(proj), '.claude', 'hooks', 'omelette-guard.mjs');
  assert.ok(r.out.includes(SNIPPET(guard)), `no snippet for ${guard} in:\n${r.out}`);
  // A plain `install` still writes nothing into the project.
  const plain = join(dir, 'proj2'); mkdirSync(plain);
  assert.equal(cliIn(plain, dir, ['install', '--dry-run', '--units', 'codex'], { CODEX_BIN: fake }).code, 0);
  assert.equal(existsSync(join(plain, '.claude')), false);
  assert.match(cli(['install', '--help'], { dir }).out, /--rules/);
});

test(
  'install --rules: a config file it cannot create is a reported failure, never a lost rules phase',
  { skip: process.platform === 'win32' ? 'POSIX directory modes' : (process.getuid && process.getuid() === 0 && 'root writes into any directory') },
  () => {
    const dir = home();
    const proj = join(dir, 'proj'); mkdirSync(proj);
    const fake = fakeBin(dir);
    // The fleet home is read-only, so `fleet.config.json` cannot be created —
    // and the project, which is a directory of its own, still can be written.
    chmodSync(dir, 0o500);
    try {
      const r = cliIn(proj, dir, ['install', '--rules', '--units', 'codex'], { PATH: join(dir, 'empty'), CODEX_BIN: fake });
      // The failure is real and it is what the exit code says…
      assert.equal(r.code, 1, `a config that could not be written must exit 1:\n${r.out}${r.err}`);
      assert.match(r.out, /^config {2}FAILED to write .*fleet\.config\.json/m, r.out);
      assert.equal(existsSync(join(dir, 'fleet.config.json')), false);
      // …and the half it has nothing to do with ran anyway: the project files
      // are the reason the operator typed --rules.
      for (const f of MANAGED) assert.ok(existsSync(join(proj, '.claude', ...f.split('/'))), `${f} was not written:\n${r.out}${r.err}`);
      assert.ok(r.out.includes(SNIPPET(join(realpathSync(proj), '.claude', 'hooks', 'omelette-guard.mjs'))), r.out);
    } finally {
      chmodSync(dir, 0o700);
    }
  },
);

test('uninstall --dry-run prints one remove per unit and promises to keep the config', () => {
  const dir = home();
  const r = cli(['uninstall', '--dry-run', '--prefix', 'test'], { dir });
  assert.equal(r.code, 0);
  for (const unit of ['gemini', 'grok', 'codex']) assert.ok(r.out.includes(`claude mcp remove -s user test-${unit}`));
  assert.ok(!r.out.includes('mcp add'));
  assert.match(r.out, /config and the status files were not touched/);
});

test('doctor with fake vendor binaries: one block per unit, everything resolved, exit 0', () => {
  const dir = home();
  const fake = fakeBin(dir);
  const r = cli(['doctor', '--prefix', 'zzz-test'], { dir, env: { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: fake } });
  assert.equal(r.code, 0, r.out + r.err);
  for (const unit of ['gemini', 'grok', 'codex']) assert.match(r.out, new RegExp(`── ${unit} \\(`));
  assert.equal(r.out.match(/fake-cli 9\.9\.9/g).length, 3); // version probe answered for all three
  assert.match(r.out, /login\s+OK — Logged in using ChatGPT/); // codex answers on stderr, like the real CLI
  assert.match(r.out, /login\s+OK — grok models listed 2 line\(s\)/);
  assert.match(r.out, /login\s+OK — agy models listed 2 line\(s\)/);
  assert.match(r.out, /^version\s+\d+\.\d+\.\d+ · latest check disabled$/m); // opted out → never a network call
  assert.match(r.out, /zzz-test-codex not registered/); // ~/.claude.json is absent under the temp HOME
  assert.match(r.out, /status feed .* is writable/);
  assert.match(r.out, /effective mode: read-only/);
  assert.match(r.out, /No faults in units that are both enabled and registered\./);
});

test('doctor reads the codex login answer off EITHER stream and never calls exit 0 + "Logged in" unknown', () => {
  const dir = home();
  // Only codex probes here: the other two bins are absent, so the run is short.
  const gone = join(dir, 'no-such');
  const state = (opts, name) => {
    const bin = fakeBin(dir, { name, ...opts });
    const r = cli(['doctor'], { dir, env: { AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: bin } });
    return (r.out.match(/── codex[\s\S]*?login\s+(.*)/) || [])[1] || '';
  };
  assert.match(state({ loginStream: 'stderr' }, 'c-err'), /^OK — Logged in using ChatGPT/); // the real shape
  assert.match(state({ loginStream: 'stdout' }, 'c-out'), /^OK — Logged in using ChatGPT/);
  // Only an EXPLICIT phrase is a negative: a CLI can exit non-zero for a dozen
  // reasons that are not "no session", and "run `codex login`" would be a lie.
  assert.match(state({ loginCode: 1, login: 'connect ECONNREFUSED' }, 'c-exit'), /^unknown \(exit 1\) — connect ECONNREFUSED/);
  assert.match(state({ login: 'You are not logged in' }, 'c-not'), /^SIGNED OUT/); // contains "logged in"
  assert.match(state({ login: 'Logged out' }, 'c-out2'), /^SIGNED OUT/);
  assert.match(state({ login: 'something else entirely' }, 'c-huh'), /^unknown/); // never guessed
});

test('doctor never prints a failing --version probe as if it were a version', () => {
  const dir = home();
  const bin = join(dir, 'broken-version');
  writeFileSync(bin, [
    `#!${process.execPath}`,
    "console.error('error: could not load config'); process.exit(2);",
  ].join('\n'));
  chmodSync(bin, 0o755);
  const r = cli(['doctor'], { dir, env: { AGY_BIN: join(dir, 'x'), GROK_BIN: join(dir, 'x'), CODEX_BIN: bin } });
  assert.match(r.out, /version\s+unknown \(exit 2: error: could not load config\)/);
  assert.doesNotMatch(r.out, /version\s+error: could not load config$/m);
});

test('doctor reports a missing binary as not found, and still exits 0 while the unit is unregistered', () => {
  const dir = home();
  const fake = fakeBin(dir);
  const r = cli(['doctor'], { dir, env: { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: join(dir, 'no-such-codex') } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /bin\s+.*no-such-codex → not found in PATH/);
  assert.match(r.out, /version\s+— \(no binary\)/);
  assert.match(r.out, /login\s+unknown \(no binary\)/);
});

test('doctor will not claim a registration that is not this clone, and a disabled unit is never a fault', () => {
  const dir = home();
  const fake = fakeBin(dir);
  // A hand-made ~/.claude.json: doctor only ever reads it.
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-codex': { command: 'node', args: [join(dir, 'gone', 'codex.mjs')] } },
  }));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { enabled: false } } }));
  const r = cli(['doctor'], { dir, env: { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: join(dir, 'no-such-codex') } });
  assert.match(r.out, /omelette-codex registered elsewhere \(user\) → node .*gone.*codex\.mjs \[FILE MISSING\]/);
  assert.match(r.out, new RegExp(`not this clone — install here would point it at ${join(ROOT, 'servers', 'codex.mjs')}`));
  assert.equal(r.code, 0); // registered + broken, but disabled in config → not a fault
  assert.doesNotMatch(r.out, /FAULT/);
  assert.match(r.out, /^\s+enabled\s+false\s+file$/m);
});

test('doctor: a registration owned by something else is never counted as ours', () => {
  const dir = home();
  const fake = fakeBin(dir);
  const server = join(ROOT, 'servers', 'codex.mjs');
  // Right path, wrong runner — some other launcher owns this name.
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-codex': { command: 'bunx', args: [server] } },
  }));
  const r = cli(['doctor'], { dir, env: { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: fake } });
  assert.match(r.out, /omelette-codex registered elsewhere \(user\) → bunx .*servers.*codex\.mjs \[file exists\]/);
});

test('doctor: an ENABLED unit registered against a server file that is gone is a fault (exit 1)', () => {
  const dir = home();
  const fake = fakeBin(dir);
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-codex': { command: 'node', args: [join(dir, 'gone', 'codex.mjs')] } },
  }));
  // Everything else about codex is healthy — the dead registration alone is the fault.
  const r = cli(['doctor'], { dir, env: { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: fake } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAULT\s+enabled and registered, but: the registered server file is missing/);
  assert.match(r.out, /1 unit\(s\) enabled AND registered are broken/);
});

test('doctor reads .claude.json from CLAUDE_CONFIG_DIR first and says so', () => {
  const dir = home();
  const fake = fakeBin(dir);
  const alt = join(dir, 'alt-config');
  mkdirSync(alt, { recursive: true });
  writeFileSync(join(alt, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-codex': { command: 'node', args: [join(ROOT, 'servers', 'codex.mjs')] } },
  }));
  // The home copy would say "not registered" — proving which file was read.
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  const r = cli(['doctor'], { dir, env: { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: fake, CLAUDE_CONFIG_DIR: alt } });
  assert.match(r.out, new RegExp(`claude config ${join(alt, '.claude.json')}\\s+\\[via CLAUDE_CONFIG_DIR\\]`));
  assert.match(r.out, /omelette-codex registered \(user\) → node .*servers.*codex\.mjs \[file exists\]/);
  // Absent there → falls back to ~/.claude.json, which has no servers.
  const back = cli(['doctor'], { dir, env: { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: fake, CLAUDE_CONFIG_DIR: join(dir, 'nowhere') } });
  assert.match(back.out, new RegExp(`claude config ${join(dir, '.claude.json')}`));
  assert.match(back.out, /omelette-codex not registered/);
});

test('doctor exits 1 when a unit is enabled AND registered AND its binary is gone', () => {
  const dir = home();
  const fake = fakeBin(dir);
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-codex': { command: 'node', args: [join(ROOT, 'servers', 'codex.mjs')] } },
  }));
  const r = cli(['doctor'], { dir, env: { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: join(dir, 'no-such-codex') } });
  assert.equal(r.code, 1);
  assert.match(r.out, /1 unit\(s\) enabled AND registered are broken/);
  assert.match(r.out, /FAULT\s+enabled and registered, but: .*no-such-codex not found in PATH/);
  assert.match(r.out, /omelette-codex registered \(user\) → node .*servers.*codex\.mjs \[file exists\]/);
});

// ─── doctor --probe-sandbox (spec §2) ────────────────────────────────────────

/**
 * A fake vendor CLI that also answers a RESEARCH RUN, so `--probe-sandbox` has
 * something to probe. It answers doctor's version and login probes like
 * `fakeBin`, and for anything else — a real run — it appends its own cwd to a
 * marker file first. That marker is the proof, in the no-flag test, that no
 * unit was spawned at all, and everywhere else it names the probe directory
 * the CLI created, so the test can check it was removed.
 *
 * `mode`: 'refuse' replies and writes nothing · 'write' writes probe.txt into
 * its cwd and replies · 'sleep' never answers (killed at the unit's timeoutS)
 * · 'write-then-sleep' writes and then hangs.
 */
function probeBin(dir, { name = 'probe-cli', mode = 'refuse', sleepMs = 30000 } = {}) {
  const path = join(dir, name);
  const marker = join(dir, `${name}.spawned`);
  const writes = mode === 'write' || mode === 'write-then-sleep';
  const hangs = mode === 'sleep' || mode === 'write-then-sleep';
  writeFileSync(path, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    "const p = require('path');",
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    "if (a[0] === 'models') { console.log('model-a'); console.log('model-b'); process.exit(0); }",
    "if (a[0] === 'login' && a[1] === 'status') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }",
    `fs.appendFileSync(${JSON.stringify(marker)}, process.cwd() + '\\n');`,
    ...(writes ? ["fs.writeFileSync(p.join(process.cwd(), 'probe.txt'), 'probe');"] : []),
    ...(hangs
      ? [`setTimeout(() => {}, ${sleepMs});`]
      : [`console.log(${writes ? "'done'" : "'refused'"}); process.exit(0);`]),
  ].join('\n'));
  chmodSync(path, 0o755);
  return { path, marker };
}

/** grok registered as OURS, so the probe's "enabled AND registered" gate opens for it. */
function registerOurs(dir, units) {
  const mcpServers = {};
  for (const u of units) mcpServers[`omelette-${u}`] = { command: 'node', args: [join(ROOT, 'servers', `${u}.mjs`)] };
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers }));
}

/** Every directory a fake reported running in — one line per real run. */
const spawnedIn = (marker) => readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean);

test('doctor --probe-sandbox: a unit that writes into the probe directory is BREACHED, and doctor exits 1', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeBin(dir, { mode: 'write' });
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake.path, CODEX_BIN: gone } });
  const m = /sandbox\s+BREACHED — (\S+) was created \(\d+ s\)/.exec(r.out);
  assert.ok(m, r.out + r.err);
  // The path named is the file inside the probe directory the CLI created…
  assert.match(m[1], /omelette-probe-grok-[^/\\]+[/\\]probe\.txt$/);
  // …and neither it nor its directory outlives the probe.
  assert.equal(existsSync(m[1]), false);
  assert.equal(existsSync(dirname(m[1])), false);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /1 unit\(s\) BREACHED the sandbox probe — see the sandbox lines above\./);
  // The other two could not be asked at all — and were not spawned.
  assert.equal(r.out.match(/sandbox\s+skipped \(not registered\)/g).length, 2);
});

test('doctor --probe-sandbox: a unit that only replies holds, and the answer is spooled like any call', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeBin(dir, { mode: 'refuse' });
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake.path, CODEX_BIN: gone } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /sandbox\s+held \(\d+ s, replied "refused"\)/);
  assert.doesNotMatch(r.out, /BREACHED/);
  // It really ran, in a directory of its own, and that directory is gone.
  const ran = spawnedIn(fake.marker);
  assert.equal(ran.length, 1);
  assert.match(ran[0], /omelette-probe-grok-/);
  assert.equal(existsSync(ran[0]), false);
  // Spooled like any other call: same store, same header.
  const spool = readdirSync(join(dir, 'results', 'grok')).filter((f) => f.endsWith('.md'));
  assert.equal(spool.length, 1);
  const body = readFileSync(join(dir, 'results', 'grok', spool[0]), 'utf8');
  assert.match(body, /\ntool: grok_research\n/);
  assert.match(body, /\ncwd: .*omelette-probe-grok-/);
  assert.match(body, /\nrefused/);
});

test('doctor --probe-sandbox: a unit that never answers is skipped as timed out, and the directory still goes', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeBin(dir, { mode: 'sleep' });
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], {
    dir,
    env: { AGY_BIN: gone, GROK_BIN: fake.path, CODEX_BIN: gone, GROK_TIMEOUT_S: '1' },
  });
  assert.match(r.out, /sandbox\s+skipped \(timed out after 1 s\)/);
  // A timeout proves nothing either way, so it is not a verdict and not an exit code.
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /BREACHED|held/);
  const ran = spawnedIn(fake.marker);
  assert.equal(ran.length, 1);
  assert.equal(existsSync(ran[0]), false);
});

test('doctor --probe-sandbox: a file on disk is BREACHED even when the run then hung past the cap', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeBin(dir, { mode: 'write-then-sleep' });
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], {
    dir,
    env: { AGY_BIN: gone, GROK_BIN: fake.path, CODEX_BIN: gone, GROK_TIMEOUT_S: '1' },
  });
  // Evidence outranks the timeout: the file was written, and it does not stop
  // being written because the run was cut off afterwards.
  const m = /sandbox\s+BREACHED — (\S+) was created \(\d+ s\)/.exec(r.out);
  assert.ok(m, r.out + r.err);
  assert.equal(r.code, 1, r.out);
  assert.equal(existsSync(dirname(m[1])), false);
});

test('doctor --probe-sandbox: disabled, unregistered and binary-less units are skipped with the reason', () => {
  const dir = home();
  const fake = probeBin(dir, { mode: 'write' });
  // gemini: registered AND its binary works — but switched off in the config.
  // grok:   binary works, never registered.
  // codex:  registered and enabled, binary gone.
  registerOurs(dir, ['gemini', 'codex']);
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { enabled: false } } }));
  const r = cli(['doctor', '--probe-sandbox'], {
    dir,
    env: { AGY_BIN: fake.path, GROK_BIN: fake.path, CODEX_BIN: join(dir, 'no-such-codex') },
  });
  assert.match(r.out, /── gemini[\s\S]*?sandbox\s+skipped \(disabled\)/);
  assert.match(r.out, /── grok[\s\S]*?sandbox\s+skipped \(not registered\)/);
  assert.match(r.out, /── codex[\s\S]*?sandbox\s+skipped \(binary not found\)/);
  // Not one of the three was asked anything: no run, no marker.
  assert.equal(existsSync(fake.marker), false);
  // Exit 1 here is the OLD fault (codex is enabled, registered and has no
  // binary) — the probe contributes nothing to it.
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /BREACHED/);
});

test('doctor without --probe-sandbox prints no sandbox line and spawns no unit', () => {
  const dir = home();
  const fake = probeBin(dir, { mode: 'write' });
  registerOurs(dir, ['gemini', 'grok', 'codex']);
  const r = cli(['doctor'], { dir, env: { AGY_BIN: fake.path, GROK_BIN: fake.path, CODEX_BIN: fake.path } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.doesNotMatch(r.out, /^\s+sandbox\s/m);
  // --version, models and login status only: the marker file was never touched.
  assert.equal(existsSync(fake.marker), false);
});

test('doctor --probe-sandbox names the write gate an operator left open, on any verdict', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeBin(dir, { mode: 'refuse' });
  registerOurs(dir, ['grok']);
  const open = cli(['doctor', '--probe-sandbox'], {
    dir,
    env: { AGY_BIN: gone, GROK_BIN: fake.path, CODEX_BIN: gone, OMELETTE_ALLOW_WRITE: 'grok' },
  });
  assert.match(open.out, /sandbox\s+held \(\d+ s, replied "refused"\) \(write gate open: OMELETTE_ALLOW_WRITE\)/);
  // The legacy alias opens gemini alone, and is named as itself. gemini has no
  // binary here, so this also pins that the suffix rides a `skipped` line too.
  const legacy = cli(['doctor', '--probe-sandbox'], {
    dir,
    env: { AGY_BIN: gone, GROK_BIN: fake.path, CODEX_BIN: gone, ORION_ALLOW_GEMINI_MUTATE: '1' },
  });
  assert.match(legacy.out, /── gemini[\s\S]*?sandbox\s+skipped \(not registered\) \(write gate open: ORION_ALLOW_GEMINI_MUTATE\)/);
  // A closed gate says nothing at all.
  assert.doesNotMatch(legacy.out, /── grok[\s\S]*?write gate open/);
});

// ─── the probe's own deadline, failed calls, the directory it reads, the env
//     it builds, mkdtemp and whose registration it probes (0.3.5 review) ──────

/**
 * A fake vendor CLI built from statements: doctor's --version / models / login
 * probes first — answered exactly like `probeBin`'s — and then `body`, which is
 * what the fake does on a REAL run. `cwd` is bound for it: the directory the
 * probe started it in, which the CLI may remove under its feet.
 */
function probeScript(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    "const p = require('path');",
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    "if (a[0] === 'models') { console.log('model-a'); console.log('model-b'); process.exit(0); }",
    "if (a[0] === 'login' && a[1] === 'status') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }",
    'const cwd = process.cwd();',
    body,
  ].join('\n'));
  chmodSync(path, 0o755);
  return path;
}

/** One unit's block of the fleet config — the file the probe's cap is read from. */
const fleetConfig = (dir, units) => writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units }));

/**
 * Wait briefly for a pid to be gone. A process SIGKILLed a moment ago can
 * still be a zombie until its parent reaps it, and `kill(pid, 0)` succeeds on
 * a zombie — so this polls rather than asking once. Synchronous, because
 * every test around it drives the CLI with spawnSync.
 */
function processGone(pid, ms = 3000) {
  const until = Date.now() + ms;
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (Date.now() > until) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

test('doctor --probe-sandbox: the directory is read after the aborted call has SETTLED, so a write still in flight is not missed', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  // The fake hands its stdout to a DETACHED grandchild and hangs. The abort
  // SIGKILLs the fake's process group, which the grandchild is no longer in:
  // it writes into the probe directory 1.5 s later — past the 1 s deadline —
  // and only then does the call settle, because the pipe it holds is what
  // core/spawn.mjs waits on. Reading the directory the instant the deadline
  // fires would call this `skipped`; it is a write, and it is a BREACH.
  const fake = probeScript(dir, 'leaky-cli', [
    "const { spawn } = require('child_process');",
    'const g = spawn(process.execPath, ["-e",',
    '  "setTimeout(() => { require(\'fs\').writeFileSync(process.argv[1], \'probe\'); process.exit(0); }, 1500);",',
    "  p.join(cwd, 'probe.txt')],",
    "  { detached: true, stdio: ['ignore', 1, 'ignore'] });",
    'g.unref();',
    'setTimeout(() => process.exit(0), 60000);',
  ].join('\n'));
  registerOurs(dir, ['gemini']);
  fleetConfig(dir, { gemini: { timeoutS: 1 } });
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: fake, GROK_BIN: gone, CODEX_BIN: gone }, timeout: 30000 });
  assert.match(r.out, /── gemini[\s\S]*?sandbox\s+BREACHED — \S+probe\.txt was created \(\d+ s\)/, r.out + r.err);
  assert.equal(r.code, 1, r.out);
});

test('doctor --probe-sandbox: a grandchild still holding stdout past the settle wait does not keep doctor alive', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  // The same leak, taken to its worst case: the detached grandchild writes at
  // once and then sits on the inherited stdout pipe for 30 s. The call NEVER
  // settles inside PROBE_SETTLE_MS, so the probe reads the directory on the
  // wait's own bound — and the pipe is a handle this process cannot close, so
  // a doctor that merely set an exit code would stay alive for the orphan's
  // whole life. It ends itself instead, once the report is out.
  const fake = probeScript(dir, 'leaky-hold-cli', [
    "const { spawn } = require('child_process');",
    'const g = spawn(process.execPath, ["-e",',
    '  "require(\'fs\').writeFileSync(process.argv[1], \'probe\'); setTimeout(() => process.exit(0), 30000);",',
    "  p.join(cwd, 'probe.txt')],",
    "  { detached: true, stdio: ['ignore', 1, 'ignore'] });",
    'g.unref();',
    'setTimeout(() => process.exit(0), 60000);',
  ].join('\n'));
  registerOurs(dir, ['gemini']);
  fleetConfig(dir, { gemini: { timeoutS: 1 } });
  const t0 = Date.now();
  // The net: 40 s is longer than the orphan lives, so a doctor that waited for
  // it fails on the elapsed time below rather than hanging the suite.
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: fake, GROK_BIN: gone, CODEX_BIN: gone }, timeout: 40000 });
  const elapsed = Date.now() - t0;
  const m = /── gemini[\s\S]*?sandbox\s+BREACHED — (\S+probe\.txt) was created \(\d+ s\)/.exec(r.out);
  assert.ok(m, r.out + r.err);
  assert.equal(r.code, 1, r.out);
  // capS (1 s) + the settle wait (5 s) + 5 s of slack: the orphan's 30 s is
  // not part of it.
  assert.ok(elapsed < 11000, `doctor took ${elapsed} ms — the leaked pipe kept it alive`);
  // The probe directory still went, and the whole report reached stdout: the
  // explicit exit waits for the flush, so nothing after the sandbox line is
  // cut off.
  assert.equal(existsSync(dirname(m[1])), false);
  assert.match(r.out, /1 unit\(s\) BREACHED the sandbox probe — see the sandbox lines above\./);
  assert.match(r.out, /── codex[\s\S]*?sandbox\s+skipped \(not registered\)/);
});

test('doctor --probe-sandbox: the probe has ONE deadline of its own, it ENDS the run, and the directory is read once the run is over', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const pidFile = join(dir, 'late-cli.pid');
  // agy's own hard kill sits 60 s ABOVE the timeout it hands the CLI, so this
  // child is NOT what ends the call — only the probe's deadline is. It sleeps
  // first and would write two seconds past that deadline, but the abort kills
  // it before it gets there: this is the deterministic other end of the race
  // the settled-read test pins — a write that never happened, because the pid
  // was gone before it could, is `skipped` and not a verdict. It would then
  // have sat there for a minute, and until it ends doctor's own event loop
  // cannot drain.
  const fake = probeScript(dir, 'late-cli', [
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'setTimeout(() => {',
    "  try { fs.writeFileSync(p.join(cwd, 'probe.txt'), 'probe'); } catch { /* the directory is gone */ }",
    "  console.log('done');",
    '}, 3000);',
    'setTimeout(() => process.exit(0), 60000);',
  ].join('\n'));
  registerOurs(dir, ['gemini']);
  fleetConfig(dir, { gemini: { timeoutS: 1 } });
  const t0 = Date.now();
  // The timeout is the test's own net: without the abort this run hangs on the
  // fake for a minute, and a hung suite reports nothing.
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: fake, GROK_BIN: gone, CODEX_BIN: gone }, timeout: 30000 });
  const elapsed = Date.now() - t0;
  assert.match(r.out, /── gemini[\s\S]*?sandbox\s+skipped \(timed out after 1 s\)/, r.out + r.err);
  assert.doesNotMatch(r.out, /BREACHED/);
  assert.equal(r.code, 0, r.out);
  // capS + 5 s: the deadline is 1 s here and the kill is immediate.
  assert.ok(elapsed < 6000, `doctor took ${elapsed} ms — the abandoned run kept it alive`);
  // …and the vendor process is not still running behind it.
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(pid > 0, 'the fake recorded no pid');
  assert.equal(processGone(pid), true, `pid ${pid} outlived doctor`);
});

test('doctor --probe-sandbox: a file the run wrote before the deadline is BREACHED, timed as the wait that happened', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  // Written at once, then the run hangs well past the cap: the write BEAT the
  // kill, so the verdict is a breach, and the seconds on the line are the wait
  // the probe did for an answer — not the wait the CLI would have needed, and
  // not the moment the abandoned call finally settled.
  const fake = probeScript(dir, 'write-then-hang', [
    "fs.writeFileSync(p.join(cwd, 'probe.txt'), 'probe');",
    'setTimeout(() => process.exit(0), 3000);',
  ].join('\n'));
  registerOurs(dir, ['gemini']);
  fleetConfig(dir, { gemini: { timeoutS: 1 } });
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: fake, GROK_BIN: gone, CODEX_BIN: gone } });
  assert.match(r.out, /sandbox\s+BREACHED — \S+probe\.txt was created \(1 s\)/, r.out + r.err);
  assert.equal(r.code, 1, r.out);
});

test('doctor --probe-sandbox: a call that failed is skipped with the reason, never reported as held', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeScript(dir, 'error-cli', [
    "process.stderr.write('grok: upstream refused the request\\n');",
    'process.exit(1);',
  ].join('\n'));
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone } });
  // `held` is a claim about a sandbox, and a call that never answered supports
  // no claim at all: the run failed, and the line says which failure it was.
  assert.match(r.out, /── grok[\s\S]*?sandbox\s+skipped \(call failed: [^\n]+\)/, r.out + r.err);
  assert.doesNotMatch(r.out, /sandbox\s+held/);
  assert.equal(r.code, 0, r.out);
});

test('doctor --probe-sandbox: a unit that answers nothing at all is skipped, not held', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeScript(dir, 'silent-cli', 'process.exit(0);');
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone } });
  assert.match(r.out, /── grok[\s\S]*?sandbox\s+skipped \(call failed: [^\n]+\)/, r.out + r.err);
  assert.doesNotMatch(r.out, /sandbox\s+held/);
  assert.equal(r.code, 0, r.out);
});

test('doctor --probe-sandbox: a failed call whose unit wrote anyway is still BREACHED', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeScript(dir, 'write-then-fail', [
    "fs.writeFileSync(p.join(cwd, 'probe.txt'), 'probe');",
    "process.stderr.write('grok: exploded after writing\\n');",
    'process.exit(1);',
  ].join('\n'));
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone } });
  // The filesystem outranks the reply in both directions: an error reply is
  // still a breach when the file is there.
  assert.match(r.out, /sandbox\s+BREACHED — \S+probe\.txt was created/, r.out + r.err);
  assert.equal(r.code, 1, r.out);
});

test('doctor --probe-sandbox: a unit that removes the probe directory is BREACHED, not held', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeScript(dir, 'rmdir-cli', [
    "process.chdir('/');",
    'fs.rmdirSync(cwd);',
    "console.log('done');",
    'process.exit(0);',
  ].join('\n'));
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone } });
  // An empty directory and a directory that is not there any more are not the
  // same answer: the second one is a write, and reading it as `held` would be
  // the one mistake this probe exists to avoid.
  assert.match(r.out, /sandbox\s+BREACHED — \S+omelette-probe-grok-\S+ directory was removed or replaced \(\d+ s\)/, r.out + r.err);
  assert.equal(r.code, 1, r.out);
});

test('doctor --probe-sandbox: a probe directory replaced by a symlink is BREACHED, and the link is not followed', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const decoy = join(dir, 'decoy');
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, 'innocent.txt'), 'not the probe');
  const fake = probeScript(dir, 'symlink-cli', [
    "process.chdir('/');",
    'fs.rmdirSync(cwd);',
    `fs.symlinkSync(${JSON.stringify(decoy)}, cwd);`,
    "console.log('done');",
    'process.exit(0);',
  ].join('\n'));
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone } });
  assert.match(r.out, /sandbox\s+BREACHED — \S+omelette-probe-grok-\S+ directory was removed or replaced \(\d+ s\)/, r.out + r.err);
  assert.doesNotMatch(r.out, /innocent\.txt/);
  assert.equal(r.code, 1, r.out);
  // The link is removed; what it pointed at is not.
  assert.equal(existsSync(join(decoy, 'innocent.txt')), true);
});

test('doctor --probe-sandbox: a relative OMELETTE_HOME behaves exactly as it does under plain doctor', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeScript(dir, 'quiet-cli', ["console.log('refused');", 'process.exit(0);'].join('\n'));
  registerOurs(dir, ['grok']);
  // The home the CLI is told about is RELATIVE — a perfectly ordinary way to
  // run it from a project. The probe changes no directory any more, so that
  // path is relative to the same thing under the flag as without it: doctor's
  // own cwd. Nothing in the probe rewrites it, and nothing has to.
  const env = { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone, OMELETTE_HOME: 'relhome' };
  const plain = cli(['doctor'], { dir, env });
  const probed = cli(['doctor', '--probe-sandbox'], { dir, env });
  // doctor reports the home exactly as it was given, flag or no flag…
  const feedLine = (r) => (/^\s+status feed\s+(.*)$/m.exec(r.out) || [])[1];
  assert.equal(feedLine(plain), 'relhome is writable', plain.out + plain.err);
  assert.equal(feedLine(probed), feedLine(plain), 'the flag changed what doctor reports about the home');
  // …and it lands in the same place: beside the directory doctor was run in.
  assert.equal(existsSync(join(dir, 'relhome')), true);
  // The probe ran, and its answer was spooled into THAT home — not into the
  // throwaway directory, which would have read as a breach of a sandbox
  // nothing touched.
  assert.match(probed.out, /── grok[\s\S]*?sandbox\s+held \(\d+ s, replied "refused"\)/, probed.out + probed.err);
  assert.doesNotMatch(probed.out, /BREACHED/);
  const spool = readdirSync(join(dir, 'relhome', 'results', 'grok')).filter((f) => f.endsWith('.md'));
  assert.equal(spool.length, 1, spool.join(','));
  // …and nowhere else: no second fleet home appeared because a relative path
  // resolved against something other than doctor's own cwd.
  assert.equal(existsSync(join(dir, 'results')), false);
});

test('doctor --probe-sandbox: a temp directory that cannot be created is skipped with the reason', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeScript(dir, 'quiet-cli', ["console.log('refused');", 'process.exit(0);'].join('\n'));
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], {
    dir,
    env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone, TMPDIR: join(dir, 'no-such-tmp') },
  });
  assert.match(r.out, /── grok[\s\S]*?sandbox\s+skipped \(temp dir: [^\n]+\)/, r.out + r.err);
  assert.equal(r.code, 0, r.out);
});

test('doctor --probe-sandbox: a registration that is not ours is not probed', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeBin(dir, { mode: 'write' });
  // A server of somebody else's, wearing our name: doctor already reports it
  // as "registered elsewhere", and spending a call on a clone this checkout
  // does not run would be measuring another install's sandbox.
  const other = join(dir, 'other-clone', 'servers');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'grok.mjs'), '// another clone\n');
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-grok': { command: 'node', args: [join(other, 'grok.mjs')] } },
  }));
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake.path, CODEX_BIN: gone } });
  assert.match(r.out, /── grok[\s\S]*?sandbox\s+skipped \(registered elsewhere\)/, r.out + r.err);
  assert.equal(existsSync(fake.marker), false, 'nothing was spawned');
  assert.equal(r.code, 0, r.out);
});

test('call drives a real server over stdio and maps the answer to an exit code', () => {
  const dir = home();
  const ok = cli(['call', 'codex', 'codex_models', '{}'], { dir });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /initialize → omelette-codex/);
  assert.match(ok.out, /tools\/list → codex_research, codex_code_review, codex_image, codex_models, codex_result/);
  assert.match(ok.out, /tools\/call → ok/);
  assert.match(ok.out, /CODEX MODEL CATALOG/);

  // a tool that answers with isError → exit 2, no spawn needed (unknown model is caught before it)
  const bad = cli(['call', 'codex', 'codex_research', '{"prompt":"x","model":"no-such-model"}'], { dir });
  assert.equal(bad.code, 2);
  assert.match(bad.out, /unknown model "no-such-model"/);

  // transport-level refusals → exit 1
  assert.equal(cli(['call', 'codex', 'not_a_tool', '{}'], { dir }).code, 1);
  assert.equal(cli(['call', 'nope', 'x', '{}'], { dir }).code, 1);
  assert.equal(cli(['call', 'codex', 'codex_models', '{oops'], { dir }).code, 1);
  assert.match(cli(['call', 'codex', 'codex_models', '{}', '--timeout', '0'], { dir }).err, /--timeout must be a positive number/);
});

test('every unit advertises <unit>_result, and it answers over real stdio with no vendor CLI', () => {
  const dir = home();
  for (const unit of ['gemini', 'grok', 'codex']) {
    // The client refuses a tool that is not in tools/list, so exit 2 — "the
    // tool answered with an error" — is proof it is advertised AND local.
    const r = cli(['call', unit, `${unit}_result`, '{}'], { dir });
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out, /result spool is empty/);
  }
});

/**
 * Send `initialize` to a real unit server and return its result.
 *
 * Every way this can go wrong has to SETTLE, or a broken server turns into a
 * hung suite with no diagnostic (`node:test` has no default per-test timeout):
 *   - a server that dies before answering → reject with its exit code and stderr,
 *   - a server that answers nothing at all → reject on the timeout, child killed.
 * And only a COMPLETE line (one terminated by '\n') is ever parsed: the ~2 KB
 * initialize frame can arrive across several `data` events, and parsing a
 * fragment would fail a perfectly healthy server.
 */
function initializeServer(serverPath, env, { timeoutMs = 10_000, cwd = env.dir } = {}) {
  return new Promise((resolve, reject) => {
    // `cwd` is not decoration: since 0.3.7 the directory a server is started in
    // decides how much contract it sends back, and the default here would be
    // this checkout — which renders its own .claude/rules on a developer
    // machine and not on CI.
    const p = spawn(process.execPath, [serverPath], { cwd, env: { PATH: process.env.PATH, HOME: env.dir, OMELETTE_HOME: env.dir, OMELETTE_UPDATE_CHECK: '0', OMELETTE_STATUS: '0' } });
    let buf = '';
    let err = '';
    let done = false;
    const settle = (fn, v) => { if (done) return; done = true; clearTimeout(timer); p.kill(); fn(v); };
    const timer = setTimeout(
      () => settle(reject, new Error(`${serverPath}: no initialize answer in ${timeoutMs}ms · stderr: ${err.trim() || '(none)'}`)),
      timeoutMs,
    );
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (c) => { err += c; });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c) => {
      buf += c;
      // Consume complete lines until one has content: a blank line before the
      // frame must not park the parser until the next `data` event.
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue; // a partial frame never gets here: only whole lines are parsed
        try { settle(resolve, JSON.parse(line).result); } catch (e) { settle(reject, e); }
        return;
      }
    });
    p.on('error', (e) => settle(reject, e));
    // A child that exits before reading turns the write below into EPIPE, and an
    // unhandled 'error' on stdin would take the test runner down with it.
    p.stdin.on('error', () => {});
    p.on('close', (code, signal) => settle(
      reject,
      new Error(`${serverPath}: exited (code ${code}, signal ${signal}) before answering initialize · stderr: ${err.trim() || '(none)'}`),
    ));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  });
}

test('every unit server returns the fleet contract plus its own line from initialize', async () => {
  const dir = home();
  // A project with no rules file of ours in either scope (HOME is `dir` too):
  // the full contract, which is what a fleet without the rules delivered gets.
  const proj = join(dir, 'proj'); mkdirSync(proj);
  for (const unit of ['gemini', 'grok', 'codex']) {
    const res = await initializeServer(join(ROOT, 'servers', `${unit}.mjs`), { dir }, { cwd: proj });
    assert.ok(res.instructions.startsWith('omelette-fleet: this server is one read-only unit'), `${unit}: contract first`);
    assert.match(res.instructions, /run `omelette-fleet rules`/);
    assert.match(res.instructions, /\n\nThis unit: /, `${unit}: has its own line`);
    assert.ok(res.instructions.startsWith(FLEET_CONTRACT), `${unit}: the contract verbatim`);
  }
});

test('a server started where the rules are installed sends ONE line instead of the contract', async () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const server = join(ROOT, 'servers', 'codex.mjs');
  const ownLine = /\n\nThis unit: Codex/;

  // A file at the path that is not ours changes nothing: the marker is the
  // only proof of ownership, here as everywhere else.
  mkdirSync(join(proj, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'rules', 'omelette-fleet.md'), '# my own rules\n');
  const foreign = await initializeServer(server, { dir }, { cwd: proj });
  assert.ok(foreign.instructions.startsWith(FLEET_CONTRACT), foreign.instructions.slice(0, 200));

  // The real file, written by the real command: one line, then the unit's own.
  assert.equal(rulesIn(proj, dir, ['--force']).status, 0);
  const short = await initializeServer(server, { dir }, { cwd: proj });
  assert.ok(short.instructions.startsWith(`${SHORT_CONTRACT}\n\nThis unit: Codex`), short.instructions.slice(0, 200));
  assert.match(short.instructions, ownLine);
  assert.ok(short.instructions.length < FLEET_CONTRACT.length, 'shorter than what it replaced');

  // A project with none of its own reads the GLOBAL one (HOME is `dir`).
  const other = join(dir, 'other'); mkdirSync(other);
  const before = await initializeServer(server, { dir }, { cwd: other });
  assert.ok(before.instructions.startsWith(FLEET_CONTRACT), 'no rules yet in either scope');
  assert.equal(rulesIn(other, dir, ['--global']).status, 0);
  const global = await initializeServer(server, { dir }, { cwd: other });
  assert.ok(global.instructions.startsWith(SHORT_CONTRACT), global.instructions.slice(0, 200));
  assert.match(global.instructions, ownLine);

  // And the config key wins over both directions of the lookup.
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, contract: 'full' }));
  const forced = await initializeServer(server, { dir }, { cwd: proj });
  assert.ok(forced.instructions.startsWith(FLEET_CONTRACT), 'contract=full, with the rules installed right there');
  // The other direction, with the global file taken away again so that only
  // the config can be deciding: a directory with no rules file in reach.
  assert.equal(rulesIn(other, dir, ['--remove', '--global']).status, 0);
  const bare = join(dir, 'bare'); mkdirSync(bare);
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, contract: 'short' }));
  const forcedShort = await initializeServer(server, { dir }, { cwd: bare });
  assert.ok(forcedShort.instructions.startsWith(SHORT_CONTRACT), 'contract=short, with no rules file anywhere');
});

/** The `up ·` line a unit server prints on stderr the moment it starts, in `cwd`. */
function startupLine(serverPath, env, cwd, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [serverPath], { cwd, env: { PATH: process.env.PATH, HOME: env.dir, OMELETTE_HOME: env.dir, OMELETTE_UPDATE_CHECK: '0', OMELETTE_STATUS: '0' } });
    let err = '';
    let done = false;
    const settle = (fn, v) => { if (done) return; done = true; clearTimeout(timer); p.kill(); fn(v); };
    const timer = setTimeout(() => settle(reject, new Error(`${serverPath}: no "up ·" line in ${timeoutMs}ms · stderr: ${err.trim() || '(none)'}`)), timeoutMs);
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (c) => {
      err += c;
      const line = err.split('\n').find((l) => l.includes('up · '));
      if (line !== undefined && err.indexOf('\n', err.indexOf(line)) >= 0) settle(resolve, line);
    });
    p.on('error', (e) => settle(reject, e));
    p.stdin.on('error', () => {});
    p.on('close', (code, signal) => settle(reject, new Error(`${serverPath}: exited (code ${code}, signal ${signal}) before saying anything · stderr: ${err.trim() || '(none)'}`)));
  });
}

test('the startup line says which contract this server resolved, and why', async () => {
  // The one thing an operator can read without a client: `doctor` answers for
  // ITS cwd, and this line answers for the directory Claude Code actually
  // started the server in.
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const server = join(ROOT, 'servers', 'codex.mjs');

  // The child reports its OWN `process.cwd()`, which is the resolved path —
  // `/var/folders/…` is a symlink to `/private/var/folders/…` on macOS.
  const full = await startupLine(server, { dir }, proj);
  assert.match(full, new RegExp(`contract=full \\(no rules file in ${realpathSync(proj).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), full);

  assert.equal(rulesIn(proj, dir).status, 0);
  const short = await startupLine(server, { dir }, proj);
  assert.match(short, /contract=short \(rules installed here\)/, short);
  // Beside the fields that were always there, not instead of them.
  assert.match(short, /up · bin=/);
  assert.match(short, /· config=/);
});

test('per-command help: `<cmd> --help`, `-h` and `help <cmd>` all print that command\'s page', () => {
  const dir = home();
  for (const cmd of ['install', 'uninstall', 'update', 'rules', 'doctor', 'show', 'set', 'call']) {
    for (const argv of [[cmd, '--help'], [cmd, '-h'], ['help', cmd]]) {
      const r = cli(argv, { dir });
      assert.equal(r.code, 0, `${argv.join(' ')} → ${r.err}`);
      assert.match(r.out, new RegExp(`^omelette-fleet ${cmd}$`, 'm'));
      assert.match(r.out, new RegExp(`^  omelette-fleet ${cmd} `, 'm'));
      assert.equal(r.err, ''); // never a parse error
    }
  }
  // The per-command body is the same text the global listing is built from.
  assert.ok(cli(['doctor', '--help'], { dir }).out.includes('--probe-models spends real Codex calls'));
  assert.ok(cli([], { dir }).out.includes('--probe-models spends real Codex calls'));
});

test('set refuses to replace a "units" (or a unit entry) that is not an object', () => {
  const dir = home();
  const cfg = join(dir, 'fleet.config.json');
  writeFileSync(cfg, JSON.stringify({ version: 1, units: ['codex'] }));
  const arr = cli(['set', 'codex.timeoutS=42'], { dir });
  assert.equal(arr.code, 1);
  assert.match(arr.err, /"units" is an array, not an object/);
  assert.equal(readFileSync(cfg, 'utf8'), JSON.stringify({ version: 1, units: ['codex'] })); // untouched

  writeFileSync(cfg, JSON.stringify({ version: 1, units: { codex: 'read-only' } }));
  const str = cli(['set', 'codex.timeoutS=42'], { dir });
  assert.equal(str.code, 1);
  assert.match(str.err, /"units\.codex" is a string, not an object/);
  // a DIFFERENT unit's broken entry is not in the way of this write
  writeFileSync(cfg, JSON.stringify({ version: 1, units: { grok: 7, codex: { timeoutS: 1 } } }));
  assert.equal(cli(['set', 'codex.timeoutS=42'], { dir }).code, 0);
  assert.equal(JSON.parse(readFileSync(cfg, 'utf8')).units.grok, 7); // and it is preserved
});

test('set writes the agents block, show reads it back with sources, and the note points at rules --agents', () => {
  const dir = home();
  const s = cli(['set', 'agents.tester.maxTurns=120'], { dir });
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /agents\.tester\.maxTurns\s+80 \[default\] → 120 \[file\]/);
  assert.match(s.out, /rules --agents/, 'a changed setting is only in the definitions after a re-render');
  // exactly the nested shape the spec names — merged into the file, top level
  const written = JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8'));
  assert.deepEqual(written.agents, { tester: { maxTurns: 120 } });
  assert.equal(written.version, 1);

  const shown = cli(['show', 'agents'], { dir });
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /^agents$/m);
  assert.match(shown.out, /^\s+tester\.maxTurns\s+120\s+file$/m);
  assert.match(shown.out, /^\s+coder\.model\s+opus\s+default$/m);
  assert.match(shown.out, /^\s+coder\.effort\s+xhigh\s+default$/m);
  assert.match(shown.out, /^\s+tester\.model\s+sonnet\s+default$/m);
  assert.doesNotMatch(shown.out, /^codex$/m, 'show agents shows the block and nothing else');
  // a bare `show` lists it after the units, and a unit selection never does
  assert.match(cli(['show'], { dir }).out, /^agents$/m);
  assert.doesNotMatch(cli(['show', 'codex'], { dir }).out, /^agents$/m);
  // a second set merges instead of replacing the block
  assert.equal(cli(['set', 'agents.coder.model=opus-4'], { dir }).code, 0);
  const both = JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8'));
  assert.deepEqual(both.agents, { tester: { maxTurns: 120 }, coder: { model: 'opus-4' } });
});

test('set refuses an unknown agent, an unknown agent key and an out-of-range value — exit 1, nothing written', () => {
  const dir = home();
  const role = cli(['set', 'agents.nope.model=x'], { dir });
  assert.equal(role.code, 1);
  assert.match(role.err, /unknown agent "nope" — known agents: coder, tester/);
  const key = cli(['set', 'agents.tester.turns=1'], { dir });
  assert.equal(key.code, 1);
  assert.match(key.err, /unknown key "turns" for agent "tester" — known keys: model, effort, maxTurns/);
  const zero = cli(['set', 'agents.tester.maxTurns=0'], { dir });
  assert.equal(zero.code, 1);
  assert.match(zero.err, /invalid value for agents\.tester\.maxTurns: "0" — expected a positive integer/);
  // A posint is a WHOLE number: `0.5` used to floor to the 0 the key forbids,
  // and `1.9` to a 1 nobody wrote. Both are refused outright now.
  for (const value of ['0.5', '1.9']) {
    const fraction = cli(['set', `agents.tester.maxTurns=${value}`], { dir });
    assert.equal(fraction.code, 1, value);
    assert.match(fraction.err, new RegExp(`invalid value for agents\\.tester\\.maxTurns: "${value}" — expected a positive integer`));
  }
  const unitFraction = cli(['set', 'grok.outputCap=0.5'], { dir });
  assert.equal(unitFraction.code, 1);
  assert.match(unitFraction.err, /invalid value for grok\.outputCap: "0\.5" — expected a positive integer/);
  const effort = cli(['set', 'agents.coder.effort=turbo'], { dir });
  assert.equal(effort.code, 1);
  assert.match(effort.err, /invalid value for agents\.coder\.effort: "turbo" — expected low \| medium \| high \| xhigh \| max/);
  const blank = cli(['set', 'agents.coder.model='], { dir });
  assert.equal(blank.code, 1);
  const shape = cli(['set', 'agents.tester=120'], { dir });
  assert.equal(shape.code, 1);
  assert.equal(existsSync(join(dir, 'fleet.config.json')), false);
});

test('set refuses a model that is not one printable line — a newline would escape the frontmatter', () => {
  const dir = home();
  const cfg = join(dir, 'fleet.config.json');
  const original = JSON.stringify({ version: 1, agents: { coder: { model: 'opus' } } });
  writeFileSync(cfg, original);
  for (const value of ['opus\n---\ninjected: 1', 'opus\ttabbed', '\u001b[0mopus']) {
    const r = cli(['set', `agents.coder.model=${value}`], { dir });
    assert.equal(r.code, 1, JSON.stringify(value));
    assert.match(r.err, /invalid value for agents\.coder\.model: .* — expected a single printable line/);
    assert.equal(readFileSync(cfg, 'utf8'), original, 'a refused set never touches the file');
  }
  // a name with ordinary spaces is still a name
  assert.equal(cli(['set', 'agents.coder.model=Claude Opus 5'], { dir }).code, 0);
  assert.equal(JSON.parse(readFileSync(cfg, 'utf8')).agents.coder.model, 'Claude Opus 5');
});

test('set agents.* is not blocked by a broken "units" block it never touches (and the reverse)', () => {
  const dir = home();
  const cfg = join(dir, 'fleet.config.json');
  writeFileSync(cfg, JSON.stringify({ version: 1, units: 'broken' }));
  const r = cli(['set', 'agents.tester.maxTurns=120'], { dir });
  assert.equal(r.code, 0, r.err);
  const written = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.deepEqual(written.agents, { tester: { maxTurns: 120 } });
  assert.equal(written.units, 'broken', 'the block it did not touch is preserved, not repaired');
  // and the mirror image: a unit key is not blocked by a broken agents block
  writeFileSync(cfg, JSON.stringify({ version: 1, agents: 'broken' }));
  assert.equal(cli(['set', 'codex.timeoutS=42'], { dir }).code, 0);
  assert.equal(JSON.parse(readFileSync(cfg, 'utf8')).agents, 'broken');
});

test('set refuses to replace an "agents" block (or one agent entry) that is not an object', () => {
  const dir = home();
  const cfg = join(dir, 'fleet.config.json');
  writeFileSync(cfg, JSON.stringify({ version: 1, agents: ['tester'] }));
  const arr = cli(['set', 'agents.tester.maxTurns=120'], { dir });
  assert.equal(arr.code, 1);
  assert.match(arr.err, /"agents" is an array, not an object/);
  assert.equal(readFileSync(cfg, 'utf8'), JSON.stringify({ version: 1, agents: ['tester'] })); // untouched

  writeFileSync(cfg, JSON.stringify({ version: 1, agents: { tester: 120 } }));
  const num = cli(['set', 'agents.tester.maxTurns=120'], { dir });
  assert.equal(num.code, 1);
  assert.match(num.err, /"agents\.tester" is a number, not an object/);
  // a unit write is not blocked by a broken agents block it does not touch
  assert.equal(cli(['set', 'codex.timeoutS=42'], { dir }).code, 0);
  assert.equal(JSON.parse(readFileSync(cfg, 'utf8')).agents.tester, 120); // and it is preserved
});

test('call refuses json args that are not an object', () => {
  const dir = home();
  for (const bad of ['[]', 'null', '3', '"hi"']) {
    const r = cli(['call', 'codex', 'codex_models', bad], { dir });
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /json args must be a JSON object/);
  }
  assert.equal(cli(['call', 'codex', 'codex_models', '{}'], { dir }).code, 0);
});

test('uninstall: a failed remove of a REGISTERED server is a failure (exit 1); an unregistered one is a no-op', () => {
  const dir = home();
  const server = join(ROOT, 'servers', 'codex.mjs');
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-codex': { command: 'node', args: [server] } },
  }));
  const PATH = `${fakeClaude(dir, { exitCode: 3 })}:${process.env.PATH}`;

  const both = cli(['uninstall', '--units', 'codex,grok'], { dir, env: { PATH } });
  assert.equal(both.code, 1, both.out);
  assert.match(both.out, /FAILED to remove omelette-codex \(exit 3\): claude says no/);
  assert.match(both.out, /omelette-grok was not registered — nothing to remove/); // idempotent
  assert.match(both.out, /Still registered: omelette-codex\./);

  // Nothing that was registered → nothing that can fail.
  const clean = cli(['uninstall', '--units', 'grok'], { dir, env: { PATH } });
  assert.equal(clean.code, 0);
  assert.match(clean.out, /config and the status files were not touched/);

  // A claude that succeeds removes it and exits 0.
  const okPath = `${fakeClaude(dir, { exitCode: 0, name: 'okdir' })}:${process.env.PATH}`;
  const done = cli(['uninstall', '--units', 'codex'], { dir, env: { PATH: okPath } });
  assert.equal(done.code, 0);
  assert.match(done.out, /removed omelette-codex/);
});

test('uninstall --dry-run marks the units that are not registered, and claude missing changes nothing', () => {
  const dir = home();
  const r = cli(['uninstall', '--dry-run', '--units', 'codex'], { dir });
  assert.equal(r.code, 0);
  assert.match(r.out, /would run: claude mcp remove -s user omelette-codex   \(not registered — a no-op\)/);
  const noClaude = cli(['uninstall', '--units', 'codex'], { dir, env: { PATH: join(dir, 'empty') } });
  assert.equal(noClaude.code, 0);
  assert.match(noClaude.out, /NOTHING WAS CHANGED/);
  assert.match(noClaude.out, /claude mcp remove -s user omelette-codex/);
});

// ─── update ──────────────────────────────────────────────────────────────────

test('update (git): up to date, --check on a behind clone (exit 3), a dirty tree (exit 1), then the fast-forward', { skip: !gitAvailable && 'git is not installed' }, () => {
  const fx = gitFixture();
  const dir = home();
  const env = { OMELETTE_PKG_ROOT: fx.clone };

  // Nothing new on origin yet.
  const level = cli(['update'], { dir, env });
  assert.equal(level.code, 0, level.out + level.err);
  assert.match(level.out, /omelette-fleet 0\.1\.0 · git install/);
  assert.match(level.out, /update check disabled/); // opted out — no network in tests
  assert.match(level.out, /already up to date — HEAD matches origin\/main/);
  assert.equal(cli(['update', '--check'], { dir, env }).code, 0);

  // A release lands on origin: --check reports it, exits 3, and changes nothing.
  bump(fx.work, '0.2.0');
  const check = cli(['update', '--check'], { dir, env });
  assert.equal(check.code, 3, check.out + check.err);
  assert.match(check.out, /behind\s+1 commit\(s\) behind origin\/main/);
  assert.match(check.out, /--check changed nothing/);
  assert.equal(pkgVersion(fx.clone), '0.1.0');

  // A dirty checkout is refused with the list — nothing is pulled over it.
  writeFileSync(join(fx.clone, 'servers', 'codex.mjs'), '// locally edited\n');
  const dirty = cli(['update'], { dir, env });
  assert.equal(dirty.code, 1, dirty.out);
  assert.match(dirty.out, /1 local change\(s\) — a pull would overwrite them/);
  assert.match(dirty.out, /servers\/codex\.mjs/);
  assert.match(dirty.out, /Commit, stash or discard them first/);
  assert.equal(pkgVersion(fx.clone), '0.1.0');
  assert.equal(cli(['update', '--check'], { dir, env }).code, 1); // --check refuses it too

  // Clean again → the fast-forward happens and the version line proves it.
  git(fx.clone, ['checkout', '--', '.']);
  const pulled = cli(['update'], { dir, env });
  assert.equal(pulled.code, 0, pulled.out + pulled.err);
  assert.match(pulled.out, /pulled\s+0\.1\.0 → 0\.2\.0/);
  assert.match(pulled.out, /Restart Claude Code to load the new servers\./);
  assert.equal(pkgVersion(fx.clone), '0.2.0');
  assert.match(cli(['update'], { dir, env }).out, /already up to date/);
});

test('update (git): a diverged checkout is never merged — exit 1 with what to do about it', { skip: !gitAvailable && 'git is not installed' }, () => {
  const fx = gitFixture();
  const dir = home();
  const env = { OMELETTE_PKG_ROOT: fx.clone };
  bump(fx.work, '0.2.0');
  // A committed local change on the same branch: clean tree, but --ff-only cannot apply.
  writeFileSync(join(fx.clone, 'servers', 'codex.mjs'), '// a local fix\n');
  git(fx.clone, ['commit', '-am', 'local work']);
  const r = cli(['update'], { dir, env });
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /git pull --ff-only origin main failed/);
  assert.match(r.err, /diverged from origin\/main/);
  assert.equal(pkgVersion(fx.clone), '0.1.0'); // untouched
});

test('update (npm): nothing is pulled — the exact upgrade command, exit 0', () => {
  const dir = home();
  const root = mkdtempSync(join(tmpdir(), 'omelette-npm-'));
  writePkg(root, '0.1.0');
  const env = { OMELETTE_PKG_ROOT: root };
  const r = cli(['update'], { dir, env });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /omelette-fleet 0\.1\.0 · npm install/);
  assert.match(r.out, /^ {2}npm i -g omelette-fleet@latest$/m);
  assert.match(r.out, /npx omelette-fleet@latest/);
  assert.equal(cli(['update', '--check'], { dir, env }).code, 0); // no release check → nothing to report
  const bad = cli(['update', '--nope'], { dir, env });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown flag: --nope/);
});

// ─── rules ───────────────────────────────────────────────────────────────────

/**
 * The marker lines exactly as the CLI generates them: a fixture that only
 * STARTS like the marker is not ours, so hand-truncated ones would be testing
 * a file the CLI is right to refuse.
 */
const MARKED_RULES = (v, body = '') => `${RULES_MARKER(v)}\n${body}`;
const MARKED_AGENT = (v, name) => `---\n${AGENT_MARKER(v)}\nname: ${name}\n---\nold\n`;
const MARKED_SKILL = (v) => `---\n${SKILL_MARKER(v)}\nname: omelette-test\n---\nold\n`;
const MARKED_HOOK = (v) => `${HOOK_MARKER(v)}\n// old\n`;

test('rules: writes the managed file into <cwd>/.claude/rules, is idempotent, refreshes an older marker', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const target = join(proj, '.claude', 'rules', 'omelette-fleet.md');
  const r1 = spawnSync(process.execPath, [BIN, 'rules'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } });
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /^written .*omelette-fleet\.md \(v\d+\.\d+\.\d+, was absent\)/m);
  // True for --global and for --agents too: it never names one location, and it
  // says how each kind of file actually reaches a session.
  assert.match(r1.stdout, /^Rules load on the next session start; agent definitions and skills are picked up by Claude Code's watcher — usually within seconds, sometimes minutes \(restart if \.claude\/agents or \.claude\/skills did not exist before\)\.$/m);
  const text = readFileSync(target, 'utf8');
  assert.ok(text.startsWith('<!-- omelette-fleet rules v'));
  assert.match(text, /Tester flow/);
  const r2 = spawnSync(process.execPath, [BIN, 'rules'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } });
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /^up to date/m);
  writeFileSync(target, text.replace(/rules v\d+\.\d+\.\d+/, 'rules v0.0.1'));
  const r3 = spawnSync(process.execPath, [BIN, 'rules'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } });
  assert.match(r3.stdout, /was 0\.0\.1\)/);
  assert.equal(readFileSync(target, 'utf8'), text);
});

test('rules: a foreign file is never touched without --force, and --remove refuses it too', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(join(proj, '.claude', 'rules'), { recursive: true });
  const target = join(proj, '.claude', 'rules', 'omelette-fleet.md');
  writeFileSync(target, '# mine\n');
  const run = (args) => spawnSync(process.execPath, [BIN, 'rules', ...args], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } });
  const r1 = run([]);
  assert.equal(r1.status, 1); assert.match(r1.stderr, /not managed by omelette-fleet/); assert.equal(readFileSync(target, 'utf8'), '# mine\n');
  const r2 = run(['--remove']);
  assert.equal(r2.status, 1); assert.ok(existsSync(target));
  const r3 = run(['--force']);
  assert.equal(r3.status, 0); assert.match(r3.stdout, /was foreign\)/); assert.ok(readFileSync(target, 'utf8').startsWith('<!-- omelette-fleet rules v'));
  const r4 = run(['--remove']);
  assert.equal(r4.status, 0); assert.match(r4.stdout, /^removed /m); assert.ok(!existsSync(target));
  const r5 = run(['--remove']);
  assert.equal(r5.status, 0); assert.match(r5.stdout, /nothing to remove/);
});

test('rules: a write it cannot do is one refusal line — no stack, no .tmp, no partial file', { skip: (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) && 'directory permissions are not enforced here' }, () => {
  const dir = home();
  const proj = join(dir, 'proj');
  const rulesDir = join(proj, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  chmodSync(rulesDir, 0o500); // readable, listable, NOT writable
  const r = spawnSync(process.execPath, [BIN, 'rules'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } });
  const left = readdirSync(rulesDir);
  chmodSync(rulesDir, 0o700); // leave the temp tree removable
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^omelette-fleet rules: cannot write .*omelette-fleet\.md: /m);
  assert.doesNotMatch(r.stderr, /at .*omelette-fleet\.mjs/); // a refusal, never a stack
  assert.deepEqual(left, [], `nothing may be left behind, found ${left.join(', ')}`);
});

// Symlink games are POSIX-only here: on Windows an unprivileged symlinkSync throws.
const symlinksWork = process.platform !== 'win32';

/** Directory permissions and mkfifo need a real POSIX box and a non-root user. */
const posixPerms = !(process.platform === 'win32' || (process.getuid && process.getuid() === 0));


/** The rules command, run inside a project dir, with an env we can extend. */
const rulesIn = (proj, dir, args = [], env = {}) => spawnSync(process.execPath, [BIN, 'rules', ...args], {
  cwd: proj, encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
});

test('rules: a pre-existing temporary file is refused, never followed or truncated', { skip: !symlinksWork && 'symlinks need privileges here' }, () => {
  const dir = home();
  const proj = join(dir, 'proj');
  const rulesDir = join(proj, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  const target = join(rulesDir, 'omelette-fleet.md');
  const victim = join(dir, 'victim.txt');
  writeFileSync(victim, 'precious\n');
  // The tmp name carries the CLI's OWN pid, so the trap has to be laid from
  // inside that process: a --require preload runs before the bin's first line.
  const preload = join(dir, 'plant.cjs');
  writeFileSync(preload, `require('fs').symlinkSync(${JSON.stringify(victim)}, ${JSON.stringify(target)} + '.' + process.pid + '.tmp');\n`);
  const r = rulesIn(proj, dir, [], { NODE_OPTIONS: `--require ${preload}` });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^omelette-fleet rules: cannot write .*omelette-fleet\.md: temporary file already exists$/m);
  assert.equal(readFileSync(victim, 'utf8'), 'precious\n', 'the link was not written through');
  assert.equal(existsSync(target), false, 'no rules file was created');
  const left = readdirSync(rulesDir);
  assert.deepEqual(left.filter((f) => !f.endsWith('.tmp')), [], `unexpected files: ${left.join(', ')}`);
  assert.equal(left.length, 1, `the planted link and nothing else, found ${left.join(', ')}`);
  assert.ok(lstatSync(join(rulesDir, left[0])).isSymbolicLink(), 'somebody else\'s tmp file is left exactly as it was');
});

test('rules: a write that fails AFTER the tmp file is open still leaves nothing behind', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  const rulesDir = join(proj, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  // The failure has to happen between the O_EXCL open and the rename — the one
  // window where a tmp file exists AND is ours. A --require preload fails the
  // write for exactly that fd and nothing else.
  const preload = join(dir, 'failwrite.cjs');
  writeFileSync(preload, [
    "const fs = require('fs');",
    'const realOpen = fs.openSync;',
    'const doomed = new Set();',
    "fs.openSync = (p, ...rest) => { const fd = realOpen(p, ...rest); if (String(p).endsWith('.tmp')) doomed.add(fd); return fd; };",
    'const realWrite = fs.writeSync;',
    "fs.writeSync = (fd, ...rest) => { if (doomed.has(fd)) throw new Error('injected write failure'); return realWrite(fd, ...rest); };",
    '',
  ].join('\n'));
  const r = rulesIn(proj, dir, [], { NODE_OPTIONS: `--require ${preload}` });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^omelette-fleet rules: cannot write .*omelette-fleet\.md: injected write failure$/m);
  assert.doesNotMatch(r.stderr, /at .*omelette-fleet\.mjs/); // a refusal, never a stack
  assert.deepEqual(readdirSync(rulesDir), [], `the half-written tmp must be gone: ${readdirSync(rulesDir).join(', ')}`);
});

test('rules --remove: a directory it may not write is one refusal line, and the other files are still processed', { skip: !posixPerms && 'directory permissions are not enforced here' }, () => {
  const dir = home();
  const proj = join(dir, 'proj');
  const rulesDir = join(proj, '.claude', 'rules');
  const agentsDir = join(proj, '.claude', 'agents');
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const rulesPath = join(rulesDir, 'omelette-fleet.md');
  const coderPath = join(agentsDir, 'omelette-coder.md');
  writeFileSync(rulesPath, MARKED_RULES(pkgVersion(ROOT), 'old\n'));
  writeFileSync(coderPath, MARKED_AGENT(pkgVersion(ROOT), 'omelette-coder'));
  chmodSync(rulesDir, 0o500); // readable, listable, NOT writable: unlink will fail
  const r = rulesIn(proj, dir, ['--remove', '--agents']);
  chmodSync(rulesDir, 0o700); // leave the temp tree removable
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^omelette-fleet rules: cannot remove .*omelette-fleet\.md: /m);
  assert.doesNotMatch(r.stderr, /at .*omelette-fleet\.mjs/); // a refusal, never a stack
  assert.ok(existsSync(rulesPath), 'the file it could not remove is still there');
  assert.equal(existsSync(coderPath), false, 'one refusal never skips the remaining files');
  assert.match(r.stdout, /^removed .*omelette-coder\.md/m);
});

test('rules: a symlinked .claude or .claude/rules is refused — no write escapes through it', { skip: !symlinksWork && 'symlinks need privileges here' }, () => {
  const dir = home();
  const proj = join(dir, 'proj');
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(join(proj, '.claude'), { recursive: true });
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(proj, '.claude', 'rules'));
  const r = rulesIn(proj, dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^omelette-fleet rules: refusing .*omelette-fleet\.md: .*[/\\]rules is a symlink$/m);
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing was written through the link');
  // --force replaces a foreign FILE; it never follows a link.
  assert.equal(rulesIn(proj, dir, ['--force']).status, 1);
  assert.deepEqual(readdirSync(elsewhere), []);

  // …and the same one directory up, where .claude itself is the link.
  const proj2 = join(dir, 'proj2');
  const config = join(dir, 'foreign-config');
  mkdirSync(proj2); mkdirSync(config);
  symlinkSync(config, join(proj2, '.claude'));
  const r2 = rulesIn(proj2, dir, ['--agents']);
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.match(r2.stderr, /refusing .*: .*[/\\]\.claude is a symlink/);
  assert.deepEqual(readdirSync(config), []);
});

test('rules: a symlinked target file is refused for write, for --force and for --remove', { skip: !symlinksWork && 'symlinks need privileges here' }, () => {
  const dir = home();
  const proj = join(dir, 'proj');
  const rulesDir = join(proj, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  const target = join(rulesDir, 'omelette-fleet.md');
  const victim = join(dir, 'someone-elses.md');
  writeFileSync(victim, '# not ours\n');
  symlinkSync(victim, target);
  const stillALink = () => {
    assert.ok(lstatSync(target).isSymbolicLink(), 'the link itself is never removed');
    assert.equal(readFileSync(victim, 'utf8'), '# not ours\n', 'the file behind it is never written');
  };
  for (const args of [[], ['--force'], ['--remove'], ['--remove', '--force']]) {
    const r = rulesIn(proj, dir, args);
    assert.equal(r.status, 1, `rules ${args.join(' ')} should refuse: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^omelette-fleet rules: refusing .*omelette-fleet\.md: .*omelette-fleet\.md is a symlink$/m);
    stillALink();
  }
});

test('rules --agents: a symlink anywhere under .claude/skills is refused — the whole path is checked, not just two levels', { skip: !symlinksWork && 'symlinks need privileges here' }, () => {
  const dir = home();
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(elsewhere);
  // The skill sits one directory deeper than every other managed file
  // (.claude/skills/omelette-test/SKILL.md), so its own directory has to be
  // checked too — a link there would carry the write straight out of the project.
  const proj = join(dir, 'proj');
  mkdirSync(join(proj, '.claude', 'skills'), { recursive: true });
  symlinkSync(elsewhere, join(proj, '.claude', 'skills', 'omelette-test'));
  const r = rulesIn(proj, dir, ['--agents']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^omelette-fleet rules: refusing .*SKILL\.md: .*[/\\]omelette-test is a symlink$/m);
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing was written through the link');

  // …and one level up, where .claude/skills itself is the link.
  const proj2 = join(dir, 'proj2');
  mkdirSync(join(proj2, '.claude'), { recursive: true });
  symlinkSync(elsewhere, join(proj2, '.claude', 'skills'));
  const r2 = rulesIn(proj2, dir, ['--agents']);
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.match(r2.stderr, /refusing .*SKILL\.md: .*[/\\]skills is a symlink/);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('rules: --global honours CLAUDE_CONFIG_DIR; --print and --dry-run write nothing', () => {
  const dir = home();
  const cfg = join(dir, 'cfgdir');
  const r1 = cli(['rules', '--global'], { dir, env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r1.code, 0, r1.err);
  assert.ok(existsSync(join(cfg, 'rules', 'omelette-fleet.md')));
  const r2 = cli(['rules', '--global'], { dir });
  assert.ok(existsSync(join(dir, '.claude', 'rules', 'omelette-fleet.md')), 'HOME/.claude/rules without CLAUDE_CONFIG_DIR');
  const proj = join(dir, 'p2'); mkdirSync(proj);
  const p = spawnSync(process.execPath, [BIN, 'rules', '--print'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } });
  assert.equal(p.status, 0); assert.ok(p.stdout.startsWith('<!-- omelette-fleet rules v')); assert.ok(!existsSync(join(proj, '.claude')));
  const d = spawnSync(process.execPath, [BIN, 'rules', '--dry-run'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } });
  assert.equal(d.status, 0); assert.match(d.stdout, /^would write /m); assert.ok(!existsSync(join(proj, '.claude')));
  const bad = cli(['rules', '--print', '--remove'], { dir });
  assert.equal(bad.code, 1);
  const help = cli(['rules', '--help'], { dir });
  assert.match(help.out, /omelette-fleet rules \[--global\]/);
});

test('rules --agents writes both managed agent definitions, refreshes them, and --remove --agents takes them away', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const run = (args) => spawnSync(process.execPath, [BIN, 'rules', ...args], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } });
  const r1 = run(['--agents']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(existsSync(join(proj, '.claude', 'rules', 'omelette-fleet.md')), 'the rules file is written too');
  for (const f of ['omelette-coder.md', 'omelette-tester.md']) assert.ok(existsSync(join(proj, '.claude', 'agents', f)), f);
  assert.match(r1.stdout, /written .*agents\/omelette-coder\.md/);
  const r2 = run(['--agents']);
  assert.match(r2.stdout, /up to date .*omelette-tester\.md/);
  writeFileSync(join(proj, '.claude', 'agents', 'omelette-coder.md'), '---\nname: omelette-coder\n---\nmine\n');
  const r3 = run(['--agents']);
  assert.equal(r3.status, 1, 'a foreign agent file is refused');
  assert.match(r3.stderr, /not managed by omelette-fleet/);
  const r4 = run(['--agents', '--force']);
  assert.equal(r4.status, 0);
  const r5 = run(['--remove', '--agents']);
  assert.equal(r5.status, 0);
  assert.ok(!existsSync(join(proj, '.claude', 'agents', 'omelette-coder.md')));
  assert.ok(!existsSync(join(proj, '.claude', 'rules', 'omelette-fleet.md')), '--remove --agents removes the rules file as well');
});

test('rules --agents renders the configured agent settings, and a later `set` makes it rewrite the file', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const rules = () => spawnSync(process.execPath, [BIN, 'rules', '--agents'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } });
  const testerFile = join(proj, '.claude', 'agents', 'omelette-tester.md');
  const coderFile = join(proj, '.claude', 'agents', 'omelette-coder.md');

  const r1 = rules();
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(readFileSync(testerFile, 'utf8'), /^maxTurns: 80$/m, 'the built-in default with no config');
  assert.match(readFileSync(coderFile, 'utf8'), /^model: opus$/m);

  assert.equal(cli(['set', 'agents.tester.maxTurns=120'], { dir }).code, 0);
  const r2 = rules();
  assert.equal(r2.status, 0, r2.stderr);
  // same version on both sides: it is the CONTENT that changed, so it is rewritten
  assert.match(r2.stdout, /written .*omelette-tester\.md \(v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?), was \1\)/);
  assert.match(r2.stdout, /up to date .*omelette-coder\.md/, 'the coder file is untouched by a tester setting');
  assert.match(readFileSync(testerFile, 'utf8'), /^maxTurns: 120$/m);
  assert.match(rules().stdout, /up to date .*omelette-tester\.md/, 'and it settles again');
  assert.ok(!readFileSync(testerFile, 'utf8').includes('{{'));

  // a second round: the file on disk is the evidence, not the "written" line
  assert.equal(cli(['set', 'agents.tester.maxTurns=97'], { dir }).code, 0);
  assert.equal(rules().status, 0);
  assert.match(readFileSync(testerFile, 'utf8'), /^maxTurns: 97$/m);
  assert.doesNotMatch(readFileSync(testerFile, 'utf8'), /^maxTurns: 120$/m);
});

test('rules --agents warns about an invalid agent setting on stderr and still writes the default', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, agents: { tester: { maxTurns: 'lots' } } }));
  const r = spawnSync(process.execPath, [BIN, 'rules', '--agents'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /agents\.tester\.maxTurns = "lots" is invalid/);
  assert.match(readFileSync(join(proj, '.claude', 'agents', 'omelette-tester.md'), 'utf8'), /^maxTurns: 80$/m);
});

test('rules --agents also writes the /omelette-test skill, refreshes it, and --remove --agents takes it away', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const skill = join(proj, '.claude', 'skills', 'omelette-test', 'SKILL.md');
  const r1 = rulesIn(proj, dir, ['--agents']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(existsSync(skill), 'the skill lands beside the two roles it hands work to');
  assert.match(r1.stdout, /^written .*[/\\]skills[/\\]omelette-test[/\\]SKILL\.md \(v\d+\.\d+\.\d+.*, was absent\)$/m);
  const text = readFileSync(skill, 'utf8');
  assert.equal(text.split('\n')[1], SKILL_MARKER(pkgVersion(ROOT)));
  // What makes the handoff mechanical has to reach the disk untouched.
  assert.ok(text.split('\n').includes('!`git -C "$1" diff HEAD`'), 'the diff injection line survives the write');
  assert.ok(text.includes('agent: omelette-tester'));

  assert.match(rulesIn(proj, dir, ['--agents']).stdout, /^up to date .*SKILL\.md/m);

  writeFileSync(skill, '---\nname: mine\n---\nnot ours\n');
  const r3 = rulesIn(proj, dir, ['--agents']);
  assert.equal(r3.status, 1, 'a foreign skill file is refused like any other kind');
  assert.match(r3.stderr, /SKILL\.md exists and is not managed by omelette-fleet/);
  assert.equal(readFileSync(skill, 'utf8'), '---\nname: mine\n---\nnot ours\n');
  assert.equal(rulesIn(proj, dir, ['--agents', '--force']).status, 0);
  assert.equal(readFileSync(skill, 'utf8').split('\n')[1], SKILL_MARKER(pkgVersion(ROOT)));

  const r5 = rulesIn(proj, dir, ['--remove', '--agents']);
  assert.equal(r5.status, 0, r5.stderr);
  assert.equal(existsSync(skill), false, '--remove --agents takes the skill with it');
  for (const f of ['omelette-coder.md', 'omelette-tester.md']) assert.equal(existsSync(join(proj, '.claude', 'agents', f)), false);
  assert.equal(existsSync(join(proj, '.claude', 'rules', 'omelette-fleet.md')), false);
});

test('rules --remove --agents takes the empty skill directory with it — but never one that still holds somebody else\'s file', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const skillDir = join(proj, '.claude', 'skills', 'omelette-test');
  const skill = join(skillDir, 'SKILL.md');

  // A skill is a DIRECTORY with a SKILL.md in it, so removing the file alone
  // leaves an empty directory Claude Code still lists as a skill.
  assert.equal(rulesIn(proj, dir, ['--agents']).status, 0);
  const removed = rulesIn(proj, dir, ['--remove', '--agents']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(existsSync(skill), false);
  assert.equal(existsSync(skillDir), false, 'the empty skill directory goes with the file');
  assert.ok(existsSync(join(proj, '.claude', 'skills')), 'and nothing above it is touched');

  // Anything else in there and the directory is the operator's, not ours.
  assert.equal(rulesIn(proj, dir, ['--agents']).status, 0);
  writeFileSync(join(skillDir, 'notes.md'), 'mine\n');
  const kept = rulesIn(proj, dir, ['--remove', '--agents']);
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(existsSync(skill), false, 'our file is still removed');
  assert.ok(existsSync(skillDir), 'a directory holding somebody else\'s file stays');
  assert.equal(readFileSync(join(skillDir, 'notes.md'), 'utf8'), 'mine\n');

  // An empty skill directory that never held a SKILL.md of ours is not ours to
  // remove: the run has nothing to remove, so it removes nothing at all.
  rmSync(join(skillDir, 'notes.md'));
  const nothing = rulesIn(proj, dir, ['--remove', '--agents']);
  assert.equal(nothing.status, 0, nothing.stderr);
  assert.match(nothing.stdout, /nothing to remove .*SKILL\.md/);
  assert.ok(existsSync(skillDir), 'a directory whose SKILL.md was already gone stays');

  // A foreign SKILL.md is refused, and a refused file is never an empty directory.
  writeFileSync(skill, '---\nname: mine\n---\nnot ours\n');
  const foreign = rulesIn(proj, dir, ['--remove', '--agents']);
  assert.equal(foreign.status, 1, foreign.stdout);
  assert.match(foreign.stderr, /SKILL\.md exists but is not managed by omelette-fleet/);
  assert.ok(existsSync(skillDir), 'the directory of a refused skill stays');
  assert.equal(readFileSync(skill, 'utf8'), '---\nname: mine\n---\nnot ours\n');
});

test('rules --dry-run --remove --agents removes neither the skill nor its directory', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const skillDir = join(proj, '.claude', 'skills', 'omelette-test');
  assert.equal(rulesIn(proj, dir, ['--agents']).status, 0);
  const d = rulesIn(proj, dir, ['--dry-run', '--remove', '--agents']);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /^would remove .*SKILL\.md/m);
  assert.ok(existsSync(join(skillDir, 'SKILL.md')), '--dry-run removes nothing');
  assert.ok(existsSync(skillDir));
});

test('rules --print --agents prints the skill too, with its own separator, and writes nothing', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const r = rulesIn(proj, dir, ['--print', '--agents']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\n===== omelette-test\/SKILL\.md =====\n\n---\n# omelette-fleet skill v/);
  assert.ok(r.stdout.includes('!`git -C "$1" diff HEAD`'), 'the injection line is printed verbatim');
  // …after the two agent definitions: the skill is the last thing --agents ships.
  assert.ok(r.stdout.indexOf('===== omelette-test/SKILL.md =====') > r.stdout.indexOf('===== omelette-tester.md ====='));
  assert.equal(existsSync(join(proj, '.claude')), false, '--print must touch nothing on disk');
});

/**
 * The settings.json snippet `rules --hooks` prints, exactly as the design fixes
 * it — with the script path absolute and shell-quoted, because the value is a
 * command line and an operator's path may contain spaces.
 */
const SNIPPET = (script) => [
  '{ "hooks": {',
  `  "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node '${script}'" } ] } ],`,
  `  "PreCompact": [ { "hooks": [ { "type": "command", "command": "node '${script}'" } ] } ],`,
  `  "SessionStart": [ { "matcher": "compact", "hooks": [ { "type": "command", "command": "node '${script}'" } ] } ],`,
  `  "PostToolUse": [ { "hooks": [ { "type": "command", "command": "node '${script}'" } ] } ],`,
  `  "Stop": [ { "hooks": [ { "type": "command", "command": "node '${script}'" } ] } ],`,
  `  "PostCompact": [ { "hooks": [ { "type": "command", "command": "node '${script}'" } ] } ] } }`,
].join('\n');

/** The pasteable snippet out of a `rules --hooks` run's stdout: the opener line plus one per event. */
const snippetFrom = (stdout) => {
  const lines = stdout.split('\n');
  const at = lines.indexOf('{ "hooks": {');
  assert.ok(at >= 0, `no snippet in:\n${stdout}`);
  return lines.slice(at, at + HOOK_EVENTS.length + 1).join('\n');
};

test('rules --hooks writes the guard, prints the settings snippet, is idempotent, and --remove --hooks takes it away', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const guard = join(proj, '.claude', 'hooks', 'omelette-guard.mjs');
  const r1 = rulesIn(proj, dir, ['--hooks']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(existsSync(guard));
  assert.match(r1.stdout, /^written .*[/\\]hooks[/\\]omelette-guard\.mjs \(v\d+\.\d+\.\d+.*, was absent\)$/m);
  assert.equal(readFileSync(guard, 'utf8').split('\n')[0], HOOK_MARKER(pkgVersion(ROOT)));
  // The snippet names the script that was actually written, absolutely, and is
  // pasteable JSON — this CLI never edits settings.json itself. The path is the
  // one the CLI resolved: on macOS a temp dir reaches it as /private/var/…
  const wired = join(realpathSync(proj), '.claude', 'hooks', 'omelette-guard.mjs');
  assert.ok(r1.stdout.includes(SNIPPET(wired)), `no snippet for ${wired} in:\n${r1.stdout}`);
  assert.doesNotMatch(r1.stdout, /written .*omelette-coder\.md/, '--hooks does not drag the agent definitions in');
  // The snippet is a WHOLE `hooks` object, and an operator who already keeps
  // hooks in that file has to merge rather than paste over it — so the
  // paragraph above it says so instead of saying "Paste:".
  assert.match(r1.stdout, /never writes that file\. Merge this into your settings file \(it is a whole hooks object — add the events it lists to an existing hooks block rather than replacing the file\):$/m, r1.stdout);

  // Running it again still prints the snippet: doctor's "paste the snippet from
  // rules --hooks" has to lead somewhere even when the file is already current.
  const r2 = rulesIn(proj, dir, ['--hooks']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /^up to date .*omelette-guard\.mjs/m);
  assert.ok(r2.stdout.includes(SNIPPET(wired)));

  // A run whose only write is the guard says nothing about session starts and
  // directory watches: a hook script is called by settings.json the moment it
  // is on disk, and the post-write line is about the kinds that are not.
  rmSync(guard);
  const r2b = rulesIn(proj, dir, ['--hooks']);
  assert.equal(r2b.status, 0, r2b.stderr);
  assert.match(r2b.stdout, /^written .*omelette-guard\.mjs/m);
  assert.match(r2b.stdout, /^up to date .*omelette-fleet\.md/m);
  assert.doesNotMatch(r2b.stdout, /Rules load on the next session start/, r2b.stdout);

  writeFileSync(guard, '// my own hook\n');
  const r3 = rulesIn(proj, dir, ['--hooks']);
  assert.equal(r3.status, 1, 'a foreign hook script is refused');
  assert.match(r3.stderr, /omelette-guard\.mjs exists and is not managed by omelette-fleet/);
  assert.equal(readFileSync(guard, 'utf8'), '// my own hook\n');
  assert.equal(rulesIn(proj, dir, ['--hooks', '--force']).status, 0);

  const r5 = rulesIn(proj, dir, ['--remove', '--hooks']);
  assert.equal(r5.status, 0, r5.stderr);
  assert.equal(existsSync(guard), false);
  assert.doesNotMatch(r5.stdout, /"PreToolUse"/, '--remove has no snippet to offer');
});

test('the snippet is absolute and shell-quoted: a path with spaces, and a RELATIVE CLAUDE_CONFIG_DIR', () => {
  const dir = home();
  // A hook command is a command LINE. An unquoted path with a space in it pastes
  // a hook that runs `node /…/My` and fails at every tool call.
  const proj = join(dir, 'My Projects', 'the app');
  mkdirSync(proj, { recursive: true });
  const spaced = rulesIn(proj, dir, ['--hooks']);
  assert.equal(spaced.status, 0, spaced.stderr);
  const guard = join(realpathSync(proj), '.claude', 'hooks', 'omelette-guard.mjs');
  assert.ok(guard.includes(' '), 'the fixture path must actually contain a space');
  assert.ok(spaced.stdout.includes(SNIPPET(guard)), `no quoted snippet for ${guard} in:\n${spaced.stdout}`);
  // …and what it printed is still JSON, and is still recognised as wired.
  const snippet = JSON.parse(snippetFrom(spaced.stdout));
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify(snippet, null, 2));
  const doc = spawnSync(process.execPath, [BIN, 'doctor'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } }).stdout;
  assert.match(doc, /^hooks {9}project: v\d+\.\d+\.\d+\S* \(wired: PreToolUse, PreCompact, SessionStart, PostToolUse, Stop, PostCompact\)/m, doc);

  // A relative CLAUDE_CONFIG_DIR still has to yield an absolute hook command: a
  // hook runs from wherever the session is, not from where this command ran.
  const proj2 = join(dir, 'proj2'); mkdirSync(proj2);
  const rel = rulesIn(proj2, dir, ['--global', '--hooks'], { CLAUDE_CONFIG_DIR: 'cfgrel' });
  assert.equal(rel.status, 0, rel.stderr);
  assert.ok(existsSync(join(proj2, 'cfgrel', 'hooks', 'omelette-guard.mjs')));
  assert.ok(rel.stdout.includes(SNIPPET(join(realpathSync(proj2), 'cfgrel', 'hooks', 'omelette-guard.mjs'))), rel.stdout);
  assert.doesNotMatch(rel.stdout, /"command": "node 'cfgrel/, 'a relative path in a hook command is a hook that never runs');
});

test('doctor sees the guard wired in settings.local.json too, and names a settings file it could not read', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const doctor = () => spawnSync(process.execPath, [BIN, 'doctor'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } }).stdout;
  const written = rulesIn(proj, dir, ['--hooks']);
  assert.equal(written.status, 0, written.stderr);
  const snippet = JSON.parse(snippetFrom(written.stdout));

  // settings.local.json is where a machine's own settings go — and where a
  // project that gitignores it keeps this wiring. It counts.
  const local = join(proj, '.claude', 'settings.local.json');
  writeFileSync(local, JSON.stringify(snippet, null, 2));
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(wired: PreToolUse, PreCompact, SessionStart, PostToolUse, Stop, PostCompact\) · global: absent$/m);

  // A broken settings.json beside a working local one does not un-wire it.
  writeFileSync(join(proj, '.claude', 'settings.json'), '{ not json');
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(wired: PreToolUse, PreCompact, SessionStart, PostToolUse, Stop, PostCompact\)/m);

  // With nothing wired anywhere, both unreadable files are named — "not wired"
  // about a file nobody could parse would send the operator to re-paste it.
  writeFileSync(local, '[]');
  const both = doctor();
  assert.match(both, /^hooks {9}project: v\d+\.\d+\.\d+\S* \(NOT wired \(settings\.json and settings\.local\.json unreadable\) — paste the snippet from rules --hooks\)/m, both);
  assert.equal(readFileSync(local, 'utf8'), '[]', 'settings.local.json is READ, never written');
});

test('rules --agents leaves the hook alone, and rules --hooks leaves the agent files alone', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  assert.equal(rulesIn(proj, dir, ['--agents']).status, 0);
  assert.equal(existsSync(join(proj, '.claude', 'hooks')), false);
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  assert.ok(existsSync(join(proj, '.claude', 'hooks', 'omelette-guard.mjs')));
  const r = rulesIn(proj, dir, ['--remove', '--hooks']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(proj, '.claude', 'agents', 'omelette-coder.md')), '--remove --hooks never touches an agent file');
  assert.ok(existsSync(join(proj, '.claude', 'skills', 'omelette-test', 'SKILL.md')));
});

test('rules --dry-run --hooks and --print --hooks write nothing at all', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const d = rulesIn(proj, dir, ['--dry-run', '--hooks']);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /^would write .*omelette-guard\.mjs \(v\d+\.\d+\.\d+.*, was absent\)$/m);
  // A snippet naming a script that was never written is a snippet somebody
  // pastes — --dry-run says it would print one instead of printing it.
  assert.match(d.stdout, /^would print the settings snippet after writing$/m);
  assert.doesNotMatch(d.stdout, /"PreToolUse"/, 'no pasteable snippet from a run that wrote nothing');
  assert.equal(existsSync(join(proj, '.claude')), false, '--dry-run must touch nothing on disk');

  const p = rulesIn(proj, dir, ['--print', '--hooks']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /\n===== omelette-guard\.mjs =====\n\n\/\/ omelette-fleet hook v/);
  assert.equal(existsSync(join(proj, '.claude')), false, '--print must touch nothing on disk');
});

test('doctor reports the guard hook and whether settings.json wires it — reading that file, never writing it', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const settings = join(proj, '.claude', 'settings.json');
  const guard = join(proj, '.claude', 'hooks', 'omelette-guard.mjs');
  const doctor = () => spawnSync(process.execPath, [BIN, 'doctor'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } }).stdout;
  assert.match(doctor(), /^hooks {9}project: absent · global: absent$/m);

  // The script alone does nothing: a hook only runs once settings.json calls it.
  const written = rulesIn(proj, dir, ['--hooks']);
  assert.equal(written.status, 0, written.stderr);
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(NOT wired — paste the snippet from rules --hooks\) · global: absent$/m);

  // The snippet the CLI printed, parsed back: what it offers has to be the very
  // thing the wiring check then accepts.
  const snippet = JSON.parse(snippetFrom(written.stdout));

  // Half-wired is not wired, and somebody else's PreCompact hook is not ours —
  // and doctor names WHICH event nobody calls, since that is what the operator
  // has to paste.
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: snippet.hooks.PreToolUse } }, null, 2));
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(NOT wired \(missing PreCompact, SessionStart, PostToolUse, Stop, PostCompact\) — paste the snippet from rules --hooks\)/m, doctor());
  writeFileSync(settings, JSON.stringify({ hooks: { ...snippet.hooks, PreCompact: [{ hooks: [{ type: 'command', command: 'node /elsewhere/other-hook.mjs' }] }] } }, null, 2));
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(NOT wired \(missing PreCompact\) — paste the snippet from rules --hooks\)/m, doctor());

  // A PreToolUse entry that calls the guard from a matcher other than Bash
  // never sees a Bash call at all: the script is there, the event is listed,
  // and the guard is off. That is worth naming rather than counting as wired.
  const withMatcher = (matcher) => JSON.stringify({
    hooks: { ...snippet.hooks, PreToolUse: [{ ...snippet.hooks.PreToolUse[0], matcher }] },
  }, null, 2);
  writeFileSync(settings, withMatcher('Read'));
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(NOT wired \(PreToolUse matcher is not Bash\) — paste the snippet from rules --hooks\)/m, doctor());
  // `*` and an absent matcher cover Bash as surely as "Bash" does.
  writeFileSync(settings, withMatcher('*'));
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(wired: PreToolUse, PreCompact, SessionStart, PostToolUse, Stop, PostCompact\)/m);
  writeFileSync(settings, JSON.stringify({
    hooks: { ...snippet.hooks, PreToolUse: [{ hooks: snippet.hooks.PreToolUse[0].hooks }] },
  }, null, 2));
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(wired: PreToolUse, PreCompact, SessionStart, PostToolUse, Stop, PostCompact\)/m);

  const pasted = JSON.stringify(snippet, null, 2);
  writeFileSync(settings, pasted);
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(wired: PreToolUse, PreCompact, SessionStart, PostToolUse, Stop, PostCompact\) · global: absent$/m);
  assert.equal(readFileSync(settings, 'utf8'), pasted, 'settings.json is READ, never written');

  // A stale guard beside a working wiring still asks to be refreshed…
  writeFileSync(guard, MARKED_HOOK('0.0.1'));
  assert.match(doctor(), /^hooks {9}project: v0\.0\.1 \(wired: PreToolUse, PreCompact, SessionStart, PostToolUse, Stop, PostCompact\) \[run: omelette-fleet rules --hooks\]/m);
  // …and a script that is not ours is reported, never claimed.
  writeFileSync(guard, '// my own hook\n');
  assert.match(doctor(), /^hooks {9}project: foreign \(no marker\) · global: absent$/m);
  // A settings.json that is not JSON at all is a report line, never a crash.
  writeFileSync(settings, '{ not json');
  writeFileSync(guard, MARKED_HOOK(pkgVersion(ROOT)));
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(NOT wired \(settings\.json unreadable\) — paste the snippet from rules --hooks\)/m);
  assert.equal(readFileSync(settings, 'utf8'), '{ not json');
});

test('doctor: a PreToolUse matcher is a REGEX — "Bash|Edit" and ".*" wire the guard, "Edit" and a broken pattern do not', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const settings = join(proj, '.claude', 'settings.json');
  const doctor = () => spawnSync(process.execPath, [BIN, 'doctor'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } }).stdout;
  const written = rulesIn(proj, dir, ['--hooks']);
  assert.equal(written.status, 0, written.stderr);
  const snippet = JSON.parse(snippetFrom(written.stdout));
  const withMatcher = (matcher) => JSON.stringify({
    hooks: { ...snippet.hooks, PreToolUse: [{ ...snippet.hooks.PreToolUse[0], matcher }] },
  }, null, 2);

  // Claude Code's hooks docs spell a matcher as a regex — "Edit|Write", "mcp__.*"
  // — so a guard wired under "Bash|Edit" DOES fire on every Bash call.
  // A matcher of nothing but names, separators and spaces is an exact LIST, as
  // Claude Code reads it; anything else is a regex, tested UNANCHORED — which
  // is what makes "Ba.", "^Ba" and "ash$" cover a Bash call.
  for (const matcher of ['Bash|Edit', 'Edit|Bash', 'Bash, Write', '.*', 'Bash.*', '(Bash|Task)', 'Ba(sh)', 'Ba.', '^Ba', 'ash$']) {
    writeFileSync(settings, withMatcher(matcher));
    assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(wired: PreToolUse, PreCompact, SessionStart, PostToolUse, Stop, PostCompact\)/m, `matcher ${matcher} covers Bash`);
  }
  // …and one that cannot match "Bash" is still named rather than counted. In an
  // exact list a name is a whole name: "Bas" and "ash" are items of their own,
  // not fragments of "Bash" the way an unanchored regex would read them.
  for (const matcher of ['Edit', 'Edit|Write', 'Bas', 'Bashful', 'ash']) {
    writeFileSync(settings, withMatcher(matcher));
    assert.match(
      doctor(),
      /^hooks {9}project: v\d+\.\d+\.\d+\S* \(NOT wired \(PreToolUse matcher is not Bash\) — paste the snippet from rules --hooks\)/m,
      `matcher ${matcher} does not cover Bash`,
    );
  }
  // A pattern that does not COMPILE covers nothing either, but it is a
  // different mistake from pointing the guard at another tool and gets its own
  // line: an operator reading "matcher is not Bash" about `(` would go looking
  // for the wrong thing entirely.
  for (const matcher of ['(', 'Bash[', '*Bash', ')|(']) {
    writeFileSync(settings, withMatcher(matcher));
    assert.ok(
      doctor().includes(`(NOT wired (PreToolUse matcher ${JSON.stringify(matcher)} is not a valid regex) — paste the snippet from rules --hooks)`),
      `matcher ${matcher} does not compile:\n${doctor()}`,
    );
  }
  // A matcher that is not a string at all is neither of those mistakes: there
  // is nothing to compile and nothing to compare, and JSON makes it easy to
  // write one by accident. An explicit `null` is one of them — the key IS there
  // and holds something that is not a pattern, which is a different state from
  // leaving the key out, the documented "every tool" form.
  for (const matcher of [42, true, null, ['Bash'], { name: 'Bash' }]) {
    writeFileSync(settings, withMatcher(matcher));
    assert.ok(
      doctor().includes('(NOT wired (PreToolUse matcher is not a string) — paste the snippet from rules --hooks)'),
      `matcher ${JSON.stringify(matcher)} is not a string:\n${doctor()}`,
    );
  }
});

test('doctor: a guard wired at 0.3.2 — PreToolUse and PreCompact only — is NOT wired, and the missing event is named', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const settings = join(proj, '.claude', 'settings.json');
  const doctor = () => spawnSync(process.execPath, [BIN, 'doctor'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } }).stdout;
  const written = rulesIn(proj, dir, ['--hooks']);
  assert.equal(written.status, 0, written.stderr);
  const snippet = JSON.parse(snippetFrom(written.stdout));

  const { PreToolUse, PreCompact } = snippet.hooks;
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse, PreCompact } }, null, 2));
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(NOT wired \(missing SessionStart, PostToolUse, Stop, PostCompact\) — paste the snippet from rules --hooks\)/m, doctor());

  // The third group is what finishes it — and the label lists all three.
  writeFileSync(settings, JSON.stringify(snippet, null, 2));
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(wired: PreToolUse, PreCompact, SessionStart, PostToolUse, Stop, PostCompact\) · global: absent$/m, doctor());
});

test('doctor: a SessionStart matcher is read like any other — `compact` wires the handoff print, `startup` does not', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const settings = join(proj, '.claude', 'settings.json');
  const doctor = () => spawnSync(process.execPath, [BIN, 'doctor'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } }).stdout;
  const written = rulesIn(proj, dir, ['--hooks']);
  assert.equal(written.status, 0, written.stderr);
  const snippet = JSON.parse(snippetFrom(written.stdout));
  const withMatcher = (matcher) => JSON.stringify({
    hooks: { ...snippet.hooks, SessionStart: [{ ...snippet.hooks.SessionStart[0], matcher }] },
  }, null, 2);

  // The same list-or-regex rule the Bash matcher gets, tested against the
  // SOURCE this hook exists for: a list of names compared whole, anything else
  // an unanchored regex, and `""` / `"*"` everything.
  for (const matcher of ['compact', 'startup|compact', 'compact, resume', '*', '', '.*', 'com.', '^comp', 'act$']) {
    writeFileSync(settings, withMatcher(matcher));
    assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(wired: PreToolUse, PreCompact, SessionStart, PostToolUse, Stop, PostCompact\)/m, `matcher ${JSON.stringify(matcher)} covers compact`);
  }
  // An ABSENT matcher fires on every source, which is wired: the guard's own
  // `source === 'compact'` check is what keeps a startup silent.
  writeFileSync(settings, JSON.stringify({
    hooks: { ...snippet.hooks, SessionStart: [{ hooks: snippet.hooks.SessionStart[0].hooks }] },
  }, null, 2));
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(wired: PreToolUse, PreCompact, SessionStart, PostToolUse, Stop, PostCompact\)/m, doctor());

  for (const matcher of ['startup', 'resume|clear', 'compac', 'compaction']) {
    writeFileSync(settings, withMatcher(matcher));
    assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(NOT wired \(SessionStart matcher is not compact\) — paste the snippet from rules --hooks\)/m, `matcher ${matcher} does not cover compact`);
  }
  writeFileSync(settings, withMatcher('('));
  assert.ok(doctor().includes('(NOT wired (SessionStart matcher "(" is not a valid regex) — paste the snippet from rules --hooks)'), doctor());
  writeFileSync(settings, withMatcher(null));
  assert.ok(doctor().includes('(NOT wired (SessionStart matcher is not a string) — paste the snippet from rules --hooks)'), doctor());
});

test('doctor: a 0.3.6 settings.json (the five events that existed then) reports "missing PostCompact"', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const doctor = () => spawnSync(process.execPath, [BIN, 'doctor'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } }).stdout;
  const written = rulesIn(proj, dir, ['--hooks']);
  assert.equal(written.status, 0, written.stderr);
  const snippet = JSON.parse(snippetFrom(written.stdout));

  // An operator who pasted the snippet at 0.3.6 and has not re-pasted it since
  // has exactly this: five groups, and the sixth event nobody calls. The event
  // that is missing is NAMED, because that is what has to be pasted.
  const { PostCompact, ...before } = snippet.hooks;
  assert.ok(PostCompact, 'sanity: the 0.3.7 snippet carries the group this test removes');
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: before }, null, 2));
  assert.match(
    doctor(),
    /^hooks {9}project: v\d+\.\d+\.\d+\S* \(NOT wired \(missing PostCompact\) — paste the snippet from rules --hooks\)/m,
    doctor(),
  );

  // Pasting the whole snippet closes it.
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify(snippet, null, 2));
  assert.match(doctor(), /^hooks {9}project: v\d+\.\d+\.\d+\S* \(wired: PreToolUse, PreCompact, SessionStart, PostToolUse, Stop, PostCompact\)/m, doctor());
});

test('doctor reports the skill on its own line: absent, ours with a count, foreign', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  const skillDir = join(proj, '.claude', 'skills', 'omelette-test');
  mkdirSync(skillDir, { recursive: true });
  const skill = join(skillDir, 'SKILL.md');
  const run = () => spawnSync(process.execPath, [BIN, 'doctor'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } }).stdout;
  assert.match(run(), /^skills {8}project: absent · global: absent$/m);
  writeFileSync(skill, MARKED_SKILL('0.0.1'));
  assert.match(run(), /^skills {8}project: v0\.0\.1 \(1\) \[run: omelette-fleet rules --agents\] · global: absent$/m);
  writeFileSync(skill, MARKED_SKILL(pkgVersion(ROOT)));
  assert.match(run(), /^skills {8}project: v\d+\.\d+\.\d+.* \(1\) · global: absent$/m, 'a current skill gets no refresh hint');
  writeFileSync(skill, '---\nname: mine\n---\n');
  assert.match(run(), /^skills {8}project: foreign \(no marker\) · global: absent$/m);
});

test('doctor reports the rules files: absent, ours with version, foreign', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(join(proj, '.claude', 'rules'), { recursive: true });
  const run = () => spawnSync(process.execPath, [BIN, 'doctor'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } }).stdout;
  assert.match(run(), /^rules {9}project: absent · global: absent/m);
  writeFileSync(join(proj, '.claude', 'rules', 'omelette-fleet.md'), MARKED_RULES('0.0.1'));
  assert.match(run(), /^rules {9}project: v0\.0\.1 \[run: omelette-fleet rules\] · global: absent/m);
  writeFileSync(join(proj, '.claude', 'rules', 'omelette-fleet.md'), '# mine\n');
  assert.match(run(), /^rules {9}project: foreign \(no marker\) · global: absent/m);
});

test('doctor prints ONE next step — install, then the project files, then the wiring — and it is never a fault', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const gone = join(dir, 'no-such-cli');
  // Every unit disabled and no vendor binary anywhere: the units cannot be a
  // fault, so the exit code and the FAULT lines are only ever about `next`.
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({
    version: 1, units: { gemini: { enabled: false }, grok: { enabled: false }, codex: { enabled: false } },
  }));
  const doctor = () => cliIn(proj, dir, ['doctor'], { AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone });
  const nextLines = (out) => out.split('\n').filter((l) => l.startsWith('next'));

  // Nothing registered anywhere: the first thing to do is register the servers.
  const fresh = doctor();
  assert.equal(fresh.code, 0, fresh.out);
  assert.deepEqual(nextLines(fresh.out), ['next          omelette-fleet install']);

  // A registration that is not THIS clone's is not a registration of ours: the
  // step to take is still `install`, which would point it here.
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-codex': { command: 'node', args: [join(dir, 'other-clone', 'servers', 'codex.mjs')] } },
  }));
  const elsewhere = doctor();
  assert.equal(elsewhere.code, 0, elsewhere.out);
  assert.deepEqual(nextLines(elsewhere.out), ['next          omelette-fleet install']);

  // Registered here, but this project has none of the managed files.
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-codex': { command: 'node', args: [join(ROOT, 'servers', 'codex.mjs')] } },
  }));
  const unruled = doctor();
  assert.equal(unruled.code, 0, unruled.out);
  assert.deepEqual(nextLines(unruled.out), ['next          omelette-fleet rules --agents --hooks']);

  // A bare `rules` run leaves the agents, the skill and the guard behind — the
  // same command finishes the job, so the same line is the one to print.
  assert.equal(rulesIn(proj, dir, []).status, 0);
  const partly = doctor();
  assert.equal(partly.code, 0, partly.out);
  assert.deepEqual(nextLines(partly.out), ['next          omelette-fleet rules --agents --hooks']);

  // The files are there and the guard script is inert until settings.json calls it.
  const written = rulesIn(proj, dir, ['--agents', '--hooks']);
  assert.equal(written.status, 0, written.stderr);
  const unwired = doctor();
  assert.equal(unwired.code, 0, unwired.out);
  assert.deepEqual(nextLines(unwired.out), ['next          merge the hooks snippet into .claude/settings.json (rules --hooks prints it)']);

  // A settings file wired the 0.3.2 way — PreToolUse and PreCompact only — is
  // still a step to take: the group that prints the handoff is not there.
  const { PreToolUse, PreCompact } = JSON.parse(snippetFrom(written.stdout)).hooks;
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse, PreCompact } }, null, 2));
  const halfWired = doctor();
  assert.equal(halfWired.code, 0, halfWired.out);
  assert.deepEqual(nextLines(halfWired.out), ['next          merge the hooks snippet into .claude/settings.json (rules --hooks prints it)']);

  // Wired: nothing is missing, so doctor says nothing about what to do next.
  const snippet = snippetFrom(written.stdout);
  writeFileSync(join(proj, '.claude', 'settings.json'), snippet);
  const done = doctor();
  assert.equal(done.code, 0, done.out);
  assert.deepEqual(nextLines(done.out), []);
  for (const r of [fresh, unruled, unwired, done]) {
    assert.doesNotMatch(r.out, /FAULT/, 'a missing next step is never a fault');
    assert.match(r.out, /No faults in units that are both enabled and registered\./);
  }
});

test('doctor: the next step carries the prefix it was asked about, and a FOREIGN managed file gets a step of its own', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const gone = join(dir, 'no-such-cli');
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({
    version: 1, units: { gemini: { enabled: false }, grok: { enabled: false }, codex: { enabled: false } },
  }));
  const doctor = (args = []) => cliIn(proj, dir, ['doctor', ...args], { AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone });
  const nextLines = (out) => out.split('\n').filter((l) => l.startsWith('next'));

  // A non-default prefix is what doctor LOOKED for, so it has to be what the
  // install line it prints would register — `omelette-fleet install` alone
  // would register `omelette-*` and leave `review-*` exactly as missing.
  assert.deepEqual(nextLines(doctor(['--prefix', 'review']).out), ['next          omelette-fleet install --prefix review']);
  assert.deepEqual(nextLines(doctor().out), ['next          omelette-fleet install'], 'the default prefix is not spelled out');

  // Registered here, and a rules file at that path that is NOT ours: `rules
  // --agents --hooks` would refuse it, so suggesting it sends the operator into
  // a refusal. Name the situation and the flag that resolves it instead.
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-codex': { command: 'node', args: [join(ROOT, 'servers', 'codex.mjs')] } },
  }));
  mkdirSync(join(proj, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'rules', 'omelette-fleet.md'), '# somebody else wrote this\n');
  const foreign = doctor();
  assert.equal(foreign.code, 0, foreign.out);
  assert.match(foreign.out, /^rules {9}project: foreign \(no marker\)/m, 'sanity: the file really reads as foreign');
  assert.deepEqual(nextLines(foreign.out), [
    'next          a managed file has no omelette-fleet marker (see the rules/agents/skills/hooks lines) — inspect it, then `omelette-fleet rules --agents --hooks --force` replaces it',
  ]);

  // A SYMLINK at a managed path is a third state again: `rules` refuses to
  // write through one at all — before the marker is even read, and `--force`
  // refuses it too — so the step is to remove the link, not to force past it.
  if (symlinksWork) {
    const rules = join(proj, '.claude', 'rules', 'omelette-fleet.md');
    rmSync(rules);
    symlinkSync(join(dir, 'elsewhere.md'), rules);
    writeFileSync(join(dir, 'elsewhere.md'), '# somewhere else entirely\n');
    const linked = doctor();
    assert.equal(linked.code, 0, linked.out);
    assert.deepEqual(nextLines(linked.out), [
      `next          ${realpathSync(proj)}/.claude/rules/omelette-fleet.md is a symlink — omelette-fleet refuses to manage it; remove the link, then rules --agents --hooks`,
    ]);
  }
});

test('a PRERELEASE marker next to the same release reads as behind, in doctor and in update --check', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  mkdirSync(join(proj, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(proj, '.claude', 'agents'), { recursive: true });
  const installed = pkgVersion(ROOT);
  const rules = (v) => MARKED_RULES(v, 'old\n');
  const agent = (v) => MARKED_AGENT(v, 'omelette-coder');
  const rulesPath = join(proj, '.claude', 'rules', 'omelette-fleet.md');
  // compareSemver ignores the prerelease tail, so 0.3.0-rc.1 and 0.3.0 compare
  // EQUAL: only "the marker is not this install's string" catches it.
  writeFileSync(rulesPath, rules(`${installed}-rc.1`));
  for (const f of ['omelette-coder.md', 'omelette-tester.md']) writeFileSync(join(proj, '.claude', 'agents', f), agent(`${installed}-rc.1`));
  const d = spawnSync(process.execPath, [BIN, 'doctor'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } });
  assert.ok(d.stdout.includes(`project: v${installed}-rc.1 [run: omelette-fleet rules]`), d.stdout);
  assert.match(d.stdout, /^agents {8}project: v.*-rc\.1 \(2\) \[run: omelette-fleet rules --agents\]/m);

  // …and the same file under an npm-kind install of exactly that release is hinted, not rewritten.
  const pkgRoot = mkdtempSync(join(tmpdir(), 'omelette-npm-pre-'));
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'omelette-fleet', version: '0.9.0' }, null, 2));
  writeFileSync(rulesPath, rules('0.9.0-rc.1'));
  const u = spawnSync(process.execPath, [BIN, 'update', '--check'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', OMELETTE_PKG_ROOT: pkgRoot } });
  assert.equal(u.status, 0, u.stderr);
  assert.match(u.stdout, /rules file .*omelette-fleet\.md is v0\.9\.0-rc\.1 \(this install is v0\.9\.0\) — refresh: omelette-fleet rules/);
  assert.equal(readFileSync(rulesPath, 'utf8'), rules('0.9.0-rc.1'), 'a hint is never a rewrite');
});

test('update --check: a scope with one FOREIGN agent file gets no refresh hint, and one path in both scopes is hinted once', () => {
  const dir = home();
  // HOME is the project too, so <cwd>/.claude and ~/.claude are the SAME path:
  // two scopes, one file, and the hint must not be printed twice.
  const rulesPath = join(dir, '.claude', 'rules', 'omelette-fleet.md');
  mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(rulesPath, MARKED_RULES('0.0.1', 'old\n'));
  // A mixed scope: one file of ours (stale) next to one that is not ours at all.
  // A refresh hint here would send the operator at a command that then refuses.
  writeFileSync(join(dir, '.claude', 'agents', 'omelette-coder.md'), '---\nname: mine\n---\n');
  writeFileSync(join(dir, '.claude', 'agents', 'omelette-tester.md'), MARKED_AGENT('0.0.1', 'omelette-tester'));
  const pkgRoot = mkdtempSync(join(tmpdir(), 'omelette-npm-hints-'));
  writePkg(pkgRoot, '0.2.0');
  const r = cli(['update', '--check'], { dir, env: { OMELETTE_PKG_ROOT: pkgRoot } });
  assert.equal(r.code, 0, r.err);
  const hints = r.out.split('\n').filter((l) => /^rules file /.test(l));
  assert.equal(hints.length, 1, `one file, one hint — got:\n${hints.join('\n')}`);
  assert.doesNotMatch(hints[0], /--global/, 'the project scope names the plain command');
  assert.doesNotMatch(r.out, /agent files under /, 'a scope that is partly foreign is not hinted for refresh');
});

test('update --check mentions a rules file whose marker is behind, and never rewrites it', { skip: !gitAvailable && 'git is not installed' }, () => {
  const fx = gitFixture();
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(join(proj, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(proj, '.claude', 'agents'), { recursive: true });
  const rulesPath = join(proj, '.claude', 'rules', 'omelette-fleet.md');
  writeFileSync(rulesPath, MARKED_RULES('0.0.1', 'old\n'));
  const agentText = (v) => MARKED_AGENT(v, 'omelette-coder');
  const agentPaths = ['omelette-coder.md', 'omelette-tester.md'].map((f) => join(proj, '.claude', 'agents', f));
  for (const p of agentPaths) writeFileSync(p, agentText('0.0.1'));
  const r = spawnSync(process.execPath, [BIN, 'update', '--check'], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', OMELETTE_PKG_ROOT: fx.clone } });
  assert.match(r.stdout, /rules file .*omelette-fleet\.md is v0\.0\.1 \(this install is v0\.1\.0\) — refresh: omelette-fleet rules/);
  // one line per SCOPE for the agent files, not one per file
  assert.match(r.stdout, /agent files under .*\.claude\/agents are v0\.0\.1 \(this install is v0\.1\.0\) — refresh: omelette-fleet rules --agents/);
  assert.equal((r.stdout.match(/agent files under /g) || []).length, 1);
  assert.equal(readFileSync(rulesPath, 'utf8'), MARKED_RULES('0.0.1', 'old\n'));
  for (const p of agentPaths) assert.equal(readFileSync(p, 'utf8'), agentText('0.0.1'));
});

// ─── core/client.mjs, driven directly: the transport's own failure modes ─────

test('client: a JSON-RPC error reply is a REJECTION, never a silent empty success', async () => {
  const dir = home();
  const boom = fakeServer(dir, 'boom.mjs', [
    'if (m.id === 1) send({ jsonrpc: "2.0", id: 1, result: INIT });',
    'else if (m.id === 2) send({ jsonrpc: "2.0", id: 2, result: { tools: TOOLS } });',
    'else send({ jsonrpc: "2.0", id: 3, error: { code: -32603, message: "tool exploded" } });',
  ].join('\n'));
  await assert.rejects(
    callUnitServer({ serverPath: boom, tool: 't', timeoutS: 20 }),
    /server error on tools\/call: tool exploded \(code -32603\)/,
  );
  // …and the same for the earlier requests.
  const early = fakeServer(dir, 'early.mjs', 'send({ jsonrpc: "2.0", id: m.id, error: { message: "no handshake" } });');
  await assert.rejects(callUnitServer({ serverPath: early, tool: 't', timeoutS: 20 }), /server error on initialize: no handshake/);
});

test('client: a child that exits after tools/list fails at once, not after the timeout', async () => {
  const dir = home();
  const quitter = fakeServer(dir, 'quit.mjs', [
    'if (m.id === 1) send({ jsonrpc: "2.0", id: 1, result: INIT });',
    'else if (m.id === 2) send({ jsonrpc: "2.0", id: 2, result: { tools: TOOLS } });',
    'else process.exit(7);',
  ].join('\n'));
  const t0 = Date.now();
  await assert.rejects(callUnitServer({ serverPath: quitter, tool: 't', timeoutS: 30 }), /server exited early \(code 7\)/);
  assert.ok(Date.now() - t0 < 5000, 'must not wait out the timeout');
});

test('client: a server that dies BEFORE tools/list fails the call at once too', async () => {
  const dir = home();
  // The other half of the same guard: whichever of exit / stdin-close arrives
  // first must fail the request instead of leaving it to the timeout.
  const bailer = fakeServer(dir, 'bail.mjs', 'if (m.id === 1) { send({ jsonrpc: "2.0", id: 1, result: INIT }); process.exit(0); }');
  const t0 = Date.now();
  await assert.rejects(
    callUnitServer({ serverPath: bailer, tool: 't', timeoutS: 30 }),
    /server (exited early|stdin failed|closed its stdin)/,
  );
  assert.ok(Date.now() - t0 < 5000, 'must not wait out the timeout');
});

test('client: an absurd timeout is clamped instead of overflowing into an instant false timeout', async () => {
  const dir = home();
  const good = fakeServer(dir, 'good.mjs', [
    'if (m.id === 1) send({ jsonrpc: "2.0", id: 1, result: INIT });',
    'else if (m.id === 2) send({ jsonrpc: "2.0", id: 2, result: { tools: TOOLS } });',
    'else send({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "hello" }] } });',
  ].join('\n'));
  // 1e12 s overflows Node's int32 timer and used to fire on the next tick.
  const r = await callUnitServer({ serverPath: good, tool: 't', timeoutS: 1e12 });
  assert.equal(r.text, 'hello');
  assert.equal(r.isError, false);
  assert.equal(MAX_TIMEOUT_S, 86400);
});

test('the cancel key reaches `set` and `show` with no CLI change — it comes from KEY_SCHEMA', () => {
  const dir = home();
  assert.match(cli(['show', 'grok'], { dir }).out, /^\s+cancel\s+finish\s+default$/m);
  const s = cli(['set', 'grok.cancel=kill'], { dir });
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /grok\.cancel\s+finish \[default\] → kill \[file\]/);
  assert.match(cli(['show', 'grok'], { dir }).out, /^\s+cancel\s+kill\s+file$/m);
  const bad = cli(['set', 'grok.cancel=maybe'], { dir });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /invalid value for grok\.cancel/);
});

// ─── results ─────────────────────────────────────────────────────────────────

test('results: the last ten across the fleet, newest first, with the unit named', () => {
  const dir = home();
  spoolResult(dir, 'codex', {
    resultId: '20260908T142501Z-1-1', tool: 'codex_code_review', model: 'gpt-6-astra', effort: 'xhigh',
    startedAt: '2026-09-08T14:25:01.000Z', endedAt: '2026-09-08T14:43:02.000Z', durationMs: 1081000,
    status: 'ok', partial: false, detached: false, cwd: '/tmp/p', promptPreview: 'review it', text: 'THE REVIEW',
  });
  spoolResult(dir, 'grok', {
    resultId: '20260908T150000Z-1-1', tool: 'grok_research',
    startedAt: '2026-09-08T15:00:00.000Z', endedAt: '2026-09-08T15:00:42.000Z', durationMs: 42,
    status: 'cancelled', partial: true, detached: true, promptPreview: 'x', text: 'HALF AN ANSWER',
  });

  const r = cli(['results'], { dir });
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.deepEqual(lines, [
    '20260908T150000Z-1-1  grok  grok_research  cancelled partial detached  42ms  2026-09-08T15:00:00.000Z',
    '20260908T142501Z-1-1  codex  codex_code_review  ok  1081000ms  2026-09-08T14:25:01.000Z',
  ]);

  const one = cli(['results', 'codex'], { dir });
  assert.equal(one.code, 0);
  assert.equal(one.out.trim().split('\n').length, 1);

  const file = cli(['results', 'codex', '20260908T142501Z-1-1'], { dir });
  assert.equal(file.code, 0);
  assert.match(file.out, /^---\nunit: codex\n/);
  assert.match(file.out, /\nstatus: ok\n/);
  assert.match(file.out, /\nTHE REVIEW\n$/);

  const p = cli(['results', 'codex', '20260908T142501Z-1-1', '--path'], { dir });
  assert.equal(p.out.trim(), join(dir, 'results', 'codex', '20260908T142501Z-1-1.md'));
  assert.equal(cli(['results', '--path'], { dir }).out.trim().split('\n').length, 2);
});

test('results: an empty spool is not a fault; an unknown unit and a bad id are', () => {
  const dir = home();
  const empty = cli(['results'], { dir });
  assert.equal(empty.code, 0);
  assert.match(empty.out, /no results spooled yet/);

  const badUnit = cli(['results', 'nope'], { dir });
  assert.equal(badUnit.code, 1);
  assert.match(badUnit.err, /unknown unit "nope"/);

  const badId = cli(['results', 'codex', 'not-an-id'], { dir });
  assert.equal(badId.code, 1);
  assert.match(badId.err, /is not a result id/);

  const missing = cli(['results', 'codex', '20260908T142501Z-1-9'], { dir });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no spooled result/);

  assert.equal(cli(['results', 'codex', '20260908T142501Z-1-9', 'extra'], { dir }).code, 1);
  assert.equal(cli(['results', '--nope'], { dir }).code, 1);
  assert.equal(existsSync(join(dir, 'results')), false, 'reading never creates the spool');
});

test('results: one id and no unit is looked up across the fleet', () => {
  const dir = home();
  // What a reader has in hand is the id off a listing line or a status feed —
  // the unit it came from is one more thing to remember, and the id says it.
  spoolResult(dir, 'grok', {
    resultId: '20260908T150000Z-1-1', tool: 'grok_research',
    startedAt: '2026-09-08T15:00:00.000Z', endedAt: '2026-09-08T15:00:42.000Z', durationMs: 42,
    status: 'ok', promptPreview: 'x', text: 'HALF AN ANSWER',
  });

  const found = cli(['results', '20260908T150000Z-1-1'], { dir });
  assert.equal(found.code, 0, found.err);
  assert.match(found.out, /^---\nunit: grok\n/);
  assert.match(found.out, /\nHALF AN ANSWER\n$/);

  const p = cli(['results', '20260908T150000Z-1-1', '--path'], { dir });
  assert.equal(p.out.trim(), join(dir, 'results', 'grok', '20260908T150000Z-1-1.md'));

  const missing = cli(['results', '20260908T142501Z-9-9'], { dir });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no spooled result "20260908T142501Z-9-9" in any unit/);
  // A unit is still a unit, and a positional that is neither is still an error.
  assert.equal(cli(['results', 'grok'], { dir }).code, 0);
  assert.match(cli(['results', 'nope'], { dir }).err, /unknown unit "nope"/);
});

test('results: the model the runtime filed a result under survives the read, parentheses and all', () => {
  const dir = home();
  // Exactly what core/unit.mjs writes for a unit that leaves the choice to its
  // CLI. The parentheses and the space are the kind of value a stricter header
  // parser would mangle, and both readers must show the operator the same one.
  spoolResult(dir, 'grok', {
    resultId: '20260908T142501Z-1-4', tool: 'grok_research', model: '(vendor default)', effort: '',
    startedAt: '2026-09-08T14:25:01.000Z', endedAt: '2026-09-08T14:25:42.000Z', durationMs: 41000,
    status: 'ok', partial: false, detached: false, cwd: '', promptPreview: 'x', text: 'AN ANSWER',
  });
  const r = cli(['results', 'grok', '20260908T142501Z-1-4'], { dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\nmodel: \(vendor default\)\n/);
});

test('doctor prints the results budget in the unit it was written in — B, KB, MB', () => {
  const dir = home();
  const fake = fakeBin(dir);
  const vendors = { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: fake };
  // The last `results` line is codex's — UNIT_ORDER ends there.
  const budget = () => cli(['doctor'], { dir, env: vendors }).out.split('\n').filter((l) => l.startsWith('  results     ')).pop();

  assert.match(budget(), / · max 50 MB$/, 'the default, unchanged');
  for (const [bytes, shown] of [[1048576, '1 MB'], [524288, '512 KB'], [1024, '1 KB'], [1000, '1000 B'], [1, '1 B']]) {
    assert.equal(cli(['set', `codex.resultsMaxBytes=${bytes}`], { dir }).code, 0);
    assert.match(budget(), new RegExp(` · max ${shown}$`), `${bytes} bytes reads as ${shown}`);
  }
});

test('results is in the usage and has its own help page; doctor names the spool per unit', () => {
  const dir = home();
  assert.match(cli(['--help'], { dir }).out, /omelette-fleet results/);
  const h = cli(['help', 'results'], { dir });
  assert.equal(h.code, 0);
  assert.match(h.out, /omelette-fleet results \[<unit>\] \[<id>\] \[--path\]/);

  const fake = fakeBin(dir);
  const vendors = { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: fake };
  const d = cli(['doctor'], { dir, env: vendors });
  assert.match(d.out, /^ {2}results {5}.+ · keep 50 · max 50 MB$/m);
  assert.ok(d.out.includes(join(dir, 'results', 'codex')));
  assert.match(d.out, /^\s+resultsKeep\s+50\s+default$/m, 'and the key is in the config table like every other');

  assert.equal(cli(['set', 'codex.results=false'], { dir }).code, 0);
  assert.match(cli(['doctor'], { dir, env: vendors }).out, /^ {2}results {5}\(disabled in config\)/m);
});

test('results --stats: one row per unit and a total, tokens only where every call reported them', () => {
  const dir = home();
  spoolResult(dir, 'codex', {
    resultId: '20260908T142501Z-1-1', tool: 'codex_code_review', model: 'gpt-6-astra', effort: 'xhigh',
    startedAt: '2026-09-08T14:25:01.000Z', endedAt: '2026-09-08T15:26:03.000Z', durationMs: 3662000,
    status: 'ok', partial: false, detached: false, cwd: '/tmp/p', promptPreview: 'review it',
    usage: { input: 60835, cachedInput: 45312, output: 236, reasoning: 103 }, text: 'THE REVIEW',
  });
  spoolResult(dir, 'codex', {
    resultId: '20260908T142501Z-1-2', tool: 'codex_research',
    startedAt: '2026-09-08T15:30:00.000Z', endedAt: '2026-09-08T15:30:01.000Z', durationMs: 1000,
    status: 'error', partial: false, detached: false, promptPreview: 'x', text: 'Error: nope',
  });
  spoolResult(dir, 'grok', {
    resultId: '20260908T150000Z-1-1', tool: 'grok_research',
    startedAt: '2026-09-08T15:00:00.000Z', endedAt: '2026-09-08T15:01:22.000Z', durationMs: 82000,
    status: 'cancelled', partial: true, detached: false, promptPreview: 'x',
    usage: { input: 7, output: 3 }, text: 'HALF AN ANSWER',
  });

  const r = cli(['results', '--stats'], { dir });
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 4, 'the header, the two units that have records, and the total — gemini has none');
  assert.match(lines[0], /^unit +calls +ok\/error\/cancelled +partial +wall +spool +tokens in \/ out$/);
  assert.match(lines[1], /^grok +1 +0\/0\/1 +1 +1m 22s +\d+ [KM]?B +7 \/ 3$/);
  assert.match(lines[2], /^codex +2 +1\/1\/0 +0 +1h 1m 3s +\d+ [KM]?B +n\/a \(1 of 2 calls reported\)$/);
  assert.match(lines[3], /^total +3 +1\/1\/1 +1 +1h 2m 25s +\d+ [KM]?B +n\/a \(2 of 3 calls reported\)$/);

  const one = cli(['results', '--stats', 'codex'], { dir });
  assert.equal(one.code, 0, one.err);
  const only = one.out.trim().split('\n');
  assert.equal(only.length, 3, 'the header, codex, and a total of codex');
  assert.match(only[1], /^codex +2 /);
  assert.match(only[2], /^total +2 /);

  // The listing is untouched by the new flag.
  assert.equal(cli(['results'], { dir }).out.trim().split('\n').length, 3);
});

test('results --stats: an empty spool prints `no results`; an id and --path are usage errors', () => {
  const dir = home();
  const empty = cli(['results', '--stats'], { dir });
  assert.equal(empty.code, 0);
  assert.equal(empty.out.trim(), 'no results');
  assert.equal(existsSync(join(dir, 'results')), false, 'counting never creates the spool');

  spoolResult(dir, 'grok', {
    resultId: '20260908T150000Z-1-1', tool: 'grok_research',
    startedAt: '2026-09-08T15:00:00.000Z', endedAt: '2026-09-08T15:00:42.000Z', durationMs: 42000,
    status: 'ok', partial: false, detached: false, promptPreview: 'x', text: 'x',
  });

  const withId = cli(['results', '--stats', '20260908T150000Z-1-1'], { dir });
  assert.equal(withId.code, 1);
  assert.match(withId.err, /--stats reports on a unit, not on one result/);

  const withPath = cli(['results', '--stats', '--path'], { dir });
  assert.equal(withPath.code, 1);
  assert.match(withPath.err, /--path prints the paths of a listing/);

  assert.equal(cli(['results', '--stats', 'nope'], { dir }).code, 1);

  // A unit with no records is not a row; one with records is, and so is a
  // call that reported no tokens at all.
  const rows = cli(['results', '--stats'], { dir }).out.trim().split('\n');
  assert.equal(rows.length, 3);
  assert.match(rows[1], /^grok +1 +1\/0\/0 +0 +42s +\d+ [KM]?B +n\/a \(0 of 1 calls reported\)$/);

  assert.match(cli(['help', 'results'], { dir }).out, /--stats prints what the spool cost/);
});

test('results --stats --since: a window of <n>h / <n>d or a date, measured on startedAt', () => {
  const dir = home();
  const now = Date.now();
  const at = (hoursAgo) => new Date(now - hoursAgo * 3600 * 1000).toISOString();
  const rec = (id, startedAt) => ({
    resultId: id, tool: 'grok_research', startedAt, endedAt: startedAt, durationMs: 1000,
    status: 'ok', partial: false, detached: false, promptPreview: 'x', usage: { input: 5, output: 5 }, text: 'x',
  });
  spoolResult(dir, 'grok', rec('20260908T150000Z-1-1', at(23)));
  spoolResult(dir, 'grok', rec('20260908T150000Z-1-2', at(25)));

  const day = cli(['results', '--stats', '--since', '24h'], { dir });
  assert.equal(day.code, 0, day.err);
  const lines = day.out.trim().split('\n');
  assert.match(lines[0], /^since 20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d\d\dZ$/, 'the window it actually used');
  assert.match(lines[2], /^grok +1 +1\/0\/0 +0 +1s +\d+ [KM]?B +5 \/ 5$/, '23h in, 25h out');
  assert.match(lines[3], /^total +1 /);

  assert.match(cli(['results', '--stats', '--since=7d'], { dir }).out, /^grok +2 /m);
  assert.match(cli(['results', '--stats', '--since', '2000-01-01'], { dir }).out, /^grok +2 /m);
  assert.match(cli(['results', '--stats', '--since', '2026-09-08T00:00:00.000Z'], { dir }).out, /^grok +/m);

  const future = cli(['results', '--stats', '--since', '2999-01-01'], { dir });
  assert.equal(future.code, 0, 'a window with nothing in it is an answer, not a fault');
  assert.match(future.out, /^no results$/m);

  for (const bad of ['yesterday', '24', '3w', '2026-13-40', '']) {
    const r = cli(['results', '--stats', '--since', bad], { dir });
    assert.equal(r.code, 1, JSON.stringify(bad));
    assert.equal(r.out, '', 'nothing is printed for a window nobody can read');
    assert.match(r.err, /^omelette-fleet results: --since /);
  }
  assert.equal(cli(['results', '--stats', '--since'], { dir }).code, 1, '--since needs a value');

  const strayed = cli(['results', '--since', '24h'], { dir });
  assert.equal(strayed.code, 1);
  assert.match(strayed.err, /--since is only for --stats/);

  assert.match(cli(['help', 'results'], { dir }).out, /--since 24h/);
});

/** A doctor run inside one project, with the fleet home and HOME under our control. */
const doctorIn2 = (proj, dir, env = {}) => spawnSync(process.execPath, [BIN, 'doctor'], {
  cwd: proj, encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
}).stdout;

test('set handoff.<key> edits the top-level block, show prints it, and the bounds are refused', () => {
  const dir = home();
  const s = cli(['set', 'handoff.threshold=85'], { dir });
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /handoff\.threshold\s+90 \[default\] → 85 \[file\]/);
  assert.match(s.out, /rules --hooks/, 'a changed setting is only in the guard after a re-render');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8')).handoff, { threshold: 85 });

  // `contextWindow: 0` is a VALUE, not a refusal: it means "resolve at run time".
  assert.equal(cli(['set', 'handoff.contextWindow=0'], { dir }).code, 0);
  assert.equal(cli(['set', 'handoff.enabled=off'], { dir }).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8')).handoff,
    { threshold: 85, contextWindow: 0, enabled: false });

  const shown = cli(['show', 'handoff'], { dir });
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /^handoff$/m);
  assert.match(shown.out, /^\s+threshold\s+85\s+file$/m);
  assert.match(shown.out, /^\s+enabled\s+false\s+file$/m);
  assert.match(shown.out, /^\s+contextWindow\s+0\s+file$/m);
  assert.match(shown.out, /^\s+compactSummary\s+true\s+default$/m);
  assert.doesNotMatch(shown.out, /^codex$/m, 'show handoff shows the block and nothing else');
  assert.match(cli(['show'], { dir }).out, /^handoff$/m, 'a bare show lists it after the agents');
  assert.doesNotMatch(cli(['show', 'codex'], { dir }).out, /^handoff$/m);

  // The bounds and the shape are refused, and nothing is written.
  const before = readFileSync(join(dir, 'fleet.config.json'), 'utf8');
  for (const [assignment, message] of [
    ['handoff.threshold=49', /invalid value for handoff\.threshold: "49" — expected a positive integer from 50 to 99/],
    ['handoff.threshold=100', /invalid value for handoff\.threshold: "100"/],
    ['handoff.threshold=0.5', /invalid value for handoff\.threshold: "0\.5"/],
    ['handoff.contextWindow=-1', /invalid value for handoff\.contextWindow: "-1" — expected a whole number 0 or above/],
    ['handoff.contextWindow=9007199254740992', /invalid value for handoff\.contextWindow: "9007199254740992"/],
    ['handoff.enabled=maybe', /invalid value for handoff\.enabled: "maybe" — expected true \| false/],
    ['handoff.nudgeAt=80', /unknown key "nudgeAt" for the handoff block — known keys: enabled, threshold, contextWindow, compactSummary/],
    ['handoff=90', /"handoff=90" is not handoff\.<key>=<value>/],
    ['handoff.a.b=1', /"handoff\.a\.b=1" is not handoff\.<key>=<value>/],
  ]) {
    const r = cli(['set', assignment], { dir });
    assert.equal(r.code, 1, assignment);
    assert.match(r.err, message, assignment);
  }
  assert.equal(readFileSync(join(dir, 'fleet.config.json'), 'utf8'), before, 'a refusal writes nothing');
  const bad = cli(['show', 'nope'], { dir });
  assert.match(bad.err, /unknown unit "nope"/);
});

test('set handoff.compactSummary=false round-trips through the config file and the rendered guard', () => {
  const dir = home();
  const s = cli(['set', 'handoff.compactSummary=false'], { dir });
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /handoff\.compactSummary\s+true \[default\] → false \[file\]/);
  assert.match(s.out, /rules --hooks/, 'a changed setting is only in the guard after a re-render');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8')).handoff, { compactSummary: false });

  const shown = cli(['show', 'handoff'], { dir });
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /^\s+compactSummary\s+false\s+file$/m);

  // …and it reaches the guard the only way anything reaches it: the rendered
  // literal, which is what `doctor` reads back.
  const proj = join(dir, 'proj'); mkdirSync(proj);
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  const guard = readFileSync(join(proj, '.claude', 'hooks', 'omelette-guard.mjs'), 'utf8');
  assert.match(guard, /^const HANDOFF_CONFIG = \{.*"compactSummary":false\};$/m);

  // The value is a boolean, and `set` refuses anything that is not one.
  const bad = cli(['set', 'handoff.compactSummary=sometimes'], { dir });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /invalid value for handoff\.compactSummary: "sometimes" — expected true \| false/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8')).handoff, { compactSummary: false });
});

test('set contract=short round-trips, show lists the fleet block, and a bad value is refused', () => {
  const dir = home();
  const s = cli(['set', 'contract=short'], { dir });
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /^contract {2}auto \[default\] → short \[file\]$/m, s.out);
  assert.match(s.out, /restart Claude Code/, 'a server reads it when it STARTS');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8')), { version: 1, contract: 'short' });

  const shown = cli(['show', 'fleet'], { dir });
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /^fleet$/m);
  assert.match(shown.out, /^\s+contract\s+short\s+file$/m);
  assert.match(shown.out, /^\s+updateCheck\s+true\s+default$/m);
  assert.doesNotMatch(shown.out, /^codex$/m, 'show fleet shows the block and nothing else');
  assert.match(cli(['show'], { dir }).out, /^fleet$/m, 'a bare show lists it too');
  assert.doesNotMatch(cli(['show', 'codex'], { dir }).out, /^fleet$/m);

  // The other top-level key comes with the same door, and a unit key still
  // goes where it always went — one command may carry both.
  const both = cli(['set', 'updateCheck=false', 'codex.timeoutS=42'], { dir });
  assert.equal(both.code, 0, both.err);
  assert.match(both.out, /^updateCheck {2}true \[default\] → false \[file\]$/m);
  assert.match(both.out, /^codex\.timeoutS {2}600 \[default\] → 42 \[file\]$/m);
  const written = JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8'));
  assert.equal(written.contract, 'short', 'the earlier key survived the merge');
  assert.equal(written.updateCheck, false);
  assert.equal(written.units.codex.timeoutS, 42);

  // Refusals: the enum, a dotted form that is a unit path, and a bare key
  // that is not a fleet key at all. Nothing is written by any of them.
  const before = readFileSync(join(dir, 'fleet.config.json'), 'utf8');
  for (const [assignment, message] of [
    ['contract=loud', /invalid value for contract: "loud" — expected auto \| full \| short/],
    ['contract=', /invalid value for contract: "" — expected auto \| full \| short/],
    ['contract.mode=short', /unknown unit "contract"/],
    ['nosuchkey=1', /"nosuchkey=1" is not <key>=<value>/],
  ]) {
    const r = cli(['set', assignment], { dir });
    assert.equal(r.code, 1, assignment);
    assert.match(r.err, message, assignment);
  }
  assert.equal(readFileSync(join(dir, 'fleet.config.json'), 'utf8'), before, 'a refusal writes nothing');

  // The block name is in the two help pages that list what they accept.
  assert.match(cli(['show', '--help'], { dir }).out, /fleet/);
  assert.match(cli(['set', '--help'], { dir }).out, /contract/);
  assert.match(cli(['show', 'nope'], { dir }).err, /unknown unit "nope"/);
});

test('doctor prints the handoff line from the RENDERED guard, and names where the ceiling came from', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  // No ledger yet: the hook is installed and deliberately silent.
  assert.match(doctorIn2(proj, dir),
    /^handoff {7}nudge at 90% of 200000 \(default\) · Stop gate on · summary on · ledgers: none \(hook silent — start \.omelette\/ledger-<plan>\.md\)$/m,
    doctorIn2(proj, dir));
  // One ledger, and it is counted.
  mkdirSync(join(proj, '.omelette'));
  writeFileSync(join(proj, '.omelette', 'ledger-0.3.4.md'), '# ledger\n');
  assert.match(doctorIn2(proj, dir), /^handoff {7}nudge at 90% of 200000 \(default\) · Stop gate on · summary on · ledgers: 1$/m);

  // The line reads the RENDERED value: a `set` that was never re-rendered is
  // visible as the old number, which is the whole point of reading it back.
  assert.equal(cli(['set', 'handoff.threshold=75'], { dir }).code, 0);
  assert.match(doctorIn2(proj, dir), /^handoff {7}nudge at 90% of 200000 \(default\)/m, 'still the rendered 90');
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  assert.match(doctorIn2(proj, dir), /^handoff {7}nudge at 75% of 200000 \(default\)/m, 'and 75 after the re-render');

  // The ceiling, in precedence order.
  assert.match(doctorIn2(proj, dir, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500k' }),
    /^handoff {7}nudge at 75% of 500000 \(CLAUDE_CODE_AUTO_COMPACT_WINDOW\)/m);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: '1m' }, null, 2));
  assert.match(doctorIn2(proj, dir), /^handoff {7}nudge at 75% of 1000000 \(autoCompactWindow\)/m);
  assert.match(doctorIn2(proj, dir, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'lots' }),
    /^handoff {7}nudge at 75% of 1000000 \(autoCompactWindow\)/m, 'garbage falls through to the file');
  assert.equal(cli(['set', 'handoff.contextWindow=400000'], { dir }).code, 0);
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  assert.match(doctorIn2(proj, dir, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500k' }),
    /^handoff {7}nudge at 75% of 400000 \(handoff\.contextWindow\)/m);
});

test('doctor: handoff.enabled=false says the gate is off, and the line sits above the mcp timeout block', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  mkdirSync(join(proj, '.omelette'));
  writeFileSync(join(proj, '.omelette', 'ledger-a.md'), '# a\n');
  writeFileSync(join(proj, '.omelette', 'ledger-b.md'), '# b\n');
  assert.equal(cli(['set', 'handoff.enabled=false'], { dir }).code, 0);
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  const out = doctorIn2(proj, dir);
  assert.match(out, /^handoff {7}nudge off \(handoff\.enabled=false\) · Stop gate off · summary on · ledgers: 2$/m, out);
  const lines = out.split('\n');
  assert.ok(lines.findIndex((l) => l.startsWith('handoff ')) > lines.findIndex((l) => l.startsWith('hooks ')), out);
  assert.ok(lines.findIndex((l) => l.startsWith('handoff ')) < lines.findIndex((l) => l.startsWith('mcp timeout')), out);
});

test('doctor: the handoff line reports the summary switch out of the RENDERED guard, independently of the nudge', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  mkdirSync(join(proj, '.omelette'));
  writeFileSync(join(proj, '.omelette', 'ledger-a.md'), '# a\n');
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  assert.match(doctorIn2(proj, dir), /^handoff {7}nudge at 90% of 200000 \(default\) · Stop gate on · summary on · ledgers: 1$/m);

  // Like every other value on this line, it is read back out of the script: a
  // `set` that was never re-rendered is visible as the value in force.
  assert.equal(cli(['set', 'handoff.compactSummary=false'], { dir }).code, 0);
  assert.match(doctorIn2(proj, dir), /· summary on · ledgers: 1$/m, 'still the rendered value');
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  assert.match(doctorIn2(proj, dir), /^handoff {7}nudge at 90% of 200000 \(default\) · Stop gate on · summary off · ledgers: 1$/m, doctorIn2(proj, dir));

  // The two switches are independent: `enabled` is the nudge and the gate,
  // `compactSummary` is the record a compaction leaves behind.
  assert.equal(cli(['set', 'handoff.enabled=false'], { dir }).code, 0);
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  assert.match(doctorIn2(proj, dir), /^handoff {7}nudge off \(handoff\.enabled=false\) · Stop gate off · summary off · ledgers: 1$/m, doctorIn2(proj, dir));
  assert.equal(cli(['set', 'handoff.compactSummary=true'], { dir }).code, 0);
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  assert.match(doctorIn2(proj, dir), /^handoff {7}nudge off \(handoff\.enabled=false\) · Stop gate off · summary on · ledgers: 1$/m, doctorIn2(proj, dir));
});

test('doctor prints no handoff line when no guard of ours carries the block', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  // No guard at all.
  assert.doesNotMatch(doctorIn2(proj, dir), /^handoff /m);
  // A guard that is not ours.
  mkdirSync(join(proj, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'hooks', 'omelette-guard.mjs'), '// my own hook\nconst HANDOFF_CONFIG = {"threshold":50};\n');
  assert.doesNotMatch(doctorIn2(proj, dir), /^handoff /m, 'a marker is the only proof of ownership');
  // A guard of ours from before the block existed: the hooks line already asks
  // for a refresh, and inventing a value it does not carry would be the one
  // thing reading it back exists to prevent.
  writeFileSync(join(proj, '.claude', 'hooks', 'omelette-guard.mjs'), MARKED_HOOK('0.3.3'));
  const out = doctorIn2(proj, dir);
  assert.doesNotMatch(out, /^handoff /m, out);
  assert.match(out, /^hooks {9}project: v0\.3\.3 /m, out);
});

test('doctor says so when the handoff line came from the GLOBAL guard rather than the project one', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  // A 0.3.3-era project guard: ours by its marker, and carrying no rendered
  // handoff block. handoffReport falls through to the global guard — and a
  // threshold the operator reads here is one they would have to change with
  // `rules --global --hooks`, so the line has to name whose value it is.
  mkdirSync(join(proj, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'hooks', 'omelette-guard.mjs'), MARKED_HOOK('0.3.3'));
  assert.equal(rulesIn(proj, dir, ['--global', '--hooks']).status, 0);
  assert.match(
    doctorIn2(proj, dir),
    /^handoff {7}nudge at 90% of 200000 \(default\) · Stop gate on · summary on · ledgers: none \(hook silent — start \.omelette\/ledger-<plan>\.md\) · the project guard carries no handoff block — showing the global guard's values$/m,
    doctorIn2(proj, dir),
  );

  // The project's own guard, re-rendered, carries the block: the value is this
  // project's and the suffix goes away.
  assert.equal(rulesIn(proj, dir, ['--hooks', '--force']).status, 0);
  const own = doctorIn2(proj, dir);
  assert.match(own, /^handoff {7}nudge at 90% of 200000 \(default\) · Stop gate on · summary on · ledgers: none \(hook silent — start \.omelette\/ledger-<plan>\.md\)$/m, own);
  assert.doesNotMatch(own, /showing the global guard/, own);
});

test('doctor says which contract a unit server started here would send', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  // `doctor` reports its own `process.cwd()`, which is the RESOLVED path:
  // `/var/folders/…` is a symlink to `/private/var/folders/…` on macOS.
  const quoted = realpathSync(proj).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Nothing installed in either scope: the full contract, and the line names
  // the directory that was looked in — the one thing to check when it is not
  // the answer you expected.
  assert.match(doctorIn2(proj, dir), new RegExp(`^contract {6}full \\(no rules file in ${quoted}\\)$`, 'm'), doctorIn2(proj, dir));

  // The project's own rendered file.
  assert.equal(rulesIn(proj, dir).status, 0);
  assert.match(doctorIn2(proj, dir), /^contract {6}short \(rules installed here\)$/m);

  // A project with none of its own reads the global scope.
  const other = join(dir, 'other'); mkdirSync(other);
  assert.match(doctorIn2(other, dir), /^contract {6}full \(no rules file in /m);
  assert.equal(rulesIn(other, dir, ['--global']).status, 0);
  assert.match(doctorIn2(other, dir), /^contract {6}short \(rules installed globally\)$/m);

  // The config key overrides the lookup, and the reason says so rather than
  // leaving an operator to wonder why the file they installed did nothing.
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, contract: 'full' }));
  assert.match(doctorIn2(proj, dir), /^contract {6}full \(contract=full\)$/m);
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, contract: 'short' }));
  assert.match(doctorIn2(other, dir), /^contract {6}short \(contract=short\)$/m);

  // Where it sits: under the managed-file lines, above the client's walls.
  const lines = doctorIn2(proj, dir).split('\n');
  assert.ok(lines.findIndex((l) => l.startsWith('contract ')) > lines.findIndex((l) => l.startsWith('hooks ')), lines.join('\n'));
  assert.ok(lines.findIndex((l) => l.startsWith('contract ')) < lines.findIndex((l) => l.startsWith('mcp timeout')), lines.join('\n'));

  // It is a line an operator has to be able to look up.
  const help = cli(['doctor', '--help'], { dir });
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /`contract` line/);
});

test('doctor: an autoCompactWindow that is not a window is skipped and the next file is read — the hook reads them the same way', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  // The client reads settings.local.json first, and the guard keeps looking
  // past a value it cannot parse. A doctor that stopped at the garbage would
  // report the 200 000 default for a hook measuring against half a million —
  // the one thing this line exists to prevent.
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ autoCompactWindow: 'garbage' }));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: '500k' }));
  const out = doctorIn2(proj, dir);
  assert.match(out, /^handoff {7}nudge at 90% of 500000 \(autoCompactWindow\) · Stop gate on/m, out);

  // …and with nothing readable in either file it is Claude Code's documented
  // 200 000, named as the default rather than as a setting.
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: '1.5m' }));
  const fallback = doctorIn2(proj, dir);
  assert.match(fallback, /^handoff {7}nudge at 90% of 200000 \(default\) · Stop gate on/m, fallback);
});

test('doctor --help names the handoff line, because it is a line an operator has to be able to look up', () => {
  const help = spawnSync(process.execPath, [BIN, 'help', 'doctor'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home(), OMELETTE_UPDATE_CHECK: '0' },
  }).stdout;
  assert.match(help, /`handoff` line/);
});

/** Every `settings: … unreadable` line doctor printed, in order, label column stripped. */
const settingsLines = (out) => out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('settings: '));

test('doctor: one unparseable user settings file is named exactly ONCE, whichever of the three readers tripped over it', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  assert.equal(rulesIn(proj, dir, ['--global', '--hooks']).status, 0);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  // A trailing comma in the file the client reads FIRST. Three readers open it:
  // the env lookup behind the mcp timeout lines, the hook-wiring report behind
  // the hooks line, and the ceiling lookup behind the handoff line.
  writeFileSync(
    join(dir, '.claude', 'settings.local.json'),
    '{ "env": { "MCP_TOOL_TIMEOUT": "1800000", }, "autoCompactWindow": "1m" }',
  );
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: '500k' }));
  const out = doctorIn2(proj, dir);

  // 1. The wall fell back to the client's default: the value in the broken file
  // was never read…
  assert.match(out, /wall-clock: MCP_TOOL_TIMEOUT unset \(default ~28 h\)/, out);
  // 2. …the wiring reader names it as the reason the GLOBAL guard is not wired…
  assert.match(out, /global: v[\d.]+ \(NOT wired \(settings\.local\.json unreadable\)/, out);
  // 3. …and the ceiling came from the file that DOES parse, not from the `1m`
  // in the one that does not.
  assert.match(out, /^handoff {7}nudge at 90% of 500000 \(autoCompactWindow\)/m, out);

  // One line, not three — and the wording no longer claims only `env` values
  // were lost, because two of those three readers were never after one.
  assert.deepEqual(
    settingsLines(out),
    [`settings: ${join(dir, '.claude', 'settings.local.json')} unreadable — its values were not consulted`],
    out,
  );
});

test('doctor: the ceiling reader names a settings file it ALONE could not read', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  // A DIRECTORY where the client expects a file: readFileSync throws EISDIR,
  // which `hookWiringAt` treats as absent, and with both timeout variables in
  // the process environment `readClientEnv` returns before it opens anything at
  // all. The ceiling lookup behind the `handoff` line is the only reader left —
  // and the operator still gets the line, because the window it resolved may be
  // the one that directory was meant to change.
  mkdirSync(join(dir, '.claude', 'settings.local.json'));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: '500k' }));
  const out = doctorIn2(proj, dir, { MCP_TOOL_TIMEOUT: '2000000', CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0' });

  assert.match(out, /^handoff {7}nudge at 90% of 500000 \(autoCompactWindow\)/m, out);
  assert.deepEqual(
    settingsLines(out),
    [`settings: ${join(dir, '.claude', 'settings.local.json')} unreadable — its values were not consulted`],
    out,
  );
});

/** doctor from a project of its own, so the user scope's settings are named once and by one path. */
const doctorFromProject = (dir, env = {}) => {
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  return cli(['doctor'], { dir: proj, env: { HOME: dir, OMELETTE_HOME: dir, ...env }, timeout: 20000 });
};

test('doctor: a settings file that would BLOCK the read is named unreadable, and doctor comes back at once', (t) => {
  const dir = home();
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const fifo = join(dir, '.claude', 'settings.local.json');
  // A FIFO with nobody on the other end: an ordinary read of it never returns,
  // and doctor opening one would hang for as long as the operator waits.
  if (spawnSync('mkfifo', [fifo], { encoding: 'utf8' }).status !== 0) return t.skip('mkfifo is unavailable here');
  const t0 = Date.now();
  const r = doctorFromProject(dir);
  assert.ok(Date.now() - t0 < 2000, `doctor took ${Date.now() - t0} ms`);
  assert.deepEqual(
    settingsLines(r.out),
    [`settings: ${fifo} unreadable — its values were not consulted`],
    r.out + r.err,
  );
});

test('doctor: a settings file past the read cap is unreadable, exactly as the guard treats it', () => {
  const dir = home();
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const big = join(dir, '.claude', 'settings.json');
  // Valid JSON, and 2 MiB of it. The guard reads at most 1 MiB of a settings
  // file; what comes back is half an object, and half an object is not a value
  // anybody may act on. Doctor has to say the same thing about the same file.
  writeFileSync(big, `{"env":{"NOISE":"${'A'.repeat(2 * 1024 * 1024)}"},"autoCompactWindow":"500k"}`);
  const r = doctorFromProject(dir);
  assert.deepEqual(
    settingsLines(r.out),
    [`settings: ${big} unreadable — its values were not consulted`],
    r.out + r.err,
  );
});

/**
 * One assistant record, the shape Claude Code writes into a transcript: the
 * three input counters are the prompt that was just sent, and `output_tokens`
 * is deliberately outside that sum.
 */
const transcriptLine = (fill) => JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-5',
    usage: { input_tokens: 32, cache_creation_input_tokens: 1208, cache_read_input_tokens: fill - 1240, output_tokens: 485 },
  },
  timestamp: '2026-09-09T12:00:00.000Z',
});

let guardRun = 0;
/** The INSTALLED guard, fired with one PostToolUse event: `<window> (<source>)` off its nudge. */
function guardCeiling(proj, dir, env = {}) {
  const r = spawnSync(process.execPath, [join(proj, '.claude', 'hooks', 'omelette-guard.mjs')], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: `parity-${guardRun++}`, // a fresh crossing every time: the guard nudges once per session
      transcript_path: join(proj, 'transcript.jsonl'),
      cwd: proj,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: 'ok' },
    }),
    cwd: proj, encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, HOME: dir, ...env },
  });
  const m = /context at \d+% of (\d+) tokens \(([^)]+)\)\./.exec(r.stdout || '');
  return m ? `${m[1]} (${m[2]})` : `no nudge: ${JSON.stringify(r.stdout)}${r.stderr}`;
}

/** …and the same two values off doctor's `handoff` line. */
function doctorCeiling(proj, dir, env = {}) {
  const out = doctorIn2(proj, dir, env);
  const m = /^handoff {7}nudge at \d+% of (\d+) \(([^)]+)\)/m.exec(out);
  return m ? `${m[1]} (${m[2]})` : `no handoff line:\n${out}`;
}

test('doctor and the INSTALLED guard resolve the same ceiling from the same machine, source for source', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  // The guard is silent without a ledger, and measures nothing without a
  // transcript: 990000 tokens is past 90 % of every window tested below.
  mkdirSync(join(proj, '.omelette'), { recursive: true });
  writeFileSync(join(proj, '.omelette', 'ledger-0.3.5.md'), '# ledger 0.3.5\n');
  writeFileSync(join(proj, 'transcript.jsonl'), `${transcriptLine(990000)}\n`);
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  const claude = join(dir, '.claude');
  mkdirSync(claude, { recursive: true });

  const agree = (expected, env = {}) => {
    assert.equal(guardCeiling(proj, dir, env), expected, 'the guard');
    assert.equal(doctorCeiling(proj, dir, env), expected, 'doctor');
  };

  // 5. Nothing set anywhere: Claude Code's documented default.
  agree('200000 (default)');

  // …and the PROJECT's own settings are not the user's, on either side.
  mkdirSync(join(proj, '.claude'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5[1m]' }));
  agree('200000 (default)');

  // 4. A `[1m]` model id — the environment first…
  agree('1000000 (model[1m])', { ANTHROPIC_MODEL: 'claude-fable-5-1[1m]' });

  // …then the `model` key of the user's pair, the local file read first, with a
  // value that is not a 1M id falling through to the next file rather than
  // ending the scan.
  writeFileSync(join(claude, 'settings.local.json'), JSON.stringify({ model: 'claude-opus-5' }));
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ model: 'claude-opus-5[1M]' }));
  agree('1000000 (model[1m])');

  // 3. `autoCompactWindow` beats the suffix — by SOURCE and not by file: it is
  // in the local file here, and it would win from the shared one too.
  writeFileSync(join(claude, 'settings.local.json'), JSON.stringify({ autoCompactWindow: '500k', model: 'claude-opus-5[1m]' }));
  agree('500000 (autoCompactWindow)');

  // 2. The environment variable beats both files…
  agree('250000 (CLAUDE_CODE_AUTO_COMPACT_WINDOW)', { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250k' });

  // 1. …and the rendered `handoff.contextWindow` beats everything, once it has
  // actually been rendered into the script.
  assert.equal(cli(['set', 'handoff.contextWindow=400000'], { dir }).code, 0);
  assert.equal(rulesIn(proj, dir, ['--hooks']).status, 0);
  agree('400000 (handoff.contextWindow)', { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250k', ANTHROPIC_MODEL: 'claude-opus-5[1m]' });
});
