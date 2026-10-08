/**
 * omelette-fleet :: test/mod-text.test.mjs
 * The fleet pane's strings (1.7.0, Task 2): mods/omelette-fleet/hooks/text.mjs
 * cuts text to a width, writes durations and clock times, shortens roles and
 * model ids, and names what a tool call is doing. Each function on its
 * boundary values; paths are made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cells, clock, cut, duration, familyOf, shortModel, shortRole, subjectOf } from '../mods/omelette-fleet/hooks/text.mjs';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

test('cut: text that fits is unchanged; longer text ends in an ellipsis within the cells; no cells, no text', () => {
  assert.equal(cut('abc', 5), 'abc');
  assert.equal(cut('abcde', 5), 'abcde');
  assert.equal(cut('abcdef', 5), 'abcd…');
  assert.equal(cut('abc', 1), '…');
  assert.equal(cut('a', 1), 'a');
  assert.equal(cut('abc', 0), '');
  assert.equal(cut('abc', -3), '');
  assert.equal(cut('', 4), '');
});

test('cut counts terminal cells: a wide character is two, a combining mark none, and a pair is never split', () => {
  assert.equal(cells('日本語'), 6);
  assert.equal(cells('한글'), 4);
  assert.equal(cells('abc'), 3);
  assert.equal(cells('é'), 1, 'a combining acute adds no cell');
  assert.equal(cells('😀'), 2);
  assert.equal(cells(''), 0);
  const wide = cut('日本語のファイル名.mjs', 8);
  assert.ok(cells(wide) <= 8, wide);
  assert.ok(wide.endsWith('…'), wide);
  assert.equal(wide, '日本語…');
  assert.equal(cut('😀😀😀', 6), '😀😀😀');
  assert.equal(cut('😀😀😀', 5), '😀😀…');
  assert.equal(cut('😀😀😀', 2), '…', 'a wide character that does not fit beside the ellipsis is dropped whole');
  assert.equal(cut('ab日', 3), 'ab…');
  for (const width of [1, 2, 3, 4, 5, 7, 9]) {
    const out = cut('日本語のファイル名.mjs', width);
    assert.ok(cells(out) <= width, `${width}: ${out}`);
  }
  assert.equal(cut('éée', 3), 'éée', 'combining marks take no cell');
});

test('duration: m:ss below ten minutes, whole minutes from ten, whole hours from one', () => {
  assert.equal(duration(0), '0:00');
  assert.equal(duration(999), '0:00');
  assert.equal(duration(42 * SEC), '0:42');
  assert.equal(duration(59 * SEC + 999), '0:59');
  assert.equal(duration(MIN), '1:00');
  assert.equal(duration(3 * MIN + 10 * SEC), '3:10');
  assert.equal(duration(10 * MIN - 1), '9:59');
  assert.equal(duration(10 * MIN), '10m');
  assert.equal(duration(12 * MIN), '12m');
  assert.equal(duration(HOUR - 1), '59m');
  assert.equal(duration(HOUR), '1h');
  assert.equal(duration(2 * HOUR + 5 * MIN), '2h');
  assert.equal(duration(26 * HOUR), '26h');
});

test('duration of a negative span (a clock that moved back) is 0:00', () => {
  assert.equal(duration(-5 * SEC), '0:00');
});

test('shortRole drops the omelette- prefix and leaves other roles alone', () => {
  assert.equal(shortRole('omelette-coder-medium'), 'coder-medium');
  assert.equal(shortRole('omelette-tester'), 'tester');
  assert.equal(shortRole('Explore'), 'Explore');
  assert.equal(shortRole('general-purpose'), 'general-purpose');
  assert.equal(shortRole('my-omelette-helper'), 'my-omelette-helper');
});

test('shortRole strips a plugin namespace first, then the omelette- prefix', () => {
  assert.equal(shortRole('omelette-fleet:omelette-coder-medium'), 'coder-medium');
  assert.equal(shortRole('other:thing'), 'thing');
  assert.equal(shortRole('other:omelette-'), 'omelette-', 'nothing left after the prefix: the name stays');
  assert.equal(shortRole('a:b:c'), 'b:c', 'one namespace only');
});

test('shortModel drops the claude- prefix and leaves other ids alone', () => {
  assert.equal(shortModel('claude-opus-5-5'), 'opus-5-5');
  assert.equal(shortModel('claude-fable-5-1'), 'fable-5-1');
  assert.equal(shortModel('grok-4.7'), 'grok-4.7');
  assert.equal(shortModel('gpt-6.1-sol'), 'gpt-6.1-sol');
});

test('familyOf names a Claude model\'s family and leaves a non-Claude id unchanged', () => {
  assert.equal(familyOf('claude-opus-5-5'), 'opus');
  assert.equal(familyOf('claude-sonnet-5-5'), 'sonnet');
  assert.equal(familyOf('claude-fable-5-1'), 'fable');
  assert.equal(familyOf('grok-4.7'), 'grok-4.7');
  assert.equal(familyOf('gpt-6.1-sol'), 'gpt-6.1-sol');
});

const bash = (command) => subjectOf('Bash', { command });

test('subjectOf: Bash shows the program, and a second word only for a known program and a plain word', () => {
  assert.equal(bash('npm test --watch'), 'Bash: npm test');
  assert.equal(bash('  git\tstatus \n --short'), 'Bash: git status');
  assert.equal(bash('ls'), 'Bash: ls');
  assert.equal(bash('ls -la /x'), 'Bash: ls');
  assert.equal(bash('a b c d e'), 'Bash: a', 'an unknown program shows alone');
  assert.equal(bash('npm test --x'), 'Bash: npm test');
  assert.equal(bash('/usr/local/bin/git status'), 'Bash: git status');
  assert.equal(bash('git -C /x status'), 'Bash: git');
  assert.equal(bash('npm run build:prod'), 'Bash: npm run');
  assert.equal(bash('node a.js'), 'Bash: node a.js');
  assert.equal(bash('omelette-fleet doctor'), 'Bash: omelette-fleet doctor');
  assert.equal(bash('npm test | tail -5'), 'Bash: npm test');
  assert.equal(bash('npm test&&echo ok'), 'Bash: npm test');
  assert.equal(subjectOf('Bash', {}), 'Bash');
  assert.equal(subjectOf('Bash', undefined), 'Bash');
  assert.equal(bash(''), 'Bash');
  assert.equal(bash('   '), 'Bash');
});

test('subjectOf: Bash skips leading assignments and one leading cd command', () => {
  assert.equal(bash('OPENAI_API_KEY=sk-x node a.js'), 'Bash: node a.js');
  assert.equal(bash('cd /home/op/p && npm test'), 'Bash: npm test');
  assert.equal(bash('cd /home/op/p; FOO=1 make all'), 'Bash: make all');
  assert.equal(bash('A=1 B=2'), 'Bash');
  assert.equal(bash('TOKEN="a b c" CI=1 npm test'), 'Bash: npm test', 'a quoted value is one word');
  assert.equal(bash("TOKEN='a b' npm test"), 'Bash: npm test');
  assert.equal(bash('TOKEN=a\\ b npm test'), 'Bash: npm test', 'an escaped space stays in the value');
  assert.equal(bash('TOKEN="unclosed npm test'), 'Bash', 'an open quote: plain Bash');
  assert.equal(bash('TOKEN=$(cat f) npm test'), 'Bash', 'a command substitution ends the scan');
  assert.equal(bash('cd /home/op/p && cd sub && make'), 'Bash: cd', 'one cd only');
  assert.equal(bash('cd /home/op/p'), 'Bash: cd', 'a bare cd');
  assert.equal(bash('cd "/home/op/my proj" && make all'), 'Bash: make all');
  assert.equal(bash('cd /home/op/p && '), 'Bash', 'nothing after the cd');
  assert.equal(bash('FOO=1 cd /x && npm test'), 'Bash: npm test');
});

test('subjectOf: a program word that is not a plain name is plain Bash', () => {
  assert.equal(bash('1A=b cmd'), 'Bash');
  assert.equal(bash('=x cmd'), 'Bash');
  assert.equal(bash('echo A=b'), 'Bash: echo');
  assert.equal(bash('$CMD run'), 'Bash');
  assert.equal(bash('./run.sh'), 'Bash: run.sh');
  assert.equal(bash('g++ a.cc'), 'Bash: g++');
});

test('subjectOf: Bash keeps secrets off the screen', () => {
  const cases = {
    'OPENAI_API_KEY=sk-x node a.js': 'Bash: node a.js',
    'export TOKEN=sk-live123': 'Bash: export',
    'env TOKEN=sk-live123 node x.js': 'Bash: env',
    'sudo TOKEN=sk-live123 node x': 'Bash: sudo',
    'echo sk-live123 | gh auth login': 'Bash: echo',
    'mysql -psecret123 db': 'Bash: mysql',
    'TOKEN=a\\ b npm test': 'Bash: npm test',
    'TOKEN=$(cat f) npm test': 'Bash',
    'TOKEN="sk-x y node a.js': 'Bash',
    'TOKEN="unclosed npm test': 'Bash',
    'npm `echo sk-live`': 'Bash: npm',
    'node $(echo sk-live)': 'Bash: node',
    'node "$(cat secret)"': 'Bash: node',
  };
  for (const [command, expected] of Object.entries(cases)) {
    const out = bash(command);
    assert.equal(out, expected, command);
    for (const fragment of ['sk-', 'secret', 'TOKEN', 'cat f']) assert.ok(!out.includes(fragment), `${command} → ${out}`);
  }
});

const MARK = 'S3CR3T9';
const SUBCOMMAND_PROGRAMS = ['npm', 'npx', 'pnpm', 'yarn', 'git', 'gh', 'node', 'cargo', 'go', 'make', 'docker', 'python', 'python3', 'pytest', 'claude', 'omelette-fleet'];
/** What a Bash subject may look like at all: the program, and a second word only for a listed program. */
const SUBJECT_SHAPE = /^Bash(?:: ([A-Za-z0-9._+-]+)(?: ([a-z][a-z0-9:._-]*))?)?$/i;

