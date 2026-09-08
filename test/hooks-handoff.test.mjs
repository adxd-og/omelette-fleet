/**
 * omelette-fleet :: test/hooks-handoff.test.mjs
 * The auto-handoff half of the guard — the PostToolUse nudge and the Stop gate
 * — driven the way Claude Code drives it: a CHILD PROCESS with the event as
 * JSON on stdin, a real transcript on disk, and HOME pointed at a throwaway
 * directory, because the ceiling is resolved out of the user's own settings
 * files and no test may see the operator's.
 *
 * Every run renders the guard with the handoff block the test wants, through
 * the same `renderHookFile` that `rules --hooks` uses: the shipped template
 * carries `{{marker}}` and `{{handoff}}` and is not runnable until it is
 * rendered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

/** The guard exactly as `rules --hooks` writes it, with this test's handoff block in it. */
function guard(handoff = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-handoff-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3', { enabled: true, threshold: 90, contextWindow: 0, ...handoff }));
  return { dir, path };
}

/**
 * One assistant record, exactly the shape Claude Code writes: `input +
 * cache_read + cache_creation` is the prompt that was just sent, and
 * `output_tokens` is deliberately outside that sum.
 */
const assistantLine = (fill) => JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-5',
    usage: { input_tokens: 32, cache_creation_input_tokens: 1208, cache_read_input_tokens: fill - 1240, output_tokens: 485 },
  },
  timestamp: '2026-09-08T18:00:00.000Z',
});
/** Everything else in a transcript: no `usage` anywhere. */
const plainLine = (type, text) => JSON.stringify({ type, message: { role: 'user', content: text }, timestamp: '2026-09-08T18:00:01.000Z' });

/** A transcript whose LAST usage record adds up to `fill`, with ordinary traffic around it. */
function writeTranscript(path, fill, { before = [] } = {}) {
  writeFileSync(path, [...before, plainLine('user', 'go on'), assistantLine(fill), plainLine('user', 'thanks')].join('\n') + '\n');
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

/** One hook invocation: the event on stdin, the answer as code/stdout/stderr. */
function fire(g, input, { env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [g.path], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', cwd: cwd || g.dir, timeout: 20000,
    // HOME is the throwaway directory: the ceiling is read out of the user's
    // own settings files, and no test may reach the operator's.
    env: { PATH: process.env.PATH, HOME: g.dir, ...env },
  });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const post = (p, over = {}) => ({
  hook_event_name: 'PostToolUse', session_id: 's-1', transcript_path: p.transcript, cwd: p.dir,
  tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' }, ...over,
});

/** The two texts the spec fixes, built the way the guard builds them. */
const NUDGE = (pct, window, source, target = '.omelette/ledger-0.3.4.md') => 'omelette-fleet: context at '
  + `${pct}% of ${window} tokens (${source}). Append a \`## Handoff\` block to ${target} now — where the work `
  + 'stands, open findings, agents in flight, next action — auto-compaction is close.';

/** The one JSON object a nudging run prints, parsed. */
function nudged(r) {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  const parsed = JSON.parse(r.out);
  assert.equal(r.out, `${JSON.stringify(parsed)}\n`, 'exactly one JSON object and nothing else');
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  return parsed.hookSpecificOutput.additionalContext;
}

/** A run that had nothing to say says nothing at all. */
function silent(r, why) {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '', `${why}: printed ${JSON.stringify(r.out)}`);
  assert.equal(r.err, '');
}

