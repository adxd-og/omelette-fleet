import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStatus, previewText, STATUS_SCHEMA } from '../core/status.mjs';

function make(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-status-'));
  const st = createStatus({ unit: 'testunit', spawnTools: new Set(['t_research']), resolve: () => ({ dir, enabled }) });
  return { dir, st };
}

test('start/end write an atomic snapshot and one log line per event, schema-tagged', () => {
  const { dir, st } = make();
  st.boot();
  const tok = st.start('t_research', 'hello\nworld\u0001!', 'm1', 'high');
  assert.ok(tok);
  let snap = JSON.parse(readFileSync(join(dir, 'status-testunit.json'), 'utf8'));
  assert.equal(snap.schema, STATUS_SCHEMA);
  assert.equal(snap.unit, 'testunit');
  assert.equal(snap.active.length, 1);
  assert.equal(snap.active[0].promptPreview, 'hello world !');
  assert.equal(snap.active[0].model, 'm1');
  st.end(tok, 'ok', null, { usage: { in: 1, out: 2 } });
  snap = JSON.parse(readFileSync(join(dir, 'status-testunit.json'), 'utf8'));
  assert.equal(snap.active.length, 0);
  assert.equal(snap.lastEvent.status, 'ok');
  assert.deepEqual(snap.lastEvent.usage, { in: 1, out: 2 });
  const lines = readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ['start', 'end']);
  assert.ok(lines.every((l) => l.schema === STATUS_SCHEMA && l.unit === 'testunit'));
  assert.equal(statSync(join(dir, 'status-testunit.json')).mode & 0o777, 0o600);
});

test('untracked tools return null and end(null) is a no-op', () => {
  const { dir, st } = make();
  assert.equal(st.start('t_models', 'x'), null);
  st.end(null, 'ok');
  assert.equal(existsSync(join(dir, 'fleet-log.ndjson')), false);
});

test('disabled feed writes nothing at all', () => {
  const { dir, st } = make(false);
  st.boot();
  const tok = st.start('t_research', 'x');
  assert.equal(tok, null);
  assert.equal(existsSync(join(dir, 'status-testunit.json')), false);
});

test('errors are truncated to 500 chars and marked as status error', () => {
  const { dir, st } = make();
  const tok = st.start('t_research', 'x');
  st.end(tok, 'error', 'e'.repeat(2000));
  const snap = JSON.parse(readFileSync(join(dir, 'status-testunit.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'error');
  assert.equal(snap.lastEvent.error.length, 500);
});

test('a result id rides the whole pair: the active entry, both log lines and lastEvent', () => {
  const { dir, st } = make();
  const rid = '20260908T142501Z-19312-1';
  const tok = st.start('t_research', 'x', 'm1', 'high', rid);
  assert.equal(tok.resultId, rid);
  let snap = JSON.parse(readFileSync(join(dir, 'status-testunit.json'), 'utf8'));
  assert.equal(snap.active[0].resultId, rid);
  // A cancelled request: a third status, and `detached` travels like `partial`.
  st.end(tok, 'cancelled', null, { detached: true });
  snap = JSON.parse(readFileSync(join(dir, 'status-testunit.json'), 'utf8'));
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
  const { dir, st } = make();
  const tok = st.start('t_research', 'x');
  st.end(tok, 'ok');
  const snap = JSON.parse(readFileSync(join(dir, 'status-testunit.json'), 'utf8'));
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
