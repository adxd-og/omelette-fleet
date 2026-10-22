/**
 * omelette-fleet :: test/tester-0.3.7-m5-m6-extra.test.mjs
 *
 * Extra coverage for the uncommitted M5 (merge policy is config) and M6 (the
 * small-change lane) work in docs/superpowers/specs/2026-09-10-0.3.7-design.md,
 * on top of what test/cli.test.mjs, test/config.test.mjs and test/rules.test.mjs
 * already added for the same change. The gap this file closes: the spec
 * promises the `gh` branch-protection probe is "bounded at 5 s" and "silent on
 * any failure". Every other test only exercises a `gh` that answers
 * immediately (success or a non-zero exit) — none exercises a `gh` that never
 * answers at all, so the timeout path itself was never driven.
 *
 * Nothing here edits core/*.mjs, bin/omelette-fleet.mjs or any implementer
 * test — only this new file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-m5m6-'));
}

const doctorIn = (proj, dir, env = {}, timeout) => spawnSync(process.execPath, [BIN, 'doctor'], {
  cwd: proj,
  encoding: 'utf8',
  timeout,
  env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
});

// ─── the gh probe is bounded, not merely "answers eventually" ───────────

test('doctor bounds the gh branch-protection probe near 5s and stays silent when gh never answers', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  // A `gh` that logs its argv (proof it was actually spawned) and then hangs
  // forever instead of exiting — the one shape none of the implementer's own
  // tests drove through the hard-kill timer.
  const bindir = join(dir, 'gh-hang');
  mkdirSync(bindir, { recursive: true });
  const ghPath = join(bindir, 'gh');
  writeFileSync(ghPath, [
    `#!${process.execPath}`,
    `require('fs').appendFileSync(${JSON.stringify(join(dir, 'gh.log'))}, process.argv.slice(2).join(' ') + '\\n');`,
    'setTimeout(() => {}, 30000);',
  ].join('\n'));
  chmodSync(ghPath, 0o755);

  const start = Date.now();
  const r = doctorIn(proj, dir, { PATH: bindir }, 15000);
  const elapsed = Date.now() - start;
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  assert.match(r.stdout, /^merge policy {2}session \(config; no rules file\)$/m, r.stdout);
  assert.doesNotMatch(r.stdout, /PR-gated/, 'a hung gh must never be read as a positive answer');
  assert.equal(readFileSync(join(dir, 'gh.log'), 'utf8').trim(), 'api repos/{owner}/{repo}/branches/main/protection');
  // The floor says the hard-kill timer fired (an instant failure path returns
  // in well under a second). No ceiling: a regression to an unbounded wait is
  // caught by the 15 s spawnSync timeout above, which fails `r.status === 0`.
  assert.ok(elapsed >= 3000, `returned too fast for the 5s bound to have fired: ${elapsed}ms`);
});
