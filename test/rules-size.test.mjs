// 1.2.0 P1 (spec docs/superpowers/specs/2026-09-20-1.2.0-context-design.md,
// "P1 — the rules file as a map"): the rules file keeps every rule byte for byte
// and loses only the prose that explained how the handoff hooks work, which now
// lives in CONFIG "The handoff hooks". These tests pin both halves: what left the
// rules, and where it went.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRulesFile } from '../core/rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** The rules file as a session loads it: rendered, under the default merge policy. */
const rules = () => renderRulesFile('1.2.0', { merge: 'session' });

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

/** How the handoff hooks work, in the words that carry it: CONFIG's to say, never the rules'. */
const MECHANICS = ['40 lines', '4 KB', '12 KB', '8 KB', 'PreCompact', 'SessionStart', 'PostToolUse', 'PostCompact', 'Stop'];

test('CONFIG carries the handoff hooks the rules file used to explain', () => {
  const md = read('docs/CONFIG.md');
  const hooks = section(md, '## The handoff hooks');
  for (const mechanism of MECHANICS) assert.ok(hooks.includes(mechanism), `CONFIG "The handoff hooks" carries: ${mechanism}`);
  for (const event of ['PreCompact', 'SessionStart', 'PostToolUse', 'Stop', 'PostCompact']) {
    assert.ok(hooks.includes(`\`${event}\``), `${event} named`);
  }
  for (const fact of [
    '<session cwd>/.omelette/ledger-*.md',
    'a ledger kept in another repository gets neither the stamp nor the print',
    '40 lines / 4 KB per ledger, 12 KB in all',
    '## Compaction summary <ISO> (trigger: …)',
    'Bounded to 8 KB',
    '`handoff.compactSummary=false`',
    '`handoff.enabled=false`',
    'remind **once** and gate **once** per crossing',
    'the handoff block is still yours to write',
    'A manual `/compact` below the threshold gets no reminder',
    'handoffs at every natural pause, and the hook is the net under it',
  ]) assert.ok(hooks.includes(fact), `CONFIG "The handoff hooks" says: ${fact}`);
  assert.match(md, /^\| .+ \| \[The handoff hooks\]\(#the-handoff-hooks\) \|$/m, 'the map at the top links it');
});
