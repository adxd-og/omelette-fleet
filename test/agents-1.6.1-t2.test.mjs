// 1.6.1 Task 2 (plan docs/superpowers/plans/2026-09-30-1.6.1-catalogs-effort-docs.md,
// "Task 2: the tester's effort, the second pass, exact model ids"): the tester
// runs at `high` and is continued with a directed second pass, the templates
// carry a stop-and-report paragraph, every shipped role pins an exact model id,
// and the docs say what was measured. Every rendering here uses a throwaway
// OMELETTE_HOME, never the operator's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SETTINGS_SCHEMA } from '../core/config.mjs';
import { AGENT_FILES, AGENT_ROLES, agentSettings, renderAgentFile, renderRulesFile } from '../core/rules.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import codexUnit from '../units/codex/adapter.mjs';
import geminiUnit from '../units/gemini/adapter.mjs';

process.env.OMELETTE_HOME = mkdtempSync(join(tmpdir(), 'omelette-t2-'));

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** A throwaway fleet home, optionally with a config file in it. */
function home(config) {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t2-home-'));
  if (config !== undefined) writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(config));
  return dir;
}

/** One section of a Markdown text: its heading line up to the next heading of the same or a higher level. */
function section(md, heading) {
  const from = md.indexOf(`\n${heading}\n`);
  assert.notEqual(from, -1, `${heading} present`);
  const level = heading.match(/^#+/)[0].length;
  const next = new RegExp(`\\n#{1,${level}} `, 'g');
  next.lastIndex = from + 1;
  const m = next.exec(md);
  return md.slice(from, m ? m.index : undefined);
}

/** A rendered definition with the schema defaults (an empty settings object: nothing configured). */
const rendered = (file) => renderAgentFile(file, '1.6.1', {});

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';

// ── the defaults ─────────────────────────────────────────────────────────────

test('the agent defaults: exact model ids for every role, the tester at high with 80 turns', () => {
  const d = (role, key) => AGENT_SETTINGS_SCHEMA[role][key].default;
  assert.equal(d('coder', 'model'), OPUS);
  assert.equal(d('coderMedium', 'model'), OPUS);
  assert.equal(d('reviewer', 'model'), OPUS);
  assert.equal(d('tester', 'model'), SONNET);
  assert.equal(d('tester', 'effort'), 'high');
  assert.equal(d('tester', 'maxTurns'), 80, 'a two-pass high run took 42 turns: the limit stays');
  assert.equal(d('coder', 'effort'), 'xhigh');
  assert.equal(d('coderMedium', 'effort'), 'medium');
  assert.equal(d('reviewer', 'effort'), 'xhigh');
});

// ── the tester template: the second pass and the stop rule ───────────────────

const SECOND_PASS_HEAD = 'Second pass — only when the orchestrator continues you with the words "Second pass", after your first report:';
const SECOND_PASS = [
  "1. **Mutation check.** In a plain copy of the repository outside the tree under test (not a `git worktree`), make about a dozen small breaking changes to the code the diff touches, one at a time, and run your tests and the implementer's against each — as several shorter commands, not one long sweep: a command running past about five minutes lets your cache go cold. Report every mutation no test catches, and add a test to your own file for each miss the spec requires.",
  "2. **Reviewer pass over what the diff writes** — strings, docs, changelog, examples, config. Is each claim consistent with the rest of the diff and with the spec's stated facts? Is any stale, undated, unverified, inferred rather than checked, or contradicted elsewhere? What does an operator upgrading meet that nothing tells them? Which behaviour did neither test file exercise? Each finding in four parts — `location · scenario · consequence · how to confirm` — the location a pointer line as in your first report.",
  '3. **Report only what is new**: `## NEW FINDINGS`, `## MUTATIONS` (each mutation, and which test file caught it or that none did), `## DIFF`, `## TEST RESULTS`.',
];
const STOP_CORE = 'When the work asked for is done and its checks pass, stop and report: no extra rounds of review, no features, files, docs or refactors that were not asked for';
const STOP_TAIL = 'Say at the end of your report what you think is worth doing instead.';
const TESTER_STOP = `${STOP_CORE}, and no second pass until the orchestrator sends one. ${STOP_TAIL}`;
const CODER_STOP = `${STOP_CORE} — the task's scope is the brief, and a fix you noticed along the way is outside it. ${STOP_TAIL}`;

test('the rendered tester: claude-sonnet-5-5 at high, 80 turns, and the second pass in three parts after the Procedure list', () => {
  const text = rendered('omelette-tester.md');
  assert.match(text, /^model: claude-sonnet-5-5$/m);
  assert.match(text, /^effort: high$/m);
  assert.match(text, /^maxTurns: 80$/m);
  const lines = text.split('\n');
  const head = lines.indexOf(SECOND_PASS_HEAD);
  assert.notEqual(head, -1, 'the second-pass section, triggered by its words');
  assert.deepEqual(lines.slice(head + 1, head + 1 + SECOND_PASS.length), SECOND_PASS, 'its three parts, whole and in order');
  const lastStep = lines.findIndex((l) => l.startsWith('4. For every failing test, rule:'));
  assert.ok(lastStep !== -1 && lastStep < head, 'it follows the Procedure list');
  const agentLine = lines.findIndex((l) => l.startsWith('The Agent tool is removed from your toolset'));
  assert.ok(head < agentLine, 'and comes before the rest of the definition');
});

test('the rendered tester carries the stop paragraph, and the second pass is the orchestrator\'s to send', () => {
  const lines = rendered('omelette-tester.md').split('\n');
  const stop = lines.indexOf(TESTER_STOP);
  assert.notEqual(stop, -1, 'the stop paragraph, whole');
  assert.ok(stop > lines.indexOf(SECOND_PASS_HEAD), 'after the second pass, covering both');
});

test('both coders carry the stop paragraph and claude-opus-5-5; the reviewer claude-opus-5-5 at xhigh', () => {
  for (const [file, effort] of [['omelette-coder.md', 'xhigh'], ['omelette-coder-medium.md', 'medium']]) {
    const text = rendered(file);
    assert.match(text, /^model: claude-opus-5-5$/m, file);
    assert.match(text, new RegExp(`^effort: ${effort}$`, 'm'), file);
    assert.ok(text.split('\n').includes(CODER_STOP), `${file}: the stop paragraph, in the coder's words`);
    assert.ok(!text.includes('Second pass'), `${file}: the second pass is the tester's alone`);
  }
  const reviewer = rendered('omelette-reviewer.md');
  assert.match(reviewer, /^model: claude-opus-5-5$/m);
  assert.match(reviewer, /^effort: xhigh$/m);
});

test('a config that sets agents.tester.model=sonnet still renders the alias', () => {
  const dir = home({ version: 1, agents: { tester: { model: 'sonnet' } } });
  const settings = agentSettings({ OMELETTE_HOME: dir });
  assert.equal(settings.tester.model, 'sonnet');
  assert.equal(settings.sources.tester.model, 'file');
  const text = renderAgentFile('omelette-tester.md', '1.6.1', settings);
  assert.match(text, /^model: sonnet$/m);
  assert.match(text, /^effort: high$/m, 'the effort it did not set follows the new default');
});

test('rules --agents in a throwaway project writes the pinned ids and the tester at high', () => {
  const dir = home();
  const r = spawnSync(process.execPath, [BIN, 'rules', '--agents'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } });
  assert.equal(r.status, 0, r.stderr);
  const agent = (name) => readFileSync(join(dir, '.claude', 'agents', name), 'utf8');
  assert.match(agent('omelette-tester.md'), /^model: claude-sonnet-5-5\neffort: high\nmaxTurns: 80$/m);
  for (const name of ['omelette-coder.md', 'omelette-coder-medium.md', 'omelette-reviewer.md']) assert.match(agent(name), /^model: claude-opus-5-5$/m, name);
});

