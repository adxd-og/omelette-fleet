import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit, {
  buildArgs, interpretGrok, parseStream, catalog,
  READONLY_TOOLS, READONLY_TOOLS_NOWEB, IMAGE_GEN_TOOLS,
} from '../units/grok/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const ok = (over = {}) => ({ stdout: '', stderr: '', code: 0, killed: false, capped: false, ...over });

/**
 * NDJSON fixture builders, shaped on a live probe (grok 1.0.13, 2026-09-06):
 * one `system/init` line, `stream_event` lines (message_start,
 * content_block_start, content_block_delta with text_delta/thinking_delta,
 * content_block_stop, message_delta, message_stop), then the whole `assistant`
 * message and a final `result` line carrying the full text, stop_reason and
 * usage. Every builder emits the keys that probe showed.
 */
const sys = () => JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'grok-4.6' });
const ev = (event) => JSON.stringify({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 's' });
const textDelta = (text, index = 1) => ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const thinkingDelta = (thinking) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } });
const inputJsonDelta = (partial_json, index = 2) => ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
const blockStart = (content_block, index = 1) => ev({ type: 'content_block_start', index, content_block });
const messageDelta = (stop_reason, usage) => ev({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage });
const assistantMsg = (content, stop_reason = 'end_turn', usage) => JSON.stringify({
  type: 'assistant',
  message: { id: 'msg_0', type: 'message', role: 'assistant', model: 'grok-4.6', content, stop_reason, usage },
  session_id: 's',
});
const resultLine = (o) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, ...o });
const stream = (...lines) => lines.join('\n') + '\n';
const USAGE = { input_tokens: 10867, output_tokens: 524, cache_read_input_tokens: 128 };

test('buildArgs: research runs stream NDJSON and carry every layer L1-L5 plus the web allow rules', () => {
  const a = buildArgs({ prompt: 'p', model: 'grok-4.6', effort: 'high', cwd: '/tmp', tools: READONLY_TOOLS, maxTurns: 30 });
  assert.deepEqual(a.slice(0, 5), ['-p', 'p', '--output-format', 'streaming-messages-json', '--include-partial-messages']);
  assert.ok(a.includes('--tools') && a[a.indexOf('--tools') + 1] === READONLY_TOOLS);
  assert.equal(a[a.indexOf('--disallowed-tools') + 1], 'search_tool,use_tool,Agent');
  assert.ok(a.includes('--no-subagents'));
  assert.equal(a[a.indexOf('--max-turns') + 1], '30');
  assert.equal(a.filter((x) => x === '--deny').length, 3);
  assert.equal(a.filter((x) => x === '--allow').length, 2);
  assert.equal(a[a.indexOf('--model') + 1], 'grok-4.6');
  assert.equal(a[a.indexOf('--reasoning-effort') + 1], 'high');
  assert.equal(a[a.indexOf('--cwd') + 1], '/tmp');
});

test('buildArgs: no-web research still streams; image runs stay plain with an image-only toolset', () => {
  const noweb = buildArgs({ prompt: 'p', tools: READONLY_TOOLS_NOWEB, maxTurns: 30 });
  assert.equal(noweb[noweb.indexOf('--output-format') + 1], 'streaming-messages-json');
  assert.ok(noweb.includes('--include-partial-messages'));
  assert.equal(noweb.filter((x) => x === '--allow').length, 0);
  const img = buildArgs({ prompt: 'p', tools: IMAGE_GEN_TOOLS, maxTurns: 8 });
  assert.equal(img[img.indexOf('--output-format') + 1], 'plain');
  assert.ok(!img.includes('--include-partial-messages')); // the path-extraction contract is built on plain stdout
  assert.equal(img[img.indexOf('--tools') + 1], 'image_gen');
  assert.equal(img.filter((x) => x === '--allow').length, 0);
  assert.ok(!img.includes('--always-approve'));
});

