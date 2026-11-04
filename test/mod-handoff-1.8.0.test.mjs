/**
 * omelette-fleet :: test/mod-handoff-1.8.0.test.mjs
 * The handoff's pure half in the mod (1.8.0, Task 9): `lastHandoffFresh`, the
 * compaction gate's freshness rule (the last handoff heading, its local date,
 * its HH:MM within 30 minutes), and the marker by which the mod knows the
 * settings hook's entry, which must be the rendered guard's first printed line. The kit tests
 * (mods/omelette-fleet/tests/register.test.ts) run the hooks themselves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';
import { HANDOFF_MARKER, lastHandoffFresh } from '../mods/omelette-fleet/hooks/handoff.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** A local time, as the gate reads `now`: the heading's date is a local date. */
const at = (day, hh = 12, mm = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
};

test('a dated heading is fresh for its local day at any time, and stale the next day', () => {
  const text = '# ledger x\nbranch: feat/x\n\n## Handoff (2026-11-03 — x)\nnext: run npm test\n';
  for (const [hh, mm] of [[0, 0], [12, 0], [23, 59]]) assert.equal(lastHandoffFresh(text, at('2026-11-03', hh, mm)), true, `${hh}:${mm}`);
  assert.equal(lastHandoffFresh(text, at('2026-11-04', 0, 1)), false);
  assert.equal(lastHandoffFresh(text, at('2026-11-02', 23, 59)), false);
});

test('a heading with HH:MM is fresh within 30 minutes before now: 14:05 at 14:30, stale at 14:40', () => {
  const text = '## Handoff (2026-11-03 14:05 — x)\nnext\n';
  assert.equal(lastHandoffFresh(text, at('2026-11-03', 14, 30)), true);
  assert.equal(lastHandoffFresh(text, at('2026-11-03', 14, 40)), false);
});

test('a heading ahead of now (a clock skew) is fresh up to 30 minutes ahead, stale past that', () => {
  const text = '## Handoff (2026-11-03 14:05 — x)\nnext\n';
  assert.equal(lastHandoffFresh(text, at('2026-11-03', 13, 40)), true);
  assert.equal(lastHandoffFresh(text, at('2026-11-03', 13, 30)), false);
});

test('the last heading decides: a fresh one followed by 200 lines is fresh; an older one after a fresh one is stale', () => {
  const now = at('2026-11-03', 14, 30);
  const fresh = '## Handoff (2026-11-03 14:20 — fresh)';
  const tail = Array.from({ length: 200 }, (_, i) => `- line ${i}`);
  assert.equal(lastHandoffFresh(['# x', fresh, ...tail].join('\n'), now), true);
  assert.equal(lastHandoffFresh(['# x', fresh, 'next', '## Handoff (2026-10-30 — older, written last)', 'next'].join('\n'), now), false);
});

test('no handoff heading is stale', () => {
  assert.equal(lastHandoffFresh('# ledger x\nbranch: feat/x\n\n- 2026-11-03 started\n', at('2026-11-03')), false);
  assert.equal(lastHandoffFresh('', at('2026-11-03')), false);
});

test('HANDOFF_MARKER is the rendered guard\'s first printed line on SessionStart compact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-marker-'));
  const guard = join(dir, HOOK_FILES[0]);
  writeFileSync(guard, renderHookFile(HOOK_FILES[0], '1.8.0-test', { enabled: true }, ROOT));
  const project = join(dir, 'project');
  mkdirSync(join(project, '.omelette'), { recursive: true });
  writeFileSync(join(project, '.omelette', 'ledger-x.md'), '# x\n## Handoff\nnext: run npm test\n');
  const r = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', cwd: project }),
    encoding: 'utf8', cwd: project, timeout: 20000, env: { PATH: process.env.PATH, HOME: dir },
  });
  assert.equal(r.status, 0, r.stderr);
  const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.equal(text.split('\n')[0], HANDOFF_MARKER);
});
