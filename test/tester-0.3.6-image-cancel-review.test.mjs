/**
 * 0.3.6 review: the image bare-path contract (S5) is promised for a run that
 * was "capped, killed OR cancelled" — but the 0.3.6 diff's own tests exercise
 * only capped and killed for every image tool. A CLIENT cancel is a distinct
 * code path (core/unit.mjs computes the status-feed outcome as `cancelled`
 * only when `call.signal.aborted && cancelMode === 'kill'`, which a hard-kill
 * from `timeoutS` never sets), and it is also the exact bug S5 fixes: before
 * 0.3.6, a cancelled image run's marker rode along INSIDE the returned text,
 * so a caller stat-ing the "path" would have stat-ed a marker too.
 *
 * These tests drive a real client cancellation (AbortController + `cancel:
 * kill`) through the real adapters and runtime — not a directly-injected
 * `{killed, cancelled}` result — so the whole chain (signal -> SIGKILL ->
 * interpreter -> artifact lookup -> bare-path contract -> status feed) is
 * exercised exactly as an MCP client cancelling a call would trigger it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUnitRuntime } from '../core/unit.mjs';
import grokUnit from '../units/grok/adapter.mjs';
import geminiUnit from '../units/gemini/adapter.mjs';
import codexUnit from '../units/codex/adapter.mjs';

/** Wrap a unit so its tools spawn `node <fake>` instead of the real CLI. */
function wrap(unit, env, fake) {
  return createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
}

function abortSoon(ms = 400) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  if (t.unref) t.unref();
  return c;
}

test('grok_image: a run the client cancels, with the file already on disk, answers with the bare path — no marker, feed says cancelled+partial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grok-img-cancel-'));
  const saved = join(dir, 'generated.jpg');
  writeFileSync(saved, 'JPEG');
  const fake = join(dir, 'fake-grok-img-cancel.mjs');
  // Prints the path, then hangs: the client's cancel is what ends it.
  writeFileSync(fake, [
    `process.stdout.write("Saved to " + ${JSON.stringify(saved)});`,
    'setTimeout(() => {}, 30000);',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { grok: { cancel: 'kill', timeoutS: 60 } } }));
  const rt = wrap(grokUnit, { ...process.env, OMELETTE_HOME: dir, GROK_BIN: process.execPath }, fake);
  const c = abortSoon();
  const r = await rt.callTool('grok_image', { prompt: 'a cat' }, { id: 1, signal: c.signal });
  assert.equal(r.isError, undefined, r.text);
  // THE CONTRACT: bare path, nothing else — the interpreter's cancel marker
  // never reaches the caller.
  assert.equal(r.text, saved);
  // The client aborted the call, so the status feed reports the outcome the
  // way core/unit.mjs classifies it — `cancelled`, not `ok` — with `partial`
  // still carried from the tool's own result.
  const snap = JSON.parse(readFileSync(join(dir, 'status-grok.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'cancelled');
  assert.equal(snap.lastEvent.partial, true);
});

test('grok_image: a run the client cancels with NO file on disk is an error naming the cancellation, not a bound to raise', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grok-img-cancel-nofile-'));
  const fake = join(dir, 'fake-grok-img-cancel-nofile.mjs');
  // Text with no path in it at all: the answer is salvaged (not thrown by
  // the interpreter itself, which only throws on cancel with NO text), so
  // imageAnswer's own artifactMiss clause is what names the cancel.
  writeFileSync(fake, [
    'process.stdout.write("still thinking about it...");',
    'setTimeout(() => {}, 30000);',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { grok: { cancel: 'kill', timeoutS: 60 } } }));
  const rt = wrap(grokUnit, { ...process.env, OMELETTE_HOME: dir, GROK_BIN: process.execPath }, fake);
  const c = abortSoon();
  const r = await rt.callTool('grok_image', { prompt: 'a cat' }, { id: 1, signal: c.signal });
  assert.equal(r.isError, true);
  assert.match(r.text, /the run was cancelled by the client before it saved one/);
  assert.doesNotMatch(r.text, /outputCap|timeoutS/);
});

test('gemini_image: a run the client cancels, with the file already on disk, answers with the bare path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-img-cancel-'));
  const fake = join(dir, 'fake-agy-img-cancel.mjs');
  writeFileSync(fake, [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const saved = join(process.cwd(), "img.png");',
    'writeFileSync(saved, "PNG");',
    'process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "Saved it to " + saved }));',
    'setTimeout(() => {}, 30000);',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { cancel: 'kill', timeoutS: 60 } } }));
  const rt = wrap(geminiUnit, { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath }, fake);
  const c = abortSoon();
  const r = await rt.callTool('gemini_image', { prompt: 'a cat' }, { id: 1, signal: c.signal });
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /img\.png$/);
  assert.doesNotMatch(r.text, /cancelled/);
  const snap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'cancelled');
  assert.equal(snap.lastEvent.partial, true);
});

test('codex_image: a run the client cancels, with image.png already saved, answers with the bare path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-codex-img-cancel-'));
  const argvLog = join(dir, 'argv.json');
  const fake = join(dir, 'fake-codex-img-cancel.mjs');
  writeFileSync(fake, [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{',
    '  const args=process.argv.slice(2);',
    `  writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args));`,
    '  const cwd=args[args.indexOf("-C")+1];',
    '  writeFileSync(join(cwd, "image.png"), "PNG");',
    '  const line=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");',
    '  line({type:"item.completed",item:{type:"agent_message",text:"Saved it to "+join(cwd,"image.png")}});',
    '  setTimeout(() => {}, 30000);',
    '});',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { codex: { cancel: 'kill', timeoutS: 60 } } }));
  const rt = wrap(codexUnit, { ...process.env, OMELETTE_HOME: dir, CODEX_BIN: process.execPath }, fake);
  const c = abortSoon(500);
  const r = await rt.callTool('codex_image', { prompt: 'a red circle' }, { id: 1, signal: c.signal });
  assert.equal(r.isError, undefined, r.text);
  const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
  assert.equal(r.text, join(argv[argv.indexOf('-C') + 1], 'image.png'));
  assert.doesNotMatch(r.text, /cancelled/);
  const snap = JSON.parse(readFileSync(join(dir, 'status-codex.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'cancelled');
  assert.equal(snap.lastEvent.partial, true);
});
