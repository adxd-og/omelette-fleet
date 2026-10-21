/**
 * omelette-fleet :: test/status-symlink-1.7.2.test.mjs
 * 1.7.2 T2: the status feed's writes never follow a planted symlink. The
 * scenario: fleet-log.ndjson replaced by a link to ~/.zshrc, and a prompt
 * holding `$(cmd)` appended there runs at the next shell start.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createStatus } from '../core/status.mjs';

const symlinksWork = process.platform !== 'win32';

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-status-link-'));
  const st = createStatus({ unit: 'testunit', spawnTools: new Set(['t_research']), resolve: () => ({ dir, enabled: true }) });
  return { st, snapshot: join(dir, `status-testunit-${process.pid}.json`), log: join(dir, 'fleet-log.ndjson') };
}

/** A file outside the fleet home with known content — what a planted link points at. */
function victim(name, content) {
  const path = join(mkdtempSync(join(tmpdir(), 'omelette-victim-')), name);
  writeFileSync(path, content);
  return path;
}

test('a symlink at the fleet log is never followed: the victim stays byte-identical and the line is dropped', { skip: !symlinksWork && 'POSIX symlinks' }, () => {
  const { st, log } = make();
  const rc = victim('.zshrc', 'export PATH=/usr/bin:/bin\n');
  const before = readFileSync(rc);
  symlinkSync(rc, log);

  const tok = st.start('t_research', 'echo $(touch /tmp/omelette-pwned)');
  assert.ok(tok, 'the tool call is never told about the feed');
  st.end(tok, 'ok');

  assert.deepEqual(readFileSync(rc), before);
  assert.ok(lstatSync(log).isSymbolicLink(), 'the planted link is left in place: the line is skipped, not written through it');
  assert.equal(readlinkSync(log), rc);
});

test('a symlink at the snapshot is replaced by a regular file; one at the old predictable tmp name is never followed', { skip: !symlinksWork && 'POSIX symlinks' }, () => {
  const { st, snapshot } = make();
  const atTarget = victim('target', 'target victim\n');
  const atOldTmp = victim('tmp', 'tmp victim\n');
  symlinkSync(atTarget, snapshot);
  symlinkSync(atOldTmp, `${snapshot}.${process.pid}.tmp`); // the name 1.7.1 wrote through

  st.boot();

  assert.equal(readFileSync(atTarget, 'utf8'), 'target victim\n');
  assert.equal(readFileSync(atOldTmp, 'utf8'), 'tmp victim\n');
  assert.ok(lstatSync(snapshot).isFile(), 'the rename replaced the link with our own file');
  assert.equal(JSON.parse(readFileSync(snapshot, 'utf8')).unit, 'testunit');
});

test('an existing 0644 log is narrowed to 0600 by the first append, and the line still lands', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const { st, log } = make();
  writeFileSync(log, '');
  chmodSync(log, 0o644);

  const tok = st.start('t_research', 'x');
  assert.equal(statSync(log).mode & 0o777, 0o600);
  st.end(tok, 'ok');
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).event), ['start', 'end']);
});

test('the boot trim leaves a symlinked log alone: nothing is read through it, the link stays, no regular log appears', { skip: !symlinksWork && 'POSIX symlinks' }, () => {
  const { st, log } = make();
  const big = victim('big', `${'x'.repeat(99)}\n`.repeat(6000)); // 600 000 bytes, past the 500 KB trim threshold
  const before = readFileSync(big);
  symlinkSync(big, log);

  st.boot();

  assert.ok(lstatSync(log).isSymbolicLink(), 'the link is left exactly as it was');
  assert.equal(readlinkSync(log), big);
  assert.deepEqual(readFileSync(big), before);
  const regular = readdirSync(dirname(log))
    .filter((n) => n.startsWith('fleet-log.ndjson'))
    .filter((n) => lstatSync(join(dirname(log), n)).isFile());
  assert.deepEqual(regular, [], "no copy of the target's tail beside the link");
});
