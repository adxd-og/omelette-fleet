/**
 * omelette-fleet :: test/mod-text-clean.test.mjs
 * The pane's strings come from outside — file names in a repository, model ids
 * and roles from the engine and the status-feed files — so text.mjs's `clean`
 * drops the characters a terminal would act on (C0 and C1 controls, DEL, the
 * bidi controls) before anything is measured or cut (1.7.0, Task 3 ruling);
 * and `cells` counts every East Asian Wide and Fullwidth code point (emoji
 * included) as two cells, from a generated table (Task 3, fix round 1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cells, clean, cut } from '../mods/omelette-fleet/hooks/text.mjs';

const range = (low, high) => Array.from({ length: high - low + 1 }, (_, i) => String.fromCodePoint(low + i));
const DROPPED = [...range(0x00, 0x1f), '\u007f', ...range(0x80, 0x9f), '\u061c', '\u200e', '\u200f', ...range(0x202a, 0x202e), ...range(0x2066, 0x2069)];

test('clean drops every C0 and C1 control, DEL and each bidi control', () => {
  for (const ch of DROPPED) {
    const code = ch.codePointAt(0).toString(16);
    assert.equal(clean(`a${ch}b`), 'ab', `U+${code}`);
  }
  assert.equal(clean(DROPPED.join('')), '');
});

test('clean keeps what a pane draws: text, the pane\'s own glyphs, wide characters, emoji with their joiners', () => {
  const kept = 'Edit 日本語.mjs ▶ · … → ← ┼ 👩\u200d💻 café é 😀\u200b\u2028';
  assert.equal(clean(kept), kept);
  assert.equal(clean(''), '');
});

test('clean on a hostile file name: the escape sequences lose their ESC and BEL, the override its U+202E', () => {
  assert.equal(clean('\u001b[2J\u001b]0;pwned\u0007x.mjs'), '[2J]0;pwnedx.mjs');
  assert.equal(clean('evil\u202egnp.mjs'), 'evilgnp.mjs');
  assert.equal(clean('a\tb\nc\rd'), 'abcd');
});

test('clean answers a string for anything: a non-string is the empty string', () => {
  for (const value of [undefined, null, 42, {}, [], true, Symbol('s')]) assert.equal(clean(value), '');
});

test('clean runs in linear time on a long hostile string', () => {
  const long = '\u001b['.repeat(500_000) + 'x'.repeat(500_000) + '\u202e'.repeat(500_000);
  const started = Date.now();
  const out = clean(long);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
  assert.equal(out, '['.repeat(500_000) + 'x'.repeat(500_000));
});

test('cells: the newer emoji block U+1FA70–1FAFF is two cells wide where assigned, and a cut keeps one whole', () => {
  assert.equal(cells(String.fromCodePoint(0x1fa70)), 2);
  assert.equal(cells('🪄'), 2);
  assert.equal(cells('🫠'), 2);
  assert.equal(cells(String.fromCodePoint(0x1faf8)), 2, 'the block\'s last assigned code point in Unicode 16');
  assert.equal(cells(String.fromCodePoint(0x1fa6f)), 1, 'below the block');
  assert.equal(cells(String.fromCodePoint(0x1fb00)), 1, 'above the block');
  assert.equal(cut('🫠🫠🫠', 5), '🫠🫠…');
  assert.ok(cells(cut('ab🫠', 3)) <= 3);
});

test('cells: the wide characters a hand table missed are two cells each', () => {
  for (const ch of ['✅', '⚡', '❌', '⭐', '⌚', '☕', '⏳', '➕', '🟢', '🆗', '🀄', '🈚', String.fromCodePoint(0x17000), String.fromCodePoint(0x1b170)]) {
    assert.equal(cells(ch), 2, `U+${ch.codePointAt(0).toString(16)}`);
  }
  assert.equal(cells('Edit ✅notes.md'), 15);
  assert.equal(cells('✅'.repeat(12)), 24);
  assert.ok(cells(cut('✅'.repeat(12), 14)) <= 14);
});

test('cells: ASCII, accented Latin and a combining sequence keep their widths; the pane\'s own glyphs stay one cell', () => {
  assert.equal(cells('npm test'), 8);
  assert.equal(cells('café crème naïve'), 16);
  assert.equal(cells('e\u0301'), 1, 'e and a combining acute');
  assert.equal(cells('●▶◌·…→←×─│┌┼'), 12);
});

test('cells: a VS16 after a one-cell code point makes the pair two cells; after a wide one it adds nothing; alone it is none', () => {
  assert.equal(cells('❤\ufe0f'), 2, 'a heart with emoji presentation');
  assert.equal(cells('☀\ufe0f'), 2, 'a sun with emoji presentation');
  assert.equal(cells('✅\ufe0f'), 2, 'a wide check mark stays two');
  assert.equal(cells('\ufe0f'), 0, 'a lone VS16');
});

test('cut never splits a base from its VS16', () => {
  assert.equal(cut('ab❤\ufe0fcd', 3), 'ab…', 'the pair does not fit beside the ellipsis: both go');
  assert.equal(cut('a❤\ufe0fbcd', 4), 'a❤\ufe0f…', 'the pair fits: both stay');
});

test('cells: a million calls on mixed text take under a second', () => {
  const samples = ['npm test', 'Edit ✅notes.md', '日本語.mjs', 'café', '🫠 ok', 'e\u0301x'];
  const started = Date.now();
  let total = 0;
  for (let i = 0; i < 1_000_000; i++) total += cells(samples[i % samples.length]);
  const took = Date.now() - started;
  assert.ok(took < 1000, `${took} ms`);
  assert.ok(total > 0);
});
