/**
 * omelette-fleet :: test/grok-profiles.test.mjs
 * 1.4.0 P1: no Grok argv ever holds a local-read tool and a web tool at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, RESEARCH_TOOLS, REVIEW_TOOLS, IMAGE_GEN_TOOLS, IMAGE_EDIT_TOOLS } from '../units/grok/adapter.mjs';

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
