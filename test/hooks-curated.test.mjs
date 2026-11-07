/**
 * omelette-fleet :: test/hooks-curated.test.mjs
 * 1.8.0 task 3, the curated files, driven the way Claude Code drives the guard:
 * a child process, the event as JSON on stdin, the exit code and stderr read
 * back. test/hooks.test.mjs holds the spec's own rows; this file holds the
 * operators the spec names and nothing there pins (`>|` `<>` `&>`, `truncate`,
 * `cp` onto, the quoted, `./..`-folded and symlinked paths, the heredoc forms,
 * the register redirect's refusals), the Write rows of Review Focus 3 in every
 * byte-level form, and the guard's bound on a hostile word.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_FILES, renderHookFile } from '../core/rules.mjs';

// The guard line compares the installed mod with the package: the fixture installs the package's own version.
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PKG_RE = PKG_VERSION.replace(/\./g, '\\.');

const BASH_CURATED = (file) => `${file} is appended to, never rewritten; to replace it on purpose, move it first`;
const WRITE_CURATED = (file) => `${file} is appended to, never rewritten: Edit for an in-place change (the harness checks it has not moved since your read), append otherwise; to replace it on purpose, move it first`;

/** The main thread (no agent_type), a guarded role and a role nobody guards. */
const EVERY_AGENT = [undefined, 'omelette-coder', 'general-purpose'];

function guard() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-guard-'));
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3'));
  return path;
}

function fire(path, event, cwd, env) {
  const r = spawnSync(process.execPath, [path], { input: JSON.stringify(event), encoding: 'utf8', cwd, timeout: 30000, ...(env ? { env } : {}) });
  assert.equal(r.signal, null, `the guard hung: ${r.stdout}${r.stderr}`);
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const LEDGER = `# ledger x\n${'- 2026-11-03 one line of the ledger\n'.repeat(30)}`;

/** A project with every kind of curated file; the real path, so an absolute spelling compares equal. */
function project(register = 'register: docs/DECISIONS.md\n') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-curated2-')));
  mkdirSync(join(dir, '.omelette'));
  mkdirSync(join(dir, 'docs'));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, '.omelette', 'ledger-x.md'), LEDGER);
  writeFileSync(join(dir, '.omelette', 'backlog.md'), '# backlog\n');
  writeFileSync(join(dir, '.omelette', 'decisions.md'), register);
  writeFileSync(join(dir, 'docs', 'DECISIONS.md'), '# decisions\n');
  writeFileSync(join(dir, 'outside.md'), 'outside\n');
  symlinkSync(join(dir, 'outside.md'), join(dir, '.omelette', 'ledger-l.md'));
  return dir;
}

const bashEvent = (dir, command, agent) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: dir, tool_input: { command }, ...(agent ? { agent_type: agent } : {}),
});
const writeEvent = (dir, file_path, content, agent) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: dir, tool_input: { file_path, content }, ...(agent ? { agent_type: agent } : {}),
});

