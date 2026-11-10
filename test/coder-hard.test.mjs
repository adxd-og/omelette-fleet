// 1.10.0 (spec docs/superpowers/specs/2026-11-10-hard-coder-design.md, "1. The
// roles" and "5. Tests"; plan docs/superpowers/plans/2026-11-10-1.10.0-hard-coder.md,
// Task 1): `omelette-coder-hard` (agents.coderHard, claude-fable-5-2 at high)
// and `omelette-coder-xhard` (agents.coderXhard, claude-fable-5-2 at xhigh)
// are the coder's own template under two more names; the guard contains each
// by its whole name, the mod reads their definitions, and the pane labels them
// whole. Nothing here reads source text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SETTINGS_SCHEMA } from '../core/config.mjs';
import { AGENT_FILES, HOOK_FILES, agentSettings, renderAgentFile, renderHookFile } from '../core/rules.mjs';
import { layout, plainRows } from '../mods/omelette-fleet/hooks/layout.mjs';
import { namesModel, readRoleDefinitions, ROLES } from '../mods/omelette-fleet/hooks/roles.mjs';
import { shortRole } from '../mods/omelette-fleet/hooks/text.mjs';

// renderAgentFile() and renderHookFile() read the live fleet config when given
// no settings: an empty throwaway home keeps the operator's own ~/.omelette out.
process.env.OMELETTE_HOME = mkdtempSync(join(tmpdir(), 'omelette-hard-'));

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const FABLE = 'claude-fable-5-2';

/** The two roles: definition name, config block, default effort (spec "1. The roles"). */
const HARD = [
  { agent: 'omelette-coder-hard', role: 'coderHard', effort: 'high' },
  { agent: 'omelette-coder-xhard', role: 'coderXhard', effort: 'xhigh' },
];

/** A throwaway fleet home, optionally with a config file in it. */
function home(config) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-hard-home-'));
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

/** A rendered definition's body: everything after the frontmatter's closing `---`. */
function body(text) {
  const end = text.indexOf('\n---\n');
  assert.notEqual(end, -1, 'the frontmatter closes');
  return text.slice(end + '\n---\n'.length);
}

/** One frontmatter line's value, or undefined when the line is absent. */
const field = (text, key) => (text.match(new RegExp(`^${key}: (.*)$`, 'm')) || [])[1];

test('each hard coder is the coder\'s text with its own name, claude-fable-5-2 and its effort — high, then xhigh', () => {
  const coder = renderAgentFile('omelette-coder.md', '1.10.0');
  for (const { agent, effort } of HARD) {
    const text = renderAgentFile(`${agent}.md`, '1.10.0');
    assert.match(text, new RegExp(`^name: ${agent}$`, 'm'));
    assert.match(text, /^model: claude-fable-5-2$/m, agent);
    assert.match(text, new RegExp(`^effort: ${effort}$`, 'm'), agent);
    assert.match(text, /^disallowedTools: Agent$/m, `${agent}: it may not spawn, as the coder may not`);
    assert.equal(text.split('\n').length, coder.split('\n').length, `${agent}: no line added or dropped`);
    assert.equal(body(text), body(coder), `${agent}: one body — the coder's word for word`);
  }
});

/** The coder's `description:` as 1.10.0 shipped it, byte for byte. */
const CODER_DESCRIPTION = 'Implements ONE task from a written brief — code and tests only, no commits unless the brief says so. Spawned by the orchestrating session; reviewed by it afterwards.';

test('each coder\'s description is its own: four distinct, the coder\'s unchanged, the hard one a named route only, the extra-hard one never a first dispatch — and no definition renders a placeholder', () => {
  const description = (name) => field(renderAgentFile(name, '1.10.0'), 'description');
  const coders = ['omelette-coder.md', 'omelette-coder-medium.md', 'omelette-coder-hard.md', 'omelette-coder-xhard.md'];
  const all = coders.map(description);
  assert.equal(new Set(all).size, coders.length, `pairwise distinct:\n${all.join('\n')}`);
  assert.equal(description('omelette-coder.md'), CODER_DESCRIPTION);
  assert.ok(description('omelette-coder-hard.md').includes('named route only'), description('omelette-coder-hard.md'));
  assert.ok(description('omelette-coder-xhard.md').includes('never a first dispatch'), description('omelette-coder-xhard.md'));
  for (const name of AGENT_FILES) assert.ok(!renderAgentFile(name, '1.10.0').includes('{{'), `${name}: no placeholder survives`);
});

