/**
 * omelette-fleet :: test/tester-1.3.0-fix8.test.mjs
 *
 * Independent tester coverage for Task 8 (S17): a bare vendor name must be
 * resolved to an absolute path from the server's own PATH — ABSOLUTE entries
 * only — once at unit start, and again at spawn time while still unresolved.
 * The call's `cwd` must never influence which executable runs.
 *
 * This file does not import test/bin-resolution.test.mjs (the implementer's
 * tests) — everything it needs is built fresh, against core/unit.mjs only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createUnitRuntime, locateBin } from '../core/unit.mjs';
import grokUnit from '../units/grok/adapter.mjs';
import codexUnit from '../units/codex/adapter.mjs';

const isWin32 = process.platform === 'win32';

/** A fake `grok` CLI: writes a marker file (so a test can tell whether it ran) and answers plain text. */
function fakeGrok(dir, name, who) {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(join(dir, 'ran.txt'))}, ${JSON.stringify(who)});`,
    `console.log('answer from ${who}');`,
    'process.exit(0);',
  ].join('\n'));
  chmodSync(path, 0o755);
  return path;
}

/** A fake `codex` CLI (used only for the re-lookup-after-install case, to cross-check with a second unit). */
function fakeCodex(dir, name, who) {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(join(dir, 'ran.txt'))}, ${JSON.stringify(who)});`,
    `console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer from ${who}' } }));`,
    'process.exit(0);',
  ].join('\n'));
  chmodSync(path, 0o755);
  return path;
}

const tmps = [];
function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

test.after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// --- 2. PATH holding only relative/empty entries — the spawn must fail, and the planted program must never run ---
for (const [label, pathValue] of [['"." only', '.'], ['"::" (two empty entries)', '::'], ['a trailing ":" (one empty entry)', '/nonexistent-omelette-dir:']]) {
  test(`S17: PATH=${label} — no absolute entry holds the bin, the spawn fails before running anything`,
    { skip: isWin32 && 'POSIX PATH search' }, async (t) => {
      const plantedDir = tempDir('omelette-t8-onlyrel-');
      const bare = 'omelette-t8-grok-onlyrel';
      fakeGrok(plantedDir, bare, 'PLANTED');

      const env = { ...process.env, OMELETTE_HOME: plantedDir, GROK_BIN: bare, PATH: pathValue };
      const rt = createUnitRuntime(grokUnit, { env });
      const r = await rt.callTool('grok_research', { prompt: 'q', cwd: plantedDir });

      assert.equal(r.isError, true, r.text);
      assert.match(r.text, new RegExp(`${bare} not found in PATH`), r.text);
      assert.doesNotMatch(r.text, /PLANTED/, r.text);
      assert.equal(existsSync(join(plantedDir, 'ran.txt')), false, 'the planted program ran despite an all-relative PATH');
    });
}

// --- 3. An explicit path (absolute, or containing a slash) is used as given — even with PATH empty ---
test('S17: an explicit absolute <UNIT>_BIN is used as given, even when PATH is empty',
  { skip: isWin32 && 'POSIX PATH search' }, async (t) => {
    const dir = tempDir('omelette-t8-explicit-');
    const explicit = fakeGrok(dir, 'grok-explicit', 'EXPLICIT');

    const env = { ...process.env, OMELETTE_HOME: dir, GROK_BIN: explicit, PATH: '' };
    const rt = createUnitRuntime(grokUnit, { env });
    const r = await rt.callTool('grok_research', { prompt: 'q', cwd: dir });

    assert.equal(r.isError, undefined, r.text);
    assert.match(r.text, /answer from EXPLICIT/, r.text);
    assert.equal(existsSync(join(dir, 'ran.txt')), true);
  });

// --- 4. Not found at unit start; installed into an absolute PATH dir before the call — found on the re-lookup ---
test('S17: a bare name absent at unit start is found on the next spawn once it appears in an absolute PATH dir',
  { skip: isWin32 && 'POSIX PATH search' }, async (t) => {
    const binDir = tempDir('omelette-t8-later-');
    const homeDir = tempDir('omelette-t8-home-');
    const bare = 'omelette-t8-codex-later';
    // Not present yet: the runtime's own PATH lookup (createUnitRuntime) must
    // find nothing here — this proves the re-lookup is what finds it, not the
    // one-time lookup at start.
    const env = { ...process.env, OMELETTE_HOME: homeDir, CODEX_BIN: bare, PATH: binDir };
    assert.equal(locateBin(bare, env), null, 'setup invariant: the bin must not exist yet');

    const rt = createUnitRuntime(codexUnit, { env });
    const before = await rt.callTool('codex_research', { prompt: 'q', cwd: homeDir });
    assert.equal(before.isError, true, before.text);
    assert.match(before.text, new RegExp(`${bare} not found in PATH`), before.text);

    // Install it now, into the SAME absolute PATH directory.
    fakeCodex(binDir, bare, 'INSTALLED-LATER');

    const after = await rt.callTool('codex_research', { prompt: 'q', cwd: homeDir });
    assert.equal(after.isError, undefined, after.text);
    assert.match(after.text, /answer from INSTALLED-LATER/, after.text);
    assert.equal(existsSync(join(binDir, 'ran.txt')), true);
  });

test('S17: end-to-end — a non-executable planted file does not satisfy the lookup, and the call fails rather than running it',
  { skip: isWin32 && 'POSIX PATH search' }, async (t) => {
    const dir = tempDir('omelette-t8-noexec-e2e-');
    const bare = 'omelette-t8-noexec-e2e-bin';
    writeFileSync(join(dir, bare), [
      `#!${process.execPath}`,
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(join(dir, 'ran.txt'))}, 'NOEXEC-RAN');`,
      "console.log('answer from NOEXEC');",
      'process.exit(0);',
    ].join('\n'));
    // No chmod: the file exists, is a regular file, but lacks the execute bit.

    const env = { ...process.env, OMELETTE_HOME: dir, GROK_BIN: bare, PATH: dir };
    const rt = createUnitRuntime(grokUnit, { env });
    const r = await rt.callTool('grok_research', { prompt: 'q', cwd: dir });

    assert.equal(r.isError, true, r.text);
    assert.match(r.text, new RegExp(`${bare} not found in PATH`), r.text);
    assert.equal(existsSync(join(dir, 'ran.txt')), false, 'the non-executable planted file ran');
  });