// ── the rules file ───────────────────────────────────────────────────────────

const SECOND_PASS_STEP = '4. **The second pass, at once, in the same tester.** After the first report the orchestrator continues the SAME tester with "Second pass" (`SendMessage` to its agent id) — a mutation check, then a reviewer\'s read of what the diff writes — before arbitration. Send it at once: the one long pause measured (31.5 minutes) restarted on a cold cache, as did tool calls past about five minutes. Only hand-dispatched testers were continued so far; where the first cannot be (a skill-forked one is untried), dispatch a fresh `omelette-tester` with the same words, the spec, the diff and the first tester\'s test file — it pays for a first read again. Skipped, with a ledger line, for a docs-only diff or one the small-change exception covers.';
const DEFINITIONS_1_6_1 = "- `omelette-fleet rules --agents` installs four definitions — **`omelette-coder`** (Opus 5.5, `effort: xhigh`), **`omelette-coder-medium`** (Opus 5.5, `effort: medium`), **`omelette-tester`** (Sonnet 5.5, `effort: high`, `maxTurns: 80` by default (config)) and **`omelette-reviewer`** (Opus 5.5, `effort: xhigh`), each model pinned by exact id (`claude-opus-5-5`, `claude-sonnet-5-5`) — plus the `/omelette-test` skill. Select a definition with `subagent_type: omelette-coder` / `omelette-coder-medium` / `omelette-tester` / `omelette-reviewer`.";

