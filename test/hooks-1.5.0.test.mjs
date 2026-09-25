/**
 * omelette-fleet :: test/hooks-1.5.0.test.mjs
 * 1.5.0 — the guard serves three events. The nudge, the Stop gate and the
 * compaction summary are gone with the estimator behind them; the git guard,
 * the PreCompact stamp and the SessionStart print stay. What this file proves:
 *
 *   - an operator whose settings.json still wires the old six runs the guard on
 *     `PostToolUse`, `Stop` and `PostCompact` with a real payload and gets exit
 *     0, nothing on either stream and every ledger byte for byte;
 *   - `handoff.enabled` now switches the stamp and the print, and nothing else;
 *   - `HOOK_EVENTS`, the printed snippet, `HANDOFF_SCHEMA` and the rendered
 *     literal all say three events and one key, and the retired keys warn;
 *   - `doctor` reads a six-event settings file as wired and names the three
 *     stale entries, and its `handoff` line says stamp and print.
 *
 * The guard is driven the way Claude Code drives it — a child process with the
 * event on stdin — rendered through the same `renderHookFile` that `rules
 * --hooks` uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HANDOFF_SCHEMA, handoffSettings } from '../core/config.mjs';
import { HOOK_EVENTS, HOOK_FILES, RETIRED_HOOK_EVENTS, hookSettingsSnippet, parseHookHandoff, renderHookFile } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/**
 * A throwaway project: the guard rendered with `handoff` into its
 * `.claude/hooks/`, one ledger holding a handoff block, and a transcript whose
 * last usage record is 95 % of Claude Code's 200 000 default — past the old
 * threshold, so a guard that still measured would nudge and gate here.
 */
