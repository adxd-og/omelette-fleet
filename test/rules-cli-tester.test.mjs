/**
 * omelette-fleet :: test/rules-cli-tester.test.mjs
 * Independent tester pass over spec sections 3 ("omelette-fleet rules"), 3b
 * ("Shipped agent definitions: --agents") and 4 ("doctor and update hooks") of
 * docs/superpowers/specs/2026-09-05-rules-delivery-design.md.
 *
 * Input is the spec and the diff at
 * .superpowers/sdd/2026-09-05-rules-delivery/review-task-3-4.diff — never the
 * implementer's summary. These tests are ADDITIONAL to test/cli.test.mjs and
 * target behaviours the spec promises that were uncovered, or only weakly
 * covered, there. Never edit test/cli.test.mjs or the implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_MARKER as agentMarker, RULES_MARKER as rulesMarker } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** A fresh fleet home per test; HOME follows it so nothing leaks into the real one. */
function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-cli-tester-'));
}

/** Run the CLI with a clean-ish env, cwd defaulting to `dir` unless a project dir is given. */
function cli(args, { dir, cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd || dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// Fixtures built from the SHARED builders (core/rules.mjs), never retyped here:
// a hand-copied marker would test a file the CLI is right to refuse.
const AGENT_MARKER = (v) => `---\n${agentMarker(v)}\nname: omelette-coder\n---\nold\n`;
const RULES_MARKER = (v, body = 'old\n') => `${rulesMarker(v)}\n${body}`;

const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// ─── §3: --print --agents ───────────────────────────────────────────────────

test('--print --agents prints all three files with a ===== name ===== separator, and writes nothing', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const r = cli(['rules', '--print', '--agents'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.startsWith('<!-- omelette-fleet rules v'), 'rules file comes first, unlabeled');
  assert.match(r.out, /\n===== omelette-coder\.md =====\n\n---\n# omelette-fleet agent v/);
  assert.match(r.out, /\n===== omelette-tester\.md =====\n\n---\n# omelette-fleet agent v/);
  // order: rules, then coder, then tester
  const iCoder = r.out.indexOf('===== omelette-coder.md =====');
  const iTester = r.out.indexOf('===== omelette-tester.md =====');
  assert.ok(iCoder > 0 && iTester > iCoder);
  assert.equal(existsSync(join(proj, '.claude')), false, '--print must touch nothing on disk');
});

// ─── §3: --dry-run --agents with one foreign agent file ─────────────────────

test('--dry-run --agents on a tree with one foreign agent file: refuses that file, previews the rest, writes nothing', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(join(proj, '.claude', 'agents'), { recursive: true });
  const coderPath = join(proj, '.claude', 'agents', 'omelette-coder.md');
  writeFileSync(coderPath, '---\nname: mine\n---\nnot ours\n');
  const r = cli(['rules', '--dry-run', '--agents'], { dir, cwd: proj });
  assert.equal(r.code, 1, 'one refused file makes the whole run exit 1');
  assert.match(r.out, /^would write .*omelette-fleet\.md/m, 'the rules file previews fine');
  assert.match(r.out, /^would write .*omelette-tester\.md/m, 'the other agent file previews fine');
  assert.match(r.err, /omelette-coder\.md.*not managed by omelette-fleet/);
  assert.doesNotMatch(r.out, /would write .*omelette-coder\.md/);
  // Nothing on disk changed at all.
  assert.equal(readFileSync(coderPath, 'utf8'), '---\nname: mine\n---\nnot ours\n');
  assert.equal(existsSync(join(proj, '.claude', 'rules')), false);
  assert.equal(existsSync(join(proj, '.claude', 'agents', 'omelette-tester.md')), false);
});

// ─── §3b: --remove alone leaves agent files in place ────────────────────────

test('--remove without --agents removes only the rules file; agent files are left untouched', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  mkdirSync(join(proj, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(proj, '.claude', 'rules'), { recursive: true });
  const rulesPath = join(proj, '.claude', 'rules', 'omelette-fleet.md');
  const coderPath = join(proj, '.claude', 'agents', 'omelette-coder.md');
  writeFileSync(rulesPath, RULES_MARKER(pkgVersion));
  writeFileSync(coderPath, AGENT_MARKER(pkgVersion));
  const r = cli(['rules', '--remove'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.equal(existsSync(rulesPath), false, 'the rules file is gone');
  assert.ok(existsSync(coderPath), 'the agent file is untouched by a bare --remove');
  assert.equal(readFileSync(coderPath, 'utf8'), AGENT_MARKER(pkgVersion));
});

// ─── §3b: --remove --agents when only the rules file exists ─────────────────

test('--remove --agents on a tree where only the rules file exists: removes it, and reports nothing-to-remove for the absent agent files', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(join(proj, '.claude', 'rules'), { recursive: true });
  const rulesPath = join(proj, '.claude', 'rules', 'omelette-fleet.md');
  writeFileSync(rulesPath, RULES_MARKER(pkgVersion));
  const r = cli(['rules', '--remove', '--agents'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^removed .*omelette-fleet\.md/m);
  assert.match(r.out, /nothing to remove.*omelette-coder\.md/);
  assert.match(r.out, /nothing to remove.*omelette-tester\.md/);
  assert.equal(existsSync(rulesPath), false);
  assert.equal(existsSync(join(proj, '.claude', 'agents')), false);
});

// ─── §3: a marker with a prerelease version is treated as ours, and refreshed ─

test('a marker with a prerelease version (v0.3.0-rc.1) is treated as OURS — refreshed without --force, no refusal', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(join(proj, '.claude', 'rules'), { recursive: true });
  const target = join(proj, '.claude', 'rules', 'omelette-fleet.md');
  const original = RULES_MARKER('0.3.0-rc.1');
  writeFileSync(target, original);
  const r = cli(['rules'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /not managed by omelette-fleet/, 'a prerelease marker must not read as foreign');
  assert.match(r.out, new RegExp(`was 0\\.3\\.0-rc\\.1\\)`));
  const rewritten = readFileSync(target, 'utf8');
  assert.notEqual(rewritten, original, 'the stale body was actually replaced');
  assert.ok(rewritten.startsWith(`<!-- omelette-fleet rules v${pkgVersion} `));
});

// ─── §3: --force on a foreign rules file must not touch a foreign agent file unless --agents ─

test('--force on a foreign rules file (no --agents) leaves a foreign agent file completely alone', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  mkdirSync(join(proj, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(proj, '.claude', 'agents'), { recursive: true });
  const rulesPath = join(proj, '.claude', 'rules', 'omelette-fleet.md');
  const coderPath = join(proj, '.claude', 'agents', 'omelette-coder.md');
  writeFileSync(rulesPath, '# my own rules\n');
  writeFileSync(coderPath, '---\nname: mine\n---\n');
  const r = cli(['rules', '--force'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  assert.ok(readFileSync(rulesPath, 'utf8').startsWith('<!-- omelette-fleet rules v'), 'the rules file WAS forced');
  assert.equal(readFileSync(coderPath, 'utf8'), '---\nname: mine\n---\n', 'the agent file is untouched: --agents was not given');
});

// ─── §3b: --global --agents under CLAUDE_CONFIG_DIR ─────────────────────────

test('--global --agents writes the rules file and both agent definitions under CLAUDE_CONFIG_DIR', () => {
  const dir = home();
  const cfg = join(dir, 'cfgdir');
  const r = cli(['rules', '--global', '--agents'], { dir, env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(cfg, 'rules', 'omelette-fleet.md')));
  assert.ok(existsSync(join(cfg, 'agents', 'omelette-coder.md')));
  assert.ok(existsSync(join(cfg, 'agents', 'omelette-tester.md')));
  // and NOT under the default ~/.claude location
  assert.equal(existsSync(join(dir, '.claude')), false);
});

// ─── §3: a .claude/rules path that is itself a FILE ─────────────────────────

test('a .claude/rules path that exists as a FILE (not a directory) fails cleanly: exit 1, nothing else written', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  mkdirSync(join(proj, '.claude'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'rules'), 'i am a file, not a directory\n');
  const r = cli(['rules'], { dir, cwd: proj });
  assert.equal(r.code, 1);
  // Refused on the PATH, before any read: `.claude/rules` is not a directory.
  assert.match(r.err, /omelette-fleet rules: refusing .*omelette-fleet\.md: .*[/\\]rules is not a directory/i);
  // Nothing else was written: the blocking path is still exactly the plain file it was,
  // no tmp file escaped next to it, and no unrelated directory (e.g. .claude/agents) appeared.
  assert.equal(readFileSync(join(proj, '.claude', 'rules'), 'utf8'), 'i am a file, not a directory\n');
  assert.equal(existsSync(join(proj, '.claude', 'agents')), false);
  assert.deepEqual(readdirSync(join(proj, '.claude')), ['rules']);
});

// ─── §3: a FIFO at the target is refused, never read ────────────────────────

test('a FIFO where the rules file should be is refused, and the run never blocks on it', { skip: process.platform === 'win32' && 'mkfifo is POSIX-only' }, () => {
  const dir = home();
  const proj = join(dir, 'proj');
  const rulesDir = join(proj, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  const target = join(rulesDir, 'omelette-fleet.md');
  const mk = spawnSync('mkfifo', [target], { encoding: 'utf8' });
  if (mk.status !== 0) return; // no mkfifo on this box: nothing to prove here
  // A readFileSync on a FIFO with no writer never returns, so the timeout is
  // the assertion: the path check has to happen BEFORE the read.
  const r = spawnSync(process.execPath, [BIN, 'rules'], {
    cwd: proj, encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  assert.equal(r.signal, null, 'the CLI blocked on the FIFO instead of refusing it');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /omelette-fleet rules: refusing .*omelette-fleet\.md: .*omelette-fleet\.md is not a regular file/);
  assert.doesNotMatch(r.stderr, /at .*omelette-fleet\.mjs/);
  assert.ok(existsSync(target), 'the FIFO is left exactly as it was');
});

// ─── §4: doctor — one agent file missing (partial), and one foreign ─────────

test('doctor reports agents as partial (N/2) when one of the two files is missing', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(join(proj, '.claude', 'agents'), { recursive: true });
  // At the running package's own version, so this is "partial" but never "behind" —
  // isolates the partial-count wording from the separate stale-refresh-hint suffix.
  writeFileSync(join(proj, '.claude', 'agents', 'omelette-coder.md'), AGENT_MARKER(pkgVersion));
  const r = cli(['doctor'], { dir, cwd: proj });
  assert.equal(r.code, 0, 'a partial agent set is informational, never a fault');
  assert.match(r.out, /^agents {8}project: partial \(1\/2\) · global: absent$/m);
});

test('doctor reports agents as foreign (no marker) as soon as one file lacks the marker', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(join(proj, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'agents', 'omelette-coder.md'), '---\nname: mine\n---\n');
  writeFileSync(join(proj, '.claude', 'agents', 'omelette-tester.md'), AGENT_MARKER('0.1.0'));
  const r = cli(['doctor'], { dir, cwd: proj });
  assert.equal(r.code, 0, 'a foreign agent file is never a fault, only informational');
  assert.match(r.out, /^agents {8}project: foreign \(no marker\) · global: absent$/m);
});

// ─── §4: update --check hint for a stale GLOBAL rules file ──────────────────

test('update --check names --global in the refresh hint for a stale GLOBAL rules file', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const cfg = join(dir, 'cfgdir');
  mkdirSync(join(cfg, 'rules'), { recursive: true });
  const globalRulesPath = join(cfg, 'rules', 'omelette-fleet.md');
  const original = RULES_MARKER('0.0.1');
  writeFileSync(globalRulesPath, original);
  // npm-kind install: a plain package.json with no .git, newer than the marker.
  const pkgRoot = mkdtempSync(join(tmpdir(), 'omelette-npm-tester-'));
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'omelette-fleet', version: '0.2.0' }, null, 2));
  const r = cli(['update', '--check'], { dir, cwd: proj, env: { OMELETTE_PKG_ROOT: pkgRoot, CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(r.code, 0, r.err); // no package update available — only the rules hint fires
  assert.match(r.out, /rules file .*omelette-fleet\.md is v0\.0\.1 \(this install is v0\.2\.0\) — refresh: omelette-fleet rules --global/);
  assert.equal(readFileSync(globalRulesPath, 'utf8'), original, 'update --check must never rewrite it');
});

// ─── §3b: update also hints stale AGENT files ("update hints a refresh for outdated agent files too") ─

test('update --check also hints a refresh for outdated agent definitions, one line per scope, and never rewrites them', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(join(proj, '.claude', 'agents'), { recursive: true });
  const coderPath = join(proj, '.claude', 'agents', 'omelette-coder.md');
  const testerPath = join(proj, '.claude', 'agents', 'omelette-tester.md');
  writeFileSync(coderPath, AGENT_MARKER('0.0.1'));
  writeFileSync(testerPath, AGENT_MARKER('0.0.1'));
  const pkgRoot = mkdtempSync(join(tmpdir(), 'omelette-npm-tester2-'));
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'omelette-fleet', version: '0.2.0' }, null, 2));
  const r = cli(['update', '--check'], { dir, cwd: proj, env: { OMELETTE_PKG_ROOT: pkgRoot } });
  assert.equal(r.code, 0, r.err);
  assert.match(
    r.out,
    /agent files under .*\.claude(\/|\\)agents are v0\.0\.1 \(this install is v0\.2\.0\) — refresh: omelette-fleet rules --agents/,
    'spec §3b: "update hints a refresh for outdated agent files too" — no such hint was found in stdout',
  );
  assert.equal(readFileSync(coderPath, 'utf8'), AGENT_MARKER('0.0.1'), 'update --check must never rewrite an agent file');
  assert.equal(readFileSync(testerPath, 'utf8'), AGENT_MARKER('0.0.1'));
});

// ─── §3: the atomic write leaves no *.tmp file behind ───────────────────────

test('a normal write (rules + agents) leaves no stray *.tmp file in either directory', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const r = cli(['rules', '--agents'], { dir, cwd: proj });
  assert.equal(r.code, 0, r.err);
  const rulesDir = join(proj, '.claude', 'rules');
  const agentsDir = join(proj, '.claude', 'agents');
  for (const d of [rulesDir, agentsDir]) {
    const leftover = readdirSync(d).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftover, [], `stray tmp file(s) in ${d}: ${leftover.join(', ')}`);
  }
});

// ─── §3: unknown flag → exit 1 ───────────────────────────────────────────────

test('rules --nope: unknown flag is refused with exit 1 and nothing written', () => {
  const dir = home();
  const proj = join(dir, 'proj'); mkdirSync(proj);
  const r = cli(['rules', '--nope'], { dir, cwd: proj });
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown flag: --nope/);
  assert.equal(existsSync(join(proj, '.claude')), false);
});
