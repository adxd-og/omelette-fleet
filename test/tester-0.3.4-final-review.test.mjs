/**
 * omelette-fleet :: test/tester-0.3.4-final-review.test.mjs
 *
 * Independent tester pass on the 0.3.4 release (spec
 * docs/superpowers/specs/2026-09-08-0.3.4-design.md), driven against the
 * working tree as it stands for the final review round. The implementer's own
 * tests (test/hooks-handoff.test.mjs, test/hooks-handoff-extra.test.mjs,
 * test/hooks.test.mjs, test/rules.test.mjs, test/config.test.mjs,
 * test/cli.test.mjs, test/tester-0.3.4-p2-review.test.mjs,
 * test/tester-0.3.4-p3-review.test.mjs) already cover the auto-handoff
 * mechanism, the guard classifier regressions (2b/2c/2d) and the small items
 * (3a/3c) in depth. This file targets three things the spec fixes in words
 * that none of those files exercise directly:
 *
 *   - §1e: "an install still at three shows hooks: … missing PostToolUse,
 *     Stop". Every existing doctor-wiring test either wires nothing, wires
 *     only PreToolUse, or wires everything but PreCompact — none of them
 *     pins the exact upgrade scenario the spec names: an operator's 0.3.3
 *     settings.json (PreToolUse + PreCompact + SessionStart, the three
 *     events that existed before 0.3.4) read by the 0.3.4 CLI.
 *   - doctor's `mergeUnreadable`: its own docstring says two readers open the
 *     same settings files and an operator with ONE broken file wants ONE
 *     line, not one per reader. The shipped tests exercise the case where a
 *     broken file is named by hookWiringAt but never opened by readClientEnv
 *     (a short-circuit past it) — not the case the docstring actually
 *     describes, where the SAME file trips both readers and dedup is what
 *     keeps the line from being printed twice.
 *   - §2d: "a path containing `$`, a space or a quote must survive
 *     `shellQuote` on both platforms. Test with such a path; fix the
 *     quoting if it does not." The shipped `hookSettingsSnippet` test in
 *     test/rules.test.mjs only exercises a path with a space — never `$` or
 *     an embedded quote, and never through a real shell. This file runs the
 *     printed command through `/bin/sh` on POSIX so a `$` that got
 *     interpolated, or a quote that broke the string early, shows up as a
 *     wrong answer rather than a passing assertion about the wrong thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookSettingsSnippet } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-p4-final-'));
}

const rulesIn = (proj, dir, args = []) => spawnSync(process.execPath, [BIN, 'rules', ...args], {
  cwd: proj, encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
});

const doctorIn = (proj, dir, env = {}) => spawnSync(process.execPath, [BIN, 'doctor'], {
  cwd: proj, encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
});

/** The pasteable snippet out of a `rules --hooks` run's stdout, parsed. */
function snippetFrom(stdout) {
  const lines = stdout.split('\n');
  const at = lines.indexOf('{ "hooks": {');
  assert.ok(at >= 0, `no snippet in:\n${stdout}`);
  // The opener line, 6 event lines, and the closer is on the same line as the
  // last event — 7 lines total, exactly as SNIPPET() in test/cli.test.mjs
  // builds it.
  return JSON.parse(lines.slice(at, at + 7).join('\n'));
}

// ─── §1e: the exact upgrade scenario the spec names ───────────────────────────

test('doctor: an operator\'s 0.3.3 settings.json (PreToolUse + PreCompact + SessionStart only) reports "missing PostToolUse, Stop, PostCompact" — the exact wording the spec fixes', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const written = rulesIn(proj, dir, ['--hooks']);
  assert.equal(written.status, 0, written.stderr);
  const snippet = snippetFrom(written.stdout);

  // The three events wired by 0.3.3, before PostToolUse and Stop existed at
  // all: an operator who has not re-pasted the snippet since upgrading has
  // exactly this settings.json.
  const settingsPath = join(proj, '.claude', 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      PreToolUse: snippet.hooks.PreToolUse,
      PreCompact: snippet.hooks.PreCompact,
      SessionStart: snippet.hooks.SessionStart,
    },
  }, null, 2));

  const out = doctorIn(proj, dir).stdout;
  assert.match(
    out,
    /^hooks {9}project: v\d+\.\d+\.\d+\S* \(NOT wired \(missing PostToolUse, Stop, PostCompact\) — paste the snippet from rules --hooks\)/m,
    out,
  );
});

