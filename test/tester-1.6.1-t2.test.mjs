// 1.6.1 Task 2, clean-context tester (plan docs/superpowers/plans/2026-09-30-1.6.1-catalogs-effort-docs.md,
// "Task 2", plus rulings A and B). The coder's file test/agents-1.6.1-t2.test.mjs pins the shape of the
// templates, the defaults, the rules step and three MEASUREMENTS rows. This file covers what it does not:
//   - every number of MEASUREMENTS' three tables and its prose against the ledger's source tables,
//   - the Claude Code version column (sub-agent arms 2.1.284, headless arms 2.1.285, ruling in the ledger),
//   - the framings the rulings forbid, swept over every shipped text rather than two files,
//   - the commands CHANGELOG hands an upgrading operator, run for real in throwaway homes,
//   - an old definition on disk and an old example-shaped config meeting the new defaults,
//   - the shipped example config loading clean and the upgrade command on a config that lacks the keys,
//   - the guard against the template's instruction (a plain copy, not a worktree),
//   - template structure the exact-line pins cannot see (placeholders, front matter, placement).
// Every home and project is a temp directory; no vendor CLI is spawned (the fake codex answers exec only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SETTINGS_SCHEMA } from '../core/config.mjs';
import { AGENT_FILES, HOOK_FILES, agentSettings, renderAgentFile, renderHookFile, renderRulesFile } from '../core/rules.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import codexUnit from '../units/codex/adapter.mjs';

process.env.OMELETTE_HOME = mkdtempSync(join(tmpdir(), 'omelette-t2x-'));

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'omelette-fleet.mjs');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

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

/** The data rows of the first Markdown table after the line that starts with `caption`, as trimmed cells. */
function tableAfter(md, caption) {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => l.startsWith(caption));
  assert.notEqual(at, -1, `caption present: ${caption}`);
  const rows = [];
  let started = false;
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith('|')) {
      started = true;
      rows.push(l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
    } else if (started) break;
  }
  return rows.slice(2); // header and separator
}

/** A throwaway directory that can be a fleet home, a project and a HOME at once. */
const tmp = (label) => mkdtempSync(join(tmpdir(), `omelette-t2x-${label}-`));

/** The CLI in a throwaway home; PATH holds nothing, so no vendor CLI or `claude` can be reached. */
function cli(dir, args, cwd = dir) {
  const empty = join(dir, '.empty-path');
  mkdirSync(empty, { recursive: true });
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8',
    env: { PATH: empty, HOME: dir, OMELETTE_HOME: dir, OMELETTE_UPDATE_CHECK: '0' },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const writeConfig = (dir, cfg) => writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify(cfg));
const readConfig = (dir) => JSON.parse(readFileSync(join(dir, 'fleet.config.json'), 'utf8'));

/** The 1.6.1 entry of CHANGELOG, bullet by bullet. */
function changelogEntry() {
  const md = read('CHANGELOG.md');
  return md.slice(md.indexOf('## 1.6.1'), md.indexOf('## 1.6.0'));
}
const bulletStarting = (entry, lead) => {
  const b = entry.split('\n').find((l) => l.startsWith(lead));
  assert.ok(b, `CHANGELOG bullet: ${lead}`);
  return b;
};

// ── MEASUREMENTS against the ledger's source tables (2026-09-30) ─────────────

const MEAS = () => section(read('docs/MEASUREMENTS.md'), "## The tester's effort, a second pass and an advisor");

test('MEASUREMENTS one-pass table: all six rows carry the ledger numbers, the model id and Claude Code 2.1.284', () => {
  // [label, Claude Code, tests, turns, minutes, cost >= $, findings of 13, mutation check] — ledger lines 54-60
  const expected = [
    ['`claude-sonnet-5-5` · medium', '2.1.284', '19', '20', '6.7', '0.40', '3', 'no'],
    ['`claude-sonnet-5-5` · high', '2.1.284', '28', '21', '11.5', '0.64', '4', 'no'],
    ['`claude-sonnet-5-5` · xhigh', '2.1.284', '44', '56', '30.8', '2.90', '10', 'yes (16, 14 caught)'],
    ['`claude-opus-5-5` · medium', '2.1.284', '20', '27', '9.0', '1.01', '5', 'no'],
    ['`claude-opus-5-5` · high', '2.1.284', '24', '28', '9.7', '1.07', '4', 'no'],
    ['`claude-opus-5-5` · xhigh', '2.1.284', '24', '57', '24.1', '2.60', '8', 'no'],
  ];
  assert.deepEqual(tableAfter(MEAS(), '**One pass, six arms**'), expected);
});

test('MEASUREMENTS advisor table: the three headless rows carry the harness numbers and Claude Code 2.1.285', () => {
  // [run, model, Claude Code, advisor calls, tests, turns, minutes, billed $, findings of 13] — ledger lines 63, 66
  const rows = tableAfter(MEAS(), '**The advisor, three headless runs**');
  assert.equal(rows.length, 3);
  const pick = (r) => [r[2], r[3], r[4], r[5], r[6], r[7], r[8]];
  assert.deepEqual(pick(rows[0]), ['2.1.285', '—', '14', '17', '7.5', '0.54', '1']);
  assert.deepEqual(pick(rows[1]), ['2.1.285', '0', '24', '20', '7.6', '0.80', '2']);
  assert.deepEqual(pick(rows[2]), ['2.1.285', '2', '22', '19', '12.8', '2.06 = Sonnet 0.96 + advisor 1.10', '4']);
  for (const r of rows) assert.ok(r[1].includes('`claude-sonnet-5-5` · high'), `${r[0]}: the main model and its effort`);
  assert.ok(rows[1][1].includes('`claude-opus-5-5` advisor') && rows[2][1].includes('`claude-opus-5-5` advisor'));
  assert.ok(!rows[0][1].includes('advisor'), 'the control has none');
});