function project(handoff = { enabled: true }) {
  const cwd = mkdtempSync(join(tmpdir(), 'omelette-1.5.0-'));
  const hooks = join(cwd, '.claude', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const guardPath = join(hooks, HOOK_FILES[0]);
  writeFileSync(guardPath, renderHookFile(HOOK_FILES[0], '1.5.0-test', handoff));
  mkdirSync(join(cwd, '.omelette'));
  const ledgerPath = join(cwd, '.omelette', 'ledger-x.md');
  writeFileSync(ledgerPath, '# ledger x\n\n## Handoff\nwhere the work stands: T1 in review\n');
  const transcript = join(cwd, 'transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', usage: { input_tokens: 40, cache_creation_input_tokens: 960, cache_read_input_tokens: 189000, output_tokens: 300 } },
  })}\n`);
  return { cwd, guardPath, ledgerPath, transcript };
}

/** One hook invocation: the event on stdin, the answer as code/stdout/stderr. HOME is the throwaway project. */
function runGuard(event, { cwd, guardPath }) {
  const r = spawnSync(process.execPath, [guardPath], {
    input: JSON.stringify(event), encoding: 'utf8', cwd, timeout: 20000,
    env: { PATH: process.env.PATH, HOME: cwd },
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/** The CLI in a sandbox of its own: OMELETTE_HOME and HOME are `dir`, cwd is `cwd` (default `dir`). */
function cli(args, { dir, cwd = dir, env = {} }) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('the three retired events exit 0 with nothing on stdout or stderr and touch no ledger', () => {
  const p = project({ enabled: true });
  const { cwd, transcript } = p;
  const before = readFileSync(p.ledgerPath, 'utf8');
  for (const ev of [
    { hook_event_name: 'PostToolUse', session_id: 's1', cwd, transcript_path: transcript, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'x' },
    { hook_event_name: 'Stop', session_id: 's1', cwd, transcript_path: transcript, stop_hook_active: false },
    { hook_event_name: 'PostCompact', session_id: 's1', cwd, transcript_path: transcript, trigger: 'manual', compact_summary: '## Handoff\nplanted' },
  ]) {
    const r = runGuard(ev, p);
    assert.equal(r.code, 0, ev.hook_event_name);
    assert.equal(r.out, '', ev.hook_event_name);
    assert.equal(r.err, '', ev.hook_event_name);
  }
  assert.equal(readFileSync(p.ledgerPath, 'utf8'), before);
  assert.deepEqual(readFileSync(join(cwd, '.omelette', 'ledger-x.md')), Buffer.from(before), 'byte for byte');
});

test('handoff.enabled=false renders a guard that neither stamps on PreCompact nor prints on SessionStart(compact)', () => {
  const p = project({ enabled: false });
  const { cwd } = p;
  const before = readFileSync(p.ledgerPath, 'utf8');
  const pre = runGuard({ hook_event_name: 'PreCompact', session_id: 's1', cwd, trigger: 'manual' }, p);
  assert.equal(pre.code, 0);
  assert.equal(pre.out, '');
  assert.equal(pre.err, '');
  assert.equal(readFileSync(p.ledgerPath, 'utf8'), before);
  const start = runGuard({ hook_event_name: 'SessionStart', session_id: 's1', cwd, source: 'compact' }, p);
  assert.equal(start.code, 0);
  assert.equal(start.out, '');
  assert.equal(start.err, '');
});

test('handoff.enabled=false leaves the git guard exactly as it was', () => {
  const p = project({ enabled: false });
  const r = runGuard({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: 'omelette-coder', tool_input: { command: 'git commit -m x' },
  }, p);
  assert.equal(r.code, 2);
  assert.match(r.err, /^omelette-coder never commits/);
});

test('handoff.enabled=true (the default) still stamps and still prints', () => {
  const p = project({ enabled: true });
  const { cwd } = p;
  const pre = runGuard({ hook_event_name: 'PreCompact', session_id: 's1', cwd, trigger: 'manual' }, p);
  assert.match(pre.out, /^HANDOFF: re-read \.omelette\/ledger-\*\.md before continuing\.\n$/);
  assert.match(readFileSync(p.ledgerPath, 'utf8'), /\n## Compaction \S+ \(trigger: manual\) — re-read this ledger before continuing\n/);
  const start = runGuard({ hook_event_name: 'SessionStart', session_id: 's1', cwd, source: 'compact' }, p);
  assert.match(start.out, /## Handoff/);
  assert.match(start.out, /^--- ledger-x\.md · last handoff ---$/m);
});

test('the guard file carries none of the estimator', () => {
  const text = readFileSync(join(ROOT, 'hooks', 'omelette-guard.mjs'), 'utf8');
  for (const gone of ['handoff-state.json', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'autoCompactWindow', 'cache_read_input_tokens', 'Compaction summary', 'stop_hook_active', 'function postToolUse', 'function stop(', 'function postCompact']) {
    assert.ok(!text.includes(gone), `still present: ${gone}`);
  }
  assert.match(text, /^const HANDOFF_CONFIG = \{\{handoff\}\};$/m);
});

test('HOOK_EVENTS is three, RETIRED_HOOK_EVENTS is the other three, and the snippet lists exactly the first three', () => {
  assert.deepEqual(HOOK_EVENTS, ['PreToolUse', 'PreCompact', 'SessionStart']);
  assert.deepEqual(RETIRED_HOOK_EVENTS, ['PostToolUse', 'Stop', 'PostCompact']);
  const snippet = JSON.parse(hookSettingsSnippet('/x/omelette-guard.mjs', 'linux').join('\n'));
  assert.deepEqual(Object.keys(snippet.hooks), ['PreToolUse', 'PreCompact', 'SessionStart']);
  assert.equal(snippet.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(snippet.hooks.SessionStart[0].matcher, 'compact');
  assert.equal(snippet.hooks.PreCompact[0].matcher, undefined);
});

test('HANDOFF_SCHEMA is one key; the rendered literal is {"enabled":true}; retired keys warn and are ignored', () => {
  assert.deepEqual(Object.keys(HANDOFF_SCHEMA), ['enabled']);
  assert.match(renderHookFile(HOOK_FILES[0], '1.5.0', { enabled: true, threshold: 85, contextWindow: 500000, compactSummary: false }),
    /^const HANDOFF_CONFIG = \{"enabled":true\};$/m);
  assert.deepEqual(parseHookHandoff('const HANDOFF_CONFIG = {"enabled":false,"threshold":85};'), { enabled: false, legacy: true });

  // A fleet.config.json written by 1.4.0 still carries the three retired keys.
  const home = mkdtempSync(join(tmpdir(), 'omelette-1.5.0-home-'));
  writeFileSync(join(home, 'fleet.config.json'), JSON.stringify({
    version: 1, handoff: { enabled: true, threshold: 85, contextWindow: 0, compactSummary: true },
  }));
  const s = handoffSettings({ OMELETTE_HOME: home });
  assert.equal(s.enabled, true);
  assert.deepEqual(Object.keys(s.sources), ['enabled']);
  assert.deepEqual(s.warnings.slice().sort(), [
    'fleet config: handoff.compactSummary is not a known key — ignored',
    'fleet config: handoff.contextWindow is not a known key — ignored',
    'fleet config: handoff.threshold is not a known key — ignored',
  ]);
  // …and the guard rendered from it carries the one key.
  assert.match(renderHookFile(HOOK_FILES[0], '1.5.0', s), /^const HANDOFF_CONFIG = \{"enabled":true\};$/m);
});

test('set handoff.threshold=85 is refused naming the one known key; set handoff.enabled=off is accepted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-1.5.0-set-'));
  for (const key of ['threshold=85', 'contextWindow=0', 'compactSummary=false']) {
    const r = cli(['set', `handoff.${key}`], { dir });
    assert.equal(r.code, 1, key);
    assert.match(r.err, new RegExp(`unknown key "${key.split('=')[0]}" for the handoff block — known keys: enabled$`, 'm'), key);
  }
  const on = cli(['set', 'handoff.enabled=off'], { dir });
  assert.equal(on.code, 0, on.err);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8')).handoff, { enabled: false });
});

/**
 * A project that is done in every way `nextStep` asks about — registered here,
 * every managed file ours — so the only thing left to read on the `hooks` line
 * is how its settings wire the guard.
 */
function finishedProject() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-1.5.0-doctor-'));
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const gone = join(dir, 'no-such-cli');
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({
    version: 1, units: { gemini: { enabled: false }, grok: { enabled: false }, codex: { enabled: false } },
  }));
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { 'omelette-codex': { command: 'node', args: [join(ROOT, 'servers', 'codex.mjs')] } },
  }));
  const written = cli(['rules', '--agents', '--hooks'], { dir, cwd: proj });
  assert.equal(written.code, 0, written.err);
  const env = { AGY_BIN: gone, GROK_BIN: gone, CODEX_BIN: gone };
  return { dir, proj, env, guard: join(proj, '.claude', 'hooks', HOOK_FILES[0]) };
}

test('doctor: a settings.json that still wires the six events reads as wired, and names the three stale entries', () => {
  const { dir, proj, env, guard } = finishedProject();
  const command = `node '${guard}'`;
  const entry = (matcher) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] }];
  // Exactly what `rules --hooks` printed from 0.3.7 to 1.4.0.
  const six = { hooks: {
    PreToolUse: entry('Bash'), PreCompact: entry(), SessionStart: entry('compact'),
    PostToolUse: entry(), Stop: entry(), PostCompact: entry(),
  } };
  const settings = join(proj, '.claude', 'settings.json');
  writeFileSync(settings, JSON.stringify(six, null, 2));
  const r = cli(['doctor'], { dir, cwd: proj, env });
  assert.match(r.out, /^hooks {9}project: v\S+ \(wired: PreToolUse, PreCompact, SessionStart · PostToolUse, Stop, PostCompact wired but no longer used — remove them from your settings files\)/m, r.out);
  assert.doesNotMatch(r.out, /^next /m, r.out);
  assert.equal(readFileSync(settings, 'utf8'), JSON.stringify(six, null, 2), 'settings.json is READ, never written');

  // The three it prints today read as wired with nothing stale to name.
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: six.hooks.PreToolUse, PreCompact: six.hooks.PreCompact, SessionStart: six.hooks.SessionStart } }));
  const clean = cli(['doctor'], { dir, cwd: proj, env });
  assert.match(clean.out, /^hooks {9}project: v\S+ \(wired: PreToolUse, PreCompact, SessionStart\) · global: absent$/m, clean.out);

  // A stale entry on a guard that is NOT fully wired rides inside the same parentheses.
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: six.hooks.PreToolUse, Stop: six.hooks.Stop } }));
  const half = cli(['doctor'], { dir, cwd: proj, env });
  assert.match(half.out, /^hooks {9}project: v\S+ \(NOT wired \(missing PreCompact, SessionStart\) — paste the snippet from rules --hooks · Stop wired but no longer used — remove them from your settings files\)/m, half.out);
});

test('doctor: the handoff line says stamp and print, and counts ledgers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-1.5.0-handoff-'));
  const on = join(dir, 'on'); mkdirSync(join(on, '.omelette'), { recursive: true });
  writeFileSync(join(on, '.omelette', 'ledger-x.md'), '# x\n');
  assert.equal(cli(['rules', '--hooks'], { dir, cwd: on }).code, 0);
  assert.match(cli(['doctor'], { dir, cwd: on }).out, /^handoff {7}stamp and print on · ledgers: 1$/m);

  const off = join(dir, 'off'); mkdirSync(join(off, '.omelette'), { recursive: true });
  writeFileSync(join(off, '.omelette', 'ledger-x.md'), '# x\n');
  assert.equal(cli(['set', 'handoff.enabled=false'], { dir }).code, 0);
  assert.equal(cli(['rules', '--hooks'], { dir, cwd: off }).code, 0);
  assert.match(cli(['doctor'], { dir, cwd: off }).out, /^handoff {7}stamp and print off \(handoff\.enabled=false\) · ledgers: 1$/m);
});