for (const merge of ['session', 'pr']) {
  test(`the rules' tester flow gains the second pass between the real runner and arbitration, six steps in order (${merge})`, () => {
    const text = renderRulesFile('1.6.1', { merge });
    assert.ok(text.length <= 14590, `${merge}: ${text.length} characters, under the ceiling test/rules-size.test.mjs moved for this step`);
    const flow = section(text, '## Tester flow').split('\n');
    const at = flow.indexOf(SECOND_PASS_STEP);
    assert.notEqual(at, -1, 'the step, whole');
    assert.ok(flow[at - 1].startsWith('3. The tester writes tests and **runs them through the real runner**'), 'after the real runner');
    assert.ok(flow[at + 1].startsWith('5. **Arbitration comes first, and it belongs to the orchestrator.**'), 'before arbitration');
    const numbers = flow.filter((l) => /^\d+\. /.test(l)).map((l) => Number(l.split('.')[0]));
    assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6]);
    assert.ok(flow.some((l) => l.startsWith('1. ') && l.includes('(Sonnet-class, high — the shipped `omelette-tester`)')), 'step 1 names the new effort');
  });

  test(`the definitions line names Sonnet 5.5 at high and the exact ids (${merge})`, () => {
    const lines = section(renderRulesFile('1.6.1', { merge }), '## Spawning sub-agents: model and effort').split('\n');
    assert.ok(lines.includes(DEFINITIONS_1_6_1), 'the definitions line, whole');
  });
}

// ── ORCHESTRATION ────────────────────────────────────────────────────────────