/** mulberry32: a seeded generator whose low bits are as good as its high ones. */
function lcg(seed) {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
}

test('subjectOf Bash, the examples of the ruling: program, listed second word, the cases that show only the program or plain Bash', () => {
  const b = (command) => subjectOf('Bash', { command });
  assert.equal(b('npm test'), 'Bash: npm test');
  assert.equal(b('npm test --silent'), 'Bash: npm test');
  assert.equal(b('npm run build'), 'Bash: npm run');
  assert.equal(b('git status'), 'Bash: git status');
  assert.equal(b('git commit -m "msg"'), 'Bash: git commit');
  assert.equal(b('/usr/local/bin/node x.js'), 'Bash: node x.js');
  assert.equal(b('./scripts/build.sh --all'), 'Bash: build.sh');
  assert.equal(b('curl https://example.test'), 'Bash: curl');
  assert.equal(b('rm -rf node_modules'), 'Bash: rm');
  assert.equal(b('echo hello'), 'Bash: echo');
  for (const program of SUBCOMMAND_PROGRAMS) assert.equal(b(`${program} sub-cmd:x.y_z --flag`), `Bash: ${program} sub-cmd:x.y_z`, program);
  assert.equal(b('npm'), 'Bash: npm');
  // a program outside the list shows alone, whatever its second word looks like
  for (const command of ['curl abc', 'echo hello', 'ls src', 'rm file', 'cat README', 'sudo npm', 'env x', 'export TOKEN', 'bash script', 'ssh host', 'time npm']) assert.equal(b(command), `Bash: ${command.split(' ')[0]}`, command);
  // a second word may be any case, but must start with a letter
  assert.equal(b('git STATUS'), 'Bash: git STATUS');
  assert.equal(b('npm Test'), 'Bash: npm Test');
  assert.equal(b('npm _x'), 'Bash: npm');
  // the second word must be plain: no flag, no path, no =, no number first, no quote or $
  for (const next of ['-v', '--version', './x', '/abs', 'a=b', '1abc', '$X', '~', '@scope/pkg', 'a/b']) {
    assert.equal(b(`npm ${next}`), 'Bash: npm', next);
  }
  assert.equal(b('npm "a b"'), 'Bash: npm');
  // quoted words are grouped before the checks
  assert.equal(b('npm "test"'), 'Bash: npm test');
  assert.equal(b("git 'status' -s"), 'Bash: git status');
  assert.equal(b('np\\m test'), 'Bash: npm test');
  // a program word outside [A-Za-z0-9._+-] is plain Bash
  for (const command of ['$X test', '"a b" c', "'a b' c", '${X} y', 'a=b', '@x y', '{ npm test; }', '!npm', '<(x)', '\\$x y', 'a:b c', 'a,b c', 'é c']) {
    assert.equal(b(command), 'Bash', command);
  }
  // the program is the base name of its word
  assert.equal(b('/a/b/git status'), 'Bash: git status');
  assert.equal(b('../x/make all'), 'Bash: make all');
  assert.equal(b('/a/b/'), 'Bash');
  assert.equal(b('~/bin/x y'), 'Bash: x', 'the plain-word check is on the base name');
  assert.equal(b('/a/b/$X y'), 'Bash');
  // stops at the first unquoted separator
  for (const [command, shown] of [
    ['npm test | tee out', 'Bash: npm test'],
    ['npm test && echo done', 'Bash: npm test'],
    ['npm test || echo fail', 'Bash: npm test'],
    ['npm test; echo done', 'Bash: npm test'],
    ['npm test\necho done', 'Bash: npm test'],
    ['npm test & echo bg', 'Bash: npm test'],
    ['npm $(echo test)', 'Bash: npm'],
    ['npm `echo test`', 'Bash: npm'],
    ['npm (test)', 'Bash: npm'],
    ['git status)', 'Bash: git status'],
    ['(npm test)', 'Bash'],
    ['| npm test', 'Bash'],
    ['; npm test', 'Bash'],
    ['\nnpm test', 'Bash'],
    ['&& npm test', 'Bash'],
  ]) assert.equal(b(command), shown, JSON.stringify(command));
  // a separator glued to a word ends the scan there (and the word is not cut with it)
  for (const [command, shown] of [
    ['npm test|tee', 'Bash: npm test'],
    ['npm test;ls', 'Bash: npm test'],
    ['npm test&&ls', 'Bash: npm test'],
    ['npm test||ls', 'Bash: npm test'],
    ['npm test(x)', 'Bash: npm test'],
    ['npm test)x', 'Bash: npm test'],
    ['npm test`x`', 'Bash: npm test'],
    ['npm test$(x)', 'Bash: npm test'],
    ['npm test\nls', 'Bash: npm test'],
  ]) assert.equal(b(command), shown, JSON.stringify(command));
  assert.equal(b('cd /x || npm test'), 'Bash: cd');
  // inside quotes the separators are text, and a substitution inside double quotes stops the scan
  assert.equal(b('git "status; rm" -s'), 'Bash: git', 'the quoted word is not plain');
  assert.equal(b("git 'a|b'"), 'Bash: git');
  assert.equal(b('npm "te$(x)st"'), 'Bash: npm');
  assert.equal(b('npm "te`x`st"'), 'Bash: npm');
  assert.equal(b("npm 'te$(x)st'"), 'Bash: npm', 'single quotes keep the $( as text, and the word is not plain');
  // a substitution inside double quotes ends the scan and drops its word, so what follows is never read
  assert.equal(b('cd "a$(x)" && npm test'), 'Bash: cd');
  assert.equal(b('cd "a`x`" && npm test'), 'Bash: cd');
  assert.equal(b('npm "$(echo "'), 'Bash: npm');
  assert.equal(b('npm "`echo "'), 'Bash: npm');
  assert.equal(b('npm "te\\"st"'), 'Bash: npm', 'an escaped quote inside double quotes does not close them');
  assert.equal(b('npm test "a\\" b" c'), 'Bash: npm test');
  // an unclosed quote anywhere in the scanned part
  for (const command of ['npm "test', "npm 'test", 'echo "', "echo '", 'FOO="x npm test', 'npm test "unclosed']) assert.equal(b(command), 'Bash', command);
  assert.equal(b('npm test && echo "unclosed'), 'Bash: npm test', 'beyond the stop, nothing is read');
  // backslash escapes
  assert.equal(b('npm test\\'), 'Bash: npm test');
  assert.equal(b('np\\ m test'), 'Bash', 'an escaped space is part of the word');
  assert.equal(b('npm te\\;st'), 'Bash: npm', 'an escaped ; is text, and the word is not plain');
  assert.equal(b('npm \\|'), 'Bash: npm');
});

