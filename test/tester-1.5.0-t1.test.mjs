/**
 * omelette-fleet :: test/tester-1.5.0-t1.test.mjs
 * Independent tester coverage for T1 ("the guard serves three events"),
 * written from docs/superpowers/specs/2026-09-25-1.5.0-process-layer-design.md
 * §"P1 — three hooks, not six" and the plan's Task T1 / Review focus items 1-2,
 * against the diff 3001062..dd5c092 (code+tests) and dd5c092..d5a88ed (docs).
 *
 * This file does NOT re-test what test/hooks-1.5.0.test.mjs, test/hooks.test.mjs,
 * test/rules.test.mjs, test/rules-size.test.mjs and test/cli.test.mjs already
 * cover well (multi-ledger PreCompact, symlink refusal, SessionStart's 40-line/
 * 4 KB/12 KB truncation with 60-line blocks and four near-4 KB ledgers, fenced
 * headings, the win32/darwin snippet, most doctor wiring permutations). It adds
 * the handful of spec claims left thin or untested in that diff:
 *
 *   - the git guard exit-2/exit-0 shape, driven through THIS file's own harness
 *     rather than importing the coder's;
 *   - the three retired events leave no trace ANYWHERE under the project, not
 *     merely a byte-identical ledger, with `trigger: auto` and a `stop_hook_active`
 *     payload as the review-focus item spells it;
 *   - `rules --hooks` actually PRINTS the three retired-key warnings on stderr
 *     (only `handoffSettings().warnings` was unit-tested in the diff);
 *   - doctor naming exactly ONE retired entry (`Stop` alone) beside a fully
 *     wired three, the case the diff's own tests approach only with two retired
 *     entries at once;
 *   - `hookSettingsSnippet` on both 'win32' and 'linux' in one assertion;
 *   - the CONFIG.md table's row count and the ORCHESTRATION/asset removal, read
 *     directly rather than inferred from the doc-map/rules-size tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES, hookSettingsSnippet, renderHookFile } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** The guard rendered exactly as `rules --hooks` would, in a throwaway dir. */
function guard(handoff) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t1-guard-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], 'tester-1.5.0', handoff));
  return path;
}

/** One hook invocation: the event on stdin, the answer as code/stdout/stderr. */
function runGuard(path, event, cwd) {
  const r = spawnSync(process.execPath, [path], {
    input: JSON.stringify(event), encoding: 'utf8', cwd, timeout: 20000,
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/** Every path under `dir`, relative and sorted, so a before/after diff names anything new. */
function walk(dir) {
  const out = [];
  const rec = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, name.name);
      out.push(relative(dir, full));
      if (name.isDirectory()) rec(full);
    }
  };
  rec(dir);
  return out;
}

/** The CLI in a sandbox of its own: OMELETTE_HOME and HOME are `dir`, cwd is `cwd` (default `dir`). */
function cli(args, { dir, cwd = dir, env = {} }) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// ─── the git guard: untouched ───────────────────────────────────────────────

test('PreToolUse: git commit and git push exit 2 naming the role; a read and a non-guarded caller pass', () => {
  const g = guard();
  const preToolUse = (over) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: 'omelette-coder', ...over });

  for (const command of ['git commit -m "wip"', 'git push origin main']) {
    const r = runGuard(g, preToolUse({ tool_input: { command } }));
    assert.equal(r.code, 2, command);
    assert.equal(r.out, '', command);
    assert.equal(
      r.err.trim(),
      'omelette-coder never commits, merges, rebases, pushes, stashes, tags, branches or opens worktrees; report instead',
      command,
    );
  }

  const read = runGuard(g, preToolUse({ tool_input: { command: 'git status' } }));
  assert.equal(read.code, 0, read.err);
  assert.equal(read.err, '');

  // The main thread carries no agent_type at all, and is nobody the guard knows.
  const unguarded = runGuard(g, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "wip"' } });
  assert.equal(unguarded.code, 0, unguarded.err);
  assert.equal(unguarded.err, '');
});

// ─── the three retired events leave no trace anywhere under the project ────

