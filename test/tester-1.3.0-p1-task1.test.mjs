/**
 * omelette-fleet :: test/tester-1.3.0-p1-task1.test.mjs
 * Independent tester pass over docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md,
 * "P1 — `omelette-reviewer`": the reviewer's settings are `model` and `effort`
 * only. This file pins that narrower key schema surfacing through `set`'s error
 * message — no other test drives an invalid agents.reviewer.* key — and the
 * `update --check` partial-scope hint at the GLOBAL scope (rulesHints'
 * dir-kind call site, bin/omelette-fleet.mjs:1585).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_MARKER } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** A throwaway fleet home. */
function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-p1-t1-'));
}

/** The CLI as a child process; HOME follows the fleet home so nothing real is read. */
function cli(args, { dir, cwd = dir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// ─── the reviewer's own, narrower schema surfacing through `set` ────────────
// AGENT_SETTINGS_SCHEMA.reviewer has exactly {model, effort} — no maxTurns,
// unlike the tester. reviewer.test.mjs only drives `set` with VALID
// agents.reviewer.* keys; the "known keys" error text for an INVALID one
// (proving the reviewer's schema is not just the tester's schema relabelled)
// is not exercised anywhere else.

test('`set agents.reviewer.maxTurns=…` is refused: the reviewer has no maxTurns key, unlike the tester', () => {
  const dir = home();
  const r = cli(['set', 'agents.reviewer.maxTurns=40'], { dir });
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown key "maxTurns" for agent "reviewer" — known keys: model, effort/);
  assert.equal(existsSync(join(dir, 'fleet.config.json')), false, 'a refused set writes nothing');
  // The tester, by contrast, DOES accept maxTurns — confirming the message
  // above is reviewer's own narrower schema, not a copy-paste of a shared one.
  const t = cli(['set', 'agents.tester.maxTurns=40'], { dir });
  assert.equal(t.code, 0, t.err);
});

// ─── the rulesHints partial-scope hint, at the GLOBAL scope too ─────────────
// reviewer.test.mjs's "update --check hints rules --agents for a scope
// missing the reviewer" test drives only the PROJECT scope. `rulesHints`
// (bin/omelette-fleet.mjs) walks `dirReport`, which reports project AND
// global — the global half of that loop is untested anywhere in the diff.

test('`update --check` also hints the partial agents scope at --global, with the same "N of 4 missing" count', () => {
  const dir = home();
  const cfg = join(dir, 'cfgdir');
  const proj = join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  const agents = join(cfg, 'agents');
  mkdirSync(agents, { recursive: true });
  for (const f of ['omelette-coder.md', 'omelette-tester.md']) {
    writeFileSync(join(agents, f), `---\n${AGENT_MARKER('0.2.0')}\nname: ${f.replace(/\.md$/, '')}\n---\nold\n`);
  }
  const pkgRoot = mkdtempSync(join(tmpdir(), 'omelette-npm-p1-t1-'));
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'omelette-fleet', version: '0.2.0' }, null, 2));
  const r = cli(['update', '--check'], { dir, cwd: proj, env: { CLAUDE_CONFIG_DIR: cfg, OMELETTE_PKG_ROOT: pkgRoot } });
  assert.equal(r.code, 0, r.err);
  assert.match(
    r.out,
    /^agent files under .*(\/|\\)agents are v0\.2\.0 \(this install is v0\.2\.0\) — refresh: omelette-fleet rules --agents --global \(2 of 4 missing\)$/m,
    r.out,
  );
  assert.equal(existsSync(join(agents, 'omelette-reviewer.md')), false, 'a hint is never a write');
});
