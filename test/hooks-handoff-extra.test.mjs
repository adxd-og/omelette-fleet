/**
 * omelette-fleet :: test/hooks-handoff-extra.test.mjs
 *
 * Tester-added coverage for the 0.3.4 auto-handoff (spec
 * docs/superpowers/specs/2026-09-08-0.3.4-design.md, section 1). These are
 * behaviours the spec fixes that test/hooks-handoff.test.mjs (the
 * implementer's own file) does not exercise directly:
 *
 *   - `handoff.enabled=false` must also silence the `Stop` gate, not only the
 *     `PostToolUse` nudge — including a session whose crossing was already
 *     recorded before the block was switched off.
 *   - An event with no `session_id` (or an empty one) is not a session the
 *     guard has anything to say about, on EITHER hook.
 *   - A ledger file that is itself a SYMLINK (inside a real, non-symlinked
 *     `.omelette`) must not be read through by the freshness scan — the same
 *     "never follow a ledger symlink" rule PreCompact/SessionStart already
 *     enforce, applied here to the new `freshHandoff`/`ledgerSizes` code.
 *   - The threshold's own documented bounds (50 and 99) behave correctly at
 *     the runtime boundary, not only as config validation.
 *   - `doctor`'s handoff line — a second, independent lstat implementation in
 *     bin/omelette-fleet.mjs — refuses a symlinked `.omelette` the same way
 *     the guard itself does, rather than counting ledgers through it.
 *
 * Driven the same way the implementer's file drives it: a CHILD PROCESS with
 * the event as JSON on stdin, a real transcript on disk, HOME pointed at a
 * throwaway directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

const symlinksWork = (() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'omelette-symcheck-'));
    symlinkSync(dir, join(dir, 'self-check-link'));
    return true;
  } catch { return false; }
})();

/** The guard exactly as `rules --hooks` writes it, with this test's handoff block in it. */
function guard(handoff = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-handoff-extra-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3', { enabled: true, threshold: 90, contextWindow: 0, ...handoff }));
  return { dir, path };
}

const assistantLine = (fill) => JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-5',
    usage: { input_tokens: 32, cache_creation_input_tokens: 1208, cache_read_input_tokens: fill - 1240, output_tokens: 485 },
  },
  timestamp: '2026-09-08T18:00:00.000Z',
});
const plainLine = (type, text) => JSON.stringify({ type, message: { role: 'user', content: text }, timestamp: '2026-09-08T18:00:01.000Z' });

function writeTranscript(path, fill) {
  writeFileSync(path, [plainLine('user', 'go on'), assistantLine(fill), plainLine('user', 'thanks')].join('\n') + '\n');
}

/** A throwaway project: `.omelette/` with the ledgers it was given, and a transcript of its own. */
function project(g, name, { ledgers = { 'ledger-0.3.4.md': '# ledger 0.3.4\n' }, fill = 182000 } = {}) {
  const dir = join(g.dir, name);
  mkdirSync(join(dir, '.omelette'), { recursive: true });
  for (const [file, text] of Object.entries(ledgers)) writeFileSync(join(dir, '.omelette', file), text);
  const transcript = join(dir, 'transcript.jsonl');
  writeTranscript(transcript, fill);
  return {
    dir,
    transcript,
    ledger: (file = 'ledger-0.3.4.md') => join(dir, '.omelette', file),
    statePath: join(dir, '.omelette', 'handoff-state.json'),
    state: () => JSON.parse(readFileSync(join(dir, '.omelette', 'handoff-state.json'), 'utf8')),
  };
}

