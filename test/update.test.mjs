/**
 * omelette-fleet :: test/update.test.mjs
 * The update check, driven entirely through an injected `fetchImpl` — NOTHING
 * HERE TOUCHES THE NETWORK. Every case that matters is a failure case: a
 * refusing GitHub, a hanging one, a cache that must not be overwritten, and the
 * startup hook that must stay silent when it is switched off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RELEASES_URL, announceUpdate, cachedCheck, checkLatest, compareSemver, currentVersion,
  detectInstall, packageRoot, updateCheckEnabled,
} from '../core/update.mjs';

const home = (config) => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-upd-'));
  if (config !== undefined) writeFileSync(join(dir, 'fleet.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
};

/** A fetch that answers one release payload and records how it was called. */
function fakeFetch(body = { tag_name: 'v9.9.9', html_url: 'https://example.test/rel' }, { ok = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, statusText: 'Test', json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

const cacheFile = (dir) => join(dir, 'update-check.json');

test('compareSemver orders x.y.z, ignores a leading v and reads garbage as 0', () => {
  assert.equal(compareSemver('0.1.0', '0.2.0'), -1);
  assert.equal(compareSemver('0.2.0', '0.1.0'), 1);
  assert.equal(compareSemver('1.2.3', 'v1.2.3'), 0);
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1); // numeric, not lexicographic
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemver('0.1', '0.1.0'), 0); // a missing part is 0
  assert.equal(compareSemver('1.2.3-rc1', '1.2.3'), -1); // a non-numeric part is 0 — a prerelease is never "newer"
  assert.equal(compareSemver('1.2.3', '1.2.3-rc1'), 1);
  assert.equal(compareSemver('', 'nonsense'), 0);
  assert.equal(compareSemver(undefined, '0.0.1'), -1);
});

test('checkLatest asks GitHub once, with the API headers, and reports behind/not-behind', async () => {
  const f = fakeFetch();
  const r = await checkLatest({ current: '0.1.0', fetchImpl: f });
  assert.deepEqual(r, { current: '0.1.0', latest: '9.9.9', behind: true, url: 'https://example.test/rel' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, RELEASES_URL);
  assert.equal(f.calls[0].init.headers.Accept, 'application/vnd.github+json');
  assert.equal(f.calls[0].init.headers['User-Agent'], 'omelette-fleet/0.1.0');
  assert.ok(f.calls[0].init.signal, 'an AbortController signal must be passed');

  const same = await checkLatest({ current: '9.9.9', fetchImpl: fakeFetch() });
  assert.equal(same.behind, false);
  const ahead = await checkLatest({ current: '10.0.0', fetchImpl: fakeFetch() });
  assert.equal(ahead.behind, false);
});

test('checkLatest throws on a refused request, a non-2xx answer and an unusable tag', async () => {
  await assert.rejects(
    checkLatest({ current: '0.1.0', fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }),
    /ENOTFOUND/,
  );
  await assert.rejects(
    checkLatest({ current: '0.1.0', fetchImpl: fakeFetch({}, { ok: false, status: 403 }) }),
    /GitHub answered 403/,
  );
  await assert.rejects(
    checkLatest({ current: '0.1.0', fetchImpl: fakeFetch({ tag_name: 'nightly' }) }),
    /unusable release tag/,
  );
  await assert.rejects(
    checkLatest({ current: '0.1.0', fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) }),
    /not json/,
  );
});

test('checkLatest gives up on a request that hangs past the timeout', async () => {
  // The deadline timer is unref'd on purpose (an update check must never hold a
  // process open), so this test has to hold the loop open itself.
  const keepAlive = setInterval(() => {}, 20);
  const t0 = Date.now();
  try {
    await assert.rejects(
      checkLatest({ current: '0.1.0', timeoutMs: 60, fetchImpl: () => new Promise(() => {}) }),
      /timed out after 60ms/,
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(Date.now() - t0 < 3000, 'must not wait for the default deadline');
});

test('cachedCheck: a fresh cache answers without any fetch at all', async () => {
  const dir = home();
  writeFileSync(cacheFile(dir), JSON.stringify({ checkedAt: 1000, latest: '5.0.0', url: 'https://example.test/cached' }));
  const f = fakeFetch();
  const r = await cachedCheck({ home: dir, current: '0.1.0', fetchImpl: f, now: 1000 + 60_000 });
  assert.equal(f.calls.length, 0);
  assert.equal(r.latest, '5.0.0');
  assert.equal(r.behind, true);
  assert.equal(r.cached, true);
  assert.equal(r.url, 'https://example.test/cached');
});

test('cachedCheck: a stale cache (and ttlMs 0) fetches and rewrites the cache atomically at 0600', async () => {
  const dir = home();
  writeFileSync(cacheFile(dir), JSON.stringify({ checkedAt: 0, latest: '0.0.1', url: 'https://example.test/old' }));
  const f = fakeFetch();
  const day = 24 * 60 * 60 * 1000;
  const r = await cachedCheck({ home: dir, current: '0.1.0', fetchImpl: f, now: () => day + 1 });
  assert.equal(f.calls.length, 1);
  assert.equal(r.latest, '9.9.9');
  assert.equal(r.cached, false);
  const written = JSON.parse(readFileSync(cacheFile(dir), 'utf8'));
  assert.deepEqual(written, { checkedAt: day + 1, latest: '9.9.9', url: 'https://example.test/rel' });
  assert.equal(statSync(cacheFile(dir)).mode & 0o777, 0o600);

  // ttlMs 0 is how `omelette-fleet update` forces a live answer.
  const forced = fakeFetch({ tag_name: 'v9.9.10' });
  const fresh = await cachedCheck({ home: dir, current: '0.1.0', fetchImpl: forced, ttlMs: 0, now: day + 2 });
  assert.equal(forced.calls.length, 1);
  assert.equal(fresh.latest, '9.9.10');
});

test('cachedCheck: no cache and no home directory yet — it creates one and still answers', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'omelette-upd-')), 'nested', 'home');
  const r = await cachedCheck({ home: dir, current: '0.1.0', fetchImpl: fakeFetch() });
  assert.equal(r.latest, '9.9.9');
  assert.equal(JSON.parse(readFileSync(cacheFile(dir), 'utf8')).latest, '9.9.9');
});

