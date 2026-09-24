/**
 * omelette-fleet :: test/tester-1.3.0-fix5.test.mjs
 * Independent coverage for P0 Task 5 (docs/superpowers/plans/2026-09-24-1.3.0-P0-fixes.md):
 * a `## Handoff` heading quoted inside a fenced block must not satisfy the Stop
 * freshness gate (`freshHeading`, via `freshHandoff`) — it must agree with the
 * SessionStart print (`lastHandoffBlock`), which has always skipped a fenced
 * heading. This file is written from scratch against the plan's contract; it
 * imports nothing from test/hooks-handoff.test.mjs and never edits it.
 *
 * The two readers are driven exactly as the shipped tests drive them: a real
 * child process (the rendered guard) fed a Stop or SessionStart(compact) event
 * on stdin, over a throwaway `.omelette/ledger-*.md`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

/** The guard exactly as `rules --hooks` writes it, threshold rendered at 90%. */
function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fix5-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3', { enabled: true, threshold: 90, contextWindow: 0 }));
  return { dir, path };
}

/** One assistant record whose usage sums to `fill`, the shape Claude Code writes. */
const assistantLine = (fill) => JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-5',
    usage: { input_tokens: 32, cache_creation_input_tokens: 1208, cache_read_input_tokens: fill - 1240, output_tokens: 485 },
  },
  timestamp: '2026-09-24T18:00:00.000Z',
});

/** A throwaway project: one ledger (default, no pre-existing handoff), a transcript at `fill`. */
function project(g, name, { fill = 182000, ledgerText = '# ledger fix5\n' } = {}) {
  const dir = join(g.dir, name);
  mkdirSync(join(dir, '.omelette'), { recursive: true });
  const ledger = join(dir, '.omelette', 'ledger-fix5.md');
  writeFileSync(ledger, ledgerText);
  const transcript = join(dir, 'transcript.jsonl');
  writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'go on' }, timestamp: '2026-09-24T18:00:01.000Z' }),
    assistantLine(fill),
  ].join('\n') + '\n');
  return { dir, transcript, ledger: () => ledger };
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

const post = (p, over = {}) => ({
  hook_event_name: 'PostToolUse', session_id: 's-1', transcript_path: p.transcript, cwd: p.dir,
  tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' }, ...over,
});
const stopEvent = (p, over = {}) => ({
  hook_event_name: 'Stop', session_id: 's-1', transcript_path: p.transcript, cwd: p.dir,
  stop_hook_active: false, last_assistant_message: 'done', ...over,
});
const startEvent = (p) => ({ hook_event_name: 'SessionStart', source: 'compact', cwd: p.dir });

/** A crossing, as the nudge records it — asserted non-silent so the fixture is honest. */
function cross(g, p) {
  const r = fire(g, post(p));
  assert.notEqual(r.out, '', 'the fixture is meant to cross the threshold');
  return r;
}

/** Is the Stop gate holding the turn (blocked)? true = held, false = released (silent). */
function isBlocked(r) {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  if (r.out === '') return false;
  const parsed = JSON.parse(r.out);
  assert.deepEqual(Object.keys(parsed), ['decision', 'reason']);
  assert.equal(parsed.decision, 'block');
  return true;
}

/** What SessionStart(compact) restores: '' when nothing, or the printed block text. */
function restored(r) {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  return r.out;
}

/** Run one Stop + one SessionStart(compact) over a project and report both readers' answers. */
function readBoth(g, p) {
  return { held: isBlocked(fire(g, stopEvent(p))), printed: restored(fire(g, startEvent(p))) };
}

// ── Case 1: a fence holding the example heading — the gate holds, nothing is restored ──

test('Stop+SessionStart: a `## Handoff` inside a ```md fence is an example — gate holds, print restores nothing', () => {
  const g = guard();
  const p = project(g, 'backtick-only');
  cross(g, p);
  appendFileSync(p.ledger(), '\n```md\n## Handoff\nexample only\n```\n');
  const r = readBoth(g, p);
  assert.equal(r.held, true, 'a fenced heading must not release the gate');
  assert.equal(r.printed, '', 'a fenced heading must not be restored');
});

test('Stop+SessionStart: a `## Handoff` inside a ~~~md fence is an example — gate holds, print restores nothing', () => {
  const g = guard();
  const p = project(g, 'tilde-only');
  cross(g, p);
  appendFileSync(p.ledger(), '\n~~~md\n## Handoff\nexample only\n~~~\n');
  const r = readBoth(g, p);
  assert.equal(r.held, true, 'a fenced heading must not release the gate');
  assert.equal(r.printed, '', 'a fenced heading must not be restored');
});

// ── Case 2: a real heading AFTER the closed fence is the block, for both readers ──

test('Stop+SessionStart: a real `## Handoff` after a closed fence releases the gate AND is restored verbatim', () => {
  const g = guard();
  const p = project(g, 'real-after');
  cross(g, p);
  appendFileSync(p.ledger(), '\n~~~md\n## Handoff\nexample only\n~~~\n\n## Handoff 2026-09-24T12:05Z\nWhere it stands: T5 in review.\n');
  const r = readBoth(g, p);
  assert.equal(r.held, false, 'a real heading past the closed fence must release the gate');
  assert.equal(r.printed, [
    '--- ledger-fix5.md · last handoff ---',
    '## Handoff 2026-09-24T12:05Z',
    'Where it stands: T5 in review.',
    '',
  ].join('\n'), 'SessionStart must restore the real block, not stay silent');
});