test('agents.coderHard and agents.coderXhard: claude-fable-5-2 at high and at xhigh by default, model and effort only, on the coder\'s ladder', () => {
  for (const { role, effort } of HARD) {
    assert.deepEqual(Object.keys(AGENT_SETTINGS_SCHEMA[role]), ['model', 'effort'], role);
    assert.equal(AGENT_SETTINGS_SCHEMA[role].model.default, FABLE, role);
    assert.equal(AGENT_SETTINGS_SCHEMA[role].effort.default, effort, role);
    assert.deepEqual(AGENT_SETTINGS_SCHEMA[role].effort.values, AGENT_SETTINGS_SCHEMA.coder.effort.values, `${role}: the coder's ladder`);
  }
  const s = agentSettings({ OMELETTE_HOME: home() });
  assert.deepEqual(s.coderHard, { model: FABLE, effort: 'high' });
  assert.deepEqual(s.coderXhard, { model: FABLE, effort: 'xhigh' });
  assert.deepEqual(s.sources.coderXhard, { model: 'default', effort: 'default' });
  assert.deepEqual(s.coder, { model: 'claude-opus-5-5', effort: 'xhigh' }, 'the coder does not move');
  assert.deepEqual(s.warnings, []);
});

test('agents.coderHard in the config file reaches the hard coder only; an invalid agents.coderXhard level is a warning and its default stays', () => {
  const s = agentSettings({ OMELETTE_HOME: home({ version: 1, agents: { coderHard: { effort: 'max' }, coderXhard: { effort: 'turbo' } } }) });
  assert.deepEqual(s.coderHard, { model: FABLE, effort: 'max' });
  assert.equal(s.sources.coderHard.effort, 'file');
  assert.deepEqual(s.coderXhard, { model: FABLE, effort: 'xhigh' });
  assert.ok(s.warnings.some((w) => /agents\.coderXhard\.effort = "turbo" is invalid — ignored/.test(w)), s.warnings.join('\n'));
  assert.match(renderAgentFile('omelette-coder-hard.md', '1.10.0', s), /^effort: max$/m);
  assert.match(renderAgentFile('omelette-coder-xhard.md', '1.10.0', s), /^effort: xhigh$/m);
  assert.match(renderAgentFile('omelette-coder.md', '1.10.0', s), /^effort: xhigh$/m, 'the coder is a block of its own');
});

test('set agents.coderHard.effort reaches the hard coder\'s file on the next rules --agents and leaves the extra-hard one alone', () => {
  const dir = home();
  const set = cli(['set', 'agents.coderHard.effort=medium'], { dir });
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /agents\.coderHard\.effort\s+high \[default\] → medium \[file\]/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8')).agents, { coderHard: { effort: 'medium' } });
  const shown = cli(['show', 'agents'], { dir });
  assert.match(shown.out, /^\s+coderHard\.effort\s+medium\s+file$/m);
  assert.match(shown.out, /^\s+coderXhard\.effort\s+xhigh\s+default$/m);
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const r = cli(['rules', '--agents'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  const agent = (name) => readFileSync(join(proj, '.claude', 'agents', name), 'utf8');
  assert.match(agent('omelette-coder-hard.md'), /^effort: medium$/m);
  assert.match(agent('omelette-coder-hard.md'), /^model: claude-fable-5-2$/m);
  assert.match(agent('omelette-coder-xhard.md'), /^name: omelette-coder-xhard$/m);
  assert.match(agent('omelette-coder-xhard.md'), /^effort: xhigh$/m, 'the extra-hard coder keeps its own default');
  assert.match(agent('omelette-coder.md'), /^effort: xhigh$/m, 'and the coder its own');
});

test('set refuses an invalid level for either hard coder, and the file name as a key — exit 1, nothing written', () => {
  const dir = home();
  for (const { role } of HARD) {
    const r = cli(['set', `agents.${role}.effort=turbo`], { dir });
    assert.equal(r.code, 1, `${role}: ${r.out}${r.err}`);
    assert.match(r.err, new RegExp(`invalid value for agents\\.${role}\\.effort: "turbo" — expected low \\| medium \\| high \\| xhigh \\| max`));
  }
  const name = cli(['set', 'agents.coder-hard.effort=high'], { dir });
  assert.equal(name.code, 1, 'the key is agents.coderHard, not the file name');
  assert.match(name.err, /unknown agent "coder-hard" — known agents: coder, coderMedium, coderHard, coderXhard, tester, reviewer/);
  assert.equal(existsSync(join(dir, 'fleet.config.json')), false);
});

test('the guard refuses a git write by either hard coder and names the one it caught; a name around either is somebody else\'s agent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-hard-guard-'));
  const guard = join(dir, 'omelette-guard.mjs');
  writeFileSync(guard, renderHookFile(HOOK_FILES[0], '1.10.0'));
  const fire = (agent_type, command) => spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type, tool_input: { command } }),
    encoding: 'utf8', cwd: dir, timeout: 20000,
  });
  for (const { agent } of HARD) {
    for (const command of ['git commit -m "wip"', 'git stash', 'git switch -c feat/x']) {
      const r = fire(agent, command);
      assert.equal(r.status, 2, `${agent}: ${command} should be refused: ${r.stdout}${r.stderr}`);
      assert.equal(r.stderr.trim(), `${agent} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`);
    }
    const read = fire(agent, 'git diff HEAD');
    assert.equal(read.status, 0, `${agent}: a read passes: ${read.stderr}`);
  }
  for (const agent of ['omelette-coder-hard-2', 'omelette-coder-xhard-2', 'my-omelette-coder-hard', 'omelette-coder-har', 'omelette-coder-hard ', 'OMELETTE-CODER-XHARD', 'omelette-coder-extra-hard']) {
    const r = fire(agent, 'git commit -m "x"');
    assert.equal(r.status, 0, `${JSON.stringify(agent)} is not guarded: ${r.stdout}${r.stderr}`);
    assert.equal(r.stderr, '', `${JSON.stringify(agent)} printed to stderr`);
  }
});

