// core/clone.mjs through its first caller, units/mistral/repro.mjs: what the lift into core (1.13.0)
// must keep of the order Mistral's prepareClone always had.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareClone } from '../units/mistral/repro.mjs';
import * as core from '../core/clone.mjs';

test('a cwd that is no git work tree is refused before the runs root is made, and that refusal wins over a broken runs root', () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'clone-order-')));
  const saved = process.env.TMPDIR;
  try {
    process.env.TMPDIR = real;
    const plain = join(real, 'plain');
    mkdirSync(plain);
    const refused = (e) => /^mistral: .*plain is not a git work tree/.test(e.message);
    assert.throws(() => prepareClone({ cwd: plain }), refused);
    assert.deepEqual(readdirSync(real), ['plain'], 'the refusal made nothing under the temp root');
    symlinkSync(plain, join(real, 'omelette-mistral-repro'));
    assert.throws(() => prepareClone({ cwd: plain }), refused);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    rmSync(real, { recursive: true, force: true });
  }
});

// The fix round of T4: four calls a second caller of core/clone.mjs makes naturally, each once silently wrong.
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const GENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...ID };
const gitIn = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe', env: GENV, timeout: 20_000 }).toString();
const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'clone-fix-')));
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'clone-runs-')));
after(() => { rmSync(BASE, { recursive: true, force: true }); rmSync(ROOT, { recursive: true, force: true }); });
let n = 0;
/** A committed repository holding README.md and b.txt. */
function committed() {
  const dir = join(BASE, `repo-${n++}`);
  mkdirSync(dir);
  gitIn(dir, 'init', '-q');
  writeFileSync(join(dir, 'README.md'), 'one\n');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-qm', 'one');
  return dir;
}
const open = (cwd, extra = {}) => core.prepareClone({ cwd, unit: 'gemini', root: ROOT, ...extra });
const runs = () => readdirSync(ROOT).filter((e) => e.startsWith('run-'));
const gitDirOf = (run) => join(run.runDir, 'out', 'git');

test('cloneDiff with indexFile: a path that does not exist yet names only what changed', () => {
  const run = open(committed());
  writeFileSync(join(run.clone, 'new.txt'), 'new\n');
  const d = core.cloneDiff(run.clone, gitDirOf(run), { indexFile: join(BASE, `index-${n++}`) });
  assert.match(d, /^\+\+\+ b\/new\.txt$/m);
  assert.doesNotMatch(d, /b\/README\.md\nnew file/);
  assert.doesNotMatch(d, /b\/b\.txt\nnew file/);
});

test('cloneDiff with indexFile: reused after an untracked file is deleted, the next diff has no phantom deletion', () => {
  const run = open(committed());
  const indexFile = join(BASE, `index-${n++}`);
  writeFileSync(join(run.clone, 'new.txt'), 'new\n');
  assert.match(core.cloneDiff(run.clone, gitDirOf(run), { indexFile }), /^\+\+\+ b\/new\.txt$/m);
  rmSync(join(run.clone, 'new.txt'));
  const again = core.cloneDiff(run.clone, gitDirOf(run), { indexFile });
  assert.doesNotMatch(again, /deleted file/);
  assert.equal(again, '');
});

test('cloneDiff refuses a relative indexFile and one inside the clone', () => {
  const run = open(committed());
  assert.throws(() => core.cloneDiff(run.clone, gitDirOf(run), { indexFile: 'idx' }), (e) => e.message === 'cloneDiff: indexFile must be an absolute path (got "idx")');
  const inside = 'cloneDiff: indexFile must lie outside the clone — the clone is the model\'s to write';
  assert.throws(() => core.cloneDiff(run.clone, gitDirOf(run), { indexFile: join(run.clone, 'idx') }), (e) => e.message === inside);
  assert.throws(() => core.cloneDiff(run.clone, gitDirOf(run), { indexFile: run.clone }), (e) => e.message === inside);
});

test('prepareClone makes out 0700 whether or not dirs names it', () => {
  const run = open(committed(), { dirs: ['tmp', 'home'] });
  for (const d of ['out', 'home']) {
    assert.equal(run[d], join(run.runDir, d));
    assert.equal(lstatSync(run[d]).mode & 0o777, 0o700, d);
  }
  assert.deepEqual(Object.keys(run.ids), ['clone', 'tmp', 'home']);
});

test('prepareClone refuses a dirs entry that is no plain name or is a key of the result', () => {
  const src = committed();
  const before = runs();
  for (const d of ['head', 'a/b', '..', 'Tmp']) {
    const message = `prepareClone: dirs entry ${JSON.stringify(d)} is not a plain directory name, or collides with a key of the result`;
    assert.throws(() => open(src, { dirs: ['tmp', d] }), (e) => e.message === message, d);
  }
  assert.deepEqual(runs(), before, 'no run is left under the root');
});

