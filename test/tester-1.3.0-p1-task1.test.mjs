/**
 * omelette-fleet :: test/tester-1.3.0-p1-task1.test.mjs
 * Independent tester pass over docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md,
 * "P1 — `omelette-reviewer`" (lines 35-43) and the rendering/config bullets of
 * "## Tests" (lines 69-75), for the task that ships ONLY the definition and its
 * settings: agents/omelette-reviewer.md, AGENT_ROLES/AGENT_FILES in
 * core/rules.mjs, AGENT_SETTINGS_SCHEMA.reviewer in core/config.mjs, the CLI
 * help, and the rulesHints partial-scope hint.
 *
 * Input is the spec and the task's diff — never the implementer's summary or
 * test/reviewer.test.mjs. These tests target behaviours the spec promises that
 * are uncovered, or only weakly covered, by the implementer's own tests: the
 * CLI help text naming three sub-agent definitions (bin/omelette-fleet.mjs),
 * and the reviewer's own, narrower key schema (no maxTurns) surfacing through
 * `set`'s error message. Never edit test/reviewer.test.mjs or the implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_MARKER } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

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

// ─── the CLI help: "the three sub-agent definitions" ────────────────────────
// Spec P1 ("The definition") says the reviewer renders "beside the coder and
// the tester" and the Tests bullets ask for "the definitions line naming
// four" (three, in this task). Neither reviewer.test.mjs nor any test in the
// diff drives `rules --help` or `install --help` — the two places the CLI's
// own help text was rewritten to say "three" instead of "two" and to name
// omelette-reviewer explicitly. 1.3.0 P2 Task 2 makes it four, the medium
// coder among them; the reviewer is still named, Opus at xhigh.

test('`rules --help` names four sub-agent definitions and the reviewer by name, opus at xhigh', () => {
  const dir = home();
  const help = cli(['rules', '--help'], { dir });
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /^\s*--agents also writes four sub-agent definitions \(omelette-coder:\s*$/m);
  assert.match(help.out, /^\s*Opus xhigh; omelette-coder-medium: Opus medium; omelette-tester:\s*$/m);
  assert.match(help.out, /^\s*Sonnet xhigh; omelette-reviewer: Opus xhigh; all four disallow\s*$/m);
  assert.match(help.out, /^\s*Agent, the reviewer also Edit and NotebookEdit\) into \.claude\/agents,\s*$/m);
});

test('`install --help` says --rules writes the four sub-agent definitions', () => {
  const dir = home();
  const help = cli(['install', '--help'], { dir });
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /^\s*the operating rules, the four sub-agent definitions, the \/omelette-test\s*$/m);
});

test('the top-level --help listing carries the same rewritten "rules" body line as `rules --help`', () => {
  const dir = home();
  const top = cli(['--help'], { dir });
  const scoped = cli(['rules', '--help'], { dir });
  assert.equal(top.code, 0, top.err);
  assert.match(top.out, /--agents also writes four sub-agent definitions \(omelette-coder:/);
  // Spec's own claim (core/rules.mjs doc comment on COMMANDS): "the global
  // listing is assembled from the same bodies the per-command pages print" —
  // so the sentence should not merely appear twice by coincidence, it is the
  // literal same array entry in both outputs.
  assert.ok(scoped.out.includes('--agents also writes four sub-agent definitions (omelette-coder:'));
});

// ─── the reviewer's own, narrower schema surfacing through `set` ────────────
// AGENT_SETTINGS_SCHEMA.reviewer has exactly {model, effort} — no maxTurns,
// unlike the tester. reviewer.test.mjs only drives `set` with VALID
// agents.reviewer.* keys; the "known keys" error text for an INVALID one
// (proving the reviewer's schema is not just the tester's schema relabelled)
// is not exercised anywhere in the diff.

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

// ─── invalid agents.reviewer.effort surfaces through `show` and through the
// rendered file's fallback, not just through the internal agentSettings()
// object reviewer.test.mjs asserts on directly ────────────────────────────

test('an invalid agents.reviewer.effort warns on `show agents` and on `rules --agents`, and the rendered file still falls back to xhigh', () => {
  const dir = home();
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ version: 1, agents: { reviewer: { effort: 'turbo' } } }));

  const shown = cli(['show', 'agents'], { dir });
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /warning\s+fleet config: agents\.reviewer\.effort = "turbo" is invalid — ignored/);

  const proj = join(dir, 'proj');
  mkdirSync(proj);
  const written = cli(['rules', '--agents'], { dir, cwd: proj });
  assert.equal(written.code, 0, written.err);
  assert.match(written.err, /omelette-fleet rules: fleet config: agents\.reviewer\.effort = "turbo" is invalid — ignored/);
  const text = readFileSync(join(proj, '.claude', 'agents', 'omelette-reviewer.md'), 'utf8');
  assert.match(text, /^effort: xhigh$/m);
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

// ─── sanity: the reviewer file itself carries the current package version's
// marker when rendered through the full `rules --agents` write path with NO
// config file at all (every other reviewer test either drives a temp config
// or calls renderAgentFile directly — none exercises the plain zero-config
// CLI write path end to end for this file) ───────────────────────────────

test('`rules --agents` with no fleet config at all still writes omelette-reviewer.md at this package version, model opus, effort xhigh', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  const r = cli(['rules', '--agents'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  const file = join(proj, '.claude', 'agents', 'omelette-reviewer.md');
  const text = readFileSync(file, 'utf8');
  assert.equal(text.split('\n')[1], AGENT_MARKER(pkgVersion));
  assert.match(text, /^model: opus$/m);
  assert.match(text, /^effort: xhigh$/m);
  assert.match(text, /^disallowedTools: Agent, Edit, NotebookEdit$/m);
  assert.match(text, /^tools: Read, Grep, Glob, Bash, Write$/m);
});
