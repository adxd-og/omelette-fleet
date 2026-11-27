// Run only as a child of test/tmp-preload.test.mjs (`.fixture.mjs`: the suite's glob never picks it
// up). One test that makes a directory under tmpdir() with each mkdtemp form — sync, callback (with an
// options argument), promise — plus one it removes itself, one nested in a recorded one and one outside
// the temp directory; writes their paths as JSON to FIXTURE_OUT, then passes, fails or calls
// process.exit as FIXTURE_MODE says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdtemp, rmSync, existsSync, writeFileSync } from 'node:fs';
import { mkdtemp as mkdtempP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the three mkdtemp forms', async () => {
  const a = mkdtempSync(join(tmpdir(), 'a-'));
  const b = await new Promise((resolve, reject) => {
    mkdtemp(join(tmpdir(), 'b-'), { encoding: 'utf8' }, (e, p) => (e ? reject(e) : resolve(p)));
  });
  const c = await mkdtempP(join(tmpdir(), 'c-'));
  const removed = mkdtempSync(join(tmpdir(), 'removed-'));
  rmSync(removed, { recursive: true, force: true });
  const nested = mkdtempSync(join(a, 'in-'));
  const outside = mkdtempSync(join(process.env.FIXTURE_OUTSIDE, 'out-'));
  for (const p of [a, b, c, nested, outside]) assert.ok(existsSync(p), p);
  writeFileSync(process.env.FIXTURE_OUT, JSON.stringify({ a, b, c, nested, outside, removed }));
  const mode = process.env.FIXTURE_MODE;
  if (mode === 'fail') assert.fail('asked to fail');
  if (mode === 'exit') process.exit(3);
});
