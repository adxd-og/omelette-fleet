// 1.7.0 Task 5: docs/MODS.md opens with a map, names the Claude Code build the
// mod was tested on, and carries no absolute home path (public repository).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = fs.readFileSync(path.join(ROOT, 'docs/MODS.md'), 'utf8');

test('docs/MODS.md opens with a map table', () => {
  const lines = md.split('\n');
  const header = lines.findIndex((l) => l === '| Question | Where |');
  assert.ok(header !== -1 && header < 10, `map header near the top (line ${header + 1})`);
  assert.match(lines[header + 1], /^\|---\|---\|$/);
  assert.ok(lines[header + 2].startsWith('| ') && lines[header + 2].includes('](#'), 'the first row links a section');
});

test('docs/MODS.md names the tested Claude Code build', () => {
  assert.match(md, /Claude Code \*\*2\.1\.294\*\*/);
});

test('docs/MODS.md carries no absolute home path', () => {
  assert.doesNotMatch(md, /\/Users\/|\/home\/|C:\\Users\\|~\/\.(?!omelette)/);
});
