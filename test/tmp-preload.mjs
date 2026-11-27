/**
 * omelette-fleet :: test/tmp-preload.mjs
 * Loaded into every test process by `node --import` (the `test` and
 * `test:file` scripts, and scripts/mutants.mjs for the suites it runs), so the
 * suite stops leaving its scratch in the OS temp directory (spec
 * docs/superpowers/specs/2026-11-27-test-tmpdir-design.md). Dev-only: `test/`
 * is not in the npm package.
 *
 * It wraps the three `mkdtemp` forms of `node:fs` (sync, callback, promise) and
 * re-syncs the ESM named exports, so `import { mkdtempSync } from 'node:fs'` in
 * a test gets the wrapped one. A directory is recorded only when its parent is
 * the OS temp directory, both compared by real path; one made inside a
 * recorded directory goes with it. On the process's `exit` — a pass, a failing
 * test, a `process.exit()` — each recorded directory is removed, recursively; a
 * removal that fails is ignored. It removes only what this very process
 * created: no name pattern, no age, nothing of another process. What a bare
 * `node --test` or a killed process leaves is scripts/tmp-sweep.mjs's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const made = new Set();
const root = () => { try { return fs.realpathSync(os.tmpdir()); } catch { return os.tmpdir(); } };
const note = (p) => {
  try {
    // The parent is resolved, the new directory's own name is not: a link at that name is never followed.
    const s = typeof p === 'string' ? p : p.toString();
    const parent = fs.realpathSync(path.dirname(path.resolve(s)));
    if (parent === root()) made.add(path.join(parent, path.basename(s)));
  } catch { /* gone already */ }
  return p;
};

const sync = fs.mkdtempSync;
fs.mkdtempSync = function (...a) { return note(sync.apply(this, a)); };
const cb = fs.mkdtemp;
fs.mkdtemp = function (...a) {
  const done = a[a.length - 1];
  // No callback: node's own argument error, at the call, as without the preload.
  if (typeof done !== 'function') return cb.apply(this, a);
  a[a.length - 1] = (e, p) => { if (!e) note(p); done(e, p); };
  return cb.apply(this, a);
};
const pm = fs.promises.mkdtemp;
fs.promises.mkdtemp = async function (...a) { return note(await pm.apply(this, a)); };
syncBuiltinESMExports();

process.on('exit', () => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});
