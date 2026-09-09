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
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

  // A value in the local file that is not a window is skipped and the next file
  // is read — the same fall-through doctor makes, so the line it prints and the
  // window the hook measures against cannot disagree.
  writeFileSync(join(g.dir, '.claude', 'settings.local.json'), JSON.stringify({ autoCompactWindow: 'garbage' }));
  writeFileSync(settings, JSON.stringify({ autoCompactWindow: '500k' }));
  writeTranscript(p.transcript, 460000); // 92% of 500000
  assert.equal(
    nudged(fire(g, post(p, { session_id: 'fresh-garbage' }))),
    NUDGE(92, 500000, 'autoCompactWindow'),
    'garbage in the local settings file falls through to the shared one',
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

test('the guard\'s window parser answers the same table core/rules.mjs answers — the two are one grammar in two files', () => {
  // The guard imports nothing from the package, so `parseWindow` is a COPY of
  // `parseContextWindow`, and a copy drifts. This is the same table
  // test/rules.test.mjs pins the original against, driven through the only door
  // the script has: the environment variable, a real transcript, and the window
  // the nudge then names.
  const g = guard();
  const p = project(g, 'window-forms');
  let i = 0;
  for (const [raw, window] of [['200000', 200000], [' 500k ', 500000], ['500K', 500000], ['1m', 1000000], ['1M', 1000000]]) {
    writeTranscript(p.transcript, window - 1000); // 99% of whatever it parsed to
    assert.equal(
      nudged(fire(g, post(p, { session_id: `form-${i++}` }), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: raw } })),
      NUDGE(99, window, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'),
      `${JSON.stringify(raw)} is ${window}`,
    );
  }
  // …and everything that is NOT a window falls through to the next source
  // rather than being guessed at — here, with no settings file anywhere under
  // this HOME, to Claude Code's documented 200 000.
  writeTranscript(p.transcript, 182000);
  for (const raw of ['', '   ', '0', '-1', '1.5m', '200_000', '200000 tokens', 'lots', 'k', '9007199254740992']) {
    assert.equal(
      nudged(fire(g, post(p, { session_id: `bad-${i++}` }), { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: raw } })),
      NUDGE(91, 200000, 'default'),
      `${JSON.stringify(raw)} is not a window`,
    );
  }
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

/**
 * THE STATE FILE LANDS WHOLE OR NOT AT ALL. A partial write that was renamed
 * into place would leave JSON that no longer parses, and readState answers a
 * file it cannot parse by rewriting it from an empty map — so every crossing
 * recorded in it would be gone and every session would be nudged again. The
 * write itself is not reachable from out here (the guard is a script, not a
 * module, and nothing in it can be monkeypatched), so what is pinned is the
 * observable contract: what is on disk is exactly what was serialised.
 */
test('PostToolUse: the state file lands WHOLE — a big map is on disk byte for byte, and nothing is left over', () => {
  const g = guard();
  const p = project(g, 'state-whole');
  // 63 fillers plus the crossing = the 64 the file is capped at, each padded so
  // the write is ~130 KB rather than a couple of hundred bytes: a map that has
  // to survive to its last byte, not one that fits in any single write.
  const seeded = {};
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  for (let i = 0; i < 63; i++) {
    seeded[`filler-${i}`] = { crossedAt: iso(i * 60000), ledgers: {}, nudged: true, blocked: false, note: 'x'.repeat(2000) };
  }
  writeFileSync(p.statePath, JSON.stringify(seeded));

  assert.equal(nudged(fire(g, post(p))), NUDGE(91, 200000, 'default'));

  const text = readFileSync(p.statePath, 'utf8');
  assert.equal(Buffer.byteLength(text), statSync(p.statePath).size, 'the file is read whole');
  const parsed = JSON.parse(text); // truncated JSON never parses
  assert.equal(JSON.stringify(parsed), text, 'on disk byte for byte, with nothing lost off either end');
  assert.deepEqual(JSON.parse(readFileSync(p.statePath, 'utf8')), parsed, 'and it reads back the same every time');
  assert.equal(Object.keys(parsed).length, 64);
  assert.equal(parsed['s-1'].nudged, true, 'the crossing that was just written');
  assert.equal(parsed['filler-62'].note.length, 2000, 'and the far end of the map survived with it');

  // The rename took the temporary file's name with it: a `.tmp` left behind is
  // a write that half happened.
  assert.deepEqual(readdirSync(join(p.dir, '.omelette')).sort(), ['handoff-state.json', 'ledger-0.3.4.md']);
});

test('PostToolUse: a state directory that may not be written is silence — no note, no half-written temporary file',
  { skip: (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) && 'the mode has to bite' }, () => {
    const g = guard();
    const p = project(g, 'state-readonly');
    const omelette = join(p.dir, '.omelette');
    // Readable and traversable, so the ledger and the measurement are still
    // there; not writable, so the temporary file cannot even be created.
    chmodSync(omelette, 0o500);
    try {
      silent(fire(g, post(p)), 'a state directory that may not be written');
      assert.deepEqual(readdirSync(omelette).sort(), ['ledger-0.3.4.md'], 'nothing was created, not even a tmp');
    } finally {
      chmodSync(omelette, 0o700); // …or the throwaway tree cannot be cleaned up
    }
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

/** A named pipe, or null where `mkfifo` is not to be had — the one file that makes a read HANG. */
function fifo(path) {
  if (process.platform === 'win32') return null;
  const r = spawnSync('mkfifo', [path], { encoding: 'utf8' });
  return r.status === 0 ? path : null;
}

test('a FIFO where a file should be never holds the hook: nobody opens the other end, and it exits at once', (t) => {
  const g = guard();
  // 50 % — everything is read on the way to the measurement, and nothing is
  // said about it, so what this test sees is the READING and not the nudge.
  const p = project(g, 'fifo', { fill: 100000 });
  mkdirSync(join(g.dir, '.claude'), { recursive: true });

  // The user's own settings file: the ONE read this guard follows a symlink for,
  // and so the one that cannot lean on an lstat to refuse a pipe.
  const settings = fifo(join(g.dir, '.claude', 'settings.local.json'));
  if (!settings) { t.skip('mkfifo is not available here'); return; }
  const started = Date.now();
  silent(fire(g, post(p)), 'a FIFO where the user settings should be');
  assert.ok(Date.now() - started < 2000, `the guard waited on the pipe: ${Date.now() - started}ms`);

  // …and the transcript, which is read on every single tool call.
  const pipe = fifo(join(g.dir, 'transcript.fifo'));
  assert.ok(pipe, 'mkfifo worked a line ago; a failure here is the test, not the guard');
  const startedAgain = Date.now();
  silent(fire(g, post(p, { transcript_path: pipe })), 'a FIFO where the transcript should be');
  assert.ok(Date.now() - startedAgain < 2000, `the guard waited on the pipe: ${Date.now() - startedAgain}ms`);
});

test('PostToolUse: a usage counter that is not a whole, safe, non-negative NUMBER is no measurement at all', () => {
  const g = guard();
  const p = project(g, 'usage-shapes');
  const record = (usage) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage } });
  const whole = { input_tokens: 32, cache_creation_input_tokens: 1208, cache_read_input_tokens: 180760 };

  // The fixture crosses while the counters are numbers…
  writeFileSync(p.transcript, `${record(whole)}\n`);
  assert.equal(nudged(fire(g, post(p, { session_id: 'shapes-ok' }))), NUDGE(91, 200000, 'default'));

  // …and every one of these is silence instead of a guess. The record with the
  // unreadable counter is the newest one, and the guard does NOT fall back to
  // the record before it: that one describes a context two turns old, and a
  // percentage nobody can check is exactly what "no measurement" is for.
  let i = 0;
  for (const [why, usage] of [
    ['an array Number() would happily coerce', { ...whole, input_tokens: [180000] }],
    ['a numeric string', { ...whole, input_tokens: '180000' }],
    ['null', { ...whole, input_tokens: null }],
    ['a boolean', { ...whole, input_tokens: true }],
    ['a fraction', { ...whole, input_tokens: 0.5 }],
    ['a negative count', { ...whole, input_tokens: -5 }],
    ['past the safe integer range', { input_tokens: 1e308, cache_read_input_tokens: 1e308 }],
    ['a SUM past the safe integer range', { input_tokens: 9e15, cache_read_input_tokens: 9e15 }],
  ]) {
    writeFileSync(p.transcript, [record(whole), record(usage)].join('\n') + '\n');
    silent(fire(g, post(p, { session_id: `shapes-${i++}` })), why);
  }
  // A counter that is simply ABSENT is still 0, which is what the spec fixes.
  writeFileSync(p.transcript, `${record({ input_tokens: 182000 })}\n`);
  assert.equal(nudged(fire(g, post(p, { session_id: 'shapes-absent' }))), NUDGE(91, 200000, 'default'));
});

