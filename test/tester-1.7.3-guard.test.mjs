/**
 * omelette-fleet :: test/tester-1.7.3-guard.test.mjs
 * Tester's probes of the 1.7.3 guard (Tasks 7 and 8) that the coder's two files
 * do not pin: a guard that cannot use the package still refuses; a module that
 * throws, hangs or lies costs one stderr line and nothing else; `handoff.enabled
 * =false` is silent on every event; a git that never answers is cut at the 2 s
 * clock; the byte bounds of the print are exact; nothing is followed through a
 * symlink.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';
import { GIT_SKIP, PRINT_MARKER, ledger, printed, project } from './fixtures/ledger-1.7.3.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REAL_LEDGER = pathToFileURL(join(ROOT, 'core', 'ledger.mjs')).href;
// The guard's HOME is a throwaway of its own: a project whose .omelette is $HOME/.omelette is the fleet home.
const HOME = mkdtempSync(join(tmpdir(), 'omelette-home-tester173-'));
const REFUSAL = 'omelette-coder never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead';
const HANDOFF_LINE = 'HANDOFF: re-read .omelette/ledger-*.md before continuing.\n';
const STAMP = /\n## Compaction \S+ \(trigger: auto\) — branch \S+ · HEAD \S+ · \S+ dirty files — re-read this ledger before continuing\n$/;
const bytes = (s) => Buffer.byteLength(s, 'utf8');

function guard({ pkg = ROOT, enabled = true } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'omelette-guard-t173-')), HOOK_FILES[0]);
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.7.3', { enabled }, pkg));
  return path;
}
/** A package whose core/ledger.mjs is the real one with `body` laid over it (or instead of it). */
function fakePackage(body, { reexport = true } = {}) {
  const pkg = mkdtempSync(join(tmpdir(), 'omelette-pkg-t173-'));
  mkdirSync(join(pkg, 'core'));
  writeFileSync(join(pkg, 'core', 'ledger.mjs'), `${reexport ? `export * from ${JSON.stringify(REAL_LEDGER)};\n` : ''}${body}\n`);
  return pkg;
}
function fire(path, event, cwd) {
  const r = spawnSync(process.execPath, [path], {
    input: JSON.stringify({ cwd, ...event }), encoding: 'utf8', cwd, timeout: 20000,
    env: { PATH: process.env.PATH, HOME },
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  const out = r.stdout || '';
  return { code: r.status, out: event.hook_event_name === 'SessionStart' ? printed(out) : out, err: r.stderr || '' };
}
const start = (source) => ({ hook_event_name: 'SessionStart', source });
const compact = { hook_event_name: 'PreCompact', trigger: 'auto' };
const lines = (s) => s.split('\n').filter(Boolean);

test('a guard whose package is gone still refuses the coder\'s commit — exit 2, the refusal alone on stderr', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'omelette-gone-t173-')), 'no-package');
  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', ledger('feat/x', '## Handoff', 'next: go'));
  const r = fire(guard({ pkg: missing }), {
    hook_event_name: 'PreToolUse', agent_type: 'omelette-coder', tool_name: 'Bash', tool_input: { command: ['git', 'commit', '-m', 'x'].join(' ') },
  }, p.dir);
  assert.equal(r.code, 2);
  assert.equal(r.err, `${REFUSAL}\n`, 'PreToolUse never touches the import: no "cannot load" line');
  assert.equal(r.out, '');
});