// ── Case 3: a fence opened with ``` and "closed" by ~~~ never closes ──

test('Stop+SessionStart: a fence opened with ``` is not closed by ~~~ — everything after it stays text, forever', () => {
  const g = guard();
  const p = project(g, 'mismatched-open');
  cross(g, p);
  // The ~~~ line does not close a ``` fence; a real heading placed after it is
  // still inside the (never-closed) fence and must stay hidden from both readers.
  appendFileSync(p.ledger(), '\n```md\n## Handoff\nexample only\n~~~\n\n## Handoff 2026-09-24T12:07Z\nWhere it stands: still inside.\n');
  const r = readBoth(g, p);
  assert.equal(r.held, true, 'a mismatched close must not close the fence');
  assert.equal(r.printed, '', 'nothing inside an unclosed fence is a handoff, however far it runs');
});

// ── Case 4: a fence closed by a longer run of the same character closes ──

test('Stop+SessionStart: a ``` fence closed by a longer run of backticks (````) closes — the heading after it counts', () => {
  const g = guard();
  const p = project(g, 'longer-close');
  cross(g, p);
  appendFileSync(p.ledger(), '\n```md\n## Handoff\nexample only\n````\n\n## Handoff 2026-09-24T12:06Z\nWhere it stands: after the longer close.\n');
  const r = readBoth(g, p);
  assert.equal(r.held, false, 'a longer run of the same fence character must close it');
  assert.equal(r.printed, [
    '--- ledger-fix5.md · last handoff ---',
    '## Handoff 2026-09-24T12:06Z',
    'Where it stands: after the longer close.',
    '',
  ].join('\n'));
});

// ── Case 5: the same texts, written with \r\n instead of \n ──

test('Stop+SessionStart: \\r\\n line breaks — a fenced example still hides, a real heading after it still counts', () => {
  const g = guard();
  const CRLF = '\r\n';

  const onlyFence = project(g, 'crlf-fenced-only');
  cross(g, onlyFence);
  appendFileSync(onlyFence.ledger(), CRLF + '```md' + CRLF + '## Handoff' + CRLF + 'example only' + CRLF + '```' + CRLF);
  const r1 = readBoth(g, onlyFence);
  assert.equal(r1.held, true, '\\r\\n: a fenced heading must not release the gate');
  assert.equal(r1.printed, '', '\\r\\n: a fenced heading must not be restored');

  const realAfter = project(g, 'crlf-real-after');
  cross(g, realAfter);
  appendFileSync(realAfter.ledger(), CRLF + '```md' + CRLF + '## Handoff' + CRLF + 'example only' + CRLF + '```' + CRLF + CRLF
    + '## Handoff 2026-09-24T12:05Z' + CRLF + 'Where it stands: T5 in review, CRLF.' + '\n');
  const r2 = readBoth(g, realAfter);
  assert.equal(r2.held, false, '\\r\\n: a real heading past the closed fence must release the gate');
  assert.equal(r2.printed, [
    '--- ledger-fix5.md · last handoff ---',
    '## Handoff 2026-09-24T12:05Z',
    'Where it stands: T5 in review, CRLF.',
    '',
  ].join('\n'), '\\r\\n: SessionStart must restore the real block');
});

// ── Case 6: the same texts, written with U+2028 instead of \n ──
//
// freshHeading's own line splitter (GATE_LINE_BREAK) recognises U+2028, exactly
// as the plan's contract says. lastHandoffBlock — unmodified by this fix, and
// still splitting only on `\r?\n` — does not. The "fenced example only" shape
// still agrees (neither reader ever finds a heading in it, fenced or not), but
// this exposes whether a genuine post-fence heading, reachable only through a
// U+2028-only run of text, is still restored once the gate lets the turn end.

test('Stop+SessionStart: U+2028 line breaks — a fenced example still hides (both readers agree)', () => {
  const g = guard();
  const SEP = ' ';
  const p = project(g, 'u2028-fenced-only');
  cross(g, p);
  appendFileSync(p.ledger(), SEP + '```md' + SEP + '## Handoff' + SEP + 'example only' + SEP + '```' + SEP);
  const r = readBoth(g, p);
  assert.equal(r.held, true, 'U+2028: a fenced heading must not release the gate');
  assert.equal(r.printed, '', 'U+2028: a fenced heading must not be restored');
});

test('Stop+SessionStart: U+2028 line breaks — a real heading after the closed fence releases the gate AND is restored', () => {
  const g = guard();
  const SEP = ' ';
  const p = project(g, 'u2028-real-after');
  cross(g, p);
  appendFileSync(p.ledger(), SEP + '```md' + SEP + '## Handoff' + SEP + 'example only' + SEP + '```' + SEP + SEP
    + '## Handoff 2026-09-24T12:05Z' + SEP + 'Where it stands: T5 in review, U+2028.\n');
  const r = readBoth(g, p);
  // The gate agrees a real heading follows a closed fence (freshHeading tracks
  // U+2028 as a line break) and releases the turn — the same promise Case 2
  // and Case 5 check for \n and \r\n.
  assert.equal(r.held, false, 'U+2028: a real heading past the closed fence must release the gate');
  // The two readers must agree on every case: gate released implies a block is
  // restored, or the session loses its one reminder for a turn the gate itself
  // judged fresh — the exact failure mode Task 5 fixes for fenced headings.
  assert.notEqual(r.printed, '', 'U+2028: the gate released the turn but SessionStart restored nothing — the readers disagree');
});
