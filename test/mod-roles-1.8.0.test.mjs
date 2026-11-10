/**
 * omelette-fleet :: test/mod-roles-1.8.0.test.mjs
 * The pins' pure half (1.8.0, Task 8): roles.mjs reading a definition's
 * frontmatter, the alias map `namesModel` reads it through, where the six
 * definitions are looked for, and the pane's notes for a pin and an effort
 * flag. The kit tests (mods/omelette-fleet/tests/register.test.ts) run the
 * hooks themselves.
 * Paths are made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, plainRows } from '../mods/omelette-fleet/hooks/layout.mjs';
import { initialState, reduce } from '../mods/omelette-fleet/hooks/model.mjs';
import { ALIASES, frontmatterOf, namesModel, readRoleDefinitions, ROLES } from '../mods/omelette-fleet/hooks/roles.mjs';
import { svgOf } from '../mods/omelette-fleet/hooks/svg.mjs';

/** A definition as `rules --agents` renders it: a comment line, keys the mod does not read, the body after. */
const definition = (model, effort, extra = []) => [
  '---',
  '# omelette-fleet agent v1.8.0 · managed by `omelette-fleet rules --agents` · edits are overwritten on refresh',
  'name: omelette-tester',
  'description: Clean-context tester — takes the approved spec and the diff from git.',
  `model: ${model}`,
  `effort: ${effort}`,
  ...extra,
  '---',
  '',
  'You test code you did not write.',
  '',
].join('\n');

test('the rendered definition: its model and effort lines, and nothing else', () => {
  assert.deepEqual(frontmatterOf(definition('claude-sonnet-5-5', 'high', ['maxTurns: 240', 'disallowedTools: Agent', 'tools: Read, Glob, Grep, Bash, Write, Edit'])), { model: 'claude-sonnet-5-5', effort: 'high' });
  assert.deepEqual(frontmatterOf(definition('claude-opus-5-5', 'xhigh').replaceAll('\n', '\r\n')), { model: 'claude-opus-5-5', effort: 'xhigh' }, 'CRLF');
  assert.deepEqual(frontmatterOf(definition('"claude-opus-5-5"', "'medium' # the medium coder")), { model: 'claude-opus-5-5', effort: 'medium' }, 'quotes and a comment off');
});

test('no definition is read where the frontmatter is not one: none, never closed, a key indented or in the body, the template\'s placeholder', () => {
  assert.deepEqual(frontmatterOf('model: claude-opus-5-5\neffort: xhigh\n'), {}, 'no opening ---');
  assert.deepEqual(frontmatterOf('---\nmodel: claude-opus-5-5\neffort: xhigh\n'), {}, 'never closed');
  assert.deepEqual(frontmatterOf('---\nname: x\n  model: claude-opus-5-5\n---\nmodel: claude-haiku-5-5\neffort: low\n'), {}, 'nested, then the body');
  assert.deepEqual(frontmatterOf(definition('{{model}}', '{{effort}}')), {}, 'the template, not the rendered copy');
  assert.deepEqual(frontmatterOf(definition('claude opus', 'x'.repeat(129))), {}, 'not an id, past the bound');
});

test('namesModel: the id, or an alias the map reads as that id; another family, an alias off the map or another id is a pin', () => {
  for (const [alias, id] of [['opus', 'claude-opus-5-5'], ['sonnet', 'claude-sonnet-5-5'], ['haiku', 'claude-haiku-5-5'], ['fable', 'claude-fable-5-2']]) {
    assert.equal(ALIASES[alias], id);
    assert.equal(namesModel(alias, id), true, alias);
    assert.equal(namesModel(id, id), true, id);
  }
  assert.equal(namesModel('claude-opus-5-5', 'opus'), true, 'a definition that names the alias');
  assert.equal(namesModel('haiku', 'claude-opus-5-5'), false);
  assert.equal(namesModel('opus-5', 'claude-opus-5-5'), false, 'off the map');
  assert.equal(namesModel('claude-opus-4-7', 'claude-opus-5-5'), false);
  assert.equal(namesModel('constructor', 'constructor'), true, 'the same string');
  assert.equal(namesModel('constructor', 'claude-opus-5-5'), false, 'no key off the prototype');
  assert.equal(namesModel(undefined, 'claude-opus-5-5'), false);
  assert.equal(namesModel('opus', undefined), false);
});

test('readRoleDefinitions: each of the six roles from the project, else from HOME; one in neither is left out; nothing else is read', async () => {
  const files = {
    '/w/p/.claude/agents/omelette-coder.md': definition('claude-opus-5-5', 'xhigh'),
    '/h/.claude/agents/omelette-coder.md': definition('claude-haiku-5-5', 'low'),
    '/h/.claude/agents/omelette-tester.md': definition('claude-sonnet-5-5', 'high'),
    '/w/p/.claude/agents/omelette-reviewer.md': 'no frontmatter',
  };
  const reads = [];
  const $ = {
    env: { get: async (name) => (name === 'HOME' ? '/h/' : undefined) },
    fs: {
      read: async (path) => {
        reads.push(path);
        if (files[path] === undefined) throw new Error(`ENOENT: ${path}`);
        return files[path];
      },
    },
  };

  const roles = await readRoleDefinitions($, '/w/p');

  assert.deepEqual(ROLES, ['omelette-coder', 'omelette-coder-medium', 'omelette-coder-hard', 'omelette-coder-xhard', 'omelette-tester', 'omelette-reviewer']);
  assert.deepEqual(Object.fromEntries(roles), {
    'omelette-coder': { model: 'claude-opus-5-5', effort: 'xhigh' },
    'omelette-tester': { model: 'claude-sonnet-5-5', effort: 'high' },
    'omelette-reviewer': {},
  });
  assert.deepEqual(reads, [
    '/w/p/.claude/agents/omelette-coder.md',
    '/w/p/.claude/agents/omelette-coder-medium.md',
    '/h/.claude/agents/omelette-coder-medium.md',
    '/w/p/.claude/agents/omelette-coder-hard.md',
    '/h/.claude/agents/omelette-coder-hard.md',
    '/w/p/.claude/agents/omelette-coder-xhard.md',
    '/h/.claude/agents/omelette-coder-xhard.md',
    '/w/p/.claude/agents/omelette-tester.md',
    '/h/.claude/agents/omelette-tester.md',
    '/w/p/.claude/agents/omelette-reviewer.md',
  ]);
});

