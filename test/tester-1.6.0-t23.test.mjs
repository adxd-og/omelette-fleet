/**
 * omelette-fleet :: test/tester-1.6.0-t23.test.mjs
 * Clean-context tester file for 1.6.0's R2 (deep research names its failed
 * gathers) and R3 (a snapshot per process). Written against the spec
 * (docs/superpowers/specs/2026-09-25-1.6.0-result-truth-design.md), not the
 * coders' own tests — this file avoids duplicating test/tester-1.6.0-r2.test.mjs,
 * the new tests in test/status.test.mjs and test/tester-1.6.0-r3.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import unit from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import { createStatus, snapshotPath } from '../core/status.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GEMINI_SERVER = join(ROOT, 'servers', 'gemini.mjs');

/* ── R2: gemini_deep_research names its failed gathers ─────────────────────── */

/** A finished-run shape in exactly the form core/spawn.mjs resolves one. */
const spawnRes = (over) => Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, killed: false, capped: false, ...over });

/**
 * A runtime whose spawn is answered by `stub(o, realSpawn)`: `realSpawn` is the
 * genuine ctx.spawn (with the run's killSignal already bound), for the one case
 * that needs a REAL hard-killed subprocess rather than a synthetic resolution.
 * `seen.last` keeps the adapter's own return (partial included) — callTool's
 * result to a client never carries the flag as a top-level readable value here.
 */
const deepRt = (env, stub, seen = {}) => createUnitRuntime(
  { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: async (a, ctx) => (seen.last = await t.run(a, { ...ctx, spawn: (o) => stub(o, ctx.spawn) })) } : t)) },
  { env },
);

const homeWithConfig = (prefix, units = { gemini: { timeoutS: 30 } }) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units }));
  return dir;
};

test('R2.1: an exit-code failure AND a REAL hard-killed gather are both named, in order; partial reaches the snapshot and the log', async () => {
  const dir = homeWithConfig('omelette-t23-r2-both-');
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const hangScript = join(dir, 'hang-agy.mjs');
  writeFileSync(hangScript, 'setTimeout(() => {}, 30000);');
  let synthPrompt = '';
  const stub = (o, realSpawn) => {
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) {
      return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify({ subquestions: ['alpha', 'beta', 'gamma'] }), structured_output: { subquestions: ['alpha', 'beta', 'gamma'] } }) });
    }
    if (/Question: alpha$/.test(prompt)) return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: 'all of alpha' }) });
    // beta: exits non-zero, no output at all — a fast, synthetic failure.
    if (/Question: beta$/.test(prompt)) return spawnRes({ stdout: '', stderr: '', code: 2 });
    // gamma: a REAL hard kill (small hardKillMs override), no output at all.
    if (/Question: gamma$/.test(prompt)) return realSpawn({ ...o, args: [hangScript, ...o.args], hardKillMs: 300 });
    synthPrompt = prompt;
    return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nthe report' }) });
  };
  const seen = {};
  const r = await deepRt(env, stub, seen).callTool('gemini_deep_research', { question: 'the big question' });
  assert.ok(!r.isError, r.text);
  // Order is DECLARATION order (ruling 2026-09-25): "agy exited 2" is not in
  // core/unit.mjs's `isDeterministic` list, so beta is retried once (a 1.5s
  // delay) and fails AFTER gamma's hard kill — and the header still names beta
  // first, because it was asked first.
  assert.match(r.text, /^\[gemini: 2 of 3 gathers failed: beta; gamma\]$/m);
  assert.equal(seen.last.partial, true);
  assert.match(synthPrompt, /_\(gather failed: agy exited 2/);
  assert.match(synthPrompt, /_\(gather failed: agy hard-killed after \d+s/);
  assert.doesNotMatch(r.text, /stages returned partial answers/);   // neither failure is a partial STAGE
  const snap = JSON.parse(readFileSync(join(dir, `status-gemini-${process.pid}.json`), 'utf8'));
  assert.equal(snap.lastEvent.partial, true);
  const lines = readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const endLines = lines.filter((l) => l.event === 'end');
  assert.equal(endLines[endLines.length - 1].partial, true);
});

