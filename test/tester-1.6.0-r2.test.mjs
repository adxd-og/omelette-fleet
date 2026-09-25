// R2 (1.6.0): a deep-research gather that THREW is named in a `gathers failed`
// header above the synthesis, and the report is partial.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import { PARTIAL_MARK_RE } from '../core/partial.mjs';

const spawnRes = (over) => Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, killed: false, capped: false, ...over });
// The runtime's callTool result does not carry `partial` (it goes to the log
// and the status snapshot), so the adapter's own return is kept in `seen.last`.
const deepRt = (env, stub, seen = {}) => createUnitRuntime(
  { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: async (a, ctx) => (seen.last = await t.run(a, { ...ctx, spawn: stub })) } : t)) },
  { env },
);
const homeWithConfig = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  return dir;
};

test('gemini_deep_research: a gather that threw is named in a `gathers failed` header and the report is partial', async () => {
  const dir = homeWithConfig('omelette-r2-failed-');
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  let synthPrompt = '';
  const stub = (o) => {
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) {
      return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '{"subquestions":["alpha","beta"]}', structured_output: { subquestions: ['alpha', 'beta'] } }) });
    }
    if (/Question: alpha$/.test(prompt)) return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: 'all of alpha' }) });
    // The second gather exits 2 with no output at all: `agy exited 2`.
    if (/Question: beta$/.test(prompt)) return spawnRes({ stdout: '', stderr: '', code: 2 });
    synthPrompt = prompt;
    return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nthe report' }) });
  };
  const seen = {};
  const r = await deepRt(env, stub, seen).callTool('gemini_deep_research', { question: 'the big question' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /^\[gemini: 1 of 2 gathers failed: beta\]/m);
  assert.equal(seen.last.partial, true);
  assert.match(synthPrompt, /_\(gather failed: agy exited 2/);   // the synthesis still ran, on honest input
  assert.doesNotMatch(r.text, /stages returned partial answers/);   // a thrown gather is not a partial stage
  assert.match(r.text, /## Summary/);
  const snap = JSON.parse(readFileSync(join(dir, `status-gemini-${process.pid}.json`), 'utf8'));
  assert.equal(snap.lastEvent.partial, true);
});

test('gemini_deep_research: a decomposition with no sub-questions degrades, with no `gathers failed` line and no partial flag', async () => {
  const dir = homeWithConfig('omelette-r2-degraded-');
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const stub = (o) => {
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) {
      return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '{}' }) });
    }
    return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nthe single-pass report' }) });
  };
  const seen = {};
  const r = await deepRt(env, stub, seen).callTool('gemini_deep_research', { question: 'the big question' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /^> \*\*Degraded run — decomposition failed\.\*\*/);
  assert.equal(seen.last.partial, undefined);   // absent, never false
  assert.doesNotMatch(r.text, /gathers failed/);
  const snap = JSON.parse(readFileSync(join(dir, `status-gemini-${process.pid}.json`), 'utf8'));
  assert.equal(snap.lastEvent.partial, undefined);
});

test('gemini_deep_research: brackets in a failed sub-question cannot close the `gathers failed` marker early', async () => {
  const dir = homeWithConfig('omelette-r2-bracket-');
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const sq = 'what does a[0] return';
  const stub = (o) => {
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) {
      return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify({ subquestions: [sq] }), structured_output: { subquestions: [sq] } }) });
    }
    if (prompt.endsWith(`Question: ${sq}`)) return spawnRes({ stdout: '', stderr: '', code: 2 });
    return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nthe report' }) });
  };
  const r = await deepRt(env, stub).callTool('gemini_deep_research', { question: 'the big question' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /^\[gemini: 1 of 1 gathers failed: what does a\(0\) return\]$/m);
  assert.ok(PARTIAL_MARK_RE.exec(r.text)[0].endsWith('gathers failed: what does a(0) return]'), r.text);
});
