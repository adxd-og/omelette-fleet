// Named like the runner's own tests (test/mutants*.test.mjs), which it never runs:
// were this file in the measured set, the fixture's baseline would go red.
import test from 'node:test';
import assert from 'node:assert/strict';

test('the runner leaves out its own tests', () => {
  assert.fail('a test/mutants*.test.mjs file was run by the mutant runner');
});