test('a module that throws on import, throws in the sweep, or lies about its result: at most one stderr line, exit 0, the print and the stamp intact', () => {
  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', ledger('feat/x', '## Handoff', 'next: still here'));
  const block = '--- ledger-x.md · last handoff ---\n## Handoff\nnext: still here\n';
  const cases = [
    ['throws on import', fakePackage('throw new Error("boom\\nsecond line");', { reexport: false }), /^omelette-guard: cannot load .*core\/ledger\.mjs — ledger sweep skipped; run omelette-fleet rules --hooks\n$/, /decisions register not printed: the guard could not load/],
    ['throws in the sweep', fakePackage('export function sweepLedgers() { throw new Error("boom\\nsecond line"); }'), /^omelette-guard: ledger sweep failed — boom\n$/, /./],
    ['sweep returns a string', fakePackage('export function sweepLedgers() { return "nope"; }'), /^$/, /./],
    ['sweep returns a hostile shape', fakePackage('export function sweepLedgers() { return { ledgers: 7, register: "nope" }; }'), /^$/, /decisions register not printed: register: unreadable/],
    ['the register lookup throws', fakePackage('export function sweepLedgers() { return { ledgers: [], register: null }; }\nexport function readRegisterPath() { throw new Error("x"); }'), /^$/, /decisions register not printed: register: unreadable/],
  ];
  for (const [label, pkg, errRe, outRe] of cases) {
    const r = fire(guard({ pkg }), start('clear'), p.dir);
    assert.equal(r.code, 0, `${label}: ${r.err}`);
    assert.match(r.err, errRe, label);
    assert.ok(r.out.startsWith(block), `${label}: the handoff block comes first: ${r.out}`);
    assert.match(r.out, outRe, label);
    const pre = fire(guard({ pkg }), compact, p.dir);
    assert.equal(pre.code, 0, label);
    assert.equal(pre.out, HANDOFF_LINE, label);
    assert.ok(lines(pre.err).length <= 1, `${label}: ${pre.err}`);
  }
  assert.match(p.read('.omelette/ledger-x.md'), /## Compaction/);
});

test('a module whose import never settles: the 2 s clock, one stderr line, exit 0, and the print and the stamp still happen', () => {
  const pkg = fakePackage('await new Promise(() => {});', { reexport: false });
  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', ledger('feat/x', '## Handoff', 'next: go'));
  const g = guard({ pkg });
  const t0 = Date.now();
  const r = fire(g, start('clear'), p.dir);
  const ms = Date.now() - t0;
  assert.equal(r.code, 0, `exit ${r.code}: ${r.err}`);
  assert.ok(ms >= 1500 && ms < 10000, `the clock, not a hang: ${ms} ms`);
  assert.equal(r.err, `omelette-guard: ${join(pkg, 'core', 'ledger.mjs')} did not load within 2 s — ledger sweep skipped\n`);
  assert.equal(r.out, `--- ledger-x.md · last handoff ---\n## Handoff\nnext: go\n\n--- decisions register not printed: the guard could not load core/ledger.mjs — run omelette-fleet rules --hooks ---\n`);
  const pre = fire(g, compact, p.dir);
  assert.equal(pre.code, 0, pre.err);
  assert.equal(pre.out, HANDOFF_LINE);
  assert.equal(lines(pre.err).length, 1, pre.err);
  assert.match(p.read('.omelette/ledger-x.md'), STAMP);
});

test('a module that loads fast leaves no timer behind: the guard exits well inside a second, on a print and on a stamp', () => {
  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', ledger('feat/x', '## Handoff', 'next: go'));
  const g = guard();
  const time = (event) => { const t0 = Date.now(); const r = fire(g, event, p.dir); return { r, ms: Date.now() - t0 }; };
  const a = time(start('clear'));
  const b = time(compact);
  assert.equal(a.r.code, 0);
  assert.equal(b.r.code, 0);
  assert.ok(a.ms < 1000, `SessionStart ${a.ms} ms`);
  assert.ok(b.ms < 1000, `PreCompact ${b.ms} ms`);
});

test('a ledger name with a control character shows as \\xNN in its heading, never raw; the block\'s own text is printed as written', () => {
  const g = guard();
  const p = project({ git: false });
  p.write('.omelette/ledger-a\x1b[31mb.md', '## Handoff\nnext\x1b[2J go\n');
  p.write('.omelette/ledger-c\x7fd.md', '## Handoff\nplain\n');
  p.write('.omelette/decisions.md', 'register: docs/R\x1b.md\n');
  const r = fire(g, start('clear'), p.dir);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('--- ledger-a\\x1b[31mb.md · last handoff ---\n## Handoff\nnext\x1b[2J go\n'), JSON.stringify(r.out));
  assert.ok(r.out.includes('--- ledger-c\\x7fd.md · last handoff ---'), JSON.stringify(r.out));
  const headings = r.out.split('\n').filter((l) => l.startsWith('--- '));
  assert.ok(headings.length >= 2);
  for (const h of headings) assert.doesNotMatch(h, /[\x00-\x1f\x7f]/, `raw control character in a heading: ${JSON.stringify(h)}`);
  assert.equal(r.out.split('\x1b').length - 1, 1, 'the only raw ESC is the one inside the block text');
  assert.equal(r.err.includes('\x1b'), false, 'and stderr carries none');
});

