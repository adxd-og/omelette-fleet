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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

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

test('--help (and no args) print the usage; --version prints the package version', () => {
  const pkg = JSON.parse(spawnSync(process.execPath, ['-p', "JSON.stringify(require('./package.json'))"], { cwd: ROOT, encoding: 'utf8' }).stdout);
  const dir = home();
  for (const args of [['--help'], []]) {
    const r = cli(args, { dir });
    assert.equal(r.code, 0);
    assert.match(r.out, /USAGE/);
    for (const cmd of ['install', 'uninstall', 'doctor', 'show', 'set', 'call']) assert.match(r.out, new RegExp(`omelette-fleet ${cmd}`));
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
  assert.match(state({ loginCode: 1, login: '' }, 'c-exit'), /^SIGNED OUT/); // non-zero exit = no session
  assert.match(state({ login: 'You are not logged in' }, 'c-not'), /^SIGNED OUT/); // contains "logged in"
  assert.match(state({ login: 'something else entirely' }, 'c-huh'), /^unknown/); // never guessed
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

test('doctor surfaces a registered server whose file is missing, and honours enabled=false in the config', () => {
  const dir = home();
  const fake = fakeBin(dir);
  // A hand-made ~/.claude.json: doctor only ever reads it.
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-codex': { command: 'node', args: [join(dir, 'gone', 'codex.mjs')] } },
  }));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { enabled: false } } }));
  const r = cli(['doctor'], { dir, env: { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: join(dir, 'no-such-codex') } });
  assert.match(r.out, /omelette-codex registered \(user\) → .*gone.*codex\.mjs \[FILE MISSING\]/);
  assert.equal(r.code, 0); // registered + broken, but disabled in config → not a fault
  assert.match(r.out, /^\s+enabled\s+false\s+file$/m);
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
  assert.match(r.out, /omelette-codex registered \(user\) → .*servers.*codex\.mjs \[file exists\]/);
});

test('call drives a real server over stdio and maps the answer to an exit code', () => {
  const dir = home();
  const ok = cli(['call', 'codex', 'codex_models', '{}'], { dir });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /initialize → omelette-codex/);
  assert.match(ok.out, /tools\/list → codex_research, codex_code_review, codex_models/);
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