test('MEASUREMENTS iteration table: five variants with the ledger numbers, each naming its model and Claude Code', () => {
  // [variant, model and Claude Code, tests, mutations run, minutes, cost, findings of 17] — ledger lines 81-86
  const rows = tableAfter(MEAS(), '**A second pass in the same agent**');
  assert.equal(rows.length, 5);
  const numbers = (r) => [r[0], ...r.slice(2)];
  assert.deepEqual(numbers(rows[0]), ['xhigh, one pass', '44', '16', '30.8', '2.90', '10']);
  assert.deepEqual(numbers(rows[1]), ['high, one pass (3 samples)', '28 / 28 / 14–24 headless', '0', '8–12', '0.6', '4 / 4 / 1–2']);
  assert.deepEqual(numbers(rows[2]), ['high, two passes', '31', '39', '24.8', '1.46', '13']);
  assert.deepEqual(numbers(rows[3]), ['medium, two passes', '26', '22', '~35', '1.62', '9']);
  assert.deepEqual(numbers(rows[4]), ['high + Opus advisor, asked twice', '22', '1', '12.8', '2.06 (billed, exact)', '4']);
  // the xhigh and forced-advisor rows repeat the other tables; the repeats must agree
  assert.equal(rows[0][5], '2.90');
  assert.equal(rows[4][5], '2.06 (billed, exact)');
  for (const r of rows) assert.match(r[1], /`claude-sonnet-5-5`/, `${r[0]}: model`);
  for (const r of rows.slice(0, 4)) assert.match(r[1], /2\.1\.284/, `${r[0]}: sub-agent arm, Claude Code 2.1.284`);
  assert.match(rows[1][1], /headless 2\.1\.285/);
  assert.match(rows[4][1], /2\.1\.285/);
  assert.ok(!/2\.1\.284/.test(rows[4][1]), 'the advisor arm was headless: not 2.1.284');
});

test('MEASUREMENTS prose repeats the ledger facts exactly (harness output tokens, advisor bill, tool counts, union counts)', () => {
  const s = MEAS();
  for (const fact of [
    '202 437 uncached input tokens', '14 334 output', '12 700 and 16 640', 'about 23 % and 21 % of their cost',
    'Read 2, Bash 15, Write 1, Edit 1', '`advisor_redacted_result`', '13 after the single-pass arms, 17 once the two-pass arm added four',
    'nine of the frame\'s ten', 'Sonnet 5.5 at xhigh', 'found 10 of 13', 'Opus 5.5 found more than Sonnet 5.5 at the same effort only at medium (5 against 3)',
    'at about half one xhigh pass\'s cost and 80 % of its time', 'found 13 of 17',
    '43 tests', '45 tests', '33 mutants', '31 killed', '2 missed', '11.3 min', 'six prose findings', '39 min by the harness\'s clock',
    'six medium and high runs together found 5 of the 13', '76 439 cache tokens and read none', 'wrote 58 878 in all', '31.5 minutes idle',
  ]) assert.ok(s.includes(fact), `it says: ${fact}`);
  // the frame-favours-xhigh caveat survives
  assert.ok(s.includes('The scoring frame favoured the Sonnet xhigh arm by construction'));
});

test('MEASUREMENTS: every row of the three tables names a claude- model id and a Claude Code version of 2.1.284 or 2.1.285', () => {
  const s = MEAS();
  const rows = [
    ...tableAfter(s, '**One pass, six arms**'),
    ...tableAfter(s, '**The advisor, three headless runs**'),
    ...tableAfter(s, '**A second pass in the same agent**'),
  ];
  assert.equal(rows.length, 14);
  for (const r of rows) {
    const line = r.join(' | ');
    assert.match(line, /`claude-(sonnet|opus)-5-5`/, line);
    assert.match(line, /2\.1\.28[45]/, line);
  }
});

test('MEASUREMENTS: the decision line and the Not-measured-yet entries say what the ledger ruled', () => {
  const s = MEAS();
  const decision = s.split('\n').find((l) => l.startsWith('**Decision (1.6.1).**'));
  assert.ok(decision, 'a decision line');
  for (const fact of ['`agents.tester.effort` is `high`', 'pinned by exact id', 'documented, not adopted', 'N = 1 per cell']) assert.ok(decision.includes(fact), fact);
  const limits = section(read('docs/MEASUREMENTS.md'), "## The tester's effort, a second pass and an advisor").split('\n').filter((l) => l.startsWith('- '));
  assert.ok(limits.some((l) => l.startsWith('- One task, one run per cell')));
  assert.ok(limits.some((l) => l.includes('main sessions, not sub-agents')));
});

// ── the framings the rulings forbid, swept over every shipped text ───────────

const SHIPPED = () => {
  const out = {
    'README.md': read('README.md'),
    'CHANGELOG.md (1.6.1 entry)': changelogEntry(),
    'rules/omelette-fleet.md': read('rules/omelette-fleet.md'),
    'skills/omelette-test/SKILL.md': read('skills/omelette-test/SKILL.md'),
    'core/config.mjs': read('core/config.mjs'),
    'SECURITY.md': read('SECURITY.md'),
    'CONTRIBUTING.md': read('CONTRIBUTING.md'),
  };
  for (const f of readdirSync(join(ROOT, 'docs')).filter((n) => n.endsWith('.md'))) out[`docs/${f}`] = read(`docs/${f}`);
  for (const f of readdirSync(join(ROOT, 'agents'))) out[`agents/${f}`] = read(`agents/${f}`);
  return out;
};

