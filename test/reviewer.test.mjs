/**
 * omelette-fleet :: test/reviewer.test.mjs
 * 1.3.0 P1 (spec docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md,
 * "P1 — `omelette-reviewer`"): the shipped reviewer renders beside the coder
 * and the tester from its own `agents.reviewer` block, carries the toolset the
 * spec fixes, and says the one file it writes. The CLI is spawned as a child
 * process with a throwaway OMELETTE_HOME/HOME, never the real one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_FILES, AGENT_MARKER, AGENT_ROLES, agentSettings, renderAgentFile } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/** A throwaway fleet home, optionally with a config file in it. */
function home(config) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-reviewer-'));
  if (config !== undefined) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(config));
  return dir;
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

/** The definition as `rules --agents` writes it with the built-in defaults. */
const reviewer = () => renderAgentFile('omelette-reviewer.md', '1.2.3', agentSettings({ OMELETTE_HOME: home() }));

/** The frontmatter lines between the opening and the closing `---`, marker included. */
function frontmatter(text) {
  const lines = text.split('\n');
  return lines.slice(1, lines.indexOf('---', 1));
}

test('omelette-reviewer renders beside the coder and the tester, from its own agents block, with the marker on line 2', () => {
  assert.deepEqual(AGENT_FILES, ['omelette-coder.md', 'omelette-tester.md', 'omelette-reviewer.md']);
  assert.equal(AGENT_ROLES['omelette-reviewer.md'], 'reviewer');
  const lines = reviewer().split('\n');
  assert.equal(lines[0], '---');
  assert.equal(lines[1], AGENT_MARKER('1.2.3'));
});

test('the reviewer\'s frontmatter: its name, opus at xhigh by default, a read-and-report toolset, and no Agent, Edit or NotebookEdit', () => {
  const fm = frontmatter(reviewer());
  assert.deepEqual(
    fm.filter((l) => !l.startsWith('#')).map((l) => l.slice(0, l.indexOf(':'))),
    ['name', 'description', 'model', 'effort', 'disallowedTools', 'tools'],
  );
  for (const line of [
    'name: omelette-reviewer',
    'model: opus',
    'effort: xhigh',
    'disallowedTools: Agent, Edit, NotebookEdit',
    'tools: Read, Grep, Glob, Bash, Write',
  ]) assert.ok(fm.includes(line), `a whole frontmatter line: ${line}`);
});

/**
 * What the definition must say, each sentence whole (spec P1: "What it does"
 * and "What keeps it read-only — stated honestly"). The first is the sentence
 * the spec asks a test to pin: the one file the reviewer writes.
 */
const SAYS = [
  'The only file you write is `.omelette/reports/<name>-review.md`.',
  'After your report the session runs `git status --porcelain` and rejects the whole review if anything but that report changed.',
  'your `git commit`, `merge`, `rebase`, `push`, `stash`, `tag`, a branch creation and `worktree` are refused with exit 2 and a line naming you.',
  'You have deliberately not been given the author\'s summary',
  'A re-review\'s brief also carries the earlier findings and the rulings on them',
  'Every finding has four parts — `location · scenario · consequence · how to confirm` —',
  'Close with one verdict line: `ship`, `do not ship` or `needs-check`',
  'Then reply with only: the verdict line and the number of findings.',
];

test('the reviewer\'s definition says the one file it writes, the check after it, and the shape of its review', () => {
  const text = reviewer();
  for (const sentence of SAYS) assert.ok(text.includes(sentence), `the definition says: ${sentence}`);
  assert.ok(!text.includes('{{'), 'no placeholder survives rendering');
});

test('agents.reviewer: built-in defaults, the file wins key by key, and the render follows it', () => {
  const none = agentSettings({ OMELETTE_HOME: home() });
  assert.deepEqual(none.reviewer, { model: 'opus', effort: 'xhigh' });
  assert.deepEqual(none.sources.reviewer, { model: 'default', effort: 'default' });
  const set = agentSettings({ OMELETTE_HOME: home({ version: 1, agents: { reviewer: { model: 'sonnet', effort: 'high' } } }) });
  assert.deepEqual(set.reviewer, { model: 'sonnet', effort: 'high' });
  assert.deepEqual(set.sources.reviewer, { model: 'file', effort: 'file' });
  assert.deepEqual(set.warnings, []);
  const text = renderAgentFile('omelette-reviewer.md', '1.2.3', set);
  assert.match(text, /^model: sonnet$/m);
  assert.match(text, /^effort: high$/m);
});

