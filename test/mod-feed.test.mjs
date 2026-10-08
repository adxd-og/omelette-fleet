/**
 * omelette-fleet :: test/mod-feed.test.mjs
 * The fleet pane's reading of the status feed (1.7.0, Task 2):
 * mods/omelette-fleet/hooks/feed.mjs picks the schema-2 snapshot files of the
 * three units out of a fleet-home listing and parses one snapshot's text. The
 * STATUS-FEED example is parsed verbatim, so a change to the documented
 * contract breaks this test before it breaks the pane.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSnapshot, snapshotNames } from '../mods/omelette-fleet/hooks/feed.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** The per-process snapshot example of docs/STATUS-FEED.md, as written there. */
function documentedSnapshot() {
  const doc = readFileSync(join(ROOT, 'docs', 'STATUS-FEED.md'), 'utf8');
  const start = doc.indexOf('```json\n') + '```json\n'.length;
  const text = doc.slice(start, doc.indexOf('\n```', start));
  assert.match(text, /"schema": 2/, 'the first JSON block of STATUS-FEED is the snapshot');
  return text;
}

/** A schema-2 snapshot of `unit` written at `updatedAt`, with the given active calls. */
const snapshotText = (unit, updatedAt, active = [], lastEvent = null) => JSON.stringify({ schema: 2, unit, pid: 4242, active, lastEvent, updatedAt: new Date(updatedAt).toISOString() });
const activeCall = (startedAt) => ({ id: '4242-1', tool: 'grok_research', model: 'grok-4.7', effort: null, promptPreview: 'x', startedAt: new Date(startedAt).toISOString(), resultId: null });

test('snapshotNames keeps the three units\' status-<unit>-<pid>.json and drops everything else', () => {
  assert.deepEqual(snapshotNames([
    'status-grok-4242.json',
    'fleet-log.ndjson',
    'status-gemini-7.json',
    'status-grok.json',
    'status-other-1.json',
    'status-grok-4242.json.4242.tmp',
    'status-grok-abc.json',
    'STATUS-grok-1.json',
    'status-codex-48123.json',
    'status-codex--1.json',
    'status-codex-.json',
    'status-codex-1-2.json',
    'status-codexx-1.json',
  ]), ['status-grok-4242.json', 'status-gemini-7.json', 'status-codex-48123.json']);
  assert.deepEqual(snapshotNames([]), []);
});

test('parseSnapshot reads the STATUS-FEED example verbatim: times in ms, the active call\'s fields, lastEvent\'s end', () => {
  const now = Date.parse('2026-09-03T09:14:05.000Z');
  assert.deepEqual(parseSnapshot(documentedSnapshot(), now), {
    unit: 'codex',
    pid: 48123,
    active: [{ id: '48123-2', tool: 'codex_code_review', model: 'gpt-5.6-terra', effort: 'high', startedAt: Date.parse('2026-09-03T09:14:02.118Z') }],
    updatedAt: Date.parse('2026-09-03T09:14:02.119Z'),
    lastEndedAt: Date.parse('2026-09-03T09:13:44.902Z'),
    isStale: false,
  });
});

test('parseSnapshot: schema 1 is null', () => {
  const now = Date.parse('2026-09-03T09:14:05.000Z');
  assert.equal(parseSnapshot(documentedSnapshot().replace('"schema": 2', '"schema": 1'), now), null);
  assert.equal(parseSnapshot(JSON.stringify({ unit: 'grok', active: [], updatedAt: '2026-09-03T09:14:02.119Z' }), now), null, 'no schema');
});

test('parseSnapshot: garbage, non-objects and an unknown unit are null', () => {
  const now = Date.now();
  for (const text of ['', 'not json', '{"schema": 2,', 'null', '[]', '42', '"status"', 'true', undefined]) {
    assert.equal(parseSnapshot(text, now), null, String(text));
  }
  assert.equal(parseSnapshot(snapshotText('claude', now), now), null);
  assert.equal(parseSnapshot(snapshotText('toString', now), now), null);
});

test('parseSnapshot: a snapshot whose updatedAt is not a time is malformed, so null', () => {
  const now = Date.now();
  assert.equal(parseSnapshot(JSON.stringify({ schema: 2, unit: 'grok', pid: 1, active: [], updatedAt: 'yesterday' }), now), null);
  assert.equal(parseSnapshot(JSON.stringify({ schema: 2, unit: 'grok', pid: 1, active: [] }), now), null);
});

test('parseSnapshot: a call in active[] with updatedAt more than 2 hours old is stale, and its active is returned empty', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const snap = parseSnapshot(snapshotText('grok', now - 2 * HOUR - MIN, [activeCall(now - 2 * HOUR - 2 * MIN)]), now);
  assert.equal(snap.isStale, true);
  assert.deepEqual(snap.active, []);
  assert.equal(snap.unit, 'grok');
});

test('parseSnapshot: a call 40 minutes without an update is live — the feed is written on events only, and a default deep research runs about 36 minutes', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const snap = parseSnapshot(snapshotText('gemini', now - 40 * MIN, [activeCall(now - 40 * MIN)]), now);
  assert.equal(snap.isStale, false);
  assert.equal(snap.active.length, 1);
});

test('parseSnapshot: staleness starts past 2 hours, and an old snapshot with nothing active is not stale', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const atBound = parseSnapshot(snapshotText('grok', now - 2 * HOUR, [activeCall(now - 2 * HOUR - MIN)]), now);
  assert.equal(atBound.isStale, false);
  assert.equal(atBound.active.length, 1);
  assert.equal(parseSnapshot(snapshotText('grok', now - 2 * HOUR - 1, [activeCall(now - 2 * HOUR - MIN)]), now).isStale, true);
  const quiet = parseSnapshot(snapshotText('gemini', now - 10 * HOUR), now);
  assert.equal(quiet.isStale, false);
  assert.deepEqual(quiet.active, []);
});

test('parseSnapshot: no lastEvent leaves no lastEndedAt; a vendor-default model and effort stay null', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const snap = parseSnapshot(snapshotText('grok', now - 1000, [activeCall(now - 2000)]), now);
  assert.equal('lastEndedAt' in snap, false);
  assert.equal(snap.active[0].effort, null);
  assert.equal(snap.active[0].model, 'grok-4.7');
});

test('parseSnapshot: an active entry without a tool or a start time is dropped, the rest kept', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const snap = parseSnapshot(snapshotText('grok', now - 1000, [activeCall(now - 2000), { id: 'x', tool: 'grok_research' }, { id: 'y', startedAt: new Date(now).toISOString() }, null, 'text']), now);
  assert.equal(snap.active.length, 1);
  assert.equal(snap.active[0].id, '4242-1');
});