test('subjectOf Bash, a property: a marker secret never reaches the subject - assignments, prefixes, flags, substitutions, pipes, separators, quotes, escapes', () => {
  const rnd = lcg(20261008);
  const pick = (list) => list[rnd(list.length)];
  const values = [
    MARK, `"${MARK}"`, `'${MARK}'`, `"a ${MARK}"`, `'a ${MARK}'`, `a\\ ${MARK}`, `x${MARK}`, `"x"${MARK}`, `$(echo ${MARK})`, `\`echo ${MARK}\``,
    `"$(echo ${MARK})"`, `"x \`echo ${MARK}\`"`, `\${${MARK}}`, `$'${MARK}'`, `"it's ${MARK}"`, `'say "${MARK}"'`, `"a\\"${MARK}"`, `a\\;${MARK}`, `"a;b|c&&${MARK}"`, `'(${MARK})'`,
    `a\\\n${MARK}`, `"multi\nline ${MARK}"`, `$(a "$(b ${MARK})")`, `"$X"${MARK}`,
  ];
  const connectors = [' | ', ' && ', ' || ', '; ', '\n', ' & ', ' > ', ' 2>&1 | ', ' <<< ', ' $(', ' `', ' (', ' ) ', ';;', '|&', '\r\n'];
  const assignments = [(v) => `TOKEN=${v}`, (v) => `A_B1=${v}`, (v) => `_x=${v}`, (v) => `A+=${v}`, (v) => `A[0]=${v}`, () => 'TOKEN=', (v) => `export TOKEN=${v}`, (v) => `A=1 B=${v}`];
  // programs with the words that precede the secret slot: a listed program's second word is shown, so the slot comes after it
  const programs = [
    'npm test', 'git status', 'node x.js', 'docker run', 'gh auth', 'make deploy', 'claude -p', 'python3 -c', 'cargo build', 'pnpm install', 'yarn add', 'npx tool', 'go run', 'pytest -k', 'omelette-fleet set',
    'echo', 'curl', 'sudo', 'env', 'export', 'time', '/usr/bin/env', 'bash -c', 'sh -c', 'ssh', 'mysql', 'psql', 'wget', 'nohup', 'xargs', 'cat', 'printf', 'gpg --passphrase', 'aws', 'kubectl',
  ];
  const flagged = [(v) => `--token ${v}`, (v) => `--token=${v}`, (v) => `-p${v}`, (v) => `-H "Authorization: Bearer ${v}"`, (v) => `--password '${v}'`, (v) => v, (v) => `https://user:${v}@host/x`, (v) => `-e KEY=${v}`, (v) => `--env=KEY=${v}`, (v) => `${v} --flag`];
  const chains = ['', 'cd /x && ', 'cd /x; ', 'cd "a b" && ', 'cd /x && cd /y && ', `cd ${MARK} && `, `cd ${MARK}; `, `cd "${MARK}" && `, 'cd /x || ', 'cd /x | ', '(', '{ ', '! ', 'FOO=1 '];
  const leaks = [];
  // every program with every flag form and value, and every chain, connector and assignment form around a fixed program
  const check = (command) => {
    const out = subjectOf('Bash', { command });
    if (out.includes('S3CR')) leaks.push([command, out]);
    const m = SUBJECT_SHAPE.exec(out);
    assert.ok(m, `shape: ${JSON.stringify(command)} -> ${JSON.stringify(out)}`);
    if (m[2] !== undefined) assert.ok(SUBCOMMAND_PROGRAMS.includes(m[1]), `second word only for a listed program: ${JSON.stringify(command)} -> ${out}`);
  };
  for (const program of programs) for (const flag of flagged) for (const value of values) check(`${program} ${flag(value)}`);
  for (const chain of chains) for (const assign of assignments) for (const value of values) check(`${chain}${assign(value)} npm test --x`);
  for (const connector of connectors) for (const program of programs) for (const flag of flagged) for (const value of values) check(`npm test${connector}${program} ${flag(value)}`);
  for (const chain of chains) for (const value of values) check(`${chain}export X=${value}`);
  const N = 6000;
  for (let k = 0; k < N; k++) {
    const parts = [pick(chains)];
    if (rnd(3) > 0) for (let n = rnd(3) + 1; n > 0; n--) parts.push(`${pick(assignments)(pick(values))} `);
    parts.push(pick(programs));
    for (let n = rnd(3); n > 0; n--) parts.push(` ${pick(flagged)(pick(values))}`);
    if (rnd(2)) parts.push(pick(connectors) + pick(flagged)(pick(values)));
    if (rnd(4) === 0) parts.push(`${pick(connectors) + pick(programs)} ${pick(flagged)(pick(values))}`);
    check(parts.join(''));
  }
  assert.deepEqual(leaks.slice(0, 5), [], `${leaks.length} of ${N} generated commands put the marker on screen`);
});

