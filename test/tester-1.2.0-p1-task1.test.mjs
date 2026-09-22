// Clean-context tester for 1.2.0 P1 Task 1 (spec
// docs/superpowers/specs/2026-09-20-1.2.0-context-design.md, "P1 — the rules
// file as a map"; task docs/superpowers/plans/2026-09-22-1.2.0-P1-rules-map.md,
// "### Task 1"). Task 1 only touches docs/CONFIG.md and test/rules-size.test.mjs:
// these tests check the section it adds against the spec, the task's exact
// fenced text, and the guard's own constants — independent of the coder's own
// test/rules-size.test.mjs (not edited here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const config = () => read('docs/CONFIG.md');

// GitHub's heading slug rule, same as test/docs-map.test.mjs.
function slug(text) {
  return text.replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}

test('## The handoff hooks sits directly before ## Keys and after ### Workflow settings', () => {
  const md = config();
  const headings = [...md.matchAll(/^(#{1,3})\s+(.+)$/gm)].map((m) => ({ level: m[1].length, text: m[2].trim(), index: m.index }));
  const i = headings.findIndex((h) => h.level === 2 && h.text === 'The handoff hooks');
  assert.notEqual(i, -1, 'heading exists at level 2');
  assert.equal(headings[i - 1].text, 'Workflow settings', 'immediately preceded by ### Workflow settings');
  assert.equal(headings[i - 1].level, 3, 'that predecessor is a level-3 heading (nested under the same level-2 section)');
  assert.equal(headings[i + 1].text, 'Keys', 'immediately followed by ## Keys');
  assert.equal(headings[i + 1].level, 2, 'Keys stays level 2 (not re-parented)');
});

test('the map row for the new section is present and its anchor resolves', () => {
  const md = config();
  const rows = md.split('\n').filter((l) => l.startsWith('|') && l.includes('[The handoff hooks]'));
  assert.equal(rows.length, 1, 'exactly one map row mentions it');
  assert.equal(rows[0], '| What do the handoff hooks do to my ledger, and when? | [The handoff hooks](#the-handoff-hooks) |');
  // it sits directly after the Handoff-settings row, per plan Step 1.3
  const lines = md.split('\n');
  const rowIdx = lines.indexOf(rows[0]);
  assert.match(lines[rowIdx - 1], /\[Handoff settings\]\(#handoff-settings\)/, 'directly follows the Handoff settings map row');
  // the anchor actually resolves under GitHub's slug rule
  const headingTexts = [...md.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => m[1]);
  const ids = headingTexts.map(slug);
  assert.ok(ids.includes('the-handoff-hooks'), 'slug(## The handoff hooks) === the-handoff-hooks, matches the row link');
});

test('the Handoff-settings paragraph links to the new section', () => {
  const md = config();
  const from = md.indexOf('\n### Handoff settings\n');
  assert.notEqual(from, -1, '### Handoff settings present');
  const next = md.indexOf('\n### ', from + 1);
  const section = md.slice(from, next === -1 ? undefined : next);
  assert.match(section, /\[The handoff hooks\]\(#the-handoff-hooks\)/, 'the settings paragraph links to the mechanics section');
});

test('every mechanics string and event name matches the guard\'s own constants, not a hardcoded copy', () => {
  const guard = read('hooks/omelette-guard.mjs');
  const cfg = read('core/config.mjs');
  const md = config();
  const from = md.indexOf('\n## The handoff hooks\n');
  const to = md.indexOf('\n## Keys\n', from);
  const section = md.slice(from, to);

  const maxLinesMatch = guard.match(/maxLines\s*=\s*(\d+)/);
  const maxBytesMatch = guard.match(/maxBytes\s*=\s*(\d+)/);
  const totalMaxMatch = guard.match(/HANDOFF_TOTAL_MAX\s*=\s*(\d+)\s*\*\s*1024/);
  const summaryMaxMatch = guard.match(/SUMMARY_MAX\s*=\s*(\d+)\s*\*\s*1024/);
  const thresholdMatch = cfg.match(/threshold:\s*\{[^}]*default:\s*(\d+)/);
  for (const m of [maxLinesMatch, maxBytesMatch, totalMaxMatch, summaryMaxMatch, thresholdMatch]) {
    assert.ok(m, 'constant found in source');
  }
  const maxLines = Number(maxLinesMatch[1]);
  const maxBytesKB = Number(maxBytesMatch[1]) / 1024;
  const totalMaxKB = Number(totalMaxMatch[1]);
  const summaryMaxKB = Number(summaryMaxMatch[1]);
  const thresholdDefault = Number(thresholdMatch[1]);

  assert.equal(maxLines, 40);
  assert.equal(maxBytesKB, 4);
  assert.equal(totalMaxKB, 12);
  assert.equal(summaryMaxKB, 8);
  assert.equal(thresholdDefault, 90);

  assert.ok(section.includes(`${maxLines} lines / ${maxBytesKB} KB per ledger, ${totalMaxKB} KB in all`), 'the 40/4/12 KB bound, taken from the guard\'s own numbers');
  assert.ok(section.includes(`Bounded to ${summaryMaxKB} KB`), 'the 8 KB summary bound, taken from the guard\'s own number');
  assert.ok(section.includes(`${thresholdDefault} % by default`), 'the 90% threshold default, taken from core/config.mjs');

  // The guard dispatches on six events; `PreToolUse` is the unrelated git guard
  // on the coder/tester roles (guard comment line 9), not part of the handoff
  // hooks this section documents, so it is excluded here on purpose.
  const dispatched = [...guard.matchAll(/name === '([A-Za-z]+)'/g)].map((m) => m[1]);
  const handoffEvents = dispatched.filter((ev) => ev !== 'PreToolUse');
  assert.deepEqual(handoffEvents.sort(), ['PostCompact', 'PostToolUse', 'PreCompact', 'SessionStart', 'Stop'].sort());
  for (const ev of handoffEvents) assert.ok(section.includes(`\`${ev}\``), `${ev} named as inline code in the section`);
});

test('the section carries the facts the guard code actually implements (symlink/FIFO skip, sub-agent silence, opt-in ledger)', () => {
  const md = config();
  const guard = read('hooks/omelette-guard.mjs');
  const from = md.indexOf('\n## The handoff hooks\n');
  const to = md.indexOf('\n## Keys\n', from);
  const section = md.slice(from, to);

  assert.match(section, /symlink or a FIFO named like a ledger is skipped/);
  assert.match(guard, /lstatSync\(path\)\.isFile\(\)/, 'guard actually uses lstat.isFile() (skips symlinks/FIFOs)');

  assert.match(section, /silent in a sub-agent/);
  assert.match(guard, /inSubagent\(event\)/, 'guard actually checks inSubagent');

  assert.match(section, /that file is the opt-in/);
});

test('three of the five spec obligation phrases (P1 bullet list) are echoed verbatim in the CONFIG section', () => {
  const md = config();
  const from = md.indexOf('\n## The handoff hooks\n');
  const to = md.indexOf('\n## Keys\n', from);
  const section = md.slice(from, to);
  for (const phrase of [
    'the handoff block is still yours to write',
    'a ledger kept in another repository gets neither the stamp nor the print',
    'A manual `/compact` below the threshold gets no reminder',
  ]) assert.ok(section.includes(phrase), `echoed: ${phrase}`);
  // Not asserted present or absent (and this is not a bug either way): "after a
  // compaction, re-read the ledger before doing anything else" is the rules
  // bullet's own sentence (rules/omelette-fleet.md:29 today), which Task 2 —
  // not Task 1 — turns into one of the six lines; the spec places the
  // *obligations* in the rules file and the *mechanics* in CONFIG, two
  // different destinations for P1 as a whole, but never forbids CONFIG from
  // also carrying that sentence, so its presence or absence here is not part
  // of Task 1's contract.
});