test('curated: the redirection operators, the word rules and the spellings of a path the spec names but hooks.test.mjs does not pin', () => {
  const g = guard();
  const dir = project();
  const B = '.omelette/backlog.md';
  const L = '.omelette/ledger-x.md';
  for (const [command, file] of [
    // Every operator that rewrites; the fd number does not hide it.
    [`cat >| ${B}`, B], [`cat <> ${B}`, B], [`echo x &> ${B}`, B], [`echo x 2> ${B}`, B], [`echo x 3> ${B}`, B],
    [`echo x >&${B}`, B], [`echo x >${B}`, B], [`> ${B}`, B], [`true && > ${B}`, B], [`cat > ${B} 2>&1`, B],
    // The path as the shell would unquote and fold it.
    [`cat > ".omelette/backlog.md"`, B], [`cat > '.omelette/ledger-x.md'`, L], [`cat > ./.omelette/../.omelette/backlog.md`, B],
    [`cat > .omelette//backlog.md`, B], [`cat > .omelette/./backlog.md`, B], [`cat > .omelette/back"log".md`, B],
    [`cat > ${join(dir, '.omelette', 'backlog.md')}`, B],
    // A symlink at a curated NAME is curated whatever it points to.
    [`cat > .omelette/ledger-l.md`, '.omelette/ledger-l.md'],
    // Heredocs: the redirection is the write, the body is text.
    [`cat > ${B} <<'EOF'\nbody\nEOF\n`, B], [`cat <<'EOF' > ${B}\nbody\nEOF\n`, B],
    // Word rules.
    ['tee .omelette/backlog.md .omelette/notes.md', B], [`echo x | tee ${B}`, B], [`truncate -s 0 ${L}`, L], [`truncate ${L} -s 0`, L],
    [`cp x ${B}`, B], ['cp x docs/DECISIONS.md', 'docs/DECISIONS.md'], [`mv -f x ${B}`, B], [`mv /tmp/backlog.md .omelette`, B], [`mv /tmp/backlog.md .omelette/`, B],
    [`cp -t .omelette x/backlog.md`, B], [`rm -f ${L}`, L], [`rm -- ${B}`, B],
    [`sed -i '' s/a/b/ ${B}`, B], [`sed -i -e s/a/b/ ${B}`, B], [`sed -ni p ${B}`, B], [`sed -E -i s/a/b/ ${B}`, B], [`sed -n -i.bak p ${B}`, B],
    [`perl -pi.bak -e s/a/b/ ${B}`, B], [`perl -pi -e s/a/b/ ${B}`, B], [`perl -i -pe 1 ${B}`, B],
    [`sort -o ${B} x`, B], [`sort --output=${B} x`, B], [`sort --output ${B} x`, B],
    // A wrapper, an assignment, a group and a pipeline before the command.
    [`env FOO=1 tee ${B}`, B], [`FOO=1 tee ${B}`, B], [`{ cat > ${B}; }`, B], [`if true; then > ${B}; fi`, B],
    [`echo x > ${L}; echo y >> ${L}`, L], [`echo y >> ${L}; echo x > ${L}`, L], [`echo x >> .omelette/notes.md; tee ${B}`, B],
    // After a `cd` the directory is unknown: the file's own name decides.
    ['cd docs && cat > DECISIONS.md', 'DECISIONS.md'], ['(cd .omelette; cat > backlog.md)', 'backlog.md'], ['cd .omelette && tee ledger-x.md', 'ledger-x.md'],
  ]) {
    for (const agent of EVERY_AGENT) {
      const r = fire(g, bashEvent(dir, command, agent), dir);
      assert.equal(r.code, 2, `${JSON.stringify(command)} (${agent || 'main thread'}) should be refused: ${r.out}${r.err}`);
      assert.equal(r.err.trim(), BASH_CURATED(file), `${JSON.stringify(command)} (${agent || 'main thread'})`);
    }
  }
});

test('curated: appends, reads, moving away, copying from, names that merely contain a curated one, and other files all pass', () => {
  const g = guard();
  const dir = project();
  const B = '.omelette/backlog.md';
  const L = '.omelette/ledger-x.md';
  for (const command of [
    // An append stays one when a rewrite of another file shares its command.
    `echo x > /tmp/zz-out; echo y >> ${L}`, `tee /tmp/zz-out >> ${B}`, `cat > notes.md && echo y >> ${B}`,
    `echo x >> ${B}`, `echo x &>> ${B}`, `echo x 2>> ${B}`, `echo x >> ${L}`, `tee --append ${B}`, `tee -a ${B} .omelette/notes.md`, `echo x | tee -a ${B}`,
    `cat ${B}`, `sed -n p ${B}`, `sed s/a/b/ ${B}`, `sed -i s/a/b/ other.md`, `perl -ne print ${B}`, `perl -e 1 ${B}`, `sort ${B} -o out`, `sort ${B}`,
    `mv ${B} /tmp/x`, `mv ${L} .omelette/archive/`, `cp ${B} ${B}.bak`, `cp ${B} /tmp/x`, `git mv ${B} y`, `git mv x ${B}`,
    `cat > ${B}.bak`, `cat > ${L}.bak`, 'cat > .omelette/notes.md', 'cat > .omelette/ledger-a/b.md', 'cat > .omelette/sub/ledger-a.md', 'cat > .omelette/archive/ledger-a.md',
    'cat > backlog.md', 'cat > sub/.omelette/backlog.md', 'cat > docs/notes.md', 'echo x 2>/dev/null', 'echo x >&2', 'echo x 2>&1',
    // An expansion the guard does not perform is not a known path.
    'cd docs && cat > ~root/DECISIONS.md', 'cd .omelette && cat > ~nobody/backlog.md',
    'cat > .omelette/ledger-$X.md', 'cd docs && cat > "$D/DECISIONS.md"', 'cat > `pwd`/.omelette/backlog.md',
    'cat > $PWD/.omelette/backlog.md', 'cat > "$PWD/.omelette/ledger-x.md"', 'cat > $(pwd)/.omelette/backlog.md',
    // A quoted body is text: `sh -c` and the like are out of its reach, said in the script.
    `grep cd file; echo y > .omelette/notes.md`,
    // The commands the spec's list leaves out.
    `cp x .omelette`, `cp -t .omelette/ x`, `mv -T x .omelette`,
  ]) {
    for (const agent of EVERY_AGENT) {
      const r = fire(g, bashEvent(dir, command, agent), dir);
      assert.equal(r.code, 0, `${JSON.stringify(command)} (${agent || 'main thread'}) should pass: ${r.out}${r.err}`);
      assert.equal(r.err, '', `${JSON.stringify(command)} (${agent || 'main thread'})`);
    }
  }
});

