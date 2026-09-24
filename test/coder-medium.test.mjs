// 1.3.0 P2 (spec docs/superpowers/specs/2026-09-24-1.3.0-roles-design.md,
// "P2 — a medium coder beside the deep one"; plan
// docs/superpowers/plans/2026-09-24-1.3.0-P2-coder-medium.md): the fourth
// shipped definition, `omelette-coder-medium`, is the coder's own template
// rendered under a second name from its own `agents.coderMedium` block, and
// `omelette-coder` keeps `effort: xhigh`. Nothing here compares the tree with
// `git show HEAD:…` or pins a rendered size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SETTINGS_SCHEMA } from '../core/config.mjs';
import * as rules from '../core/rules.mjs';

// `AGENT_TEMPLATES` is read off the namespace (`rules.AGENT_TEMPLATES`), so
// before it exists one test fails rather than the whole file at import.
const { AGENT_FILES, AGENT_MARKER, AGENT_ROLES, HOOK_FILES, agentSettings, parseAgentMarker, renderAgentFile, renderHookFile } = rules;

// renderAgentFile() reads the live fleet config when it is given no settings:
// an empty throwaway home keeps the operator's own ~/.omelette out of it.
process.env.OMELETTE_HOME = mkdtempSync(join(tmpdir(), 'omelette-medium-'));

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** A throwaway fleet home, optionally with a config file in it. */
function home(config) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-medium-home-'));
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

/** A rendered definition without its `name:` and `effort:` lines — what the two coders must share. */
const withoutNameAndEffort = (text) => text.split('\n').filter((l) => !/^(name|effort): /.test(l)).join('\n');

