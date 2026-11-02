/**
 * omelette-fleet :: test/tester-1.7.3-cli.test.mjs
 * 1.7.3, Tasks 5-6, probed from outside: the `ledger` CLI's refusals and exit
 * codes outside a clean repository, `visible()` on every printed value, and
 * the `doctor` rows the coder's tests leave unpinned (boundaries, states,
 * unreadable registers, no git, exit code).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GIT_SKIP, ledger, project } from './fixtures/ledger-1.7.3.mjs';

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'omelette-fleet.mjs');
const ESC = '\x1b';
function run(p, args, { path = process.env.PATH } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'omelette-home-'));
  const gone = join(home, 'no-such-cli');
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: p.dir, encoding: 'utf8',
    env: { PATH: path, HOME: home, OMELETTE_HOME: home, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const cli = (p, args, o) => run(p, ['ledger', ...args], o);
function doctor(p, o) {
  const r = run(p, ['doctor'], o);
  const at = r.out.indexOf('\nledgers ');
  const rows = at < 0 ? [] : r.out.slice(at + 1, r.out.indexOf('\ncontract ')).split('\n');
  return { ...r, rows };
}
/** A register of `n` unstruck lines, then `extra`. */
const register = (n, ...extra) => [
  '# Decisions', '', ...Array.from({ length: n }, (_, i) => `- 2026-11-01 · p · Ruling(binding): live ${i} — x — y`), ...extra, '',
].join('\n');

test('ledger open: the plan name is refused with its message, ESC escaped; a flag or a third word is exit 2; nothing written', () => {
  const p = project({ git: false });
  const before = p.snapshot();
  const bad = cli(p, ['open', `a${ESC}[31mb`]);
  assert.equal(bad.code, 2);
  assert.equal(bad.out, '');
  assert.match(bad.err, /^omelette-fleet ledger open: plan name "a.*b" must start with a letter or digit and hold only letters, digits, "\.", "_" or "-"\n$/);
  assert.ok(!bad.err.includes(ESC), 'the ESC reaches the terminal');
  for (const args of [['open', '-x'], ['open', '--force', 'a'], ['open', 'a', `b${ESC}c`], [`nope${ESC}x`], ['sweep', `x${ESC}y`]]) {
    const r = cli(p, args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.out, '');
    assert.ok(!r.err.includes(ESC), `${JSON.stringify(args)}: ${JSON.stringify(r.err)}`);
  }
  assert.equal(cli(p, ['open', 'a'.repeat(65)]).code, 2, 'a name over 64 characters');
  assert.deepEqual(p.snapshot(), before);
});

test('ledger open: outside a repository exit 1 and nothing written; an existing file is kept byte for byte', { skip: GIT_SKIP }, () => {
  const bare = project({ git: false });
  const before = bare.snapshot();
  const r = cli(bare, ['open', '1.0.0']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /^omelette-fleet ledger open: not inside a git repository\n$/);
  assert.deepEqual(bare.snapshot(), before);

  const p = project();
  p.write('.omelette/ledger-1.0.0.md', 'mine, no header\n');
  const again = cli(p, ['open', '1.0.0']);
  assert.deepEqual(again, { code: 1, out: '', err: 'omelette-fleet ledger open: .omelette/ledger-1.0.0.md exists\n' });
  assert.equal(p.read('.omelette/ledger-1.0.0.md'), 'mine, no header\n');
});

test('ledger open creates .omelette when absent, and the ledger it wrote is open to the sweep (nothing to do)', { skip: GIT_SKIP }, () => {
  const p = project();
  p.git(['checkout', '-q', '-b', 'feat/x']);
  // remove the fixture's .omelette
  spawnSync('rmdir', [join(p.dir, '.omelette')]);
  assert.equal(cli(p, ['open', 'x']).code, 0);
  assert.match(p.read('.omelette/ledger-x.md'), /^branch: feat\/x$/m);
  assert.deepEqual(cli(p, ['sweep']), { code: 0, out: 'sweep: nothing to do\n', err: '' });
});

