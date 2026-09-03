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
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callUnitServer, MAX_TIMEOUT_S } from '../core/client.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** A fresh fleet home per test; HOME follows it so nothing leaks into the real one. */
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-cli-'));
  return dir;
}

/** Run the CLI with a clean-ish env (PATH kept: `claude` may or may not exist — no test depends on it). */
function cli(args, { dir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    // The update check is OFF for every run: a unit test that quietly calls
    // GitHub is a flaky test and a slow one. `env` can still switch it back on.
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
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
    for (const cmd of ['install', 'uninstall', 'update', 'doctor', 'show', 'set', 'call']) assert.match(r.out, new RegExp(`omelette-fleet ${cmd}`));
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

test('call drives a real server over stdio and maps the answer to an exit code', () => {
  const dir = home();
  const ok = cli(['call', 'codex', 'codex_models', '{}'], { dir });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /initialize → omelette-codex/);
  assert.match(ok.out, /tools\/list → codex_research, codex_code_review, codex_image, codex_models/);
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

test('per-command help: `<cmd> --help`, `-h` and `help <cmd>` all print that command\'s page', () => {
  const dir = home();
  for (const cmd of ['install', 'uninstall', 'update', 'doctor', 'show', 'set', 'call']) {
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
