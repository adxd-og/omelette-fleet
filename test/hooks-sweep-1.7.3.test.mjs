/**
 * omelette-fleet :: test/hooks-sweep-1.7.3.test.mjs
 * 1.7.3 spec, "The sweep" (where it runs): the rendered guard imports the sweep
 * from its package and runs it on every SessionStart source and before the
 * PreCompact stamp; a failed import or sweep is one stderr line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES, parseHookPackage, renderHookFile } from '../core/rules.mjs';
import { GIT_SKIP, ledger, project } from './fixtures/ledger-1.7.3.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const HANDOFF_LINE = 'HANDOFF: re-read .omelette/ledger-*.md before continuing.\n';
// The guard's HOME is a throwaway of its own, never the project: a project
// whose `.omelette` is the fleet home ($HOME/.omelette) is not swept.
const HOME = mkdtempSync(join(tmpdir(), 'omelette-home-173-'));

function guard({ pkg = ROOT, handoff = { enabled: true } } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'omelette-guard-173-')), HOOK_FILES[0]);
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.7.3', handoff, pkg));
  return path;
}
function fire(path, event, cwd) {
  const r = spawnSync(process.execPath, [path], {
    input: JSON.stringify({ cwd, ...event }), encoding: 'utf8', cwd, timeout: 20000,
    env: { PATH: process.env.PATH, HOME },
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('rules --hooks renders the package root into the guard as a JSON string, and parseHookPackage reads it back', () => {
  const odd = '/x/a "b"\\c';
  assert.equal(parseHookPackage(renderHookFile(HOOK_FILES[0], '1.7.3', { enabled: true }, odd)), odd);
  const text = renderHookFile(HOOK_FILES[0], '1.7.3', { enabled: true });
  assert.equal(parseHookPackage(text), ROOT);
  assert.ok(!text.includes('{{'), 'no placeholder survives rendering');
  assert.equal(parseHookPackage('// not a guard\n'), null);
});

test('SessionStart sweeps on every source — startup, resume, clear, compact, fork — and startup, resume and fork print nothing', { skip: GIT_SKIP }, () => {
  const g = guard();
  for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
    const p = project();
    p.write('.omelette/ledger-gone.md', ledger('feat/gone', '## Handoff', 'next: nothing'));
    const r = fire(g, { hook_event_name: 'SessionStart', source }, p.dir);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, '', `${source}: ${r.err}`);
    assert.equal(existsSync(join(p.dir, '.omelette', 'ledger-gone.md')), false, `${source}: swept out of the root`);
    assert.match(p.read('.omelette/archive/ledger-gone.md'), /\nclosed \S+ by sweep — 0 binding rulings → \.omelette\/decisions\.md\n$/);
    if (['startup', 'resume', 'fork'].includes(source)) assert.equal(r.out, '', `${source} prints nothing`);
  }
  // handoff.enabled=false: the guard leaves the ledgers alone, the sweep included.
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone'));
  assert.equal(fire(guard({ handoff: { enabled: false } }), { hook_event_name: 'SessionStart', source: 'startup' }, p.dir).code, 0);
  assert.equal(existsSync(join(p.dir, '.omelette', 'ledger-gone.md')), true);
});

test('PreCompact sweeps first, then stamps only the ledgers left open or untracked', { skip: GIT_SKIP }, () => {
  const p = project();
  p.git(['branch', 'feat/open']);
  p.write('.omelette/ledger-open.md', ledger('feat/open'));
  p.write('.omelette/ledger-old.md', '# ledger old\n');
  p.write('.omelette/ledger-gone.md', ledger('feat/gone'));
  p.write('.omelette/ledger-stuck.md', ledger('feat/stuck'));
  p.write('.omelette/archive/ledger-stuck.md', 'an older plan of the same name\n');
  const r = fire(guard(), { hook_event_name: 'PreCompact', trigger: 'auto' }, p.dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, HANDOFF_LINE);
  const STAMP = /\n## Compaction \S+ \(trigger: auto\) — re-read this ledger before continuing\n$/;
  assert.match(p.read('.omelette/ledger-open.md'), STAMP);
  assert.match(p.read('.omelette/ledger-old.md'), STAMP);
  assert.equal(p.read('.omelette/ledger-stuck.md'), ledger('feat/stuck'), 'closed and held in place by a collision: not stamped');
  assert.doesNotMatch(p.read('.omelette/archive/ledger-gone.md'), /## Compaction/, 'archived before the stamp');
});

test('a guard whose package is gone still prints and stamps, and says once on stderr that the sweep was skipped', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'omelette-gone-')), 'no-package');
  const g = guard({ pkg: missing });
  const p = project({ git: false });
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', '## Handoff', 'next: re-render the guard'));
  const start = fire(g, { hook_event_name: 'SessionStart', source: 'compact' }, p.dir);
  assert.equal(start.code, 0);
  assert.ok(start.out.startsWith('--- ledger-gone.md · last handoff ---\n## Handoff\nnext: re-render the guard\n'), start.out);
  assert.equal(start.err, `omelette-guard: cannot load ${join(missing, 'core', 'ledger.mjs')} — ledger sweep skipped; run omelette-fleet rules --hooks\n`);
  const pre = fire(g, { hook_event_name: 'PreCompact', trigger: 'manual' }, p.dir);
  assert.equal(pre.out, HANDOFF_LINE);
  assert.match(p.read('.omelette/ledger-gone.md'), /## Compaction \S+ \(trigger: manual\)/, 'without the sweep every root ledger is stamped, as before 1.7.3');
  assert.equal(pre.err.split('\n').filter(Boolean).length, 1);
});

test('outside a repository the guard\'s sweep is one stderr line and exit 0, and the print still happens', () => {
  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', ledger('feat/x', '## Handoff', 'next: commit'));
  const r = fire(guard(), { hook_event_name: 'SessionStart', source: 'compact' }, p.dir);
  assert.equal(r.code, 0);
  assert.equal(r.err, 'omelette-guard: sweep: not inside a git repository — nothing swept\n');
  assert.ok(r.out.startsWith('--- ledger-x.md · last handoff ---\n## Handoff\nnext: commit\n'), r.out);
  assert.equal(existsSync(join(p.dir, '.omelette', 'ledger-x.md')), true);
});

test('doctor names a guard whose rendered package root no longer holds core/ledger.mjs', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-doc-173-'));
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  const gone = join(dir, 'no-such-cli');
  const env = { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone };
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: proj, encoding: 'utf8', env });
  assert.equal(run(['rules', '--hooks']).status, 0);
  assert.doesNotMatch(run(['doctor']).stdout, /hook imports/, 'a freshly rendered guard imports a file that is there');
  const installed = join(proj, '.claude', 'hooks', HOOK_FILES[0]);
  writeFileSync(installed, readFileSync(installed, 'utf8').replace(/^const PACKAGE_ROOT = .*$/m, 'const PACKAGE_ROOT = "/nonexistent/omelette";'));
  assert.match(run(['doctor']).stdout, /^ {14}hook imports \/nonexistent\/omelette\/core\/ledger\.mjs — not found: run omelette-fleet rules --hooks$/m);
});
