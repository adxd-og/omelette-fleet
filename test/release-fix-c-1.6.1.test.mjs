// 1.6.1 release fix round C: the three release reviews' accepted findings.
// C1 — a paired unit's feed and record name the model its adapter pins (the
// catalog head when nothing names one), so feed, record and argv agree; a unit
// without the opt-in still says `null` for the vendor's default. The text items
// (T1–T9) are pinned below the code. Every run uses a throwaway fleet home and
// a fake vendor binary; nothing real is spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnitRuntime } from '../core/unit.mjs';
import codexUnit from '../units/codex/adapter.mjs';
import grokUnit from '../units/grok/adapter.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
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

test('C1: STATUS-FEED qualifies its null model for a paired unit', () => {
  const row = read('docs/STATUS-FEED.md').split('\n').find((l) => l.startsWith('| `active[].model` / `.effort` |'));
  assert.ok(row, 'the row');
  assert.ok(row.includes('`pairedEffort`') && row.includes('catalog head'), row);
});

// ── text ─────────────────────────────────────────────────────────────────────

test('T1: SECURITY\'s guard table — the first row passes nothing; the --abort/--quit/--help exception is rebase\'s alone', () => {
  const lines = read('docs/SECURITY.md').split('\n');
  const first = lines.find((l) => /^\| `commit`, `merge`/.test(l));
  assert.ok(first, 'the first row');
  const cells = first.split(' | ');
  assert.equal(cells[cells.length - 1].replace(/ \|$/, ''), '—', first);
  const rebase = lines.find((l) => /^\| `rebase`/.test(l));
  assert.ok(rebase && rebase.includes('--abort'), 'rebase keeps its exception');
});

test('T2: STATUS-FEED — codex turn.failed after text is an error with no partial, and the intro sentence says so', () => {
  const md = read('docs/STATUS-FEED.md');
  const row = md.split('\n').find((l) => l.startsWith('| Codex `turn.failed`'));
  assert.ok(row && /codex/i.test(row) && row.includes('`"error"`') && row.includes('`codex turn failed: <cause>`'), row);
  assert.equal(row.split(' | ')[3], '—', 'no partial');
  assert.ok(md.includes('A run that had already produced text is **not** an error — except a codex turn the CLI itself declared failed'), 'the intro is qualified');
});

test('T3: ADAPTERS and ARCHITECTURE state the pairing with its condition', () => {
  assert.match(read('docs/ADAPTERS.md'), /pairing[^.]*unless the operator configured an effort/);
  assert.match(read('docs/ARCHITECTURE.md'), /pairing[^\n]*unless the operator configured an effort/);
});

test('T4: ORCHESTRATION — under `session`, the session pushes and tags after the operator\'s explicit approval', () => {
  const row = read('docs/ORCHESTRATION.md').split('\n').find((l) => l.startsWith('| `session` (the default) |'));
  assert.ok(row.endsWith('| The session, after the operator\'s explicit approval |'), row);
});

test('T5: README maps both SECURITY sections for network and disk', () => {
  const lines = read('README.md').split('\n');
  assert.ok(lines.includes('| What the fleet sends over the network | [SECURITY, Network](docs/SECURITY.md#network) |'));
  assert.ok(lines.includes('| What the fleet writes to disk | [SECURITY, What the fleet writes down locally](docs/SECURITY.md#what-the-fleet-writes-down-locally) |'));
});

test('T6, T7, T8: ORCHESTRATION states the alias lag as measured, dates the advisor, and says "within ten seconds"', () => {
  const md = read('docs/ORCHESTRATION.md');
  assert.ok(!md.includes('The aliases lag one'), 'no rule');
  assert.ok(md.includes('**The advisor, measured and not adopted.** Measured on Claude Code 2.1.285, 2026-09-30:'));
  for (const rel of ['docs/ORCHESTRATION.md', 'docs/MEASUREMENTS.md']) {
    const text = read(rel);
    assert.ok(!text.includes('4 s after'), `${rel}: 4 s`);
    assert.ok(text.includes('within ten seconds of its report, wrote 58 878 in all'), rel);
  }
});

test('T9: CONFIG\'s doctor codex row says doctor reads the env of its own shell, not the registration\'s', () => {
  const md = read('docs/CONFIG.md');
  assert.ok(md.includes('`doctor` reads `CODEX_DEFAULT_MODEL` — and every other environment key — from its own shell, not from the MCP registration\'s `env` block'));
});

test('C2: the --since docs name the offset form and MEASUREMENTS shows the git log recipe', () => {
  assert.ok(read('docs/CONFIG.md').includes('`2026-09-25T18:47:00+03:00`'));
  const meas = read('docs/MEASUREMENTS.md');
  assert.ok(meas.includes('`omelette-fleet results --stats --since "$(git log -1 --format=%cI <first commit>)"`'));
  assert.ok(!meas.includes('with milliseconds: 2026-09-25T18:47:00.000Z'));
});
