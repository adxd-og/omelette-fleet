// test/tmp-preload.mjs — the module `npm test` loads into every test process (`--import`): what a
// process made with mkdtemp directly under the OS temp directory is gone once it exits, however it
// exits; what it made anywhere else stays. Each row runs the fixture in a `node --test` of its own,
// its TMPDIR a fresh directory under this file's base; the real temp directory is never read.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRELOAD = pathToFileURL(join(HERE, 'tmp-preload.mjs')).href;
const FIXTURE = join(HERE, 'fixtures', 'tmp-preload', 'forms.fixture.mjs');

const B = mkdtempSync(join(tmpdir(), 'tmp-preload-test-'));
after(() => rmSync(B, { recursive: true, force: true }));

// The fixture in a child `node --test` (NODE_TEST_CONTEXT dropped, or it would report to this one),
// with or without the preload, its TMPDIR on `t` or on a link to it.
const run = (mode, { preload = true, link = false } = {}) => {
  const row = mkdtempSync(join(B, 'row-'));
  const t = join(row, 'tmp');
  const o = join(row, 'outside');
  const out = join(row, 'out.json');
  mkdirSync(t);
  mkdirSync(o);
  let tmp = t;
  if (link) { tmp = join(row, 'link'); symlinkSync(t, tmp); }
  const env = { ...process.env, TMPDIR: tmp, FIXTURE_OUT: out, FIXTURE_OUTSIDE: o, FIXTURE_MODE: mode };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [...(preload ? ['--import', PRELOAD] : []), '--test', FIXTURE], { env, timeout: 30_000, encoding: 'utf8' });
  const output = `status ${r.status} signal ${r.signal}\n${r.stdout}\n${r.stderr}`;
  assert.ok(existsSync(out), `the fixture never wrote its paths:\n${output}`);
  return { status: r.status, t, made: JSON.parse(readFileSync(out, 'utf8')), output };
};
const exists = (made, keys) => Object.fromEntries(keys.map((k) => [k, existsSync(made[k])]));

test('pass: the three mkdtemp forms are gone after the process, the nested one with its parent, the one outside the temp directory stays', () => {
  const r = run('pass');
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(exists(r.made, ['a', 'b', 'c', 'nested', 'outside']), { a: false, b: false, c: false, nested: false, outside: true });
  assert.deepEqual(readdirSync(r.t), []);
});

test('fail: a failing test file still removes its directories', () => {
  const r = run('fail');
  assert.notEqual(r.status, 0, r.output);
  assert.deepEqual(exists(r.made, ['a', 'b', 'c']), { a: false, b: false, c: false });
});

test('exit: process.exit in a test still removes them', () => {
  const r = run('exit');
  assert.notEqual(r.status, 0, r.output);
  assert.deepEqual(exists(r.made, ['a', 'b', 'c']), { a: false, b: false, c: false });
});

test('TMPDIR through a link: the parent is compared resolved', () => {
  const r = run('pass', { link: true });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(exists(r.made, ['a', 'b', 'c']), { a: false, b: false, c: false });
});

test("a callback-less fs.mkdtemp throws node's own error at the call, as without the preload, and makes nothing", () => {
  const tmp = mkdtempSync(join(B, 'nocb-'));
  const SRC = [
    "import fs from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "for (const args of [[join(tmpdir(), 'm-')], [join(tmpdir(), 'm-'), {}], [join(tmpdir(), 'm-'), 'utf8']]) {",
    "  try { fs.mkdtemp(...args); console.log('no throw'); } catch (e) { console.log(e.code); }",
    '}',
  ].join('\n');
  const env = { ...process.env, TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', SRC], { env, timeout: 30_000, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.stdout, 'ERR_INVALID_ARG_TYPE\nERR_INVALID_ARG_TYPE\nERR_INVALID_ARG_TYPE\n');
  assert.equal(r.stderr, '');
  assert.deepEqual(readdirSync(tmp), []);
});

test('without the preload the same fixture leaves a, b and c', () => {
  const r = run('pass', { preload: false });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(exists(r.made, ['a', 'b', 'c']), { a: true, b: true, c: true });
});
