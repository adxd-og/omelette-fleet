/**
 * omelette-fleet :: test/tester-1.6.0-t1.test.mjs
 * Clean-context tester coverage for 1.6.0 R1 ("one rule for `partial`") that
 * test/partial-1.6.0.test.mjs (the coder's own invariant test) does not
 * exercise: the FULL runtime path (spawn → adapter → status feed → spool →
 * `results --stats`), the image-tool standing exception end to end, the
 * clean-run absence of the key, and an independent byte-for-byte check of
 * every marker string against the pre-1.6.0 adapters (git 9b2f9f9).
 *
 * Fake vendor binaries are `node <script>` the way test/codex.test.mjs and
 * test/gemini.test.mjs build them: OMELETTE_HOME is a fresh temp dir per
 * test, and the `spawn` a tool gets is patched to prepend the fake's path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnitRuntime } from '../core/unit.mjs';
import { partialMark, PARTIAL_MARK_RE } from '../core/partial.mjs';
import geminiUnit from '../units/gemini/adapter.mjs';
import grokUnit from '../units/grok/adapter.mjs';
import codexUnit from '../units/codex/adapter.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');

/** A runtime whose spawn is patched to run `node <fake>` instead of the real vendor CLI. */
function wrapUnit(unit, env, fake) {
  return createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
}

const lastLogLine = (dir, event, tool) =>
  readFileSync(join(dir, 'fleet-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((l) => l.event === event && l.tool === tool).at(-1);

const spoolBody = (dir, unit) => {
  const spoolDir = join(dir, 'results', unit);
  const file = readdirSync(spoolDir).find((f) => f.endsWith('.md'));
  return readFileSync(join(spoolDir, file), 'utf8');
};

// --- per-unit fixtures: a valid answer, then a non-zero exit -----------------

const UNITS = [
  {
    name: 'gemini', unit: geminiUnit, binEnv: 'AGY_BIN', tool: 'gemini_research', statusFile: 'status-gemini.json',
    fake: () => [
      'process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "a clean gemini answer" }));',
      'process.exit(1);',
    ].join('\n'),
    markerRe: /\[gemini: CLI exited 1 — treat the answer as partial\]/,
  },
  {
    name: 'grok', unit: grokUnit, binEnv: 'GROK_BIN', tool: 'grok_research', statusFile: 'status-grok.json',
    fake: () => [
      'const lines = [',
      '  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a clean grok answer" }] } }),',
      '  JSON.stringify({ type: "result", result: "a clean grok answer", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } }),',
      '].join("\\n");',
      'process.stdout.write(lines);',
      'process.exit(1);',
    ].join('\n'),
    markerRe: /\[grok: CLI exited 1 — treat the answer as partial\]/,
  },
  {
    name: 'codex', unit: codexUnit, binEnv: 'CODEX_BIN', tool: 'codex_research', statusFile: 'status-codex.json',
    fake: () => [
      'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{',
      '  const line=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");',
      '  line({type:"item.completed",item:{type:"agent_message",text:"a clean codex answer"}});',
      '  line({type:"turn.completed",usage:{input_tokens:5,output_tokens:2}});',
      '  process.exit(1);',
      '});',
    ].join('\n'),
    markerRe: /\[codex: CLI exited 1 — treat the answer as partial\]/,
  },
];

for (const u of UNITS) {
  test(`${u.name}: a valid answer on a non-zero exit is marked in the text, flagged in the snapshot, the log line and the spool header`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `omelette-t1-${u.name}-`));
    const fake = join(dir, `fake-${u.name}.mjs`);
    writeFileSync(fake, u.fake());
    writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { [u.name]: { timeoutS: 30 } } }));
    const env = { ...process.env, OMELETTE_HOME: dir, [u.binEnv]: process.execPath };
    const rt = wrapUnit(u.unit, env, fake);
    const r = await rt.callTool(u.tool, { prompt: 'q' });

    // The client-visible text carries the marker — this IS what the caller
    // reads, whatever the raw MCP response's structured shape does or does
    // not carry (see the tester's DIFF note on `r.partial`).
    assert.equal(r.isError, undefined, r.text);
    assert.match(r.text, u.markerRe, r.text);

    const snap = JSON.parse(readFileSync(join(dir, u.statusFile), 'utf8'));
    assert.equal(snap.lastEvent.status, 'ok');       // there IS an answer
    assert.equal(snap.lastEvent.partial, true);

    const endLine = lastLogLine(dir, 'end', u.tool);
    assert.ok(endLine, 'expected an `end` line for this tool in fleet-log.ndjson');
    assert.equal(endLine.partial, true);

    const body = spoolBody(dir, u.name);
    assert.match(body, /\npartial: true\n/, body.slice(0, 400));
  });
}

