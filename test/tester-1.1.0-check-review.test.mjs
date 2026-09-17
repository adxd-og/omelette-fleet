/**
 * omelette-fleet :: test/tester-1.1.0-check-review.test.mjs
 * Clean-context review of `omelette-fleet check` / core/check.mjs against
 * docs/superpowers/specs/2026-09-17-1.1.0-design.md §1, §4 and §5 — edges the
 * implementer's own test/check.test.mjs, test/evidence-pointers.test.mjs and
 * test/docs-map.test.mjs leave uncovered or only weakly covered:
 *   - §1 pointer paths with `./`, `sub/../`, a trailing slash, a Windows-style
 *     backslash separator (both inside root and as an escape attempt).
 *   - §4 CRLF line endings, both in the checked report and in a target file.
 *   - §4 a root that is itself a symlink.
 *   - §4 the checked-file size boundary from the accepted side (exactly 1 MiB).
 *   - §4 two `commit:` lines (the first decides, valid or not) and an
 *     uppercase hex hash.
 *   - §4 a thorough, recursive "writes nothing" check across several flag
 *     combinations, including a symlink in the tree.
 *   - §5 the README CLI row, the SECURITY sentence and the agents' unchanged
 *     short-reply fields — none of which any existing test reads.
 *
 * Everything runs on temp directories under os.tmpdir(), removed in after().
 * No test spawns a vendor binary; the CLI runs with its own throwaway
 * OMELETTE_HOME. The staleness tests build their own git repository and skip,
 * loudly, where git is not on PATH.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedSince, checkPointers, parseCommit } from '../core/check.mjs';
import { renderAgentFile } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

const dirs = [];
function tmp(prefix = 'omelette-check-review-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A project fixture: { 'rel/path': contents } under a fresh temp root. */
function project(files) {
  const root = tmp();
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

/** The CLI, with a throwaway home so nothing reaches the operator's fleet. */
function cli(args, { cwd, env = {} } = {}) {
  const home = tmp('omelette-check-review-home-');
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: home, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', home };
}

const summary = (n, { ok = 0, moved = 0, mismatch = 0, missing = 0, outside = 0, stale = 0, tooLarge = 0 } = {}) =>
  `check: ${n} pointers · ${ok} ok · ${moved} moved · ${mismatch} mismatch · ${missing} missing · ${outside} outside · ${stale} stale`
  + (tooLarge ? ` · ${tooLarge} too-large` : '');

const GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const GIT_SKIP = GIT ? false : 'git is not on PATH — the staleness tests need a real repository';
const GIT_ID = ['-c', 'user.name=omelette test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];

/** A one-commit repository: `first` is its hash, a.txt reads "hello world". */
function gitRepo() {
  const root = tmp('omelette-check-review-git-');
  const run = (args) => {
    const r = spawnSync('git', [...GIT_ID, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return (r.stdout || '').trim();
  };
  run(['init', '-q']);
  writeFileSync(join(root, 'a.txt'), 'hello world\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'first']);
  return { root, first: run(['rev-parse', 'HEAD']) };
}

// ─── §1 pointer path shapes ─────────────────────────────────────────────────

test('pointer paths: leading ./, a sub/../ that never leaves root, and a trailing slash all resolve to the same file', () => {
  const root = project({ 'c.txt': 'value one\n', 'sub/inner.txt': 'value two\n' });
  const text = [
    './c.txt:1 · `value one` · c',
    'sub/../c.txt:1 · `value one` · c',
    'c.txt/:1 · `value one` · c',
  ].join('\n');
  const { pointers } = checkPointers({ text, root, changed: null });
  assert.deepEqual(pointers.map((p) => p.status), ['ok', 'ok', 'ok']);
});

test('pointer paths: a Windows-style backslash separator resolves inside root, and a backslash .. still escapes', () => {
  const root = project({ 'sub/inner.txt': 'value two\n' });
  const inside = checkPointers({ text: 'sub\\inner.txt:1 · `value two` · c', root, changed: null }).pointers[0];
  assert.equal(inside.status, 'ok', 'backslash is treated as a separator, not literal path data');

  const base = tmp();
  const escRoot = join(base, 'proj');
  mkdirSync(escRoot, { recursive: true });
  writeFileSync(join(base, 'outside.txt'), 'the secret line\n');
  const escape = checkPointers({ text: '..\\outside.txt:1 · `the secret line` · c', root: escRoot, changed: null }).pointers[0];
  assert.equal(escape.status, 'outside', 'a backslash .. is caught exactly like a forward-slash one');
});

// ─── §4 CRLF ─────────────────────────────────────────────────────────────────

test('ok/moved: CRLF line endings in the TARGET file do not shift line numbers or break matching', () => {
  const root = project({});
  writeFileSync(join(root, 'a.txt'), 'first line here\r\nthe second line\r\nthird line here\r\n');
  const ok = checkPointers({ text: 'a.txt:2 · `the second line` · c', root, changed: null }).pointers[0];
  assert.equal(ok.status, 'ok');
  const moved = checkPointers({ text: 'a.txt:1 · `third line here` · c', root, changed: null }).pointers[0];
  assert.deepEqual([moved.status, moved.foundAt], ['moved', 3]);
});

test('check: CRLF line endings in the CHECKED report parse cleanly, and no stray \\r reaches the output', () => {
  const root = project({ 'a.txt': 'first line here\nthe second line\n' });
  writeFileSync(join(root, 'report.md'), 'a.txt:2 · `the second line` · ok\r\na.txt:1 · `nowhere at all here` · mismatch\r\n');
  const r = cli(['check', 'report.md'], { cwd: root });
  assert.equal(r.code, 1);
  assert.equal(
    r.out,
    `mismatch  a.txt:1  nowhere at all here\n${summary(2, { ok: 1, mismatch: 1 })}\n`,
    'no \\r before either newline, and the claim survives the carriage return',
  );
});

// ─── §4 a root that is itself a symlink ─────────────────────────────────────

test('checkPointers: a root that is itself a symlink resolves pointers as if it were the real directory', () => {
  const real = project({ 'c.txt': 'the kept line here\n' });
  const rootLink = join(tmp(), 'root-link');
  symlinkSync(real, rootLink);
  const p = checkPointers({ text: 'c.txt:1 · `the kept line here` · c', root: rootLink, changed: null }).pointers[0];
  assert.equal(p.status, 'ok');
});

test('check: --root pointing at a symlinked directory works end to end', () => {
  const real = project({ 'c.txt': 'the kept line here\n' });
  const rootLink = join(tmp(), 'root-link');
  symlinkSync(real, rootLink);
  const elsewhere = project({ 'report.md': 'c.txt:1 · `the kept line here` · c\n' });
  const r = cli(['check', join(elsewhere, 'report.md'), '--root', rootLink], { cwd: elsewhere });
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.equal(r.out, `${summary(1, { ok: 1 })}\n`);
});

// ─── §4 the checked-file bound, from the accepted side ──────────────────────

test('check: a checked file of exactly 1 MiB is accepted — only one byte over is a usage error', () => {
  const CHECK_FILE_MAX = 1024 * 1024;
  const root = project({ 'a.txt': 'first line here\n' });
  const pointerLine = 'a.txt:1 · `first line here` · exactly the boundary\n';
  const padLen = CHECK_FILE_MAX - Buffer.byteLength(pointerLine, 'utf8') - 1; // -1 for the padding line's own \n
  assert.ok(padLen > 0, 'fixture sanity: room to pad');
  const content = pointerLine + 'x'.repeat(padLen) + '\n';
  assert.equal(Buffer.byteLength(content, 'utf8'), CHECK_FILE_MAX, 'fixture sanity: exactly the boundary');
  writeFileSync(join(root, 'exact.md'), content);
  const r = cli(['check', 'exact.md'], { cwd: root });
  assert.equal(r.code, 0, `exactly 1 MiB must be accepted, got ${r.code}: ${r.err}`);
  assert.equal(r.out, `${summary(1, { ok: 1 })}\n`);
});

// ─── §4 two commit: lines, and an uppercase hash ────────────────────────────

test('parseCommit: two commit lines — the first decides, whether or not it is a real commit', () => {
  assert.equal(parseCommit('commit: 1111111\ncommit: 2222222\n'), '1111111', 'first valid hash wins over the second');
  assert.equal(
    parseCommit('commit: not-hex-at-all\ncommit: 3dd368d\n'),
    null,
    'the first commit: line decides even when it fails the hex grammar — it is not skipped in favour of a later valid one',
  );
});

test('check: two commit: lines — staleness is driven only by the first, even naming an unknown commit', { skip: GIT_SKIP }, () => {
  const { root, first } = gitRepo();
  writeFileSync(join(root, 'map.md'), [
    'commit: deadbee',
    `commit: ${first}`,
    '',
    'a.txt:1 · `hello world` · c',
    '',
  ].join('\n'));
  const r = cli(['check', 'map.md'], { cwd: root });
  assert.equal(r.code, 0);
  assert.equal(
    r.out,
    `staleness: not checked (unknown commit deadbee)\n${summary(1, { ok: 1 })}\n`,
    'the second, valid commit: line is never reached',
  );
});

test('parseCommit: an uppercase hex hash counts as hex, case preserved', () => {
  assert.equal(parseCommit('commit: 3DD368D\n'), '3DD368D');
  assert.equal(parseCommit(`commit: ${'A'.repeat(40)}\n`), 'A'.repeat(40));
});

test('changedSince: an uppercase hash passes hex validation and reaches git — never rejected as "invalid commit"', { skip: GIT_SKIP }, () => {
  const { root, first } = gitRepo();
  const r = changedSince({ hash: first.toUpperCase(), root });
  assert.ok(
    r.changed instanceof Set || /^unknown commit /.test(r.reason || ''),
    `uppercase hex must clear the grammar check, got ${JSON.stringify(r)}`,
  );
});

// ─── §4 nothing written, recursively, across several runs ──────────────────

function snapshot(dir) {
  const rows = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) rows.push(`L ${name} -> ${readlinkSync(p)}`);
    else if (st.isDirectory()) rows.push(`D ${name}`, ...snapshot(p).map((s) => `  ${s}`));
    else rows.push(`F ${name} ${readFileSync(p, 'utf8')}`);
  }
  return rows;
}

test('check writes nothing anywhere under the project, recursively, across ok/moved/mismatch/outside/missing runs and flag combinations', () => {
  const root = project({ 'a.txt': 'one\ntwo\n', 'sub/b.txt': 'alpha\n' });
  symlinkSync(join(root, 'a.txt'), join(root, 'link.txt'));
  writeFileSync(join(root, 'report.md'), [
    'a.txt:1 · `one` · ok',
    'a.txt:1 · `two` · moved',
    'a.txt:1 · `nowhere` · mismatch',
    '../escape.txt:1 · `x` · outside',
    'link.txt:1 · `one` · outside-symlink',
    'gone.txt:1 · `x` · missing',
    '',
  ].join('\n'));
  const before = snapshot(root);
  cli(['check', 'report.md'], { cwd: root });
  cli(['check', 'report.md', '--strict'], { cwd: root });
  cli(['check', 'report.md', '--require', '0'], { cwd: root });
  cli(['check', 'report.md', '--root', root], { cwd: tmp() });
  assert.deepEqual(snapshot(root), before);
});

// ─── §5 docs the implementer's suite never reads ────────────────────────────

test('README: the check row names its flags, statuses, the exit-0 rule and the ORCHESTRATION link', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const row = readme.split('\n').find((l) => l.startsWith('| `check <file.md>'));
  assert.ok(row, 'a check row is present in the CLI table');
  for (const needle of [
    '--strict', '--require <n>', '--root <dir>',
    '`ok`', '`moved`', '`mismatch`', '`missing`', '`outside`', '`too-large`', '`stale`',
    'Read-only', '(docs/ORCHESTRATION.md#evidence-with-pointers)',
  ]) {
    assert.ok(row.includes(needle), `check row mentions ${needle}`);
  }
  const orch = readFileSync(join(ROOT, 'docs/ORCHESTRATION.md'), 'utf8');
  assert.match(orch, /^## Evidence with pointers$/m, 'the linked heading actually exists');
});

test('SECURITY.md: check gets its one-sentence bullet — root only, no writes, git diff --name-only', () => {
  const security = readFileSync(join(ROOT, 'docs/SECURITY.md'), 'utf8');
  // The sentence was rewritten with the review round (spec §4 "The git child is
  // boxed"): the bullet is found by what it is about, not by its old wording.
  const bullet = security.split('\n').find((l) => l.startsWith('- **`check` opens only paths that resolve inside the project root'));
  assert.ok(bullet, 'the check bullet is present');
  assert.match(bullet, /git diff --name-only/);
  assert.match(bullet, /writes nothing/);
  assert.match(bullet, /O_NOFOLLOW/, 'and says how a target is opened');
});

test('agent templates: the short reply keeps its current fields (§2) for both roles', () => {
  const coder = renderAgentFile('omelette-coder.md', '1.1.0');
  assert.match(coder, /\*\*Status\*\* \(DONE \| DONE_WITH_CONCERNS \| BLOCKED \| NEEDS_CONTEXT\)/);
  assert.match(coder, /files changed, a one-line test summary, concerns, the report path/);
  const tester = renderAgentFile('omelette-tester.md', '1.1.0');
  assert.match(tester, /tests added, `passing\/total` for your file and for the suite/);
  assert.match(tester, /each failing test with its ruling, the report path/);
});
