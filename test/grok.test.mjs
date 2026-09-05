import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit, {
  buildArgs, interpretGrok, catalog,
  READONLY_TOOLS, READONLY_TOOLS_NOWEB, IMAGE_GEN_TOOLS,
} from '../units/grok/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

const ok = (over = {}) => ({ stdout: '', stderr: '', code: 0, killed: false, ...over });

test('buildArgs: research runs carry every layer L1-L5 plus the web allow rules and json output', () => {
  const a = buildArgs({ prompt: 'p', model: 'grok-4.6', effort: 'high', cwd: '/tmp', tools: READONLY_TOOLS, maxTurns: 30 });
  assert.deepEqual(a.slice(0, 4), ['-p', 'p', '--output-format', 'json']);
  assert.ok(a.includes('--tools') && a[a.indexOf('--tools') + 1] === READONLY_TOOLS);
  assert.equal(a[a.indexOf('--disallowed-tools') + 1], 'search_tool,use_tool,Agent');
  assert.ok(a.includes('--no-subagents'));
  assert.equal(a[a.indexOf('--max-turns') + 1], '30');
  assert.equal(a.filter((x) => x === '--deny').length, 3);
  assert.equal(a.filter((x) => x === '--allow').length, 2);
  assert.equal(a[a.indexOf('--model') + 1], 'grok-4.6');
  assert.equal(a[a.indexOf('--reasoning-effort') + 1], 'high');
  assert.equal(a[a.indexOf('--cwd') + 1], '/tmp');
});

test('buildArgs: no-web research drops the allow rules; image runs are plain mode with an image-only toolset', () => {
  const noweb = buildArgs({ prompt: 'p', tools: READONLY_TOOLS_NOWEB, maxTurns: 30 });
  assert.ok(noweb.includes('json'));
  assert.equal(noweb.filter((x) => x === '--allow').length, 0);
  const img = buildArgs({ prompt: 'p', tools: IMAGE_GEN_TOOLS, maxTurns: 8 });
  assert.equal(img[img.indexOf('--output-format') + 1], 'plain');
  assert.equal(img[img.indexOf('--tools') + 1], 'image_gen');
  assert.equal(img.filter((x) => x === '--allow').length, 0);
  assert.ok(!img.includes('--always-approve'));
});

test('interpretGrok: json mode — end_turn in any spelling is clean, early stop is annotated, cancelled without text explains', () => {
  const j = (o) => JSON.stringify(o);
  assert.equal(interpretGrok(ok({ stdout: j({ text: 'hi', stopReason: 'EndTurn' }) }), { jsonMode: true, timeoutS: 300 }), 'hi');
  assert.equal(interpretGrok(ok({ stdout: j({ text: 'hi', stopReason: 'end_turn' }) }), { jsonMode: true, timeoutS: 300 }), 'hi');
  assert.match(interpretGrok(ok({ stdout: j({ text: 'partial', stopReason: 'cancelled' }) }), { jsonMode: true, timeoutS: 300 }), /run ended early — stopReason=cancelled/);
  assert.throws(() => interpretGrok(ok({ stdout: j({ text: '', stopReason: 'Cancelled' }) }), { jsonMode: true, timeoutS: 300 }), /needed interactive approval/);
  assert.throws(() => interpretGrok(ok({ stdout: j({ type: 'error', message: 'unknown model' }) }), { jsonMode: true, timeoutS: 300 }), /grok CLI error: unknown model/);
});

test('interpretGrok: plain mode returns raw text; unparseable json fails open; kills and empty exits are loud', () => {
  assert.equal(interpretGrok(ok({ stdout: ' /a/b.jpg \n' }), { jsonMode: false, timeoutS: 300 }), '/a/b.jpg');
  assert.equal(interpretGrok(ok({ stdout: '{not json' }), { jsonMode: true, timeoutS: 300 }), '{not json');
  assert.throws(() => interpretGrok(ok({ killed: true }), { jsonMode: true, timeoutS: 900 }), /hard-killed after 900s/); // nothing captured
  assert.throws(() => interpretGrok(ok({ code: 1, stderr: 'bad' }), { jsonMode: true, timeoutS: 300 }), /grok exited 1: bad/);
});