test('Stop: a handoff heading counts only on a LINE OF ITS OWN — not glued to an unterminated line, not `##\\nHandoff`', () => {
  const g = guard();
  // A ledger whose last line has no newline on it: the block appended after it
  // reads as `…mid-line## Handoff`, which is text and not a heading. Reading
  // from the recorded offset alone would see `## Handoff` at byte 0 and call it
  // one, so the read starts ONE BYTE EARLIER and asks what that byte was.
  const glued = project(g, 'glued', { ledgers: { 'ledger-0.3.4.md': '# ledger\nRuling: the last line has no newline' } });
  cross(g, glued);
  appendFileSync(glued.ledger(), '## Handoff 2026-09-09T09:00Z\nnot a heading — it is the tail of the line above\n');
  assert.equal(blocked(fire(g, stopEvent(glued))), BLOCK(91, 200000));

  // `##` and `Handoff` on two lines is two things, neither of them a handoff.
  const split = project(g, 'split-heading');
  cross(g, split);
  appendFileSync(split.ledger(), '\n##\nHandoff 2026-09-09T09:00Z\nstate: nowhere\n');
  assert.equal(blocked(fire(g, stopEvent(split))), BLOCK(91, 200000));

  // `## Handoffs` is a heading about handoffs, not a handoff block.
  const plural = project(g, 'plural-heading');
  cross(g, plural);
  appendFileSync(plural.ledger(), '\n## Handoffs, and why we write them\nnot a handoff either\n');
  assert.equal(blocked(fire(g, stopEvent(plural))), BLOCK(91, 200000));

  // …while the same block on a line of its own, after a terminated one, counts.
  const clean = project(g, 'clean-heading');
  cross(g, clean);
  appendFileSync(clean.ledger(), '\n## Handoff 2026-09-09T09:05Z\nWhere it stands: T2 in review.\n');
  silent(fire(g, stopEvent(clean)), 'a heading on its own line is the block');
});

