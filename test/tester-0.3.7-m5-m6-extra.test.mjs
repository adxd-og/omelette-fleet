/**
 * omelette-fleet :: test/tester-0.3.7-m5-m6-extra.test.mjs
 *
 * Extra coverage for the uncommitted M5 (merge policy is config) and M6 (the
 * small-change lane) work in docs/superpowers/specs/2026-09-10-0.3.7-design.md,
 * on top of what test/cli.test.mjs, test/config.test.mjs and test/rules.test.mjs
 * already added for the same change. Three gaps this file closes:
 *
 *   1. The spec promises the `gh` branch-protection probe is "bounded at 5 s"
 *      and "silent on any failure". Every existing test only exercises a `gh`
 *      that answers immediately (success or a non-zero exit) — none exercises
 *      a `gh` that never answers at all, so the timeout path itself was never
 *      driven.
 *   2. `workflow.merge` joined `set`'s existing all-or-nothing validation
 *      (parse errors are collected before anything is written), but no test
 *      combines a valid `workflow.<key>` assignment with an invalid assignment
 *      of another kind in the same command to prove the new block does not
 *      leak a partial write.
 *   3. The spec's own "Docs" line names CONFIG, README, ORCHESTRATION + rules
 *      template, and CHANGELOG as required reading for M5/M6. rules.test.mjs
 *      checks the RENDERED rules file; nothing checks the doc files themselves
 *      (or the CHANGELOG) for the promised content.
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

function cli(args, { dir, env = {}, timeout } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    timeout,
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const doctorIn = (proj, dir, env = {}, timeout) => spawnSync(process.execPath, [BIN, 'doctor'], {
  cwd: proj,
  encoding: 'utf8',
  timeout,
  env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
});

// ─── 1. the gh probe is bounded, not merely "answers eventually" ───────────

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
  // Long enough that this only passes if the hard-kill timer actually fired
  // (an instant failure path would return in well under a second); short
  // enough that a regression to an unbounded wait fails the suite instead of
  // silently hanging it forever (the 15s spawnSync timeout is the backstop).
  assert.ok(elapsed >= 3000, `returned too fast for the 5s bound to have fired: ${elapsed}ms`);
  assert.ok(elapsed < 12000, `took far longer than the documented 5s bound: ${elapsed}ms`);
});

// ─── 2. workflow.merge shares set's existing all-or-nothing guarantee ──────

test('set: an invalid unit assignment in the same command blocks an otherwise-valid workflow.merge — nothing is written', () => {
  const dir = home();
  assert.equal(cli(['set', 'workflow.merge=pr'], { dir }).code, 0);
  const before = readFileSync(join(dir, 'fleet.config.json'), 'utf8');
  assert.equal(JSON.parse(before).workflow.merge, 'pr');

  const r = cli(['set', 'workflow.merge=session', 'codex.timeoutS=not-a-number'], { dir });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /invalid value for codex\.timeoutS/);
  assert.equal(
    readFileSync(join(dir, 'fleet.config.json'), 'utf8'),
    before,
    'a batch with one invalid assignment must write NEITHER key, including the otherwise-valid workflow one',
  );

  // And the reverse: a bad workflow key alongside a good unit key.
  const r2 = cli(['set', 'workflow.merge=nonsense', 'codex.timeoutS=42'], { dir });
  assert.equal(r2.code, 1, r2.out + r2.err);
  assert.match(r2.err, /invalid value for workflow\.merge/);
  assert.equal(
    readFileSync(join(dir, 'fleet.config.json'), 'utf8'),
    before,
    'the good codex.timeoutS assignment must not land either',
  );
});

// ─── 3. the promised doc surfaces actually carry the M5/M6 content ────────

test('docs: CONFIG, README, ORCHESTRATION, the rules template and CHANGELOG all carry the merge policy and the lane', () => {
  const config = readFileSync(join(ROOT, 'docs', 'CONFIG.md'), 'utf8');
  assert.ok(config.includes('### Workflow settings'), 'CONFIG.md documents the workflow block');
  assert.ok(config.includes('`workflow.merge`'), 'CONFIG.md names the key');
  assert.ok(
    config.includes('this repository looks PR-gated: consider set workflow.merge=pr'),
    'CONFIG.md documents the hint text',
  );
  assert.ok(
    config.includes('gh api repos/{owner}/{repo}/branches/main/protection'),
    'CONFIG.md documents the exact gh endpoint used',
  );

  const orchestration = readFileSync(join(ROOT, 'docs', 'ORCHESTRATION.md'), 'utf8');
  assert.ok(orchestration.includes('`workflow.merge` in the fleet config'), 'ORCHESTRATION explains the config key');
  // Spec: "ORCHESTRATION carries both variants in one paragraph" — find the
  // single line/paragraph that mentions the branch-merge policy and assert
  // BOTH rendered sentences live inside it, not in two separate places.
  const mergeParas = orchestration.split(/\n{2,}/).filter((p) => p.includes('workflow.merge'));
  assert.equal(mergeParas.length, 1, 'exactly one paragraph should discuss workflow.merge');
  assert.ok(mergeParas[0].includes('The session merges the branch into main itself'), 'the session sentence is in that paragraph');
  assert.ok(mergeParas[0].includes('opens a pull request from the feature branch and never merges into main itself'), 'the pr sentence is in the SAME paragraph');
  assert.ok(orchestration.includes('**The small-change lane.**'), 'ORCHESTRATION mirrors the lane bullet');
  assert.ok(orchestration.includes('**What stays out of the lane.**'), 'ORCHESTRATION mirrors the stays-out bullet');

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('merge policy  session'), 'README shows the doctor line format');
  assert.ok(readme.includes('workflow.merge=pr'), 'README tells the operator how to switch it');

  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.ok(
    changelog.includes('**The merge policy is config, and the rules say what you chose.**'),
    'CHANGELOG has an 0.3.7 bullet for the merge policy',
  );
  assert.ok(changelog.includes('**The small-change lane.**'), 'CHANGELOG has an 0.3.7 bullet for the lane');

  const template = readFileSync(join(ROOT, 'rules', 'omelette-fleet.md'), 'utf8');
  assert.ok(template.includes('{{merge}}'), 'the template still carries the unrendered placeholder on disk');
  assert.ok(template.includes('**The small-change lane.**'));
  assert.ok(template.includes('**What stays out of the lane.**'));
  // The lane sits right after the exception it extends, as the spec's ordering implies.
  assert.ok(
    template.indexOf('The small-change exception') < template.indexOf('The small-change lane'),
    'the lane bullet follows the exception bullet it extends',
  );
});
