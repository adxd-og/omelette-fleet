/**
 * omelette-fleet :: test/hooks-handoff-1.8.0.test.mjs
 * 1.8.0 Task 9, the guard's half: on `compact` and `clear` the SessionStart
 * print is one JSON document, `hookSpecificOutput.additionalContext` the text,
 * led by the marker line the mod strips (its one copy reaches the session as
 * the mod's prompt.context block), the marker counted inside the 12 KB cap.
 * test/hooks-print-1.7.3.test.mjs pins the sections themselves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';
import { GIT_SKIP, ledger, project } from './fixtures/ledger-1.7.3.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = mkdtempSync(join(tmpdir(), 'omelette-home-180-'));
const MARKER = '--- omelette-fleet · read before continuing ---';
const CAP = 12 * 1024;

function guard() {
  const path = join(mkdtempSync(join(tmpdir(), 'omelette-guard-180-')), HOOK_FILES[0]);
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.8.0-test', { enabled: true }, ROOT));
  return path;
}
function fire(path, source, cwd) {
  const r = spawnSync(process.execPath, [path], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source, cwd }), encoding: 'utf8', cwd, timeout: 20000,
    env: { PATH: process.env.PATH, HOME },
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const bytes = (s) => Buffer.byteLength(s, 'utf8');

test('SessionStart compact with a ledger prints one JSON document: the marker line, then the sections as before', () => {
  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', '# x\n## Handoff\nnext: run npm test\n');
  const r = fire(guard(), 'compact', p.dir);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${MARKER}\n--- ledger-x.md · last handoff ---\n## Handoff\nnext: run npm test\n` },
  });
});

test('SessionStart startup prints nothing', () => {
  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', '# x\n## Handoff\nnext: run npm test\n');
  assert.equal(fire(guard(), 'startup', p.dir).out, '');
});

test('the cap holds with the marker counted: sections that fill 12 KB exactly print at most 12 KB of text', () => {
  const p = project({ git: false });
  const section = (name, block) => `--- ${name} · last handoff ---\n${block}\n`;
  // Three handoff blocks near lastHandoffBlock's own bound (40 lines, 4 KB), then a fourth sized so the sections reach 12 KB to the byte.
  const full = ['## Handoff', ...Array.from({ length: 39 }, (_, i) => `${'h'.repeat(99)}${i % 10}`)].join('\n');
  const used = ['a', 'b', 'c'].reduce((n, x, i) => n + (i ? 1 : 0) + bytes(section(`ledger-${x}.md`, full)), 0);
  const last = `## Handoff\n${'d'.repeat(CAP - used - 1 - bytes(section('ledger-d.md', '## Handoff\n')))}`;
  assert.equal(used + 1 + bytes(section('ledger-d.md', last)), CAP, 'the fixture fills the cap exactly');
  for (const x of ['a', 'b', 'c']) p.write(`.omelette/ledger-${x}.md`, `${full}\n`);
  p.write('.omelette/ledger-d.md', `${last}\n`);
  const text = JSON.parse(fire(guard(), 'clear', p.dir).out).hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith(`${MARKER}\n--- ledger-a.md · last handoff ---\n`));
  assert.ok(bytes(text) <= CAP, `${bytes(text)} bytes`);
});

// 1.8.0 release fix (guard review G5): the register (6 KB) and the backlog (2 KB)
// reserved first left about 3.9 KB, under one handoff block's own 4 KB, and this
// repository's print carried the register and the backlog but no handoff. The newest
// open ledger's last handoff is reserved first now, then the backlog, then the
// register in what is left; the other handoffs get the rest.
test('the newest open ledger\'s handoff is reserved first: with a 6 KB register and a 2 KB backlog all three print, the register cut to what is left', { skip: GIT_SKIP }, () => {
  const p = project();
  p.git(['branch', 'feat/alpha']);
  p.git(['branch', 'feat/zeta']);
  // A last block at lastHandoffBlock's own bound: 40 lines, just under 4 KB.
  const block = (tag) => [`## Handoff (2026-11-04 — ${tag})`, ...Array.from({ length: 39 }, (_, i) => `${tag[0].repeat(99)}${i % 10}`)].join('\n');
  const register = Array.from({ length: 80 }, (_, i) => `- 2026-11-01 · p · Ruling(binding): ${String(i).padStart(2, '0')} ${'r'.repeat(80)}`);
  p.write('.omelette/decisions.md', `${register.join('\n')}\n`);
  p.write('.omelette/backlog.md', ['# Backlog', '', '| # | What |', '|---|---|', ...Array.from({ length: 60 }, (_, i) => `| ${i} | ${'y'.repeat(60)} |`), ''].join('\n'));
  p.write('.omelette/ledger-zeta.md', ledger('feat/zeta', block('zeta')));
  const zeta = `--- ledger-zeta.md · last handoff ---\n${block('zeta')}\n`;

  const one = JSON.parse(fire(guard(), 'clear', p.dir).out).hookSpecificOutput.additionalContext;
  assert.ok(bytes(one) <= CAP, `${bytes(one)} bytes`);
  assert.ok(one.startsWith(`${MARKER}\n${zeta}\n--- .omelette/decisions.md · decisions register ---\n[… register cut to its last `), one.slice(0, 300));
  assert.ok(one.includes(`${register[79]}\n\n--- .omelette/backlog.md · first table ---\n| # | What |\n`), 'the register ends whole on its last line, then the backlog');
  assert.ok(one.endsWith('[… truncated]\n'), 'the backlog\'s table at its own 2 KB');
  assert.ok(bytes(one) > CAP - 200, `the register takes what the handoff and the backlog leave: ${bytes(one)} bytes`);

  // An older open ledger, first by name: the newest by mtime is the one reserved, the other is dropped whole.
  p.write('.omelette/ledger-alpha.md', ledger('feat/alpha', block('alpha')));
  const old = new Date(Date.now() - 3600_000);
  utimesSync(join(p.dir, '.omelette', 'ledger-alpha.md'), old, old);
  const two = JSON.parse(fire(guard(), 'clear', p.dir).out).hookSpecificOutput.additionalContext;
  assert.ok(bytes(two) <= CAP, `${bytes(two)} bytes`);
  assert.ok(two.startsWith(`${MARKER}\n${zeta}[… truncated]\n\n--- .omelette/decisions.md · decisions register ---\n`), two.slice(0, 300));
  assert.equal(two.includes('ledger-alpha.md'), false, 'the older handoff is dropped whole');
});
