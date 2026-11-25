// 1.13.0 T4 (plan docs/superpowers/plans/2026-11-24-1.13.0-neon-tester.md, section T4):
// the generic clone, diff, removal and neutraliser helpers live in core/clone.mjs and take the
// parameters a second unit passes. test/mistral-repro*.test.mjs pin Mistral's behaviour through
// units/mistral/repro.mjs; these rows pin what only a second caller of the core module sees.
// Git only: nothing here needs sandbox-exec, so every row runs on every platform.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appendDiff, assertRun, cloneDiff, demoteHeadings, neutraliseModelText, oneLine, prepareClone, removeRun, runsRootAt,
} from '../core/clone.mjs';
import { prepareClone as mistralPrepareClone } from '../units/mistral/repro.mjs';

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-neon-t4-')));
const NAME = `omelette-neon-t4-runs-${process.pid}`;
after(() => { rmSync(BASE, { recursive: true, force: true }); rmSync(join(tmpdir(), NAME), { recursive: true, force: true }); });

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const GENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...ID };
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe', env: GENV, timeout: 20_000 }).toString();
let n = 0;
/** A committed repository: README.md, a `.vibe/` and a `.keep/` directory. */
function repo(files = {}) {
  const dir = join(BASE, `repo-${n++}`);
  mkdirSync(dir);
  git(dir, 'init', '-q');
  const all = { 'README.md': 'one\n', '.vibe/c.toml': 'x = 1\n', '.keep/k': 'k\n', ...files };
  for (const [p, c] of Object.entries(all)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'one');
  return dir;
}
const MSG = 'gemini: a run directory was replaced — withheld';
const open = (cwd, extra = {}) => prepareClone({ cwd, unit: 'gemini', root: runsRootAt(NAME, 'gemini'), ...extra });
const runsIn = () => readdirSync(join(tmpdir(), NAME));

test('prepareClone: the run lands under the root it is given, a non-repository is refused with the unit\'s own prefix and leaves no run', () => {
  const root = runsRootAt(NAME, 'gemini');
  const before = readdirSync(root);
  const plain = join(BASE, 'plain');
  mkdirSync(plain);
  assert.throws(() => prepareClone({ cwd: plain, unit: 'gemini', root }), (e) => /^gemini: .* is not a git work tree/.test(e.message) && !/^mistral/.test(e.message));
  assert.deepEqual(readdirSync(root), before, 'a refused cwd made no run dir');
  const run = open(repo());
  assert.equal(dirname(run.runDir), realpathSync(root));
  assert.match(run.runDir, /\/run-[^/]+$/);
});

test('runsRootAt: the refusals open with the unit passed, a drifted mode is put back, an absent root is made 0700', () => {
  const name = `${NAME}-b`;
  const p = join(tmpdir(), name);
  after(() => rmSync(p, { recursive: true, force: true }));
  assert.equal(runsRootAt(name, 'gemini'), p);
  assert.equal(lstatSync(p).mode & 0o777, 0o700);
  chmodSync(p, 0o755);
  runsRootAt(name, 'gemini');
  assert.equal(lstatSync(p).mode & 0o777, 0o700, 'the drift is undone');
  rmSync(p, { recursive: true });
  writeFileSync(p, 'a file');
  assert.throws(() => runsRootAt(name, 'gemini'), (e) => e.message === `gemini: ${p} is not a directory — remove it`);
  rmSync(p);
  mkdirSync(join(BASE, 'target'), { recursive: true });
  symlinkSync(join(BASE, 'target'), p);
  assert.throws(() => runsRootAt(name, 'codex'), (e) => e.message === `codex: ${p} is not a directory — remove it`);
});

