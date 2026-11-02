/**
 * omelette-fleet :: test/hooks-wiring-1.7.3.test.mjs
 * 1.7.3 spec, Non-goals: the snippet's SessionStart widens to every source; an
 * install still matched on `compact` keeps working there, and doctor says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'omelette-fleet.mjs');

test('doctor: a SessionStart matched on compact alone is still wired, and a line of its own names the sources it misses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-wiring-173-'));
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  const gone = join(dir, 'no-such-cli');
  const env = { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone };
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: proj, encoding: 'utf8', env });
  const written = run(['rules', '--hooks']);
  assert.equal(written.status, 0, written.stderr);
  const lines = written.stdout.split('\n');
  const at = lines.indexOf('{ "hooks": {');
  const snippet = JSON.parse(lines.slice(at, at + 4).join('\n'));
  assert.equal('matcher' in snippet.hooks.SessionStart[0], false, 'the printed snippet fires SessionStart on every source');
  const settings = join(proj, '.claude', 'settings.json');
  for (const [matcher, missing] of [
    ['compact', 'startup, resume, clear'],
    ['startup|compact', 'resume, clear'],
    ['startup|resume|clear|compact', null],
    ['*', null],
    [undefined, null],
  ]) {
    const group = { ...(matcher === undefined ? {} : { matcher }), hooks: snippet.hooks.SessionStart[0].hooks };
    writeFileSync(settings, JSON.stringify({ hooks: { ...snippet.hooks, SessionStart: [group] } }));
    const out = run(['doctor']).stdout;
    assert.match(out, /^hooks {9}project: v\S+ \(wired: PreToolUse, PreCompact, SessionStart\)/m, `${matcher}: still wired`);
    if (missing) assert.match(out, new RegExp(`^ {14}project SessionStart misses ${missing} — replace the SessionStart group with the snippet from omelette-fleet rules --hooks$`, 'm'), `${matcher}`);
    else assert.doesNotMatch(out, /SessionStart misses/, `${matcher}`);
  }
});
