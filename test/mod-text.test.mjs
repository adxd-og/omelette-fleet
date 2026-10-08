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

test('subjectOf: Bash parses in linear time', () => {
  for (const command of ['cd ' + ' '.repeat(20000) + 'x', 'A=' + 'x'.repeat(50000), 'cd ' + '"'.repeat(20001), 'A=1 '.repeat(20000) + 'npm test']) {
    const started = performance.now();
    bash(command);
    const took = performance.now() - started;
    assert.ok(took < 50, `${command.slice(0, 12)}…: ${took.toFixed(1)} ms`);
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
});

test('clock with this machine\'s offset reads as the local time', () => {
  const at = Date.UTC(2026, 9, 8, 12, 5, 40);
  const d = new Date(at);
  const two = (n) => String(n).padStart(2, '0');
  assert.equal(clock(at, d.getTimezoneOffset()), `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`);
});
