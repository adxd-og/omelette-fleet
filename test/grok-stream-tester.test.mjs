import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArgs, interpretGrok, parseStream,
  IMAGE_GEN_TOOLS, IMAGE_EDIT_TOOLS,
} from '../units/grok/adapter.mjs';

// Independent tester coverage for task 1 (0.3.1 §1, "Grok streaming output").
// Never edits units/grok/adapter.mjs or test/grok.test.mjs — new fixtures only,
// re-derived from the spec/brief rather than the implementer's own test file.

const ok = (over = {}) => ({ stdout: '', stderr: '', code: 0, killed: false, ...over });

const sys = () => JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'grok-4.6' });
const ev = (event) => JSON.stringify({ type: 'stream_event', event, session_id: 's' });
const textDelta = (text, index = 1) => ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const thinkingDelta = (thinking, index = 0) => ev({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
const inputJsonDelta = (partial_json, index = 2) => ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
const messageStart = (usage) => ev({ type: 'message_start', message: { id: 'msg_0', type: 'message', role: 'assistant', model: 'grok-4.6', content: [], usage } });
const messageDelta = (stop_reason, usage) => ev({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage });
const resultLine = (o) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, ...o });
const stream = (...lines) => lines.join('\n') + '\n';
const USAGE = { input_tokens: 500, output_tokens: 120 };

test('parseStream: a thinking_delta block preceding the text contributes nothing to the assembled answer', () => {
  const s = parseStream(stream(
    sys(),
    thinkingDelta('mulling it over'),
    thinkingDelta(' more thinking'),
    textDelta('the answer'),
  ));
  assert.equal(s.text, 'the answer');
  assert.ok(!s.text.includes('mulling'));
});

test('parseStream: two text blocks with a tool_use block (input_json_delta) between them assemble only the text', () => {
  const s = parseStream(stream(
    sys(),
    textDelta('first part. '),
    inputJsonDelta('{"q":"x"}'),
    inputJsonDelta('"more"'),
    textDelta('second part'),
  ));
  assert.equal(s.text, 'first part. second part');
  assert.ok(!s.text.includes('"q"'));
});

test('parseStream: a result line whose result differs from the assembled deltas — final text wins', () => {
  const s = parseStream(stream(
    sys(),
    textDelta('draft answer'),
    resultLine({ result: 'polished answer', stop_reason: 'end_turn', usage: USAGE }),
  ));
  assert.equal(s.text, 'draft answer');
  assert.equal(s.finalText, 'polished answer');
  assert.equal(
    interpretGrok(ok({ stdout: stream(sys(), textDelta('draft answer'), resultLine({ result: 'polished answer', stop_reason: 'end_turn' })) }), { jsonMode: true, timeoutS: 300 }),
    'polished answer',
  );
});

test('interpretGrok: a result with is_error true and errors[] throws with the joined error text', () => {
  assert.throws(
    () => interpretGrok(ok({
      stdout: stream(sys(), resultLine({ is_error: true, errors: ['bad thing one', 'bad thing two'], result: '' })),
      code: 1,
    }), { jsonMode: true, timeoutS: 300 }),
    /grok CLI error: bad thing one; bad thing two/,
  );
});

test('interpretGrok: a result with is_error true and no errors[] falls back to result, then subtype', () => {
  assert.throws(
    () => interpretGrok(ok({
      stdout: stream(sys(), resultLine({ is_error: true, subtype: 'error_max_turns', result: null })),
      code: 1,
    }), { jsonMode: true, timeoutS: 300 }),
    /grok CLI error: error_max_turns/,
  );
});

test('interpretGrok: a killed run with only system/init (or system + an all-zero message_start) throws, never a silent empty success', () => {
  assert.throws(
    () => interpretGrok(ok({ stdout: stream(sys()), code: null, killed: true }), { jsonMode: true, timeoutS: 900 }),
    /grok hard-killed after 900s/,
  );
  assert.throws(
    () => interpretGrok(ok({ stdout: stream(sys(), messageStart({ input_tokens: 0, output_tokens: 0 })), code: null, killed: true }), { jsonMode: true, timeoutS: 900 }),
    /grok hard-killed after 900s/,
  );
});