test('the three retired events, fired with realistic payloads, leave the project directory tree byte-for-byte and file-for-file identical', () => {
  const g = guard({ enabled: true });
  const proj = mkdtempSync(join(tmpdir(), 'omelette-t1-retired-'));
  mkdirSync(join(proj, '.omelette'));
  writeFileSync(join(proj, '.omelette', 'ledger-x.md'), '# ledger x\n\n## Handoff\nwhere it stands: T1 in review\n');
  const transcript = join(proj, 'transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', usage: { input_tokens: 40, cache_creation_input_tokens: 960, cache_read_input_tokens: 189000, output_tokens: 300 } },
  })}\n`);

  const before = walk(proj);
  const beforeBytes = new Map(
    before.filter((p) => statSync(join(proj, p)).isFile()).map((p) => [p, readFileSync(join(proj, p))]),
  );

  for (const ev of [
    { hook_event_name: 'PostToolUse', session_id: 's1', cwd: proj, transcript_path: transcript, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'x' },
    { hook_event_name: 'Stop', session_id: 's1', cwd: proj, transcript_path: transcript, stop_hook_active: false },
    {
      hook_event_name: 'PostCompact', session_id: 's1', cwd: proj, transcript_path: transcript, trigger: 'auto',
      compact_summary: '## Handoff\nplanted by the summary the client sent',
    },
  ]) {
    const r = runGuard(g, ev, proj);
    assert.equal(r.code, 0, `${ev.hook_event_name}: ${r.out}${r.err}`);
    assert.equal(r.out, '', ev.hook_event_name);
    assert.equal(r.err, '', ev.hook_event_name);
  }

  const after = walk(proj);
  assert.deepEqual(after, before, 'no file or directory was created or removed anywhere under the project');
  for (const [p, bytes] of beforeBytes) {
    assert.deepEqual(readFileSync(join(proj, p)), bytes, `${p} is byte-for-byte unchanged`);
  }
  // Named explicitly, since it is the file the retired estimator used to write.
  assert.equal(existsSync(join(proj, '.omelette', 'handoff-state.json')), false);
});

// ─── rules --hooks: the retired keys warn on stderr, end to end ────────────

test('rules --hooks prints one stderr warning per retired handoff key, and still renders the one-key literal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t1-warn-'));
  const proj = join(dir, 'proj'); mkdirSync(proj);
  // A fleet.config.json exactly as 1.4.0 could have left it: all four keys.
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({
    version: 1, handoff: { enabled: true, threshold: 85, contextWindow: 500000, compactSummary: false },
  }));

  const r = cli(['rules', '--hooks'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  for (const key of ['threshold', 'contextWindow', 'compactSummary']) {
    assert.match(
      r.err,
      new RegExp(`^omelette-fleet rules: fleet config: handoff\\.${key} is not a known key — ignored$`, 'm'),
      `${key} warned on stderr:\n${r.err}`,
    );
  }
  const installed = readFileSync(join(proj, '.claude', 'hooks', 'omelette-guard.mjs'), 'utf8');
  assert.match(installed, /^const HANDOFF_CONFIG = \{"enabled":true\};$/m);
});

// ─── doctor: exactly one retired entry beside a fully wired three ──────────

test('doctor: three fully wired events plus a settings entry that STILL calls the guard on Stop alone names only Stop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t1-doctor-stop-'));
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const written = cli(['rules', '--hooks'], { dir, cwd: proj });
  assert.equal(written.code, 0, written.err);
  const at = written.out.split('\n').indexOf('{ "hooks": {');
  assert.ok(at >= 0, written.out);
  const snippet = JSON.parse(written.out.split('\n').slice(at, at + 4).join('\n'));

  const settings = join(proj, '.claude', 'settings.json');
  writeFileSync(settings, JSON.stringify({
    hooks: { ...snippet.hooks, Stop: [{ hooks: snippet.hooks.PreCompact[0].hooks }] },
  }, null, 2));
  const r = cli(['doctor'], { dir, cwd: proj });
  assert.match(
    r.out,
    /^hooks {9}project: v\S+ \(wired: PreToolUse, PreCompact, SessionStart · Stop wired but no longer used — remove them from your settings files\)/m,
    r.out,
  );
  assert.doesNotMatch(r.out, /PostToolUse|PostCompact/, 'only the entry actually present is named');
});

// ─── hookSettingsSnippet: win32 and linux together ─────────────────────────

test('hookSettingsSnippet on win32 and on linux both parse as JSON with exactly the three keys', () => {
  for (const platform of ['win32', 'linux']) {
    const parsed = JSON.parse(hookSettingsSnippet('/abs/path/.claude/hooks/omelette-guard.mjs', platform).join('\n'));
    assert.deepEqual(Object.keys(parsed.hooks), ['PreToolUse', 'PreCompact', 'SessionStart'], platform);
  }
});

// ─── docs: read directly, not inferred ─────────────────────────────────────

test('docs/CONFIG.md "The handoff hooks" table has exactly two event rows', () => {
  const md = readFileSync(join(ROOT, 'docs', 'CONFIG.md'), 'utf8');
  const at = md.indexOf('## The handoff hooks');
  assert.ok(at >= 0, 'section present');
  const next = md.indexOf('\n## ', at + 1);
  const section = md.slice(at, next === -1 ? undefined : next);
  const rows = section.split('\n').filter((l) => /^\| `/.test(l));
  assert.deepEqual(rows.map((l) => l.match(/^\| `([^`]+)`/)[1]), ['PreCompact', 'SessionStart']);
});

test('docs/ORCHESTRATION.md no longer references the handoff-lifecycle diagram, and the files are gone', () => {
  const orch = readFileSync(join(ROOT, 'docs', 'ORCHESTRATION.md'), 'utf8');
  assert.doesNotMatch(orch, /handoff-lifecycle/);
  assert.equal(existsSync(join(ROOT, 'docs', 'assets', 'diagrams', 'handoff-lifecycle.svg')), false);
  assert.equal(existsSync(join(ROOT, 'docs', 'assets', 'diagrams', 'handoff-lifecycle.html')), false);
});
