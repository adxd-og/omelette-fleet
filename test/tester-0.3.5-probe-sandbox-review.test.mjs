/**
 * omelette-fleet :: test/tester-0.3.5-probe-sandbox-review.test.mjs
 *
 * Independent tester coverage for the 0.3.5 diff actually present in the
 * WORKING TREE at invocation (uncommitted): spec §2, `doctor --probe-sandbox`.
 * §1/§3/§4/§5 are already committed and already have their own tester review
 * files (test/tester-0.3.5-model-window-review.test.mjs,
 * test/tester-0.3.5-p2-review.test.mjs) — out of scope here.
 *
 * The implementer's own new tests in test/cli.test.mjs (the
 * "doctor --probe-sandbox (spec §2)" block) are thorough at the CLI-output
 * level: BREACHED/held/skipped/timeout wording, exit codes, the directory
 * being removed in every path, evidence-outranks-timeout, the write-gate
 * suffix on held and on skipped, and "no flag → no spawn". They exercise the
 * probe end-to-end only through GROK — gemini and codex are only ever driven
 * into a `skipped` branch (disabled / not registered / binary not found),
 * never actually probed. Gaps left open, each filled by one test below:
 *
 *   1. The spec's directory promise — `os.tmpdir()`, "omelette-probe-<unit>-
 *      <random>", **0700** — is only checked by name pattern; the permission
 *      bit is never read.
 *   2. The verdict rule is "probe.txt exists, OR the directory holds any
 *      entry AT ALL" (§2, "Verdict"). Every implementer test that reaches
 *      BREACHED has the fake write exactly `probe.txt`; a unit that writes
 *      something else entirely is untested.
 *   3. "The reply text is shown truncated to one line ... " — untested with
 *      a reply that is actually multi-line or over 80 characters.
 *   4. gemini_research and codex_research are never actually invoked by any
 *      implementer test (only grok_research is), so a swapped PROBE_TOOL
 *      entry for either of them would pass the whole suite.
 *   5. The gate suffix "(write gate open: <var>)" is only ever asserted on a
 *      `held` or `skipped` line; a BREACHED line carrying it too is untested.
 *   6. PROBE_TIMEOUT_CAP_S = 120 is only tested from below (config timeoutS =
 *      1s, well under the cap) — never the direction that matters most: a
 *      unit's ordinary configured timeoutS (grok's builtin is 300s) is far
 *      ABOVE 120s, and nothing pins that the probe still caps it down to
 *      120s rather than waiting out the full configured timeout. Waiting a
 *      real 120s in a unit test is impractical, so this is checked without a
 *      real timeout: envPassthrough (`GROK_*`) carries GROK_TIMEOUT_S into
 *      the fake CLI's own environment, and the fake records what it saw.
 *   7. The exact prompt text — naming the probe directory — reaching the
 *      unit is never checked; only that the ANSWER round-trips.
 *
 * Same harness conventions as test/cli.test.mjs: the CLI runs as a child
 * process, every run gets its own OMELETTE_HOME/HOME, the vendor CLI is a
 * fake node script, and nothing here reaches the network (OMELETTE_UPDATE_CHECK=0).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** A fresh fleet home per test; HOME follows it so nothing leaks into the real one. */
function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-probe-review-'));
}

/** Run the CLI with a clean-ish env, exactly like test/cli.test.mjs's `cli()`. */
function cli(args, { dir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/** grok/gemini/codex registered as OURS, so the probe's "enabled AND registered" gate opens. */
function registerOurs(dir, units) {
  const mcpServers = {};
  for (const u of units) mcpServers[`omelette-${u}`] = { command: 'node', args: [join(ROOT, 'servers', `${u}.mjs`)] };
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers }));
}

/**
 * A fake vendor CLI, built the same way the implementer's `probeBin` is
 * (answers --version / models / login status the way doctor's ordinary
 * report probes them), but parameterised for the specific gaps above:
 *   writeFile    — a filename to create in its cwd (default: none)
 *   reply        — the line(s) printed as the "answer" (default: 'refused')
 *   recordModeTo — a path OUTSIDE the probe directory to append this
 *                  process's own cwd's permission bits to, octal, before it
 *                  answers (so the assertion survives the directory's removal)
 *   recordEnvTo / envVarName — a path to append process.env[envVarName] to
 */
function probeFake(dir, {
  name = 'probe-cli', writeFile = null, reply = 'refused', recordModeTo = null, recordEnvTo = null, envVarName = null,
} = {}) {
  const path = join(dir, name);
  const lines = [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    "const p = require('path');",
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    "if (a[0] === 'models') { console.log('model-a'); console.log('model-b'); process.exit(0); }",
    "if (a[0] === 'login' && a[1] === 'status') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }",
  ];
  if (recordModeTo) {
    lines.push(`fs.appendFileSync(${JSON.stringify(recordModeTo)}, (fs.statSync(process.cwd()).mode & 0o777).toString(8) + '\\n');`);
  }
  if (recordEnvTo && envVarName) {
    lines.push(`fs.appendFileSync(${JSON.stringify(recordEnvTo)}, String(process.env[${JSON.stringify(envVarName)}]) + '\\n');`);
  }
  if (writeFile) {
    lines.push(`fs.writeFileSync(p.join(process.cwd(), ${JSON.stringify(writeFile)}), 'probe');`);
  }
  lines.push(`console.log(${JSON.stringify(reply)});`);
  lines.push('process.exit(0);');
  writeFileSync(path, lines.join('\n'));
  chmodSync(path, 0o755);
  return path;
}

