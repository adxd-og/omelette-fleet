// Tester round for 1.3.0 P2 Task 2 (spec
// docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md, "P2 — a medium
// coder beside the deep one" — "What ships" — and the rendering bullet of
// "## Tests"). Written from a clean context against the diff, not against the
// implementer's own test/coder-medium.test.mjs (nothing here imports it).
//
// Never compares the tree against `git show HEAD:…`, never pins a rendered
// size, never runs `set`/`install`/`doctor --probe-sandbox` against the real
// fleet home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SETTINGS_SCHEMA } from '../core/config.mjs';
import {
  AGENT_FILES,
  AGENT_MARKER,
  AGENT_ROLES,
  AGENT_TEMPLATES,
  SKILL_FILES,
  agentSettings,
  parseAgentMarker,
  renderAgentFile,
  renderSkillFile,
} from '../core/rules.mjs';

// renderAgentFile() falls back to reading the LIVE fleet config when it is
// given no explicit settings object. Point OMELETTE_HOME at a throwaway,
// empty directory for the whole file so a call with no settings argument
// never reads the operator's own ~/.omelette.
process.env.OMELETTE_HOME = mkdtempSync(join(tmpdir(), 'p2t2-live-'));

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const V = '9.9.9-p2t2';

/** A throwaway fleet home, optionally seeded with a config file. */
function home(config) {
  const dir = mkdtempSync(join(tmpdir(), 'p2t2-home-'));
  if (config !== undefined) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(config));
  return dir;
}