test('handoff.enabled=false: no sweep, no stamp, no print, no announcement — on every event and source', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', '## Handoff', 'next: x'));
  p.write('.omelette/decisions.md', '- 2026-11-01 · p · a ruling\n');
  p.write('.omelette/backlog.md', '| a |\n');
  const before = p.snapshot();
  const g = guard({ enabled: false });
  for (const event of [start('clear'), start('compact'), start('startup'), compact, { hook_event_name: 'PreCompact', trigger: 'manual' }]) {
    const r = fire(g, event, p.dir);
    assert.deepEqual([r.code, r.out, r.err], [0, '', ''], JSON.stringify(event));
  }
  assert.deepEqual(p.snapshot(), before, 'nothing under the project moved or changed');
});

test('PreCompact: a root left with nothing but archived ledgers announces and stamps nothing; a standing ledger is stamped', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-a.md', ledger('feat/a'));
  p.write('.omelette/ledger-b.md', ledger('feat/b'));
  const r = fire(guard(), compact, p.dir);
  assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
  assert.doesNotMatch(p.read('.omelette/archive/ledger-a.md'), /## Compaction/);
  assert.equal(existsSync(join(p.dir, '.omelette', 'ledger-a.md')), false);
  p.write('.omelette/ledger-lane.md', ledger('main', 'lane line'));
  const again = fire(guard(), compact, p.dir);
  assert.equal(again.out, HANDOFF_LINE);
  assert.match(p.read('.omelette/ledger-lane.md'), STAMP);
});

test('a git that never answers is cut at the 2 s clock once, not once per ledger; the guard still stamps, prints, and exits 0', { skip: process.platform === 'win32' && 'POSIX shell', timeout: 60000 }, async () => {
  const bin = mkdtempSync(join(tmpdir(), 'omelette-fakegit-t173-'));
  const pidFile = join(bin, 'pids');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho $$ >> ${JSON.stringify(pidFile)}\nexec sleep 60\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const p = project({ git: false });
  for (const n of ['a', 'b', 'c']) p.write(`.omelette/ledger-${n}.md`, ledger(`feat/${n}`, '## Handoff', `${n}: next`));
  const run = (event) => new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [guard()], { cwd: p.dir, env: { PATH: `${bin}${delimiter}${process.env.PATH}`, HOME }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const bound = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (code, signal) => { clearTimeout(bound); resolve({ code, signal, out, err, ms: Date.now() - t0 }); });
    child.stdin.end(JSON.stringify({ cwd: p.dir, ...event }));
  });
  const s = await run(start('clear'));
  assert.equal(s.signal, null, 'the guard exited on its own');
  assert.equal(s.code, 0, s.err);
  assert.ok(s.ms >= 1500, `the clock ran its 2 s (${s.ms} ms)`);
  assert.ok(s.ms < 5500, `one wait for three ledgers, not three (${s.ms} ms)`);
  assert.equal(lines(s.err).length, 1, s.err);
  assert.ok(s.out.includes('--- ledger-a.md · last handoff ---') && s.out.includes('--- ledger-c.md · last handoff ---'), s.out);
  const pre = await run(compact);
  assert.equal(pre.code, 0, pre.err);
  assert.equal(pre.out, HANDOFF_LINE);
  for (const n of ['a', 'b', 'c']) assert.match(p.read(`.omelette/ledger-${n}.md`), /## Compaction/, 'git said nothing: every root ledger is stamped');
  // The fake git was killed, not left behind.
  const pids = readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number);
  assert.ok(pids.length >= 2);
  for (const pid of pids) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    assert.equal(alive, false, `fake git ${pid} outlived the guard`);
  }
});

