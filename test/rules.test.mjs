import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AGENT_FILES, AGENT_MARKER, AGENT_ROLES, CONTEXT_WINDOW_DEFAULT, CONTEXT_WINDOW_ENV, FLEET_CONTRACT,
  HOOK_EVENTS, HOOK_FILES, HOOK_MARKER, HOOK_TEMPLATE_DIR, KINDS,
  MODEL_ENV, MODEL_SETTING, MODEL_WINDOW, MODEL_WINDOW_SOURCE,
  MERGE_SENTENCES, RULES_FILE_NAME, RULES_MARKER, RULES_TEMPLATE_PATH, SETTINGS_FILES, SHORT_CONTRACT, SKILL_FILES, SKILL_MARKER,
  SKILL_TEMPLATE_DIR,
  agentSettings, agentsTarget, contractFor, hookSettingsSnippet, hooksTarget, parseAgentMarker, parseContextWindow, parseHookHandoff, parseHookMarker, parseModelWindow, parseRulesMarker, parseSkillMarker,
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

/**
 * A cwd and an env in which NO rules file of ours can be found, in either
 * scope — the state every contract assertion in this file needs to be exact
 * about. It cannot be the process cwd: this repository renders its own
 * managed files into <repo root>/.claude (gitignored), so a developer machine
 * has a rules file there and CI does not.
 */
function nowhere() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-contract-'));
  mkdirSync(join(dir, 'global'), { recursive: true });
  return { cwd: dir, env: { OMELETTE_HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'global') } };
}