test('parseStream: text deltas assemble, thinking is ignored, the final message wins, usage and stop_reason are read', () => {
  const s = parseStream(stream(
    sys(),
    blockStart({ type: 'thinking', thinking: '' }, 0),
    thinkingDelta('the user wants a count'),
    blockStart({ type: 'text', text: '' }),
    textDelta('1\n'),
    textDelta('2\n'),
    textDelta('3'),
    messageDelta('end_turn', USAGE),
    assistantMsg([{ type: 'thinking', thinking: 'the user wants a count' }, { type: 'text', text: '1\n2\n3 (final)' }], 'end_turn', USAGE),
    resultLine({ result: '1\n2\n3 (final)', stop_reason: 'end_turn', usage: USAGE }),
  ));
  assert.equal(s.text, '1\n2\n3'); // deltas only — no thinking
  assert.equal(s.finalText, '1\n2\n3 (final)'); // authoritative full text
  assert.equal(s.stopReason, 'end_turn');
  assert.deepEqual(s.usage, { input: 10867, output: 524 });
  // The answer is the final text when it differs from the deltas.
  assert.equal(interpretGrok(ok({ stdout: stream(sys(), textDelta('drift'), resultLine({ result: 'the answer', stop_reason: 'end_turn' })) }), { jsonMode: true, timeoutS: 300 }), 'the answer');
  // No final message at all (a stream that ended after the deltas): the deltas are the answer.
  assert.equal(interpretGrok(ok({ stdout: stream(sys(), textDelta('deltas only'), messageDelta('end_turn', null)) }), { jsonMode: true, timeoutS: 300 }), 'deltas only');
});

test('parseStream: a whole assistant message assembles only its text blocks, tool_use in between and all', () => {
  const s = parseStream(stream(
    sys(),
    textDelta('let me look. '),
    inputJsonDelta('{"path":"/a/b.js"}'), // tool arguments stream as deltas too — never part of the answer
    textDelta('found it'),
    assistantMsg([
      { type: 'text', text: 'let me look.' },
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: '/a/b.js' } },
      { type: 'text', text: 'found it' },
    ], 'end_turn', USAGE),
  ));
  assert.equal(s.text, 'let me look. found it'); // input_json_delta contributed nothing
  assert.equal(s.finalText, 'let me look.\nfound it');
  assert.ok(!s.finalText.includes('tool_use') && !s.finalText.includes('/a/b.js'));
  // A top-level `{"type":"message"}` line is accepted too — the whole-message
  // spelling is the one part of the shape the 2026-09-06 probe left uncertain.
  const bare = parseStream(stream(sys(), textDelta('x'), JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'bare final' }], stop_reason: 'end_turn' })));
  assert.equal(bare.finalText, 'bare final');
  assert.equal(bare.stopReason, 'end_turn');
});

test('parseStream: malformed, foreign and unknown lines are skipped, never fatal', () => {
  const s = parseStream(stream(
    sys(),
    '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_de', // truncated by the kill
    'Some banner the CLI printed',
    JSON.stringify({ type: 'from_a_future_cli', payload: 1 }),
    textDelta('kept'),
  ));
  assert.equal(s.text, 'kept');
  assert.equal(s.error, null);
});