test('curated: the register redirect curates the file it names; one the print refuses curates nothing', () => {
  const g = guard();
  for (const [register, target, code] of [
    ['register: docs/DECISIONS.md\n', 'docs/DECISIONS.md', 2],
    ['register: docs/DECISIONS.md\r\n', 'docs/DECISIONS.md', 2], // the reader strips the CR
    ['register:   docs/DECISIONS.md  \n', 'docs/DECISIONS.md', 2],
    ['﻿register: docs/DECISIONS.md\n', 'docs/DECISIONS.md', 2], // …and a BOM
    ['register: ../outside.md\n', '../outside.md', 0], // outside the project
    ['register: .git/hooks/x\n', '.git/hooks/x', 0], // under .git
    ['register: /tmp/zz-register.md\n', '/tmp/zz-register.md', 0], // absolute
    ['register: .omelette/decisions.md\n', 'docs/DECISIONS.md', 0], // itself: nothing redirected
    ['register: missing-dir/x.md\n', 'missing-dir/x.md', 0], // its directory does not exist
    ['# a plain register\n', 'docs/DECISIONS.md', 0], // no redirect: docs/DECISIONS.md is just a file
    ['register: docs/DECISIONS.md\n', 'docs/OTHER.md', 0],
  ]) {
    const dir = project(register);
    for (const agent of EVERY_AGENT) {
      const bash = fire(g, bashEvent(dir, `cat > ${target}`, agent), dir);
      assert.equal(bash.code, code, `${JSON.stringify(register)} → cat > ${target} (${agent || 'main thread'}): ${bash.err}`);
      const write = fire(g, writeEvent(dir, join(dir, target), 'replaced\n', agent), dir);
      assert.equal(write.code, code, `${JSON.stringify(register)} → Write ${target} (${agent || 'main thread'}): ${write.err}`);
    }
  }
  // Whatever it redirects to, the register's own file stays curated.
  const dir = project('register: docs/DECISIONS.md\n');
  assert.equal(fire(g, bashEvent(dir, 'cat > .omelette/decisions.md'), dir).code, 2);
  assert.equal(fire(g, writeEvent(dir, '.omelette/decisions.md', 'register: elsewhere.md\n'), dir).code, 2, 'a Write that re-points the register is not an append');
});