test('ledger sweep exits 0 with one line on every precondition failure and writes nothing: outside a repo, no git on PATH, a refused register: line', { skip: GIT_SKIP }, () => {
  const bare = project({ git: false });
  bare.write('.omelette/ledger-a.md', ledger('feat/a'));
  let before = bare.snapshot();
  assert.deepEqual(cli(bare, ['sweep']), { code: 0, out: 'sweep: not inside a git repository — nothing swept\n', err: '' });
  assert.deepEqual(bare.snapshot(), before);

  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', '- 2026-10-02 Ruling(binding): one — two — three'));
  const empty = mkdtempSync(join(tmpdir(), 'omelette-nopath-'));
  before = p.snapshot();
  assert.deepEqual(cli(p, ['sweep'], { path: empty }), { code: 0, out: 'sweep: git not found on PATH — nothing swept\n', err: '' });
  assert.deepEqual(p.snapshot(), before);

  p.write('.omelette/decisions.md', 'register: ../out.md\n');
  before = p.snapshot();
  const r = cli(p, ['sweep']);
  assert.deepEqual(r, { code: 0, out: 'register: ../out.md refused (contains ..) — nothing swept\n', err: '' });
  assert.deepEqual(p.snapshot(), before);
});

test('ledger sweep --dry-run with nothing to do says so, then the dry-run line, and writes nothing', { skip: GIT_SKIP }, () => {
  const p = project();
  const before = p.snapshot();
  assert.deepEqual(cli(p, ['sweep', '--dry-run']), { code: 0, out: 'sweep: nothing to do\ndry run — nothing written\n', err: '' });
  assert.deepEqual(p.snapshot(), before);
});

test('ledger sweep: a file name with ESC is escaped in the line', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write(`.omelette/ledger-a${ESC}[31mb.md`, '# no header\n');
  const r = cli(p, ['sweep']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^untracked: ledger-a.*b\.md \(no branch: header/);
  assert.ok(!r.out.includes(ESC));
});

test('doctor: ESC in a ledger name, and in a valid register: path, never reaches the terminal', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write(`.omelette/ledger-a${ESC}[31mb.md`, '# no header\n');
  p.write(`.omelette/decisions.md`, `register: docs/r${ESC}[31mx.md\n`);
  mkdirSync(join(p.dir, 'docs'));
  const d = doctor(p);
  assert.ok(d.rows.length >= 3, d.out);
  assert.ok(!d.out.includes(ESC), JSON.stringify(d.rows));
  // A control character in the redirect is refused outright (session ruling, T7–8 round), the value escaped.
  assert.match(d.rows.at(-1), /^decisions {5}register: docs\/r\\u001b\[31mx\.md refused \(control characters\)$/);
});

test('doctor: a closed ledger is moved by a doctor run, its closed: line printed, the register written; --dry-run is not doctor\'s', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', '- 2026-10-02 Ruling(binding): one — two — three'));
  const d = doctor(p);
  assert.equal(d.code, doctor(project({ git: false })).code, 'the exit code does not depend on the ledgers');
  assert.match(d.rows[1], /^ {14}closed: ledger-gone\.md \(feat\/gone gone\) — 1 binding ruling → \.omelette\/decisions\.md, moved to \.omelette\/archive\/$/);
  assert.match(p.read('.omelette/archive/ledger-gone.md'), /closed \S+ by sweep — 1 binding ruling/);
  assert.match(p.read('.omelette/decisions.md'), /Ruling\(binding\): one — two — three/);
});

test('doctor: no .omelette → no rows; an empty .omelette → 0/0/0 and "none yet"; .omelette a symlink → one line, nothing read', { skip: GIT_SKIP }, () => {
  const p = project();
  assert.deepEqual(doctor(p).rows, [
    'ledgers       0 open, 0 untracked, 0 archived',
    'decisions     .omelette/decisions.md — none yet',
  ]);

  const linked = project();
  const target = join(linked.dir, 'elsewhere');
  mkdirSync(target);
  writeFileSync(join(target, 'ledger-a.md'), ledger('feat/gone'));
  spawnSync('rmdir', [join(linked.dir, '.omelette')]);
  symlinkSync(target, join(linked.dir, '.omelette'));
  const before = linked.snapshot();
  const d = doctor(linked);
  assert.deepEqual(d.rows, ['ledgers       .omelette is not a directory of this project — nothing read']);
  assert.deepEqual(linked.snapshot(), before, 'nothing moved through the symlink');
});

