// 1.6.1 release fix round C: the three release reviews' accepted findings.
// C1 — a paired unit's feed and record name the model its adapter pins (the
// catalog head when nothing names one), so feed, record and argv agree; a unit
// without the opt-in still says `null` for the vendor's default. The text items
// (T1–T9) and C2 were documentation tests and were removed. Every run uses a throwaway fleet home and
// a fake vendor binary; nothing real is spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUnitRuntime } from '../core/unit.mjs';
import codexUnit from '../units/codex/adapter.mjs';
import grokUnit from '../units/grok/adapter.mjs';

const HEAD = codexUnit.catalog.ids[0];

/**
 * A fake vendor binary that logs its argv and, while the run is live, copies
 * the unit's status snapshot (status-<unit>-<pid>.json in the fleet home) —
 * what the feed's `active` entry said about the run in flight. `answer` is the
 * rest of the script: how it replies.
 */
function station(unitName, answer) {
  const dir = mkdtempSync(join(tmpdir(), `omelette-fixc-${unitName}-`));
  const bin = join(dir, `fake-${unitName}`);
  const argvLog = join(dir, 'argv.log');
  const seen = join(dir, 'snapshot-seen.json');
  writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    "const path = require('path');",
    `fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    `const snap = fs.readdirSync(${JSON.stringify(dir)}).find((f) => /^status-${unitName}-\\d+\\.json$/.test(f));`,
    `if (snap) fs.writeFileSync(${JSON.stringify(seen)}, fs.readFileSync(path.join(${JSON.stringify(dir)}, snap), 'utf8'));`,
    ...answer,
  ].join('\n'));
  chmodSync(bin, 0o755);
  return {
    dir,
    bin,
    argv: () => JSON.parse(readFileSync(argvLog, 'utf8').split('\n')[0]),
    seen: () => JSON.parse(readFileSync(seen, 'utf8')),
    startLine: () => readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === 'start'),
    record: (unit) => {
      const d = join(dir, 'results', unit);
      return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(d, f), 'utf8'))[0] : '';
    },
  };
}

const CODEX_ANSWER = [
  "process.stdin.on('data', () => {}).on('end', () => {",
  "  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
  "  line({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } });",
  "  line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });",
  '});',
  'process.stdin.resume();',
];

const codexRuntime = (st) => createUnitRuntime(codexUnit, { env: { PATH: process.env.PATH, HOME: st.dir, OMELETTE_HOME: st.dir, CODEX_BIN: st.bin } });

test('C1: a default codex call — the argv, the feed\'s active entry, the ndjson start line and the record all name the catalog head', async () => {
  const st = station('codex', CODEX_ANSWER);
  const r = await codexRuntime(st).callTool('codex_research', { prompt: 'x' });
  assert.ok(!r.isError, r.text);
  const argv = st.argv();
  assert.equal(argv[argv.indexOf('-m') + 1], HEAD);
  assert.equal(st.seen().active[0].model, HEAD, JSON.stringify(st.seen()));
  assert.equal(st.seen().active[0].effort, 'xhigh');
  assert.equal(st.startLine().model, HEAD);
  assert.match(st.record('codex'), new RegExp(`^model: ${HEAD.replaceAll('.', '\\.')}$`, 'm'));
});

test('C1: a named codex model is what the argv, the feed and the ndjson start line say', async () => {
  const st = station('codex', CODEX_ANSWER);
  await codexRuntime(st).callTool('codex_research', { prompt: 'x', model: 'gpt-6-luna' });
  const argv = st.argv();
  assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-6-luna');
  assert.equal(st.seen().active[0].model, 'gpt-6-luna');
  assert.equal(st.startLine().model, 'gpt-6-luna');
  assert.match(st.record('codex'), /^model: gpt-6-luna$/m);
});

test('C1: a unit without the opt-in (grok) still says null for a default call — the vendor\'s default is not named', async () => {
  const st = station('grok', ['process.exit(1);']);
  await createUnitRuntime(grokUnit, { env: { PATH: process.env.PATH, HOME: st.dir, OMELETTE_HOME: st.dir, GROK_BIN: st.bin } }).callTool('grok_research', { prompt: 'x' });
  assert.ok(!st.argv().includes('--model'), st.argv().join(' '));
  assert.equal(st.seen().active[0].model, null, JSON.stringify(st.seen()));
  assert.equal(st.startLine().model, null);
});
