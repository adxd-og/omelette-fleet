/**
 * omelette-fleet :: test/doctor-timeouts.test.mjs
 * The two client timeout walls `doctor` reports (spec 2026-09-08-0.3.3-design,
 * section 1c). The CLI is driven as a CHILD PROCESS, like every other CLI test
 * here: bin/omelette-fleet.mjs runs main() at import, and its exit code is only
 * real when a process actually produced it.
 *
 * Every run gets its own OMELETTE_HOME and its own HOME, the vendor binaries
 * point at paths that do not exist (so no probe is spawned and no unit can be a
 * fault), and the update check is off — nothing here touches the network, the
 * real fleet home or the operator's Claude Code settings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** A fresh fleet home + HOME per test; a project directory inside it. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-walls-'));
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  return { dir, proj };
}

/**
 * A stand-in vendor CLI, for the one test that needs a unit to be enabled AND
 * registered AND healthy: without a binary that answers, doctor would call the
 * pair a FAULT and exit 1, which has nothing to do with a timeout wall.
 * `login status` answers on stderr, where the real codex CLI puts it.
 */
function fakeBin(dir, name = 'fake-cli') {
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

/** `doctor` in the project, with no vendor binary anywhere: no probes, no faults. */
function doctor({ dir, proj }, { args = [], env = {} } = {}) {
  const gone = join(dir, 'no-such-cli');
  const r = spawnSync(process.execPath, [BIN, 'doctor', ...args], {
    cwd: proj,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0',
      AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone, ...env,
    },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/**
 * The `mcp timeout` block, label column stripped — read by CONTENT, never by
 * position, so a line added above another one does not rewrite these tests.
 */
function timeoutBlock(out) {
  const lines = out.split('\n');
  const i = lines.findIndex((l) => l.startsWith('mcp timeout   '));
  if (i < 0) return [];
  const block = [lines[i].slice(14)];
  for (let j = i + 1; j < lines.length && lines[j].startsWith('              '); j++) block.push(lines[j].slice(14));
  return block;
}

const lineStartingWith = (out, head) => timeoutBlock(out).find((l) => l.startsWith(head));

const writeConfig = (dir, config) => writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, ...config }));

const writeSettings = (root, body) => {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(body, null, 2));
};

const writeLocalSettings = (root, body) => {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify(body, null, 2));
};

const IDLE = 'CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT';

test('doctor reads a client env var in Claude Code\'s own precedence: process env, local, project, user', () => {
  const s = sandbox();
  // grok at 600 s so no state below trips the "reaches it" clause and the line
  // stays about the SOURCE, which is what this test is for.
  writeConfig(s.dir, { units: { gemini: { enabled: false }, codex: { enabled: false }, grok: { timeoutS: 600 } } });

  // Nothing anywhere: the documented default, and no source to name.
  assert.equal(
    lineStartingWith(doctor(s).out, 'idle:'),
    `idle: ${IDLE} unset → 30 min default; the longest run is grok.timeoutS=600 s · ok`,
  );

  // The user scope is the last file read. Its path comes from homedir(), which
  // is $HOME verbatim, while a project path arrives through process.cwd() and is
  // already resolved — hence realpathSync on one and not on the other.
  writeSettings(s.dir, { env: { [IDLE]: '3600000' } });
  const user = join(s.dir, '.claude', 'settings.json');
  assert.equal(
    lineStartingWith(doctor(s).out, 'idle:'),
    `idle: ${IDLE}=3600000 ms (${user} env) → 60 min; the longest run is grok.timeoutS=600 s · ok`,
  );

  // …the project's settings.json beats it…
  writeSettings(s.proj, { env: { [IDLE]: '2700000' } });
  const project = join(realpathSync(s.proj), '.claude', 'settings.json');
  assert.equal(
    lineStartingWith(doctor(s).out, 'idle:'),
    `idle: ${IDLE}=2700000 ms (${project} env) → 45 min; the longest run is grok.timeoutS=600 s · ok`,
  );

  // …settings.local.json beats that…
  writeLocalSettings(s.proj, { env: { [IDLE]: '2400000' } });
  const local = join(realpathSync(s.proj), '.claude', 'settings.local.json');
  assert.equal(
    lineStartingWith(doctor(s).out, 'idle:'),
    `idle: ${IDLE}=2400000 ms (${local} env) → 40 min; the longest run is grok.timeoutS=600 s · ok`,
  );

  // …and the process environment beats every file.
  assert.equal(
    lineStartingWith(doctor(s, { env: { [IDLE]: '1200000' } }).out, 'idle:'),
    `idle: ${IDLE}=1200000 ms (process env) → 20 min; the longest run is grok.timeoutS=600 s · ok`,
  );

  // A settings file that is not JSON, or whose env is not an object, is skipped
  // rather than crashing the report — and it is never written.
  writeFileSync(join(s.proj, '.claude', 'settings.local.json'), '{ not json');
  assert.equal(
    lineStartingWith(doctor(s).out, 'idle:'),
    `idle: ${IDLE}=2700000 ms (${project} env) → 45 min; the longest run is grok.timeoutS=600 s · ok`,
  );
});