/** A file of the repository, as text. */
function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** One section of a Markdown text: its heading line up to the next heading of the same or a higher level. */
function section(md, heading) {
  const from = md.indexOf(`\n${heading}\n`);
  assert.notEqual(from, -1, `${heading} present`);
  const level = heading.match(/^#+/)[0].length;
  const next = new RegExp(`\\n#{1,${level}} `, 'g');
  next.lastIndex = from + 1;
  const m = next.exec(md);
  return md.slice(from, m ? m.index : undefined);
}

/** ORCHESTRATION's "Spawning sub-agents" item for the medium coder, whole. */
const MEDIUM_BULLET = "- **`omelette-coder-medium`** — `model: opus`, `effort: medium`, `disallowedTools: Agent`, otherwise the default tools: the coder's own template rendered under a second name, from its own `agents.coderMedium` block, so its instructions are the coder's word for word and the two cannot drift apart. Which one a brief goes to is the rule under [What each agent is handed](#what-each-agent-is-handed).";
/** The guarded roles, as ORCHESTRATION's Layer 3 and SECURITY's PreToolUse row list them. */
const FOUR_ROLES = '`omelette-coder`, `omelette-coder-medium`, `omelette-tester` or `omelette-reviewer`';

// ── Task 2: the fourth definition renders ────────────────────────────────────

test('rules --agents ships four definitions, the medium coder right after the coder, each with the marker on line 2 and its own name', () => {
  assert.deepEqual(AGENT_FILES, ['omelette-coder.md', 'omelette-coder-medium.md', 'omelette-tester.md', 'omelette-reviewer.md']);
  assert.equal(AGENT_ROLES['omelette-coder-medium.md'], 'coderMedium');
  for (const name of AGENT_FILES) {
    const text = renderAgentFile(name, '1.3.0');
    assert.equal(text.split('\n')[1], AGENT_MARKER('1.3.0'), `${name}: the marker on line 2`);
    assert.equal(parseAgentMarker(text), '1.3.0', `${name}: ours`);
    assert.ok(!text.includes('{{'), `${name}: no placeholder survives`);
    assert.match(text, new RegExp(`^name: ${name.replace(/\.md$/, '')}$`, 'm'), `${name}: its name is its file name`);
  }
});

test('omelette-coder-medium is the coder text with its own name and effort: medium — and omelette-coder stays at xhigh', () => {
  const coder = renderAgentFile('omelette-coder.md', '1.3.0');
  const medium = renderAgentFile('omelette-coder-medium.md', '1.3.0');
  assert.match(medium, /^name: omelette-coder-medium$/m);
  assert.match(medium, /^effort: medium$/m);
  assert.match(medium, /^model: opus$/m);
  assert.match(medium, /^disallowedTools: Agent$/m, 'it may not spawn, exactly as the coder may not');
  assert.match(coder, /^name: omelette-coder$/m);
  assert.match(coder, /^effort: xhigh$/m);
  assert.equal(medium.split('\n').length, coder.split('\n').length, 'no line added or dropped');
  assert.equal(withoutNameAndEffort(medium), withoutNameAndEffort(coder), 'one text: only the name and effort lines differ');
});

test('the medium coder has no template of its own: it renders from agents/omelette-coder.md', () => {
  assert.deepEqual(rules.AGENT_TEMPLATES, { 'omelette-coder-medium.md': 'omelette-coder.md' });
  assert.equal(existsSync(join(ROOT, 'agents', 'omelette-coder-medium.md')), false, 'no second copy of the coder text');
  assert.ok(readFileSync(join(ROOT, 'agents', 'omelette-coder.md'), 'utf8').includes('\nname: {{name}}\n'), 'the coder template takes its name from the file it renders');
});

test('agents.coderMedium: opus at medium by default, on the same effort ladder, and the deep coder keeps xhigh', () => {
  assert.deepEqual(Object.keys(AGENT_SETTINGS_SCHEMA.coderMedium), ['model', 'effort']);
  assert.equal(AGENT_SETTINGS_SCHEMA.coderMedium.model.default, 'opus');
  assert.equal(AGENT_SETTINGS_SCHEMA.coderMedium.effort.default, 'medium');
  assert.deepEqual(AGENT_SETTINGS_SCHEMA.coderMedium.effort.values, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(AGENT_SETTINGS_SCHEMA.coder.effort.default, 'xhigh', 'the default does not move in this release');
  const s = agentSettings({ OMELETTE_HOME: home() });
  assert.deepEqual(s.coderMedium, { model: 'opus', effort: 'medium' });
  assert.deepEqual(s.coder, { model: 'opus', effort: 'xhigh' });
  assert.equal(s.sources.coderMedium.effort, 'default');
  assert.deepEqual(s.warnings, []);
});

test('agents.coderMedium in the config file reaches the medium definition only, with its source', () => {
  const s = agentSettings({ OMELETTE_HOME: home({ version: 1, agents: { coderMedium: { model: 'sonnet', effort: 'high' } } }) });
  assert.deepEqual(s.coderMedium, { model: 'sonnet', effort: 'high' });
  assert.equal(s.sources.coderMedium.model, 'file');
  assert.equal(s.sources.coderMedium.effort, 'file');
  assert.deepEqual(s.coder, { model: 'opus', effort: 'xhigh' }, 'the deep coder is a block of its own');
  assert.deepEqual(s.warnings, []);
  const medium = renderAgentFile('omelette-coder-medium.md', '1.3.0', s);
  assert.match(medium, /^model: sonnet$/m);
  assert.match(medium, /^effort: high$/m);
  const coder = renderAgentFile('omelette-coder.md', '1.3.0', s);
  assert.match(coder, /^model: opus$/m);
  assert.match(coder, /^effort: xhigh$/m);
});

test('an invalid agents.coderMedium value is a warning and the medium default stays in force — never a throw', () => {
  const s = agentSettings({ OMELETTE_HOME: home({ agents: { coderMedium: { effort: 'turbo', model: '', maxTurns: 5 } } }) });
  assert.deepEqual(s.coderMedium, { model: 'opus', effort: 'medium' });
  assert.ok(s.warnings.some((w) => /agents\.coderMedium\.effort = "turbo" is invalid — ignored/.test(w)));
  assert.ok(s.warnings.some((w) => /agents\.coderMedium\.model = "" is invalid — ignored/.test(w)));
  assert.ok(s.warnings.some((w) => /agents\.coderMedium\.maxTurns is not a known key — ignored/.test(w)));
});

test('rules --agents writes omelette-coder-medium.md beside the coder, rendered from agents.coderMedium', () => {
  const dir = home({ version: 1, agents: { coderMedium: { effort: 'low' } } });
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const r = cli(['rules', '--agents'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  for (const f of AGENT_FILES) assert.ok(existsSync(join(proj, '.claude', 'agents', f)), `${f} is written`);
  assert.match(r.out, /written .*omelette-coder-medium\.md/);
  const medium = readFileSync(join(proj, '.claude', 'agents', 'omelette-coder-medium.md'), 'utf8');
  assert.match(medium, /^name: omelette-coder-medium$/m);
  assert.match(medium, /^effort: low$/m);
  assert.match(readFileSync(join(proj, '.claude', 'agents', 'omelette-coder.md'), 'utf8'), /^effort: xhigh$/m, 'a medium setting never reaches the deep coder');
});

test('rules --agents warns about an invalid agents.coderMedium value on stderr and writes the medium default', () => {
  const dir = home({ version: 1, agents: { coderMedium: { effort: 'turbo' } } });
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const r = cli(['rules', '--agents'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /agents\.coderMedium\.effort = "turbo" is invalid/);
  assert.match(readFileSync(join(proj, '.claude', 'agents', 'omelette-coder-medium.md'), 'utf8'), /^effort: medium$/m);
});

test('show agents lists coderMedium.model and coderMedium.effort, each with its source', () => {
  const dir = home({ version: 1, agents: { coderMedium: { effort: 'high' } } });
  const r = cli(['show', 'agents'], { dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\s+coderMedium\.model\s+opus\s+default$/m);
  assert.match(r.out, /^\s+coderMedium\.effort\s+high\s+file$/m);
  assert.match(r.out, /^\s+coder\.effort\s+xhigh\s+default$/m);
});

test('every definition rules --agents ships is a role the guard refuses by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-medium-guard-'));
  const guard = join(dir, 'omelette-guard.mjs');
  writeFileSync(guard, renderHookFile(HOOK_FILES[0], '1.3.0'));
  for (const name of AGENT_FILES) {
    const agent = name.replace(/\.md$/, '');
    const r = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: agent, tool_input: { command: 'git commit -m "x"' } }),
      encoding: 'utf8', cwd: dir, timeout: 20000,
    });
    assert.equal(r.status, 2, `${agent} ships, so the guard contains it: ${r.stdout}${r.stderr}`);
    assert.equal(r.stderr.trim(), `${agent} never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead`);
  }
});