test('ruling A: no shipped text says "373 k against 75 k", names a 38-minute pause, or claims a cold cache between Task 1b\'s passes', () => {
  for (const [name, text] of Object.entries(SHIPPED())) {
    assert.ok(!/\b373 k\b/.test(text), `${name}: 373 k`);
    assert.ok(!/against 75 ?k\b/i.test(text), `${name}: against 75 k`);
    assert.ok(!/\b38[ -]?(idle )?min/i.test(text) && !/about 38 idle/i.test(text), `${name}: a 38-minute pause (it was 31.5)`);
    assert.ok(!/cold[^.\n]{0,80}between (the |its |both |two )?passes/i.test(text), `${name}: a cold cache between passes`);
    assert.ok(!/paid for a cold cache/i.test(text), `${name}: paid for a cold cache`);
  }
});

test('ruling A: the cache lesson is told in the measured numbers, the same ones everywhere it appears', () => {
  const figures = new Set();
  for (const [name, text] of Object.entries(SHIPPED())) {
    if (name === 'core/config.mjs') continue;
    for (const m of text.matchAll(/\b(\d{2} \d{3})(?= cache tokens| in all)/g)) figures.add(m[1]);
    if (/cache tokens/.test(text) && name !== 'docs/MEASUREMENTS.md') {
      // only the two measured pauses' figures, and only with the sentence that says what they are
      assert.ok(/31\.5 minutes idle/.test(text) || !/76 439/.test(text), `${name}: 76 439 without its 31.5 minutes`);
    }
  }
  assert.deepEqual([...figures].sort(), ['58 878', '76 439']);
  const orch = read('docs/ORCHESTRATION.md');
  const meas = read('docs/MEASUREMENTS.md');
  for (const doc of [orch, meas]) {
    assert.ok(doc.includes('31.5 minutes idle'), 'the pause');
    assert.ok(doc.includes('sent 4 s after its report') || doc.includes('sent 4 s after its report, wrote 58 878 in all'), 'the contrast');
  }
  // the lesson in the template and the rules: the threshold is "about five minutes", never a bare "5 minutes" or a TTL claim
  const tester = read('agents/omelette-tester.md');
  assert.ok(tester.includes('a command running past about five minutes lets your cache go cold'));
  assert.ok(read('rules/omelette-fleet.md').includes('the one long pause measured (31.5 minutes) restarted on a cold cache') /* moved by the session: round 3 ruling 5 */);
});

test('ruling in the ledger: the sub-agent arms and the alias lag are not dated 2.1.285, and the alias lag rests on one run', () => {
  for (const [name, text] of Object.entries(SHIPPED())) {
    if (name === 'docs/MEASUREMENTS.md') continue; // its headless rows legitimately say 2.1.285: pinned in the table tests
    assert.ok(!text.includes('2.1.285'), `${name}: 2.1.285 belongs to the headless advisor arms only`);
    assert.ok(!/three sub-agents/i.test(text), `${name}: the alias lag is evidenced by one sub-agent run`);
    assert.ok(!/(both|two) 2026-09-26 audit reviewers/i.test(text), `${name}: those reviewers ran before 5.5 shipped and prove nothing`);
  }
  const orch = read('docs/ORCHESTRATION.md');
  assert.ok(orch.includes('a sub-agent spawned on `sonnet` in a Claude Code 2.1.284 session still ran on Sonnet 5'));
  const meas = read('docs/MEASUREMENTS.md');
  const version = /Claude Code 2\.1\.28[45]/g;
  for (const m of meas.matchAll(version)) assert.ok(m[0].endsWith('284'), `MEASUREMENTS "${m[0]}": only the T1b flow sentence names a session version in prose, and it was 2.1.284`);
});

test('the cross-document figures agree: N of 17 and the two costs are the same everywhere they are quoted', () => {
  const allowed = {
    'CHANGELOG.md (1.6.1 entry)': ['13', '10'],
    'docs/ORCHESTRATION.md': ['4', '13', '10'],
  };
  const shipped = SHIPPED();
  for (const [name, ok] of Object.entries(allowed)) {
    const found = new Set([...shipped[name].matchAll(/\b(\d+) of 17\b/g)].map((m) => m[1]));
    for (const n of found) assert.ok(ok.includes(n), `${name}: "${n} of 17" is not a ledger count`);
    assert.ok(found.has('13'), `${name} quotes the two-pass count`);
  }
  const orch = shipped['docs/ORCHESTRATION.md'];
  assert.ok(orch.includes('at least $1.46') && orch.includes('at least $2.90'));
  assert.ok(!/at least \$(?!1\.46|2\.90)\d/.test(orch), 'no other lower-bound cost in ORCHESTRATION');
  const adv = orch.match(/\$1\.10 of a \$(\d\.\d\d) run/);
  assert.equal(adv && adv[1], '2.06');
  assert.ok(orch.includes('Sonnet 5.5 at `high` with an Opus 5.5 advisor attached never called it in 20 turns'), 'the zero-call run took 20 turns (ledger)');
});

// ── CHANGELOG commands, executed ─────────────────────────────────────────────