test('prepareClone: setup runs after the drop and before the .git copy — what it commits is in the copy the diff is taken against', () => {
  const src = repo();
  const seen = {};
  const run = open(src, {
    drop: ['.vibe'],
    setup: ({ clone, env }) => {
      seen.keys = Object.keys(env).includes('GIT_LFS_SKIP_SMUDGE') && env.GIT_CONFIG_GLOBAL === '/dev/null';
      seen.vibeOnDisk = existsSync(join(clone, '.vibe'));
      seen.vibeInIndex = git(clone, 'ls-files', '--', '.vibe').trim();
      seen.outGit = existsSync(join(dirname(clone), 'out', 'git'));
      writeFileSync(join(clone, 'setup.txt'), 'made by setup\n');
      git(clone, 'add', 'setup.txt');
      git(clone, 'commit', '-qm', 'setup');
    },
  });
  assert.deepEqual(seen, { keys: true, vibeOnDisk: false, vibeInIndex: '', outGit: false }, 'setup ran after the drop, before out/git exists, with the clone git env');
  assert.equal(cloneDiff(run.clone), '', 'the setup commit is in the pristine copy: nothing to propose');
  assert.equal(git(run.clone, 'rev-parse', 'HEAD'), execFileSync('git', ['--git-dir', join(run.runDir, 'out', 'git'), 'rev-parse', 'HEAD'], { env: GENV }).toString());
  writeFileSync(join(run.clone, 'later.txt'), 'x\n');
  const d = cloneDiff(run.clone);
  assert.match(d, /^\+\+\+ b\/later\.txt$/m);
  assert.doesNotMatch(d, /setup\.txt/);
});

test('prepareClone: a setup that throws propagates and the run dir is removed', () => {
  const src = repo();
  const before = runsIn();
  assert.throws(() => open(src, { setup: () => { throw new Error('boom from setup'); } }), /boom from setup/);
  assert.deepEqual(runsIn(), before);
});

test('prepareClone: an empty drop keeps every committed path; several drops leave the clone, its index and the diff without them', () => {
  const src = repo();
  const none = open(src, { drop: [] });
  assert.ok(existsSync(join(none.clone, '.vibe', 'c.toml')) && existsSync(join(none.clone, '.keep', 'k')));
  assert.match(git(none.clone, 'ls-files'), /\.vibe\/c\.toml/);
  const dflt = open(src);
  assert.ok(existsSync(join(dflt.clone, '.vibe', 'c.toml')), 'no drop given: nothing dropped (the Mistral wrapper passes .vibe itself)');
  const two = open(src, { drop: ['.vibe', '.keep'] });
  assert.equal(existsSync(join(two.clone, '.vibe')), false);
  assert.equal(existsSync(join(two.clone, '.keep')), false);
  assert.equal(git(two.clone, 'ls-files').trim(), 'README.md');
  assert.equal(cloneDiff(two.clone), '', 'a drop is not a change the model made');
});

test('prepareClone: extra dirs are made 0700, keyed on the result, in ids but for out; assertRun names every one with the message it is given', () => {
  const src = repo();
  const run = open(src, { dirs: ['tmp', 'out', 'scratch'] });
  for (const d of ['tmp', 'out', 'scratch']) {
    assert.equal(run[d], join(run.runDir, d));
    assert.equal(lstatSync(run[d]).mode & 0o777, 0o700, d);
  }
  assert.deepEqual(Object.keys(run.ids).sort(), ['clone', 'scratch', 'tmp']);
  for (const k of ['clone', 'scratch', 'tmp']) assert.deepEqual(Object.keys(run.ids[k]).sort(), ['dev', 'ino']);
  assert.ok(existsSync(join(run.out, 'git', 'HEAD')), 'the pristine .git copy is in out');
  assertRun(run, MSG);
  // every key of ids is checked: a replaced scratch dir, a link standing for it, a missing one
  rmSync(run.scratch, { recursive: true });
  assert.throws(() => assertRun(run, MSG), (e) => e.message === MSG, 'removed');
  mkdirSync(run.scratch);
  assert.throws(() => assertRun(run, MSG), (e) => e.message === MSG, 'recreated: another inode');
  rmSync(run.scratch, { recursive: true });
  mkdirSync(join(BASE, 'elsewhere'), { recursive: true });
  symlinkSync(join(BASE, 'elsewhere'), run.scratch);
  assert.throws(() => assertRun(run, MSG), (e) => e.message === MSG, 'a link');
  rmSync(run.scratch);
  // the same for the first of dirs, and the clone
  const run2 = open(src, { dirs: ['tmp', 'out', 'scratch'] });
  rmSync(run2.tmp, { recursive: true });
  mkdirSync(run2.tmp);
  assert.throws(() => assertRun(run2, MSG), (e) => e.message === MSG);
  const run3 = open(src, { dirs: ['tmp', 'out', 'scratch'] });
  rmSync(run3.clone, { recursive: true, force: true });
  mkdirSync(run3.clone);
  assert.throws(() => assertRun(run3, MSG), (e) => e.message === MSG);
});