test('rules --help and install --help count four definitions, the medium coder among them', () => {
  const dir = home();
  const rulesHelp = cli(['rules', '--help'], { dir });
  assert.equal(rulesHelp.code, 0, rulesHelp.err);
  assert.match(rulesHelp.out, /--agents also writes four sub-agent definitions/);
  assert.match(rulesHelp.out, /omelette-coder-medium: Opus medium;/);
  assert.match(cli(['install', '--help'], { dir }).out, /the four sub-agent definitions/);
});

// ── Task 3: `set` reaches agents.coderMedium ─────────────────────────────────

test('set agents.coderMedium.<key> round-trips: written under the schema\'s spelling, in any case, and read back by show and rules --agents', () => {
  const dir = home();
  const s = cli(['set', 'agents.coderMedium.effort=high'], { dir });
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /agents\.coderMedium\.effort\s+medium \[default\] → high \[file\]/);
  assert.match(s.out, /rules --agents/, 'a changed setting reaches the definition on the next re-render');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8')).agents, { coderMedium: { effort: 'high' } });
  // the role name was always matched without regard to case; a camelCase role keeps that
  assert.equal(cli(['set', 'agents.CODERMEDIUM.model=sonnet'], { dir }).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8')).agents, { coderMedium: { effort: 'high', model: 'sonnet' } });
  const shown = cli(['show', 'agents'], { dir });
  assert.match(shown.out, /^\s+coderMedium\.model\s+sonnet\s+file$/m);
  assert.match(shown.out, /^\s+coderMedium\.effort\s+high\s+file$/m);
  const proj = join(dir, 'proj'); mkdirSync(proj);
  assert.equal(cli(['rules', '--agents'], { dir, cwd: proj }).code, 0);
  const medium = readFileSync(join(proj, '.claude', 'agents', 'omelette-coder-medium.md'), 'utf8');
  assert.match(medium, /^model: sonnet$/m);
  assert.match(medium, /^effort: high$/m);
  assert.match(readFileSync(join(proj, '.claude', 'agents', 'omelette-coder.md'), 'utf8'), /^effort: xhigh$/m, 'the deep coder is untouched');
});

test('set refuses an invalid agents.coderMedium value and a key the role does not have — exit 1, nothing written', () => {
  const dir = home();
  const effort = cli(['set', 'agents.coderMedium.effort=turbo'], { dir });
  assert.equal(effort.code, 1);
  assert.match(effort.err, /invalid value for agents\.coderMedium\.effort: "turbo" — expected low \| medium \| high \| xhigh \| max/);
  const key = cli(['set', 'agents.coderMedium.maxTurns=5'], { dir });
  assert.equal(key.code, 1);
  assert.match(key.err, /unknown key "maxTurns" for agent "coderMedium" — known keys: model, effort/);
  const role = cli(['set', 'agents.coder-medium.effort=high'], { dir });
  assert.equal(role.code, 1, 'the key is agents.coderMedium, not the file name');
  assert.match(role.err, /unknown agent "coder-medium" — known agents: coder, coderMedium, tester, reviewer/);
  assert.equal(existsSync(join(dir, 'fleet.config.json')), false);
});

