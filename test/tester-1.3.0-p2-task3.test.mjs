// Tester coverage for 1.3.0 P2 task 3 (spec
// docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md, "## Tests" line 72:
// "config round-trips `agents.coderMedium.*`, `show` lists them, an invalid
// value warns and falls back") — the promise under test is `cmdSet`'s role
// match: the typed role is matched against the schema's OWN spelling ignoring
// case, own keys only (an inherited name such as `constructor` never counts as
// known), and the unknown-agent message keeps its shape. This file is
// independent of test/coder-medium.test.mjs: its own `home`/`cli` helpers,
// nothing imported from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** A throwaway fleet home, optionally seeded with a config file. */
function home(config) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-p2t3-home-'));
  if (config !== undefined) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(config));
  return dir;
}

/** The CLI as a child process, HOME and OMELETTE_HOME inside the sandbox — never the real ones. */
function cli(args, { dir, cwd = dir } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const configFile = (dir) => join(dir, 'fleet.config.json');
/** Raw bytes, not parsed JSON — a byte-compare must catch even a whitespace change. */
const rawBytes = (dir) => (existsSync(configFile(dir)) ? readFileSync(configFile(dir)) : null);

// ── The three spellings all reach coderMedium ────────────────────────────────

test('agents.coderMedium, agents.codermedium and agents.CODERMEDIUM all reach the same schema block, and only the medium definition renders it', () => {
  const dir = home();

  const a = cli(['set', 'agents.coderMedium.effort=high'], { dir });
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /agents\.coderMedium\.effort\s+medium \[default\] → high \[file\]/);

  const b = cli(['set', 'agents.codermedium.effort=high'], { dir });
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /agents\.coderMedium\.effort\s+high \[file\] → high \[file\]/);

  const c = cli(['set', 'agents.CODERMEDIUM.model=sonnet'], { dir });
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /agents\.coderMedium\.model\s+opus \[default\] → sonnet \[file\]/);

  // Written under the schema's own spelling, never the input's case.
  const written = JSON.parse(readFileSync(configFile(dir), 'utf8'));
  assert.deepEqual(written.agents, { coderMedium: { effort: 'high', model: 'sonnet' } });
  assert.ok(!Object.hasOwn(written.agents, 'codermedium'));
  assert.ok(!Object.hasOwn(written.agents, 'CODERMEDIUM'));

  const shown = cli(['show', 'agents'], { dir });
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /^\s+coderMedium\.effort\s+high\s+file$/m);
  assert.match(shown.out, /^\s+coderMedium\.model\s+sonnet\s+file$/m);
  // The deep coder is untouched by any of the three spellings.
  assert.match(shown.out, /^\s+coder\.effort\s+xhigh\s+default$/m);
  assert.match(shown.out, /^\s+coder\.model\s+opus\s+default$/m);

  const proj = join(dir, 'proj'); mkdirSync(proj);
  const r = cli(['rules', '--agents'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  const medium = readFileSync(join(proj, '.claude', 'agents', 'omelette-coder-medium.md'), 'utf8');
  assert.match(medium, /^effort: high$/m);
  assert.match(medium, /^model: sonnet$/m);
  const coder = readFileSync(join(proj, '.claude', 'agents', 'omelette-coder.md'), 'utf8');
  assert.match(coder, /^effort: xhigh$/m, 'the deep coder keeps its default effort');
  assert.match(coder, /^model: opus$/m, 'the deep coder keeps its default model');
});

// ── An unknown role keeps the message shape, and writes nothing ─────────────

test('agents.coder-medium, agents.constructor and agents.__proto__ are all unknown agents — same message shape, exit 1, nothing written', () => {
  const dir = home({ version: 1, agents: { coderMedium: { effort: 'high' } } });
  const before = rawBytes(dir);
  assert.ok(before !== null, 'the seeded config exists before any refused set');

  const cases = [
    ['agents.coder-medium.effort=high', 'coder-medium'],
    ['agents.constructor.model=x', 'constructor'],
    ['agents.__proto__.model=x', '__proto__'],
  ];
  for (const [arg, given] of cases) {
    const r = cli(['set', arg], { dir });
    assert.equal(r.code, 1, `${arg}: exit 1`);
    assert.match(
      r.err,
      new RegExp(`unknown agent "${given.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" — known agents: coder, coderMedium, tester, reviewer`),
      `${arg}: message shape unchanged`,
    );
    const after = rawBytes(dir);
    assert.deepEqual(after, before, `${arg}: config file byte-identical after the refusal`);
  }
});

// ── An inherited/uppercase spelling of a real role still resolves ────────────

test('agents.Coder.effort=high still reaches the coder role, not coderMedium and not a new "Coder" entry', () => {
  const dir = home();
  const r = cli(['set', 'agents.Coder.effort=high'], { dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /agents\.coder\.effort\s+xhigh \[default\] → high \[file\]/);
  const written = JSON.parse(readFileSync(configFile(dir), 'utf8'));
  assert.deepEqual(written.agents, { coder: { effort: 'high' } });
});

// ── Invalid value and unknown key for coderMedium — refused, nothing written ─

test('agents.coderMedium.effort=bogus is refused and writes nothing', () => {
  const dir = home();
  assert.equal(existsSync(configFile(dir)), false, 'no config file exists yet');
  const r = cli(['set', 'agents.coderMedium.effort=bogus'], { dir });
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid value for agents\.coderMedium\.effort: "bogus" — expected low \| medium \| high \| xhigh \| max/);
  assert.equal(existsSync(configFile(dir)), false, 'a refused set never creates the file');
});

test('agents.coderMedium.maxTurns=5 is refused — that key does not exist for coderMedium — and writes nothing', () => {
  const dir = home({ version: 1, agents: { coderMedium: { effort: 'high' } } });
  const before = rawBytes(dir);
  const r = cli(['set', 'agents.coderMedium.maxTurns=5'], { dir });
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown key "maxTurns" for agent "coderMedium" — known keys: model, effort/);
  const after = rawBytes(dir);
  assert.deepEqual(after, before, 'the seeded config is untouched by the refusal');
});