test('interpretGrok: a hard kill mid-delta returns the assembled deltas under the partial marker', () => {
  const killed = interpretGrok(ok({
    stdout: stream(sys(), blockStart({ type: 'text', text: '' }), textDelta('1\n'), textDelta('2\n'), textDelta('3')),
    code: null,
    killed: true,
  }), { jsonMode: true, timeoutS: 900 });
  assert.equal(killed.partial, true);
  assert.match(killed.text, /^1\n2\n3/);
  assert.match(killed.text, /\[grok: hard-killed after 900s — treat the answer as partial; raise grok\.timeoutS in the fleet config\]/);
  // Usage seen before the kill still travels to the status feed.
  const withUsage = interpretGrok(ok({
    stdout: stream(sys(), textDelta('half'), messageDelta(null, USAGE)),
    code: null,
    killed: true,
  }), { jsonMode: true, timeoutS: 900 });
  assert.deepEqual(withUsage.usage, { input: 10867, output: 524 });
  assert.equal(withUsage.partial, true);
  // Nothing captured at all: the kill is still an error, not an empty success.
  assert.throws(() => interpretGrok(ok({ stdout: '', code: null, killed: true }), { jsonMode: true, timeoutS: 900 }), /grok hard-killed after 900s/);
  assert.throws(() => interpretGrok(ok({ stdout: stream(sys()), code: null, killed: true }), { jsonMode: true, timeoutS: 900 }), /grok hard-killed after 900s/);
  const fromPlain = interpretGrok(ok({ stdout: ' half an answer \n', code: null, killed: true }), { jsonMode: false, timeoutS: 900 });
  assert.equal(fromPlain.partial, true);
  assert.match(fromPlain.text, /^half an answer/);
});

test('interpretGrok: usage is reported, an early stop is annotated, a clean end_turn in any spelling is not', () => {
  const clean = interpretGrok(ok({ stdout: stream(sys(), textDelta('hi'), resultLine({ result: 'hi', stop_reason: 'end_turn', usage: USAGE })) }), { jsonMode: true, timeoutS: 300 });
  assert.equal(clean.text, 'hi');
  assert.deepEqual(clean.usage, { input: 10867, output: 524 });
  // stopReason spelling changed across CLI generations — compared case/underscore-insensitively.
  assert.equal(interpretGrok(ok({ stdout: stream(sys(), textDelta('hi'), resultLine({ result: 'hi', stop_reason: 'EndTurn' })) }), { jsonMode: true, timeoutS: 300 }), 'hi');
  const early = interpretGrok(ok({ stdout: stream(sys(), textDelta('partial'), resultLine({ result: 'partial', stop_reason: 'max_tokens', usage: USAGE })) }), { jsonMode: true, timeoutS: 300 });
  assert.match(early.text, /^partial/);
  assert.match(early.text, /\[grok: run ended early — stopReason=max_tokens\]/);
  assert.deepEqual(early.usage, { input: 10867, output: 524 });
  // A cancelled run with no text at all explains what cancelled it.
  assert.throws(
    () => interpretGrok(ok({ stdout: stream(sys(), messageDelta('cancelled', null), resultLine({ result: '', stop_reason: 'cancelled' })) }), { jsonMode: true, timeoutS: 300 }),
    /needed interactive approval/,
  );
});

test('interpretGrok: CLI-level failures are errors, not answers, in both the result and the legacy shape', () => {
  // v1.0.13: a failure arrives as the final result line with is_error + errors[].
  assert.throws(
    () => interpretGrok(ok({
      stdout: stream(sys(), JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Couldn\'t set model \'nope\': unknown model id'], usage: { input_tokens: 0, output_tokens: 0 } })),
      code: 1,
      stderr: 'Error: unknown model id',
    }), { jsonMode: true, timeoutS: 300 }),
    /grok CLI error: Couldn't set model 'nope': unknown model id/,
  );
  // Older CLI generations printed a bare error object instead.
  assert.throws(
    () => interpretGrok(ok({ stdout: JSON.stringify({ type: 'error', message: 'unknown model' }) }), { jsonMode: true, timeoutS: 300 }),
    /grok CLI error: unknown model/,
  );
});