test('setup is handed the clone, the env, CLONE_CONFIG and the work tree\'s head; the result\'s head names what it committed', () => {
  const src = committed();
  const seen = {};
  const run = open(src, {
    setup: ({ clone, env, config, head }) => {
      Object.assign(seen, { config, head });
      writeFileSync(join(clone, 'setup.txt'), 'made by setup\n');
      const g = (...a) => execFileSync('git', [...config, '-c', 'user.name=t', '-c', 'user.email=t@t', '-C', clone, ...a], { stdio: 'pipe', env, timeout: 20_000 });
      g('add', 'setup.txt');
      g('commit', '-qm', 'setup');
    },
  });
  assert.equal(seen.head, gitIn(src, 'rev-parse', '--short', 'HEAD').trim());
  assert.deepEqual(seen.config, core.CLONE_CONFIG);
  assert.notEqual(run.head, seen.head);
  assert.equal(run.head, gitIn(run.clone, 'rev-parse', '--short', 'HEAD').trim());
});

test('an async setup is refused and leaves no run', () => {
  const src = committed();
  const before = runs();
  assert.throws(() => open(src, { setup: async () => { throw new Error('late'); } }), /setup must be synchronous/);
  assert.deepEqual(runs(), before);
});

test('cloneDiff with indexFile: a lock or a link left at the scratch path neither stops nor redirects the next diff', () => {
  const run = open(committed());
  const indexFile = join(BASE, `index-${n++}`);
  writeFileSync(join(run.clone, 'new.txt'), 'new\n');
  writeFileSync(`${indexFile}.lock`, '');
  assert.match(core.cloneDiff(run.clone, gitDirOf(run), { indexFile }), /^\+\+\+ b\/new\.txt$/m);
  rmSync(indexFile);
  symlinkSync(join(run.clone, 'planted'), indexFile);
  assert.match(core.cloneDiff(run.clone, gitDirOf(run), { indexFile }), /^\+\+\+ b\/new\.txt$/m);
  assert.equal(existsSync(join(run.clone, 'planted')), false, 'nothing was written through the link');
  assert.equal(lstatSync(indexFile).isSymbolicLink(), false);
});

test('cloneDiff refuses the git dir\'s own index and an empty indexFile', () => {
  const run = open(committed());
  const own = 'cloneDiff: indexFile must not be the git dir\'s own index';
  assert.throws(() => core.cloneDiff(run.clone, gitDirOf(run), { indexFile: join(gitDirOf(run), 'index') }), (e) => e.message === own);
  assert.throws(() => core.cloneDiff(run.clone, gitDirOf(run), { indexFile: '' }), (e) => e.message === 'cloneDiff: indexFile must be an absolute path (got "")');
});

test('cloneDiff\'s exclude drops untracked files under the named directories only', () => {
  const run = open(committed());
  for (const d of ['a', 'ab', 'b/a']) {
    mkdirSync(join(run.clone, d), { recursive: true });
    writeFileSync(join(run.clone, d, 'x'), 'x\n');
  }
  const d = core.cloneDiff(run.clone, gitDirOf(run), { exclude: ['a'] });
  assert.match(d, /^\+\+\+ b\/ab\/x$/m);
  assert.match(d, /^\+\+\+ b\/b\/a\/x$/m);
  assert.doesNotMatch(d, /^\+\+\+ b\/a\/x$/m);
});

test('prepareClone refuses dirs that is not an array, and a setup cannot change CLONE_CONFIG', () => {
  const src = committed();
  assert.throws(() => open(src, { dirs: 'tmp' }), (e) => e.message === 'prepareClone: dirs must be an array of directory names');
  const before = [...core.CLONE_CONFIG];
  open(src, { setup: ({ config }) => { config.push('-c', 'x.y=z'); } });
  assert.deepEqual(core.CLONE_CONFIG, before);
});

