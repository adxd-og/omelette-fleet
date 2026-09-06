import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_FILES, AGENT_MARKER, AGENT_ROLES, FLEET_CONTRACT, HOOK_EVENTS, HOOK_FILES, HOOK_MARKER, HOOK_TEMPLATE_DIR, KINDS,
  RULES_FILE_NAME, RULES_MARKER, RULES_TEMPLATE_PATH, SETTINGS_FILES, SKILL_FILES, SKILL_MARKER,
  SKILL_TEMPLATE_DIR,
  agentSettings, agentsTarget, hookSettingsSnippet, hooksTarget, parseAgentMarker, parseHookMarker, parseRulesMarker, parseSkillMarker,
  renderAgentFile, renderHookFile, renderRulesFile, renderSkillFile, rulesTarget, settingsTarget, settingsTargets,
  skillsTarget, unitInstructions,
} from '../core/rules.mjs';

// renderAgentFile() falls back to the machine's fleet config for its settings
// (read at call time, never at import), so every default-argument render in this
// file is pointed at an empty throwaway home: the built-in defaults, whatever the
// operator's own ~/.omelette happens to hold.
process.env.OMELETTE_HOME = mkdtempSync(join(tmpdir(), 'omelette-rules-'));

/** A throwaway fleet home, optionally with a config file in it. */
function home(config) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-agentcfg-'));
  if (config !== undefined) writeFileSync(join(dir, 'fleet.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

test('FLEET_CONTRACT is short plain text that names the two rules that matter', () => {
  assert.ok(FLEET_CONTRACT.length < 1800, `contract is ${FLEET_CONTRACT.length} chars — keep it under one screen`);
  assert.ok(!/^#/m.test(FLEET_CONTRACT), 'no markdown headers in an instructions block');
  assert.match(FLEET_CONTRACT, /propose/i);
  assert.match(FLEET_CONTRACT, /Grok/);
  assert.match(FLEET_CONTRACT, /omelette-fleet rules/);
});

test('unitInstructions appends the unit line after a blank line, and copes with none', () => {
  assert.equal(unitInstructions({ name: 'x' }), FLEET_CONTRACT);
  assert.equal(unitInstructions({ name: 'x', instructions: '' }), FLEET_CONTRACT);
  assert.equal(unitInstructions({ name: 'x', instructions: 'This unit: X.' }), `${FLEET_CONTRACT}\n\nThis unit: X.`);
});

test('the template ships, renders its version everywhere, and round-trips through the marker parser', () => {
  assert.ok(existsSync(RULES_TEMPLATE_PATH));
  // The template does not retype the marker: it asks for it by placeholder.
  assert.match(readFileSync(RULES_TEMPLATE_PATH, 'utf8'), /\{\{marker\}\}/);
  const text = renderRulesFile('1.2.3');
  assert.ok(!/\{\{[a-z]+\}\}/.test(text), 'no placeholder survives rendering');
  assert.equal(parseRulesMarker(text), '1.2.3');
  assert.ok(text.startsWith('<!-- omelette-fleet rules v1.2.3'));
  assert.ok(text.endsWith('\n'));
});

test('parseRulesMarker rejects anything that is not ours', () => {
  assert.equal(parseRulesMarker(''), null);
  assert.equal(parseRulesMarker('# My own rules\n'), null);
  assert.equal(parseRulesMarker('\n<!-- omelette-fleet rules v1.0.0 -->'), null, 'the marker must be the FIRST line');
  assert.equal(parseRulesMarker('<!-- omelette-fleet rules vgarbage -->'), null);
});

test('the marker builders are the ONE source the templates, the renderers and the parsers share', () => {
  assert.equal(RULES_MARKER('1.2.3'), '<!-- omelette-fleet rules v1.2.3 · managed by `omelette-fleet rules` · edits are overwritten on refresh -->');
  assert.equal(AGENT_MARKER('1.2.3'), '# omelette-fleet agent v1.2.3 · managed by `omelette-fleet rules --agents` · edits are overwritten on refresh');
  // What the renderers emit IS the builder's line — the literal is never retyped.
  assert.equal(renderRulesFile('1.2.3').split('\n')[0], RULES_MARKER('1.2.3'));
  for (const name of AGENT_FILES) assert.equal(renderAgentFile(name, '1.2.3').split('\n')[1], AGENT_MARKER('1.2.3'));
  // \u2026and what the builders emit is what the parsers accept, whole.
  assert.equal(parseRulesMarker(RULES_MARKER('1.2.3') + '\nbody\n'), '1.2.3');
  assert.equal(parseAgentMarker('---\n' + AGENT_MARKER('1.2.3') + '\nname: x\n'), '1.2.3');
});

test('parseRulesMarker demands the EXACT generated marker line, not a prefix of it', () => {
  // A line that merely opens like ours is somebody else's file: ownership is the
  // full marker or nothing, or `--force`-less overwrites become guessable.
  assert.equal(parseRulesMarker('<!-- omelette-fleet rules v1.0.0 -->'), null, 'prefix + version alone is not the marker');
  assert.equal(parseRulesMarker('<!-- omelette-fleet rules v1.0.0 -->\nbody\n'), null);
  assert.equal(parseRulesMarker('<!-- omelette-fleet rules v1.0.0 · managed -->\n'), null, 'truncated middle');
  assert.equal(parseRulesMarker('<!-- omelette-fleet rules v1.0.0 · managed by -->\n'), null, 'truncated after "managed by"');
  assert.equal(parseRulesMarker('<!-- omelette-fleet rules v1.0.0 · managed by someone else -->\n'), null, 'managed by someone else');
  assert.equal(parseRulesMarker('<!-- omelette-fleet rules v1.0.0 · managed by `omelette-fleet rules` -->\n'), null, 'the marker\'s tail is part of it');
  assert.equal(parseRulesMarker(RULES_MARKER('1.0.0') + ' plus a tail\n'), null, 'trailing garbage after the marker');
  assert.equal(parseRulesMarker('x' + RULES_MARKER('1.0.0') + '\n'), null, 'leading garbage before the marker');
  assert.equal(parseRulesMarker(RULES_MARKER('1.0.0') + '\n'), '1.0.0');
});

test('rulesTarget: project under cwd, global under ~/.claude or CLAUDE_CONFIG_DIR', () => {
  assert.deepEqual(rulesTarget({ cwd: '/w/p', env: {} }), { path: '/w/p/.claude/rules/omelette-fleet.md', scope: 'project' });
  assert.deepEqual(rulesTarget({ global: true, env: {} }), { path: join(homedir(), '.claude', 'rules', RULES_FILE_NAME), scope: 'global' });
  assert.deepEqual(rulesTarget({ global: true, env: { CLAUDE_CONFIG_DIR: '/cfg' } }), { path: '/cfg/rules/omelette-fleet.md', scope: 'global' });
  assert.equal(rulesTarget({ global: true, env: { CLAUDE_CONFIG_DIR: '  ' } }).path, join(homedir(), '.claude', 'rules', RULES_FILE_NAME));
});

test('agent templates render with a YAML-comment marker on line 2 and valid frontmatter', () => {
  assert.deepEqual(AGENT_FILES, ['omelette-coder.md', 'omelette-tester.md']);
  for (const name of AGENT_FILES) {
    const text = renderAgentFile(name, '1.2.3');
    const lines = text.split('\n');
    assert.equal(lines[0], '---');
    assert.match(lines[1], /^# omelette-fleet agent v1\.2\.3 /);
    assert.equal(parseAgentMarker(text), '1.2.3');
    assert.match(text, /^name: omelette-(coder|tester)$/m);
    assert.match(text, /^effort: xhigh$/m);
    assert.match(text, /^model: (opus|sonnet)$/m);
    // Enforced by the harness, not by prose: neither shipped role may spawn.
    assert.match(text, /^disallowedTools: Agent$/m);
    assert.ok(text.indexOf('\n---\n', 4) > 0, 'frontmatter is closed');
    assert.ok(!text.includes('{{version}}'));
  }
  assert.match(renderAgentFile('omelette-tester.md', '0.0.0'), /^tools: Read, Glob, Grep, Bash, Write, Edit$/m);
});

test('parseAgentMarker rejects a file without the line-2 comment', () => {
  assert.equal(parseAgentMarker('---\nname: mine\n---\n'), null);
  assert.equal(parseAgentMarker('# omelette-fleet agent v1.0.0 x\n'), null);
});

test('parseAgentMarker demands the EXACT generated marker line, not a prefix of it', () => {
  assert.equal(parseAgentMarker('---\n# omelette-fleet agent v1.0.0\nname: mine\n'), null, 'prefix + version alone is not the marker');
  assert.equal(parseAgentMarker('---\n# omelette-fleet agent v1.0.0 x\nname: mine\n'), null, 'garbage after the version is not the marker');
  assert.equal(parseAgentMarker('---\n# omelette-fleet agent v1.0.0 · managed by\nname: mine\n'), null, 'truncated after "managed by"');
  assert.equal(parseAgentMarker('---\n# omelette-fleet agent v1.0.0 · managed by someone else\nname: mine\n'), null, 'managed by someone else');
  assert.equal(parseAgentMarker('---\n# omelette-fleet agent v1.0.0 · managed by `omelette-fleet rules --agents`\nname: mine\n'), null, 'the marker\'s tail is part of it');
  assert.equal(parseAgentMarker('---\n' + AGENT_MARKER('1.0.0') + ' plus a tail\nname: mine\n'), null, 'trailing garbage after the marker');
  assert.equal(parseAgentMarker(AGENT_MARKER('1.0.0') + '\n'), null, 'line 1 must be the frontmatter opener');
  assert.equal(parseAgentMarker('---\n' + AGENT_MARKER('1.0.0') + '\nname: mine\n'), '1.0.0');
});

test('agentsTarget mirrors rulesTarget', () => {
  assert.deepEqual(agentsTarget({ cwd: '/w/p', env: {} }), { dir: '/w/p/.claude/agents', scope: 'project' });
  assert.equal(agentsTarget({ global: true, env: { CLAUDE_CONFIG_DIR: '/cfg' } }).dir, '/cfg/agents');
});

// ─── agent settings (fleet config → template) ────────────────────────────────

test('agentSettings: no file at all is the built-in defaults, sourced "default", with no warnings', () => {
  const s = agentSettings({ OMELETTE_HOME: home() });
  assert.deepEqual(s.coder, { model: 'opus', effort: 'xhigh' });
  assert.deepEqual(s.tester, { model: 'sonnet', effort: 'xhigh', maxTurns: 80 });
  assert.deepEqual(s.warnings, []);
  assert.equal(s.sources.tester.maxTurns, 'default');
  assert.equal(s.sources.coder.model, 'default');
  assert.match(s.configPath, /fleet\.config\.json$/);
});

test('agentSettings: the file wins key by key, and the source says so', () => {
  const s = agentSettings({ OMELETTE_HOME: home({ version: 1, agents: { tester: { maxTurns: 120, model: 'haiku' } } }) });
  assert.equal(s.tester.maxTurns, 120);
  assert.equal(s.sources.tester.maxTurns, 'file');
  assert.equal(s.tester.model, 'haiku');
  assert.equal(s.tester.effort, 'xhigh');
  assert.equal(s.sources.tester.effort, 'default', 'a key the file does not set stays the default');
  assert.deepEqual(s.coder, { model: 'opus', effort: 'xhigh' });
  assert.deepEqual(s.warnings, []);
});

test('agentSettings: an invalid value is a warning and the default stays in force — never a throw', () => {
  const s = agentSettings({ OMELETTE_HOME: home({ agents: { coder: { effort: 'turbo', model: '' }, tester: { maxTurns: 0, nope: 1 } } }) });
  assert.equal(s.coder.effort, 'xhigh');
  assert.equal(s.coder.model, 'opus');
  assert.equal(s.tester.maxTurns, 80);
  assert.ok(s.warnings.some((w) => /agents\.coder\.effort = "turbo" is invalid/.test(w)));
  assert.ok(s.warnings.some((w) => /agents\.coder\.model = "" is invalid/.test(w)));
  assert.ok(s.warnings.some((w) => /agents\.tester\.maxTurns = 0 is invalid/.test(w)));
  assert.ok(s.warnings.some((w) => /agents\.tester\.nope is not a known key/.test(w)));
});

test('agentSettings: a block of the wrong shape, an unknown role and a malformed file all warn and default', () => {
  const arr = agentSettings({ OMELETTE_HOME: home({ agents: ['coder'] }) });
  assert.equal(arr.coder.model, 'opus');
  assert.ok(arr.warnings.some((w) => /agents is not an object/.test(w)));

  const str = agentSettings({ OMELETTE_HOME: home({ agents: { tester: 'sonnet', reviewer: { model: 'x' } } }) });
  assert.equal(str.tester.maxTurns, 80);
  assert.ok(str.warnings.some((w) => /agents\.tester is not an object/.test(w)));
  assert.ok(str.warnings.some((w) => /agents\.reviewer is not a known agent/.test(w)));

  const broken = agentSettings({ OMELETTE_HOME: home('{ not json') });
  assert.equal(broken.tester.maxTurns, 80);
  assert.ok(broken.warnings.some((w) => /fleet config:/.test(w)));
});

test('renderAgentFile renders the settings it is given, and leaves no placeholder behind', () => {
  const s = agentSettings({
    OMELETTE_HOME: home({ agents: { coder: { model: 'opus-4', effort: 'max' }, tester: { model: 'haiku', effort: 'low', maxTurns: 120 } } }),
  });
  const coder = renderAgentFile('omelette-coder.md', '1.2.3', s);
  assert.match(coder, /^model: opus-4$/m);
  assert.match(coder, /^effort: max$/m);
  const tester = renderAgentFile('omelette-tester.md', '1.2.3', s);
  assert.match(tester, /^model: haiku$/m);
  assert.match(tester, /^effort: low$/m);
  assert.match(tester, /^maxTurns: 120$/m);
  // Every template placeholder is accounted for — a stray `{{` would ship a
  // definition Claude Code reads as a literal.
  for (const text of [coder, tester]) assert.ok(!text.includes('{{'), 'no placeholder survives rendering');
});

test('renderAgentFile without a settings argument reads the fleet config, so `rules --agents` renders what `set` wrote', () => {
  const previous = process.env.OMELETTE_HOME;
  process.env.OMELETTE_HOME = home({ agents: { tester: { maxTurns: 140 } } });
  try {
    assert.match(renderAgentFile('omelette-tester.md', '1.2.3'), /^maxTurns: 140$/m);
  } finally { process.env.OMELETTE_HOME = previous; }
  assert.match(renderAgentFile('omelette-tester.md', '1.2.3'), /^maxTurns: 80$/m);
});

test('renderAgentFile: a partial settings object still renders a usable definition', () => {
  const text = renderAgentFile('omelette-tester.md', '1.2.3', { tester: { maxTurns: 200 } });
  assert.match(text, /^maxTurns: 200$/m);
  assert.match(text, /^model: sonnet$/m);
  assert.match(text, /^effort: xhigh$/m);
  assert.ok(!renderAgentFile('omelette-coder.md', '1.2.3', {}).includes('{{'));
});

test('AGENT_ROLES ties each shipped definition to the agents block it renders from', () => {
  assert.deepEqual(AGENT_ROLES, { 'omelette-coder.md': 'coder', 'omelette-tester.md': 'tester' });
  assert.deepEqual(Object.keys(AGENT_ROLES), AGENT_FILES, 'AGENT_FILES is the map\'s keys — one source, one order');
});

test('agentSettings + renderAgentFile: a model smuggling a newline cannot break out of the frontmatter', () => {
  // The frontmatter is what makes `disallowedTools: Agent` binding. A value that
  // closed it early would leave the rest of the definition in the BODY — prose
  // the harness does not enforce — in a file whose marker still says it is ours.
  const s = agentSettings({ OMELETTE_HOME: home({ agents: { coder: { model: 'opus\n---\ninjected: 1' } } }) });
  assert.equal(s.coder.model, 'opus');
  assert.equal(s.sources.coder.model, 'default');
  assert.ok(s.warnings.some((w) => /agents\.coder\.model = "opus\\n---\\ninjected: 1" is invalid/.test(w)));

  const text = renderAgentFile('omelette-coder.md', '1.2.3', s);
  assert.ok(!text.includes('injected'));
  const lines = text.split('\n');
  assert.equal(lines.filter((l) => l === '---').length, 2, 'the frontmatter opens once and closes once');
  const close = lines.indexOf('---', 1);
  assert.ok(lines.slice(1, close).includes('disallowedTools: Agent'), 'the guard stays INSIDE the frontmatter');
  assert.ok(lines.slice(1, close).includes('model: opus'));
  assert.equal(lines[close + 1], '', 'the closing --- is followed by the body');
});

// ─── the managed-file kinds registry ─────────────────────────────────────────

test('KINDS is the one registry every managed file goes through, with a distinct marker builder per kind', () => {
  assert.deepEqual(Object.keys(KINDS), ['rules', 'agents', 'skills', 'hooks']);
  const markers = new Set();
  for (const [kind, spec] of Object.entries(KINDS)) {
    assert.equal(typeof spec.marker, 'function', `${kind}.marker`);
    assert.equal(typeof spec.parse, 'function', `${kind}.parse`);
    assert.equal(typeof spec.render, 'function', `${kind}.render`);
    assert.equal(typeof spec.hint, 'string', `${kind}.hint`);
    assert.ok(Array.isArray(spec.files) && spec.files.length, `${kind}.files`);
    // The flag that writes this kind: null = every `rules` run writes it.
    assert.ok(spec.flag === null || typeof spec.flag === 'string', `${kind}.flag`);
    assert.deepEqual(spec.dir({ cwd: '/w/p', env: {} }), { dir: `/w/p/.claude/${kind}`, scope: 'project' }, `${kind}.dir`);
    markers.add(spec.marker('1.2.3'));
  }
  assert.equal(markers.size, Object.keys(KINDS).length, 'two kinds sharing a marker line would share an owner');
});

test('every kind renders a file its OWN parser accepts and every other kind rejects', () => {
  for (const [kind, spec] of Object.entries(KINDS)) {
    for (const name of spec.files) {
      const text = spec.render(name, '1.2.3');
      assert.equal(spec.parse(text), '1.2.3', `${kind}/${name} does not round-trip through its own parser`);
      assert.ok(!text.includes('{{'), `${kind}/${name}: no placeholder survives rendering`);
      assert.ok(text.endsWith('\n'), `${kind}/${name} ends with a newline`);
      for (const [other, otherSpec] of Object.entries(KINDS)) {
        if (other === kind) continue;
        assert.equal(otherSpec.parse(text), null, `${other}'s parser claims a ${kind} file`);
      }
    }
  }
});

// ─── the /omelette-test skill ────────────────────────────────────────────────

test('the skill template ships, renders its marker on line 2, and round-trips through parseSkillMarker', () => {
  assert.deepEqual(SKILL_FILES, ['omelette-test/SKILL.md']);
  const template = join(SKILL_TEMPLATE_DIR, 'omelette-test', 'SKILL.md');
  assert.ok(existsSync(template));
  // The template does not retype the marker: it asks for it by placeholder.
  assert.match(readFileSync(template, 'utf8'), /\{\{marker\}\}/);
  const text = renderSkillFile('omelette-test/SKILL.md', '1.2.3');
  const lines = text.split('\n');
  assert.equal(lines[0], '---');
  assert.equal(lines[1], SKILL_MARKER('1.2.3'));
  assert.equal(SKILL_MARKER('1.2.3'), '# omelette-fleet skill v1.2.3 · managed by `omelette-fleet rules --agents` · edits are overwritten on refresh');
  assert.equal(parseSkillMarker(text), '1.2.3');
  assert.ok(!text.includes('{{'), 'no placeholder survives rendering');
});

test('the skill hands the forked tester the spec and a diff taken from git AT INVOCATION', () => {
  const text = renderSkillFile('omelette-test/SKILL.md', '1.2.3');
  assert.match(text, /^name: omelette-test$/m);
  assert.match(text, /^context: fork$/m);
  assert.match(text, /^agent: omelette-tester$/m);
  // The orchestrator (the session model) invokes this skill via the Skill tool, so it must stay model-invocable.
  assert.ok(!/^disable-model-invocation:/m.test(text), 'the skill must not disable model invocation — the orchestrator calls it');
  assert.match(text, /^argument-hint: \[spec path\] \[repo path\]$/m);
  // QUOTED: the description ends in "Usage: /omelette-test <spec path> [repo
  // path]", and an unquoted `: ` inside a plain scalar ends the value — a YAML
  // parser rejects the file, and Claude Code would never load the skill at all.
  assert.match(text, /^description: "Clean-context tester handoff — .*Usage: \/omelette-test <spec path> \[repo path\]"$/m);
  // The whole point of the skill: the `!`…`` lines run at render time, before
  // the fork, so the tester gets the diff instead of the coder's summary. They
  // are content, not placeholders — nothing may rewrite or escape them. The
  // repo path rides `$1`, which the shell expands to "" when it was not given —
  // and `git -C ""` is a no-op, so the diff is then the current directory's.
  const lines = text.split('\n');
  assert.ok(lines.includes('!`git -C "$1" diff HEAD`'), 'the diff injection line must survive rendering verbatim');
  assert.ok(lines.includes('!`git -C "$1" ls-files --others --exclude-standard`'), 'the untracked-files line must survive rendering verbatim');
  // $0 is the first argument the skill was invoked with, $1 the second.
  assert.ok(text.includes('read `$0` first'), '$0 reaches the skill body untouched');
  assert.match(text, /^Repository under test: `\$1` — when empty, the current directory\.$/m);
  assert.ok(text.indexOf('\n---\n', 4) > 0, 'frontmatter is closed');
  // Every line of it is a plain `key: value` a YAML parser reads, marker aside.
  for (const line of frontmatter(text, 'skills/omelette-test/SKILL.md')) {
    if (line.startsWith('#')) continue;
    assert.match(line, /^[a-z-]+: \S/, `not a "key: value" line: ${line}`);
  }
});

test('parseSkillMarker demands the EXACT generated marker line on line 2, not a prefix of it', () => {
  assert.equal(parseSkillMarker(''), null);
  assert.equal(parseSkillMarker('---\nname: mine\n---\n'), null);
  assert.equal(parseSkillMarker(SKILL_MARKER('1.0.0') + '\n'), null, 'line 1 must be the frontmatter opener');
  assert.equal(parseSkillMarker('---\n# omelette-fleet skill v1.0.0\nname: mine\n'), null, 'prefix + version alone is not the marker');
  assert.equal(parseSkillMarker('---\n# omelette-fleet skill v1.0.0 · managed by\nname: mine\n'), null, 'truncated after "managed by"');
  assert.equal(parseSkillMarker('---\n# omelette-fleet skill v1.0.0 · managed by someone else\nname: mine\n'), null);
  assert.equal(parseSkillMarker('---\n' + SKILL_MARKER('1.0.0') + ' plus a tail\nname: mine\n'), null, 'trailing garbage after the marker');
  assert.equal(parseSkillMarker('---\n' + AGENT_MARKER('1.0.0') + '\nname: mine\n'), null, 'an AGENT marker does not own a skill file');
  assert.equal(parseSkillMarker('---\n' + SKILL_MARKER('1.0.0') + '\nname: mine\n'), '1.0.0');
});

test('skillsTarget mirrors agentsTarget', () => {
  assert.deepEqual(skillsTarget({ cwd: '/w/p', env: {} }), { dir: '/w/p/.claude/skills', scope: 'project' });
  assert.deepEqual(skillsTarget({ global: true, env: {} }), { dir: join(homedir(), '.claude', 'skills'), scope: 'global' });
  assert.equal(skillsTarget({ global: true, env: { CLAUDE_CONFIG_DIR: '/cfg' } }).dir, '/cfg/skills');
  assert.equal(skillsTarget({ global: true, env: { CLAUDE_CONFIG_DIR: '  ' } }).dir, join(homedir(), '.claude', 'skills'));
});

// ─── the guard hook ──────────────────────────────────────────────────────────

test('the guard template ships, renders its marker on line 1, and round-trips through parseHookMarker', () => {
  assert.deepEqual(HOOK_FILES, ['omelette-guard.mjs']);
  const template = join(HOOK_TEMPLATE_DIR, 'omelette-guard.mjs');
  assert.ok(existsSync(template));
  // The template does not retype the marker: it asks for it by placeholder.
  assert.match(readFileSync(template, 'utf8'), /^\{\{marker\}\}$/m);
  const text = renderHookFile('omelette-guard.mjs', '1.2.3');
  assert.equal(text.split('\n')[0], HOOK_MARKER('1.2.3'));
  assert.equal(HOOK_MARKER('1.2.3'), '// omelette-fleet hook v1.2.3 · managed by `omelette-fleet rules --hooks` · edits are overwritten on refresh');
  assert.equal(parseHookMarker(text), '1.2.3');
  assert.ok(!text.includes('{{'), 'no placeholder survives rendering');
});

test('parseHookMarker demands the EXACT generated marker line on line 1, not a prefix of it', () => {
  assert.equal(parseHookMarker(''), null);
  assert.equal(parseHookMarker('#!/usr/bin/env node\n'), null);
  assert.equal(parseHookMarker('\n' + HOOK_MARKER('1.0.0') + '\n'), null, 'the marker must be the FIRST line');
  assert.equal(parseHookMarker('// omelette-fleet hook v1.0.0\n'), null, 'prefix + version alone is not the marker');
  assert.equal(parseHookMarker('// omelette-fleet hook v1.0.0 · managed by\n'), null, 'truncated after "managed by"');
  assert.equal(parseHookMarker(HOOK_MARKER('1.0.0') + ' plus a tail\n'), null, 'trailing garbage after the marker');
  assert.equal(parseHookMarker(HOOK_MARKER('1.0.0') + '\nbody\n'), '1.0.0');
});

test('hooksTarget mirrors agentsTarget, and settingsTarget names the file doctor only ever READS', () => {
  assert.deepEqual(hooksTarget({ cwd: '/w/p', env: {} }), { dir: '/w/p/.claude/hooks', scope: 'project' });
  assert.deepEqual(hooksTarget({ global: true, env: {} }), { dir: join(homedir(), '.claude', 'hooks'), scope: 'global' });
  assert.equal(hooksTarget({ global: true, env: { CLAUDE_CONFIG_DIR: '/cfg' } }).dir, '/cfg/hooks');
  assert.deepEqual(settingsTarget({ cwd: '/w/p', env: {} }), { path: '/w/p/.claude/settings.json', scope: 'project' });
  assert.deepEqual(settingsTarget({ global: true, env: {} }), { path: join(homedir(), '.claude', 'settings.json'), scope: 'global' });
  assert.equal(settingsTarget({ global: true, env: { CLAUDE_CONFIG_DIR: '/cfg' } }).path, '/cfg/settings.json');
});

// ─── frontmatter that a YAML parser will actually accept ─────────────────────

/**
 * A minimal frontmatter scan. This package ships no YAML parser and node has
 * none, so the check is the shape a parser cares about, not a parse: `key:
 * value` per line, and — the one that bit us — a value containing `: ` must be
 * QUOTED, or the parser reads a nested mapping and rejects the document.
 */
function frontmatter(text, label) {
  const lines = text.split('\n');
  assert.equal(lines[0], '---', `${label}: line 1 opens the frontmatter`);
  const close = lines.indexOf('---', 1);
  assert.ok(close > 1, `${label}: frontmatter is closed`);
  return lines.slice(1, close);
}

test('every rendered frontmatter file is YAML a parser will accept: key: value lines, and no unquoted ": " in a value', () => {
  for (const kind of ['agents', 'skills']) {
    for (const name of KINDS[kind].files) {
      const label = `${kind}/${name}`;
      for (const line of frontmatter(KINDS[kind].render(name, '1.2.3'), label)) {
        if (line.startsWith('#')) continue; // the marker, a YAML comment
        assert.match(line, /^[A-Za-z][A-Za-z0-9-]*: \S/, `${label}: not a "key: value" line: ${line}`);
        const value = line.slice(line.indexOf(': ') + 2);
        if (value.includes(': ')) {
          assert.ok(
            value.startsWith('"') && value.endsWith('"'),
            `${label}: an unquoted ": " ends the value early — quote it: ${line}`,
          );
        }
      }
    }
  }
});

// ─── the settings snippet the CLI prints (and never writes) ──────────────────

test('hookSettingsSnippet quotes the script for the platform it is told about: POSIX single quotes, Windows double quotes', () => {
  const spaced = '/Users/me/My Projects/app/.claude/hooks/omelette-guard.mjs';
  const posix = hookSettingsSnippet(spaced, 'darwin');
  // A hook `command` is a command LINE: an unquoted path with a space in it
  // runs `node /Users/me/My` at every single tool call.
  assert.ok(posix[1].includes(`"command": "node '${spaced}'"`), posix.join('\n'));
  assert.ok(posix[2].includes(`"command": "node '${spaced}'"`), posix.join('\n'));
  assert.equal(hookSettingsSnippet(spaced, 'linux').join('\n'), posix.join('\n'));

  // cmd.exe knows nothing about POSIX single quotes, and the JSON layer is what
  // doubles the backslashes of a Windows path.
  const win = hookSettingsSnippet('/C\\Users\\me\\.claude\\hooks\\omelette-guard.mjs', 'win32');
  assert.ok(win[1].includes('"command": "node \\"/C\\\\Users\\\\me\\\\.claude\\\\hooks\\\\omelette-guard.mjs\\""'), win.join('\n'));

  // Whatever the platform, what it prints is a pasteable `hooks` object naming
  // both events, and the script is still recognisable by name.
  for (const platform of ['darwin', 'win32']) {
    const parsed = JSON.parse(hookSettingsSnippet(spaced, platform).join('\n'));
    assert.deepEqual(Object.keys(parsed.hooks), HOOK_EVENTS);
    assert.equal(parsed.hooks.PreToolUse[0].matcher, 'Bash');
    for (const event of HOOK_EVENTS) assert.ok(parsed.hooks[event][0].hooks[0].command.includes(HOOK_FILES[0]));
  }

  // The default is this machine's own platform — the CLI passes no argument.
  assert.deepEqual(hookSettingsSnippet(spaced), hookSettingsSnippet(spaced, process.platform));
});

test('hookSettingsSnippet resolves a relative path: a hook runs from wherever the session is, not from where the CLI ran', () => {
  const [, preToolUse] = hookSettingsSnippet('cfgrel/hooks/omelette-guard.mjs', 'darwin');
  assert.ok(preToolUse.includes(`node '${join(process.cwd(), 'cfgrel', 'hooks', 'omelette-guard.mjs')}'`), preToolUse);
});

test('settingsTargets names BOTH files Claude Code reads at a scope, in that order — and this package writes neither', () => {
  assert.deepEqual(settingsTargets({ cwd: '/w/p', env: {} }).map((t) => t.path), [
    '/w/p/.claude/settings.json',
    '/w/p/.claude/settings.local.json',
  ]);
  assert.deepEqual(settingsTargets({ cwd: '/w/p', env: {} }).map((t) => t.name), SETTINGS_FILES);
  assert.deepEqual(settingsTargets({ global: true, env: { CLAUDE_CONFIG_DIR: '/cfg' } }).map((t) => t.path), [
    '/cfg/settings.json',
    '/cfg/settings.local.json',
  ]);
  assert.equal(settingsTargets({ global: true, env: {} })[0].path, join(homedir(), '.claude', 'settings.json'));
  // The primary one is what `rules --hooks` names in its "paste into …" line.
  assert.equal(settingsTarget({ cwd: '/w/p', env: {} }).path, settingsTargets({ cwd: '/w/p', env: {} })[0].path);
});
