/**
 * omelette-fleet :: test/ledger-1.7.3.test.mjs
 * 1.7.3 spec, "The model": a ledger's header names its branch; open while the
 * branch exists, closed once it is gone, standing on main, untracked without
 * a header; `ledger open` writes the header from the current branch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_TIMEOUT_MS, classifyLedger, listLedgers, openLedger, parseLedgerHeader } from '../core/ledger.mjs';
import { GIT_SKIP, ledger, project } from './fixtures/ledger-1.7.3.mjs';

test('parseLedgerHeader: the first branch: line among the first 20, LF or CRLF; none, a late one or a bad name is null', () => {
  assert.equal(parseLedgerHeader('# ledger 1.9.0\nbranch: feat/1.9.0\n'), 'feat/1.9.0');
  assert.equal(parseLedgerHeader('# ledger\r\nbranch: feat/x  \r\n'), 'feat/x');
  assert.equal(parseLedgerHeader('branch: main\n'), 'main');
  assert.equal(parseLedgerHeader(`${'line\n'.repeat(19)}branch: feat/x\n`), 'feat/x', 'line 20 still counts');
  assert.equal(parseLedgerHeader(`${'line\n'.repeat(20)}branch: feat/x\n`), null, 'line 21 does not');
  assert.equal(parseLedgerHeader('# ledger\n- 2026-01-01 Ruling: x — y — z\n'), null);
  assert.equal(parseLedgerHeader('  branch: feat/x\n'), null, 'the header opens its line');
  assert.equal(parseLedgerHeader('branch: -x\nbranch: feat/x\n'), null, 'the first branch: line decides');
  for (const bad of ['-x', 'a..b', 'a//b', 'x.lock', 'x/', 'x y', '']) {
    assert.equal(parseLedgerHeader(`branch: ${bad}\n`), null, JSON.stringify(bad));
  }
  assert.equal(GIT_TIMEOUT_MS, 2000);
});

test('classifyLedger: open while the branch exists, closed once it is deleted, standing on main, untracked without a header', { skip: GIT_SKIP }, () => {
  const p = project();
  p.git(['branch', 'feat/x']);
  p.write('.omelette/ledger-x.md', ledger('feat/x'));
  p.write('.omelette/ledger-lane.md', ledger('main'));
  p.write('.omelette/ledger-old.md', '# ledger old\n');
  p.write('.omelette/archive/ledger-0.1.md', '# old\n');
  assert.deepEqual(classifyLedger(p.dir, 'ledger-x.md'), { name: 'ledger-x.md', plan: 'x', state: 'open', branch: 'feat/x' });
  assert.deepEqual(classifyLedger(p.dir, 'ledger-lane.md'), { name: 'ledger-lane.md', plan: 'lane', state: 'standing', branch: 'main' });
  assert.deepEqual(classifyLedger(p.dir, 'ledger-old.md'), { name: 'ledger-old.md', plan: 'old', state: 'untracked' });
  p.git(['branch', '-D', 'feat/x']);
  assert.deepEqual(classifyLedger(p.dir, 'ledger-x.md'), { name: 'ledger-x.md', plan: 'x', state: 'closed', branch: 'feat/x' });
  const list = listLedgers(p.dir);
  assert.deepEqual(list.ledgers.map((l) => `${l.name}:${l.state}`), ['ledger-lane.md:standing', 'ledger-old.md:untracked', 'ledger-x.md:closed']);
  assert.equal(list.archived, 1);
  assert.equal(list.error, null);
});

test('classifyLedger: outside a repository a named branch is unknown, with the reason; an untracked ledger never asks git', () => {
  const p = project({ git: false });
  p.write('.omelette/ledger-x.md', ledger('feat/x'));
  p.write('.omelette/ledger-old.md', '# old\n');
  assert.deepEqual(classifyLedger(p.dir, 'ledger-x.md'), { name: 'ledger-x.md', plan: 'x', state: 'unknown', branch: 'feat/x', error: 'not-a-repo' });
  assert.deepEqual(classifyLedger(p.dir, 'ledger-old.md', { env: { PATH: join(p.dir, 'no-such-dir') } }), { name: 'ledger-old.md', plan: 'old', state: 'untracked' });
  assert.equal(listLedgers(p.dir).error, 'not-a-repo');
});

test('openLedger: the header comes from the current branch; an existing ledger, a detached HEAD and a bad plan name are refused', { skip: GIT_SKIP }, () => {
  const p = project();
  rmSync(join(p.dir, '.omelette'), { recursive: true });
  p.git(['checkout', '-q', '-b', 'feat/1.9.0']);
  assert.deepEqual(openLedger(p.dir, '1.9.0'), { rel: '.omelette/ledger-1.9.0.md', branch: 'feat/1.9.0' });
  assert.equal(p.read('.omelette/ledger-1.9.0.md'), '# ledger 1.9.0\nbranch: feat/1.9.0\n\n');
  assert.deepEqual(openLedger(p.dir, '1.9.0'), { error: '.omelette/ledger-1.9.0.md exists' });
  assert.equal(p.read('.omelette/ledger-1.9.0.md'), '# ledger 1.9.0\nbranch: feat/1.9.0\n\n', 'never overwritten');
  p.git(['checkout', '-q', '--detach']);
  assert.deepEqual(openLedger(p.dir, '2.0.0'), { error: "HEAD is detached — check out the plan's branch first" });
  assert.equal(existsSync(join(p.dir, '.omelette', 'ledger-2.0.0.md')), false);
  for (const bad of ['../x', 'a/b', '', '-x', '.x']) assert.match(openLedger(p.dir, bad).error, /^plan name /, JSON.stringify(bad));
});