test('curated: a Write is an append byte for byte — re-encodings, a BOM, an empty or shorter content refused; an exact prefix, a new file passes; the agent does not matter', () => {
  const g = guard();
  const dir = project();
  const lp = '.omelette/ledger-x.md';
  const abs = join(dir, lp);
  const rows = [
    // [file_path, content, exit]
    [lp, `${LEDGER}- appended\n`, 0], [abs, `${LEDGER}- appended\n`, 0], [`./${lp}`, `${LEDGER}x`, 0],
    [lp, LEDGER, 0], // an append of nothing: the file's own bytes
    [lp, `${LEDGER}é`, 0],
    [lp, LEDGER.slice(0, LEDGER.length / 2), 2], [lp, LEDGER.slice(0, -1), 2], [abs, '', 2],
    [lp, `${LEDGER.replace(/\n/g, '\r\n')}- x\r\n`, 2], [lp, `${LEDGER.slice(0, -1)} and more\n`, 2],
    [lp, `﻿${LEDGER}x`, 2], [lp, `x${LEDGER}`, 2], [lp, `${LEDGER.replace('# ledger x', '# ledger y')}x`, 2],
    [lp, 'a summary of the ledger\n', 2],
    [lp, undefined, 2], [lp, null, 2], [lp, 5, 2], [lp, ['a'], 2], // not a string: not an append of anything
    ['./docs/../.omelette/backlog.md', 'x', 2], ['sub/../.omelette/backlog.md', 'x', 2], ['.omelette/backlog.md', '# backlog\nmore', 0],
    ['.omelette/ledger-new.md', 'x', 0], // absent: nothing to lose
    ['.omelette/ledger-l.md', 'outside\nmore\n', 2], // a symlink at a curated name, even for an append of its target
    ['.omelette/backlog.md.bak', 'x', 0], ['.omelette/notes.md', 'x', 0], ['.omelette/ledger-a/b.md', 'x', 0], ['docs/DECISIONS.md', 'new', 2], ['docs/DECISIONS.md', '# decisions\nmore', 0],
    ['.omelette', 'x', 0], // a directory is not a curated name
  ];
  for (const [filePath, content, code] of rows) {
    for (const agent of EVERY_AGENT) {
      const r = fire(g, writeEvent(dir, filePath, content, agent), dir);
      assert.equal(r.code, code, `Write ${filePath} ${JSON.stringify(content)?.slice(0, 40)} (${agent || 'main thread'}) should exit ${code}: ${r.out}${r.err}`);
      if (code === 2) assert.match(r.err.trim(), /^[^\n]+ is appended to, never rewritten: Edit for an in-place change /);
      else assert.equal(r.err, '');
    }
  }
  // "Byte for byte": a file holding bytes that are not UTF-8 is never the prefix of a string, even of the replacement characters its bytes decode to.
  writeFileSync(join(dir, '.omelette', 'ledger-bin.md'), Buffer.from([0xff, 0x0a]));
  for (const agent of EVERY_AGENT) {
    assert.equal(fire(g, writeEvent(dir, '.omelette/ledger-bin.md', '\ufffd\nmore\n', agent), dir).code, 2, `invalid UTF-8 on disk, U+FFFD in content (${agent || 'main thread'})`);
  }
  // The refusal names the file as the project spells it, the same for a relative and an absolute path.
  assert.equal(fire(g, writeEvent(dir, abs, 'x'), dir).err.trim(), WRITE_CURATED(lp));
  assert.equal(fire(g, writeEvent(dir, lp, 'x'), dir).err.trim(), WRITE_CURATED(lp));
  assert.equal(readFileSync(abs, 'utf8'), LEDGER, 'the guard only answers; it writes nothing');
  // Edit and NotebookEdit are the harness's to check, and no rule of this task reads them.
  for (const tool_name of ['Edit', 'NotebookEdit']) {
    const r = fire(g, { hook_event_name: 'PreToolUse', tool_name, cwd: dir, tool_input: { file_path: abs, old_string: 'a', new_string: 'b' } }, dir);
    assert.equal(r.code, 0, `${tool_name}: ${r.err}`);
  }
  // A Write without a usable file_path is nobody's to refuse here.
  for (const file_path of [undefined, '', 5, null]) assert.equal(fire(g, writeEvent(dir, file_path, 'x'), dir).code, 0, JSON.stringify(file_path));
});

test('curated: a command the guard cannot make sense of never throws, never hangs and refuses nothing it should not', () => {
  const g = guard();
  const dir = project();
  const started = Date.now();
  for (const command of [
    '>', ': >', 'mv', 'cp', 'mv -t', 'mv --', 'sed -i', "sed -i ''", 'sed -e', 'sed --file', 'perl -i', 'tee', 'sort -o', 'truncate', 'rm', 'cd',
    '>'.repeat(1 << 20), '> '.repeat(300000), 'tee ' + "'a' ".repeat(100000), 'mv ' + 'a '.repeat(200000),
    '\u0000', 'cat > \u0000', 'rm .omelette/\u0000x',
  ]) {
    for (const agent of [undefined, 'omelette-coder']) {
      const r = fire(g, bashEvent(dir, command, agent), dir);
      assert.equal(r.code, 0, `${JSON.stringify(command.slice(0, 20))}…(${command.length}) (${agent || 'main thread'}): ${r.err.slice(0, 200)}`);
      assert.equal(r.err, '');
    }
  }
  assert.ok(Date.now() - started < 20000, `took ${Date.now() - started} ms`);
});

