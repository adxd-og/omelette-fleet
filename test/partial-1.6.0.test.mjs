import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partialMark, withPartial, PARTIAL_MARK_RE, MARK_KINDS } from '../core/partial.mjs';
import { interpretAgy } from '../units/gemini/adapter.mjs';
import { interpretGrok } from '../units/grok/adapter.mjs';
import { extractResult } from '../units/codex/adapter.mjs';

const invariant = (r, where) => {
  const text = typeof r === 'string' ? r : r.text;
  const flag = typeof r === 'string' ? false : !!r.partial;
  assert.equal(flag, PARTIAL_MARK_RE.test(text), `${where}: partial=${flag} but marker ${PARTIAL_MARK_RE.test(text) ? 'present' : 'absent'}\n${text}`);
};

test('partialMark spells every 1.5.0 marker byte for byte', () => {
  assert.equal(partialMark('gemini', 'capped', { outputCap: 400000 }), '[gemini: output capped at 400000 chars — the beginning of the stream was dropped; treat the answer as partial]');
  assert.equal(partialMark('codex', 'killed', { after: 600 }), '[codex: hard-killed after 600s — treat the answer as partial; raise codex.timeoutS in the fleet config]');
  assert.equal(partialMark('grok', 'cancelled'), '[grok: cancelled by the client — treat the answer as partial]');
  assert.equal(partialMark('grok', 'cancelled', { tail: ' — Grok had reported: boom' }), '[grok: cancelled by the client — Grok had reported: boom]');
  assert.equal(partialMark('gemini', 'exited', { code: 1 }), '[gemini: CLI exited 1 — treat the answer as partial]');
  assert.equal(partialMark('grok', 'early', { stopReason: 'max_tokens' }), '[grok: run ended early — stopReason=max_tokens]');
  assert.equal(partialMark('gemini', 'status', { status: 'TIMEOUT' }), '[gemini: run ended early — status=TIMEOUT]');
  assert.equal(partialMark('codex', 'unfinished'), '[codex: run ended before turn.completed — treat as partial]');
  assert.equal(partialMark('gemini', 'stages', { n: 1, m: 4 }), '[gemini: 1 of 4 stages returned partial answers]');
  assert.equal(partialMark('gemini', 'gathers', { n: 1, m: 3, subs: 'why; how' }), '[gemini: 1 of 3 gathers failed: why; how]');
  for (const k of MARK_KINDS) assert.match(partialMark('grok', k, { outputCap: 1, after: 1, code: 1, stopReason: 'x', n: 1, m: 2, subs: 's' }), PARTIAL_MARK_RE);
  assert.throws(() => partialMark('grok', 'nope'), /unknown kind/);
});

test('withPartial keeps the shape and never marks an empty text', () => {
  assert.deepEqual(withPartial('answer', '[grok: CLI exited 1 — treat the answer as partial]'), { text: 'answer\n\n[grok: CLI exited 1 — treat the answer as partial]', partial: true });
  assert.deepEqual(withPartial({ text: 'a', usage: { input: 1 } }, '[codex: run ended before turn.completed — treat as partial]'), { text: 'a\n\n[codex: run ended before turn.completed — treat as partial]', usage: { input: 1 }, partial: true });
  assert.equal(withPartial('', '[x]'), '');
  assert.deepEqual(withPartial({ text: '' }, '[x]'), { text: '' });
});

test('the regex ignores the notes that carry no flag', () => {
  assert.doesNotMatch('_(gather failed: quota)_', PARTIAL_MARK_RE);
  assert.doesNotMatch('> **Degraded run — decomposition failed.**', PARTIAL_MARK_RE);
  assert.match('[gemini: run ended early — status=TIMEOUT]', PARTIAL_MARK_RE);   // a marker since 1.6.0 (agy reported a non-SUCCESS status)
});

// gemini: every exit path interpretAgy returns text on.
const agyOut = (o) => JSON.stringify({ response: 'answer', status: o.status || 'SUCCESS' });
test('gemini: flag ⇔ marker on every text-returning path', () => {
  const base = { stderr: '', killed: false, capped: false, cancelled: false };
  invariant(interpretAgy({ ...base, stdout: agyOut({}), code: 0 }, { timeoutS: 300 }), 'clean');
  invariant(interpretAgy({ ...base, stdout: agyOut({}), code: 1 }, { timeoutS: 300 }), 'exit 1');
  invariant(interpretAgy({ ...base, stdout: agyOut({ status: 'TIMEOUT' }), code: 0 }, { timeoutS: 300 }), 'status TIMEOUT');
  invariant(interpretAgy({ ...base, stdout: agyOut({ status: 'TIMEOUT' }), code: 1 }, { timeoutS: 300 }), 'status TIMEOUT + exit 1');
  invariant(interpretAgy({ ...base, stdout: agyOut({}), code: 0, capped: true }, { timeoutS: 300, outputCap: 10 }), 'capped');
  invariant(interpretAgy({ ...base, stdout: agyOut({}), code: 1, capped: true }, { timeoutS: 300, outputCap: 10 }), 'capped + exit 1 (Review Focus 1)');
  invariant(interpretAgy({ ...base, stdout: agyOut({}), code: null, killed: true }, { timeoutS: 300 }), 'killed');
  invariant(interpretAgy({ ...base, stdout: agyOut({}), code: null, killed: true, cancelled: true }, { timeoutS: 300 }), 'cancelled');
  const exit1 = interpretAgy({ ...base, stdout: agyOut({}), code: 1 }, { timeoutS: 300 });
  assert.equal(exit1.partial, true);
  assert.match(exit1.text, /\[gemini: CLI exited 1 — treat the answer as partial\]/);
});

