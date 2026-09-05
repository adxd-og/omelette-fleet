import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_FILES, AGENT_MARKER, FLEET_CONTRACT, RULES_FILE_NAME, RULES_MARKER, RULES_TEMPLATE_PATH,
  agentsTarget, parseAgentMarker, parseRulesMarker, renderAgentFile, renderRulesFile, rulesTarget,
  unitInstructions,
} from '../core/rules.mjs';

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