test('interpretGrok: a failed result that still carries text is an early stop, not a thrown-away run', () => {
  // grok 1.0.13 ends a maxTurns-capped run with is_error + subtype
  // error_max_turns and the PAID partial answer in `result` — no errors[].
  const capped = interpretGrok(ok({
    stdout: stream(
      sys(),
      textDelta('half the review'),
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'half the review, tidied', stop_reason: null, usage: USAGE }),
    ),
    code: 1,
  }), { jsonMode: true, timeoutS: 300 });
  assert.match(capped.text, /^half the review, tidied/);
  assert.match(capped.text, /\[grok: run ended early — stopReason=error_max_turns\]/);
  assert.match(capped.text, /CLI exited 1/);
  assert.deepEqual(capped.usage, { input: 10867, output: 524 });
  // Deltas alone are enough — a failed result with no `result` text still keeps them.
  const fromDeltas = interpretGrok(ok({
    stdout: stream(sys(), textDelta('what it got to'), JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: null })),
  }), { jsonMode: true, timeoutS: 300 });
  assert.match(fromDeltas, /^what it got to/);
  assert.match(fromDeltas, /\[grok: run ended early — stopReason=error_max_turns\]/);
  // Nothing assembled: the failure is still an error, with the errors[] message.
  assert.throws(
    () => interpretGrok(ok({ stdout: stream(sys(), JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['auth expired'] })), code: 1 }), { jsonMode: true, timeoutS: 300 }),
    /grok CLI error: auth expired/,
  );
});

test('parseStream: usage fields merge — a later line reporting only one count never erases the other', () => {
  const s = parseStream(stream(
    sys(),
    ev({ type: 'message_start', message: { id: 'msg_0', content: [], usage: { input_tokens: 500, output_tokens: 0 } } }),
    textDelta('answer'),
    messageDelta('end_turn', { output_tokens: 9 }), // no input_tokens on this line
  ));
  assert.deepEqual(s.usage, { input: 500, output: 9 });
});

test('parseStream: a successful result closes the run at end_turn even when its stop_reason is null', () => {
  // After a tool-use turn the whole message says stop_reason "tool_use"; the
  // success result line that follows means the run finished, so a complete
  // answer must not be stamped with an early-stop marker.
  const s = parseStream(stream(
    sys(),
    textDelta('looked it up. the answer'),
    assistantMsg([{ type: 'text', text: 'looked it up.' }, { type: 'tool_use', id: 't', name: 'read_file', input: {} }], 'tool_use', USAGE),
    resultLine({ result: 'looked it up. the answer', stop_reason: null, usage: USAGE }),
  ));
  assert.equal(s.stopReason, 'end_turn');
  const r = interpretGrok(ok({ stdout: stream(sys(), textDelta('done'), resultLine({ result: 'done', stop_reason: null, usage: USAGE })) }), { jsonMode: true, timeoutS: 300 });
  assert.equal(r.text, 'done'); // no marker
});

test('interpretGrok: plain mode returns raw text; an unrecognized stream fails open; empty exits are loud', () => {
  assert.equal(interpretGrok(ok({ stdout: ' /a/b.jpg \n' }), { jsonMode: false, timeoutS: 300 }), '/a/b.jpg');
  assert.equal(interpretGrok(ok({ stdout: '{not json' }), { jsonMode: true, timeoutS: 300 }), '{not json');
  assert.throws(() => interpretGrok(ok({ code: 1, stderr: 'bad' }), { jsonMode: true, timeoutS: 300 }), /grok exited 1: bad/);
});

test('interpretGrok: a non-zero exit WITH text keeps the text under a partial marker, in both modes', () => {
  const plain = interpretGrok(ok({ stdout: 'half an answer', code: 1, stderr: 'wobble' }), { jsonMode: false, timeoutS: 300 });
  assert.match(plain, /^half an answer/);
  assert.match(plain, /\[grok: CLI exited 1 — treat the answer as partial\]/);
  const streamed = interpretGrok(ok({ stdout: stream(sys(), textDelta('hi'), resultLine({ result: 'hi', stop_reason: 'end_turn', usage: USAGE })), code: 2 }), { jsonMode: true, timeoutS: 300 });
  assert.match(streamed.text, /^hi/);
  assert.match(streamed.text, /CLI exited 2/);
  assert.deepEqual(streamed.usage, { input: 10867, output: 524 });
  // An early stop AND a non-zero exit: both markers, answer still returned.
  const both = interpretGrok(ok({ stdout: stream(sys(), textDelta('partial'), messageDelta('cancelled', null)), code: 1 }), { jsonMode: true, timeoutS: 300 });
  assert.match(both, /run ended early — stopReason=cancelled/);
  assert.match(both, /CLI exited 1/);
  // Unparseable output on a failed exit still fails open — with the marker.
  assert.match(interpretGrok(ok({ stdout: '{not json', code: 1 }), { jsonMode: true, timeoutS: 300 }), /CLI exited 1/);
});

