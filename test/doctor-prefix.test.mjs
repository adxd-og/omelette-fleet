/**
 * omelette-fleet :: test/doctor-prefix.test.mjs
 * `doctor` finding this checkout's servers wherever they are registered, and
 * the hook wiring read as the UNION of a scope's settings files (spec
 * 2026-09-08-0.3.3-design, section 5).
 *
 * The event list is never spelled out here: it comes from HOOK_EVENTS and from
 * the snippet `rules --hooks` prints, so a release that adds an event does not
 * make these tests wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const UNITS = ['gemini', 'grok', 'codex'];
const server = (unit) => join(ROOT, 'servers', `${unit}.mjs`);

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-prefix-'));
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  // Every unit disabled: these tests register servers against a machine with no
  // vendor binaries, and an enabled-and-registered unit whose binary is missing
  // is a FAULT and an exit 1 — which would be about the binary, not the scan.
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({
    version: 1, units: { gemini: { enabled: false }, grok: { enabled: false }, codex: { enabled: false } },
  }));
  return { dir, proj };
}

function run(s, args, env = {}) {
  const gone = join(s.dir, 'no-such-cli');
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: s.proj,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: s.dir, OMELETTE_HOME: s.dir, OMELETTE_UPDATE_CHECK: '0',
      AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone, ...env,
    },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const doctor = (s, args = []) => run(s, ['doctor', ...args]);
const nextLines = (out) => out.split('\n').filter((l) => l.startsWith('next'));
const line = (out, head) => out.split('\n').find((l) => l.startsWith(head));

/** Every unit registered under one prefix, pointing at THIS checkout. */
const ours = (prefix) => Object.fromEntries(UNITS.map((u) => [`${prefix}-${u}`, { type: 'stdio', command: 'node', args: [server(u)] }]));

const writeClaudeJson = (s, body) => writeFileSync(join(s.dir, '.claude.json'), JSON.stringify(body, null, 2));

/**
 * A stand-in vendor CLI for the one test that needs a unit ENABLED as well as
 * registered — the per-server `timeout` line is printed for enabled units only,
 * and an enabled unit with no binary is a FAULT and an exit 1 about the binary.
 */