test('doctor: the idle wall has four states — unset, 0, an explicit window, and a value that is not milliseconds', () => {
  const s = sandbox();
  // grok at 1800 s reaches the 30 min default exactly; that is the incident case.
  writeConfig(s.dir, { units: { gemini: { enabled: false }, codex: { enabled: false }, grok: { timeoutS: 1800 } } });
  const reaches = `${IDLE}=0 or a per-server "timeout"`;

  assert.equal(
    lineStartingWith(doctor(s).out, 'idle:'),
    `idle: ${IDLE} unset → 30 min default; grok.timeoutS=1800 s reaches it — units send progress every 30 s when the client passes a progress token; otherwise set ${reaches}`,
  );

  assert.equal(
    lineStartingWith(doctor(s, { env: { [IDLE]: '0' } }).out, 'idle:'),
    `idle: ${IDLE}=0 (process env) → disabled · ok`,
  );

  assert.equal(
    lineStartingWith(doctor(s, { env: { [IDLE]: '3600000' } }).out, 'idle:'),
    `idle: ${IDLE}=3600000 ms (process env) → 60 min; the longest run is grok.timeoutS=1800 s · ok`,
  );

  assert.equal(
    lineStartingWith(doctor(s, { env: { [IDLE]: '600000' } }).out, 'idle:'),
    `idle: ${IDLE}=600000 ms (process env) → 10 min; grok.timeoutS=1800 s reaches it — units send progress every 30 s when the client passes a progress token; otherwise set ${reaches}`,
  );

  // "30m" is not a bound the client understands; saying "unset" about it would
  // be a lie, and treating it as a number would be a guess.
  assert.equal(
    lineStartingWith(doctor(s, { env: { [IDLE]: '30m' } }).out, 'idle:'),
    `idle: ${IDLE}=30m (process env) is not a whole number of ms — ignored, 30 min default; grok.timeoutS=1800 s reaches it — units send progress every 30 s when the client passes a progress token; otherwise set ${reaches}`,
  );
});

test('doctor: the timeout block is informational — exit code unchanged, and nothing at all with every unit disabled', () => {
  const s = sandbox();
  writeConfig(s.dir, { units: { gemini: { timeoutS: 300 }, grok: { timeoutS: 1800 }, codex: { timeoutS: 600 } } });

  const on = doctor(s, { env: { [IDLE]: '60000' } });
  assert.equal(on.code, 0, on.out);
  assert.ok(timeoutBlock(on.out).length >= 1, on.out);
  assert.doesNotMatch(on.out, /FAULT/);
  assert.match(on.out, /No faults in units that are both enabled and registered\./);

  // No enabled unit, no call to bound: the block is absent rather than empty.
  writeConfig(s.dir, { units: { gemini: { enabled: false }, grok: { enabled: false }, codex: { enabled: false } } });
  const off = doctor(s);
  assert.equal(off.code, 0, off.out);
  assert.deepEqual(timeoutBlock(off.out), []);
  assert.doesNotMatch(off.out, /^mcp timeout/m);
});

const WALL = 'MCP_TOOL_TIMEOUT';

