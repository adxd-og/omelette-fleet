/**
 * omelette-fleet :: test/tester-1.3.0-fix5.test.mjs
 * Independent coverage for P0 Task 5 (docs/superpowers/plans/2026-09-24-1.3.0-P0-fixes.md):
 * a `## Handoff` heading quoted inside a fenced block is an example, and the
 * SessionStart print (`lastHandoffBlock`) skips it. The Stop freshness gate this
 * file also drove until 1.5.0 is gone with the rest of the auto-handoff; the
 * print's half of every case stays.
 *
 * The print is driven exactly as the shipped tests drive it: a real child
 * process (the rendered guard) fed a SessionStart(compact) event on stdin, over
 * a throwaway `.omelette/ledger-*.md`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

/** The guard exactly as `rules --hooks` writes it. */
function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fix5-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3', { enabled: true }));
  return { dir, path };
}

/** A throwaway project: one ledger, no pre-existing handoff. */
function project(g, name, { ledgerText = '# ledger fix5\n' } = {}) {
  const dir = join(g.dir, name);
  mkdirSync(join(dir, '.omelette'), { recursive: true });
  const ledger = join(dir, '.omelette', 'ledger-fix5.md');
  writeFileSync(ledger, ledgerText);
  return { dir, ledger: () => ledger };
}

/** One hook invocation: the event on stdin, the answer as code/stdout/stderr. */
function fire(g, input) {
  const r = spawnSync(process.execPath, [g.path], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', cwd: g.dir, timeout: 20000,
    env: { PATH: process.env.PATH, HOME: g.dir },
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const startEvent = (p) => ({ hook_event_name: 'SessionStart', source: 'compact', cwd: p.dir });

/** What SessionStart(compact) restores over a project: '' when nothing, or the printed block text. */
function restored(g, p) {
  const r = fire(g, startEvent(p));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  return r.out;
}

// ── Case 1: a fence holding the example heading — nothing is restored ──

test('SessionStart: a `## Handoff` inside a ```md fence is an example — the print restores nothing', () => {
  const g = guard();
  const p = project(g, 'backtick-only');
  appendFileSync(p.ledger(), '\n```md\n## Handoff\nexample only\n```\n');
  const printed = restored(g, p);
  assert.equal(printed, '', 'a fenced heading must not be restored');
});

test('SessionStart: a `## Handoff` inside a ~~~md fence is an example — the print restores nothing', () => {
  const g = guard();
  const p = project(g, 'tilde-only');
  appendFileSync(p.ledger(), '\n~~~md\n## Handoff\nexample only\n~~~\n');
  const printed = restored(g, p);
  assert.equal(printed, '', 'a fenced heading must not be restored');
});

// ── Case 2: a real heading AFTER the closed fence is the block ──

test('SessionStart: a real `## Handoff` after a closed fence is restored verbatim', () => {
  const g = guard();
  const p = project(g, 'real-after');
  appendFileSync(p.ledger(), '\n~~~md\n## Handoff\nexample only\n~~~\n\n## Handoff 2026-09-24T12:05Z\nWhere it stands: T5 in review.\n');
  const printed = restored(g, p);
  assert.equal(printed, [
    '--- ledger-fix5.md · last handoff ---',
    '## Handoff 2026-09-24T12:05Z',
    'Where it stands: T5 in review.',
    '',
  ].join('\n'), 'SessionStart must restore the real block, not stay silent');
});

// ── Case 3: a fence opened with ``` and "closed" by ~~~ never closes ──

test('SessionStart: a fence opened with ``` is not closed by ~~~ — everything after it stays text, forever', () => {
  const g = guard();
  const p = project(g, 'mismatched-open');
  // The ~~~ line does not close a ``` fence; a real heading placed after it is
  // still inside the (never-closed) fence and must stay hidden.
  appendFileSync(p.ledger(), '\n```md\n## Handoff\nexample only\n~~~\n\n## Handoff 2026-09-24T12:07Z\nWhere it stands: still inside.\n');
  const printed = restored(g, p);
  assert.equal(printed, '', 'nothing inside an unclosed fence is a handoff, however far it runs');
});

// ── Case 4: a fence closed by a longer run of the same character closes ──

test('SessionStart: a ``` fence closed by a longer run of backticks (````) closes — the heading after it counts', () => {
  const g = guard();
  const p = project(g, 'longer-close');
  appendFileSync(p.ledger(), '\n```md\n## Handoff\nexample only\n````\n\n## Handoff 2026-09-24T12:06Z\nWhere it stands: after the longer close.\n');
  const printed = restored(g, p);
  assert.equal(printed, [
    '--- ledger-fix5.md · last handoff ---',
    '## Handoff 2026-09-24T12:06Z',
    'Where it stands: after the longer close.',
    '',
  ].join('\n'));
});

// ── Case 5: the same texts, written with \r\n instead of \n ──

test('SessionStart: \\r\\n line breaks — a fenced example still hides, a real heading after it still counts', () => {
  const g = guard();
  const CRLF = '\r\n';

  const onlyFence = project(g, 'crlf-fenced-only');
  appendFileSync(onlyFence.ledger(), CRLF + '```md' + CRLF + '## Handoff' + CRLF + 'example only' + CRLF + '```' + CRLF);
  const printed1 = restored(g, onlyFence);
  assert.equal(printed1, '', '\\r\\n: a fenced heading must not be restored');

  const realAfter = project(g, 'crlf-real-after');
  appendFileSync(realAfter.ledger(), CRLF + '```md' + CRLF + '## Handoff' + CRLF + 'example only' + CRLF + '```' + CRLF + CRLF
    + '## Handoff 2026-09-24T12:05Z' + CRLF + 'Where it stands: T5 in review, CRLF.' + '\n');
  const printed2 = restored(g, realAfter);
  assert.equal(printed2, [
    '--- ledger-fix5.md · last handoff ---',
    '## Handoff 2026-09-24T12:05Z',
    'Where it stands: T5 in review, CRLF.',
    '',
  ].join('\n'), '\\r\\n: SessionStart must restore the real block');
});

// ── Case 6: the same texts, written with U+2028 instead of \n ──
//
// lastHandoffBlock splits lines on U+2028 too (HANDOFF_LINE_BREAK): a fenced
// example written with it still hides, and a genuine post-fence heading reached
// only through a U+2028-only run of text is still restored.

test('SessionStart: U+2028 line breaks — a fenced example still hides', () => {
  const g = guard();
  const SEP = ' ';
  const p = project(g, 'u2028-fenced-only');
  appendFileSync(p.ledger(), SEP + '```md' + SEP + '## Handoff' + SEP + 'example only' + SEP + '```' + SEP);
  const printed = restored(g, p);
  assert.equal(printed, '', 'U+2028: a fenced heading must not be restored');
});

test('SessionStart: U+2028 line breaks — a real heading after the closed fence is restored', () => {
  const g = guard();
  const SEP = ' ';
  const p = project(g, 'u2028-real-after');
  appendFileSync(p.ledger(), SEP + '```md' + SEP + '## Handoff' + SEP + 'example only' + SEP + '```' + SEP + SEP
    + '## Handoff 2026-09-24T12:05Z' + SEP + 'Where it stands: T5 in review, U+2028.\n');
  const printed = restored(g, p);
  // The same promise Case 2 and Case 5 check for \n and \r\n.
  assert.notEqual(printed, '', 'U+2028: a real heading past the closed fence must be restored');
});