test('subjectOf Bash is linear: 100 000-character commands of spaces, quotes, backslashes, =, cd, separators and assignments each take under 250 ms (the defect it pins took seconds; the bound leaves room for a loaded CI machine)', () => {
  const n = 100000;
  const cases = {
    spaces: ' '.repeat(n),
    'cd and spaces': `cd ${' '.repeat(n)}x`,
    'cd and spaces then &&': `cd ${' '.repeat(n)}&& npm test`,
    'npm and spaces': `npm${' '.repeat(n)}test`,
    'double quotes': '"'.repeat(n),
    'single quotes': "'".repeat(n),
    'open quote then text': `FOO="${'x'.repeat(n)}`,
    'quote pairs': '""'.repeat(n / 2),
    backslashes: '\\'.repeat(n),
    'backslash pairs': '\\ '.repeat(n / 2),
    'equals signs': '='.repeat(n),
    'name equals': `A${'='.repeat(n)}`,
    assignments: 'A=1 '.repeat(n / 4),
    'assignment of a long word': `A=${'b'.repeat(n)} npm test`,
    'a long word': 'a'.repeat(n),
    'a long name without =': `${'A'.repeat(n)} x`,
    'cd words': 'cd '.repeat(n / 3),
    'cd and &&': 'cd x && '.repeat(n / 8),
    'cd and ;': 'cd x; '.repeat(n / 6),
    'dollar-parens': '$('.repeat(n / 2),
    'double quote then dollar-parens': `"${'$('.repeat(n / 2)}`,
    backticks: '`'.repeat(n),
    newlines: '\n'.repeat(n),
    pipes: '|'.repeat(n),
    ampersands: '&'.repeat(n),
    'many words': 'a '.repeat(n / 2),
    'many words after npm': `npm ${'t '.repeat(n / 2)}`,
    tabs: '\t'.repeat(n),
    'cd tab runs': `cd${'\t '.repeat(n / 2)}`,
    'cd and quotes': `cd ${'"'.repeat(n)}`,
  };
  subjectOf('Bash', { command: 'npm test' }); // warm up
  for (const [name, command] of Object.entries(cases)) {
    let best = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      const t = performance.now();
      subjectOf('Bash', { command });
      best = Math.min(best, performance.now() - t);
    }
    assert.ok(best < 250, `${name}: ${best.toFixed(1)} ms for ${command.length} characters`);
  }
});