test('agents.reviewer: an invalid value or an unknown key warns, and the default stays in force', () => {
  const s = agentSettings({ OMELETTE_HOME: home({ agents: { reviewer: { effort: 'turbo', model: '', nope: 1 } } }) });
  assert.deepEqual(s.reviewer, { model: 'opus', effort: 'xhigh' });
  assert.ok(s.warnings.some((w) => /agents\.reviewer\.effort = "turbo" is invalid — ignored/.test(w)));
  assert.ok(s.warnings.some((w) => /agents\.reviewer\.model = "" is invalid — ignored/.test(w)));
  assert.ok(s.warnings.some((w) => /agents\.reviewer\.nope is not a known key — ignored/.test(w)));
  assert.match(renderAgentFile('omelette-reviewer.md', '1.2.3', s), /^effort: xhigh$/m);
});

test('set and show round-trip agents.reviewer.*, and set refuses an invalid value without writing', () => {
  const dir = home();
  const s = cli(['set', 'agents.reviewer.model=sonnet', 'agents.reviewer.effort=high'], { dir });
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /^agents\.reviewer\.model {2}opus \[default\] → sonnet \[file\]$/m);
  assert.match(s.out, /^agents\.reviewer\.effort {2}xhigh \[default\] → high \[file\]$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8')).agents, { reviewer: { model: 'sonnet', effort: 'high' } });
  const shown = cli(['show', 'agents'], { dir });
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /^\s+reviewer\.model\s+sonnet\s+file$/m);
  assert.match(shown.out, /^\s+reviewer\.effort\s+high\s+file$/m);

  const fresh = home();
  const defaults = cli(['show', 'agents'], { dir: fresh });
  assert.match(defaults.out, /^\s+reviewer\.model\s+opus\s+default$/m);
  assert.match(defaults.out, /^\s+reviewer\.effort\s+xhigh\s+default$/m);
  const bad = cli(['set', 'agents.reviewer.effort=turbo'], { dir: fresh });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /invalid value for agents\.reviewer\.effort: "turbo" — expected low \| medium \| high \| xhigh \| max/);
  assert.equal(existsSync(join(fresh, 'fleet.config.json')), false, 'a refused set writes nothing');
});

test('rules --agents writes omelette-reviewer.md with the configured values, and doctor counts three definitions', () => {
  const dir = home({ version: 1, agents: { reviewer: { effort: 'max' } } });
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  const r = cli(['rules', '--agents'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  const file = join(proj, '.claude', 'agents', 'omelette-reviewer.md');
  assert.ok(existsSync(file), 'the reviewer definition is written');
  const text = readFileSync(file, 'utf8');
  assert.equal(text.split('\n')[1], AGENT_MARKER(pkgVersion));
  assert.match(text, /^effort: max$/m);
  assert.match(text, /^model: opus$/m);
  const d = cli(['doctor'], { dir, cwd: proj });
  assert.match(d.out, /^agents {8}project: v\d+\.\d+\.\d+\S* \(3\) · global: absent$/m, d.out);
});

test('update --check hints rules --agents for a scope missing the reviewer, even at this install\'s own version, and writes nothing', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  const agents = join(proj, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  // What a 1.2.0 install leaves behind, marked at the running version: the two old definitions, no reviewer.
  for (const f of ['omelette-coder.md', 'omelette-tester.md']) {
    writeFileSync(join(agents, f), `---\n${AGENT_MARKER('0.2.0')}\nname: ${f.replace(/\.md$/, '')}\n---\nold\n`);
  }
  const pkgRoot = mkdtempSync(join(tmpdir(), 'omelette-npm-reviewer-'));
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'omelette-fleet', version: '0.2.0' }, null, 2));
  const r = cli(['update', '--check'], { dir, cwd: proj, env: { OMELETTE_PKG_ROOT: pkgRoot } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^agent files under .*\.claude(\/|\\)agents are v0\.2\.0 \(this install is v0\.2\.0\) — refresh: omelette-fleet rules --agents \(1 of 3 missing\)$/m, r.out);
  assert.equal(existsSync(join(agents, 'omelette-reviewer.md')), false, 'a hint is never a write');
});