test('the mod reads both hard coders\' definitions, the project\'s first, then HOME\'s; another model asked for is a pin, claude-fable-5-2 is none', async () => {
  const definition = (name, effort) => ['---', `name: ${name}`, `model: ${FABLE}`, `effort: ${effort}`, 'disallowedTools: Agent', '---', '', 'body', ''].join('\n');
  const files = {
    '/w/p/.claude/agents/omelette-coder-hard.md': definition('omelette-coder-hard', 'high'),
    '/h/.claude/agents/omelette-coder-xhard.md': definition('omelette-coder-xhard', 'xhigh'),
  };
  const $ = {
    env: { get: async (name) => (name === 'HOME' ? '/h' : undefined) },
    fs: {
      read: async (path) => {
        if (files[path] === undefined) throw new Error(`ENOENT: ${path}`);
        return files[path];
      },
    },
  };
  const roles = await readRoleDefinitions($, '/w/p');
  assert.deepEqual(roles.get('omelette-coder-hard'), { model: FABLE, effort: 'high' }, 'from the project');
  assert.deepEqual(roles.get('omelette-coder-xhard'), { model: FABLE, effort: 'xhigh' }, 'from HOME');
  for (const { agent } of HARD) {
    for (const asked of ['opus', 'claude-opus-5-5', 'haiku', 'claude-fable-5-1']) {
      assert.equal(namesModel(asked, roles.get(agent).model), false, `${agent} asked for ${asked}: pinned to ${FABLE}`);
    }
    assert.equal(namesModel(FABLE, roles.get(agent).model), true, `${agent}: its own id is no pin`);
  }
});

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

/** The orchestrator, the four units idle, and `agents` beneath the orchestrator, each running `npm test`. */
const paneWith = (...agents) => ({
  now: NOW, isOpen: true, usage: {}, history: [],
  nodes: [
    { id: 'main', kind: 'orchestrator', role: 'orchestrator', status: 'running', since: NOW - 60000, order: 0 },
    ...['gemini', 'grok', 'codex', 'mistral'].map((name, i) => ({ id: `unit:${name}`, kind: 'unit', role: name, status: 'idle', since: NOW - 60000, feed: 'ok', order: i + 1 })),
    ...agents.map((fields, i) => ({ id: `a${i}`, kind: 'agent', parentId: 'main', status: 'running', activity: 'Bash: npm test', since: NOW - 60000, order: 5 + i, ...fields })),
  ],
});

test('the pane labels every guarded role whole in a graph box, coder-hard and coder-xhard among them, with fable and the effort under each', () => {
  const labels = ROLES.map(shortRole);
  assert.ok(labels.includes('coder-hard') && labels.includes('coder-xhard'), labels.join(', '));
  for (const role of ROLES) {
    const graph = plainRows(layout(paneWith({ role }), { columns: 71, rows: 40 })).join('\n');
    assert.ok(graph.includes(`│ ▶ ${shortRole(role)}`), `${role}:\n${graph}`);
    assert.ok(!graph.includes('…'), `${role}: nothing cut:\n${graph}`);
  }
  const both = paneWith(
    { role: 'omelette-coder-hard', model: FABLE, effort: 'high' },
    { role: 'omelette-coder-xhard', model: FABLE, effort: 'xhigh' },
  );
  const graph = plainRows(layout(both, { columns: 71, rows: 40 })).join('\n');
  for (const box of ['│ ▶ coder-hard  │', '│ fable · high  │', '│ ▶ coder-xhard │', '│ fable · xhigh │']) assert.ok(graph.includes(box), `${box}:\n${graph}`);
  const tree = plainRows(layout(both, { columns: 40, rows: 40 }));
  assert.ok(tree.includes('├ ▶ coder-hard  fable · high'), tree.join('\n'));
  assert.ok(tree.includes('├ ▶ coder-xhard  fable · xhigh'), tree.join('\n'));
});