test('readRoleDefinitions never rejects: HOME unreadable and a relative cwd leave nothing to read', async () => {
  const reads = [];
  const $ = {
    env: { get: async () => { throw new Error('no env'); } },
    fs: { read: async (path) => { reads.push(path); return definition('claude-opus-5-5', 'xhigh'); } },
  };

  assert.equal((await readRoleDefinitions($, 'relative/dir')).size, 0);
  assert.deepEqual(reads, []);
});

const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
const run = (state, ...events) => events.reduce(reduce, state);
const PIN = 'coder: pinned haiku → claude-opus-5-5';
const FLAG = 'coder: effort medium (definition says xhigh)';
const TOUCHED = 'touched: .omelette/reports/touched-omelette-coder-c1c1c1c1.md — 2 files';

/** An omelette-coder `c1c1c1c1` on medium, pinned and flagged as asked, then a reviewer `r1` with neither; stopped with a record when asked. */
const fleetOf = ({ pinned = false, flagged = false, touched = false } = {}) => run(initialState(T0),
  { type: 'spawn', at: T0, agentId: 'c1c1c1c1', role: 'omelette-coder', model: 'claude-opus-5-5' },
  ...(pinned ? [{ type: 'pinned', at: T0, agentId: 'c1c1c1c1', from: 'haiku', to: 'claude-opus-5-5' }] : []),
  { type: 'spawn', at: T0, agentId: 'r1', role: 'omelette-reviewer', model: 'claude-opus-5-5' },
  { type: 'step', at: T0 + 10, agentId: 'c1c1c1c1', model: 'claude-opus-5-5', effort: 'medium' },
  ...(flagged ? [{ type: 'effort-flag', at: T0 + 10, agentId: 'c1c1c1c1', effort: 'medium', expected: 'xhigh' }] : []),
  ...(touched ? [{ type: 'stop', at: T0 + 50, agentId: 'c1c1c1c1', touched: TOUCHED }] : []),
  { type: 'tick', at: T0 + 100 });
const drawn = (state, columns, isAscii = false) => layout(state, { columns, rows: 60, isAscii });
const isNote = (text) => /pinned|definition says|touched/.test(text);
const noteRowsOf = (rows) => rows.filter((row) => row.some((segment) => isNote(segment.text)));

test('the graph draws a pin and an effort flag as dim notes under it, above the history; each only when the row has it', () => {
  const rows = drawn(fleetOf({ pinned: true, flagged: true }), 100);
  assert.deepEqual(noteRowsOf(rows), [[{ text: PIN, tone: 'dim' }], [{ text: FLAG, tone: 'dim' }]]);
  const plain = plainRows(rows);
  assert.ok(plain.indexOf(PIN) > plain.findIndex((row) => row.includes('gemini')), 'under the graph');
  assert.ok(plain.indexOf(FLAG) < plain.findIndex((row) => /^\d\d:\d\d:\d\d /.test(row)), 'above the history');

  assert.deepEqual(plainRows(noteRowsOf(drawn(fleetOf({ pinned: true }), 100))), [PIN]);
  assert.deepEqual(plainRows(noteRowsOf(drawn(fleetOf({ flagged: true }), 100))), [FLAG]);
  assert.deepEqual(noteRowsOf(drawn(fleetOf(), 100)), [], 'neither: no note');
  assert.deepEqual(plainRows(noteRowsOf(drawn(fleetOf({ pinned: true }), 100, true))), ['coder: pinned haiku -> claude-opus-5-5'], 'ASCII');
  assert.deepEqual(plainRows(noteRowsOf(drawn(fleetOf({ pinned: true, flagged: true, touched: true }), 100))), [PIN, FLAG, TOUCHED], 'an agent\'s notes in order, its touched record last');
});

test('the tree draws the pin and the effort flag under their agent\'s own rows', () => {
  const rows = plainRows(drawn(fleetOf({ pinned: true, flagged: true }), 52));
  const coder = rows.findIndex((row) => row.includes(' coder '));
  assert.deepEqual(rows.slice(coder + 1, coder + 3), [`│   ${PIN}`, `│   ${FLAG}`]);
  assert.match(rows[coder + 3], /reviewer/, 'the next actor follows them');
  assert.deepEqual(noteRowsOf(drawn(fleetOf(), 52)), []);
});

test('the Svg draws the pin and the effort flag in its dim group under the units; neither, no note', () => {
  const { source } = svgOf(fleetOf({ pinned: true, flagged: true }));
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(source, new RegExp(`<g opacity="0\\.5"><text x="\\d+" y="\\d+">${literal(PIN)}</text><text x="\\d+" y="\\d+">${literal(FLAG)}</text></g>`));
  assert.equal(/pinned|definition says/.test(svgOf(fleetOf()).source), false);
});
