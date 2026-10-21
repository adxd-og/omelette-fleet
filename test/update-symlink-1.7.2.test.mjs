/**
 * omelette-fleet :: test/update-symlink-1.7.2.test.mjs
 * 1.7.2 T2: the update cache's write never follows a planted symlink. Driven
 * through `cachedCheck` with an injected fetch — nothing touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedCheck, CHECK_FILE } from '../core/update.mjs';

const symlinksWork = process.platform !== 'win32';

const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v9.9.9', html_url: 'https://example.test/rel' }) });

function victim(name, content) {
  const path = join(mkdtempSync(join(tmpdir(), 'omelette-victim-')), name);
  writeFileSync(path, content);
  return path;
}

test('writeCache: a symlink at the cache is replaced by a regular file; one at the old predictable tmp name is never followed', { skip: !symlinksWork && 'POSIX symlinks' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'omelette-upd-link-'));
  const cache = join(home, CHECK_FILE);
  const atTarget = victim('.zshrc', 'export PATH=/usr/bin:/bin\n');
  const atOldTmp = victim('tmp', 'tmp victim\n');
  symlinkSync(atTarget, cache);
  symlinkSync(atOldTmp, `${cache}.${process.pid}.tmp`); // the name 1.7.1 wrote through

  const r = await cachedCheck({ home, current: '0.1.0', fetchImpl, ttlMs: 0 });
  assert.equal(r.latest, '9.9.9');

  assert.equal(readFileSync(atTarget, 'utf8'), 'export PATH=/usr/bin:/bin\n');
  assert.equal(readFileSync(atOldTmp, 'utf8'), 'tmp victim\n');
  assert.ok(lstatSync(cache).isFile(), 'the rename replaced the link with our own file');
  assert.equal(JSON.parse(readFileSync(cache, 'utf8')).latest, '9.9.9');
});

test('readCache reads nothing through a link to a FIFO: cachedCheck resolves instead of waiting for a writer', { skip: !symlinksWork && 'POSIX symlinks and FIFOs' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'omelette-upd-fifo-'));
  const fifo = join(mkdtempSync(join(tmpdir(), 'omelette-fifo-')), 'pipe');
  execFileSync('mkfifo', [fifo]);
  symlinkSync(fifo, join(home, CHECK_FILE));
  const code = `import { cachedCheck } from ${JSON.stringify(new URL('../core/update.mjs', import.meta.url).href)};
const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v9.9.9' }) });
console.log(JSON.stringify(await cachedCheck({ home: ${JSON.stringify(home)}, current: '0.1.0', fetchImpl })));`;
  // A read through the link opens the FIFO and waits for a writer that never comes.
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 5000, encoding: 'utf8' });
  assert.equal(r.error, undefined, 'the check must not wait on the FIFO');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.latest, '9.9.9');
  assert.equal(out.cached, false, 'the link was treated as no cache');
});
