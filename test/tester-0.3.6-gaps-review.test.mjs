/**
 * omelette-fleet :: test/tester-0.3.6-gaps-review.test.mjs
 *
 * Independent coverage for the uncommitted 0.3.6 diff on top of `main`
 * (spec: docs/superpowers/specs/2026-09-10-0.3.6-design.md).
 *
 * The diff's own tests already exercise, at length: `cwd` on the three
 * research tools end-to-end (validation wording, spooled `cwd:` header,
 * omitted-cwd default) per unit; `resolveBin`'s once-at-start resolution
 * (test/bin-resolution.test.mjs, test/tester-0.3.5-p3-review.test.mjs); the
 * Codex output cap constant and its use in `unit.builtin`; the probe's
 * settle-then-read race in both directions (write lands before the settle
 * bound → BREACHED, write never lands because the kill was clean → skipped);
 * `interpretGrok`'s cancel-with-reported-error tail, on both the throw branch
 * and the salvaged-text branch; and the image tools' bare-path contract for
 * capped/killed/cancelled/non-zero-exit runs with and without a saved file,
 * per unit.
 *
 * What was NOT exercised by that diff, and is covered here instead:
 *
 * 1. `core/cwd.mjs`'s `checkCwd()` as a PURE FUNCTION. Every existing test
 *    reaches it only through an adapter's research or review tool, so a
 *    regression in the shared module itself (introduced in 0.3.6 by lifting
 *    three identical copies into one) would show up three times identically
 *    rather than being pinned once. Also covers two inputs no adapter test
 *    sends: a non-string `cwd` (a malformed MCP client could send one; the
 *    schema says `string` but nothing enforces it before this function does),
 *    and whitespace around an otherwise-valid absolute path.
 * 2. `core/artifact.mjs`'s `newestImage()` as a pure function — new in 0.3.6,
 *    and reached in the test suite only through `gemini_image` runtime tests
 *    that always ask it for exactly the one file the fake CLI wrote. Nothing
 *    exercises its own filtering (extension, `isFile`, `since`) or its
 *    tie-break (newest `mtimeMs` wins among several candidates) directly.
 * 3. `core/artifact.mjs`'s `unfinishedRun()` as a pure function — also new,
 *    and only ever seen through a real spawn result in the adapter tests.
 *    Pins its literal truth table, including the `code: null` case a
 *    signal-terminated process reports and the `code: undefined` case a
 *    synthetic result (one that never went through core/spawn.mjs) reports.
 * 4. `show codex` reporting the new 4 000 000 default on the CLI's own render
 *    path — the spec says it explicitly ("`show codex` reports the new
 *    number as a `default`"), and the diff's test only pins the constant and
 *    `unit.builtin.outputCap` at the unit level, never the `show` output a
 *    human actually reads.
 *
 * No real vendor binary; no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCwd } from '../core/cwd.mjs';
import { newestImage, unfinishedRun } from '../core/artifact.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

// --- core/cwd.mjs :: checkCwd ------------------------------------------------

test('checkCwd: omitted means "run where the server already does" — not an error', () => {
  assert.deepEqual(checkCwd(undefined), { cwd: '' });
});

test('checkCwd: a non-string value is refused with the same wording as any other bad input', () => {
  const num = checkCwd(123);
  assert.equal(num.cwd, undefined);
  assert.equal(num.error, 'Error: "cwd" must be an absolute path (got 123).');
  const obj = checkCwd({ not: 'a string' });
  assert.equal(obj.cwd, undefined);
  assert.match(obj.error, /"cwd" must be an absolute path/);
  const arr = checkCwd(['/abs']);
  assert.match(arr.error, /"cwd" must be an absolute path/);
});

test('checkCwd: a relative path is refused before any spawn, wording pinned exactly', () => {
  const r = checkCwd('relative/path');
  assert.equal(r.cwd, undefined);
  assert.equal(r.error, 'Error: "cwd" must be an absolute path (got "relative/path").');
});

test('checkCwd: an empty or all-whitespace string is refused as "must be an absolute path", not as missing', () => {
  const empty = checkCwd('');
  assert.equal(empty.error, 'Error: "cwd" must be an absolute path (got "").');
  const blank = checkCwd('   ');
  assert.equal(blank.error, 'Error: "cwd" must be an absolute path (got "   ").');
});

test('checkCwd: surrounding whitespace on an otherwise-valid path is trimmed before the absolute check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-checkcwd-'));
  assert.deepEqual(checkCwd(`  ${dir}  `), { cwd: dir });
});

test('checkCwd: an existing FILE (not a directory) is refused with the "not an existing directory" wording', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-checkcwd-file-'));
  const file = join(dir, 'not-a-dir.txt');
  writeFileSync(file, 'x');
  const r = checkCwd(file);
  assert.equal(r.cwd, undefined);
  assert.equal(r.error, `Error: "cwd" is not an existing directory: ${file}`);
});

test('checkCwd: a path that does not exist at all gets the same wording as an existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-checkcwd-missing-'));
  const gone = join(dir, 'no-such-subdir');
  const r = checkCwd(gone);
  assert.equal(r.error, `Error: "cwd" is not an existing directory: ${gone}`);
});

test('checkCwd: an absolute existing directory is accepted, trimmed path returned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-checkcwd-ok-'));
  assert.deepEqual(checkCwd(dir), { cwd: dir });
});

// --- core/artifact.mjs :: newestImage ---------------------------------------

test('newestImage: a missing or unreadable directory returns "" rather than throwing', () => {
  assert.equal(newestImage(join(tmpdir(), 'omelette-newestimage-does-not-exist')), '');
});

test('newestImage: only image-extension FILES count — not a directory of the same name, not a non-image file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-newestimage-filter-'));
  writeFileSync(join(dir, 'notes.txt'), 'x');
  mkdirSync(join(dir, 'looks-like-an-image.png')); // a directory, not a file
  const only = join(dir, 'the-one.jpeg');
  writeFileSync(only, 'JPEG');
  assert.equal(newestImage(dir), only);
});

test('newestImage: every extension the fleet\'s image tools produce, case-insensitively', () => {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'PNG', 'JPG']) {
    const dir = mkdtempSync(join(tmpdir(), 'omelette-newestimage-ext-'));
    const p = join(dir, `art.${ext}`);
    writeFileSync(p, 'IMG');
    assert.equal(newestImage(dir), p, `extension .${ext} was not recognized`);
  }
});

test('newestImage: among several candidates, the NEWEST by mtime wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-newestimage-tiebreak-'));
  const older = join(dir, 'older.png');
  const newer = join(dir, 'newer.png');
  writeFileSync(older, 'a');
  writeFileSync(newer, 'b');
  utimesSync(older, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  utimesSync(newer, new Date(Date.now() - 1000), new Date(Date.now() - 1000));
  assert.equal(newestImage(dir), newer);
  // Reversing which file is actually newer flips the answer — this is a real
  // mtime comparison, not "last one readdirSync happened to list".
  utimesSync(older, new Date(), new Date());
  assert.equal(newestImage(dir), older);
});

test('newestImage: `since` excludes a file that predates the run; 0 (the default) keeps every existing file eligible', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-newestimage-since-'));
  const old = join(dir, 'pre-existing.gif');
  writeFileSync(old, 'GIF');
  utimesSync(old, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const since = Date.now();
  assert.equal(newestImage(dir, since), '', 'a file older than the run was not excluded');
  assert.equal(newestImage(dir), old, 'default since=0 must not exclude a pre-existing file');
  const fresh = join(dir, 'fresh.webp');
  writeFileSync(fresh, 'WEBP');
  assert.equal(newestImage(dir, since), fresh);
});

// --- core/artifact.mjs :: unfinishedRun -------------------------------------

test('unfinishedRun: a clean run (code 0, no flags) is NOT unfinished; garbage input is not unfinished either', () => {
  assert.equal(unfinishedRun({ code: 0 }), false);
  assert.equal(unfinishedRun({}), false);
  assert.equal(unfinishedRun(null), false);
  assert.equal(unfinishedRun(undefined), false);
  assert.equal(unfinishedRun('not an object'), false);
  assert.equal(unfinishedRun(42), false);
});

test('unfinishedRun: killed, cancelled or capped alone is enough, whatever the exit code says', () => {
  assert.equal(unfinishedRun({ killed: true, code: 0 }), true);
  assert.equal(unfinishedRun({ cancelled: true, code: 0 }), true);
  assert.equal(unfinishedRun({ capped: true, code: 0 }), true);
});

test('unfinishedRun: a non-zero exit code alone is unfinished, with none of the other flags set', () => {
  assert.equal(unfinishedRun({ code: 1 }), true);
  assert.equal(unfinishedRun({ code: -1 }), true);
});

test('unfinishedRun: a real spawn result signal-killed with code:null (no explicit flag) reads as unfinished', () => {
  // core/spawn.mjs's own shape for a signal-terminated child: `code` is
  // present (not undefined) and not 0, so this is the general "any exit that
  // is not a clean 0" rule catching a case none of the three named flags do.
  assert.equal(unfinishedRun({ code: null, signal: 'SIGKILL' }), true);
});

// --- CLI :: show codex reports the new outputCap default --------------------

function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-0.3.6-gaps-'));
}

function cli(args, { dir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('show codex: outputCap reports the 0.3.6 default, 4000000, not the fleet-wide 400000', () => {
  const dir = home();
  const r = cli(['show', 'codex'], { dir });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /outputCap\s+4000000\s+default/, r.out);
  assert.doesNotMatch(r.out, /outputCap\s+400000\s+default/, r.out);
});

test('show grok / gemini: outputCap defaults are unchanged by the codex bump', () => {
  const dir = home();
  assert.match(cli(['show', 'grok'], { dir }).out, /outputCap\s+10000000\s+default/);
  assert.match(cli(['show', 'gemini'], { dir }).out, /outputCap\s+400000\s+default/);
});