function fakeBin(dir, name = 'fake-cli') {
  const p = join(dir, name);
  writeFileSync(p, [
    `#!${process.execPath}`,
    'const a = process.argv.slice(2);',
    "if (a[0] === '--version') { console.log('fake-cli 9.9.9'); process.exit(0); }",
    "if (a[0] === 'login' && a[1] === 'status') { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }",
    'process.exit(0);',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

test('doctor adopts the prefix its own servers are actually registered under', () => {
  const s = sandbox();
  // The operator's real shape: three servers under `orion-`, user scope.
  writeClaudeJson(s, { mcpServers: ours('orion') });

  const r = doctor(s);
  assert.equal(r.code, 0, r.out);
  assert.equal(line(r.out, 'prefix'), 'prefix        orion (found on the registrations)');
  for (const u of UNITS) {
    assert.match(r.out, new RegExp(`orion-${u} registered \\(user\\) → node .*servers.*${u}\\.mjs \\[file exists\\]`));
    assert.doesNotMatch(r.out, new RegExp(`omelette-${u} not registered`));
  }
  // The whole point: a working install is not told to install itself.
  assert.deepEqual(nextLines(r.out), ['next          omelette-fleet rules --agents --hooks']);

  // An explicit --prefix is still exactly what doctor looks for.
  const asked = doctor(s, ['--prefix', 'omelette']);
  assert.equal(asked.code, 0, asked.out);
  assert.equal(line(asked.out, 'prefix'), undefined, 'nothing was adopted, so nothing is announced');
  assert.match(asked.out, /omelette-codex not registered/);
  assert.deepEqual(nextLines(asked.out), ['next          omelette-fleet install']);
});

test('doctor reads the project\'s own .mcp.json, and says which file it read', () => {
  const s = sandbox();
  writeFileSync(join(s.proj, '.mcp.json'), JSON.stringify({ mcpServers: ours('omelette') }, null, 2));
  const r = doctor(s);
  assert.equal(r.code, 0, r.out);
  assert.equal(line(r.out, 'mcp.json'), `mcp.json      ${join(realpathSync(s.proj), '.mcp.json')}`);
  assert.match(r.out, /omelette-codex registered \(\.mcp\.json\) → node .*servers.*codex\.mjs \[file exists\]/);
  assert.deepEqual(nextLines(r.out), ['next          omelette-fleet rules --agents --hooks']);

  // Unreadable is named, never counted: "not registered" about a file nobody
  // could parse would send an operator to register what is already there.
  writeFileSync(join(s.proj, '.mcp.json'), '{ not json');
  const broken = doctor(s);
  assert.equal(broken.code, 0, broken.out);
  assert.ok(
    line(broken.out, 'mcp.json').startsWith(`mcp.json      ${join(realpathSync(s.proj), '.mcp.json')} (`),
    line(broken.out, 'mcp.json'),
  );
  assert.match(broken.out, /omelette-codex not registered/);
  assert.equal(readFileSync(join(s.proj, '.mcp.json'), 'utf8'), '{ not json', '.mcp.json is READ, never written');
});

test('doctor counts THIS project\'s scope and ignores another project\'s', () => {
  const s = sandbox();
  writeClaudeJson(s, { projects: { [join(s.dir, 'somewhere-else')]: { mcpServers: ours('omelette') } } });
  const other = doctor(s);
  assert.match(other.out, /omelette-codex not registered/);
  assert.deepEqual(nextLines(other.out), ['next          omelette-fleet install']);

  // The key Claude Code writes is the directory the session ran in — which on
  // macOS reaches the same place through /var and /private/var.
  writeClaudeJson(s, { projects: { [s.proj]: { mcpServers: ours('omelette') } } });
  const here = doctor(s);
  assert.match(here.out, /omelette-codex registered \(project\) → node .*servers.*codex\.mjs \[file exists\]/);

  writeClaudeJson(s, { projects: { [realpathSync(s.proj)]: { mcpServers: ours('omelette') } } });
  const resolved = doctor(s);
  assert.match(resolved.out, /omelette-codex registered \(project\) → node .*servers.*codex\.mjs \[file exists\]/);
});

test('doctor keeps omelette and names both when our servers wear two prefixes', () => {
  const s = sandbox();
  writeClaudeJson(s, {
    mcpServers: {
      'orion-codex': { command: 'node', args: [server('codex')] },
      'review-gemini': { command: 'node', args: [server('gemini')] },
    },
  });
  const r = doctor(s);
  assert.equal(r.code, 0, r.out);
  assert.equal(
    line(r.out, 'prefix'),
    'prefix        omelette — our servers are also registered as orion-*, review-*; pass --prefix <name> to look at one',
  );
  // The prefix is ambiguous; the registrations are not. Each is reported under
  // the name it wears, because each of them does run this checkout.
  assert.match(r.out, /orion-codex registered \(user\) → node .*servers.*codex\.mjs \[file exists\]/);
  assert.match(r.out, /review-gemini registered \(user\) → node .*servers.*gemini\.mjs \[file exists\]/);
  assert.match(r.out, /omelette-grok not registered/, 'and the unit nobody registered still says so');

  // A name of ours pointing at ANOTHER clone is not a prefix of ours.
  writeClaudeJson(s, { mcpServers: { 'orion-codex': { command: 'node', args: [join(s.dir, 'other-clone', 'servers', 'codex.mjs')] } } });
  const elsewhere = doctor(s);
  assert.equal(line(elsewhere.out, 'prefix'), undefined);
  assert.match(elsewhere.out, /omelette-codex not registered/);
  assert.deepEqual(nextLines(elsewhere.out), ['next          omelette-fleet install']);
});

test('doctor reads the scopes in Claude Code\'s precedence: the project entry in .claude.json, then .mcp.json, then user', () => {
  const s = sandbox();
  // codex enabled, with a binary that answers, so the per-server timeout line
  // is printed and the run is not a fault about a missing CLI.
  writeFileSync(join(s.dir, 'fleet.config.json'), JSON.stringify({
    version: 1, units: { gemini: { enabled: false }, grok: { enabled: false }, codex: { timeoutS: 600 } },
  }));
  const codex = (timeout) => ({ 'omelette-codex': { type: 'stdio', command: 'node', args: [server('codex')], timeout } });
  const run3 = () => run(s, ['doctor'], { CODEX_BIN: fakeBin(s.dir, 'fake-codex') });

  // The same name in all three places, each with its own cap. Claude Code reads
  // its "local" scope — this project's entry in .claude.json — first.
  writeClaudeJson(s, { mcpServers: codex(3600000), projects: { [s.proj]: { mcpServers: codex(1000) } } });
  writeFileSync(join(s.proj, '.mcp.json'), JSON.stringify({ mcpServers: codex(2000) }, null, 2));
  const local = run3();
  assert.equal(local.code, 0, local.out);
  assert.match(local.out, /omelette-codex "timeout": 1000 ms \(project\) overrides it/, local.out);
  assert.match(local.out, /omelette-codex registered \(project\) → /);

  // Without it, `.mcp.json` — the checked-in project scope — beats the user's.
  writeClaudeJson(s, { mcpServers: codex(3600000) });
  const projectFile = run3();
  assert.equal(projectFile.code, 0, projectFile.out);
  assert.match(projectFile.out, /omelette-codex "timeout": 2000 ms \(\.mcp\.json\) overrides it/, projectFile.out);
  assert.match(projectFile.out, /omelette-codex registered \(\.mcp\.json\) → /);

  // And the user scope answers only when it is the only one left.
  writeFileSync(join(s.proj, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
  const user = run3();
  assert.match(user.out, /omelette-codex "timeout": 3600000 ms \(user\) overrides it/, user.out);
  assert.match(user.out, /omelette-codex registered \(user\) → /);
});

test('doctor finds a server of ours registered under a name that is not <prefix>-<unit>, and calls it by that name', () => {
  const s = sandbox();
  // A perfectly working install whose operator named the server for the job it
  // does. Reporting `omelette-codex not registered` about it ends in an
  // `install` that registers a second copy of what is already there.
  writeClaudeJson(s, { mcpServers: { 'codex-review': { type: 'stdio', command: 'node', args: [server('codex')] } } });
  const r = doctor(s);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /codex-review registered \(user\) → node .*servers.*codex\.mjs \[file exists\]/);
  assert.doesNotMatch(r.out, /omelette-codex not registered/);
  // …and `next` says what is actually missing, not "install".
  assert.deepEqual(nextLines(r.out), ['next          omelette-fleet rules --agents --hooks']);
  // The other two units are genuinely absent, and still say so.
  assert.match(r.out, /omelette-gemini not registered/);
});

test('doctor calls a mixed install ambiguous even when one of the prefixes is omelette', () => {
  const s = sandbox();
  writeClaudeJson(s, {
    mcpServers: {
      'orion-codex': { command: 'node', args: [server('codex')] },
      'omelette-gemini': { command: 'node', args: [server('gemini')] },
    },
  });
  const r = doctor(s);
  assert.equal(r.code, 0, r.out);
  assert.equal(
    line(r.out, 'prefix'),
    'prefix        omelette — our servers are also registered as orion-*; pass --prefix <name> to look at one',
    'two prefixes are two installs, and doctor reports on one of them',
  );
  // The default is kept, and both servers are found where they actually are.
  assert.match(r.out, /omelette-gemini registered \(user\) → /);
  assert.match(r.out, /orion-codex registered \(user\) → /);
});

test('doctor: a scope\'s settings files are read as a UNION — one event here, the rest there', () => {
  const s = sandbox();
  const rules = run(s, ['rules', '--hooks']);
  assert.equal(rules.code, 0, rules.err);
  const lines = rules.out.split('\n');
  const start = lines.indexOf('{ "hooks": {');
  assert.ok(start >= 0, rules.out);
  let snippet = null;
  for (let end = start + 1; end <= lines.length && !snippet; end++) {
    try { snippet = JSON.parse(lines.slice(start, end).join('\n')); } catch { /* keep growing */ }
  }
  assert.ok(snippet, `no parseable snippet in:\n${rules.out}`);
  assert.deepEqual(Object.keys(snippet.hooks).sort(), HOOK_EVENTS.slice().sort(), 'the snippet covers every event');

  const settings = join(s.proj, '.claude', 'settings.json');
  const local = join(s.proj, '.claude', 'settings.local.json');
  const [first, ...rest] = HOOK_EVENTS;
  const wired = `(wired: ${HOOK_EVENTS.join(', ')})`;

  // The first event alone is not wired: half a wiring is not a wiring.
  writeFileSync(settings, JSON.stringify({ hooks: { [first]: snippet.hooks[first] } }, null, 2));
  assert.ok(doctor(s).out.includes('NOT wired'), doctor(s).out);

  // The rest in the OTHER file: together they wire the guard, and doctor says so.
  writeFileSync(local, JSON.stringify({ hooks: Object.fromEntries(rest.map((e) => [e, snippet.hooks[e]])) }, null, 2));
  const both = doctor(s);
  assert.ok(both.out.includes(wired), `${wired} not in:\n${both.out}`);
  assert.equal(both.code, 0, both.out);

  // A matcher that covers nothing in one file is not a finding when another
  // file wires the same event properly — the guard does see the call.
  writeFileSync(settings, JSON.stringify({
    hooks: { [first]: [{ ...snippet.hooks[first][0], matcher: 'Read' }] },
  }, null, 2));
  writeFileSync(local, JSON.stringify({ hooks: snippet.hooks }, null, 2));
  const shadowed = doctor(s);
  assert.ok(shadowed.out.includes(wired), shadowed.out);
  assert.doesNotMatch(shadowed.out, /matcher is not Bash/, shadowed.out);

  // Both files are READ, never written.
  const before = [readFileSync(settings, 'utf8'), readFileSync(local, 'utf8')];
  doctor(s);
  assert.deepEqual([readFileSync(settings, 'utf8'), readFileSync(local, 'utf8')], before);
});