test('ORCHESTRATION "Effort by role and model" sits under "Spawning sub-agents", has a map row, and its table agrees with the schema defaults row by row', () => {
  const md = read('docs/ORCHESTRATION.md');
  const effort = section(md, '### Effort by role and model');
  assert.ok(section(md, '## Spawning sub-agents: model and effort').includes(effort), 'a subsection of "Spawning sub-agents"');
  const head = md.slice(0, md.indexOf('\n## '));
  assert.match(head, /^\| .+ \| \[Effort by role and model\]\(#effort-by-role-and-model\) \|$/m, 'the map at the top links it');
  const lines = effort.split('\n');
  assert.ok(lines.includes('| Role | Model id | Effort | Why |'), 'the table header');
  const rows = lines.filter((l) => l.startsWith('| `omelette-')).map((l) => l.split(' | ').map((c) => c.replace(/^\| /, '')));
  assert.deepEqual(rows.map((r) => r[0]), AGENT_FILES.map((f) => `\`${f.replace(/\.md$/, '')}\``), 'one row per shipped role, in the order rules writes them');
  for (const row of rows) {
    const role = AGENT_ROLES[`${row[0].replaceAll('`', '')}.md`];
    assert.equal(row[1], `\`${AGENT_SETTINGS_SCHEMA[role].model.default}\``, `${role}: the model id is the default`);
    assert.equal(row[2].match(/`([^`]+)`/)[1], AGENT_SETTINGS_SCHEMA[role].effort.default, `${role}: the effort is the default`);
    assert.ok(row[3].length > 20, `${role}: a reason`);
  }
  for (const lead of ['**What the measurement showed.**', '**The advisor, measured and not adopted.**', '**What actually ran is in the transcript.**']) {
    assert.ok(lines.some((l) => l.startsWith(lead)), `a paragraph: ${lead}`);
  }
  assert.ok(effort.includes('(MEASUREMENTS.md#the-testers-effort-a-second-pass-and-an-advisor)'), 'the measurement is linked');
  assert.ok(effort.includes('$1.10 of a $2.06 run'), 'the advisor paragraph carries the measured cost');
});

test('ORCHESTRATION\'s tester section sends the second pass by its trigger word before arbitration, and at once, by what the transcripts measured', () => {
  const md = read('docs/ORCHESTRATION.md');
  const tester = section(md, '## Tester sub-agent and arbitration');
  const paras = tester.split('\n');
  const second = paras.findIndex((l) => l.startsWith('**Then a second pass, in the same tester, before arbitration.**'));
  const atOnce = paras.findIndex((l) => l.startsWith('**Send it at once.**'));
  const arbitration = paras.findIndex((l) => l.startsWith('**Arbitration belongs to the orchestrator'));
  assert.ok(second !== -1 && atOnce === second + 2 && atOnce < arbitration, 'the two paragraphs, in order, before arbitration');
  for (const fact of ['"Second pass"', 'docs-only diff', 'small-change exception', '(MEASUREMENTS.md#the-testers-effort-a-second-pass-and-an-advisor)', 'was not tried', 'dispatch a fresh `omelette-tester` with the words "Second pass", the spec, the diff and the first tester\'s test file']) {
    assert.ok(paras[second].includes(fact), `it says: ${fact}`);
  }
  for (const fact of ['31.5 minutes idle', '76 439 cache tokens and read none', 'sent 4 s after its report, wrote 58 878 in all', 'past about five minutes', 'several shorter commands']) {
    assert.ok(paras[atOnce].includes(fact), `it says: ${fact}`);
  }
  for (const p of [paras[second], paras[atOnce]]) assert.ok(p.split(/\s+/).length <= 250, 'not a wall');
  assert.ok(!md.includes('373 k'), 'the two-pass total is not presented as the cost of the pause');
});

test('round 3 (3, 7, 8): the alias lag is stated as measured, exact ids are first-party ids, and the coder row says what the rows say', () => {
  const clause = 'on a provider that names models differently (Bedrock, Vertex, Foundry)';
  const config = section(read('docs/CONFIG.md'), '### Agent settings');
  assert.ok(!config.includes('aliases lag a release'), 'CONFIG states the measurement, not a rule');
  assert.ok(config.includes('on 2026-09-30, on Claude Code 2.1.284, a sub-agent spawned with the `sonnet` alias ran on Sonnet 5 two days after 5.5 shipped, while `opus` resolved to Opus 5.5'));
  const spawning = section(read('docs/ORCHESTRATION.md'), '## Spawning sub-agents: model and effort');
  const md = read('CHANGELOG.md');
  const bullet = md.slice(md.indexOf('## 1.6.1'), md.indexOf('## 1.6.0')).split('\n').find((l) => l.startsWith('- **The tester runs at `high`'));
  for (const [name, text] of [['CONFIG', config], ['ORCHESTRATION', spawning], ['CHANGELOG', bullet]]) {
    assert.ok(text.includes(clause) && /`agents\.<role>\.model` to that provider's id or back to the alias/.test(text) && text.includes('not tested here'), `${name}: the provider clause`);
  }
  assert.ok(spawning.includes('medium left a fail-open class in place; xhigh\'s misses were two narrow writes, fixed in one round'));
  assert.ok(!spawning.includes('xhigh did not'));
  for (const rel of ['CHANGELOG.md', 'docs/CONFIG.md', 'README.md']) assert.ok(!read(rel).includes('an empty value clears the key'), `${rel}: an empty value is an empty string, read as unset`);
  assert.ok(read('docs/CONFIG.md').includes('writes an empty string, which the runtime reads as unset — `show` prints `(unset) file`'));
});

test('ORCHESTRATION names the pinned ids where it named the aliases', () => {
  const spawning = section(read('docs/ORCHESTRATION.md'), '## Spawning sub-agents: model and effort');
  assert.ok(!spawning.includes('The shipped definitions name the aliases'), 'the alias sentence is rewritten');
  assert.ok(spawning.includes('The shipped definitions pin exact model ids'), 'around the pinned ids');
  assert.ok(spawning.includes('- **`omelette-tester`** — `model: claude-sonnet-5-5`, `effort: high`, `maxTurns: 80` by default (config)'), 'the tester item');
  for (const stale of ['`model: sonnet`, `effort: xhigh`', '`model: opus`, `effort: xhigh`', '`model: opus`, `effort: medium`']) {
    assert.ok(!spawning.includes(stale), `gone: ${stale}`);
  }
});

// ── MEASUREMENTS ─────────────────────────────────────────────────────────────

const ROW_SINGLE_PASS = '| `claude-sonnet-5-5` · xhigh | 2.1.284 | 44 | 56 | 30.8 | 2.90 | 10 | yes (16, 14 caught) |';
const ROW_ADVISOR = '| `--advisor opus`, the brief asking for two consultations | `claude-sonnet-5-5` · high, `claude-opus-5-5` advisor | 2.1.285 | 2 | 22 | 19 | 12.8 | 2.06 = Sonnet 0.96 + advisor 1.10 | 4 |';
const ROW_TWO_PASSES = '| high, two passes | `claude-sonnet-5-5` · 2.1.284 | 31 | 39 | 24.8 | 1.46 | 13 |';

test('MEASUREMENTS: the tester section, mapped in the process-cost group, carries the three tables and their limits', () => {
  const md = read('docs/MEASUREMENTS.md');
  const s = section(md, "## The tester's effort, a second pass and an advisor");
  const group = md.slice(md.indexOf('**Process cost**'), md.indexOf('**Review value**'));
  assert.ok(group.includes("| [The tester's effort, a second pass and an advisor](#the-testers-effort-a-second-pass-and-an-advisor) |"), 'a row in the process-cost group');
  const lines = s.split('\n');
  for (const row of [ROW_SINGLE_PASS, ROW_ADVISOR, ROW_TWO_PASSES]) assert.ok(lines.includes(row), `the row: ${row.slice(0, 50)}`);
  for (const fact of ['union of distinct valid findings', 'nine of the frame', 'one run per cell', 'lower bounds', 'a fifth to a quarter', 'main sessions, not sub-agents', 'the two sub-agent runs at high found the same four findings and the headless pair at high found one and two', '`advisor_redacted_result`', '45 tests', '33 mutants', '76 439 cache tokens and read none', 'wrote 58 878 in all', 'three tool calls ran 6.2, 10.0 and 6.5 minutes', 'several shorter commands']) {
    assert.ok(s.includes(fact), `it says: ${fact}`);
  }
  for (const p of lines) assert.ok(p.split(/\s+/).length <= 250, `no paragraph over 250 words: ${p.slice(0, 40)}`);
  assert.ok(!s.includes('373 k') && !/cold cache between/.test(s), 'the cache is framed by the per-request fields, and Task 1b had no pause between passes');
});

test('MEASUREMENTS "Not measured yet" names the second pass on another task and Opus as the second-pass reader', () => {
  const s = section(read('docs/MEASUREMENTS.md'), '## Not measured yet');
  assert.ok(s.includes('- **The second pass on another task, against one xhigh pass.**'));
  assert.ok(s.includes('- **Opus as the second-pass reader.**'));
  assert.ok(s.includes('- **The second pass after a skill-forked first pass.**'));
});

// ── the other docs follow the defaults ───────────────────────────────────────

test('no doc still gives the shipped tester Sonnet at xhigh or the alias `sonnet` as its default', () => {
  const orchestration = read('docs/ORCHESTRATION.md');
  const config = read('docs/CONFIG.md');
  const readme = read('README.md');
  const rules = read('rules/omelette-fleet.md');
  assert.ok(!rules.includes('(Sonnet, `effort: xhigh`') && !rules.includes('Sonnet-class, xhigh'), 'rules');
  assert.ok(!orchestration.includes('`model: sonnet`,') && !orchestration.includes('Sonnet, `effort: xhigh`'), 'ORCHESTRATION: no definition item or line gives the tester the alias or xhigh');
  assert.ok(!readme.includes('`omelette-tester`: Sonnet xhigh'), 'README rules row');
  assert.ok(readme.includes('`omelette-tester`: Sonnet 5.5 high'), 'README rules row names the new pair');
  const agentSection = section(config, '### Agent settings');
  assert.ok(agentSection.includes('| `agents.tester.model` | one printable line | `"claude-sonnet-5-5"` |'), 'CONFIG tester model row');
  assert.ok(agentSection.includes('| `agents.tester.effort` | `low` \\| `medium` \\| `high` \\| `xhigh` \\| `max` | `"high"` |'), 'CONFIG tester effort row');
  assert.ok(config.includes('    "tester": { "model": "claude-sonnet-5-5", "effort": "high", "maxTurns": 80 },'), 'CONFIG Shape block');
  const help = spawnSync(process.execPath, [BIN, 'rules', '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home(), OMELETTE_HOME: home(), OMELETTE_UPDATE_CHECK: '0' } });
  assert.match(help.stdout, /^\s*Sonnet high; omelette-reviewer: Opus xhigh; all four disallow\s*$/m, '`rules --help`');
});

// ── the shipped example stops freezing the package's defaults (ruling B) ──────

/** A fake codex that answers `exec` and logs every argv it was started with. */
function codexStation() {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t2-codex-'));
  const bin = join(dir, 'fake-codex');
  const logPath = join(dir, 'argv.log');
  writeFileSync(bin, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    "process.stdin.on('data', () => {}).on('end', () => {",
    "  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "  line({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } });",
    "  line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });",
    '});',
    'process.stdin.resume();',
  ].join('\n'));
  chmodSync(bin, 0o755);
  const argvs = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, argvs };
}

/** One codex_research call in the fleet home `home`; returns [the -m, the effort flag] that reached the CLI. */
async function codexCall(home) {
  const st = codexStation();
  const rt = createUnitRuntime(codexUnit, { env: { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: home, CODEX_BIN: st.bin } });
  const r = await rt.callTool('codex_research', { prompt: 'x' });
  assert.ok(!r.isError, r.text);
  const [argv] = st.argvs();
  return [argv[argv.indexOf('-m') + 1], argv.find((x) => x.startsWith('model_reasoning_effort='))];
}

/** The CLI in a throwaway home with nothing on PATH, so `install` registers nothing and only writes the config. */
function cliHome(dir, args) {
  const empty = join(dir, 'empty-path');
  mkdirSync(empty, { recursive: true });
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { PATH: empty, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' } });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

test('the shipped example carries only what an operator decides: no agents block, no codex model or effort, Gemini\'s model because that unit has none built in', () => {
  const example = JSON.parse(read('examples/fleet.config.json'));
  assert.ok(!('agents' in example), JSON.stringify(example));
  assert.deepEqual(Object.keys(example.units.codex).sort(), ['enabled', 'mode', 'timeoutS', 'webSearch']);
  assert.equal(geminiUnit.builtin.model, undefined, 'gemini has no built-in model, so the example keeps the operator\'s choice');
  assert.equal(example.units.gemini.model, 'Gemini 3.8 Flash (High)');
  assert.deepEqual(example.defaults, { status: true });
  const readme = read('README.md');
  const block = readme.slice(readme.indexOf('`examples/fleet.config.json`, which carries only what an operator decides'));
  const json = block.slice(block.indexOf('```json\n') + 8, block.indexOf('\n```', block.indexOf('```json\n') + 8));
  assert.deepEqual(JSON.parse(json), example, 'README shows the file as it is');
  for (const rel of ['README.md', 'docs/CONFIG.md']) {
    const md = read(rel);
    assert.ok(md.includes('carries only what an operator decides') && md.includes('follows the package\'s defaults, release by release'), `${rel} says what the example carries`);
  }
  const shape = section(read('docs/CONFIG.md'), '## Shape');
  assert.ok(shape.includes('"tester": { "model": "claude-sonnet-5-5", "effort": "high", "maxTurns": 80 },') && shape.includes('"model": "gpt-6.1-sol"'), 'CONFIG\'s Shape block stays the full map of keys');
});

test('install from the shipped example in a throwaway home: the tester and codex follow the package\'s defaults', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t2-install-'));
  const r = cliHome(dir, ['install', '--units', 'codex']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^config {2}wrote .*fleet\.config\.json/m, r.out);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8')), JSON.parse(read('examples/fleet.config.json')));
  const s = agentSettings({ OMELETTE_HOME: dir });
  assert.deepEqual(s.tester, { model: SONNET, effort: 'high', maxTurns: 80 });
  assert.deepEqual(s.sources.tester, { model: 'default', effort: 'default', maxTurns: 'default' });
  assert.deepEqual(s.coder, { model: OPUS, effort: 'xhigh' });
  assert.deepEqual(await codexCall(dir), ['gpt-6.1-sol', 'model_reasoning_effort="xhigh"']);
});

test('the upgrade path CHANGELOG gives: `set codex.model= codex.effort=` clears the codex keys; `set` cannot clear an agents key, a hand edit does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-t2-upgrade-'));
  const old = { version: 1, agents: { coder: { model: 'opus', effort: 'xhigh' }, tester: { model: 'sonnet', effort: 'xhigh', maxTurns: 80 } }, units: { codex: { enabled: true, mode: 'read-only', model: 'gpt-6-astra', effort: 'high' } } };
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(old));
  assert.deepEqual(await codexCall(dir), ['gpt-6-astra', 'model_reasoning_effort="high"'], 'a 1.6.0-shaped config keeps what it set');
  const cleared = cliHome(dir, ['set', 'codex.model=', 'codex.effort=']);
  assert.equal(cleared.code, 0, cleared.err);
  assert.deepEqual(await codexCall(dir), ['gpt-6.1-sol', 'model_reasoning_effort="xhigh"'], 'the catalog head at its pairing');
  const before = readFileSync(join(dir, 'fleet.config.json'), 'utf8');
  const refused = cliHome(dir, ['set', 'agents.tester.model=']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /invalid value for agents\.tester\.model: ""/);
  assert.equal(cliHome(dir, ['set', 'agents.tester.effort=']).code, 1);
  assert.equal(readFileSync(join(dir, 'fleet.config.json'), 'utf8'), before, 'a refused set writes nothing');
  const edited = JSON.parse(before);
  delete edited.agents;
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(edited));
  const s = agentSettings({ OMELETTE_HOME: dir });
  assert.deepEqual([s.tester.model, s.tester.effort, s.coder.model], [SONNET, 'high', OPUS], 'the hand edit follows the defaults');
});

