/**
 * omelette-fleet :: test/tester-1.4.0-t3.test.mjs
 * Independent coverage for 1.4.0 P3 ("`doctor` prints text, not terminal
 * control"): every value doctor/install/update print that came out of
 * project or user JSON — server name, command, args/target, scope, the
 * mcp.json line, adoptPrefix's found prefix, a JSON parse error's message —
 * has its C0/C1 control characters and DEL rendered as `\uXXXX` escapes, and
 * stdout carries no such byte other than `\n` and `\t`.
 *
 * Modeled on test/doctor-prefix.test.mjs's sandbox()/run()/ours() helpers.
 * Targets left uncovered (or only lightly covered) by that file's own new
 * test: the adopted-prefix line (single AND ambiguous-multi-prefix forms), a
 * control character in a `.claude.json` project-scope entry (not just
 * `.mcp.json`), a `"timeout"` value holding DEL, the "registered server file
 * is missing" FAULT line, a `.claude.json` JSON-parse-error message, and
 * `install`/`update --check` under the same malicious files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const UNITS = ['gemini', 'grok', 'codex'];
const server = (unit) => join(ROOT, 'servers', `${unit}.mjs`);

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t3-'));
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
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

const doctor = (s, args = [], env = {}) => run(s, ['doctor', ...args], env);
const writeClaudeJson = (s, body) => writeFileSync(join(s.dir, '.claude.json'), JSON.stringify(body, null, 2));
const ours = (prefix) => Object.fromEntries(UNITS.map((u) => [`${prefix}-${u}`, { type: 'stdio', command: 'node', args: [server(u)] }]));

function fakeBin(dir, name = 'fake-cli') {
  const p = join(dir, name);
  writeFileSync(p, [`#!${process.execPath}`, 'process.exit(0);'].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

/** No C0/C1 control byte or DEL on stdout other than `\n` (10) and `\t` (9). */
function assertNoRawControlBytes(out, msg = '') {
  for (const ch of out) {
    const code = ch.charCodeAt(0);
    const raw = !(code === 10 || code === 9) && (code < 32 || (code >= 0x7f && code <= 0x9f));
    assert.ok(!raw, `raw control byte ${code} on stdout${msg ? ` (${msg})` : ''}`);
  }
}

test('adoptPrefix: a single adopted prefix carrying a control character is printed as its escape', () => {
  const s = sandbox();
  const prefix = 'ori\u001bon';
  writeClaudeJson(s, { mcpServers: ours(prefix) });
  const r = doctor(s);
  assert.equal(r.code, 0, r.out);
  assertNoRawControlBytes(r.out);
  assert.match(r.out, /^prefix {8}ori\\u001bon \(found on the registrations\)$/m);
  // The same escaped prefix also has to show up in each unit's own mcp line
  // (mcpLine's `server` is the full registered name, prefix included).
  for (const u of UNITS) {
    assert.match(r.out, new RegExp(`ori\\\\u001bon-${u} registered \\(user\\)`));
  }
});

test('adoptPrefix: the ambiguous multi-prefix line escapes a control character in either prefix', () => {
  const s = sandbox();
  writeClaudeJson(s, {
    mcpServers: {
      'ori\u001bon-codex': { type: 'stdio', command: 'node', args: [server('codex')] },
      'review-gemini': { type: 'stdio', command: 'node', args: [server('gemini')] },
    },
  });
  const r = doctor(s);
  assert.equal(r.code, 0, r.out);
  assertNoRawControlBytes(r.out);
  assert.equal(
    r.out.split('\n').find((l) => l.startsWith('prefix')),
    'prefix        omelette — our servers are also registered as ori\\u001bon-*, review-*; pass --prefix <name> to look at one',
  );
});