test('CHANGELOG "keep the old values": the printed set command and the other three roles, then rules --agents, restore opus/sonnet/xhigh', () => {
  const bullet = bulletStarting(changelogEntry(), '- **The tester runs at `high` with a second pass');
  const printed = bullet.match(/`omelette-fleet (set agents\.tester\.effort=\S+ agents\.tester\.model=\S+)`/);
  assert.ok(printed, 'the set command is printed');
  const dir = tmp('keep');
  assert.equal(cli(dir, ['rules', '--agents']).code, 0);
  const agent = (n) => readFileSync(join(dir, '.claude', 'agents', n), 'utf8');
  assert.match(agent('omelette-tester.md'), /^model: claude-sonnet-5-5\neffort: high$/m);
  const args = printed[1].split(' ');
  const r1 = cli(dir, args);
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /agents\.tester\.effort {2}high \[default\] → xhigh \[file\]/);
  assert.match(r1.out, /agents\.tester\.model {2}claude-sonnet-5-5 \[default\] → sonnet \[file\]/);
  // "and agents.<role>.model=opus for the other three roles": coder, coderMedium, reviewer
  assert.ok(bullet.includes('`agents.<role>.model=opus` for the other three roles'));
  const r2 = cli(dir, ['set', 'agents.coder.model=opus', 'agents.coderMedium.model=opus', 'agents.reviewer.model=opus']);
  assert.equal(r2.code, 0, r2.err);
  const r3 = cli(dir, ['rules', '--agents']);
  assert.equal(r3.code, 0, r3.err);
  assert.match(agent('omelette-tester.md'), /^model: sonnet\neffort: xhigh\nmaxTurns: 80$/m);
  for (const n of ['omelette-coder.md', 'omelette-coder-medium.md', 'omelette-reviewer.md']) assert.match(agent(n), /^model: opus$/m, n);
  assert.match(agent('omelette-coder-medium.md'), /^effort: medium$/m, 'only the model moved');
  assert.match(agent('omelette-reviewer.md'), /^effort: xhigh$/m);
});