// grok: streaming-messages-json lines as grokAnswer reads them.
const grokLines = (stop, extra = '') => [
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } }),
  JSON.stringify({ type: 'result', result: 'answer', stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } }),
].join('\n') + extra;
test('grok: flag ⇔ marker on every text-returning path; the error path still throws', () => {
  const base = { stderr: '', killed: false, capped: false, cancelled: false };
  const o = { jsonMode: true, timeoutS: 300 };
  invariant(interpretGrok({ ...base, stdout: grokLines('end_turn'), code: 0 }, o), 'clean');
  invariant(interpretGrok({ ...base, stdout: grokLines('end_turn'), code: 1 }, o), 'exit 1');
  invariant(interpretGrok({ ...base, stdout: grokLines('max_tokens'), code: 0 }, o), 'early');
  invariant(interpretGrok({ ...base, stdout: grokLines('max_tokens'), code: 1 }, o), 'early + exit 1');
  invariant(interpretGrok({ ...base, stdout: 'plain text', code: 1 }, { jsonMode: false, timeoutS: 300 }), 'plain exit 1');
  invariant(interpretGrok({ ...base, stdout: 'plain text', code: 1, capped: true }, { jsonMode: false, timeoutS: 300, outputCap: 5 }), 'plain capped + exit 1 (Review Focus 1)');
  invariant(interpretGrok({ ...base, stdout: grokLines('end_turn'), code: null, killed: true }, o), 'killed');
  invariant(interpretGrok({ ...base, stdout: grokLines('end_turn'), code: null, killed: true, cancelled: true }, o), 'cancelled');
  const exit1 = interpretGrok({ ...base, stdout: grokLines('end_turn'), code: 1 }, o);
  assert.equal(exit1.partial, true);
  // Review Focus 2: a reported error that took the answer with it is thrown, not marked…
  const errResult = JSON.stringify({ type: 'result', is_error: true, error: 'auth expired', result: '' });
  assert.throws(() => interpretGrok({ ...base, stdout: errResult, code: 1 }, o), /grok CLI error/);
  // …and one that left text behind is the pinned early stop, now flagged.
  const errWithText = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } }), errResult].join('\n');
  const early = interpretGrok({ ...base, stdout: errWithText, code: 1 }, o);
  invariant(early, 'error with text');
  assert.equal(early.partial, true);
  assert.match(early.text, /\[grok: run ended early — stopReason=/);
});

// codex: JSONL as extractResult reads it.
const codexLines = (completed) => [
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } }),
  ...(completed ? [JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })] : []),
].join('\n');
test('codex: flag ⇔ marker on every text-returning path', () => {
  const base = { stderr: '', killed: false, capped: false, cancelled: false };
  const o = { timeoutS: 600 };
  invariant(extractResult({ ...base, stdout: codexLines(true), code: 0 }, o), 'clean');
  invariant(extractResult({ ...base, stdout: codexLines(true), code: 1 }, o), 'exit 1');
  invariant(extractResult({ ...base, stdout: codexLines(false), code: 0 }, o), 'no turn.completed');
  invariant(extractResult({ ...base, stdout: codexLines(false), code: 1 }, o), 'no turn.completed + exit 1');
  invariant(extractResult({ ...base, stdout: codexLines(true), code: 1, capped: true }, { ...o, outputCap: 10 }), 'capped + exit 1 (Review Focus 1)');
  invariant(extractResult({ ...base, stdout: codexLines(true), code: null, killed: true }, o), 'killed');
  invariant(extractResult({ ...base, stdout: codexLines(true), code: null, killed: true, cancelled: true }, o), 'cancelled');
  const unfinished = extractResult({ ...base, stdout: codexLines(false), code: 0 }, o);
  assert.equal(unfinished.partial, true);
  assert.match(unfinished.text, /\[codex: run ended before turn\.completed — treat as partial\]/);
});
