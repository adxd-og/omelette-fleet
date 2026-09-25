import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('SECURITY states the perimeter rule and the two Grok profiles', () => {
  const md = read('docs/SECURITY.md');
  assert.match(md, /no run reads local files and reaches the web at once/);
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
