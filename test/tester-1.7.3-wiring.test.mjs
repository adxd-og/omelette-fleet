/**
 * omelette-fleet :: test/tester-1.7.3-wiring.test.mjs
 * Task 9 (1.7.3): what the coder's wiring test leaves open — when doctor stays
 * silent about a compact-only SessionStart (foreign / absent guard, union of the
 * two files, global scope), a matcher that never covers compact, and the exit code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'omelette-fleet.mjs');

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-tester-wiring-173-'));
  const proj = join(dir, 'proj');
  const claude = join(dir, 'claudehome');
  mkdirSync(proj);
  const gone = join(dir, 'no-such-cli');
  const env = { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, CLAUDE_CONFIG_DIR: claude, OMELETTE_UPDATE_CHECK: '0', AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone };
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: proj, encoding: 'utf8', env, timeout: 60000 });
  const snip = (args) => {
    const w = run(args);
    assert.equal(w.status, 0, w.stderr);
    const lines = w.stdout.split('\n');
    const at = lines.indexOf('{ "hooks": {');
    return JSON.parse(lines.slice(at, at + 5).join('\n'));
  };
  return { dir, proj, claude, run, snip };
}

const withSession = (snippet, group) => JSON.stringify({ hooks: { ...snippet.hooks, SessionStart: [{ ...group, hooks: snippet.hooks.SessionStart[0].hooks }] } });
const MISSES = /SessionStart misses/;

test('doctor: no misses line for a foreign or absent guard, however the matcher reads', () => {
  const w = world();
  try {
    const snippet = w.snip(['rules', '--hooks']);
    const settings = join(w.proj, '.claude', 'settings.json');
    writeFileSync(settings, withSession(snippet, { matcher: 'compact' }));
    assert.match(w.run(['doctor']).stdout, /^ {14}project SessionStart misses startup, resume, clear — /m, 'control: ours, compact only');
    const guard = join(w.proj, '.claude', 'hooks', 'omelette-guard.mjs');
    // foreign: a script of the same name without our marker
    writeFileSync(guard, '// somebody else\n');
    const foreign = w.run(['doctor']).stdout;
    assert.match(foreign, /^hooks {9}project: foreign/m, foreign);
    assert.doesNotMatch(foreign, MISSES, foreign);
    // absent: the script gone, the settings still calling it
    rmSync(guard);
    const absent = w.run(['doctor']).stdout;
    assert.doesNotMatch(absent, MISSES, absent);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('doctor: the misses line is judged on the union of the scope\'s two settings files', () => {
  const w = world();
  try {
    const snippet = w.snip(['rules', '--hooks']);
    const claude = join(w.proj, '.claude');
    writeFileSync(join(claude, 'settings.json'), withSession(snippet, { matcher: 'compact' }));
    writeFileSync(join(claude, 'settings.local.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup|resume|clear', hooks: snippet.hooks.SessionStart[0].hooks }] } }));
    const both = w.run(['doctor']).stdout;
    assert.match(both, /^hooks {9}project: v\S+ \(wired: PreToolUse, PreCompact, SessionStart, SubagentStop\)/m, both);
    assert.doesNotMatch(both, MISSES, both);
    // the second file narrower: only `resume` — the union still misses startup and clear
    writeFileSync(join(claude, 'settings.local.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'resume', hooks: snippet.hooks.SessionStart[0].hooks }] } }));
    assert.match(w.run(['doctor']).stdout, /^ {14}project SessionStart misses startup, clear — /m);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('doctor: a regex-ish matcher is judged source by source, like every other matcher', () => {
  const w = world();
  try {
    const snippet = w.snip(['rules', '--hooks']);
    const settings = join(w.proj, '.claude', 'settings.json');
    for (const [matcher, missing] of [
      ['^(startup|compact)$', 'resume, clear'],
      ['.*', null],
      ['compact|clear', 'startup, resume'],
      [' startup , compact ', 'resume, clear'],
    ]) {
      writeFileSync(settings, withSession(snippet, { matcher }));
      const out = w.run(['doctor']).stdout;
      if (missing) assert.match(out, new RegExp(`^ {14}project SessionStart misses ${missing} — `, 'm'), matcher);
      else assert.doesNotMatch(out, MISSES, matcher);
    }
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('doctor: a SessionStart matcher that never covers compact gets no misses line (its own matcher finding stands)', () => {
  const w = world();
  try {
    const snippet = w.snip(['rules', '--hooks']);
    writeFileSync(join(w.proj, '.claude', 'settings.json'), withSession(snippet, { matcher: 'startup|clear' }));
    const out = w.run(['doctor']).stdout;
    assert.doesNotMatch(out, MISSES, out);
    assert.match(out, /SessionStart matcher is not compact/, out);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('doctor: the global scope names itself, and the exit code does not move with the wiring', () => {
  const w = world();
  try {
    const snippet = w.snip(['rules', '--hooks', '--global']);
    mkdirSync(w.claude, { recursive: true });
    const settings = join(w.claude, 'settings.json');
    writeFileSync(settings, withSession(snippet, { matcher: 'compact' }));
    const old = w.run(['doctor']);
    assert.match(old.stdout, /^ {14}global SessionStart misses startup, resume, clear — replace the SessionStart group with the snippet from omelette-fleet rules --hooks --global$/m, old.stdout);
    assert.doesNotMatch(old.stdout, /project SessionStart misses/);
    writeFileSync(settings, withSession(snippet, {}));
    const fresh = w.run(['doctor']);
    assert.doesNotMatch(fresh.stdout, MISSES);
    assert.equal(old.status, fresh.status, 'the misses line is a note, not a verdict');
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('doctor: two SessionStart groups in ONE file cover the union of their sources', () => {
  const w = world();
  try {
    const snippet = w.snip(['rules', '--hooks']);
    const hooks = snippet.hooks.SessionStart[0].hooks;
    const settings = join(w.proj, '.claude', 'settings.json');
    writeFileSync(settings, JSON.stringify({ hooks: { ...snippet.hooks, SessionStart: [{ matcher: 'compact', hooks }, { matcher: 'startup|resume|clear', hooks }] } }));
    const out = w.run(['doctor']).stdout;
    assert.match(out, /^hooks {9}project: v\S+ \(wired: PreToolUse, PreCompact, SessionStart, SubagentStop\)/m, out);
    assert.doesNotMatch(out, MISSES, out);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});
