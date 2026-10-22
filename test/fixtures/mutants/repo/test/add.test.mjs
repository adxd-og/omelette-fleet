// The fixture repository's one test file: it pins add() and ignores LABEL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { add, double } from '../lib/add.mjs';

test('add sums', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(double(4), 8);
});
