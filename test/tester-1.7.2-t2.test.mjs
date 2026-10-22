/**
 * 1.7.2 T2, tester probes: what the implementer's tests leave unpinned —
 * tmp cleanup after a failed rename, the trim path, FIFO / non-regular log,
 * modes of everything written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStatus } from '../core/status.mjs';
import { cachedCheck, CHECK_FILE } from '../core/update.mjs';

const posix = process.platform !== 'win32';
const skip = !posix && 'POSIX only';

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t2-'));
  const st = createStatus({ unit: 'tu', spawnTools: new Set(['t']), resolve: () => ({ dir, enabled: true }) });
  return { st, dir, snapshot: join(dir, `status-tu-${process.pid}.json`), log: join(dir, 'fleet-log.ndjson') };
}
const tmps = (dir) => readdirSync(dir).filter((n) => n.endsWith('.tmp'));
const bigLog = () => Array.from({ length: 6000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(100) })).join('\n') + '\n';

test('a rename that fails after the exclusive open leaves no snapshot tmp behind', { skip }, () => {
  const { st, dir, snapshot } = make();
  mkdirSync(snapshot); // a directory at the target: renameSync(tmp, dir) fails
  st.boot();
  assert.deepEqual(tmps(dir), []);
  assert.ok(lstatSync(snapshot).isDirectory());
});

test('the update cache: a failed rename returns without a tmp, a good write is 0600', { skip }, async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v9.9.9', html_url: 'https://example.test/r' }) });
  const bad = mkdtempSync(join(tmpdir(), 'omelette-t2-upd-'));
  mkdirSync(join(bad, CHECK_FILE));
  const r = await cachedCheck({ home: bad, current: '0.1.0', fetchImpl, ttlMs: 0 });
  assert.equal(r.latest, '9.9.9', 'an unwritable cache is a slower check, not a failure');
  assert.deepEqual(tmps(bad), []);

  const good = mkdtempSync(join(tmpdir(), 'omelette-t2-upd-'));
  await cachedCheck({ home: good, current: '0.1.0', fetchImpl, ttlMs: 0 });
  assert.equal(statSync(join(good, CHECK_FILE)).mode & 0o777, 0o600);
  assert.deepEqual(tmps(good), []);
});

test('trim: an oversized log is cut to its last 1000 lines, 0600, no tmp, and a link at the old tmp name is not followed', { skip }, () => {
  const { st, dir, log } = make();
  writeFileSync(log, bigLog());
  chmodSync(log, 0o644);
  const victim = join(mkdtempSync(join(tmpdir(), 'omelette-t2-v-')), 'v');
  writeFileSync(victim, 'victim\n');
  symlinkSync(victim, `${log}.${process.pid}.tmp`);
  st.boot();
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1000);
  assert.equal(JSON.parse(lines.at(-1)).i, 5999);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(readFileSync(victim, 'utf8'), 'victim\n');
  assert.deepEqual(tmps(dir).filter((n) => !lstatSync(join(dir, n)).isSymbolicLink()), []);
});

test('existing log modes wider than 0600 are narrowed, whichever bits are wide', { skip }, () => {
  for (const mode of [0o666, 0o640, 0o620, 0o604, 0o700]) {
    const { st, log } = make();
    writeFileSync(log, '');
    chmodSync(log, mode);
    st.end(st.start('t', 'x'), 'ok');
    assert.equal(statSync(log).mode & 0o777, 0o600, `from ${mode.toString(8)}`);
  }
});

function mkfifo(path) { execFileSync('mkfifo', [path]); }

test('a FIFO at the log path does not block the tool call (no reader)', { skip }, () => {
  const { dir, log } = make();
  mkfifo(log);
  const code = `import { createStatus } from ${JSON.stringify(new URL('../core/status.mjs', import.meta.url).href)};
const st = createStatus({ unit: 'tu', spawnTools: new Set(['t']), resolve: () => ({ dir: ${JSON.stringify(dir)}, enabled: true }) });
st.boot(); const t = st.start('t', 'x'); st.end(t, 'ok'); console.log('done');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 8000, encoding: 'utf8' });
  assert.equal(r.error, undefined, 'the process must not hang on the FIFO');
  assert.match(r.stdout, /done/);
});

test('a FIFO with a reader attached receives nothing: a non-regular file is skipped', { skip }, () => {
  const { st, log } = make();
  mkfifo(log);
  const rd = openSync(log, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    st.end(st.start('t', 'x'), 'ok');
    const buf = Buffer.alloc(4096);
    let n = 0;
    try { n = readSync(rd, buf, 0, 4096, null); } catch (e) { assert.equal(e.code, 'EAGAIN'); }
    assert.equal(n, 0, 'nothing was written to the FIFO');
  } finally { closeSync(rd); }
});
