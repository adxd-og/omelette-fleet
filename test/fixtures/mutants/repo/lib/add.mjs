// The mutant runner's fixture module (test/mutants.test.mjs): one behaviour the
// fixture test pins (add) and one it never looks at (LABEL).
export const LABEL = 'adder';

export function add(a, b) {
  return a + b;
}

export function double(a) {
  return add(a, a);
}