test('a project-scope (.claude.json) entry with a control character in its command is escaped, not just .mcp.json entries', () => {
  const s = sandbox();
  writeClaudeJson(s, {
    projects: {
      [s.proj]: {
        mcpServers: {
          'omelette-codex': { type: 'stdio', command: 'node\u001b[2K', args: [server('codex'), '\u007fextra'] },
        },
      },
    },
  });
  const r = doctor(s);
  assert.equal(r.code, 0, r.out);
  assertNoRawControlBytes(r.out);
  assert.match(r.out, /omelette-codex registered elsewhere \(project\) → node\\u001b\[2K /);
});

test('a "timeout" value holding DEL in .mcp.json is escaped (JSON.stringify alone leaves DEL raw)', () => {
  const s = sandbox();
  writeFileSync(join(s.dir, 'fleet.config.json'), JSON.stringify({
    version: 1, units: { gemini: { enabled: false }, grok: { enabled: false }, codex: { timeoutS: 600 } },
  }));
  writeClaudeJson(s, {
    mcpServers: { 'omelette-codex': { type: 'stdio', command: 'node', args: [server('codex')], timeout: 'bad\u007f' } },
  });
  const r = doctor(s, [], { CODEX_BIN: fakeBin(s.dir, 'fake-codex') });
  assertNoRawControlBytes(r.out);
  assert.match(r.out, /omelette-codex "timeout": "bad\\u007f" is not an integer/);
});

test('the "registered server file is missing" FAULT line escapes a control character in the target', () => {
  const s = sandbox();
  writeFileSync(join(s.dir, 'fleet.config.json'), JSON.stringify({
    version: 1, units: { gemini: { enabled: false }, grok: { enabled: false }, codex: { timeoutS: 600 } },
  }));
  const missingTarget = join(s.dir, '\u009bmissing', 'codex.mjs');
  writeClaudeJson(s, {
    mcpServers: { 'omelette-codex': { type: 'stdio', command: 'node', args: [missingTarget] } },
  });
  const r = doctor(s, [], { CODEX_BIN: fakeBin(s.dir, 'fake-codex') });
  assertNoRawControlBytes(r.out);
  assert.match(r.out, /FAULT {7}enabled and registered, but: the registered server file is missing \([^)]*\\u009bmissing[^)]*\)/);
  assert.doesNotMatch(r.out, /FAULT[^\n]*\u009b/, 'the raw C1 byte must not appear on the FAULT line itself');
});

test('a JSON-parse-error message from .claude.json is escaped exactly like the .mcp.json one', () => {
  const s = sandbox();
  // A JSON.parse error over source text whose first token IS the control
  // character embeds the raw byte in e.message (verified against Node's
  // parser directly): `Unexpected token '\x1b', "\x1b bad json" is not
  // valid JSON`. The .mcp.json line already goes through visible() for its
  // error (see the diff's own new test); the claude-config line is a
  // DIFFERENT call site (bin/omelette-fleet.mjs:2672) and spec P3 promises
  // "the message of a JSON parse error" without carving out which file.
  writeFileSync(join(s.dir, '.claude.json'), '\u001b bad json');
  const r = doctor(s);
  assert.equal(r.code, 0, r.out);
  const claudeLine = r.out.split('\n').find((l) => l.startsWith('claude config'));
  assert.ok(claudeLine, r.out);
  assert.ok(!claudeLine.includes('\u001b'), `raw ESC on the claude config line: ${JSON.stringify(claudeLine)}`);
  assertNoRawControlBytes(r.out, 'claude config parse-error line');
});

test('install --dry-run prints no raw control byte even when .claude.json/.mcp.json hold one', () => {
  const s = sandbox();
  writeClaudeJson(s, {
    mcpServers: { 'omelette-codex': { type: 'stdio', command: 'node\u001b[2K', args: [server('codex')] } },
  });
  writeFileSync(join(s.proj, '.mcp.json'), JSON.stringify({
    mcpServers: { 'omelette-gemini': { type: 'stdio', command: '\u001b[2K node', args: [server('gemini')] } },
  }, null, 2));
  const r = run(s, ['install', '--dry-run', '--units', 'codex']);
  assertNoRawControlBytes(r.out, 'install --dry-run');
});

test('update --check prints no raw control byte even when .claude.json/.mcp.json hold one', () => {
  const s = sandbox();
  writeClaudeJson(s, {
    mcpServers: { 'omelette-codex': { type: 'stdio', command: 'node\u001b[2K', args: [server('codex')] } },
  });
  writeFileSync(join(s.proj, '.mcp.json'), JSON.stringify({
    mcpServers: { 'omelette-gemini': { type: 'stdio', command: '\u001b[2K node', args: [server('gemini')] } },
  }, null, 2));
  const r = run(s, ['update', '--check']);
  assertNoRawControlBytes(r.out, 'update --check');
});