test('doctor: counts — "1 line", struck in any case, indented or bare dashes are not lines, CRLF, stale pointer singular, a pointer on a struck line is not checked', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('src/x.mjs', 'export const answer = 42;\n');
  p.write('.omelette/decisions.md', [
    '# Decisions\r',
    '- src/x.mjs:1 · `export const answer = 42` · 2026-11-01 · p · Ruling(binding): ok — a — b\r',
    '- src/gone.mjs:1 · `nothing` · 2026-11-01 · p · Ruling(binding): stale — a — b SUPERSEDED BY the line above\r',
    '  - 2026-11-01 · p · Ruling(binding): indented — not a line\r',
    '-2026-11-01 no space — not a line\r',
    '* 2026-11-01 star — not a line\r',
    '- 2026-11-01 · p · Ruling(binding): gone — a — b · superseded by x\r',
    '',
  ].join('\n'));
  assert.equal(doctor(p).rows.at(-1), 'decisions     .omelette/decisions.md — 3 lines, 2 struck, 0 stale pointers');

  const one = project();
  one.write('.omelette/decisions.md', '- src/missing.mjs:3 · `zzz zzz zzz` · 2026-11-01 · p · Ruling(binding): x — y — z\n');
  assert.equal(doctor(one).rows.at(-1), 'decisions     .omelette/decisions.md — 1 line, 0 struck, 1 stale pointer');
});

test('doctor: 30 unstruck lines is quiet, 31 warns; struck lines do not count towards the 30', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('.omelette/decisions.md', register(30, ...Array.from({ length: 5 }, (_, i) => `- 2026-10-01 · p · Ruling(binding): s${i} — x — y · superseded by z`)));
  assert.deepEqual(doctor(p).rows.slice(1), ['decisions     .omelette/decisions.md — 35 lines, 5 struck, 0 stale pointers']);
  p.write('.omelette/decisions.md', register(31));
  assert.deepEqual(doctor(p).rows.slice(1), [
    'decisions     .omelette/decisions.md — 31 lines, 0 struck, 0 stale pointers',
    '              warning: 31 unstruck lines — over 30: strike what no longer binds (append "superseded by …")',
  ]);
});

test('doctor: an untracked ledger is a line, not a warning word; an unclassified ledger (no repository) and a closed one that collides are counted by state', { skip: GIT_SKIP }, () => {
  const bare = project({ git: false });
  bare.write('.omelette/ledger-a.md', ledger('feat/a'));
  assert.deepEqual(doctor(bare).rows, [
    'ledgers       0 open, 1 unclassified (ledger-a.md), 0 untracked, 0 archived',
    '              sweep: not inside a git repository — nothing swept',
    'decisions     .omelette/decisions.md — none yet',
  ]);

  const p = project();
  p.write('.omelette/ledger-gone.md', ledger('feat/gone'));
  p.write('.omelette/archive/ledger-gone.md', '# earlier\n');
  const before = p.read('.omelette/ledger-gone.md');
  assert.deepEqual(doctor(p).rows.slice(0, 2), [
    'ledgers       0 open, 1 closed (ledger-gone.md), 0 untracked, 1 archived',
    '              collision: ledger-gone.md — .omelette/archive/ledger-gone.md exists; left in place',
  ]);
  assert.equal(p.read('.omelette/ledger-gone.md'), before);
});

test('doctor: a symlinked register is not read, and a refused register: line leaves the exit code alone', { skip: GIT_SKIP }, () => {
  const p = project();
  p.write('real.md', '- 2026-11-01 · p · Ruling(binding): a — b — c\n');
  symlinkSync(join(p.dir, 'real.md'), join(p.dir, '.omelette', 'decisions.md'));
  const d = doctor(p);
  assert.ok(!d.rows.join('\n').includes('1 line'), 'a symlinked register is not followed');
  assert.match(d.rows.join('\n'), /unreadable|not a regular file|refused/);

  const refused = project();
  refused.write('.omelette/decisions.md', 'register: /etc/passwd\n');
  assert.equal(doctor(refused).code, doctor(project()).code);
});