test('subjectOf: the file tools with the file\'s base name', () => {
  assert.equal(subjectOf('Edit', { file_path: '/home/op/fleet/units/grok/adapter.mjs' }), 'Edit adapter.mjs');
  assert.equal(subjectOf('Write', { file_path: '/home/op/fleet/README.md' }), 'Write README.md');
  assert.equal(subjectOf('Read', { file_path: 'units/grok/models.js' }), 'Read models.js');
  assert.equal(subjectOf('NotebookEdit', { notebook_path: '/home/op/notes/run.ipynb' }), 'NotebookEdit run.ipynb');
  assert.equal(subjectOf('Read', { file_path: 'C:\\op\\fleet\\plan.md' }), 'Read plan.md');
  assert.equal(subjectOf('Edit', {}), 'Edit');
});

test('subjectOf: a unit tool is its tool part; any other tool is its name', () => {
  assert.equal(subjectOf('mcp__orion-grok__grok_code_review', { prompt: 'x' }), 'code_review');
  assert.equal(subjectOf('mcp__x__gemini_deep_research', {}), 'deep_research');
  assert.equal(subjectOf('mcp__omelette__get_usage', {}), 'mcp__omelette__get_usage');
  assert.equal(subjectOf('Grep', { pattern: 'x' }), 'Grep');
  assert.equal(subjectOf('Agent', { subagent_type: 'omelette-tester' }), 'Agent');
});