/** The CLI as a child process, HOME and OMELETTE_HOME inside the sandbox only. */
function cli(args, { dir, cwd = dir } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/** Line-by-line diff of two texts with the same line count. */
function diffLines(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  assert.equal(la.length, lb.length, 'both renders must have the same number of lines');
  const diffs = [];
  for (let i = 0; i < la.length; i++) {
    if (la[i] !== lb[i]) diffs.push({ i, a: la[i], b: lb[i] });
  }
  return diffs;
}

// ── coder vs coder-medium: one text, two names/efforts ───────────────────────

test('omelette-coder-medium vs omelette-coder: every line is identical except name: and effort:, and nothing else', () => {
  const coder = renderAgentFile('omelette-coder.md', V);
  const medium = renderAgentFile('omelette-coder-medium.md', V);
  const diffs = diffLines(coder, medium);
  assert.equal(diffs.length, 2, `expected exactly 2 differing lines, got ${JSON.stringify(diffs)}`);
  for (const d of diffs) {
    assert.match(d.a, /^(name|effort): /, `unexpected differing line in coder: ${JSON.stringify(d)}`);
    assert.match(d.b, /^(name|effort): /, `unexpected differing line in medium: ${JSON.stringify(d)}`);
  }
  const fields = diffs.map((d) => d.a.split(':')[0]).sort();
  assert.deepEqual(fields, ['effort', 'name'], 'the two differing lines are exactly name: and effort:');
});

test('omelette-coder-medium frontmatter: name, model, effort and disallowedTools as whole lines', () => {
  const medium = renderAgentFile('omelette-coder-medium.md', V).split('\n');
  assert.ok(medium.includes('name: omelette-coder-medium'), medium.join('\n'));
  assert.ok(medium.includes('model: opus'), medium.join('\n'));
  assert.ok(medium.includes('effort: medium'), medium.join('\n'));
  assert.ok(medium.includes('disallowedTools: Agent'), medium.join('\n'));
});

test('the marker sits on line 2 of the rendered omelette-coder-medium.md', () => {
  const medium = renderAgentFile('omelette-coder-medium.md', V);
  assert.equal(medium.split('\n')[1], AGENT_MARKER(V));
  assert.equal(parseAgentMarker(medium), V);
});

// ── no placeholder survives anywhere, including the skill ────────────────────

test('no {{name}}, {{model}} or {{effort}} placeholder survives in any of the four rendered definitions or the rendered skill', () => {
  for (const name of AGENT_FILES) {
    const text = renderAgentFile(name, V);
    for (const ph of ['{{name}}', '{{model}}', '{{effort}}']) {
      assert.ok(!text.includes(ph), `${name} still has ${ph}`);
    }
  }
  for (const name of SKILL_FILES) {
    const text = renderSkillFile(name, V);
    for (const ph of ['{{name}}', '{{model}}', '{{effort}}']) {
      assert.ok(!text.includes(ph), `${name} still has ${ph}`);
    }
  }
});

// ── the coder keeps xhigh; tester and reviewer frontmatter untouched ─────────

test('omelette-coder still renders effort: xhigh by default, unchanged from before this release', () => {
  const coder = renderAgentFile('omelette-coder.md', V);
  assert.match(coder, /^name: omelette-coder$/m);
  assert.match(coder, /^effort: xhigh$/m);
  assert.match(coder, /^model: opus$/m);
});

test('omelette-tester and omelette-reviewer frontmatter is unchanged by this release', () => {
  const tester = renderAgentFile('omelette-tester.md', V);
  assert.match(tester, /^name: omelette-tester$/m);
  assert.match(tester, /^model: sonnet$/m);
  assert.match(tester, /^effort: xhigh$/m);
  assert.match(tester, /^disallowedTools: Agent$/m);

  const reviewer = renderAgentFile('omelette-reviewer.md', V);
  assert.match(reviewer, /^name: omelette-reviewer$/m);
  assert.match(reviewer, /^model: opus$/m);
  assert.match(reviewer, /^effort: xhigh$/m);
  assert.match(reviewer, /^disallowedTools: Agent, Edit, NotebookEdit$/m);
});

// ── config reaches only the block it names ────────────────────────────────────

test('agents.coderMedium.effort=high and agents.coderMedium.model=sonnet change only the medium coder; the deep coder keeps opus/xhigh', () => {
  const dir = home({ version: 1, agents: { coderMedium: { effort: 'high', model: 'sonnet' } } });
  const settings = agentSettings({ OMELETTE_HOME: dir });
  assert.deepEqual(settings.coderMedium, { model: 'sonnet', effort: 'high' });
  assert.deepEqual(settings.coder, { model: 'opus', effort: 'xhigh' }, 'untouched by the medium block');

  const medium = renderAgentFile('omelette-coder-medium.md', V, settings);
  assert.match(medium, /^model: sonnet$/m);
  assert.match(medium, /^effort: high$/m);
  assert.match(medium, /^name: omelette-coder-medium$/m);

  const coder = renderAgentFile('omelette-coder.md', V, settings);
  assert.match(coder, /^model: opus$/m);
  assert.match(coder, /^effort: xhigh$/m);
});

test('an invalid agents.coderMedium.effort warns and the medium coder falls back to effort: medium', () => {
  const dir = home({ version: 1, agents: { coderMedium: { effort: 'turbo' } } });
  const settings = agentSettings({ OMELETTE_HOME: dir });
  assert.equal(settings.coderMedium.effort, 'medium');
  assert.ok(
    settings.warnings.some((w) => /agents\.coderMedium\.effort = "turbo" is invalid — ignored/.test(w)),
    settings.warnings.join('\n'),
  );
  const medium = renderAgentFile('omelette-coder-medium.md', V, settings);
  assert.match(medium, /^effort: medium$/m);
});

// ── the CLI, end to end, in a throwaway home ──────────────────────────────────

test('rules --agents in a temp project writes all four definitions with the marker, and doctor counts (4)', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  const r = cli(['rules', '--agents'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  for (const f of AGENT_FILES) {
    const p = join(proj, '.claude', 'agents', f);
    assert.ok(existsSync(p), `${f} written`);
    assert.ok(parseAgentMarker(readFileSync(p, 'utf8')) !== null, `${f} carries the marker`);
  }
  const d = cli(['doctor'], { dir, cwd: proj });
  assert.equal(d.code, 0, d.err);
  assert.match(d.out, /^agents {8}project: v\S+ \(4\)/m, d.out);
});

test('show agents (temp home) lists coderMedium.model and coderMedium.effort with their sources', () => {
  const dir = home({ version: 1, agents: { coderMedium: { effort: 'low' } } });
  const r = cli(['show', 'agents'], { dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /coderMedium\.model\s+opus\s+default/, r.out);
  assert.match(r.out, /coderMedium\.effort\s+low\s+file/, r.out);
  assert.match(r.out, /coder\.effort\s+xhigh\s+default/, r.out);
});

// ── the template file itself, and AGENT_TEMPLATES/AGENT_ROLES shape ─────────

test('the coder template file on disk still holds the {{name}} placeholder, but its own rendered output does not', () => {
  const raw = readFileSync(join(ROOT, 'agents', 'omelette-coder.md'), 'utf8');
  assert.ok(raw.includes('{{name}}'), 'the template source uses the placeholder — it is not hand-written per role');
  const rendered = renderAgentFile('omelette-coder.md', V);
  assert.ok(!rendered.includes('{{name}}'), 'the rendered coder output must not ship the literal placeholder');
  assert.match(rendered, /^name: omelette-coder$/m);
});

test('AGENT_ROLES and AGENT_TEMPLATES agree: coder-medium has no template file of its own', () => {
  assert.equal(AGENT_ROLES['omelette-coder-medium.md'], 'coderMedium');
  assert.equal(AGENT_TEMPLATES['omelette-coder-medium.md'], 'omelette-coder.md');
  assert.equal(existsSync(join(ROOT, 'agents', 'omelette-coder-medium.md')), false, 'no second copy of the coder text on disk');
  assert.equal(Object.keys(AGENT_SETTINGS_SCHEMA.coderMedium).length, 2, 'coderMedium has just model and effort, like coder');
});
