/**
 * omelette-fleet :: test/tester-1.3.0-fix10.test.mjs
 *
 * Independent tester coverage for plan Task 10 (2026-09-24-1.3.0-P0-fixes.md,
 * C3/C5/C7/C11). Written from a clean context, against the diff only — no
 * import from test/cli.test.mjs, no shared helper code with it. Every helper
 * below is authored fresh so this file never depends on the implementer's own
 * test file changing shape under it.
 *
 * NOTHING REAL IS TOUCHED: every run gets its own OMELETTE_HOME, and HOME
 * follows it. `set`, `install` and `doctor --probe-sandbox` are NEVER run
 * against the real fleet home — only against a throwaway temp directory.
 * Every spawn that could hang carries a timeout, and every fake vendor CLI
 * exits on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellWord } from '../core/rules.mjs';
import { configPath, writeFleetConfig } from '../core/config.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const isWin = process.platform === 'win32';

/** A fresh throwaway directory, used as a fleet home, a project, or both. */
function tmp(prefix = 'omelette-fix10-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Run the CLI as a child process, exactly like the shipped tests do. */
function cli(args, { dir, env = {}, timeout } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    timeout,
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, signal: r.signal, out: r.stdout || '', err: r.stderr || '' };
}

/** A stand-in vendor CLI good enough for doctor's --version / models / login status probes. */
function fakeBin(dir, name = 'fake-vendor') {
  const p = join(dir, name);
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    "if (a[0] === 'models') { console.log('model-a'); process.exit(0); }",
    "if (a[0] === 'login' && a[1] === 'status') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }",
    "console.error('unexpected argv: ' + a.join(' '));",
    'process.exit(1);',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** A vendor CLI whose real run replaces its own probe directory with a symlink to `target`. */
function symlinkingProbeBin(dir, name, target) {
  const p = join(dir, name);
  writeFileSync(p, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    "if (a[0] === 'models') { console.log('model-a'); process.exit(0); }",
    "if (a[0] === 'login' && a[1] === 'status') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }",
    'const cwd = process.cwd();',
    "process.chdir('/');",
    'fs.rmdirSync(cwd);',
    `fs.symlinkSync(${JSON.stringify(target)}, cwd);`,
    "console.log('done');",
    'process.exit(0);',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** grok registered as OURS, so the probe's "enabled AND registered" gate opens for it. */
function registerGrok(dir) {
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-grok': { command: 'node', args: [join(ROOT, 'servers', 'grok.mjs')] } },
  }));
}

// ─── C3 ─────────────────────────────────────────────────────────────────────

test('writeFleetConfig: a pre-existing REGULAR file at the predictable temp name is refused, never truncated, never removed (C3, core/config.mjs direct)', () => {
  const dir = tmp();
  const env = { OMELETTE_HOME: dir };
  mkdirSync(dir, { recursive: true });
  const path = configPath(env);
  // In-process, so process.pid IS the pid writeFleetConfig will use — no
  // subprocess or preload trick is needed to know the name in advance.
  const tmpName = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpName, 'SENTINEL-LEFTOVER-NOT-A-LINK');
  assert.throws(
    () => writeFleetConfig({ grok: { timeoutS: 300 } }, env),
    (e) => e instanceof Error
      && new RegExp(`^cannot write .*: temporary file .*\\.${process.pid}\\.tmp already exists$`).test(e.message),
  );
  // The leftover regular file is neither truncated nor removed…
  assert.equal(readFileSync(tmpName, 'utf8'), 'SENTINEL-LEFTOVER-NOT-A-LINK');
  // …and the real config was never created.
  assert.equal(existsSync(path), false, 'writeFleetConfig created the target despite the refusal');
});