// --- results --stats counts a non-zero-exit run as partial -------------------

test('results --stats counts a marked non-zero-exit run in the partial column', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t1-stats-'));
  const fake = join(dir, 'fake-agy-stats.mjs');
  writeFileSync(fake, [
    'process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "a clean gemini answer" }));',
    'process.exit(1);',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const rt = wrapUnit(geminiUnit, env, fake);
  const r = await rt.callTool('gemini_research', { prompt: 'q' });
  assert.equal(r.isError, undefined, r.text);

  const cli = spawnSync(process.execPath, [BIN, 'results', '--stats'], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  assert.equal(cli.status, 0, cli.stderr);
  // unit  calls  ok/error/cancelled  partial  wall  spool  tokens in/out
  assert.match(cli.stdout, /^gemini +1 +1\/0\/0 +1 /m, cli.stdout);
});

// --- the image standing exception: bare path + flag, never a marker in text --

test('gemini_image: an artifact from a run that exited non-zero is flagged partial, with NO marker in the returned text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t1-gemini-img-exit-'));
  const fake = join(dir, 'fake-agy-img-exit.mjs');
  // agy saves the file in its own cwd, names it in a SUCCESSFUL envelope, and
  // the CLI then exits 1: no bound of ours (cap, kill, cancel) was reached, so
  // only the exit code says the run did not finish.
  writeFileSync(fake, [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'writeFileSync(join(process.cwd(), "img.png"), "PNG");',
    'process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "Saved it to " + join(process.cwd(), "img.png") }));',
    'process.exit(1);',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const rt = wrapUnit(geminiUnit, env, fake);
  const r = await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /omelette-gemini-image-\S+[/\\]img\.png$/, r.text);   // the bare path
  assert.ok(!PARTIAL_MARK_RE.test(r.text), `expected NO marker in the image tool's text, got: ${r.text}`);
  const snap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snap.lastEvent.partial, true);
});

// --- a clean run carries NO `partial` key anywhere, never `false` -----------

for (const u of UNITS) {
  test(`${u.name}: a clean run (exit 0) carries NO \`partial\` key in the snapshot or the log line`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `omelette-t1-clean-${u.name}-`));
    const fake = join(dir, `fake-${u.name}-clean.mjs`);
    const cleanBody = u.name === 'codex'
      ? [
        'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{',
        '  const line=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");',
        '  line({type:"item.completed",item:{type:"agent_message",text:"a clean codex answer"}});',
        '  line({type:"turn.completed",usage:{input_tokens:5,output_tokens:2}});',
        '});',
      ].join('\n')
      : u.name === 'grok'
        ? [
          'const lines = [',
          '  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a clean grok answer" }] } }),',
          '  JSON.stringify({ type: "result", result: "a clean grok answer", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 5 } }),',
          '].join("\\n");',
          'process.stdout.write(lines);',
        ].join('\n')
        : 'process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "a clean gemini answer" }));';
    writeFileSync(fake, cleanBody);
    writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { [u.name]: { timeoutS: 30 } } }));
    const env = { ...process.env, OMELETTE_HOME: dir, [u.binEnv]: process.execPath };
    const rt = wrapUnit(u.unit, env, fake);
    const r = await rt.callTool(u.tool, { prompt: 'q' });
    assert.equal(r.isError, undefined, r.text);
    assert.ok(!PARTIAL_MARK_RE.test(r.text), r.text);

    const snap = JSON.parse(readFileSync(join(dir, u.statusFile), 'utf8'));
    assert.equal(snap.lastEvent.status, 'ok');
    assert.ok(!('partial' in snap.lastEvent), `expected NO partial key on a clean run, got: ${JSON.stringify(snap.lastEvent)}`);

    const endLine = lastLogLine(dir, 'end', u.tool);
    assert.ok(!('partial' in endLine), `expected NO partial key in the log line, got: ${JSON.stringify(endLine)}`);
  });
}

// --- marker strings: byte-identical to the pre-1.6.0 adapters ---------------

// Fetched at test time from the commit BEFORE this feature (9b2f9f9), so the
// comparison is against git history, not a hand transcription that could
// carry the same slip the new code does.
const oldGemini = execFileSync('git', ['show', '9b2f9f9:units/gemini/adapter.mjs'], { cwd: ROOT, encoding: 'utf8' });
const oldGrok = execFileSync('git', ['show', '9b2f9f9:units/grok/adapter.mjs'], { cwd: ROOT, encoding: 'utf8' });
const oldCodex = execFileSync('git', ['show', '9b2f9f9:units/codex/adapter.mjs'], { cwd: ROOT, encoding: 'utf8' });

