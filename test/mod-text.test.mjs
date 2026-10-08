/**
 * omelette-fleet :: test/mod-text.test.mjs
 * The fleet pane's strings (1.7.0, Task 2): mods/omelette-fleet/hooks/text.mjs
 * cuts text to a width, writes durations and clock times, shortens roles and
 * model ids, and names what a tool call is doing. Each function on its
 * boundary values; paths are made up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, cut, duration, familyOf, shortModel, shortRole, subjectOf } from '../mods/omelette-fleet/hooks/text.mjs';

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

test('cut counts code points, so a surrogate pair is never split', () => {
  assert.equal(cut('😀😀😀', 3), '😀😀😀');
  assert.equal(cut('😀😀😀', 2), '😀…');
  assert.equal([...cut('😀😀😀😀', 3)].length, 3);
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

test('subjectOf: Bash with the command\'s first two words', () => {
  assert.equal(subjectOf('Bash', { command: 'npm test --watch' }), 'Bash: npm test');
  assert.equal(subjectOf('Bash', { command: '  git\tstatus \n --short' }), 'Bash: git status');
  assert.equal(subjectOf('Bash', { command: 'ls' }), 'Bash: ls');
  assert.equal(subjectOf('Bash', { command: 'npm test --x' }), 'Bash: npm test');
  assert.equal(subjectOf('Bash', {}), 'Bash');
  assert.equal(subjectOf('Bash', undefined), 'Bash');
});

test('subjectOf: Bash skips leading assignments (often a secret) and one leading cd segment, then takes two words', () => {
  assert.equal(subjectOf('Bash', { command: 'OPENAI_API_KEY=sk-x node a.js' }), 'Bash: node a.js');
  assert.equal(subjectOf('Bash', { command: 'cd /home/op/p && npm test' }), 'Bash: npm test');
  assert.equal(subjectOf('Bash', { command: 'cd /home/op/p; FOO=1 make all' }), 'Bash: make all');
  assert.equal(subjectOf('Bash', { command: 'A=1 B=2' }), 'Bash');
  assert.equal(subjectOf('Bash', { command: 'TOKEN="a b c" CI=1 npm test' }), 'Bash: npm test', 'a quoted value is one word');
  assert.equal(subjectOf('Bash', { command: 'TOKEN="sk-x y node a.js' }), 'Bash', 'an open quote: nothing of the value is shown');
  assert.equal(subjectOf('Bash', { command: 'cd /home/op/p && cd sub && make' }), 'Bash: cd sub', 'one cd segment only');
  assert.equal(subjectOf('Bash', { command: 'cd /home/op/p' }), 'Bash: cd /home/op/p', 'a cd with nothing after it is the command');
  assert.equal(subjectOf('Bash', { command: 'cd /home/op/p && ' }), 'Bash');
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
