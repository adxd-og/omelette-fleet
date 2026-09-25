import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStatus, previewText, STATUS_SCHEMA } from '../core/status.mjs';

function make(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-status-'));
  const st = createStatus({ unit: 'testunit', spawnTools: new Set(['t_research']), resolve: () => ({ dir, enabled }) });
  return { dir, st, file: join(dir, `status-testunit-${process.pid}.json`) };
}

test('start/end write an atomic snapshot and one log line per event, schema-tagged', () => {
  const { dir, st, file } = make();
  st.boot();
  const tok = st.start('t_research', 'hello\nworld\u0001!', 'm1', 'high');
  assert.ok(tok);
  let snap = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(snap.schema, STATUS_SCHEMA);
  assert.equal(snap.unit, 'testunit');
  assert.equal(snap.active.length, 1);
  assert.equal(snap.active[0].promptPreview, 'hello world !');
  assert.equal(snap.active[0].model, 'm1');
  st.end(tok, 'ok', null, { usage: { in: 1, out: 2 } });
  snap = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(snap.active.length, 0);
  assert.equal(snap.lastEvent.status, 'ok');
  assert.deepEqual(snap.lastEvent.usage, { in: 1, out: 2 });
  const lines = readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ['start', 'end']);
  assert.ok(lines.every((l) => l.schema === STATUS_SCHEMA && l.unit === 'testunit'));
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('untracked tools return null and end(null) is a no-op', () => {
  const { dir, st } = make();
  assert.equal(st.start('t_models', 'x'), null);
  st.end(null, 'ok');
  assert.equal(existsSync(join(dir, 'fleet-log.ndjson')), false);
});

test('disabled feed writes nothing at all', () => {
  const { st, file } = make(false);
  st.boot();
  const tok = st.start('t_research', 'x');
  assert.equal(tok, null);
  assert.equal(existsSync(file), false);
});

test('errors are truncated to 500 chars and marked as status error', () => {
  const { st, file } = make();
  const tok = st.start('t_research', 'x');
  st.end(tok, 'error', 'e'.repeat(2000));
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(snap.lastEvent.status, 'error');
  assert.equal(snap.lastEvent.error.length, 500);
});

test('a result id rides the whole pair: the active entry, both log lines and lastEvent', () => {
  const { dir, st, file } = make();
  const rid = '20260908T142501Z-19312-1';
  const tok = st.start('t_research', 'x', 'm1', 'high', rid);
  assert.equal(tok.resultId, rid);
  let snap = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(snap.active[0].resultId, rid);
  // A cancelled request: a third status, and `detached` travels like `partial`.
  st.end(tok, 'cancelled', null, { detached: true });
  snap = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(snap.schema, STATUS_SCHEMA, 'a new field never bumps the schema');
  assert.equal(snap.lastEvent.status, 'cancelled');
  assert.equal(snap.lastEvent.detached, true);
  assert.equal(snap.lastEvent.resultId, rid);
  const lines = readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.resultId), [rid, rid]);
  assert.equal(lines[1].status, 'cancelled');
  assert.equal(lines[1].detached, true);
});

test('an omitted result id is null everywhere it appears, never undefined', () => {
  const { dir, st, file } = make();
  const tok = st.start('t_research', 'x');
  st.end(tok, 'ok');
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(snap.active.length, 0);
  assert.equal(snap.lastEvent.resultId, null);
  const start = readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))[0];
  assert.equal(start.resultId, null);
});

test('previewText is the one preview rule, exported so the result record shares it', () => {
  assert.equal(previewText('hello\nworld\u0001!'), 'hello world !');
  assert.equal(previewText(null), '');
  assert.equal(previewText('x'.repeat(400)).length, 200);
});

/* ── Schema 2 (1.6.0): one snapshot per process, a sweep of dead ones ─────── */

