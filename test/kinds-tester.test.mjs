/**
 * omelette-fleet :: test/kinds-tester.test.mjs
 * Tester sub-agent coverage for 0.3.1 tasks 3 & 4 (managed-kinds registry,
 * the /omelette-test skill, the hooks kind and the guard script) — written
 * from the design spec and the task briefs, against the diff, WITHOUT reading
 * the implementer's own summary.
 *
 * The CLI is driven as a real child process (never imported) for the same
 * reason test/cli.test.mjs gives: exit codes and the stdout/stderr split are
 * only real that way. Every run gets its own throwaway HOME/OMELETTE_HOME,
 * and OMELETTE_UPDATE_CHECK=0 keeps every run off the network.
 *
 * These tests target gaps the existing suite (test/cli.test.mjs,
 * test/rules.test.mjs, test/hooks.test.mjs) does not close:
 *   - --global combined with --agents / --hooks, actually writing under
 *     CLAUDE_CONFIG_DIR and being read back correctly by `doctor`.
 *   - a foreign skill / a foreign hook script refused for --remove, not only
 *     for a write (the existing tests only exercise the write-side refusal
 *     for these two kinds; the rules-kind refusal-on-remove is tested, but
 *     never carried over to skills/hooks explicitly).
 *   - `update --check` printing the stale-file hint for the skill and the
 *     hook kinds specifically (only the agents kind is exercised today).
 *   - the literal claim "rules --agents writes exactly rules + 2 agents + the
 *     skill and nothing else" as one exhaustive listing, not an implication
 *     of several looser existence checks.
 *   - the coder guard's actual security promise ("omelette-coder never …
 *     branches … whatever it was asked to do") against real git syntax the
 *     given regex does not anticipate: attached-flag branch creation
 *     (`checkout -bname`, `switch -cname`) and a global flag ahead of the
 *     subcommand (`git -C <dir> checkout -b name`). Both are verified against
 *     a real git binary below before being asserted against the guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_MARKER, SKILL_MARKER } from '../core/rules.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const GUARD = join(ROOT, 'hooks', 'omelette-guard.mjs'); // the shipped template, not yet rendered

/** A fresh fleet home per test. */
function home() {
  return mkdtempSync(join(tmpdir(), 'omelette-kt-'));
}

/** The CLI, cwd == HOME == OMELETTE_HOME unless overridden — mirrors test/cli.test.mjs's `cli()`. */
function cli(args, { dir, env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/** `rules` run inside a project dir distinct from the fleet home, env extensible. */
const rulesIn = (proj, dir, args = [], env = {}) => spawnSync(process.execPath, [BIN, 'rules', ...args], {
  cwd: proj,
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
});

const doctorIn = (proj, dir, env = {}) => spawnSync(process.execPath, [BIN, 'doctor'], {
  cwd: proj,
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0', ...env },
}).stdout;

const writePkg = (root, version) => writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({ name: 'omelette-fleet', version }, null, 2) + '\n',
);

const pkgVersion = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const MARKED_SKILL = (v) => `---\n${SKILL_MARKER(v)}\nname: omelette-test\n---\nold\n`;
const MARKED_HOOK = (v) => `${HOOK_MARKER(v)}\n// old\n`;

/** Every file under `dir`, as paths relative to it, sorted — for an exhaustive listing assertion. */
function listFilesRec(dir) {
  const found = [];
  const walk = (d, prefix) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), rel);
      else found.push(rel);
    }
  };
  walk(dir, '');
  return found.sort();
}

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

// ─── §3: rules --agents writes EXACTLY rules + 2 agents + the skill ──────────

test('rules --agents writes exactly the rules file, the two agent definitions and the skill — nothing else under .claude', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  const r = rulesIn(proj, dir, ['--agents']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(listFilesRec(join(proj, '.claude')), [
    'agents/omelette-coder.md',
    'agents/omelette-tester.md',
    'rules/omelette-fleet.md',
    'skills/omelette-test/SKILL.md',
  ]);
});

// ─── §3: foreign skill refused for --remove, not only for a write ───────────

test('a foreign skill file (no line-2 marker) is refused for --remove --agents, not only for a write', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  const skill = join(proj, '.claude', 'skills', 'omelette-test', 'SKILL.md');
  mkdirSync(dirname(skill), { recursive: true });
  const foreignText = '---\nname: mine\n---\nnot ours, no marker on line 2\n';
  writeFileSync(skill, foreignText);

  const write = rulesIn(proj, dir, ['--agents']);
  assert.equal(write.status, 1, 'a foreign skill blocks the whole --agents write with exit 1');
  assert.match(write.stderr, /SKILL\.md exists and is not managed by omelette-fleet/);
  // the file-per-file contract: one refusal does not stop the OTHER files
  for (const f of ['omelette-coder.md', 'omelette-tester.md']) {
    assert.ok(existsSync(join(proj, '.claude', 'agents', f)), `${f} should still be written`);
  }
  assert.equal(readFileSync(skill, 'utf8'), foreignText, 'the foreign skill itself is untouched by the write');

  const remove = rulesIn(proj, dir, ['--remove', '--agents']);
  assert.equal(remove.status, 1, 'a foreign skill must not be deleted by --remove --agents either');
  assert.match(remove.stderr, /SKILL\.md exists but is not managed by omelette-fleet/);
  assert.equal(readFileSync(skill, 'utf8'), foreignText, 'still untouched after --remove');
  // …while the files that ARE ours are removed as usual.
  for (const f of ['omelette-coder.md', 'omelette-tester.md']) {
    assert.ok(!existsSync(join(proj, '.claude', 'agents', f)), `${f} should still be removed`);
  }
});

