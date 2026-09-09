/**
 * omelette-fleet :: test/tester-0.3.5-p3-review.test.mjs
 *
 * Independent coverage for the uncommitted 0.3.5 re-review diff on top of
 * `feat/0.3.5` (spec: docs/superpowers/specs/2026-09-09-0.3.5-design.md, §2
 * `doctor --probe-sandbox`). The diff's own tests (test/cli.test.mjs) already
 * cover the probe's own deadline race, failed/empty replies, the directory
 * itself as evidence (removed / replaced by a symlink), a relative
 * OMELETTE_HOME resolved before the chdir, a temp dir that cannot be
 * created, and a registration that is not ours.
 *
 * Two behaviours promised by `probeRuntimeEnv` and the new
 * "could not inspect" skip branch were NOT exercised by that diff:
 *
 * 1. A relative `<UNIT>_BIN` (one WITH a path separator) is resolved to an
 *    absolute path against the operator's own cwd before the probe chdir's
 *    into its own throwaway directory — every existing test only ever hands
 *    the probe an already-absolute bin path, so a regression here (spawning
 *    the relative path unresolved, which fails once cwd has moved) would go
 *    unnoticed.
 * 2. A probe directory the run answered from, but that this process can no
 *    longer read afterwards, is `skipped (could not inspect: …)` — never
 *    `held` (nothing was proven) and never `BREACHED` (no entry was ever
 *    seen).
 *
 * Everything here runs the real CLI as a child process, exactly like
 * test/cli.test.mjs, against fake vendor binaries — no real vendor CLI, no
 * network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** A fresh fleet home per test; HOME follows it so nothing leaks into the real one. */
function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-p3-'));
}

/** Run the CLI as a child process, the way an operator would. */
function cli(args, { dir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/** grok registered as OURS, so the probe's "enabled AND registered" gate opens for it. */
function registerOurs(dir, units) {
  const mcpServers = {};
  for (const u of units) mcpServers[`omelette-${u}`] = { command: 'node', args: [join(ROOT, 'servers', `${u}.mjs`)] };
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers }));
}

/**
 * A fake vendor CLI answering doctor's own `--version` / `models` / `login
 * status` probes first, then `body` — a real run's own script, written with
 * `fs`, `p` (path) and `cwd` (this child's own process.cwd() at the time it
 * ran, which is the probe directory once doctor has stood in it) already in
 * scope.
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

test('doctor --probe-sandbox: a relative <UNIT>_BIN (with a path separator) still spawns after the probe stands in its own directory', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  mkdirSync(join(dir, 'fakebins'), { recursive: true });
  // Written under `dir`, and referenced ONLY as a path relative to `dir` — the
  // CLI's own cwd (per `cli()` above) — never as an absolute path. If the
  // probe spawned it after chdir'ing into its throwaway directory without
  // first resolving this against the ORIGINAL cwd, the vendor process would
  // not exist at that relative path any more and the call would fail to spawn.
  const rel = 'fakebins/relgrok';
  probeScript(dir, rel, ["console.log('refused');", 'process.exit(0);'].join('\n'));
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: rel, CODEX_BIN: gone } });
  // "held", specifically for grok, is already proof it was neither skipped
  // (a spawn failure from the unresolved relative path) nor breached; gemini
  // and codex are legitimately skipped elsewhere in the same report, since
  // neither is registered in this fixture.
  assert.match(r.out, /── grok[\s\S]*?sandbox\s+held \(\d+ s, replied "refused"\)/, r.out + r.err);
  assert.doesNotMatch(r.out, /BREACHED/);
  assert.equal(r.code, 0, r.out);
});

test('doctor --probe-sandbox: a relative <UNIT>_BIN without any separator is left for PATH, and still resolves', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const path = probeScript(dir, 'barename-cli', ["console.log('refused');", 'process.exit(0);'].join('\n'));
  registerOurs(dir, ['grok']);
  // A bare command name is not a path `probeRuntimeEnv` touches — it stays
  // exactly as the operator set it, and PATH (unaffected by the probe's own
  // chdir) is what has to find it.
  const r = cli(['doctor', '--probe-sandbox'], {
    dir,
    env: { AGY_BIN: gone, GROK_BIN: 'barename-cli', CODEX_BIN: gone, PATH: `${dirname(path)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` },
  });
  assert.match(r.out, /── grok[\s\S]*?sandbox\s+held \(\d+ s, replied "refused"\)/, r.out + r.err);
  assert.equal(r.code, 0, r.out);
});

test('doctor --probe-sandbox: a probe directory this process can no longer read is skipped as "could not inspect", never held or BREACHED', (t) => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const leftBehind = [];
  const fake = probeScript(dir, 'lockdown-cli', [
    // Ownership, not the current mode bits, governs chmod — the run can still
    // strip its own directory's read/execute bits, the same way an unusually
    // strict sandbox or a race with another process could leave doctor
    // looking at a directory it can no longer list.
    'try { fs.chmodSync(cwd, 0o000); } catch (e) { console.error(String(e)); }',
    "console.log('refused');",
    'process.exit(0);',
  ].join('\n'));
  registerOurs(dir, ['grok']);
  let r;
  try {
    r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone } });
  } finally {
    // Doctor's own cleanup only logs when it cannot remove a locked directory
    // (bin/omelette-fleet.mjs's probeUnit, `finally` block) — put the
    // permissions back so this run does not leave 0000 debris in the OS temp
    // dir for whoever cleans it next.
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith('omelette-probe-grok-')) continue;
      const p = join(tmpdir(), name);
      leftBehind.push(p);
      try { chmodSync(p, 0o700); rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  if (!/skipped \(could not inspect:/.test(r.out) && leftBehind.length === 0) {
    return t.skip('chmod 0o000 did not block this process from reading its own directory here');
  }
  assert.match(r.out, /── grok[\s\S]*?sandbox\s+skipped \(could not inspect: [^\n]+\)/, r.out + r.err);
  assert.doesNotMatch(r.out, /sandbox\s+held/, r.out);
  assert.doesNotMatch(r.out, /BREACHED/, r.out);
  assert.equal(r.code, 0, r.out);
});
