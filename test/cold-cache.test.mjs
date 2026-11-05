// scripts/cold-cache.mjs — cold prompt-cache restarts read out of a sub-agent's
// transcript: which requests are cold, what caused each, and the gap the TTL
// clock saw. The transcript is synthetic; aggregates out, never content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyseTranscript, bucketOf, summarise } from '../scripts/cold-cache.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cold-cache.mjs');
const T0 = Date.parse('2026-11-05T12:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const usage = (write, read) => ({ input_tokens: 2, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: 10 });
const request = (id, min, u, block) => ({ type: 'assistant', timestamp: at(min), message: { id, model: 'claude-sonnet-5-5', role: 'assistant', usage: u, content: [block] } });
const result = (toolUseId, min) => ({ type: 'user', timestamp: at(min), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] } });
const brief = (min, text) => ({ type: 'user', timestamp: at(min), message: { role: 'user', content: text } });

// First request writes 40 k; a Bash of 6.5 min; the next request rewrites
// everything (cold, cause Bash, gap 5–10); a Read of a few seconds and a warm
// request; the agent reports; the orchestrator resumes it 12 minutes later and
// that request is cold too (cause orchestrator, gap 10–30).
const transcript = [
  brief(0, 'the brief'),
  request('m1', 0, usage(40_000, 0), { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }),
  result('t1', 6.5),
  request('m2', 6.6, usage(41_000, 0), { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a' } }),
  result('t2', 6.7),
  request('m3', 6.8, usage(300, 41_000), { type: 'text', text: 'done' }),
  brief(18.8, 'Second pass'),
  request('m4', 18.9, usage(42_000, 0), { type: 'text', text: 'again' }),
];

test('cold restarts: not the first request, caused by the Bash before it or by the orchestrator, bucketed by the gap since the previous request', () => {
  const a = analyseTranscript(transcript, 'omelette-tester');
  assert.equal(a.requests, 4);
  assert.deepEqual(a.cold.map((c) => [c.cause, c.bucket, c.tokens]), [['Bash', '5–10', 41_000], ['orchestrator', '10–30', 42_000]]);
  assert.equal(a.cold[0].causeMin.toFixed(1), '6.5');
  assert.deepEqual(a.longBash, [6.5]);
  const s = summarise([a]);
  assert.equal(s.cold, 2);
  assert.equal(s.coldTokens, 83_000);
  assert.equal(s.byRole['omelette-tester'].cold, 2);
  assert.equal(s.longBash.under8, 1);
  assert.deepEqual(['<5', '5–10', '10–30', '30–60', '>60', 'unknown'], [4.9, 5, 29.9, 59, 60, NaN].map(bucketOf));
});

test('the CLI walks <project>/<session>/subagents and prints aggregates only', () => {
  const project = mkdtempSync(join(tmpdir(), 'omelette-cold-'));
  const dir = join(project, 'sess', 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent-a1.jsonl'), transcript.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'omelette-tester' }));
  const r = spawnSync(process.execPath, [SCRIPT, project, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.agents, 1);
  assert.equal(s.cold, 2);
  assert.doesNotMatch(r.stdout, /npm test|agent-a1|omelette-cold-/, 'no command text, file name or path in the output');
});
