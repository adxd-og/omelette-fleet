/**
 * omelette-fleet :: test/tester-1.4.0-d2.test.mjs
 * 1.4.0 fix round D-2: four sources that still reached the terminal raw —
 * format characters outside visible()'s old set, an agent `model` rendered
 * into `rules --agents --print`, the unit log sink, and the update-check
 * cache's `latest` printed by doctor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLog, visible } from '../core/log.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const UNITS = ['gemini', 'grok', 'codex'];

function sandbox(config = { version: 1, units: { gemini: { enabled: false }, grok: { enabled: false }, codex: { enabled: false } } }) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-d2-'));
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(config));
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

test('visible escapes soft hyphen, Arabic letter mark and an astral tag character, the astral one as \\u{...}', () => {
  assert.equal(visible('a­b؜c\u{e0041}d᠎￹'), 'a\\u00adb\\u061cc\\u{e0041}d\\u180e\\ufff9');
  assert.equal(visible('plain ascii é'), 'plain ascii é');
});

test('doctor prints a soft hyphen, an Arabic letter mark and a tag character from .mcp.json as their escapes', () => {
  const s = sandbox();
  const servers = Object.fromEntries(UNITS.map((u) => [`omelette-${u}`, { type: 'stdio', command: 'node', args: [join(ROOT, 'servers', `${u}.mjs`)] }]));
  servers['omelette-codex'] = { type: 'stdio', command: 'no­de؜x\u{e0041}', args: ['/x/servers/codex.mjs'] };
  writeFileSync(join(s.proj, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
  const r = run(s, ['doctor']);
  assert.equal(r.code, 0, r.out);
  for (const raw of ['­', '؜', '\u{e0041}']) assert.ok(!r.out.includes(raw), `raw U+${raw.codePointAt(0).toString(16)} on stdout`);
  assert.ok(r.out.includes('no\\u00adde\\u061cx\\u{e0041}'), r.out);
});

test('rules --agents --print with a C1 control in agents.coder.model prints no raw byte and renders the default', () => {
  const s = sandbox({ version: 1, agents: { coder: { model: 'op\u009bus-x' } } });
  const r = run(s, ['rules', '--agents', '--print']);
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.out.includes('\u009b'), 'raw U+009B on stdout');
  assert.ok(!r.err.includes('\u009b'), 'raw U+009B on stderr');
  assert.match(r.err, /agents\.coder\.model = .* is invalid — ignored/);
  const coder = r.out.slice(r.out.indexOf('===== omelette-coder.md ====='));
  assert.match(coder, /\nmodel: opus\n/);
});

test('the unit log sink writes a control character as its escape', () => {
  const written = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try { makeLog('unit')('bad\u001b[2Kmodel ‮ end'); } finally { process.stderr.write = orig; }
  assert.deepEqual(written, ['[unit] bad\\u001b[2Kmodel \\u202e end\n']);
});

test('doctor prints an update-check cache latest that is not a version as unknown, with no ESC', () => {
  const s = sandbox();
  writeFileSync(join(s.dir, 'update-check.json'), JSON.stringify({ checkedAt: Date.now(), latest: '9.9.9\u001b[2K', url: 'https://example.test' }));
  const r = run(s, ['doctor'], { OMELETTE_UPDATE_CHECK: '1' });
  assert.ok(!r.out.includes('\u001b'), 'raw ESC on stdout');
  const version = r.out.split('\n').find((l) => l.startsWith('version'));
  assert.match(version, /· latest unknown/, version);

  writeFileSync(join(s.dir, 'update-check.json'), JSON.stringify({ checkedAt: Date.now(), latest: '1.4.1', url: 'https://example.test' }));
  const ok = run(s, ['doctor'], { OMELETTE_UPDATE_CHECK: '1' });
  assert.match(ok.out.split('\n').find((l) => l.startsWith('version')), /· latest 1\.4\.1/);
});
