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
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';
import { project } from './fixtures/ledger-1.7.3.mjs';

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
