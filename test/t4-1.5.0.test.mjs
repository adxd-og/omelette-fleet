/**
 * omelette-fleet :: test/t4-1.5.0.test.mjs
 * 1.5.0 T4, the docs half: README and SECURITY describe the three-event guard,
 * the Codex web default mode is recorded, the spooled body is named as
 * best-effort, and the Gemini catalog no longer claims a sync source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const section = (md, heading) => {
  const from = md.indexOf(`\n## ${heading}\n`);
  assert.ok(from >= 0, `section "${heading}" exists`);
  const to = md.indexOf('\n## ', from + 1);
  return md.slice(from, to === -1 ? undefined : to);
};

test('README: the doctor sample names the three events and the stamp-and-print handoff line', () => {
  const md = read('README.md');
  assert.match(md, /^hooks {9}project: v\d+\.\d+\.\d+ \(wired: PreToolUse, PreCompact, SessionStart\) · global: absent$/m);
  assert.match(md, /^handoff {7}stamp and print on · ledgers: 1$/m);
  assert.doesNotMatch(md, /wired: PreToolUse, PreCompact, SessionStart, PostToolUse/);
  assert.doesNotMatch(md, /nudge at 90%|Stop gate on|summary on/);
  assert.doesNotMatch(md, /90 % of (the|its) (context )?window/);
  assert.match(md, /\(\[MEASUREMENTS\]\(docs\/MEASUREMENTS\.md#the-handoff-hooks-over-five-compactions\)\)/);
});

test('SECURITY: the guard section names no transcript read, no state file and no PostCompact handler', () => {
  const guard = section(read('docs/SECURITY.md'), 'The guard hook');
  assert.doesNotMatch(guard, /tail of the transcript/i);
  assert.doesNotMatch(guard, /handoff-state\.json/);
  assert.doesNotMatch(guard, /^- \*\*`PostCompact`/m);
  assert.doesNotMatch(guard, /^- \*\*`PostToolUse` and `Stop`/m);
  assert.match(guard, /^- \*\*`PreCompact`\.\*\*/m);
  assert.match(guard, /^- \*\*`SessionStart`, matcher `compact`\.\*\*[^\n]*1 MiB[^\n]*40 lines \/ 4 KB per ledger and 12 KB in all/m);
  assert.match(guard, /It reads no transcript, keeps no state file/);
});

test('SECURITY: the body of a spooled answer is named as best-effort', () => {
  const best = section(read('docs/SECURITY.md'), 'What is best-effort');
  assert.match(best, /^- \*\*The body of a spooled answer\.\*\* `omelette-fleet results` escapes the header it prints/m);
});

test('MEASUREMENTS: the Codex web default mode has its section, its map row and its method', () => {
  const md = read('docs/MEASUREMENTS.md');
  assert.match(md, /\| \[The Codex web default mode\]\(#the-codex-web-default-mode\) \|/);
  const s = section(md, 'The Codex web default mode');
  assert.match(s, /^\| none \(the CLI's default\) \| 2 /m);
  assert.match(s, /^\| `web_search="cached"` \| 2 /m);
  assert.match(s, /^\| `web_search="live"` \| 2 /m);
  assert.match(s, /the default is indistinguishable from either on the exec output/);
  assert.ok(md.indexOf('\n## The Codex web default mode\n') < md.indexOf('\n## How the numbers are taken\n'));
  assert.match(section(md, 'How the numbers are taken'), /^- \*\*The Codex web default mode\.\*\*[^\n]*< \/dev\/null/m);
});

test('the Codex adapter header carries the measured sentence; the Gemini catalog claims no sync source', () => {
  assert.match(read('units/codex/adapter.mjs'), /Measured 2026-09-25 on codex-cli 0\.156\.1/);
  const gemini = read('units/gemini/models.js');
  assert.match(gemini, /^\/\*\*\n \* omelette-fleet :: units\/gemini\/models\.js — the Gemini catalog/);
  assert.doesNotMatch(gemini, /sync:catalog|SINGLE SOURCE OF TRUTH|gemini-models\.js/);
});
