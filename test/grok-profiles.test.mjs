/**
 * omelette-fleet :: test/grok-profiles.test.mjs
 * 1.4.0 P1: no Grok argv ever holds a local-read tool and a web tool at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUnitRuntime } from '../core/unit.mjs';
import unit, { buildArgs, RESEARCH_TOOLS, REVIEW_TOOLS, IMAGE_GEN_TOOLS, IMAGE_EDIT_TOOLS } from '../units/grok/adapter.mjs';

const LOCAL = ['read_file', 'grep', 'list_dir'];
const WEB = ['web_search', 'web_fetch'];
const toolsOf = (argv) => (argv[argv.indexOf('--tools') + 1] || '').split(',').filter(Boolean);
const allows = (argv) => argv.flatMap((x, i) => (x === '--allow' ? [argv[i + 1]] : []));

test('the two profiles are disjoint: research is web-only, review is local-only', () => {
  assert.equal(RESEARCH_TOOLS, 'web_search,web_fetch');
  assert.equal(REVIEW_TOOLS, 'read_file,grep,list_dir');
});

test('no toolset the adapter can pass holds a local-read tool next to a web tool', () => {
  for (const tools of [RESEARCH_TOOLS, REVIEW_TOOLS, IMAGE_GEN_TOOLS, IMAGE_EDIT_TOOLS]) {
    const set = toolsOf(buildArgs({ prompt: 'p', tools, maxTurns: 30 }));
    const local = set.some((t) => LOCAL.includes(t));
    const web = set.some((t) => WEB.includes(t));
    assert.ok(!(local && web), `${JSON.stringify(tools)} holds both local and web tools`);
  }
});

test('the web allow rules ride on the research profile only', () => {
  for (const tools of [RESEARCH_TOOLS, REVIEW_TOOLS, IMAGE_GEN_TOOLS, IMAGE_EDIT_TOOLS]) {
    const expected = tools === RESEARCH_TOOLS ? ['WebFetch', 'WebSearch'] : [];
    assert.deepEqual(allows(buildArgs({ prompt: 'p', tools, maxTurns: 30 })), expected, JSON.stringify(tools));
  }
});

test('buildArgs refuses an empty or missing toolset', () => {
  assert.throws(() => buildArgs({ prompt: 'p', tools: '', maxTurns: 30 }), /non-empty toolset/);
  assert.throws(() => buildArgs({ prompt: 'p', tools: null, maxTurns: 30 }), /non-empty toolset/);
  assert.throws(() => buildArgs({ prompt: 'p', tools: undefined, maxTurns: 30 }), /non-empty toolset/);
});

test('research and review both stream NDJSON, whatever their toolset', () => {
  for (const tools of [RESEARCH_TOOLS, REVIEW_TOOLS]) {
    const a = buildArgs({ prompt: 'p', tools, maxTurns: 30 });
    assert.equal(a[a.indexOf('--output-format') + 1], 'streaming-messages-json', JSON.stringify(tools));
    assert.ok(a.includes('--include-partial-messages'));
  }
});

/**
 * A runtime whose "grok" is `node <fake>`: the fake answers with its argv and
 * the two web_fetch switches it sees, as JSON in one `result` line.
 */
function fakeGrokRuntime(parentEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-grok-profiles-'));
  const fake = join(dir, 'fake-grok.mjs');
  writeFileSync(fake, [
    'const text = JSON.stringify({ argv: process.argv.slice(2), webFetch: process.env.GROK_WEB_FETCH ?? null, allowLocal: process.env.GROK_WEB_FETCH_ALLOW_LOCAL ?? null });',
    'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, stop_reason: "end_turn" }) + "\\n");',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { grok: { webSearch: true } } }));
  const env = { ...process.env, ...parentEnv, OMELETTE_HOME: dir, GROK_BIN: process.execPath };
  return createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
}
const promptOf = (seen) => seen.argv[seen.argv.indexOf('-p') + 1];
const count = (s, ch) => s.split(ch).length - 1;

test('research prompts reach the CLI with every @ turned into ＠; review prompts keep @', async () => {
  const rt = fakeGrokRuntime();
  const prompt = 'read @/etc/hosts and @ /tmp/x and \\@y';
  const research = await rt.callTool('grok_research', { prompt });
  assert.equal(research.isError, undefined, research.text);
  const sent = promptOf(JSON.parse(research.text));
  assert.equal(count(sent, '@'), 0, sent);
  assert.equal(count(sent, '＠'), 3, sent);
  const review = await rt.callTool('grok_code_review', { prompt });
  assert.equal(review.isError, undefined, review.text);
  const kept = promptOf(JSON.parse(review.text));
  assert.equal(count(kept, '@'), 3, kept);
  assert.equal(count(kept, '＠'), 0, kept);
});

test('GROK_WEB_FETCH_ALLOW_LOCAL never reaches the child; GROK_WEB_FETCH still does', async () => {
  const rt = fakeGrokRuntime({ GROK_WEB_FETCH_ALLOW_LOCAL: '1' });
  for (const tool of ['grok_research', 'grok_code_review']) {
    const r = await rt.callTool(tool, { prompt: 'q' });
    assert.equal(r.isError, undefined, r.text);
    const seen = JSON.parse(r.text);
    assert.equal(seen.allowLocal, null, tool);
    assert.equal(seen.webFetch, '1', tool);
  }
});