test('doctor: the wall-clock line compares MCP_TOOL_TIMEOUT with what the longest enabled unit can take', () => {
  const s = sandbox();
  // grok 1800 s is the largest bound; gemini's 300 s counts as 360 s because
  // its hard kill sits 60 s above the timeout it hands agy.
  writeConfig(s.dir, { units: { gemini: { timeoutS: 300 }, grok: { timeoutS: 1800 }, codex: { timeoutS: 600 } } });

  // Unset: the client's documented default, which nothing here reaches.
  assert.equal(
    lineStartingWith(doctor(s).out, 'wall-clock:'),
    `wall-clock: ${WALL} unset (default ~28 h) ≥ 1800000 needed · ok`,
  );

  // Set and generous.
  assert.equal(
    lineStartingWith(doctor(s, { env: { [WALL]: '2000000' } }).out, 'wall-clock:'),
    `wall-clock: ${WALL}=2000000 ms (process env) ≥ 1800000 needed · ok`,
  );

  // Set below what one call can take: the incident, in one line, naming the
  // unit whose bound sets the number, plus the snippet and nothing to run.
  const low = doctor(s, { env: { [WALL]: '900000' } });
  assert.equal(low.code, 0, 'a wall is never a fault');
  assert.equal(
    lineStartingWith(low.out, 'wall-clock:'),
    `wall-clock: ${WALL}=900000 ms (process env) < 1800000 needed (grok.timeoutS=1800 s) · TOO LOW`,
  );
  assert.equal(
    lineStartingWith(low.out, 'raise it:'),
    `raise it: {"env":{"${WALL}":"1800000"}} — merge into .claude/settings.json or ~/.claude/settings.json (omelette-fleet never writes them)`,
  );

  // A value the client cannot read is neither "unset" nor a number.
  assert.equal(
    lineStartingWith(doctor(s, { env: { [WALL]: '2000s' } }).out, 'wall-clock:'),
    `wall-clock: ${WALL}=2000s (process env) is not a whole number of ms — ignored, default ~28 h ≥ 1800000 needed · ok`,
  );

  // gemini alone: the +60 s hard-kill margin is what a gemini call can reach.
  writeConfig(s.dir, { units: { gemini: { timeoutS: 900 }, grok: { enabled: false }, codex: { enabled: false } } });
  assert.equal(
    lineStartingWith(doctor(s, { env: { [WALL]: '900000' } }).out, 'wall-clock:'),
    `wall-clock: ${WALL}=900000 ms (process env) < 960000 needed (gemini.timeoutS=900 s + 60 s hard kill) · TOO LOW`,
  );
});

test('doctor: a per-server "timeout" on our registration overrides the env for that server', () => {
  const s = sandbox();
  writeConfig(s.dir, { units: { gemini: { enabled: false }, grok: { enabled: false }, codex: { timeoutS: 600 } } });
  // codex is enabled AND registered here, so it needs a binary that answers or
  // the run is a FAULT and exits 1 for a reason that is not the wall.
  const bin = fakeBin(s.dir, 'fake-codex');
  const at = (env = {}) => doctor(s, { env: { CODEX_BIN: bin, ...env } });
  const server = join(ROOT, 'servers', 'codex.mjs');
  const register = (timeout) => writeFileSync(join(s.dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-codex': { command: 'node', args: [server], ...(timeout === undefined ? {} : { timeout }) } },
  }));

  // No `timeout` field: nothing to say about this server.
  register(undefined);
  const plain = at();
  assert.equal(plain.code, 0, plain.out);
  assert.equal(lineStartingWith(plain.out, 'omelette-codex '), undefined);

  // Generous: it overrides the env, and it is enough.
  register(1200000);
  assert.equal(
    lineStartingWith(at({ [WALL]: '300000' }).out, 'omelette-codex '),
    'omelette-codex "timeout": 1200000 ms (user) overrides it for that server ≥ 600000 needed · ok',
  );

  // Tight: the server caps its own calls below what codex can take, whatever
  // the env says. The shared line stays `ok`, and the next line names the
  // registration rather than the variable.
  register(300000);
  const capped = at({ [WALL]: '2000000' });
  assert.equal(capped.code, 0, capped.out);
  assert.equal(
    lineStartingWith(capped.out, 'omelette-codex '),
    'omelette-codex "timeout": 300000 ms (user) overrides it for that server < 600000 needed (codex.timeoutS=600 s) · TOO LOW',
  );
  assert.match(capped.out, new RegExp('wall-clock: .* · ok'));

  // Below the client's own minimum, or not a number at all: the client ignores
  // the field, so reporting it as a bound would be a lie.
  register(500);
  assert.equal(
    lineStartingWith(at().out, 'omelette-codex '),
    'omelette-codex "timeout": 500 is not an integer ≥ 1000 ms — the client ignores it',
  );
  register('20m');
  assert.equal(
    lineStartingWith(at().out, 'omelette-codex '),
    'omelette-codex "timeout": "20m" is not an integer ≥ 1000 ms — the client ignores it',
  );
});