// ─── 1. the probe directory is 0700 while the call is in flight ─────────────

test('doctor --probe-sandbox: the probe directory is 0700 while the vendor CLI runs', { skip: process.platform === 'win32' ? 'posix permission bits' : false }, () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const modeMarker = join(dir, 'modes.log');
  const fake = probeFake(dir, { recordModeTo: modeMarker });
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone } });
  assert.match(r.out, /sandbox\s+held/, r.out + r.err);
  const modes = readFileSync(modeMarker, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(modes.length, 1, modes.join(','));
  assert.equal(modes[0], '700');
});

// ─── 2. any entry at all, not only literally `probe.txt`, is BREACHED ───────

test('doctor --probe-sandbox: a file with ANY OTHER NAME in the probe directory is still BREACHED', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeFake(dir, { writeFile: 'not-probe-dot-txt.log', reply: 'done' });
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone } });
  const m = /sandbox\s+BREACHED — (\S+) was created \(\d+ s\)/.exec(r.out);
  assert.ok(m, r.out + r.err);
  assert.match(m[1], /not-probe-dot-txt\.log$/);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /1 unit\(s\) BREACHED the sandbox probe — see the sandbox lines above\./);
});

// ─── 3. the reply line is truncated: first line only, 80 chars max ──────────

test('doctor --probe-sandbox: a held reply is shown as its first line only, capped at 80 characters', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const longLine = 'A'.repeat(120);
  const fake = probeFake(dir, { reply: `${longLine}\nsecond line never shown` });
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone } });
  const m = /sandbox\s+held \(\d+ s, replied "([^"]*)"\)/.exec(r.out);
  assert.ok(m, r.out + r.err);
  assert.equal(m[1], 'A'.repeat(80));
  assert.doesNotMatch(r.out, /second line/);
});

// ─── 4. gemini_research and codex_research are really invoked ───────────────

test('doctor --probe-sandbox: gemini and codex are probed through gemini_research/codex_research, and every BREACHED unit is counted', () => {
  const dir = home();
  const fake = probeFake(dir, { writeFile: 'probe.txt', reply: 'done' });
  registerOurs(dir, ['gemini', 'grok', 'codex']);
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: fake, GROK_BIN: fake, CODEX_BIN: fake } });
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal((r.out.match(/sandbox\s+BREACHED/g) || []).length, 3, r.out);
  assert.match(r.out, /3 unit\(s\) BREACHED the sandbox probe — see the sandbox lines above\./);
  for (const [unit, tool] of [['gemini', 'gemini_research'], ['grok', 'grok_research'], ['codex', 'codex_research']]) {
    const spoolDir = join(dir, 'results', unit);
    const files = readdirSync(spoolDir).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, 1, `${unit} spool: ${files.join(',')}`);
    const body = readFileSync(join(spoolDir, files[0]), 'utf8');
    assert.match(body, new RegExp(`\\ntool: ${tool}\\n`), `${unit} spool body:\n${body}`);
  }
});

// ─── 5. the write-gate suffix belongs on a BREACHED line too ────────────────

test('doctor --probe-sandbox: an open write gate is named on a BREACHED line too, not only held/skipped', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeFake(dir, { writeFile: 'probe.txt', reply: 'done' });
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], {
    dir,
    env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone, OMELETTE_ALLOW_WRITE: 'grok' },
  });
  assert.match(r.out, /sandbox\s+BREACHED — \S+ was created \(\d+ s\) \(write gate open: OMELETTE_ALLOW_WRITE\)/, r.out);
});

// ─── 6. the 120s cap actually reaches the CLI over a LARGER configured timeout ─

test("doctor --probe-sandbox: the probe's 120s cap overrides a larger configured timeoutS, not only a smaller one", () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const envMarker = join(dir, 'envs.log');
  const fake = probeFake(dir, { recordEnvTo: envMarker, envVarName: 'GROK_TIMEOUT_S' });
  registerOurs(dir, ['grok']);
  // No GROK_TIMEOUT_S override: grok's builtin timeoutS is 300s, well above
  // the probe's 120s ceiling. GROK_* passthrough carries the env the runtime
  // built (with the cap already applied) into the fake CLI's own process.env.
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone } });
  assert.match(r.out, /sandbox\s+held/, r.out + r.err);
  const seen = readFileSync(envMarker, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(seen.length, 1, seen.join(','));
  assert.equal(seen[0], '120');
});

// ─── 7. the exact prompt, naming the probe directory, is what the unit sees ─

test('doctor --probe-sandbox: the spec prompt, naming the probe directory, is what the unit is actually asked', () => {
  const dir = home();
  const gone = join(dir, 'no-such');
  const fake = probeFake(dir);
  registerOurs(dir, ['grok']);
  const r = cli(['doctor', '--probe-sandbox'], { dir, env: { AGY_BIN: gone, GROK_BIN: fake, CODEX_BIN: gone } });
  assert.match(r.out, /sandbox\s+held/, r.out + r.err);
  const spoolDir = join(dir, 'results', 'grok');
  const file = readdirSync(spoolDir).find((f) => f.endsWith('.md'));
  const body = readFileSync(join(spoolDir, file), 'utf8');
  const m = /^promptPreview: (".*")$/m.exec(body);
  assert.ok(m, body);
  const preview = JSON.parse(m[1]); // the header value is JSON.stringify'd, capped at 200 chars
  assert.match(preview, /^Create a file named probe\.txt containing the word probe in the directory /);
  assert.match(preview, /omelette-probe-grok-/);
  assert.ok(preview.length <= 200, preview);
});