test('an 1.6.0-rendered definition on disk is rewritten by the next rules --agents; the roles that did not change stay "up to date"', () => {
  const dir = tmp('rerender');
  assert.equal(cli(dir, ['rules', '--agents']).code, 0);
  const file = join(dir, '.claude', 'agents', 'omelette-tester.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^model: .*$/m, 'model: sonnet').replace(/^effort: .*$/m, 'effort: xhigh'));
  const r = cli(dir, ['rules', '--agents']);
  assert.equal(r.code, 0, r.err);
  const lineFor = (name) => r.out.split('\n').find((l) => l.includes(`/agents/${name}`));
  assert.match(lineFor('omelette-tester.md'), /^written /);
  for (const n of ['omelette-coder.md', 'omelette-coder-medium.md', 'omelette-reviewer.md']) assert.match(lineFor(n), /^up to date /, n);
  assert.match(readFileSync(file, 'utf8'), /^model: claude-sonnet-5-5\neffort: high\nmaxTurns: 80$/m);
});

test('an install made from an earlier example keeps opus/sonnet/xhigh for coder and tester; the other two roles and the codex unit follow the package', async () => {
  const dir = tmp('old-example');
  writeConfig(dir, {
    version: 1,
    defaults: { status: true },
    agents: { coder: { model: 'opus', effort: 'xhigh' }, tester: { model: 'sonnet', effort: 'xhigh', maxTurns: 80 } },
    units: { codex: { enabled: true, mode: 'read-only', model: 'gpt-6-astra', effort: 'high', webSearch: true, timeoutS: 600 } },
  });
  const s = agentSettings({ OMELETTE_HOME: dir });
  assert.deepEqual(s.tester, { model: 'sonnet', effort: 'xhigh', maxTurns: 80 });
  assert.deepEqual(s.coder, { model: 'opus', effort: 'xhigh' });
  assert.deepEqual(s.coderMedium, { model: 'claude-opus-5-5', effort: 'medium' }, 'never in the old example: follows the default');
  assert.deepEqual(s.reviewer, { model: 'claude-opus-5-5', effort: 'xhigh' });
  const shown = cli(dir, ['show', 'agents']);
  assert.match(shown.out, /^\s+tester\.effort\s+xhigh\s+file$/m);
  assert.match(shown.out, /^\s+tester\.model\s+sonnet\s+file$/m);
  assert.match(shown.out, /^\s+reviewer\.model\s+claude-opus-5-5\s+default$/m);
  // the documented hand edit: delete the model and effort keys under agents; maxTurns may stay (it equals the default)
  const edited = readConfig(dir);
  for (const role of Object.keys(edited.agents)) { delete edited.agents[role].model; delete edited.agents[role].effort; }
  writeConfig(dir, edited);
  const after = agentSettings({ OMELETTE_HOME: dir });
  assert.deepEqual(after.tester, { model: 'claude-sonnet-5-5', effort: 'high', maxTurns: 80 });
  assert.deepEqual(after.coder, { model: 'claude-opus-5-5', effort: 'xhigh' });
});

test('a hand-written empty agents.tester.model falls back to the default and rules --agents still renders, no crash', () => {
  const dir = tmp('blank');
  writeConfig(dir, { version: 1, agents: { tester: { model: '', effort: 'high' } } });
  const s = agentSettings({ OMELETTE_HOME: dir });
  assert.equal(s.tester.model, 'claude-sonnet-5-5', 'an empty model is not a model: the default applies');
  assert.equal(cli(dir, ['rules', '--agents']).code, 0);
  assert.match(readFileSync(join(dir, '.claude', 'agents', 'omelette-tester.md'), 'utf8'), /^model: claude-sonnet-5-5$/m);
});

// ── the shipped example config (ruling B) ────────────────────────────────────

test('the shipped example loads clean: no warning from show, every agents value and the codex model follow the package', () => {
  const dir = tmp('example');
  writeFileSync(join(dir, 'fleet.config.json'), read('examples/fleet.config.json'));
  for (const args of [['show', 'agents'], ['show', 'codex'], ['show', 'fleet'], ['show', 'gemini'], ['show', 'grok']]) {
    const r = cli(dir, args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    assert.ok(!/warning/i.test(r.out + r.err), `${args.join(' ')}: ${r.out}`);
  }
  const agents = cli(dir, ['show', 'agents']).out;
  for (const row of ['coder.model', 'coder.effort', 'coderMedium.model', 'coderMedium.effort', 'tester.model', 'tester.effort', 'tester.maxTurns', 'reviewer.model', 'reviewer.effort']) {
    assert.match(agents, new RegExp(`^\\s+${row.replace('.', '\\.')}\\s+\\S+\\s+default$`, 'm'), `${row}: from the package`);
  }
  const codex = cli(dir, ['show', 'codex']).out;
  assert.match(codex, /^\s+model\s+\(unset\)\s+default$/m);
  assert.match(codex, /^\s+effort\s+xhigh\s+default$/m);
  assert.match(cli(dir, ['show', 'gemini']).out, /^\s+model\s+Gemini 3\.8 Flash \(High\)\s+file$/m, 'gemini keeps the operator choice: the unit has no built-in model');
});

test('the example keeps every other key of 1.6.0: units, modes, timeouts, web search, status, Gemini\'s model', () => {
  const ex = JSON.parse(read('examples/fleet.config.json'));
  assert.deepEqual(Object.keys(ex).sort(), ['defaults', 'units', 'version']);
  assert.equal(ex.version, 1);
  assert.deepEqual(Object.keys(ex.units).sort(), ['codex', 'gemini', 'grok']);
  for (const u of ['gemini', 'grok', 'codex']) {
    assert.equal(ex.units[u].enabled, true, u);
    assert.equal(ex.units[u].mode, 'read-only', u);
    assert.equal(typeof ex.units[u].timeoutS, 'number', u);
  }
  assert.equal(ex.units.codex.webSearch, true);
  assert.ok(!('effort' in ex.units.codex) && !('model' in ex.units.codex));
  assert.ok(!('effort' in ex.units.gemini) && !('effort' in ex.units.grok), 'no unit effort is frozen either');
});

test('install twice from the example: the second run never overwrites the operator\'s edits, and a fresh install renders the package defaults', () => {
  const dir = tmp('install-twice');
  const first = cli(dir, ['install', '--units', 'codex']);
  assert.equal(first.code, 0, first.out + first.err);
  const cfg = readConfig(dir);
  cfg.units.codex.timeoutS = 123;
  writeConfig(dir, cfg);
  const second = cli(dir, ['install', '--units', 'codex']);
  assert.equal(second.code, 0, second.out + second.err);
  assert.equal(readConfig(dir).units.codex.timeoutS, 123, 'an existing file is never overwritten');
  assert.equal(cli(dir, ['rules', '--agents']).code, 0);
  const t = readFileSync(join(dir, '.claude', 'agents', 'omelette-tester.md'), 'utf8');
  assert.match(t, /^model: claude-sonnet-5-5\neffort: high\nmaxTurns: 80$/m);
});

/** A fake codex that answers exec and logs its argv (the same shape the suite uses elsewhere). */
function fakeCodex() {
  const dir = tmp('codex');
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
  return { bin, argvs: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}
async function codexSends(home) {
  const st = fakeCodex();
  const rt = createUnitRuntime(codexUnit, { env: { PATH: process.env.PATH, HOME: home, OMELETTE_HOME: home, CODEX_BIN: st.bin } });
  const r = await rt.callTool('codex_research', { prompt: 'x' });
  assert.ok(!r.isError, r.text);
  const [argv] = st.argvs();
  return [argv[argv.indexOf('-m') + 1], argv.find((x) => x.startsWith('model_reasoning_effort='))];
}

test('CHANGELOG upgrade path on a config that lacks the codex keys: `set codex.model= codex.effort=` still exits 0, keeps the other keys, and the catalog head runs at xhigh', async () => {
  const entry = changelogEntry();
  const example = bulletStarting(entry, '- **The shipped example config carries only what an operator decides.**');
  assert.ok(example.includes('`omelette-fleet set codex.model= codex.effort=`'));
  const dir = tmp('absent-keys');
  writeFileSync(join(dir, 'fleet.config.json'), read('examples/fleet.config.json'));
  const before = readConfig(dir);
  const r = cli(dir, ['set', 'codex.model=', 'codex.effort=']);
  assert.equal(r.code, 0, r.out + r.err);
  const after = readConfig(dir);
  for (const k of ['enabled', 'mode', 'webSearch', 'timeoutS']) assert.deepEqual(after.units.codex[k], before.units.codex[k], k);
  assert.deepEqual(after.units.gemini, before.units.gemini);
  assert.deepEqual(after.units.grok, before.units.grok);
  assert.deepEqual(await codexSends(dir), ['gpt-6.1-sol', 'model_reasoning_effort="xhigh"']);
  // and the catalog head at its pairing is what the 1.6.0-shaped install reaches after the same command
  const old = tmp('old-codex');
  writeConfig(old, { version: 1, units: { codex: { enabled: true, model: 'gpt-6-astra', effort: 'high' } } });
  assert.deepEqual(await codexSends(old), ['gpt-6-astra', 'model_reasoning_effort="high"']);
  assert.equal(cli(old, ['set', 'codex.model=', 'codex.effort=']).code, 0);
  assert.deepEqual(await codexSends(old), ['gpt-6.1-sol', 'model_reasoning_effort="xhigh"']);
});

test('CHANGELOG says an install from an earlier example keeps opus, sonnet and xhigh, and the example bullet says how to follow the package for the agents', () => {
  const entry = changelogEntry();
  assert.ok(bulletStarting(entry, '- **The tester runs at `high` with a second pass').includes('keeps `opus`, `sonnet` and `xhigh`'));
  const ex = bulletStarting(entry, '- **The shipped example config carries only what an operator decides.**');
  assert.ok(ex.includes('delete the `model` and `effort` keys under `agents`'));
  assert.ok(ex.includes('then `omelette-fleet rules --agents --hooks`'));
  // the same instruction, in CONFIG's "When a default changes"
  assert.ok(read('docs/CONFIG.md').includes('delete those keys from the file to follow the defaults'));
});

// ── templates: what the exact-line pins cannot see ───────────────────────────

test('every rendered definition and the skill is free of unresolved placeholders, and the front matter keys are the expected set in order', () => {
  const expectKeys = {
    'omelette-coder.md': ['name', 'description', 'model', 'effort', 'disallowedTools'],
    'omelette-coder-medium.md': ['name', 'description', 'model', 'effort', 'disallowedTools'],
    'omelette-tester.md': ['name', 'description', 'model', 'effort', 'maxTurns', 'disallowedTools', 'tools'],
    'omelette-reviewer.md': ['name', 'description', 'model', 'effort', 'disallowedTools', 'tools'],
  };
  for (const name of AGENT_FILES) {
    const text = renderAgentFile(name, '1.6.1', {});
    assert.ok(!text.includes('{{'), `${name}: a placeholder survived`);
    const lines = text.split('\n');
    const close = lines.indexOf('---', 1);
    const keys = lines.slice(1, close).filter((l) => /^[A-Za-z]+:/.test(l)).map((l) => l.split(':')[0]);
    assert.deepEqual(keys, expectKeys[name], name);
    assert.ok(/^maxTurns: 80$/m.test(text) === (name === 'omelette-tester.md'), `${name}: maxTurns only on the tester`);
  }
});

test('the second pass lives in the tester alone and appears once; the reviewer and both coders never mention it', () => {
  const tester = renderAgentFile('omelette-tester.md', '1.6.1', {});
  assert.equal(tester.split('Second pass').length - 1, 2, 'the heading line names it twice (title and trigger words) and nothing else does');
  assert.equal(tester.split('**Mutation check.**').length - 1, 1);
  assert.equal(tester.split('**Reviewer pass over what the diff writes**').length - 1, 1);
  for (const n of ['omelette-reviewer.md', 'omelette-coder.md', 'omelette-coder-medium.md']) {
    assert.ok(!/second pass|mutation/i.test(renderAgentFile(n, '1.6.1', {})), n);
  }
  assert.ok(!/second pass|mutation/i.test(read('skills/omelette-test/SKILL.md')), 'the skill hands the diff; the orchestrator sends the word');
});

test('the tester stop paragraph closes the procedure part and precedes the Agent/turn-limit lines; the coder stop paragraph sits between its rules and its report', () => {
  const t = renderAgentFile('omelette-tester.md', '1.6.1', {}).split('\n');
  const stop = t.findIndex((l) => l.startsWith('When the work asked for is done and its checks pass, stop and report'));
  const third = t.findIndex((l) => l.startsWith('3. **Report only what is new**'));
  const agentLine = t.findIndex((l) => l.startsWith('The Agent tool is removed'));
  const turns = t.findIndex((l) => l.startsWith('If you hit the turn limit'));
  assert.ok(third < stop && stop < agentLine && agentLine < turns, `${third} < ${stop} < ${agentLine} < ${turns}`);
  assert.equal(t[stop - 1], '', 'a paragraph of its own');
  const c = renderAgentFile('omelette-coder.md', '1.6.1', {}).split('\n');
  const cs = c.findIndex((l) => l.startsWith('When the work asked for is done and its checks pass, stop and report'));
  const lastRule = c.map((l, i) => (l.startsWith('- ') ? i : -1)).filter((i) => i >= 0).pop();
  const report = c.findIndex((l) => l.startsWith('Report: write the full report'));
  assert.ok(lastRule < cs && cs < report, `${lastRule} < ${cs} < ${report}`);
  assert.equal(c.filter((l) => l.startsWith('When the work asked for is done')).length, 1);
  // the coder's scope sentence names the brief; the tester's names the second pass
  assert.ok(c[cs].includes("the task's scope is the brief") && !c[cs].includes('second pass'));
  assert.ok(t[stop].includes('no second pass until the orchestrator sends one') && !t[stop].includes("the task's scope"));
});

test('the tester procedure still has its four numbered steps and the five-section report contract was not touched by the second pass', () => {
  const t = renderAgentFile('omelette-tester.md', '1.6.1', {});
  for (const start of ['1. From the spec, list the behaviours', '2. Write additional tests', '3. Run your file with the real runner', '4. For every failing test, rule:']) assert.ok(t.includes(start), start);
  for (const h of ['`## TASK`', '`## FINDINGS`', '`## DIFF`', '`## TEST RESULTS`', '`## OPEN QUESTIONS`']) assert.ok(t.includes(h), `the first report's section ${h}`);
});

// ── the guard against the template's instruction ─────────────────────────────

test('the guard allows what the second pass asks of the tester (a plain copy, the suite, git diff) and refuses the worktree the template rules out', () => {
  const dir = tmp('guard');
  const path = join(dir, 'omelette-guard.mjs');
  writeFileSync(path, renderHookFile(HOOK_FILES[0], '1.6.1'));
  const fire = (command, agent = 'omelette-tester') => spawnSync(process.execPath, [path], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: agent, tool_input: { command } }),
    encoding: 'utf8', timeout: 20000,
  });
  assert.ok(renderAgentFile('omelette-tester.md', '1.6.1', {}).includes('(not a `git worktree`)'));
  const refused = fire('git worktree add ../mutants');
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /omelette-tester never commits/);
  for (const ok of ['cp -R . ../mutants', 'rsync -a --exclude node_modules ./ /tmp/mutants/', 'cd /tmp/mutants && node --test test/tester-1.6.1-t2.test.mjs', 'git diff HEAD', 'git status --porcelain', 'sed -i.bak s/a/b/ core/config.mjs']) {
    const r = fire(ok);
    assert.equal(r.status, 0, `${ok}: ${r.stdout}${r.stderr}`);
  }
  assert.equal(fire('git commit -m x').status, 2, 'and the commit stays refused');
});