test('R2: the gathers-failed header lists sub-questions in DECLARATION order, whatever order their failures land in (ruling 2026-09-25)', async () => {
  const dir = homeWithConfig('omelette-t23-r2-order-');
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const hangScript = join(dir, 'hang-agy-2.mjs');
  writeFileSync(hangScript, 'setTimeout(() => {}, 30000);');
  const stub = (o, realSpawn) => {
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) {
      return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify({ subquestions: ['alpha', 'beta'] }), structured_output: { subquestions: ['alpha', 'beta'] } }) });
    }
    // alpha is declared FIRST but exits non-zero with no stderr: "agy exited 2"
    // is not in `isDeterministic`, so core/unit.mjs's ctx.retry retries it once
    // (a 1.5s delay) before it finally fails.
    if (/Question: alpha$/.test(prompt)) return spawnRes({ stdout: '', stderr: '', code: 2 });
    // beta is declared SECOND but is a real hard kill: "hard-killed" IS
    // deterministic, so it is never retried and settles almost immediately.
    if (/Question: beta$/.test(prompt)) return realSpawn({ ...o, args: [hangScript, ...o.args], hardKillMs: 300 });
    return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nreport' }) });
  };
  const r = await deepRt(env, stub).callTool('gemini_deep_research', { question: 'q' });
  const m = r.text.match(/^\[gemini: 2 of 2 gathers failed: (.+)\]$/m);
  assert.ok(m, r.text);
  // The spec's header example ("<sub-question 1>; <sub-question 2>") reads as
  // declaration order; the code instead names each gather in the order its own
  // `Promise.all` member SETTLES (`failedGathers.push` inside the catch), so a
  // gather declared LATER but retried NEVER (a deterministic failure) is named
  // BEFORE one declared earlier that a transient-looking failure gets retried
  // for. Reported as a finding, not asserted as a bug.
  assert.equal(m[1], 'alpha; beta', `observed order was "${m[1]}" — the header must follow the order the sub-questions were asked in`);
});

test('R2.2: a partial stage AND a failed gather together — stages line, then gathers line, then the synthesis text; no degraded banner', async () => {
  const dir = homeWithConfig('omelette-t23-r2-combo-');
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const stub = (o) => {
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) {
      return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify({ subquestions: ['alpha', 'beta'] }), structured_output: { subquestions: ['alpha', 'beta'] } }) });
    }
    // alpha: hard-killed WITH salvaged text — a partial STAGE, not a failure.
    if (/Question: alpha$/.test(prompt)) return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: 'half of alpha' }), code: null, killed: true });
    // beta: exits non-zero with nothing — a failed GATHER.
    if (/Question: beta$/.test(prompt)) return spawnRes({ stdout: '', stderr: '', code: 2 });
    return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nthe report' }) });
  };
  const r = await deepRt(env, stub).callTool('gemini_deep_research', { question: 'the big question' });
  assert.ok(!r.isError, r.text);
  const paras = r.text.split('\n\n');
  // decompose + 2 gathers + synth = 4 stages that ran; only alpha's is partial.
  assert.equal(paras[0], '[gemini: 1 of 4 stages returned partial answers]');
  assert.equal(paras[1], '[gemini: 1 of 2 gathers failed: beta]');
  assert.doesNotMatch(r.text, /Degraded run/);
  assert.ok(paras[2].startsWith('## Summary'), paras[2]);
});

test('R2 (finding): a degraded run whose single shallow-pass gather also fails shows BOTH the banner and the gathers-failed header', async () => {
  const dir = homeWithConfig('omelette-t23-r2-degraded-fail-');
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const stub = (o) => {
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '{}' }) });   // no subquestions -> degrades
    if (/Research this question/.test(prompt)) return spawnRes({ stdout: '', stderr: '', code: 2 });   // the single shallow-pass gather fails
    return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nthe single-pass report' }) });
  };
  const seen = {};
  const r = await deepRt(env, stub, seen).callTool('gemini_deep_research', { question: 'the big question' });
  assert.ok(!r.isError, r.text);
  const paras = r.text.split('\n\n');
  assert.match(paras[0], /^> \*\*Degraded run — decomposition failed\.\*\*/);
  assert.equal(paras[1], '[gemini: 1 of 1 gathers failed: the big question]');
  assert.doesNotMatch(r.text, /stages returned partial answers/);
  // "degraded ... gets no flag" (spec) is true of the degraded path ALONE; a
  // gathers-failed header is a SEPARATE mechanism and still flips the flag —
  // recorded here since the spec sentence reads, on its own, as if degraded
  // were exempt altogether.
  assert.equal(seen.last.partial, true);
});

test('R2.3: a sub-question longer than 80 characters is truncated in the header to 80', async () => {
  const dir = homeWithConfig('omelette-t23-r2-trunc-');
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const longQ = 'x'.repeat(100);
  const expected = 'x'.repeat(80);
  const stub = (o) => {
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) {
      return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify({ subquestions: [longQ] }), structured_output: { subquestions: [longQ] } }) });
    }
    if (prompt.endsWith(`Question: ${longQ}`)) return spawnRes({ stdout: '', stderr: '', code: 2 });
    return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nreport' }) });
  };
  const r = await deepRt(env, stub).callTool('gemini_deep_research', { question: 'q' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, new RegExp(`^\\[gemini: 1 of 1 gathers failed: ${expected}\\]$`, 'm'));
  assert.doesNotMatch(r.text, new RegExp(`gathers failed: ${expected}x`));   // no 81st character leaked in
});