// ─── doctor's mergeUnreadable: the SAME broken file must be named once ────────

test('doctor: a settings file broken enough to trip BOTH the timeout-wall reader and the hook-wiring reader is still named exactly ONCE', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  // grok stays enabled so timeoutWalls() actually reads settings for the wall
  // and idle env vars — the same file the hook-wiring reader below also opens.
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({
    version: 1, units: { gemini: { enabled: false }, codex: { enabled: false }, grok: { timeoutS: 600 } },
  }));
  mkdirSync(join(proj, '.claude'), { recursive: true });
  // Broken JSON, and no settings.local.json at all: this is the ONE file both
  // readClientEnv (for MCP_TOOL_TIMEOUT / the idle var) and hookWiringAt (for
  // the `hooks` block) will open and fail to parse.
  writeFileSync(join(proj, '.claude', 'settings.json'), '{ "env": { "FOO": "bar", } }');
  const settingsPath = join(realpathSync(proj), '.claude', 'settings.json');

  const out = doctorIn(proj, dir).stdout;
  const unreadableLines = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('settings: '));
  assert.deepEqual(
    unreadableLines,
    [`settings: ${settingsPath} unreadable — its values were not consulted`],
    `mergeUnreadable's own docstring: "an operator with one broken file wants one line about it, not one per reader" — got:\n${out}`,
  );
});

// ─── §2d: `$`, a space and an embedded quote, through a REAL shell ────────────

test(
  'hookSettingsSnippet: a script path holding `$`, an apostrophe, a `"` and a space survives shell quoting — proven by actually running the printed command in /bin/sh',
  { skip: process.platform === 'win32' && 'exercises a POSIX shell' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'omelette-shellquote-'));
    // $HOME would expand into something else entirely if the quoting failed to
    // protect it; the apostrophe would end a naive single-quoted string early
    // and hand the rest of the path to the shell as a second command; the
    // space would split the path into two arguments a naive quoting left bare;
    // and the double quote is along for the ride, because POSIX single quotes
    // need do nothing special with it.
    const weird = join(dir, `we'ird $HOME "money" dir`);
    mkdirSync(weird);
    const script = join(weird, 'omelette-guard.mjs');
    writeFileSync(script, "console.log('MARKER-OK');\n");

    const parsed = JSON.parse(hookSettingsSnippet(script, 'darwin').join('\n'));
    const command = parsed.hooks.PreToolUse[0].hooks[0].command;
    assert.equal(typeof command, 'string');

    // A HOME that is deliberately wrong: if `$HOME` in the path were expanded
    // by the shell rather than protected by the quoting, this run would try to
    // execute a script under /should-not-be-used instead and fail to find it.
    const r = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8', env: { ...process.env, HOME: '/should-not-be-used-and-does-not-exist' },
    });
    assert.equal(r.status, 0, `${command}\nstdout=${JSON.stringify(r.stdout)}\nstderr=${JSON.stringify(r.stderr)}`);
    assert.equal(r.stdout, 'MARKER-OK\n', `the shell ran something other than the intended script — stderr: ${r.stderr}`);
  },
);

test('hookSettingsSnippet: the Windows form protects `$` and an apostrophe too (double quotes; Windows paths cannot hold a `"`)', () => {
  // `resolve()` inside hookSettingsSnippet always resolves against the HOST's
  // own path shape (this suite runs on POSIX): a leading `/` is what the
  // existing plain-path Windows test already uses to make the fixture
  // POSIX-absolute without `resolve()` prepending this checkout's own cwd —
  // the drive letter is real Windows syntax and the leading slash is a
  // test-only stand-in for running the resolve step on a POSIX host.
  const weird = '/C\\Users\\me\\$HOME\'s app\\.claude\\hooks\\omelette-guard.mjs';
  const parsed = JSON.parse(hookSettingsSnippet(weird, 'win32').join('\n'));
  const command = parsed.hooks.PreToolUse[0].hooks[0].command;
  // cmd.exe interpolates neither `$` nor `'` inside a double-quoted string, so
  // the raw characters have to appear verbatim in the DECODED command — the
  // doubled backslashes are only in the JSON serialisation on the wire
  // (JSON.stringify's own escaping), and `command` here is already parsed
  // back out of it, exactly like every other value this test reads.
  const expected = `node "${weird}"`;
  assert.equal(command, expected, command);
});
