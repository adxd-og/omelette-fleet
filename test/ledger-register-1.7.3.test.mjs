/**
 * omelette-fleet :: test/ledger-register-1.7.3.test.mjs
 * 1.7.3 spec, "The model": which ledger lines are binding rulings, the register
 * line they become (pointer first, in check's grammar), and where the register is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePointers } from '../core/check.mjs';
import { harvestBindings, readRegisterPath, registerLine } from '../core/ledger.mjs';
import { project } from './fixtures/ledger-1.7.3.mjs';

const FENCE = '`'.repeat(3);
const POINTED = 'Ruling(binding): the guard is containment — a hostile agent has other ways — cost: false safety · hooks/omelette-guard.mjs:12 · `NOT a security boundary`';

test('harvestBindings: every Ruling(binding): line, handoff blocks included; fenced code and an inline-quoted marker are not rulings; the date is the line\'s own', () => {
  const text = [
    '# ledger 1.9.0', 'branch: feat/1.9.0', '',
    '- 2026-10-01 T1 done. Ruling: plain rulings stay in the ledger — they bind one plan — cost: none',
    `- 2026-10-02 ${POINTED}`,
    'Ruling(binding): undated — the sweep dates it — cost: a wrong day',
    '- 2026-10-03 the vocabulary is `Ruling(binding):` — quoted, not a ruling',
    `${FENCE}md`, 'Ruling(binding): inside a fence — an example — cost: none', FENCE,
    '## Handoff 2026-10-04',
    '- 2026-10-04 Rulings: (1) Ruling(binding): a handoff block counts too — it is a ledger line — cost: none',
  ].join('\r\n');
  assert.deepEqual(harvestBindings(text), [
    { ruling: POINTED, date: '2026-10-02' },
    { ruling: 'Ruling(binding): undated — the sweep dates it — cost: a wrong day', date: null },
    { ruling: 'Ruling(binding): a handoff block counts too — it is a ledger line — cost: none', date: '2026-10-04' },
  ]);
});

test('registerLine: a trailing pointer moves to the front in check\'s grammar; without one the line is prose to check', () => {
  const pointed = registerLine({ ruling: POINTED, date: '2026-10-02', plan: '1.9.0' });
  assert.equal(pointed, '- hooks/omelette-guard.mjs:12 · `NOT a security boundary` · 2026-10-02 · 1.9.0 · Ruling(binding): the guard is containment — a hostile agent has other ways — cost: false safety');
  assert.deepEqual(parsePointers(pointed), [{ line: 1, path: 'hooks/omelette-guard.mjs', lineNo: 12, fragment: 'NOT a security boundary' }]);
  const plain = registerLine({ ruling: 'Ruling(binding): undated — the sweep dates it — cost: a wrong day', date: '2026-11-02', plan: '1.9.0' });
  assert.equal(plain, '- 2026-11-02 · 1.9.0 · Ruling(binding): undated — the sweep dates it — cost: a wrong day');
  assert.deepEqual(parsePointers(plain), [], 'neither a pointer nor a malformed one');
  assert.equal(
    registerLine({ ruling: 'Ruling(binding): x — y — z · `core/a.mjs:3` · `const a = 1;`', date: '2026-11-02', plan: 'p' }),
    '- core/a.mjs:3 · `const a = 1;` · 2026-11-02 · p · Ruling(binding): x — y — z',
    'a backticked path:line is the same pointer',
  );
});

test('readRegisterPath: .omelette/decisions.md, or the file its first line names', () => {
  const p = project({ git: false });
  const own = { path: join(p.dir, '.omelette', 'decisions.md'), rel: '.omelette/decisions.md', via: null };
  assert.deepEqual(readRegisterPath(p.dir), own, 'absent: the default, created by the first sweep that has a line');
  p.write('.omelette/decisions.md', '- 2026-11-01 · p · Ruling(binding): a — b — c\n');
  assert.deepEqual(readRegisterPath(p.dir), own);
  p.write('docs/.keep', '');
  for (const first of ['register: docs/DECISIONS.md\n', 'register:   docs/DECISIONS.md  \r\n', '﻿register: ./docs/DECISIONS.md\n']) {
    p.write('.omelette/decisions.md', first);
    assert.deepEqual(readRegisterPath(p.dir), { path: join(p.dir, 'docs', 'DECISIONS.md'), rel: 'docs/DECISIONS.md', via: '.omelette/decisions.md' }, JSON.stringify(first));
  }
});

test('readRegisterPath: anything but a relative path to a file inside the project is refused, naming why', { skip: process.platform === 'win32' && 'POSIX paths and symlinks' }, () => {
  const p = project({ git: false });
  const outside = mkdtempSync(join(tmpdir(), 'omelette-outside-'));
  writeFileSync(join(outside, 'x.md'), 'theirs\n');
  p.write('docs/real.md', 'ours\n');
  symlinkSync(join(outside, 'x.md'), join(p.dir, 'docs', 'link.md'));
  symlinkSync(outside, join(p.dir, 'away'));
  mkdirSync(join(p.dir, 'docs', 'dir.md'));
  for (const [value, shown, reason] of [
    ['', '(nothing)', 'empty'],
    ['/etc/passwd', '/etc/passwd', 'absolute path'],
    ['../x.md', '../x.md', 'contains ..'],
    ['docs/../../x.md', 'docs/../../x.md', 'contains ..'],
    ['.omelette/decisions.md', '.omelette/decisions.md', 'points at itself'],
    ['nowhere/x.md', 'nowhere/x.md', 'its directory does not exist'],
    ['away/x.md', 'away/x.md', 'outside the project'],
    ['docs/link.md', 'docs/link.md', 'a symlink'],
    ['docs/dir.md', 'docs/dir.md', 'not a regular file'],
  ]) {
    p.write('.omelette/decisions.md', `register: ${value}\n`);
    assert.deepEqual(readRegisterPath(p.dir), { error: `register: ${shown} refused (${reason})` }, value);
  }
  rmSync(join(p.dir, '.omelette', 'decisions.md'));
  symlinkSync(join(outside, 'x.md'), join(p.dir, '.omelette', 'decisions.md'));
  assert.deepEqual(readRegisterPath(p.dir), { error: 'register: .omelette/decisions.md is not a regular file' });
});