test('clock: HH:MM:SS of a time shifted by the offset getTimezoneOffset reports, across midnight both ways', () => {
  const at = Date.UTC(2026, 9, 8, 12, 5, 40, 999);
  assert.equal(clock(at, 0), '12:05:40');
  assert.equal(clock(at, -180), '15:05:40', 'UTC+3 reports -180');
  assert.equal(clock(at, 300), '07:05:40', 'UTC-5 reports 300');
  assert.equal(clock(Date.UTC(2026, 9, 8, 23, 30, 0), -180), '02:30:00');
  assert.equal(clock(Date.UTC(2026, 9, 8, 1, 0, 0), 120), '23:00:00');
  assert.equal(clock(Date.UTC(2026, 9, 8, 0, 0, 0), 0), '00:00:00');
  assert.equal(clock(-1000, 0), '23:59:59', 'before the epoch');
  assert.equal(clock(Date.UTC(1969, 11, 31, 23, 0, 0), 120), '21:00:00');
});

test('clock with this machine\'s offset reads as the local time', () => {
  const at = Date.UTC(2026, 9, 8, 12, 5, 40);
  const d = new Date(at);
  const two = (n) => String(n).padStart(2, '0');
  assert.equal(clock(at, d.getTimezoneOffset()), `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`);
});