/**
 * A directory the guard may READ and may not WRITE. Where chmod means nothing —
 * Windows, or a run as root, which ignores the mode entirely — there is no such
 * directory to be had and the test says so instead of pretending.
 */
function makeUnwritable(dir) {
  if (process.platform === 'win32') return false;
  if (typeof process.getuid === 'function' && process.getuid() === 0) return false;
  chmodSync(dir, 0o500);
  try { writeFileSync(join(dir, 'probe'), 'x'); return false; } catch { return true; }
}

test('a note the guard could not write is a note it does not act on: no nudge, no gate, no state', (t) => {
  const g = guard();
  const p = project(g, 'unwritable');
  const omelette = join(p.dir, '.omelette');
  if (!makeUnwritable(omelette)) { t.skip('this platform has no unwritable directory for this user'); return; }
  try {
    // The crossing cannot be recorded, so it is not announced either: a nudge
    // that is said and forgotten is said on every tool call afterwards.
    silent(fire(g, post(p)), 'the crossing could not be recorded');
    assert.equal(existsSync(p.statePath), false, 'and nothing was written');
  } finally { chmodSync(omelette, 0o700); }

  // The same for the gate: a crossing recorded while the directory was
  // writable, and a Stop that cannot mark the turn as held.
  cross(g, p);
  if (!makeUnwritable(omelette)) { t.skip('this platform has no unwritable directory for this user'); return; }
  try {
    silent(fire(g, stopEvent(p)), 'the gate could not record that it fired');
    assert.equal(p.state()['s-1'].blocked, false, 'and the entry is untouched');
  } finally { chmodSync(omelette, 0o700); }
});