test('doctor: a refused register: line is reported even when git is also the failure (spec: a warning for a refused register: line)', { skip: GIT_SKIP }, () => {
  const bare = project({ git: false });
  bare.write('.omelette/decisions.md', 'register: /etc/passwd\n');
  bare.write('.omelette/ledger-a.md', ledger('feat/a'));
  const rows = doctor(bare).rows.join('\n');
  // The refusal rides the `decisions` row itself (the sweep stopped on git first, so no line above).
  assert.match(rows, /^decisions {5}register: \/etc\/passwd refused \(absolute path\)$/m, rows);
});

// ── second pass: mutants the first fifteen tests left alive ──────────────────

test('doctor: ESC in the name of an open, a standing, a closed-collision and an unclassified ledger is escaped in the ledgers row', { skip: GIT_SKIP }, () => {
  const p = project();
  p.git(['branch', 'feat/o']);
  p.write(`.omelette/ledger-o${ESC}[31m.md`, ledger('feat/o'));
  p.write(`.omelette/ledger-s${ESC}[31m.md`, ledger('main'));
  p.write(`.omelette/ledger-c${ESC}[31m.md`, ledger('feat/gone'));
  p.write(`.omelette/archive/ledger-c${ESC}[31m.md`, '# earlier\n');
  const d = doctor(p);
  assert.match(d.rows[0], /^ledgers {7}1 open \(ledger-o.*\.md → feat\/o\), 1 standing \(ledger-s.*\.md\), 1 closed \(ledger-c.*\.md\), 0 untracked, 1 archived$/, d.rows[0]);
  assert.ok(!d.out.includes(ESC), JSON.stringify(d.rows));

  const bare = project({ git: false });
  bare.write(`.omelette/ledger-u${ESC}[31m.md`, ledger('feat/x'));
  const b = doctor(bare);
  assert.match(b.rows[0], /1 unclassified \(ledger-u.*\.md\)/);
  assert.ok(!b.out.includes(ESC), JSON.stringify(b.rows));
});

test('doctor: the ledgers row comes after the handoff row (the order the plan fixes)', { skip: GIT_SKIP }, () => {
  const p = project();
  const hooks = run(p, ['rules', '--hooks']);
  assert.equal(hooks.code, 0, hooks.err);
  p.write('.omelette/ledger-a.md', '# no header\n');
  const out = run(p, ['doctor']).out;
  const handoff = out.indexOf('\nhandoff ');
  const ledgers = out.indexOf('\nledgers ');
  assert.ok(handoff >= 0, `no handoff row:\n${out}`);
  assert.ok(ledgers > handoff, 'ledgers row before the handoff row');
});

test('doctor and sweep in $HOME: a .omelette that is the fleet home is not a project — no rows, nothing swept (second-pass finding 1)', { skip: GIT_SKIP }, () => {
  // The project IS the home: its .omelette/ is OMELETTE_HOME, with a closed ledger planted in it.
  const p = project();
  p.git(['branch', 'feat/gone']);
  p.write('.omelette/ledger-gone.md', ledger('feat/gone', '- 2026-10-02 Ruling(binding): planted — in the fleet home — cost: none'));
  p.git(['branch', '-D', 'feat/gone']);
  const env = { PATH: process.env.PATH, HOME: p.dir, OMELETTE_HOME: join(p.dir, '.omelette'), OMELETTE_UPDATE_CHECK: '0' };
  const d = spawnSync(process.execPath, [BIN, 'doctor'], { cwd: p.dir, encoding: 'utf8', env });
  assert.doesNotMatch(d.stdout, /^(ledgers|decisions) /m, d.stdout);
  const s = spawnSync(process.execPath, [BIN, 'ledger', 'sweep'], { cwd: p.dir, encoding: 'utf8', env });
  assert.equal(s.status, 0);
  assert.equal(s.stdout, 'sweep: nothing to do\n');
  assert.ok(existsSync(join(p.dir, '.omelette', 'ledger-gone.md')), 'the planted ledger stays');
});