test('curated: a long word of closing parentheses costs milliseconds, as every other long word does (the guard runs before every tool call)', () => {
  const g = guard();
  const dir = project();
  for (const agent of [undefined, 'omelette-coder']) {
    const command = `echo ${')'.repeat(40000)}x`;
    const started = Date.now();
    const r = fire(g, bashEvent(dir, command, agent), dir);
    const ms = Date.now() - started;
    assert.equal(r.code, 0, r.err);
    assert.ok(ms < 1000, `a 40 KB word of ")" took ${ms} ms (${agent || 'main thread'})`);
  }
});

test('curated: the refusal is the whole of stderr, one line, with a long command behind the write', () => {
  const g = guard();
  const dir = project();
  const r = fire(g, bashEvent(dir, `cat > .omelette/backlog.md; echo ${'x'.repeat(100000)}`), dir);
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.equal(r.err, `${BASH_CURATED('.omelette/backlog.md')}\n`);
});

/**
 * `doctor`'s guard line beyond the three forms test/cli.test.mjs pins: the user
 * scope's two settings files (the local one read first, as the client reads
 * them), a CLAUDE_CONFIG_DIR, and the groups of a settings hook named one by one.
 */
test('doctor: the guard line reads settings.local.json before settings.json, honours CLAUDE_CONFIG_DIR, and names each PreToolUse group', () => {
  const BIN = join(import.meta.dirname, '..', 'bin', 'omelette-fleet.mjs');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-doctor-')));
  const proj = join(dir, 'proj');
  mkdirSync(join(proj, '.claude'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' };
  const run = (args, e = env) => spawnSync(process.execPath, [BIN, ...args], { cwd: proj, encoding: 'utf8', env: e });
  const written = run(['rules', '--hooks']);
  assert.equal(written.status, 0, written.stderr);
  const lines = written.stdout.split('\n');
  const at = lines.indexOf('{ "hooks": {');
  const snippet = JSON.parse(lines.slice(at, at + 6).join('\n'));
  const command = snippet.hooks.PreToolUse[0].hooks[0].command;
  const settings = (hooks) => writeFileSync(join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { ...snippet.hooks, ...hooks } }));
  const guardLine = (e = env) => run(['doctor'], e).stdout.split('\n').find((l) => l.startsWith('guard ')) || '';
  const plugin = (root, { enabled, version }, file = 'settings.json') => {
    mkdirSync(join(root, 'plugins'), { recursive: true });
    writeFileSync(join(root, file), JSON.stringify({ enabledPlugins: { 'omelette-fleet@omelette-fleet': enabled } }));
    writeFileSync(join(root, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'omelette-fleet@omelette-fleet': [{ scope: 'user', version }] } }));
  };
  const group = (matcher) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command }] });

  // Two PreToolUse groups, each named; a group without a matcher is `*`.
  settings({ PreToolUse: [group('Bash'), group('Write')] });
  assert.equal(guardLine(), 'guard         settings hook wired (PreToolUse Bash, PreToolUse Write, SubagentStop)');
  settings({ PreToolUse: [group()] });
  assert.equal(guardLine(), 'guard         settings hook wired (PreToolUse *, SubagentStop)');
  settings({ PreToolUse: [group('Bash|Write|Edit|NotebookEdit')], SubagentStop: [group()] });
  assert.equal(guardLine(), 'guard         settings hook wired (PreToolUse Bash|Write|Edit|NotebookEdit, SubagentStop)');

  // The local file's `false` wins over the shared file's `true`.
  const user = join(dir, '.claude');
  plugin(user, { enabled: true, version: PKG_VERSION });
  assert.match(guardLine(), new RegExp(` · mod omelette-fleet enabled, installed ${PKG_RE} — the mod answers first$`));
  writeFileSync(join(user, 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'omelette-fleet@omelette-fleet': false } }));
  assert.match(guardLine(), new RegExp(` · mod omelette-fleet installed ${PKG_RE}, not enabled — the second delivery is absent$`));
  // Enabled and installed nowhere: no mod half.
  const alt = join(dir, 'alt');
  assert.doesNotMatch(guardLine({ ...env, CLAUDE_CONFIG_DIR: alt }), /mod omelette-fleet/);
  // A CLAUDE_CONFIG_DIR replaces `<home>/.claude` for both files.
  plugin(alt, { enabled: true, version: PKG_VERSION });
  assert.match(guardLine({ ...env, CLAUDE_CONFIG_DIR: alt }), new RegExp(` · mod omelette-fleet enabled, installed ${PKG_RE} — the mod answers first$`));
});

