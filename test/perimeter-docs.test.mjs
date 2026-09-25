import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('SECURITY states the perimeter rule and the two Grok profiles', () => {
  const md = read('docs/SECURITY.md');
  assert.doesNotMatch(md, /no run reads local files and reaches the web at once/);
  assert.match(md, /a Codex review run reads inside a kernel sandbox and has no web/);
  assert.doesNotMatch(md, /the one run that holds local reads and the web at once/);
  assert.match(md, /the runs that hold local reads and the web at once are `codex_research`, by design \(research that depends on running things\), and `gemini_research` under the opt-in agy rule set, by the operator's choice/);
  assert.match(md, /L1 {2}research: --tools web_search,web_fetch/);
  assert.match(md, /^ {4}review: {3}--tools read_file,grep,list_dir/m);
  assert.doesNotMatch(md, /--tools read_file,grep,list_dir,web_search,web_fetch/);
});

test('SECURITY recommends read_url(*) alone and names read_file(*) as the opt-in with its cost', () => {
  const md = read('docs/SECURITY.md');
  const from = md.indexOf('\n## Recommended agy allow-rules');
  const to = md.indexOf('\n## ', from + 1);
  const section = md.slice(from, to === -1 ? undefined : to);
  assert.match(section, /"allow": \["read_url\(\*\)"\]/, 'the web-research rule set');
  assert.match(section, /"allow": \["read_file\(\*\)", "read_url\(\*\)"\]/, 'the opt-in rule set, second');
  assert.ok(section.indexOf('"allow": ["read_url(*)"]') < section.indexOf('"allow": ["read_file(*)", "read_url(*)"]'), 'web research first');
  assert.match(section, /any file the operator's user can read, sent anywhere|any file your user can read, sent anywhere/);
  assert.match(section, /"deny": \[/, 'deny rules for credential files, by exact path');
  assert.match(section, /application_default_credentials\.json/);
});

test('ORCHESTRATION and CONFIG say what grok_research reads and what webSearch does per profile', () => {
  assert.match(read('docs/ORCHESTRATION.md'), /`grok_research`[^\n]*reads no local files/);
  const config = read('docs/CONFIG.md');
  assert.match(config, /\| `webSearch` \|[^\n]*research[^\n]*review[^\n]*\|/);
});

test('SECURITY: the Codex section states the review/research web split', () => {
  const md = read('docs/SECURITY.md');
  assert.match(md, /`codex_code_review` always runs with the `web_search` setting `"disabled"`/);
  assert.doesNotMatch(md, /tools\.web_search/);
});

test('the opt-in agy set does not pretend an exact-path deny covers the result spool', () => {
  const md = read('docs/SECURITY.md');
  assert.doesNotMatch(md, /read_file\(~\/\.omelette\/results\)/);
  assert.match(md, /cannot be named by an exact-path deny, so under the opt-in set past unit answers are readable by an injected page/);
});

test('the Gemini local-file route points at the opt-in agy rule set', async () => {
  const opt = /needs the opt-in agy rule set \(SECURITY, Recommended agy allow-rules\)/;
  assert.match(read('rules/omelette-fleet.md').split('\n').find((l) => l.startsWith('| Reading local images')), opt);
  assert.match(read('docs/ORCHESTRATION.md').split('\n').find((l) => l.startsWith('| Reading local images')), opt);
  assert.match(read('units/gemini/adapter.mjs'), /needs `read_file\(\*\)` in the operator's agy allow-rules — the opt-in set in SECURITY/);
  const pointer = /needs `read_file\(\*\)` in the agy allow-rules, the opt-in set in (SECURITY|\[SECURITY\]\(docs\/SECURITY\.md#recommended-agy-allow-rules\))/;
  assert.match(read('README.md').split('\n').find((l) => l.startsWith('| **gemini** |')), pointer);
  const gemini = (await import('../units/gemini/adapter.mjs')).default;
  assert.match(gemini.instructions, pointer);
  const grok = (await import('../units/grok/adapter.mjs')).default;
  assert.match(grok.tools.find((t) => t.name === 'grok_research').description, /gemini_research for images and PDFs \(with the opt-in agy rule set\)/);
});

test('CONFIG: codex webSearch affects research only', () => {
  const config = read('docs/CONFIG.md');
  assert.match(config, /\| `webSearch` \| boolean \|[^\n]*codex: affects research only; review is always without/);
});

test('SECURITY: --no-memory in the Grok layers, the empty research directory, the reach knobs in the scrub', () => {
  const md = read('docs/SECURITY.md');
  assert.match(md, /^ {4}--no-memory \(research, review\) — cross-session memory off/m);
  assert.match(md, /The three research tools — `grok_research`, `gemini_research` and `codex_research` — start in a fresh empty directory, removed after the run, unless the caller passes `cwd`, which opts the run into whatever the CLI reads from a workspace/);
  assert.match(md, /The list also holds reach knobs the patterns would admit/);
  assert.match(md, /`CODEX_EXEC_SERVER_URL` for codex and `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES` for gemini; `GROK_HOME`, `GROK_MODELS_BASE_URL` and `AGY_ADC_AUTH` pass, as your choices/);
});