test('R2.4: cancellation before synthesis returns CANCELLED + partial, with no gathers-failed header even when a gather had already failed', async () => {
  const dir = homeWithConfig('omelette-t23-r2-cancel-', { gemini: { cancel: 'kill', timeoutS: 60 } });
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const controller = new AbortController();
  const stub = (o) => {
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) {
      return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: JSON.stringify({ subquestions: ['alpha', 'beta'] }), structured_output: { subquestions: ['alpha', 'beta'] } }) });
    }
    if (/Question: alpha$/.test(prompt)) return spawnRes({ stdout: '', stderr: '', code: 2 });   // fails BEFORE the cancel is observed
    if (/Question: beta$/.test(prompt)) {
      controller.abort();   // the cancel lands while beta's gather is still "in flight"
      return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: 'beta finding' }) });
    }
    return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nSHOULD NOT APPEAR' }) });
  };
  const rt = createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub }) } : t)) },
    { env },
  );
  const r = await rt.callTool('gemini_deep_research', { question: 'the big question' }, { id: 1, signal: controller.signal });
  assert.match(r.text, /Cancelled — the synthesis stage did not run/);
  assert.doesNotMatch(r.text, /gathers failed/);
  assert.doesNotMatch(r.text, /SHOULD NOT APPEAR/);
  const snap = JSON.parse(readFileSync(join(dir, `status-gemini-${process.pid}.json`), 'utf8'));
  assert.equal(snap.lastEvent.status, 'cancelled');
  assert.equal(snap.lastEvent.partial, true);
});

/* ── R3: a snapshot per process ─────────────────────────────────────────────── */

test('R3.5: two different units in one dir — each boot sweeps only its OWN units dead file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t23-r3-crossunit-'));
  const deadAlpha = join(dir, 'status-alpha-999991.json');
  const deadBravo = join(dir, 'status-bravo-999992.json');
  writeFileSync(deadAlpha, JSON.stringify({ schema: 2, unit: 'alpha', pid: 999991, active: [], lastEvent: null, updatedAt: '2000-01-01T00:00:00.000Z' }));
  writeFileSync(deadBravo, JSON.stringify({ schema: 2, unit: 'bravo', pid: 999992, active: [], lastEvent: null, updatedAt: '2000-01-01T00:00:00.000Z' }));

  createStatus({ unit: 'alpha', spawnTools: new Set(['t']), resolve: () => ({ dir, enabled: true }), pid: 11111 }).boot();
  assert.equal(existsSync(deadAlpha), false, "an 'alpha' boot must sweep alpha's own dead file");
  assert.equal(existsSync(deadBravo), true, "an 'alpha' boot must leave bravo's file alone");

  createStatus({ unit: 'bravo', spawnTools: new Set(['t']), resolve: () => ({ dir, enabled: true }), pid: 22222 }).boot();
  assert.equal(existsSync(deadBravo), false, "a 'bravo' boot must sweep bravo's own dead file");
});

test('R3.6: a hyphenated unit name round-trips through the snapshot name and the sweep', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t23-r3-hyphen-'));
  const st = createStatus({ unit: 'my-unit', spawnTools: new Set(['t']), resolve: () => ({ dir, enabled: true }), pid: 42424 });
  st.boot();
  const file = join(dir, 'status-my-unit-42424.json');
  assert.equal(existsSync(file), true);
  assert.equal(snapshotPath(dir, 'my-unit', 42424), file);
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(snap.unit, 'my-unit');
  assert.equal(snap.pid, 42424);

  const deadMyUnit = join(dir, 'status-my-unit-999999.json');
  writeFileSync(deadMyUnit, JSON.stringify({ schema: 2, unit: 'my-unit', pid: 999999, active: [], lastEvent: null, updatedAt: '2000-01-01T00:00:00.000Z' }));
  const deadUnit = join(dir, 'status-unit-999998.json');
  writeFileSync(deadUnit, JSON.stringify({ schema: 2, unit: 'unit', pid: 999998, active: [], lastEvent: null, updatedAt: '2000-01-01T00:00:00.000Z' }));

  createStatus({ unit: 'unit', spawnTools: new Set(['t']), resolve: () => ({ dir, enabled: true }), pid: 55555 }).boot();
  assert.equal(existsSync(deadMyUnit), true, "a 'unit' boot must NOT sweep 'my-unit's dead file");
  assert.equal(existsSync(deadUnit), false, "a 'unit' boot sweeps its OWN dead file");

  createStatus({ unit: 'my-unit', spawnTools: new Set(['t']), resolve: () => ({ dir, enabled: true }), pid: 66666 }).boot();
  assert.equal(existsSync(deadMyUnit), false, "a 'my-unit' boot sweeps its own dead file");
});