test('CHANGELOG 1.6.1 states the three behaviour changes and how to keep the old values', () => {
  const md = read('CHANGELOG.md');
  const entry = md.slice(md.indexOf('## 1.6.1'), md.indexOf('## 1.6.0'));
  const bullet = entry.split('\n').find((l) => l.startsWith('- **The tester runs at `high` with a second pass'));
  assert.ok(bullet, 'the bullet');
  for (const fact of ['`claude-opus-5-5`', '`claude-sonnet-5-5`', '"Second pass"', 'stop-and-report', '`omelette-fleet set agents.tester.effort=xhigh agents.tester.model=sonnet`', 'rules --agents', '(docs/MEASUREMENTS.md#the-testers-effort-a-second-pass-and-an-advisor)']) {
    assert.ok(bullet.includes(fact), `it says: ${fact}`);
  }
  const example = entry.split('\n').find((l) => l.startsWith('- **The shipped example config carries only what an operator decides.**'));
  assert.ok(example, 'the example bullet');
  for (const fact of ['`omelette-fleet set codex.model= codex.effort=`', 'by hand', '`set` refuses an empty value for an agents key', 'release by release']) {
    assert.ok(example.includes(fact), `it says: ${fact}`);
  }
  for (const b of [bullet, example]) assert.ok(b.split(/\s+/).length <= 250, 'not a wall');
});