test('prepareClone: dirs is the whole set — one without tmp makes no tmp, and ids holds the clone and the others only', () => {
  const run = open(repo(), { dirs: ['out', 'work'] });
  assert.equal(run.tmp, undefined);
  assert.equal(existsSync(join(run.runDir, 'tmp')), false);
  assert.deepEqual(Object.keys(run.ids).sort(), ['clone', 'work']);
  assertRun(run, MSG);
});

function bigClone(extra) {
  const run = open(repo(), extra);
  writeFileSync(join(run.clone, 'big.txt'), `${'x'.repeat(100)}\n`.repeat(12_000));
  return run;
}

test('cloneDiff: the truncation line names keepKey — the one given, and Mistral\'s key when none is', () => {
  const run = bigClone();
  const dflt = cloneDiff(run.clone);
  assert.ok(dflt.endsWith('\n… diff truncated at 1 MB — set mistral.reproKeep=true to inspect the clone\n'), dflt.slice(-200));
  const own = cloneDiff(run.clone, join(run.runDir, 'out', 'git'), { keepKey: 'gemini.testKeep' });
  assert.ok(own.endsWith('\n… diff truncated at 1 MB — set gemini.testKeep=true to inspect the clone\n'), own.slice(-200));
  assert.doesNotMatch(own, /mistral/);
  const short = cloneDiff(run.clone, undefined, { keepKey: 'gemini.testKeep' });
  assert.ok(short.endsWith('set gemini.testKeep=true to inspect the clone\n'), 'the gitDir default stands when only the options are given');
});

test('cloneDiff: indexFile carries every git call of the diff — the copy\'s own index is not touched, two diffs agree, and it is the file that holds the intent-to-add', () => {
  const run = open(repo());
  const gitDir = join(run.runDir, 'out', 'git');
  const own = join(gitDir, 'index');
  const mine = join(BASE, `index-${n++}`);
  copyFileSync(own, mine);
  const pristine = readFileSync(own);
  writeFileSync(join(run.clone, 'README.md'), 'two\n');
  writeFileSync(join(run.clone, 'fresh.txt'), 'new\n');
  const first = cloneDiff(run.clone, gitDir, { indexFile: mine });
  const second = cloneDiff(run.clone, gitDir, { indexFile: mine });
  assert.match(first, /^\+two$/m);
  assert.match(first, /^\+\+\+ b\/fresh\.txt$/m, 'the untracked file is in the diff');
  assert.equal(second, first, 'the second diff over the same index file is the same');
  assert.deepEqual(readFileSync(own), pristine, 'the copy\'s own index is byte for byte what prepareClone left');
  assert.ok(execFileSync('git', ['--git-dir', gitDir, 'ls-files'], { env: { ...GENV, GIT_INDEX_FILE: mine } }).toString().includes('fresh.txt'), 'the intent-to-add went to indexFile');
  // without indexFile the diff writes the copy's own index (that is why a caller passes one)
  const plain = cloneDiff(run.clone, gitDir);
  assert.equal(plain, first);
  assert.notDeepEqual(readFileSync(own), pristine);
});

