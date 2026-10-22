/**
 * omelette-fleet :: test/tester-1.5.0-t1.test.mjs
 * Independent tester coverage for T1 ("the guard serves three events"),
 * written from docs/superpowers/specs/2026-09-25-1.5.0-process-layer-design.md
 * §"P1 — three hooks, not six" and the plan's Task T1. The one claim left
 * untested elsewhere: `rules --hooks` actually PRINTS the three retired-key
 * warnings on stderr (only `handoffSettings().warnings` is unit-tested), and
 * the three retired events create no file anywhere under the project.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

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
