/**
 * omelette-fleet :: test/tester-0.3.2-review.test.mjs
 * Clean-context tester coverage for spec docs/superpowers/specs/2026-09-06-0.3.2-design.md,
 * written against `git diff HEAD` in this checkout (feat/0.3.2, uncommitted work
 * on top of 05351fa). Section 3 (Grok output cap) already has thorough coverage
 * from an earlier round (test/config.test.mjs, test/grok.test.mjs,
 * test/spawn.test.mjs, test/unit.test.mjs, test/outputcap-tester.test.mjs) and
 * is not repeated here. This file targets what the implementer's own new tests
 * (test/cli.test.mjs, test/hooks.test.mjs, test/rules.test.mjs) left uncovered
 * for sections 4 and 5:
 *   - a skill directory that is itself a symlink is never touched by
 *     `--remove --agents` (spec section 4: "... and is not a symlink");
 *   - a guard wired through the WINDOWS-quoted snippet (double quotes, doubled
 *     backslashes) is still recognised by `doctor` on whatever platform runs
 *     the check — spec section 5: "hookWiringAt keeps matching on the script
 *     name" regardless of which platform produced the snippet.
 *
 * Does not edit the implementation or the implementer's own test files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookSettingsSnippet } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const symlinksWork = process.platform !== 'win32';

function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-review-'));
}

const rulesIn = (proj, dir, args = []) => spawnSync(process.execPath, [BIN, 'rules', ...args], {
  cwd: proj,
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
});

const doctorIn = (proj, dir, env = {}) => spawnSync(process.execPath, [BIN, 'doctor'], {
  cwd: proj,
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
}).stdout;

// ─── section 4: the skill's own directory being a symlink ────────────────────

test(
  '`--remove --agents` never touches a skill directory that is itself a symlink — the file, the link and its target all survive',
  { skip: !symlinksWork && 'symlinks need privileges on this platform' },
  () => {
    const dir = home();
    const proj = join(dir, 'proj'); mkdirSync(proj);
    const skillDir = join(proj, '.claude', 'skills', 'omelette-test');
    const skill = join(skillDir, 'SKILL.md');

    // Write the skill normally, then replace its directory with a symlink to
    // an equivalent one elsewhere — the shape a planted link or a shared/mounted
    // skills directory could produce.
    assert.equal(rulesIn(proj, dir, ['--agents']).status, 0);
    const rendered = readFileSync(skill, 'utf8');
    const elsewhere = mkdtempSync(join(dir, 'elsewhere-'));
    writeFileSync(join(elsewhere, 'SKILL.md'), rendered);
    spawnSync('rm', ['-rf', skillDir]);
    symlinkSync(elsewhere, skillDir, 'dir');
    assert.ok(lstatSync(skillDir).isSymbolicLink(), 'test setup: the skill dir is a symlink');

    const removed = rulesIn(proj, dir, ['--remove', '--agents']);
    // Spec: rmdirSync fires ONLY when the directory "is not a symlink" — so the
    // whole removal must leave a symlinked skill directory exactly as it was,
    // never silently unlink the link, never remove or empty its target.
    assert.equal(removed.status, 1, `a symlinked skill dir must not be silently accepted:\n${removed.stdout}${removed.stderr}`);
    assert.ok(lstatSync(skillDir).isSymbolicLink(), 'the symlink itself must survive');
    assert.ok(existsSync(elsewhere), 'the symlink target directory must survive');
    assert.ok(existsSync(join(elsewhere, 'SKILL.md')), 'the file behind the symlink must survive untouched');
    assert.equal(readFileSync(join(elsewhere, 'SKILL.md'), 'utf8'), rendered);
  },
);

// ─── section 5: hookWiringAt recognises a WINDOWS-quoted snippet too ─────────

test('doctor recognises a guard wired through the WINDOWS-quoted snippet, run on whatever platform this test executes on', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);

  // Write the guard script itself the normal (platform-independent) way…
  const written = rulesIn(proj, dir, ['--hooks']);
  assert.equal(written.status, 0, written.stderr);
  const guardPath = join(proj, '.claude', 'hooks', 'omelette-guard.mjs');
  assert.ok(existsSync(guardPath));

  // …but paste the WIN32-quoted form of the snippet into settings.json — the
  // form an operator on Windows would actually have: double quotes, and the
  // backslashes of a REAL Windows path doubled by the JSON layer. The POSIX
  // path this checkout's guard actually lives at has no backslashes to double,
  // so this uses a synthetic Windows path with the same basename — `hookWiring`
  // matches on the script's NAME as a substring, never on the path resolving.
  const winPath = `C:\\Users\\me\\.claude\\hooks\\${basename(guardPath)}`;
  const winLines = hookSettingsSnippet(winPath, 'win32');
  const winSnippet = winLines.join('\n');
  assert.match(winSnippet, /\\\\/, 'sanity: the win32 snippet really is backslash-doubled');
  writeFileSync(join(proj, '.claude', 'settings.json'), winSnippet);

  const out = doctorIn(proj, dir);
  // "hookWiringAt keeps matching on the script name" (spec §5) — the check is a
  // substring match on the script's basename, so the win32 quoting must not
  // make a real doctor run (on THIS host's platform) report it as unwired.
  assert.match(
    out,
    /^hooks {9}project: v\d+\.\d+\.\d+\S* \(wired: PreToolUse, PreCompact, SessionStart\)/m,
    `a win32-quoted, correctly-targeted snippet must still read as wired:\n${out}`,
  );
});