test('install: a dangling link where fleet.config.json should be, OUTSIDE the fleet home, is refused — the outside target is never created (C3)',
  { skip: isWin && 'POSIX symlinks' }, () => {
    const dir = tmp();
    const outside = tmp('omelette-fix10-outside-');
    const victim = join(outside, 'nested', 'install.txt');
    mkdirSync(dirname(victim), { recursive: true });
    symlinkSync(victim, join(dir, 'fleet.config.json'));
    const fake = fakeBin(dir, 'codex');
    const r = cli(['install', '--units', 'codex'], {
      dir, env: { PATH: join(dir, 'empty'), CODEX_BIN: fake },
    });
    assert.notEqual(r.code, 0, r.out + r.err);
    assert.match(r.out, /^config {2}FAILED to write .*fleet\.config\.json: EEXIST/m, r.out);
    assert.equal(existsSync(victim), false, 'the dangling link outside the home was followed and its target created');
    assert.equal(existsSync(dirname(victim)), true, 'the directory we made to hold the victim should still be there');
    assert.equal(lstatSync(join(dir, 'fleet.config.json')).isSymbolicLink(), true, 'the link itself was removed or replaced');
  });

// ─── C5 ─────────────────────────────────────────────────────────────────────

test('doctor --probe-sandbox: a decoy directory the probed process points a replacement symlink at keeps its own mode AND keeps existing (C5, independent drive)',
  { skip: isWin && 'POSIX symlinks and modes' }, () => {
    const dir = tmp();
    const gone = join(dir, 'no-such-vendor-cli');
    const decoy = join(dir, 'unrelated-target-dir');
    mkdirSync(decoy);
    chmodSync(decoy, 0o755);
    const before = lstatSync(decoy).mode & 0o777;
    const fake = symlinkingProbeBin(dir, 'symlink-swap-cli', decoy);
    registerGrok(dir);
    const r = cli(['doctor', '--probe-sandbox'], {
      dir, env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone }, timeout: 20000,
    });
    assert.match(r.out, /sandbox\s+BREACHED — \S+ directory was removed or replaced/, r.out + r.err);
    assert.equal(existsSync(decoy), true, 'cleanup removed what the replacement link pointed at, not just the link');
    assert.equal(lstatSync(decoy).mode & 0o777, before, 'cleanup chmodded the decoy target instead of leaving it alone');
  });

// ─── C7 ─────────────────────────────────────────────────────────────────────

test('doctor: a FIFO skill file together with .mcp.json linked to /dev/zero — doctor comes back within 5s, exit 0, and names both as unreadable (C7)',
  (t) => {
    if (isWin) return t.skip('POSIX FIFOs and devices');
    const dir = tmp();
    const proj = join(dir, 'proj');
    const skillPath = join(proj, '.claude', 'skills', 'omelette-test', 'SKILL.md');
    const mcpPath = join(proj, '.mcp.json');
    mkdirSync(dirname(skillPath), { recursive: true });
    if (spawnSync('mkfifo', [skillPath], { encoding: 'utf8' }).status !== 0) return t.skip('mkfifo is unavailable here');
    symlinkSync('/dev/zero', mcpPath);
    // PATH is empty: no vendor CLI, no `claude`, no `gh` — the only thing that
    // could hold this run is one of the two files planted above.
    const empty = join(dir, 'empty-path');
    mkdirSync(empty, { recursive: true });
    const t0 = Date.now();
    const r = cli(['doctor'], { dir: proj, env: { HOME: dir, OMELETTE_HOME: dir, PATH: empty }, timeout: 20000 });
    const elapsed = Date.now() - t0;
    assert.equal(r.signal, null, `doctor was killed by the harness timeout:\n${r.out}${r.err}`);
    assert.ok(elapsed < 5000, `doctor took ${elapsed} ms — expected well under 5 s`);
    assert.equal(r.code, 0, `${r.out}${r.err}`);
    assert.match(r.out, /^skills {8}project: absent/m, r.out);
    assert.match(r.out, /^mcp\.json {6}\S+\.mcp\.json \(not a regular file, or unreadable — not consulted\)$/m, r.out);
  });