function fire(g, input, { env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [g.path], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', cwd: cwd || g.dir, timeout: 20000,
    env: { PATH: process.env.PATH, HOME: g.dir, ...env },
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const post = (p, over = {}) => ({
  hook_event_name: 'PostToolUse', session_id: 's-1', transcript_path: p.transcript, cwd: p.dir,
  tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' }, ...over,
});
const stopEvent = (p, over = {}) => ({
  hook_event_name: 'Stop', session_id: 's-1', transcript_path: p.transcript, cwd: p.dir,
  stop_hook_active: false, last_assistant_message: 'done', ...over,
});

function silent(r, why) {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '', `${why}: printed ${JSON.stringify(r.out)}`);
  assert.equal(r.err, '');
}
function blocked(r) {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  const parsed = JSON.parse(r.out);
  assert.deepEqual(Object.keys(parsed), ['decision', 'reason']);
  assert.equal(parsed.decision, 'block');
  return parsed.reason;
}
function nudged(r) {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  const parsed = JSON.parse(r.out);
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  return parsed.hookSpecificOutput.additionalContext;
}

test('Stop: handoff.enabled=false never gates, even with a crossing already recorded before it was switched off', () => {
  const g = guard({ enabled: false });
  const p = project(g, 'disabled-stop');
  // A crossing recorded by hand, exactly as PostToolUse would have left it had
  // the block been on when the threshold was crossed — the config was then
  // turned off and the guard re-rendered, which is the realistic sequence.
  writeFileSync(p.statePath, JSON.stringify({
    's-1': { crossedAt: new Date().toISOString(), ledgers: { 'ledger-0.3.4.md': 10 }, nudged: true, blocked: false },
  }));
  silent(fire(g, stopEvent(p)), 'handoff.enabled=false must silence the Stop gate too');
  // The stale entry is untouched — a disabled guard does not even look at it.
  assert.deepEqual(JSON.parse(readFileSync(p.statePath, 'utf8'))['s-1'].blocked, false);
});

test('PostToolUse and Stop: an event with no session_id, or an empty one, is not a session the guard tracks', () => {
  const g = guard();
  const p = project(g, 'no-session');
  for (const id of [undefined, '', null]) {
    silent(fire(g, post(p, { session_id: id })), `PostToolUse with session_id ${JSON.stringify(id)}`);
    silent(fire(g, stopEvent(p, { session_id: id })), `Stop with session_id ${JSON.stringify(id)}`);
  }
  assert.equal(existsSync(p.statePath), false, 'nothing was ever recorded, whatever the fill');
  // …and with a real id the very same fixture crosses normally, confirming the
  // fixture itself was over the threshold all along.
  assert.equal(nudged(fire(g, post(p))), 'omelette-fleet: context at 91% of 200000 tokens (default). '
    + 'Append a `## Handoff` block to .omelette/ledger-0.3.4.md now — where the work stands, open findings, '
    + 'agents in flight, next action — auto-compaction is close.');
});

test(
  'Stop: a ledger that is itself a SYMLINK is never read for freshness — its content cannot satisfy the gate',
  { skip: !symlinksWork && 'symlinks need privileges here' },
  () => {
    const g = guard();
    const p = project(g, 'symlinked-ledger');
    // Cross the threshold first, with one real ledger.
    const first = fire(g, post(p));
    assert.notEqual(first.out, '', 'the fixture is meant to cross the threshold');

    // A second "ledger" that is a symlink to a file that DOES carry a handoff —
    // created after the crossing, so an honest ledger would count from byte 0
    // and satisfy the gate. A symlinked one must not: same rule PreCompact and
    // SessionStart already apply to ledger files.
    const outside = join(g.dir, 'outside-handoff.md');
    writeFileSync(outside, '# not a ledger\n\n## Handoff 2026-09-08T20:00Z\nplanted outside .omelette\n');
    symlinkSync(outside, join(p.dir, '.omelette', 'ledger-planted.md'));

    const reason = blocked(fire(g, stopEvent(p)));
    assert.match(reason, /one of the ledgers in \.omelette\//, 'two ledger-shaped names now exist, so neither is singled out');
    assert.match(reason, /no `## Handoff` block has been appended/, 'the symlinked content must not count as a handoff');
  },
);

test('the threshold bounds the spec fixes (50 and 99) fire exactly at the boundary and not one point short', () => {
  const low = guard({ threshold: 50 });
  const p = project(low, 'floor-threshold', { fill: 99999 }); // 49%
  silent(fire(low, post(p)), '49% is below a threshold of 50');
  writeTranscript(p.transcript, 100000); // exactly 50%
  assert.match(nudged(fire(low, post(p))), /^omelette-fleet: context at 50% of 200000 tokens \(default\)\./);

  const high = guard({ threshold: 99 });
  const q = project(high, 'ceiling-threshold', { fill: 197999 }); // 98%
  silent(fire(high, post(q)), '98% is below a threshold of 99');
  writeTranscript(q.transcript, 198000); // exactly 99%
  assert.match(nudged(fire(high, post(q))), /^omelette-fleet: context at 99% of 200000 tokens \(default\)\./);
});

test('doctor: the handoff line refuses a symlinked `.omelette` — it does not count ledgers through the link',
  { skip: !symlinksWork && 'symlinks need privileges here' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'omelette-doctor-symlink-'));
    const proj = join(dir, 'proj');
    mkdirSync(proj);
    const outside = join(dir, 'outside-omelette');
    mkdirSync(outside);
    writeFileSync(join(outside, 'ledger-real.md'), '# ledger\n');
    symlinkSync(outside, join(proj, '.omelette'));

    const rules = spawnSync(process.execPath, [BIN, 'rules', '--hooks'], {
      cwd: proj, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
    });
    assert.equal(rules.status, 0, rules.stderr);

    const doctor = spawnSync(process.execPath, [BIN, 'doctor'], {
      cwd: proj, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
    }).stdout;
    assert.match(
      doctor,
      /^handoff {7}nudge at 90% of 200000 \(default\) · Stop gate on · ledgers: none \(hook silent — start \.omelette\/ledger-<plan>\.md\)$/m,
      doctor,
    );
  });