/** Put a file at one scope's rules path of a `nowhere()`, ours or not. */
function installRules(o, scope, text) {
  const { path } = rulesTarget({ global: scope === 'global', cwd: o.cwd, env: o.env });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

test('FLEET_CONTRACT is short plain text that names the two rules that matter', () => {
  assert.ok(FLEET_CONTRACT.length < 1800, `contract is ${FLEET_CONTRACT.length} chars — keep it under one screen`);
  assert.ok(!/^#/m.test(FLEET_CONTRACT), 'no markdown headers in an instructions block');
  assert.match(FLEET_CONTRACT, /propose/i);
  assert.match(FLEET_CONTRACT, /Grok/);
  assert.match(FLEET_CONTRACT, /omelette-fleet rules/);
});

test('unitInstructions appends the unit line after a blank line, and copes with none', () => {
  // Explicit about WHERE, or the answer would depend on whether the machine
  // running the suite has this repository's own .claude/rules in place.
  const o = nowhere();
  assert.equal(unitInstructions({ name: 'x' }, o), FLEET_CONTRACT);
  assert.equal(unitInstructions({ name: 'x', instructions: '' }, o), FLEET_CONTRACT);
  assert.equal(unitInstructions({ name: 'x', instructions: 'This unit: X.' }, o), `${FLEET_CONTRACT}\n\nThis unit: X.`);
});

test('contractFor: the rules file in the server cwd decides, then the global one, and only OURS counts', () => {
  const o = nowhere();
  // Nothing installed anywhere: the full contract, and the reason names the
  // directory that was looked in — the one thing an operator needs to check.
  assert.deepEqual(contractFor(o), { text: FLEET_CONTRACT, short: false, reason: `no rules file in ${o.cwd}` });

  // A file at the path that carries no marker of ours is somebody else's file.
  installRules(o, 'project', '# my own rules about the fleet\n');
  assert.deepEqual(contractFor(o), { text: FLEET_CONTRACT, short: false, reason: `no rules file in ${o.cwd}` });

  // Ours, at ANY version: one line instead of the contract.
  installRules(o, 'project', renderRulesFile('0.0.1'));
  assert.deepEqual(contractFor(o), { text: SHORT_CONTRACT, short: true, reason: 'rules installed here' });

  // The project's file is checked first…
  installRules(o, 'global', renderRulesFile('9.9.9'));
  assert.equal(contractFor(o).reason, 'rules installed here');

  // …and the global one answers for a project that has none of its own.
  installRules(o, 'project', '# my own rules about the fleet\n');
  assert.deepEqual(contractFor(o), { text: SHORT_CONTRACT, short: true, reason: 'rules installed globally' });

  // A directory at the path, and a path that does not exist, both read as absent.
  const dirAt = nowhere();
  mkdirSync(rulesTarget({ cwd: dirAt.cwd, env: dirAt.env }).path, { recursive: true });
  assert.equal(contractFor(dirAt).short, false);
});

test('contractFor: `contract` overrides the lookup in both directions, from the caller or from the config', () => {
  const installed = nowhere();
  installRules(installed, 'project', renderRulesFile('0.0.1'));
  // `full` wins over the file that is right there…
  assert.deepEqual(contractFor({ ...installed, mode: 'full' }), { text: FLEET_CONTRACT, short: false, reason: 'contract=full' });

  // …and `short` wins with no file anywhere.
  const bare = nowhere();
  assert.deepEqual(contractFor({ ...bare, mode: 'short' }), { text: SHORT_CONTRACT, short: true, reason: 'contract=short' });

  // The config says it when the caller says nothing — this is how a server
  // gets it, since nothing passes `mode` down from a settings file by hand.
  const configured = nowhere();
  writeFileSync(join(configured.env.OMELETTE_HOME, 'fleet.config.json'), JSON.stringify({ version: 1, contract: 'short' }));
  assert.deepEqual(contractFor(configured), { text: SHORT_CONTRACT, short: true, reason: 'contract=short' });

  // Anything that is not one of the two is not an override: auto decides.
  assert.equal(contractFor({ ...bare, mode: 'auto' }).reason, `no rules file in ${bare.cwd}`);
  assert.equal(contractFor({ ...bare, mode: 'loud' }).reason, `no rules file in ${bare.cwd}`);
  assert.equal(contractFor({ ...bare, mode: null }).reason, `no rules file in ${bare.cwd}`);
});

test('the short contract is ONE line naming the rules file, and the unit keeps its own line either way', () => {
  assert.equal(
    SHORT_CONTRACT,
    'omelette-fleet: read-only unit; the operating model is in your rules file (.claude/rules/omelette-fleet.md, project or global) — the units propose, you apply.',
  );
  assert.equal(SHORT_CONTRACT.includes('\n'), false, 'one line');
  assert.ok(SHORT_CONTRACT.length * 4 < FLEET_CONTRACT.length, 'the whole point of it is that it is short');
  // It has to say where the operating model IS, or a session that gets it has
  // no way back to the thing it replaced.
  assert.match(SHORT_CONTRACT, /\.claude\/rules\/omelette-fleet\.md/);
  assert.match(SHORT_CONTRACT, /propose/);

  const o = nowhere();
  assert.equal(unitInstructions({ name: 'x', instructions: 'This unit: X.' }, o), `${FLEET_CONTRACT}\n\nThis unit: X.`);
  installRules(o, 'project', renderRulesFile('0.0.1'));
  assert.equal(unitInstructions({ name: 'x', instructions: 'This unit: X.' }, o), `${SHORT_CONTRACT}\n\nThis unit: X.`);
  assert.equal(unitInstructions({ name: 'x', instructions: '   ' }, o), SHORT_CONTRACT);
  assert.equal(unitInstructions({ name: 'x' }, o), SHORT_CONTRACT);
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

test('the rendered rules cover delegate justification, the Reviews section, and the ledger review-yield line', () => {
  const text = renderRulesFile('1.2.3');
  assert.match(text, /When a delegate is justified/);
  assert.match(text, /^## Reviews$/m);
  assert.match(text, /review yield:/);
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
  // QUOTED, like the description below: `[spec path] [repo path]` opens a YAML
  // FLOW SEQUENCE and then puts a second one after it, which is a parse error —
  // the whole file, skill and all, is what a YAML reader would then reject.
  assert.match(text, /^argument-hint: "\[spec path\] \[repo path\]"$/m);
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
        const quoted = value.startsWith('"') && value.endsWith('"') && value.length > 1;
        if (value.includes(': ')) {
          assert.ok(quoted, `${label}: an unquoted ": " ends the value early — quote it: ${line}`);
        }
        // A value that OPENS a flow collection is parsed as one: `[spec path]
        // [repo path]` is a sequence with a second sequence stapled to it,
        // which is a parse error rather than the hint it looks like.
        if (/^[[{]/.test(value)) {
          assert.ok(quoted, `${label}: an unquoted "${value[0]}" starts a YAML flow collection — quote it: ${line}`);
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
  assert.ok(posix[3].includes(`"command": "node '${spaced}'"`), posix.join('\n'));
  assert.ok(posix[4].includes(`"command": "node '${spaced}'"`), posix.join('\n'));
  assert.ok(posix[5].includes(`"command": "node '${spaced}'"`), posix.join('\n'));
  assert.ok(posix[6].includes(`"command": "node '${spaced}'"`), posix.join('\n'));
  assert.equal(hookSettingsSnippet(spaced, 'linux').join('\n'), posix.join('\n'));

  // cmd.exe knows nothing about POSIX single quotes, and the JSON layer is what
  // doubles the backslashes of a Windows path.
  const win = hookSettingsSnippet('/C\\Users\\me\\.claude\\hooks\\omelette-guard.mjs', 'win32');
  assert.ok(win[1].includes('"command": "node \\"/C\\\\Users\\\\me\\\\.claude\\\\hooks\\\\omelette-guard.mjs\\""'), win.join('\n'));

  // Whatever the platform, what it prints is a pasteable `hooks` object naming
  // every event, and the script is still recognisable by name.
  for (const platform of ['darwin', 'win32']) {
    const parsed = JSON.parse(hookSettingsSnippet(spaced, platform).join('\n'));
    assert.deepEqual(Object.keys(parsed.hooks), HOOK_EVENTS);
    assert.equal(parsed.hooks.PreToolUse[0].matcher, 'Bash');
    for (const event of HOOK_EVENTS) assert.ok(parsed.hooks[event][0].hooks[0].command.includes(HOOK_FILES[0]));
  }

  // The default is this machine's own platform — the CLI passes no argument.
  assert.deepEqual(hookSettingsSnippet(spaced), hookSettingsSnippet(spaced, process.platform));
});

test('the snippet wires all six events: SessionStart on `compact`, and the four unmatched ones on nothing', () => {
  const script = '/Users/me/app/.claude/hooks/omelette-guard.mjs';
  assert.deepEqual(HOOK_EVENTS, ['PreToolUse', 'PreCompact', 'SessionStart', 'PostToolUse', 'Stop', 'PostCompact']);
  for (const platform of ['darwin', 'win32']) {
    const snippet = hookSettingsSnippet(script, platform);
    assert.equal(snippet.length, HOOK_EVENTS.length + 1, 'the opener line plus one line per event');
    const parsed = JSON.parse(snippet.join('\n'));
    assert.deepEqual(Object.keys(parsed.hooks), HOOK_EVENTS);
    // PreToolUse is matched on a TOOL and SessionStart on a SOURCE. The other
    // three are matched on nothing at all: every compaction is one, every Stop
    // is one, and a PostToolUse matcher could only skip tools that grow the
    // context exactly like the ones it kept.
    assert.equal(parsed.hooks.PreToolUse[0].matcher, 'Bash');
    assert.equal(parsed.hooks.SessionStart[0].matcher, 'compact');
    for (const event of ['PreCompact', 'PostToolUse', 'Stop']) {
      assert.equal('matcher' in parsed.hooks[event][0], false, `${event} is matched on nothing`);
    }
    for (const event of HOOK_EVENTS) {
      assert.equal(parsed.hooks[event].length, 1);
      assert.equal(parsed.hooks[event][0].hooks.length, 1);
      assert.equal(parsed.hooks[event][0].hooks[0].type, 'command');
      assert.ok(parsed.hooks[event][0].hooks[0].command.includes(HOOK_FILES[0]));
    }
  }
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

test('renderHookFile substitutes the handoff block as a JSON literal, and fills a partial one from the schema', () => {
  const text = renderHookFile(HOOK_FILES[0], '1.2.3', { enabled: true, threshold: 85, contextWindow: 500000 });
  assert.match(text, /^const HANDOFF_CONFIG = \{"enabled":true,"threshold":85,"contextWindow":500000,"compactSummary":true\};$/m);
  assert.ok(!text.includes('{{'), 'no placeholder survives rendering');
  // The template is not runnable until it is rendered, and what renders into it
  // is a JSON literal — so the rendered script has to parse as a program. It is
  // checked as a FILE: the guard is ESM, and `node --check -` reads stdin as
  // CommonJS and fails on the first `import`.
  const checked = join(mkdtempSync(join(tmpdir(), 'omelette-render-')), 'omelette-guard.mjs');
  writeFileSync(checked, text);
  const syntax = spawnSync(process.execPath, ['--check', checked], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  // A partial object, a broken value and a missing argument all render the
  // schema's defaults: `rules --hooks` never writes a guard that cannot run.
  assert.match(renderHookFile(HOOK_FILES[0], '1.2.3', { threshold: 200 }),
    /^const HANDOFF_CONFIG = \{"enabled":true,"threshold":90,"contextWindow":0,"compactSummary":true\};$/m);
  assert.match(renderHookFile(HOOK_FILES[0], '1.2.3', {}),
    /^const HANDOFF_CONFIG = \{"enabled":true,"threshold":90,"contextWindow":0,"compactSummary":true\};$/m);
  assert.match(renderHookFile(HOOK_FILES[0], '1.2.3', null),
    /^const HANDOFF_CONFIG = \{"enabled":true,"threshold":90,"contextWindow":0,"compactSummary":true\};$/m);
  assert.match(renderHookFile(HOOK_FILES[0], '1.2.3', { enabled: false, threshold: 50, contextWindow: 1 }),
    /^const HANDOFF_CONFIG = \{"enabled":false,"threshold":50,"contextWindow":1,"compactSummary":true\};$/m);
  assert.match(renderHookFile(HOOK_FILES[0], '1.2.3', { compactSummary: false }),
    /^const HANDOFF_CONFIG = \{"enabled":true,"threshold":90,"contextWindow":0,"compactSummary":false\};$/m);
});

test('parseHookHandoff reads back exactly what renderHookFile wrote, and refuses anything that is not it', () => {
  const settings = { enabled: false, threshold: 77, contextWindow: 300000, compactSummary: false };
  assert.deepEqual(parseHookHandoff(renderHookFile(HOOK_FILES[0], '1.2.3', settings)), settings);
  // No settings argument reads the live fleet config — which this file points at
  // an empty throwaway home on line 20, so it is the built-in defaults.
  assert.deepEqual(parseHookHandoff(renderHookFile(HOOK_FILES[0], '1.2.3')),
    { enabled: true, threshold: 90, contextWindow: 0, compactSummary: true });
  // A 0.3.3 guard, a file that is not a guard, and a hand-edited literal.
  assert.equal(parseHookHandoff(''), null);
  assert.equal(parseHookHandoff('// omelette-fleet hook v0.3.3 …\nconst HANDOFF = "x";\n'), null);
  assert.equal(parseHookHandoff('const HANDOFF_CONFIG = not json;\n'), null);
  assert.equal(parseHookHandoff('const HANDOFF_CONFIG = [1,2];\n'), null);
  // …and a value out of range in a literal somebody edited by hand reads as the
  // default, exactly as the guard itself treats it. A key a 0.3.6 literal never
  // carried reads as its default too — which is what the guard's own
  // `HANDOFF_CONFIG.compactSummary !== false` computes from the same literal.
  assert.deepEqual(parseHookHandoff('const HANDOFF_CONFIG = {"enabled":"yes","threshold":900,"contextWindow":-5};\n'),
    { enabled: true, threshold: 90, contextWindow: 0, compactSummary: true });
});

test('parseContextWindow: 200000, 500k, 1M — and nothing else is a window', () => {
  assert.equal(CONTEXT_WINDOW_ENV, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  assert.equal(CONTEXT_WINDOW_DEFAULT, 200000);
  assert.equal(parseContextWindow('200000'), 200000);
  assert.equal(parseContextWindow(200000), 200000);
  assert.equal(parseContextWindow(' 500k '), 500000);
  assert.equal(parseContextWindow('500K'), 500000);
  assert.equal(parseContextWindow('1m'), 1000000);
  assert.equal(parseContextWindow('1M'), 1000000);
  for (const raw of ['', '   ', '0', '-1', '1.5m', '200_000', '200000 tokens', 'lots', 'k', null, undefined, true, {}, [], 0, -1, 1.5]) {
    assert.equal(parseContextWindow(raw), null, JSON.stringify(raw));
  }
});

test('parseModelWindow: a model id that ends in `[1m]` is a 1 000 000 window, and nothing else is one', () => {
  assert.equal(MODEL_ENV, 'ANTHROPIC_MODEL');
  assert.equal(MODEL_SETTING, 'model');
  assert.equal(MODEL_WINDOW, 1000000);
  assert.equal(MODEL_WINDOW_SOURCE, 'model[1m]');

  // The suffix Claude Code writes into the id of a 1M-context model, in the
  // forms a settings file or an environment variable can carry it: either case,
  // and past the whitespace a hand-edited file leaves behind.
  assert.equal(parseModelWindow('claude-opus-5[1m]'), 1000000);
  assert.equal(parseModelWindow('claude-fable-5-1[1M]'), 1000000);
  assert.equal(parseModelWindow('  claude-opus-5[1m]  '), 1000000);
  // Nonsense to write and harmless to honour: the rule is the suffix, and a
  // second rule about what must precede it is a rule the guard's own copy would
  // have to match exactly.
  assert.equal(parseModelWindow('[1m]'), 1000000);

  // The suffix has to END the id. Everything below names a perfectly good model
  // and says nothing whatever about the window — and a value that is not a
  // string is not an id at all.
  for (const raw of [
    'claude-opus-5', 'claude-opus-5[1m] (default)', 'claude-opus-5[1m]x', 'claude-1m', 'opus[2m]',
    '[1m]-opus', '1m', '', '   ', null, undefined, true, 1000000, {}, [],
  ]) {
    assert.equal(parseModelWindow(raw), null, JSON.stringify(raw));
  }
});

test('hookSettingsSnippet: a path holding `$1`, a space and a single quote survives the quoting on both platforms', () => {
  // Everything an operator's path can hold that a shell would otherwise read as
  // syntax: a `$` in front of a digit (a positional parameter under `sh`), a
  // space (the reason the quoting exists at all), and the one character POSIX
  // single quotes cannot contain.
  const hostile = "/Users/me/My $1 Dir/it's/.claude/hooks/omelette-guard.mjs";

  // POSIX single quotes take everything literally; the quote itself is closed,
  // escaped and reopened — `'…it'\''s…'`.
  const posix = JSON.parse(hookSettingsSnippet(hostile, 'darwin').join('\n'));
  for (const event of HOOK_EVENTS) {
    assert.equal(
      posix.hooks[event][0].hooks[0].command,
      `node '/Users/me/My $1 Dir/it'\\''s/.claude/hooks/omelette-guard.mjs'`,
      `${event}: the POSIX quoting must survive whole`,
    );
  }

  // cmd.exe knows nothing about POSIX single quotes or about `$1`, and a Windows
  // path cannot contain a `"` — so double quotes need no escaping inside them,
  // and the JSON layer is the only thing that escapes anything.
  const win = JSON.parse(hookSettingsSnippet(hostile, 'win32').join('\n'));
  for (const event of HOOK_EVENTS) {
    assert.equal(win.hooks[event][0].hooks[0].command, `node "/Users/me/My $1 Dir/it's/.claude/hooks/omelette-guard.mjs"`);
  }

  // The snippet is one pasteable JSON object on either platform — the two parses
  // above are that proof, and every event is still wired to the same script.
  assert.deepEqual(Object.keys(posix.hooks), HOOK_EVENTS);
  assert.deepEqual(Object.keys(win.hooks), HOOK_EVENTS);
});

test('the pasted command LINE runs the guard at such a path: a shell reads it back whole and the refusal still lands',
  { skip: process.platform === 'win32' && 'a POSIX shell' }, () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'omelette-quote-')), "My $1 Dir it's");
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'omelette-guard.mjs');
    writeFileSync(script, renderHookFile(HOOK_FILES[0], '1.2.3'));

    const command = JSON.parse(hookSettingsSnippet(script, 'darwin').join('\n')).hooks.PreToolUse[0].hooks[0].command;
    // A hook `command` is a command LINE handed to a shell, so a shell is what
    // has to read the path back: `$1` unexpanded, the space intact, the quote
    // intact. `printf %s` is the shortest thing that shows what the shell saw.
    const echoed = spawnSync('/bin/sh', ['-c', `printf %s ${command.slice('node '.length)}`], { encoding: 'utf8' });
    assert.equal(echoed.stdout, script, `the shell did not read the path back whole: ${echoed.stdout}${echoed.stderr}`);

    // …and end to end: the line exactly as the operator would paste it, the
    // event on stdin, exit 2 with the refusal.
    const r = spawnSync('/bin/sh', ['-c', command], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        agent_type: 'omelette-coder',
        tool_input: { command: 'git commit -m x' },
      }),
      encoding: 'utf8',
      timeout: 20000,
      // The snippet spells the interpreter `node`, by name. Point PATH at the
      // one running this suite so the test cannot depend on which node happens
      // to come first on the machine.
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
    });
    assert.equal(r.status, 2, `the guard did not run: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^omelette-coder never commits/);
  });

test('the tester definition says the guard contains it too — the role is enforced, not merely asked', () => {
  const text = renderAgentFile('omelette-tester.md', '1.2.3');
  assert.match(text, /guard hook/, 'the tester is told the guard exists');
  assert.match(text, /Never stash or move the tree/, 'and why moving the tree is the one thing it must not do');
  assert.ok(!text.includes('{{'), 'no placeholder survives rendering');
});

test('renderRulesFile fills {{merge}}: the session sentence by default, the pull-request one on `pr`', () => {
  const session = renderRulesFile('1.2.3');
  assert.ok(!session.includes('{{'), 'no placeholder survives rendering');
  assert.match(session, /The session merges the branch into main itself once every review is clean and it is confident the work is ready; pushing and tagging wait for the operator's explicit approval\./);
  assert.doesNotMatch(session, /pull request/);
  assert.equal(renderRulesFile('1.2.3', { merge: 'session' }), session, 'the default IS the session policy');

  const pr = renderRulesFile('1.2.3', { merge: 'pr' });
  assert.ok(!pr.includes('{{'));
  assert.match(pr, /The session opens a pull request from the feature branch and never merges into main itself; merging is the operator's or the repository's gate\./);
  assert.doesNotMatch(pr, /merges the branch into main itself/);
  // Both variants are the same managed file otherwise — same marker, one sentence apart.
  assert.equal(parseRulesMarker(pr), '1.2.3');
  assert.equal(pr.replace(MERGE_SENTENCES.pr, MERGE_SENTENCES.session), session);
  assert.deepEqual(Object.keys(MERGE_SENTENCES), ['session', 'pr']);
  for (const [key, text] of Object.entries(MERGE_SENTENCES)) {
    assert.ok(!text.includes('\n'), `${key} must be one sentence on one line`);
  }

  // Anything that is not one of the two renders the DEFAULT sentence: the file
  // is written from config that was already validated, and a render that
  // refused would leave a project with no rules at all. `constructor` is in
  // that list on purpose — a plain object's inherited keys are not policies.
  for (const merge of ['squash', 'constructor', 'toString', '', null, undefined, 0, false, {}, ['pr']]) {
    assert.equal(renderRulesFile('1.2.3', { merge }), session, JSON.stringify(merge));
  }
  for (const workflow of [null, undefined, 'pr', 42, []]) {
    assert.equal(renderRulesFile('1.2.3', workflow), session, `workflow: ${JSON.stringify(workflow)}`);
  }
});

test('the rendered rules carry the small-change lane and what stays out of it', () => {
  const text = renderRulesFile('1.2.3');
  assert.match(text, /The small-change lane/);
  assert.match(text, /goes to main on its own short branch \(`fix\/<name>`\)/);
  assert.match(text, /No spec, no plan, no reviews, no tag\./);
  assert.match(text, /What stays out of the lane/);
  assert.match(text, /touches the guard's refusal logic, the env allowlist, the billing scrub, the write gates or a tool's schema/);
  // It sits with the exception it extends, in the operating-model list.
  assert.ok(text.indexOf('The small-change exception') < text.indexOf('The small-change lane'), 'the lane follows the exception');
  assert.ok(text.indexOf('The small-change lane') < text.indexOf('## Ledger and handoff'), 'both stay in the operating model');
  assert.ok(!text.includes('{{'), 'no placeholder survives rendering');
  // The lane is text, not behaviour: it renders identically under either policy.
  assert.equal(
    renderRulesFile('1.2.3', { merge: 'pr' }).includes('The small-change lane'),
    true,
  );
});