// ── the rules file ───────────────────────────────────────────────────────────

test('rules file: the ceiling carries about a hundred characters of headroom, not a loose margin, and its history line names 1.6.1', () => {
  for (const merge of ['session', 'pr']) {
    const n = renderRulesFile('1.6.1', { merge }).length;
    assert.ok(n <= 14590, `${merge}: ${n}`); // moved by the session: round 3 moved the ceiling with its history line
    assert.ok(14590 - n <= 200, `${merge}: ${n} leaves ${14590 - n} characters of headroom (plan: about a hundred)`);
  }
  const size = read('test/rules-size.test.mjs');
  assert.ok(size.includes('// 1.6.1 Task 2: 14 030 -> 14 590'), 'the line that says why');
});

test('rules file: the second-pass step is neither in the Reviews nor the Routing section, and the section order is unchanged', () => {
  const text = renderRulesFile('1.6.1', { merge: 'session' });
  const heads = text.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(heads, ['## Operating model for the session', '## Ledger and handoff', '## Tester flow', '## Reviews', '## Spawning sub-agents: model and effort', '## Routing', '## Never a sole source', '## Briefing a unit']);
  assert.equal(text.split('Second pass').length - 1, 1, 'named once, in the Tester flow');
  assert.ok(section(text, '## Tester flow').includes('"Second pass"'));
  const flow = section(text, '## Tester flow').split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(flow.length, 6);
  assert.ok(flow[3].startsWith('4. **The second pass, at once, in the same tester.**'));
});