test('removeRun: dirs names the directories taken once emptied — an extra one goes with the run, and one not named keeps the run dir', () => {
  const src = repo();
  const empty = (run) => () => { for (const d of ['clone', 'tmp', 'scratch']) if (existsSync(run[d])) for (const e of readdirSync(run[d])) rmSync(join(run[d], e), { recursive: true, force: true }); };
  const a = open(src, { dirs: ['tmp', 'out', 'scratch'] });
  writeFileSync(join(a.scratch, 'f'), 'x');
  assert.equal(removeRun(a.runDir, { clear: empty(a), dirs: ['clone', 'tmp', 'scratch'] }), true);
  assert.equal(existsSync(a.runDir), false, 'the run dir and its extra dir are gone');
  const b = open(src, { dirs: ['tmp', 'out', 'scratch'] });
  const logs = [];
  assert.equal(removeRun(b.runDir, { clear: empty(b), log: (l) => logs.push(l) }), false, 'default dirs: scratch is not taken, so the run dir is not empty');
  assert.ok(existsSync(b.runDir) && existsSync(b.scratch));
  assert.equal(existsSync(b.out), false, 'out goes recursively whatever dirs says');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^repro run dir not removed: /);
  // without clear the run dir goes in one pass, extra dirs and all
  const c = open(src, { dirs: ['tmp', 'out', 'scratch'] });
  assert.equal(removeRun(c.runDir), true);
  assert.equal(existsSync(c.runDir), false);
});

const OTHER_NAME = String.raw`proposed[ \t]+test[ \t]+patch`;
const OTHER_LINES = String.raw`^[ \t]*(_\((tester note:)|\[gemini: )`;
const MARK = '> (model-written, not the adapter\'s) ';

test('neutraliseModelText and demoteHeadings: another unit\'s heading and adapter lines are marked, Mistral\'s are not', () => {
  const text = [
    '## Proposed Test Patch', '<h3> proposed test patch', 'Proposed test patch', '=====',
    '[gemini: partial]', '_(tester note: x)_', '## proposed patch (not applied)', '[mistral: partial]', '_(clone unchanged)_',
  ].join('\n');
  const out = neutraliseModelText(text, { headingName: OTHER_NAME, adapterLines: OTHER_LINES }).split('\n');
  assert.equal(out[0], `${MARK}## Proposed Test Patch`);
  assert.equal(out[1], `${MARK}<h3> proposed test patch`);
  assert.equal(out[2], `${MARK}Proposed test patch`, 'setext');
  assert.equal(out[4], `${MARK}[gemini: partial]`);
  assert.equal(out[5], `${MARK}_(tester note: x)_`);
  assert.equal(out[6], '## proposed patch (not applied)', 'Mistral\'s heading is plain text to this unit');
  assert.equal(out[7], '[mistral: partial]');
  assert.equal(out[8], '_(clone unchanged)_');
  assert.equal(demoteHeadings('## proposed test patch', OTHER_NAME), `${MARK}## proposed test patch`);
  assert.equal(demoteHeadings('## proposed patch (not applied)', OTHER_NAME), '## proposed patch (not applied)');
  // the fence the answer left open is closed, one longer than its longest run
  assert.equal(neutraliseModelText('a\r\n````js\ncode', { headingName: OTHER_NAME, adapterLines: OTHER_LINES }), 'a\n````js\ncode\n`````');
});

