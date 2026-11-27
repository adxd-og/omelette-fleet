#!/usr/bin/env node
/**
 * omelette-fleet :: scripts/tmp-sweep.mjs
 * The net under test/tmp-preload.mjs: `pretest` runs it on the OS temp
 * directory before every `npm test`, for what a bare `node --test`, a killed
 * process or a child left there (spec
 * docs/superpowers/specs/2026-11-27-test-tmpdir-design.md). Dev-only:
 * `scripts/` is not in the npm package.
 *
 *   node scripts/tmp-sweep.mjs
 *
 * An entry is removed only when all four hold: its name is `omelette-`,
 * anything, a dash and six characters of mkdtemp's alphabet (SWEEP_NAME);
 * `lstat` says a directory, so a link is never followed and never removed; it
 * belongs to this user; its modification time is more than MAX_AGE_MS old. The
 * units' fixed parents (`omelette-evals`, `omelette-mistral-repro`,
 * `omelette-gemini-test`) stay whatever their age, as does everything not
 * ours. After BUDGET_MS of wall clock it leaves the rest to the next run. It
 * never fails `npm test`: anything thrown is one line on stderr, and the exit
 * code is 0. Importing the module runs nothing.
 */
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A test's mkdtemp under the temp directory: `omelette-<anything>-<six characters>`. */
export const SWEEP_NAME = /^omelette-.*-[A-Za-z0-9]{6}$/;
/** A matching directory last modified longer ago than this is stale. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The wall clock a sweep may spend before it stops. */
export const BUDGET_MS = 5000;

/**
 * Remove the stale directories directly under `root` (see the header): each
 * entry whose name matches SWEEP_NAME, that `lstat` says is a directory owned
 * by `uid`, and whose `now - mtimeMs` is more than `maxAgeMs`. An entry `lstat`
 * cannot read is skipped; one whose removal throws is named in `failed`. The
 * clock is read before each matching name is looked at, so the budget covers
 * the `lstat`s of a crowded directory as well as the removals: at `budgetMs`
 * or more since the call began, the rest is left and `stopped` is true. `uid: null` (no
 * `process.getuid`) removes nothing. Returns names, not paths. THROWS when
 * `root` cannot be read.
 */
export function sweep({ root, now = Date.now(), maxAgeMs = MAX_AGE_MS, budgetMs = BUDGET_MS, uid = typeof process.getuid === 'function' ? process.getuid() : null }) {
  const began = Date.now();
  const removed = [];
  const failed = [];
  for (const name of readdirSync(root)) {
    if (!SWEEP_NAME.test(name)) continue;
    if (Date.now() - began >= budgetMs) return { removed, failed, stopped: true };
    const path = join(root, name);
    let st;
    try { st = lstatSync(path); } catch { continue; }
    if (!(st.isDirectory() && st.uid === uid && now - st.mtimeMs > maxAgeMs)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { removed, failed, stopped: false };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const { removed, stopped } = sweep({ root: realpathSync(tmpdir()) });
    if (removed.length) {
      const rest = stopped ? ` (stopped at the ${BUDGET_MS / 1000} s budget, the rest next run)` : '';
      process.stdout.write(`tmp-sweep: removed ${removed.length} stale omelette-* directories${rest}\n`);
    }
  } catch (e) {
    process.stderr.write(`tmp-sweep: ${(e && e.message) || e}\n`);
  }
}