// ─── §4: foreign hook refused for --remove, not only for a write ────────────

test('a foreign hook script (no line-1 marker) is refused for --remove --hooks, not only for a write', () => {
  const dir = home();
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  const guard = join(proj, '.claude', 'hooks', 'omelette-guard.mjs');
  mkdirSync(dirname(guard), { recursive: true });
  const foreignText = '// my own hook, not managed by omelette-fleet\n';
  writeFileSync(guard, foreignText);

  const write = rulesIn(proj, dir, ['--hooks']);
  assert.equal(write.status, 1);
  assert.match(write.stderr, /omelette-guard\.mjs exists and is not managed by omelette-fleet/);
  assert.equal(readFileSync(guard, 'utf8'), foreignText);

  const remove = rulesIn(proj, dir, ['--remove', '--hooks']);
  assert.equal(remove.status, 1, 'a foreign hook script must not be deleted by --remove --hooks either');
  assert.match(remove.stderr, /omelette-guard\.mjs exists but is not managed by omelette-fleet/);
  assert.equal(readFileSync(guard, 'utf8'), foreignText, 'never removed');
});

// ─── §2/§4: --global --hooks, actually writing under CLAUDE_CONFIG_DIR ──────

test('rules --global --hooks writes under CLAUDE_CONFIG_DIR, prints an absolute snippet for THAT path, and doctor sees it wired at global scope', () => {
  const dir = home();
  const cfg = join(dir, 'cfgdir');
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  const env = { CLAUDE_CONFIG_DIR: cfg };

  const write = rulesIn(proj, dir, ['--global', '--hooks'], env);
  assert.equal(write.status, 0, write.stderr);
  const guard = join(cfg, 'hooks', 'omelette-guard.mjs');
  assert.ok(existsSync(guard), 'the guard is written under CLAUDE_CONFIG_DIR, not under the project');
  assert.equal(readFileSync(guard, 'utf8').split('\n')[0], HOOK_MARKER(pkgVersion(ROOT)));
  assert.ok(write.stdout.includes(`node '${guard}'`), `snippet should name the quoted ${guard}:\n${write.stdout}`);
  assert.equal(existsSync(join(proj, '.claude')), false, '--global must not touch the project .claude at all');

  // doctor, same CLAUDE_CONFIG_DIR: absent at project scope, present (not wired) at global.
  const before = doctorIn(proj, dir, env);
  assert.match(before, /^hooks {9}project: absent · global: v\d+\.\d+\.\d+\S* \(NOT wired — paste the snippet from rules --hooks\)$/m, before);

  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${guard}` }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: `node ${guard}` }] }],
    },
  }, null, 2));
  const after = doctorIn(proj, dir, env);
  assert.match(after, /^hooks {9}project: absent · global: v\d+\.\d+\.\d+\S* \(wired: PreToolUse, PreCompact\)$/m, after);
});

test('rules --global --agents writes the skill (and both agent definitions) under CLAUDE_CONFIG_DIR, and doctor counts them at global scope', () => {
  const dir = home();
  const cfg = join(dir, 'cfgdir');
  const proj = join(dir, 'proj');
  mkdirSync(proj);
  const env = { CLAUDE_CONFIG_DIR: cfg };

  const write = rulesIn(proj, dir, ['--global', '--agents'], env);
  assert.equal(write.status, 0, write.stderr);
  assert.ok(existsSync(join(cfg, 'rules', 'omelette-fleet.md')));
  for (const f of ['omelette-coder.md', 'omelette-tester.md']) assert.ok(existsSync(join(cfg, 'agents', f)));
  const skill = join(cfg, 'skills', 'omelette-test', 'SKILL.md');
  assert.ok(existsSync(skill), 'the skill also lands under CLAUDE_CONFIG_DIR for --global --agents');
  assert.equal(readFileSync(skill, 'utf8').split('\n')[1], SKILL_MARKER(pkgVersion(ROOT)));
  assert.equal(existsSync(join(proj, '.claude')), false, '--global must not touch the project at all');

  const out = doctorIn(proj, dir, env);
  assert.match(out, /^skills {8}project: absent · global: v\d+\.\d+\.\d+\S* \(1\)$/m, out);
  assert.match(out, /^agents {8}project: absent · global: v\d+\.\d+\.\d+\S* \(2\)$/m, out);
});

// ─── update --check hints for a stale skill and a stale hook ────────────────

test('update --check hints a stale skill with the --agents refresh command, and a stale hook with the --hooks refresh command', () => {
  const dir = home();
  mkdirSync(join(dir, '.claude', 'skills', 'omelette-test'), { recursive: true });
  mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'skills', 'omelette-test', 'SKILL.md'), MARKED_SKILL('0.0.1'));
  writeFileSync(join(dir, '.claude', 'hooks', 'omelette-guard.mjs'), MARKED_HOOK('0.0.1'));

  const pkgRoot = mkdtempSync(join(tmpdir(), 'omelette-npm-kinds-'));
  writePkg(pkgRoot, '0.5.0');

  const r = cli(['update', '--check'], { dir, env: { OMELETTE_PKG_ROOT: pkgRoot } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /skill files under .*\.claude[/\\]skills are v0\.0\.1 \(this install is v0\.5\.0\) — refresh: omelette-fleet rules --agents/, r.out);
  assert.match(r.out, /hook files under .*\.claude[/\\]hooks are v0\.0\.1 \(this install is v0\.5\.0\) — refresh: omelette-fleet rules --hooks/, r.out);
  // a --check hint is never a rewrite
  assert.equal(readFileSync(join(dir, '.claude', 'skills', 'omelette-test', 'SKILL.md'), 'utf8'), MARKED_SKILL('0.0.1'));
  assert.equal(readFileSync(join(dir, '.claude', 'hooks', 'omelette-guard.mjs'), 'utf8'), MARKED_HOOK('0.0.1'));
});

// ─── the coder guard's actual security promise vs the given regex ──────────
//
// The rule text (§4, and the guard's own header comment) is unconditional:
// "omelette-coder never commits, merges, rebases, pushes, stashes, tags,
// branches or opens worktrees … whatever it was asked to do". The task-4
// brief then FIXES the exact regex: `\bgit\s+(commit|push|stash|checkout\s+-b|switch\s+-c|worktree)\b`.
// Real git accepts branch names attached to `-b`/`-c` with no space, and a
// global flag (`-C <dir>`) ahead of the subcommand — both create a branch and
// both are real, everyday git syntax. Verified against the real git binary
// below before being asserted against the guard, so a failure here is not a
// typo in the test.

function guard(version = '1.2.3') {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-kt-'));
  const path = join(dir, 'omelette-guard.mjs');
  const template = readFileSync(GUARD, 'utf8');
  writeFileSync(path, template.replace('{{marker}}', HOOK_MARKER(version)));
  return path;
}

function fire(path, input) {
  const r = spawnSync(process.execPath, [path], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 20000,
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const preToolUse = (command) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: 'omelette-coder',
  tool_input: { command },
});

test('git itself: -b/-c accept an attached branch name with no space, and a branch is created', { skip: !gitAvailable && 'git is not installed' }, () => {
  const repo = mkdtempSync(join(tmpdir(), 'omelette-git-real-'));
  const runGit = (args) => spawnSync('git', args, {
    cwd: repo, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: repo, GIT_CONFIG_GLOBAL: join(repo, 'no-gitconfig'), GIT_CONFIG_SYSTEM: join(repo, 'no-gitconfig'), GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' },
  });
  assert.equal(runGit(['init', '-q', '-b', 'main']).status, 0);
  assert.equal(runGit(['commit', '--allow-empty', '-q', '-m', 'init']).status, 0);
  assert.equal(runGit(['checkout', '-bfeature-attached']).status, 0, 'real git accepts -bNAME with no space');
  assert.equal(runGit(['checkout', 'main']).status, 0);
  assert.equal(runGit(['switch', '-cfeature-attached-2']).status, 0, 'real git accepts -cNAME with no space');
  assert.equal(runGit(['checkout', 'main']).status, 0);
  assert.equal(runGit(['-C', repo, 'checkout', '-b', 'feature-globalflag']).status, 0, 'a global -C flag ahead of the subcommand is ordinary git syntax');
  const branches = runGit(['branch']).stdout;
  for (const b of ['feature-attached', 'feature-attached-2', 'feature-globalflag']) {
    assert.match(branches, new RegExp(b), `git branch should list ${b}:\n${branches}`);
  }
});

test('the coder guard: attached-flag branch creation (checkout -bNAME, switch -cNAME) — the rule text promises the coder never branches "whatever it was asked to do"', () => {
  const g = guard();
  for (const command of ['git checkout -bfeature-x', 'git switch -cfeature-y']) {
    const r = fire(g, preToolUse(command));
    assert.equal(r.code, 2, `"${command}" creates a branch in real git and should be blocked like "checkout -b x": got exit ${r.code}, stdout=${r.out}, stderr=${r.err}`);
  }
});

test('the coder guard: a global -C flag ahead of the subcommand (git -C <dir> checkout -b x) still creates a branch', () => {
  const g = guard();
  const r = fire(g, preToolUse('git -C /tmp/some-repo checkout -b feature-z'));
  assert.equal(r.code, 2, `git -C <dir> checkout -b <name> creates a branch and should be blocked: got exit ${r.code}, stdout=${r.out}, stderr=${r.err}`);
});