// ── Task 7: ORCHESTRATION lists four definitions ─────────────────────────────

test('ORCHESTRATION: "Spawning sub-agents" lists the four definitions, the medium coder right after the coder, and Layer 3 names the four guarded roles', () => {
  const md = read('docs/ORCHESTRATION.md');
  const spawning = section(md, '## Spawning sub-agents: model and effort');
  const lines = spawning.split('\n');
  assert.ok(lines.includes('`omelette-fleet rules --agents` writes four of these next to the rules file:'), 'the count sentence says four');
  const coder = lines.findIndex((l) => l.startsWith('- **`omelette-coder`** — '));
  assert.notEqual(coder, -1, 'the coder item is there');
  assert.equal(lines[coder + 1], MEDIUM_BULLET, 'the medium coder follows it, whole');
  for (const name of ['omelette-tester', 'omelette-reviewer']) assert.ok(lines.some((l) => l.startsWith(`- **\`${name}\`**`)), `${name} is listed`);
  assert.ok(spawning.includes('Select them with `subagent_type: omelette-coder` / `omelette-coder-medium` / '), 'selected by name');
  assert.ok(spawning.includes('All four are refreshed by re-running the command'), 'the refresh sentence counts four');
  assert.ok(spawning.includes('`disallowedTools: Agent` in every shipped definition takes the possibility away'), 'the nesting paragraph does not count');
  assert.ok(spawning.includes('for EVERY shipped role'), 'nor does its guard sentence');
  assert.doesNotMatch(spawning, /both shipped|BOTH shipped|Both are refreshed/, 'no sentence still counts two');
  assert.ok(md.includes(`when the caller is one of the four roles this package ships — ${FOUR_ROLES} — and the command is`), 'Layer 3 names the four guarded roles');
});

// ── Task 8: CONFIG documents agents.coderMedium ──────────────────────────────

test('CONFIG "Agent settings": agents.coderMedium.* rows, the 1.2.0 trial as the reason, the coder\'s default unchanged, and what a default change does to a rendered file', () => {
  const agentSection = section(read('docs/CONFIG.md'), '### Agent settings');
  const lines = agentSection.split('\n');
  assert.ok(agentSection.includes('the four Claude Code sub-agent definitions'), 'the intro counts four');
  const effortRow = lines.findIndex((l) => l.startsWith('| `agents.coder.effort` |'));
  assert.notEqual(effortRow, -1, 'the coder effort row');
  assert.ok(lines[effortRow + 1].startsWith('| `agents.coderMedium.model` | one printable line | `"opus"` |'), 'the model row follows the coder rows');
  assert.ok(lines[effortRow + 2].startsWith('| `agents.coderMedium.effort` | `low` \\| `medium` \\| `high` \\| `xhigh` \\| `max` | `"medium"` |'), 'the effort row, default medium');
  assert.ok(agentSection.includes('(MEASUREMENTS.md#coder-effort-medium-high-xhigh-on-one-task)'), 'the 1.2.0 trial is the reason');
  assert.ok(read('docs/MEASUREMENTS.md').includes('\n## Coder effort: medium, high, xhigh on one task\n'), 'and the anchor is a heading there');
  assert.ok(agentSection.includes('so `agents.coder.effort` stays `"xhigh"`'), 'the deep coder keeps its default');
  for (const fact of [
    'reaches it only when `omelette-fleet rules --agents` runs',
    'a key you never set follows the new default',
    '`omelette-fleet set agents.coder.effort=xhigh` survives any later change of the default',
    'already sets `agents.coder` and `agents.tester` explicitly',
    'it does not compare what they say with the config',
  ]) assert.ok(agentSection.includes(fact), `the migration paragraph says: ${fact}`);
});

// ── Task 9: SECURITY names the medium coder ──────────────────────────────────

test('SECURITY: the PreToolUse row names the four guarded roles, and rules --agents writes the medium coder too', () => {
  const lines = read('docs/SECURITY.md').split('\n');
  const pre = lines.find((l) => l.startsWith('- **`PreToolUse`, matcher `Bash`.**'));
  assert.ok(pre, 'the PreToolUse row');
  assert.ok(pre.includes(`When the caller is one of the four sub-agent roles this package ships — ${FOUR_ROLES} — *and* the command is`), 'four roles, each by name');
  const writes = lines.find((l) => l.includes('The one command that writes into a project is'));
  assert.ok(writes && writes.includes('`.claude/agents/omelette-coder.md`, `.claude/agents/omelette-coder-medium.md`, '), 'the medium coder is among the files --agents writes');
});