test('curated: a ledger module that never settles, throws on import or throws in readRegisterPath costs a clock and one stderr line, never the refusal', () => {
  const dir = project();
  const real = join(import.meta.dirname, '..', 'core', 'ledger.mjs');
  for (const [label, body, ms] of [
    ['never settles', 'await new Promise(() => {});', 1500],
    ['throws on import', 'throw new Error("boom");', 0],
    ['readRegisterPath throws', `export * from ${JSON.stringify(real)};\nexport function readRegisterPath() { throw new Error("x"); }`, 0],
  ]) {
    const pkg = mkdtempSync(join(tmpdir(), 'omelette-pkg-curated-'));
    mkdirSync(join(pkg, 'core'));
    writeFileSync(join(pkg, 'core', 'ledger.mjs'), `${body}\n`);
    const gdir = mkdtempSync(join(tmpdir(), 'omelette-guard-'));
    const path = join(gdir, 'omelette-guard.mjs');
    writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3', undefined, pkg));
    for (const [event, code] of [
      [bashEvent(dir, 'rm .omelette/decisions.md'), 2],
      [bashEvent(dir, 'echo x >> .omelette/decisions.md'), 0],
      [writeEvent(dir, '.omelette/ledger-x.md', 'short'), 2],
      [bashEvent(dir, 'cat > .omelette/backlog.md', 'omelette-coder'), 2],
    ]) {
      const started = Date.now();
      const r = fire(path, event, dir);
      assert.equal(r.code, code, `${label}: ${JSON.stringify(event.tool_input)} → ${r.err}`);
      assert.ok(Date.now() - started >= ms || code === 0, `${label}: the clock`);
      assert.ok(r.err.trim().split('\n').length <= 2, `${label}: at most the module's line and the refusal: ${r.err}`);
      if (code === 2) assert.ok(r.err.trimEnd().split('\n').pop().includes('is appended to, never rewritten'), `${label}: the refusal is there: ${r.err}`);
    }
  }
});

test('curated: a guard whose package has moved says nothing about it on a call that rewrites nothing', () => {
  const gdir = mkdtempSync(join(tmpdir(), 'omelette-guard-'));
  const path = join(gdir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.2.3', undefined, join(gdir, 'no-package-here')));
  const dir = project();
  for (const command of ['echo x >> .omelette/ledger-x.md', 'cat .omelette/backlog.md', 'ls', 'git status']) {
    for (const agent of [undefined, 'omelette-coder']) {
      const r = fire(path, bashEvent(dir, command, agent), dir);
      assert.equal(r.code, 0, command);
      assert.equal(r.err, '', `${command}: no "cannot load" line for a call that never needed the register`);
    }
  }
  for (const tool_name of ['Edit', 'NotebookEdit']) assert.equal(fire(path, { hook_event_name: 'PreToolUse', tool_name, cwd: dir, tool_input: { file_path: join(dir, '.omelette', 'backlog.md') } }, dir).err, '');
});

test('curated: a project under the fleet home is not rooted at it — $OMELETTE_HOME is passed over as ~/.omelette is', () => {
  const g = guard();
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-fleethome-')));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'omelette-home-')));
  mkdirSync(join(base, '.omelette'));
  writeFileSync(join(base, '.omelette', 'backlog.md'), '# the fleet home holds state, not a backlog\n');
  const proj = join(base, 'work', 'proj');
  mkdirSync(proj, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: join(base, '.omelette') };
  for (const command of ['echo y > backlog.md', 'cd x && echo y > backlog.md', 'cat > .omelette/backlog.md']) {
    for (const agent of EVERY_AGENT) {
      const r = fire(g, bashEvent(proj, command, agent), proj, env);
      assert.equal(r.code, 0, `${command} (${agent || 'main thread'}) under the fleet home: ${r.err}`);
    }
  }
  // …while the same file is curated for a project that has its own `.omelette/`.
  // (1.8.0 release fix G9: a `cd` the guard can follow is resolved, so the row
  // goes where the backlog is; `cd x` now lands on proj/x/backlog.md, no curated file.)
  mkdirSync(join(proj, '.omelette'));
  writeFileSync(join(proj, '.omelette', 'backlog.md'), '# backlog\n');
  assert.equal(fire(g, bashEvent(proj, 'cd .omelette && echo y > backlog.md'), proj, env).code, 2);
});