test('interpretGrok: a front-truncated stream is a marked partial answer, or a loud error — never a fragment', () => {
  const opts = { jsonMode: true, timeoutS: 300, outputCap: 2000 };
  const MARKER = /\[grok: output capped at 2000 chars — the beginning of the stream was dropped; treat the answer as partial\]/;
  // Whole lines survived in the tail: the answer is there, its beginning is not.
  const marked = interpretGrok(ok({
    stdout: stream(textDelta('the tail of the answer'), resultLine({ result: 'the tail of the answer', stop_reason: 'end_turn', usage: USAGE })),
    capped: true,
  }), opts);
  assert.match(marked.text, /^the tail of the answer/);
  assert.match(marked.text, MARKER);
  assert.equal(marked.partial, true);
  assert.deepEqual(marked.usage, { input: 10867, output: 524 });
  // The whole answer rode ONE huge `result` line and the cap cut it open: not a
  // single line parses, and the JSON fragment that survived must never be
  // handed back as the answer the way an unrecognized format legitimately is.
  assert.throws(
    () => interpretGrok(ok({ stdout: '_reason":"end_turn","usage":{"input_tokens":10}}\n', capped: true }), opts),
    /^Error: grok output exceeded the 2000 char cap and the final result line was lost — raise grok\.outputCap or narrow the task$/,
  );
  // Plain mode has no lines to parse and never claims to: its text is text,
  // front-truncated, so it comes back marked rather than thrown away. An image
  // run's path is the LAST token of the output, which the cap keeps.
  const plain = interpretGrok(ok({ stdout: '/tmp/img.jpg', capped: true }), { jsonMode: false, timeoutS: 300, outputCap: 2000 });
  assert.match(plain.text, /^\/tmp\/img\.jpg/);
  assert.match(plain.text, MARKER);
  assert.equal(plain.partial, true);
  // A run that was killed AND capped says both things, once each: the salvage is
  // answered first, and the cap note rides along with it.
  const both = interpretGrok(ok({ stdout: stream(sys(), textDelta('what it got to')), capped: true, code: null, killed: true }), opts);
  assert.match(both.text, /hard-killed after 300s/);
  assert.match(both.text, MARKER);
  assert.equal(both.partial, true);
  // Killed, capped, and nothing captured at all: no answer to salvage, and the
  // error names both bounds rather than sending the operator at one of them.
  assert.throws(
    () => interpretGrok(ok({ stdout: '', capped: true, code: null, killed: true }), opts),
    /^Error: grok hard-killed after 300s and output exceeded the 2000 char cap — raise grok\.timeoutS or grok\.outputCap in the fleet config$/,
  );
  // Killed and capped with a JSON FRAGMENT in the tail: the salvage is answered
  // first everywhere else, but here there is nothing to salvage — not one line
  // parsed, so the "text" is the middle of a `result` line, and handing that
  // back under the partial marker would dress a fragment up as an answer.
  assert.throws(
    () => interpretGrok(ok({ stdout: '_reason":"end_turn","usage":{"input_tokens":10}}\n', capped: true, code: null, killed: true }), opts),
    /^Error: grok hard-killed after 300s and output exceeded the 2000 char cap — raise grok\.timeoutS or grok\.outputCap in the fleet config$/,
  );
  // Plain mode parses nothing BY DESIGN, so its capped kill is not that case:
  // the text is text, front-truncated, and it is still salvaged and marked.
  const plainKill = interpretGrok(ok({ stdout: '/tmp/img.jpg', capped: true, code: null, killed: true }), { jsonMode: false, timeoutS: 300, outputCap: 2000 });
  assert.match(plainKill.text, /^\/tmp\/img\.jpg/);
  assert.match(plainKill.text, /hard-killed after 300s/);
  assert.equal(plainKill.partial, true);
  // …and an uncapped kill with nothing captured keeps naming only timeoutS.
  assert.throws(
    () => interpretGrok(ok({ stdout: '', code: null, killed: true }), opts),
    /^Error: grok hard-killed after 300s \(raise grok\.timeoutS in the fleet config\)$/,
  );
  // A kill on a run the CLI had already reported an error for: the error is
  // WHY there is no answer, and dropping it left the operator with a bare
  // timeout to chase — an expired login reads nothing like a slow review.
  assert.throws(
    () => interpretGrok(ok({
      stdout: stream(sys(), JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['auth expired'] })),
      code: null,
      killed: true,
    }), opts),
    /^Error: grok hard-killed after 300s; the CLI had reported: auth expired$/,
  );
  // …and the same run capped as well says all three things: both bounds, and
  // the reason the CLI itself gave, which neither bound explains.
  assert.throws(
    () => interpretGrok(ok({
      stdout: stream(sys(), JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['auth expired'] })),
      capped: true,
      code: null,
      killed: true,
    }), opts),
    /^Error: grok hard-killed after 300s and output exceeded the 2000 char cap; the CLI had reported: auth expired — raise grok\.timeoutS or grok\.outputCap in the fleet config$/,
  );
  // So does an early stop.
  const early = interpretGrok(ok({ stdout: stream(sys(), textDelta('some'), resultLine({ result: 'some', stop_reason: 'max_tokens' })), capped: true }), opts);
  assert.match(early.text, /run ended early — stopReason=max_tokens/);
  assert.match(early.text, MARKER);
  assert.equal(early.partial, true);
  // Nothing dropped: no marker, no flag, and the bare-string shape is kept.
  assert.equal(
    interpretGrok(ok({ stdout: stream(sys(), textDelta('all of it'), resultLine({ result: 'all of it', stop_reason: 'end_turn' })) }), opts),
    'all of it',
  );
});