// The fix round after T9–T10's tester (2026-11-25): a line of the unit's shape behind a character a reader does not
// see, or sees as blank, is marked too; a line with no such character comes out as it always did.
test('neutraliseModelText marks a line of the unit\'s shape behind an invisible, format or odd-space character, and leaves an ordinary line as it was', () => {
  const opts = { headingName: String.raw`proposed[ \t]+patch[ \t]*\([ \t]*not[ \t]+applied[ \t]*\)`, adapterLines: String.raw`^[ \t]*(_\((clone unchanged|vibe:)|\[mistral: )` };
  const MARK = '> (model-written, not the adapter\'s) ';
  const leads = {
    'zero-width space': '\u{200b}', 'byte-order mark': '\u{feff}', 'left-to-right mark': '\u{200e}', 'right-to-left override': '\u{202e}',
    'word joiner': '\u{2060}', 'no-break space': '\u{a0}', 'ideographic space': '\u{3000}', VT: '\u000b', FF: '\u000c', NEL: '\u0085',
    'ANSI reset': '\u001b[0m', 'an OSC title': '\u001b]0;t\u0007', 'a run of them with a space and a tab': '\u{200b} \u{a0}\t\u001b[1m\u{3000}',
  };
  for (const [name, c] of Object.entries(leads)) {
    for (const line of ['_(clone unchanged)_', '_(vibe: exit 0)_', '[mistral: partial]', '## proposed patch (not applied)', '<h2>proposed patch (not applied)</h2>']) {
      assert.equal(core.neutraliseModelText(`before\n${c}${line}\nafter`, opts), `before\n${MARK}${c}${line}\nafter`, `${name}: ${line}`);
    }
    assert.equal(core.neutraliseModelText(`${c}proposed patch (not applied)\n---\nafter`, opts), `${MARK}${c}proposed patch (not applied)\n---\nafter`, `${name}: setext`);
  }
  const plain = ['before', 'see _(clone unchanged)_', '  _(clone unchanged)_', 'é [mistral: x]', 'proposed patch (not applied) here', '#proposed patches', 'x\u{200b}_(vibe: no)_', ''].join('\n');
  const marked = core.neutraliseModelText(plain, opts);
  assert.equal(marked, plain.replace('  _(clone unchanged)_', `${MARK}  _(clone unchanged)_`), 'only the indented line of the unit\'s shape is marked, the rest byte for byte');
});

// The second fix round after the T9/T10 tester (2026-11-25): a model-written ignore file can ignore itself, so the
// listing the notice reads honours no ignore rule.
test('untrackedPast lists an untracked file whatever the clone\'s ignore files say, and leaves an excluded directory out', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'neon-test-')));
  try {
    const src = join(base, 'src');
    mkdirSync(src);
    gitIn(src, 'init', '-q');
    writeFileSync(join(src, 'README.md'), 'one\n');
    gitIn(src, 'add', '-A');
    gitIn(src, 'commit', '-qm', 'one');
    const run = core.prepareClone({ cwd: src, unit: 'gemini', root: base });
    writeFileSync(join(run.clone, '.gitignore'), '*\n');
    writeFileSync(join(run.clone, 't.test.mjs'), 'ok\n');
    mkdirSync(join(run.clone, 'deps'));
    writeFileSync(join(run.clone, 'deps', 'x'), 'dep\n');
    const names = core.untrackedPast(run.clone, gitDirOf(run), { indexFile: join(run.out, 'diff.index'), exclude: ['deps'] });
    assert.deepEqual([...names].sort(), ['.gitignore', 't.test.mjs']);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// The release-review fix round (2026-11-25): the rule that decides a directory, for gemini_test's guards.
test('ignoreRules names the deciding source of an ignored directory, not one a negation re-includes, and reads a name opening with ":" as a name', () => {
  const run = open(committed());
  writeFileSync(join(run.clone, '.gitignore'), 'cache/\n:odd/\nkeep/\n!keep/\n');
  for (const d of ['cache', ':odd', 'keep', 'plain']) mkdirSync(join(run.clone, d));
  const rules = core.ignoreRules(run.clone, gitDirOf(run), { indexFile: join(BASE, `index-${n++}`), paths: ['cache', ':odd', 'keep', 'plain'] });
  assert.deepEqual([...rules.entries()], [['cache', { source: '.gitignore', pattern: 'cache/' }], [':odd', { source: '.gitignore', pattern: ':odd/' }]]);
  assert.equal(core.ignoreRules(run.clone, gitDirOf(run), { paths: [] }).size, 0, 'no path: no git call');
});

// Found on CI (2026-11-25): git 2.47+ starts a detached `git maintenance run --auto` after a commit, older gits a
// `git gc --auto`; it worked in the clone's .git while prepareClone copied it. git's own trace is the evidence.
test('a commit made with CLONE_CONFIG starts no gc and no maintenance, and one made without it starts one', () => {
  const spawned = (config) => {
    const dir = committed();
    writeFileSync(join(dir, 'more.txt'), 'more\n');
    gitIn(dir, 'add', '-A');
    const r = spawnSync('git', [...config, '-C', dir, 'commit', '-qm', 'two'], { env: { ...GENV, GIT_TRACE: '1' }, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    return (r.stderr.match(/run_command: git (gc|maintenance)\b/g) || []).length;
  };
  assert.equal(spawned(core.CLONE_CONFIG), 0);
  assert.equal(spawned([]), 1, 'the control: this git starts one without the flags');
});