test('interpretGrok: a non-zero exit WITH text keeps the text under a partial marker, in both modes', () => {
  const j = (o) => JSON.stringify(o);
  const plain = interpretGrok(ok({ stdout: 'half an answer', code: 1, stderr: 'wobble' }), { jsonMode: false, timeoutS: 300 });
  assert.match(plain, /^half an answer/);
  assert.match(plain, /\[grok: CLI exited 1 — treat the answer as partial\]/);
  const json = interpretGrok(ok({ stdout: j({ text: 'hi', stopReason: 'end_turn' }), code: 2 }), { jsonMode: true, timeoutS: 300 });
  assert.match(json, /^hi/);
  assert.match(json, /CLI exited 2/);
  // An early stop AND a non-zero exit: both markers, answer still returned.
  const both = interpretGrok(ok({ stdout: j({ text: 'partial', stopReason: 'cancelled' }), code: 1 }), { jsonMode: true, timeoutS: 300 });
  assert.match(both, /run ended early — stopReason=cancelled/);
  assert.match(both, /CLI exited 1/);
  // Unparseable json on a failed exit still fails open — with the marker.
  assert.match(interpretGrok(ok({ stdout: '{not json', code: 1 }), { jsonMode: true, timeoutS: 300 }), /CLI exited 1/);
});

test('interpretGrok: a hard kill with captured output returns the answer under a partial marker', () => {
  const j = (o) => JSON.stringify(o);
  // A 15-minute review killed by timeoutS used to throw away everything the CLI
  // had already printed. The salvage reads the SAME payload the clean path does.
  const fromJson = interpretGrok(ok({ stdout: j({ text: 'half a review', stopReason: 'end_turn' }), code: null, killed: true }), { jsonMode: true, timeoutS: 900 });
  assert.equal(fromJson.partial, true);
  assert.match(fromJson.text, /^half a review/);
  assert.match(fromJson.text, /\[grok: hard-killed after 900s — treat the answer as partial; raise grok\.timeoutS in the fleet config\]/);
  const fromPlain = interpretGrok(ok({ stdout: ' half an answer \n', code: null, killed: true }), { jsonMode: false, timeoutS: 900 });
  assert.equal(fromPlain.partial, true);
  assert.match(fromPlain.text, /^half an answer/);
  // Truncated JSON is salvaged raw, exactly as the clean path fails open.
  assert.match(interpretGrok(ok({ stdout: '{not json', code: null, killed: true }), { jsonMode: true, timeoutS: 900 }).text, /^\{not json/);
  // Nothing captured at all: the kill is still an error, not an empty success.
  assert.throws(() => interpretGrok(ok({ stdout: '   ', code: null, killed: true }), { jsonMode: false, timeoutS: 900 }), /hard-killed after 900s/);
  assert.throws(() => interpretGrok(ok({ stdout: j({ text: '', stopReason: 'cancelled' }), code: null, killed: true }), { jsonMode: true, timeoutS: 900 }), /hard-killed after 900s/);
});

test('unit contract: five tools, efforts from the catalog, workspace-write declared unsupported', () => {
  assert.deepEqual(unit.tools.map((t) => t.name), ['grok_research', 'grok_code_review', 'grok_image', 'grok_image_edit', 'grok_models']);
  assert.deepEqual(unit.supportedModes, { 'read-only': true, 'workspace-write': null });
  assert.ok(catalog.effortEnum().includes('high'));
  assert.deepEqual(unit.billingRiskEnv, ['XAI_API_KEY']);
  assert.equal(unit.extraSchema.imageMaxTurns.default, 8);
});

test('runtime with a fake grok: env GROK_WEB_FETCH set, research stays read-only even with the ceiling open, image edit validates its source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grok-'));
  const fake = join(dir, 'fake-grok.mjs');
  writeFileSync(fake, 'process.stdout.write(JSON.stringify({text:"ARGS "+process.argv.slice(2).join(" ")+" WEBFETCH="+process.env.GROK_WEB_FETCH, stopReason:"end_turn"}))');
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { grok: { mode: 'workspace-write', webSearch: false, maxTurns: 12 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, OMELETTE_ALLOW_WRITE: 'grok', GROK_BIN: process.execPath };
  const rt = createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
  assert.equal(rt.cfgFor().values.mode, 'read-only'); // refused: unsupported by the unit
  const r = await rt.callTool('grok_research', { prompt: 'q' });
  assert.match(r.text, /--tools read_file,grep,list_dir --/); // webSearch:false → no web tools
  assert.doesNotMatch(r.text, /--allow/);
  assert.match(r.text, /--max-turns 12/);
  assert.match(r.text, /WEBFETCH=1/);
  const bad = await rt.callTool('grok_image_edit', { prompt: 'x', imagePath: 'nope.jpg' });
  assert.match(bad.text, /must be an absolute path/);
  assert.equal(bad.isError, true); // a refusal must never be reported to MCP as a success
  const gone = await rt.callTool('grok_image_edit', { prompt: 'x', imagePath: join(dir, 'missing.jpg') });
  assert.match(gone.text, /not an existing file/);
  assert.equal(gone.isError, true);
  const noPrompt = await rt.callTool('grok_research', { prompt: '' });
  assert.equal(noPrompt.isError, true);
});
