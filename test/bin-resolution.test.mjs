/**
 * omelette-fleet :: test/bin-resolution.test.mjs
 *
 * A `<UNIT>_BIN` override that CONTAINS A PATH SEPARATOR is a path, and a
 * relative one is a path relative to the directory the SERVER was started in.
 * Since 0.3.6 a call may ask for the run to happen somewhere else (`cwd` on the
 * three research tools), and the OS resolves a relative command against the
 * CHILD's cwd — so an unresolved override would spawn a different executable,
 * or none, depending on who called. It is made absolute ONCE, at unit start.
 *
 * Each test plants the SAME relative path in two directories: the server's own
 * cwd and the directory the call asks to run in. Only one of them may run, and
 * the marker file each fake writes says which did.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createUnitRuntime, locateBin } from '../core/unit.mjs';
import geminiUnit from '../units/gemini/adapter.mjs';
import grokUnit from '../units/grok/adapter.mjs';
import codexUnit from '../units/codex/adapter.mjs';

/** What each unit's research tool needs on stdout to read a run as an answer. */
const UNITS = {
  gemini: {
    unit: geminiUnit,
    binEnv: 'AGY_BIN',
    tool: 'gemini_research',
    reply: (who) => `console.log(JSON.stringify({ status: 'SUCCESS', response: 'answer from ${who}' }));`,
  },
  grok: {
    unit: grokUnit,
    binEnv: 'GROK_BIN',
    tool: 'grok_research',
    reply: (who) => `console.log('answer from ${who}');`,
  },
  codex: {
    unit: codexUnit,
    binEnv: 'CODEX_BIN',
    tool: 'codex_research',
    reply: (who) => `console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer from ${who}' } }));`,
  },
};

/** A fake vendor CLI at `dir/rel` that records it ran and answers as `who`. */
function fake(dir, rel, who, spec) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(join(dir, 'ran.txt'))}, ${JSON.stringify(who)});`,
    spec.reply(who),
    'process.exit(0);',
  ].join('\n'));
  chmodSync(path, 0o755);
}

for (const [name, spec] of Object.entries(UNITS)) {
  test(`${name}: a relative <UNIT>_BIN with a separator resolves against the server's cwd, not the caller's`, async (t) => {
    const serverDir = mkdtempSync(join(tmpdir(), `omelette-bin-server-${name}-`));
    const callDir = mkdtempSync(join(tmpdir(), `omelette-bin-call-${name}-`));
    t.after(() => {
      rmSync(serverDir, { recursive: true, force: true });
      rmSync(callDir, { recursive: true, force: true });
    });
    // The same relative path exists in both directories. Unresolved, the OS
    // would pick the one in the directory the RUN happens in — the decoy.
    const rel = join('rel', name);
    fake(serverDir, rel, 'server', spec);
    fake(callDir, rel, 'decoy', spec);

    const env = { ...process.env, OMELETTE_HOME: serverDir, [spec.binEnv]: rel };
    const was = process.cwd();
    let rt;
    try {
      process.chdir(serverDir);
      rt = createUnitRuntime(spec.unit, { env });
    } finally {
      process.chdir(was);
    }
    const r = await rt.callTool(spec.tool, { prompt: 'q', cwd: callDir });

    assert.equal(r.isError, undefined, r.text);
    assert.match(r.text, /answer from server/, r.text);
    assert.equal(existsSync(join(serverDir, 'ran.txt')), true, 'the server-side binary never ran');
    assert.equal(existsSync(join(callDir, 'ran.txt')), false, 'the decoy in the call directory ran');
  });
}

for (const [name, spec] of Object.entries(UNITS)) {
  test(`${name}: a bare <UNIT>_BIN is looked up in the ABSOLUTE PATH entries only — a program in the call's cwd never runs (S17)`,
    { skip: process.platform === 'win32' && 'POSIX PATH search' }, async (t) => {
      const goodDir = mkdtempSync(join(tmpdir(), `omelette-bin-good-${name}-`));
      const callDir = mkdtempSync(join(tmpdir(), `omelette-bin-evil-${name}-`));
      t.after(() => {
        rmSync(goodDir, { recursive: true, force: true });
        rmSync(callDir, { recursive: true, force: true });
      });
      const bare = `omelette-s17-${name}`;
      fake(goodDir, bare, 'server', spec);
      fake(callDir, bare, 'decoy', spec);
      // `.` and an empty entry both mean "the directory the child runs in" to
      // the OS's own PATH search — the directory the CALL chose.
      for (const rel of ['.', '']) {
        rmSync(join(goodDir, 'ran.txt'), { force: true });
        rmSync(join(callDir, 'ran.txt'), { force: true });
        const env = { ...process.env, OMELETTE_HOME: goodDir, [spec.binEnv]: bare, PATH: `${rel}${delimiter}${goodDir}` };
        const r = await createUnitRuntime(spec.unit, { env }).callTool(spec.tool, { prompt: 'q', cwd: callDir });
        assert.match(r.text, /answer from server/, `PATH=${JSON.stringify(env.PATH)}: ${r.text}`);
        assert.equal(existsSync(join(callDir, 'ran.txt')), false, `PATH=${JSON.stringify(env.PATH)}: the program planted in the call's cwd ran`);
      }
      // …and with no absolute entry holding it, the answer is "not found" — never the decoy.
      rmSync(join(callDir, 'ran.txt'), { force: true });
      const env = { ...process.env, OMELETTE_HOME: goodDir, [spec.binEnv]: bare, PATH: `.${delimiter}/usr/bin` };
      const r = await createUnitRuntime(spec.unit, { env }).callTool(spec.tool, { prompt: 'q', cwd: callDir });
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, new RegExp(`${bare} not found in PATH`));
      assert.equal(existsSync(join(callDir, 'ran.txt')), false, 'the planted program ran');
    });
}