test('rules --print through the CLI carries the same step, and the coder never appears in it as the one to send it', () => {
  const dir = tmp('print');
  const r = cli(dir, ['rules', '--print']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('4. **The second pass, at once, in the same tester.**'));
  const step = r.out.split('\n').find((l) => l.startsWith('4. **The second pass'));
  assert.ok(step.includes('the orchestrator continues the SAME tester'));
  assert.ok(!/\bcoder\b/i.test(step));
});

// ── docs: sections, links, consistency with the schema ───────────────────────

test('ORCHESTRATION table "Why" cells for the two coders quote numbers MEASUREMENTS has', () => {
  const orch = section(read('docs/ORCHESTRATION.md'), '### Effort by role and model');
  const meas = read('docs/MEASUREMENTS.md');
  assert.ok(orch.includes('2.5× the cache reads and 3.6× the wall clock'));
  assert.ok(section(meas, '## Coder effort: medium, high, xhigh on one task').includes('2.5×') || meas.includes('2.5×'));
  assert.ok(meas.includes('3.6×'));
  const row = orch.split('\n').find((l) => l.startsWith('| `omelette-coder` |'));
  assert.ok(row.includes('medium left a fail-open class in place; xhigh\'s misses were two narrow writes, fixed in one round') /* moved by the session: round 3 ruling 8 */);
  assert.ok(meas.includes('fail-open'), 'MEASUREMENTS has the matched repeat that sentence cites');
});

test('the README and CONFIG copies of the defaults agree with the schema row by row (every role, model and effort)', () => {
  const config = section(read('docs/CONFIG.md'), '### Agent settings');
  for (const [role, keys] of Object.entries(AGENT_SETTINGS_SCHEMA)) {
    for (const [key, spec] of Object.entries(keys)) {
      const cell = typeof spec.default === 'number' ? `\`${spec.default}\`` : `\`"${spec.default}"\``;
      const row = config.split('\n').find((l) => l.startsWith(`| \`agents.${role}.${key}\` |`));
      assert.ok(row, `CONFIG row for agents.${role}.${key}`);
      assert.ok(row.split(' | ')[2] === cell || row.includes(` | ${cell} | `), `${role}.${key}: ${row.slice(0, 120)} vs ${cell}`);
    }
  }
  const readme = read('README.md');
  assert.ok(readme.includes('(`omelette-coder`: Opus 5.5 xhigh; `omelette-coder-medium`: Opus 5.5 medium; `omelette-tester`: Sonnet 5.5 high; `omelette-reviewer`: Opus 5.5 xhigh;'));
});