test('update --check: a FIFO at the managed guard hook path does not hold the command — it returns within 5s (C7, update path)',
  (t) => {
    if (isWin) return t.skip('POSIX FIFOs');
    const pkgRoot = tmp('omelette-fix10-pkgroot-');
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'omelette-fleet', version: '9.9.9' }));
    const dir = tmp();
    const proj = join(dir, 'proj');
    const hookPath = join(proj, '.claude', 'hooks', 'omelette-guard.mjs');
    mkdirSync(dirname(hookPath), { recursive: true });
    if (spawnSync('mkfifo', [hookPath], { encoding: 'utf8' }).status !== 0) return t.skip('mkfifo is unavailable here');
    const t0 = Date.now();
    const r = cli(['update', '--check'], {
      dir: proj, env: { HOME: dir, OMELETTE_HOME: dir, OMELETTE_PKG_ROOT: pkgRoot }, timeout: 20000,
    });
    const elapsed = Date.now() - t0;
    assert.equal(r.signal, null, `update --check was killed by the harness timeout:\n${r.out}${r.err}`);
    assert.ok(elapsed < 5000, `update --check took ${elapsed} ms — expected well under 5 s`);
    // 0 (no update) or 3 (update available) are both "it answered"; anything
    // else (a thrown stack, a non-zero from an unrelated failure) is a miss.
    assert.ok(r.code === 0 || r.code === 3, `${r.out}${r.err}`);
  });

// ─── C11 ────────────────────────────────────────────────────────────────────

test('shellWord: bare where a POSIX shell reads the word as itself, quoted otherwise', () => {
  assert.equal(shellWord('/usr/local/bin/node', 'darwin'), '/usr/local/bin/node');
  assert.equal(shellWord('/usr/local/bin/node', 'linux'), '/usr/local/bin/node');
  assert.equal(shellWord('a path with spaces/server.mjs', 'linux'), "'a path with spaces/server.mjs'");
  assert.equal(shellWord('$HOME/server.mjs', 'linux'), "'$HOME/server.mjs'");
  assert.equal(shellWord("it's/server.mjs", 'linux'), "'it'\\''s/server.mjs'");
  assert.equal(shellWord('say "hi"/server.mjs', 'linux'), '\'say "hi"/server.mjs\'');
  assert.equal(shellWord('', 'linux'), "''");
  assert.equal(shellWord('/tmp/café/☺.mjs', 'linux'), "'/tmp/café/☺.mjs'");
  // win32: quoting path uses double quotes, not single.
  assert.equal(shellWord('a b/server.mjs', 'win32'), '"a b/server.mjs"');
  assert.equal(shellWord('/usr/local/bin/node', 'win32'), '/usr/local/bin/node');
});

test('install: a printed registration quotes a server path when the FLEET HOME itself holds a space, and the quoted line round-trips through a POSIX shell (C11)',
  { skip: isWin && 'POSIX quoting' }, () => {
    // The space lives in the temp HOME's own name, not in an extra segment
    // added under it — a different construction from any spaced-path fixture
    // already in the suite, so a copy of the package sits directly inside it.
    const dir = mkdtempSync(join(tmpdir(), 'omelette fix10 home '));
    const pkg = join(dir, 'pkgcopy');
    for (const part of ['bin', 'core', 'units', 'servers', 'examples', 'rules', 'agents', 'skills', 'hooks', 'package.json']) {
      cpSync(join(ROOT, part), join(pkg, part), { recursive: true });
    }
    const fake = fakeBin(dir, 'codex');
    const server = join(realpathSync(pkg), 'servers', 'codex.mjs');
    const empty = join(dir, 'empty-path');
    mkdirSync(empty, { recursive: true });
    const run = (args) => spawnSync(process.execPath, [join(pkg, 'bin', 'omelette-fleet.mjs'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: empty, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', CODEX_BIN: fake },
    });
    const r = run(['install', '--units', 'codex']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const line = r.stdout.split('\n').find((l) => l.includes('claude mcp add'));
    assert.ok(line, r.stdout);
    assert.equal(line, `  claude mcp add -s user omelette-codex -- node ${shellWord(server)}`, r.stdout);
    // What the operator would paste: the server path is ONE argument.
    const words = spawnSync('sh', ['-c', `set -- ${line.trim().slice('claude '.length)}; printf '%s\\n' "$@"`], { encoding: 'utf8' });
    assert.equal(words.status, 0, words.stdout + words.stderr);
    assert.equal(words.stdout.trim().split('\n').pop(), server, words.stdout + words.stderr);
  });