test('runtime with a fake grok: `outputCap` bounds the real spawn, and a capped-out run is not retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grok-cap-'));
  const runs = join(dir, 'runs');
  const fake = join(dir, 'fake-grok.mjs');
  // One `result` line far longer than the cap: the tail keeps a fragment of it
  // and nothing parses — the shape a real answer past the cap arrives in.
  writeFileSync(fake, [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(runs)}, "x");`,
    'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "a".repeat(400) }) + "\\n");',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { grok: { outputCap: 100 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, GROK_BIN: process.execPath };
  const rt = createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
  const r = await rt.callTool('grok_research', { prompt: 'q' });
  assert.equal(r.isError, true);
  assert.match(r.text, /exceeded the 100 char cap and the final result line was lost/);
  // The bounded retry exists for an empty run; a second full run here would be
  // paid for and would hit the same cap.
  assert.equal(readFileSync(runs, 'utf8').length, 1, 'the run was not retried');
});

test('unit contract: five tools, efforts from the catalog, workspace-write declared unsupported', () => {
  assert.deepEqual(unit.tools.map((t) => t.name), ['grok_research', 'grok_code_review', 'grok_image', 'grok_image_edit', 'grok_models']);
  assert.deepEqual(unit.supportedModes, { 'read-only': true, 'workspace-write': null });
  assert.ok(catalog.effortEnum().includes('high'));
  assert.deepEqual(unit.billingRiskEnv, ['XAI_API_KEY']);
  assert.equal(unit.extraSchema.imageMaxTurns.default, 8);
  // Thinking deltas ride the same stream as the answer, so Grok's tail cap is
  // five times the fleet default — a long review must not lose its result line.
  assert.equal(unit.builtin.outputCap, 2000000);
});

test('runtime with a fake grok: the streamed answer is assembled, usage reaches the status feed, image edit validates its source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grok-'));
  const fake = join(dir, 'fake-grok.mjs');
  // The fake speaks the two output formats the adapter asks for: streaming
  // NDJSON for research/review, plain stdout for the image tools.
  writeFileSync(fake, [
    'const argv = process.argv.slice(2);',
    'const text = "ARGS " + argv.join(" ") + " WEBFETCH=" + process.env.GROK_WEB_FETCH;',
    // A prompt asking for it gets a run that reports only output tokens — the
    // shape the "tokens in=? out=N" log line exists for.
    'const usage = argv.join(" ").includes("OUTPUT_ONLY") ? { output_tokens: 7 } : { input_tokens: 11, output_tokens: 7 };',
    'if (argv.includes("streaming-messages-json")) {',
    '  const ev = (event) => JSON.stringify({ type: "stream_event", event });',
    '  process.stdout.write([',
    '    JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),',
    '    ...text.split(" ").map((w, i) => ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: i ? " " + w : w } })),',
    '    ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage }),',
    '    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, stop_reason: "end_turn", usage }),',
    '  ].join("\\n") + "\\n");',
    '} else process.stdout.write(text);',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { grok: { mode: 'workspace-write', webSearch: false, maxTurns: 12 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, OMELETTE_ALLOW_WRITE: 'grok', GROK_BIN: process.execPath };
  const rt = createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
  assert.equal(rt.cfgFor().values.mode, 'read-only'); // refused: unsupported by the unit
  const r = await rt.callTool('grok_research', { prompt: 'q' });
  assert.match(r.text, /^ARGS /); // the deltas / result line assembled back into one answer
  assert.match(r.text, /--output-format streaming-messages-json --include-partial-messages/);
  assert.match(r.text, /--tools read_file,grep,list_dir --/); // webSearch:false → no web tools
  assert.doesNotMatch(r.text, /--allow/);
  assert.match(r.text, /--max-turns 12/);
  assert.match(r.text, /WEBFETCH=1/);
  const snapshot = JSON.parse(readFileSync(join(dir, 'status-grok.json'), 'utf8'));
  assert.deepEqual(snapshot.lastEvent.usage, { input: 11, output: 7 }); // Grok reported no usage before 0.3.1
  // A count the run never reported reads as "?" in the log, never "null".
  const stderrWrite = process.stderr.write.bind(process.stderr);
  let logged = '';
  process.stderr.write = (chunk, ...rest) => { logged += chunk; return stderrWrite(chunk, ...rest); };
  try { await rt.callTool('grok_research', { prompt: 'OUTPUT_ONLY' }); } finally { process.stderr.write = stderrWrite; }
  assert.match(logged, /grok done · tokens in=\? out=7/);
  const bad = await rt.callTool('grok_image_edit', { prompt: 'x', imagePath: 'nope.jpg' });
  assert.match(bad.text, /must be an absolute path/);
  assert.equal(bad.isError, true); // a refusal must never be reported to MCP as a success
  const gone = await rt.callTool('grok_image_edit', { prompt: 'x', imagePath: join(dir, 'missing.jpg') });
  assert.match(gone.text, /not an existing file/);
  assert.equal(gone.isError, true);
  const noPrompt = await rt.callTool('grok_research', { prompt: '' });
  assert.equal(noPrompt.isError, true);
});

/** interpretGrok returns a bare string when nothing travels with the text, and `{ text, … }` when something does. */
const answerText = (res, opts = { jsonMode: true, timeoutS: 300 }) => {
  const a = interpretGrok(res, opts);
  return typeof a === 'string' ? a : a.text;
};

test('parseStream: a token count of 0 is a count — the merge keeps it instead of reading it as "absent"', () => {
  // A cache-served or tool-only turn really does report output_tokens 0, and
  // `a || b` turns that number into "no count reported" (a `?` in the log line).
  const zeroOut = parseStream(stream(sys(), textDelta('x'), resultLine({ result: 'x', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 0 } })));
  assert.deepEqual(zeroOut.usage, { input: 10, output: 0 });
  const zeroIn = parseStream(stream(sys(), textDelta('x'), resultLine({ result: 'x', stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 7 } })));
  assert.deepEqual(zeroIn.usage, { input: 0, output: 7 });
  // …and a later 0 does not hand an earlier line's count back in its place.
  const merged = parseStream(stream(
    sys(),
    ev({ type: 'message_start', message: { usage: { input_tokens: 512, output_tokens: 0 } } }),
    textDelta('x'),
    messageDelta('end_turn', { output_tokens: 0 }),
  ));
  assert.deepEqual(merged.usage, { input: 512, output: 0 });
  // The MERGE itself is unchanged: a line that reports only one side keeps the other.
  const kept = parseStream(stream(
    sys(),
    ev({ type: 'message_start', message: { usage: { input_tokens: 512, output_tokens: 0 } } }),
    messageDelta('end_turn', { output_tokens: 40 }),
  ));
  assert.deepEqual(kept.usage, { input: 512, output: 40 });
  // message_start's all-zero placeholder is still not a report of anything.
  const placeholder = parseStream(stream(sys(), ev({ type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } }), textDelta('x')));
  assert.equal(placeholder.usage, null);
});

test('parseStream: a SUCCESSFUL result line that stops on "tool_use" is a finished answer, not an early stop', () => {
  // The last turn of a completed run can carry the tool call's own stop_reason.
  // Stamping "ended early" on that turns every clean answer into a suspect one.
  const s = parseStream(stream(sys(), textDelta('done'), resultLine({ result: 'done', stop_reason: 'tool_use', usage: USAGE })));
  assert.equal(s.stopReason, 'end_turn');
  assert.equal(answerText(ok({ stdout: stream(sys(), textDelta('done'), resultLine({ result: 'done', stop_reason: 'tool_use' })) })), 'done');
  // The stop_reasons that DO mean "cut short" still say so, in their own
  // spelling — `cancelled` among them: a headless run that reached a tool call
  // needing approval ends at exit 0 with empty final text, and reading that as
  // a clean end_turn is the very thing the streaming output exists to prevent.
  for (const stop of ['max_tokens', 'max_turns', 'length', 'cancelled']) {
    const early = parseStream(stream(sys(), textDelta('half'), resultLine({ result: 'half', stop_reason: stop })));
    assert.equal(early.stopReason, stop, stop);
    const marked = answerText(ok({ stdout: stream(sys(), textDelta('half'), resultLine({ result: 'half', stop_reason: stop })) }));
    assert.match(marked, new RegExp(`\\[grok: run ended early — stopReason=${stop}\\]`));
  }
});

test('parseStream: an error line whose `message` is not a string still yields TEXT, never "[object Object]"', () => {
  const obj = parseStream(stream(sys(), JSON.stringify({ type: 'error', message: { code: 'rate_limit', detail: 'slow down' } })));
  assert.equal(typeof obj.error, 'string');
  assert.doesNotMatch(obj.error, /\[object Object\]/);
  assert.match(obj.error, /rate_limit/);
  assert.throws(
    () => interpretGrok(ok({ stdout: stream(sys(), JSON.stringify({ type: 'error', message: { code: 'rate_limit' } })) }), { jsonMode: true, timeoutS: 300 }),
    /grok CLI error: .*rate_limit/,
  );
  // A string message is passed through, and one that is neither still says something.
  assert.equal(parseStream(stream(sys(), JSON.stringify({ type: 'error', message: 'plain words' }))).error, 'plain words');
  for (const message of [null, 42, ['a', 'b']]) {
    const e = parseStream(stream(sys(), JSON.stringify({ type: 'error', message }))).error;
    assert.equal(typeof e, 'string', JSON.stringify(message));
    assert.ok(e.length > 0 && !e.includes('[object Object]'), e);
  }
});