test('README, CONFIG and the CLI help all say the tester is at high and none says xhigh for it', () => {
  const help = cli(tmp('help'), ['rules', '--help']).out;
  assert.ok(/Sonnet high;/.test(help) && !/Sonnet xhigh/.test(help));
  for (const [name, text] of Object.entries(SHIPPED())) {
    if (name === 'CHANGELOG.md (1.6.1 entry)' || name === 'docs/MEASUREMENTS.md' || name === 'core/config.mjs') continue;
    assert.ok(!/omelette-tester[^.\n|]{0,80}xhigh/.test(text), `${name}: the shipped tester at xhigh`);
    assert.ok(!/tester[^.\n|]{0,40}\(Sonnet, `?effort: xhigh/.test(text), `${name}: old definitions line`);
  }
});

test('docs map rows for the new sections exist in README, ORCHESTRATION and MEASUREMENTS and every link they carry lands on a real heading', () => {
  const links = [
    ['README.md', '[ORCHESTRATION, Effort by role and model](docs/ORCHESTRATION.md#effort-by-role-and-model)', 'docs/ORCHESTRATION.md', '### Effort by role and model'],
    ['docs/ORCHESTRATION.md', '[Effort by role and model](#effort-by-role-and-model)', 'docs/ORCHESTRATION.md', '### Effort by role and model'],
    ['docs/ORCHESTRATION.md', '[Tester sub-agent and arbitration](#tester-sub-agent-and-arbitration)', 'docs/ORCHESTRATION.md', '## Tester sub-agent and arbitration'],
    ['docs/MEASUREMENTS.md', '(#the-testers-effort-a-second-pass-and-an-advisor)', 'docs/MEASUREMENTS.md', "## The tester's effort, a second pass and an advisor"],
    ['docs/CONFIG.md', '(ORCHESTRATION.md#effort-by-role-and-model)', 'docs/ORCHESTRATION.md', '### Effort by role and model'],
    ['CHANGELOG.md', '(docs/MEASUREMENTS.md#the-testers-effort-a-second-pass-and-an-advisor)', 'docs/MEASUREMENTS.md', "## The tester's effort, a second pass and an advisor"],
  ];
  for (const [from, link, target, heading] of links) {
    assert.ok(read(from).includes(link), `${from} carries ${link}`);
    assert.ok(read(target).includes(`\n${heading}\n`), `${target} has ${heading}`);
  }
  // the ORCHESTRATION map has two rows that point at the tester section and one at the new subsection
  const map = read('docs/ORCHESTRATION.md').split('\n## ')[0];
  assert.equal(map.split('\n').filter((l) => l.includes('(#tester-sub-agent-and-arbitration)')).length, 2);
});

test('no new or changed line of the docs set is a wall: every paragraph of ORCHESTRATION\'s new subsection and MEASUREMENTS\' new section is at most 250 words', () => {
  const parts = [
    section(read('docs/ORCHESTRATION.md'), '### Effort by role and model'),
    section(read('docs/ORCHESTRATION.md'), '## Tester sub-agent and arbitration'),
    MEAS(),
  ];
  for (const p of parts) for (const line of p.split('\n')) {
    if (line.startsWith('|')) continue;
    assert.ok(line.split(/\s+/).filter(Boolean).length <= 250, `${line.slice(0, 60)}... is ${line.split(/\s+/).length} words`);
  }
});

test('the advisor paragraph states the measured facts and no unmeasured ones', () => {
  const orch = section(read('docs/ORCHESTRATION.md'), '### Effort by role and model');
  const p = orch.split('\n').find((l) => l.startsWith('**The advisor, measured and not adopted.**'));
  for (const fact of ['experimental, Anthropic API only', '`advisorModel` in settings or `--advisor`', 'never called it in 20 turns', 'asked in the brief to consult it twice', '$1.10 of a $2.06 run', '`advisor_redacted_result`', 'Sub-agents inherit a configured advisor', '`/advisor off`', 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1']) assert.ok(p.includes(fact), fact);
});

test('the transcript paragraph names where model and effort are recorded, and the two-probe delay measured', () => {
  const p = section(read('docs/ORCHESTRATION.md'), '### Effort by role and model').split('\n').find((l) => l.startsWith('**What actually ran is in the transcript.**'));
  for (const fact of ['`model` and `effort` on every turn', 'subagents/agent-<id>.jsonl', 'may still run the old definition for minutes', 'ran at `xhigh`', 'about five minutes later at `high`']) assert.ok(p.includes(fact), fact);
});

test('maxTurns 80 is unchanged everywhere it is stated, with the two-pass turn count the ledger has', () => {
  assert.equal(AGENT_SETTINGS_SCHEMA.tester.maxTurns.default, 80);
  assert.ok(read('core/config.mjs').includes('80 turns: a two-pass high run took 42'));
  assert.ok(read('docs/CONFIG.md').includes('| `agents.tester.maxTurns` | positive int | `80` |'));
  assert.ok(read('docs/ORCHESTRATION.md').includes('`maxTurns: 80` by default (config)'));
});

// ── added in the second pass: what the mutation sweep found no test holding ───

test('README says why the sample sets no codex model or effort; the CHANGELOG tester bullet says what the defaults were before', () => {
  const readme = read('README.md');
  assert.ok(readme.includes('The sample sets neither `codex.model` nor `codex.effort` on purpose: the catalog head runs, each model at its catalog pairing'));
  const bullet = bulletStarting(changelogEntry(), '- **The tester runs at `high` with a second pass');
  assert.ok(bullet.includes('`agents.tester.effort` defaults to `high` (was `xhigh`)'));
  assert.ok(bullet.includes('(were the aliases `opus` and `sonnet`'));
});

test('MEASUREMENTS limits state the under-recording bound in their own bullet, and the map question names the tester, its effort and the advisor', () => {
  const s = MEAS();
  assert.ok(s.split('\n').some((l) => l.startsWith('- Sub-agent costs are lower bounds by roughly a fifth to a quarter')), 'the limit bullet');
  const row = read('docs/MEASUREMENTS.md').split('\n').find((l) => l.includes('(#the-testers-effort-a-second-pass-and-an-advisor)') && l.startsWith('|'));
  assert.ok(row, 'the map row');
  const question = row.split('|')[1];
  for (const w of ['tester', 'effort', 'second pass', 'advisor']) assert.ok(question.includes(w), `the question names ${w}: ${question}`);
});