test('R3.7: the "last event" jq recipe from STATUS-FEED reads the newest lastEvent across a units files', (t) => {
  let jqPath = '';
  try { jqPath = execSync('which jq', { encoding: 'utf8' }).trim(); } catch { /* no jq */ }
  if (!jqPath) { t.skip('jq not found on PATH — skipping the recipe check'); return; }

  const dir = mkdtempSync(join(tmpdir(), 'omelette-t23-r3-jq-'));
  const mk = (pid, endedAt, extra = {}) => writeFileSync(
    join(dir, `status-codex-${pid}.json`),
    JSON.stringify({
      schema: 2, unit: 'codex', pid, active: [],
      lastEvent: endedAt ? { tool: 'codex_research', status: 'ok', endedAt, durationMs: 1, error: null, resultId: null, ...extra } : null,
      updatedAt: endedAt || new Date().toISOString(),
    }),
  );
  mk(100, '2026-01-01T00:00:00.000Z', { marker: 'oldest' });
  mk(200, '2026-01-03T00:00:00.000Z', { marker: 'newest' });
  mk(300, null);   // no lastEvent: excluded by `select(.lastEvent)`

  const cmd = `jq -s 'map(select(.unit=="codex" and .lastEvent)) | max_by(.lastEvent.endedAt) | .lastEvent' ${join(dir, 'status-codex-*.json')}`;
  const out = execSync(cmd, { shell: '/bin/bash', encoding: 'utf8' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.endedAt, '2026-01-03T00:00:00.000Z');
  assert.equal(parsed.marker, 'newest');
});

/** Poll `check` until it returns truthy or 10s pass; fails loudly on timeout. */
async function until(check, what) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    let v;
    try { v = check(); } catch { v = undefined; }
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out after 10s waiting for ${what}`);
}

test('R3.8: a real gemini server — notifications/cancelled ends the call as cancelled (seen in the log); the snapshot goes on stdin close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t23-r3-cancel-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { cancel: 'kill', timeoutS: 60 } } }));
  const fakeAgyPath = join(dir, 'fake-agy');
  writeFileSync(fakeAgyPath, [`#!${process.execPath}`, 'setInterval(() => {}, 1000);'].join('\n'));
  chmodSync(fakeAgyPath, 0o755);
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: fakeAgyPath, OMELETTE_UPDATE_CHECK: '0' };
  const child = spawn(process.execPath, [GEMINI_SERVER], { env, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const frames = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) { try { frames.push(JSON.parse(line)); } catch { /* not a frame */ } }
    }
  });
  child.stdin.on('error', () => {});
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })}\n`);
    await until(() => frames.some((f) => f.id === 1), 'the initialize reply');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gemini_research', arguments: { prompt: 'hold on' } } })}\n`);
    const snapPath = join(dir, `status-gemini-${child.pid}.json`);
    await until(() => existsSync(snapPath) && JSON.parse(readFileSync(snapPath, 'utf8')).active.length === 1, 'the call to show as active');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } })}\n`);
    const logPath = join(dir, 'fleet-log.ndjson');
    // The lastEvent line before removal: read the LOG (persists after the
    // snapshot file goes), not the snapshot, which can be removed by the time
    // this check runs.
    await until(() => {
      if (!existsSync(logPath)) return false;
      const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return lines.some((l) => l.event === 'end' && l.status === 'cancelled');
    }, 'the log to record a cancelled end');
    child.stdin.end();
    await until(() => !existsSync(snapPath), 'the snapshot to be removed on the clean-exit path');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('R3.9: no .tmp file survives a boot/start/end cycle, and the log lines carry schema 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t23-r3-tmp-'));
  const st = createStatus({ unit: 'tmpcheck', spawnTools: new Set(['t']), resolve: () => ({ dir, enabled: true }), pid: 77777 });
  st.boot();
  const tok = st.start('t', 'hello');
  st.end(tok, 'ok');
  const names = readdirSync(dir);
  assert.equal(names.some((n) => n.endsWith('.tmp')), false, `leftover tmp files: ${names.join(', ')}`);
  const lines = readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((l) => l.schema === 2));
});