test('cachedCheck: a failed fetch never throws and never destroys the previous answer', async () => {
  const dir = home();
  const good = JSON.stringify({ checkedAt: 0, latest: '3.0.0', url: 'https://example.test/keep' });
  writeFileSync(cacheFile(dir), good);
  const r = await cachedCheck({ home: dir, current: '0.1.0', ttlMs: 0, fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(r, { current: '0.1.0', latest: null, behind: false, error: 'offline' });
  assert.equal(readFileSync(cacheFile(dir), 'utf8'), good); // byte-identical
  // …and a garbage cache is simply "no cache", never a crash.
  writeFileSync(cacheFile(dir), '{ not json');
  const g = await cachedCheck({ home: dir, current: '0.1.0', fetchImpl: fakeFetch() });
  assert.equal(g.latest, '9.9.9');
});

test('cachedCheck: a cache stamped in the future is stale, not eternal', async () => {
  const dir = home();
  writeFileSync(cacheFile(dir), JSON.stringify({ checkedAt: 9_000_000, latest: '4.0.0' }));
  const f = fakeFetch();
  const r = await cachedCheck({ home: dir, current: '0.1.0', fetchImpl: f, now: 1_000 });
  assert.equal(f.calls.length, 1);
  assert.equal(r.latest, '9.9.9');
});

test('updateCheckEnabled: the env switch wins over the config, which wins over the default', () => {
  const on = home();
  assert.equal(updateCheckEnabled({ env: { OMELETTE_HOME: on } }), true); // no file → default true
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' no ']) {
    assert.equal(updateCheckEnabled({ env: { OMELETTE_HOME: on, OMELETTE_UPDATE_CHECK: off } }), false, off);
  }
  for (const yes of ['1', 'true', 'on', '', 'yes']) {
    assert.equal(updateCheckEnabled({ env: { OMELETTE_HOME: on, OMELETTE_UPDATE_CHECK: yes } }), true, yes);
  }
  const off = home({ version: 1, updateCheck: false, units: {} });
  assert.equal(updateCheckEnabled({ env: { OMELETTE_HOME: off } }), false);
  // The env switch only ever says NO: an affirmative value leaves the file's
  // answer standing, so "1" cannot re-open a fleet that opted out in config.
  assert.equal(updateCheckEnabled({ env: { OMELETTE_HOME: off, OMELETTE_UPDATE_CHECK: '1' } }), false);
  assert.equal(updateCheckEnabled({ config: { updateCheck: false }, env: {} }), false);
  assert.equal(updateCheckEnabled({ config: { updateCheck: true }, env: { OMELETTE_UPDATE_CHECK: '0' } }), false);
});

test('detectInstall: a .git directory means git, anything else means npm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-root-'));
  assert.equal(detectInstall(dir), 'npm');
  mkdirSync(join(dir, '.git'));
  assert.equal(detectInstall(dir), 'git');
  // this checkout is itself a git clone, and its package.json is readable
  assert.equal(detectInstall(), 'git');
  assert.match(currentVersion(), /^\d+\.\d+\.\d+/);
  assert.equal(currentVersion(join(dir, 'nowhere')), '0.0.0');
  assert.equal(packageRoot({ OMELETTE_PKG_ROOT: dir }), dir);
  assert.ok(packageRoot({}).length > 1);
});

// ─── the startup hook (core/unit.mjs calls exactly this) ─────────────────────

const collect = () => { const lines = []; const log = (m) => lines.push(m); log.lines = lines; return log; };

test('announceUpdate logs ONE line when a newer release exists', async () => {
  const dir = home();
  const log = collect();
  const r = await announceUpdate({ home: dir, current: '0.1.0', env: { OMELETTE_HOME: dir }, log, fetchImpl: fakeFetch() });
  assert.equal(r.behind, true);
  assert.deepEqual(log.lines, ['update: omelette-fleet 9.9.9 is available (you run 0.1.0) — run `omelette-fleet update`']);
});

test('announceUpdate stays silent when the fleet is current, and when the check fails', async () => {
  const dir = home();
  const same = collect();
  await announceUpdate({ home: dir, current: '9.9.9', env: { OMELETTE_HOME: dir }, log: same, fetchImpl: fakeFetch() });
  assert.deepEqual(same.lines, []);

  const broken = collect();
  const r = await announceUpdate({
    home: home(), current: '0.1.0', env: {}, log: broken, fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.deepEqual(broken.lines, []);
  assert.equal(r.latest, null); // resolved, never rejected — startUnit attaches .then only
});

test('announceUpdate is skipped ENTIRELY when the check is switched off', async () => {
  const dir = home();
  const f = fakeFetch();
  const log = collect();
  const r = await announceUpdate({ home: dir, current: '0.1.0', env: { OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' }, log, fetchImpl: f });
  assert.equal(r, null);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(log.lines, []);

  const byConfig = home({ updateCheck: false });
  const f2 = fakeFetch();
  await announceUpdate({ home: byConfig, current: '0.1.0', env: { OMELETTE_HOME: byConfig }, log, fetchImpl: f2 });
  assert.equal(f2.calls.length, 0);
  assert.deepEqual(log.lines, []);
});