test('appendDiff: the heading and the unchanged line are the ones given, the model\'s heading of the unit\'s name is demoted, the fence outgrows the diff', () => {
  const opts = { heading: '## proposed test patch', headingName: OTHER_NAME, unchanged: '_(tester note: nothing changed)_' };
  const diff = 'diff --git a/x b/x\n+```` four\n';
  const out = appendDiff('answer\n## proposed test patch\nmore', diff, opts);
  assert.equal(out.match(/^## proposed test patch$/gm).length, 1, 'the model\'s own is demoted, the unit\'s is the one left');
  assert.ok(out.includes(`${MARK}## proposed test patch\nmore`));
  assert.match(out, /\n\n## proposed test patch\n\n`````diff\n/);
  assert.ok(out.endsWith('\n+```` four\n`````'));
  assert.doesNotMatch(out, /proposed patch \(not applied\)/);
  assert.equal(appendDiff('answer', '', opts), 'answer\n\n_(tester note: nothing changed)_');
  assert.equal(appendDiff('answer', '', { ...opts, unchanged: '_(clone unchanged)_' }), 'answer\n\n_(clone unchanged)_');
});

// Second pass: behaviour the old module's comments state and no row of the Mistral files pins.
test('removeRun: a dir already gone (a clear that took it too) is gone, not a failure', () => {
  const run = open(repo(), { dirs: ['tmp', 'out', 'scratch'] });
  const logs = [];
  assert.equal(removeRun(run.runDir, {
    dirs: ['clone', 'tmp', 'scratch'],
    log: (l) => logs.push(l),
    clear: () => { for (const d of ['clone', 'tmp', 'scratch']) rmSync(run[d], { recursive: true, force: true }); },
  }), true);
  assert.equal(existsSync(run.runDir), false);
  assert.deepEqual(logs, []);
});

test('cloneDiff: no system or global git config applies — a clean filter the operator\'s config names does not run on the clone\'s files', () => {
  const run = open(repo());
  const marker = join(BASE, `filter-ran-${n++}`);
  const gconf = join(BASE, `gitconfig-${n++}`);
  writeFileSync(gconf, `[filter "x"]\n\tclean = touch ${marker}; cat\n`);
  writeFileSync(join(run.clone, '.gitattributes'), '* filter=x\n');
  writeFileSync(join(run.clone, 'README.md'), 'two\n');
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gconf;
  try {
    const d = cloneDiff(run.clone);
    assert.match(d, /^\+two$/m, 'the diff is still taken');
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved;
  }
  assert.equal(existsSync(marker), false, 'the operator\'s global filter ran during the diff');
});

test('cloneDiff: core.fsmonitor named in the git dir it is given does not run', () => {
  const run = open(repo());
  const marker = join(BASE, `fsmonitor-ran-${n++}`);
  const hook = join(BASE, `fsm-${n++}.sh`);
  writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\nprintf '\\0'\n`);
  chmodSync(hook, 0o755);
  const gitDir = join(run.runDir, 'out', 'git');
  execFileSync('git', ['--git-dir', gitDir, 'config', 'core.fsmonitor', hook], { env: GENV });
  writeFileSync(join(run.clone, 'README.md'), 'two\n');
  writeFileSync(join(run.clone, 'u.txt'), 'u\n');
  const d = cloneDiff(run.clone, gitDir);
  assert.match(d, /^\+two$/m);
  assert.equal(existsSync(marker), false, 'the fsmonitor hook ran during the diff');
});

test('prepareClone: config the environment hands git (GIT_CONFIG_COUNT) cannot switch the LFS filter on for the clone\'s checkout', () => {
  const src = repo({ '.gitattributes': 'big.bin filter=lfs\n', 'big.bin': 'pointer\n' });
  // Each of the three keys is tried alone: a long-running process filter would otherwise shadow the smudge one.
  for (const [key, value] of [['filter.lfs.smudge', 'touch MARK; cat'], ['filter.lfs.process', 'touch MARK; cat'], ['filter.lfs.required', 'true']]) {
    const mark = join(BASE, `lfs-${n++}`);
    const saved = { ...process.env };
    const pairs = [[key, value.replace('MARK', mark)]];
    if (key === 'filter.lfs.required') pairs.push(['filter.lfs.smudge', `touch ${mark}; false`]);
    process.env.GIT_CONFIG_COUNT = String(pairs.length);
    pairs.forEach(([k, v], i) => { process.env[`GIT_CONFIG_KEY_${i}`] = k; process.env[`GIT_CONFIG_VALUE_${i}`] = v; });
    try {
      open(src);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    assert.equal(existsSync(mark), false, `${key} from the environment took effect on the checkout`);
  }
});

test('oneLine: a path with a control character, DEL included, is JSON-quoted; a plain one is untouched', () => {
  assert.equal(oneLine('a/b c.txt'), 'a/b c.txt');
  assert.equal(oneLine('a\nb'), '"a\\nb"');
  assert.equal(oneLine('a\u007fb'), JSON.stringify('a\u007fb'));
  assert.equal(oneLine('a\u0000b'), JSON.stringify('a\u0000b'));
});

test('neutraliseModelText: a tilde fence whose info string holds a backtick is still open; a shorter closer does not close a longer fence', () => {
  const o = { headingName: OTHER_NAME, adapterLines: OTHER_LINES };
  assert.equal(neutraliseModelText('~~~ js `x`\ncode', o), '~~~ js `x`\ncode\n~~~~');
  assert.equal(neutraliseModelText('````\ncode\n```\nmore', o), '````\ncode\n```\nmore\n`````');
  assert.equal(neutraliseModelText('````\ncode\n````\nmore', o), '````\ncode\n````\nmore', 'an equal closer does close it');
});

test('the Mistral wrapper keeps Mistral\'s own prefix on the non-repository refusal', () => {
  const plain = join(BASE, `plain-${n++}`);
  mkdirSync(plain);
  assert.throws(() => mistralPrepareClone({ cwd: plain }), (e) => e.message.startsWith(`mistral: ${plain} is not a git work tree (git rev-parse --is-inside-work-tree: `) && e.message.endsWith(' — repro clones its HEAD, so it needs one'));
});

test('cloneDiff: an untracked file named like a glob or a pathspec magic is in the diff as itself', () => {
  const run = open(repo());
  for (const f of ['a[1].txt', ':(top)q', '*']) writeFileSync(join(run.clone, f), 'x\n');
  const d = cloneDiff(run.clone);
  for (const f of ['a[1].txt', ':(top)q', '*']) assert.ok(d.includes(`+++ b/${f}\n`), `${f} is not in the diff`);
});

// Third pass: the fix round's edges that test/clone.test.mjs leaves open.
test('prepareClone: every reserved dirs name is refused, a hyphenated or numbered name is a plain one and a leading digit is not', () => {
  const src = repo();
  const before = runsIn();
  for (const d of ['clone', 'head', 'dirty', 'ids', 'top', '1x', '-x', 'a_b', 'a.b', '']) {
    assert.throws(() => open(src, { dirs: ['tmp', d] }), (e) => /^prepareClone: dirs entry .* is not a plain directory name, or collides with a key of the result$/.test(e.message), JSON.stringify(d));
  }
  assert.deepEqual(runsIn(), before, 'a refusal makes no run');
  const run = open(src, { dirs: ['tmp', 'out', 'work-dir2'] });
  assert.equal(run['work-dir2'], join(run.runDir, 'work-dir2'));
  assert.deepEqual(Object.keys(run.ids), ['clone', 'tmp', 'work-dir2']);
});

test('prepareClone: root as a function is called once, after the work-tree check, and its path holds the run', () => {
  const root = runsRootAt(NAME, 'gemini');
  const calls = [];
  const plain = join(BASE, `plain-${n++}`);
  mkdirSync(plain);
  assert.throws(() => prepareClone({ cwd: plain, unit: 'gemini', root: () => { calls.push('x'); return root; } }), /is not a git work tree/);
  assert.equal(calls.length, 0, 'a refused cwd never asks for the root');
  const run = prepareClone({ cwd: repo(), unit: 'gemini', root: () => { calls.push('y'); return root; } });
  assert.equal(calls.length, 1);
  assert.equal(dirname(run.runDir), realpathSync(root));
});

test('cloneDiff: an indexFile beside the clone that only starts with its name is allowed; one that reaches into the clone by a .. segment is refused', () => {
  const run = open(repo());
  const gitDir = join(run.runDir, 'out', 'git');
  writeFileSync(join(run.clone, 'u.txt'), 'u\n');
  assert.match(cloneDiff(run.clone, gitDir, { indexFile: `${run.clone}.index` }), /^\+\+\+ b\/u\.txt$/m, 'a sibling named like the clone plus a suffix');
  const weird = `${run.runDir}/tmp/../clone`;
  assert.throws(() => cloneDiff(weird, gitDir, { indexFile: join(run.clone, 'idx') }), /indexFile must lie outside the clone/);
  assert.equal(existsSync(join(run.clone, 'idx')), false, 'nothing was written into the clone');
});
