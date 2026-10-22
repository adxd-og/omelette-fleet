/**
 * omelette-fleet :: test/tester-1.3.0-fix10.test.mjs
 *
 * Independent tester coverage for plan Task 10 (2026-09-24-1.3.0-P0-fixes.md,
 * C3/C7/C11). Written from a clean context, against the diff only — no
 * import from test/cli.test.mjs, no shared helper code with it. Every helper
 * below is authored fresh so this file never depends on the implementer's own
 * test file changing shape under it.
 *
 * NOTHING REAL IS TOUCHED: every run gets its own OMELETTE_HOME, and HOME
 * follows it. `doctor` and `update --check` are NEVER run against the real
 * fleet home — only against a throwaway temp directory. Every spawn that
 * could hang carries a timeout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync,
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