test('doctor: the deep-research bound is reported while gemini is enabled, and only then', () => {
  const s = sandbox();
  writeConfig(s.dir, { units: { gemini: { timeoutS: 300 }, grok: { enabled: false }, codex: { enabled: false } } });
  assert.equal(
    lineStartingWith(doctor(s).out, 'deep research:'),
    'deep research: gemini_deep_research worst case: 3 stages × 2 attempts × (300 + 60 s) = 2160 s · within the wall-clock limit',
  );

  // The same bound against a wall it does not fit under: informational, and the
  // docs already say to run that tool deliberately — so still no `next`.
  const tight = doctor(s, { env: { [WALL]: '1000000' } });
  assert.equal(tight.code, 0);
  assert.equal(
    lineStartingWith(tight.out, 'deep research:'),
    'deep research: gemini_deep_research worst case: 3 stages × 2 attempts × (300 + 60 s) = 2160 s · ABOVE the wall-clock limit (1000000 ms) — run it deliberately',
  );

  writeConfig(s.dir, { units: { gemini: { enabled: false }, grok: { enabled: false }, codex: { timeoutS: 600 } } });
  assert.equal(lineStartingWith(doctor(s).out, 'deep research:'), undefined);
});

/** A project wired up to the point where doctor has no first-run step left. */
function wiredProject(s) {
  // codex registered and disabled: `nextStep` needs a registration of ours, and
  // a disabled unit with no binary can never be a fault.
  writeFileSync(join(s.dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-codex': { command: 'node', args: [join(ROOT, 'servers', 'codex.mjs')] } },
  }));
  writeConfig(s.dir, { units: { gemini: { timeoutS: 300 }, grok: { timeoutS: 1800 }, codex: { enabled: false } } });
  const rules = spawnSync(process.execPath, [BIN, 'rules', '--agents', '--hooks'], {
    cwd: s.proj, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: s.dir, OMELETTE_HOME: s.dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  assert.equal(rules.status, 0, rules.stderr);
  return rules.stdout;
}

/** The whole `hooks` object `rules --hooks` printed, however many events it holds. */
function snippetFrom(stdout) {
  const lines = stdout.split('\n');
  const start = lines.indexOf('{ "hooks": {');
  assert.ok(start >= 0, `no snippet in:\n${stdout}`);
  for (let end = start + 1; end <= lines.length; end++) {
    try { return JSON.parse(lines.slice(start, end).join('\n')); } catch { /* keep growing */ }
  }
  throw new Error(`no parseable snippet in:\n${stdout}`);
}

const nextLines = (out) => out.split('\n').filter((l) => l.startsWith('next'));

test('doctor: the timeout next waits for the first-run steps, and never changes the exit code', () => {
  const s = sandbox();
  const printed = wiredProject(s);

  // The guard is on disk and nothing calls it: that step comes first, even
  // though the wall is short.
  const unwired = doctor(s, { env: { [WALL]: '900000' } });
  assert.equal(unwired.code, 0, unwired.out);
  assert.deepEqual(nextLines(unwired.out), ['next          merge the hooks snippet into .claude/settings.json (rules --hooks prints it)']);
  assert.equal(
    lineStartingWith(unwired.out, 'wall-clock:'),
    `wall-clock: ${WALL}=900000 ms (process env) < 1800000 needed (grok.timeoutS=1800 s) · TOO LOW`,
  );

  // Wired: nothing of the first run is left, so the wall is what to do next.
  writeSettings(s.proj, snippetFrom(printed));
  const wired = doctor(s, { env: { [WALL]: '900000' } });
  assert.equal(wired.code, 0, wired.out);
  assert.deepEqual(nextLines(wired.out), [
    `next          raise ${WALL} to 1800000 ms — merge {"env":{"${WALL}":"1800000"}} into your settings file (omelette-fleet never writes it)`,
  ]);

  // A wall that is fine leaves doctor with nothing to say at all.
  const fine = doctor(s, { env: { [WALL]: '2000000' } });
  assert.equal(fine.code, 0, fine.out);
  assert.deepEqual(nextLines(fine.out), []);
});

test('doctor: the whole mcp timeout block, in the order the spec sets', () => {
  const s = sandbox();
  writeConfig(s.dir, { units: { gemini: { timeoutS: 300 }, grok: { timeoutS: 1800 }, codex: { timeoutS: 600 } } });
  assert.deepEqual(timeoutBlock(doctor(s).out), [
    `wall-clock: ${WALL} unset (default ~28 h) ≥ 1800000 needed · ok`,
    'deep research: gemini_deep_research worst case: 3 stages × 2 attempts × (300 + 60 s) = 2160 s · within the wall-clock limit',
    `idle: ${IDLE} unset → 30 min default; grok.timeoutS=1800 s reaches it — units send progress every 30 s when the client passes a progress token; otherwise set ${IDLE}=0 or a per-server "timeout"`,
  ]);

  const low = doctor(s, { env: { [WALL]: '900000' } });
  assert.deepEqual(timeoutBlock(low.out), [
    `wall-clock: ${WALL}=900000 ms (process env) < 1800000 needed (grok.timeoutS=1800 s) · TOO LOW`,
    `raise it: {"env":{"${WALL}":"1800000"}} — merge into .claude/settings.json or ~/.claude/settings.json (omelette-fleet never writes them)`,
    'deep research: gemini_deep_research worst case: 3 stages × 2 attempts × (300 + 60 s) = 2160 s · ABOVE the wall-clock limit (900000 ms) — run it deliberately',
    `idle: ${IDLE} unset → 30 min default; grok.timeoutS=1800 s reaches it — units send progress every 30 s when the client passes a progress token; otherwise set ${IDLE}=0 or a per-server "timeout"`,
  ]);
  assert.equal(low.code, 0, 'the whole block is informational');
});

// ─── an unreadable settings file (P3 · spec 3c) ───────────────────────────────

/** Every `settings: … unreadable` line doctor printed, in order, label column stripped. */
const unreadableLines = (out) => out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('settings: '));

