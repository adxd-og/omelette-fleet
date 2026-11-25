// core/clone.mjs through its first caller, units/mistral/repro.mjs: what the lift into core (1.13.0)
// must keep of the order Mistral's prepareClone always had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareClone } from '../units/mistral/repro.mjs';

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