test('the state file never grows past the cap it is read under — the oldest crossings go, the live one stays', () => {
  const g = guard();
  // Many ledgers: a crossing records one offset per ledger, so this project's
  // own entry is kilobytes rather than bytes — which is how a state file that
  // was fine yesterday stops being readable today.
  const ledgers = {};
  for (let i = 0; i < 400; i++) ledgers[`ledger-plan-${String(i).padStart(3, '0')}.md`] = `# plan ${i}\n`;
  const p = project(g, 'bytecap', { ledgers });

  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const bulky = (n) => {
    const offsets = {};
    for (let i = 0; i < 200; i++) offsets[`ledger-plan-${String(i).padStart(3, '0')}.md`] = 1000 + i;
    return { crossedAt: iso(n * 60000), ledgers: offsets, nudged: true, blocked: true };
  };
  // Just under the cap, and under the 64-entry cap as well, so it is the BYTES
  // that do the trimming below and not the count.
  const seeded = {};
  let n = 0;
  while (n < 63) {
    seeded[`filler-${String(n).padStart(2, '0')}`] = bulky(n);
    if (JSON.stringify(seeded).length > 255 * 1024) { delete seeded[`filler-${String(n).padStart(2, '0')}`]; break; }
    n++;
  }
  assert.ok(JSON.stringify(seeded).length > 200 * 1024, 'the fixture has to start near the cap to test it');
  assert.ok(n <= 63, 'and under the entry cap, or the count would do the trimming');
  writeFileSync(p.statePath, JSON.stringify(seeded));

  assert.equal(nudged(fire(g, post(p))), NUDGE(91, 200000, 'default', 'one of the ledgers in .omelette/'));
  const size = statSync(p.statePath).size;
  assert.ok(size <= 256 * 1024, `a state file past its own read cap is a state file nobody reads again: ${size}`);
  const state = p.state();
  assert.ok(state['s-1'], 'the crossing being recorded survives the trim');
  assert.equal(Object.keys(state['s-1'].ledgers).length, 400, 'with every ledger offset it took');
  assert.ok(Object.keys(state).length < n + 1, 'and the oldest entries are the ones that went');
  assert.ok(state['filler-00'], 'the newest of them are kept');
  assert.equal(state[`filler-${String(n - 1).padStart(2, '0')}`], undefined, 'the oldest is dropped first');
});