test('locateBin: a bare name becomes the first executable FILE in an absolute PATH entry; a path is left as it is (S17)',
  { skip: process.platform === 'win32' && 'POSIX PATH search' }, (t) => {
    const a = mkdtempSync(join(tmpdir(), 'omelette-locate-a-'));
    const b = mkdtempSync(join(tmpdir(), 'omelette-locate-b-'));
    t.after(() => {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    });
    writeFileSync(join(a, 'tool'), 'not executable'); //   a file without the execute bit: skipped
    mkdirSync(join(b, 'dirtool')); //                         a directory under the name: skipped
    writeFileSync(join(b, 'tool'), '#!/bin/sh\n');
    chmodSync(join(b, 'tool'), 0o755);
    const env = { PATH: ['.', '', 'rel/bin', a, b].join(delimiter) };
    assert.equal(locateBin('tool', env), join(b, 'tool'));
    assert.equal(locateBin('dirtool', env), null);
    assert.equal(locateBin('missing', env), null);
    assert.equal(locateBin('/abs/tool', env), '/abs/tool', 'a path is not searched for');
    assert.equal(locateBin('tool', {}), null, 'no PATH, nothing found');
  });

test('locateBin: a PATH entry is searched as the OS reads it — `..` after a symlink climbs from where the link POINTS, not from the link\'s own directory',
  { skip: process.platform === 'win32' && 'POSIX symlinks and PATH search' }, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'omelette-locate-dotdot-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // root/a/link -> root/x/y, so the OS reads root/a/link/../bin as root/x/bin;
    // spelled out textually it would be root/a/bin, which holds nothing.
    mkdirSync(join(root, 'a'));
    mkdirSync(join(root, 'x', 'y'), { recursive: true });
    mkdirSync(join(root, 'x', 'bin'));
    symlinkSync(join(root, 'x', 'y'), join(root, 'a', 'link'));
    writeFileSync(join(root, 'x', 'bin', 'tool'), '#!/bin/sh\n');
    chmodSync(join(root, 'x', 'bin', 'tool'), 0o755);
    const entry = `${root}/a/link/../bin`;
    assert.equal(locateBin('tool', { PATH: entry }), `${entry}/tool`);
  });
