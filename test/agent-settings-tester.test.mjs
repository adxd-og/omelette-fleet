/**
 * omelette-fleet :: test/agent-settings-tester.test.mjs
 *
 * Independent coverage for task 2 (0.3.1 §4 "Agent hardening" — the "Agent
 * settings live in the fleet config" paragraph and the dynamic-adjustment
 * mechanism), written from the spec and the task-2 brief, against the diff in
 * review-t2.diff — never against the implementer's own report.
 *
 * Conventions mirrored from test/cli.test.mjs: the CLI is spawned as a child
 * process with a throwaway OMELETTE_HOME/HOME and OMELETTE_UPDATE_CHECK=0;
 * never the real HOME.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SETTINGS_SCHEMA, coerce } from '../core/config.mjs';
import { agentSettings, renderAgentFile } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-agentcli-'));
}

function cli(args, { dir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// ─── coercion of config-FILE values (as opposed to CLI-argument strings,
//     which are already strings before they reach `coerce`) ──────────────────

test('agentSettings: a numeric-looking STRING in the config file coerces the same as a number for maxTurns', () => {
  const dir = home();
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, agents: { tester: { maxTurns: '120' } } }));
  const s = agentSettings({ OMELETTE_HOME: dir });
  assert.equal(s.tester.maxTurns, 120);
  assert.equal(typeof s.tester.maxTurns, 'number');
  assert.equal(s.sources.tester.maxTurns, 'file');
  assert.deepEqual(s.warnings, []);
});

test('agentSettings: maxTurns -5 in the config file is invalid — default and a warning, never a throw', () => {
  const dir = home();
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, agents: { tester: { maxTurns: -5 } } }));
  const s = agentSettings({ OMELETTE_HOME: dir });
  assert.equal(s.tester.maxTurns, 80);
  assert.ok(s.warnings.some((w) => /agents\.tester\.maxTurns = -5 is invalid/.test(w)));
});

test('agentSettings: a non-numeric maxTurns string ("abc") in the config file is invalid — default and a warning', () => {
  const dir = home();
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, agents: { tester: { maxTurns: 'abc' } } }));
  const s = agentSettings({ OMELETTE_HOME: dir });
  assert.equal(s.tester.maxTurns, 80);
  assert.ok(s.warnings.some((w) => /agents\.tester\.maxTurns = "abc" is invalid/.test(w)));
});

test('agentSettings: coder.effort "ultra" (an unlisted level) is invalid — default and a warning', () => {
  const dir = home();
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, agents: { coder: { effort: 'ultra' } } }));
  const s = agentSettings({ OMELETTE_HOME: dir });
  assert.equal(s.coder.effort, 'xhigh');
  assert.ok(s.warnings.some((w) => /agents\.coder\.effort = "ultra" is invalid/.test(w)));
});

// ─── `rules --print --agents`: reflects settings, writes nothing ─────────────

test('rules --print --agents renders the current settings and touches no file', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  assert.equal(cli(['set', 'agents.tester.maxTurns=99'], { dir }).code, 0);

  const p = spawnSync(process.execPath, [BIN, 'rules', '--print', '--agents'], {
    cwd: proj, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /^maxTurns: 99$/m);
  assert.ok(!p.stdout.includes('{{'), 'no placeholder leaks into --print output');
  assert.ok(!existsSync(join(proj, '.claude')), '--print --agents writes nothing at all');
});

test('rules --print --agents still warns about an invalid setting on stderr, without writing anything', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, agents: { tester: { maxTurns: 0 } } }));
  const p = spawnSync(process.execPath, [BIN, 'rules', '--print', '--agents'], {
    cwd: proj, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /agents\.tester\.maxTurns = 0 is invalid/);
  assert.match(p.stdout, /^maxTurns: 80$/m, 'the default is what --print shows back, same as what a real write would use');
  assert.ok(!existsSync(join(proj, '.claude')));
});

// ─── `set agents.*` must not disturb `units.*`, and vice versa, INCLUDING
//     within the very same invocation ──────────────────────────────────────

test('set agents.tester.maxTurns does not disturb an existing units block', () => {
  const dir = home();
  const cfg = join(dir, 'fleet.config.json');
  writeFileSync(cfg, JSON.stringify({ version: 1, units: { codex: { timeoutS: 111, enabled: false } } }));
  const r = cli(['set', 'agents.tester.maxTurns=55'], { dir });
  assert.equal(r.code, 0, r.err);
  const written = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.deepEqual(written.units, { codex: { timeoutS: 111, enabled: false } }, 'units block is byte-for-byte preserved');
  assert.deepEqual(written.agents, { tester: { maxTurns: 55 } });
});

test('one `set` call mixing a unit key and an agents key writes both and disturbs neither', () => {
  const dir = home();
  const r = cli(['set', 'codex.timeoutS=42', 'agents.tester.maxTurns=77'], { dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /codex\.timeoutS/);
  assert.match(r.out, /agents\.tester\.maxTurns/);
  const written = JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8'));
  assert.equal(written.units.codex.timeoutS, 42);
  assert.equal(written.agents.tester.maxTurns, 77);
});

// ─── `set agents.tester.maxTurns=0` refused: exit 1 AND the file's existing
//     bytes are provably untouched (not merely "still absent") ──────────────

test('set agents.tester.maxTurns=0 is refused and an EXISTING config file is left byte-for-byte untouched', () => {
  const dir = home();
  const cfg = join(dir, 'fleet.config.json');
  const original = JSON.stringify({ version: 1, agents: { tester: { maxTurns: 45 } }, units: { grok: { enabled: true } } });
  writeFileSync(cfg, original);
  const r = cli(['set', 'agents.tester.maxTurns=0'], { dir });
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid value for agents\.tester\.maxTurns/);
  assert.equal(readFileSync(cfg, 'utf8'), original, 'refused set never touches the file at all');
});

// ─── the coder template never grows a maxTurns line — that key belongs to
//     the tester role only, per AGENT_SETTINGS_SCHEMA.coder having no such key ──

test('the coder role has no maxTurns key, and its rendered file never contains a maxTurns line', () => {
  assert.ok(!('maxTurns' in AGENT_SETTINGS_SCHEMA.coder), 'coder schema has no maxTurns key');
  const rendered = renderAgentFile('omelette-coder.md', '9.9.9', {
    coder: { model: 'opus', effort: 'xhigh' },
    tester: { model: 'sonnet', effort: 'xhigh', maxTurns: 999 },
  });
  assert.ok(!/maxTurns/.test(rendered), 'a tester-only key never leaks into the coder template');
  assert.ok(!rendered.includes('{{'));
});

// ─── `show agents` surfaces warnings from a broken config file too, and never
//     crashes on one ────────────────────────────────────────────────────────

test('show agents prints a warning line and the default value when the config file itself is broken', () => {
  const dir = home();
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, agents: { tester: { effort: 'bogus' } } }));
  const r = cli(['show', 'agents'], { dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /warning\s+fleet config: agents\.tester\.effort = "bogus" is invalid/);
  assert.match(r.out, /^\s+tester\.effort\s+xhigh\s+default$/m);
});

test('show agents on a config file that is not even valid JSON still answers with defaults and a warning', () => {
  const dir = home();
  writeFileSync(join(dir, 'fleet.config.json'), '{ not json');
  const r = cli(['show', 'agents'], { dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /warning\s+fleet config:/);
  assert.match(r.out, /^\s+tester\.maxTurns\s+80\s+default$/m);
});

// ─── coerce() spec-level sanity for the exact AGENT_SETTINGS_SCHEMA objects,
//     independent of any CLI or file plumbing ────────────────────────────────

test('coerce() against the live AGENT_SETTINGS_SCHEMA specs: the brief\'s exact edge values', () => {
  assert.deepEqual(coerce(AGENT_SETTINGS_SCHEMA.tester.maxTurns, '120'), { ok: true, value: 120 });
  assert.deepEqual(coerce(AGENT_SETTINGS_SCHEMA.tester.maxTurns, 0), { ok: false });
  assert.deepEqual(coerce(AGENT_SETTINGS_SCHEMA.tester.maxTurns, -5), { ok: false });
  assert.deepEqual(coerce(AGENT_SETTINGS_SCHEMA.tester.maxTurns, 'abc'), { ok: false });
  assert.deepEqual(coerce(AGENT_SETTINGS_SCHEMA.coder.effort, 'ultra'), { ok: false });
  assert.deepEqual(coerce(AGENT_SETTINGS_SCHEMA.coder.effort, 'xhigh'), { ok: true, value: 'xhigh' });
});

// ─── renderAgentFile: version placeholder + a full round trip through the
//     real CLI, confirming the exact "written … (v<pkg>, was <pkg>)" wording ──

test('rules --agents on a fresh project: the initial write reports "written … (v<pkg>, was absent)"', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const r = spawnSync(process.execPath, [BIN, 'rules', '--agents'], {
    cwd: proj, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`written .*omelette-tester\\.md \\(v${pkgVersion.replace(/\./g, '\\.')}, was absent\\)`));
});