/** How long a spawned guard has been running, and its answer once it is over. */
function fireSlowly(g, input, { cwd, bootMs = 300 } = {}) {
  const child = spawn(process.execPath, [g.path], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: g.dir },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  const done = new Promise((resolve) => child.on('close', () => resolve(out)));
  // Booted and waiting on stdin: the guard reads the event before it reads
  // anything else, so closing stdin is what starts its clock.
  const started = new Promise((resolve) => setTimeout(() => {
    child.stdin.end(JSON.stringify(input));
    resolve();
  }, bootMs));
  return { done, started };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('two sessions crossing at once: the write merges onto the CURRENT map instead of restoring a stale one', async (t) => {
  // The window is real and small: the guard reads the state file early and
  // writes it at the end of its run, and another session's guard can land in
  // between. Opening it from a test means making one run slow between those
  // two points — 4000 ledgers to size and scan for a handoff, measured at
  // ~120 ms against ~10 ms to the read — and writing the other session's entry
  // while it is busy. The three outcomes are told apart below, so a run that
  // was simply too fast is retried rather than reported either way.
  const g = guard();
  const dir = join(g.dir, 'merge');
  mkdirSync(join(dir, '.omelette'), { recursive: true });
  for (let i = 0; i < 4000; i++) {
    writeFileSync(join(dir, '.omelette', `ledger-${String(i).padStart(4, '0')}.md`), `# ledger ${i}\n${'x'.repeat(512)}\n`);
  }
  const transcript = join(dir, 'transcript.jsonl');
  writeTranscript(transcript, 182000);
  const statePath = join(dir, '.omelette', 'handoff-state.json');
  const entry = () => ({ crossedAt: new Date().toISOString(), ledgers: {}, nudged: true, blocked: false });
  const event = {
    hook_event_name: 'PostToolUse', session_id: 'slow', transcript_path: transcript, cwd: dir,
    tool_name: 'Bash', tool_input: { command: 'npm test' },
  };

  for (let attempt = 1; attempt <= 5; attempt++) {
    // What the slow run will read: one entry, and it is not its own.
    writeFileSync(statePath, JSON.stringify({ before: entry() }));
    const slow = fireSlowly(g, event, { cwd: dir });
    await slow.started;
    await delay(30 * attempt); // the read is a handful of syscalls past the event
    // Another session's guard, landing while the slow one is still scanning.
    writeFileSync(statePath, JSON.stringify({ before: entry(), other: entry() }));
    await slow.done;

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.slow && state.other) return; // merged: the write read the file again
    assert.ok(!state.slow, 'the stale snapshot was written back and the other session\'s crossing was lost');
    // The slow run finished before the other session wrote: no window, no proof.
  }
  t.skip('the race window never opened on this machine — the guard finished before the second writer');
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

test('PostToolUse: a model id ending in `[1m]` is a 1 000 000 ceiling — from the environment, from either user settings file, and never above autoCompactWindow', () => {
  const g = guard();
  const p = project(g, 'model-1m', { fill: 950000 }); // 95% of 1000000
  mkdirSync(join(g.dir, '.claude'), { recursive: true });
  const local = join(g.dir, '.claude', 'settings.local.json');
  const shared = join(g.dir, '.claude', 'settings.json');

  // 4a. ANTHROPIC_MODEL in the hook's own environment. Every step below uses a
  // session id of its own, so each run is a fresh crossing.
  assert.equal(
    nudged(fire(g, post(p, { session_id: 'model-env' }), { env: { ANTHROPIC_MODEL: 'claude-fable-5-1[1m]' } })),
    NUDGE(95, 1000000, 'model[1m]'),
  );

  // 4b. The `model` key of the USER's own settings, the local file first, as
  // the client reads them.
  writeFileSync(local, JSON.stringify({ model: 'claude-fable-5-1[1m]' }));
  assert.equal(nudged(fire(g, post(p, { session_id: 'model-local' }))), NUDGE(95, 1000000, 'model[1m]'));

  // …settings.json when the local file says nothing about a model, with the
  // suffix read case-insensitively and past the whitespace a hand-edited file
  // carries.
  writeFileSync(local, JSON.stringify({ permissions: { allow: [] } }));
  writeFileSync(shared, JSON.stringify({ model: '  claude-opus-5[1M]  ' }));
  assert.equal(nudged(fire(g, post(p, { session_id: 'model-shared' }))), NUDGE(95, 1000000, 'model[1m]'));

  // A local file that does not parse is skipped and the next one is read — the
  // same fall-through `autoCompactWindow` makes, and the same one doctor makes.
  writeFileSync(local, '{ "model": "claude-opus-5[1m]", }');
  assert.equal(nudged(fire(g, post(p, { session_id: 'model-broken-local' }))), NUDGE(95, 1000000, 'model[1m]'));

  // 3 BEATS 4: an operator who capped the window on purpose meant it, whatever
  // model the session happens to be running.
  writeFileSync(local, JSON.stringify({ autoCompactWindow: '500k', model: 'claude-opus-5[1m]' }));
  writeTranscript(p.transcript, 460000); // 92% of 500000
  assert.equal(
    nudged(fire(g, post(p, { session_id: 'cap-beats-model' }), { env: { ANTHROPIC_MODEL: 'claude-fable-5-1[1m]' } })),
    NUDGE(92, 500000, 'autoCompactWindow'),
  );

  // …and so does the environment variable, over both of them.
  writeTranscript(p.transcript, 230000); // 92% of 250000
  assert.equal(
    nudged(fire(g, post(p, { session_id: 'env-beats-model' }), {
      env: { ANTHROPIC_MODEL: 'claude-opus-5[1m]', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250k' },
    })),
    NUDGE(92, 250000, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'),
  );

  // …and so does the rendered `handoff.contextWindow`, which is the value the
  // operator put in the fleet config and re-rendered.
  const pinned = guard({ contextWindow: 400000 });
  const q = project(pinned, 'pinned-over-model', { fill: 380000 }); // 95% of 400000
  assert.equal(
    nudged(fire(pinned, post(q), { env: { ANTHROPIC_MODEL: 'claude-opus-5[1m]' } })),
    NUDGE(95, 400000, 'handoff.contextWindow'),
  );

  // A CLAUDE_CONFIG_DIR is honoured for the `model` key exactly as it is for
  // `autoCompactWindow`: same directory rule, same two files, same order.
  const cfg = join(g.dir, 'cfgdir');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ model: 'claude-opus-5[1m]' }));
  writeTranscript(p.transcript, 950000);
  assert.equal(
    nudged(fire(g, post(p, { session_id: 'model-configdir' }), { env: { CLAUDE_CONFIG_DIR: cfg } })),
    NUDGE(95, 1000000, 'model[1m]'),
  );
});

test('PostToolUse: a model that does not end in `[1m]` is not a window — and the PROJECT\'s settings are not the user\'s', () => {
  const g = guard();
  const p = project(g, 'model-not-1m', { fill: 182000 }); // 91% of 200000
  mkdirSync(join(g.dir, '.claude'), { recursive: true });
  const shared = join(g.dir, '.claude', 'settings.json');

  // The user scope only. A `[1m]` in the project's own settings changes nothing:
  // this hook reads the user's pair, exactly as doctor does.
  mkdirSync(join(p.dir, '.claude'), { recursive: true });
  writeFileSync(join(p.dir, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5[1m]' }));
  assert.equal(nudged(fire(g, post(p, { session_id: 'project-scope' }))), NUDGE(91, 200000, 'default'));

  // The suffix has to END the id.
  let i = 0;
  for (const model of ['claude-opus-5', 'claude-opus-5[1m] (default)', 'claude-opus-5[1m]x', 'claude-1m', 'opus[2m]', '[1m]-opus', '']) {
    assert.equal(
      nudged(fire(g, post(p, { session_id: `model-bad-env-${i++}` }), { env: { ANTHROPIC_MODEL: model } })),
      NUDGE(91, 200000, 'default'),
      JSON.stringify(model),
    );
  }

  // A `model` key that is not a string is not an id: a number, a boolean, a
  // null, an array and an object are each skipped rather than stringified into
  // something that might end in the suffix.
  for (const model of [1000000, true, null, ['claude-opus-5[1m]'], { id: 'claude-opus-5[1m]' }]) {
    writeFileSync(shared, JSON.stringify({ model }));
    assert.equal(
      nudged(fire(g, post(p, { session_id: `model-bad-file-${i++}` }))),
      NUDGE(91, 200000, 'default'),
      JSON.stringify(model),
    );
  }

  // A file that is not JSON at all and one whose top level is not an object are
  // skipped in silence, and with nothing readable anywhere the ceiling is
  // Claude Code's documented default.
  writeFileSync(join(g.dir, '.claude', 'settings.local.json'), 'not json at all');
  writeFileSync(shared, '[1, 2]');
  assert.equal(nudged(fire(g, post(p, { session_id: 'model-unparseable' }))), NUDGE(91, 200000, 'default'));
});