/** Every fixed (non-interpolated) piece of the old template must survive verbatim. */
const assertAnchors = (src, anchors, where) => {
  for (const a of anchors) assert.ok(src.includes(a), `${where}: expected the pre-1.6.0 source to contain ${JSON.stringify(a)}`);
};

test('partialMark: capped is byte-identical to every pre-1.6.0 adapter (fixed text either side of the number)', () => {
  const anchors = ['output capped at ', ' chars — the beginning of the stream was dropped; treat the answer as partial'];
  assertAnchors(oldGemini, anchors, 'gemini 9b2f9f9');
  assertAnchors(oldGrok, anchors, 'grok 9b2f9f9');
  assertAnchors(oldCodex, anchors, 'codex 9b2f9f9');
  for (const unit of ['gemini', 'grok', 'codex']) {
    const m = partialMark(unit, 'capped', { outputCap: 12345 });
    assert.equal(m, `[${unit}: output capped at 12345 chars — the beginning of the stream was dropped; treat the answer as partial]`);
  }
});

test('partialMark: killed is byte-identical to every pre-1.6.0 adapter', () => {
  for (const unit of ['gemini', 'grok', 'codex']) {
    const src = { gemini: oldGemini, grok: oldGrok, codex: oldCodex }[unit];
    assertAnchors(src, ['hard-killed after ', 's — treat the answer as partial; raise ', `${unit}.timeoutS in the fleet config`], `${unit} 9b2f9f9`);
    const m = partialMark(unit, 'killed', { after: 600 });
    assert.equal(m, `[${unit}: hard-killed after 600s — treat the answer as partial; raise ${unit}.timeoutS in the fleet config]`);
  }
});

test('partialMark: cancelled (default tail) is byte-identical to every pre-1.6.0 adapter', () => {
  for (const unit of ['gemini', 'grok', 'codex']) {
    const src = { gemini: oldGemini, grok: oldGrok, codex: oldCodex }[unit];
    assertAnchors(src, ['cancelled by the client'], `${unit} 9b2f9f9`);
    assert.equal(partialMark(unit, 'cancelled'), `[${unit}: cancelled by the client — treat the answer as partial]`);
  }
  // grok's own cancelTail variant (the standing exception to the default tail).
  assert.ok(oldGrok.includes('cancelled by the client${cancelTail'), 'grok 9b2f9f9: expected the cancelTail template');
  assert.equal(
    partialMark('grok', 'cancelled', { tail: ' — Grok had reported: boom' }),
    '[grok: cancelled by the client — Grok had reported: boom]',
  );
});

test('partialMark: exited is byte-identical to every pre-1.6.0 adapter', () => {
  for (const unit of ['gemini', 'grok', 'codex']) {
    const src = { gemini: oldGemini, grok: oldGrok, codex: oldCodex }[unit];
    assertAnchors(src, ['CLI exited ', ' — treat the answer as partial'], `${unit} 9b2f9f9`);
    assert.equal(partialMark(unit, 'exited', { code: 7 }), `[${unit}: CLI exited 7 — treat the answer as partial]`);
  }
});

test('partialMark: grok\'s early stop, gemini\'s status, codex\'s unfinished and gemini\'s stages line are byte-identical', () => {
  assertAnchors(oldGrok, ['run ended early — stopReason='], 'grok 9b2f9f9');
  assert.equal(partialMark('grok', 'early', { stopReason: 'max_tokens' }), '[grok: run ended early — stopReason=max_tokens]');

  assertAnchors(oldGemini, ['run ended early — status='], 'gemini 9b2f9f9');
  assert.equal(partialMark('gemini', 'status', { status: 'TIMEOUT' }), '[gemini: run ended early — status=TIMEOUT]');

  assertAnchors(oldCodex, ['run ended before turn.completed — treat as partial'], 'codex 9b2f9f9');
  assert.equal(partialMark('codex', 'unfinished'), '[codex: run ended before turn.completed — treat as partial]');

  assertAnchors(oldGemini, [' of ', ' stages returned partial answers'], 'gemini 9b2f9f9');
  assert.equal(partialMark('gemini', 'stages', { n: 2, m: 5 }), '[gemini: 2 of 5 stages returned partial answers]');
});

