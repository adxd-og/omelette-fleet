/**
 * omelette-fleet :: test/tester-1.8.0-task9.test.mjs
 * The tester's tests for 1.8.0 Task 9 (the handoff block, the one-copy strip,
 * the compaction skip): `lastHandoffFresh` at its edges (a day boundary, a
 * heading in a fence, CRLF, a date-only heading after a timed one, a 4 MiB
 * file), the guard's JSON print round-tripping awkward text, and the mod's own
 * `printHandoff` reading the REAL rendered guard's stdout (the two halves meet
 * only here; the kit tests mock the engine between them).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';
import { HANDOFF_MARKER, lastHandoffFresh } from '../mods/omelette-fleet/hooks/handoff.mjs';
import { printHandoff } from '../mods/omelette-fleet/hooks/guard.mjs';
import { project } from './fixtures/ledger-1.7.3.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = mkdtempSync(join(tmpdir(), 'omelette-home-t9-'));
const at = (day, hh = 12, mm = 0, ss = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm, ss).getTime();
};

test('a heading dated yesterday is stale even 11 minutes old across midnight (the date must be today)', () => {
  assert.equal(lastHandoffFresh('## Handoff (2026-11-04 23:59 — x)\n', at('2026-11-05', 0, 10)), false);
  assert.equal(lastHandoffFresh('## Handoff (2026-11-04 23:59 — x)\n', at('2026-11-04', 23, 59, 30)), true);
});

test('the 30-minute bound to the second: 14:05 is fresh at 14:34:59 and stale at 14:35:01', () => {
  const text = '## Handoff (2026-11-03 14:05 — x)\n';
  assert.equal(lastHandoffFresh(text, at('2026-11-03', 14, 34, 59)), true);
  assert.equal(lastHandoffFresh(text, at('2026-11-03', 14, 35, 1)), false);
});

test('a heading inside a fenced code block counts as the last heading (ruled: no fence tracking)', () => {
  const now = at('2026-11-03', 14, 30);
  const text = ['## Handoff (2026-10-01 — real, old)', 'next', '', '```', '## Handoff (2026-11-03 14:25 — an example)', '```', ''].join('\n');
  assert.equal(lastHandoffFresh(text, now), true);
});

test('CRLF and bare-CR ledgers: the last heading is found and its stamp is not read with a stray \\r', () => {
  const now = at('2026-11-03', 14, 30);
  assert.equal(lastHandoffFresh('# x\r\n## Handoff (2026-10-01 — old)\r\nnext\r\n## Handoff (2026-11-03 14:20 — new)\r\nnext\r\n', now), true);
  assert.equal(lastHandoffFresh('# x\r## Handoff (2026-11-03 14:20 — new)\r## Handoff (2026-10-01 — old)\r', now), false);
});

test('a date-only heading written after a timed one decides, and the other way round', () => {
  const now = at('2026-11-03', 18, 0);
  assert.equal(lastHandoffFresh('## Handoff (2026-11-03 09:00 — morning)\nn\n## Handoff (2026-11-03 — later, no time)\nn\n', now), true);
  assert.equal(lastHandoffFresh('## Handoff (2026-11-03 — early, no time)\nn\n## Handoff (2026-11-03 09:00 — morning)\nn\n', now), false);
});

test('malformed stamps are stale, not thrown on: hour 25, month 13, a heading with no parenthesis', () => {
  const now = at('2026-11-03', 14, 30);
  for (const heading of ['## Handoff (2026-11-03 25:00 — x)', '## Handoff (2026-13-03 — x)', '## Handoff', '## Handoff (2026-11-03 14:5 — x)']) {
    assert.doesNotThrow(() => lastHandoffFresh(`${heading}\n`, now), heading);
  }
  assert.equal(lastHandoffFresh('## Handoff (2026-11-03 25:00 — x)\n', now), false);
  assert.equal(lastHandoffFresh('## Handoff (2026-13-03 — x)\n', now), false);
  assert.equal(lastHandoffFresh('## Handoffs and why we write them (2026-11-03 14:25)\n', now), false, 'a heading ABOUT handoffs is no heading');
});

test('a 4 MiB ledger is read in well under a second, whether its last heading is fresh or it has none; a megabyte of blanks after `## Handoff (` does not backtrack', () => {
  const now = at('2026-11-03', 14, 30);
  const filler = `${'x'.repeat(99)}\n`.repeat(Math.floor((4 * 1024 * 1024) / 100));
  let t = Date.now();
  assert.equal(lastHandoffFresh(`${filler}## Handoff (2026-11-03 14:20 — x)\n`, now), true);
  assert.equal(lastHandoffFresh(filler, now), false);
  assert.equal(lastHandoffFresh(`## Handoff (${' \t'.repeat(1024 * 1024)}x\n`, now), false);
  assert.ok(Date.now() - t < 1500, `${Date.now() - t} ms`);
});

function renderedGuard() {
  const path = join(mkdtempSync(join(tmpdir(), 'omelette-guard-t9-')), HOOK_FILES[0]);
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.8.0-test', { enabled: true }, ROOT));
  return path;
}

const AWKWARD = 'say "hi" \\ back\\slash\ttab · middle dot 🥚 {"json":[1,2]} </script> \u0001 end';

test('the JSON print round-trips awkward ledger text: quotes, backslashes, a tab, an emoji, a control character; one line on stdout', () => {
  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', `# x\n## Handoff (2026-11-03 — x)\n${AWKWARD}\n`);
  const r = spawnSync(process.execPath, [renderedGuard()], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'clear', cwd: p.dir }), encoding: 'utf8', cwd: p.dir, timeout: 20000, env: { PATH: process.env.PATH, HOME },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trimEnd().includes('\n'), false, 'one line');
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, `${HANDOFF_MARKER}\n--- ledger-x.md · last handoff ---\n## Handoff (2026-11-03 — x)\n${AWKWARD}\n`);
});

/** The engine's `$` for printHandoff: a real child process, as `$.process.run` makes one. */
const engine = (path = process.env.PATH) => ({
  env: { get: async () => path },
  process: {
    run: async (argv, init) => {
      const r = spawnSync(argv[0], argv.slice(1), { input: init.stdin, encoding: 'utf8', timeout: init.timeoutMs, env: init.env });
      return { exitCode: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  },
});

test('the mod\'s printHandoff reads the real rendered guard: the text led by the marker, the sections after it, no JSON wrapper', async () => {
  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', '# x\n## Handoff (2026-11-03 — x)\nnext: run npm test\n');
  p.write('.omelette/backlog.md', '| # | What |\n|---|---|\n| 1 | next |\n');
  const text = await printHandoff(engine(), renderedGuard(), p.dir);
  assert.equal(text.split('\n')[0], HANDOFF_MARKER);
  assert.ok(text.includes('--- ledger-x.md · last handoff ---\n## Handoff (2026-11-03 — x)\nnext: run npm test\n'));
  assert.ok(text.includes('--- .omelette/backlog.md · first table ---'));
  assert.equal(text.startsWith('{'), false);
  assert.ok(Buffer.byteLength(text, 'utf8') <= 12 * 1024);
});

test('the mod\'s printHandoff on a project with no ledger answers the empty string', async () => {
  const p = project({ git: false });
  assert.equal(await printHandoff(engine(), renderedGuard(), p.dir), '');
});