test('the register prints whole at exactly 6 KB and under the tail note one byte past; a tail cut inside a multibyte character leaves no U+FFFD', () => {
  const g = guard();
  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', '## Handoff\nnext: go\n');
  const exact = `${'r'.repeat(63)}\n`.repeat(96); // 96 * 64 = 6144
  assert.equal(bytes(exact), 6144);
  p.write('.omelette/decisions.md', exact);
  const whole = fire(g, start('clear'), p.dir).out;
  assert.ok(!whole.includes('larger than 6 KB'), 'exactly 6 KB is whole');
  assert.equal(whole.split('\n').filter((l) => l.startsWith('rrr')).length, 96);
  p.write('.omelette/decisions.md', `x\n${exact}`); // 6146 bytes
  const tailed = fire(g, start('clear'), p.dir).out;
  assert.ok(tailed.includes('[… register larger than 6 KB — its last 6 KB]\nrrr'), 'the note, then a whole line');
  assert.equal(tailed.split('\n').filter((l) => l.startsWith('rrr')).length, 96);
  assert.ok(!/\nx\n/.test(tailed));
  // Cyrillic: two bytes a character, the cut lands inside one.
  const ru = Array.from({ length: 300 }, (_, i) => `- ${String(i).padStart(3, '0')} решение ${'я'.repeat(40)}`).join('\n');
  p.write('.omelette/decisions.md', `${ru}\n`);
  const out = fire(g, start('clear'), p.dir).out;
  assert.ok(out.includes('larger than 6 KB'));
  assert.ok(!out.includes('�'), 'no replacement character');
  assert.ok(out.includes('- 299 решение'));
});

test('the backlog table is kept to exactly 2 KB by whole lines: 2048 bytes fit, one more line is the truncation marker; no table, or only a later one, is no section', () => {
  const g = guard();
  const p = project({ git: false });
  const row = `|${'t'.repeat(61)}|`; // 63 bytes + newline
  const table = (count) => Array.from({ length: count }, () => row).join('\n');
  p.write('.omelette/backlog.md', `# B\n\n${table(32)}\n\nafter\n`);
  assert.equal(fire(g, start('clear'), p.dir).out, `--- .omelette/backlog.md · first table ---\n${table(32)}\n`);
  p.write('.omelette/backlog.md', `# B\n\n${table(33)}\n`);
  assert.equal(fire(g, start('clear'), p.dir).out, `--- .omelette/backlog.md · first table ---\n${table(32)}\n[… truncated]\n`);
  p.write('.omelette/backlog.md', '# Backlog\n\nplain prose, no table\n\n- a | b | c\n');
  assert.equal(fire(g, start('clear'), p.dir).out, '');
  p.write('.omelette/backlog.md', '# Backlog\n\n| a |\n|---|\n\n| later |\n');
  assert.ok(!fire(g, start('clear'), p.dir).out.includes('later'), 'only the first table');
});

