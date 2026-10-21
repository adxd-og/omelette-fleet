/**
 * omelette-fleet :: test/update-symlink-1.7.2.test.mjs
 * 1.7.2 T2: the update cache's write never follows a planted symlink. Driven
 * through `cachedCheck` with an injected fetch — nothing touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