test('interpretGrok: a killed run with deltas and no result line carries no usage key at all when none was reported', () => {
  const killed = interpretGrok(ok({
    stdout: stream(sys(), textDelta('partial answer, no result line')),
    code: null,
    killed: true,
  }), { jsonMode: true, timeoutS: 900 });
  assert.equal(killed.partial, true);
  assert.match(killed.text, /^partial answer, no result line/);
  assert.match(killed.text, /\[grok: hard-killed after 900s/);
  assert.ok(!('usage' in killed), 'no usage line was seen — the key should be absent, not null/undefined-valued');
});

test('parseStream: message_start\'s all-zero usage placeholder is ignored; a later message_delta with real counts is not', () => {
  const s = parseStream(stream(
    sys(),
    messageStart({ input_tokens: 0, output_tokens: 0 }),
    textDelta('answer'),
    messageDelta('end_turn', { input_tokens: 42, output_tokens: 9 }),
  ));
  assert.deepEqual(s.usage, { input: 42, output: 9 });
});

test('parseStream: usage maps only input_tokens/output_tokens to {input, output}, dropping any other reported fields', () => {
  const s = parseStream(stream(
    sys(),
    textDelta('answer'),
    resultLine({ result: 'answer', stop_reason: 'end_turn', usage: { input_tokens: 10867, output_tokens: 524, cache_read_input_tokens: 128, cache_creation_input_tokens: 5 } }),
  ));
  assert.deepEqual(s.usage, { input: 10867, output: 524 });
  assert.deepEqual(Object.keys(s.usage).sort(), ['input', 'output']);
});

test('parseStream: CRLF line endings are handled exactly like LF', () => {
  const lf = stream(sys(), textDelta('hello '), textDelta('world'), resultLine({ result: 'hello world', stop_reason: 'end_turn', usage: USAGE }));
  const crlf = lf.replace(/\n/g, '\r\n');
  const s = parseStream(crlf);
  assert.equal(s.text, 'hello world');
  assert.equal(s.finalText, 'hello world');
  assert.deepEqual(s.usage, { input: 500, output: 120 });
  // usage is present on this fixture, so interpretGrok returns the object shape, not a bare string.
  const r = interpretGrok(ok({ stdout: crlf }), { jsonMode: true, timeoutS: 300 });
  assert.equal(r.text, 'hello world');
  assert.deepEqual(r.usage, { input: 500, output: 120 });
});

test('parseStream: a malformed line in the middle of the stream is skipped; deltas before and after it are both kept', () => {
  const s = parseStream(stream(
    sys(),
    textDelta('before. '),
    '{"type":"stream_event","event":{"type":"content_block_delta"', // truncated garbage, not at the end of the stream
    'not json at all, a stray banner line',
    textDelta('after'),
  ));
  assert.equal(s.text, 'before. after');
  assert.equal(s.error, null);
  assert.equal(s.parsed, true);
});

test('buildArgs: image_edit also keeps plain output with no --include-partial-messages', () => {
  const a = buildArgs({ prompt: 'p', tools: IMAGE_EDIT_TOOLS, maxTurns: 8 });
  assert.equal(a[a.indexOf('--output-format') + 1], 'plain');
  assert.ok(!a.includes('--include-partial-messages'));
  assert.equal(a[a.indexOf('--tools') + 1], 'image_edit');
});

test('buildArgs: grok_image (IMAGE_GEN_TOOLS) keeps plain output with no --include-partial-messages', () => {
  const a = buildArgs({ prompt: 'p', tools: IMAGE_GEN_TOOLS, maxTurns: 8 });
  assert.equal(a[a.indexOf('--output-format') + 1], 'plain');
  assert.ok(!a.includes('--include-partial-messages'));
});

test('interpretGrok: an early stop_reason coming only from the final assistant message (no result line) is still annotated', () => {
  const early = interpretGrok(ok({
    stdout: stream(
      sys(),
      textDelta('partial'),
      JSON.stringify({ type: 'assistant', message: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens', usage: USAGE } }),
    ),
  }), { jsonMode: true, timeoutS: 300 });
  assert.match(early.text, /^partial/);
  assert.match(early.text, /\[grok: run ended early — stopReason=max_tokens\]/);
});

test('interpretGrok: a clean run with usage returns exactly {text, usage} — no partial key leaks in', () => {
  const r = interpretGrok(ok({ stdout: stream(sys(), textDelta('hi'), resultLine({ result: 'hi', stop_reason: 'end_turn', usage: USAGE })) }), { jsonMode: true, timeoutS: 300 });
  assert.deepEqual(Object.keys(r).sort(), ['text', 'usage']);
  assert.deepEqual(r.usage, { input: 500, output: 120 });
});