test('two processes of one unit keep separate snapshots; neither boot clears the other', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-status-two-'));
  const mk = (pid) => createStatus({ unit: 'u', spawnTools: new Set(['t']), resolve: () => ({ dir, enabled: true }), pid });
  // Two LIVE pids: a dead one is exactly what the sweep removes. This process
  // and its parent; a runner whose parent is already gone fails here, loudly.
  const A = process.pid; const B = process.ppid;
  assert.notEqual(A, B);
  for (const p of [A, B]) assert.doesNotThrow(() => process.kill(p, 0), `pid ${p} must be alive for this test`);
  const a = mk(A); const b = mk(B);                // `pid` option: tests only; defaults to process.pid
  a.boot(); const ta = a.start('t', 'a');
  b.boot();                                       // must not touch a's file
  const snapA = JSON.parse(readFileSync(join(dir, `status-u-${A}.json`), 'utf8'));
  assert.equal(snapA.active.length, 1); assert.equal(snapA.pid, A); assert.equal(snapA.schema, 2);
  assert.equal(JSON.parse(readFileSync(join(dir, `status-u-${B}.json`), 'utf8')).lastEvent, null, 'a fresh process starts with no lastEvent of its own');
  a.end(ta, 'ok');
  assert.equal(JSON.parse(readFileSync(join(dir, `status-u-${A}.json`), 'utf8')).lastEvent.status, 'ok');
});

test('boot sweeps a dead neighbour and leaves a live one alone (Review Focus 3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-status-sweep-'));
  const dead = join(dir, 'status-u-999999.json');   // no such pid on any sane machine; the test asserts that first
  assert.throws(() => process.kill(999999, 0));
  writeFileSync(dead, JSON.stringify({ schema: 2, unit: 'u', pid: 999999, active: [{ id: 'x' }], lastEvent: null, updatedAt: '2000-01-01T00:00:00.000Z' }));
  const live = join(dir, `status-u-${process.pid}.json`);   // "live": our own pid, written as if by a sibling
  writeFileSync(live, JSON.stringify({ schema: 2, unit: 'u', pid: process.pid, active: [], lastEvent: null, updatedAt: '2000-01-01T00:00:00.000Z' }));
  const other = join(dir, 'status-v-999999.json');           // another UNIT's dead file: not ours to sweep
  writeFileSync(other, '{}');
  createStatus({ unit: 'u', spawnTools: new Set(['t']), resolve: () => ({ dir, enabled: true }), pid: 33333 }).boot();
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(other), true);
});

test('the sweep removes a file only when the OS says its pid does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-status-edges-'));
  // pid 1 belongs to root: signalling it is EPERM for an ordinary user (alive,
  // not ours) and succeeds for root (alive). Either way the file stays.
  let pid1 = null;
  try { process.kill(1, 0); } catch (e) { pid1 = e.code; }
  assert.ok(pid1 === null || pid1 === 'EPERM', `kill(1, 0) gave ${pid1}`);
  const root = join(dir, 'status-u-1.json');
  // A pid the OS cannot even be asked about (out of range): unknown is not dead.
  const odd = join(dir, 'status-u-99999999999.json');
  // The schema-1 name carries no pid, so nothing says whose it is: not the sweep's.
  const legacy = join(dir, 'status-u.json');
  for (const f of [root, odd, legacy]) writeFileSync(f, '{}');
  createStatus({ unit: 'u', spawnTools: new Set(['t']), resolve: () => ({ dir, enabled: true }), pid: 33333 }).boot();
  assert.equal(existsSync(root), true);
  assert.equal(existsSync(odd), true);
  assert.equal(existsSync(legacy), true);
});

test('a disabled feed sweeps nothing either', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-status-off-'));
  const dead = join(dir, 'status-u-999999.json');
  assert.throws(() => process.kill(999999, 0));
  writeFileSync(dead, '{}');
  createStatus({ unit: 'u', spawnTools: new Set(['t']), resolve: () => ({ dir, enabled: false }), pid: 33333 }).boot();
  assert.equal(existsSync(dead), true);
});

test('dispose removes this process\'s snapshot and nothing else', () => {
  const { dir, st, file } = make();
  st.boot(); assert.equal(existsSync(file), true);
  writeFileSync(join(dir, 'status-testunit-424242.json'), '{}');
  st.dispose();
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(join(dir, 'status-testunit-424242.json')), true);
});

test('the log line carries schema 2', () => {
  const { dir, st } = make();
  st.end(st.start('t_research', 'x'), 'ok');
  const lines = readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.schema === 2), JSON.stringify(lines));
});