test('the 12 KB cap is exact: 12288 bytes print whole, one more byte drops the last handoff whole and keeps the register', () => {
  const g = guard();
  const p = project({ git: false });
  const block = ['## Handoff', ...Array.from({ length: 39 }, (_, i) => `${'h'.repeat(99)}${i % 10}`)].join('\n');
  p.write('.omelette/ledger-a.md', block);
  p.write('.omelette/ledger-b.md', block);
  const setRegister = (pad) => p.write('.omelette/decisions.md', `- one ruling\nz${'z'.repeat(pad)}\n`);
  // The whole print's bytes: since 1.8.0 its marker line is counted inside the cap.
  const whole = (out) => bytes(PRINT_MARKER) + bytes(out);
  setRegister(100);
  const base = whole(fire(g, start('compact'), p.dir).out);
  assert.ok(base < 12288, `${base}`);
  const pad = 100 + (12288 - base);
  setRegister(pad);
  const exact = fire(g, start('compact'), p.dir).out;
  assert.equal(whole(exact), 12288);
  assert.ok(exact.includes('decisions register') && !exact.includes('[… truncated]'), 'nothing was dropped');
  assert.ok(exact.endsWith(`z${'z'.repeat(pad)}\n`), 'the register is whole at 12288');
  setRegister(pad + 1);
  const over = fire(g, start('compact'), p.dir).out;
  assert.ok(whole(over) <= 12288, `${whole(over)}`);
  assert.ok(!over.includes('--- ledger-b.md · last handoff ---'), 'the handoff that no longer fits is dropped whole');
  assert.ok(over.includes(`${block}\n[… truncated]\n\n--- .omelette/decisions.md · decisions register ---\n`), 'ledger-a whole, then the marker, then the register');
  assert.ok(over.endsWith(`z${'z'.repeat(pad + 1)}\n`), 'the register is whole');
});

test('a symlinked .omelette, decisions.md, backlog.md or register: target is not followed out of the project', () => {
  const secretDir = mkdtempSync(join(tmpdir(), 'omelette-secret-t173-'));
  writeFileSync(join(secretDir, 'secret.md'), 'TOPSECRET register line\n');
  writeFileSync(join(secretDir, 'backlog.md'), '| TOPSECRET |\n|---|\n');
  mkdirSync(join(secretDir, 'omelette'));
  writeFileSync(join(secretDir, 'omelette', 'ledger-s.md'), '## Handoff\nTOPSECRET handoff\n');
  const g = guard();

  const linked = project({ git: false });
  rmSync(join(linked.dir, '.omelette'), { recursive: true });
  symlinkSync(join(secretDir, 'omelette'), join(linked.dir, '.omelette'));
  for (const event of [start('clear'), start('startup'), compact]) {
    const r = fire(g, event, linked.dir);
    assert.deepEqual([r.code, r.out, r.err], [0, '', ''], `a symlinked .omelette is not ours: ${JSON.stringify(event)}`);
  }
  assert.equal(readFileSync(join(secretDir, 'omelette', 'ledger-s.md'), 'utf8'), '## Handoff\nTOPSECRET handoff\n', 'nothing appended through the link');

  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', '## Handoff\nnext: go\n');
  symlinkSync(join(secretDir, 'secret.md'), join(p.dir, '.omelette', 'decisions.md'));
  symlinkSync(join(secretDir, 'backlog.md'), join(p.dir, '.omelette', 'backlog.md'));
  const r1 = fire(g, start('clear'), p.dir);
  assert.equal(r1.code, 0, r1.err);
  assert.ok(!r1.out.includes('TOPSECRET') && !r1.err.includes('TOPSECRET'), `${r1.out}${r1.err}`);
  assert.ok(r1.out.includes('next: go'));

  const q = project({ git: false });
  q.write('.omelette/ledger-x.md', '## Handoff\nnext: go\n');
  q.write('.omelette/decisions.md', 'register: docs/R.md\n');
  mkdirSync(join(q.dir, 'docs'));
  symlinkSync(join(secretDir, 'secret.md'), join(q.dir, 'docs', 'R.md'));
  const r2 = fire(g, start('clear'), q.dir);
  assert.equal(r2.code, 0, r2.err);
  assert.ok(!r2.out.includes('TOPSECRET') && !r2.err.includes('TOPSECRET'), `${r2.out}${r2.err}`);
});