const said = (path) => `settings: ${path} unreadable — env values in it were not consulted`;

test('doctor names a settings file that exists and cannot be parsed — once, however many readers opened it', () => {
  const s = sandbox();
  writeConfig(s.dir, { units: { gemini: { enabled: false }, codex: { enabled: false }, grok: { timeoutS: 600 } } });

  // Nothing broken: nothing said.
  assert.deepEqual(unreadableLines(doctor(s).out), []);

  // A project settings.json with a trailing comma. TWO readers open it — the
  // env lookup behind the wall lines and the hook-wiring report behind the
  // hooks line — and the operator gets ONE line about it.
  mkdirSync(join(s.proj, '.claude'), { recursive: true });
  writeFileSync(join(s.proj, '.claude', 'settings.json'), '{ "env": { "MCP_TOOL_TIMEOUT": "1800000", } }');
  const project = join(realpathSync(s.proj), '.claude', 'settings.json');
  const one = doctor(s);
  assert.equal(one.code, 0, 'an unparseable settings file is never a fault');
  assert.deepEqual(unreadableLines(one.out), [said(project)]);
  // …and it is not pedantry: the wall really did fall back to the client's
  // default, because the value the operator wrote was never read.
  assert.equal(
    lineStartingWith(one.out, 'wall-clock:'),
    `wall-clock: ${WALL} unset (default ~28 h) ≥ 600000 needed · ok`,
  );

  // A second broken file, at the user scope, whose top level is not an object:
  // one line each, still one per file, in the order they are read.
  mkdirSync(join(s.dir, '.claude'), { recursive: true });
  writeFileSync(join(s.dir, '.claude', 'settings.local.json'), '[1, 2]');
  // The user scope's path comes from homedir(), which is $HOME verbatim; the
  // project's arrives through process.cwd() and is already resolved.
  const user = join(s.dir, '.claude', 'settings.local.json');
  assert.deepEqual(unreadableLines(doctor(s).out), [said(project), said(user)]);

  // A file that parses and simply has nothing to say is not "unreadable".
  writeFileSync(join(s.dir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: [] } }));
  assert.deepEqual(unreadableLines(doctor(s).out), [said(project)]);

  // Neither is a file that is not there at all.
  rmSync(join(s.proj, '.claude', 'settings.json'));
  assert.deepEqual(unreadableLines(doctor(s).out), []);
});

test('doctor names the unreadable file even when there is no wall to report', () => {
  const s = sandbox();
  // No enabled unit: `timeoutWalls` answers with an empty report and prints no
  // block at all. The file is still named, because the hook-wiring reader
  // opened it too — which is the whole point of merging the two lists.
  writeConfig(s.dir, { units: { gemini: { enabled: false }, grok: { enabled: false }, codex: { enabled: false } } });
  mkdirSync(join(s.proj, '.claude'), { recursive: true });
  writeFileSync(join(s.proj, '.claude', 'settings.local.json'), 'not json at all');
  const project = join(realpathSync(s.proj), '.claude', 'settings.local.json');

  const r = doctor(s);
  assert.equal(r.code, 0);
  assert.deepEqual(timeoutBlock(r.out), [], 'no enabled unit, no timeout block');
  assert.deepEqual(unreadableLines(r.out), [said(project)]);
  // The hooks line says nothing here — no guard is installed in this sandbox —
  // so this line is the only place the operator learns the file is broken.
  assert.match(r.out, /^hooks {9}project: absent/m);
});
