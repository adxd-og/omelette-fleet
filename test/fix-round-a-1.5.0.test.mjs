/**
 * omelette-fleet :: test/fix-round-a-1.5.0.test.mjs
 * 1.5.0 fix round A — the review findings, each pinned:
 *
 *   - a guard rendered before 1.5.0 carries the four-key handoff literal and
 *     still nudges, gates and summarises: `parseHookHandoff` says `legacy`, and
 *     doctor's handoff line says so instead of "stamp and print";
 *   - a scope with no guard of its own whose settings still call a guard on a
 *     retired event names that event on its `absent` label;
 *   - `check`'s usage errors and `results`' paths and argument errors print
 *     control and bidi characters as escapes, never raw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES, parseHookHandoff, renderHookFile } from '../core/rules.mjs';
import { createResultStore } from '../core/results.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** The CLI in a sandbox of its own: OMELETTE_HOME and HOME are `dir`, cwd is `cwd` (default `dir`). */
function cli(args, { dir, cwd = dir, env = {} }) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// What a 1.4.0 `rules --hooks` rendered, byte for byte.
const LITERAL_1_4_0 = 'const HANDOFF_CONFIG = {"enabled":false,"threshold":85,"contextWindow":500000,"compactSummary":true};';

/** A rendered 1.5.0 guard with its handoff literal swapped for the 1.4.0 one — our marker kept. */
function guard140() {
  const lines = renderHookFile(HOOK_FILES[0], '1.4.0').split('\n');
  const at = lines.findIndex((l) => l.startsWith('const HANDOFF_CONFIG = '));
  assert.ok(at >= 0, 'the rendered guard carries its handoff literal on a line of its own');
  lines[at] = LITERAL_1_4_0;
  return lines.join('\n');
}

test('parseHookHandoff: a 1.5.0 literal is not legacy; a literal carrying any retired key is', () => {
  assert.deepEqual(parseHookHandoff(renderHookFile(HOOK_FILES[0], '1.5.0', { enabled: true })), { enabled: true, legacy: false });
  assert.deepEqual(parseHookHandoff(renderHookFile(HOOK_FILES[0], '1.5.0', { enabled: false })), { enabled: false, legacy: false });
  assert.deepEqual(parseHookHandoff(guard140()), { enabled: false, legacy: true });
  for (const key of ['threshold', 'contextWindow', 'compactSummary']) {
    const text = `const HANDOFF_CONFIG = {"enabled":true,"${key}":1};\n`;
    assert.deepEqual(parseHookHandoff(text), { enabled: true, legacy: true }, key);
  }
  assert.equal(parseHookHandoff('no literal here'), null);
});

test('doctor: a guard rendered before 1.5.0 reads as the 1.4.0 guard it is, not as "stamp and print off"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fixa-legacy-'));
  const proj = join(dir, 'proj');
  mkdirSync(join(proj, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'hooks', HOOK_FILES[0]), guard140());
  mkdirSync(join(proj, '.omelette'));
  writeFileSync(join(proj, '.omelette', 'ledger-x.md'), '# x\n');
  const r = cli(['doctor'], { dir, cwd: proj });
  assert.match(r.out, /^handoff {7}pre-1\.5\.0 guard — run rules --hooks; until then it nudges, gates and summarises as 1\.4\.0 did · ledgers: 1$/m, r.out);
  assert.doesNotMatch(r.out, /stamp and print/, r.out);
});

test('doctor: no project guard, a global one, and project settings calling it on Stop — the absent label names Stop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fixa-absent-'));
  const proj = join(dir, 'proj');
  mkdirSync(join(proj, '.claude'), { recursive: true });
  const g = cli(['rules', '--global', '--hooks'], { dir, cwd: proj });
  assert.equal(g.code, 0, g.err);
  const globalGuard = join(dir, '.claude', 'hooks', HOOK_FILES[0]);
  writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `node '${globalGuard}'` }] }] },
  }));
  const r = cli(['doctor'], { dir, cwd: proj });
  assert.match(r.out, /^hooks {9}project: absent \(Stop wired but no longer used — remove them from your settings files\) · global: /m, r.out);
});

/** Nothing a terminal would act on: C0 but tab and newline, DEL, C1, and the RLO override. */
function assertNoRaw(text, label) {
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‮]/u, `${label}: ${JSON.stringify(text)}`);
}

const HOSTILE = 'x\u001b[2K‮';

test('check: the file name, an extra positional, --require and --root echo escaped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-fixa-check-'));
  const cases = [
    { args: ['check', `${HOSTILE}.md`], label: 'nonexistent file' },
    { args: ['check', 'a.md', HOSTILE], label: 'extra positional' },
    { args: ['check', 'a.md', '--require', HOSTILE], label: '--require' },
    { args: ['check', 'a.md', '--root', join(dir, HOSTILE)], label: '--root' },
  ];
  for (const { args, label } of cases) {
    const r = cli(args, { dir });
    assert.equal(r.code, 2, `${label}: ${r.err}`);
    assert.ok(r.err.includes('\\u001b'), `${label}: ${r.err}`);
    assert.ok(r.err.includes('\\u202e'), `${label}: ${r.err}`);
    assertNoRaw(r.err, label);
    assertNoRaw(r.out, label);
  }
});

test('results: argument errors, spool paths and missing-result lines echo escaped', () => {
  const base = mkdtempSync(join(tmpdir(), 'omelette-fixa-results-'));
  const home = join(base, `home${HOSTILE}`);
  mkdirSync(home);
  const env = { OMELETTE_HOME: home };
  const run = (args) => cli(args, { dir: base, env });
  const escaped = (r, label) => {
    const both = r.out + r.err;
    assert.ok(both.includes('\\u001b') && both.includes('\\u202e'), `${label}: ${both}`);
    assertNoRaw(r.out, label);
    assertNoRaw(r.err, label);
  };

  escaped(run(['results', HOSTILE]), 'unknown unit');
  escaped(run(['results', 'grok', HOSTILE]), 'not a result id');
  escaped(run(['results', 'grok', '20260908T142501Z-19312-1', HOSTILE]), 'unexpected argument');
  escaped(run(['results', '--stats', '--since', HOSTILE]), '--since');

  const empty = run(['results']);
  assert.equal(empty.code, 0, empty.err);
  assert.match(empty.out, /^\(no results spooled yet — /m);
  escaped(empty, 'empty spool');

  const missing = run(['results', 'grok', '20260908T142501Z-19312-1']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no spooled result "20260908T142501Z-19312-1" for grok in /);
  escaped(missing, 'missing id');

  createResultStore({ home, unit: 'grok' }).write({
    resultId: '20260908T142501Z-19312-2', tool: 'grok_research', model: 'm', effort: 'high',
    startedAt: '2026-09-08T14:25:01.000Z', endedAt: '2026-09-08T14:26:01.000Z', durationMs: 60000,
    status: 'ok', partial: false, detached: false, cwd: '/tmp/p', promptPreview: 'p', text: 'answer\n',
  });
  // `--path` stays raw by ruling: it prints a path a script opens next, not a
  // line for a human — test/tester-1.5.0-t4.test.mjs pins that.
  const one = run(['results', 'grok', '20260908T142501Z-19312-2', '--path']);
  assert.equal(one.code, 0, one.err);
  assert.ok(one.out.includes('\u202e'), 'the single-result --path prints the raw path');
  const list = run(['results', '--path']);
  assert.equal(list.code, 0, list.err);
  assert.ok(list.out.includes('\u202e'), 'the listing --path prints the raw path');
});
