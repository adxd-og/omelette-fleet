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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createUnitRuntime } from '../core/unit.mjs';
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