test('PostToolUse: the nudge fires ONCE at the threshold, as one JSON object, and records the crossing', () => {
  const g = guard();
  // 32 + 1208 + 180760 = 182000 of 200000 = 91%.
  const p = project(g, 'nudge');
  const first = fire(g, post(p));
  assert.equal(nudged(first), NUDGE(91, 200000, 'default'));

  // The crossing is on disk, 0600, with the ledger's size at the moment it happened.
  const state = p.state();
  assert.deepEqual(Object.keys(state), ['s-1']);
  assert.match(state['s-1'].crossedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.deepEqual(state['s-1'].ledgers, { 'ledger-0.3.4.md': statSync(p.ledger()).size });
  assert.equal(state['s-1'].nudged, true);
  assert.equal(state['s-1'].blocked, false);
  if (process.platform !== 'win32') assert.equal(statSync(p.statePath).mode & 0o777, 0o600);

  // …and it is said once. The context has not shrunk, and repeating the line on
  // every tool call is how a reminder becomes noise.
  silent(fire(g, post(p)), 'a second tool call after the crossing');
  silent(fire(g, post(p, { session_id: 's-1' })), 'and a third');
  // Another session in the same project crosses on its own terms.
  assert.equal(nudged(fire(g, post(p, { session_id: 's-2' }))), NUDGE(91, 200000, 'default'));
  assert.deepEqual(Object.keys(p.state()).sort(), ['s-1', 's-2']);
});

test('PostToolUse: below the threshold is silence — and a fill that falls back below it deletes the crossing', () => {
  const g = guard();
  const p = project(g, 'below', { fill: 179999 }); // 89% of 200000
  silent(fire(g, post(p)), '89% is below 90');
  assert.equal(existsSync(p.statePath), false, 'nothing crossed, so nothing is written');

  // Exactly at the threshold it fires: the percentage is floored, so 180000 is 90.
  writeTranscript(p.transcript, 180000);
  assert.equal(nudged(fire(g, post(p))), NUDGE(90, 200000, 'default'));

  // A window that fell back below the line was compacted, trimmed, or was never
  // this session's: the crossing describes a context that is gone.
  writeTranscript(p.transcript, 100000);
  silent(fire(g, post(p)), '50% after a crossing');
  assert.deepEqual(p.state(), {}, 'the entry is deleted, and the file stays');
  // …so the next crossing nudges again.
  writeTranscript(p.transcript, 182000);
  assert.equal(nudged(fire(g, post(p))), NUDGE(91, 200000, 'default'));
});

test('PostToolUse: the ceiling is the first source that yields a positive integer, and the nudge names it', () => {
  const g = guard();
  const p = project(g, 'ceiling', { fill: 182000 });
  const settings = join(g.dir, '.claude', 'settings.json');
  mkdirSync(join(g.dir, '.claude'), { recursive: true });

  // 4. Nothing set anywhere: Claude Code's documented 200 000.
  assert.equal(nudged(fire(g, post(p))), NUDGE(91, 200000, 'default'));

  // 3. `autoCompactWindow` in the user's own settings, in the `500k` form. Each
  // step uses a session id of its own, so every run is a fresh crossing.
  writeFileSync(settings, JSON.stringify({ autoCompactWindow: '500k' }, null, 2));
  writeTranscript(p.transcript, 460000); // 92% of 500000
  assert.equal(nudged(fire(g, post(p, { session_id: 'fresh-2' }))), NUDGE(92, 500000, 'autoCompactWindow'));
  // settings.local.json is read FIRST, exactly as the client reads it.
  writeFileSync(join(g.dir, '.claude', 'settings.local.json'), JSON.stringify({ autoCompactWindow: 1000000 }));
  writeTranscript(p.transcript, 950000); // 95% of 1000000
  assert.equal(nudged(fire(g, post(p, { session_id: 'fresh-3' }))), NUDGE(95, 1000000, 'autoCompactWindow'));

  // 2. The environment variable beats both files, in the `1m` form…
  writeTranscript(p.transcript, 920000);
  assert.equal(
    nudged(fire(g, post(p, { session_id: 'fresh-4' }), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1M' } })),
    NUDGE(92, 1000000, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'),
  );
  // …and a value that is not a window is not a ceiling: it falls through to the
  // next source rather than being guessed at.
  writeTranscript(p.transcript, 950000);
  assert.equal(
    nudged(fire(g, post(p, { session_id: 'fresh-5' }), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'lots' } })),
    NUDGE(95, 1000000, 'autoCompactWindow'),
    'garbage in the environment falls through to the settings file',
  );

  // 1. The rendered `handoff.contextWindow` beats everything: it is the value
  // the operator put in the fleet config and re-rendered.
  const pinned = guard({ contextWindow: 400000 });
  const q = project(pinned, 'pinned', { fill: 380000 }); // 95% of 400000
  assert.equal(
    nudged(fire(pinned, post(q), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1m' } })),
    NUDGE(95, 400000, 'handoff.contextWindow'),
  );

  // A CLAUDE_CONFIG_DIR is honoured for the settings file, exactly as elsewhere.
  const cfg = join(g.dir, 'cfgdir');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ autoCompactWindow: '250k' }));
  writeTranscript(p.transcript, 230000); // 92% of 250000
  assert.equal(
    nudged(fire(g, post(p, { session_id: 'fresh-6' }), { env: { CLAUDE_CONFIG_DIR: cfg } })),
    NUDGE(92, 250000, 'autoCompactWindow'),
  );
});

test('PostToolUse: a sub-agent is never nudged — it has no ledger of its own', () => {
  const g = guard();
  const p = project(g, 'subagent');
  for (const over of [{ agent_type: 'omelette-coder' }, { agent_id: 'agent_017x' }, { agent_id: 'a', agent_type: 'omelette-tester' }]) {
    silent(fire(g, post(p, over)), JSON.stringify(over));
  }
  assert.equal(existsSync(p.statePath), false, 'a sub-agent does not record a crossing either');
  // …and the main thread, which carries neither, still does.
  assert.equal(nudged(fire(g, post(p))), NUDGE(91, 200000, 'default'));
});

test('PostToolUse: no ledger is no opt-in — an absent, an empty and a symlinked .omelette are all silent', () => {
  const g = guard();
  // No `.omelette` at all.
  const bare = join(g.dir, 'bare');
  mkdirSync(bare);
  const transcript = join(bare, 't.jsonl');
  writeTranscript(transcript, 182000);
  silent(fire(g, { hook_event_name: 'PostToolUse', session_id: 's-1', cwd: bare, transcript_path: transcript }), 'no .omelette');

  // A `.omelette` holding no ledger: notes are not a ledger, and neither is a
  // file whose name only looks like one.
  const empty = project(g, 'empty', { ledgers: { 'notes.md': '# notes\n', 'ledger-old.txt': 'x\n' } });
  silent(fire(g, post(empty)), 'no ledger-*.md');
  assert.equal(existsSync(empty.statePath), false);

  // With two ledgers, the message names neither one.
  const two = project(g, 'two', { ledgers: { 'ledger-a.md': '# a\n', 'ledger-b.md': '# b\n' } });
  assert.equal(nudged(fire(g, post(two))), NUDGE(91, 200000, 'default', 'one of the ledgers in .omelette/'));
});

test('PostToolUse: a `.omelette` that is a symlink is refused, as it is for every other event',
  { skip: process.platform === 'win32' && 'POSIX symlinks' }, () => {
    const g = guard();
    const proj = join(g.dir, 'linked');
    mkdirSync(proj);
    const outside = join(g.dir, 'outside-omelette');
    mkdirSync(outside);
    writeFileSync(join(outside, 'ledger-x.md'), '# ledger\n');
    symlinkSync(outside, join(proj, '.omelette'));
    const transcript = join(proj, 't.jsonl');
    writeTranscript(transcript, 182000);
    silent(fire(g, { hook_event_name: 'PostToolUse', session_id: 's-1', cwd: proj, transcript_path: transcript }), 'a linked .omelette');
    assert.equal(existsSync(join(outside, 'handoff-state.json')), false, 'and nothing is written through the link');
  });

test('PostToolUse: no measurement, no nudge — a missing, unusable or usage-less transcript is silence', () => {
  const g = guard();
  const p = project(g, 'transcripts');
  // No path, a path that is not there, a path that is a directory.
  silent(fire(g, post(p, { transcript_path: undefined })), 'no transcript_path');
  silent(fire(g, post(p, { transcript_path: '' })), 'an empty transcript_path');
  silent(fire(g, post(p, { transcript_path: join(g.dir, 'nope.jsonl') })), 'a transcript that is not there');
  silent(fire(g, post(p, { transcript_path: p.dir })), 'a directory where a transcript should be');

  // A transcript with no usage anywhere: lines that are not JSON, and JSON that
  // is not an assistant record.
  const noUsage = join(g.dir, 'no-usage.jsonl');
  writeFileSync(noUsage, [plainLine('user', 'hi'), 'not json at all', JSON.stringify({ type: 'assistant', message: {} }), ''].join('\n'));
  silent(fire(g, post(p, { transcript_path: noUsage })), 'no usage record');
  assert.equal(existsSync(p.statePath), false);

  // A usage record whose counters are all absent measures 0%, which is below
  // every threshold — silence, not a crash.
  const zero = join(g.dir, 'zero.jsonl');
  writeFileSync(zero, `${JSON.stringify({ type: 'assistant', message: { usage: {} } })}\n`);
  silent(fire(g, post(p, { transcript_path: zero })), 'a usage record with no counters');
});

test('PostToolUse: only the last 256 KiB of the transcript are read, and the LAST usage record in them wins', () => {
  const g = guard();
  const p = project(g, 'tail');
  // A usage record that would cross the threshold, followed by 300 KiB of
  // ordinary traffic and a smaller one: the newest is the measurement, and the
  // old one is behind the tail read where it belongs.
  const filler = Array.from({ length: 1600 }, (_, i) => plainLine('user', `${'x'.repeat(180)}${i}`));
  writeFileSync(p.transcript, [assistantLine(199000), ...filler, assistantLine(100000)].join('\n') + '\n');
  silent(fire(g, post(p)), 'the newest record measures 50%');

  // The same file with the newest record above the threshold.
  writeFileSync(p.transcript, [assistantLine(100000), ...filler, assistantLine(182000)].join('\n') + '\n');
  assert.equal(nudged(fire(g, post(p))), NUDGE(91, 200000, 'default'));

  // A transcript whose ONLY usage record is past the tail is no measurement at
  // all: the read starts mid-file and that half-line simply fails to parse.
  writeFileSync(p.transcript, [assistantLine(182000), ...filler].join('\n') + '\n');
  silent(fire(g, post(p, { session_id: 's-tail' })), 'the only usage record is behind the tail');
});

test('PostToolUse: a transcript that is not a regular file is never read',
  { skip: process.platform === 'win32' && 'POSIX symlinks' }, () => {
    const g = guard();
    const p = project(g, 'link-transcript');
    const real = join(g.dir, 'elsewhere.jsonl');
    writeTranscript(real, 182000);
    const link = join(p.dir, 'linked.jsonl');
    symlinkSync(real, link);
    silent(fire(g, post(p, { transcript_path: link })), 'a symlinked transcript');
  });

test('PostToolUse: a state file that is not ours to write is silence, and the link is never written through',
  { skip: process.platform === 'win32' && 'POSIX symlinks' }, () => {
    const g = guard();
    // A symlink out of `.omelette` is how a rename lands somewhere else entirely.
    const linked = project(g, 'state-link');
    const outside = join(g.dir, 'outside-state.json');
    writeFileSync(outside, '{"untouched":true}\n');
    symlinkSync(outside, linked.statePath);
    silent(fire(g, post(linked)), 'a symlinked state file');
    assert.equal(readFileSync(outside, 'utf8'), '{"untouched":true}\n', 'never written through');

    // A directory under that name, and a file far bigger than any state.
    const dirState = project(g, 'state-dir');
    mkdirSync(dirState.statePath);
    silent(fire(g, post(dirState)), 'a directory where the state file should be');
    const big = project(g, 'state-big');
    writeFileSync(big.statePath, `{"pad":"${'x'.repeat(300 * 1024)}"}`);
    silent(fire(g, post(big)), 'a state file past the read cap');

    // …but a file of OURS that no longer parses is rewritten rather than
    // disabling the mechanism for good.
    const broken = project(g, 'state-broken');
    writeFileSync(broken.statePath, '{ not json');
    assert.equal(nudged(fire(g, post(broken))), NUDGE(91, 200000, 'default'));
    assert.equal(broken.state()['s-1'].nudged, true);
  });

test('PostToolUse: the state is pruned at 7 days and capped at 64 entries, and the live session survives both', () => {
  const g = guard();
  const p = project(g, 'prune');
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const day = 24 * 60 * 60 * 1000;
  const seeded = {
    'old-1': { crossedAt: iso(8 * day), ledgers: {}, nudged: true, blocked: true },
    'old-2': { crossedAt: 'not a date', ledgers: {}, nudged: true, blocked: true },
    'recent': { crossedAt: iso(2 * day), ledgers: {}, nudged: true, blocked: false },
  };
  for (let i = 0; i < 70; i++) seeded[`filler-${i}`] = { crossedAt: iso(i * 60000), ledgers: {}, nudged: true, blocked: false };
  writeFileSync(p.statePath, JSON.stringify(seeded));

  assert.equal(nudged(fire(g, post(p))), NUDGE(91, 200000, 'default'));
  const state = p.state();
  assert.equal(Object.keys(state).length, 64, 'the file is capped at 64 entries');
  assert.ok(state['s-1'], 'the session being written always survives');
  assert.equal(state['old-1'], undefined, 'older than 7 days');
  assert.equal(state['old-2'], undefined, 'a crossedAt that is not a date is older than anything');
  assert.ok(state['filler-0'], 'the newest entries are the ones kept');
  assert.equal(state['filler-69'], undefined, 'the oldest are the ones dropped');
});

test('PostToolUse: a fresh `## Handoff` since the crossing keeps the nudge quiet', () => {
  const g = guard();
  const p = project(g, 'fresh');
  const before = '# ledger\n\n## Handoff 2026-09-08T10:00Z\nwritten long before the crossing\n';
  writeFileSync(p.ledger(), before);
  // A crossing recorded by hand, so the nudge has not been said yet — the state
  // remembers the size the ledger had at that moment.
  writeFileSync(p.statePath, JSON.stringify({
    's-1': { crossedAt: new Date().toISOString(), ledgers: { 'ledger-0.3.4.md': Buffer.byteLength(before) }, nudged: false, blocked: false },
  }));
  // A ruling is not a handoff…
  appendFileSync(p.ledger(), 'Ruling: keep the cap — a truncated tail beats a flooded context — costs the oldest lines\n');
  assert.equal(nudged(fire(g, post(p))), NUDGE(91, 200000, 'default'));

  // …and the handoff itself is.
  writeFileSync(p.statePath, JSON.stringify({
    's-2': { crossedAt: new Date().toISOString(), ledgers: { 'ledger-0.3.4.md': statSync(p.ledger()).size }, nudged: false, blocked: false },
  }));
  appendFileSync(p.ledger(), '\n## Handoff 2026-09-08T18:00Z\nWhere it stands: T3 in review.\n');
  silent(fire(g, post(p, { session_id: 's-2' })), 'the handoff is already written');
  assert.equal(p.state()['s-2'].nudged, false, 'nothing was said, so nothing is marked as said');
});

test('PostToolUse: handoff.enabled=false renders a guard that says nothing at all, and threshold is honoured', () => {
  const off = guard({ enabled: false });
  const p = project(off, 'disabled');
  silent(fire(off, post(p)), 'the block is switched off');
  assert.equal(existsSync(p.statePath), false, 'and nothing is recorded either');

  // A rendered threshold of 85 fires at 85%, and not at 84%.
  const low = guard({ threshold: 85 });
  const q = project(low, 'eighty-five', { fill: 169999 }); // 84%
  silent(fire(low, post(q)), '84% is below 85');
  writeTranscript(q.transcript, 170000); // 85%
  assert.equal(nudged(fire(low, post(q))), NUDGE(85, 200000, 'default'));
});

const stopEvent = (p, over = {}) => ({
  hook_event_name: 'Stop', session_id: 's-1', transcript_path: p.transcript, cwd: p.dir,
  stop_hook_active: false, last_assistant_message: 'done', ...over,
});

const BLOCK = (pct, window, target = '.omelette/ledger-0.3.4.md') => 'omelette-fleet: context at '
  + `${pct}% of ${window} tokens and no \`## Handoff\` block has been appended to ${target} since the `
  + 'threshold was crossed. Append it now (state, open findings, agents in flight, next action), then stop.';

/** The one JSON object a blocking run prints, parsed. */
function blocked(r) {
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  const parsed = JSON.parse(r.out);
  assert.equal(r.out, `${JSON.stringify(parsed)}\n`, 'exactly one JSON object and nothing else');
  assert.deepEqual(Object.keys(parsed), ['decision', 'reason']);
  assert.equal(parsed.decision, 'block');
  return parsed.reason;
}

/** A crossing, as the nudge would have recorded it. */
function cross(g, p, over = {}) {
  const r = fire(g, post(p, over));
  assert.notEqual(r.out, '', 'the fixture is meant to cross the threshold');
  return r;
}

test('Stop: the gate holds the turn ONCE per crossing, with the reason the spec fixes', () => {
  const g = guard();
  const p = project(g, 'gate');
  cross(g, p);
  assert.equal(blocked(fire(g, stopEvent(p))), BLOCK(91, 200000));
  assert.equal(p.state()['s-1'].blocked, true);
  // It reminds, it does not imprison: a session that stops again stops.
  silent(fire(g, stopEvent(p)), 'the second Stop of the same crossing');
  silent(fire(g, stopEvent(p)), 'and the third');
});

test('Stop: `stop_hook_active` is a skip — the guard never fights Claude Code\'s own continuation', () => {
  const g = guard();
  const p = project(g, 'active');
  cross(g, p);
  silent(fire(g, stopEvent(p, { stop_hook_active: true })), 'Claude Code is already continuing because of a stop hook');
  assert.equal(p.state()['s-1'].blocked, false, 'and nothing is marked as gated');
  // …and with the flag back to false the gate is still available.
  assert.equal(blocked(fire(g, stopEvent(p))), BLOCK(91, 200000));
});

test('Stop: a sub-agent\'s turn is never gated', () => {
  const g = guard();
  const p = project(g, 'sub-stop');
  cross(g, p);
  for (const over of [{ agent_type: 'omelette-tester' }, { agent_id: 'agent_017x' }]) {
    silent(fire(g, stopEvent(p, over)), JSON.stringify(over));
  }
  assert.equal(p.state()['s-1'].blocked, false);
});

test('Stop: a `## Handoff` appended AFTER the crossing lets the turn end; one written before it does not', () => {
  const g = guard();
  // A ledger that already carried a handoff when the threshold was crossed: it
  // describes the context of an hour ago, and the gate is about to ask for one
  // that describes this one.
  const stale = project(g, 'stale', { ledgers: { 'ledger-0.3.4.md': '# ledger\n\n## Handoff 2026-09-08T10:00Z\nstale\n' } });
  cross(g, stale);
  assert.equal(blocked(fire(g, stopEvent(stale))), BLOCK(91, 200000));

  // …and the same ledger with a block appended since.
  const fresh = project(g, 'fresh-stop');
  cross(g, fresh);
  appendFileSync(fresh.ledger(), '\n## Handoff 2026-09-08T18:00Z\nWhere it stands: T4 in review.\nNext: report.\n');
  silent(fire(g, stopEvent(fresh)), 'the handoff is written');
  assert.equal(fresh.state()['s-1'].blocked, false, 'a turn that was never held is not marked as held');
});

test('Stop: a Ruling: line and a ## Compaction stamp are not a handoff — the gate still blocks', () => {
  const g = guard();
  const p = project(g, 'not-a-handoff');
  cross(g, p);
  appendFileSync(p.ledger(), [
    'Ruling: keep the tail read — the newest handoff is at the end — costs the older ones',
    '',
    '## Compaction 2026-09-08T18:00:00.000Z (trigger: auto) — re-read this ledger before continuing',
    '### Handoff notes',
    '##Handoff',
    '',
  ].join('\n'));
  assert.equal(blocked(fire(g, stopEvent(p))), BLOCK(91, 200000));
});

test('Stop: a ledger created after the crossing counts from its first byte', () => {
  const g = guard();
  const p = project(g, 'new-ledger');
  cross(g, p);
  // Two ledgers now, so the message names neither — and the new one is read
  // whole, because the crossing recorded no size for it.
  writeFileSync(join(p.dir, '.omelette', 'ledger-0.3.5.md'), '# ledger 0.3.5\n\n## Handoff 2026-09-08T18:30Z\nstarted the next plan\n');
  silent(fire(g, stopEvent(p)), 'a ledger created after the crossing carries the handoff');

  // …and the same, without a handoff in it, blocks and names the directory.
  const q = project(g, 'new-ledger-empty');
  cross(g, q);
  writeFileSync(join(q.dir, '.omelette', 'ledger-0.3.5.md'), '# ledger 0.3.5\nRuling: nothing yet\n');
  assert.equal(blocked(fire(g, stopEvent(q))), BLOCK(91, 200000, 'one of the ledgers in .omelette/'));
});

test('Stop: no crossing, no gate — a session that never passed the threshold stops normally', () => {
  const g = guard();
  const p = project(g, 'never-crossed', { fill: 100000 });
  silent(fire(g, stopEvent(p)), 'no entry for this session');
  // …and neither does a session whose crossing belongs to another id.
  writeTranscript(p.transcript, 182000);
  cross(g, p, { session_id: 'other' });
  silent(fire(g, stopEvent(p)), 'the crossing is another session\'s');
  assert.equal(existsSync(p.statePath), true);
});

test('Stop: the measurement is re-taken — a context that fell back below the threshold clears the crossing', () => {
  const g = guard();
  const p = project(g, 'remeasure');
  cross(g, p);
  writeTranscript(p.transcript, 100000); // 50%: a compaction the guard did not see
  silent(fire(g, stopEvent(p)), 'below the threshold again');
  assert.deepEqual(p.state(), {}, 'the crossing goes with the context it described');
  // A transcript that cannot be measured at all is silence, and the entry stays
  // put: no measurement never decides anything. The window has to be back over
  // the line first — the crossing above was just cleared with the context it
  // described.
  writeTranscript(p.transcript, 182000);
  cross(g, p);
  silent(fire(g, stopEvent(p, { transcript_path: join(g.dir, 'gone.jsonl') })), 'no measurement');
  assert.equal(p.state()['s-1'].blocked, false);
});

test('PreCompact clears the crossing, and the next window crosses on its own terms', () => {
  const g = guard();
  const p = project(g, 'precompact');
  cross(g, p);
  assert.equal(blocked(fire(g, stopEvent(p))), BLOCK(91, 200000));

  const pre = fire(g, { hook_event_name: 'PreCompact', session_id: 's-1', trigger: 'auto', cwd: p.dir });
  assert.equal(pre.code, 0, pre.err);
  assert.match(pre.out, /^HANDOFF: re-read \.omelette\/ledger-\*\.md before continuing\.$/m, 'the 0.3.3 line is untouched');
  assert.deepEqual(p.state(), {}, 'the compaction the crossing was about has happened');
  assert.match(readFileSync(p.ledger(), 'utf8'), /## Compaction .* \(trigger: auto\) —/);

  // Another session's crossing in the same project survives the compaction of
  // this one: the entry is per session.
  cross(g, p, { session_id: 'other' });
  fire(g, { hook_event_name: 'PreCompact', session_id: 's-1', trigger: 'auto', cwd: p.dir });
  assert.ok(p.state().other, 'only the compacting session\'s entry is cleared');

  // …and the same session crosses again afterwards, from the sizes the ledger
  // has NOW — the `## Compaction` stamp is not a handoff.
  assert.equal(nudged(fire(g, post(p))), NUDGE(91, 200000, 'default'));
  assert.equal(blocked(fire(g, stopEvent(p))), BLOCK(91, 200000));
});

test('the two events together: nudge, gate, handoff, silence', () => {
  const g = guard();
  const p = project(g, 'walk');
  // Below the line: the session works, and the guard says nothing.
  writeTranscript(p.transcript, 120000);
  silent(fire(g, post(p)), '60%');
  silent(fire(g, stopEvent(p)), 'stopping below the line is ordinary');

  // The window fills: one reminder, then one held turn.
  writeTranscript(p.transcript, 182000);
  assert.equal(nudged(fire(g, post(p))), NUDGE(91, 200000, 'default'));
  silent(fire(g, post(p)), 'the reminder is said once');
  assert.equal(blocked(fire(g, stopEvent(p))), BLOCK(91, 200000));

  // The session writes the block it was asked for.
  appendFileSync(p.ledger(), '\n## Handoff 2026-09-08T19:00Z\nWhere it stands: T4 done, docs next.\n');
  silent(fire(g, stopEvent(p)), 'the turn ends now');
  silent(fire(g, post(p)), 'and nothing is said on the way out');
  // The ledger was never written to by the guard: only PreCompact appends.
  assert.equal(readFileSync(p.ledger(), 'utf8').includes('## Compaction'), false);
});
